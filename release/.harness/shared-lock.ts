// Harness for the in-source tests of shared/lock.ts. It stands in for the other takers of a
// lock: real processes that take it at the same moment, one that died holding it, a pid the
// system gave to another process since, and a holder in another VM, known only by its beat.
// The lock directories are written here as lock.ts writes them: a `holder` file of JSON, and
// on a share a `beat` file beside it.
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { startOf, withLock } from "../shared/lock.ts";
import { onTestFinished } from "./vitest.ts";

const LOCK_TS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "shared", "lock.ts");
const NODE = ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e"];

/** Work that answers `answer`. */
export const answering = (answer: string) => async (): Promise<string> => answer;

/** Takes the lock and looks, while it is held and after: what is in its folder, and whether
 *  the lock names this process (its pid, and when it started) as its holder. */
export const holding = async (
  dir: string,
): Promise<{ during: string[]; holderIsThisProcess: boolean; after: string[] }> => {
  const folder = path.dirname(dir);
  const seen = await withLock(dir, async () => ({
    names: fs.readdirSync(folder).sort(),
    holder: JSON.parse(fs.readFileSync(path.join(dir, "holder"), "utf8")) as {
      pid: number;
      start: string | null;
    },
  }));
  return {
    during: seen.names,
    holderIsThisProcess:
      seen.holder.pid === process.pid && seen.holder.start === startOf(process.pid),
    after: fs.readdirSync(folder).sort(),
  };
};

/** A lock left by a process that took it and then died inside its work, without leaving. */
export const leftByADeadProcess = (dir: string) => {
  const ran = spawnSync(
    process.execPath,
    [
      ...NODE,
      `import { withLock } from ${JSON.stringify(LOCK_TS)};
       await withLock(process.argv[1], async () => process.exit(0));`,
      dir,
    ],
    { encoding: "utf8" },
  );
  if (ran.status !== 0 || !fs.existsSync(path.join(dir, "holder")))
    throw new Error(`the process that was to die holding the lock did not: ${ran.stderr}`);
};

/** A lock left by a process that took it, exited inside its work, and is now a zombie: its
 *  parent (a `sleep`, which the shell that started both became) never asks after it. The
 *  parent is ended when the test ends. */
export const leftByAZombie = async (dir: string) => {
  const parent = spawn(
    "sh",
    [
      "-c",
      '"$0" "$@" & exec sleep 60',
      process.execPath,
      ...NODE,
      `import { withLock } from ${JSON.stringify(LOCK_TS)};
       await withLock(process.argv[1], async () => process.exit(0));`,
      dir,
    ],
    { stdio: "ignore" },
  );
  onTestFinished(() => void parent.kill("SIGKILL"));
  const state = () => {
    try {
      const { pid } = JSON.parse(fs.readFileSync(path.join(dir, "holder"), "utf8"));
      return spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout;
    } catch {
      return "";
    }
  };
  for (let waited = 0; !state().trim().startsWith("Z"); waited += 20) {
    if (waited > 4000) throw new Error(`the holder did not become a zombie: '${state()}'`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

/** A lock in place, written by hand, held since `since` by:
 *  - "this process": this very process, with its true start time: a live holder;
 *  - "this pid, started at another time": the same pid, but a process that started at
 *    another time: what is left when a holder died and the system gave its pid away;
 *  - "nobody": a directory with something in it and no holder (a lock of the kind
 *    root/reviewer.ts once made: a `pid` file). */
export const heldBy = (
  dir: string,
  holder: "this process" | "this pid, started at another time" | "nobody",
  since: string,
) => {
  fs.mkdirSync(dir, { recursive: true });
  if (holder === "nobody") return fs.writeFileSync(path.join(dir, "pid"), String(process.pid));
  fs.writeFileSync(
    path.join(dir, "holder"),
    JSON.stringify({
      id: "0123456789abcdef0123456789abcdef",
      pid: process.pid,
      host: "this-machine",
      since,
      start: holder === "this process" ? startOf(process.pid) : "Thu Jan  1 00:00:00 1970",
    }),
  );
};

/** A share lock in place, held from another VM (the pid it names is that VM's, and means
 *  nothing here: 1 is alive on every machine). Beating: its beat goes on until the test
 *  ends. Not: its beat is as its holder left it when it died. */
export const leftWithABeat = (dir: string, beating: boolean) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "holder"),
    JSON.stringify({
      id: "fedcba9876543210fedcba9876543210",
      pid: 1,
      host: "another-vm",
      since: "2026-11-20T21:04:05.000Z",
      start: "12345",
    }),
  );
  let count = 7;
  fs.writeFileSync(path.join(dir, "beat"), String(count));
  if (!beating) return;
  const beat = setInterval(() => {
    try {
      fs.writeFileSync(path.join(dir, "beat"), String(++count));
    } catch {
      /* the lock was taken away: the test will say so */
    }
  }, 10);
  onTestFinished(() => clearInterval(beat));
};

/** `takers` processes that each do one piece of work, all let go at the same moment: under
 *  the lock `dir` (`locked`), or with no lock at all (the control). Each writes a line as it
 *  starts its work and another as it ends. Answers how many did their work, and whether any
 *  two were ever in it together.
 *  `share`: the lock is taken as a share's, at that pace, and each holds it for `holdMs`,
 *  the first half of that without letting its process do anything else. */
export const contended = async (
  dir: string,
  takers: number,
  locked: boolean,
  share?: { holdMs: number; pace: { pollMs: number; beatMs: number; missed: number } },
): Promise<{ entered: number; overlapped: boolean }> => {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const [log, go] = [`${dir}.log`, `${dir}.go`];
  const asked = {
    dir,
    log,
    go,
    locked,
    scope: share ? "share" : "machine",
    pace: share?.pace ?? { pollMs: 20, beatMs: 2000, missed: 5 },
    blockMs: share ? share.holdMs / 2 : 0,
    holdMs: share ? share.holdMs / 2 : 150,
  };
  const code = `
    import * as fs from "node:fs";
    import { withLock } from ${JSON.stringify(LOCK_TS)};
    const asked = JSON.parse(process.argv[1]);
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const work = async () => {
      fs.appendFileSync(asked.log, "in\\n");
      if (asked.blockMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, asked.blockMs);
      await sleep(asked.holdMs);
      fs.appendFileSync(asked.log, "out\\n");
    };
    process.stdout.write("ready\\n");
    while (!fs.existsSync(asked.go)) await sleep(5);
    if (asked.locked) await withLock(asked.dir, work, { scope: asked.scope }, asked.pace);
    else await work();`;
  const started = Array.from({ length: takers }, () => {
    const child = spawn(process.execPath, [...NODE, code, JSON.stringify(asked)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    return {
      ready: new Promise<void>((resolve) => child.stdout.once("data", () => resolve())),
      ended: new Promise<void>((resolve, reject) =>
        child.on("close", (status) =>
          status === 0 ? resolve() : reject(new Error(`a taker failed (${status}): ${stderr}`)),
        ),
      ),
    };
  });
  await Promise.race([
    Promise.all(started.map((taker) => taker.ready)),
    ...started.map((taker) => taker.ended),
  ]);
  fs.writeFileSync(go, "");
  await Promise.all(started.map((taker) => taker.ended));
  let [inside, most, entered] = [0, 0, 0];
  for (const line of fs.readFileSync(log, "utf8").split("\n")) {
    if (line === "in") ((most = Math.max(most, ++inside)), entered++);
    if (line === "out") inside--;
  }
  return { entered, overlapped: most > 1 };
};

/** On a share, a waiter frozen at the worst moment. A share lock is left by a dead holder
 *  (its beat stopped). The first waiter takes the right to move it away, and finds it still
 *  the dead holder's; then its whole process stops (`freezeMs`, as a VM paused) just before
 *  it moves it. A second waiter, meanwhile, takes the first's right for dead (nothing beats
 *  in a right), clears the dead lock and takes the lock. The first wakes and moves what is
 *  in the lock's place. Answers, in order, who was inside and when; and what is left beside
 *  the lock. (Paced so that `missed` beats are 400 ms.) */
export const frozenHeir = async (
  dir: string,
  freezeMs: number,
): Promise<{ order: string[]; left: string[] }> => {
  leftWithABeat(dir, false);
  const log = `${dir}.log`;
  const dead = "fedcba9876543210fedcba9876543210";
  const taker = (name: string, freeze: boolean) =>
    spawn(
      process.execPath,
      [
        ...NODE,
        `import { createRequire, syncBuiltinESMExports } from "node:module";
         const fs = createRequire(import.meta.url)("node:fs");
         const [dir, log, name, freeze, freezeMs, holdMs] = process.argv.slice(1);
         if (freeze === "1") {
           const rename = fs.renameSync;
           let once = true;
           fs.renameSync = (from, to, ...rest) => {
             if (once && from === dir && to.includes(".gone-")) {
               once = false;
               Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(freezeMs));
             }
             return rename(from, to, ...rest);
           };
           syncBuiltinESMExports();
         }
         const { withLock } = await import(${JSON.stringify(LOCK_TS)});
         await withLock(dir, async () => {
           fs.appendFileSync(log, name + " in\\n");
           await new Promise((resolve) => setTimeout(resolve, Number(holdMs)));
           fs.appendFileSync(log, name + " out\\n");
         }, { scope: "share" }, { pollMs: 10, beatMs: 40, missed: 10 });`,
        dir,
        log,
        name,
        freeze ? "1" : "0",
        String(freezeMs),
        String(freezeMs + 1000),
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
  const ended = (child: ReturnType<typeof spawn>) =>
    new Promise<void>((resolve, reject) => {
      let stderr = "";
      child.stderr!.on("data", (chunk) => (stderr += chunk));
      child.on("close", (status) =>
        status === 0 ? resolve() : reject(new Error(`a taker failed (${status}): ${stderr}`)),
      );
    });
  const first = taker("first", true);
  const firstEnded = ended(first);
  for (let waited = 0; !fs.existsSync(`${dir}.heir-${dead}`); waited += 5) {
    if (waited > 10_000) throw new Error("the first waiter never took the right");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await Promise.all([firstEnded, ended(taker("second", false))]);
  const order = fs.readFileSync(log, "utf8").trim().split("\n");
  fs.rmSync(log);
  return { order, left: fs.readdirSync(path.dirname(dir)).sort() };
};

/** A process holds the lock `dir` (written by hand, naming itself with its true start: a
 *  live holder), and then, not waiting, takes it once while opening the holder file fails
 *  (EMFILE: no descriptor left), and once more after. What each taking did: "taken", or
 *  the refusal's message (its own pid said as "<this one>"). */
export const holderUnreadable = (dir: string): string[] => {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const ran = spawnSync(
    process.execPath,
    [
      ...NODE,
      `import { createRequire, syncBuiltinESMExports } from "node:module";
       const fs = createRequire(import.meta.url)("node:fs");
       const path = createRequire(import.meta.url)("node:path");
       const dir = process.argv[1];
       const { startOf, withLock } = await import(${JSON.stringify(LOCK_TS)});
       fs.mkdirSync(dir);
       fs.writeFileSync(path.join(dir, "holder"), JSON.stringify({
         id: "0123456789abcdef0123456789abcdef", pid: process.pid, host: "this-machine",
         since: "2026-11-20T21:04:05.000Z", start: startOf(process.pid) }));
       const open = fs.openSync;
       let failing = true;
       fs.openSync = (file, ...rest) => {
         if (failing && file === path.join(dir, "holder"))
           throw Object.assign(new Error("EMFILE: too many open files"), { code: "EMFILE" });
         return open(file, ...rest);
       };
       syncBuiltinESMExports();
       const said = [];
       for (const _ of [1, 2]) {
         try {
           await withLock(dir, async () => {}, { wait: false });
           said.push("taken");
         } catch (error) {
           said.push(error.message.replace("process " + process.pid + " ", "process <this one> "));
         }
         failing = false;
       }
       process.stdout.write(JSON.stringify(said));`,
      dir,
    ],
    { encoding: "utf8" },
  );
  if (ran.status !== 0) throw new Error(`the holder failed: ${ran.stderr}`);
  return JSON.parse(ran.stdout) as string[];
};

/** In the lock's place, a link that leads nowhere (anyone who can write the folder can put
 *  one there). */
export const danglingLinkAt = (dir: string) => {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.symlinkSync(path.join(path.dirname(dir), "nowhere"), dir);
};

/** Another side, on a share, does what it can to the lock's folder: it puts a link in the
 *  lock being made (`<dir>.new-<id>/holder`, in the moment after its directory appears)
 *  that leads to a file of the taker's; or it leaves in the lock's place a directory that is
 *  no lock, holding a link to a folder of the taker's. The taker takes the lock: did it (or
 *  why not)? Are the taker's file and folder as they were, and what is left beside it? */
export const hostileFolder = (
  dir: string,
  does: "link in the lock being made" | "a directory with a link in it",
): { took: boolean | string; untouched: boolean; left: string[] } => {
  const folder = path.dirname(dir);
  fs.mkdirSync(folder, { recursive: true });
  const victim = fs.mkdtempSync(path.join(path.dirname(folder), "victim-"));
  fs.writeFileSync(path.join(victim, "notes.txt"), "the person's");
  if (does === "a directory with a link in it") {
    fs.mkdirSync(dir);
    fs.symlinkSync(victim, path.join(dir, "sub"));
    fs.writeFileSync(path.join(dir, "junk"), "");
  }
  const ran = spawnSync(
    process.execPath,
    [
      ...NODE,
      `import { createRequire, syncBuiltinESMExports } from "node:module";
       const fs = createRequire(import.meta.url)("node:fs");
       const [dir, victim, does] = process.argv.slice(1);
       if (does === "link in the lock being made") {
         const mkdir = fs.mkdirSync;
         fs.mkdirSync = (made, ...rest) => {
           const answer = mkdir(made, ...rest);
           if (String(made).startsWith(dir + ".new-")) fs.symlinkSync(victim + "/notes.txt", made + "/holder");
           return answer;
         };
         syncBuiltinESMExports();
       }
       const { withLock } = await import(${JSON.stringify(LOCK_TS)});
       let took = false;
       try {
         await withLock(dir, async () => { took = true; }, { wait: false });
       } catch (error) {
         took = error.message.replace(new RegExp("'[^']*[.]new-[0-9a-f]+/"), "'<the lock being made>/");
       }
       process.stdout.write(JSON.stringify(took));`,
      dir,
      victim,
      does,
    ],
    { encoding: "utf8" },
  );
  if (ran.status !== 0) throw new Error(`the taker failed: ${ran.stderr}`);
  const untouched = fs.readFileSync(path.join(victim, "notes.txt"), "utf8") === "the person's";
  fs.rmSync(victim, { recursive: true, force: true });
  const left = fs
    .readdirSync(folder)
    .map((name) => name.replace(/-[0-9a-f]{16,32}$/, "-<id>"))
    .sort();
  return { took: JSON.parse(ran.stdout) as boolean | string, untouched, left };
};

/** Another side makes the lock's place a link to a live lock beside it (`<dir>` leads to
 *  `<live>`, held by this process), or puts there a lock whose right names itself (a holder
 *  that is dead, and a right `<dir>.heir-<id>` naming the same id). This process then takes
 *  `<dir>`, not waiting, with a time limit: what came of it ("taken", a refusal's message,
 *  or "stuck" when it did not answer in time), and is the live lock still its holder's? */
export const misleadingLock = (
  dir: string,
  does: "link to a live lock" | "a right that names itself",
): { came: string; liveIntact: boolean } => {
  const folder = path.dirname(dir);
  fs.mkdirSync(folder, { recursive: true });
  const live = path.join(folder, "live.lock");
  const holder = (pid: number, start: string | null) =>
    JSON.stringify({ id: "0123456789abcdef0123456789abcdef", pid, host: "h", since: "s", start });
  fs.mkdirSync(live);
  fs.writeFileSync(path.join(live, "holder"), holder(process.pid, startOf(process.pid)));
  if (does === "link to a live lock") fs.symlinkSync(live, dir);
  else {
    const dead = JSON.stringify({
      id: "fedcba9876543210fedcba9876543210",
      pid: 2 ** 31 - 2,
      host: "h",
      since: "s",
      start: "x",
    });
    for (const at of [dir, `${dir}.heir-fedcba9876543210fedcba9876543210`]) {
      fs.mkdirSync(at);
      fs.writeFileSync(path.join(at, "holder"), dead);
    }
  }
  const ran = spawnSync(
    process.execPath,
    [
      ...NODE,
      `import { withLock } from ${JSON.stringify(LOCK_TS)};
       let came = "taken";
       try {
         await withLock(process.argv[1], async () => {}, { wait: false });
       } catch (error) {
         came = error.message;
       }
       process.stdout.write(came);`,
      dir,
    ],
    { encoding: "utf8", timeout: 5000 },
  );
  const liveIntact =
    fs.existsSync(path.join(live, "holder")) &&
    JSON.parse(fs.readFileSync(path.join(live, "holder"), "utf8")).pid === process.pid;
  return { came: ran.status === null ? "stuck" : ran.stdout || ran.stderr, liveIntact };
};
