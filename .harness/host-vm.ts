// Harness for in-source tests of the VM layer's own helpers (host/vm/fake.ts, used by both
// backends): a child process whose spawn failed, as node gives one, and how a stream ends.
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Duplex } from "node:stream";

/** A child whose spawn failed before it made its pipes, as node gives one when this process
 *  holds too many files (EMFILE): no stdin or stdout, and its error on the next tick. */
export const spawnFailed = (code: string): ChildProcess => {
  const child = Object.assign(new EventEmitter(), { stdin: null, stdout: null, stderr: null });
  process.nextTick(() =>
    child.emit("error", Object.assign(new Error(`spawn socat ${code}`), { code })),
  );
  return child as unknown as ChildProcess;
};

/** How a stream ends: its error's message, or "ended". */
export const endOf = (stream: Duplex) =>
  new Promise<string>((resolve) => {
    stream.once("error", (error) => resolve(error.message));
    stream.once("close", () => resolve("ended"));
    stream.resume();
  });
