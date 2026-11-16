// T2 (fake backend). A workspace starting and closing workspaces in its own domain
// (desolate spawn / close, inside one): asked from inside, checked by the root, signed by the
// workspace, run by the host only once it has checked that signature (shared/spawn.ts).
//
// The boundary claim: the root's ordinary user, which parses every domain's data, cannot make
// the host start a workspace or run a command in one. A request it queues itself, without
// the asking workspace's key, is refused; the same request signed by the workspace (the
// control) is run.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { bootstrap, git, newStack } from "../lib/harness.ts";
import type { Stack } from "../lib/harness.ts";

let stack: Stack;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** A command in a workspace VM, as its agent would run it. */
const inside = (workspace: string, script: string) => stack.desolate("exec", `dev/${workspace}`, "--vm", "--", "bash", "-c", script);
type Listed = { domain: string; workspaces: { workspace: string; status: string; startedBy: string | null; outlived: boolean }[] }[];
const listed = () => (JSON.parse(stack.desolate("list", "dev", "--json").stdout || "[]") as Listed)[0]?.workspaces ?? [];
const until = async (probe: () => boolean, ms: number) => {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await sleep(500)) if (probe()) return true;
  return false;
};
type Event = { type: string; workspace?: string; startedBy?: string | null; request?: string; ok?: boolean; said?: string; parent?: string };
const events = (workspace = "w1"): Event[] => inside(workspace, "desolate events --all").stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Event);

describe("T2 workspaces that start workspaces, in their own domain only", () => {
  before(() => {
    stack = newStack("spawn");
    stack.seed("acme/widgets", (dir) => {
      fs.writeFileSync(path.join(dir, "README.md"), "# widgets\n");
      git(dir, "add", "-A");
      git(dir, "commit", "--quiet", "-m", "seed");
    });
    assert.equal(bootstrap(stack).code, 0);
    assert.equal(stack.quiet("clone", "acme/widgets", "--no-domain").code, 0);
    assert.equal(stack.quiet("domain", "create", "dev", "--repo", "acme/widgets").code, 0);
    const up = stack.quiet("up", "dev", "--name", "w1", "--branch", "task/one");
    assert.equal(up.code, 0, up.stderr);
  });
  after(() => stack.destroy());

  it("until the person allows it, a workspace starts none", () => {
    const asked = inside("w1", "desolate spawn --name helper");
    assert.equal(asked.code, 1);
    assert.match(asked.stderr, /cannot start workspaces/);
    assert.match(asked.stderr, /desolate domain dev spawn --max <n>/);
    assert.match(inside("w1", "desolate domain stats").stdout, /its workspaces cannot start workspaces/);
    const allowed = stack.desolate("domain", "dev", "spawn", "--max", "1");
    assert.equal(allowed.code, 0, allowed.stderr);
    assert.match(allowed.stdout, /may start up to 1 workspace/);
  });

  it("a workspace starts one, with its command as the agent; it is labelled, in the stats and the events", async () => {
    // The task's words reach the agent as words: quotes, `$(...)` and a leading dash included.
    const asked = inside("w1", `desolate spawn --name helper --branch task/helper -- bash -c 'echo "task: $1"; sleep 600' _ 'tidy up; $(id) --help'`);
    assert.equal(asked.code, 0, asked.stderr);
    assert.match(asked.stdout, /asked for dev\/helper/);
    assert.ok(await until(() => listed().some((w) => w.workspace === "helper" && w.status === "running"), 240_000), JSON.stringify(listed()));
    const helper = listed().find((w) => w.workspace === "helper")!;
    assert.equal(helper.startedBy, "w1");
    assert.equal(listed().find((w) => w.workspace === "w1")!.startedBy, null);
    assert.match(stack.desolate("list", "dev").stdout, /dev\/helper .* started by w1\n/);
    assert.match(stack.desolate("list", "dev").stdout, /dev\/w1 .* started by you\n/);
    let log = "";
    assert.ok(await until(() => /task: tidy up; \$\(id\) --help/.test((log = stack.desolate("agent", "log", "dev/helper").stdout)), 30_000), log);
    // What the workspace that asked can see.
    const stats = inside("w1", "desolate domain stats").stdout;
    assert.match(stats, /started by workspaces: 1 of at most 1/);
    assert.match(stats, /helper {2}running .* started by w1/);
    assert.ok(await until(() => events().some((e) => e.type === "request" && e.request === "spawn" && e.ok === true && e.workspace === "helper"), 30_000));
    assert.ok(events().some((e) => e.type === "workspace-made" && e.workspace === "helper" && e.startedBy === "w1"));
  });

  it("the limit holds: a second one is refused at once", () => {
    const asked = inside("w1", "desolate spawn --name second");
    assert.equal(asked.code, 1);
    assert.match(asked.stderr, /its limit of 1/);
  });

  it("the root's ordinary user cannot make one: a request without the workspace's key is refused by the host", async () => {
    // As the root's ordinary user would, if a domain's data had taken it over: straight into
    // the queue the host is handed, for a workspace of the domain, with a signature of its own.
    stack.desolate("domain", "dev", "spawn", "--max", "3");
    const forged = { kind: "workspace.spawn", at: Date.now(), args: { domain: "dev", workspace: "forged", parent: "w1", branch: "", command: JSON.stringify(["bash", "-c", "echo pwned"]), at: new Date().toISOString(), nonce: "0f".repeat(16), mac: "ab".repeat(32) } };
    const put = stack.inRoot(["bash", "-c", 'mkdir -p /var/lib/desolate/host-queue && cat > /var/lib/desolate/host-queue/zz1-0123456789.json'], { input: JSON.stringify(forged) });
    assert.equal(put.code, 0, put.stderr);
    assert.ok(await until(() => events().some((e) => e.type === "request" && e.workspace === "forged"), 30_000));
    const said = events().find((e) => e.type === "request" && e.workspace === "forged")!;
    assert.equal(said.ok, false);
    assert.match(String(said.said), /not signed by dev\/w1/);
    await sleep(3000);
    assert.ok(!listed().some((w) => w.workspace === "forged"), "nothing was made");
    stack.desolate("domain", "dev", "spawn", "--max", "1");
  });

  it("a workspace closes one it started only when nothing in it would be lost, and never one it did not start", async () => {
    // Not its own to close: the person started w1.
    const notMine = inside("helper", "desolate close w1");
    assert.equal(notMine.code, 1);
    assert.match(notMine.stderr, /was not started by helper/);
    // Uncommitted work in it: refused, and said why.
    assert.equal(inside("helper", "cd /workspaces/acme/widgets/.worktrees/task-helper && echo draft > notes.txt").code, 0);
    assert.equal(inside("w1", "desolate close helper").code, 0, "the root takes the request");
    assert.ok(await until(() => events().some((e) => e.type === "request" && e.request === "close" && e.ok === false), 120_000));
    assert.match(String(events().find((e) => e.request === "close" && e.ok === false)!.said), /uncommitted changes or untracked files in \/workspaces\/acme\/widgets\/\.worktrees\/task-helper/);
    assert.ok(listed().some((w) => w.workspace === "helper"), "still there");
    // Committed: it goes, and its branch stays.
    assert.equal(inside("helper", "cd /workspaces/acme/widgets/.worktrees/task-helper && git add -A && git commit -qm notes").code, 0);
    assert.equal(inside("w1", "desolate close helper").code, 0);
    assert.ok(await until(() => !listed().some((w) => w.workspace === "helper"), 120_000), JSON.stringify(listed()));
    assert.ok(events().some((e) => e.type === "workspace-removed" && e.workspace === "helper" && e.startedBy === "w1"));
    assert.match(stack.desolate("branches", "dev").stdout, /task\/helper/, "its branch is the domain's still");
  });
});
