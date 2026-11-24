// What the Mac takes from the root's answers: one parser per operation, in one table. The root's
// ordinary user answers every call over the CLI channel (stack.ts rootctl), and it is the user
// that parses what workspaces send, so an answer is data from a party that may have been taken
// over (shared/actions.ts checks the other direction the same way). host/stack.ts hands a
// caller only what the parser for its operation gave back: each field's type, bound and form
// checked, fields the Mac does not read dropped. An operation that is not in the table cannot
// be asked for (it does not type-check), and an answer not in its form is a refusal that says
// which operation's it was and where, never what it held.
//
// Where an answer names something the Mac then acts on (a workspace's VM, a domain whose folder
// it removes, the keys it registers, a proxy's socket), the form is not enough: the parser also
// checks it against what the Mac asked about, or rebuilds it from checked parts. Before this
// table each caller added its own checks, and two that were missing were found by an audit
// (2026-11-22).
import { Refusal, refuse } from "../shared/exit.ts";
import { LIMIT as ISSUE, ID as ISSUE_ID } from "../shared/issues.ts";
import { NAMES } from "../shared/limits.ts";
import { LIMITS } from "../shared/size.ts";
import { printable } from "../shared/text.ts";
import {
  characters,
  isBranch,
  isCommit,
  isSlug,
  parseRepo,
  workspaceVmName,
} from "../shared/names.ts";
import { checkoutPath } from "../shared/plan.ts";
import { INSTANCE } from "./paths.ts";
import type { Expect, Invoke, Table, Throws } from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { answered, changed, cutOf } from "../.harness/host-replies.ts";
import type { textOf } from "../.harness/shared-actions.ts";
import type { refusalOf } from "../.harness/refusal.ts";

/** Where in an answer a part is not in its form: the path to it from the top ("keys[0].role"),
 *  in the Mac's own names and numbers, never the answer's bytes. */
class Unformed extends Error {}
const unformed = (at: string): never => {
  throw new Unformed(at || "the answer itself");
};

/** A part of an answer: what it is, checked, or Unformed. `at`: where it is. */
type Part<T> = (value: unknown, at: string) => T;
/** A field that may be absent: then it is left out of what the Mac is given. */
type Maybe<T> = Part<T> & { maybe: true };
type Of<P> = P extends Part<infer T> ? T : never;
type Fields = Record<string, Part<unknown>>;
type Shaped<F extends Fields> = {
  [K in keyof F as F[K] extends { maybe: true } ? never : K]: Of<F[K]>;
} & { [K in keyof F as F[K] extends { maybe: true } ? K : never]?: Of<F[K]> } extends infer S
  ? { [K in keyof S]: S[K] }
  : never;

const maybe = <T>(part: Part<T>): Maybe<T> =>
  Object.assign((value: unknown, at: string) => part(value, at), { maybe: true as const });

/** An object of these fields, and of no others: a field it has that the Mac does not read is
 *  not passed on. Not an array, not null. */
const shape =
  <F extends Fields>(fields: F): Part<Shaped<F>> =>
  (value, at) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) unformed(at);
    const given = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, part] of Object.entries(fields)) {
      const field = Object.hasOwn(given, key) ? given[key] : undefined;
      if (field === undefined && "maybe" in part) continue;
      out[key] = part(field, at ? `${at}.${key}` : key);
    }
    return out as Shaped<F>;
  };

const list =
  <T>(item: Part<T>, most = Infinity): Part<T[]> =>
  (value, at) =>
    Array.isArray(value) && value.length <= most
      ? value.map((entry, i) => item(entry, `${at}[${i}]`))
      : unformed(at);

const orNull =
  <T>(part: Part<T>): Part<T | null> =>
  (value, at) =>
    value === null ? null : part(value, at);

/** Text of at most `most` characters (code points), as it is: what the Mac compares, hands on
 *  whole or shows as many lines (a diff, an issue's body), never cut or changed here. */
const text =
  (most: number): Part<string> =>
  (value, at) =>
    typeof value === "string" && (value.length <= most || characters(value) <= most)
      ? value
      : unformed(at);

/** One line of text the Mac shows (a title, a name, a sentence): made printable here
 *  (shared/text.ts), so it holds no newline, tab or control, and cut at `most` with the mark
 *  rather than refused. A title from before a bound existed shows, cut; it does not refuse the
 *  list it is in. */
const line =
  (most: number): Part<string> =>
  (value, at) =>
    typeof value === "string" ? printable(value, most) : unformed(at);

declare namespace line {
  /** a note shown on one line holds no newline or tab, nor what a terminal acts on; plain text
   *  is as it was (the control) */
  export type OneLine = Table<
    typeof answered,
    [
      [
        args: [
          op: "domain.add-repo",
          value: { domain: "acme"; repo: "acme/web"; added: true; note: "a plain note" },
          asked: {},
        ],
        expected: { domain: "acme"; repo: "acme/web"; added: true; note: "a plain note" },
      ],
      [
        args: [
          op: "domain.add-repo",
          value: {
            domain: "acme";
            repo: "acme/web";
            added: true;
            note: "two\nlines\tand \u001b[2Jmore";
          },
          asked: {},
        ],
        expected: { domain: "acme"; repo: "acme/web"; added: true; note: "two?lines?and ?[2Jmore" },
      ],
    ]
  >;
}

/** A list of records the root collected from what workspaces sent (offers, issues, branches,
 *  the egress log): each is read on its own, and one not in its form is left out and counted,
 *  so one hostile record neither hides the rest nor locks the command (notShown says so). */
const some =
  <T>(item: Part<T>): Part<{ kept: T[]; dropped: number }> =>
  (value, at) => {
    if (!Array.isArray(value)) return unformed(at);
    const kept: T[] = [];
    for (const [i, entry] of value.entries())
      try {
        kept.push(item(entry, `${at}[${i}]`));
      } catch (error) {
        if (!(error instanceof Unformed)) throw error;
      }
    return { kept, dropped: value.length - kept.length };
  };

/** What a command says of the records `some` left out, once, or null when it left none. */
export const notShown = (dropped: number): string | null =>
  dropped === 0
    ? null
    : `${dropped} ${dropped === 1 ? "entry was" : "entries were"} not in a form this Mac shows`;

const whole =
  (min: number, max: number): Part<number> =>
  (value, at) =>
    Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max
      ? (value as number)
      : unformed(at);
const count = whole(0, Number.MAX_SAFE_INTEGER);

const yes: Part<boolean> = (value, at) => (typeof value === "boolean" ? value : unformed(at));

const oneOf =
  <const V extends readonly unknown[]>(...values: V): Part<V[number]> =>
  (value, at) =>
    values.includes(value) ? (value as V[number]) : unformed(at);

const named =
  (test: (value: unknown) => boolean): Part<string> =>
  (value, at) =>
    test(value) ? (value as string) : unformed(at);
const slug = named(isSlug);
const repo = named((value) => parseRepo(value) !== null);
const branch = named(isBranch);
const commit = named(isCommit);
/** A time as the root writes one (`toISOString`, or the proxy's seconds): shown, and sorted. */
const stamp = named(
  (value) => typeof value === "string" && /^\d{4}-\d\d-\d\dT[\d:.]{8,12}Z$/.test(value),
);

/** How long the root's own sentences and names may be, in characters: each far past what an
 *  honest root says (a sentence of a refusal, a hostname of 253), and each a bound on what this
 *  Mac holds and prints of an answer it did not choose. */
const SAID = {
  /** A hostname, a header's or a secret's name, a label. */
  name: 300,
  /** One sentence: a reason, a fix, a note, a check's detail. */
  sentence: 4000,
  /** A path in a repository, a route a request named. */
  path: 4096,
} as const;
/** The text a person signs to approve a push: shared/approval.ts reads no more than this. */
const APPROVAL_TEXT = 1024;
/** One page of a diff: root/offers.ts's DIFF_PAGE is 256 KiB of it, and a line the page cut is
 *  carried whole into the next. */
const DIFF_PAGE_MOST = 1024 * 1024;

/** A VM's size: each part a whole number up to what desolate makes for a person (shared/size.ts
 *  LIMITS), since the Mac gives a VM that much of itself. Only the most: a workspace an older
 *  desolate made smaller than today's least is a real one, and is listed, started and removed
 *  as any other (the least is the person's to keep to when asking: checkSize). */
const upTo = (most: number) => whole(1, most);
const parts = {
  cpus: upTo(LIMITS.cpus[1]),
  memoryMiB: upTo(LIMITS.memoryMiB[1]),
  diskGiB: upTo(LIMITS.diskGiB[1]),
};
const size = shape({
  cpus: maybe(parts.cpus),
  memoryMiB: maybe(parts.memoryMiB),
  diskGiB: maybe(parts.diskGiB),
});
const fullSize = shape(parts);

declare namespace size {
  /** a size an older desolate made, under today's least, is kept; one past the most desolate
   *  makes, and one of no CPUs, are refused */
  export type Most = Table<
    typeof answered,
    [
      [
        args: [
          op: "domain.size",
          value: { domain: "acme"; size: { memoryMiB: 1000; diskGiB: 20 } },
          asked: {},
        ],
        expected: { domain: "acme"; size: { memoryMiB: 1000; diskGiB: 20 } },
      ],
      [
        args: [
          op: "domain.size",
          value: { domain: "acme"; size: { memoryMiB: 1048576 } },
          asked: {},
        ],
        expected: "the root's answer to 'domain.size' is not in the form this Mac takes (size.memoryMiB)",
      ],
      [
        args: [op: "domain.size", value: { domain: "acme"; size: { cpus: 0 } }, asked: {}],
        expected: "the root's answer to 'domain.size' is not in the form this Mac takes (size.cpus)",
      ],
    ]
  >;
}

const listed = <T>(item: Part<T>) => shape({ items: list(item), total: count, from: count });

// ------------------------------------------------------------------ workspaces

/** One checkout of a workspace's: a worktree's name is one name (its branch with each `/` a
 *  `-`: root/domains.ts plan), and its path is the one the Mac builds from its repository, kind
 *  and name (shared/plan.ts), so never a path the root chose. */
const checkoutFields = shape({
  repo,
  kind: oneOf("main", "worktree"),
  name: text(NAMES.branch),
  branch,
  base: branch,
  path: text(SAID.path),
});
const checkout: Part<Of<typeof checkoutFields>> = (value, at) => {
  const c = checkoutFields(value, at);
  if (c.kind === "main" ? c.name !== "" : !isBranch(c.name) || c.name.includes("/"))
    unformed(`${at}.name`);
  if (c.path !== checkoutPath(c.repo, c.kind, c.name)) unformed(`${at}.path`);
  return c;
};

/** A workspace as the root records it (root/domains.ts Workspace): its VM is checked by
 *  whoever takes the record (vouched, domainRecord), against the name the Mac computes. */
const workspaceRecord = shape({
  domain: slug,
  workspace: slug,
  vm: text(SAID.name),
  title: line(200),
  checkouts: list(checkout),
  env: maybe(repo),
  repos: maybe(list(repo)),
  size: maybe(fullSize),
  author: maybe(shape({ name: line(200), email: line(200) })),
  startedBy: maybe(shape({ workspace: slug, createdAt: stamp })),
  fetch: yes,
  createdAt: stamp,
  state: oneOf("planned", "up", "stopped"),
});

declare namespace workspaceRecord {
  type W = {
    domain: "acme";
    workspace: "w1";
    vm: "dsl-main-ddb30a57cc";
    title: "w1";
    checkouts: [
      {
        repo: "acme/web";
        kind: "worktree";
        name: "fix-login";
        branch: "fix/login";
        base: "main";
        path: "/workspaces/acme/web/.worktrees/fix-login";
      },
    ];
    fetch: false;
    createdAt: "2026-11-16T10:00:00.000Z";
    state: "up";
  };
  type Asked = { domain: "acme"; name: "w1" };
  /** a workspace's record is taken in its form; what the Mac does not read is not passed on */
  export type Reads = Table<
    typeof answered,
    [
      [args: [op: "workspace.get", value: W, asked: Asked], expected: W],
      [
        args: [
          op: "workspace.get",
          value: Invoke<typeof changed, [value: W, changes: { extra: "dropped" }]>,
          asked: Asked,
        ],
        expected: W,
      ],
    ]
  >;
  /** each part that could aim the Mac elsewhere is refused: a checkout's path not the one
   *  its parts make, a worktree's name that climbs, a domain that is not a slug, a state it
   *  does not have, the wrong type, an array, null */
  export type Refuses = Table<
    typeof answered,
    [
      [
        args: [
          op: "workspace.get",
          value: Invoke<
            typeof changed,
            [
              value: W,
              changes: {
                checkouts: [
                  {
                    repo: "acme/web";
                    kind: "worktree";
                    name: "fix-login";
                    branch: "fix/login";
                    base: "main";
                    path: "/Users/someone";
                  },
                ];
              },
            ]
          >,
          asked: Asked,
        ],
        expected: "the root's answer to 'workspace.get' is not in the form this Mac takes (checkouts[0].path)",
      ],
      [
        args: [
          op: "workspace.get",
          value: Invoke<
            typeof changed,
            [
              value: W,
              changes: {
                checkouts: [
                  {
                    repo: "acme/web";
                    kind: "worktree";
                    name: "../../..";
                    branch: "fix/login";
                    base: "main";
                    path: "/workspaces/acme/web/.worktrees/../../..";
                  },
                ];
              },
            ]
          >,
          asked: Asked,
        ],
        expected: "the root's answer to 'workspace.get' is not in the form this Mac takes (checkouts[0].name)",
      ],
      [
        args: [
          op: "workspace.get",
          value: Invoke<typeof changed, [value: W, changes: { domain: "acme/../x" }]>,
          asked: Asked,
        ],
        expected: "the root's answer to 'workspace.get' is not in the form this Mac takes (domain)",
      ],
      [
        args: [
          op: "workspace.get",
          value: Invoke<typeof changed, [value: W, changes: { state: "deleted" }]>,
          asked: Asked,
        ],
        expected: "the root's answer to 'workspace.get' is not in the form this Mac takes (state)",
      ],
      [
        args: [
          op: "workspace.get",
          value: Invoke<typeof changed, [value: W, changes: { fetch: "no" }]>,
          asked: Asked,
        ],
        expected: "the root's answer to 'workspace.get' is not in the form this Mac takes (fetch)",
      ],
      [
        args: [op: "workspace.get", value: [W], asked: Asked],
        expected: "the root's answer to 'workspace.get' is not in the form this Mac takes (the answer itself)",
      ],
      [
        args: [op: "workspace.get", value: null, asked: Asked],
        expected: "the root's answer to 'workspace.get' is not in the form this Mac takes (the answer itself)",
      ],
    ]
  >;
}

/** Whether a record of the root's names its own workspace's VM, in that domain: the VM is a
 *  hash of the domain and the workspace's name that the Mac computes itself. */
export const isOwnVm = (domain: string, w: { domain?: unknown; workspace: unknown; vm: unknown }) =>
  (w.domain === undefined || w.domain === domain) &&
  isSlug(w.workspace) &&
  w.vm === workspaceVmName(INSTANCE, domain, w.workspace);

declare namespace isOwnVm {
  /** the VM a record names is the one the host computes for that workspace, in that domain */
  export type Records = Table<
    typeof isOwnVm,
    [
      [
        args: [domain: "acme", w: { domain: "acme"; workspace: "w1"; vm: "dsl-main-ddb30a57cc" }],
        expected: true,
      ],
      [args: [domain: "acme", w: { workspace: "w1"; vm: "dsl-main-ddb30a57cc" }], expected: true],
      /** another domain's workspace of the same name has another VM */
      [
        args: [domain: "acme", w: { domain: "acme"; workspace: "w1"; vm: "dsl-main-41eb634ef1" }],
        expected: false,
      ],
      [
        args: [domain: "acme", w: { domain: "beta"; workspace: "w1"; vm: "dsl-main-ddb30a57cc" }],
        expected: false,
      ],
      [
        args: [
          domain: "acme",
          w: { domain: "acme"; workspace: "../w1"; vm: "dsl-main-ddb30a57cc" },
        ],
        expected: false,
      ],
      [
        args: [domain: "acme", w: { domain: "acme"; workspace: "w1"; vm: "dsl-main-root" }],
        expected: false,
      ],
    ]
  >;
}

/** The root's word about one workspace, checked against what the host computes itself: a VM
 *  named in its answer is a VM the host stops, starts, destroys and writes state for (audit,
 *  2026-11-16: an answer naming another domain's VM would have had it removed). */
const vouched = <W extends { domain: string; workspace: string; vm: string }>(
  w: W,
  domain: unknown,
  workspace?: unknown,
): W => {
  if (
    w.domain !== domain ||
    (workspace !== undefined && w.workspace !== workspace) ||
    !isOwnVm(w.domain, w)
  )
    refuse(
      `the root's answer about ${String(domain)}/${String(workspace ?? w.workspace)} does not name that workspace's own VM`,
      "desolate doctor; if it persists, the root VM is not well: desolate bootstrap",
    );
  return w;
};

declare namespace vouched {
  type W = {
    domain: "acme";
    workspace: "w1";
    vm: "dsl-main-ddb30a57cc";
    title: "w1";
    checkouts: [];
    fetch: false;
    createdAt: "2026-11-16T10:00:00.000Z";
    state: "up";
  };
  /** the root's answer is taken only if it names the workspace asked about, and its own VM */
  export type Passes = Expect<
    Invoke<typeof answered, [op: "workspace.get", value: W, asked: { domain: "acme"; name: "w1" }]>,
    "=",
    W
  >;
  /** another domain's VM, another workspace, a plan named for another domain: refused */
  export type Refuses = Table<
    typeof answered,
    [
      [
        args: [
          op: "workspace.get",
          value: Invoke<typeof changed, [value: W, changes: { vm: "dsl-main-41eb634ef1" }]>,
          asked: { domain: "acme"; name: "w1" },
        ],
        expected: "the root's answer about acme/w1 does not name that workspace's own VM",
      ],
      [
        args: [
          op: "workspace.get",
          value: Invoke<typeof changed, [value: W, changes: { workspace: "w2" }]>,
          asked: { domain: "acme"; name: "w1" },
        ],
        expected: "the root's answer about acme/w1 does not name that workspace's own VM",
      ],
      [
        args: [
          op: "workspace.plan",
          value: Invoke<typeof changed, [value: W, changes: { domain: "beta" }]>,
          asked: { domain: "acme"; name: "w1" },
        ],
        expected: "the root's answer about acme/w1 does not name that workspace's own VM",
      ],
      [
        args: [
          op: "workspace.get",
          value: Invoke<typeof changed, [value: W, changes: { workspace: "--x" }]>,
          asked: { domain: "acme" },
        ],
        expected: "the root's answer to 'workspace.get' is not in the form this Mac takes (workspace)",
      ],
      /** a plan whose name the root chose (none was asked for) is taken with its own VM */
      [args: [op: "workspace.plan", value: W, asked: { domain: "acme" }], expected: W],
    ]
  >;
}

/** A domain as the root lists it, with its workspaces. A workspace record not in its form, or
 *  that does not name its own VM in this domain (it would give one domain's VM another
 *  domain's names, rules and proxy), is left out of `workspaces`, and named in `unformed`, as
 *  it may be printed: one record does not take the list down, and with it every command that
 *  reads it, and a workspace the person can no longer reach is said (unformedNotes, doctor). */
const domainFields = shape({
  slug,
  title: line(200),
  repos: list(repo),
  createdAt: stamp,
  env: maybe(repo),
  size: maybe(size),
  spawnMax: maybe(whole(0, 1000)),
  workspaces: (value, at) => (Array.isArray(value) ? value : unformed(at)),
});
/** What may be printed of a record not in its form: its name, made printable and short. */
const nameOf = (value: unknown, key: string) =>
  printable(
    typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : "?",
    NAMES.slug,
  ) || "?";
const domainRecord = (value: unknown, at: string) => {
  const d = domainFields(value, at);
  const workspaces: Of<typeof workspaceRecord>[] = [];
  const unformedOnes: string[] = [];
  for (const [i, entry] of d.workspaces.entries()) {
    try {
      const w = workspaceRecord(entry, `${at ? `${at}.` : ""}workspaces[${i}]`);
      if (w.domain === d.slug && isOwnVm(d.slug, w)) workspaces.push(w);
      else unformedOnes.push(nameOf(entry, "workspace"));
    } catch (error) {
      if (!(error instanceof Unformed)) throw error;
      unformedOnes.push(nameOf(entry, "workspace"));
    }
  }
  return { ...d, workspaces, ...(unformedOnes.length ? { unformed: unformedOnes } : {}) };
};

/** Every domain the root lists; one whose record is not in its form is left out of `domains`
 *  and named in `unformed`, rather than refusing them all. */
const domainList = (value: unknown, at: string) => {
  if (!Array.isArray(value)) return unformed(at);
  const domains: ReturnType<typeof domainRecord>[] = [];
  const unformedOnes: string[] = [];
  for (const [i, entry] of value.entries())
    try {
      domains.push(domainRecord(entry, `[${i}]`));
    } catch (error) {
      if (!(error instanceof Unformed)) throw error;
      unformedOnes.push(nameOf(entry, "slug"));
    }
  return { domains, unformed: unformedOnes };
};

/** Whether `answer`, the answer to `op`, is a domain's record or the list of them. */
export const listsDomains = (
  op: string,
  answer: unknown,
): answer is ReturnType<typeof domainList> | ReturnType<typeof domainRecord> =>
  (op === "domain.list" || op === "domain.show") && typeof answer === "object" && answer !== null;

/** What a command says, once, of the records a domain list or record left out, each with the
 *  command that names them. */
export const unformedNotes = (
  answer:
    | { domains: { slug: string; unformed?: string[] }[]; unformed: string[] }
    | {
        slug: string;
        unformed?: string[];
      },
): string[] => {
  const domains = "domains" in answer ? answer.domains : [answer];
  const notes = domains
    .filter((d) => d.unformed?.length)
    .map(
      (d) =>
        `${d.unformed!.length} workspace${d.unformed!.length === 1 ? "" : "s"} of ${d.slug} ${d.unformed!.length === 1 ? "was" : "were"} not in a form this Mac takes: desolate doctor`,
    );
  if ("domains" in answer && answer.unformed.length)
    notes.push(
      `${answer.unformed.length} domain${answer.unformed.length === 1 ? "" : "s"} ${answer.unformed.length === 1 ? "was" : "were"} not in a form this Mac takes: desolate doctor`,
    );
  return notes;
};

declare namespace domainRecord {
  type W = {
    domain: "acme";
    workspace: "w1";
    vm: "dsl-main-ddb30a57cc";
    title: "w1";
    checkouts: [];
    fetch: false;
    createdAt: "2026-11-16T10:00:00.000Z";
    state: "up";
  };
  type D = {
    slug: "acme";
    title: "Acme";
    repos: ["acme/web"];
    createdAt: "2026-11-16T09:00:00.000Z";
  };
  /** a domain's workspaces; a record naming another VM or another domain, or not in its form,
   *  is left out and named (the first row is the control) */
  export type Own = Table<
    typeof answered,
    [
      [
        args: [
          op: "domain.list",
          value: [Invoke<typeof changed, [value: D, changes: { workspaces: [W] }]>],
          asked: {},
        ],
        expected: {
          domains: [Invoke<typeof changed, [value: D, changes: { workspaces: [W] }]>];
          unformed: [];
        },
      ],
      [
        args: [
          op: "domain.list",
          value: [
            Invoke<
              typeof changed,
              [
                value: D,
                changes: {
                  workspaces: [
                    Invoke<typeof changed, [value: W, changes: { vm: "dsl-main-41eb634ef1" }]>,
                    Invoke<typeof changed, [value: W, changes: { domain: "beta" }]>,
                    Invoke<
                      typeof changed,
                      [value: W, changes: { workspace: "w9\u001b[2J"; state: "gone" }]
                    >,
                  ];
                },
              ]
            >,
          ],
          asked: {},
        ],
        expected: {
          domains: [
            Invoke<
              typeof changed,
              [value: D, changes: { workspaces: []; unformed: ["w1", "w1", "w9?[2J"] }]
            >,
          ];
          unformed: [];
        },
      ],
    ]
  >;
  /** a domain that is not a slug, or with a repository that is not one, is left out and named,
   *  beside one that is kept; an object for the list is refused */
  export type Refuses = Table<
    typeof answered,
    [
      [
        args: [
          op: "domain.list",
          value: [
            Invoke<typeof changed, [value: D, changes: { slug: "acme/x"; workspaces: [] }]>,
            Invoke<typeof changed, [value: D, changes: { workspaces: [] }]>,
          ],
          asked: {},
        ],
        expected: {
          domains: [Invoke<typeof changed, [value: D, changes: { workspaces: [] }]>];
          unformed: ["acme/x"];
        },
      ],
      [
        args: [
          op: "domain.list",
          value: [Invoke<typeof changed, [value: D, changes: { repos: ["../x"]; workspaces: [] }]>],
          asked: {},
        ],
        expected: { domains: []; unformed: ["acme"] },
      ],
      [
        args: [
          op: "domain.list",
          value: Invoke<typeof changed, [value: D, changes: { workspaces: [] }]>,
          asked: {},
        ],
        expected: "the root's answer to 'domain.list' is not in the form this Mac takes (the answer itself)",
      ],
      /** domain.show is about the domain asked for */
      [
        args: [
          op: "domain.show",
          value: Invoke<typeof changed, [value: D, changes: { workspaces: [] }]>,
          asked: { slug: "beta" },
        ],
        expected: "the root's answer to 'domain.show' is not in the form this Mac takes (slug)",
      ],
    ]
  >;
}

declare namespace unformedNotes {
  /** once for each domain with workspaces left out, and once for the domains; none for none */
  export type Notes = Table<
    typeof unformedNotes,
    [
      [args: [answer: { domains: [{ slug: "acme" }]; unformed: [] }], expected: []],
      [
        args: [answer: { domains: [{ slug: "acme"; unformed: ["w1", "w2"] }]; unformed: ["old"] }],
        expected: [
          "2 workspaces of acme were not in a form this Mac takes: desolate doctor",
          "1 domain was not in a form this Mac takes: desolate doctor",
        ],
      ],
    ]
  >;
}

/** An answer that must name what was asked about: `field` of it equal to `asked[key]`. */
const about =
  <T extends Record<string, unknown>>(part: Part<T>, field: keyof T & string, key: string) =>
  (value: unknown, asked: Asked): T => {
    const answer = part(value, "");
    return answer[field] === asked[key] ? answer : unformed(field);
  };

// ------------------------------------------------------------------ the rest of the answers

/** The most lines of a git VM push's account the Mac passes on to the person's terminal there:
 *  an honest one is a line or two (delivered, pushed, refused). */
const GIT_PUSH_SAID = 50;

/** One page of a diff: a later page starts past this one and within the diff, so asking for
 *  the next always moves on and ends (and a count of what was shown has a whole to be of). */
const diffPage: Part<{ text: string; from: number; next: number | null; total: number }> = (
  value,
  at,
) => {
  const d = shape({ text: text(DIFF_PAGE_MOST), from: count, next: orNull(count), total: count })(
    value,
    at,
  );
  if (d.from > d.total) unformed("from");
  if (d.next !== null && (d.next <= d.from || d.next > d.total)) unformed("next");
  return d;
};

declare namespace diffPage {
  /** a page that moves on, the last page, and an empty diff; a page that would be asked for
   *  again, or one past the end of the diff */
  export type Pages = Table<
    typeof answered,
    [
      [
        args: [op: "review.diff", value: { text: "+a\n"; from: 0; next: 3; total: 6 }, asked: {}],
        expected: { text: "+a\n"; from: 0; next: 3; total: 6 },
      ],
      [
        args: [
          op: "review.diff",
          value: { text: "+b\n"; from: 3; next: null; total: 6 },
          asked: {},
        ],
        expected: { text: "+b\n"; from: 3; next: null; total: 6 },
      ],
      [
        args: [op: "review.diff", value: { text: ""; from: 0; next: null; total: 0 }, asked: {}],
        expected: { text: ""; from: 0; next: null; total: 0 },
      ],
      [
        args: [op: "review.diff", value: { text: "+a\n"; from: 3; next: 3; total: 6 }, asked: {}],
        expected: "the root's answer to 'review.diff' is not in the form this Mac takes (next)",
      ],
      [
        args: [op: "review.diff", value: { text: ""; from: 0; next: 5; total: 0 }, asked: {}],
        expected: "the root's answer to 'review.diff' is not in the form this Mac takes (next)",
      ],
    ]
  >;
}

const issue = shape({
  id: named((value) => typeof value === "string" && ISSUE_ID.test(value)),
  repo,
  title: text(ISSUE.title),
  body: text(ISSUE.body),
  labels: list(text(ISSUE.label), ISSUE.labels),
  domain: slug,
  workspace: slug,
  at: stamp,
  state: oneOf("offered", "approving", "published", "rejected"),
  edited: maybe(yes),
  url: maybe(line(SAID.name)),
  problem: maybe(line(SAID.sentence)),
});

declare namespace issue {
  type I = {
    id: "w1abcd-0123abcd";
    repo: "acme/web";
    title: "Login loops";
    body: "";
    labels: ["bug"];
    domain: "acme";
    workspace: "w1";
    at: "2026-11-16T10:00:00.000Z";
    state: "offered";
  };
  /** the issue asked for, in its form; in a list, one with a title past GitHub's bound or a
   *  label for a list of labels is left out and counted, beside one that is kept; another
   *  issue than the one frozen is refused */
  export type Reads = Table<
    typeof answered,
    [
      [args: [op: "issue.freeze", value: I, asked: { id: "w1abcd-0123abcd" }], expected: I],
      [
        args: [
          op: "issue.list",
          value: [
            Invoke<
              typeof changed,
              [value: I, changes: { title: Invoke<typeof textOf, [length: 257]> }]
            >,
          ],
          asked: {},
        ],
        expected: { kept: []; dropped: 1 },
      ],
      [
        args: [
          op: "issue.list",
          value: [Invoke<typeof changed, [value: I, changes: { labels: "bug" }]>, I],
          asked: {},
        ],
        expected: { kept: [I]; dropped: 1 },
      ],
      [
        args: [op: "issue.freeze", value: I, asked: { id: "w2abcd-0123abcd" }],
        expected: "the root's answer to 'issue.freeze' is not in the form this Mac takes (id)",
      ],
    ]
  >;
}

const offer = shape({
  domain: slug,
  repo,
  branch,
  commit,
  workspace: line(NAMES.slug),
  lfs: count,
  at: stamp,
  base: maybe(branch),
});

const review = shape({
  domain: slug,
  repo,
  branch,
  commit,
  base: text(NAMES.branch + 8),
  against: oneOf("origin", "domain"),
  againstLabel: line(SAID.name),
  defaultBranch: orNull(branch),
  pushable: yes,
  isDefault: yes,
  commits: listed(
    shape({
      commit,
      subject: line(SAID.sentence),
      author: line(SAID.sentence),
      body: text(ISSUE.body),
    }),
  ),
  changes: listed(
    shape({
      path: text(SAID.path),
      status: oneOf("added", "modified", "deleted", "renamed", "changed"),
      added: orNull(count),
      removed: orNull(count),
      was: maybe(text(SAID.path)),
      lookalike: maybe(yes),
    }),
  ),
  stat: line(SAID.sentence),
  lfsObjects: count,
  warnings: list(line(SAID.sentence)),
  pushCommits: count,
});

declare namespace review {
  type R = {
    domain: "acme";
    repo: "acme/web";
    branch: "fix/login";
    commit: "0123456789abcdef0123456789abcdef01234567";
    base: "origin/main";
    against: "origin";
    againstLabel: "origin/main";
    defaultBranch: "main";
    pushable: true;
    isDefault: false;
    commits: {
      items: [
        {
          commit: "0123456789abcdef0123456789abcdef01234567";
          subject: "Fix the login";
          author: "A <a@example.com>";
          body: "";
        },
      ];
      total: 1;
      from: 0;
    };
    changes: {
      items: [{ path: "src/login.ts"; status: "modified"; added: 3; removed: 1 }];
      total: 1;
      from: 0;
    };
    stat: "1 file changed";
    lfsObjects: 0;
    warnings: [];
    pushCommits: 1;
  };
  /** a review in its form; a count that is not a whole number, a commit that is not an id */
  export type Reads = Table<
    typeof answered,
    [
      [args: [op: "review", value: R, asked: {}], expected: R],
      [
        args: [
          op: "review",
          value: Invoke<typeof changed, [value: R, changes: { pushCommits: -1 }]>,
          asked: {},
        ],
        expected: "the root's answer to 'review' is not in the form this Mac takes (pushCommits)",
      ],
      [
        args: [
          op: "review",
          value: Invoke<typeof changed, [value: R, changes: { commit: "HEAD" }]>,
          asked: {},
        ],
        expected: "the root's answer to 'review' is not in the form this Mac takes (commit)",
      ],
    ]
  >;
}

const secretListed = shape({
  name: named((value) => typeof value === "string" && /^[A-Z][A-Z0-9_-]{7,63}$/.test(value)),
  hosts: list(line(SAID.name)),
  headers: orNull(list(line(SAID.name))),
  on: yes,
  secondsLeft: maybe(count),
});

const ranked = listed(shape({ host: line(SAID.name), count }));

/** Keys the root's answer says it made: their roles, which must be the ones asked for (a read
 *  key unless anonymous, a write key only to push). Their public halves are not taken from it:
 *  repos.ts reads them from the keyring itself. */
const prepared = (value: unknown, asked: Asked) => {
  const answer = shape({
    repo,
    pushable: yes,
    anonymous: yes,
    keys: list(shape({ role: oneOf("read", "write") })),
  })(value, "");
  const roles = [...(asked.anonymous ? [] : ["read"]), ...(asked.push ? ["write"] : [])];
  const answeredRoles = answer.keys.map((k) => k.role);
  if (
    answeredRoles.length !== roles.length ||
    roles.some((role) => !answeredRoles.includes(role as "read"))
  )
    refuse(
      `the root answered for other keys than the ones asked for ${String(asked.repo)}, so none was registered`,
      "desolate doctor",
    );
  return answer;
};

declare namespace prepared {
  type Asked = { repo: "acme/web"; push: false; anonymous: false };
  /** the read key asked for, and no public half passed on; a write key a --no-push clone did
   *  not ask for, or a role that is neither, refused */
  export type Roles = Table<
    typeof answered,
    [
      [
        args: [
          op: "repo.prepare",
          value: {
            repo: "acme/web";
            pushable: false;
            anonymous: false;
            keys: [{ role: "read"; pubkey: "ssh-ed25519 AAAAroots" }];
          },
          asked: Asked,
        ],
        expected: { repo: "acme/web"; pushable: false; anonymous: false; keys: [{ role: "read" }] },
      ],
      [
        args: [
          op: "repo.prepare",
          value: {
            repo: "acme/web";
            pushable: false;
            anonymous: false;
            keys: [{ role: "read" }, { role: "write" }];
          },
          asked: Asked,
        ],
        expected: "the root answered for other keys than the ones asked for acme/web, so none was registered",
      ],
      [
        args: [
          op: "repo.prepare",
          value: {
            repo: "acme/web";
            pushable: false;
            anonymous: false;
            keys: [{ role: "../read" }];
          },
          asked: Asked,
        ],
        expected: "the root's answer to 'repo.prepare' is not in the form this Mac takes (keys[0].role)",
      ],
    ]
  >;
}

/** Where the root's proxies listen (root/proxy/as-proxy.ts proxyOutDir, under root/layout.ts's
 *  ROOT.proxies): a workspace's is `<domain>/<vm>.sock` there. The link is wired to the socket
 *  the Mac names for the workspace it asked about, never to one an answer chose. */
const PROXY_SOCKETS = "/var/lib/desolate-proxies/out";
const proxySocket = (value: unknown, asked: Asked) => {
  const socket = `${PROXY_SOCKETS}/${String(asked.domain)}/${String(asked.vm)}.sock`;
  const answer = shape({ socket: text(SAID.path) })(value, "");
  if (!isSlug(asked.domain) || answer.socket !== socket) unformed("socket");
  return { socket };
};

declare namespace proxySocket {
  type Asked = { vm: "dsl-main-ddb30a57cc"; domain: "acme"; workspace: "w1" };
  /** the workspace's own proxy, and no other socket in the root */
  export type Socket = Table<
    typeof answered,
    [
      [
        args: [
          op: "proxy.start",
          value: { socket: "/var/lib/desolate-proxies/out/acme/dsl-main-ddb30a57cc.sock" },
          asked: Asked,
        ],
        expected: { socket: "/var/lib/desolate-proxies/out/acme/dsl-main-ddb30a57cc.sock" },
      ],
      [
        args: [
          op: "proxy.start",
          value: { socket: "/var/lib/desolate-proxies/out/beta/dsl-main-41eb634ef1.sock" },
          asked: Asked,
        ],
        expected: "the root's answer to 'proxy.start' is not in the form this Mac takes (socket)",
      ],
      [
        args: [
          op: "proxy.start",
          value: { socket: ["/run/desolate/rootctl/rootctl.sock"] },
          asked: Asked,
        ],
        expected: "the root's answer to 'proxy.start' is not in the form this Mac takes (socket)",
      ],
    ]
  >;
}

/** A domain removed: the one asked about. Only then does the Mac remove its folder and its
 *  templates, by the name the person gave (workspaces.ts remove). */
const removedDomain = (value: unknown, asked: Asked) => {
  const answer = shape({ domain: text(NAMES.slug), kept: line(SAID.sentence) })(value, "");
  if (answer.domain !== asked.slug || !isSlug(asked.slug))
    refuse(
      `the root answered about another domain than ${String(asked.slug)}, so nothing was removed on this Mac`,
      "desolate doctor",
    );
  return answer;
};

declare namespace removedDomain {
  /** the domain asked about, or a refusal before anything on the Mac is removed */
  export type Removed = Table<
    typeof answered,
    [
      [
        args: [
          op: "domain.remove",
          value: { domain: "acme"; kept: "kept" },
          asked: { slug: "acme" },
        ],
        expected: { domain: "acme"; kept: "kept" },
      ],
      [
        args: [op: "domain.remove", value: { domain: ".."; kept: "kept" }, asked: { slug: "acme" }],
        expected: "the root answered about another domain than acme, so nothing was removed on this Mac",
      ],
      [
        args: [
          op: "domain.remove",
          value: { domain: "beta"; kept: "kept" },
          asked: { slug: "acme" },
        ],
        expected: "the root answered about another domain than acme, so nothing was removed on this Mac",
      ],
    ]
  >;
}

/** What root/push.ts prepare says a push is (the last line of its stdout, as JSON): the
 *  approval text, which the person's own words are checked against (push.ts approvalDiffers)
 *  before it is shown, and the summary and warnings shown beside it. */
export const pushPlan = (stdout: string) => {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim().split("\n").pop() ?? "");
  } catch {
    return unformedReply("push.ts prepare", "the answer itself");
  }
  try {
    return shape({
      message: text(APPROVAL_TEXT),
      summary: line(SAID.sentence),
      warnings: list(line(SAID.sentence), 50),
    })(value, "");
  } catch (error) {
    if (!(error instanceof Unformed)) throw error;
    return unformedReply("push.ts prepare", error.message);
  }
};

declare namespace pushPlan {
  /** the plan, its warnings as text; one whose approval text is not text, or that is no JSON */
  export type Plan = Table<
    typeof refusalOf,
    [
      [
        args: [
          f: typeof pushPlan,
          args: [
            'progress\n{"message":"desolate push approval v2\\n","summary":"1 commit","warnings":["big"]}',
          ],
        ],
        expected: null,
      ],
      [
        args: [f: typeof pushPlan, args: ['{"message":7,"summary":"","warnings":[]}']],
        expected: {
          message: "the root's answer to 'push.ts prepare' is not in the form this Mac takes (message)";
          fix: "desolate doctor; if it persists, the root VM is not well: desolate bootstrap";
          code: 1;
        },
      ],
      [
        args: [f: typeof pushPlan, args: ["not json"]],
        expected: {
          message: "the root's answer to 'push.ts prepare' is not in the form this Mac takes (the answer itself)";
          fix: "desolate doctor; if it persists, the root VM is not well: desolate bootstrap";
          code: 1;
        },
      ],
    ]
  >;
  /** a warning's escape arrives as text */
  export type Warnings = Expect<
    Invoke<
      typeof pushPlan,
      [stdout: '{"message":"m","summary":"s","warnings":["\\u001b[2Jgone"]}']
    >,
    "=",
    { message: "m"; summary: "s"; warnings: ["?[2Jgone"] }
  >;
}

/** An answer the Mac does not read: nothing of it is passed on. */
const ignored = (): void => {};

type Asked = Record<string, unknown>;
const of =
  <T>(part: Part<T>) =>
  (value: unknown, _asked: Asked): T =>
    part(value, "");

/** A value the Mac reads only through shared/events.ts, which takes each as a name of its
 *  form or as null (slugOrNull and the rest) and shows text printable: passed on as it is, so
 *  one odd record says null in its own events and does not stop the others'. */
const asIs: Part<unknown> = (value) => value;
const matching = (form: RegExp) => named((value) => typeof value === "string" && form.test(value));
/** A record (or a list of them) of these fields, each as it is, and of these parts. */
const record = <K extends string, F extends Fields = {}>(keys: K[], parts?: F) =>
  shape({
    ...(Object.fromEntries(keys.map((key) => [key, maybe(asIs)])) as Record<K, Maybe<unknown>>),
    ...(parts as F),
  });
const records = <K extends string, F extends Fields = {}>(keys: K[], parts?: F) =>
  maybe(list(record(keys, parts)));
/** The root's state as `desolate events` reads it (shared/events.ts stateEvents), and how many
 *  dashboards were opened (each asks every workspace's daemon for a look). */
const rootState = shape({
  offers: records(["domain", "workspace", "repo", "branch", "commit"]),
  refused: records(["domain", "repo", "why"]),
  approvals: records(["repo", "branch", "commit"]),
  issues: records(["id", "domain", "workspace", "repo", "title", "state", "url"]),
  domains: records(["slug"], {
    workspaces: records(["workspace", "state", "startedBy"], {
      checkouts: records(["repo"], { head: maybe(orNull(record(["branch", "commit"]))) }),
      says: maybe(shape({ status: maybe(orNull(record(["color", "message", "updated"]))) })),
    }),
  }),
  lookAsked: maybe(count),
});

/** Every operation the Mac asks of the root, and what it takes of the answer. */
const REPLIES = {
  ping: of(shape({ keyring: yes })),
  doctor: of(
    list(
      shape({
        name: line(SAID.name),
        ok: yes,
        detail: line(SAID.sentence),
        fix: maybe(line(SAID.sentence)),
      }),
    ),
  ),
  "forge.set": ignored,
  "keys.list": of(list(shape({ repo, role: oneOf("read", "write") }))),
  "repo.prepare": prepared,
  "repo.fetch": of(
    shape({
      repo,
      branches: count,
      defaultBranch: orNull(branch),
      lfsObjects: count,
      rootClone: oneOf("created", "present"),
    }),
  ),
  "repo.list": of(
    list(
      shape({
        repo,
        pushable: yes,
        anonymous: yes,
        defaultBranch: orNull(branch),
        fetchedAt: orNull(line(SAID.name)),
      }),
    ),
  ),
  "domain.list": of(domainList),
  "domain.show": about(domainRecord, "slug", "slug"),
  "domain.create": about(
    shape({ slug, title: line(200), repos: list(repo), createdAt: stamp }),
    "slug",
    "slug",
  ),
  "domain.add-repo": of(shape({ domain: slug, repo, added: yes, note: line(SAID.sentence) })),
  "domain.env": of(shape({ domain: slug, env: orNull(repo), repos: list(repo) })),
  "domain.size": of(shape({ domain: slug, size: orNull(size) })),
  "domain.spawn": ignored,
  "domain.env-key": of(
    orNull(
      shape({
        repo,
        spec: oneOf(".devcontainer", ".devcontainer.json"),
        id: commit,
      }),
    ),
  ),
  "domain.remove": removedDomain,
  "domain.projectSize": of(
    orNull(
      shape({
        repo,
        path: oneOf(".devcontainer/devcontainer.json", ".devcontainer.json"),
        size,
        problems: list(line(SAID.sentence)),
      }),
    ),
  ),
  "workspace.plan": (value: unknown, asked: Asked) =>
    vouched(workspaceRecord(value, ""), asked.domain, asked.name),
  "workspace.get": (value: unknown, asked: Asked) =>
    vouched(workspaceRecord(value, ""), asked.domain, asked.name),
  "workspace.state": ignored,
  "workspace.resize": ignored,
  "workspace.remove": ignored,
  "workspace.unpushed": of(
    list(
      shape({
        repo,
        branch: orNull(branch),
        commit: orNull(commit),
        count: orNull(count),
        why: orNull(line(SAID.sentence)),
      }),
    ),
  ),
  "proxy.start": proxySocket,
  "proxy.stop": ignored,
  "secret.list": of(list(secretListed)),
  "secret.apply": of(list(secretListed)),
  "net.policy": of(
    shape({
      mode: oneOf("open", "enforce"),
      hosts: list(line(SAID.name)),
      internal: list(line(SAID.name)),
      heldMiB: maybe(count),
    }),
  ),
  "net.recommend": of(
    shape({
      mode: oneOf("open", "enforce"),
      listed: list(line(SAID.name)),
      reached: ranked,
      refused: ranked,
    }),
  ),
  "net.log": of(
    shape({
      items: some(
        shape({
          time: line(SAID.name),
          domain: slug,
          workspace: maybe(line(SAID.name)),
          host: line(SAID.name),
          port: maybe(whole(0, 65535)),
          verdict: line(SAID.name),
          address: maybe(line(SAID.name)),
          via: maybe(line(SAID.name)),
          method: maybe(line(SAID.name)),
          route: maybe(line(SAID.path)),
          reason: maybe(line(SAID.sentence)),
          secrets: maybe(list(line(SAID.name))),
        }),
      ),
      total: count,
      from: count,
    }),
  ),
  "offers.list": of(some(offer)),
  "offers.refused": of(
    list(
      shape({ domain: slug, repo, at: stamp, why: line(SAID.sentence), fix: line(SAID.sentence) }),
    ),
  ),
  "offers.dismiss": ignored,
  "branches.list": of(
    some(
      shape({
        domain: slug,
        repo,
        branch,
        commit,
        landed: maybe(orNull(branch)),
        offered: yes,
        checkedOutIn: list(slug),
      }),
    ),
  ),
  review: of(review),
  "review.diff": of(diffPage),
  "suede.changed": of(
    list(
      shape({
        dir: text(SAID.path),
        remote: orNull(repo),
        branch,
        files: list(text(SAID.path)),
      }),
    ),
  ),
  "issue.list": of(some(issue)),
  "issue.freeze": about(issue, "id", "id"),
  "issue.done": ignored,
  "approvals.pending": of(
    list(
      shape({ message: text(APPROVAL_TEXT), summary: line(SAID.sentence), at: line(SAID.name) }),
    ),
  ),
  "approvals.wait": of(
    shape({
      tag: text(SAID.name),
      pending: list(shape({ message: text(APPROVAL_TEXT), at: line(SAID.name) })),
    }),
  ),
  "approvals.refuse": ignored,
  "approvals.answer": ignored,
  "git.push": of(
    shape({
      pushed: yes,
      error: maybe(line(SAID.sentence)),
      said: maybe(list(line(SAID.sentence), GIT_PUSH_SAID)),
    }),
  ),
  // The state service's own (host/daemon.ts heldAsker; rootctl's service does not answer
  // them). A request the dashboard queued is run only as hostArgv builds it from its kind and
  // arguments (shared/actions.ts), a workspace's spawn or close only once its signature is
  // checked (host/spawn.ts admit), in that order: so here only its id, which its progress is
  // said back with, as the service makes one. One whose id is not is left out.
  "stated.facts": ignored,
  "stated.nudge": ignored,
  "stated.signin": ignored,
  "stated.progress": ignored,
  "stated.state": of(shape({ tag: matching(/^[0-9a-f]{16}$/), state: rootState })),
  "stated.requests": of(
    some(shape({ id: matching(/^[0-9a-z]{1,12}-[0-9a-z]{1,8}$/), kind: asIs, args: asIs })),
  ),
} satisfies Record<string, (value: unknown, asked: Asked) => unknown>;

/** An operation the Mac may ask of the root, and what its answer is once it is checked. */
export type Op = keyof typeof REPLIES;
export type Answer<O extends Op> = ReturnType<(typeof REPLIES)[O]>;
/** A question for the root's state service: `stated.<it>` in the table. */
export type Stated = Op extends infer O ? (O extends `stated.${infer K}` ? K : never) : never;

/** The root's refusal, as the person is shown it: its words and its fix as text (printable),
 *  and an exit code from 1 to 255, so a refusal never exits 0. */
export const refusalIn = (reply: unknown): Refusal => {
  const r = (typeof reply === "object" && reply !== null ? reply : {}) as Record<string, unknown>;
  const code = r.code;
  return new Refusal(
    typeof r.error === "string" ? printable(r.error) : "the root refused",
    typeof r.fix === "string" ? printable(r.fix) : "",
    Number.isSafeInteger(code) && (code as number) >= 1 && (code as number) <= 255
      ? (code as number)
      : 1,
  );
};

/** The root's envelope around an answer (root/rootctl.ts): `{ok: true, result}`, taken as
 *  replyOf takes `result`; `{ok: false, ...}`, its refusal (refusalIn); anything else, an
 *  answer not in its form. */
export const opened = <O extends Op>(op: O, reply: unknown, asked: Asked = {}): Answer<O> => {
  const r = (typeof reply === "object" && reply !== null ? reply : {}) as Record<string, unknown>;
  if (r.ok === true) return replyOf(op, r.result, asked);
  if (r.ok === false) throw refusalIn(r);
  return unformedReply(op, "ok");
};

declare namespace opened {
  /** an answer; a refusal with its own exit code; one that says exit 0, or no number, or not
   *  text, still refuses (1), as text */
  export type Envelope = Table<
    typeof refusalOf,
    [
      [
        args: [f: typeof opened, args: ["ping", { ok: true; result: { keyring: true } }]],
        expected: null,
      ],
      [
        args: [
          f: typeof opened,
          args: ["ping", { ok: false; error: "no"; fix: "desolate bootstrap"; code: 64 }],
        ],
        expected: { message: "no"; fix: "desolate bootstrap"; code: 64 },
      ],
      [
        args: [f: typeof opened, args: ["ping", { ok: false; error: "gone\u001b[2J"; code: 0 }]],
        expected: { message: "gone?[2J"; fix: ""; code: 1 },
      ],
      [
        args: [f: typeof opened, args: ["ping", { ok: false; error: ["x"]; fix: 7; code: 256 }]],
        expected: { message: "the root refused"; fix: ""; code: 1 },
      ],
      [
        args: [f: typeof opened, args: ["ping", { ok: "yes"; result: { keyring: true } }]],
        expected: {
          message: "the root's answer to 'ping' is not in the form this Mac takes (ok)";
          fix: "desolate doctor; if it persists, the root VM is not well: desolate bootstrap";
          code: 1;
        },
      ],
    ]
  >;
}

/** The answer to `op`, asked with `asked`, as the Mac takes it; or a refusal that says which
 *  operation's answer was not in its form, and where. */
export const replyOf = <O extends Op>(op: O, value: unknown, asked: Asked = {}): Answer<O> => {
  try {
    return REPLIES[op](value, asked) as Answer<O>;
  } catch (error) {
    if (!(error instanceof Unformed)) throw error;
    return unformedReply(op, error.message);
  }
};
const unformedReply = (op: string, where: string): never =>
  refuse(
    `the root's answer to '${op}' is not in the form this Mac takes (${where})`,
    "desolate doctor; if it persists, the root VM is not well: desolate bootstrap",
  );

declare namespace replyOf {
  /** a refusal says which operation and where, and how to look into it; never what it held */
  export type Says = Throws<
    Invoke<typeof replyOf, [op: "ping", value: { keyring: "\u001b[2Jyes" }]>,
    "the root's answer to 'ping' is not in the form this Mac takes (keyring)"
  >;
  /** what an answer holds that the Mac does not read is not passed on */
  export type Drops = Expect<
    Invoke<typeof replyOf, [op: "ping", value: { keyring: true; node: "v22"; user: 501 }]>,
    "=",
    { keyring: true }
  >;
  /** an answer the Mac does not read at all gives the caller nothing of it */
  export type Ignored = Expect<
    Invoke<typeof replyOf, [op: "proxy.stop", value: { anything: ["at all"] }]>,
    "=",
    undefined
  >;
  /** a slug with a slash and a whole number that is not one are refused; a sentence past its
   *  bound is shown cut, with the mark */
  export type Forms = Table<
    typeof answered,
    [
      [
        args: [
          op: "domain.add-repo",
          value: { domain: "acme"; repo: "acme/web"; added: true; note: "" },
          asked: {},
        ],
        expected: { domain: "acme"; repo: "acme/web"; added: true; note: "" },
      ],
      [
        args: [
          op: "domain.add-repo",
          value: { domain: "acme/x"; repo: "acme/web"; added: true; note: "" },
          asked: {},
        ],
        expected: "the root's answer to 'domain.add-repo' is not in the form this Mac takes (domain)",
      ],
      [
        args: [
          op: "repo.fetch",
          value: {
            repo: "acme/web";
            branches: 1.5;
            defaultBranch: "main";
            lfsObjects: 0;
            rootClone: "present";
          },
          asked: {},
        ],
        expected: "the root's answer to 'repo.fetch' is not in the form this Mac takes (branches)",
      ],
      [
        args: [
          op: "domain.add-repo",
          value: {
            domain: "acme";
            repo: "acme/web";
            added: true;
            note: Invoke<typeof textOf, [length: 4001]>;
          },
          asked: {},
        ],
        expected: {
          domain: "acme";
          repo: "acme/web";
          added: true;
          note: Invoke<typeof cutOf, [length: 4000]>;
        },
      ],
    ]
  >;
}

declare namespace rootState {
  type W = { workspace: "w1"; state: "up"; startedBy: null; checkouts: []; says: { status: null } };
  /** the state as `desolate events` reads it: what it does not read is not passed on (a
   *  domain's network mode, the page's bounds), and a name not of its form is passed on, for
   *  stateEvents to make null; a tag not of its form, or a list that is not one, is refused,
   *  naming where */
  export type State = Table<
    typeof answered,
    [
      [
        args: [
          op: "stated.state",
          value: {
            tag: "0123456789abcdef";
            state: {
              domains: [{ slug: "-x"; net: "open"; workspaces: [W] }];
              bounds: { slug: 40 };
              lookAsked: 3;
            };
          },
          asked: {},
        ],
        expected: {
          tag: "0123456789abcdef";
          state: { domains: [{ slug: "-x"; workspaces: [W] }]; lookAsked: 3 };
        },
      ],
      [
        args: [op: "stated.state", value: { tag: "0123 HTTP/1.1"; state: {} }, asked: {}],
        expected: "the root's answer to 'stated.state' is not in the form this Mac takes (tag)",
      ],
      [
        args: [
          op: "stated.state",
          value: { tag: "0123456789abcdef"; state: { offers: "all" } },
          asked: {},
        ],
        expected: "the root's answer to 'stated.state' is not in the form this Mac takes (state.offers)",
      ],
    ]
  >;
  /** a request is passed on as it came, for hostArgv to build or refuse; one whose id is not
   *  one the service makes is left out and counted, beside one that is kept */
  export type Requests = Expect<
    Invoke<
      typeof answered,
      [
        op: "stated.requests",
        value: [
          { id: "mia1x2-abc123"; kind: "repo.fetch"; args: { repo: "acme/app" }; state: "queued" },
          { id: "../x"; kind: "repo.fetch"; args: {} },
        ],
        asked: {},
      ]
    >,
    "=",
    { kept: [{ id: "mia1x2-abc123"; kind: "repo.fetch"; args: { repo: "acme/app" } }]; dropped: 1 }
  >;
}
