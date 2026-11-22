// T1: the map of features (tests/v3/features.ts) is whole and true. Every file desolate
// ships belongs to a feature, so a change to it says which suites, docs and screenshots to
// look at again (tests/v3/affected.ts); and every suite, doc part and screenshot the map names
// exists, so what it says to run can be run.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { covers, FEATURES } from "../features.ts";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
// Not desolate's own (suede's machinery, a vendored terminal), the docs' pictures, and the
// in-source tests' harness (which ships, but only as types).
const SKIP = [
  "release/.suede/",
  "release/.github/",
  "release/docs/assets/",
  "release/host/git-ui/vendor/",
  "release/.harness/",
];

describe("T1 the map of features", () => {
  it("every file desolate ships belongs to a feature", () => {
    const files = spawnSync("git", ["ls-files", "release"], { cwd: ROOT, encoding: "utf8" })
      .stdout.split("\n")
      .filter((f) => f && !SKIP.some((skip) => f.startsWith(skip)));
    assert.ok(files.length > 100, `git listed ${files.length} files`);
    const loose = files.filter((f) => !FEATURES.some((feature) => covers(feature.code, f)));
    assert.deepEqual(loose, [], "add each to a feature in tests/v3/features.ts");
  });

  it("every T2 and T3 suite is named by a feature, so a change can find it", () => {
    const named = new Set(FEATURES.flatMap((f) => f.tests));
    const suites = ["t2", "t3"].flatMap((tier) =>
      fs
        .readdirSync(path.join(ROOT, "tests/v3", tier))
        .filter((f) => f.endsWith(".test.ts"))
        .map((f) => `${tier}/${f.slice(0, -".test.ts".length)}`),
    );
    assert.deepEqual(
      suites.filter((s) => !named.has(s)),
      [],
      "add each to a feature's tests in tests/v3/features.ts",
    );
  });

  it("every suite, doc part and screenshot it names exists", () => {
    const shots = fs.readFileSync(path.join(ROOT, "tests/v3/demo/screenshots.ts"), "utf8");
    const named = /SHOTS=([a-z,]+)/.exec(shots)?.[1]?.split(",") ?? [];
    for (const f of FEATURES) {
      for (const suite of f.tests)
        assert.ok(
          fs.existsSync(path.join(ROOT, "tests/v3", `${suite}.test.ts`)),
          `${f.id}: ${suite}`,
        );
      for (const doc of f.docs) {
        const [file, parts] = doc.split(": ");
        const text = fs.readFileSync(path.join(ROOT, file!), "utf8");
        for (const part of parts ? parts.split(/, (?=[A-Z0-9])/) : [])
          assert.ok(text.includes(part), `${f.id}: ${file} has no "${part}"`);
      }
      for (const shot of f.shots)
        assert.ok(named.includes(shot), `${f.id}: no screenshot "${shot}"`);
      for (const entry of f.code)
        assert.ok(fs.existsSync(path.join(ROOT, entry)), `${f.id}: ${entry} does not exist`);
    }
  });
});
