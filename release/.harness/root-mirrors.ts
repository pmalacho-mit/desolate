// Harness for in-source tests of the root's mirrors and of what it reads from a domain's
// out-box (root/git.ts, repos.ts, outbox.ts, intake.ts): what the root kept, and files a
// domain could leave, in the shape a test names. Beside root-state.ts, whose root this
// shares.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathIn } from "./root-state.ts";

type Where = Parameters<typeof pathIn>[0];

/** The text of the one file in a directory under one of the root's: what was kept there.
 *  Throws when there is none, or more than one. */
export const theOnlyFileIn = (where: Where, dir: string): string => {
  const names = fs.readdirSync(pathIn(where, dir));
  if (names.length !== 1) throw new Error(`${dir} holds ${names.length} files, not one`);
  return fs.readFileSync(path.join(pathIn(where, dir), names[0]!), "utf8");
};

/** A bundle's copy, in the root's state, whose header (its list of refs) is `bytes` long
 *  before the blank line that ends it, and a pack that is no pack. Its path. */
export const aBundleWithAHeaderOf = (bytes: number): string => {
  const file = pathIn("state", `incoming/header-${bytes}.bundle`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const magic = "# v2 git bundle\n";
  const line = `${"0".repeat(40)} refs/heads/b\n`;
  let header = magic + line.repeat(Math.floor((bytes - magic.length) / line.length));
  header += "x".repeat(bytes - header.length);
  fs.writeFileSync(file, `${header}\n\nPACK`);
  return file;
};

const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};
/** The remote publishing a commit on `main` that holds `files` (on top of what it held), as a
 *  fetch brings it into the mirror: a bare repository where the root keeps `repo`'s, made the
 *  first time. Needs `Mock<"./layout.ts", typeof mirrorsAndClonesHere>`. */
export const aMirrorCommit = (repo: string, files: Record<string, string>) => {
  const seed = path.join(process.env.DESOLATE_HOME!, "mirror-seeds", repo);
  const mirror = path.join(fs.realpathSync(pathIn("mirrors", "")), `${repo}.git`);
  const sh = (dir: string, ...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { env: gitEnv, encoding: "utf8" });
  if (!fs.existsSync(path.join(mirror, "HEAD"))) {
    fs.rmSync(seed, { recursive: true, force: true });
    fs.mkdirSync(seed, { recursive: true });
    sh(seed, "init", "-q", "-b", "main");
    fs.mkdirSync(mirror, { recursive: true });
    sh(mirror, "init", "-q", "--bare");
  }
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(seed, name)), { recursive: true });
    fs.writeFileSync(path.join(seed, name), text);
  }
  sh(seed, "add", "-A");
  sh(seed, "commit", "-q", "--allow-empty", "-m", "published");
  sh(seed, "push", "-q", "--force", mirror, "main:main");
};

/** Every start of git from now on, counted (gitStarts): a `git` first on the PATH the root's
 *  git is run with, which counts, then runs git. */
const counted = () => path.join(process.env.DESOLATE_HOME!, "git-starts");
export const countingGit = () => {
  const dir = path.join(process.env.DESOLATE_HOME!, "counting-git");
  if (!fs.existsSync(dir)) {
    const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "git"),
      `#!/bin/sh\necho >> '${counted()}'\nexec '${real}' "$@"\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${dir}:${process.env.PATH}`;
  }
  fs.writeFileSync(counted(), "");
};
/** How many times git was started since countingGit. */
export const gitStarts = () => fs.readFileSync(counted(), "utf8").length;
