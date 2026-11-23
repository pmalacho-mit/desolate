// T1. The look the host takes in each running workspace's checkouts, by itself, on a timer
// (host/workspaces.ts, LOOK_EACH): it runs beside whatever a person or an agent is doing in
// the same repository, so it must take no lock there.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { LOOK_EACH } from "../../../release/host/workspaces.ts";

const git = (repo: string, ...args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });

/** A repository with one committed file whose time on disk no longer matches the index: a
 *  `git status` there wants to refresh the index, which is when it takes the lock. */
const staleRepo = () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "desolate-look-"));
  git(repo, "init", "-q");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-q", "-m", "one");
  const then = new Date(Date.now() - 3600_000);
  fs.utimesSync(path.join(repo, "a.txt"), then, then);
  return repo;
};
/** The index file itself: git writes a new one (index.lock, renamed over it), so a look that
 *  took the lock leaves another file there. */
const indexFile = (repo: string) => fs.statSync(path.join(repo, ".git", "index")).ino;
const look = (repo: string) =>
  execFileSync("bash", ["-c", LOOK_EACH, "_", repo], { encoding: "utf8" });

describe("T1 the host's look in a workspace's checkout", () => {
  it("takes no lock on the index; the control, a plain git status, rewrites it", () => {
    const repo = staleRepo();
    try {
      const before = indexFile(repo);
      assert.equal(look(repo), "", "a clean checkout: nothing would be lost");
      assert.equal(indexFile(repo), before, "the look left the index as it was");
      // The control: the same repository, the same stale file, without the flag.
      git(repo, "status", "--porcelain");
      assert.notEqual(indexFile(repo), before, "a plain status wrote a new index, under its lock");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("still says what would be lost", () => {
    const repo = staleRepo();
    try {
      fs.writeFileSync(path.join(repo, "a.txt"), "two\n");
      assert.equal(look(repo), `UNCOMMITTED ${repo}\n`);
      git(repo, "stash", "-q");
      assert.equal(look(repo), `STASHED ${repo}\n`);
      assert.equal(look(path.join(repo, "nowhere")), `UNREADABLE ${path.join(repo, "nowhere")}\n`);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
