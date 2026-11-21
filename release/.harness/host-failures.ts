// Harness for the in-source tests of release/host/failures.ts: a program's output of many
// lines, and what the host kept of failures under the test file's own home (setup.ts).
import * as fs from "node:fs";
import * as path from "node:path";

/** Output of `count` lines: "line 1" to "line <count>". */
export const lines = (count: number): string =>
  Array.from({ length: count }, (_, i) => `line ${i + 1}\n`).join("");

/** Each failure kept, oldest first: what failed (from its file's name), how many lines of it
 *  were kept, and the file's mode. */
export const keptFailures = (): { what: string; lines: number; mode: string }[] => {
  const dir = path.join(process.env.DESOLATE_HOME!, "logs", "failures");
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
  return names.map((name) => ({
    what: /^[0-9TZ-]+?Z-(.*)\.txt$/.exec(name)?.[1] ?? name,
    lines: fs.readFileSync(path.join(dir, name), "utf8").trimEnd().split("\n").length,
    mode: (fs.statSync(path.join(dir, name)).mode & 0o777).toString(8),
  }));
};
