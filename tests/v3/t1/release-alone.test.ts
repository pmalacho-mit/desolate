// T1: release/ without suede.nests. The in-source tests beside the code `import type` the DSL
// from the development checkout's .suede/nests, which the release branch does not have. Their
// import, and the namespaces, are erased when node runs the code, so the release needs nothing
// at runtime; release/nests.d.ts (suede.nests' optional-dependency stub) is what lets the same
// files type-check there, and release/nests-harness.d.ts does the same for the tests' harness
// modules (tests/nests). This copies release/ out of the checkout and checks both, each beside
// a control that shows the check can tell.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

const repo = path.resolve(import.meta.dirname, "../../..");
const tsc = path.join(repo, "node_modules/.bin/tsc");
let copy: string;

const typeCheck = () =>
  spawnSync(tsc, ["-p", copy], { encoding: "utf8" });

describe("T1 release/ alone, without suede.nests", () => {
  before(() => {
    copy = fs.mkdtempSync(path.join(os.tmpdir(), "desolate-release-alone-"));
    fs.cpSync(path.join(repo, "release"), copy, { recursive: true });
    // The development checkout's compiler options, for the copy's files; @types/node from here.
    const options = JSON.parse(
      fs.readFileSync(path.join(repo, "tsconfig.json"), "utf8").replace(/^\s*\/\/.*$/gm, ""),
    ).compilerOptions;
    fs.writeFileSync(path.join(copy, "tsconfig.json"), JSON.stringify({
      compilerOptions: { ...options, typeRoots: [path.join(repo, "node_modules/@types")] },
      include: ["**/*.ts"],
    }));
  });
  after(() => fs.rmSync(copy, { recursive: true, force: true }));

  it("has in-source tests to check, importing from a path the copy does not have", () => {
    const marked = execFileSync("grep", ["-rl", "--include=*.ts", "dsl.import.meta.vitest", copy], { encoding: "utf8" })
      .trim().split("\n").filter((file) => !file.endsWith("nests.d.ts"));
    assert.ok(marked.length > 10, `files with in-source tests: ${marked.length}`);
    assert.ok(!fs.existsSync(path.join(copy, "../.suede/nests")), "nothing beside the copy");
  });

  it("type-checks, with the stub", () => {
    const run = typeCheck();
    assert.equal(run.status, 0, run.stdout + run.stderr);
  });

  it("runs: what node strips leaves nothing of suede.nests or a harness in any file", () => {
    const marked = execFileSync("grep", ["-rlE", "--include=*.ts", "import\\.meta\\.vitest|\\.harness\\.ts", copy], { encoding: "utf8" })
      .trim().split("\n").filter((file) => !file.endsWith(".d.ts"));
    assert.ok(marked.length > 10);
    for (const file of marked) {
      const ran = stripTypeScriptTypes(fs.readFileSync(file, "utf8"));
      assert.doesNotMatch(ran, /dsl\.import\.meta\.vitest|\.harness\.ts/, `${path.relative(copy, file)}: an import that is not \`import type\``);
    }
  });

  it("the control: a value import of the DSL is not stripped, and would fail where it is not", () => {
    const ran = stripTypeScriptTypes(`import { Expect } from "../../.suede/nests/dsl.import.meta.vitest.ts";\nexport const x = 1;\n`);
    assert.match(ran, /dsl\.import\.meta\.vitest/);
  });

  it("the control: without the stubs, the same copy does not type-check", () => {
    fs.rmSync(path.join(copy, "nests.d.ts"));
    fs.rmSync(path.join(copy, "nests-harness.d.ts"));
    const run = typeCheck();
    assert.notEqual(run.status, 0);
    assert.match(run.stdout, /TS2307: Cannot find module '[./]+\.suede\/nests\/dsl\.import\.meta\.vitest\.ts'/);
    assert.match(run.stdout, /TS2307: Cannot find module '[./]+tests\/nests\/[a-z-]+\.harness\.ts'/);
  });
});
