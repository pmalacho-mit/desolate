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
import { FRESH_MS, IDENTITY_FILE, KEY, verify } from "../shared/spawn.ts";
import type { Signed } from "../shared/spawn.ts";
import { because } from "./failures.ts";
import { INSTANCE, paths } from "./paths.ts";
import type { Backend } from "./vm/types.ts";
import type { Expect, Given, Invoke } from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { emptyHome, readState, writeState } from "../.harness/home.ts";
import type { everyVmExists, giveKey, noVmExists, signed } from "../.harness/host-spawn.ts";

const KEYS = () => path.join(paths.state, "workspace-keys");
const LEDGER = () => path.join(paths.state, "spawn.json");
/** `used`: each request run, by its signature, until it could no longer be fresh: kept on
 *  disk, so a restart of the daemon is not a way to run one twice (audit, 2026-11-16).
 *  `started[...].parentKey`: a fingerprint of the parent's key when it asked, so a later
 *  workspace that only shares its name cannot close what the first one started. */
type Ledger = {
  max: Record<string, number>;
  started: Record<string, { parent: string; at: string; parentKey?: string }>;
  used: Record<string, number>;
};
const ledger = (): Ledger => {
  const value = readJson<Partial<Ledger>>(LEDGER(), {});
  // (Signatures an older desolate kept in spawn.json still count, once: a request run just
  // before an upgrade is not run again after it.)
  const used = { ...(value.used ?? {}), ...readJson<Record<string, number>>(USED(), {}) };
  // Moved to their own file at once: the next write of spawn.json, by the CLI too, leaves
  // them out (final review).
  if (value.used && Object.keys(value.used).length > 0) {
    saveUsed(used);
    save({ max: value.max ?? {}, started: value.started ?? {}, used });
  }
  return { max: value.max ?? {}, started: value.started ?? {}, used };
};
/** The requests run, in a file of their own that only the daemon writes: spawn.json is also
 *  written by the CLI (a started record, a limit), and one whole-file write must not undo
 *  another's (review of the fixes). */
const USED = () => path.join(paths.state, "spawn-used.json");
const saveUsed = (used: Record<string, number>) => writeJson(USED(), used, 0o600);
const fingerprint = (key: string | null) =>
  key ? createHash("sha256").update(key).digest("hex").slice(0, 16) : null;
const save = (value: Ledger) =>
  writeJson(LEDGER(), { max: value.max, started: value.started }, 0o600);

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
  const put = await b.exec(
    vm,
    ["bash", "-c", 'umask 022 && cat >"$1.new" && mv -f "$1.new" "$1"', "_", IDENTITY_FILE],
    { root: true, input: key, timeoutMs: 60_000 },
  );
  if (put.code !== 0)
    throw new Error(
      because("the workspace's key could not be written into it", "workspace-key", put.stderr),
    );
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
declare namespace setMax {
  /** no limit unless a person sets one; a number, 0 (off) included, until it is cleared */
  export type Limits = Given<
    Invoke<typeof emptyHome>,
    [
      Expect<Invoke<typeof maxFor, [domain: "acme"]>, "=", null>,
      Given<
        Invoke<typeof setMax, [domain: "acme", max: 0]>,
        Expect<Invoke<typeof maxFor, [domain: "acme"]>, "=", 0>
      >,
      Given<
        Invoke<typeof setMax, [domain: "acme", max: 2]>,
        Expect<Invoke<typeof maxFor, [domain: "acme"]>, "=", 2>
      >,
      Given<
        Invoke<typeof setMax, [domain: "acme", max: null]>,
        Expect<Invoke<typeof maxFor, [domain: "acme"]>, "=", null>
      >,
    ]
  >;
}

export const recordStarted = (domain: string, workspace: string, parent: string) => {
  const value = ledger();
  const parentKey = fingerprint(keyOf(workspaceVmName(INSTANCE, domain, parent)));
  value.started[`${domain}/${workspace}`] = {
    parent,
    at: new Date().toISOString(),
    ...(parentKey ? { parentKey } : {}),
  };
  save(value);
};
declare namespace recordStarted {
  /** who started a workspace is kept, and it goes when the workspace is removed */
  export type UntilForgotten = Given<
    [
      Invoke<typeof emptyHome>,
      Invoke<typeof recordStarted, [domain: "acme", workspace: "helper", parent: "lead"]>,
    ],
    [
      Expect<Invoke<typeof parentOf, [domain: "acme", workspace: "helper"]>, "=", "lead">,
      Expect<
        Invoke<typeof startedIn, [domain: "acme", exists: typeof everyVmExists]>,
        "=",
        ["acme/helper"]
      >,
      /** one whose VM is gone is not counted */
      Expect<Invoke<typeof startedIn, [domain: "acme", exists: typeof noVmExists]>, "=", []>,
      Given<
        Invoke<typeof forget, [domain: "acme", workspace: "helper"]>,
        Expect<Invoke<typeof parentOf, [domain: "acme", workspace: "helper"]>, "=", null>
      >,
    ]
  >;
}

/** Spawns run now, per domain: at most three at once, whatever the limit (a flood of signed
 *  requests started thirty VMs a minute: audit). Counted from the check to the end of up.
 *  A hard bound (R7) on requests from a domain's workspaces, a side not trusted: what it
 *  bounds is how fast they can make this Mac start VMs, and three at once is a pace no
 *  person's own work needs more of (a spawn takes a minute or more). */
const running = new Map<string, number>();
export const MOST_AT_ONCE = 3;
export const begin = (domain: string) => running.set(domain, (running.get(domain) ?? 0) + 1);
/** Spawns under way now, every domain's. */
export const underWay = () => [...running.values()].reduce((a, b) => a + b, 0);
export const end = (domain: string) =>
  running.set(domain, Math.max(0, (running.get(domain) ?? 1) - 1));
declare namespace end {
  /** spawns under way, every domain's; an end with none under way leaves none, not fewer */
  export type Counts = Given<
    [
      Invoke<typeof begin, [domain: "acme"]>,
      Invoke<typeof begin, [domain: "acme"]>,
      Invoke<typeof begin, [domain: "beta"]>,
      Invoke<typeof end, [domain: "beta"]>,
      Invoke<typeof end, [domain: "beta"]>,
    ],
    Expect<Invoke<typeof underWay>, "=", 2>
  >;
}
export const parentOf = (domain: string, workspace: string): string | null =>
  ledger().started[`${domain}/${workspace}`]?.parent ?? null;
/** The workspaces of a domain a workspace started that still exist (as VMs this host has). */
export const startedIn = (domain: string, exists: (vm: string) => boolean) =>
  Object.keys(ledger().started).filter(
    (key) =>
      key.startsWith(`${domain}/`) &&
      exists(workspaceVmName(INSTANCE, domain, key.slice(domain.length + 1))),
  );

/** Whether the host runs this request: the signature, freshness and once only, then the
 *  domain's limit (spawn) or the parent (close). Returns why not, or null. */
export const check = (
  r: Signed & { mac: string },
  exists: (vm: string) => boolean,
  now = Date.now(),
): string | null => {
  if (!isSlug(r.domain) || !isSlug(r.parent) || !isSlug(r.name))
    return "not a request desolate makes";
  const why = verify(keyOf(workspaceVmName(INSTANCE, r.domain, r.parent)), r, now);
  if (why) return why;
  const value = ledger();
  if (value.used[r.mac] !== undefined) return "that request was already run";
  // A request is remembered for as long as `verify` would still take it: FRESH_MS after it
  // was made, with two minutes either way for the VM's clock. Twice FRESH_MS outlives that.
  for (const [mac, at] of Object.entries(value.used))
    if (now - at > 2 * FRESH_MS) delete value.used[mac];
  if (r.op === "spawn") {
    if ((running.get(r.domain) ?? 0) >= MOST_AT_ONCE)
      return `${r.domain} already has ${MOST_AT_ONCE} workspaces being started by its workspaces: ask again once one is up`;
    const max = maxFor(r.domain);
    if (max === 0)
      return `${r.domain} does not let its workspaces start workspaces (on the Mac: desolate domain ${r.domain} spawn --max none)`;
    const live = startedIn(r.domain, exists).length;
    // With those under way, which are not recorded until they are up (third review).
    const counted = live + (running.get(r.domain) ?? 0);
    if (max !== null && counted >= max)
      return `${r.domain} already has ${counted} workspace(s) started (or being started) by its workspaces, its limit (desolate domain ${r.domain} spawn --max <n>)`;
  } else {
    const record = value.started[`${r.domain}/${r.name}`];
    if (record?.parent !== r.parent)
      return `${r.domain}/${r.name} was not started by ${r.parent}${record ? "" : " (a person started it: only a person removes it)"}`;
    if (
      record.parentKey &&
      record.parentKey !== fingerprint(keyOf(workspaceVmName(INSTANCE, r.domain, r.parent)))
    )
      return `${r.domain}/${r.name} was started by an earlier workspace named ${r.parent}, since removed: only a person removes it now`;
  }
  value.used[r.mac] = now;
  saveUsed(value.used);
  // Counted as under way in the same step as the check: a burst of requests, each awaiting
  // something before it was counted, all saw none under way (review of the fixes). The
  // caller ends it (end()) however the spawn ends.
  if (r.op === "spawn") begin(r.domain);
  return null;
};

declare namespace check {
  type Lead = "1111111111111111111111111111111111111111111111111111111111111111";
  /** a key the host gave another workspace, or a later workspace given the same name */
  type Other = "2222222222222222222222222222222222222222222222222222222222222222";
  type Spawn = {
    op: "spawn";
    domain: "acme";
    parent: "lead";
    name: "helper";
    branch: "task/docs";
    checkouts: [];
    command: ["claude", "-p", "fix the docs"];
    at: "2026-11-16T10:00:00.000Z";
    nonce: "00000000000000000000000000000001";
  };
  type Close = {
    op: "close";
    domain: "acme";
    parent: "lead";
    name: "helper";
    at: "2026-11-16T10:00:00.000Z";
    nonce: "00000000000000000000000000000002";
  };
  /** the same request, said to come from a workspace the host never gave a key */
  type ForOther = {
    op: "spawn";
    domain: "acme";
    parent: "other";
    name: "helper";
    branch: "task/docs";
    checkouts: [];
    command: ["claude", "-p", "fix the docs"];
    at: "2026-11-16T10:00:00.000Z";
    nonce: "00000000000000000000000000000001";
  };
  /** names that would become a path or a VM label */
  type OutOfItsDomain = {
    op: "spawn";
    domain: "../acme";
    parent: "lead";
    name: "helper";
    branch: "task/docs";
    checkouts: [];
    command: ["claude", "-p", "fix the docs"];
    at: "2026-11-16T10:00:00.000Z";
    nonce: "00000000000000000000000000000001";
  };
  type Capitals = {
    op: "spawn";
    domain: "acme";
    parent: "lead";
    name: "Helper";
    branch: "task/docs";
    checkouts: [];
    command: ["claude", "-p", "fix the docs"];
    at: "2026-11-16T10:00:00.000Z";
    nonce: "00000000000000000000000000000001";
  };
  /** three more requests, each its own (a nonce of its own) */
  type SecondOne = {
    op: "spawn";
    domain: "acme";
    parent: "lead";
    name: "helper";
    branch: "task/docs";
    checkouts: [];
    command: ["claude", "-p", "fix the docs"];
    at: "2026-11-16T10:00:00.000Z";
    nonce: "0000000000000000000000000000000a";
  };
  type ThirdOne = {
    op: "spawn";
    domain: "acme";
    parent: "lead";
    name: "helper";
    branch: "task/docs";
    checkouts: [];
    command: ["claude", "-p", "fix the docs"];
    at: "2026-11-16T10:00:00.000Z";
    nonce: "0000000000000000000000000000000b";
  };
  type FourthOne = {
    op: "spawn";
    domain: "acme";
    parent: "lead";
    name: "helper";
    branch: "task/docs";
    checkouts: [];
    command: ["claude", "-p", "fix the docs"];
    at: "2026-11-16T10:00:00.000Z";
    nonce: "0000000000000000000000000000000c";
  };
  /** a minute after the request was made */
  type Now = 1794823260000;
  type Empty = Invoke<typeof emptyHome>;
  type LeadsKey = Invoke<typeof giveKey, [domain: "acme", workspace: "lead", key: Lead]>;
  type Keyed = [Empty, LeadsKey];

  /** signed with the parent's own key, fresh: run, and never again (the signature is kept on
   *  disk, so restarting the daemon does not make it new) */
  export type RunsOnce = Given<
    Keyed,
    [
      Expect<
        Invoke<
          typeof check,
          [
            r: Invoke<typeof signed, [key: Lead, request: Spawn]>,
            exists: typeof noVmExists,
            now: Now,
          ]
        >,
        "=",
        null
      >,
      Expect<
        Invoke<
          typeof check,
          [
            r: Invoke<typeof signed, [key: Lead, request: Spawn]>,
            exists: typeof noVmExists,
            now: Now,
          ]
        >,
        "=",
        "that request was already run"
      >,
    ]
  >;
  /** what only the parent could have signed, and only lately */
  export type Refuses = Given<
    Keyed,
    [
      Expect<
        Invoke<
          typeof check,
          [
            r: Invoke<typeof signed, [key: Other, request: Spawn]>,
            exists: typeof noVmExists,
            now: Now,
          ]
        >,
        "=",
        "the request is not signed by acme/lead"
      >,
      Expect<
        Invoke<
          typeof check,
          [
            r: Invoke<typeof signed, [key: Lead, request: ForOther]>,
            exists: typeof noVmExists,
            now: Now,
          ]
        >,
        "=",
        "the host has no key for acme/other: it was not started by this host, or was removed"
      >,
      /** sixteen minutes old; three minutes ahead of the host's clock */
      Expect<
        Invoke<
          typeof check,
          [
            r: Invoke<typeof signed, [key: Lead, request: Spawn]>,
            exists: typeof noVmExists,
            now: 1794824160000,
          ]
        >,
        "=",
        "the request is too old (or from the future): ask again"
      >,
      Expect<
        Invoke<
          typeof check,
          [
            r: Invoke<typeof signed, [key: Lead, request: Spawn]>,
            exists: typeof noVmExists,
            now: 1794823020000,
          ]
        >,
        "=",
        "the request is too old (or from the future): ask again"
      >,
      /** a name that would become a path or a VM label, signed or not */
      Expect<
        Invoke<
          typeof check,
          [
            r: Invoke<typeof signed, [key: Lead, request: OutOfItsDomain]>,
            exists: typeof noVmExists,
            now: Now,
          ]
        >,
        "=",
        "not a request desolate makes"
      >,
      Expect<
        Invoke<
          typeof check,
          [
            r: Invoke<typeof signed, [key: Lead, request: Capitals]>,
            exists: typeof noVmExists,
            now: Now,
          ]
        >,
        "=",
        "not a request desolate makes"
      >,
    ]
  >;
  /** a request an older desolate ran (it kept them in spawn.json) is not run again after the
   *  upgrade, and spawn.json, which the CLI also writes, no longer holds it */
  export type RanBeforeTheUpgrade = Given<
    [
      Empty,
      LeadsKey,
      Invoke<
        typeof writeState,
        [
          name: "spawn.json",
          text: '{"max":{},"started":{},"used":{"2c83209c4fc7a4f3d1947e14da1b18bc73f6e57935e015a4e353df39e2c42039":1794823200000}}',
        ]
      >,
    ],
    [
      Expect<
        Invoke<
          typeof check,
          [
            r: Invoke<typeof signed, [key: Lead, request: Spawn]>,
            exists: typeof noVmExists,
            now: Now,
          ]
        >,
        "=",
        "that request was already run"
      >,
      Expect<
        Invoke<typeof readState, [name: "spawn.json"]>,
        "=",
        '{\n  "max": {},\n  "started": {}\n}\n'
      >,
    ]
  >;

  /** the person's limit: 0 turns spawning off; at the limit, those still there count */
  export type Off = Given<
    [Empty, LeadsKey, Invoke<typeof setMax, [domain: "acme", max: 0]>],
    Expect<
      Invoke<
        typeof check,
        [r: Invoke<typeof signed, [key: Lead, request: Spawn]>, exists: typeof noVmExists, now: Now]
      >,
      "=",
      "acme does not let its workspaces start workspaces (on the Mac: desolate domain acme spawn --max none)"
    >
  >;
  export type AtTheLimit = Given<
    [
      Empty,
      LeadsKey,
      Invoke<typeof setMax, [domain: "acme", max: 1]>,
      Invoke<typeof recordStarted, [domain: "acme", workspace: "first", parent: "lead"]>,
    ],
    Expect<
      Invoke<
        typeof check,
        [
          r: Invoke<typeof signed, [key: Lead, request: Spawn]>,
          exists: typeof everyVmExists,
          now: Now,
        ]
      >,
      "=",
      "acme already has 1 workspace(s) started (or being started) by its workspaces, its limit (desolate domain acme spawn --max <n>)"
    >
  >;
  /** one that was removed since frees its place */
  export type BelowTheLimit = Given<
    [
      Empty,
      LeadsKey,
      Invoke<typeof setMax, [domain: "acme", max: 1]>,
      Invoke<typeof recordStarted, [domain: "acme", workspace: "first", parent: "lead"]>,
    ],
    Expect<
      Invoke<
        typeof check,
        [r: Invoke<typeof signed, [key: Lead, request: Spawn]>, exists: typeof noVmExists, now: Now]
      >,
      "=",
      null
    >
  >;
  /** with no limit, still three at once per domain: a burst of signed requests waits */
  export type ThreeAtOnce = Given<
    [
      Empty,
      LeadsKey,
      Invoke<
        typeof check,
        [
          r: Invoke<typeof signed, [key: Lead, request: SecondOne]>,
          exists: typeof noVmExists,
          now: Now,
        ]
      >,
      Invoke<
        typeof check,
        [
          r: Invoke<typeof signed, [key: Lead, request: ThirdOne]>,
          exists: typeof noVmExists,
          now: Now,
        ]
      >,
      Invoke<
        typeof check,
        [
          r: Invoke<typeof signed, [key: Lead, request: FourthOne]>,
          exists: typeof noVmExists,
          now: Now,
        ]
      >,
    ],
    Expect<
      Invoke<
        typeof check,
        [r: Invoke<typeof signed, [key: Lead, request: Spawn]>, exists: typeof noVmExists, now: Now]
      >,
      "=",
      "acme already has 3 workspaces being started by its workspaces: ask again once one is up"
    >
  >;

  /** a workspace closes only what it started; what a person started, only a person removes */
  export type ClosesItsOwn = Given<
    [
      Empty,
      LeadsKey,
      Invoke<typeof recordStarted, [domain: "acme", workspace: "helper", parent: "lead"]>,
    ],
    Expect<
      Invoke<
        typeof check,
        [
          r: Invoke<typeof signed, [key: Lead, request: Close]>,
          exists: typeof everyVmExists,
          now: Now,
        ]
      >,
      "=",
      null
    >
  >;
  export type NotItsOwn = Given<
    Keyed,
    Expect<
      Invoke<
        typeof check,
        [
          r: Invoke<typeof signed, [key: Lead, request: Close]>,
          exists: typeof everyVmExists,
          now: Now,
        ]
      >,
      "=",
      "acme/helper was not started by lead (a person started it: only a person removes it)"
    >
  >;
  /** a later workspace that only shares the parent's name (its key is another) closes nothing */
  export type AnEarlierNamesake = Given<
    [
      Empty,
      LeadsKey,
      Invoke<typeof recordStarted, [domain: "acme", workspace: "helper", parent: "lead"]>,
      Invoke<typeof giveKey, [domain: "acme", workspace: "lead", key: Other]>,
    ],
    Expect<
      Invoke<
        typeof check,
        [
          r: Invoke<typeof signed, [key: Other, request: Close]>,
          exists: typeof everyVmExists,
          now: Now,
        ]
      >,
      "=",
      "acme/helper was started by an earlier workspace named lead, since removed: only a person removes it now"
    >
  >;
}
