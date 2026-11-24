// Bounds two layers must agree on (docs/v3/limits.md, R3: one bound, one name, one reason).
// Each was written in several files, with several numbers and several messages, and a push
// refused by one layer for a bound another had let through said "not JSON" or "not a plain
// file". Here each is defined once, with where its number comes from, and `over` is the one
// sentence for a bound that was hit: the limit, the actual value, and the unit counted.
//
// A bound here is hard (R7): it bounds input from a side that is not trusted, or is the
// forge's own, and is not a setting. What depends on the Mac or the person is in settings.ts.
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Table } from "../../suede.nests/dsl.import.meta.vitest.ts";

const KiB = 1024;
const MiB = 1024 * KiB;
const GiB = 1024 * MiB;

/** What the forge itself takes, so what every layer on the way to it carries and no more.
 *  A layer that holds one of these (the reviewer's pack, the pusher's upload, the outbox's
 *  bundle, the git VM's LFS file) checks it against the number here. */
export const FORGE = {
  /** A pack, and a bundle of one: GitHub limits a push to 2 GB (its documentation, "About
   *  large files on GitHub"). */
  packBytes: 2 * GiB,
  /** One LFS object: 5 GiB is the largest GitHub stores, on its largest plan (2 GiB on
   *  Free and Pro, 4 GiB on Team, 5 GiB on Enterprise Cloud); the forge refuses its own
   *  smaller limit itself, in its own words. */
  lfsObjectBytes: 5 * GiB,
} as const;

/** The size from which a blob is not an LFS pointer: git-lfs itself looks for a pointer only
 *  in a blob under 1024 bytes (its `blobSizeCutoff`), so a blob is looked at as one only
 *  when its size is under this. It replaces four copies of 400, which missed a pointer made
 *  longer by extension lines. */
export const LFS_POINTER_BYTES = 1024;

/** How long the names and notes may be that a workspace writes and every other layer reads.
 *  A workspace is not trusted, so each is checked where it is read, against these. */
export const NAMES = {
  /** A domain's or a workspace's name, in characters (ASCII, so bytes too). A name is used
   *  as a hostname label, which DNS ends at 63, and as a path component. 40 is a choice under
   *  that, kept from v2 so that no name made before is refused. names.ts's SLUG is this
   *  rule, and the one that checks. */
  slug: 40,
  /** A branch desolate carries, in characters (ASCII by names.ts's isBranch, so bytes). git
   *  itself takes longer. What holds one here is the text a person signs to approve a push,
   *  which the keyring reads at no more than 1,024 characters (approval.ts): 200 fits there
   *  beside a repository's name (up to 201), three commits' ids, a nonce and a pack's hash. */
  branch: 200,
  /** A checkout's status line, in characters (code points): a sentence or two, shown whole
   *  in a row of the dashboard. release/AGENTS.md tells the writer this number. */
  status: 200,
  /** A checkout's note, in bytes: 16 KiB is about four pages of text. The root reads it
   *  whole, from a file a workspace wrote, for every checkout it lists: the bound is on what
   *  it will hold for each. */
  noteBytes: 16 * KiB,
} as const;

/** The root's record of one domain (root/record.ts): what it offered, had refused and had
 *  pushed. Each is that domain's own file, read whole at every state the dashboard is sent.
 *  `offers`: the branches one domain may have under "Needs you" at once. Past it an offer is
 *  refused in words (dismiss some, or delete branches); 2,000 is far past what a person
 *  reviews, and bounds the file near half a MiB. `pushes`: the pushes kept, newest last (a
 *  branch list marks "merged" from the latest push of a branch). `bytes`: a file past this
 *  is not one the root wrote, and is set aside unread. `lockWaitMs`: how long a change waits
 *  for another process's (each takes moments) before it fails and says so, as pushed.json's
 *  lock did. */
export const RECORD = { offers: 2000, pushes: 500, bytes: 4 * MiB, lockWaitMs: 10_000 } as const;

/** A terminal's size, in columns and rows, as a browser tab or an attached terminal asks
 *  for it: whole numbers from 1 to these. Past what a screen shows (a 4K display at an
 *  8-pixel font is 480 columns), and inside the unsigned 16-bit fields a pty's size is set
 *  with (TIOCSWINSZ). What asks is a page or a workspace: the bound is on what the program
 *  in the terminal is told to lay out for. */
export const TERMINAL = { cols: 1000, rows: 500 } as const;

/** The ports a workspace's programs may be reached on, and the ones a person may name: the
 *  unprivileged ones. Below 1024 a port is the system's (binding one needs root, on the Mac
 *  and in a VM), and 65535 is the last port TCP has. */
export const PORTS = { min: 1024, max: 65535 } as const;

/** A size, as a person reads it: the one way desolate writes one. Binary units, said as
 *  such (R8). Under a MiB in whole KiB (never "0 KiB": anything is at least 1), then MiB,
 *  then GiB, to one decimal place. */
export const formatBytes = (bytes: number): string =>
  bytes < MiB
    ? `${Math.max(1, Math.round(bytes / KiB))} KiB`
    : bytes < GiB
      ? `${(bytes / MiB).toFixed(1)} MiB`
      : `${(bytes / GiB).toFixed(1)} GiB`;

declare namespace formatBytes {
  /** what a pack's or an object's size reads as. Up to a GiB this is the text
   *  host/approver.ts (`formatSize`) and host/push.ts (`formatBytes`) have always printed */
  export type Sizes = Table<
    typeof formatBytes,
    [
      [args: [bytes: 4096], expected: "4 KiB"],
      [args: [bytes: 300], expected: "1 KiB"],
      [args: [bytes: 0], expected: "1 KiB"],
      [args: [bytes: 1048575], expected: "1024 KiB"],
      [args: [bytes: 1048576], expected: "1.0 MiB"],
      [args: [bytes: 5767168], expected: "5.5 MiB"],
      /** from a GiB on, in GiB: "2355.2 MiB" is not how a person reads a size */
      [args: [bytes: 1073741824], expected: "1.0 GiB"],
      [args: [bytes: 2469606195], expected: "2.3 GiB"],
    ]
  >;
}

/** A limit as its definition says it: "2 GiB", not "2.0 GiB", when it is a whole number of
 *  the unit; any other size as formatBytes writes it. */
const limitBytes = (bytes: number): string => {
  for (const [size, unit] of [
    [GiB, "GiB"],
    [MiB, "MiB"],
    [KiB, "KiB"],
  ] as const)
    if (bytes >= size && bytes % size === 0) return `${bytes / size} ${unit}`;
  return formatBytes(bytes);
};

/** The one sentence for a bound that was hit (R3): what was measured, how large it is, and
 *  the limit, with the unit that was counted (R8). `what`: the thing, as the person knows
 *  it ("the pack", "the status"). `unit`: "bytes" (written as a size) or what was counted
 *  ("characters", "LFS objects"). `allows`: who sets the limit, to end the sentence ("a push
 *  to the forge may carry"); without it, "allowed". A sentence, with no capital and no full
 *  stop: the caller's refusal puts it in place.
 *
 *  Two sizes that round to the same text ("16 KiB, over the 16 KiB") are written in bytes. */
export const over = (
  what: string,
  limit: number,
  actual: number,
  unit: string,
  allows = "allowed",
): string => {
  if (unit !== "bytes") return `${what} is ${actual} ${unit}, over the ${limit} ${allows}`;
  const [is, most] = [formatBytes(actual), limitBytes(limit)];
  return is === most || is === formatBytes(limit)
    ? `${what} is ${actual} bytes, over the ${limit} ${allows}`
    : `${what} is ${is}, over the ${most} ${allows}`;
};

declare namespace over {
  /** the bound that was hit, by name, with the limit and the actual value */
  export type Says = Table<
    typeof over,
    [
      [
        args: [
          what: "the pack",
          limit: 2147483648,
          actual: 2469606195,
          unit: "bytes",
          allows: "a push to the forge may carry",
        ],
        expected: "the pack is 2.3 GiB, over the 2 GiB a push to the forge may carry",
      ],
      [
        args: [what: "the status", limit: 200, actual: 312, unit: "characters"],
        expected: "the status is 312 characters, over the 200 allowed",
      ],
      [
        args: [
          what: "the branch's name",
          limit: 200,
          actual: 201,
          unit: "characters",
          allows: "desolate carries",
        ],
        expected: "the branch's name is 201 characters, over the 200 desolate carries",
      ],
      /** a size just over its limit would read as the limit: said in bytes instead */
      [
        args: [what: "the note", limit: 16384, actual: 16385, unit: "bytes"],
        expected: "the note is 16385 bytes, over the 16384 allowed",
      ],
      [
        args: [
          what: "the note",
          limit: 16384,
          actual: 40000,
          unit: "bytes",
          allows: "a note may be",
        ],
        expected: "the note is 39 KiB, over the 16 KiB a note may be",
      ],
    ]
  >;
}
