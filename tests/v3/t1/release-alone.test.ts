// T1: release/ without suede.nests. The in-source tests beside the code `import type` the DSL
// from the development checkout's suede.nests, which the release branch does not have, and
// their harness from release/.harness, which it does. Both imports, and the namespaces, are
// erased when node runs the code, so the release needs neither at runtime; release/nests.d.ts
// (suede.nests' optional-dependency stub) is what lets the same files type-check there, and
// .harness/vitest.ts keeps the harness from naming Vitest to the type checker. This copies
// release/ out of the checkout and checks both, each beside a control that shows the check
// can tell.
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
      include: ["**/*.ts", ".harness/*.ts"],
    }));
  });
  after(() => fs.rmSync(copy, { recursive: true, force: true }));

  it("has in-source tests to check, importing the DSL from a path the copy does not have", () => {
    const marked = execFileSync("grep", ["-rl", "--include=*.ts", "dsl.import.meta.vitest", copy], { encoding: "utf8" })
      .trim().split("\n").filter((file) => !file.endsWith("nests.d.ts"));
    assert.ok(marked.length > 10, `files with in-source tests: ${marked.length}`);
    assert.ok(!fs.existsSync(path.join(copy, "../suede.nests")), "nothing beside the copy");
    assert.ok(fs.existsSync(path.join(copy, ".harness/home.ts")), "the harness is in the copy");
  });

  it("type-checks, with the stub: the code, its tests, and the harness", () => {
    const run = spawnSync(tsc, ["-p", copy, "--listFilesOnly"], { encoding: "utf8" });
    assert.match(run.stdout, /\/\.harness\/setup\.ts$/m, "the harness is type-checked too");
    const checked = typeCheck();
    assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  });

  it("runs: what node strips leaves no import of suede.nests or of the harness in any file", () => {
    const marked = execFileSync("grep", ["-rlE", "--include=*.ts", "import\\.meta\\.vitest|\\.harness/", copy], { encoding: "utf8" })
      .trim().split("\n").filter((file) => !file.endsWith(".d.ts") && !file.includes("/.harness/"));
    assert.ok(marked.length > 10);
    for (const file of marked) {
      const ran = stripTypeScriptTypes(fs.readFileSync(file, "utf8"));
      assert.doesNotMatch(ran, /dsl\.import\.meta\.vitest|\.harness\//, `${path.relative(copy, file)}: an import that is not \`import type\``);
    }
  });

  it("the control: a value import is not stripped, and would load the harness or fail", () => {
    const ran = stripTypeScriptTypes(`import { Expect } from "../../suede.nests/dsl.import.meta.vitest.ts";\nimport { emptyHome } from "../.harness/home.ts";\nexport const x = 1;\n`);
    assert.match(ran, /dsl\.import\.meta\.vitest/);
    assert.match(ran, /\.harness\/home\.ts/);
  });

  it("the control: without the stub, the same copy does not type-check, and Vitest named plainly would not either", () => {
    fs.rmSync(path.join(copy, "nests.d.ts"));
    fs.writeFileSync(path.join(copy, ".harness/plainly.ts"), `import { onTestFinished } from "vitest";\nexport const plainly = onTestFinished;\n`);
    const run = typeCheck();
    assert.notEqual(run.status, 0);
    assert.match(run.stdout, /TS2307: Cannot find module '[./]+suede\.nests\/dsl\.import\.meta\.vitest\.ts'/);
    assert.match(run.stdout, /\.harness\/plainly\.ts.*TS2307: Cannot find module 'vitest'/);
  });
});
