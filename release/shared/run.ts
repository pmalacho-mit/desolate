// Running other programs: always an argv, never a shell string.
//
// How long a program may take is not decided here (docs/v3/limits.md, R4: patience belongs
// to whoever is waiting). A caller passes `signal`, and the program is ended when whoever
// asked for it goes away; and, for a program that talks to a peer which is remote or not
// trusted (the forge, a VM), `idleMs`: ended when nothing has arrived for that long, however
// long it has run. `timeoutMs`, a total, is for the callers not yet moved to those.
import { spawn } from "node:child_process";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Invoke, Throws } from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { never, throwsUntil, trueOnCall } from "../.harness/shared-probe.ts";
import type {
  abortedIn,
  answerWhenItsRunnerEnds,
  leftRunning,
  nestedLeftRunning,
  outlivesItsRunner,
} from "../.harness/shared-run.ts";

export type RunResult = { code: number; stdout: string; stderr: string };
export type RunOptions = {
  input?: string | Buffer;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** A total: past it the program is killed, whatever it was doing. For callers not yet
   *  moved to `signal` and `idleMs` (R4). */
  timeoutMs?: number;
  /** Whoever asked went away (a closed connection, a request that was dropped): when it
   *  fires, the program is ended, and so is everything it started. */
  signal?: AbortSignal;
  /** The program is ended, with everything it started, when neither of its streams has
   *  produced anything for this long: "nothing arrived", not "it took too long". (With
   *  `inheritStderr`, stdout alone is watched: its stderr is not ours to see.) */
  idleMs?: number;
  /** Echo the child's stderr to ours as it arrives (progress for a person). */
  inheritStderr?: boolean;
  /** The most of each stream kept (default 192 MiB): past it, the program is stopped. */
  maxBytes?: number;
};

/** What run() keeps of a program's output, at most, on each stream. Many of the programs run
 *  are in a VM, where anything may run: one that wrote without end grew a string in this
 *  process until V8 refused it, and the throw, in a 'data' listener, stopped the host's daemon
 *  (audit, 2026-11-20). Past it, the program is killed and the answer says so: a failure. */
export const RUN_MAX = 192 * 1024 * 1024;

/** What the answer's stderr ends with when the program was ended because whoever asked for
 *  it went away. */
const CANCELLED = "\n(cancelled)";

/** What the answer's stderr ends with when the program was ended because the process that
 *  ran it is ending. */
const STOPPING = "\n(stopped: the program that ran it is ending)";

/** How long a program told to end (SIGTERM) has to end what it started, before it and its
 *  group are killed (SIGKILL). A program that itself runs programs in groups of their own
 *  (with `signal`, here) ends those groups when it is told to end, and cannot when it is
 *  killed: killed at once, its own children were left running. Two seconds is a program
 *  ending its children and exiting, not one finishing its work, and a cancelled program
 *  that ignores the request is still gone in two seconds. */
export const ENDING_MS = 2_000;

/** A program run with `signal` or `idleMs` is ended with everything it started: it runs in a
 *  process group of its own, and the group is ended whole. (Killed alone, a `runuser` left
 *  its node and that node's git running, and a shell leaves what it started holding the
 *  pipes this waits on: the independent review of #169.) What leaves the group (a program
 *  that makes a session of its own, as a daemon does) is not reached: no process group is.
 *  A group of its own has no terminal: such a program cannot ask the person anything there,
 *  and the terminal's Ctrl-C does not reach it. So what would have ended it with this
 *  process still does: these are the groups now running, each with what marks its run as
 *  ended and why, and they are killed when this process exits or is told to (the signals a
 *  terminal and a supervisor send). Where nothing else listens for the signal, this process
 *  then ends by it, as it would have had nothing listened. */
const groups = new Map<number, (why: string) => void>();
let guarded = false;
const guard = () => {
  if (guarded) return;
  guarded = true;
  const endAll = () => {
    for (const [pid, said] of groups) {
      said(STOPPING);
      try {
        // At once: a process that is exiting cannot wait for them.
        process.kill(-pid, "SIGKILL");
      } catch {
        /* ended already */
      }
    }
  };
  process.on("exit", endAll);
  for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    const told = () => {
      endAll();
      if (process.listenerCount(name) > 1) return;
      process.removeListener(name, told);
      process.kill(process.pid, name);
    };
    process.on(name, told);
  }
};

/** Sends `how` to the process group `group`; false when there is none left. */
const toGroup = (group: number, how: NodeJS.Signals): boolean => {
  try {
    process.kill(-group, how);
    return true;
  } catch {
    return false;
  }
};

export const run = (
  command: string,
  args: string[],
  options: RunOptions = {},
): Promise<RunResult> =>
  new Promise((resolve) => {
    const { signal } = options;
    if (signal?.aborted) return resolve({ code: 128, stdout: "", stderr: CANCELLED });
    const grouped = signal !== undefined || options.idleMs !== undefined;
    if (grouped) guard();
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      cwd: options.cwd,
      stdio: ["pipe", "pipe", options.inheritStderr ? "inherit" : "pipe"],
      detached: grouped,
    });
    const group = grouped ? child.pid : undefined;
    let stdout = "";
    let stderr = "";
    let timer: NodeJS.Timeout | undefined;
    let idle: NodeJS.Timeout | undefined;
    // Ended by us, once, for one reason, which the answer's stderr ends with; and then never
    // a success, whatever the program's own exit (it may have exited 0 and left what it
    // started holding its pipes).
    let ended = false;
    const said = (why: string) => {
      if (ended) return false;
      ended = true;
      stderr += why;
      return true;
    };
    if (group) groups.set(group, said);
    const end = (why: string) => {
      if (!said(why)) return;
      // The group: the program and everything it started (a negative pid is a group). Told
      // to end first, so that what it runs in groups of its own is ended too; then killed.
      if (group && toGroup(group, "SIGTERM"))
        setTimeout(() => toGroup(group, "SIGKILL"), ENDING_MS).unref();
      else child.kill("SIGKILL");
    };
    const cancel = () => end(CANCELLED);
    const done = () => {
      if (timer) clearTimeout(timer);
      if (idle) clearTimeout(idle);
      if (group) groups.delete(group);
      signal?.removeEventListener("abort", cancel);
    };
    const max = options.maxBytes ?? RUN_MAX;
    let over = false;
    const tooMuch = () => {
      over = true;
      end(`\n(more than ${max} bytes of output: stopped)`);
    };
    child.stdout!.on("data", (chunk) => {
      idle?.refresh();
      if (over) return;
      if (stdout.length + chunk.length > max) return tooMuch();
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      idle?.refresh();
      if (over) return;
      if (stderr.length + chunk.length > max) return tooMuch();
      stderr += chunk;
    });
    child.on("error", (error) => {
      done();
      resolve({ code: 127, stdout, stderr: stderr + String(error.message) });
    });
    child.on("close", (code, killed) => {
      done();
      resolve({ code: ended ? 128 : (code ?? (killed ? 128 : 1)), stdout, stderr });
    });
    if (options.timeoutMs)
      timer = setTimeout(
        () => end(`\n(timed out after ${options.timeoutMs} ms)`),
        options.timeoutMs,
      );
    if (options.idleMs)
      idle = setTimeout(
        () => end(`\n(nothing from it for ${options.idleMs} ms: stopped)`),
        options.idleMs,
      );
    signal?.addEventListener("abort", cancel, { once: true });
    child.stdin!.on("error", () => {});
    child.stdin!.end(options.input ?? "");
  });

declare namespace run {
  /** the exit code and both streams, whatever the code: a failure is an answer, not a throw */
  export type Result = Expect<
    Invoke<typeof run, [command: "sh", args: ["-c", "echo out; echo err >&2; exit 3"]]>,
    "=",
    { code: 3; stdout: "out\n"; stderr: "err\n" }
  >;
  /** an argv: each word reaches the program as it is, and no shell reads it */
  export type Argv = Expect<
    Invoke<typeof run, [command: "printf", args: ["%s|", "$(touch x); rm -rf ~", "*"]]>,
    "=",
    { code: 0; stdout: "$(touch x); rm -rf ~|*|"; stderr: "" }
  >;
  /** what `input` holds is the child's stdin */
  export type Input = Expect<
    Invoke<typeof run, [command: "cat", args: [], options: { input: "fed in" }]>,
    "matches",
    { code: 0; stdout: "fed in" }
  >;
  /** a program that is not there: 127, as a shell says it, and the reason */
  export type Missing = Expect<
    Invoke<typeof run, [command: "desolate-no-such-program", args: []]>,
    "matches",
    { code: 127; stdout: ""; stderr: "spawn desolate-no-such-program ENOENT" }
  >;
  /** past its most output it is killed, and says so: 128, never a success */
  export type TooMuch = Expect<
    Invoke<typeof run, [command: "yes", args: [], options: { maxBytes: 100000 }]>,
    "matches",
    { code: 128; stderr: "\n(more than 100000 bytes of output: stopped)" }
  >;
  /** past its time it is killed, and says so: 128 (a signal), never a success */
  export type Timeout = Expect<
    Invoke<typeof run, [command: "sleep", args: ["10"], options: { timeoutMs: 50 }]>,
    "=",
    { code: 128; stdout: ""; stderr: "\n(timed out after 50 ms)" }
  >;
  /** silent for longer than `idleMs`, it is killed, and says so; what it said first is kept */
  export type Idle = Expect<
    Invoke<
      typeof run,
      [command: "sh", args: ["-c", "echo connecting; sleep 10"], options: { idleMs: 300 }]
    >,
    "=",
    { code: 128; stdout: "connecting\n"; stderr: "\n(nothing from it for 300 ms: stopped)" }
  >;
  /** idle is not a total: a program that keeps saying something runs past `idleMs` (here
   *  four lines, 150 ms apart, against 400 ms) */
  export type NotIdleWhileItTalks = Expect<
    Invoke<
      typeof run,
      [
        command: "sh",
        args: ["-c", "for n in 1 2 3 4; do echo $n; sleep 0.15; done"],
        options: { idleMs: 400 },
      ]
    >,
    "=",
    { code: 0; stdout: "1\n2\n3\n4\n"; stderr: "" }
  >;
  /** whoever asked went away: it is killed, and says so: 128, never a success */
  export type Cancelled = Expect<
    Invoke<
      typeof run,
      [
        command: "sh",
        args: ["-c", "echo started; sleep 10"],
        options: { signal: Invoke<typeof abortedIn, [ms: 300]> },
      ]
    >,
    "=",
    { code: 128; stdout: "started\n"; stderr: "\n(cancelled)" }
  >;
  /** ended by us is never a success, though the program itself exited 0: here a shell that
   *  exits at once, leaving a `sleep` that holds its output open and says nothing */
  export type EndedIsNotASuccess = Expect<
    Invoke<
      typeof run,
      [command: "sh", args: ["-c", "sleep 30 & exit 0"], options: { idleMs: 300 }]
    >,
    "=",
    { code: 128; stdout: ""; stderr: "\n(nothing from it for 300 ms: stopped)" }
  >;
  /** asked for by someone already gone: never started */
  export type CancelledBefore = Expect<
    Invoke<
      typeof run,
      [
        command: "sh",
        args: ["-c", "echo started"],
        options: { signal: Invoke<typeof abortedIn, [ms: 0]> },
      ]
    >,
    "=",
    { code: 128; stdout: ""; stderr: "\n(cancelled)" }
  >;
  /** what the program started ends with it: the shell's own child, a `sleep` it left running
   *  behind it, is gone once the run is cancelled. The control: the same shell, cancelled by
   *  nobody, exits and leaves its `sleep` alive (the harness then ends it). */
  export type EndsWhatItStarted = [
    Expect<Invoke<typeof leftRunning, [cancelled: true]>, "=", false>,
    Expect<Invoke<typeof leftRunning, [cancelled: false]>, "=", true>,
  ];
  /** and it does not outlive the process that ran it: a program in a group of its own (it
   *  was given a signal) is ended when its runner is told to end (SIGTERM, as a terminal's
   *  Ctrl-C or a supervisor would), though nothing fired the signal. The control: run with
   *  neither `signal` nor `idleMs`, as before, a runner killed alone leaves it running. */
  export type EndsWithItsRunner = [
    Expect<Invoke<typeof outlivesItsRunner, [grouped: true]>, "=", false>,
    Expect<Invoke<typeof outlivesItsRunner, [grouped: false]>, "=", true>,
  ];
  /** and a runner that is itself run, and cancelled, ends what it runs: a program that runs
   *  a `sleep` with a signal of its own is cancelled from outside, and the `sleep` goes too
   *  (it is told to end before it is killed, and ends its own groups) */
  export type EndsWhatItsRunnerRuns = Expect<Invoke<typeof nestedLeftRunning>, "=", false>;
  /** a run its runner ended, as that runner was told to end, says so (where the runner
   *  listens for the signal itself, and lives on to read the answer) */
  export type SaysItsRunnerEnded = Expect<
    Invoke<typeof answerWhenItsRunnerEnds>,
    "=",
    { code: 128; stdout: ""; stderr: "\n(stopped: the program that ran it is ending)" }
  >;
}

/** run(), but a failure is an exception carrying the child's stderr. */
export const must = async (
  command: string,
  args: string[],
  options: RunOptions = {},
): Promise<string> => {
  const result = await run(command, args, options);
  if (result.code !== 0)
    throw new Error(
      `${command} ${args.join(" ")} exited ${result.code}: ${(result.stderr || result.stdout).trim().slice(-2000)}`,
    );
  return result.stdout;
};

declare namespace must {
  /** stdout, when the program succeeds */
  export type Output = Expect<Invoke<typeof must, [command: "printf", args: ["ok"]]>, "=", "ok">;
  /** otherwise an exception that names the command, its code and what it said */
  export type Fails = Throws<
    Invoke<typeof must, [command: "sh", args: ["-c", "echo no such ref >&2; exit 128"]]>,
    "sh -c echo no such ref >&2; exit 128 exited 128: no such ref"
  >;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `probe` is true. Returns false at the deadline: the caller decides what a
 *  timeout means, and must not read it as success. */
export const waitFor = async (
  probe: () => Promise<boolean> | boolean,
  timeoutMs: number,
  everyMs = 100,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await probe()) return true;
    } catch {
      /* not yet */
    }
    if (Date.now() >= deadline) return false;
    await sleep(everyMs);
  }
};

declare namespace waitFor {
  /** asked again until it is true */
  export type ComesUp = Expect<
    Invoke<typeof waitFor, [probe: Invoke<typeof trueOnCall, [n: 3]>, timeoutMs: 5000, everyMs: 1]>,
    "=",
    true
  >;
  /** a probe that throws is not there yet, not a failure */
  export type ThrowsMeansNotYet = Expect<
    Invoke<
      typeof waitFor,
      [probe: Invoke<typeof throwsUntil, [n: 3]>, timeoutMs: 5000, everyMs: 1]
    >,
    "=",
    true
  >;
  /** at the deadline, false: the caller decides what a timeout means */
  export type Deadline = Expect<
    Invoke<typeof waitFor, [probe: Invoke<typeof never>, timeoutMs: 20, everyMs: 5]>,
    "=",
    false
  >;
}
