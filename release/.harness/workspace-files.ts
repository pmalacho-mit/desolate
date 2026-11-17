// Harness for in-source tests of workspace code that looks at a checkout's files: a checkout,
// stood in for by a temporary directory holding the files named (each "{}"), removed when the
// test finishes.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { onTestFinished } from "./vitest.ts";

/** A directory with these files in it, by relative path. */
export const projectWith = (files: string[]): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desolate-project-"));
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), "{}\n");
  }
  return dir;
};
