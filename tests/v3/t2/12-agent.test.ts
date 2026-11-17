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
});
