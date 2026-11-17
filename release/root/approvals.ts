// Raw pushes in the root's terminal that wait for a person (root/approver.ts writes one file
// each): read by the dashboard (stated.ts) and by the host's approval page (ops.ts,
// approvals.pending). One rule for both: each file on its own, so one that is malformed, too
// large or not a file hides none of the others; at most two minutes old.
import * as fs from "node:fs";
import * as path from "node:path";
import { parseApproval } from "../shared/approval.ts";
import type { PushApproval } from "../shared/approval.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Given, Invoke } from "../../suede.nests/dsl.import.meta.vitest.ts";
import type {
  emptyRoot,
  makeDirIn,
  namesIn,
  pathIn,
  writeFilledIn,
  writeIn,
  writeJsonIn,
} from "../.harness/root-state.ts";

export const APPROVAL_TTL_MS = 120_000;
const FILE_MOST = 16 * 1024;

export type Pending = {
  message: string;
  summary: string;
  at: string;
  approval: PushApproval;
  file: string;
};

/** The approvals waiting in `dir`, oldest name first. With `prune`, what is not one (or has
 *  expired) is removed. */
export const pendingIn = (dir: string, now = Date.now(), prune = false): Pending[] => {
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
    let entry: { message?: unknown; summary?: unknown; at?: unknown } | null = null;
    try {
      const stat = fs.lstatSync(file);
      if (stat.isFile() && stat.size <= FILE_MOST)
        entry = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      entry = null;
    }
    const approval = entry && typeof entry === "object" ? parseApproval(entry.message) : null;
    const at = typeof entry?.at === "string" ? entry.at : "";
    const age = now - Date.parse(at);
    if (!approval || !(age >= -5_000 && age < APPROVAL_TTL_MS)) {
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
      summary: String(entry!.summary ?? "").slice(0, 200),
      at,
      approval,
      file,
    });
  }
  return out;
};

declare namespace pendingIn {
  // A raw push waiting for the person, as root/raw-push.ts leaves it: the keyring's challenge,
  // a line saying where it came from, and when.
  type Message =
    "desolate push approval v2\nrepo: acme/app\nbranch: feature/login\ncommit: 0123456789abcdef0123456789abcdef01234567\nonto: none\nnonce: 00112233445566778899aabbccddeeff\n";
  type Dir = Invoke<typeof pathIn, [where: "state", name: "approvals"]>;
  /** 12:00:10, ten seconds after it was asked for */
  type Now = 1794830410000;
  type Fresh = Invoke<typeof emptyRoot>;
  type Waiting = Invoke<
    typeof writeJsonIn,
    [
      where: "state",
      name: "approvals/a.json",
      value: {
        message: Message;
        summary: "a raw git push from the root's terminal";
        at: "2026-11-16T12:00:00.000Z";
      },
    ]
  >;

  /** one push waiting, with what it names read from the challenge itself */
  export type Lists = Given<
    [Fresh, Waiting],
    Expect<
      Invoke<typeof pendingIn, [dir: Dir, now: Now]>,
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
  /** each file on its own: what is broken, too large, not a file, not a challenge, expired or
   *  from the future hides none of the others */
  export type OneByOne = Given<
    [
      Fresh,
      Waiting,
      Invoke<typeof writeIn, [where: "state", name: "approvals/0-broken.json", text: "{"]>,
      Invoke<typeof writeFilledIn, [where: "state", name: "approvals/1-large.json", bytes: 17000]>,
      Invoke<typeof makeDirIn, [where: "state", name: "approvals/2-dir.json"]>,
      Invoke<
        typeof writeJsonIn,
        [
          where: "state",
          name: "approvals/3-forged.json",
          value: { message: "approve everything"; at: "2026-11-16T12:00:00.000Z" },
        ]
      >,
      Invoke<
        typeof writeJsonIn,
        [
          where: "state",
          name: "approvals/4-old.json",
          value: { message: Message; at: "2026-11-16T11:57:00.000Z" },
        ]
      >,
      Invoke<
        typeof writeJsonIn,
        [
          where: "state",
          name: "approvals/5-future.json",
          value: { message: Message; at: "2026-11-16T12:01:00.000Z" },
        ]
      >,
    ],
    Expect<
      Invoke<typeof pendingIn, [dir: Dir, now: Now]>,
      "matches",
      [{ summary: "a raw git push from the root's terminal" }]
    >
  >;
  /** pruning removes the files that are not approvals, and leaves a directory alone */
  export type Prunes = Given<
    [
      Fresh,
      Waiting,
      Invoke<typeof writeIn, [where: "state", name: "approvals/0-broken.json", text: "{"]>,
      Invoke<typeof makeDirIn, [where: "state", name: "approvals/2-dir.json"]>,
      Invoke<
        typeof writeJsonIn,
        [
          where: "state",
          name: "approvals/4-old.json",
          value: { message: Message; at: "2026-11-16T11:57:00.000Z" },
        ]
      >,
      Invoke<typeof pendingIn, [dir: Dir, now: Now, prune: true]>,
    ],
    Expect<
      Invoke<typeof namesIn, [where: "state", dir: "approvals"]>,
      "=",
      ["2-dir.json", "a.json"]
    >
  >;
  /** no directory yet: nothing waits */
  export type NoDir = Given<Fresh, Expect<Invoke<typeof pendingIn, [dir: Dir, now: Now]>, "=", []>>;
}
