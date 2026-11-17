// Harness for upstream.ts's tests: the git VM's places (its Places), stood in for by a
// temporary directory holding only what the test names, removed when the test finishes. A
// clone is a directory with a .git in it and a mirror one with a HEAD: enough for the checks
// that look before any git runs, which is all these tests reach.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { onTestFinished } from "vitest";
import type { Places } from "../../release/git/upstream.ts";

const scratch = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desolate-git-vm-"));
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const placesIn = (dir: string): Places => ({ clones: path.join(dir, "git"), mirrors: path.join(dir, "mirrors"), release: path.join(dir, "release"), subrepo: path.join(dir, "subrepo"), scratch: dir });

/** A git VM with clones of `clones` and mirrors of `mirrors` (each <owner>/<repo>). */
export const gitVm = (clones: string[], mirrors: string[]): Places => {
  const at = placesIn(scratch());
  for (const repo of clones) fs.mkdirSync(path.join(at.clones, repo, ".git"), { recursive: true });
  for (const repo of mirrors) {
    fs.mkdirSync(path.join(at.mirrors, `${repo}.git`), { recursive: true });
    fs.writeFileSync(path.join(at.mirrors, `${repo}.git`, "HEAD"), "ref: refs/heads/main\n");
  }
  return at;
};

/** A git VM whose release holds this pins.env and this git/suede-upstream.sh. */
export const releaseWith = (pins: string, script: string): Places => {
  const at = placesIn(scratch());
  fs.mkdirSync(path.join(at.release, "git"), { recursive: true });
  fs.writeFileSync(path.join(at.release, "pins.env"), pins);
  fs.writeFileSync(path.join(at.release, "git", "suede-upstream.sh"), script);
  return at;
};

/** What `desolate upstream` is told the current directory is a clone of. */
export const cwdIs = (repo: string) => () => repo;
/** A current directory that is no clone: the command's own `repoOf` stops there. */
export const outsideEveryClone = (): string => {
  throw new Error("this directory is not one of your clones");
};
