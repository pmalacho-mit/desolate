// Raw pushes that wait for a person (root/raw-push.ts writes one file each): read by the
// dashboard (stated.ts) and by the host's approval page (ops.ts, approvals.pending). One rule
// for both: each file on its own, so one that is malformed, too large or not a file hides
// none of the others; and one is listed while the process that wrote it, which waits for the
// answer, is alive. When it ends (Ctrl-C, a closed terminal), its request is off the list,
// as the keyring has already dropped its challenge (keyring.ts): there is no clock.
//
// The files are the root's ordinary user's, so this list is no more trusted than that user:
// what the person signs is checked by the host and the keyring, not here.
import * as fs from "node:fs";
import * as path from "node:path";
import { parseApproval } from "../shared/approval.ts";
import type { PushApproval } from "../shared/approval.ts";
import { startOf } from "../shared/lock.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Given, Invoke } from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { aRequestIn } from "../.harness/root-approvals.ts";
import type {
  emptyRoot,
  makeDirIn,
  namesIn,
  pathIn,
  writeFilledIn,
  writeIn,
  writeJsonIn,
} from "../.harness/root-state.ts";

/** A request is the keyring's challenge, a line, a time and its writer: far less than this.
 *  The bound is on what a reader holds of each file the root's user may have written. */
const FILE_MOST = 16 * 1024;

export type Pending = {
  message: string;
  summary: string;
  at: string;
  approval: PushApproval;
  file: string;
};

/** Is the process a request names still the one that wrote it? (Its pid, and when that
 *  process started: a pid used again by another process is not it.) */
const waiting = (entry: { pid?: unknown; start?: unknown }): boolean =>
  Number.isInteger(entry.pid) &&
  typeof entry.start === "string" &&
  startOf(entry.pid as number) === entry.start;

/** The approvals waiting in `dir`, oldest name first. With `prune`, what is not one (or whose
 *  writer has ended) is removed. (`_now` is no longer read: a request has no age.) */
export const pendingIn = (dir: string, _now = Date.now(), prune = false): Pending[] => {
  const out: Pending[] = [];
  let names: string[];
  try {
    names = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .sort();
  } catch {
    return out;
  }
  for (const name of names) {
    const file = path.join(dir, name);
    let entry: Record<string, unknown> | null = null;
    try {
      const stat = fs.lstatSync(file);
      if (stat.isFile() && stat.size <= FILE_MOST)
        entry = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      entry = null;
    }
    const approval = entry && typeof entry === "object" ? parseApproval(entry.message) : null;
    if (!approval || !waiting(entry!)) {
      if (prune)
        try {
          fs.rmSync(file, { force: true });
        } catch {
          /* a directory, say: not this reader's to remove */
        }
      continue;
    }
    out.push({
      message: String(entry!.message),
      summary: String(entry!.summary ?? ""),
      at: typeof entry!.at === "string" ? entry!.at : "",
      approval,
      file,
    });
  }
  return out;
};

declare namespace pendingIn {
  // A raw push waiting for the person, as root/raw-push.ts leaves it: the keyring's challenge,
  // a line saying where it came from, when, and the process waiting for the answer.
  type Message =
    "desolate push approval v2\nrepo: acme/app\nbranch: feature/login\ncommit: 0123456789abcdef0123456789abcdef01234567\nonto: none\nnonce: 00112233445566778899aabbccddeeff\n";
  type Dir = Invoke<typeof pathIn, [where: "state", name: "approvals"]>;
  type Fresh = Invoke<typeof emptyRoot>;
  type Waiting = Invoke<
    typeof aRequestIn,
    [
      name: "a.json",
      writer: "waiting",
      value: {
        message: Message;
        summary: "a raw git push from the root's terminal";
        at: "2026-11-16T12:00:00.000Z";
      },
    ]
  >;

  /** one push waiting, with what it names read from the challenge itself; however long ago it
   *  was asked for (a person reading a long diff), it is listed while its asker waits */
  export type Lists = Given<
    [Fresh, Waiting],
    Expect<
      Invoke<typeof pendingIn, [dir: Dir]>,
      "matches",
      [
        {
          summary: "a raw git push from the root's terminal";
          at: "2026-11-16T12:00:00.000Z";
          approval: {
            repo: "acme/app";
            branch: "feature/login";
            commit: "0123456789abcdef0123456789abcdef01234567";
            onto: null;
            nonce: "00112233445566778899aabbccddeeff";
          };
        },
      ]
    >
  >;
  /** each file on its own: what is broken, too large, not a file, not a challenge, or written
   *  by a process that has ended, or by none (an old request naming nobody), hides none of the
   *  others. A pid now another process's is not the asker. (`Lists` is the control: the same
   *  request, its asker alive, is listed.) */
  export type OneByOne = Given<
    [
      Fresh,
      Waiting,
      Invoke<typeof writeIn, [where: "state", name: "approvals/0-broken.json", text: "{"]>,
      Invoke<typeof writeFilledIn, [where: "state", name: "approvals/1-large.json", bytes: 17000]>,
      Invoke<typeof makeDirIn, [where: "state", name: "approvals/2-dir.json"]>,
      Invoke<
        typeof aRequestIn,
        [name: "3-forged.json", writer: "waiting", value: { message: "approve everything" }]
      >,
      Invoke<
        typeof aRequestIn,
        [name: "4-ended.json", writer: "ended", value: { message: Message }]
      >,
      Invoke<
        typeof aRequestIn,
        [name: "5-another.json", writer: "another", value: { message: Message }]
      >,
      Invoke<
        typeof writeJsonIn,
        [
          where: "state",
          name: "approvals/6-nobody.json",
          value: { message: Message; at: "2026-11-16T12:00:00.000Z" },
        ]
      >,
    ],
    Expect<
      Invoke<typeof pendingIn, [dir: Dir]>,
      "matches",
      [{ summary: "a raw git push from the root's terminal" }]
    >
  >;
  /** pruning removes the files that are not waiting approvals, and leaves a directory alone */
  export type Prunes = Given<
    [
      Fresh,
      Waiting,
      Invoke<typeof writeIn, [where: "state", name: "approvals/0-broken.json", text: "{"]>,
      Invoke<typeof makeDirIn, [where: "state", name: "approvals/2-dir.json"]>,
      Invoke<
        typeof aRequestIn,
        [name: "4-ended.json", writer: "ended", value: { message: Message }]
      >,
      Invoke<typeof pendingIn, [dir: Dir, _now: 0, prune: true]>,
    ],
    Expect<
      Invoke<typeof namesIn, [where: "state", dir: "approvals"]>,
      "=",
      ["2-dir.json", "a.json"]
    >
  >;
  /** no directory yet: nothing waits */
  export type NoDir = Given<Fresh, Expect<Invoke<typeof pendingIn, [dir: Dir]>, "=", []>>;
}
