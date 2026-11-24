// T4 (vz, on a Mac: DESOLATE_TIER=T4). Each VM's ssh host key is its own: made in it at its
// first start (host/vm/lima.ts, `ownKey`), the only one the Mac accepts for it, kept as it
// stops and starts, and a VM that answers at another's port is refused. Only real VMs run
// sshd. Every refusal sits beside the control of the right pairing.
//
// Run: tests/v3/run.sh t4
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { bootstrap, git, newStack } from "../lib/harness.ts";
import type { Stack } from "../lib/harness.ts";

let stack: Stack;
const REAL = process.env.DESOLATE_TIER === "T4";
const vm: Record<string, string> = {};
const dir = (name: string) => path.join(stack.home, "lima", vm[name]!);
/** The keys a VM's ssh.known_hosts accepts (Lima's file: hosts, then the key). */
const accepted = (name: string) =>
  fs
    .readFileSync(path.join(dir(name), "ssh.known_hosts"), "utf8")
    .trim()
    .split("\n")
    .map((line) => line.split(" ").slice(1).join(" "));
const portOf = (name: string) =>
  Number(/^\s*Port (\d+)$/m.exec(fs.readFileSync(path.join(dir(name), "ssh.config"), "utf8"))![1]);
/** The ed25519 key the VM's sshd holds, as its own file says. */
const held = (name: string) => {
  const r = stack.inVm(vm[name]!, ["cat", "/etc/ssh/ssh_host_ed25519_key.pub"]);
  assert.equal(r.code, 0, r.stderr);
  return r.stdout.trim().split(" ").slice(0, 2).join(" ");
};
/** The ed25519 key a new connection to the VM's port is shown. */
const shown = (name: string) =>
  spawnSync("ssh-keyscan", ["-t", "ed25519", "-p", String(portOf(name)), "127.0.0.1"], {
    encoding: "utf8",
  })
    .stdout.trim()
    .split(" ")
    .slice(1)
    .join(" ");
/** ssh as the Mac's client reaches `alias` (its ssh.config, known hosts and host-key alias),
 *  but at `port`: a fresh connection, its host key strictly checked. */
const sshAs = (alias: string, port: number) =>
  spawnSync(
    "ssh",
    [
      "-F",
      path.join(dir(alias), "ssh.config"),
      "-o",
      "ControlPath=none",
      "-o",
      `Port=${port}`,
      "-o",
      "LogLevel=ERROR",
      `lima-${vm[alias]}`,
      "--",
      "true",
    ],
    { encoding: "utf8", env: stack.env, timeout: 60_000 },
  );
const refusedForKey = /Host key verification failed|IDENTIFICATION HAS CHANGED/;
const keyCheck = () =>
  stack
    .quiet("doctor")
    .stdout.split("\n")
    .find((line) => line.includes("VMs have ssh host keys of their own")) ?? "";

describe(
  "T3: each VM's ssh host key is its own",
  { skip: REAL ? false : "set DESOLATE_TIER=T4 (tests/v3/run.sh t4, on a Mac)" },
  () => {
    before(() => {
      stack = newStack("keys");
      stack.seed("acme/app", (d) => {
        fs.writeFileSync(path.join(d, "README.md"), "# app\n");
        git(d, "add", "-A");
        git(d, "commit", "--quiet", "-m", "seed");
      });
    });
    after(() => stack?.destroy());

    it("T3 bootstrap, the git VM, and two workspaces", () => {
      const result = bootstrap(stack);
      assert.equal(result.code, 0, result.stderr + result.stdout.slice(-1500));
      assert.equal(stack.quiet("clone", "acme/app", "--no-domain").code, 0);
      const gitVm = stack.quiet("git", "acme/app");
      assert.equal(gitVm.code, 0, gitVm.stderr);
      assert.equal(stack.quiet("domain", "create", "dev").code, 0);
      assert.equal(stack.quiet("domain", "dev", "add", "--repo", "acme/app").code, 0);
      for (const name of ["one", "two"]) {
        const up = stack.quiet("up", "dev", "--name", name);
        assert.equal(up.code, 0, up.stderr);
      }
      const list = JSON.parse(stack.quiet("list", "--json").stdout) as {
        workspaces: { workspace: string; vm: string }[];
      }[];
      for (const w of list.flatMap((d) => d.workspaces)) vm[w.workspace] = w.vm;
      vm.root = `dsl-${stack.instance}-root`;
      vm.git = `dsl-${stack.instance}-git`;
      vm.base = `dsl-${stack.instance}-base`;
      assert.ok(vm.one && vm.two, JSON.stringify(list));
    });

    it("T3 each VM is accepted by one key, the one it holds and shows, and no other VM's or the base's", () => {
      const vms = ["root", "git", "one", "two"];
      for (const name of vms) {
        assert.equal(accepted(name).length, 1, `${name}: one key`);
        // The control: the same comparison finds the key equal where it is the same key.
        assert.equal(accepted(name)[0], held(name), `${name}: accepted is what it holds`);
        assert.equal(shown(name), held(name), `${name}: shown to a new connection`);
      }
      const keys = vms.map((name) => accepted(name)[0]);
      assert.equal(new Set(keys).size, vms.length, `each its own: ${keys.join(" | ")}`);
      // The base keeps the key every clone started with (Lima copied it): accepted for none.
      const base = accepted("base")[0]!;
      assert.match(base, /^ssh-ed25519 /);
      for (const key of keys) assert.notEqual(key, base);
      assert.match(keyCheck(), /^ {2}ok {3}VMs have ssh host keys of their own: no running VM/);
    });

    it("T3 a VM answering at another's port is refused by the Mac's client (the right pairing is let in)", () => {
      const control = sshAs("root", portOf("root"));
      assert.equal(control.status, 0, control.stderr);
      const asRoot = sshAs("root", portOf("one"));
      assert.notEqual(asRoot.status, 0);
      assert.match(asRoot.stderr, refusedForKey);
      const control2 = sshAs("two", portOf("two"));
      assert.equal(control2.status, 0, control2.stderr);
      const asTwo = sshAs("two", portOf("one"));
      assert.notEqual(asTwo.status, 0);
      assert.match(asTwo.stderr, refusedForKey);
    });

    it("T3 a workspace stopped and started again keeps its key, and Lima keeps what was recorded", () => {
      const before = accepted("one")[0];
      assert.equal(stack.quiet("stop", "dev/one").code, 0);
      const started = stack.quiet("start", "dev/one");
      assert.equal(started.code, 0, started.stderr);
      assert.deepEqual(accepted("one"), [before]);
      assert.equal(held("one"), before);
      assert.equal(shown("one"), before);
      const log = fs.readFileSync(path.join(dir("one"), "ha.stderr.log"), "utf8");
      assert.doesNotMatch(log, /host key mismatch/);
      assert.equal(sshAs("one", portOf("one")).status, 0);
    });

    it("T3 a workspace given the root VM's key: doctor names both, and bootstrap gives each its own", () => {
      const rootKey = accepted("root")[0]!;
      const oneKey = accepted("one")[0]!;
      // Two VMs with one key, as VMs made before each had its own were: the root VM's host keys,
      // put in workspace one, and accepted for it.
      const keys = stack.inRoot(
        [
          "bash",
          "-c",
          "tar -C /etc/ssh -cf - ssh_host_ed25519_key ssh_host_ed25519_key.pub | base64",
        ],
        { root: true },
      );
      assert.equal(keys.code, 0, keys.stderr);
      const put = stack.inVm(vm.one!, ["bash", "-c", "base64 -d | tar -C /etc/ssh -xf -"], {
        root: true,
        input: keys.stdout,
      });
      assert.equal(put.code, 0, put.stderr);
      const file = path.join(dir("one"), "ssh.known_hosts");
      const line = fs.readFileSync(file, "utf8").trim().split(" ");
      fs.writeFileSync(file, `${line[0]} ${rootKey}\n`);
      assert.equal(shown("one"), rootKey);
      // The control for the refusal below: with one key, the client cannot tell the two apart.
      const together = sshAs("root", portOf("one"));
      assert.equal(together.status, 0, together.stderr);
      const said = keyCheck();
      assert.match(said, /^ {2}FAIL VMs have ssh host keys of their own: /);
      assert.match(said, /dev\/one accepts the same ssh host key as root\b/);
      assert.match(said, /\broot accepts the same ssh host key as dev\/one\b/);

      const result = bootstrap(stack);
      assert.equal(result.code, 0, result.stderr + result.stdout.slice(-1500));
      assert.equal((result.stdout.match(/given an ssh host key of its own/g) ?? []).length, 2);
      for (const name of ["root", "one"]) {
        assert.equal(accepted(name)[0], held(name));
        assert.equal(shown(name), held(name));
      }
      const now = ["root", "git", "one", "two"].map((name) => accepted(name)[0]);
      assert.equal(new Set(now).size, 4);
      assert.ok(!now.includes(rootKey) && !now.includes(oneKey));
      const asRoot = sshAs("root", portOf("one"));
      assert.notEqual(asRoot.status, 0);
      assert.match(asRoot.stderr, refusedForKey);
      assert.equal(sshAs("root", portOf("root")).status, 0);
      assert.equal(stack.inRoot(["true"], { root: true }).code, 0);
      assert.match(keyCheck(), /^ {2}ok {3}VMs have ssh host keys of their own/);
      // Lima's own sessions: a shell and a copy.
      const shell = spawnSync("limactl", ["--tty=false", "shell", vm.one!, "true"], {
        env: stack.env,
        encoding: "utf8",
      });
      assert.equal(shell.status, 0, shell.stderr);
      const copied = path.join(stack.work, "copied");
      const copy = spawnSync(
        "limactl",
        ["--tty=false", "copy", `${vm.one}:/etc/hostname`, copied],
        { env: stack.env, encoding: "utf8" },
      );
      assert.equal(copy.status, 0, copy.stderr);
      assert.ok(fs.readFileSync(copied, "utf8").length > 0);
    });
  },
);
