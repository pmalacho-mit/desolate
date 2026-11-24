// T1. Every verb refuses a flag it does not know, as a usage error (exit 64), before it does
// anything: a misspelt flag (`--dryrun`, `--chekout`) is never quietly ignored or passed on.
// And the verbs the CLI has are the verbs completion offers. `--help` (or `-h`) on any verb
// prints its help and runs nothing: once, `desolate destroy --help` destroyed the stack.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { pathToFileURL } from "node:url";

const RELEASE = path.resolve(import.meta.dirname, "../../../release");
// The tests' stand-in for VMs, loaded as every test run loads it: no real VM is touched.
const FAKE = `--import=${pathToFileURL(path.resolve(import.meta.dirname, "../lib/fake-backend.ts")).href}`;
const home = fs.mkdtempSync(path.join(os.tmpdir(), "desolate-flags-"));
after(() => fs.rmSync(home, { recursive: true, force: true }));
// No stack: a verb that went past its flags would fail some other way (or take its time).
const run = (...args: string[]) =>
  spawnSync(path.join(RELEASE, "cli.sh"), args, {
    encoding: "utf8",
    timeout: 20_000,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      DESOLATE_HOME: home,
      DESOLATE_INSTANCE: "flagtest",
      NODE_OPTIONS: FAKE,
    },
  });

const completionVerbs = () =>
  /words="(bootstrap [^"]+)"/
    .exec(fs.readFileSync(path.join(RELEASE, "completion.bash"), "utf8"))![1]!
    .split(" ");

describe("T1 the CLI's flags", () => {
  // (Verbs whose subcommand comes first are given one.)
  const lines: Record<string, string[]> = {
    domain: ["domain", "dev", "show"],
    root: ["root", "shell"],
    net: ["net", "log"],
    agent: ["agent", "list"],
    suede: ["suede", "changed", "a/b", "0".repeat(40)],
  };
  for (const verb of completionVerbs().filter((verb) => verb !== "help" && verb !== "completion"))
    it(`${verb}: an unknown flag is a usage error`, () => {
      const result = run(...(lines[verb] ?? [verb]), "--no-such-flag");
      assert.equal(
        result.status,
        64,
        `${verb} exited ${result.status}: ${result.stderr.slice(0, 300)}`,
      );
      assert.match(result.stderr, /no-such-flag/);
    });

  for (const verb of completionVerbs().filter((verb) => verb !== "help" && verb !== "completion"))
    it(`${verb} --help: the help, and nothing run`, () => {
      const result = run(...(lines[verb] ?? [verb]), "--help");
      assert.equal(
        result.status,
        0,
        `${verb} exited ${result.status}: ${result.stderr.slice(0, 300)}`,
      );
      assert.match(result.stdout, new RegExp(`desolate (?:[\\w-]+ \\| )*${verb}\\b`));
      assert.equal(result.stderr, "");
    });

  it("destroy --all --help leaves the stack's home; destroy --all, the control, does not", () => {
    const stack = fs.mkdtempSync(path.join(os.tmpdir(), "desolate-help-"));
    after(() => fs.rmSync(stack, { recursive: true, force: true }));
    const marker = path.join(stack, "marker");
    fs.writeFileSync(marker, "");
    const env = {
      PATH: process.env.PATH,
      HOME: stack,
      DESOLATE_HOME: stack,
      DESOLATE_INSTANCE: "helptest",
      NODE_OPTIONS: FAKE,
    };
    const destroy = (...args: string[]) =>
      spawnSync(path.join(RELEASE, "cli.sh"), ["destroy", "--all", ...args], {
        encoding: "utf8",
        timeout: 60_000,
        env,
      });
    for (const asked of ["--help", "-h"]) {
      const helped = destroy(asked);
      assert.equal(helped.status, 0, helped.stderr);
      assert.match(helped.stdout, /desolate destroy \[--all\]/);
      assert.ok(fs.existsSync(marker), `destroy --all ${asked} removed the stack's home`);
    }
    // The control: without --help it goes to work. It removes the home where the stand-in VMs'
    // Docker answers, and fails reaching it where there is none (a Mac without Colima running).
    const control = destroy();
    assert.ok(
      !fs.existsSync(marker) || (control.status !== 0 && /docker/.test(control.stderr)),
      `the control neither destroyed nor tried to: ${control.status} ${control.stderr.slice(0, 300)}`,
    );
  });

  it("-h after -- is the other program's, not desolate's", () => {
    // `exec` with no stack fails reaching it: it went past its flags, and did not print help.
    const result = run("exec", "acme/w1", "--", "ls", "-h");
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /desolate exec/);
  });
});
