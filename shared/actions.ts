// What the dashboard can ask the host to do (section 4.8): a fixed list. The root's state
// service uses it to refuse anything else at once and to show the command; the host's
// daemon uses it AGAIN, on the request it collects, to build the command it runs. The host
// never runs a command line the root VM wrote.
import { over } from "./limits.ts";
import { characters, isSlug, parseRepo } from "./names.ts";
import { checkoutsOf, LIMIT as SPAWN, parseSigned } from "./spawn.ts";
import { printable } from "./text.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Invoke, Table } from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { reposOf, textOf } from "../.harness/shared-actions.ts";

type Args = Record<string, string | undefined>;

/** What the dashboard's Create domain takes (R7: the root's ordinary user, which a domain's
 *  data passes through, writes the request; the host runs it). `repos`: the repositories a
 *  domain starts with, one click's worth (more are added with `desolate domain <d> add`).
 *  `title`: a label of plain printable ASCII, never an option, as long as the page's field. */
export const CREATE = { repos: 20, title: 80 } as const;
const TITLE = new RegExp(`^[\\x20-\\x7e]{1,${CREATE.title}}$`);
/** How long one argument of a host action may be, in characters (code points). R7: the
 *  root's ordinary user writes them, and the host parses them; one that is not text, or is
 *  longer, refuses the action (never left out of it). A spawn's command is JSON, which
 *  shared/spawn.ts's LIMIT.json bounds before it is signed, so every command a workspace
 *  may sign is carried. Its checkouts are 16 of `<owner/repo>=worktree:<branch>` (ASCII, at
 *  most 411 each), as JSON (New workspace's, comma-separated). Create's repos are 20 names
 *  of at most 201, comma-separated. Every other argument is a name, a size or a title. */
export const ARGUMENT = {
  command: SPAWN.json,
  checkouts: 8_000,
  repos: CREATE.repos * 202,
  other: 200,
} as const;
const argumentMost = (key: string) =>
  key === "command"
    ? ARGUMENT.command
    : key === "checkouts"
      ? ARGUMENT.checkouts
      : key === "repos"
        ? ARGUMENT.repos
        : ARGUMENT.other;
/** Within its bound: `length` (UTF-16 units) is never fewer than the characters, so only a
 *  long one is counted. */
const fits = (key: string, value: string) =>
  value.length <= argumentMost(key) || characters(value) <= argumentMost(key);
export const HOST_ACTIONS: Record<string, (a: Args) => string[] | null> = {
  "workspace.start": (a) =>
    isSlug(a.domain) && isSlug(a.workspace) ? ["start", `${a.domain}/${a.workspace}`] : null,
  "workspace.stop": (a) =>
    isSlug(a.domain) && isSlug(a.workspace) ? ["stop", `${a.domain}/${a.workspace}`] : null,
  // The dashboard's Delete: only what would lose nothing, checked again by the host when it
  // runs (workspaces.ts remove). A plain `desolate rm` is the person's own, in a terminal.
  "workspace.remove": (a) =>
    isSlug(a.domain) && isSlug(a.workspace)
      ? ["rm", `${a.domain}/${a.workspace}`, "--if-clean", "--if-pushed"]
      : null,
  // The dashboard's Resize: a stopped workspace's size, whole (the host refuses a running one,
  // and a smaller disk). Memory in MiB and disk in GiB, as the page sends them.
  "workspace.resize": (a) =>
    isSlug(a.domain) &&
    isSlug(a.workspace) &&
    /^[1-9]\d?$/.test(a.cpus ?? "") &&
    /^[1-9]\d{3,5}m$/.test(a.memory ?? "") &&
    /^[1-9]\d{1,3}g$/.test(a.disk ?? "")
      ? [
          "resize",
          `${a.domain}/${a.workspace}`,
          "--cpus",
          a.cpus!,
          "--memory",
          a.memory!,
          "--disk",
          a.disk!,
        ]
      : null,
  // `checkouts`: comma-separated, when New workspace was given another repository's
  // environment: every checkout named, that one's first (whose devcontainer `up` runs).
  "workspace.up": (a) => {
    const checkouts = a.checkouts ? checkoutsOf(a.checkouts.split(",")) : [];
    return checkouts &&
      isSlug(a.domain) &&
      (a.workspace === undefined || a.workspace === "" || isSlug(a.workspace))
      ? [
          "up",
          a.domain,
          ...(a.workspace ? ["--name", a.workspace] : []),
          ...checkouts.flatMap((c) => ["--checkout", c]),
        ]
      : null;
  },
  "repo.fetch": (a) => (a.repo !== undefined && parseRepo(a.repo) ? ["fetch", a.repo] : null),
  // `repos`: the repositories it starts with, comma-separated (each must be one).
  "domain.create": (a) => {
    const repos = a.repos ? a.repos.split(",") : [];
    // A title that is not one is refused, not left out (actionRefusal says why): a domain
    // made without the title the person typed is not what they asked for.
    if (a.title && (!TITLE.test(a.title) || a.title.startsWith("-"))) return null;
    return isSlug(a.domain) && repos.length <= CREATE.repos && repos.every((r) => parseRepo(r))
      ? [
          "domain",
          "create",
          a.domain,
          ...(a.title ? ["--title", a.title] : []),
          ...repos.flatMap((r) => ["--repo", r]),
        ]
      : null;
  },
  "domain.add": (a) =>
    isSlug(a.domain) && a.repo !== undefined && parseRepo(a.repo)
      ? ["domain", a.domain, "add", "--repo", a.repo]
      : null,
  // A workspace's own requests (shared/spawn.ts), queued by the root, never by a click: the
  // host's daemon runs one only after checking its signature against the asking
  // workspace's key (host/spawn.ts). The command is argv after `--`, never read by a shell.
  "workspace.spawn": (a) => {
    const r = signedOf("spawn", a);
    return r && r.op === "spawn"
      ? [
          "up",
          r.domain,
          "--name",
          r.name,
          "--started-by",
          r.parent,
          ...r.checkouts.flatMap((c) => ["--checkout", c]),
          ...(r.branch ? ["--branch", r.branch] : []),
          "--",
          ...r.command,
        ]
      : null;
  },
  "workspace.close": (a) => {
    const r = signedOf("close", a);
    return r ? ["rm", `${r.domain}/${r.name}`, "--if-clean"] : null;
  },
};
/** The kinds only a workspace's signed request makes: the dashboard cannot ask for them. */
export const SIGNED_KINDS = new Set(["workspace.spawn", "workspace.close"]);
/** A signed request carried as an action's arguments (strings; the command as JSON). */
export const signedOf = (op: "spawn" | "close", a: Args) => {
  let command: unknown = [];
  let checkouts: unknown = [];
  if (op === "spawn") {
    try {
      command = JSON.parse(a.command ?? "[]");
      checkouts = JSON.parse(a.checkouts ?? "[]");
    } catch {
      return null;
    }
  }
  return parseSigned({
    op,
    domain: a.domain,
    parent: a.parent,
    name: a.workspace,
    branch: a.branch,
    checkouts,
    command,
    at: a.at,
    nonce: a.nonce,
    mac: a.mac,
  });
};
export const hostArgv = (kind: unknown, args: unknown): string[] | null => {
  if (
    typeof kind !== "string" ||
    !Object.hasOwn(HOST_ACTIONS, kind) ||
    typeof args !== "object" ||
    args === null
  )
    return null;
  const clean: Args = {};
  // (Absent is absent: a key whose value is undefined was not given.)
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (value === undefined) continue;
    if (typeof value !== "string" || !fits(key, value)) return null;
    clean[key] = value;
  }
  return HOST_ACTIONS[kind]!(clean);
};

/** Why hostArgv refuses this action, as a sentence (R3: a bound that was hit is named, with
 *  its limit and the value), or null when it takes it. For whoever shows the refusal (the
 *  root's state service, the host's daemon): the bounds by name, and otherwise that the
 *  arguments are not ones the action takes. */
export const actionRefusal = (kind: unknown, args: unknown): string | null => {
  if (hostArgv(kind, args) !== null) return null;
  if (typeof kind !== "string" || !Object.hasOwn(HOST_ACTIONS, kind))
    return `'${printable(kind, 80)}' is not something the host does`;
  if (typeof args !== "object" || args === null) return "it was asked with no arguments";
  const given = args as Record<string, unknown>;
  for (const [key, value] of Object.entries(given)) {
    if (value === undefined) continue;
    if (typeof value !== "string") return `its ${printable(key, 40)} is not text`;
    if (!fits(key, value))
      return over(`its ${printable(key, 40)}`, argumentMost(key), characters(value), "characters");
  }
  if (kind === "domain.create") {
    const title = typeof given.title === "string" ? given.title : "";
    if (title && (!TITLE.test(title) || title.startsWith("-")))
      return characters(title) > CREATE.title
        ? over("the title", CREATE.title, characters(title), "characters")
        : "a title is plain letters, digits, spaces and punctuation (ASCII), and does not start with -";
    const repos = typeof given.repos === "string" && given.repos ? given.repos.split(",") : [];
    if (repos.length > CREATE.repos)
      return over("the new domain", CREATE.repos, repos.length, "repositories", "one Create takes");
  }
  return `those are not arguments '${kind}' takes`;
};

declare namespace actionRefusal {
  /** the bound that was hit, by name and number; and what the host does not do at all */
  export type Says = Table<
    typeof actionRefusal,
    [
      [
        args: [kind: "domain.create", args: { domain: "dev"; title: "widgets work" }],
        expected: null,
      ],
      [
        args: [
          kind: "domain.create",
          args: { domain: "dev"; title: Invoke<typeof textOf, [length: 81]> },
        ],
        expected: "the title is 81 characters, over the 80 allowed",
      ],
      [
        args: [kind: "domain.create", args: { domain: "dev"; title: "Caf\u00e9" }],
        expected: "a title is plain letters, digits, spaces and punctuation (ASCII), and does not start with -",
      ],
      [
        args: [
          kind: "domain.create",
          args: { domain: "dev"; repos: Invoke<typeof reposOf, [count: 21]> },
        ],
        expected: "the new domain is 21 repositories, over the 20 one Create takes",
      ],
      [
        args: [kind: "domain.create", args: { domain: Invoke<typeof textOf, [length: 201]> }],
        expected: "its domain is 201 characters, over the 200 allowed",
      ],
      [
        args: [kind: "workspace.rm", args: {}],
        expected: "'workspace.rm' is not something the host does",
      ],
      [
        args: [kind: "workspace.start", args: { domain: "dev"; workspace: "../x" }],
        expected: "those are not arguments 'workspace.start' takes",
      ],
    ]
  >;
}

declare namespace hostArgv {
  /** each kind the dashboard may ask for becomes one fixed `desolate` command line */
  export type Kinds = Table<
    typeof hostArgv,
    [
      [
        args: [kind: "workspace.start", args: { domain: "dev"; workspace: "w1" }],
        expected: ["start", "dev/w1"],
      ],
      [
        args: [kind: "workspace.stop", args: { domain: "dev"; workspace: "w1" }],
        expected: ["stop", "dev/w1"],
      ],
      [args: [kind: "workspace.up", args: { domain: "dev" }], expected: ["up", "dev"]],
      [
        args: [kind: "workspace.up", args: { domain: "dev"; workspace: "issue-12" }],
        expected: ["up", "dev", "--name", "issue-12"],
      ],
      [
        args: [
          kind: "workspace.up",
          args: { domain: "dev"; workspace: "w2"; checkouts: "acme/web=main,acme/api=worktree:w2" },
        ],
        expected: [
          "up",
          "dev",
          "--name",
          "w2",
          "--checkout",
          "acme/web=main",
          "--checkout",
          "acme/api=worktree:w2",
        ],
      ],
      [
        args: [kind: "repo.fetch", args: { repo: "acme/widgets" }],
        expected: ["fetch", "acme/widgets"],
      ],
      [
        args: [kind: "domain.create", args: { domain: "dev"; title: "widgets work" }],
        expected: ["domain", "create", "dev", "--title", "widgets work"],
      ],
      [
        args: [kind: "domain.add", args: { domain: "dev"; repo: "acme/widgets" }],
        expected: ["domain", "dev", "add", "--repo", "acme/widgets"],
      ],
      [
        args: [kind: "domain.create", args: { domain: "dev"; repos: "acme/widgets,acme/lib" }],
        expected: ["domain", "create", "dev", "--repo", "acme/widgets", "--repo", "acme/lib"],
      ],
      [
        args: [kind: "workspace.remove", args: { domain: "dev"; workspace: "w1" }],
        expected: ["rm", "dev/w1", "--if-clean", "--if-pushed"],
      ],
      [
        args: [
          kind: "workspace.resize",
          args: { domain: "dev"; workspace: "w1"; cpus: "4"; memory: "16384m"; disk: "60g" },
        ],
        expected: ["resize", "dev/w1", "--cpus", "4", "--memory", "16384m", "--disk", "60g"],
      ],
    ]
  >;
  /** nothing else: a kind not on the list (an object's own keys included), a name that is not
   *  a slug or a repository, anything that would read as an option, an argument that is not a
   *  string */
  export type Refuses = Table<
    typeof hostArgv,
    [
      [args: [kind: "workspace.rm", args: { domain: "dev"; workspace: "w1" }], expected: null],
      [
        args: [kind: "domain.create", args: { domain: "dev"; repos: "acme/widgets,--help" }],
        expected: null,
      ],
      [args: [kind: "__proto__", args: {}], expected: null],
      [args: [kind: "constructor", args: {}], expected: null],
      [args: [kind: "workspace.start", args: { domain: "dev" }], expected: null],
      [args: [kind: "workspace.start", args: { domain: "dev"; workspace: "../x" }], expected: null],
      [args: [kind: "workspace.start", args: { domain: "--all"; workspace: "w1" }], expected: null],
      [args: [kind: "workspace.up", args: { domain: "dev"; workspace: "--fetch" }], expected: null],
      [args: [kind: "workspace.up", args: { domain: "dev; rm -rf ~" }], expected: null],
      [
        args: [kind: "workspace.up", args: { domain: "dev"; checkouts: "acme/web=worktree:--x" }],
        expected: null,
      ],
      [args: [kind: "workspace.up", args: { domain: "dev"; checkouts: "--fetch" }], expected: null],
      [args: [kind: "repo.fetch", args: { repo: "--upload-pack=x" }], expected: null],
      [
        args: [kind: "domain.add", args: { domain: "dev"; repo: "acme/widgets/../x" }],
        expected: null,
      ],
      [args: [kind: "workspace.start", args: { domain: ["dev"]; workspace: "w1" }], expected: null],
      [args: [kind: "workspace.start", args: null], expected: null],
      [args: [kind: 7, args: {}], expected: null],
      [
        args: [
          kind: "workspace.resize",
          args: { domain: "dev"; workspace: "w1"; cpus: "4"; memory: "16g"; disk: "60g" },
        ],
        expected: null,
      ],
      [
        args: [
          kind: "workspace.resize",
          args: { domain: "dev"; workspace: "w1"; cpus: "--help"; memory: "16384m"; disk: "60g" },
        ],
        expected: null,
      ],
      [
        args: [kind: "workspace.resize", args: { domain: "dev"; workspace: "w1"; cpus: "4" }],
        expected: null,
      ],
    ]
  >;
  /** a title is a label: one that looks like an option, holds a control or is longer than
   *  the page's field is refused (actionRefusal says why), never left out of a domain made
   *  without it (until 2026-11-21 it was); none, or an empty one, is no title */
  export type Title = Table<
    typeof hostArgv,
    [
      [args: [kind: "domain.create", args: { domain: "dev"; title: "--help" }], expected: null],
      [
        args: [kind: "domain.create", args: { domain: "dev"; title: "a\u001b[2Jb" }],
        expected: null,
      ],
      [
        args: [
          kind: "domain.create",
          args: { domain: "dev"; title: Invoke<typeof textOf, [length: 81]> },
        ],
        expected: null,
      ],
      [
        args: [
          kind: "domain.create",
          args: { domain: "dev"; title: Invoke<typeof textOf, [length: 80]> },
        ],
        expected: ["domain", "create", "dev", "--title", Invoke<typeof textOf, [length: 80]>],
      ],
      [
        args: [kind: "domain.create", args: { domain: "dev"; title: "" }],
        expected: ["domain", "create", "dev"],
      ],
    ]
  >;
  /** a workspace's signed spawn: `up` with the command after `--`, each word one argv
   *  element, so a shell's syntax in a word is that word's text */
  export type Spawn = Expect<
    Invoke<
      typeof hostArgv,
      [
        kind: "workspace.spawn",
        args: {
          domain: "acme";
          workspace: "helper";
          parent: "w1";
          branch: "issue/9";
          checkouts: '["acme/api=main"]';
          command: '["claude","-p","fix it; $(rm -rf ~)"]';
          at: "2026-11-16T00:00:00.000Z";
          nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";
          mac: "abababababababababababababababababababababababababababababababab";
        },
      ]
    >,
    "=",
    [
      "up",
      "acme",
      "--name",
      "helper",
      "--started-by",
      "w1",
      "--checkout",
      "acme/api=main",
      "--branch",
      "issue/9",
      "--",
      "claude",
      "-p",
      "fix it; $(rm -rf ~)",
    ]
  >;
  /** a close removes only a clean workspace */
  export type Close = Expect<
    Invoke<
      typeof hostArgv,
      [
        kind: "workspace.close",
        args: {
          domain: "acme";
          workspace: "helper";
          parent: "w1";
          at: "2026-11-16T00:00:00.000Z";
          nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";
          mac: "abababababababababababababababababababababababababababababababab";
        },
      ]
    >,
    "=",
    ["rm", "acme/helper", "--if-clean"]
  >;
  /** a spawn whose command is not JSON, or is a shell line rather than words, or that names
   *  itself as its parent: nothing */
  export type BadSpawn = Table<
    typeof hostArgv,
    [
      [
        args: [
          kind: "workspace.spawn",
          args: {
            domain: "acme";
            workspace: "helper";
            parent: "w1";
            command: "claude -p hi";
            at: "2026-11-16T00:00:00.000Z";
            nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";
            mac: "abababababababababababababababababababababababababababababababab";
          },
        ],
        expected: null,
      ],
      [
        args: [
          kind: "workspace.spawn",
          args: {
            domain: "acme";
            workspace: "helper";
            parent: "w1";
            command: '"claude -p hi"';
            at: "2026-11-16T00:00:00.000Z";
            nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";
            mac: "abababababababababababababababababababababababababababababababab";
          },
        ],
        expected: null,
      ],
      [
        args: [
          kind: "workspace.spawn",
          args: {
            domain: "acme";
            workspace: "w1";
            parent: "w1";
            command: '["claude"]';
            at: "2026-11-16T00:00:00.000Z";
            nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";
            mac: "abababababababababababababababababababababababababababababababab";
          },
        ],
        expected: null,
      ],
    ]
  >;
}
