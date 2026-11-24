// A program run for a person who is waiting on it, where shared/run.ts's `run` would hold
// everything it says until it ends: a provisioning that takes minutes says each step as it
// starts it, and an archive goes from the program to a file (or from a file to the program)
// as bytes, never as one string in this process.
//
// No timer is in here (docs/v3/limits.md, R4): the program runs until it ends, or until
// whoever is waiting stops it. It stays in this process's group, so a terminal's Ctrl-C
// reaches it as it reaches desolate.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import { Duplex } from "node:stream";
import { RUN_MAX } from "../../shared/run.ts";
import type { RunResult } from "../../shared/run.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Given, Invoke } from "../../../suede.nests/dsl.import.meta.vitest.ts";
import type { emptyScratch, scratch } from "../../.harness/shared-files.ts";
import type { hexOf, streamed } from "../../.harness/host-stream.ts";
import type { endOf, spawnFailed } from "../../.harness/host-vm.ts";

export type StreamOptions = {
  env?: NodeJS.ProcessEnv;
  input?: string | Buffer;
  /** A file that is the program's stdin, read as the program takes it. */
  stdinFrom?: string;
  /** A file the program's stdout is written to as it comes (the person's alone, made anew);
   *  the answer's `stdout` is then empty. */
  stdoutTo?: string;
  /** Given each whole line of the program's stdout as it comes: what it is doing, for
   *  whoever is waiting. The answer's `stdout` still holds all of it. */
  lines?: (line: string) => void;
};

/** `run`, streamed. The answer is `run`'s: the exit code and both streams, a failure an
 *  answer and not a throw. What is kept of a stream in memory is bounded as `run` bounds it
 *  (RUN_MAX: past it the program is stopped, and the answer says so); what goes to a file
 *  is not kept, and so not bounded. */
export const runStreamed = (
  command: string,
  args: string[],
  options: StreamOptions = {},
): Promise<RunResult> =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let kept = 0;
    let over = false;
    const keepable = (chunk: Buffer) => {
      if (over) return false;
      kept += chunk.length;
      if (kept <= RUN_MAX) return true;
      over = true;
      stderr += `\n(more than ${RUN_MAX} bytes of output: stopped)`;
      child.kill("SIGKILL");
      return false;
    };
    // The file is whole on disk before the answer is given: its end is waited for.
    const file = options.stdoutTo
      ? fs.createWriteStream(options.stdoutTo, { mode: 0o600, flags: "w" })
      : null;
    const written = file
      ? new Promise<string>((done) => {
          // A file that cannot be written (no such folder, a full disk) ends the program: its
          // output has nowhere to go, and unread it would fill the pipe and stop it forever.
          file.on("error", (error) => {
            child.stdout.unpipe(file);
            child.stdout.resume();
            child.kill("SIGKILL");
            done(`\n(${options.stdoutTo}: ${error.message})`);
          });
          file.on("finish", () => done(""));
        })
      : Promise.resolve("");
    let line = "";
    if (file) child.stdout.pipe(file);
    else
      child.stdout.on("data", (chunk: Buffer) => {
        if (!keepable(chunk)) return;
        stdout += chunk;
        if (!options.lines) return;
        line += chunk;
        for (let end = line.indexOf("\n"); end >= 0; end = line.indexOf("\n")) {
          options.lines(line.slice(0, end));
          line = line.slice(end + 1);
        }
      });
    child.stderr.on("data", (chunk: Buffer) => {
      if (keepable(chunk)) stderr += chunk;
    });
    child.on("error", (error) => {
      file?.destroy();
      resolve({ code: 127, stdout, stderr: stderr + String(error.message) });
    });
    child.on("close", async (code, killed) => {
      if (line !== "") options.lines?.(line);
      const failed = await written;
      resolve({
        code: failed !== "" ? 1 : (code ?? (killed ? 128 : 1)),
        stdout,
        stderr: stderr + failed,
      });
    });
    child.stdin.on("error", () => {});
    if (options.stdinFrom) {
      const from = fs.createReadStream(options.stdinFrom);
      // A file that cannot be read ends the program's input: it fails on what it was given,
      // and the answer says which file.
      from.on("error", (error) => {
        stderr += `\n(${options.stdinFrom}: ${error.message})`;
        child.stdin.end();
        child.kill("SIGKILL");
      });
      from.pipe(child.stdin);
    } else child.stdin.end(options.input ?? "");
  });

declare namespace runStreamed {
  /** each line of what it says, as it says it; and the whole answer at its end, as run's */
  export type Lines = Expect<
    Invoke<
      typeof streamed,
      [command: "sh", args: ["-c", "echo '==> packages'; echo '==> node'; echo warn >&2; exit 3"]]
    >,
    "=",
    {
      said: ["==> packages", "==> node"];
      code: 3;
      stdout: "==> packages\n==> node\n";
      stderr: "warn\n";
    }
  >;
  /** a last line with no newline is a line too */
  export type LastLine = Expect<
    Invoke<typeof streamed, [command: "printf", args: ["a\\nb"]]>,
    "matches",
    { said: ["a", "b"]; code: 0 }
  >;
  /** bytes to a file, and from one: none of them through a string here, so an archive is
   *  whatever size it is, and arrives as it was */
  export type Files = Given<
    [
      Invoke<typeof emptyScratch>,
      Invoke<
        typeof runStreamed,
        [
          command: "sh",
          args: ["-c", "printf '\\037\\213\\000\\377bytes'"],
          options: { stdoutTo: Invoke<typeof scratch, [name: "out.bin"]> },
        ]
      >,
      Invoke<
        typeof runStreamed,
        [
          command: "sh",
          args: ["-c", 'cat >"$0"', Invoke<typeof scratch, [name: "copy.bin"]>],
          options: { stdinFrom: Invoke<typeof scratch, [name: "out.bin"]> },
        ]
      >,
    ],
    [
      Expect<
        Invoke<typeof hexOf, [file: Invoke<typeof scratch, [name: "out.bin"]>]>,
        "=",
        "1f8b00ff6279746573"
      >,
      Expect<
        Invoke<typeof hexOf, [file: Invoke<typeof scratch, [name: "copy.bin"]>]>,
        "=",
        "1f8b00ff6279746573"
      >,
    ]
  >;
  /** a file that cannot be written ends the program (and the answer says which file): it is
   *  not waited on, its output having nowhere to go */
  export type Unwritable = Expect<
    Invoke<
      typeof runStreamed,
      [
        command: "sh",
        args: ["-c", "head -c 5000000 /dev/zero"],
        options: { stdoutTo: "/desolate-no-such-dir/out.bin" },
      ]
    >,
    "matches",
    { code: 1 }
  >;
  /** a program that is not there: 127 and the reason, as run says it */
  export type Missing = Expect<
    Invoke<typeof runStreamed, [command: "desolate-no-such-program", args: []]>,
    "matches",
    { code: 127; stderr: "spawn desolate-no-such-program ENOENT" }
  >;
}

/** A child process's stdio as one Duplex stream. */
export const duplexOf = (child: ChildProcess): Duplex => {
  const { stdin, stdout } = child;
  // No pipes: the spawn failed before it made them (EMFILE, ENFILE: this process holds too
  // many files). Its error comes on the next tick and ends the stream, which is not thrown.
  if (!stdin || !stdout) {
    const failed = new Duplex({ read() {}, write: (_chunk, _encoding, done) => done() });
    child.once("error", (error) => failed.destroy(error));
    return failed;
  }
  const stream = new Duplex({
    read() {
      stdout.resume();
    },
    write(chunk, encoding, callback) {
      stdin.write(chunk, encoding, callback);
    },
    final(callback) {
      stdin.end(callback);
    },
    destroy(error, callback) {
      child.kill();
      callback(error);
    },
  });
  stdout.on("data", (chunk) => {
    if (!stream.push(chunk)) stdout.pause();
  });
  stdout.on("end", () => stream.push(null));
  stdin.on("error", () => {});
  child.on("error", (error) => stream.destroy(error));
  return stream;
};

declare namespace duplexOf {
  /** a spawn that could not make its pipes gives a stream ended by its error, not a throw */
  export type NoPipes = Expect<
    Invoke<
      typeof endOf,
      [stream: Invoke<typeof duplexOf, [child: Invoke<typeof spawnFailed, [code: "EMFILE"]>]>]
    >,
    "=",
    "spawn socat EMFILE"
  >;
}
