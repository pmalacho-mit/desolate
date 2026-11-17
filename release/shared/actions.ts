// What the dashboard can ask the host to do (section 4.8): a fixed list. The root's state
// service uses it to refuse anything else at once and to show the command; the host's
// daemon uses it AGAIN, on the request it collects, to build the command it runs. The host
// never runs a command line the root VM wrote.
import { isSlug, parseRepo } from "./names.ts";
import { parseSigned } from "./spawn.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Invoke, Table } from "../../suede.nests/dsl.import.meta.vitest.ts";

type Args = Record<string, string | undefined>;
export const HOST_ACTIONS: Record<string, (a: Args) => string[] | null> = {
  "workspace.start": (a) => (isSlug(a.domain) && isSlug(a.workspace) ? ["start", `${a.domain}/${a.workspace}`] : null),
  "workspace.stop": (a) => (isSlug(a.domain) && isSlug(a.workspace) ? ["stop", `${a.domain}/${a.workspace}`] : null),
  "workspace.up": (a) => (isSlug(a.domain) && (a.workspace === undefined || a.workspace === "" || isSlug(a.workspace)) ? ["up", a.domain, ...(a.workspace ? ["--name", a.workspace] : [])] : null),
  "repo.fetch": (a) => (a.repo !== undefined && parseRepo(a.repo) ? ["fetch", a.repo] : null),
  "domain.create": (a) => (isSlug(a.domain) ? ["domain", "create", a.domain, ...(a.title && /^[\x20-\x7e]{1,80}$/.test(a.title) && !a.title.startsWith("-") ? ["--title", a.title] : [])] : null),
  "domain.add": (a) => (isSlug(a.domain) && a.repo !== undefined && parseRepo(a.repo) ? ["domain", a.domain, "add", "--repo", a.repo] : null),
  // A workspace's own requests (shared/spawn.ts), queued by the root, never by a click: the
  // host's daemon runs one only after checking its signature against the asking
  // workspace's key (host/spawn.ts). The command is argv after `--`, never read by a shell.
  "workspace.spawn": (a) => {
    const r = signedOf("spawn", a);
    return r && r.op === "spawn" ? ["up", r.domain, "--name", r.name, "--started-by", r.parent, ...r.checkouts.flatMap((c) => ["--checkout", c]), ...(r.branch ? ["--branch", r.branch] : []), "--", ...r.command] : null;
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
  return parseSigned({ op, domain: a.domain, parent: a.parent, name: a.workspace, branch: a.branch, checkouts, command, at: a.at, nonce: a.nonce, mac: a.mac });
};
export const hostArgv = (kind: unknown, args: unknown): string[] | null => {
  if (typeof kind !== "string" || !Object.hasOwn(HOST_ACTIONS, kind) || typeof args !== "object" || args === null) return null;
  const clean: Args = {};
  // (A spawn's command and checkouts are the long arguments: JSON, bounded by shared/spawn.ts.)
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) if (typeof value === "string" && value.length <= (key === "command" ? 200_000 : key === "checkouts" ? 8_000 : 200)) clean[key] = value;
  return HOST_ACTIONS[kind]!(clean);
};

declare namespace hostArgv {
  /** each kind the dashboard may ask for becomes one fixed `desolate` command line */
  export type Kinds = Table<typeof hostArgv, [
    [args: [kind: "workspace.start", args: { domain: "dev"; workspace: "w1" }], expected: ["start", "dev/w1"]],
    [args: [kind: "workspace.stop", args: { domain: "dev"; workspace: "w1" }], expected: ["stop", "dev/w1"]],
    [args: [kind: "workspace.up", args: { domain: "dev" }], expected: ["up", "dev"]],
    [args: [kind: "workspace.up", args: { domain: "dev"; workspace: "issue-12" }], expected: ["up", "dev", "--name", "issue-12"]],
    [args: [kind: "repo.fetch", args: { repo: "acme/widgets" }], expected: ["fetch", "acme/widgets"]],
    [args: [kind: "domain.create", args: { domain: "dev"; title: "widgets work" }], expected: ["domain", "create", "dev", "--title", "widgets work"]],
    [args: [kind: "domain.add", args: { domain: "dev"; repo: "acme/widgets" }], expected: ["domain", "dev", "add", "--repo", "acme/widgets"]],
  ]>;
  /** nothing else: a kind not on the list (an object's own keys included), a name that is not
   *  a slug or a repository, anything that would read as an option, an argument that is not a
   *  string */
  export type Refuses = Table<typeof hostArgv, [
    [args: [kind: "workspace.rm", args: { domain: "dev"; workspace: "w1" }], expected: null],
    [args: [kind: "__proto__", args: {}], expected: null],
    [args: [kind: "constructor", args: {}], expected: null],
    [args: [kind: "workspace.start", args: { domain: "dev" }], expected: null],
    [args: [kind: "workspace.start", args: { domain: "dev"; workspace: "../x" }], expected: null],
    [args: [kind: "workspace.start", args: { domain: "--all"; workspace: "w1" }], expected: null],
    [args: [kind: "workspace.up", args: { domain: "dev"; workspace: "--fetch" }], expected: null],
    [args: [kind: "workspace.up", args: { domain: "dev; rm -rf ~" }], expected: null],
    [args: [kind: "repo.fetch", args: { repo: "--upload-pack=x" }], expected: null],
    [args: [kind: "domain.add", args: { domain: "dev"; repo: "acme/widgets/../x" }], expected: null],
    [args: [kind: "workspace.start", args: { domain: ["dev"]; workspace: "w1" }], expected: null],
    [args: [kind: "workspace.start", args: null], expected: null],
    [args: [kind: 7, args: {}], expected: null],
  ]>;
  /** a title is a label: one that looks like an option or holds a control is left out, and
   *  the domain is made without it */
  export type Title = Table<typeof hostArgv, [
    [args: [kind: "domain.create", args: { domain: "dev"; title: "--help" }], expected: ["domain", "create", "dev"]],
    [args: [kind: "domain.create", args: { domain: "dev"; title: "a\u001b[2Jb" }], expected: ["domain", "create", "dev"]],
  ]>;
  /** a workspace's signed spawn: `up` with the command after `--`, each word one argv
   *  element, so a shell's syntax in a word is that word's text */
  export type Spawn = Expect<
    Invoke<typeof hostArgv, [kind: "workspace.spawn", args: { domain: "acme"; workspace: "helper"; parent: "w1"; branch: "issue/9"; checkouts: '["acme/api=main"]'; command: '["claude","-p","fix it; $(rm -rf ~)"]'; at: "2026-11-16T00:00:00.000Z"; nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f"; mac: "abababababababababababababababababababababababababababababababab" }]>,
    "=",
    ["up", "acme", "--name", "helper", "--started-by", "w1", "--checkout", "acme/api=main", "--branch", "issue/9", "--", "claude", "-p", "fix it; $(rm -rf ~)"]
  >;
  /** a close removes only a clean workspace */
  export type Close = Expect<
    Invoke<typeof hostArgv, [kind: "workspace.close", args: { domain: "acme"; workspace: "helper"; parent: "w1"; at: "2026-11-16T00:00:00.000Z"; nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f"; mac: "abababababababababababababababababababababababababababababababab" }]>,
    "=",
    ["rm", "acme/helper", "--if-clean"]
  >;
  /** a spawn whose command is not JSON, or is a shell line rather than words, or that names
   *  itself as its parent: nothing */
  export type BadSpawn = Table<typeof hostArgv, [
    [args: [kind: "workspace.spawn", args: { domain: "acme"; workspace: "helper"; parent: "w1"; command: "claude -p hi"; at: "2026-11-16T00:00:00.000Z"; nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f"; mac: "abababababababababababababababababababababababababababababababab" }], expected: null],
    [args: [kind: "workspace.spawn", args: { domain: "acme"; workspace: "helper"; parent: "w1"; command: '"claude -p hi"'; at: "2026-11-16T00:00:00.000Z"; nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f"; mac: "abababababababababababababababababababababababababababababababab" }], expected: null],
    [args: [kind: "workspace.spawn", args: { domain: "acme"; workspace: "w1"; parent: "w1"; command: '["claude"]'; at: "2026-11-16T00:00:00.000Z"; nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f"; mac: "abababababababababababababababababababababababababababababababab" }], expected: null],
  ]>;
}
