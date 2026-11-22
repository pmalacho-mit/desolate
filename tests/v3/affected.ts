// What a change touches, from the map of features (features.ts): which features, so which
// suites to run again, which docs to read again, and which screenshots to take again.
//
//   node tests/v3/affected.ts [<base>]        changes since <base> (default origin/main), and
//                                             what is not committed yet
//   node tests/v3/affected.ts --t2 [<base>]   only the T2 suites to run, a path a line
//                                             (tests/v3/run.sh affected runs them)
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { touched } from "./features.ts";

const root = path.resolve(import.meta.dirname, "..", "..");
const args = process.argv.slice(2);
const onlyT2 = args[0] === "--t2";
const base = (onlyT2 ? args[1] : args[0]) ?? "origin/main";
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
// A suite changed is run again itself; what every suite runs on (the harness, the stand-in
// forge, the runner) is run again by all of them.
const allT2 = files.some((f) =>
  ["tests/v3/lib/", "tests/v3/forge/", "tests/v3/run.sh"].some((p) => f.startsWith(p)),
);
const changedSuites = files
  .map((f) => /^tests\/v3\/(t[23]\/[^/]+)\.test\.ts$/.exec(f)?.[1])
  .filter((s): s is string => !!s && fs.existsSync(path.join(root, "tests/v3", `${s}.test.ts`)));
const suites = [
  ...new Set([
    ...features.flatMap((f) => f.tests),
    ...changedSuites,
    ...(allT2
      ? fs
          .readdirSync(path.join(root, "tests/v3/t2"))
          .filter((f) => f.endsWith(".test.ts"))
          .map((f) => `t2/${f.slice(0, -".test.ts".length)}`)
      : []),
  ]),
].sort();
const t2 = suites.filter((s) => s.startsWith("t2/"));
const t3 = suites.filter((s) => s.startsWith("t3/"));
const out = (line = "") => process.stdout.write(`${line}\n`);
if (onlyT2) {
  for (const s of t2) out(`tests/v3/${s}.test.ts`);
  process.exit(0);
}
out(`${files.length} file(s) changed since ${base}; ${features.length} feature(s) touched:`);
for (const f of features) out(`  ${f.id}: ${f.what}`);
if (allT2) out("  the tests' harness, forge or runner: every T2 suite");
out();
out("Run again (tests/v3/run.sh affected does the first two):");
out("  T1, always: make test");
if (t2.length) {
  out("  T2, these suites (in a desolate workspace: tests/v3/README.md):");
  for (const s of t2) out(`    ${s}`);
}
if (features.some((f) => f.boundary) || t3.length)
  out(
    `  T4 on the Mac (${
      features.some((f) => f.boundary)
        ? `a boundary is touched: ${features
            .filter((f) => f.boundary)
            .map((f) => f.id)
            .join(", ")}`
        : "a T4 suite changed"
    }): TMPDIR=~/t tests/v3/run.sh t4${t3.length ? `   (${t3.join(", ")})` : ""}`,
  );
out("  The whole of T2 (tests/v3/run.sh t2) before a merge into main.");
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
