// What a change touches, from the map of features (features.ts): which features, so which
// suites to run again, which docs to read again, and which screenshots to take again.
//
//   node tests/v3/affected.ts [<base>]     changes since <base> (default origin/main), and
//                                          what is not committed yet
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { touched } from "./features.ts";

const root = path.resolve(import.meta.dirname, "..", "..");
const base = process.argv[2] ?? "origin/main";
const git = (...args: string[]) =>
  spawnSync("git", args, { cwd: root, encoding: "utf8" }).stdout.split("\n").filter(Boolean);
const files = [
  ...new Set([
    ...git("diff", "--name-only", `${base}...HEAD`),
    ...git("diff", "--name-only", "HEAD"),
    ...git("ls-files", "--others", "--exclude-standard", "release", "tests"),
  ]),
];
const features = touched(files);
const out = (line = "") => process.stdout.write(`${line}\n`);
out(`${files.length} file(s) changed since ${base}; ${features.length} feature(s) touched:`);
for (const f of features) out(`  ${f.id}: ${f.what}`);
const suites = [...new Set(features.flatMap((f) => f.tests))].sort();
const t2 = suites.filter((s) => s.startsWith("t2/"));
const t3 = suites.filter((s) => s.startsWith("t3/"));
out();
out("Run again:");
out("  T1, always: make test");
if (t2.length) {
  out("  T2, these suites (in a desolate workspace: tests/v3/README.md):");
  for (const s of t2) out(`    ${s}`);
}
if (features.some((f) => f.boundary))
  out(
    `  T4 on the Mac (a boundary is touched: ${features
      .filter((f) => f.boundary)
      .map((f) => f.id)
      .join(", ")}): TMPDIR=~/t tests/v3/run.sh t4${t3.length ? `   (${t3.join(", ")})` : ""}`,
  );
const docs = [...new Set(features.flatMap((f) => f.docs))];
if (docs.length) {
  out();
  out("Read again, and say what changed:");
  for (const d of docs) out(`  ${d}`);
}
const shots = [...new Set(features.flatMap((f) => f.shots))];
if (shots.length) {
  out();
  out("Take again, and look at:");
  out(`  SHOTS=${shots.join(",")} node tests/v3/demo/screenshots.ts   (its header says how)`);
}
