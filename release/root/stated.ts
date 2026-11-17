// The state service (section 4.8): one long-running process in the root VM that holds the
// stack's current state in memory and PUSHES changes to whoever is watching. The dashboard
// renders from it, so nothing is spawned to draw anything: v2's panel waited on process
// start-up, not on data.
//
//   node stated.ts          as the root's user; listens on the root VM's loopback
//
// WHAT IT KNOWS, AND FROM WHERE
//   the root's own facts   repositories, domains, workspaces and their checkouts, offers,
//                          each domain's network mode and secret names, raw pushes waiting
//                          for approval. Read from the root's files when one changes.
//   what workspaces say    each checkout's status and note, read as data (P4).
//   the host's facts       which VMs run, forwarded ports, each editor's address, a
//                          start's progress. The root cannot see these, and cannot ask: no
//                          VM can open a connection to the host. The host's daemon dials
//                          IN and tells it (PUT /host/facts), and nudges it when a file in
//                          a share changed (a VM gets no change events for a share).
//
// WHAT IT CAN DO
//   Nothing on the host by itself. The dashboard's actions are queued here; the host's
//   daemon collects them (GET /host/requests) and runs, as its own CLI, the ones on its
//   fixed list. A push is the exception that proves the rule: it starts here, as a
//   `git push origin` in the root clone, and then WAITS, like any raw push, for the person
//   to approve it on the host (`desolate approve`). Nothing here can approve.
//
// WHO MAY TALK TO IT
//   a browser   only as desolate.localhost, only same-origin (the editor gate's rules),
//               only with the cookie it got for the address `desolate ui` prints (so no
//               other program on the machine), and for actions only with a header a
//               cross-site page cannot send.
//   the host    with the token the host installed as root at bootstrap.
// Repository content (branch names, commit subjects, statuses, notes) leaves here as JSON
// strings and is put on the page as text, never as HTML.
import { pendingIn } from "./approvals.ts";
import { printable } from "../shared/text.ts";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as path from "node:path";
import { hostArgv, SIGNED_KINDS } from "../shared/actions.ts";
import { stateEvents } from "../shared/events.ts";
import { writeJson } from "../shared/json.ts";
import { outlived } from "../shared/plan.ts";
import type { Stats } from "../shared/stats.ts";
import {
  isBranch,
  isCommit,
  isLocalhostSuffix,
  isSlug,
  parseRepo,
  pullRequestUrl,
  ROOT_HOSTNAME,
  ROOT_UI,
} from "../shared/names.ts";
import { statusView } from "../shared/status.ts";
import type { Head } from "../shared/status.ts";
import { refusal, sameSecret } from "../shared/gate.ts";
import * as domains from "./domains.ts";
import { branchesOf, refusalsOf } from "./outbox.ts";
import { forge, safeIn } from "./git.ts";
import { APPROVALS, clonePath, domainPath, GITCONFIG, HOST_QUEUE, ROOT } from "./layout.ts";
import * as issues from "./issues.ts";
import { issueUrl } from "../shared/issues.ts";
import * as offers from "./offers.ts";
import * as proxy from "./proxy/manage.ts";
import { landedFor, pushedList } from "./pushed.ts";
import * as secrets from "./proxy/secrets.ts";
import * as repos from "./repos.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Given, Invoke, Table } from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { aDomain, emptyRoot, pathIn, writeIn, writeJsonIn } from "../.harness/root-state.ts";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const TOKEN_FILE = "/etc/desolate/host-token";
const readToken = (file: string): string | null => {
  try {
    const token = fs.readFileSync(file, "utf8").trim();
    return /^[0-9a-f]{48}$/.test(token) ? token : null;
  } catch {
    return null;
  }
};
declare namespace readToken {
  type Fresh = Invoke<typeof emptyRoot>;
  /** a token the host installed: 48 hex digits, whitespace around it ignored */
  export type Reads = Given<
    [
      Fresh,
      Invoke<
        typeof writeIn,
        [where: "state", name: "token", text: "0123456789abcdef0123456789abcdef0123456789abcdef\n"]
      >,
    ],
    Expect<
      Invoke<typeof readToken, [file: Invoke<typeof pathIn, [where: "state", name: "token"]>]>,
      "=",
      "0123456789abcdef0123456789abcdef0123456789abcdef"
    >
  >;
  /** anything else is no token at all, so nothing is let in with it: too short, not hex, none */
  export type NoToken = Given<
    [
      Fresh,
      Invoke<typeof writeIn, [where: "state", name: "short", text: "0123456789abcdef"]>,
      Invoke<
        typeof writeIn,
        [where: "state", name: "upper", text: "0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF"]
      >,
    ],
    [
      Expect<
        Invoke<typeof readToken, [file: Invoke<typeof pathIn, [where: "state", name: "short"]>]>,
        "=",
        null
      >,
      Expect<
        Invoke<typeof readToken, [file: Invoke<typeof pathIn, [where: "state", name: "upper"]>]>,
        "=",
        null
      >,
      Expect<
        Invoke<typeof readToken, [file: Invoke<typeof pathIn, [where: "state", name: "missing"]>]>,
        "=",
        null
      >,
    ]
  >;
}

const hostToken = () => readToken(TOKEN_FILE);
/** The person's browser's credential for the dashboard. The host made it and installed it
 *  as root; `desolate ui` prints the dashboard's address with it. The name and the origin
 *  checks keep other web pages out; they do not keep out another program on the machine,
 *  which can connect to the loopback port and send any Host and no Origin. Without this,
 *  any user of the Mac, or a sandboxed app allowed to reach localhost, read every
 *  workspace's editor address with its token (found on the M1; release/docs/incidents.md). */
const UI_TOKEN_FILE = "/etc/desolate/ui-token";
const uiToken = () => readToken(UI_TOKEN_FILE);
/** A cookie's name of this stack's own: cookies are kept per host name, not per port, and
 *  two stacks on one machine (a test beside the real one) share `desolate.localhost`. */
const cookieName = (token: string) =>
  `desolate_ui_${createHash("sha256").update(token).digest("hex").slice(0, 12)}`;

declare namespace cookieName {
  /** a name of this stack's own, from its token: two stacks on one machine keep two cookies */
  export type PerStack = Table<
    typeof cookieName,
    [
      [
        args: [token: "000000000000000000000000000000000000000000000000"],
        expected: "desolate_ui_f9a2ba511957",
      ],
      [
        args: [token: "111111111111111111111111111111111111111111111111"],
        expected: "desolate_ui_2f7a94061bca",
      ],
    ]
  >;
}

// ------------------------------------------------------------------ state
type HostFacts = {
  stack?: {
    instance: string;
    backend: string;
    isolated: boolean;
    editorPort: number;
    approver: string | null;
    rootHostname?: string;
    gitHostname?: string;
    mac?: { cpus: number; memoryMiB: number };
  };
  workspaces?: Record<
    string,
    {
      status: string;
      devcontainer?: string;
      editor?: string;
      ports?: { port: number; url: string }[];
      reserved?: number[];
      heldOnMac?: { port: number; by: string }[];
    }
  >;
  at?: string;
};
/** `link`: after a push, GitHub's page for opening its pull request (shared/names.ts). */
type Action = {
  id: string;
  kind: string;
  args: Record<string, string>;
  command: string;
  state: "queued" | "running" | "done" | "failed";
  lines: string[];
  at: string;
  code?: number;
  link?: string;
};
let facts: HostFacts = {};
let hostSeen = 0;
const actions: Action[] = [];
/** The host's long polls that are waiting for something to do. An action stays "queued"
 *  (and is handed to every poll) until the host reports on it: a poll whose connection
 *  died takes nothing with it. The host runs each id once. */
const waiters = new Set<() => void>();
const queued = () =>
  actions.filter((action) => action.state === "queued" && action.kind !== "offer.push");

const pendingApprovals = () =>
  pendingIn(APPROVALS).map(({ approval, summary }) => ({
    repo: approval.repo,
    branch: approval.branch,
    commit: approval.commit,
    summary,
  }));

/** The last HEAD each checkout was seen on: a read that caught one half written (null) shows
 *  that instead, so a `git switch` is one change and not two. */
const heads = new Map<string, Head>();
const settled = (key: string, head: Head | null): Head | null => {
  if (head) heads.set(key, head);
  return head ?? heads.get(key) ?? null;
};

/** The name of a domain's environment build (host/templates.ts): planned as a workspace for
 *  as long as it is being built, and refused as a workspace's name. */
export const TEMPLATE_BUILD = "template";

type Making = Pick<Action, "kind" | "args" | "state" | "lines" | "at">;

/** What a workspace waits on while the dashboard makes or starts it: the last line its
 *  action printed ("" before the first), or null when no action of the dashboard's is still
 *  at it. `desolate up` without a name makes a workspace named after it starts, so that one
 *  is the domain's workspace planned since. Dogfooding, 2026-11-17: the row said "planned",
 *  then "running" with Stop, a minute before its editor came, and none of it said it was
 *  still being made. */
export const makingOf = (
  w: { workspace: string; createdAt?: string },
  domain: string,
  list: readonly Making[],
): string | null => {
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const a = list[i]!;
    if ((a.state !== "queued" && a.state !== "running") || a.args.domain !== domain) continue;
    const named = a.args.workspace ?? "";
    const mine =
      a.kind === "workspace.start"
        ? named === w.workspace
        : a.kind === "workspace.up"
          ? // The environment is built by whichever up comes first, named or not.
            w.workspace === TEMPLATE_BUILD ||
            (named ? named === w.workspace : (w.createdAt ?? "") >= a.at)
          : false;
    if (!mine) continue;
    if (a.state === "queued") return "waiting for the Mac";
    const last = [...a.lines].reverse().find((line) => line.trim() !== "") ?? "";
    return printable(last.replace(/^progress:\s*/, "").trim()).slice(0, 200);
  }
  return null;
};

declare namespace makingOf {
  /** the dashboard's New workspace (no name) makes the one planned after it began; a named
   *  one, or a Start, is that workspace's; the environment build is the domain's first up's */
  export type Whose = Table<
    typeof makingOf,
    [
      [
        args: [
          w: { workspace: "w1"; createdAt: "2026-11-17T20:00:05.000Z" },
          domain: "acme",
          list: [
            {
              kind: "workspace.up";
              args: { domain: "acme"; workspace: "" };
              state: "running";
              lines: ["  its VM is up (10 s)", "progress:   docker (0.3 s)", ""];
              at: "2026-11-17T20:00:00.000Z";
            },
          ],
        ],
        expected: "docker (0.3 s)",
      ],
      [
        args: [
          w: { workspace: "template"; createdAt: "2026-11-17T20:00:01.000Z" },
          domain: "acme",
          list: [
            {
              kind: "workspace.up";
              args: { domain: "acme"; workspace: "w2" };
              state: "running";
              lines: ["  building acme's environment once"];
              at: "2026-11-17T20:00:00.000Z";
            },
          ],
        ],
        expected: "building acme's environment once",
      ],
      [
        args: [
          w: { workspace: "w1"; createdAt: "2026-11-16T09:00:00.000Z" },
          domain: "acme",
          list: [
            {
              kind: "workspace.start";
              args: { domain: "acme"; workspace: "w1" };
              state: "queued";
              lines: [];
              at: "2026-11-17T20:00:00.000Z";
            },
          ],
        ],
        expected: "waiting for the Mac",
      ],
    ]
  >;
  /** not this workspace's: one made before the action began, another domain's, another
   *  name's, a stop, or an action that is over */
  export type NotItsOwn = Table<
    typeof makingOf,
    [
      [
        args: [
          w: { workspace: "w1"; createdAt: "2026-11-16T09:00:00.000Z" },
          domain: "acme",
          list: [
            {
              kind: "workspace.up";
              args: { domain: "acme" };
              state: "running";
              lines: ["docker"];
              at: "2026-11-17T20:00:00.000Z";
            },
          ],
        ],
        expected: null,
      ],
      [
        args: [
          w: { workspace: "w1"; createdAt: "2026-11-17T20:00:05.000Z" },
          domain: "acme",
          list: [
            {
              kind: "workspace.up";
              args: { domain: "other" };
              state: "running";
              lines: ["docker"];
              at: "2026-11-17T20:00:00.000Z";
            },
            {
              kind: "workspace.up";
              args: { domain: "acme"; workspace: "w2" };
              state: "running";
              lines: ["docker"];
              at: "2026-11-17T20:00:00.000Z";
            },
            {
              kind: "workspace.stop";
              args: { domain: "acme"; workspace: "w1" };
              state: "running";
              lines: [];
              at: "2026-11-17T20:00:00.000Z";
            },
            {
              kind: "workspace.up";
              args: { domain: "acme" };
              state: "done";
              lines: ["made"];
              at: "2026-11-17T20:00:00.000Z";
            },
          ],
        ],
        expected: null,
      ],
    ]
  >;
}

const snapshot = () => {
  // What was pushed and has since landed in the branch it was for (pushed.ts): a branch
  // still at that commit is marked "merged into <base>".
  const pushed = pushedList();
  const list = domains.domains().map((d) => ({
    slug: d.slug,
    title: d.title,
    repos: d.repos,
    branches: branchesOf(d.slug, d.repos).map((b) => ({
      ...b,
      landed: landedFor(pushed, b.repo, b.branch, b.commit),
    })),
    net: proxy.policy(d.slug).mode,
    secrets: secrets.list(d.slug).map((s) => ({ name: s.name, on: s.on })),
    // The domain's environment, while it is built for its first workspace: shown as that,
    // not as a workspace named "template" with a Start button (dogfooding, 2026-11-17).
    building: domains.workspaces(d.slug).some((w) => w.workspace === TEMPLATE_BUILD)
      ? { line: makingOf({ workspace: TEMPLATE_BUILD }, d.slug, actions) ?? "" }
      : null,
    workspaces: domains
      .workspaces(d.slug)
      .filter((w) => w.workspace !== TEMPLATE_BUILD)
      .map((w, _, all) => {
        const says = statusView(path.join(domainPath(d.slug), "repos"), w);
        return {
          workspace: w.workspace,
          vm: w.vm,
          state: w.state,
          // Still being made or started by the dashboard's action: what it is at.
          making: makingOf(w, d.slug, actions),
          size: w.size ?? null,
          // Who asked for it (null: the person), and whether that one is gone before it.
          startedBy: w.startedBy?.workspace ?? null,
          outlived: outlived(all, w),
          // `branch` is what the checkout started on; `head`, what it has checked out now (its
          // HEAD, read as data: the host's daemon nudges when one changes).
          checkouts: w.checkouts.map((c, i) => ({
            repo: c.repo,
            branch: c.branch,
            kind: c.kind,
            head: settled(`${d.slug}/${w.workspace}/${c.repo}`, says.checkouts[i]?.head ?? null),
          })),
          says,
          host: facts.workspaces?.[w.vm] ?? null,
        };
      }),
  }));
  return {
    stack: facts.stack ?? null,
    // The host's daemon tells this service what only the host knows. If it has gone quiet,
    // what is shown about VMs is stale, and the page says so.
    hostConnected: Date.now() - hostSeen < 150_000,
    repos: repos
      .list()
      .map((r) => ({ repo: r.repo, pushable: r.pushable, defaultBranch: r.defaultBranch })),
    domains: list,
    spawnMax: Object.fromEntries(domains.domains().map((d) => [d.slug, d.spawnMax ?? null])),
    offers: offers.allOffers(),
    // Issues workspaces offered: every one still waiting, and the last few done with.
    issues: (() => {
      const all = issues.list();
      // (Done with: their title and page are enough; the body is sent only while it waits.)
      const done = all
        .filter((i) => i.state === "published" || i.state === "rejected")
        .slice(-10)
        .map((i) => ({ ...i, body: "" }));
      return [...all.filter((i) => i.state === "offered" || i.state === "approving"), ...done];
    })(),
    refused: domains.domains().flatMap((d) => refusalsOf(d.slug)),
    approvals: pendingApprovals(),
    actions: actions.slice(-12),
  };
};

// ------------------------------------------------------------------ pushing changes
let last = "";
const subscribers = new Set<ServerResponse>();
const publish = () => {
  let text: string;
  let state: ReturnType<typeof snapshot>;
  try {
    state = snapshot();
    text = JSON.stringify(state);
  } catch (error) {
    console.error(`stated: the state could not be read: ${String(error)}`);
    return;
  }
  if (text === last) return;
  last = text;
  try {
    forDomains(state);
  } catch (error) {
    console.error(`stated: a domain's stats or events could not be written: ${String(error)}`);
  }
  for (const subscriber of subscribers) subscriber.write(`data: ${text}\n\n`);
  for (const wake of [...stateWaiters]) wake();
};
/** The host's `GET /host/state` (host/events.ts), held until the state changes. */
const stateWaiters = new Set<() => void>();
const stateTag = () => createHash("sha256").update(last).digest("hex").slice(0, 16);
let scheduled: NodeJS.Timeout | null = null;
/** Something changed, or may have: look, soon, once. */
const changed = () => {
  if (scheduled) return;
  scheduled = setTimeout(() => {
    scheduled = null;
    publish();
  }, 40);
};

// ------------------------------------------------------------------ each domain's own view
// Into each domain's inbox, which its workspaces read and cannot write: its stats
// (`desolate domain stats` there) and its events (`desolate events`). Only that domain's.
type Snapshot = ReturnType<typeof snapshot>;
let before: Snapshot | null = null;
const written = new Map<string, string>();
const seq = new Map<string, number>();
const EVENTS_MAX = 512 * 1024;
const forDomains = (state: Snapshot) => {
  for (const d of state.domains) {
    const inbox = path.join(domainPath(d.slug), "inbox");
    if (!fs.existsSync(inbox)) continue;
    const running = d.workspaces.filter((w) => w.host?.status === "running");
    const stats: Omit<Stats, "at"> = {
      v: 1,
      domain: d.slug,
      title: d.title,
      repos: d.repos,
      spawn: {
        max: state.spawnMax[d.slug] ?? null,
        used: d.workspaces.filter((w) => w.startedBy).length,
      },
      mac: state.stack?.mac ?? null,
      running: {
        workspaces: running.length,
        memoryMiB: running.reduce((sum, w) => sum + (w.size?.memoryMiB ?? 0), 0),
      },
      workspaces: d.workspaces.map((w) => ({
        workspace: w.workspace,
        state: w.state,
        vm: w.host?.status ?? null,
        startedBy: w.startedBy,
        outlived: w.outlived,
        size: w.size,
        checkouts: w.checkouts.map((c) => ({
          repo: c.repo,
          branch: c.branch,
          head: c.head ? (c.head.branch ?? c.head.commit ?? null) : null,
        })),
        status: w.says.status
          ? { color: String(w.says.status.color), message: printable(w.says.status.message, 200) }
          : null,
      })),
    };
    const text = JSON.stringify(stats);
    if (written.get(d.slug) !== text) {
      writeJson(path.join(inbox, "domain.json"), { ...stats, at: new Date().toISOString() });
      written.set(d.slug, text);
    }
  }
  // Events: what changed since the last state, each to the domain it is about. (The first
  // state is where things stand, not news.)
  if (before) {
    const by = new Map<string, unknown[]>();
    for (const e of stateEvents(
      before as Parameters<typeof stateEvents>[0],
      state as Parameters<typeof stateEvents>[1],
    )) {
      const slug = (e as { domain?: unknown }).domain;
      if (
        typeof slug !== "string" ||
        (!state.domains.some((d) => d.slug === slug) &&
          !before.domains.some((d) => d.slug === slug))
      )
        continue;
      by.set(slug, [...(by.get(slug) ?? []), e]);
    }
    for (const [slug, events] of by) appendEvents(slug, events);
  }
  before = state;
};
const appendEvents = (slug: string, events: unknown[]) => {
  const file = path.join(domainPath(slug), "inbox", "events.jsonl");
  if (events.length === 0 || !fs.existsSync(path.dirname(file))) return;
  let n = seq.get(slug) ?? lastSeq(file);
  fs.appendFileSync(
    file,
    events.map((e) => `${JSON.stringify({ ...(e as object), seq: (n += 1) })}\n`).join(""),
    { mode: 0o644 },
  );
  seq.set(slug, n);
  // Kept to its last half when it grows past half a MiB: a reader follows by `seq`.
  if (fs.statSync(file).size > EVENTS_MAX) {
    const kept = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    fs.writeFileSync(`${file}.new`, `${kept.slice(Math.floor(kept.length / 2)).join("\n")}\n`, {
      mode: 0o644,
    });
    fs.renameSync(`${file}.new`, file);
  }
};
/** How a workspace's spawn or close ended, as the host reported it: an event in that domain,
 *  so the workspace that asked learns whether it was done, and if not, why. */
const requestEnded = (action: Action) => {
  // Ended either way: it no longer holds its name or a place against the limit (rootd counts
  // the queue). A spawn that failed held its name for half an hour, though no workspace had
  // it (dogfooding: a retry under another branch was refused, "already has a workspace").
  const queued = fromQueue.get(action.id);
  if (queued) {
    fs.rmSync(queued, { force: true });
    fromQueue.delete(action.id);
  }
  if (!SIGNED_KINDS.has(action.kind) || !isSlug(action.args.domain)) return;
  appendEvents(action.args.domain, [
    {
      v: 1,
      at: new Date().toISOString(),
      type: "request",
      source: "root",
      request: action.kind === "workspace.spawn" ? "spawn" : "close",
      domain: action.args.domain,
      workspace: isSlug(action.args.workspace) ? action.args.workspace : null,
      parent: isSlug(action.args.parent) ? action.args.parent : null,
      ok: action.code === 0,
      said: action.lines
        .filter((line) => !/tkn=/.test(line))
        .slice(-4)
        .map((line) => printable(line, 300))
        .join(" / "),
    },
  ]);
};
const lastSeq = (file: string) => {
  try {
    const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
    return Number((JSON.parse(lines[lines.length - 1] ?? "{}") as { seq?: unknown }).seq) || 0;
  } catch {
    return 0;
  }
};

// ------------------------------------------------------------------ a workspace's requests
// A workspace's signed spawn or close, queued by rootd (rootd.ts): handed to the host as an
// action, which runs it only once it has checked the signature (host/spawn.ts). Renamed as
// it is taken, so rootd still counts it against the domain's limit until the workspace
// exists; swept after half an hour.
/** Which queue file each action came from, to remove it when the action ends. */
const fromQueue = new Map<string, string>();
const takeQueue = () => {
  let names: string[];
  try {
    names = fs.readdirSync(HOST_QUEUE);
  } catch {
    return;
  }
  for (const name of names) {
    const file = path.join(HOST_QUEUE, name);
    if (name.endsWith(".taken")) {
      try {
        if (Date.now() - fs.statSync(file).mtimeMs > 30 * 60_000) fs.rmSync(file, { force: true });
      } catch {
        /* gone */
      }
      continue;
    }
    if (!/^[0-9a-z]+-[0-9a-f]{10}\.json$/.test(name)) continue;
    try {
      const item = JSON.parse(fs.readFileSync(file, "utf8")) as {
        kind?: unknown;
        args?: Record<string, string>;
      };
      const taken = file.replace(/\.json$/, ".taken");
      fs.renameSync(file, taken);
      if (typeof item.kind === "string" && SIGNED_KINDS.has(item.kind) && item.args) {
        const action = act(item.kind, item.args, { signed: true });
        if ("id" in action) fromQueue.set(action.id, taken);
      }
      changed();
    } catch (error) {
      console.error(`stated: a workspace's request could not be taken: ${String(error)}`);
      fs.rmSync(file, { force: true });
    }
  }
};

// ------------------------------------------------------------------ actions
const quote = (word: string) =>
  /^[A-Za-z0-9_./:=@-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`;

declare namespace quote {
  /** the command shown on the dashboard is one a person could paste: a word that a shell
   *  would read as more than a word is quoted */
  export type Words = Table<
    typeof quote,
    [
      [args: [word: "acme/w1"], expected: "acme/w1"],
      [args: [word: "--title"], expected: "--title"],
      [args: [word: "Acme widgets"], expected: "'Acme widgets'"],
      [args: [word: "it's"], expected: "'it'\\''s'"],
      [args: [word: "$(rm -rf ~)"], expected: "'$(rm -rf ~)'"],
    ]
  >;
}

const act = (
  kind: string,
  args: Record<string, string>,
  from: { signed?: boolean } = {},
): Action | { error: string } => {
  // A spawn or a close is a workspace's signed request, never a click on the dashboard.
  if (SIGNED_KINDS.has(kind) && !from.signed)
    return { error: `'${kind}' is asked for by a workspace, not from the dashboard` };
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const record = (command: string): Action => {
    const action: Action = {
      id,
      kind,
      args,
      command,
      state: "queued",
      lines: [],
      at: new Date().toISOString(),
    };
    actions.push(action);
    // The oldest finished one goes: never one still waiting for the host (a flood of a
    // domain's requests pushed others', and the person's clicks, out before they ran: audit).
    if (actions.length > 50) {
      const done = actions.findIndex((a) => a.state === "done" || a.state === "failed");
      if (done >= 0) actions.splice(done, 1);
      else if (actions.length > 1000) actions.shift();
    }
    return action;
  };
  if (kind === "offer.push") return push(args, record);
  const argv = hostArgv(kind, args);
  if (!argv) return { error: `'${kind}' with those arguments is not something the dashboard does` };
  // The command shown is the one the host will run: the dashboard teaches the CLI.
  const shown = `desolate ${argv.map(quote).join(" ")}`;
  const action = record(shown.length > 600 ? `${shown.slice(0, 600)} ...` : shown);
  for (const wake of [...waiters]) wake();
  return action;
};

declare namespace act {
  /** a click is queued for the host as the one command it will run, which the page shows */
  export type Queues = [
    Expect<
      Invoke<typeof act, [kind: "workspace.start", args: { domain: "acme"; workspace: "w1" }]>,
      "matches",
      { kind: "workspace.start"; state: "queued"; command: "desolate start acme/w1"; lines: [] }
    >,
    Expect<
      Invoke<typeof act, [kind: "domain.create", args: { domain: "acme"; title: "Acme widgets" }]>,
      "matches",
      { command: "desolate domain create acme --title 'Acme widgets'" }
    >,
  ];
  /** a spawn or a close is a workspace's signed request, never a click; and nothing off the
   *  host's fixed list is anything */
  export type Refuses = Table<
    typeof act,
    [
      [
        args: [kind: "workspace.spawn", args: { domain: "acme"; workspace: "helper" }],
        expected: {
          error: "'workspace.spawn' is asked for by a workspace, not from the dashboard";
        },
      ],
      [
        args: [kind: "workspace.close", args: { domain: "acme"; workspace: "helper" }],
        expected: {
          error: "'workspace.close' is asked for by a workspace, not from the dashboard";
        },
      ],
      [
        args: [kind: "workspace.rm", args: { domain: "acme"; workspace: "w1" }],
        expected: {
          error: "'workspace.rm' with those arguments is not something the dashboard does";
        },
      ],
      [
        args: [kind: "workspace.start", args: { domain: "acme"; workspace: "--all" }],
        expected: {
          error: "'workspace.start' with those arguments is not something the dashboard does";
        },
      ],
    ]
  >;
}

/** A push from the dashboard: `git push origin <commit>:<branch>` in the root clone. That
 *  goes to git-remote-desolate-push, which asks the keyring for a challenge and waits for
 *  the person to approve it on the host. This process cannot approve it. */
const push = (
  args: Record<string, string>,
  record: (command: string) => Action,
): Action | { error: string } => {
  const repo = parseRepo(args.repo);
  if (!isSlug(args.domain) || !repo || !isBranch(args.branch) || !isCommit(args.commit))
    return {
      error: "a push names a domain, a repository, a branch and the commit that was reviewed",
    };
  const offer = offers
    .offersOf(args.domain)
    .find((o) => o.repo === args.repo && o.branch === args.branch);
  if (!offer || offer.commit !== args.commit)
    return {
      error: `${args.branch} is no longer offered at ${args.commit.slice(0, 12)}: it moved, or was withdrawn. Review it again.`,
    };
  const action = record(
    `desolate push ${args.domain} ${args.repo} ${args.branch} --expect ${args.commit}`,
  );
  action.state = "running";
  action.lines.push(
    "waiting for your approval on the host: run `desolate approve` in a terminal there",
  );
  const child = spawn(
    "git",
    [
      ...safeIn(clonePath(repo)),
      "-C",
      clonePath(repo),
      "push",
      "--porcelain",
      "origin",
      `${args.commit}:refs/heads/${args.branch}`,
    ],
    {
      env: { ...process.env, GIT_CONFIG_GLOBAL: GITCONFIG, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const take = (chunk: Buffer) => {
    for (const line of chunk
      .toString()
      .split("\n")
      .map((l) => printable(l, 300, " ").trim())
      .filter(Boolean))
      action.lines.push(line.slice(0, 300));
    if (action.lines.length > 60) action.lines.splice(0, action.lines.length - 60);
    changed();
  };
  child.stdout.on("data", take);
  child.stderr.on("data", take);
  child.on("close", (code) => {
    action.code = code ?? 1;
    action.state = code === 0 ? "done" : "failed";
    if (code === 0) {
      offers.withdraw(args.domain!, args.repo!, args.branch!);
      action.lines.push(`pushed ${args.repo} ${args.branch} at ${args.commit}`);
      // (Recorded by the push itself, in raw-push.ts; this is only the page's link.)
      try {
        const base =
          offer.base ?? repos.list().find((r) => r.repo === args.repo)?.defaultBranch ?? null;
        action.link =
          (forge().kind === "github" ? pullRequestUrl(args.repo!, args.branch!, base) : null) ??
          undefined;
      } catch {
        /* no forge on record: no link */
      }
    }
    changed();
  });
  return action;
};

declare namespace push {
  type Fresh = Invoke<typeof emptyRoot>;
  /** the dashboard's Push is for the commit the person reviewed, still offered at it: a
   *  malformed one, one never offered, and one that moved since are refused before git runs.
   *  (One that passes waits for the person's approval on the host: T2's.) */
  export type Refuses = Given<
    [
      Fresh,
      Invoke<typeof aDomain, [slug: "acme", repos: ["acme/app"]]>,
      Invoke<
        typeof writeJsonIn,
        [
          where: "domains",
          name: "acme/offers.json",
          value: [
            {
              domain: "acme";
              repo: "acme/app";
              branch: "fix";
              commit: "0123456789abcdef0123456789abcdef01234567";
              workspace: "w1";
              lfs: 0;
              at: "2026-11-16T12:00:00.000Z";
            },
          ],
        ]
      >,
    ],
    [
      Expect<
        Invoke<
          typeof act,
          [
            kind: "offer.push",
            args: { domain: "acme"; repo: "acme/app"; branch: "fix"; commit: "HEAD" },
          ]
        >,
        "=",
        { error: "a push names a domain, a repository, a branch and the commit that was reviewed" }
      >,
      Expect<
        Invoke<
          typeof act,
          [
            kind: "offer.push",
            args: {
              domain: "acme";
              repo: "acme/app";
              branch: "--force";
              commit: "0123456789abcdef0123456789abcdef01234567";
            },
          ]
        >,
        "=",
        { error: "a push names a domain, a repository, a branch and the commit that was reviewed" }
      >,
      Expect<
        Invoke<
          typeof act,
          [
            kind: "offer.push",
            args: {
              domain: "acme";
              repo: "acme/app";
              branch: "other";
              commit: "0123456789abcdef0123456789abcdef01234567";
            },
          ]
        >,
        "=",
        {
          error: "other is no longer offered at 0123456789ab: it moved, or was withdrawn. Review it again.";
        }
      >,
      Expect<
        Invoke<
          typeof act,
          [
            kind: "offer.push",
            args: {
              domain: "acme";
              repo: "acme/app";
              branch: "fix";
              commit: "89abcdef0123456789abcdef0123456789abcdef";
            },
          ]
        >,
        "=",
        {
          error: "fix is no longer offered at 89abcdef0123: it moved, or was withdrawn. Review it again.";
        }
      >,
    ]
  >;
}

// ------------------------------------------------------------------ http
const body = (req: IncomingMessage, limit = 262_144): Promise<unknown> =>
  new Promise((resolve, reject) => {
    let text = "";
    req.on("data", (chunk) => {
      text += chunk;
      if (text.length > limit) {
        reject(new Error("too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(error as Error);
      }
    });
    req.on("error", reject);
  });
const SECURITY = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
  "cross-origin-resource-policy": "same-origin",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), clipboard-read=()",
};
const send = (res: ServerResponse, status: number, type: string, content: string) => {
  res.writeHead(status, {
    "content-type": type,
    "content-length": Buffer.byteLength(content),
    ...SECURITY,
  });
  res.end(content);
};
const json = (res: ServerResponse, status: number, value: unknown) =>
  send(res, status, "application/json; charset=utf-8", JSON.stringify(value));
const STATIC: Record<string, [string, string]> = {
  "/": ["dashboard.html", "text/html; charset=utf-8"],
  "/ui.js": ["dashboard.js", "text/javascript; charset=utf-8"],
  "/ui.css": ["dashboard.css", "text/css; charset=utf-8"],
  // Syntax colour for the diff (shared/ui/highlight.js says how it is kept to colour).
  "/highlight.js": ["../../shared/ui/highlight.js", "text/javascript; charset=utf-8"],
  "/highlight-worker.js": ["../../shared/ui/highlight-worker.js", "text/javascript; charset=utf-8"],
  // An offered issue's preview: Markdown built as elements, never as HTML.
  "/markdown.js": ["../../shared/ui/markdown.js", "text/javascript; charset=utf-8"],
};

const fromHost = (req: IncomingMessage) => {
  const token = hostToken();
  const given = /^Bearer ([0-9a-f]{48})$/.exec(String(req.headers.authorization ?? ""))?.[1];
  return token !== null && given !== undefined && sameSecret(given, token);
};

const handle = async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname.startsWith("/host/")) {
    if (!fromHost(req)) return json(res, 403, { error: "this is the host daemon's side" });
    hostSeen = Date.now();
    if (req.method === "PUT" && url.pathname === "/host/facts") {
      facts = (await body(req)) as HostFacts;
      changed();
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/host/nudge") {
      changed();
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/host/progress") {
      const report = (await body(req)) as {
        id?: string;
        lines?: string[];
        done?: boolean;
        code?: number;
      };
      const action = actions.find((a) => a.id === report.id);
      if (action) {
        action.state = report.done ? (report.code === 0 ? "done" : "failed") : "running";
        if (report.done) action.code = report.code;
        for (const line of report.lines ?? []) action.lines.push(printable(line, 300, " "));
        if (action.lines.length > 60) action.lines.splice(0, action.lines.length - 60);
        if (report.done) requestEnded(action);
        changed();
      }
      return json(res, 200, { ok: true });
    }
    // The issues the person chose to publish, waiting for the approval on the Mac
    // (host/issues.ts); and what became of each.
    if (req.method === "GET" && url.pathname === "/host/issues")
      return json(
        res,
        200,
        issues.list().filter((i) => i.state === "approving"),
      );
    if (req.method === "POST" && url.pathname === "/host/issue") {
      const told = (await body(req)) as { id?: unknown; url?: unknown; refused?: unknown };
      const issue = issues.get(told.id);
      if (!issue) return json(res, 404, { error: "no such issue" });
      const where = told.url === undefined ? null : issueUrl(issue.repo, told.url);
      const result = where
        ? issues.published(issue.id, where)
        : issues.backToDraft(
            issue.id,
            typeof told.refused === "string" ? told.refused : "not published",
          );
      changed();
      return "error" in result ? json(res, 409, result) : json(res, 200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/host/state") {
      // The state, when it is not the one the host has (by its tag): for `desolate events`.
      if (!last) publish();
      const send = () => json(res, 200, { tag: stateTag(), state: JSON.parse(last || "{}") });
      if (url.searchParams.get("since") !== stateTag()) return send();
      const answer = () => {
        clearTimeout(timer);
        stateWaiters.delete(answer);
        if (!res.writableEnded) send();
      };
      const timer = setTimeout(answer, 50_000);
      stateWaiters.add(answer);
      res.on("close", () => {
        clearTimeout(timer);
        stateWaiters.delete(answer);
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/host/requests") {
      // Held open until there is something to do: the host learns of a click at once.
      if (queued().length > 0) return json(res, 200, queued());
      const answer = () => {
        clearTimeout(timer);
        waiters.delete(answer);
        if (!res.writableEnded) json(res, 200, queued());
      };
      const timer = setTimeout(answer, 50_000);
      waiters.add(answer);
      res.on("close", () => {
        clearTimeout(timer);
        waiters.delete(answer);
      });
      return;
    }
    return json(res, 404, { error: "no such thing" });
  }

  // A browser. The gate's rules: this name only, this origin only.
  // The dashboard's name, as the host says it is (a stack inside a workspace has its own:
  // shared/names.ts, HOSTNAME_SUFFIX); checked, and desolate.localhost until it says.
  const named = facts.stack?.rootHostname;
  const refused = refusal(
    typeof named === "string" && named.startsWith("desolate.") && isLocalhostSuffix(named.slice(9))
      ? named
      : ROOT_HOSTNAME,
    req.headers,
  );
  if (refused)
    return send(
      res,
      refused.status,
      "text/plain; charset=utf-8",
      `desolate: refused ${refused.why.replace("this is the editor of", "this is the dashboard at")}\n`,
    );
  const ui = uiToken();
  if (!ui)
    return send(
      res,
      503,
      "text/plain; charset=utf-8",
      "desolate: the dashboard has no credential installed yet; run `desolate bootstrap` on the host\n",
    );
  const name = cookieName(ui);
  const given = url.searchParams.get("tkn");
  if (req.method === "GET" && url.pathname === "/" && given !== null) {
    if (!sameSecret(given, ui))
      return send(
        res,
        403,
        "text/plain; charset=utf-8",
        "desolate: refused: that is not this dashboard's address; `desolate ui` prints it\n",
      );
    // Exchanged for a cookie the page's own script cannot read, sent to this name only,
    // and never on a request another site starts; the token leaves the address bar.
    const rest = url.search
      .slice(1)
      .split("&")
      .filter((part) => part !== "" && !part.startsWith("tkn="))
      .join("&");
    res.writeHead(303, {
      location: `/${rest ? `?${rest}` : ""}`,
      "set-cookie": `${name}=${ui}; HttpOnly; SameSite=Strict; Path=/`,
      "content-length": 0,
      ...SECURITY,
    });
    return res.end();
  }
  const cookie = new RegExp(`(?:^|;\\s*)${name}=([0-9a-f]{48})(?:;|$)`).exec(
    String(req.headers.cookie ?? ""),
  )?.[1];
  if (!cookie || !sameSecret(cookie, ui))
    return send(
      res,
      401,
      "text/plain; charset=utf-8",
      "desolate: open the dashboard at the address `desolate ui` prints: it carries this dashboard's token\n",
    );
  if (req.method === "GET" && STATIC[url.pathname]) {
    const [file, type] = STATIC[url.pathname]!;
    return send(res, 200, type, fs.readFileSync(path.join(HERE, "ui", file), "utf8"));
  }
  if (req.method === "GET" && url.pathname === "/state")
    return send(res, 200, "application/json; charset=utf-8", last || JSON.stringify(snapshot()));
  if (req.method === "GET" && url.pathname === "/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      ...SECURITY,
      connection: "keep-alive",
    });
    res.write(`data: ${last || JSON.stringify(snapshot())}\n\n`);
    subscribers.add(res);
    const beat = setInterval(() => res.write(": still here\n\n"), 15_000);
    req.on("close", () => {
      clearInterval(beat);
      subscribers.delete(res);
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/review") {
    try {
      return json(
        res,
        200,
        await offers.review(
          domains.slugOf(url.searchParams.get("domain"), "domain"),
          url.searchParams.get("repo"),
          url.searchParams.get("branch"),
          url.searchParams.get("against"),
        ),
      );
    } catch (error) {
      return json(res, 400, { error: (error as Error).message });
    }
  }
  if (req.method === "GET" && url.pathname === "/diff") {
    try {
      return json(
        res,
        200,
        await offers.diff(
          domains.slugOf(url.searchParams.get("domain"), "domain"),
          url.searchParams.get("repo"),
          url.searchParams.get("branch"),
          url.searchParams.get("against"),
          url.searchParams.get("whitespace"),
        ),
      );
    } catch (error) {
      return json(res, 400, { error: (error as Error).message });
    }
  }
  if (req.method === "POST" && url.pathname === "/offer") {
    // The person dismisses an offer: it leaves "Needs you", the branch stays (offers.ts).
    if (
      req.headers["x-desolate-ui"] !== "1" ||
      !String(req.headers["content-type"] ?? "").startsWith("application/json")
    )
      return json(res, 403, { error: "this comes from the dashboard itself" });
    const asked = (await body(req)) as {
      domain?: unknown;
      repo?: unknown;
      branch?: unknown;
      do?: unknown;
    };
    const result =
      asked.do === "dismiss"
        ? offers.dismiss(asked.domain, asked.repo, asked.branch)
        : { error: "dismiss" };
    changed();
    return "error" in result ? json(res, 400, result) : json(res, 200, result);
  }
  if (req.method === "POST" && url.pathname === "/issue") {
    // The person's edit of an offered issue, or their decision on it. Publishing only freezes
    // it here: the issue is created by the host, once the person approves it on the Mac.
    if (
      req.headers["x-desolate-ui"] !== "1" ||
      !String(req.headers["content-type"] ?? "").startsWith("application/json")
    )
      return json(res, 403, { error: "this comes from the dashboard itself" });
    const asked = (await body(req)) as {
      id?: unknown;
      do?: unknown;
      title?: unknown;
      body?: unknown;
      labels?: unknown;
    };
    const fields = {
      ...(typeof asked.title === "string" ? { title: asked.title } : {}),
      ...(typeof asked.body === "string" ? { body: asked.body } : {}),
      ...(Array.isArray(asked.labels) ? { labels: asked.labels as string[] } : {}),
    };
    let result;
    if (asked.do === "save") result = issues.edit(asked.id, fields);
    else if (asked.do === "publish") {
      const saved = issues.edit(asked.id, fields);
      result = "error" in saved ? saved : issues.toApprove(asked.id);
    } else if (asked.do === "draft") result = issues.backToDraft(asked.id);
    else if (asked.do === "reject") result = issues.reject(asked.id);
    else result = { error: "save, publish, draft or reject" };
    changed();
    return "error" in result
      ? json(res, 400, result)
      : json(res, 200, { ok: true, state: result.state });
  }
  if (req.method === "POST" && url.pathname === "/action") {
    // A header a cross-site page cannot add without a preflight this server never grants,
    // on top of the gate: a form or an image cannot press a button here.
    if (
      req.headers["x-desolate-ui"] !== "1" ||
      !String(req.headers["content-type"] ?? "").startsWith("application/json")
    )
      return json(res, 403, { error: "actions come from the dashboard itself" });
    const request = (await body(req)) as { kind?: string; args?: Record<string, string> };
    const args: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.args ?? {}))
      if (typeof value === "string" && value.length <= 200) args[key] = value;
    const result = act(String(request.kind ?? ""), args);
    changed();
    return "error" in result
      ? json(res, 400, result)
      : json(res, 202, { id: result.id, command: result.command });
  }
  return json(res, 404, { error: "no such thing" });
};

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  createServer((req, res) => {
    handle(req, res).catch((error: Error) => {
      if (!res.headersSent) json(res, 500, { error: error.message });
      else res.end();
    });
  }).listen(ROOT_UI.port, "127.0.0.1", () =>
    console.error(`stated: listening on 127.0.0.1:${ROOT_UI.port}`),
  );
  // The root's own files: looked at when one changes. (The shares cannot be watched from
  // inside a VM; the host's daemon watches those and nudges.) And a look every second
  // regardless, which costs a few small files read, so that a missed event is a second
  // late and not lost.
  //
  // EACH DIRECTORY BY ITSELF, NEVER A TREE. node's recursive watch on Linux scans every
  // directory that appears under the tree. One that is gone again by then (git's
  // quarantine, while a bundle is checked) is an error it raises on the watcher, and with
  // nobody listening that ended this process: the dashboard died the first time a domain
  // sent work, on real VMs only, where the timing allows it (found by tier T3). So: no
  // recursion, and every watcher has a listener. One that fails is dropped; the look
  // every second remains.
  for (const dir of [
    ROOT.state,
    APPROVALS,
    path.join(ROOT.state, "refused"),
    path.join(ROOT.state, "secrets"),
    path.join(ROOT.state, "issues"),
    ROOT.domains,
  ])
    try {
      if (!fs.existsSync(dir)) continue;
      const watcher = fs.watch(dir, changed);
      watcher.on("error", (error) => {
        console.error(`stated: no longer watching ${dir}: ${String(error)}`);
        watcher.close();
      });
    } catch (error) {
      console.error(`stated: cannot watch ${dir}: ${String(error)}`);
    }
  setInterval(publish, 1000);
  setInterval(takeQueue, 500);
  publish();
}
