// T1. After a squashed push (shared/approval.ts): which commit of a branch the remote's branch
// is a squash of, and the command that carries the branch on from it, run in a real git
// repository: the commits after the squash kept, a merge kept as a merge, work not committed
// put back.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { catchUp, squashedFrom } from "../../../release/shared/approval.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desolate-squashed-"));
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};
const git = (...args: string[]) => {
  const ran = spawnSync("git", args, { cwd: dir, env, encoding: "utf8" });
  if (ran.status !== 0) throw new Error(`git ${args.join(" ")}: ${ran.stderr}`);
  return ran.stdout.trim();
};
const run = async (args: string[]) => {
  const ran = spawnSync("git", args, { cwd: dir, env, encoding: "utf8" });
  return { code: ran.status ?? 1, stdout: ran.stdout };
};
const write = (file: string, text: string) => fs.writeFileSync(path.join(dir, file), text);

git("init", "-q", "-b", "main");
git("commit", "-q", "--allow-empty", "-m", "base");
git("switch", "-q", "-c", "fix");
write("f", "one\n");
git("add", "f");
git("commit", "-q", "-m", "first");
write("f", "one\ntwo\n");
git("commit", "-q", "-am", "second");
const squashed = git("rev-parse", "HEAD");
// The squash the reviewer makes: the last commit's files, on where the branch leaves main.
const squash = git("commit-tree", "-p", "main", "-m", "squash", `${squashed}^{tree}`);
git("update-ref", "refs/remotes/origin/fix", squash);

describe("T1 after a squashed push", () => {
  it("names the commit of the branch the remote's branch is a squash of", async () => {
    assert.equal(await squashedFrom(run, squash, squashed), squashed);
    // CONTROL: a remote branch with other files is no squash of it.
    write("g", "else\n");
    git("add", "g");
    const other = git("commit-tree", "-p", "main", "-m", "other", git("write-tree"));
    git("reset", "-q", "HEAD", "g");
    fs.rmSync(path.join(dir, "g"));
    assert.equal(await squashedFrom(run, other, squashed), null);
    // Nor is a merge on the remote, whatever its files.
    const merged = git(
      "commit-tree",
      "-p",
      "main",
      "-p",
      squashed,
      "-m",
      "merge",
      `${squashed}^{tree}`,
    );
    assert.equal(await squashedFrom(run, merged, squashed), null);
  });

  it("the command keeps what was committed since, a merge as a merge, and uncommitted work", () => {
    git("switch", "-q", "main");
    write("m", "main moves\n");
    git("add", "m");
    git("commit", "-q", "-m", "main moves");
    const mainMoves = git("rev-parse", "HEAD");
    git("switch", "-q", "fix");
    git("merge", "-q", "--no-edit", "main");
    write("f", "one\ntwo\nthree\n");
    git("commit", "-q", "-am", "after");
    write("f", "one\ntwo\nthree\nnot yet\n");
    // (`git fetch` needs a remote: the rest of the command, as printed.)
    const command = catchUp("fix", squashed, "fix").replace(/^git fetch && /, "");
    const ran = spawnSync("bash", ["-c", command], { cwd: dir, env, encoding: "utf8" });
    assert.equal(ran.status, 0, ran.stderr);
    const log = git("log", "--format=%s", "fix").split("\n");
    assert.deepEqual(log.slice(0, 2), ["after", "Merge branch 'main' into fix"]);
    assert.ok(log.includes("squash"), "on the squash");
    assert.ok(!log.includes("first") && !log.includes("second"), "the squashed commits are gone");
    assert.equal(
      git("rev-list", "--count", "fix", `^${mainMoves}`, `^${squash}`),
      "2",
      "main's commit is the very one main has, not a copy",
    );
    assert.equal(fs.readFileSync(path.join(dir, "f"), "utf8"), "one\ntwo\nthree\nnot yet\n");
    assert.equal(git("diff", "--stat").includes("1 file changed"), true, "uncommitted, as it was");
  });
});
