// The reviewer's account of a push: what desolate's reviewer (root/reviewer.ts, in the root
// VM) says a push would send, as the host's approval page and terminal show it and as the
// person's signature names it. One type for both ends (docs/v3/limits.md): it was written
// twice, in root/reviewer.ts and host/approve-web.ts, and cut in both.
//
// The reviewer answers a request (`AccountRequest`, one JSON line) with a stream of lines
// (`AccountLine`, each one JSON object and a newline): any number of `progress` lines, said
// while it works, and then exactly one answer: the `account`, a `page` of one of its lists,
// a page of a `diff`, or an `error`. It works for as long as whoever asked holds the
// connection; there is no deadline inside it (R4).
//
// Types and framing only. What the lines hold is the reviewer's to make and the approval
// surfaces' to show, as text (repository content is data).
import { over } from "./limits.ts";
import type { Listed } from "./listed.ts";
import { printable } from "./text.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Invoke, Table } from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { repeat } from "../.harness/shared-text.ts";
import type { all, chunks, failsAfter, longLine } from "../.harness/shared-review-account.ts";

/** What a push sends: the pack the reviewer made and keeps (its sha256, and its size in
 *  bytes), and the LFS objects its commits point to: how many, their bytes as their pointers
 *  say, and their list's digest (shared/approval.ts, lfsDigest), which the host puts in the
 *  text the person signs. The list itself, however long, stays in the root: the reviewer
 *  gives it to the pusher, which checks it against that digest. */
export type Sends = {
  pack: string;
  size: number;
  lfs: { count: number; bytes: number; digest: string };
};

/** The person's other choice: the commits pushed as one. Its tree is the commit's own, its
 *  parent is where the commit leaves the remote's history, and its author, committer and
 *  dates are the commit's (root/reviewer.ts says how it is made). */
export type Squash = {
  commit: string;
  parent: string | null;
  /** How many commits it stands for. */
  count: number;
  message: string;
  author: string;
  committer: string;
  /** Its dates, the last commit's: when it says it was written, and committed. */
  dates: string;
};

export type AccountCommit = { commit: string; subject: string; author: string };
export type AccountFile = {
  /** Made safe to show (printable); a name that is not UTF-8 as git quotes it ("caf\351"). */
  path: string;
  added: number;
  removed: number;
  binary?: boolean;
  sensitive?: boolean;
};
/** A file a commit of the push changes that the net change does not list: changed, then put
 *  back. Every commit is pushed, so what was in between is in the history. */
export type AccountBetween = { path: string; sensitive?: boolean };

export type Account = {
  /** Names this account, for `page` and `diff`. */
  key: string;
  /** Every one: a warning is never one of "and 3 more". */
  warnings: string[];
  /** The commits a push sends, first to last: the first page, and the true total. */
  commits: Listed<AccountCommit>;
  /** The files the push changes, net. This list and `between` put the `sensitive` ones (what
   *  runs on the forge) first, so that they are on the first page; then git's order. */
  files: Listed<AccountFile>;
  between: Listed<AccountBetween>;
  sends: Sends;
  /** The same push as one commit, when it has two or more. */
  squash?: Squash & { sends: Sends };
  /** Whether the push builds on what the remote's branch has; null when the branch is new. */
  fastForward: boolean | null;
  /** When the push replaces the remote's branch, and that branch is a squash of a commit of
   *  this one: that commit. */
  squashedFrom?: string;
  base: string | null;
  remote: string | null;
};

/** A page of a diff, in bytes, counted as bytes (R8): `text` is the diff from byte `from`
 *  up to byte `next`, cut between lines, so that no character and no line is halved. `next`
 *  is where the following page starts, or null when this one ends the diff; `total` is the
 *  whole diff's size. The producer says `next`: text that was not UTF-8 does not have the
 *  length its bytes had, so the asker never works a position out from `text`. */
export type DiffPage = { text: string; from: number; next: number | null; total: number };

/** What is asked of the reviewer. `account`: the account of a push. `page`: more of one of
 *  its lists, from entry `from`. `diff`: a page of a diff, of one file, of one commit, or of
 *  the net change, from byte `from` (0 when not said). A diff's `{file}` is a `path` exactly
 *  as the account lists it, compared as text, never a pattern: the diff is of every file
 *  listed so. */
export type AccountRequest =
  | { op: "account"; repo: string; branch: string; commit: string; onto: string | null }
  | { op: "page"; key: string; list: "commits" | "files" | "between"; from: number }
  | { op: "diff"; key: string; of: { file: string } | { commit: string } | "net"; from?: number };

/** One line of the reviewer's answer stream: progress, then the one answer. A `page` holds
 *  the list that was asked for, under its own name, in the shape the account has it. */
export type AccountLine =
  | { progress: { phase: string; done?: number; of?: number } }
  | { account: Account }
  | { page: Pick<Account, "commits"> | Pick<Account, "files"> | Pick<Account, "between"> }
  | { diff: DiffPage }
  | { error: string };

/** The most one line of the stream may be, in bytes: what its reader will hold of an answer
 *  it has not yet been able to read. The largest honest line is an account: three pages of
 *  a hundred entries (listed.ts's PAGE), each entry little more than a path, which is at
 *  most 4,096 bytes (PATH_MAX) and at worst six bytes of JSON for one of its own
 *  (`\u0001`): 3 x 100 x 4,096 x 6 is 7.4 MB. A page of a diff is the producer's to keep
 *  under this. */
export const ACCOUNT_LINE_BYTES = 8 * 1024 * 1024;

/** An AccountLine as the line the reviewer writes: one JSON object, then a newline. JSON
 *  writes a newline inside a string as `\n`, so a line is always one line. A line its
 *  reader would refuse, over ACCOUNT_LINE_BYTES, is not written: an `error` that says so is,
 *  so that the bound is said where it was passed. */
export const accountLine = (line: AccountLine): string => {
  const text = JSON.stringify(line);
  const bytes = Buffer.byteLength(text);
  if (bytes <= ACCOUNT_LINE_BYTES) return `${text}\n`;
  const what = Object.keys(line)[0];
  return `${JSON.stringify({
    error: `the reviewer's ${what} could not be sent: ${over("it", ACCOUNT_LINE_BYTES, bytes, "bytes", "one line may be")}`,
  })}\n`;
};

declare namespace accountLine {
  /** one object a line, whatever it holds: a newline in a phase or an error cannot end it */
  export type Writes = Table<
    typeof accountLine,
    [
      [
        args: [line: { progress: { phase: "packing"; done: 120; of: 4000 } }],
        expected: '{"progress":{"phase":"packing","done":120,"of":4000}}\n',
      ],
      [
        args: [line: { error: "the push's pack could not be made:\nfatal: bad object" }],
        expected: '{"error":"the push\'s pack could not be made:\\nfatal: bad object"}\n',
      ],
    ]
  >;
  /** a line its reader would refuse is not sent: what is, says why */
  export type TooLong = Expect<
    Invoke<
      typeof accountLine,
      [line: { error: Invoke<typeof repeat, [text: "x", count: 9000000]> }]
    >,
    "=",
    '{"error":"the reviewer\'s error could not be sent: it is 8.6 MiB, over the 8 MiB one line may be"}\n'
  >;
}

type Fields = Record<string, unknown>;
const isObject = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown) => Number.isInteger(value) && (value as number) >= 0;
/** A list as listed.ts makes it: its entries (theirs to check, each by its reader) and two
 *  counts. */
const isListed = (value: unknown) =>
  isObject(value) && Array.isArray(value.items) && isCount(value.total) && isCount(value.from);
const isSends = (value: unknown) =>
  isObject(value) &&
  typeof value.pack === "string" &&
  isCount(value.size) &&
  isObject(value.lfs) &&
  isCount(value.lfs.count) &&
  isCount(value.lfs.bytes) &&
  typeof value.lfs.digest === "string";
const LISTS = ["commits", "files", "between"] as const;

/** Whether `held`, under the name `kind`, is that kind of line: the shape a reader relies
 *  on to tell one from another and to page (its kinds, its counts, its positions). What the
 *  entries of a list hold is their reader's to check, and to show as text. */
const SHAPES: Record<string, (held: unknown) => boolean> = {
  progress: (held) =>
    isObject(held) &&
    typeof held.phase === "string" &&
    (held.done === undefined || isCount(held.done)) &&
    (held.of === undefined || isCount(held.of)),
  account: (held) =>
    isObject(held) &&
    typeof held.key === "string" &&
    Array.isArray(held.warnings) &&
    held.warnings.every((warning) => typeof warning === "string") &&
    LISTS.every((list) => isListed(held[list])) &&
    isSends(held.sends),
  page: (held) =>
    isObject(held) &&
    Object.keys(held).length === 1 &&
    LISTS.some((list) => list in held && isListed(held[list])),
  diff: (held) =>
    isObject(held) &&
    typeof held.text === "string" &&
    isCount(held.from) &&
    (held.next === null || isCount(held.next)) &&
    isCount(held.total),
  error: (held) => typeof held === "string",
};

/** What a line holds, or null when it is not a line of this stream: one JSON object with
 *  exactly one of the five names, holding that kind's shape (SHAPES). */
const lineOf = (text: string): AccountLine | null => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 1 || !Object.hasOwn(SHAPES, keys[0]!)) return null;
  return SHAPES[keys[0]!]!(value[keys[0]!]) ? (value as AccountLine) : null;
};

/** The reviewer's answer stream, read: each `progress` line as it arrives, then the one
 *  answer, which ends it (anything after an answer is not read). `stream` is the bytes as
 *  they come, in chunks of any size. Whatever goes wrong with the stream is an answer too,
 *  an `error` that says what, so that a reader always ends with one answer:
 *  - a line that is not a line of this stream (the reviewer logs to stderr, never here);
 *  - a line over ACCOUNT_LINE_BYTES, said as that bound (R3), never as "not JSON";
 *  - a stream that ends before any answer: the reviewer ended, or was ended, mid-work. */
export async function* accountLines(
  stream: AsyncIterable<Uint8Array | string>,
): AsyncGenerator<AccountLine, void, void> {
  // What is held of a line not yet ended: one buffer, grown by doubling, so that a writer
  // of one byte at a time costs its bytes and not an object each (8 MiB of one-byte chunks
  // held as a list of them was a gigabyte).
  let held = Buffer.alloc(0);
  let size = 0;
  const hold = (bytes: Buffer) => {
    if (size + bytes.length > held.length) {
      const bigger = Buffer.alloc(Math.max(held.length * 2, size + bytes.length, 4096));
      held.copy(bigger, 0, 0, size);
      held = bigger;
    }
    bytes.copy(held, size);
    size += bytes.length;
  };
  const tooLong = (bytes: number): AccountLine => ({
    error: `the reviewer's answer cannot be read: ${over("a line of it", ACCOUNT_LINE_BYTES, bytes, "bytes", "one line may be")}`,
  });
  try {
    for await (const piece of stream) {
      let rest = typeof piece === "string" ? Buffer.from(piece, "utf8") : Buffer.from(piece);
      for (;;) {
        const end = rest.indexOf(10);
        if (end < 0) break;
        if (size + end > ACCOUNT_LINE_BYTES) return void (yield tooLong(size + end));
        hold(rest.subarray(0, end));
        const text = held.toString("utf8", 0, size);
        rest = rest.subarray(end + 1);
        size = 0;
        if (text.trim() === "") continue;
        const line = lineOf(text);
        if (!line)
          return void (yield {
            error: `the reviewer's answer cannot be read: this is not a line of an account: ${printable(text, 200)}`,
          });
        yield line;
        if (!("progress" in line)) return;
      }
      if (size + rest.length > ACCOUNT_LINE_BYTES) return void (yield tooLong(size + rest.length));
      hold(rest);
    }
  } catch (error) {
    // The connection failed (reset, closed under it): an answer too, never a throw that each
    // reader must remember to catch.
    return void (yield {
      error: `the reviewer's answer could not be read to its end: ${printable(error instanceof Error ? error.message : error, 200)}`,
    });
  }
  yield {
    error:
      size > 0
        ? "the reviewer's answer ended in the middle of a line: it stopped, or was stopped, before it finished"
        : "the reviewer ended without an answer: it stopped, or was stopped, before it finished",
  };
}

declare namespace accountLines {
  /** progress as it comes, then the answer, however the bytes were cut into chunks: here a
   *  chunk ends inside a line, and inside a character (the two bytes of an é) */
  export type Reads = Expect<
    Invoke<
      typeof all,
      [
        lines: Invoke<
          typeof accountLines,
          [
            stream: Invoke<
              typeof chunks,
              [
                parts: [
                  '{"progress":{"phase":"reading the commits"}}\n{"prog',
                  'ress":{"phase":"packing","done":1,"of":2}}\n',
                  '{"error":"no such commit: caf\u00c3',
                  '\u00a9"}\n',
                ],
              ]
            >,
          ]
        >,
      ]
    >,
    "=",
    [
      { progress: { phase: "reading the commits" } },
      { progress: { phase: "packing"; done: 1; of: 2 } },
      { error: "no such commit: café" },
    ]
  >;
  /** one answer ends the stream: what follows it is not read */
  export type OneAnswer = Expect<
    Invoke<
      typeof all,
      [
        lines: Invoke<
          typeof accountLines,
          [
            stream: Invoke<
              typeof chunks,
              [
                parts: [
                  '{"diff":{"text":"+a\\n","from":0,"next":null,"total":3}}\n{"error":"late"}\n',
                ],
              ]
            >,
          ]
        >,
      ]
    >,
    "=",
    [{ diff: { text: "+a\n"; from: 0; next: null; total: 3 } }]
  >;
  /** a reviewer that stopped before its answer (killed, crashed, cancelled) is said so, as
   *  the answer: its reader never waits for one that will not come, or takes progress for it */
  export type EndedEarly = [
    Expect<
      Invoke<
        typeof all,
        [
          lines: Invoke<
            typeof accountLines,
            [stream: Invoke<typeof chunks, [parts: ['{"progress":{"phase":"packing"}}\n']]>]
          >,
        ]
      >,
      "=",
      [
        { progress: { phase: "packing" } },
        {
          error: "the reviewer ended without an answer: it stopped, or was stopped, before it finished";
        },
      ]
    >,
    Expect<
      Invoke<
        typeof all,
        [
          lines: Invoke<
            typeof accountLines,
            [stream: Invoke<typeof chunks, [parts: ['{"account":{"key":"k","warn']]>]
          >,
        ]
      >,
      "=",
      [
        {
          error: "the reviewer's answer ended in the middle of a line: it stopped, or was stopped, before it finished";
        },
      ]
    >,
  ];
  /** what is not a line of an account is not passed on as one: something a program printed
   *  where the answer goes, JSON of another shape, two answers in one object. Shown as text. */
  export type NotALine = [
    Expect<
      Invoke<
        typeof all,
        [
          lines: Invoke<
            typeof accountLines,
            [
              stream: Invoke<
                typeof chunks,
                [parts: ['warning: \u001b[31mredirecting\n{"error":"never read"}\n']]
              >,
            ]
          >,
        ]
      >,
      "=",
      [
        {
          error: "the reviewer's answer cannot be read: this is not a line of an account: warning: ?[31mredirecting";
        },
      ]
    >,
    Expect<
      Invoke<
        typeof all,
        [
          lines: Invoke<
            typeof accountLines,
            [stream: Invoke<typeof chunks, [parts: ['{"ok":true,"commits":[]}\n']]>]
          >,
        ]
      >,
      "=",
      [
        {
          error: 'the reviewer\'s answer cannot be read: this is not a line of an account: {"ok":true,"commits":[]}';
        },
      ]
    >,
    Expect<
      Invoke<
        typeof all,
        [
          lines: Invoke<
            typeof accountLines,
            [stream: Invoke<typeof chunks, [parts: ['{"error":"a","account":{}}\n']]>]
          >,
        ]
      >,
      "=",
      [
        {
          error: 'the reviewer\'s answer cannot be read: this is not a line of an account: {"error":"a","account":{}}';
        },
      ]
    >,
    /** nor is one that has a kind's name and not its shape */
    Expect<
      Invoke<
        typeof all,
        [
          lines: Invoke<
            typeof accountLines,
            [stream: Invoke<typeof chunks, [parts: ['{"diff":{"text":"+a","from":"0"}}\n']]>]
          >,
        ]
      >,
      "=",
      [
        {
          error: 'the reviewer\'s answer cannot be read: this is not a line of an account: {"diff":{"text":"+a","from":"0"}}';
        },
      ]
    >,
  ];
  /** a line with no end is not held without end: past the bound it is refused, as that
   *  bound, when the bound is passed and not when the stream ends */
  export type TooLong = Expect<
    Invoke<
      typeof all,
      [lines: Invoke<typeof accountLines, [stream: Invoke<typeof longLine, [bytes: 9000000]>]>]
    >,
    "=",
    [
      {
        error: "the reviewer's answer cannot be read: a line of it is 8.6 MiB, over the 8 MiB one line may be";
      },
    ]
  >;
  /** a connection that fails under it is an answer too: said, not thrown */
  export type Fails = Expect<
    Invoke<
      typeof all,
      [
        lines: Invoke<
          typeof accountLines,
          [
            stream: Invoke<
              typeof failsAfter,
              [parts: ['{"progress":{"phase":"packing"}}\n{"acc'], error: "read ECONNRESET"]
            >,
          ]
        >,
      ]
    >,
    "=",
    [
      { progress: { phase: "packing" } },
      { error: "the reviewer's answer could not be read to its end: read ECONNRESET" },
    ]
  >;
}
