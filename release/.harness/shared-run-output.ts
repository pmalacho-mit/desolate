// Harness for the in-source tests of shared/run.ts's output: where it goes and how it is
// counted. Output a test cannot write as a literal (a file it went to, bytes split across
// two writes).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { run } from "../shared/run.ts";

/** Runs `script` (sh) with its stdout sent to a new file: the answer, and what the file holds. */
export const toFile = async (script: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desolate-run-"));
  const file = path.join(dir, "out");
  try {
    const answer = await run("sh", ["-c", script], { stdoutTo: file });
    return { ...answer, file: fs.readFileSync(file, "utf8") };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};
