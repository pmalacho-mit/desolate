// The host's side of a workspace starting, and closing, workspaces in its own domain
// (shared/spawn.ts says why the host, not the root, vouches for one).
//
// Kept in the host's own state (~/.desolate/state), which no VM is shown:
//   workspace-keys/<vm>   each workspace VM's key: made here, written onto that VM's own disk
//   spawn.json            each domain's limit, as the person set it here; and which workspace
//                         started which, as this host started them
// The root has a copy of each limit, to answer a workspace early and to show it; this one is
// the one that holds.
import { randomBytes } from "node:crypto";
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
type Ledger = { max: Record<string, number>; started: Record<string, { parent: string; at: string }> };
const ledger = (): Ledger => {
  const value = readJson<Partial<Ledger>>(LEDGER(), {});
  return { max: value.max ?? {}, started: value.started ?? {} };
};
const save = (value: Ledger) => writeJson(LEDGER(), value, 0o600);

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

export const maxFor = (domain: string) => ledger().max[domain] ?? 0;
export const setMax = (domain: string, max: number) => {
  const value = ledger();
  if (max > 0) value.max[domain] = max;
  else delete value.max[domain];
  save(value);
};
export const recordStarted = (domain: string, workspace: string, parent: string) => {
  const value = ledger();
  value.started[`${domain}/${workspace}`] = { parent, at: new Date().toISOString() };
  save(value);
};
export const parentOf = (domain: string, workspace: string): string | null => ledger().started[`${domain}/${workspace}`]?.parent ?? null;
/** The workspaces of a domain a workspace started that still exist (as VMs this host has). */
export const startedIn = (domain: string, exists: (vm: string) => boolean) =>
  Object.keys(ledger().started).filter((key) => key.startsWith(`${domain}/`) && exists(workspaceVmName(INSTANCE, domain, key.slice(domain.length + 1))));

const used = new Map<string, number>();
/** Whether the host runs this request: the signature, freshness and once only, then the
 *  domain's limit (spawn) or the parent (close). Returns why not, or null. */
export const check = (r: Signed & { mac: string }, exists: (vm: string) => boolean, now = Date.now()): string | null => {
  if (!isSlug(r.domain) || !isSlug(r.parent) || !isSlug(r.name)) return "not a request desolate makes";
  const why = verify(keyOf(workspaceVmName(INSTANCE, r.domain, r.parent)), r, now);
  if (why) return why;
  if (used.has(r.mac)) return "that request was already run";
  for (const [mac, at] of used) if (now - at > 30 * 60_000) used.delete(mac);
  if (r.op === "spawn") {
    const max = maxFor(r.domain);
    if (max === 0) return `${r.domain} does not let its workspaces start workspaces (on the Mac: desolate domain ${r.domain} spawn --max <n>)`;
    const live = startedIn(r.domain, exists).length;
    if (live >= max) return `${r.domain} already has ${live} workspace(s) started by its workspaces, its limit (desolate domain ${r.domain} spawn --max <n>)`;
  } else {
    const parent = parentOf(r.domain, r.name);
    if (parent !== r.parent) return `${r.domain}/${r.name} was not started by ${r.parent}${parent ? "" : " (a person started it: only a person removes it)"}`;
  }
  used.set(r.mac, now);
  return null;
};
