// What the dashboard can ask the host to do (section 4.8): a fixed list. The root's state
// service uses it to refuse anything else at once and to show the command; the host's
// daemon uses it AGAIN, on the request it collects, to build the command it runs. The host
// never runs a command line the root VM wrote.
import { isSlug, parseRepo } from "./names.ts";
import { parseSigned } from "./spawn.ts";

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
