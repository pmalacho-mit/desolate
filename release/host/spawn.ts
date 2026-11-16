// The host's side of a workspace starting, and closing, workspaces in its own domain
// (shared/spawn.ts says why the host, not the root, vouches for one).
//
// Kept in the host's own state (~/.desolate/state), which no VM is shown:
//   workspace-keys/<vm>   each workspace VM's key: made here, written onto that VM's own disk
//   spawn.json            each domain's limit, if the person set one (none: no limit); which workspace
//                         started which, as this host started them
// The root has a copy of each limit, to answer a workspace early and to show it; this one is
// the one that holds.
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { readJson, writeJson } from "../shared/json.ts";
import { isSlug, workspaceVmName } from "../shared/names.ts";
import { IDENTITY_FILE, KEY, verify } from "../shared/spawn.ts";
import type { Signed } from "../shared/spawn.ts";
import { INSTANCE, paths } from "./paths.ts";
import type { Backend } from "./vm/types.ts";

const KEYS = () => path.join(paths.state, "workspace-keys");
const LEDGER = () => path.join(paths.state, "spawn.json");
/** `used`: each request run, by its signature, until it could no longer be fresh: kept on
 *  disk, so a restart of the daemon is not a way to run one twice (audit, 2026-11-16).
 *  `started[...].parentKey`: a fingerprint of the parent's key when it asked, so a later
 *  workspace that only shares its name cannot close what the first one started. */
type Ledger = { max: Record<string, number>; started: Record<string, { parent: string; at: string; parentKey?: string }>; used: Record<string, number> };
const ledger = (): Ledger => {
  const value = readJson<Partial<Ledger>>(LEDGER(), {});
  return { max: value.max ?? {}, started: value.started ?? {}, used: readJson<Record<string, number>>(USED(), {}) };
};
/** The requests run, in a file of their own that only the daemon writes: spawn.json is also
 *  written by the CLI (a started record, a limit), and one whole-file write must not undo
 *  another's (review of the fixes). */
const USED = () => path.join(paths.state, "spawn-used.json");
const saveUsed = (used: Record<string, number>) => writeJson(USED(), used, 0o600);
const fingerprint = (key: string | null) => (key ? createHash("sha256").update(key).digest("hex").slice(0, 16) : null);
const save = (value: Ledger) => writeJson(LEDGER(), { max: value.max, started: value.started }, 0o600);

export const keyOf = (vm: string): string | null => {
  try {
    const key = fs.readFileSync(path.join(KEYS(), vm), "utf8").trim();
    return KEY.test(key) ? key : null;
  } catch {
    return null;
  }
};

/** The VM's key, onto its own disk (/run/desolate, which its devcontainer binds): at every
 *  start, since /run is gone when the VM stops. One key per VM, for as long as it exists. */
export const giveIdentity = async (b: Backend, vm: string) => {
  let key = keyOf(vm);
  if (!key) {
    key = randomBytes(32).toString("hex");
    fs.mkdirSync(KEYS(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(KEYS(), vm), `${key}\n`, { mode: 0o600 });
  }
  const put = await b.exec(vm, ["bash", "-c", 'umask 022 && cat >"$1.new" && mv -f "$1.new" "$1"', "_", IDENTITY_FILE], { root: true, input: key, timeoutMs: 60_000 });
  if (put.code !== 0) throw new Error(`the workspace's key could not be written into it: ${put.stderr.trim().slice(-300)}`);
};

/** A removed workspace's key and its place in the record go with it. */
export const forget = (domain: string, workspace: string) => {
  fs.rmSync(path.join(KEYS(), workspaceVmName(INSTANCE, domain, workspace)), { force: true });
  const value = ledger();
  if (value.started[`${domain}/${workspace}`]) {
    delete value.started[`${domain}/${workspace}`];
    save(value);
  }
};

/** How many workspaces a domain's workspaces may have started at once. null: no limit, the
 *  default (a person sets one with desolate domain <d> spawn --max <n>; 0 turns it off). */
export const maxFor = (domain: string): number | null => ledger().max[domain] ?? null;
export const setMax = (domain: string, max: number | null) => {
  const value = ledger();
  if (max === null) delete value.max[domain];
  else value.max[domain] = max;
  save(value);
};
export const recordStarted = (domain: string, workspace: string, parent: string) => {
  const value = ledger();
  const parentKey = fingerprint(keyOf(workspaceVmName(INSTANCE, domain, parent)));
  value.started[`${domain}/${workspace}`] = { parent, at: new Date().toISOString(), ...(parentKey ? { parentKey } : {}) };
  save(value);
};
/** Spawns run now, per domain: at most three at once, whatever the limit (a flood of signed
 *  requests started thirty VMs a minute: audit). Counted from the check to the end of up. */
const running = new Map<string, number>();
export const MOST_AT_ONCE = 3;
export const begin = (domain: string) => running.set(domain, (running.get(domain) ?? 0) + 1);
/** Spawns under way now, every domain's. */
export const underWay = () => [...running.values()].reduce((a, b) => a + b, 0);
export const end = (domain: string) => running.set(domain, Math.max(0, (running.get(domain) ?? 1) - 1));
export const parentOf = (domain: string, workspace: string): string | null => ledger().started[`${domain}/${workspace}`]?.parent ?? null;
/** The workspaces of a domain a workspace started that still exist (as VMs this host has). */
export const startedIn = (domain: string, exists: (vm: string) => boolean) =>
  Object.keys(ledger().started).filter((key) => key.startsWith(`${domain}/`) && exists(workspaceVmName(INSTANCE, domain, key.slice(domain.length + 1))));

/** Whether the host runs this request: the signature, freshness and once only, then the
 *  domain's limit (spawn) or the parent (close). Returns why not, or null. */
export const check = (r: Signed & { mac: string }, exists: (vm: string) => boolean, now = Date.now()): string | null => {
  if (!isSlug(r.domain) || !isSlug(r.parent) || !isSlug(r.name)) return "not a request desolate makes";
  const why = verify(keyOf(workspaceVmName(INSTANCE, r.domain, r.parent)), r, now);
  if (why) return why;
  const value = ledger();
  if (value.used[r.mac] !== undefined) return "that request was already run";
  for (const [mac, at] of Object.entries(value.used)) if (now - at > 30 * 60_000) delete value.used[mac];
  if (r.op === "spawn") {
    if ((running.get(r.domain) ?? 0) >= MOST_AT_ONCE) return `${r.domain} already has ${MOST_AT_ONCE} workspaces being started by its workspaces: ask again once one is up`;
    const max = maxFor(r.domain);
    if (max === 0) return `${r.domain} does not let its workspaces start workspaces (on the Mac: desolate domain ${r.domain} spawn --max none)`;
    const live = startedIn(r.domain, exists).length;
    if (max !== null && live >= max) return `${r.domain} already has ${live} workspace(s) started by its workspaces, its limit (desolate domain ${r.domain} spawn --max <n>)`;
  } else {
    const record = value.started[`${r.domain}/${r.name}`];
    if (record?.parent !== r.parent) return `${r.domain}/${r.name} was not started by ${r.parent}${record ? "" : " (a person started it: only a person removes it)"}`;
    if (record.parentKey && record.parentKey !== fingerprint(keyOf(workspaceVmName(INSTANCE, r.domain, r.parent)))) return `${r.domain}/${r.name} was started by an earlier workspace named ${r.parent}, since removed: only a person removes it now`;
  }
  value.used[r.mac] = now;
  saveUsed(value.used);
  // Counted as under way in the same step as the check: a burst of requests, each awaiting
  // something before it was counted, all saw none under way (review of the fixes). The
  // caller ends it (end()) however the spawn ends.
  if (r.op === "spawn") begin(r.domain);
  return null;
};
