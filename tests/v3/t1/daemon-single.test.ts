// T1. One host daemon a home. A daemon that starts ends the connections for channels it
// finds under the Lima home (lima.ts, release: what a daemon that died left), so a second one
// started while the first runs (two commands racing to start it, a stop slower than the wait
// for it) would end the first's, and the two would take turns doing it. The second ends at
// once instead, saying which holds the home (daemon.ts, serve), and touches nothing.
//
// The first's connection for channels is a stand-in: a process whose command names a control
// socket under the home, as an ssh master's does, beside its folder. The Lima backend is the
// Mac's: elsewhere it refuses to start, and so does the daemon.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const DAEMON = path.resolve(import.meta.dirname, "../../../release/host/daemon.ts");
const homes: string[] = [];
const started: ChildProcess[] = [];

const freePort = () =>
  new Promise<number>((resolve) => {
    const server = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });

/** A home (short: its sockets must fit), with a VM's folder and a stand-in master in it. */
const home = () => {
  const at = fs.mkdtempSync("/tmp/dsl-dm-");
  homes.push(at);
  const ch = path.join(at, "lima", "dsl-main-w9", "ch");
  fs.mkdirSync(ch, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(ch, "kept"), "");
  return { at, ch };
};
const standInMaster = (ch: string) => {
  const master = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)", "--", "-o", `ControlPath=${path.join(ch, "ctl")}`],
    { stdio: "ignore" },
  );
  started.push(master);
  return master;
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const daemon = async (at: string, port: number) => {
  const child = spawn(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", DAEMON, "serve"],
    {
      env: { ...process.env, DESOLATE_HOME: at, DESOLATE_EDITOR_PORT: String(port) },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  started.push(child);
  let said = "";
  child.stderr!.on("data", (chunk) => (said += chunk));
  const ended = new Promise<number>((resolve) => child.on("exit", (code) => resolve(code ?? 1)));
  return { child, ended, said: () => said };
};
/** The daemon's socket answers: it is up. */
const answers = (at: string) =>
  new Promise<boolean>((resolve) => {
    const socket = net.connect(path.join(at, "state", "daemon.sock"));
    socket.on("connect", () => (socket.destroy(), resolve(true)));
    socket.on("error", () => resolve(false));
  });
const until = async (what: () => Promise<boolean> | boolean, ms: number) => {
  for (const began = Date.now(); Date.now() - began < ms;)
    if (await what()) return true;
    else await new Promise((resolve) => setTimeout(resolve, 100));
  return false;
};

const LOCK = path.resolve(import.meta.dirname, "../../../release/shared/lock.ts");
/** A daemon of other code, as one an older desolate left: it holds the home's lock and its
 *  socket, says another code, and when asked to stop closes its socket at once and ends
 *  `stopMs` later (closing its listeners, its connections). */
const standInDaemon = async (at: string, stopMs: number) => {
  const state = path.join(at, "state");
  fs.mkdirSync(state, { recursive: true });
  const script = `
    import net from "node:net"; import fs from "node:fs";
    const { withLock } = await import(${JSON.stringify(LOCK)});
    await withLock(${JSON.stringify(path.join(state, "daemon.lock"))}, () => new Promise(() => {
      const server = net.createServer((c) => c.on("data", (d) => {
        const q = JSON.parse(String(d));
        c.end(JSON.stringify({ ok: true, code: "other" }) + "\\n");
        if (q.op === "stop") { server.close(); fs.rmSync(${JSON.stringify(path.join(state, "daemon.sock"))}, { force: true }); setTimeout(() => process.exit(0), ${stopMs}); }
      }));
      server.listen(${JSON.stringify(path.join(state, "daemon.sock"))}, () => console.log("up"));
    }), { wait: false });`;
  const child = spawn(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", script],
    {
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  started.push(child);
  await new Promise((resolve) => child.stdout!.once("data", resolve));
  return child;
};
/** `ensureDaemon`, as a command runs it: how long it took, and how it ended. */
const ensure = (at: string, port: number) =>
  new Promise<{ code: number; said: string; ms: number }>((resolve) => {
    const began = Date.now();
    const child = spawn(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        "--input-type=module",
        "-e",
        `const { ensureDaemon } = await import(${JSON.stringify(DAEMON)}); await ensureDaemon(); console.log("ensured");`,
      ],
      {
        env: { ...process.env, DESOLATE_HOME: at, DESOLATE_EDITOR_PORT: String(port) },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let said = "";
    child.stdout!.on("data", (chunk) => (said += chunk));
    child.stderr!.on("data", (chunk) => (said += chunk));
    child.on("exit", (code) => resolve({ code: code ?? 1, said, ms: Date.now() - began }));
  });

describe(
  "T1 one host daemon a home",
  { skip: process.platform === "darwin" ? false : "the Lima backend is the Mac's" },
  () => {
    after(() => {
      for (const child of started) child.kill("SIGKILL");
      for (const at of homes) fs.rmSync(at, { recursive: true, force: true });
    });

    it("a second daemon on the home ends at once, saying which holds it, and the first's connections and folders are untouched", async () => {
      const { at, ch } = home();
      const port = await freePort();
      const first = await daemon(at, port);
      assert.ok(await until(() => answers(at), 20_000), `the first did not start: ${first.said()}`);
      // Its connection, made after it started (what its own dials make).
      fs.mkdirSync(ch, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(ch, "kept"), "");
      const master = standInMaster(ch);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const second = await daemon(at, port);
      assert.notEqual(await second.ended, 0);
      assert.match(
        second.said(),
        new RegExp(
          `the host daemon for ${at} is already running \\(pid ${first.child.pid}, since .*\\): this one ends`,
        ),
      );
      assert.ok(alive(master.pid!), "the first's connection still runs");
      assert.ok(fs.existsSync(path.join(ch, "kept")), "and its folder is there");
      assert.ok(await answers(at), "and the first still answers");
    });

    it("control: a daemon started alone ends the connections it finds under the home and removes their folders", async () => {
      const { at, ch } = home();
      const master = standInMaster(ch);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const alone = await daemon(at, await freePort());
      assert.ok(await until(() => answers(at), 20_000), `it did not start: ${alone.said()}`);
      assert.ok(await until(() => !alive(master.pid!), 5_000), "the connection it found was ended");
      assert.equal(fs.existsSync(ch), false, "and its folder removed");
    });

    it("a start that finds the daemon before it still ending waits for it to let go of the home, then starts its own (12 s here, past the 10 s it used to wait before starting anyway)", async () => {
      const { at } = home();
      const old = await standInDaemon(at, 12_000);
      const ended = new Promise((resolve) => old.on("exit", resolve));
      const result = await ensure(at, await freePort());
      assert.equal(result.code, 0, result.said);
      assert.match(result.said, /ensured/);
      assert.ok(result.ms >= 11_000, `it waited ${result.ms} ms`);
      await ended;
      assert.ok(await answers(at), "its own daemon answers");
    });

    it("control: one that ends at once is followed at once", async () => {
      const { at } = home();
      await standInDaemon(at, 0);
      const result = await ensure(at, await freePort());
      assert.equal(result.code, 0, result.said);
      assert.ok(result.ms < 8_000, `it took ${result.ms} ms`);
      assert.ok(await answers(at));
    });
  },
);
