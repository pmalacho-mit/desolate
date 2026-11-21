// The reviewer's git (reviewer.ts): how it runs git in its own repositories, which hold
// objects the root's user sent, and how it shows what those objects say. Every module of
// the reviewer runs git through here, and only here.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { NAMES } from "../shared/limits.ts";
import type { Repo } from "../shared/names.ts";
import { run } from "../shared/run.ts";
import { printable } from "../shared/text.ts";
import { GITCONFIG, REVIEWER } from "./layout.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Table } from "../../suede.nests/dsl.import.meta.vitest.ts";

/** What the reviewer logs goes to its stderr: its stdout is its answer (reviewer.ts). */
export const log = (message: string) =>
  console.error(`${new Date().toISOString()} reviewer: ${message}`);
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Variation selectors (and the Mongolian vowel separator): invisible, and able to carry
 *  data inside text that reads as something else. printable leaves them (they are marks,
 *  not controls); the approval page is shown text an agent wrote, so they go too. */
const INVISIBLE = /[\u{fe00}-\u{fe0f}\u{e0100}-\u{e01ef}\u{180e}]/gu;

/** Text an agent wrote, made safe to show (shared/text.ts's printable: no control
 *  characters, no bidirectional overrides, which make a name read as another), and no
 *  variation selectors. Cut only at `max` (printable's bound against a flood unless said),
 *  and then with the mark: making it fit a line is the display's (R1). */
export const shown = (text: string, max?: number) => printable(text.replace(INVISIBLE, "?"), max);

declare namespace shown {
  /** what an agent wrote, as the approval page may show it: as written, unless it would
   *  read as something else */
  export type AsWritten = Table<
    typeof shown,
    [
      [args: [text: "Fix the login loop"], expected: "Fix the login loop"],
      [args: [text: "café"], expected: "café"],
    ]
  >;
  /** controls, a right-to-left override that makes a name read backwards, invisible spaces
   *  and variation selectors: each one a question mark */
  export type Hides = Table<
    typeof shown,
    [
      [args: [text: "evil\u001b[31m red"], expected: "evil?[31m red"],
      [args: [text: "invoice‮fdp.exe"], expected: "invoice?fdp.exe"],
      [args: [text: "pay​pal"], expected: "pay?pal"],
      [args: [text: "ok️"], expected: "ok?"],
      [args: [text: "line break"], expected: "line?break"],
    ]
  >;
  /** cut only where it is asked to be, never inside a character, and never silently */
  export type Cut = Table<
    typeof shown,
    [
      [args: [text: "abcdef", max: 3], expected: "ab…"],
      [args: [text: "\u{1f600}\u{1f600}\u{1f600}", max: 2], expected: "\u{1f600}…"],
      [args: [text: "abc", max: 3], expected: "abc"],
    ]
  >;
}

/** Files that run on the forge, or change how git treats the repository, or are suede's own
 *  machinery (`.suede/core/`, which every consumer of a dependency runs): listed first,
 *  however many files a push changes. */
export const SENSITIVE =
  /(^|\/)(\.github\/|\.gitlab-ci\.yml$|\.gitmodules$|\.gitattributes$|\.lfsconfig$|\.gitignore$|\.circleci\/|Jenkinsfile$|\.devcontainer\/|devcontainer\.json$|\.husky\/|\.pre-commit-config\.yaml$|CODEOWNERS$|\.suede\/core\/)/;

declare namespace SENSITIVE {
  /** what runs on the forge, steers git, or is suede's own machinery: listed first, always */
  export type Listed = Table<
    typeof SENSITIVE.test,
    [
      [args: [string: ".github/workflows/ci.yml"], expected: true],
      [args: [string: "packages/api/.github/dependabot.yml"], expected: true],
      [args: [string: ".gitmodules"], expected: true],
      [args: [string: ".gitattributes"], expected: true],
      [args: [string: ".lfsconfig"], expected: true],
      [args: [string: ".devcontainer/devcontainer.json"], expected: true],
      [args: [string: ".husky/pre-commit"], expected: true],
      [args: [string: "docs/CODEOWNERS"], expected: true],
      [args: [string: "vendor/x/.suede/core/sync.sh"], expected: true],
    ]
  >;
  /** and ordinary files are not, however close their names */
  export type NotListed = Table<
    typeof SENSITIVE.test,
    [
      [args: [string: "src/github/client.ts"], expected: false],
      [args: [string: "docs/gitmodules.md"], expected: false],
      [args: [string: "suede.nests/README.md"], expected: false],
      [args: [string: "README.md"], expected: false],
    ]
  >;
}

/** An LFS pointer, in git-lfs's own form: a version line, the oid, the size, nothing else. */
export const POINTER =
  /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:([0-9a-f]{64})\nsize (\d+)\n$/;

export const repoDir = (repo: Repo) =>
  path.join(REVIEWER.home, "repos", repo.owner, `${repo.name}.git`);
const CONFIG = "[core]\n\trepositoryformatversion = 0\n\tbare = true\n";

export const env = (extra: Record<string, string> = {}) => ({
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: REVIEWER.home,
  LANG: "C.UTF-8",
  GIT_CONFIG_GLOBAL: GITCONFIG,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_ATTR_NOSYSTEM: "1",
  ...extra,
});
/** The settings every git run here starts with: nothing an earlier request could have left in
 *  the repository (hooks, attributes, a commit graph, a pack index over packs) is trusted. */
export const hardened = (dir: string) => [
  "-c",
  `safe.directory=${dir}`,
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.attributesFile=/dev/null",
  "-c",
  "core.commitGraph=false",
  "-c",
  "core.multiPackIndex=false",
  "-c",
  "fetch.writeCommitGraph=false",
  "-c",
  "gc.auto=0",
  "-c",
  "maintenance.auto=false",
];

/** git in the reviewer's repository `dir`. No deadline (R4): git here works on objects on
 *  this disk, and runs until it is done or whoever asked goes away (review-ask.ts ends the
 *  whole process group then). `idleMs` only for git's conversation with the forge, which is
 *  remote: ended when nothing has come from it for that long. */
export const gitIn = (
  dir: string,
  args: string[],
  options: { input?: string; ssh?: string; env?: Record<string, string>; idleMs?: number } = {},
) =>
  run("git", ["--git-dir", dir, ...hardened(dir), ...args], {
    env: env({
      GIT_DIR: dir,
      ...(options.ssh ? { GIT_SSH_COMMAND: options.ssh } : {}),
      ...options.env,
    }),
    input: options.input,
    ...(options.idleMs ? { idleMs: options.idleMs } : {}),
  });

/** git's output, or an Error that says what git said last (its whole stderr is logged). */
export const gitOk = async (
  dir: string,
  args: string[],
  options: Parameters<typeof gitIn>[2] = {},
) => {
  const result = await gitIn(dir, args, options);
  if (result.code !== 0) {
    const said = (result.stderr || result.stdout).trim();
    log(`git ${args[0]} failed:\n${said}`);
    throw new Error(
      `git ${args[0]} failed: ${shown(said.split("\n").slice(-2).join(" | "), 300)}`,
    );
  }
  return result.stdout;
};

/** git's output as it comes, as bytes (a diff is not always text), for a reader that may
 *  stop reading: `take` is given each chunk, and answers false to end git there. Resolves
 *  with git's exit code, or null when it was ended so. */
export const gitStream = (
  dir: string,
  args: string[],
  take: (chunk: Buffer) => boolean,
): Promise<number | null> =>
  new Promise((resolve) => {
    const child = spawn("git", ["--git-dir", dir, ...hardened(dir), ...args], {
      env: env({ GIT_DIR: dir }),
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stopped = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (stopped || take(chunk)) return;
      stopped = true;
      child.kill("SIGKILL");
    });
    child.on("error", () => resolve(1));
    child.on("close", (code) => resolve(stopped ? null : (code ?? 1)));
  });

/** A git command's whole output as bytes (a blob's content is not always text). At most 64
 *  MiB, which is why its callers ask in batches: past it, git is ended and this is null, as
 *  it is when git fails. */
export const gitBytes = (dir: string, args: string[], input: string): Promise<Buffer | null> =>
  new Promise((resolve) => {
    const child = spawn("git", ["--git-dir", dir, ...hardened(dir), ...args], {
      env: env({ GIT_DIR: dir }),
      stdio: ["pipe", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) child.kill("SIGKILL");
      else chunks.push(chunk);
    });
    child.on("error", () => resolve(null));
    // (A git that ends before reading all its input: EPIPE on its stdin, not a crash.)
    child.stdin.on("error", () => {});
    child.on("close", (code) => resolve(code === 0 ? Buffer.concat(chunks) : null));
    child.stdin.end(input);
  });

/** Its repository for one of the root's repositories, put back as it should be before git
 *  runs in it: whatever an earlier request's process could have left (config, hooks,
 *  attributes, alternates, replacements, grafts) is gone. */
export const ensureRepo = (repo: Repo) => {
  const dir = repoDir(repo);
  for (const sub of ["objects/pack", "objects/info", "refs/heads", "refs/seen"])
    fs.mkdirSync(path.join(dir, sub), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, "HEAD"), "ref: refs/heads/main\n", { mode: 0o600 });
  fs.writeFileSync(path.join(dir, "config"), CONFIG, { mode: 0o600 });
  // (And what git would trust without re-reading the objects: a commit graph, a pack index
  // over several packs, packed refs. It never writes these itself here: gc and the graph are
  // off.)
  for (const extra of [
    "hooks",
    "info",
    "shallow",
    "commondir",
    "objects/info/alternates",
    "objects/info/http-alternates",
    "objects/info/grafts",
    "objects/info/commit-graph",
    "objects/info/commit-graphs",
    "objects/pack/multi-pack-index",
    "packed-refs",
    "refs/replace",
    "worktrees",
    "modules",
  ])
    fs.rmSync(path.join(dir, extra), { recursive: true, force: true });
  return dir;
};

export const has = async (dir: string, id: string) =>
  (await gitIn(dir, ["cat-file", "-e", `${id}^{commit}`])).code === 0;

/** `text` written to `file` all at once: never half a file, under its name, to a reader.
 *  (Each its own temporary name: two summaries at once once both wrote "<file>.part", and
 *  one rename found it gone.) */
export const atomically = (file: string, text: string) => {
  const part = `${file}.${Math.random().toString(16).slice(2)}${process.pid}.part`;
  fs.writeFileSync(part, text, { mode: 0o600 });
  fs.renameSync(part, file);
};

/** The refs a review bundle may carry (review-client.ts makes it, reviewer.ts takes it): the
 *  clone's review ref, and its view of the remote's branches. A branch's name is at most what
 *  a branch desolate carries may be (NAMES.branch), in the characters names.ts allows; one
 *  that is not is not sent, and the account says some of the remote's branches were not. */
export const BUNDLE_REF = new RegExp(
  `^refs/(desolate/review/[0-9a-f]{16}|remotes/origin/[A-Za-z0-9._/-]{1,${NAMES.branch}})$`,
);

declare namespace BUNDLE_REF {
  /** a review bundle carries the clone's review ref and its origin/* refs, and nothing else */
  export type Refs = Table<
    typeof BUNDLE_REF.test,
    [
      [args: [string: "refs/desolate/review/0123456789abcdef"], expected: true],
      [args: [string: "refs/remotes/origin/main"], expected: true],
      [args: [string: "refs/remotes/origin/feature/login"], expected: true],
      [args: [string: "refs/heads/main"], expected: false],
      [args: [string: "refs/desolate/review/xyz"], expected: false],
      [args: [string: "refs/remotes/origin/a b"], expected: false],
      [args: [string: "refs/remotes/other/main"], expected: false],
      [args: [string: "refs/tags/v1"], expected: false],
    ]
  >;
}
