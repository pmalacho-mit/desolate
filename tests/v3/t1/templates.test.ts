// T1. A domain's template (section 4.7, C3): what it is keyed by, and what it is called.
// (Building one needs a registry the tests do not have; the M1's numbers are in
// docs/v3/decisions.md, "A domain's template".)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { workspaceVmName } from "../../../release/shared/names.ts";
import { keyOf, templateVm, UNBRANCH } from "../../../release/host/templates.ts";

describe("T1 a domain's template", () => {
  const env = { repo: "acme/widgets", spec: ".devcontainer", id: "a".repeat(40) };
  it("is keyed by the spec as published: another tree, another file, another repository is another template", () => {
    assert.equal(keyOf(env), keyOf({ ...env }), "the same spec, the same key");
    assert.notEqual(keyOf(env), keyOf({ ...env, id: "b".repeat(40) }));
    assert.notEqual(keyOf(env), keyOf({ ...env, spec: ".devcontainer.json" }));
    assert.notEqual(keyOf(env), keyOf({ ...env, repo: "acme/other" }));
    assert.match(keyOf(env), /^[0-9a-f]{16}$/);
  });
  it("is named for its domain and key, never like a workspace's VM, and as long as one", () => {
    const name = templateVm("web", keyOf(env));
    assert.match(name, /^dsl-[a-z0-9]+-t[0-9a-f]{9}$/);
    assert.notEqual(
      name,
      templateVm("api", keyOf(env)),
      "one domain's template is never another's",
    );
    const workspace = workspaceVmName("main", "web", "w1");
    assert.equal(name.replace(/^dsl-main-/, "").length, workspace.replace(/^dsl-main-/, "").length);
    assert.doesNotMatch(
      name,
      /^dsl-[a-z0-9]+-[0-9a-f]{10}$/,
      "a workspace VM's name is ten hex digits; a template's starts with t",
    );
  });
});

describe("T1 a template's build leaves no branch in the domain", () => {
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  /** A domain clone on main, and the build's worktree made as workspace/init.ts makes one. */
  const made = () => {
    const clone = fs.mkdtempSync(path.join(os.tmpdir(), "desolate-unbranch-"));
    git(clone, "init", "-q", "-b", "main");
    git(clone, "config", "user.email", "t@example.com");
    git(clone, "config", "user.name", "t");
    fs.writeFileSync(path.join(clone, ".gitignore"), "node_modules/\n");
    git(clone, "add", ".");
    git(clone, "commit", "-qm", "first");
    const wt = path.join(clone, ".worktrees", "template");
    git(clone, "worktree", "add", "-q", "--no-track", "-b", "template", wt, "main");
    git(clone, "worktree", "lock", wt);
    // What the build wrote: ignored, its output.
    fs.mkdirSync(path.join(wt, "node_modules"));
    fs.writeFileSync(path.join(wt, "node_modules", "x.js"), "");
    return { clone, wt };
  };
  const unbranch = (clone: string, wt: string) =>
    spawnSync("sh", ["-c", UNBRANCH, "unbranch", clone, wt, "template", "main"], {
      encoding: "utf8",
    });
  const branches = (clone: string) => git(clone, "branch", "--format=%(refname:short)");

  it("the build's own worktree and branch go", () => {
    const { clone, wt } = made();
    try {
      assert.equal(branches(clone), "main\ntemplate", "the branch is there before");
      assert.equal(unbranch(clone, wt).status, 0);
      assert.equal(branches(clone), "main");
      assert.ok(!fs.existsSync(wt));
    } finally {
      fs.rmSync(clone, { recursive: true, force: true });
    }
  });

  it("CONTROLS: a commit of its own, or a change in it, and both stay", () => {
    const { clone, wt } = made();
    try {
      fs.writeFileSync(path.join(wt, "work.txt"), "mine");
      assert.equal(unbranch(clone, wt).status, 0);
      assert.ok(fs.existsSync(path.join(wt, "work.txt")), "an uncommitted file is kept");
      assert.equal(branches(clone), "main\ntemplate");
      git(wt, "add", "work.txt");
      git(wt, "commit", "-qm", "mine");
      assert.equal(unbranch(clone, wt).status, 0);
      assert.equal(branches(clone), "main\ntemplate", "a branch with a commit of its own is kept");
      assert.ok(fs.existsSync(wt));
    } finally {
      fs.rmSync(clone, { recursive: true, force: true });
    }
  });
});
