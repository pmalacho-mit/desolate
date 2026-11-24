// T1. The workspace daemon's branch watch (workspace/wsd.ts, `watch`): watchRefs on a real
// repository, paced as wsd paces it, counting the looks. A branch that moves is looked at
// within a second; a repository where nothing moves is not looked at; a flood is looked at
// about once a second. Here on the Mac's file events (FSEvents); in a workspace VM, inotify's
// (measured there, 2026-11-23; T2's 04-offers has a branch reach the root on it). Run in a
// Linux container on 2026-11-23, node 24: passes; with node's recursive watch it did not,
// at the same branch's third move (control).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { watchRefs } from "../../../release/workspace/sync.ts";
import { paced } from "../../../release/shared/run.ts";

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
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A repository with one commit on main, watched and paced as wsd does; `looks` counts. */
const watched = async () => {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "desolate-refs-")));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "commit", "-q", "--allow-empty", "-m", "one");
  // The events of making it are past before the watch starts.
  await sleep(300);
  const counted = { looks: 0 };
  const pacer = paced(async () => void counted.looks++);
  const failures: Error[] = [];
  const stop = await watchRefs(repo, pacer.poke, (error) => failures.push(error));
  await sleep(500);
  counted.looks = 0;
  return {
    repo,
    counted,
    failures,
    close: () => {
      stop();
      pacer.close();
      fs.rmSync(repo, { recursive: true, force: true });
    },
  };
};

/** Wait up to a second for a look; answers how many there were. */
const lookedWithin = async (counted: { looks: number }, ms = 1000) => {
  const deadline = Date.now() + ms;
  while (counted.looks === 0 && Date.now() < deadline) await sleep(25);
  return counted.looks;
};

describe("T1 the workspace daemon's branch watch", { concurrency: true }, () => {
  it("looks within a second of a commit, a new branch whose name has a slash, and a deletion; not while nothing changes (the control)", async () => {
    const w = await watched();
    try {
      await sleep(3000);
      assert.equal(w.counted.looks, 0, "three seconds with nothing changed: no look");

      git(w.repo, "commit", "-q", "--allow-empty", "-m", "two");
      assert.ok((await lookedWithin(w.counted)) >= 1, "a commit is looked at within a second");
      await sleep(1100);
      w.counted.looks = 0;

      // The same branch again and again: each move is git's rename over the ref, which a
      // watch on the file itself (node's recursive watch on Linux) stopped hearing after two.
      for (let i = 0; i < 4; i++) {
        git(w.repo, "commit", "-q", "--allow-empty", "-m", `again ${i}`);
        assert.ok((await lookedWithin(w.counted)) >= 1, `commit ${i} on the same branch`);
        await sleep(1100);
        w.counted.looks = 0;
      }

      git(w.repo, "branch", "feature/x");
      assert.ok((await lookedWithin(w.counted)) >= 1, "a new branch feature/x, within a second");
      await sleep(1100);
      w.counted.looks = 0;

      // Below a directory the watch has now seen made: another branch in it, then a commit
      // on it alone (only refs/heads/feature/y moves).
      git(w.repo, "branch", "feature/y");
      assert.ok((await lookedWithin(w.counted)) >= 1, "feature/y, beside feature/x");
      await sleep(1100);
      w.counted.looks = 0;

      git(w.repo, "branch", "-D", "feature/x");
      assert.ok((await lookedWithin(w.counted)) >= 1, "a branch deleted, within a second");
      await sleep(1100);
      w.counted.looks = 0;

      // Packed, then deleted: only packed-refs is rewritten.
      git(w.repo, "pack-refs", "--all");
      await sleep(1100);
      w.counted.looks = 0;
      git(w.repo, "branch", "-D", "feature/y");
      assert.ok((await lookedWithin(w.counted)) >= 1, "a packed branch deleted");
      await sleep(1100);
      w.counted.looks = 0;

      // What moves no branch is not watched: the index, HEAD.
      fs.writeFileSync(path.join(w.repo, "a.txt"), "a\n");
      git(w.repo, "add", "a.txt");
      git(w.repo, "status", "--porcelain");
      await sleep(1500);
      assert.equal(w.counted.looks, 0, "an add and a status: no look");
      assert.deepEqual(w.failures, []);
    } finally {
      w.close();
    }
  });

  it("a loop of 200 touches of a branch's ref costs a few looks, not 200; touching HEAD none", async () => {
    const w = await watched();
    try {
      const ref = path.join(w.repo, ".git", "refs", "heads", "main");
      const head = path.join(w.repo, ".git", "HEAD");
      for (let i = 0; i < 200; i++) {
        const at = new Date(Date.now() - i * 1000);
        fs.utimesSync(head, at, at);
      }
      await sleep(1500);
      assert.equal(w.counted.looks, 0, "HEAD moves no branch");
      for (let i = 0; i < 200; i++) {
        const at = new Date(Date.now() - i * 1000);
        fs.utimesSync(ref, at, at);
        if (i % 20 === 0) await sleep(10);
      }
      await sleep(1500);
      assert.ok(w.counted.looks >= 1, `the touches were seen (${w.counted.looks} looks)`);
      assert.ok(w.counted.looks <= 3, `at most a look a second (${w.counted.looks} looks)`);
    } finally {
      w.close();
    }
  });

  it("a stopped watch looks no more; a directory that is no repository is refused", async () => {
    const w = await watched();
    const { repo, counted } = w;
    const kept = fs.mkdtempSync(path.join(os.tmpdir(), "desolate-refs-kept-"));
    fs.cpSync(repo, kept, { recursive: true });
    w.close();
    const pacer = paced(async () => void counted.looks++);
    const stop = await watchRefs(kept, pacer.poke, () => {});
    stop();
    git(kept, "commit", "-q", "--allow-empty", "-m", "after");
    await sleep(1500);
    assert.equal(counted.looks, 0, "stopped: a commit is not looked at");
    fs.rmSync(kept, { recursive: true, force: true });
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "desolate-refs-none-"));
    try {
      await assert.rejects(
        watchRefs(
          empty,
          () => {},
          () => {},
        ),
      );
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});
