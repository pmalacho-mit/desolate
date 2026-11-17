// Running other programs: always an argv, never a shell string.
import { spawn } from "node:child_process";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Invoke, Throws } from "../../.suede/nests/dsl.import.meta.vitest.ts";
import type { never, throwsUntil, trueOnCall } from "../../tests/nests/shared-probe.harness.ts";

export type RunResult = { code: number; stdout: string; stderr: string };
export type RunOptions = {
  input?: string | Buffer;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
  /** Echo the child's stderr to ours as it arrives (progress for a person). */
  inheritStderr?: boolean;
};

export const run = (command: string, args: string[], options: RunOptions = {}): Promise<RunResult> =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      cwd: options.cwd,
      stdio: ["pipe", "pipe", options.inheritStderr ? "inherit" : "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timer: NodeJS.Timeout | undefined;
    child.stdout!.on("data", (chunk) => (stdout += chunk));
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: stderr + String(error.message) });
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? (signal ? 128 : 1), stdout, stderr });
    });
    if (options.timeoutMs)
      timer = setTimeout(() => {
        stderr += `\n(timed out after ${options.timeoutMs} ms)`;
        child.kill("SIGKILL");
      }, options.timeoutMs);
    child.stdin!.on("error", () => {});
    child.stdin!.end(options.input ?? "");
  });

declare namespace run {
  /** the exit code and both streams, whatever the code: a failure is an answer, not a throw */
  export type Result = Expect<Invoke<typeof run, [command: "sh", args: ["-c", "echo out; echo err >&2; exit 3"]]>, "=", { code: 3; stdout: "out\n"; stderr: "err\n" }>;
  /** an argv: each word reaches the program as it is, and no shell reads it */
  export type Argv = Expect<Invoke<typeof run, [command: "printf", args: ["%s|", "$(touch x); rm -rf ~", "*"]]>, "=", { code: 0; stdout: "$(touch x); rm -rf ~|*|"; stderr: "" }>;
  /** what `input` holds is the child's stdin */
  export type Input = Expect<Invoke<typeof run, [command: "cat", args: [], options: { input: "fed in" }]>, "matches", { code: 0; stdout: "fed in" }>;
  /** a program that is not there: 127, as a shell says it, and the reason */
  export type Missing = Expect<Invoke<typeof run, [command: "desolate-no-such-program", args: []]>, "matches", { code: 127; stdout: ""; stderr: "spawn desolate-no-such-program ENOENT" }>;
  /** past its time it is killed, and says so: 128 (a signal), never a success */
  export type Timeout = Expect<Invoke<typeof run, [command: "sleep", args: ["10"], options: { timeoutMs: 50 }]>, "=", { code: 128; stdout: ""; stderr: "\n(timed out after 50 ms)" }>;
}

/** run(), but a failure is an exception carrying the child's stderr. */
export const must = async (command: string, args: string[], options: RunOptions = {}): Promise<string> => {
  const result = await run(command, args, options);
  if (result.code !== 0)
    throw new Error(`${command} ${args.join(" ")} exited ${result.code}: ${(result.stderr || result.stdout).trim().slice(-2000)}`);
  return result.stdout;
};

declare namespace must {
  /** stdout, when the program succeeds */
  export type Output = Expect<Invoke<typeof must, [command: "printf", args: ["ok"]]>, "=", "ok">;
  /** otherwise an exception that names the command, its code and what it said */
  export type Fails = Throws<Invoke<typeof must, [command: "sh", args: ["-c", "echo no such ref >&2; exit 128"]]>, "sh -c echo no such ref >&2; exit 128 exited 128: no such ref">;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `probe` is true. Returns false at the deadline: the caller decides what a
 *  timeout means, and must not read it as success. */
export const waitFor = async (probe: () => Promise<boolean> | boolean, timeoutMs: number, everyMs = 100): Promise<boolean> => {
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
  export type ComesUp = Expect<Invoke<typeof waitFor, [probe: Invoke<typeof trueOnCall, [n: 3]>, timeoutMs: 5000, everyMs: 1]>, "=", true>;
  /** a probe that throws is not there yet, not a failure */
  export type ThrowsMeansNotYet = Expect<Invoke<typeof waitFor, [probe: Invoke<typeof throwsUntil, [n: 3]>, timeoutMs: 5000, everyMs: 1]>, "=", true>;
  /** at the deadline, false: the caller decides what a timeout means */
  export type Deadline = Expect<Invoke<typeof waitFor, [probe: Invoke<typeof never>, timeoutMs: 20, everyMs: 5]>, "=", false>;
}
