// The pusher: the one process in the root VM that can use a write key, as a user of its own
// (desolate-pusher), and only to move one branch, from the commit a person approved it
// moving from to the commit they approved.
//
// WHY. The root's ordinary user runs everything here that parses what a domain sends: git on
// agent-written packs, outbox files, the dashboard's state. It used to push too, with the
// write agent open to it for the two minutes an approval lasts; a bug in any of those
// parsers could have pushed another branch, or another commit, in that window (the
// independent audit's F6 on the M1).
//
// WHAT THIS DOES NOT DO: PARSE. A first version took a bundle from that user and ran git on
// it, here, with the write agent in reach: a bug in git's pack parsing that compromised the
// root's user could have been sent straight on to this one (the audit of that version said
// so). Now nothing the root's user sends is parsed in this process, beyond one JSON line
// (at most LIMIT.header, read by node's own parser) that says how many bytes follow:
//   - the pack is taken whole and hashed, never read, and goes to the remote only if it is
//     the pack the person approved (the reviewer made it, of the approved commits' own
//     objects): no other object rides along. The forge's git reads it;
//   - an LFS object is hashed as it arrives, and goes up only if it hashes to its name and is
//     one the approved commits point to (the approval carries their ids' digest).
//     git-lfs uploads it from a repository of this push's own that holds no git object;
//   - what is pushed is decided by the keyring's record of the approval, not by anything
//     sent: this process speaks git's push protocol itself (receive-pack: a few lines of
//     text with the forge) and asks for exactly one ref update, `<onto> <commit>
//     refs/heads/<branch>`. The forge applies it atomically: the branch is `onto` and
//     becomes `commit`, or nothing changes. A pack without `commit` in it cannot make the
//     branch point at it, and a pack cannot name a ref.
// What it reads besides: the keyring's answers, the forge's ref list and status lines, and
// the forge's address and host key from root's own copy (PINNED_FORGE).
//
//   node pusher.ts          (as desolate-pusher; started and kept by root/start.sh)
//
// ONE PUSH, THEN GONE. After a push (pushed or not) this process exits, and root's supervisor
// kills every process of this user before starting the next one, which empties this user's
// home before it listens.
//
// The socket (PUSHER.control) is in a directory only the root's user and this user enter.
// One request per connection:
//   {"op":"ping"}                                             -> {"ok":true}
//   {"op":"push","approval":id,"pack":N,"lfs":[{"oid","size"}...],"lfsListed":[oid...]}\n
//     then each LFS object's bytes in that order, then N bytes of pack. `lfsListed` is every
//     LFS object the approved commits point to (the reviewer's list, whose digest the person
//     signed); `lfs` is those of them the root holds, sent
//                                       -> {"progress":"..."}\n lines while it uploads, then
//                                          {"ok":true,...} | {"ok":false,"error","moved"}
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import * as path from "node:path";
import type { Readable, Writable } from "node:stream";
import { lfsDigest } from "../shared/approval.ts";
import { FORGE, formatBytes, over } from "../shared/limits.ts";
import { isBranch, isCommit, isLfsOid, parseRepo } from "../shared/names.ts";
import { run } from "../shared/run.ts";
import { printable, tail } from "../shared/text.ts";
import { APPROVAL } from "./keyring.ts";
import { hold } from "./keyring-client.ts";
import { GITCONFIG, KEYRING, PINNED_FORGE, PUSHER } from "./layout.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type {
  Call,
  Expect,
  Given,
  Invoke,
  Table,
  Throws,
} from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { aBrokenPack, aPack, forgeSaying } from "../.harness/root-forge.ts";
import type { emptyRoot, writeJsonIn } from "../.harness/root-state.ts";

/** What the pusher takes, from the root's ordinary user (the header, the pack, an LFS object:
 *  not trusted) and from the forge (`advertised`). */
const LIMIT = {
  /** The one JSON line the root's user sends (send.ts), read by node's own parser. Its size is
   *  what bounds the list of LFS objects in it: there is no count (docs/v3/limits.md). The
   *  list is the reviewer's, which reaches the root's user in a line of at most 1 MiB
   *  (review-client.ts, `packFor`), about 78 bytes an object; here it is twice, as
   *  `lfsListed` and as the objects sent with their sizes, about 170 bytes an object: so
   *  4 MiB takes any list the reviewer can give, and a push is never refused for it after the
   *  person approved it. */
  header: 4 * 1024 * 1024,
  pack: FORGE.packBytes,
  lfs: FORGE.lfsObjectBytes,
  /** Everything the forge says in one push, its ref list and its report together: a forge
   *  with about 600,000 refs. */
  advertised: 64 * 1024 * 1024,
} as const;
/** The one idle bound (R4), against the two peers this waits on that it does not trust to
 *  end: the root's user sending a push (each chunk must come within it), and the forge taking
 *  one (each LFS chunk, each chunk of the pack). Not a total: a push takes as long as it
 *  takes while it moves. A minute: longer than any pause a working link makes (ssh's own
 *  keepalive gives up on a dead one in 45 s, below), short enough that a stall is said while
 *  the person is still there. */
const IDLE_MS = 60_000;
/** How often a long step says how far it is (to the one who handed the push over). */
const PROGRESS_MS = 10_000;
/** When the root's user must have handed over all of a push of `bytes` (its pack and LFS
 *  objects), from the claim. A total, on purpose, though R4 has idle bounds only: the claim
 *  has stopped the approval's clock (keyring.ts, APPROVAL), and without a total the root's
 *  user could send a byte a minute and land the approved push days after the person took it
 *  for failed (found by the adversarial review of this change; the claim's 35 minutes used to
 *  bound it). What it hands over is on its own disk in this VM: the approval's two minutes,
 *  and as long again as the bytes take at 10 MiB/s, far below any disk the root VM has. The
 *  bytes are the person's to know: the LFS objects' sizes are in the list they approved, and
 *  the pack is at most FORGE.packBytes (a 2 GiB pack: 5 min 25 s). */
export const handOverBy = (bytes: number, from = Date.now()) =>
  from + APPROVAL.lifeMs + Math.ceil(bytes / (10 * 1024 * 1024)) * 1000;
/** After the whole pack went out, the forge checks it and then reports, saying nothing
 *  meanwhile (no side-band): ssh's keepalive ends a dead link, and this ends a forge that
 *  answers keepalives and never reports. The total the whole push had before (30 minutes),
 *  kept for this one wait, which no push has been seen to need a fraction of. */
const REPORT_MS = 30 * 60_000;
const ZERO = "0".repeat(40);
// One line per message, always starting with the time: no log line can read as an event.
const log = (message: string) =>
  console.error(`${new Date().toISOString()} pusher: ${message.replace(/[\r\n]+/g, " ")}`);
/** What happened, for `desolate events` on the host (host/events.ts): one line on stdout,
 *  which root's supervisor keeps in a log of root's. Made of the keyring's record of the
 *  approval and the forge's answer, nothing the root's user said. */
let current: { repo: string; ref: string; commit: string; onto: string | null } | null = null;
const emit = (result: Record<string, unknown>) => {
  if (!current) return;
  const base = {
    at: new Date().toISOString(),
    repo: current.repo,
    branch: current.ref,
    commit: current.commit,
    onto: current.onto,
  };
  const line =
    result.ok === true
      ? { type: "pushed", ...base }
      : {
          type: result.uncertain === true ? "push-uncertain" : "push-failed",
          ...base,
          error: String(result.error ?? ""),
        };
  process.stdout.write(`EVENT ${JSON.stringify(line)}\n`);
};

type Approved = {
  id: string;
  repo: string;
  ref: string;
  commit: string;
  onto: string | null;
  pack: string;
  lfs: { count: number; digest: string };
  pubkey: string;
};

/** The forge's address, from root's own copy (the host writes it, as root): the root's user
 *  cannot aim a push elsewhere. {@link forgeAddress.Reads} {@link forgeAddress.Refuses} */
export const forgeAddress = (): { user: string; host: string; port: number } => {
  const f = JSON.parse(fs.readFileSync(PINNED_FORGE.config, "utf8")) as {
    ssh?: { user?: string; host?: string; port?: number };
  };
  const ssh = f.ssh ?? {};
  if (
    !/^[a-z_][a-z0-9_-]*$/.test(ssh.user ?? "") ||
    !/^[A-Za-z0-9.-]+$/.test(ssh.host ?? "") ||
    !Number.isInteger(ssh.port)
  )
    throw new Error("the forge's address is not well formed");
  return ssh as { user: string; host: string; port: number };
};

declare namespace forgeAddress {
  type Fresh = Invoke<typeof emptyRoot>;
  /** where a push goes is root's copy of the forge (forge-pin.ts), read as three checked words
   *  @incident 2026-11-12-pusher-parsed-nothing */
  export type Reads = Given<
    [
      Fresh,
      Invoke<
        typeof writeJsonIn,
        [
          where: "sys",
          name: "forge.json",
          value: { kind: "github"; ssh: { user: "git"; host: "github.com"; port: 22 } },
        ]
      >,
    ],
    Expect<Invoke<typeof forgeAddress>, "=", { user: "git"; host: "github.com"; port: 22 }>
  >;
  /** an address that would be read as an ssh option, or carry a second word, is not one */
  export type Refuses = [
    Given<
      [
        Fresh,
        Invoke<
          typeof writeJsonIn,
          [
            where: "sys",
            name: "forge.json",
            value: { ssh: { user: "-oProxyCommand=sh"; host: "github.com"; port: 22 } },
          ]
        >,
      ],
      Throws<Invoke<typeof forgeAddress>, "the forge's address is not well formed">
    >,
    Given<
      [
        Fresh,
        Invoke<
          typeof writeJsonIn,
          [
            where: "sys",
            name: "forge.json",
            value: { ssh: { user: "git"; host: "github.com evil.example"; port: 22 } },
          ]
        >,
      ],
      Throws<Invoke<typeof forgeAddress>, "the forge's address is not well formed">
    >,
    Given<
      [
        Fresh,
        Invoke<
          typeof writeJsonIn,
          [
            where: "sys",
            name: "forge.json",
            value: { ssh: { user: "git"; host: "github.com"; port: "22" } },
          ]
        >,
      ],
      Throws<Invoke<typeof forgeAddress>, "the forge's address is not well formed">
    >,
  ];
}

const sshOptions = (identity: string) => [
  "-F",
  "/dev/null",
  "-o",
  `IdentityAgent=${KEYRING.writeAgent}`,
  "-o",
  `IdentityFile=${identity}`,
  "-o",
  "IdentitiesOnly=yes",
  "-o",
  "BatchMode=yes",
  "-o",
  "StrictHostKeyChecking=yes",
  "-o",
  `UserKnownHostsFile=${PINNED_FORGE.knownHosts}`,
  "-o",
  "ConnectTimeout=20",
  // A link that died is given up on after three unanswered keepalives, 45 s: what ends a
  // push whose pack is sent while the forge works on it, saying nothing (no side-band).
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ServerAliveCountMax=3",
];
const env = (extra: Record<string, string> = {}) => ({
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: PUSHER.home,
  LANG: "C.UTF-8",
  GIT_CONFIG_GLOBAL: GITCONFIG,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_NO_REPLACE_OBJECTS: "1",
  ...extra,
});

// ---------------------------------------------------------------- git's pkt-line, by hand
/** One pkt-line: four hex digits of length (the four included), then the text. */
export const pkt = (text: string) => {
  const body = Buffer.from(text, "utf8");
  if (body.length > 65516) throw new Error("a pkt-line is at most 65516 bytes");
  return Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4, "0")), body]);
};
export const FLUSH = Buffer.from("0000");

declare namespace pkt {
  /** four hex digits of length, the four included, then the text */
  export type Frames = Expect<
    Call<Invoke<typeof pkt, [text: "abc\n"]>, "toString">,
    "=",
    "0008abc\n"
  >;
  /** the longest line git takes is framed */
  export type Fits = Expect<
    Invoke<typeof pkt, [text: Call<"x", "repeat", [count: 65516]>]>["length"],
    "=",
    65520
  >;
  /** one byte more is refused, never sent */
  export type TooLong = Throws<
    Invoke<typeof pkt, [text: Call<"x", "repeat", [count: 65517]>]>,
    "a pkt-line is at most 65516 bytes"
  >;
}

/** pkt-lines from a stream: `next()` gives a line's text, or null for a flush. */
export const pktReader = (stream: Readable, limit: number) => {
  let buffered = Buffer.alloc(0);
  let total = 0;
  let ended = false;
  let failed: Error | null = null;
  let wake: (() => void) | null = null;
  stream.on("data", (chunk: Buffer) => {
    total += chunk.length;
    if (total > limit) failed = new Error("the forge said more than desolate reads");
    buffered = Buffer.concat([buffered, chunk]);
    wake?.();
  });
  stream.on("end", () => {
    ended = true;
    wake?.();
  });
  stream.on("error", (error: Error) => {
    failed = error;
    wake?.();
  });
  const need = async (count: number) => {
    while (buffered.length < count) {
      if (failed) throw failed;
      if (ended) throw new Error("the forge ended the conversation early");
      await new Promise<void>((resolve) => (wake = resolve));
      wake = null;
    }
    if (failed) throw failed;
  };
  return {
    next: async (): Promise<string | null> => {
      await need(4);
      const head = buffered.subarray(0, 4).toString("latin1");
      if (!/^[0-9a-f]{4}$/.test(head)) throw new Error("the forge did not speak git's protocol");
      const length = parseInt(head, 16);
      if (length === 0) {
        buffered = buffered.subarray(4);
        return null;
      }
      if (length < 5) throw new Error("the forge sent a pkt-line desolate does not use");
      await need(length);
      const line = buffered.subarray(4, length).toString("utf8");
      buffered = buffered.subarray(length);
      return line;
    },
  };
};

/** What the forge's ref list says `refs/heads/<branch>` is (ZERO: there is no such branch). */
export const advertised = (lines: string[], branch: string): string => {
  const want = `refs/heads/${branch}`;
  for (const [index, raw] of lines.entries()) {
    const line = (index === 0 ? raw.split("\0")[0]! : raw).replace(/\n$/, "");
    const [id, name, extra] = line.split(" ");
    if (!/^[0-9a-f]{40}$/.test(id ?? "") || !name || extra !== undefined)
      throw new Error("the forge's ref list is not one desolate reads");
    if (name === want) return id!;
  }
  return ZERO;
};

declare namespace advertised {
  // The forge's ref list, as receive-pack sends it: the first line carries its capabilities.
  type List = [
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa refs/heads/main\0report-status ofs-delta\n",
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb refs/heads/feature\n",
  ];
  /** what the branch is on the forge now, or the all-zero id when it has no such branch */
  export type Reads = Table<
    typeof advertised,
    [
      [args: [lines: List, branch: "main"], expected: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
      [
        args: [lines: List, branch: "feature"],
        expected: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      ],
      [args: [lines: List, branch: "other"], expected: "0000000000000000000000000000000000000000"],
      [
        args: [
          lines: [
            "0000000000000000000000000000000000000000 capabilities^{}\0report-status ofs-delta\n",
          ],
          branch: "main",
        ],
        expected: "0000000000000000000000000000000000000000",
      ],
    ]
  >;
  /** a list that is not one git sends is not read at all: a line with a third word, or no id */
  export type Strict = [
    Throws<
      Invoke<
        typeof advertised,
        [
          lines: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa refs/heads/main extra\n"],
          branch: "main",
        ]
      >,
      "the forge's ref list is not one desolate reads"
    >,
    Throws<
      Invoke<typeof advertised, [lines: ["main refs/heads/main\n"], branch: "main"]>,
      "the forge's ref list is not one desolate reads"
    >,
  ];
}

/** The forge's report: did it take the one update asked for? {@link reported.Took}
 *  {@link reported.DidNot} */
export const reported = (
  lines: string[],
  ref: string,
): { ok: true } | { ok: false; error: string } => {
  const text = lines.map((line) => line.replace(/\n$/, ""));
  if (text[0] !== "unpack ok")
    return {
      ok: false,
      error: `the forge could not unpack what was sent (${printable(text[0] ?? "no report", 200)})`,
    };
  if (text.slice(1).includes(`ok ${ref}`)) return { ok: true };
  const ng = text.find((line) => line.startsWith(`ng ${ref} `));
  return {
    ok: false,
    error: `the forge refused the update: ${ng ? printable(ng.slice(ref.length + 4), 200) : "no answer for the branch"}`,
  };
};

declare namespace reported {
  /** the forge unpacked what was sent, and took the one update asked for */
  export type Took = Expect<
    Invoke<
      typeof reported,
      [lines: ["unpack ok\n", "ok refs/heads/main\n"], ref: "refs/heads/main"]
    >,
    "=",
    { ok: true }
  >;
  /** anything else is not that: an ok for another ref, no unpack line, the forge's refusal */
  export type DidNot = Table<
    typeof reported,
    [
      [
        args: [lines: ["unpack ok\n", "ok refs/heads/other\n"], ref: "refs/heads/main"],
        expected: { ok: false; error: "the forge refused the update: no answer for the branch" },
      ],
      [
        args: [lines: ["ok refs/heads/main\n"], ref: "refs/heads/main"],
        expected: {
          ok: false;
          error: "the forge could not unpack what was sent (ok refs/heads/main)";
        },
      ],
      [
        args: [
          lines: ["unpack ok\n", "ng refs/heads/main protected branch hook declined\n"],
          ref: "refs/heads/main",
        ],
        expected: {
          ok: false;
          error: "the forge refused the update: protected branch hook declined";
        },
      ],
    ]
  >;
}

/** The whole conversation with the forge's receive-pack: read its ref list; if the branch is
 *  not exactly `onto`, stop; {@link updateRef.RemoteMoved} else ask for the one update `<onto>
 *  <commit> refs/heads/<branch>`, {@link updateRef.Updates} let `sendPack` put the pack on the
 *  wire, and read the forge's report. */
export const updateRef = async (
  forge: { stdin: Writable; stdout: Readable },
  branch: string,
  onto: string | null,
  commit: string,
  sendPack: (sink: Writable) => Promise<void>,
): Promise<{ ok: true } | { ok: false; moved: boolean; error: string }> => {
  const from = onto ?? ZERO;
  const ref = `refs/heads/${branch}`;
  const reader = pktReader(forge.stdout, LIMIT.advertised);
  const refs: string[] = [];
  for (let line = await reader.next(); line !== null; line = await reader.next()) refs.push(line);
  if (refs.length === 0)
    throw new Error("the forge listed no refs, not even an empty repository's");
  const now = advertised(refs, branch);
  // Already there (a push that landed, asked again): nothing to do, and it is done.
  if (now === commit) {
    await write(forge.stdin, FLUSH).catch(() => {});
    return { ok: true };
  }
  if (now !== from) {
    await write(forge.stdin, FLUSH).catch(() => {});
    return {
      ok: false,
      moved: true,
      error: `the remote's ${branch} is ${now === ZERO ? "not there" : `at ${now.slice(0, 12)}`}, not ${onto ? `at the ${onto.slice(0, 12)}` : "absent, as"} the approval names: nothing was pushed`,
    };
  }
  // The pack is made with offset deltas (send.ts); a forge that does not take them is told
  // nothing rather than sent what it cannot read.
  const caps = (refs[0]!.split("\0")[1] ?? "").trim().split(" ");
  if (!caps.includes("report-status") || !caps.includes("ofs-delta"))
    throw new Error(
      `the forge does not offer what desolate's push needs (report-status, ofs-delta): ${printable(caps.join(" "), 200)}`,
    );
  await write(
    forge.stdin,
    Buffer.concat([pkt(`${from} ${commit} ${ref}\0report-status agent=desolate-pusher\n`), FLUSH]),
  );
  // From here the forge may take the update as soon as the pack is whole, whatever happens
  // after: its report is read while the pack goes, and a failure past this point says that
  // the push may have landed, never that nothing was pushed.
  const report = (async () => {
    const lines: string[] = [];
    for (let line = await reader.next(); line !== null; line = await reader.next())
      lines.push(line);
    return reported(lines, ref);
  })();
  report.catch(() => {});
  try {
    await sendPack(forge.stdin);
  } catch (error) {
    const said = await Promise.race([
      report,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
    ]).catch(() => null);
    if (said?.ok) return said;
    throw new Uncertain(`sending the pack failed (${(error as Error).message})`);
  }
  let result: Awaited<typeof report>;
  let waited: NodeJS.Timeout | undefined;
  try {
    result = await Promise.race([
      report,
      new Promise<never>(
        (_, reject) =>
          (waited = setTimeout(
            () => reject(new Error(`nothing in ${REPORT_MS / 60_000} minutes after the pack`)),
            REPORT_MS,
          )),
      ),
    ]);
  } catch (error) {
    throw new Uncertain(`the forge's report did not arrive (${(error as Error).message})`);
  } finally {
    clearTimeout(waited);
  }
  return result.ok
    ? result
    : {
        ok: false,
        moved: /non-fast-forward|fetch first|stale|lock/.test(result.error),
        error: result.error,
      };
};

/** A failure after the ref update was asked for: the forge may have applied it. */
export class Uncertain extends Error {}

declare namespace updateRef {
  // A forge whose main is at aaaa..., which takes the update and says so.
  type Takes = Invoke<
    typeof forgeSaying,
    [
      refs: [
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa refs/heads/main\0report-status ofs-delta delete-refs\n",
      ],
      report: ["unpack ok\n", "ok refs/heads/main\n"],
    ]
  >;
  /** the branch is where the approval says: one update is asked for, from exactly it to the
   *  approved commit, and the pack follows as it came
   *  @principle P2 */
  export type Updates = Given<
    Takes,
    [
      Expect<
        Invoke<
          typeof updateRef,
          [
            forge: Takes,
            branch: "main",
            onto: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            sendPack: typeof aPack,
          ]
        >,
        "=",
        { ok: true }
      >,
      Expect<
        Call<Takes, "asked">,
        "=",
        "008aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb refs/heads/main\0report-status agent=desolate-pusher\n0000PACK"
      >,
    ]
  >;
  /** a new branch moves from the all-zero id, on an empty repository too */
  export type NewBranch = Expect<
    Invoke<
      typeof updateRef,
      [
        forge: Invoke<
          typeof forgeSaying,
          [
            refs: [
              "0000000000000000000000000000000000000000 capabilities^{}\0report-status ofs-delta\n",
            ],
            report: ["unpack ok\n", "ok refs/heads/feature\n"],
          ]
        >,
        branch: "feature",
        onto: null,
        commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        sendPack: typeof aPack,
      ]
    >,
    "=",
    { ok: true }
  >;
  // A forge whose main has moved on to cccc... since the approval.
  type Moved = Invoke<
    typeof forgeSaying,
    [refs: ["cccccccccccccccccccccccccccccccccccccccc refs/heads/main\0report-status ofs-delta\n"]]
  >;
  /** the remote moved since the person approved: nothing is asked for, no pack is sent
   *  @principle P2
   *  @incident 2026-11-12-pusher-parsed-nothing
   *  @standsIn the forge's receive-pack (forgeSaying)
   *  @realIn tests/v3/t1/pusher.test.ts, "the branch moves only from the commit the approval names: a stale onto, or none for a branch that exists, pushes nothing" */
  export type RemoteMoved = Given<
    Moved,
    [
      Expect<
        Invoke<
          typeof updateRef,
          [
            forge: Moved,
            branch: "main",
            onto: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            sendPack: typeof aPack,
          ]
        >,
        "=",
        {
          ok: false;
          moved: true;
          error: "the remote's main is at cccccccccccc, not at the aaaaaaaaaaaa the approval names: nothing was pushed";
        }
      >,
      Expect<Call<Moved, "asked">, "=", "0000">,
    ]
  >;
  /** a branch the approval names as new that the remote has by now is not overwritten
   *  @principle P2 */
  export type NotNewAnyMore = Expect<
    Invoke<
      typeof updateRef,
      [
        forge: Invoke<
          typeof forgeSaying,
          [
            refs: [
              "cccccccccccccccccccccccccccccccccccccccc refs/heads/feature\0report-status ofs-delta\n",
            ],
          ]
        >,
        branch: "feature",
        onto: null,
        commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        sendPack: typeof aPack,
      ]
    >,
    "=",
    {
      ok: false;
      moved: true;
      error: "the remote's feature is at cccccccccccc, not absent, as the approval names: nothing was pushed";
    }
  >;
  /** already at the approved commit (a push that landed, asked again): done, nothing sent */
  export type AlreadyThere = Expect<
    Invoke<
      typeof updateRef,
      [
        forge: Invoke<
          typeof forgeSaying,
          [
            refs: [
              "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb refs/heads/main\0report-status ofs-delta\n",
            ],
          ]
        >,
        branch: "main",
        onto: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        sendPack: typeof aPack,
      ]
    >,
    "=",
    { ok: true }
  >;
  /** the forge's refusal is passed on, and one that says the branch moved says so */
  export type Refused = Expect<
    Invoke<
      typeof updateRef,
      [
        forge: Invoke<
          typeof forgeSaying,
          [
            refs: [
              "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa refs/heads/main\0report-status ofs-delta\n",
            ],
            report: ["unpack ok\n", "ng refs/heads/main non-fast-forward\n"],
          ]
        >,
        branch: "main",
        onto: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        sendPack: typeof aPack,
      ]
    >,
    "=",
    { ok: false; moved: true; error: "the forge refused the update: non-fast-forward" }
  >;
  /** a pack that broke after the update was asked for may still have landed: that is said,
   *  never "nothing was pushed" */
  export type MayHaveLanded = Throws<
    Invoke<
      typeof updateRef,
      [
        forge: Invoke<
          typeof forgeSaying,
          [
            refs: [
              "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa refs/heads/main\0report-status ofs-delta\n",
            ],
          ]
        >,
        branch: "main",
        onto: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        sendPack: typeof aBrokenPack,
      ]
    >,
    Uncertain
  >;
  /** a forge that cannot take what the pusher sends is told nothing */
  export type NoOfsDelta = Throws<
    Invoke<
      typeof updateRef,
      [
        forge: Invoke<
          typeof forgeSaying,
          [refs: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa refs/heads/main\0report-status\n"]]
        >,
        branch: "main",
        onto: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        sendPack: typeof aPack,
      ]
    >,
    "the forge does not offer what desolate's push needs (report-status, ofs-delta): report-status"
  >;
  /** and one that does not speak git's protocol is not read past its first four bytes */
  export type NotGit = Throws<
    Invoke<
      typeof updateRef,
      [
        forge: Invoke<typeof forgeSaying, [refs: [], report: [], raw: "HTTP/1.1 200 OK\r\n"]>,
        branch: "main",
        onto: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        sendPack: typeof aPack,
      ]
    >,
    "the forge did not speak git's protocol"
  >;
}

// ---------------------------------------------------------------- what arrives
/** Exactly `count` bytes from a socket, each chunk to `sink` (a file, the forge), hashed on
 *  the way. Gives up when nothing arrives for IDLE_MS, or at `until` (a time) however much
 *  arrives (`handOverBy`). */
export const receive = (
  socket: Socket,
  first: Buffer,
  count: number,
  sink: (chunk: Buffer) => Promise<void> | void,
  until = Infinity,
): Promise<{ rest: Buffer; sha256: string }> =>
  new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    let left = count;
    let idle: NodeJS.Timeout | undefined;
    const stop = () => {
      clearTimeout(idle);
      socket.off("data", onData);
      socket.off("close", onClose);
      socket.off("end", onClose);
      socket.pause();
    };
    const fail = (error: Error) => {
      stop();
      reject(error);
    };
    const arm = () => {
      clearTimeout(idle);
      const remain = until - Date.now();
      idle =
        remain < IDLE_MS
          ? setTimeout(
              () => fail(new Error("the push was not handed over in the time it is given")),
              Math.max(0, remain),
            )
          : setTimeout(() => fail(new Error(`nothing arrived for ${IDLE_MS / 1000} s`)), IDLE_MS);
    };
    const take = async (chunk: Buffer) => {
      const part = chunk.subarray(0, left);
      left -= part.length;
      if (part.length > 0) {
        hash.update(part);
        await sink(part);
      }
      return chunk.subarray(part.length);
    };
    const finish = (rest: Buffer) => {
      stop();
      resolve({ rest, sha256: hash.digest("hex") });
    };
    // The idle time is the sender's: it runs while waiting for bytes, not while the forge (or
    // the disk) takes the last chunk.
    const onData = (chunk: Buffer) => {
      socket.pause();
      clearTimeout(idle);
      void take(chunk).then((rest) => {
        if (left === 0) return finish(rest);
        arm();
        socket.resume();
      }, fail);
    };
    const onClose = () => fail(new Error("the connection ended before everything arrived"));
    void take(first).then((rest) => {
      if (left === 0) return finish(rest);
      socket.on("data", onData);
      socket.on("close", onClose);
      socket.on("end", onClose);
      arm();
      socket.resume();
    }, fail);
  });

/** `chunk` onto `stream`, settled once the stream has taken it. With `idleMs`, a stream that
 *  takes nothing for that long is given up on: the forge stopped reading. */
export const write = (stream: Writable, chunk: Buffer, idleMs?: number) =>
  new Promise<void>((resolve, reject) => {
    if (stream.destroyed || stream.writableEnded)
      return reject(new Error("the forge stopped listening"));
    if (stream.write(chunk)) return resolve();
    let timer: NodeJS.Timeout | undefined;
    const onError = (error: Error) => (clearTimeout(timer), reject(error));
    stream.once("error", onError);
    stream.once("drain", () => {
      clearTimeout(timer);
      stream.off("error", onError);
      resolve();
    });
    if (idleMs !== undefined)
      timer = setTimeout(() => {
        stream.off("error", onError);
        reject(new Error(`the forge took nothing for ${idleMs / 1000} s`));
      }, idleMs);
  });

/** How a watched upload is paced: given up on after `idleMs` with nothing moved, said every
 *  `everyMs`, looked at every `pollMs`. Not the defaults only so a test need not take minutes. */
export type Pace = { idleMs: number; everyMs: number; pollMs: number };
const PACE: Pace = { idleMs: IDLE_MS, everyMs: PROGRESS_MS, pollMs: 1000 };

/** `git lfs push` (`command` and `args`), ended when nothing has moved for `pace.idleMs`, and
 *  saying how far it is every `pace.everyMs` (`say`). What moved is read from the file git-lfs
 *  writes its progress to (GIT_LFS_PROGRESS, `progress`): a line for every 32 KiB it sends,
 *  "upload <n>/<of> <sent>/<size> <name>" (measured with git-lfs 3.3.0, Debian's: 245 lines for
 *  an 8 MB object sent at 330 KB/s, the first after 32 KiB). So a long upload that moves is
 *  never stopped, and one that stalls is, however long it ran first. `objects` and `bytes`:
 *  what is being sent, to say it against. */
export const uploadWatched = async (
  command: string,
  args: string[],
  env: Record<string, string>,
  progress: string,
  sending: { objects: number; bytes: number },
  say: (line: string) => void,
  pace: Pace = PACE,
): Promise<{ code: number; stderr: string; stalled: string | null }> => {
  fs.writeFileSync(progress, "", { mode: 0o600 });
  const stop = new AbortController();
  const each = new Map<string, { sent: number; size: number }>();
  let read = 0;
  let partial = "";
  let moved = Date.now();
  let said = Date.now();
  let stalled: string | null = null;
  const far = () => {
    let up = 0;
    let sent = 0;
    for (const object of each.values()) {
      sent += object.sent;
      if (object.sent === object.size) up++;
    }
    return `${up} of ${sending.objects} LFS object(s) up, ${formatBytes(sent)} of ${formatBytes(sending.bytes)}`;
  };
  const look = () => {
    let size = 0;
    try {
      size = fs.statSync(progress).size;
    } catch {
      /* not there yet */
    }
    if (size > read) {
      const fd = fs.openSync(progress, "r");
      try {
        const chunk = Buffer.alloc(size - read);
        fs.readSync(fd, chunk, 0, chunk.length, read);
        read = size;
        const lines = (partial + chunk.toString("utf8")).split("\n");
        partial = lines.pop() ?? "";
        for (const line of lines) {
          const step = /^upload \d+\/\d+ (\d+)\/(\d+) (.*)$/.exec(line);
          if (step) each.set(step[3]!, { sent: Number(step[1]), size: Number(step[2]) });
        }
      } finally {
        fs.closeSync(fd);
      }
      moved = Date.now();
    }
    // Once every byte is sent, git-lfs waits on the forge (storing, verifying), which says
    // nothing meanwhile: its own timeouts are what bound that, not nothing written here.
    let sent = 0;
    for (const object of each.values()) sent += object.sent;
    if (sent < sending.bytes && Date.now() - moved >= pace.idleMs) {
      stalled = `nothing was sent for ${pace.idleMs / 1000} s (${far()})`;
      stop.abort();
    } else if (Date.now() - said >= pace.everyMs) {
      said = Date.now();
      say(`uploading: ${far()}`);
    }
  };
  const timer = setInterval(look, pace.pollMs);
  try {
    const done = await run(command, args, {
      env: { ...env, GIT_LFS_PROGRESS: progress },
      signal: stop.signal,
    });
    return { code: done.code, stderr: done.stderr, stalled };
  } finally {
    clearInterval(timer);
  }
};

// ---------------------------------------------------------------- one push
const lfsPath = (dir: string, oid: string) =>
  path.join(dir, "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4), oid);

/** One push: the approval `request.approval` names, claimed from the keyring for as long as
 *  this runs (the claim is this connection to it, closed in the `finally`, and by the kernel
 *  if this process dies first), and then the push itself (`pushClaimed`). */
const push = async (
  socket: Socket,
  request: Record<string, unknown>,
  rest: Buffer,
): Promise<Record<string, unknown>> => {
  const id = String(request.approval ?? "");
  const claim = await hold(KEYRING.pusher, { op: "approval", id });
  try {
    if (claim.answer.ok !== true)
      return {
        ok: false,
        error: `the keyring holds no live approval ${id.slice(0, 40)}: nothing was pushed`,
      };
    return await pushClaimed(socket, request, rest, claim.answer.approval as Approved);
  } finally {
    await claim.release();
  }
};

const pushClaimed = async (
  socket: Socket,
  request: Record<string, unknown>,
  rest: Buffer,
  approved: Approved,
): Promise<Record<string, unknown>> => {
  current = {
    repo: approved.repo,
    ref: approved.ref,
    commit: approved.commit,
    onto: approved.onto,
  };
  const repo = parseRepo(approved.repo);
  if (
    !repo ||
    !isBranch(approved.ref) ||
    !isCommit(approved.commit) ||
    (approved.onto !== null && !isCommit(approved.onto)) ||
    typeof approved.pubkey !== "string" ||
    !/^[0-9a-f]{64}$/.test(String(approved.pack)) ||
    !/^[0-9a-f]{64}$/.test(String(approved.lfs?.digest))
  )
    return { ok: false, error: "the keyring's approval is not well formed" };
  // Said to the one who handed the push over (send.ts), before the answer.
  const say = (text: string) => {
    if (!socket.destroyed && socket.writable)
      socket.write(JSON.stringify({ progress: text }) + "\n");
  };
  const packSize = Number(request.pack);
  const lfs = Array.isArray(request.lfs)
    ? (request.lfs as { oid?: unknown; size?: unknown }[])
    : [];
  if (!Number.isInteger(packSize) || packSize < 32)
    return { ok: false, error: "a pack is a whole number of bytes, at least a pack's 32" };
  if (packSize > LIMIT.pack)
    return {
      ok: false,
      error: `${over("the pack", LIMIT.pack, packSize, "bytes", "a push to the forge may carry")}: nothing was pushed`,
    };
  if (lfs.some((o) => !isLfsOid(o.oid) || !Number.isInteger(o.size) || (o.size as number) < 0))
    return { ok: false, error: "LFS objects are named by sha256, with a size in bytes" };
  const large = lfs.find((o) => (o.size as number) > LIMIT.lfs);
  if (large)
    return {
      ok: false,
      error: `${over(`the LFS object ${String(large.oid).slice(0, 12)}`, LIMIT.lfs, large.size as number, "bytes", "the forge stores")}: nothing was pushed`,
    };
  // The LFS objects the person approved (their ids' digest is in the text they signed): the
  // whole list, which must be that one, and of it only those the root holds go up.
  // Each as `<oid> <size>`: the size its pointer says, which the object sent must have.
  const listed = Array.isArray(request.lfsListed) ? (request.lfsListed as unknown[]) : [];
  if (
    !listed.every(
      (entry) => typeof entry === "string" && /^[0-9a-f]{64} [0-9]{1,12}$/.test(entry),
    ) ||
    new Set(listed).size !== approved.lfs.count ||
    lfsDigest(listed as string[]) !== approved.lfs.digest
  )
    return {
      ok: false,
      error: "the LFS objects listed are not the ones approved: nothing was pushed",
    };
  const allowed = new Set(listed as string[]);
  if (lfs.some((o) => !allowed.has(`${String(o.oid)} ${String(o.size)}`)))
    return {
      ok: false,
      error:
        "an LFS object sent is not one the approved commits point to, of the size they say: nothing was pushed",
    };
  if (new Set(lfs.map((o) => o.oid)).size !== lfs.length)
    return { ok: false, error: "an LFS object is sent once: nothing was pushed" };
  const lfsBytes = lfs.reduce((sum, o) => sum + (o.size as number), 0);
  const until = handOverBy(packSize + lfsBytes);
  const onto = approved.onto ?? ZERO;
  const forge = forgeAddress();
  const work = fs.mkdtempSync(path.join(PUSHER.home, "push-"));
  const identity = path.join(work, "write.pub");
  fs.writeFileSync(identity, `${approved.pubkey.trim()}\n`, { mode: 0o600 });
  try {
    // Everything is received, and checked, before anything goes to the forge: each LFS object
    // is the bytes that hash to its name, and the pack is the one the person approved, whole.
    // (Not forwarded as it came, its end held back: any stretch of what arrives may be a
    // whole pack of its own, which the forge takes as soon as it ends, whatever follows. The
    // independent review of #165's fix found that, in the first version of it.)
    let left = rest;
    const dir = path.join(work, "lfs.git");
    if (lfs.length > 0) {
      const made = await run("git", ["init", "--bare", "--quiet", dir], { env: env() });
      if (made.code !== 0)
        return {
          ok: false,
          error: `cannot make the pusher's LFS repository: ${made.stderr.trim()}`,
        };
      fs.rmSync(path.join(dir, "hooks"), { recursive: true, force: true });
      for (const object of lfs) {
        const file = lfsPath(dir, object.oid as string);
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        const out = fs.openSync(
          `${file}.part`,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
          0o600,
        );
        let got: { rest: Buffer; sha256: string };
        try {
          got = await receive(
            socket,
            left,
            object.size as number,
            (chunk) => void fs.writeSync(out, chunk),
            until,
          );
        } finally {
          fs.closeSync(out);
        }
        left = got.rest;
        if (got.sha256 !== object.oid)
          return {
            ok: false,
            error: `an LFS object did not hash to its name (${String(object.oid).slice(0, 12)}): nothing was pushed`,
          };
        fs.renameSync(`${file}.part`, file);
      }
    }
    const packFile = path.join(work, "push.pack");
    const packOut = fs.openSync(
      packFile,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );
    let packed: { rest: Buffer; sha256: string };
    try {
      packed = await receive(
        socket,
        left,
        packSize,
        (chunk) => void fs.writeSync(packOut, chunk),
        until,
      );
    } finally {
      fs.closeSync(packOut);
    }
    if (packed.sha256 !== approved.pack)
      return {
        ok: false,
        error: `the pack is not the one approved (it hashes to ${packed.sha256.slice(0, 12)}, not ${approved.pack.slice(0, 12)}): nothing was pushed`,
      };
    // LFS first: the remote never has a pointer without its object.
    if (lfs.length > 0) {
      const url = `ssh://${forge.user}@${forge.host}:${forge.port}/${repo.owner}/${repo.name}.git`;
      log(`${approved.repo}: uploading ${lfs.length} LFS object(s)`);
      say(`uploading ${lfs.length} LFS object(s)`);
      const up = await uploadWatched(
        "git",
        [
          "--git-dir",
          dir,
          "-c",
          `safe.directory=${dir}`,
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          `remote.origin.url=${url}`,
          "-c",
          `lfs.url=${url}`,
          "-c",
          `lfs.pushurl=${url}`,
          "-c",
          "lfs.locksverify=false",
          "lfs",
          "push",
          "origin",
          "--object-id",
          ...lfs.map((o) => o.oid as string),
        ],
        env({ GIT_DIR: dir, GIT_SSH_COMMAND: ["ssh", ...sshOptions(identity)].join(" ") }),
        path.join(work, "lfs-progress"),
        { objects: lfs.length, bytes: lfsBytes },
        say,
      );
      if (up.stalled)
        return {
          ok: false,
          error: `the LFS upload stopped moving: ${up.stalled}, so the commit was not pushed`,
        };
      if (up.code !== 0) {
        const last = tail(up.stderr.trim(), 2);
        return {
          ok: false,
          error: `the LFS objects did not upload, so the commit was not pushed: ${last.before ? `(${last.before} earlier lines) ` : ""}${printable(last.text.replace(/\n/g, " | "), 600)}`,
        };
      }
    }
    // The one ref update, and the pack as it came.
    const ssh = spawn(
      "ssh",
      [
        ...sshOptions(identity),
        "-p",
        String(forge.port),
        `${forge.user}@${forge.host}`,
        `git-receive-pack '${repo.owner}/${repo.name}.git'`,
      ],
      { env: env(), stdio: ["pipe", "pipe", "pipe"] },
    );
    let stderr = "";
    ssh.stderr.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-4000)));
    ssh.stdin.on("error", () => {});
    const exited = new Promise<number>((resolve) => ssh.on("close", (code) => resolve(code ?? 1)));
    try {
      const result = await updateRef(
        ssh,
        approved.ref,
        approved.onto,
        approved.commit,
        async (sink) => {
          // The approved pack, as checked above: its bytes, never read. Each chunk must be
          // taken within IDLE_MS; how long the whole takes is the link's.
          let sent = 0;
          let said = Date.now();
          for await (const chunk of fs.createReadStream(packFile)) {
            await write(sink, chunk as Buffer, IDLE_MS);
            sent += (chunk as Buffer).length;
            if (Date.now() - said >= PROGRESS_MS) {
              said = Date.now();
              say(`sending the pack: ${formatBytes(sent)} of ${formatBytes(packSize)}`);
            }
          }
        },
      );
      ssh.stdin.end();
      await exited;
      if (!result.ok) return { ok: false, moved: result.moved, error: result.error };
      log(`${approved.repo}: ${approved.ref} ${onto.slice(0, 12)} -> ${approved.commit}`);
      return { ok: true, repo: approved.repo, branch: approved.ref, commit: approved.commit };
    } catch (error) {
      ssh.kill("SIGKILL");
      const said = stderr.trim()
        ? ` (ssh: ${printable(tail(stderr.trim(), 2).text.replace(/\n/g, " | "), 300)})`
        : "";
      if (error instanceof Uncertain)
        return {
          ok: false,
          uncertain: true,
          error: `${error.message}${said}: the push may have reached the remote; \`desolate fetch ${approved.repo}\` shows whether ${approved.ref} is at ${approved.commit.slice(0, 12)}`,
        };
      return { ok: false, error: `${(error as Error).message}${said}: nothing was pushed` };
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
};

let pushing = false;
let server: ReturnType<typeof createServer>;
const handle = (socket: Socket) => {
  socket.on("error", () => socket.destroy());
  let head = Buffer.alloc(0);
  const onData = (chunk: Buffer) => {
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf(10);
    const answer = (value: Record<string, unknown>) => socket.end(JSON.stringify(value) + "\n");
    if (end > LIMIT.header || (end < 0 && head.length > LIMIT.header)) {
      socket.off("data", onData);
      head = Buffer.alloc(0);
      // Said, not dropped: what is over is the list of LFS objects one push can carry. Then
      // the connection goes, and what it sent with it.
      const line = {
        ok: false,
        error: `the push's request is over the ${formatBytes(LIMIT.header)} the pusher reads: it names more LFS objects than one push can carry, so nothing was pushed`,
      };
      return void socket.end(JSON.stringify(line) + "\n", () => socket.destroy());
    }
    if (end < 0) return;
    socket.off("data", onData);
    socket.pause();
    const rest = head.subarray(end + 1);
    let request: Record<string, unknown>;
    try {
      request = JSON.parse(head.subarray(0, end).toString("utf8")) as Record<string, unknown>;
    } catch {
      return answer({ ok: false, error: "not a request" });
    }
    if (request.op === "ping") return answer({ ok: true });
    if (request.op !== "push")
      return answer({ ok: false, error: `unknown op '${String(request.op).slice(0, 40)}'` });
    // One push per process: the next waits for the next process (root/send.ts retries).
    if (pushing) return answer({ ok: false, busy: true, error: "another push is under way" });
    pushing = true;
    server.close();
    const exit = () => process.exit(0);
    void push(socket, request, rest)
      .then(
        (result) => (emit(result), answer(result)),
        (error: Error) => (
          emit({ ok: false, error: error.message }),
          answer({ ok: false, error: error.message })
        ),
      )
      .finally(() => {
        socket.once("close", exit);
        setTimeout(exit, 5000).unref();
      });
  };
  socket.on("data", onData);
};

const main = async () => {
  // Whatever an earlier push's process left in this user's home: gone, before anything.
  for (const name of fs.readdirSync(PUSHER.home))
    fs.rmSync(path.join(PUSHER.home, name), { recursive: true, force: true });
  fs.rmSync(PUSHER.control, { force: true });
  // The directory (root/start.sh: this user's, the root's user's group, 0750) is the gate.
  const before = process.umask(0o111);
  server = createServer({ allowHalfOpen: true }, handle);
  await new Promise<void>((resolve) => server.listen(PUSHER.control, resolve));
  process.umask(before);
  log(`listening at ${PUSHER.control}`);
};

if (process.argv[1] && fs.realpathSync(process.argv[1]) === new URL(import.meta.url).pathname)
  void main();
