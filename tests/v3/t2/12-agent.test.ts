// T2 (fake backend). `desolate agent`: an agent kept running in a workspace without tmux,
// attachable from the person's own terminal (workspace/agent-holder.py, host/agent.ts).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { bootstrap, git, newStack, REPO_ROOT } from "../lib/harness.ts";
import type { Stack } from "../lib/harness.ts";

let stack: Stack;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("T2 desolate agent: kept running, attached to, stopped", () => {
  before(() => {
    stack = newStack("agent");
    stack.seed("acme/widgets", (dir) => {
      fs.writeFileSync(path.join(dir, "README.md"), "# widgets\n");
      git(dir, "add", "-A");
      git(dir, "commit", "--quiet", "-m", "seed");
    });
    assert.equal(bootstrap(stack).code, 0);
    assert.equal(stack.quiet("clone", "acme/widgets", "--no-domain").code, 0);
    assert.equal(stack.quiet("domain", "create", "dev", "--repo", "acme/widgets").code, 0);
    const up = stack.quiet("up", "dev", "--name", "w1", "--branch", "task/one");
    assert.equal(up.code, 0, up.stderr);
  });
  after(() => stack.destroy());

  it("an agent runs in the workspace's checkout, is listed, keeps a log, takes input, and stops", async () => {
    const started = stack.desolate(
      "agent",
      "start",
      "dev/w1",
      "--name",
      "echo",
      "--",
      "bash",
      "-c",
      'echo "in $(pwd)"; while read -r line; do echo "you said: $line"; done',
    );
    assert.equal(started.code, 0, started.stderr);
    assert.match(started.stdout, /agent echo is running in dev\/w1 \(acme\/widgets\)/);
    let listed = "";
    for (let i = 0; i < 20 && !/echo {2}running/.test(listed); i++) {
      listed = stack.desolate("agent", "list", "dev").stdout;
      if (!/echo {2}running/.test(listed)) await sleep(250);
    }
    assert.match(listed, /dev\/w1 {2}echo {2}running/);
    assert.equal(
      stack.desolate("agent", "start", "dev/w1", "--name", "echo", "--", "true").code,
      1,
      "one agent of a name at a time",
    );
    // What the person types in an attach reaches it (the holder's own protocol, as host/agent.ts speaks it).
    const typed = Buffer.from("hello agent\r").toString("base64");
    stack.desolate(
      "exec",
      "dev/w1",
      "--vm",
      "--",
      "bash",
      "-c",
      `printf 'i %s\\n' ${typed} | timeout 3 python3 -I /desolate/release/workspace/agent-holder.py attach echo >/dev/null; true`,
    );
    let log = "";
    for (let i = 0; i < 20 && !/you said: hello agent/.test(log); i++) {
      log = stack.desolate("agent", "log", "dev/w1", "--name", "echo").stdout;
      if (!/you said: hello agent/.test(log)) await sleep(250);
    }
    assert.match(
      log,
      /in \/workspaces\/acme\/widgets\/\.worktrees\/task-one/,
      "in the workspace's checkout",
    );
    assert.match(log, /you said: hello agent/);
    assert.equal(stack.desolate("agent", "stop", "dev/w1", "--name", "echo").code, 0);
    for (let i = 0; i < 40 && !/echo {2}exited/.test(listed); i++) {
      listed = stack.desolate("agent", "list", "dev/w1").stdout;
      if (!/echo {2}exited/.test(listed)) await sleep(250);
    }
    assert.match(
      listed,
      /echo {2}exited/,
      "stopped as a person would: interrupted, through its own terminal",
    );
    assert.equal(
      stack.desolate("agent", "start", "dev/w1", "--name", "../x", "--", "true").code,
      64,
      "a name is a name",
    );
  });

  it("the agent recipe: a sentence becomes a workspace on its own branch, a program at work in it, and an offer", async () => {
    // A recipe is a script of ordinary desolate commands (release/recipes/): run here as a
    // person runs it, with this stack's environment.
    const recipe = (...args: string[]) => {
      const ran = spawnSync(path.join(REPO_ROOT, "release", "recipes", "agent.sh"), args, {
        env: stack.env,
        encoding: "utf8",
      });
      return { code: ran.status ?? 1, stdout: ran.stdout, stderr: ran.stderr };
    };
    const agent = ["--", "bash", "/desolate/release/recipes/echo-agent.sh"];
    const started = recipe("dev", "Add a shout() greeting", ...agent);
    assert.equal(started.code, 0, started.stderr);
    assert.match(
      started.stdout,
      /dev\/add-a-shout-greeting: working on it, on task\/add-a-shout-greeting\.\n {2}watch it: {3}desolate agent attach dev\/add-a-shout-greeting/,
    );
    // The stand-in agent writes its task down, commits, offers the branch and goes green.
    let offers: { branch: string; workspace: string }[] = [];
    for (let i = 0; i < 120 && !offers.some((o) => o.branch === "task/add-a-shout-greeting"); i++) {
      offers = JSON.parse(stack.desolate("offers", "dev", "--json").stdout || "[]");
      if (!offers.some((o) => o.branch === "task/add-a-shout-greeting")) await sleep(500);
    }
    assert.ok(
      offers.some(
        (o) => o.branch === "task/add-a-shout-greeting" && o.workspace === "add-a-shout-greeting",
      ),
      JSON.stringify(offers),
    );
    const log = stack.desolate("agent", "log", "dev/add-a-shout-greeting").stdout;
    assert.match(log, /task: Add a shout\(\) greeting/, "the sentence is the agent's task");
    // The same sentence again: a workspace of its own, never the first one's.
    const again = recipe("dev", "Add a shout() greeting", ...agent);
    assert.equal(again.code, 0, again.stderr);
    assert.match(
      again.stdout,
      /dev\/add-a-shout-greeting-2: working on it, on task\/add-a-shout-greeting-2/,
    );
    // Refused before anything is made.
    assert.equal(recipe("dev").code, 64, "a task is a domain, a sentence and a command");
    assert.equal(recipe("dev", "Do it").code, 64, "... and the command");
    assert.notEqual(
      recipe("nowhere", "Do it", ...agent).code,
      0,
      "no such domain: `desolate up` refuses, and the recipe stops there",
    );
    // The old command says where it went.
    const old = stack.desolate("task", "dev", "Do it");
    assert.equal(old.code, 64);
    assert.match(old.stderr, /'desolate task' is a recipe now/);
    for (const name of ["add-a-shout-greeting", "add-a-shout-greeting-2"])
      stack.desolate("agent", "stop", `dev/${name}`);
  });

  it("the issues recipe reads every labelled issue, and stops an agent only for an issue GitHub says is closed", async () => {
    // GitHub, through a stand-in for the person's gh (tests/v3/forge/gh.sh): 120 labelled open
    // issues, newest first, so #20 is the 101st; #130 open without the label; #150 closed.
    const bin = path.join(stack.work, "gh-bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.symlinkSync(path.join(REPO_ROOT, "tests", "v3", "forge", "gh.sh"), path.join(bin, "gh"));
    const env = { ...stack.env, PATH: `${bin}:${stack.env.PATH}` };
    const recipe = (more: NodeJS.ProcessEnv = {}) => {
      const ran = spawnSync(
        path.join(REPO_ROOT, "release", "recipes", "issues.sh"),
        ["--repo", "acme/widgets", "--domain", "dev", "--max", "1", "--", "true"],
        { env: { ...env, ...more }, encoding: "utf8" },
      );
      return { code: ran.status ?? 1, stdout: ran.stdout, stderr: ran.stderr };
    };
    // Control: the list as the recipe read it before (its first 100) does not have #20.
    const before = spawnSync(
      "gh",
      [
        ...["issue", "list", "--repo", "acme/widgets", "--label", "desolate:run", "--state"],
        ...["open", "--limit", "100", "--json", "number", "--jq", ".[].number"],
      ],
      { env, encoding: "utf8" },
    );
    assert.equal(before.status, 0, before.stderr);
    assert.equal(before.stdout.split("\n").filter(Boolean).length, 100);
    assert.ok(!before.stdout.split("\n").includes("20"), "control: #20 is past the first 100");
    // An agent at work on each of the three, as the recipe would have started them.
    const running = () =>
      (
        JSON.parse(stack.desolate("agent", "list", "dev", "--json").stdout || "[]") as {
          workspace: string;
          state: string;
        }[]
      )
        .filter((a) => a.state === "running" && a.workspace.startsWith("dev/issue-"))
        .map((a) => a.workspace)
        .sort();
    for (const n of ["20", "130", "150"]) {
      const up = stack.quiet("up", "dev", "--name", `issue-${n}`, "--branch", `issue/${n}`);
      assert.equal(up.code, 0, up.stderr);
      const started = stack.desolate(
        ...["agent", "start", `dev/issue-${n}`, "--name", "agent", "--"],
        ...["bash", "-c", "while sleep 1; do :; done"],
      );
      assert.equal(started.code, 0, started.stderr);
    }
    for (let i = 0; i < 40 && running().length < 3; i++) await sleep(250);
    assert.deepEqual(running(), ["dev/issue-130", "dev/issue-150", "dev/issue-20"]);

    // GitHub down: nothing is done, and the pass says why.
    const down = recipe({ GH_FAILS: "1" });
    assert.equal(down.code, 1);
    assert.match(
      down.stderr,
      /the issues of acme\/widgets labelled desolate:run could not be listed: nothing was done this pass/,
    );
    assert.deepEqual(running(), ["dev/issue-130", "dev/issue-150", "dev/issue-20"]);

    const pass = recipe();
    assert.equal(pass.code, 0, pass.stderr);
    assert.doesNotMatch(pass.stdout, /#20\b/, "the 101st is read, and is at work: nothing to say");
    assert.match(
      pass.stdout,
      /^#130 is open, without the label desolate:run: its agent is left running \(to stop it: desolate agent stop dev\/issue-130 --name agent\)$/m,
    );
    assert.match(
      pass.stdout,
      /^#150 is closed: stopping its agent \(the workspace stays: desolate rm dev\/issue-150\)$/m,
    );
    // The rest wait, said once: 119 (120 labelled issues, the pull request left out, #20 at work).
    assert.match(
      pass.stdout,
      /^--max 1 are working: 119 wait for the next pass \(#120 #119 .* #21 #19 .* #1\)$/m,
    );
    assert.doesNotMatch(pass.stdout, /#121/, "a pull request is not an issue");
    for (let i = 0; i < 40 && running().length > 2; i++) await sleep(250);
    assert.deepEqual(
      running(),
      ["dev/issue-130", "dev/issue-20"],
      "only the closed one's agent stopped",
    );
    for (const n of ["20", "130"])
      stack.desolate("agent", "stop", `dev/issue-${n}`, "--name", "agent");
  });
});
