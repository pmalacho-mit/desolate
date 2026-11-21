// FALLBACK, TO BE REMOVED when limits ticket 1 (#173) has landed in the root: the reviewer
// that answers with one JSON object instead of the stream (shared/review-account.ts), read
// as the stream would be. The host is written against the stream; this file is all that
// knows the old answer, and its one caller is host/daemon.ts's reviewerSummary. To remove
// it: delete this file, its harness (host-review-fallback.ts, beside the others) and the
// places in host/daemon.ts marked FALLBACK, and its line in tests/v3/features.ts.
//
// What the old reviewer cannot do, this says, in the account's own terms, and never makes
// up: its lists are cut (the newest 50 commits, 200 files) and it has no further page; its
// diff is one text, cut at 256 KiB or not made at all, and not to be had by file.
// It keeps nothing: a page of a diff is asked of the old reviewer again (it keeps its own
// answers ten minutes, and makes one again after), and is given only if the reviewer still
// names the pack the account named.
import type { Account, AccountLine, AccountRequest } from "../shared/review-account.ts";
import { ACCOUNT_LINE_BYTES, accountLine } from "../shared/review-account.ts";
import type { accountLines } from "../shared/review-account.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Invoke, Table } from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { all, chunks } from "../.harness/shared-review-account.ts";
import type { oldReviewer } from "../.harness/host-review-fallback.ts";

/** The old reviewer's one answer (root/reviewer.ts, before #173). */
export type OldSummary = {
  ok: boolean;
  error?: string;
  warnings?: string[];
  /** The newest first, at most 50; `more`: how many older ones are not listed. */
  commits?: { commit: string; subject: string; author: string }[];
  more?: number;
  files?: { path: string; added: number; removed: number; binary?: boolean; sensitive?: boolean }[];
  moreFiles?: number;
  base?: string | null;
  remote?: string | null;
  fastForward?: boolean | null;
  squashedFrom?: string;
  diff?: string;
  diffCut?: boolean;
  sends?: { pack: string; size: number; lfs: string[] };
  squash?: {
    commit: string;
    parent: string | null;
    count: number;
    message: string;
    author?: string;
    committer?: string;
    dates?: string;
    sends: { pack: string; size: number; lfs: string[] };
  };
  between?: { path: string; sensitive?: boolean }[];
  moreBetween?: number;
  eachDiff?: string;
  eachDiffCut?: boolean;
  eachDiffWhy?: string;
};

type Asked = Extract<AccountRequest, { op: "account" }>;
const OLD = "old:";
/** Whether an account's key is one this file made: its pages are answered here. */
export const isOldKey = (key: string): boolean => key.startsWith(OLD);
/** The key of an old answer's account: the push it was asked of, and the pack it named. */
const keyOf = (asked: Asked, pack: string): string =>
  OLD +
  Buffer.from(
    JSON.stringify([asked.repo, asked.branch, asked.commit, asked.onto, pack]),
    "utf8",
  ).toString("base64url");
const askedOf = (key: string): { asked: Asked; pack: string } | null => {
  try {
    const held: unknown = JSON.parse(Buffer.from(key.slice(OLD.length), "base64url").toString());
    if (!Array.isArray(held) || held.length !== 5) return null;
    const [repo, branch, commit, onto, pack] = held as unknown[];
    if ([repo, branch, commit, pack].some((v) => typeof v !== "string")) return null;
    if (onto !== null && typeof onto !== "string") return null;
    return {
      asked: { op: "account", repo, branch, commit, onto } as Asked,
      pack: pack as string,
    };
  } catch {
    return null;
  }
};

/** An old answer, if `value` is one: an object that says `ok`. */
const oldOf = (value: unknown): OldSummary | null =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  typeof (value as { ok?: unknown }).ok === "boolean"
    ? (value as OldSummary)
    : null;

/** The old answer as the line the stream would have ended with: the account, or the error.
 *  Its commits are turned first to last, as the account lists them, and placed where they
 *  are in the whole list: the old reviewer lists the newest, so the page it gives is the
 *  list's end. */
export const lineOf = (old: OldSummary, asked: Asked): AccountLine => {
  if (!old.ok || !old.sends)
    return { error: String(old.error ?? "the reviewer gave no account of what the push sends") };
  const commits = [...(old.commits ?? [])].reverse();
  const older = Math.max(0, old.more ?? 0);
  const files = old.files ?? [];
  const between = old.between ?? [];
  const account: Account = {
    key: keyOf(asked, old.sends.pack),
    warnings: old.warnings ?? [],
    commits: { items: commits, total: older + commits.length, from: older },
    files: { items: files, total: files.length + Math.max(0, old.moreFiles ?? 0), from: 0 },
    between: {
      items: between,
      total: between.length + Math.max(0, old.moreBetween ?? 0),
      from: 0,
    },
    sends: old.sends,
    ...(old.squash
      ? {
          squash: {
            ...old.squash,
            author: old.squash.author ?? "",
            committer: old.squash.committer ?? "",
            dates: old.squash.dates ?? "",
          },
        }
      : {}),
    fastForward: old.fastForward ?? null,
    ...(old.squashedFrom ? { squashedFrom: old.squashedFrom } : {}),
    base: old.base ?? null,
    remote: old.remote ?? null,
  };
  return { account };
};

declare namespace lineOf {
  type Asked_ = {
    op: "account";
    repo: "acme/web";
    branch: "fix";
    commit: "1111111111111111111111111111111111111111";
    onto: null;
  };
  type Sends_ = {
    pack: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    size: 100;
    lfs: [];
  };
  /** the old lists as pages with true totals: its 2 newest commits of 5 are entries 3 and 4,
   *  first to last; its 1 file of 3 is the first page */
  export type Lists = Expect<
    Invoke<
      typeof lineOf,
      [
        old: {
          ok: true;
          commits: [
            { commit: "b"; subject: "second"; author: "a" },
            { commit: "a"; subject: "first"; author: "a" },
          ];
          more: 3;
          files: [{ path: "x"; added: 1; removed: 0 }];
          moreFiles: 2;
          fastForward: true;
          sends: Sends_;
        },
        asked: Asked_,
      ]
    >,
    "matches",
    {
      account: {
        commits: {
          items: [
            { commit: "a"; subject: "first"; author: "a" },
            { commit: "b"; subject: "second"; author: "a" },
          ];
          total: 5;
          from: 3;
        };
        files: { items: [{ path: "x"; added: 1; removed: 0 }]; total: 3; from: 0 };
        between: { items: []; total: 0; from: 0 };
        warnings: [];
        fastForward: true;
        base: null;
        sends: Sends_;
      };
    }
  >;
  /** an old answer with no account of what is sent is the stream's error, in its words */
  export type NoAccount = Table<
    typeof lineOf,
    [
      [
        args: [old: { ok: false; error: "bad object" }, asked: Asked_],
        expected: { error: "bad object" },
      ],
      [
        args: [old: { ok: true }, asked: Asked_],
        expected: { error: "the reviewer gave no account of what the push sends" },
      ],
    ]
  >;
}

/** The reviewer's answer, as bytes, with an old answer made the line the stream would have
 *  ended with; anything else passes as it came, for accountLines to read (or refuse). A
 *  line is held until its end, and no further than the stream's own bound on one. */
export async function* withOld(
  asked: Asked,
  stream: AsyncIterable<Uint8Array | string>,
): AsyncGenerator<Uint8Array | string, void, void> {
  let held: Buffer[] = [];
  let size = 0;
  for await (const piece of stream) {
    let rest = typeof piece === "string" ? Buffer.from(piece, "utf8") : Buffer.from(piece);
    for (;;) {
      const end = rest.indexOf(10);
      if (end < 0) break;
      const line = Buffer.concat([...held, rest.subarray(0, end + 1)]);
      rest = rest.subarray(end + 1);
      held = [];
      size = 0;
      let old: OldSummary | null = null;
      try {
        old = oldOf(JSON.parse(line.toString("utf8")));
      } catch {
        /* not JSON: not an old answer */
      }
      yield old ? accountLine(lineOf(old, asked)) : line;
    }
    if (rest.length) held.push(rest);
    size += rest.length;
    // Past the bound it is not an answer of either kind: passed on, to be refused as that.
    if (size > ACCOUNT_LINE_BYTES) {
      yield* held;
      held = [];
      size = 0;
    }
  }
  yield* held;
}

declare namespace withOld {
  type Push = {
    op: "account";
    repo: "acme/web";
    branch: "fix";
    commit: "1111111111111111111111111111111111111111";
    onto: null;
  };
  /** the stream passes as it came, its chunks cut anywhere: read, it is the same lines */
  export type Stream = Expect<
    Invoke<
      typeof all,
      [
        lines: Invoke<
          typeof accountLines,
          [
            stream: Invoke<
              typeof withOld,
              [
                asked: Push,
                stream: Invoke<
                  typeof chunks,
                  [parts: ['{"progress":{"phase":"pack', 'ing"}}\n{"error":"no"}\n']]
                >,
              ]
            >,
          ]
        >,
      ]
    >,
    "=",
    [{ progress: { phase: "packing" } }, { error: "no" }]
  >;
  /** an old answer among them is the account it names */
  export type Old = Expect<
    Invoke<
      typeof all,
      [
        lines: Invoke<
          typeof accountLines,
          [
            stream: Invoke<
              typeof withOld,
              [
                asked: Push,
                stream: Invoke<typeof chunks, [parts: ['{"ok":false,"error":"bad', ' object"}\n']]>,
              ]
            >,
          ]
        >,
      ]
    >,
    "=",
    [{ error: "bad object" }]
  >;
}

/** What the old reviewer's diff says when it was cut: the page ends the text it has. */
const CUT_NOTE =
  "\n(this is where the reviewer in the root cut it, at 256 KiB: it is an older one. The rest: with git, in the git terminal)\n";

/** A request that names an old account (`page`, `diff`), answered from the old reviewer's
 *  one answer, asked again with `ask` (the bytes of its answer to an `account` request). */
export async function* oldAnswer(
  request: Exclude<AccountRequest, { op: "account" }>,
  ask: (asked: Asked) => AsyncIterable<Uint8Array | string>,
): AsyncGenerator<AccountLine, void, void> {
  const named = askedOf(request.key);
  if (!named) return void (yield { error: "that is not an account the reviewer gave" });
  if (request.op === "page")
    return void (yield {
      error: `the reviewer in the root is an older one, which lists no more of the ${request.list === "between" ? "files changed in between" : request.list} than it gave. The rest: with git, in the git terminal`,
    });
  let text = "";
  for await (const piece of ask(named.asked)) {
    text += typeof piece === "string" ? piece : Buffer.from(piece).toString("utf8");
    if (text.length > ACCOUNT_LINE_BYTES) break;
  }
  let old: OldSummary | null = null;
  try {
    old = oldOf(JSON.parse(text.trim().split("\n").pop() ?? ""));
  } catch {
    /* said below */
  }
  if (!old?.ok || !old.sends)
    return void (yield {
      error: `the reviewer could not be asked again for the diff: ${String(old?.error ?? "it gave no answer")}`,
    });
  // The diff of another account than the one shown is not shown as this one's.
  if (old.sends.pack !== named.pack)
    return void (yield {
      error:
        "what this push would send has changed since its account was made, so its diff is not the one to read: refuse it, and push again",
    });
  const whole = (diff: string, cut: boolean): AccountLine => {
    const bytes = Buffer.from(diff + (cut ? CUT_NOTE : ""), "utf8");
    // One page: the old reviewer's text is at most 256 KiB, and it has no other.
    return {
      diff:
        (request.from ?? 0) > 0
          ? { text: "", from: bytes.length, next: null, total: bytes.length }
          : { text: bytes.toString("utf8"), from: 0, next: null, total: bytes.length },
    };
  };
  if (request.of === "net") {
    if (old.diff === undefined)
      return void (yield {
        error:
          "the reviewer in the root is an older one, which makes no diff of a change over 20,000 lines. Read it with git, in the git terminal",
      });
    return void (yield whole(old.diff, old.diffCut === true));
  }
  if ("file" in request.of)
    return void (yield {
      error:
        "the reviewer in the root is an older one, which gives the diff whole and not by file: use Show the diff",
    });
  // Each commit whole is one text, each under its `commit <id>` line (a message's own
  // lines are indented, and a diff's start with another character).
  const each = old.eachDiff;
  const at = each === undefined ? -1 : `\n${each}`.indexOf(`\ncommit ${request.of.commit}\n`);
  if (each === undefined || at < 0)
    return void (yield {
      error: `the reviewer in the root is an older one, and did not give this commit whole${old.eachDiffWhy ? ` (it gave ${old.eachDiffWhy})` : ""}. Read it with git, in the git terminal`,
    });
  // From its own `commit` line to the next one's, or to the end of the text.
  const rest = each.slice(at);
  const next = rest.slice(1).search(/\ncommit [0-9a-f]{40,64}\n/);
  yield whole(
    next < 0 ? rest : rest.slice(0, next + 2),
    next < 0 && old.eachDiffCut === true && each.length >= 256 * 1024,
  );
}

declare namespace oldAnswer {
  type Key =
    "old:WyJhY21lL3dlYiIsImZpeCIsIjExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTEiLG51bGwsImVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWUiXQ";
  type Old = {
    ok: true;
    diff: "diff --git a/x b/x\n+one\n";
    eachDiff: "commit 2222222222222222222222222222222222222222\nAuthor:     A\n\n    first\n\ndiff --git a/x b/x\n+o\ncommit 1111111111111111111111111111111111111111\nAuthor:     A\n\n    second\n";
    sends: {
      pack: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
      size: 100;
      lfs: [];
    };
  };
  /** the net diff, whole, as one page that ends it, its size in bytes */
  export type Net = Expect<
    Invoke<
      typeof all,
      [
        lines: Invoke<
          typeof oldAnswer,
          [
            request: { op: "diff"; key: Key; of: "net" },
            ask: Invoke<typeof oldReviewer, [says: Old]>,
          ]
        >,
      ]
    >,
    "=",
    [{ diff: { text: "diff --git a/x b/x\n+one\n"; from: 0; next: null; total: 24 } }]
  >;
  /** one commit whole: its part of the old reviewer's one text, and no other commit's */
  export type OneCommit = Expect<
    Invoke<
      typeof all,
      [
        lines: Invoke<
          typeof oldAnswer,
          [
            request: {
              op: "diff";
              key: Key;
              of: { commit: "2222222222222222222222222222222222222222" };
            },
            ask: Invoke<typeof oldReviewer, [says: Old]>,
          ]
        >,
      ]
    >,
    "=",
    [
      {
        diff: {
          text: "commit 2222222222222222222222222222222222222222\nAuthor:     A\n\n    first\n\ndiff --git a/x b/x\n+o\n";
          from: 0;
          next: null;
          total: 96;
        };
      },
    ]
  >;
  /** the reviewer now names another pack than the account did: its diff is not shown as
   *  this account's (beside Net, the control, where the pack is the account's) */
  export type AnotherPack = Expect<
    Invoke<
      typeof all,
      [
        lines: Invoke<
          typeof oldAnswer,
          [
            request: { op: "diff"; key: Key; of: "net" },
            ask: Invoke<
              typeof oldReviewer,
              [
                says: {
                  ok: true;
                  diff: "+another\n";
                  sends: {
                    pack: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
                    size: 1;
                    lfs: [];
                  };
                },
              ]
            >,
          ]
        >,
      ]
    >,
    "=",
    [
      {
        error: "what this push would send has changed since its account was made, so its diff is not the one to read: refuse it, and push again";
      },
    ]
  >;
  /** what the old reviewer cannot do is said, and how to read it all the same: a further
   *  page of a list, a diff by file, a key that is not one of these */
  export type Cannot = [
    Expect<
      Invoke<
        typeof all,
        [
          lines: Invoke<
            typeof oldAnswer,
            [
              request: { op: "page"; key: Key; list: "commits"; from: 50 },
              ask: Invoke<typeof oldReviewer, [says: Old]>,
            ]
          >,
        ]
      >,
      "=",
      [
        {
          error: "the reviewer in the root is an older one, which lists no more of the commits than it gave. The rest: with git, in the git terminal";
        },
      ]
    >,
    Expect<
      Invoke<
        typeof all,
        [
          lines: Invoke<
            typeof oldAnswer,
            [
              request: { op: "diff"; key: Key; of: { file: "x" } },
              ask: Invoke<typeof oldReviewer, [says: Old]>,
            ]
          >,
        ]
      >,
      "=",
      [
        {
          error: "the reviewer in the root is an older one, which gives the diff whole and not by file: use Show the diff";
        },
      ]
    >,
    Expect<
      Invoke<
        typeof all,
        [
          lines: Invoke<
            typeof oldAnswer,
            [
              request: { op: "diff"; key: "old:not-a-key"; of: "net" },
              ask: Invoke<typeof oldReviewer, [says: Old]>,
            ]
          >,
        ]
      >,
      "=",
      [{ error: "that is not an account the reviewer gave" }]
    >,
  ];
}
