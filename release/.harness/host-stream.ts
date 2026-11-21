// Harness for the in-source tests of release/host/vm/stream.ts: what a waiting person is told
// while a program runs (a callback, which a type cannot say), and what a file holds, byte for
// byte.
import * as fs from "node:fs";
import { runStreamed } from "../host/vm/stream.ts";

/** Runs it, and says each line it was given as the program said it, with the answer. */
export const streamed = async (command: string, args: string[]) => {
  const said: string[] = [];
  const result = await runStreamed(command, args, { lines: (line) => void said.push(line) });
  return { said, ...result };
};

/** A file's bytes, as hex. */
export const hexOf = (file: string): string => fs.readFileSync(file).toString("hex");
