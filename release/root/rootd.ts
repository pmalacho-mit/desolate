// The root's daemon. For now it has one job: the request channel (section 6.4). A workspace
// may ask the root for a fixed set of things, by writing a request file into its domain's
// outbox; the root answers in the inbox, which the domain cannot write. Each request is
// validated against the workspace's DOMAIN (which outbox it arrived in: a path the host
// decides, not a field the workspace fills in). The answer is whether it was done. Nothing on
// this channel can name a key, a host or a path. How a request is taken, worked on and
// waited for, and how one domain is kept from slowing another: "The channel", below.
//
//   fetch <repo>            refresh the mirror
//   offer <repo> <branch>   a bundle is waiting in the outbox
//   spawn <name> ...        start a workspace in this domain, with a command in it
//   close <name>            remove one this workspace started, if nothing would be lost
//   issue <repo> ...        a GitHub issue offered, for the person to edit and publish
//
// spawn and close are signed by the asking workspace (shared/spawn.ts). The root cannot check
// the signature (it does not have the key, by design), so it checks what it can, to answer
// at once, and queues the request for the host, which checks the signature and runs it.
//
// And it imports each domain's branches into the root clones as the domain writes them out.
//
// virtiofs delivers no file events across VMs, so outboxes are polled.
import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { Worker } from "node:worker_threads";
import { writeJson } from "../shared/json.ts";
import { BEAT } from "../shared/lock.ts";
import { FRESH_MS, parseSigned } from "../shared/spawn.ts";
import { parseRepo } from "../shared/names.ts";
import { sleep } from "../shared/run.ts";
import { define, valueOf, whole } from "../shared/settings.ts";
import { printable } from "../shared/text.ts";
import { domain as domainOf, domains, workspaces } from "./domains.ts";
import { HOST_QUEUE } from "./layout.ts";
import { fetchDomain, take } from "./offers.ts";
import { drain, inbox, outbox } from "./outbox.ts";
import { waiting } from "./pushed.ts";
import * as issues from "./issues.ts";
import * as repos from "./repos.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Given, Invoke } from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { aDomain, aWorkspace, emptyRoot, jsonFilesIn } from "../.harness/root-state.ts";

const queuedFor = (
  domain: string,
): { kind: string; args: Record<string, string>; at: number }[] => {
  try {
    // Waiting (.json), and handed to the host lately (.taken: the state service renames each
    // as it hands it over, and sweeps them after half an hour), so a request between the two
    // is still counted against the limit.
    return fs
      .readdirSync(HOST_QUEUE)
      .filter((name) => name.endsWith(".json") || name.endsWith(".taken"))
      .flatMap((name) => {
        try {
          const item = JSON.parse(fs.readFileSync(path.join(HOST_QUEUE, name), "utf8")) as {
            kind: string;
            args: Record<string, string>;
            at: number;
          };
          return item.args?.domain === domain ? [item] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
};

/** How long a spawn in the host's queue holds its name and counts against the domain's limit.
 *  The host runs a signed request only while it is fresh (shared/spawn.ts: FRESH_MS after it
 *  was signed, and two minutes of clocks that disagree); twice that is past any it could still
 *  run, and the state service sweeps what it handed over at the same age (stated.ts). */
const PENDING_MS = 2 * FRESH_MS;

const signed = (domain: string, request: Record<string, unknown>): Record<string, unknown> => {
  // The domain is the outbox's, whatever the request says: a request signed for another
  // domain then fails the host's check (its signature covers the domain).
  const r = parseSigned({ ...request, domain });
  if (!r)
    return { ok: false, error: "that is not a request desolate makes (desolate spawn --help)" };
  const all = workspaces(domain);
  if (!all.some((w) => w.workspace === r.parent))
    return { ok: false, error: `${domain} has no workspace '${r.parent}'` };
  if (r.op === "spawn" && r.name === "template")
    return {
      ok: false,
      error: "'template' is the name of the domain's template build",
      fix: "desolate spawn --name <another>",
    };
  if (r.op === "spawn") {
    const max = domainOf(domain).spawnMax ?? null;
    if (max === 0)
      return {
        ok: false,
        error: `${domain}'s workspaces cannot start workspaces: the person turned it off`,
        fix: `on the Mac: desolate domain ${domain} spawn --max none`,
      };
    const pending = queuedFor(domain).filter(
      (q) =>
        q.kind === "workspace.spawn" &&
        Date.now() - q.at < PENDING_MS &&
        !all.some((w) => w.workspace === q.args.workspace),
    );
    if (all.some((w) => w.workspace === r.name) || pending.some((q) => q.args.workspace === r.name))
      return {
        ok: false,
        error: `${domain} already has a workspace '${r.name}'`,
        fix: "desolate spawn --name <another>",
      };
    // A branch is checked out in one workspace at a time, and a main checkout too: said here,
    // to the workspace that asked, and in its terms. (From the host it came back later, with a
    // fix for the person: remove the workspace holding it, the asker itself.) What it would
    // take: each --checkout as named; with --branch, that branch in the others; with neither,
    // a worktree named for it where the main checkout is held (domains.ts, plan).
    const repos = domainOf(domain).repos;
    const named = new Map(
      r.checkouts.map((c) => [c.slice(0, c.indexOf("=")), c.slice(c.indexOf("=") + 1)] as const),
    );
    const where = (w: string) => (w === r.parent ? "this workspace" : `${domain}/${w}`);
    for (const [repo, how] of named) {
      if (!repos.includes(repo))
        return {
          ok: false,
          error: `${repo} is not in the domain ${domain}`,
          fix: `desolate spawn --checkout <one of: ${repos.join(", ")}>=worktree:<branch>`,
        };
      const holder =
        how === "main"
          ? all.find((w) => w.checkouts.some((c) => c.repo === repo && c.kind === "main"))
          : all.find((w) =>
              w.checkouts.some(
                (c) =>
                  c.repo === repo &&
                  c.kind === "worktree" &&
                  c.name === how.slice("worktree:".length).replace(/\//g, "-"),
              ),
            );
      if (holder)
        return {
          ok: false,
          error: `${how === "main" ? `the main checkout of ${repo}` : `the branch '${how.slice("worktree:".length)}' of ${repo}`} is checked out in ${where(holder.workspace)}`,
          fix: `desolate spawn --name ${r.name} --checkout ${repo}=worktree:<a branch of its own>`,
        };
    }
    if (named.size === 0 || r.branch) {
      const branch = r.branch || r.name;
      const dir = branch.replace(/\//g, "-");
      const holder = all.find((w) =>
        w.checkouts.some((c) => c.kind === "worktree" && c.name === dir && !named.has(c.repo)),
      );
      if (holder)
        return {
          ok: false,
          error: `the branch '${branch}' is checked out in ${where(holder.workspace)} (a workspace you start gets that branch in each repository you do not name with --checkout)`,
          fix: `desolate spawn --name ${r.name} --checkout <owner/repo>=worktree:<a branch of its own>   (or --branch <a branch of its own>)`,
        };
    }
    const live = all.filter((w) => w.startedBy).length + pending.length;
    if (max !== null && live >= max)
      return {
        ok: false,
        error: `${domain} already has ${live} workspace(s) started by its workspaces, its limit of ${max}`,
        fix: "close one you started (desolate close <name>), or ask the person to raise the limit",
      };
  } else {
    const child = all.find((w) => w.workspace === r.name);
    if (!child) return { ok: false, error: `${domain} has no workspace '${r.name}'` };
    if (child.startedBy?.workspace !== r.parent)
      return {
        ok: false,
        error: `${domain}/${r.name} was not started by ${r.parent}: only the workspace that started it can close it`,
        fix: "ask the person: desolate rm on the Mac",
      };
  }
  const args: Record<string, string> = {
    domain,
    workspace: r.name,
    parent: r.parent,
    at: r.at,
    nonce: r.nonce,
    mac: r.mac,
    ...(r.op === "spawn"
      ? {
          branch: r.branch,
          checkouts: JSON.stringify(r.checkouts),
          command: JSON.stringify(r.command),
        }
      : {}),
  };
  fs.mkdirSync(HOST_QUEUE, { recursive: true });
  writeJson(
    path.join(HOST_QUEUE, `${Date.now().toString(36)}-${randomBytes(5).toString("hex")}.json`),
    { kind: r.op === "spawn" ? "workspace.spawn" : "workspace.close", args, at: Date.now() },
  );
  return { ok: true, workspace: r.name };
};

declare namespace signed {
  // The domain acme: w1 holds both main checkouts; w2 was started by w1, in a worktree "w2".
  type Fresh = Invoke<typeof emptyRoot>;
  type Acme = Invoke<typeof aDomain, [slug: "acme", repos: ["acme/api", "acme/web"]]>;
  type W1 = Invoke<
    typeof aWorkspace,
    [domain: "acme", name: "w1", checkouts: ["acme/api=main", "acme/web=main"]]
  >;
  type W2 = Invoke<
    typeof aWorkspace,
    [
      domain: "acme",
      name: "w2",
      checkouts: ["acme/api=worktree:w2", "acme/web=worktree:w2"],
      startedBy: "w1",
    ]
  >;
  // Each request is signed as shared/spawn.ts makes it (`at`, `nonce`, `mac`): the root cannot
  // check the signature (it has no key, by design; the host does).

  /** a spawn the root can say nothing against is queued for the host, for the domain whose
   *  outbox it came from, whatever the request says its domain is */
  export type Queues = Given<
    [Fresh, Acme, W1],
    [
      Expect<
        Invoke<
          typeof signed,
          [
            domain: "acme",
            request: {
              at: "2026-11-16T12:00:00.000Z";
              nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";
              mac: "abababababababababababababababababababababababababababababababab";
              op: "spawn";
              domain: "other";
              parent: "w1";
              name: "helper";
              checkouts: ["acme/web=worktree:task/web"];
              command: ["claude", "-p", "fix it"];
            },
          ]
        >,
        "=",
        { ok: true; workspace: "helper" }
      >,
      Expect<
        Invoke<typeof jsonFilesIn, [where: "state", dir: "host-queue"]>,
        "matches",
        [
          {
            kind: "workspace.spawn";
            args: {
              domain: "acme";
              workspace: "helper";
              parent: "w1";
              branch: "";
              checkouts: '["acme/web=worktree:task/web"]';
              command: '["claude","-p","fix it"]';
              mac: "abababababababababababababababababababababababababababababababab";
            };
          },
        ]
      >,
    ]
  >;
  /** a spawn waiting in the queue holds its name already */
  export type PendingHoldsItsName = Given<
    [
      Fresh,
      Acme,
      W1,
      Invoke<
        typeof signed,
        [
          domain: "acme",
          request: {
            at: "2026-11-16T12:00:00.000Z";
            nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";
            mac: "abababababababababababababababababababababababababababababababab";
            op: "spawn";
            parent: "w1";
            name: "helper";
            checkouts: ["acme/web=worktree:a"];
          },
        ]
      >,
    ],
    Expect<
      Invoke<
        typeof signed,
        [
          domain: "acme",
          request: {
            at: "2026-11-16T12:00:00.000Z";
            nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";
            mac: "abababababababababababababababababababababababababababababababab";
            op: "spawn";
            parent: "w1";
            name: "helper";
            checkouts: ["acme/web=worktree:b"];
          },
        ]
      >,
      "=",
      {
        ok: false;
        error: "acme already has a workspace 'helper'";
        fix: "desolate spawn --name <another>";
      }
    >
  >;
  /** what is refused at once, to the workspace that asked, in its terms; nothing is queued */
  export type Refuses = Given<
    [Fresh, Acme, W1, W2],
    [
      Expect<
        Invoke<
          typeof signed,
          [domain: "acme", request: { op: "spawn"; parent: "w1"; name: "helper" }]
        >,
        "=",
        { ok: false; error: "that is not a request desolate makes (desolate spawn --help)" }
      >,
      Expect<
        Invoke<
          typeof signed,
          [
            domain: "acme",
            request: {
              at: "2026-11-16T12:00:00.000Z";
              nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";
              mac: "abababababababababababababababababababababababababababababababab";
              op: "spawn";
              parent: "w9";
              name: "helper";
            },
          ]
        >,
        "=",
        { ok: false; error: "acme has no workspace 'w9'" }
      >,
      Expect<
        Invoke<
          typeof signed,
          [
            domain: "acme",
            request: {
              at: "2026-11-16T12:00:00.000Z";
              nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";
              mac: "abababababababababababababababababababababababababababababababab";
              op: "spawn";
              parent: "w1";
              name: "template";
            },
          ]
        >,
        "=",
        {
          ok: false;
          error: "'template' is the name of the domain's template build";
          fix: "desolate spawn --name <another>";
        }
      >,
      Expect<
        Invoke<
          typeof signed,
          [
            domain: "acme",
            request: {
              at: "2026-11-16T12:00:00.000Z";
              nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";
              mac: "abababababababababababababababababababababababababababababababab";
              op: "spawn";
              parent: "w1";
              name: "w2";
            },
          ]
        >,
        "=",
        {
          ok: false;
          error: "acme already has a workspace 'w2'";
          fix: "desolate spawn --name <another>";
        }
      >,
      Expect<
        Invoke<
          typeof signed,
          [
            domain: "acme",
            request: {
              at: "2026-11-16T12:00:00.000Z";
              nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";
              mac: "abababababababababababababababababababababababababababababababab";
              op: "spawn";
              parent: "w1";
              name: "helper";
              checkouts: ["other/x=main"];
            },
          ]
        >,
        "=",
        {
          ok: false;
          error: "other/x is not in the domain acme";
          fix: "desolate spawn --checkout <one of: acme/api, acme/web>=worktree:<branch>";
        }
      >,
      Expect<
        Invoke<
          typeof signed,
          [
            domain: "acme",
            request: {
              at: "2026-11-16T12:00:00.000Z";
              nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";
              mac: "abababababababababababababababababababababababababababababababab";
              op: "spawn";
              parent: "w2";
              name: "helper";
              checkouts: ["acme/api=main"];
            },
          ]
        >,
        "=",
        {
          ok: false;
          error: "the main checkout of acme/api is checked out in acme/w1";
          fix: "desolate spawn --name helper --checkout acme/api=worktree:<a branch of its own>";
        }
      >,
      Expect<
        Invoke<
          typeof signed,
          [
            domain: "acme",
            request: {
              at: "2026-11-16T12:00:00.000Z";
              nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";
              mac: "abababababababababababababababababababababababababababababababab";
              op: "spawn";
              parent: "w1";
              name: "helper";
              branch: "w2";
            },
          ]
        >,
        "matches",
        {
          ok: false;
          error: "the branch 'w2' is checked out in acme/w2 (a workspace you start gets that branch in each repository you do not name with --checkout)";
        }
      >,
      Expect<Invoke<typeof jsonFilesIn, [where: "state", dir: "host-queue"]>, "=", []>,
    ]
  >;
  /** the person's limit on what its workspaces may start: none at all, or a number */
  export type Limit = [
    Given<
      [
        Fresh,
        Invoke<typeof aDomain, [slug: "acme", repos: ["acme/api"], extra: { spawnMax: 0 }]>,
        W1,
      ],
      Expect<
        Invoke<
          typeof signed,
          [
            domain: "acme",
            request: {
              at: "2026-11-16T12:00:00.000Z";
              nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";
              mac: "abababababababababababababababababababababababababababababababab";
              op: "spawn";
              parent: "w1";
              name: "helper";
            },
          ]
        >,
        "=",
        {
          ok: false;
          error: "acme's workspaces cannot start workspaces: the person turned it off";
          fix: "on the Mac: desolate domain acme spawn --max none";
        }
      >
    >,
    Given<
      [
        Fresh,
        Invoke<
          typeof aDomain,
          [slug: "acme", repos: ["acme/api", "acme/web"], extra: { spawnMax: 1 }]
        >,
        W1,
        W2,
      ],
      Expect<
        Invoke<
          typeof signed,
          [
            domain: "acme",
            request: {
              at: "2026-11-16T12:00:00.000Z";
              nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";
              mac: "abababababababababababababababababababababababababababababababab";
              op: "spawn";
              parent: "w1";
              name: "helper";
              checkouts: ["acme/web=worktree:x"];
            },
          ]
        >,
        "=",
        {
          ok: false;
          error: "acme already has 1 workspace(s) started by its workspaces, its limit of 1";
          fix: "close one you started (desolate close <name>), or ask the person to raise the limit";
        }
      >
    >,
  ];
  /** a workspace closes only one it started */
  export type Close = Given<
    [Fresh, Acme, W1, W2, Invoke<typeof aWorkspace, [domain: "acme", name: "w3", checkouts: []]>],
    [
      Expect<
        Invoke<
          typeof signed,
          [
            domain: "acme",
            request: {
              at: "2026-11-16T12:00:00.000Z";
              nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";
              mac: "abababababababababababababababababababababababababababababababab";
              op: "close";
              parent: "w3";
              name: "w2";
            },
          ]
        >,
        "=",
        {
          ok: false;
          error: "acme/w2 was not started by w3: only the workspace that started it can close it";
          fix: "ask the person: desolate rm on the Mac";
        }
      >,
      Expect<
        Invoke<
          typeof signed,
          [
            domain: "acme",
            request: {
              at: "2026-11-16T12:00:00.000Z";
              nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";
              mac: "abababababababababababababababababababababababababababababababab";
              op: "close";
              parent: "w1";
              name: "gone";
            },
          ]
        >,
        "=",
        { ok: false; error: "acme has no workspace 'gone'" }
      >,
      Expect<
        Invoke<
          typeof signed,
          [
            domain: "acme",
            request: {
              at: "2026-11-16T12:00:00.000Z";
              nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";
              mac: "abababababababababababababababababababababababababababababababab";
              op: "close";
              parent: "w1";
              name: "w2";
            },
          ]
        >,
        "=",
        { ok: true; workspace: "w2" }
      >,
      Expect<
        Invoke<typeof jsonFilesIn, [where: "state", dir: "host-queue"]>,
        "matches",
        [{ kind: "workspace.close"; args: { domain: "acme"; workspace: "w2"; parent: "w1" } }]
      >,
    ]
  >;
}

const handle = async (
  domain: string,
  repoList: string[],
  request: Record<string, unknown>,
  tell: (doing: string) => void = () => {},
): Promise<Record<string, unknown>> => {
  if (request.op === "spawn" || request.op === "close") return signed(domain, request);
  const repo = parseRepo(request.repo);
  // Only its own domain's repositories.
  if (!repo || !repoList.includes(String(request.repo)))
    return { ok: false, error: "that repository is not in this domain" };
  if (request.op === "fetch") {
    const id = String(request.repo);
    const run = fetchOf(id, tell);
    if (run.behind)
      tell(`waiting for the fetch of ${id} already under way to end, then fetching it again`);
    await run.result;
    return { ok: true };
  }
  if (request.op === "offer") return inClone(String(request.repo), () => take(domain, request));
  if (request.op === "issue")
    return issues.offer(
      domain,
      repoList,
      workspaces(domain).map((w) => w.workspace),
      request,
    );
  return {
    ok: false,
    error:
      "the root takes 'fetch', 'offer', 'issue', 'spawn' and 'close' from a workspace, and nothing else",
  };
};

declare namespace handle {
  type Fresh = Invoke<typeof emptyRoot>;
  /** a workspace asks only of its own domain's repositories, and only for what is on the list */
  export type Refuses = Given<
    [Fresh, Invoke<typeof aDomain, [slug: "acme", repos: ["acme/app"]]>],
    [
      Expect<
        Invoke<
          typeof handle,
          [domain: "acme", repoList: ["acme/app"], request: { op: "fetch"; repo: "other/app" }]
        >,
        "=",
        { ok: false; error: "that repository is not in this domain" }
      >,
      Expect<
        Invoke<
          typeof handle,
          [
            domain: "acme",
            repoList: ["acme/app"],
            request: { op: "fetch"; repo: "acme/app/../../other" },
          ]
        >,
        "=",
        { ok: false; error: "that repository is not in this domain" }
      >,
      Expect<
        Invoke<
          typeof handle,
          [
            domain: "acme",
            repoList: ["acme/app"],
            request: { op: "push"; repo: "acme/app"; branch: "main" },
          ]
        >,
        "=",
        {
          ok: false;
          error: "the root takes 'fetch', 'offer', 'issue', 'spawn' and 'close' from a workspace, and nothing else";
        }
      >,
    ]
  >;
  /** an issue offered, kept for the person */
  export type Issue = Given<
    [Fresh, Invoke<typeof aDomain, [slug: "acme", repos: ["acme/app"]]>],
    Expect<
      Invoke<
        typeof handle,
        [
          domain: "acme",
          repoList: ["acme/app"],
          request: { op: "issue"; repo: "acme/app"; title: "Login loops" },
        ]
      >,
      "matches",
      { ok: true }
    >
  >;
}

/** The reply to one request a domain left in its outbox: what it asked, if it is a request; a
 *  failure on the way is a refusal, not a crash. `tell` hears what it is doing, as it goes. */
const answer = async (
  domain: string,
  repoList: string[],
  request: Record<string, unknown> | null,
  tell: (doing: string) => void = () => {},
): Promise<Record<string, unknown>> => {
  if (!request || typeof request.op !== "string") return { ok: false, error: "not a request" };
  try {
    return await handle(domain, repoList, request, tell);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? printable(error.message) : "the root failed",
    };
  }
};

declare namespace answer {
  type Fresh = Invoke<typeof emptyRoot>;
  /** what is not a request is answered as such, and nothing is done */
  export type NotARequest = [
    Expect<
      Invoke<typeof answer, [domain: "acme", repoList: ["acme/app"], request: null]>,
      "=",
      { ok: false; error: "not a request" }
    >,
    Expect<
      Invoke<typeof answer, [domain: "acme", repoList: ["acme/app"], request: { op: 7 }]>,
      "=",
      { ok: false; error: "not a request" }
    >,
  ];
  /** a request that fails on the way is a refusal with the reason, and the daemon goes on */
  export type FailsAsARefusal = Given<
    Fresh,
    Expect<
      Invoke<
        typeof answer,
        [
          domain: "gone",
          repoList: ["acme/app"],
          request: {
            op: "offer";
            repo: "acme/app";
            branch: "fix";
            commit: "0123456789abcdef0123456789abcdef01234567";
          },
        ]
      >,
      "=",
      { ok: false; error: "there is no domain 'gone'" }
    >
  >;
  /** a request that passes is handled (an issue offered, here) */
  export type Handled = Given<
    [Fresh, Invoke<typeof aDomain, [slug: "acme", repos: ["acme/app"]]>],
    Expect<
      Invoke<
        typeof answer,
        [
          domain: "acme",
          repoList: ["acme/app"],
          request: { op: "issue"; repo: "acme/app"; title: "Login loops" },
        ]
      >,
      "matches",
      { ok: true }
    >
  >;
}

const log = (line: string) => process.stderr.write(`${new Date().toISOString()} rootd: ${line}\n`);

/** One piece of work at a time in a repository's root clone, in the order asked, whichever
 *  domain asked: an import (git fetch --prune <domain>) and an offer's take, from two domains'
 *  lanes at once, would meet on the clone's ref locks, and the later fail. In order, so a
 *  domain's work in a clone it shares with another waits for at most the one piece of the
 *  other's ahead of it (each domain's lane gives one at a time). */
const clones = new Map<string, Promise<unknown>>();
const inClone = <T>(id: string, work: () => Promise<T>): Promise<T> => {
  const done = (clones.get(id) ?? Promise.resolve()).catch(() => {}).then(work);
  clones.set(id, done);
  void done
    .catch(() => {})
    .then(() => {
      if (clones.get(id) === done) clones.delete(id);
    });
  return done;
};

/** A domain's branches, brought into the root clone as the domain writes them out (its list
 *  beside each bundle changes), not only when one is reviewed or offered: so `git fetch
 *  root` in the git VM, and the dashboard's review, have every branch. The import is the
 *  one a review does (offers.ts fetchDomain: git-remote-desolate, every object checked). At
 *  most one every few seconds per repository, whatever the domain writes. */
const IMPORT_GAP_MS = 3000;
const imported = new Map<string, { mtime: number; at: number }>();
const importChanged = async (slug: string, repoList: string[]) => {
  for (const id of repoList) {
    const repo = parseRepo(id);
    if (!repo) continue;
    let mtime = 0;
    try {
      // (A stat of the domain's file, read for its time only: what it says is not used.)
      mtime = fs.lstatSync(path.join(outbox(slug), "sync", id, "refs.json")).mtimeMs;
    } catch {
      continue;
    }
    const key = `${slug}\0${id}`;
    const last = imported.get(key);
    if (last && (last.mtime === mtime || Date.now() - last.at < IMPORT_GAP_MS)) continue;
    imported.set(key, { mtime, at: Date.now() });
    await inClone(id, () => fetchDomain(slug, repo)).catch((error: Error) =>
      log(`${slug} ${id}: not imported: ${printable(error.message)}`),
    );
  }
};

/** One run of `work` for a key at a time; and every call made while one runs is answered by
 *  the one run that begins after it, together. So ten fetches of a repository asked during a
 *  fetch of it are one more fetch, not ten; and each asker is answered by a run that began
 *  after it asked, so what it is told is never older than its question. `tell` hears what its
 *  run says as it goes; `behind` is true when the call waits for a run under way to end. */
export const coalesced = <T>(work: (key: string, said: (line: string) => void) => Promise<T>) => {
  type Run = { told: ((line: string) => void)[]; result: Promise<T> };
  const runs = new Map<string, { now: Run; next: Run | null }>();
  const start = (key: string, after: Promise<unknown>): Run => {
    const run: Run = { told: [], result: Promise.resolve() as Promise<T> };
    run.result = after
      .catch(() => {})
      .then(() => work(key, (line) => run.told.forEach((tell) => tell(line))));
    void run.result
      .catch(() => {})
      .then(() => {
        const state = runs.get(key);
        if (!state || state.now !== run) return;
        if (state.next) {
          state.now = state.next;
          state.next = null;
        } else runs.delete(key);
      });
    return run;
  };
  return (
    key: string,
    tell: (line: string) => void = () => {},
  ): { result: Promise<T>; behind: boolean } => {
    const state = runs.get(key);
    let run: Run;
    if (!state) runs.set(key, { now: (run = start(key, Promise.resolve())), next: null });
    else run = state.next ??= start(key, state.now.result);
    run.told.push(tell);
    return { result: run.result, behind: state !== undefined };
  };
};

/** The fetches the root makes of a repository's remote, for a workspace (`desolate fetch`, a
 *  `git fetch` in one) and to see a push land, as one queue per repository: whatever the
 *  number of askers, at most one fetch runs and one waits. (The host's own `desolate fetch`
 *  runs in another process, kept apart from these by repos.ts's lock.) */
const fetchOf = coalesced(async (id, said) => {
  const repo = parseRepo(id);
  if (!repo) throw new Error(`'${id}' is not a repository`);
  return repos.fetch(repo, said);
});

/** A pushed branch's pull request is merged on the forge, not here: so a repository with a
 *  push still waiting to land is fetched now and then (pushed.ts), and its mirror shows the
 *  merge without anyone asking. The same fetch as `desolate fetch`, with the read key, and
 *  the same queue: a check that comes while a workspace's fetch runs is the next one. */
const LANDED_CHECK = define({
  name: "root.landedCheckMinutes",
  env: "DESOLATE_ROOT_LANDED_CHECK_MINUTES",
  side: "root",
  default: 15,
  parse: whole(1, 24 * 60),
  why: "How often the root fetches a repository with a push still waiting to land, to see its pull request merged: each is a fetch from the forge, with the read key.",
});
let landedAt = Date.now();
let checking = false;
// Beside the loop, not in it: a fetch can take minutes, and requests keep being answered.
const checkLanded = (everyMs: number) => {
  if (checking || Date.now() - landedAt < everyMs) return;
  checking = true;
  landedAt = Date.now();
  void (async () => {
    for (const id of waiting())
      if (parseRepo(id))
        await fetchOf(id).result.catch((error: Error) =>
          log(`${id}: not fetched to look for merges: ${printable(error.message)}`),
        );
  })().finally(() => {
    checking = false;
  });
};

// THE CHANNEL
//
// A workspace writes `requests/<id>.json` into its outbox and waits (workspace/sync.ts,
// request). The root says three things back, in the domain's inbox:
//   rootd.beat           `<boot> <count>`, every BEAT.beatMs, from a thread of its own (so a
//                        main loop that is busy, a large copy, does not stop it), for as long
//                        as rootd runs; `boot` is new each time rootd starts
//   replies/<id>.taken   `{ boot, doing }`, the moment a request is taken from the outbox, and
//                        again whenever what is being done changes; removed with the answer
//   replies/<id>.json    the answer
// So the workspace waits for as long as the root is there and on it, with no deadline (R4),
// and is told at once when it is not. A workspace from before this reads only the reply, as
// it always did; one after, facing a root from before (no beat), waits as it always did.
//
// The loop never waits on a request's work. Each domain has one lane: its requests are worked
// on one at a time, in the order they came, beside every other domain's lane. Its imports
// (importChanged) go in the same lane, so the two never meet in a root clone. Fetches go to
// fetchOf instead, where any number of askers share one fetch: so an offer is never behind a
// domain's fetches, nor refused for them.

/** A root's start: in every beat, and in each `.taken` it writes. */
const BOOT = randomBytes(8).toString("hex");

/** How many of one domain's requests the root holds at once: taken from its outbox and not
 *  yet answered, counted apart for its fetches and for the rest (R7: a bound against a
 *  workspace, which may flood its outbox; each request is up to outbox.ts's 1 MiB of JSON).
 *  Fifty is what one pass of the loop took from a domain before there were lanes, and so what
 *  the root held of one then. When the lane is full the root takes no more from that domain:
 *  the rest wait in its outbox, on its own disk, while their askers wait on a beat that goes
 *  on. A fetch over the bound (seen as one only once taken) is refused, saying why. Neither
 *  bound slows another domain: the loop takes at most this many from each in a pass. */
const MOST_HELD = 50;

/** A reply is read within a poll (150 ms) of being written; one whose asker went away is
 *  swept after this. A `.taken` of a request still held is never swept, however long its
 *  work. */
const REPLY_KEPT_MS = 10 * 60_000;

/** A request taken from a domain's outbox, not yet answered. */
type Held = { domain: string; name: string; op: string; what: string; fetch: boolean };
const held = new Map<string, Held>();
const heldBy = (domain: string, fetch: boolean) =>
  [...held.values()].filter((h) => h.domain === domain && h.fetch === fetch).length;
const replyFile = (h: Held, ending: ".json" | ".taken") =>
  path.join(inbox(h.domain), "replies", h.name.replace(/\.json$/, ending));

/** What the root is doing with a request, for its asker to show in a long wait. */
const doing = (h: Held, now: string) => {
  try {
    writeJson(replyFile(h, ".taken"), { boot: BOOT, doing: printable(now, 300) });
  } catch (error) {
    log(`${h.domain}: cannot say what is being done: ${printable((error as Error).message)}`);
  }
};

const answered = (h: Held, reply: Record<string, unknown>) => {
  held.delete(`${h.domain}/${h.name}`);
  log(
    `${h.domain} ${h.op} ${h.what} -> ${reply.ok === true ? "ok" : `refused: ${printable(reply.error)}`}`,
  );
  try {
    writeJson(replyFile(h, ".json"), reply);
    fs.rmSync(replyFile(h, ".taken"), { force: true });
  } catch (error) {
    log(`${h.domain}: cannot answer ${h.name}: ${printable((error as Error).message)}`);
  }
};

const lanes = new Map<string, Promise<void>>();
const inLane = (domain: string, work: () => Promise<void>) => {
  lanes.set(
    domain,
    (lanes.get(domain) ?? Promise.resolve()).then(work).catch((error: Error) => {
      log(`${domain}: ${printable(error.message)}`);
    }),
  );
};
const importing = new Set<string>();

/** One request, just taken from a domain's outbox: said to be taken, then worked on in the
 *  domain's lane, or beside it for a fetch, and answered. */
const taken = (domain: string, repoList: string[], name: string, request: unknown) => {
  // A name the domain used again while its request of that name is still held: dropped,
  // unanswered (its first is answered under that name). Else a name written again each pass
  // would be held again each pass, past MOST_HELD, which counts what is held by name.
  if (held.has(`${domain}/${name}`)) return;
  const r = request && typeof request === "object" ? (request as Record<string, unknown>) : null;
  const h: Held = {
    domain,
    name,
    op: printable(r?.op, 20),
    what: printable(r?.repo ?? r?.name, 100),
    fetch: r?.op === "fetch",
  };
  held.set(`${domain}/${name}`, h);
  if (!r || typeof r.op !== "string") return answered(h, { ok: false, error: "not a request" });
  if (h.fetch) {
    if (heldBy(domain, true) > MOST_HELD)
      return answered(h, {
        ok: false,
        error: `this domain has ${MOST_HELD} fetches waiting already: ask again once one is answered`,
      });
    doing(h, `fetching ${h.what}`);
    void answer(domain, repoList, r, (now) => doing(h, now)).then((reply) => answered(h, reply));
    return;
  }
  const ahead = heldBy(domain, false) - 1;
  doing(
    h,
    ahead > 0
      ? `waiting for ${ahead} earlier request(s) of this domain to be answered`
      : `answering the ${h.op}`,
  );
  inLane(domain, async () => {
    if (ahead > 0) doing(h, `answering the ${h.op}`);
    answered(h, await answer(domain, repoList, r));
  });
};

/** Replies whose asker went away, and the `.taken` of a root that is gone: swept, by age, at
 *  most once a minute for a domain (a domain that floods its outbox has as many replies, and
 *  looking at each every pass would be its cost on everyone's loop). */
const SWEEP_EVERY_MS = 60_000;
const swept = new Map<string, number>();
const sweep = (domain: string) => {
  if (Date.now() - (swept.get(domain) ?? 0) < SWEEP_EVERY_MS) return;
  swept.set(domain, Date.now());
  const dir = path.join(inbox(domain), "replies");
  try {
    for (const name of fs.readdirSync(dir)) {
      if (held.has(`${domain}/${name.split(".")[0]}.json`)) continue;
      const file = path.join(dir, name);
      if (Date.now() - fs.lstatSync(file).mtimeMs > REPLY_KEPT_MS) fs.rmSync(file, { force: true });
    }
  } catch {
    /* no replies yet */
  }
};

/** The beat, from a thread of its own: a count, after this start's `boot`, into each file it
 *  is given (the main loop gives it every domain's), each beat, whole (written beside and
 *  renamed over, so a reader never sees half of one). If the thread ends, rootd ends: a root
 *  that answers with no beat would be taken for gone by every waiter, and kept starts it again. */
const startBeat = (): Worker => {
  const worker = new Worker(
    // (getBuiltinModule: the same text is a script or a module, whichever this process
    // takes evaluated code for; as lock.ts's beat.)
    `const { parentPort, workerData } = process.getBuiltinModule("node:worker_threads");
     const fs = process.getBuiltinModule("node:fs");
     let files = [];
     let count = 0;
     const beat = () => {
       count++;
       for (const file of files)
         try {
           fs.writeFileSync(file + ".new", workerData.boot + " " + count + "\\n", { mode: 0o644 });
           fs.renameSync(file + ".new", file);
         } catch {}
     };
     parentPort.on("message", (list) => { files = list; beat(); });
     setInterval(beat, workerData.everyMs);`,
    { eval: true, workerData: { boot: BOOT, everyMs: BEAT.beatMs } },
  );
  worker.on("error", (error: Error) => log(`the beat stopped: ${printable(error.message)}`));
  worker.on("exit", () => {
    log("the beat's thread ended; ending, to be started again");
    process.exit(1);
  });
  return worker;
};

const main = async () => {
  log("up");
  const landedEveryMs = valueOf(LANDED_CHECK) * 60_000;
  const beat = startBeat();
  let beating = "";
  for (;;) {
    checkLanded(landedEveryMs);
    const all = domains();
    const files = all.map((d) => path.join(inbox(d.slug), "rootd.beat"));
    if (JSON.stringify(files) !== beating) {
      beating = JSON.stringify(files);
      beat.postMessage(files);
    }
    for (const d of all) {
      if (!importing.has(d.slug)) {
        importing.add(d.slug);
        inLane(d.slug, () =>
          importChanged(d.slug, d.repos).finally(() => importing.delete(d.slug)),
        );
      }
      // Each request is read once and removed, by name, in a directory that was checked to be
      // the outbox's own (outbox.ts): never through a path a workspace could have redirected.
      const room = MOST_HELD - heldBy(d.slug, false);
      if (room > 0)
        for (const { name, data } of drain<unknown>(
          path.join(outbox(d.slug), "requests"),
          /^[0-9a-z-]{1,60}\.json$/,
          room,
        ))
          taken(d.slug, d.repos, name, data);
      sweep(d.slug);
    }
    await sleep(250);
  }
};

// Run by start.sh (`kept rootd rootd.ts`: node with this file's path); imported, it does nothing.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === new URL(import.meta.url).pathname)
  await main();
