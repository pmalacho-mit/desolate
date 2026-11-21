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
