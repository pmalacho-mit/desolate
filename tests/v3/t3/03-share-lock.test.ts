// T3 (qemu) and T4 (vz, on a Mac: DESOLATE_TIER=T4). A share lock (shared/lock.ts, scope
// "share") between two real VMs, over the share they both see: /workspaces, a domain's, as
// workspace/init.ts takes it. In-source tests take it between processes of one machine; only
// here does a beat cross virtiofs, written by one VM's kernel and read by another's.
// And a stopped workspace's link: what it carried ends when the host lets it go.
//
// Run: tests/v3/run.sh t4   (or t3)
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { bootstrap, git, newStack } from "../lib/harness.ts";
import type { Stack } from "../lib/harness.ts";

let stack: Stack;
const REAL = process.env.DESOLATE_TIER === "T3" || process.env.DESOLATE_TIER === "T4";
const DIR = "/workspaces/.t4-lock";
const vms: Record<string, string> = {};
const inVm = (who: string, script: string) => stack.inVm(vms[who]!, ["bash", "-c", script]);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// One taker, run in a VM: `rounds <n> <locked>` takes the lock n times, each time inside for
// a while (or, not locked, the control, goes in without it); `hold` takes it and keeps its
// main thread busy until it is killed; `wait` waits for it, saying whom for, then goes in.
// Whoever is inside makes the file `inside`, which only one may make at a time: a second
// inside at once is written down as an overlap.
const TAKER = `
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
const { withLock } = await import("/desolate/release/shared/lock.ts");
const [name, mode, rounds, locked] = process.argv.slice(2);
const DIR = ${JSON.stringify(DIR)};
const lock = DIR + "/locks/t4.lock";
const log = (line) => fs.appendFileSync(DIR + "/" + name + ".log", line + "\\n");
fs.writeFileSync(DIR + "/" + name + ".pid", String(process.pid));
const inside = async (ms) => {
  try { fs.writeFileSync(DIR + "/inside", name, { flag: "wx" }); } catch { log("overlap"); }
  log("in");
  await new Promise((resolve) => setTimeout(resolve, ms));
  if (fs.readFileSync(DIR + "/inside", "utf8") === name) fs.rmSync(DIR + "/inside");
  log("out");
};
const share = { scope: "share", waiting: (holder) => log("waiting for " + holder.host) };
if (mode === "rounds")
  for (let i = 0; i < Number(rounds); i++) {
    if (locked === "1") await withLock(lock, () => inside(700), share);
    else await inside(700);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
if (mode === "hold")
  await withLock(lock, async () => {
    log("in");
    for (;;) spawnSync("sleep", ["5"]);
  }, share);
if (mode === "wait") await withLock(lock, async () => log("in"), share);
log("done");
`;

/** Starts a taker in the background of its VM, as `name`. */
const start = (who: string, name: string, ...args: string[]) => {
  const ran = inVm(
    who,
    `cd ${DIR} && rm -f ${name}.log && (setsid nohup node --disable-warning=ExperimentalWarning taker.mjs ${name} ${args.join(" ")} > ${name}.err 2>&1 < /dev/null &) && echo started`,
  );
  assert.equal(ran.code, 0, ran.stderr);
};
/** A taker's log, as the other VM sees it over the share. */
const logOf = (who: string, name: string) =>
  inVm(who, `cat ${DIR}/${name}.log 2>/dev/null; cat ${DIR}/${name}.err >&2 2>/dev/null`);
const until = async (what: string, ms: number, check: () => boolean) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`not within ${ms / 1000} s: ${what}`);
    await sleep(500);
  }
};
const count = (text: string, line: string) =>
  text.split("\n").filter((each) => each === line).length;

describe(
  "T3: a share lock between two VMs, and a stopped workspace's link",
  { skip: REAL ? false : "set DESOLATE_TIER=T3 (tests/v3/run.sh t3), or T4 on a Mac" },
  () => {
    before(() => {
      stack = newStack("lock");
      stack.seed("acme/app", (dir) => {
        fs.writeFileSync(path.join(dir, "README.md"), "# app\n");
        git(dir, "add", "-A");
        git(dir, "commit", "--quiet", "-m", "seed");
      });
    });
    after(() => stack?.destroy());

    it("T3 bootstrap, a domain, and two workspaces", () => {
      stack.step(`bootstrap on the ${stack.backend} backend`);
      const result = bootstrap(stack);
      assert.equal(result.code, 0, result.stderr + result.stdout.slice(-1500));
      stack.step("clone, domain, two workspaces");
      assert.equal(stack.desolate("clone", "acme/app", "--no-domain").code, 0);
      assert.equal(stack.desolate("domain", "create", "dev").code, 0);
      assert.equal(stack.desolate("domain", "dev", "add", "--repo", "acme/app").code, 0);
      for (const name of ["one", "two"]) {
        const up = stack.quiet("up", "dev", "--name", name);
        assert.equal(up.code, 0, up.stderr);
      }
      const list = JSON.parse(stack.quiet("list", "--json").stdout) as {
        domain: string;
        workspaces: { workspace: string; vm: string }[];
      }[];
      for (const w of list.find((d) => d.domain === "dev")!.workspaces) vms[w.workspace] = w.vm;
      assert.ok(vms.one && vms.two && vms.one !== vms.two, "two VMs");
      const wrote = stack.inVm(vms.one!, ["bash", "-c", `mkdir -p ${DIR} && cat > ${DIR}/taker.mjs`], {
        input: TAKER,
      });
      assert.equal(wrote.code, 0, wrote.stderr);
      assert.equal(inVm("two", `test -f ${DIR}/taker.mjs && echo seen`).stdout.trim(), "seen");
    });

    it("T3 one holder at a time, across two VMs; the control, with no lock, overlaps", async () => {
      stack.step("two VMs take one share lock, five times each");
      start("one", "a", "rounds", "5", "1");
      start("two", "b", "rounds", "5", "1");
      await until("both takers done", 180_000, () =>
        ["a", "b"].every((name) => logOf("one", name).stdout.includes("done")),
      );
      for (const name of ["a", "b"]) {
        const log = logOf("two", name).stdout;
        assert.equal(count(log, "in"), 5, `${name} went in five times: ${log}`);
        assert.equal(count(log, "overlap"), 0, `${name} was never inside with the other: ${log}`);
      }
      stack.step("the control: the same, with no lock");
      start("one", "c", "rounds", "5", "0");
      start("two", "d", "rounds", "5", "0");
      await until("both control takers done", 120_000, () =>
        ["c", "d"].every((name) => logOf("one", name).stdout.includes("done")),
      );
      assert.ok(
        count(logOf("one", "c").stdout + logOf("one", "d").stdout, "overlap") > 0,
        "control: without the lock, the two were inside together, and it was seen",
      );
    });

    it("T3 a killed holder is taken over once its beat stops, and never while it lives", async () => {
      stack.step("one VM holds the lock, busy; the other waits");
      inVm("one", `rm -f ${DIR}/inside`);
      start("one", "holder", "hold");
      await until("the holder is in", 60_000, () =>
        logOf("two", "holder").stdout.includes("in"),
      );
      start("two", "waiter", "wait");
      await until("the waiter waits, naming the holder's VM", 60_000, () =>
        logOf("one", "waiter").stdout.includes("waiting for"),
      );
      // Two and a half of BEAT's windows (10 s): a live holder, its main thread blocked in a
      // spawnSync all along, beats from its own thread.
      await sleep(25_000);
      assert.doesNotMatch(
        logOf("one", "waiter").stdout,
        /^in$/m,
        "the waiter did not go in while the holder lived",
      );
      stack.step("the holder is killed");
      const killed = inVm("one", `kill -9 "$(cat ${DIR}/holder.pid)" && echo killed`);
      assert.equal(killed.stdout.trim(), "killed", killed.stderr);
      const at = Date.now();
      await until("the waiter goes in", 60_000, () =>
        /^in$/m.test(logOf("two", "waiter").stdout),
      );
      const took = Date.now() - at;
      assert.ok(took < 30_000, `taken over ${took} ms after the kill: one window and a look`);
      assert.match(logOf("two", "waiter").stdout, /done/);
    });

    it("T3 a workspace let go by the host: what its link carried ends", async () => {
      stack.step("a connection on workspace two's link, then the host lets it go");
      const socket = net.connect(path.join(stack.home, "run", vms.two!, "proxy.sock"));
      let closedAt = 0;
      socket.on("close", () => (closedAt = Date.now()));
      socket.on("error", () => {});
      await new Promise((resolve) => socket.once("connect", resolve));
      await sleep(3000);
      assert.equal(closedAt, 0, "control: a carried connection stays open while its workspace is up");
      const answer = await new Promise<string>((resolve, reject) => {
        const daemon = net.connect(path.join(stack.home, "state", "daemon.sock"));
        let text = "";
        daemon.on("connect", () =>
          daemon.write(JSON.stringify({ op: "unregister", vm: vms.two }) + "\n"),
        );
        daemon.on("data", (chunk) => (text += chunk));
        daemon.on("end", () => resolve(text));
        daemon.on("error", reject);
      });
      assert.match(answer, /"ok":true/);
      const let_go = Date.now();
      await until("the carried connection is closed", 10_000, () => closedAt !== 0);
      assert.ok(closedAt - let_go < 10_000);
    });
  },
);
