// Harness for the in-source tests of shared/run.ts's `signal`: it stands in for whoever
// asked for a program and then went away (a closed connection, a person's Ctrl-C), and looks
// for what a program left running behind it.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ENDING_MS, paced, run, sleep, waitFor } from "../shared/run.ts";

const RUN_TS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "shared", "run.ts");

/** A signal that fires `ms` from now; already fired for 0. */
export const abortedIn = (ms: number): AbortSignal =>
  ms === 0 ? AbortSignal.abort() : AbortSignal.timeout(ms);

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Runs a shell that starts a `sleep` of its own, says the sleep's pid, and waits for it.
 *  Cancelled: the run is cancelled once the pid is known. Not cancelled (the control): the
 *  shell is told nothing and exits at once, without waiting. Either way: is that `sleep`
 *  still running afterwards? (Whatever is left is then ended here.) */
export const leftRunning = async (cancelled: boolean): Promise<boolean> => {
  const gone = new AbortController();
  const ran = await (cancelled
    ? (async () => {
        const running = run("sh", ["-c", "sleep 30 & echo $!; wait"], { signal: gone.signal });
        await sleep(300);
        gone.abort();
        return running;
      })()
    : run("sh", ["-c", "sleep 30 >/dev/null 2>&1 & echo $!"]));
  const pid = Number(ran.stdout.trim());
  if (!Number.isInteger(pid) || pid < 2) throw new Error(`no pid from the shell: ${ran.stdout}`);
  // A killed process is gone within moments, not at once: give it one.
  const left = !(await waitFor(() => !alive(pid), cancelled ? 2000 : 200, 20));
  if (left) process.kill(pid, "SIGKILL");
  return left;
};

/** A process of its own runs a `sleep` with run(), in a group of its own (`grouped`: it is
 *  given a signal that never fires) or as run() always did, and is then told to end
 *  (SIGTERM), alone, as a supervisor would. `nested`: it runs, the same way, a process
 *  that runs the `sleep`. Is the `sleep` still running afterwards? (Whatever is left is
 *  then ended here.) */
export const outlivesItsRunner = async (grouped: boolean, nested = false): Promise<boolean> => {
  const inner = `import { run } from ${JSON.stringify(RUN_TS)};
       const options = process.argv[1] === "grouped" ? { signal: new AbortController().signal } : {};
       await run("sh", ["-c", "echo $$ >&2; exec sleep 30"], { ...options, stderrLines: (line) => process.stderr.write(line + "\\n") });`;
  const outer = `import { run } from ${JSON.stringify(RUN_TS)};
       const options = process.argv[1] === "grouped" ? { signal: new AbortController().signal } : {};
       await run(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", process.argv[2], process.argv[1]], { ...options, stderrLines: (line) => process.stderr.write(line + "\\n") });`;
  const runner = spawn(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--input-type=module",
      "-e",
      nested ? outer : inner,
      grouped ? "grouped" : "alone",
      inner,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  // The shell says its pid, which is the sleep's once it has become it.
  const pid = await new Promise<number>((resolve, reject) => {
    let said = "";
    runner.stderr.on("data", (chunk) => {
      said += chunk;
      if (/^\d+\n/m.test(said)) resolve(Number(/^(\d+)\n/m.exec(said)![1]));
    });
    runner.on("close", () => reject(new Error(`the runner ended before its program: ${said}`)));
  });
  await sleep(100);
  runner.kill("SIGTERM");
  const left = !(await waitFor(() => !alive(pid), grouped ? 4000 : 300, 20));
  if (left) process.kill(pid, "SIGKILL");
  return left;
};

/** run() runs a node that starts a `sleep` in a session of its own (out of every group of
 *  run's) which holds the node's output open, and then exits; nothing more is said, so the
 *  run is ended after `idleMs`. Its answer, and whether it came soon (within twice
 *  ENDING_MS of the end), not when the sleep (10 s) ends. The sleep is then ended here. */
export const answerWithAnEscapee = async (
  idleMs: number,
): Promise<{ code: number; stderr: string; soon: boolean }> => {
  const started = Date.now();
  const answer = await run(
    process.execPath,
    [
      "-e",
      `const child = require("node:child_process").spawn("sleep", ["10"], { detached: true, stdio: "inherit" });
       process.stderr.write(child.pid + "\\n");`,
    ],
    { idleMs },
  );
  const pid = Number(/^(\d+)\n/.exec(answer.stderr)?.[1]);
  if (pid > 1 && alive(pid)) process.kill(pid, "SIGKILL");
  return {
    code: answer.code,
    stderr: answer.stderr.replace(/^\d+\n/, ""),
    soon: Date.now() - started < idleMs + 2 * ENDING_MS,
  };
};

const NODE = [process.execPath, "--disable-warning=ExperimentalWarning", "--input-type=module"];

/** run() runs a node that itself runs a `sleep` with run(), with a signal of its own (so in a
 *  group of its own), and writes the sleep's pid to a file; the outer run is then cancelled.
 *  Is the `sleep` still running afterwards? (Whatever is left is then ended here.) */
export const nestedLeftRunning = async (): Promise<boolean> => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desolate-run-"));
  const said = path.join(dir, "pid");
  const gone = new AbortController();
  try {
    const outer = run(
      NODE[0]!,
      [
        ...NODE.slice(1),
        "-e",
        `import { run } from ${JSON.stringify(RUN_TS)};
         await run("sh", ["-c", "echo $$ > " + process.argv[1] + "; exec sleep 30"], { signal: new AbortController().signal });`,
        said,
      ],
      { signal: gone.signal },
    );
    let pid = 0;
    if (
      !(await waitFor(() => (pid = Number(fs.readFileSync(said, "utf8").trim())) > 1, 10_000, 20))
    )
      throw new Error("the inner sleep never said its pid");
    // (The pid is the shell's until it has become the sleep: let it.)
    await sleep(100);
    gone.abort();
    await outer;
    const left = !(await waitFor(() => !alive(pid), 4000, 20));
    if (left) process.kill(pid, "SIGKILL");
    return left;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

/** A process runs a `sleep` with run() and a signal, listens for SIGTERM itself (so it lives
 *  on), and is sent SIGTERM: what does its run answer? `escapee`: the program run starts the
 *  `sleep` (10 s) in a session of its own, holding the run's output, and exits; the answer
 *  then also says whether it came soon (within twice ENDING_MS, three times when `during`),
 *  not when the sleep ends. `during`: that run is begun by the process's own listener of the
 *  signal, while run() is ending the one it had. */
export const answerWhenItsRunnerEnds = async (
  escapee = false,
  during = false,
): Promise<{ code: number; stdout: string; stderr: string; soon?: boolean }> => {
  const runner = spawn(
    NODE[0]!,
    [
      ...NODE.slice(1),
      "-e",
      `import { run } from ${JSON.stringify(RUN_TS)};
       const program = process.argv[1] === "escapee"
         ? [process.execPath, ["-e", 'require("node:child_process").spawn("sleep", ["10"], { detached: true, stdio: "inherit" }).unref()']]
         : ["sh", ["-c", "exec sleep 30"]];
       const signal = new AbortController().signal;
       let answer;
       if (process.argv[2] === "during") {
         run("sh", ["-c", "exec sleep 30"], { signal });
         answer = new Promise((resolve) =>
           process.on("SIGTERM", () => resolve(run(program[0], program[1], { signal }))));
       } else {
         process.on("SIGTERM", () => {});
         answer = run(program[0], program[1], { signal });
       }
       process.stderr.write("running\\n");
       process.stdout.write(JSON.stringify(await answer));`,
      escapee ? "escapee" : "plain",
      during ? "during" : "before",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let out = "";
  runner.stdout.on("data", (chunk) => (out += chunk));
  await new Promise<void>((resolve, reject) => {
    runner.stderr.on("data", (chunk) => String(chunk).includes("running") && resolve());
    runner.on("close", () => reject(new Error("the runner ended before its program ran")));
  });
  await sleep(escapee ? 500 : 100);
  const told = Date.now();
  runner.kill("SIGTERM");
  await new Promise((resolve) => runner.on("close", resolve));
  const answer = JSON.parse(out);
  return escapee ? { ...answer, soon: Date.now() - told < (during ? 3 : 2) * ENDING_MS } : answer;
};

/** When `paced` starts its looks, on a clock of the test's own: events poked in `bursts`
 *  (each from, to, every ms), each look taking `lookMs`, closed at `closeAt`, paced by
 *  `quietMs` and `gapMs` (paced's own unless given). Timers due by an event's time run before
 *  it. */
export const pacedLooks = async (
  bursts: [from: number, to: number, every: number][],
  lookMs = 0,
  closeAt = Infinity,
  quietMs?: number,
  gapMs?: number,
): Promise<number[]> => {
  let now = 0;
  let made = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const later = (fn: () => void, ms: number) => {
    const id = ++made;
    timers.set(id, { at: now + ms, fn });
    return () => void timers.delete(id);
  };
  const looks: number[] = [];
  const pacer = paced(
    async () => {
      looks.push(now);
      if (lookMs > 0) await new Promise<void>((resolve) => later(resolve, lookMs));
    },
    () => now,
    later,
    quietMs,
    gapMs,
  );
  const events: [at: number, act: () => void][] = [[closeAt, pacer.close]];
  for (const [from, to, every] of bursts)
    for (let at = from; at <= to; at += every) events.push([at, pacer.poke]);
  events.sort((a, b) => a[0] - b[0]);
  const settle = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  for (;;) {
    const [id, due] = [...timers].sort((a, b) => a[1].at - b[1].at)[0] ?? [];
    const event = events[0];
    if (due && id !== undefined && (!event || due.at <= event[0])) {
      timers.delete(id);
      now = Math.max(now, due.at);
      due.fn();
    } else if (event && event[0] !== Infinity) {
      events.shift();
      now = event[0];
      event[1]();
    } else break;
    await settle();
  }
  return looks;
};
