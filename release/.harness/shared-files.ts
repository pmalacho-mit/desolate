// Harness for in-source tests of shared/ code that reads and writes files by path (copy.ts,
// json.ts, status.ts): it stands in for the other side, a VM or a domain that leaves files,
// links and FIFOs where the code will look. Everything is under the test file's own home
// (setup.ts), in scratch/, so a name in a test is a path the harness resolves.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { onTestFinished } from "./vitest.ts";

const top = () => path.join(process.env.DESOLATE_HOME!, "scratch");

/** The absolute path of `name` under scratch/ (its directory made; the file itself not). */
export const scratch = (name = ""): string => {
  const file = path.join(top(), name);
  fs.mkdirSync(name === "" ? file : path.dirname(file), { recursive: true });
  return file;
};

/** scratch/, emptied: what a test that needs nothing before it starts with. */
export const emptyScratch = () => {
  fs.rmSync(top(), { recursive: true, force: true });
  fs.mkdirSync(top(), { recursive: true });
};

/** A file the other side wrote. */
export const writeScratch = (name: string, text: string) => fs.writeFileSync(scratch(name), text);

/** A file under scratch/, or null when there is none. */
export const readScratch = (name: string): string | null => {
  try {
    return fs.readFileSync(scratch(name), "utf8");
  } catch {
    return null;
  }
};

/** What is in a directory under scratch/, sorted. */
export const scratchFiles = (dir = ""): string[] => fs.readdirSync(scratch(dir)).sort();

/** A symbolic link at `name` to `target`, another name under scratch/. */
export const linkScratch = (name: string, target: string) => fs.symlinkSync(scratch(target), scratch(name));

/** A FIFO at `name`: a reader that opened it without O_NONBLOCK would wait for a writer. */
export const fifoScratch = (name: string) => execFileSync("mkfifo", [scratch(name)]);

/** A directory at `name`. */
export const dirScratch = (name: string) => fs.mkdirSync(scratch(name), { recursive: true });

/** `name`, open for reading, as copy.ts's openPlain hands it on; closed when the test ends. */
export const opened = (name: string): { fd: number; size: number } => {
  const fd = fs.openSync(scratch(name), "r");
  onTestFinished(() => fs.closeSync(fd));
  return { fd, size: fs.fstatSync(fd).size };
};
