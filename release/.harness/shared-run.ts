// Harness for the in-source tests of shared/run.ts's `signal`: it stands in for whoever
// asked for a program and then went away (a closed connection, a person's Ctrl-C), and looks
// for what a program left running behind it.
import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { run, sleep, waitFor } from "../shared/run.ts";

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
 *  (SIGTERM), alone, as a supervisor would. Is the `sleep` still running afterwards?
 *  (Whatever is left is then ended here.) */
export const outlivesItsRunner = async (grouped: boolean): Promise<boolean> => {
  const runner = spawn(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--input-type=module",
      "-e",
      `import { run } from ${JSON.stringify(RUN_TS)};
       const options = process.argv[1] === "grouped" ? { signal: new AbortController().signal } : {};
       await run("sh", ["-c", "echo $$ >&2; exec sleep 30"], { ...options, inheritStderr: true });`,
      grouped ? "grouped" : "alone",
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
  runner.kill("SIGTERM");
  const left = !(await waitFor(() => !alive(pid), grouped ? 2000 : 300, 20));
  if (left) process.kill(pid, "SIGKILL");
  return left;
};
