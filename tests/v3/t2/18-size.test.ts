// T2 (fake backend). A workspace's size: what its project asks for (its devcontainer.json:
// `customizations.desolate`, then the spec's `hostRequirements`), under the person's own
// choices and within this Mac; and `desolate resize`, which changes a stopped workspace's
// size in its VM and in the root's record. The fake backend's VM is a container: its size is
// the container's limits, which `docker inspect` reads back. (The real VM's edit is T4's.)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { rootVmName } from "../../../release/shared/names.ts";
import { bootstrap, git, newStack } from "../lib/harness.ts";
import type { Stack } from "../lib/harness.ts";

let stack: Stack;
// An image no one can pull: the devcontainer does not come up, which does not take the
// workspace down (08-devcontainer), and the size is the VM's either way.
const NOWHERE = "desolate.invalid/none:1";
const seedSpec = (repo: string, spec: string) =>
  stack.seed(repo, (dir) => {
    fs.writeFileSync(path.join(dir, ".devcontainer.json"), spec);
    git(dir, "add", "-A");
    git(dir, "commit", "--quiet", "-m", "seed");
  });
type Listed = { domain: string; workspaces: { workspace: string; vm: string; size: unknown }[] }[];
const listed = (target: string) => {
  const [domain, workspace] = target.split("/");
  return (JSON.parse(stack.quiet("list", "--json").stdout) as Listed)
    .find((d) => d.domain === domain)!
    .workspaces.find((w) => w.workspace === workspace)!;
};
/** The fake VM's own limits: what the backend gave it. */
const limits = (vm: string) => {
  const seen = spawnSync(
    "docker",
    ["inspect", "-f", "{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}}", vm],
    { encoding: "utf8" },
  ).stdout.trim();
  const [nano, bytes] = seen.split(" ").map(Number);
  return { cpus: nano! / 1e9, memoryMiB: bytes! / 1048576 };
};

describe("T2: a workspace's size, from its project, and resized", () => {
  before(() => {
    stack = newStack("size");
    // JSON with comments, as devcontainer.json is written.
    seedSpec(
      "acme/sized",
      `{
  "image": "${NOWHERE}",
  // what this project needs: desolate's own, and the spec's
  "customizations": { "desolate": { "cpus": 3, "memory": "5g" } },
  "hostRequirements": { "cpus": 8, "memory": "2gb", "storage": "40gb" }
}
`,
    );
    seedSpec(
      "acme/greedy",
      JSON.stringify({
        image: NOWHERE,
        hostRequirements: { cpus: 64, memory: "256gb" },
        customizations: { desolate: { disk: "lots" } },
      }),
    );
    assert.equal(bootstrap(stack).code, 0);
    for (const repo of ["acme/sized", "acme/greedy"])
      assert.equal(stack.quiet("clone", repo, "--no-domain").code, 0);
    for (const [domain, repo] of [
      ["sized", "acme/sized"],
      ["greedy", "acme/greedy"],
    ] as const) {
      assert.equal(stack.quiet("domain", "create", domain).code, 0);
      assert.equal(stack.quiet("domain", domain, "add", "--repo", repo).code, 0);
    }
  });
  after(() => stack.destroy());

  it("the project's devcontainer.json sizes its workspace: desolate's own customizations first, then hostRequirements", () => {
    stack.step("the project's size");
    const up = stack.desolate("up", "sized", "--name", "w1");
    assert.equal(up.code, 0, up.stderr);
    assert.match(up.stdout, /^ {2}size {9}3 CPUs, 5 GiB memory, 40 GiB disk$/m);
    assert.match(
      up.stdout,
      /^ {2}project asks 3 CPUs, 5 GiB memory, 40 GiB disk \(acme\/sized, \.devcontainer\.json\)$/m,
    );
    assert.deepEqual(listed("sized/w1").size, { cpus: 3, memoryMiB: 5120, diskGiB: 40 });
    assert.deepEqual(
      limits(listed("sized/w1").vm),
      { cpus: 3, memoryMiB: 5120 },
      "and its VM was made that size",
    );
  });

  it("the person's choices come before the project's, and up says which decided", () => {
    stack.step("the person decides");
    assert.equal(stack.quiet("domain", "sized", "size", "--memory", "4g").code, 0);
    const up = stack.desolate("up", "sized", "--name", "w2", "--cpus", "2");
    assert.equal(up.code, 0, up.stderr);
    assert.match(up.stdout, /^ {2}size {9}2 CPUs, 4 GiB memory, 40 GiB disk$/m);
    assert.match(up.stdout, /^ {4}2 CPUs instead: up's flag decides$/m);
    assert.match(up.stdout, /^ {4}4 GiB memory instead: the domain's size decides$/m);
    assert.equal(stack.quiet("domain", "sized", "size", "--clear").code, 0);
  });

  it("a project's size is its repository's word: kept within this Mac, and what is not a size is not used", () => {
    stack.step("a project that asks too much");
    // (Quiet: what it is lowered to is this Mac's own, not the transcript's.)
    const up = stack.quiet("up", "greedy", "--name", "w1");
    assert.equal(up.code, 0, up.stderr);
    const cores = os.cpus().length;
    const most = Math.floor((Math.floor(os.totalmem() / 1048576) * 3) / 4 / 1024);
    assert.match(up.stdout, new RegExp(`^ {4}lowered: 64 CPUs: this Mac has ${cores}$`, "m"));
    assert.match(
      up.stdout,
      new RegExp(`^ {4}lowered: 256 GiB memory: a workspace gets at most ${most} GiB here`, "m"),
    );
    assert.match(
      up.stdout,
      /^ {4}not used: customizations\.desolate\.disk: "lots" is not an amount \(write it as "16g"\)$/m,
    );
    assert.deepEqual(listed("greedy/w1").size, {
      cpus: cores,
      memoryMiB: most * 1024,
      diskGiB: 30,
    });
    assert.equal(stack.quiet("rm", "greedy/w1").code, 0);
  });

  it("resize: refused while it runs, a disk never shrinks, and a stopped one is resized in its VM and its record", () => {
    stack.step("resize");
    const asked = stack.desolate("resize", "sized/w1");
    assert.equal(asked.code, 0, asked.stderr);
    assert.match(asked.stdout, /^sized\/w1 {2}3 CPUs, 5 GiB memory, 40 GiB disk$/m);
    // CONTROL: while it runs, nothing changes, and the fix is said.
    const running = stack.desolate("resize", "sized/w1", "--memory", "6g");
    assert.notEqual(running.code, 0);
    assert.match(
      running.stderr,
      /sized\/w1 is running: a VM's size changes only while it is stopped/,
    );
    assert.match(running.stderr, /fix: desolate stop sized\/w1/);
    assert.deepEqual(limits(listed("sized/w1").vm), { cpus: 3, memoryMiB: 5120 });
    assert.equal(stack.quiet("stop", "sized/w1").code, 0);
    const shrink = stack.desolate("resize", "sized/w1", "--disk", "30g");
    assert.notEqual(shrink.code, 0);
    assert.match(shrink.stderr, /a workspace's disk can grow, never shrink: sized\/w1 has 40 GiB/);
    const resized = stack.desolate("resize", "sized/w1", "--memory", "6g", "--disk", "50g");
    assert.equal(resized.code, 0, resized.stderr);
    assert.match(resized.stdout, /^resized sized\/w1: 3 CPUs, 6 GiB memory, 50 GiB disk$/m);
    assert.deepEqual(listed("sized/w1").size, { cpus: 3, memoryMiB: 6144, diskGiB: 50 });
    assert.deepEqual(limits(listed("sized/w1").vm), { cpus: 3, memoryMiB: 6144 });
    const started = stack.quiet("start", "sized/w1");
    assert.equal(started.code, 0, started.stderr);
    assert.deepEqual(
      limits(listed("sized/w1").vm),
      { cpus: 3, memoryMiB: 6144 },
      "and it starts with its new size",
    );
  });

  it("settings: the root VM's size is what `desolate settings set` stored, after the restart it names; the root's own settings are passed in, root's", () => {
    stack.step("settings");
    const set = stack.desolate("settings", "set", "root.memoryMiB", "1536m");
    assert.equal(set.code, 0, set.stderr);
    assert.match(
      set.stdout,
      /^root\.memoryMiB = 1536: the root VM has it when it starts again: desolate down, then desolate bootstrap\.$/m,
    );
    assert.equal(stack.desolate("settings", "set", "workspace.cpus", "1").code, 0);
    // A setting read in the root VM, stored as `set` stores one (this branch defines none of
    // its own; the reviewer's and rootd's are other tickets'), and one for the git VM, which
    // the root must not be given.
    const store = path.join(stack.home, "settings.json");
    fs.writeFileSync(
      store,
      JSON.stringify({
        ...JSON.parse(fs.readFileSync(store, "utf8")),
        "root.example": { value: "7", side: "root" },
        "git.example": { value: "8", side: "git" },
      }),
    );
    const root = rootVmName(stack.instance);
    assert.notEqual(limits(root).memoryMiB, 1536, "not before the restart");
    assert.equal(stack.quiet("down").code, 0);
    const again = bootstrap(stack);
    assert.equal(again.code, 0, again.stderr + again.stdout);
    assert.deepEqual(limits(root).memoryMiB, 1536, "the root VM has the size it was set");
    assert.match(again.stdout, /workspaces {3}1 CPU, /, "and a new workspace, the CPUs set");
    const passed = stack.inRoot(["cat", "/etc/desolate/settings.json"]);
    assert.equal(passed.code, 0, passed.stderr);
    assert.deepEqual(JSON.parse(passed.stdout), { "root.example": { value: "7", side: "root" } });
    // Root's in the root VM: its ordinary user, which runs what reads a domain's data, cannot
    // change what the root's services read. CONTROL: root can, so the check can tell.
    const user = stack.inRoot(["sh", "-c", "echo '{}' > /etc/desolate/settings.json"]);
    assert.notEqual(user.code, 0, "the root's ordinary user wrote the root's settings");
    const moved = stack.inRoot(["sh", "-c", "mv /etc/desolate/settings.json /tmp/x"]);
    assert.notEqual(moved.code, 0, "the root's ordinary user replaced the root's settings");
    const owner = stack.inRoot(["test", "-w", "/etc/desolate/settings.json"], { root: true });
    assert.equal(owner.code, 0, "root can write it: the control");
    assert.deepEqual(JSON.parse(stack.inRoot(["cat", "/etc/desolate/settings.json"]).stdout), {
      "root.example": { value: "7", side: "root" },
    });
    assert.equal(stack.desolate("settings", "unset", "root.memoryMiB").code, 0);
  });

  it("the transcript reads as reviewed", () => {
    stack.checkTranscript("t2-18-size");
  });
});
