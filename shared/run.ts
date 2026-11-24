// Running other programs: always an argv, never a shell string.
//
// How long a program may take is not decided here (docs/v3/limits.md, R4: patience belongs
// to whoever is waiting). A caller passes `signal`, and the program is ended when whoever
// asked for it goes away; and, for a program that talks to a peer which is remote or not
// trusted (the forge, a VM), `idleMs`: ended when nothing has arrived for that long, however
// long it has run. `timeoutMs`, a total, is for the callers not yet moved to those.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type {
  Configure,
  Expect,
  Invoke,
  Table,
  Throws,
} from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { never, throwsUntil, trueOnCall } from "../.harness/shared-probe.ts";
import type {
  abortedIn,
  answerWhenItsRunnerEnds,
  answerWithAnEscapee,
  leftRunning,
  nestedLeftRunning,
  outlivesItsRunner,
  pacedLooks,
} from "../.harness/shared-run.ts";
import type { toFile } from "../.harness/shared-run-output.ts";

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
  /** The most of each stream kept, in bytes (default RUN_MAX): past it, the program is
   *  stopped. A caller whose program runs in a VM (whose output is not trusted) and that
   *  needs a line or a page of it should pass far less. */
  maxBytes?: number;
  /** stdout goes to this file (made, or emptied), whole, and is not kept: the answer's
   *  stdout is "". For output larger than is worth holding (an archive, a log), and, as
   *  "/dev/null", for a caller that needs only the exit code. stderr is kept as ever. (With
   *  `idleMs`, stderr alone is then watched.) */
  stdoutTo?: string;
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
const groups = new Map<number, { said: (why: string) => boolean; end: (why: string) => void }>();
let guarded = false;
const guard = () => {
  if (guarded) return;
  guarded = true;
  // Exiting: at once, since a process that is exiting cannot wait for them.
  process.on("exit", () => {
    for (const [pid, run] of groups) {
      run.said(STOPPING);
      toGroup(pid, "SIGKILL");
    }
  });
  // Told to end: as a run is ended, told first and killed ENDING_MS later (or once they are
  // gone, if sooner), so that what they run in groups of their own is ended too.
  let ending: Promise<void> | undefined;
  const endAllInTurn = () =>
    (ending ??= (async () => {
      // Each ended as its run ends it: told, killed later, its pipes let go.
      for (const run of groups.values()) run.end(STOPPING);
      for (const by = Date.now() + ENDING_MS; groups.size > 0 && Date.now() < by;)
        await new Promise((resolve) => setTimeout(resolve, 20));
      // (A run begun meanwhile, as by a handler of the same signal, is killed with the rest,
      // says why, and lets go of its pipes as any ended run does.)
      for (const [pid, run] of groups) {
        run.end(STOPPING);
        toGroup(pid, "SIGKILL");
      }
      ending = undefined;
    })());
  for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    const told = async () => {
      await endAllInTurn();
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

/** What is kept of one stream: its bytes, in one buffer that doubles as it fills and never
 *  past `most`, made text once at the end. Bytes, so that a bound in bytes counts bytes
 *  (R8), and a character whose bytes two writes split is one character, not two broken ones.
 *  One buffer, so that a program writing a byte at a time costs a byte for each, not an
 *  object for each (a list of chunks held 141 bytes for every byte kept: the independent
 *  review of #187). */
const kept = (most: number) => {
  let buffer = Buffer.alloc(0);
  let size = 0;
  return {
    /** false, and nothing kept, when the chunk would take it past `most` */
    add: (chunk: Buffer): boolean => {
      if (size + chunk.length > most) return false;
      if (size + chunk.length > buffer.length) {
        const grown = Buffer.allocUnsafe(
          Math.min(most, Math.max(size + chunk.length, buffer.length * 2, 4096)),
        );
        buffer.copy(grown, 0, 0, size);
        buffer = grown;
      }
      chunk.copy(buffer, size);
      size += chunk.length;
      return true;
    },
    text: () => buffer.toString("utf8", 0, size),
  };
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
    let file: number | undefined;
    if (options.stdoutTo !== undefined)
      try {
        file = fs.openSync(options.stdoutTo, "w");
      } catch (error) {
        return resolve({ code: 127, stdout: "", stderr: (error as Error).message });
      }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        env: options.env ?? process.env,
        cwd: options.cwd,
        stdio: ["pipe", file ?? "pipe", options.inheritStderr ? "inherit" : "pipe"],
        detached: grouped,
      });
    } catch (error) {
      // (An argument node will not pass, as one holding a NUL: said as a program not run.)
      return resolve({ code: 127, stdout: "", stderr: (error as Error).message });
    } finally {
      // The child has its own copy of the file's descriptor now, or there is no child.
      if (file !== undefined) fs.closeSync(file);
    }
    const group = grouped ? child.pid : undefined;
    const max = options.maxBytes ?? RUN_MAX;
    const out = kept(max);
    const err = kept(max);
    let told = "";
    const text = () => ({ stdout: out.text(), stderr: err.text() + told });
    let timer: NodeJS.Timeout | undefined;
    let idle: NodeJS.Timeout | undefined;
    // Ended by us, once, for one reason, which the answer's stderr ends with; and then never
    // a success, whatever the program's own exit (it may have exited 0 and left what it
    // started holding its pipes).
    let ended = false;
    const said = (why: string) => {
      if (ended) return false;
      ended = true;
      told += why;
      return true;
    };
    let closed = false;
    const end = (why: string) => {
      if (!said(why)) return;
      if (!group) return void child.kill("SIGKILL");
      // The group: the program and everything it started (a negative pid is a group). Told
      // to end first, so that what it runs in groups of its own is ended too; then killed.
      // What escaped the group (a daemon's own session) may still hold the pipes: they are
      // let go then too, so that the answer does not wait on it.
      // (No group left to tell: none to kill later either, since its id may be another's by
      // then.)
      const told = toGroup(group, "SIGTERM");
      setTimeout(() => {
        if (told) toGroup(group, "SIGKILL");
        if (closed) return;
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, ENDING_MS).unref();
    };
    if (group) groups.set(group, { said, end });
    const cancel = () => end(CANCELLED);
    const done = () => {
      closed = true;
      if (timer) clearTimeout(timer);
      if (idle) clearTimeout(idle);
      if (group) groups.delete(group);
      signal?.removeEventListener("abort", cancel);
    };
    let over = false;
    const tooMuch = () => {
      over = true;
      end(`\n(more than ${max} bytes of output: stopped)`);
    };
    const keep = (into: ReturnType<typeof kept>) => (chunk: Buffer) => {
      idle?.refresh();
      if (over) return;
      if (!into.add(chunk)) return tooMuch();
    };
    child.stdout?.on("data", keep(out));
    child.stderr?.on("data", keep(err));
    child.on("error", (error) => {
      done();
      const { stdout, stderr } = text();
      resolve({ code: 127, stdout, stderr: stderr + String(error.message) });
    });
    child.on("close", (code, killed) => {
      done();
      resolve({ code: ended ? 128 : (code ?? (killed ? 128 : 1)), ...text() });
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
  /** the bound is in bytes, as it says: here 4 characters of 3 bytes each, in two writes,
   *  are 12 bytes, over 10 (until 2026-11-21 the kept text's UTF-16 length, 3, was added to
   *  the second write's 3 bytes, and all 12 were kept) */
  export type TooMuchCountsBytes = Expect<
    Invoke<
      typeof run,
      [
        command: "sh",
        args: ["-c", "printf '\u20ac\u20ac\u20ac'; sleep 0.2; printf '\u20ac'"],
        options: { maxBytes: 10 },
      ]
    >,
    "matches",
    { code: 128; stderr: "\n(more than 10 bytes of output: stopped)" }
  >;
  /** a character whose bytes arrive in two writes is one character, not two broken ones */
  export type SplitCharacter = Expect<
    Invoke<
      typeof run,
      [command: "sh", args: ["-c", "printf '\\342'; sleep 0.2; printf '\\202\\254'"]]
    >,
    "=",
    { code: 0; stdout: "\u20ac"; stderr: "" }
  >;
  /** stdout sent to a file goes there whole, and is not kept; stderr is kept as ever */
  export type ToAFile = Expect<
    Invoke<typeof toFile, [script: "echo kept-in-the-file; echo err >&2; exit 2"]>,
    "=",
    { code: 2; stdout: ""; stderr: "err\n"; file: "kept-in-the-file\n"; open: "as before" }
  >;
  /** an argument node will not pass (a NUL): an answer, a program not run, and the file's
   *  descriptor closed, never a throw */
  export type NotPassed = Expect<
    Invoke<typeof toFile, [script: "echo hi", also: ["a\u0000b"]]>,
    "matches",
    { code: 127; stdout: ""; file: ""; open: "as before" }
  >;
  /** to /dev/null: only the exit code is wanted, and no output is held, however much (the
   *  control, TooMuch: the same program kept is stopped at its bound) */
  export type Discarded = Expect<
    Invoke<
      typeof run,
      [
        command: "sh",
        args: ["-c", "head -c 300000 /dev/zero; exit 4"],
        options: { stdoutTo: "/dev/null"; maxBytes: 100000 },
      ]
    >,
    "=",
    { code: 4; stdout: ""; stderr: "" }
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
  /** and when its runner is told to end, a runner it runs is told so too, before either is
   *  killed: so what that one runs ends as well (here two deep: a node that runs a node that
   *  runs a `sleep`, each with a signal; the outermost is sent SIGTERM) */
  export type EndsWhatItRunsWhenTold = Expect<
    Invoke<typeof outlivesItsRunner, [grouped: true, nested: true]>,
    "=",
    false
  >;
  /** what left its group (a daemon, in a session of its own) is not reached, and does not
   *  hold the answer either: it holds the run's output open, and the answer comes within
   *  ENDING_MS of the end all the same */
  export type AnswersThoughAnEscapeeHoldsItsPipes = Configure<
    { timeout: 15_000 },
    Expect<
      Invoke<typeof answerWithAnEscapee, [idleMs: 300]>,
      "=",
      { code: 128; stderr: "\n(nothing from it for 300 ms: stopped)"; soon: true }
    >
  >;
  /** a run its runner ended, as that runner was told to end, says so (where the runner
   *  listens for the signal itself, and lives on to read the answer) */
  export type SaysItsRunnerEnded = Expect<
    Invoke<typeof answerWhenItsRunnerEnds>,
    "=",
    { code: 128; stdout: ""; stderr: "\n(stopped: the program that ran it is ending)" }
  >;
  /** and so does one begun while its runner was ending (by its own listener of the signal),
   *  soon, though what its program started holds its pipes */
  export type SaysItsRunnerEndedWhenBegunEnding = Configure<
    { timeout: 20_000 },
    Expect<
      Invoke<typeof answerWhenItsRunnerEnds, [escapee: true, during: true]>,
      "=",
      {
        code: 128;
        stdout: "";
        stderr: "\n(stopped: the program that ran it is ending)";
        soon: true;
      }
    >
  >;
  /** and says so soon, though what its program started left the group and holds its pipes */
  export type SaysItsRunnerEndedThoughAnEscapee = Configure<
    { timeout: 15_000 },
    Expect<
      Invoke<typeof answerWhenItsRunnerEnds, [escapee: true]>,
      "=",
      {
        code: 128;
        stdout: "";
        stderr: "\n(stopped: the program that ran it is ending)";
        soon: true;
      }
    >
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

/** Look after things change: `poke` for each event. A look starts `quietMs` after the last
 *  event (a commit touches several files within milliseconds, a rebase moves a branch many
 *  times in a second), or `gapMs` after the first it answers if they keep coming; never
 *  sooner than `gapMs` after the last look began, never two at once. So a flood of events
 *  (a loop touching a ref) costs at most a look a second. `look` does not throw; `later`
 *  sets a timer and answers what cancels it. */
export const paced = (
  look: () => Promise<void>,
  now = () => performance.now(),
  later = (fn: () => void, ms: number) => clearTimeout.bind(null, setTimeout(fn, ms)),
  quietMs = 300,
  gapMs = 1000,
) => {
  let first: number | null = null;
  let last = 0;
  let began = -Infinity;
  let cancel = () => {};
  let looking = false;
  const arm = () => {
    cancel();
    if (first === null || looking) return;
    const at = Math.max(began + gapMs, Math.min(last + quietMs, first + gapMs));
    cancel = later(async () => {
      [first, looking, began] = [null, true, now()];
      await look();
      looking = false;
      arm();
    }, at - now());
  };
  return {
    poke: () => {
      last = now();
      first ??= last;
      arm();
    },
    /** what was poked and not looked at yet is dropped */
    close: () => {
      first = null;
      arm();
    },
  };
};

declare namespace paced {
  /** when it looks, given when events came (bursts: from, to, every ms) and how long a look
   *  takes. One event: a look 300 ms after it. A commit's few events within milliseconds:
   *  one look, 300 ms after the last. Two events seconds apart: two looks (the control) */
  export type Quiet = Table<
    typeof pacedLooks,
    [
      [args: [bursts: [[0, 0, 1]]], expected: [300]],
      [args: [bursts: [[0, 20, 5]]], expected: [320]],
      [args: [bursts: [[0, 0, 1], [2000, 2000, 1]]], expected: [300, 2300]],
    ]
  >;
  /** at most one look a second: events every 10 ms for 3 s look three times, not never (a
   *  flood would otherwise keep the quiet from coming) and not once each; two quick changes
   *  a look apart wait out the second's rest */
  export type AtMostOneASecond = Table<
    typeof pacedLooks,
    [
      [args: [bursts: [[0, 2990, 10]]], expected: [1000, 2000, 3000]],
      [args: [bursts: [[0, 0, 1], [400, 400, 1]]], expected: [300, 1300]],
    ]
  >;
  /** the root's state service's pace for its own files (root/stated.ts): 40 ms after an
   *  event, still at most once a second, however many there are */
  export type StateService = Table<
    typeof pacedLooks,
    [
      [args: [bursts: [[0, 0, 1]], lookMs: 0, closeAt: 99999, quietMs: 40], expected: [40]],
      [
        args: [bursts: [[0, 0, 1], [400, 400, 1]], lookMs: 0, closeAt: 99999, quietMs: 40],
        expected: [40, 1040],
      ],
      [
        args: [bursts: [[0, 2990, 10]], lookMs: 0, closeAt: 99999, quietMs: 40],
        expected: [1000, 2000, 3000],
      ],
    ]
  >;
  /** never two at once: an event during a slow look (1.5 s) is looked at when it ends */
  export type OneAtATime = Expect<
    Invoke<typeof pacedLooks, [bursts: [[0, 0, 1], [400, 400, 1]], lookMs: 1500]>,
    "=",
    [300, 1800]
  >;
  /** closed, what was poked is dropped: no look (the control: the same poke, not closed) */
  export type Closed = [
    Expect<Invoke<typeof pacedLooks, [bursts: [[0, 0, 1]], lookMs: 0, closeAt: 100]>, "=", []>,
    Expect<Invoke<typeof pacedLooks, [bursts: [[0, 0, 1]], lookMs: 0, closeAt: 400]>, "=", [300]>,
  ];
}
