// Harness for in-source tests of what the root reads with git: whether a pushed branch has
// landed in its base (root/pushed.ts), and whether a bundle a domain sent may enter a root clone
// (root/intake.ts). Small local repositories and bundles, made with git under the test file's
// own home, in the shape a test names. No remote and no network: the mirror the root reads is
// a repository like these. Imported by the tests as types only, so nothing
// here reaches the release (release/nests-harness.d.ts).
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };

type Story = "merged" | "squashed" | "changed-again" | "half-merged" | "not-merged";

/** A repository whose `main` began with a.txt and b.txt, and a branch `work` off it that
 *  changed a.txt and b.txt, then, on main:
 *    merged         work merged with a merge commit
 *    squashed       work's changes squashed into one commit
 *    changed-again  squashed, then a.txt changed again
 *    half-merged    only work's change to a.txt
 *    not-merged     nothing
 *  `git` runs git there, as pushed.ts is given it; `commit` is work's tip. */
export const aRepoWhere = (story: Story) => {
  const dir = fs.mkdtempSync(path.join(process.env.DESOLATE_HOME!, `git-${story}-`));
  const sh = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env }).trim();
  const write = (file: string, text: string) => fs.writeFileSync(path.join(dir, file), text);
  const commit = (message: string) => (sh("add", "-A"), sh("commit", "-q", "-m", message), sh("rev-parse", "HEAD"));
  sh("init", "-q", "-b", "main");
  write("a.txt", "a\n");
  write("b.txt", "b\n");
  commit("start");
  sh("switch", "-q", "-c", "work");
  write("a.txt", "a, changed\n");
  commit("work: a");
  write("b.txt", "b, changed\n");
  const tip = commit("work: b");
  sh("switch", "-q", "main");
  if (story === "merged") sh("merge", "-q", "--no-ff", "-m", "merge work", "work");
  if (story === "squashed" || story === "changed-again") (sh("merge", "-q", "--squash", "work"), commit("work, squashed"));
  if (story === "changed-again") (write("a.txt", "a, changed again\n"), commit("a again"));
  if (story === "half-merged") (write("a.txt", "a, changed\n"), commit("only a"));
  const git = async (args: string[]) => {
    const ran = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env });
    return { code: ran.status ?? 1, stdout: ran.stdout, stderr: ran.stderr };
  };
  return { git, commit: tip };
};

/** A bundle as a domain's outbox would hold it, and a root clone's git directory to check it
 *  against (`gitDir`): a v2 bundle of an ordinary commit, one whose tree holds a directory
 *  named `.git` (a checkout of it would plant a repository's config), one in git's v3 format,
 *  or a file that is no bundle at all. `copy` is where it is. */
export const aBundle = (kind: "clean" | "dotgit" | "v3" | "text") => {
  const dir = fs.mkdtempSync(path.join(process.env.DESOLATE_HOME!, `bundle-${kind}-`));
  const clone = path.join(dir, "clone");
  const sh = (cwd: string, args: string[], input?: string) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env, input }).trim();
  sh(dir, ["init", "-q", "-b", "main", clone]);
  const copy = path.join(dir, "incoming", "taken.bundle");
  fs.mkdirSync(path.dirname(copy));
  if (kind === "text") fs.writeFileSync(copy, "not a bundle\n");
  else if (kind === "v3") fs.writeFileSync(copy, "# v3 git bundle\n@object-format=sha256\n\nPACK");
  else {
    const work = path.join(dir, "work");
    sh(dir, ["init", "-q", "-b", "main", work]);
    const blob = sh(work, ["hash-object", "-w", "--stdin"], "[core]\n\thooksPath = /tmp\n");
    const inner = sh(work, ["mktree"], `100644 blob ${blob}\tconfig\n`);
    const tree = kind === "dotgit" ? sh(work, ["mktree"], `040000 tree ${inner}\t.git\n`) : sh(work, ["mktree"], `100644 blob ${blob}\tREADME\n`);
    const commit = sh(work, ["commit-tree", tree, "-m", kind]);
    sh(work, ["update-ref", "refs/heads/offered", commit]);
    sh(work, ["bundle", "create", "-q", copy, "refs/heads/offered"]);
  }
  return { copy, gitDir: path.join(clone, ".git") };
};
