// Workspaces, from the host: up, list, stop, rm, exec.
import { forTerminal, printableLines } from "../shared/text.ts";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EXIT, refuse } from "../shared/exit.ts";
import { devHostname, editorHostname, editorHostPort, isBranch, isSlug, parseRepo, workspaceVmName } from "../shared/names.ts";
import { outlived } from "../shared/plan.ts";
import type { WorkspacePlan } from "../shared/plan.ts";
import { readHead } from "../shared/status.ts";
import { checkSize, defaultsFor, describe as describeSize, LIMITS, merge, parseDisk, parseMemory } from "../shared/size.ts";
import type { Size } from "../shared/size.ts";
import { terminalFilter } from "../shared/terminal-filter.ts";
import { guest, INSTANCE, paths, RELEASE_DIR } from "./paths.ts";
import { retiredAt, stale } from "./retired.ts";
import { backend, ensureProxyUser, rootctl } from "./stack.ts";
import type { VmSpec } from "./vm/types.ts";
import type { Expect, Given, Invoke, Table, Throws } from "../../.suede/nests/dsl.import.meta.vitest.ts";
import type { setEnv } from "../../tests/nests/env.harness.ts";
import type { refusalOf } from "../../tests/nests/refusal.harness.ts";

type Out = (line: string) => void;
type Workspace = WorkspacePlan & { state: string };
type DomainView = { slug: string; title: string; repos: string[]; workspaces: Workspace[] };

const NODE = ["node", "--disable-warning=ExperimentalWarning"];

export const splitTarget = (target: string | undefined): { domain: string; workspace: string } => {
  const parts = (target ?? "").split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) refuse(`'${target ?? ""}' does not name a workspace`, "name it as <domain>/<workspace> (see `desolate list`)", EXIT.usage);
  return { domain: parts[0]!, workspace: parts[1]! };
};

declare namespace splitTarget {
  /** `<domain>/<workspace>`, and nothing more or less */
  export type Names = Expect<Invoke<typeof splitTarget, [target: "acme/w1"]>, "=", { domain: "acme"; workspace: "w1" }>;
  export type Refuses = [
    Expect<Invoke<typeof refusalOf, [run: typeof splitTarget, args: [target: "acme"]]>, "=", { message: "'acme' does not name a workspace"; fix: "name it as <domain>/<workspace> (see `desolate list`)"; code: 64 }>,
    Throws<Invoke<typeof splitTarget, [target: "acme/w1/x"]>, "'acme/w1/x' does not name a workspace">,
    Throws<Invoke<typeof splitTarget, [target: "/w1"]>, "'/w1' does not name a workspace">,
    Throws<Invoke<typeof splitTarget, [target: undefined]>, "'' does not name a workspace">,
  ];
}

export const specOf = (plan: WorkspacePlan, repos: string[]): VmSpec => ({
  name: plan.vm,
  role: "workspace",
  egress: "none",
  shares: [
    { host: RELEASE_DIR, guest: guest.release, writable: false },
    { host: paths.domainRepos(plan.domain), guest: guest.workspaces, writable: true },
    { host: paths.outbox(plan.domain), guest: guest.outbox, writable: true },
    // The inbox is the root's to write: a domain cannot forge a delivery or its own plan.
    { host: paths.inbox(plan.domain), guest: guest.inbox, writable: false },
    // The domain's package caches (section 4.7, C4): npm's, pip's and the rest, shared by
    // the domain's workspaces and nobody else's. Whatever one of them puts there, every
    // workspace of the domain could have done itself (section 2), so sharing it poisons
    // nothing; it is never shown to another domain, the root's git or the host's tools.
    { host: paths.domainCache(plan.domain), guest: guest.cache, writable: true },
    // The mirrors of this domain's repositories, and no others, each read-only and at the
    // same path in every VM (a clone's alternates file names it).
    ...repos.map((id) => {
      const repo = parseRepo(id)!;
      return { host: paths.mirror(repo), guest: guest.mirror(repo), writable: false };
    }),
  ],
  sockets: [{ host: `${paths.link(plan.vm)}/proxy.sock`, guest: guest.linkSocket }],
  // Its size, as the plan records it (shared/size.ts); a plan from before sizes were
  // recorded (a template's builder, an old workspace started again) gets the stack's defaults.
  ...(plan.size ?? stackDefaults()),
  labels: { title: `${plan.domain}/${plan.workspace}`, domain: plan.domain, workspace: plan.workspace },
});

declare namespace specOf {
  type Plan = {
    domain: "acme"; workspace: "w1"; vm: "dsl-main-ddb30a57cc"; title: "w1"; fetch: false; createdAt: "2026-11-16T10:00:00Z";
    checkouts: [{ repo: "acme/web"; kind: "worktree"; name: "fix-login"; branch: "fix/login"; base: "origin/main"; path: "/workspaces/acme/web/.worktrees/fix-login" }];
    size: { cpus: 4; memoryMiB: 8192; diskGiB: 60 };
  };
  /** no network but its link; its domain's clones, outbox and caches writable; the inbox (the
   *  root's to write) and the mirrors of its domain's repositories, and only those, read-only */
  export type Shares = Expect<Invoke<typeof specOf, [plan: Plan, repos: ["acme/web", "acme/api"]]>, "matches", {
    name: "dsl-main-ddb30a57cc"; role: "workspace"; egress: "none";
    shares: [
      { guest: "/desolate/release"; writable: false },
      { guest: "/workspaces"; writable: true },
      { guest: "/desolate/outbox"; writable: true },
      { guest: "/desolate/inbox"; writable: false },
      { guest: "/desolate/cache"; writable: true },
      { guest: "/desolate/mirrors/acme/web.git"; writable: false },
      { guest: "/desolate/mirrors/acme/api.git"; writable: false },
    ];
    sockets: [{ guest: "/desolate/link/proxy.sock" }];
    cpus: 4; memoryMiB: 8192; diskGiB: 60;
    labels: { title: "acme/w1"; domain: "acme"; workspace: "w1" };
  }>;
}

const sized = (name: string, fallback: number, min: number, max: number) => {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) refuse(`${name} is '${value}'`, `a whole number from ${min} to ${max}`);
  return number;
};

/** The stack's defaults: from this Mac (its cores and memory), worked out each time and
 *  stored nowhere; DESOLATE_WORKSPACE_CPUS, _MEMORY_MIB and _DISK_GIB override them. */
export const stackDefaults = (): Size => {
  const mac = defaultsFor(os.cpus().length, Math.floor(os.totalmem() / 1024 / 1024));
  return {
    cpus: sized("DESOLATE_WORKSPACE_CPUS", mac.cpus, LIMITS.cpus[0], LIMITS.cpus[1]),
    memoryMiB: sized("DESOLATE_WORKSPACE_MEMORY_MIB", mac.memoryMiB, LIMITS.memoryMiB[0], LIMITS.memoryMiB[1]),
    diskGiB: sized("DESOLATE_WORKSPACE_DISK_GIB", mac.diskGiB, LIMITS.diskGiB[0], LIMITS.diskGiB[1]),
  };
};
declare namespace stackDefaults {
  type Overrides = [
    Invoke<typeof setEnv, [name: "DESOLATE_WORKSPACE_CPUS", value: "3"]>,
    Invoke<typeof setEnv, [name: "DESOLATE_WORKSPACE_MEMORY_MIB", value: "6144"]>,
    Invoke<typeof setEnv, [name: "DESOLATE_WORKSPACE_DISK_GIB", value: "40"]>,
  ];
  /** the environment overrides what this Mac would give, each part */
  export type Overridden = Given<Overrides, Expect<Invoke<typeof stackDefaults>, "=", { cpus: 3; memoryMiB: 6144; diskGiB: 40 }>>;
  /** within the limits a workspace may have, as whole numbers */
  export type Refuses = Given<
    Invoke<typeof setEnv, [name: "DESOLATE_WORKSPACE_CPUS", value: "1.5"]>,
    Expect<Invoke<typeof refusalOf, [run: typeof stackDefaults, args: []]>, "=", { message: "DESOLATE_WORKSPACE_CPUS is '1.5'"; fix: "a whole number from 1 to 64"; code: 1 }>
  >;
}

/** `--cpus 4 --memory 8g --disk 60g`, read and checked. */
export const sizeFlags = (values: { cpus?: unknown; memory?: unknown; disk?: unknown }): Partial<Size> => {
  const size: Partial<Size> = {};
  if (values.cpus !== undefined) size.cpus = Number(values.cpus);
  if (values.memory !== undefined) size.memoryMiB = parseMemory(values.memory) ?? refuse(`--memory '${String(values.memory)}' is not an amount`, "--memory 8g (or 4096 for MiB)", EXIT.usage);
  if (values.disk !== undefined) size.diskGiB = parseDisk(values.disk) ?? refuse(`--disk '${String(values.disk)}' is not an amount`, "--disk 60g", EXIT.usage);
  const why = checkSize(size);
  if (why) refuse(why, "--cpus <n> --memory <8g> --disk <60g>", EXIT.usage);
  return size;
};

declare namespace sizeFlags {
  /** each flag as `up` and `domain <d> size` take it; what is not given is left to the next */
  export type Reads = Table<typeof sizeFlags, [
    [args: [values: { cpus: "4"; memory: "8g"; disk: "60g" }], expected: { cpus: 4; memoryMiB: 8192; diskGiB: 60 }],
    [args: [values: { memory: "4096" }], expected: { memoryMiB: 4096 }],
    [args: [values: {}], expected: {}],
  ]>;
  /** a usage error (exit 64), with the spelling that works */
  export type Refuses = [
    Expect<Invoke<typeof refusalOf, [run: typeof sizeFlags, args: [values: { memory: "lots" }]]>, "=", { message: "--memory 'lots' is not an amount"; fix: "--memory 8g (or 4096 for MiB)"; code: 64 }>,
    Throws<Invoke<typeof sizeFlags, [values: { cpus: "four" }]>, "CPUs must be from 1 to 64">,
    Throws<Invoke<typeof sizeFlags, [values: { disk: "10g" }]>, "disk must be from 30 GiB to 2048 GiB">,
  ];
}

/** What a workspace VM printed is the workspace's text. On its way to the person's
 *  terminal it is text: nothing in it may move the cursor, retitle the window or write the
 *  clipboard. (`desolate exec` is different: there the person asked for the VM's output.) */
const said = (text: string) => printableLines(text);

export const startServices = async (plan: WorkspacePlan) => {
  const b = backend();
  // Each step's time, for whoever is watching (DESOLATE_PROGRESS): where a start goes.
  let at = Date.now();
  const step = (name: string) => {
    if (process.env.DESOLATE_PROGRESS) process.stderr.write(`progress:   ${name} (${((Date.now() - at) / 1000).toFixed(1)} s)\n`);
    at = Date.now();
  };
  // The workspace's own proxy, in the root, as its domain's proxies' user; then its link,
  // which leads there and nowhere else.
  await ensureProxyUser(plan.domain);
  const proxy = await rootctl<{ socket: string }>("proxy.start", { vm: plan.vm, domain: plan.domain, workspace: plan.workspace }, { quiet: true });
  const { connectWorkspace } = await import("./daemon.ts");
  step("its proxy");
  await connectWorkspace({ ...plan, proxy: proxy.socket });
  step("its link");
  const services = await b.exec(plan.vm, ["bash", `${guest.release}/workspace/start.sh`, String(process.getuid!()), b.link(plan.vm).guest], { root: true, timeoutMs: 300_000 });
  step("its services (start.sh)");
  if (services.code !== 0) throw new Error(`the workspace's services did not start: ${said((services.stderr || services.stdout).trim().slice(-600))}`);
  // Its key, for what it asks of the host through the root (host/spawn.ts).
  await (await import("./spawn.ts")).giveIdentity(b, plan.vm);
  // start.sh puts the user in the docker group; what the host runs next must have it.
  await b.refreshSessions?.(plan.vm, services.stdout.includes("desolate: sessions raised"));
  const init = await b.exec(plan.vm, [...NODE, `${guest.release}/workspace/init.ts`, plan.workspace], { timeoutMs: 900_000 });
  step("its checkouts (init.ts)");
  if (init.code !== 0) throw new Error(`the workspace could not make its checkouts: ${said((init.stderr || init.stdout).trim().slice(-800))}`);
  // A docker daemon only where one is wanted: a checkout with a spec (start.sh says how).
  if (plan.checkouts.some((c) => locateSpec(paths.domainRepos(plan.domain), c))) await b.exec(plan.vm, ["bash", `${guest.release}/workspace/start.sh`, String(process.getuid!()), b.link(plan.vm).guest, "docker"], { root: true, timeoutMs: 300_000 });
  // The project's devcontainer, then the editor (which runs in it when it can). Neither
  // fails the workspace: without them it is the VM itself, and `up` says which it is.
  step("docker");
  const dev = await b.exec(plan.vm, [...NODE, `${guest.release}/workspace/devcontainer.ts`, plan.workspace], { timeoutMs: 3_700_000 });
  step("the devcontainer"); 
  const devcontainer = said(/^devcontainer: (.*)$/m.exec(dev.stdout)?.[1]?.trim().slice(0, 500) ?? `FAILED: ${(dev.stderr || dev.stdout).trim().slice(-300) || "it said nothing"}`);
  // (With the time the host last retired the tokens: a token older than that is made again.)
  const editor = await b.exec(plan.vm, ["bash", "-lc", `bash ${guest.release}/workspace/editor.sh ${editorHostname(INSTANCE, plan.domain, plan.workspace)} ${retiredAt()}`], { timeoutMs: 300_000 });
  step("the editor");
  return { editorDown: editor.code === 0 ? null : said((editor.stderr || editor.stdout).trim().split("\n").slice(-2).join(" ").slice(0, 300)) || "the editor did not start", devcontainer };
};

/** The address a person opens for a workspace's editor: its own hostname, the stack's
 *  editor port, the token the VM made, and the first checkout as the folder. */
export const editorUrl = async (w: Workspace): Promise<{ url: string } | { error: string }> => {
  const token = await backend().exec(w.vm, ["bash", "-lc", "cat ~/.desolate-editor/token"], { timeoutMs: 60_000 });
  if (token.code !== 0 || !/^[0-9a-f]{48}$/.test(token.stdout.trim())) return { error: "the editor is not running in this workspace (its image may have none: desolate doctor)" };
  if (await editorTokenStale(w.vm)) return { error: "its token was retired (another program held [::1] on the editors' port), and has not been made again: desolate bootstrap, or restart the workspace" };
  const { editorPort } = await import("./daemon.ts");
  const { port, error } = await editorPort();
  if (error) return { error: `the editor's port is not available on this machine: ${error}. Free it, or set DESOLATE_EDITOR_PORT, then: desolate bootstrap` };
  // One checkout: its folder. More: the workspace file the workspace's init wrote, with all
  // of them (workspace/init.ts).
  const folder = w.checkouts[0]?.path;
  const where = w.checkouts.length > 1 ? `&workspace=${encodeURIComponent(`/workspaces/.desolate/${w.workspace}.code-workspace`)}` : folder ? `&folder=${encodeURIComponent(folder)}` : "";
  return { url: `http://${editorHostname(INSTANCE, w.domain, w.workspace)}:${port}/?tkn=${token.stdout.trim()}${where}` };
};

export const editor = async (target: string | undefined, out: Out, json: boolean) => {
  const w = await find(target);
  if ((await backend().info(w.vm)).status !== "running") refuse(`${w.domain}/${w.workspace} is not running`, `desolate start ${w.domain}/${w.workspace}`);
  const result = await editorUrl(w);
  if ("error" in result) refuse(result.error, `desolate start ${w.domain}/${w.workspace}`);
  out(json ? JSON.stringify(result) : (result as { url: string }).url);
};

/** Whether a checkout carries a devcontainer spec: its existence only, read on the host as
 *  data (P4), where the checkout is a directory in the domain's share. */
const locateSpec = (reposDir: string, c: { repo: string; kind: string; name: string }) => {
  const dir = c.kind === "main" ? path.join(reposDir, c.repo) : path.join(reposDir, c.repo, ".worktrees", c.name);
  return fs.existsSync(path.join(dir, ".devcontainer", "devcontainer.json")) || fs.existsSync(path.join(dir, ".devcontainer.json"));
};

export const urlsOf = (plan: { domain: string; workspace: string }) => ({
  editor: `http://${editorHostname(INSTANCE, plan.domain, plan.workspace)}:${editorHostPort()}`,
  dev: `http://${devHostname(INSTANCE, plan.domain, plan.workspace)}`,
});

declare namespace urlsOf {
  /** its editor, on the stack's editor port, and its dev servers, each at a name of its own */
  export type Names = Expect<Invoke<typeof urlsOf, [plan: { domain: "acme"; workspace: "w1" }]>, "=", { editor: "http://acme-w1-editor-1a26c5.localhost:31581"; dev: "http://acme-w1-1a26c5.localhost" }>;
}

export const up = async (domain: string | undefined, options: { name?: string; checkouts: string[]; branch?: string; base?: string; fetch: boolean; size?: Partial<Size>; startedBy?: string; command?: string[]; keep?: { startedBy?: { workspace: string; createdAt: string }; parent?: string | null } }, out: Out, json: boolean) => {
  if (!domain) refuse("which domain?", "desolate up <domain> [--name <workspace>]", EXIT.usage);
  // --started-by <workspace>: the workspace of this domain that asked for this one (`desolate
  // spawn` in it, run by the host's daemon once it checked the request: host/spawn.ts).
  // (`keep`: a workspace made again on its own checkouts keeps who started it.)
  let startedBy: { workspace: string; createdAt: string } | undefined = options.keep?.startedBy;
  if (options.startedBy !== undefined) {
    const parent = await rootctl<Workspace>("workspace.get", { domain, name: options.startedBy }, { quiet: true });
    startedBy = { workspace: parent.workspace, createdAt: parent.createdAt };
  }
  const phases: [string, number][] = [];
  let mark = Date.now();
  const phase = (name: string) => {
    // For whoever is watching the start as it happens (the dashboard): each phase as it ends.
    if (process.env.DESOLATE_PROGRESS) process.stderr.write(`progress: ${name} (${((Date.now() - mark) / 1000).toFixed(1)} s)\n`);
    phases.push([name, Date.now() - mark]);
    mark = Date.now();
  };
  const started = Date.now();
  const b = backend();
  // A workspace is a clone of the base (or of a template made from it): one older than this
  // desolate's image would give it other tools than this desolate expects.
  const stale = b.baseStale?.() ?? null;
  if (stale) refuse(`${stale}: a workspace made now would run the older tools`, "desolate bootstrap (it provisions the base again: minutes, once)");
  let editorDown: string | null = null;
  let devcontainer = "";
  if (options.name === "template") refuse("'template' is the name of the domain's template build", `desolate up ${domain} --name <another>`, EXIT.usage);
  const view = await rootctl<DomainView>("domain.show", { slug: domain }, { quiet: true });
  // The environment: the first repository the person named with --checkout (its devcontainer,
  // if it has one), else the domain's. Before --branch adds the rest.
  const envRepo = options.checkouts[0]?.split("=")[0];
  // --branch <b>: a worktree on <b> in every repository of the domain (a --checkout names one
  // differently), so a task that spans repositories is one branch name in each.
  if (options.branch !== undefined) {
    if (!isBranch(options.branch)) refuse(`'${options.branch}' is not a branch desolate will carry`, "letters, digits, '.', '_', '-' and '/', not starting with a dash", EXIT.usage);
    const named = new Set(options.checkouts.map((c) => c.split("=")[0]));
    options = { ...options, checkouts: [...options.checkouts, ...view.repos.filter((repo) => !named.has(repo)).map((repo) => `${repo}=worktree:${options.branch}`)] };
  }
  if (options.fetch) for (const repo of view.repos) await rootctl("repo.fetch", { repo }, { quiet: json });
  if (options.fetch) phase("mirrors refreshed");
  // The domain's template (section 4.7, C3), before this workspace takes its checkouts:
  // made once per environment, then cloned. Not on the fake backend, whose clone carries no
  // docker images. DESOLATE_TEMPLATES=0 makes every workspace from the base.
  let template: string | null = null;
  if (b.kind !== "fake" && process.env.DESOLATE_TEMPLATES !== "0") {
    const { ensure } = await import("./templates.ts");
    const say = (line: string) => (json ? process.stderr.write(`${forTerminal(line)}\n`) : out(line));
    template = await ensure(domain, view.repos, { specOf, startServices }, say, envRepo);
    if (template) phase("template");
  }
  // Its size: the flags, then the domain's, then the stack's defaults (each part on its own).
  const size = merge(options.size, (view as DomainView & { size?: Partial<Size> }).size, stackDefaults());
  // Who commits in it: your own git identity, as on this Mac (as the git VM takes it).
  const mine = (key: string) => spawnSync("git", ["config", "--global", key], { encoding: "utf8" }).stdout?.trim() ?? "";
  const author = { name: mine("user.name"), email: mine("user.email") };
  const plan = vouched(await rootctl<Workspace>("workspace.plan", { instance: INSTANCE, domain, name: options.name, checkouts: options.checkouts, base: options.base, fetch: options.fetch, size, author, ...(startedBy ? { startedBy } : {}), ...(envRepo ? { env: envRepo } : {}) }, { quiet: true }), domain, options.name);
  // A VM of that name already here is not this workspace's: refused, and never destroyed below.
  // (Names are a hash of the domain and the workspace; one domain could search for a name of
  // its own that collides with another domain's VM: audit, 2026-11-16.)
  if ((await b.info(plan.vm)).status !== "missing") {
    await rootctl("workspace.remove", { domain, name: plan.workspace }, { quiet: true }).catch(() => {});
    refuse(`a VM named ${plan.vm} already exists, and it is not ${domain}/${plan.workspace}'s`, `desolate up ${domain} --name <another name>`, EXIT.busy);
  }
  // (The domain, whether it has a template to make, and the plan, which is two small files:
  // asks of the root, about 0.2 s each. No network: --fetch is its own phase, above.)
  phase("asked the root");
  let made = false;
  try {
    if (template) await b.clone(template, specOf(plan, view.repos));
    else await b.create(specOf(plan, view.repos));
    made = true;
    await b.start(plan.vm);
    phase("VM booted");
    ({ editorDown, devcontainer } = await startServices(plan));
    phase("services, checkouts, devcontainer and editor");
  } catch (error) {
    // A workspace that did not come up holds no checkout, and leaves no proxy or link.
    const { disconnectWorkspace } = await import("./daemon.ts");
    await disconnectWorkspace(plan.vm).catch(() => {});
    await rootctl("proxy.stop", { vm: plan.vm }, { quiet: true }).catch(() => {});
    // Only a VM this run made (one that appeared between the check above and the create is
    // not this workspace's to destroy).
    if (made) await b.destroy(plan.vm).catch(() => {});
    await rootctl("workspace.remove", { domain, name: plan.workspace }, { quiet: true }).catch(() => {});
    if (made) (await import("./spawn.ts")).forget(domain, plan.workspace);
    throw error;
  }
  await rootctl("workspace.state", { domain, name: plan.workspace, state: "up" }, { quiet: true });
  const parent = options.keep ? options.keep.parent : startedBy?.workspace;
  if (parent) (await import("./spawn.ts")).recordStarted(domain, plan.workspace, parent);
  // `-- <command...>`: an agent, started in it once it is up (host/agent.ts).
  const agent = options.command?.length ? await (await import("./agent.ts")).startIn(plan, options.command) : null;
  const seconds = (ms: number) => (ms / 1000).toFixed(1);
  const breakdown = `the start took ${seconds(Date.now() - started)} s: ${phases.map(([name, ms]) => `${name} ${seconds(ms)} s`).join(", ")}`;
  const opened = editorDown ? { error: editorDown } : await editorUrl(plan);
  const urls = { ...urlsOf(plan), ...("url" in opened ? { editorWithToken: opened.url } : { editorError: opened.error }) };
  if (json) return out(JSON.stringify({ domain, workspace: plan.workspace, vm: plan.vm, isolated: b.isolated, checkouts: plan.checkouts, size: plan.size ?? size, devcontainer, urls, ...(startedBy ? { startedBy } : {}), ...(agent ? { agent } : {}), tookMs: Date.now() - started, phases: Object.fromEntries(phases) }));
  out(`workspace ${domain}/${plan.workspace} is up${b.isolated ? "" : "  [NOT ISOLATED: fake backend]"}${startedBy ? `, started by ${domain}/${startedBy.workspace}` : ""}`);
  for (const c of plan.checkouts) out(`  ${c.repo}  ${c.kind === "main" ? `main checkout (${c.branch})` : `worktree ${c.branch} from ${c.base}`}  ${c.path}`);
  out(`  size         ${describeSize(plan.size ?? size)}`);
  if (!author.name || !author.email)
    out(`  commits as   ${author.name || `${domain}/${plan.workspace}`} <${author.email || `${plan.workspace}@${domain}.desolate.invalid`}>: this Mac's git has no ${!author.name && !author.email ? "user.name or user.email" : !author.name ? "user.name" : "user.email"} (git config --global user.name "Your Name"; git config --global user.email you@example.com, then the next up uses them)`);
  out(`  devcontainer ${devcontainer}`);
  out("url" in opened ? `  editor       ${opened.url}` : `  editor       NOT AVAILABLE: ${opened.error}`);
  out(`  dev servers  ${urls.dev}:<port>   (the port it listens on inside, nothing to declare)`);
  if (agent) out(`  agent        ${agent} is running: desolate agent attach ${domain}/${plan.workspace}`);
  out(breakdown);
  out(`next: desolate editor ${domain}/${plan.workspace} --open      its editor, in your browser`);
  out(`      desolate exec ${domain}/${plan.workspace} -- <command>     a command in its devcontainer (bash, for a shell)`);
};

export const list = async (out: Out, json: boolean, only?: string) => {
  const b = backend();
  const domains = (await rootctl<DomainView[]>("domain.list", {}, { quiet: true })).filter((d) => !only || d.slug === only);
  const vms = new Map((await b.list()).map((vm) => [vm.name, vm.status]));
  const view = domains.map((d) => ({
    domain: d.slug, title: d.title, repos: d.repos,
    workspaces: d.workspaces.map((w) => ({
      workspace: w.workspace, vm: w.vm, status: vms.get(w.vm) ?? "missing", isolated: b.isolated, size: w.size ?? null,
      startedBy: w.startedBy?.workspace ?? null, outlived: outlived(d.workspaces, w),
      // What each checkout has checked out now (its HEAD, read here as data), beside what it
      // started on.
      checkouts: w.checkouts.map((c) => {
        const head = readHead(paths.domainRepos(d.slug), c);
        return { ...c, head, now: head ? (head.branch ?? (head.commit ? `(detached ${head.commit.slice(0, 12)})` : "(?)")) : c.branch };
      }),
      urls: urlsOf(w),
    })),
  }));
  if (json) return out(JSON.stringify(view));
  if (view.length === 0) return out("no domains yet. Start with: desolate domain create <slug>");
  for (const d of view) {
    out(`${d.domain}  "${d.title}"  ${d.repos.length ? d.repos.join(", ") : "(no repositories: desolate domain " + d.domain + " add --repo <owner>/<repo>)"}`);
    if (d.workspaces.length === 0) out(`  (no workspaces: desolate up ${d.domain})`);
    for (const w of d.workspaces)
      out(`  ${d.domain}/${w.workspace}  ${w.status}${w.isolated ? "" : "  [not isolated]"}  ${w.checkouts.map((c) => `${c.repo}@${c.now}`).join(", ")}${w.size ? `  (${w.size.cpus} CPU, ${Math.round(w.size.memoryMiB / 1024)} GiB)` : ""}  ${w.startedBy ? `started by ${w.startedBy}${w.outlived ? " (removed since: this one outlived it)" : ""}` : "started by you"}`);
  }
};

/** Every running workspace gets its proxy and its link again. A workspace's proxy lives in
 *  the root VM, so a root VM that was restarted left each running workspace with no way out
 *  at all, while `list` still said "running" (found on the M1). Bootstrap calls this.
 *  Returns how many were reconnected. */
/** The host's retiring a VM's editor token was made after (editor.sh writes it), or 0. */
export const editorTokenEpoch = async (vm: string) => {
  const made = await backend().exec(vm, ["bash", "-lc", "cat ~/.desolate-editor/token.epoch 2>/dev/null || echo 0"], { timeoutMs: 60_000 });
  const epoch = Number(made.stdout.trim());
  return made.code === 0 && Number.isSafeInteger(epoch) && epoch > 0 ? epoch : 0;
};
/** Whether a VM's editor token was made before the host last retired the tokens (retired.ts).
 *  One whose mark cannot be read is stale then: it is made again. */
const editorTokenStale = async (vm: string) => retiredAt() > 0 && stale(await editorTokenEpoch(vm));

export const reconnectRunning = async (): Promise<number> => {
  const b = backend();
  const running = new Set((await b.list()).filter((vm) => vm.status === "running").map((vm) => vm.name));
  const { connectWorkspace } = await import("./daemon.ts");
  let count = 0;
  for (const d of await rootctl<DomainView[]>("domain.list", {}, { quiet: true }))
    for (const w of d.workspaces) {
      // A record naming a VM that is not its own workspace's (the root's word, checked) gets
      // no proxy and no link: it would give one domain's VM another domain's rules.
      if (!running.has(w.vm) || w.domain !== d.slug || !isOwnVm(d.slug, w)) continue;
      await ensureProxyUser(w.domain);
      const proxy = await rootctl<{ socket: string }>("proxy.start", { vm: w.vm, domain: w.domain, workspace: w.workspace }, { quiet: true });
      await connectWorkspace({ ...w, proxy: proxy.socket });
      // And its end of the link, which restarts its relay if desolate's code changed (the
      // link's handshake is in it).
      await b.exec(w.vm, ["bash", `${guest.release}/workspace/net/up.sh`, b.link(w.vm).guest], { root: true, timeoutMs: 120_000 });
      // Its key too: a workspace made before keys were given gets one here, without a restart.
      await (await import("./spawn.ts")).giveIdentity(b, w.vm);
      // And its editor's token, made again if the host retired the tokens since it was made.
      if (await editorTokenStale(w.vm)) await b.exec(w.vm, ["bash", "-lc", `bash ${guest.release}/workspace/editor.sh ${editorHostname(INSTANCE, w.domain, w.workspace)} ${retiredAt()}`], { timeoutMs: 300_000 });
      count += 1;
    }
  return count;
};

/** The root's word about a workspace, checked against what the host computes itself: the root
 *  is where every domain's data is parsed, and a VM named in its answer is a VM the host
 *  stops, starts or destroys (audit, 2026-11-16: an answer naming another domain's VM would
 *  have had it removed). */
/** Whether a record of the root's names its own workspace's VM, in that domain. */
export const isOwnVm = (domain: string, w: { domain?: unknown; workspace: unknown; vm: unknown }) =>
  (w.domain === undefined || w.domain === domain) && isSlug(w.workspace) && w.vm === workspaceVmName(INSTANCE, domain, w.workspace);
export const vouched = <W extends { domain: string; workspace: string; vm: string }>(w: W, domain: string, workspace?: string): W => {
  if (w.domain !== domain || (workspace !== undefined && w.workspace !== workspace) || !isSlug(w.workspace) || w.vm !== workspaceVmName(INSTANCE, domain, w.workspace))
    refuse(`the root's answer about ${domain}/${workspace ?? w.workspace} does not name that workspace's own VM`, "desolate doctor; if it persists, the root VM is not well: desolate bootstrap");
  return w;
};
declare namespace isOwnVm {
  /** the VM a record names is the one the host computes for that workspace, in that domain */
  export type Records = Table<typeof isOwnVm, [
    [args: [domain: "acme", w: { domain: "acme"; workspace: "w1"; vm: "dsl-main-ddb30a57cc" }], expected: true],
    [args: [domain: "acme", w: { workspace: "w1"; vm: "dsl-main-ddb30a57cc" }], expected: true],
    /** another domain's workspace of the same name has another VM */
    [args: [domain: "acme", w: { domain: "acme"; workspace: "w1"; vm: "dsl-main-41eb634ef1" }], expected: false],
    [args: [domain: "acme", w: { domain: "beta"; workspace: "w1"; vm: "dsl-main-ddb30a57cc" }], expected: false],
    [args: [domain: "acme", w: { domain: "acme"; workspace: "../w1"; vm: "dsl-main-ddb30a57cc" }], expected: false],
    [args: [domain: "acme", w: { domain: "acme"; workspace: "w1"; vm: "dsl-main-root" }], expected: false],
  ]>;
}
declare namespace vouched {
  /** the root's answer is used only if it names the workspace asked about, and its own VM */
  export type Passes = Expect<Invoke<typeof vouched, [w: { domain: "acme"; workspace: "w1"; vm: "dsl-main-ddb30a57cc" }, domain: "acme", workspace: "w1"]>, "=", { domain: "acme"; workspace: "w1"; vm: "dsl-main-ddb30a57cc" }>;
  export type Refuses = [
    Throws<Invoke<typeof vouched, [w: { domain: "acme"; workspace: "w1"; vm: "dsl-main-41eb634ef1" }, domain: "acme", workspace: "w1"]>, "the root's answer about acme/w1 does not name that workspace's own VM">,
    Throws<Invoke<typeof vouched, [w: { domain: "acme"; workspace: "w2"; vm: "dsl-main-ddb30a57cc" }, domain: "acme", workspace: "w1"]>, "the root's answer about acme/w1 does not name that workspace's own VM">,
  ];
}
const find = async (target: string | undefined) => {
  const { domain, workspace } = splitTarget(target);
  return vouched(await rootctl<Workspace>("workspace.get", { domain, name: workspace }, { quiet: true }), domain, workspace);
};

export const stop = async (target: string | undefined, out: Out) => {
  const w = await find(target);
  const b = backend();
  const { disconnectWorkspace } = await import("./daemon.ts");
  // The VM first: its link's port is let go only once nothing in a VM can still dial it (a
  // freed port is anyone's on this machine to take; shared/link.ts).
  if ((await b.info(w.vm)).status === "running") await b.stop(w.vm);
  await disconnectWorkspace(w.vm);
  await rootctl("proxy.stop", { vm: w.vm }, { quiet: true }).catch(() => {});
  await rootctl("workspace.state", { domain: w.domain, name: w.workspace, state: "stopped" }, { quiet: true });
  out(`stopped ${w.domain}/${w.workspace}. Its checkouts stay held; start it again with: desolate start ${w.domain}/${w.workspace}`);
};

export const start = async (target: string | undefined, out: Out) => {
  const w = await find(target);
  const b = backend();
  const started = Date.now();
  const info = await b.info(w.vm);
  if (info.status === "missing") {
    // Its VM is gone (a destroy, or a VM removed by hand), its record and checkouts are not:
    // the checkouts are in the domain's clones on the host. Made again, on the same ones.
    out(`the VM of ${w.domain}/${w.workspace} is gone; making it again, on the same checkouts (they are on this Mac, and kept)`);
    const checkouts = w.checkouts.map((c) => (c.kind === "main" ? `${c.repo}=main` : `${c.repo}=worktree:${c.branch}`));
    const parent = (await import("./spawn.ts")).parentOf(w.domain, w.workspace);
    await remove(`${w.domain}/${w.workspace}`, () => {});
    return up(w.domain, { name: w.workspace, checkouts, fetch: false, size: w.size ?? undefined, keep: { startedBy: w.startedBy, parent } }, out, false);
  }
  if (info.status === "suspended") await b.resume(w.vm);
  else if (info.status !== "running") await b.start(w.vm);
  const { devcontainer, editorDown } = await startServices(w);
  await rootctl("workspace.state", { domain: w.domain, name: w.workspace, state: "up" }, { quiet: true });
  out(`workspace ${w.domain}/${w.workspace} is up (${((Date.now() - started) / 1000).toFixed(1)} s)`);
  if (w.size) out(`  size         ${describeSize(w.size)}`);
  out(`  devcontainer ${devcontainer}`);
  if (editorDown) out(`  editor       NOT AVAILABLE: ${editorDown}`);
};

/** What would be lost: each checkout's uncommitted changes, untracked files and stashes,
 *  looked at in the workspace itself (git runs in its own VM, never on the host: P4), after
 *  its branches are written out for the root. What the VM says is its word about itself. */
const unsaved = async (w: Workspace): Promise<string[]> => {
  const b = backend();
  if ((await b.info(w.vm)).status !== "running") return ["it is not running, so what it holds cannot be looked at (a person removes it: desolate rm)"];
  const script = `${NODE.join(" ")} ${guest.release}/workspace/desolate.ts sync >/dev/null 2>&1 || echo "UNSYNCED"
for p in "$@"; do
  s=$(git -C "$p" status --porcelain --untracked-files=normal 2>/dev/null) || { echo "UNREADABLE $p"; continue; }
  [ -z "$s" ] || echo "UNCOMMITTED $p"
  [ -z "$(git -C "$p" stash list 2>/dev/null)" ] || echo "STASHED $p"
done`;
  const looked = await b.exec(w.vm, ["bash", "-c", script, "_", ...w.checkouts.map((c) => c.path)], { timeoutMs: 120_000 });
  if (looked.code !== 0) return [`it could not be looked at: ${said(looked.stderr.trim().slice(-200))}`];
  const say: Record<string, string> = { UNSYNCED: "its branches could not be written out for the root", UNCOMMITTED: "uncommitted changes or untracked files in", STASHED: "stashed changes in", UNREADABLE: "a checkout git could not read:" };
  return looked.stdout.split("\n").map((line) => /^(UNSYNCED|UNCOMMITTED|STASHED|UNREADABLE)(?: (\/workspaces\/\S{1,300}))?$/.exec(line.trim())).filter((m) => m !== null).map((m) => `${say[m![1]!]}${m![2] ? ` ${m![2]}` : ""}`);
};

export const remove = async (target: string | undefined, out: Out, options: { ifClean?: boolean } = {}) => {
  if (target && !target.includes("/")) {
    const result = await rootctl<{ domain: string; kept: string }>("domain.remove", { slug: target }, { quiet: true });
    // Its template is its own and goes with it.
    await (await import("./templates.ts")).removeAll(result.domain);
    fs.rmSync(paths.domain(result.domain), { recursive: true, force: true });
    return out(`removed the domain ${result.domain}; ${result.kept}.`);
  }
  const w = await find(target);
  // --if-clean (a workspace closing one it started): only if nothing would be lost.
  if (options.ifClean) {
    const lost = await unsaved(w);
    if (lost.length > 0) refuse(`${w.domain}/${w.workspace} was not removed: ${lost.join("; ")}`, `commit or discard it there first (desolate exec ${w.domain}/${w.workspace} -- git status), or remove it yourself: desolate rm ${w.domain}/${w.workspace}`, EXIT.busy);
  }
  const { disconnectWorkspace } = await import("./daemon.ts");
  await backend().destroy(w.vm);
  await disconnectWorkspace(w.vm);
  await rootctl("proxy.stop", { vm: w.vm }, { quiet: true }).catch(() => {});
  fs.rmSync(paths.link(w.vm), { recursive: true, force: true });
  await rootctl("workspace.remove", { domain: w.domain, name: w.workspace }, { quiet: true });
  (await import("./spawn.ts")).forget(w.domain, w.workspace);
  out(`removed ${w.domain}/${w.workspace}. Its branches and worktrees stay in the domain's clones.`);
};

/** A command, or an agent, in a workspace. stdin, stdout, stderr and the exit code pass
 *  through. */
export const exec = async (target: string | undefined, command: string[], options: { checkout?: string; vm?: boolean }): Promise<number> => {
  const w = await find(target);
  if (command.length === 0) refuse("exec needs a command", "desolate exec <domain>/<workspace> -- <command> [args...]", EXIT.usage);
  const checkout = options.checkout ? w.checkouts.find((c) => c.repo === options.checkout) : w.checkouts[0];
  if (!checkout) refuse(`${options.checkout} is not checked out in ${w.domain}/${w.workspace}`, `it has: ${w.checkouts.map((c) => c.repo).join(", ")}`);
  const b = backend();
  // (Not asked first whether the VM runs: that is a round trip on every exec. A stopped VM's
  // exec fails at once, and is said as such below.)
  // In the project's devcontainer when the workspace has one that is up, else in the VM
  // itself (enter.sh decides, inside the VM); --vm asks for the VM itself.
  const child = b.spawn(w.vm, ["bash", `${guest.release}/workspace/enter.sh`, ...(options.vm ? ["--vm"] : []), checkout!.path, "--", ...command]);
  process.stdin.pipe(child.stdin!);
  child.stdin!.on("error", () => {});
  // To a terminal (a person running an agent by hand): kept to what a screen needs
  // (shared/terminal-filter.ts). To a pipe or a file (a script): unchanged.
  const shown = terminalFilter();
  if (process.stdout.isTTY) child.stdout!.on("data", (chunk: Buffer) => process.stdout.write(shown(chunk)));
  else child.stdout!.pipe(process.stdout);
  if (process.stderr.isTTY) {
    const filter = terminalFilter();
    child.stderr!.on("data", (chunk: Buffer) => process.stderr.write(filter(chunk)));
  } else child.stderr!.pipe(process.stderr);
  let lima = "";
  child.stderr!.on("data", (chunk: Buffer) => { if (lima.length < 2000) lima += chunk.toString("utf8"); });
  const code = await new Promise<number>((resolve) => child.on("close", (status) => resolve(status ?? 1)));
  if (code !== 0 && /instance .* is stopped|is not running/i.test(lima)) process.stderr.write(`desolate: ${w.domain}/${w.workspace} is not running\n  fix: desolate start ${w.domain}/${w.workspace}\n`);
  // A full-screen program's modes, off again: the terminal is your shell's.
  if (process.stdout.isTTY) process.stdout.write(shown.reset());
  process.stdin.unpipe();
  process.stdin.pause();
  return code;
};
