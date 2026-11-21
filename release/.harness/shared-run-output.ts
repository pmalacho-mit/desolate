// Harness for the in-source tests of shared/run.ts's output: where it goes and how it is
// counted. Output a test cannot write as a literal (a file it went to, bytes split across
// two writes).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { run } from "../shared/run.ts";

/** This process's open descriptors, as the system lists them. */
const descriptors = () =>
  fs.readdirSync(process.platform === "linux" ? "/proc/self/fd" : "/dev/fd").length;

/** Runs `script` (sh, then `also` as more arguments) with its stdout sent to a new file: the
 *  answer, what the file holds, and whether as many descriptors are open after as before. */
export const toFile = async (script: string, also: string[] = []) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desolate-run-"));
  const file = path.join(dir, "out");
  try {
    const before = descriptors();
    const answer = await run("sh", ["-c", script, ...also], { stdoutTo: file });
    const open = descriptors() === before ? "as before" : `${descriptors() - before} more`;
    return { ...answer, file: fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "", open };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};
