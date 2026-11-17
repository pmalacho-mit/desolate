// The root's daemon. For now it has one job: the request channel (section 6.4). A workspace
// may ask the root for a fixed set of things, by writing a request file into its domain's
// outbox; the root answers in the inbox, which the domain cannot write. Each request is
// validated against the workspace's DOMAIN (which outbox it arrived in: a path the host
// decides, not a field the workspace fills in), and rate-limited. The answer is whether it
// was done. Nothing on this channel can name a key, a host or a path.
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
import { writeJson } from "../shared/json.ts";
import { parseSigned } from "../shared/spawn.ts";
import { parseRepo } from "../shared/names.ts";
import { sleep } from "../shared/run.ts";
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

const RATE = { perMinute: 30 } as const;
const recent = new Map<string, number[]>();
const allowed = (domain: string) => {
  const now = Date.now();
  const times = (recent.get(domain) ?? []).filter((time) => now - time < 60_000);
  if (times.length >= RATE.perMinute) return false;
  times.push(now);
  recent.set(domain, times);
  return true;
};

const queuedFor = (domain: string): { kind: string; args: Record<string, string>; at: number }[] => {
  try {
    // Waiting (.json), and handed to the host lately (.taken: the state service renames each
    // as it hands it over, and sweeps them after half an hour), so a request between the two
    // is still counted against the limit.
    return fs.readdirSync(HOST_QUEUE).filter((name) => name.endsWith(".json") || name.endsWith(".taken")).flatMap((name) => {
      try {
        const item = JSON.parse(fs.readFileSync(path.join(HOST_QUEUE, name), "utf8")) as { kind: string; args: Record<string, string>; at: number };
        return item.args?.domain === domain ? [item] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
};

const signed = (domain: string, request: Record<string, unknown>): Record<string, unknown> => {
  // The domain is the outbox's, whatever the request says: a request signed for another
  // domain then fails the host's check (its signature covers the domain).
  const r = parseSigned({ ...request, domain });
  if (!r) return { ok: false, error: "that is not a request desolate makes (desolate spawn --help)" };
  const all = workspaces(domain);
  if (!all.some((w) => w.workspace === r.parent)) return { ok: false, error: `${domain} has no workspace '${r.parent}'` };
  if (r.op === "spawn" && r.name === "template") return { ok: false, error: "'template' is the name of the domain's template build", fix: "desolate spawn --name <another>" };
  if (r.op === "spawn") {
    const max = domainOf(domain).spawnMax ?? null;
    if (max === 0) return { ok: false, error: `${domain}'s workspaces cannot start workspaces: the person turned it off`, fix: `on the Mac: desolate domain ${domain} spawn --max none` };
    const pending = queuedFor(domain).filter((q) => q.kind === "workspace.spawn" && Date.now() - q.at < 30 * 60_000 && !all.some((w) => w.workspace === q.args.workspace));
    if (all.some((w) => w.workspace === r.name) || pending.some((q) => q.args.workspace === r.name)) return { ok: false, error: `${domain} already has a workspace '${r.name}'`, fix: "desolate spawn --name <another>" };
    // A branch is checked out in one workspace at a time, and a main checkout too: said here,
    // to the workspace that asked, and in its terms. (From the host it came back later, with a
    // fix for the person: remove the workspace holding it, the asker itself.) What it would
    // take: each --checkout as named; with --branch, that branch in the others; with neither,
    // a worktree named for it where the main checkout is held (domains.ts, plan).
    const repos = domainOf(domain).repos;
    const named = new Map(r.checkouts.map((c) => [c.slice(0, c.indexOf("=")), c.slice(c.indexOf("=") + 1)] as const));
    const where = (w: string) => (w === r.parent ? "this workspace" : `${domain}/${w}`);
    for (const [repo, how] of named) {
      if (!repos.includes(repo)) return { ok: false, error: `${repo} is not in the domain ${domain}`, fix: `desolate spawn --checkout <one of: ${repos.join(", ")}>=worktree:<branch>` };
      const holder = how === "main"
        ? all.find((w) => w.checkouts.some((c) => c.repo === repo && c.kind === "main"))
        : all.find((w) => w.checkouts.some((c) => c.repo === repo && c.kind === "worktree" && c.name === how.slice("worktree:".length).replace(/\//g, "-")));
      if (holder) return { ok: false, error: `${how === "main" ? `the main checkout of ${repo}` : `the branch '${how.slice("worktree:".length)}' of ${repo}`} is checked out in ${where(holder.workspace)}`, fix: `desolate spawn --name ${r.name} --checkout ${repo}=worktree:<a branch of its own>` };
    }
    if (named.size === 0 || r.branch) {
      const branch = r.branch || r.name;
      const dir = branch.replace(/\//g, "-");
      const holder = all.find((w) => w.checkouts.some((c) => c.kind === "worktree" && c.name === dir && !named.has(c.repo)));
      if (holder) return { ok: false, error: `the branch '${branch}' is checked out in ${where(holder.workspace)} (a workspace you start gets that branch in each repository you do not name with --checkout)`, fix: `desolate spawn --name ${r.name} --checkout <owner/repo>=worktree:<a branch of its own>   (or --branch <a branch of its own>)` };
    }
    const live = all.filter((w) => w.startedBy).length + pending.length;
    if (max !== null && live >= max) return { ok: false, error: `${domain} already has ${live} workspace(s) started by its workspaces, its limit of ${max}`, fix: "close one you started (desolate close <name>), or ask the person to raise the limit" };
  } else {
    const child = all.find((w) => w.workspace === r.name);
    if (!child) return { ok: false, error: `${domain} has no workspace '${r.name}'` };
    if (child.startedBy?.workspace !== r.parent) return { ok: false, error: `${domain}/${r.name} was not started by ${r.parent}: only the workspace that started it can close it`, fix: "ask the person: desolate rm on the Mac" };
  }
  const args: Record<string, string> = { domain, workspace: r.name, parent: r.parent, at: r.at, nonce: r.nonce, mac: r.mac, ...(r.op === "spawn" ? { branch: r.branch, checkouts: JSON.stringify(r.checkouts), command: JSON.stringify(r.command) } : {}) };
  fs.mkdirSync(HOST_QUEUE, { recursive: true });
  writeJson(path.join(HOST_QUEUE, `${Date.now().toString(36)}-${randomBytes(5).toString("hex")}.json`), { kind: r.op === "spawn" ? "workspace.spawn" : "workspace.close", args, at: Date.now() });
  return { ok: true, workspace: r.name };
};

declare namespace signed {
  // The domain acme: w1 holds both main checkouts; w2 was started by w1, in a worktree "w2".
  type Fresh = Invoke<typeof emptyRoot>;
  type Acme = Invoke<typeof aDomain, [slug: "acme", repos: ["acme/api", "acme/web"]]>;
  type W1 = Invoke<typeof aWorkspace, [domain: "acme", name: "w1", checkouts: ["acme/api=main", "acme/web=main"]]>;
  type W2 = Invoke<typeof aWorkspace, [domain: "acme", name: "w2", checkouts: ["acme/api=worktree:w2", "acme/web=worktree:w2"], startedBy: "w1"]>;
  // Each request is signed as shared/spawn.ts makes it (`at`, `nonce`, `mac`): the root cannot
  // check the signature (it has no key, by design; the host does).

  /** a spawn the root can say nothing against is queued for the host, for the domain whose
   *  outbox it came from, whatever the request says its domain is */
  export type Queues = Given<
    [Fresh, Acme, W1],
    [
      Expect<Invoke<typeof signed, [domain: "acme", request: { at: "2026-11-16T12:00:00.000Z"; nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f"; mac: "abababababababababababababababababababababababababababababababab"; op: "spawn"; domain: "other"; parent: "w1"; name: "helper"; checkouts: ["acme/web=worktree:task/web"]; command: ["claude", "-p", "fix it"] }]>, "=", { ok: true; workspace: "helper" }>,
      Expect<Invoke<typeof jsonFilesIn, [where: "state", dir: "host-queue"]>, "matches", [{
        kind: "workspace.spawn";
        args: { domain: "acme"; workspace: "helper"; parent: "w1"; branch: ""; checkouts: '["acme/web=worktree:task/web"]'; command: '["claude","-p","fix it"]'; mac: "abababababababababababababababababababababababababababababababab" };
      }]>,
    ]
  >;
  /** a spawn waiting in the queue holds its name already */
  export type PendingHoldsItsName = Given<
    [Fresh, Acme, W1, Invoke<typeof signed, [domain: "acme", request: { at: "2026-11-16T12:00:00.000Z"; nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f"; mac: "abababababababababababababababababababababababababababababababab"; op: "spawn"; parent: "w1"; name: "helper"; checkouts: ["acme/web=worktree:a"] }]>],
    Expect<Invoke<typeof signed, [domain: "acme", request: { at: "2026-11-16T12:00:00.000Z"; nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f"; mac: "abababababababababababababababababababababababababababababababab"; op: "spawn"; parent: "w1"; name: "helper"; checkouts: ["acme/web=worktree:b"] }]>, "=", { ok: false; error: "acme already has a workspace 'helper'"; fix: "desolate spawn --name <another>" }>
  >;
  /** what is refused at once, to the workspace that asked, in its terms; nothing is queued */
  export type Refuses = Given<[Fresh, Acme, W1, W2], [
    Expect<Invoke<typeof signed, [domain: "acme", request: { op: "spawn"; parent: "w1"; name: "helper" }]>, "=", { ok: false; error: "that is not a request desolate makes (desolate spawn --help)" }>,
    Expect<Invoke<typeof signed, [domain: "acme", request: { at: "2026-11-16T12:00:00.000Z"; nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f"; mac: "abababababababababababababababababababababababababababababababab"; op: "spawn"; parent: "w9"; name: "helper" }]>, "=", { ok: false; error: "acme has no workspace 'w9'" }>,
    Expect<Invoke<typeof signed, [domain: "acme", request: { at: "2026-11-16T12:00:00.000Z"; nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f"; mac: "abababababababababababababababababababababababababababababababab"; op: "spawn"; parent: "w1"; name: "template" }]>, "=", { ok: false; error: "'template' is the name of the domain's template build"; fix: "desolate spawn --name <another>" }>,
    Expect<Invoke<typeof signed, [domain: "acme", request: { at: "2026-11-16T12:00:00.000Z"; nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f"; mac: "abababababababababababababababababababababababababababababababab"; op: "spawn"; parent: "w1"; name: "w2" }]>, "=", { ok: false; error: "acme already has a workspace 'w2'"; fix: "desolate spawn --name <another>" }>,
    Expect<Invoke<typeof signed, [domain: "acme", request: { at: "2026-11-16T12:00:00.000Z"; nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f"; mac: "abababababababababababababababababababababababababababababababab"; op: "spawn"; parent: "w1"; name: "helper"; checkouts: ["other/x=main"] }]>, "=", { ok: false; error: "other/x is not in the domain acme"; fix: "desolate spawn --checkout <one of: acme/api, acme/web>=worktree:<branch>" }>,
    Expect<Invoke<typeof signed, [domain: "acme", request: { at: "2026-11-16T12:00:00.000Z"; nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f"; mac: "abababababababababababababababababababababababababababababababab"; op: "spawn"; parent: "w2"; name: "helper"; checkouts: ["acme/api=main"] }]>, "=", { ok: false; error: "the main checkout of acme/api is checked out in acme/w1"; fix: "desolate spawn --name helper --checkout acme/api=worktree:<a branch of its own>" }>,
    Expect<Invoke<typeof signed, [domain: "acme", request: { at: "2026-11-16T12:00:00.000Z"; nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f"; mac: "abababababababababababababababababababababababababababababababab"; op: "spawn"; parent: "w1"; name: "helper"; branch: "w2" }]>, "matches", { ok: false; error: "the branch 'w2' is checked out in acme/w2 (a workspace you start gets that branch in each repository you do not name with --checkout)" }>,
    Expect<Invoke<typeof jsonFilesIn, [where: "state", dir: "host-queue"]>, "=", []>,
  ]>;
  /** the person's limit on what its workspaces may start: none at all, or a number */
  export type Limit = [
    Given<
      [Fresh, Invoke<typeof aDomain, [slug: "acme", repos: ["acme/api"], extra: { spawnMax: 0 }]>, W1],
      Expect<Invoke<typeof signed, [domain: "acme", request: { at: "2026-11-16T12:00:00.000Z"; nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f"; mac: "abababababababababababababababababababababababababababababababab"; op: "spawn"; parent: "w1"; name: "helper" }]>, "=", { ok: false; error: "acme's workspaces cannot start workspaces: the person turned it off"; fix: "on the Mac: desolate domain acme spawn --max none" }>
    >,
    Given<
      [Fresh, Invoke<typeof aDomain, [slug: "acme", repos: ["acme/api", "acme/web"], extra: { spawnMax: 1 }]>, W1, W2],
      Expect<Invoke<typeof signed, [domain: "acme", request: { at: "2026-11-16T12:00:00.000Z"; nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f"; mac: "abababababababababababababababababababababababababababababababab"; op: "spawn"; parent: "w1"; name: "helper"; checkouts: ["acme/web=worktree:x"] }]>, "=", { ok: false; error: "acme already has 1 workspace(s) started by its workspaces, its limit of 1"; fix: "close one you started (desolate close <name>), or ask the person to raise the limit" }>
    >,
  ];
  /** a workspace closes only one it started */
  export type Close = Given<[Fresh, Acme, W1, W2, Invoke<typeof aWorkspace, [domain: "acme", name: "w3", checkouts: []]>], [
    Expect<Invoke<typeof signed, [domain: "acme", request: { at: "2026-11-16T12:00:00.000Z"; nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f"; mac: "abababababababababababababababababababababababababababababababab"; op: "close"; parent: "w3"; name: "w2" }]>, "=", { ok: false; error: "acme/w2 was not started by w3: only the workspace that started it can close it"; fix: "ask the person: desolate rm on the Mac" }>,
    Expect<Invoke<typeof signed, [domain: "acme", request: { at: "2026-11-16T12:00:00.000Z"; nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f"; mac: "abababababababababababababababababababababababababababababababab"; op: "close"; parent: "w1"; name: "gone" }]>, "=", { ok: false; error: "acme has no workspace 'gone'" }>,
    Expect<Invoke<typeof signed, [domain: "acme", request: { at: "2026-11-16T12:00:00.000Z"; nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f"; mac: "abababababababababababababababababababababababababababababababab"; op: "close"; parent: "w1"; name: "w2" }]>, "=", { ok: true; workspace: "w2" }>,
    Expect<Invoke<typeof jsonFilesIn, [where: "state", dir: "host-queue"]>, "matches", [{ kind: "workspace.close"; args: { domain: "acme"; workspace: "w2"; parent: "w1" } }]>,
  ]>;
}

const handle = async (domain: string, repoList: string[], request: Record<string, unknown>): Promise<Record<string, unknown>> => {
  if (request.op === "spawn" || request.op === "close") return signed(domain, request);
  const repo = parseRepo(request.repo);
  // Only its own domain's repositories.
  if (!repo || !repoList.includes(String(request.repo))) return { ok: false, error: "that repository is not in this domain" };
  if (request.op === "fetch") {
    await repos.fetch(repo);
    return { ok: true };
  }
  if (request.op === "offer") return take(domain, request);
  if (request.op === "issue") return issues.offer(domain, repoList, workspaces(domain).map((w) => w.workspace), request);
  return { ok: false, error: "the root takes 'fetch', 'offer', 'issue', 'spawn' and 'close' from a workspace, and nothing else" };
};

declare namespace handle {
  type Fresh = Invoke<typeof emptyRoot>;
  /** a workspace asks only of its own domain's repositories, and only for what is on the list */
  export type Refuses = Given<[Fresh, Invoke<typeof aDomain, [slug: "acme", repos: ["acme/app"]]>], [
    Expect<Invoke<typeof handle, [domain: "acme", repoList: ["acme/app"], request: { op: "fetch"; repo: "other/app" }]>, "=", { ok: false; error: "that repository is not in this domain" }>,
    Expect<Invoke<typeof handle, [domain: "acme", repoList: ["acme/app"], request: { op: "fetch"; repo: "acme/app/../../other" }]>, "=", { ok: false; error: "that repository is not in this domain" }>,
    Expect<Invoke<typeof handle, [domain: "acme", repoList: ["acme/app"], request: { op: "push"; repo: "acme/app"; branch: "main" }]>, "=", { ok: false; error: "the root takes 'fetch', 'offer', 'issue', 'spawn' and 'close' from a workspace, and nothing else" }>,
  ]>;
  /** an issue offered, kept for the person */
  export type Issue = Given<
    [Fresh, Invoke<typeof aDomain, [slug: "acme", repos: ["acme/app"]]>],
    Expect<Invoke<typeof handle, [domain: "acme", repoList: ["acme/app"], request: { op: "issue"; repo: "acme/app"; title: "Login loops" }]>, "matches", { ok: true }>
  >;
}

/** The reply to one request a domain left in its outbox: what it asked, if it is a request,
 *  and the domain has not asked too often; a failure on the way is a refusal, not a crash. */
const answer = async (domain: string, repoList: string[], request: Record<string, unknown> | null): Promise<Record<string, unknown>> => {
  let reply: Record<string, unknown>;
  if (!request || typeof request.op !== "string") reply = { ok: false, error: "not a request" };
  else if (!allowed(domain)) reply = { ok: false, error: `this domain has made ${RATE.perMinute} requests in a minute; wait and ask again` };
  else
    try {
      reply = await handle(domain, repoList, request);
    } catch (error) {
      reply = { ok: false, error: error instanceof Error ? error.message.slice(0, 500) : "the root failed" };
    }
  return reply;
};

declare namespace answer {
  type Fresh = Invoke<typeof emptyRoot>;
  /** what is not a request is answered as such, and nothing is done */
  export type NotARequest = [
    Expect<Invoke<typeof answer, [domain: "acme", repoList: ["acme/app"], request: null]>, "=", { ok: false; error: "not a request" }>,
    Expect<Invoke<typeof answer, [domain: "acme", repoList: ["acme/app"], request: { op: 7 }]>, "=", { ok: false; error: "not a request" }>,
  ];
  /** a request that fails on the way is a refusal with the reason, and the daemon goes on */
  export type FailsAsARefusal = Given<
    Fresh,
    Expect<Invoke<typeof answer, [domain: "gone", repoList: ["acme/app"], request: { op: "offer"; repo: "acme/app"; branch: "fix"; commit: "0123456789abcdef0123456789abcdef01234567" }]>, "=", { ok: false; error: "there is no domain 'gone'" }>
  >;
  /** a request that passes is handled (an issue offered, here) */
  export type Handled = Given<
    [Fresh, Invoke<typeof aDomain, [slug: "acme", repos: ["acme/app"]]>],
    Expect<Invoke<typeof answer, [domain: "acme", repoList: ["acme/app"], request: { op: "issue"; repo: "acme/app"; title: "Login loops" }]>, "matches", { ok: true }>
  >;
}

const log = (line: string) => process.stderr.write(`${new Date().toISOString()} rootd: ${line}\n`);

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
    await fetchDomain(slug, repo).catch((error: Error) => log(`${slug} ${id}: not imported: ${error.message.slice(0, 300)}`));
  }
};

/** A pushed branch's pull request is merged on the forge, not here: so a repository with a
 *  push still waiting to land is fetched now and then (pushed.ts), and its mirror shows the
 *  merge without anyone asking. The same fetch as `desolate fetch`, with the read key. */
const LANDED_EVERY_MS = Number(process.env.DESOLATE_LANDED_CHECK_MS) || 15 * 60_000;
let landedAt = Date.now();
let checking = false;
// Beside the loop, not in it: a fetch can take minutes, and requests keep being answered.
const checkLanded = () => {
  if (checking || Date.now() - landedAt < LANDED_EVERY_MS) return;
  checking = true;
  landedAt = Date.now();
  void (async () => {
    for (const id of waiting()) {
      const repo = parseRepo(id);
      if (repo) await repos.fetch(repo).catch((error: Error) => log(`${id}: not fetched to look for merges: ${error.message.slice(0, 300)}`));
    }
  })().finally(() => {
    checking = false;
  });
};

const main = async () => {
log("up");
for (;;) {
  checkLanded();
  for (const d of domains()) {
    await importChanged(d.slug, d.repos);
    // Each request is read once and removed, by name, in a directory that was checked to be
    // the outbox's own (outbox.ts): never through a path a workspace could have redirected.
    for (const { name, data: request } of drain<Record<string, unknown>>(path.join(outbox(d.slug), "requests"), /^[0-9a-z-]{1,60}\.json$/, 50)) {
      const reply = await answer(d.slug, d.repos, request);
      log(`${d.slug} ${String(request?.op)} ${String(request?.repo ?? request?.name)} -> ${reply.ok === true ? "ok" : `refused: ${String(reply.error)}`}`);
      writeJson(path.join(inbox(d.slug), "replies", name), reply);
    }
    // Replies are read within moments; old ones are swept.
    try {
      for (const name of fs.readdirSync(path.join(inbox(d.slug), "replies")))
        if (Date.now() - fs.statSync(path.join(inbox(d.slug), "replies", name)).mtimeMs > 600_000) fs.rmSync(path.join(inbox(d.slug), "replies", name), { force: true });
    } catch {
      /* no replies yet */
    }
  }
  await sleep(250);
}
};

// Run by start.sh (`kept rootd rootd.ts`: node with this file's path); imported, it does nothing.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === new URL(import.meta.url).pathname) await main();
