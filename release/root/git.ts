// How the root runs git. Only ever in a repository the root owns: a mirror or a root clone
// (P4). There is no function here that takes a path into a domain.
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { run } from "../shared/run.ts";
import type { RunOptions, RunResult } from "../shared/run.ts";
import { failure } from "../shared/text.ts";
import { parseRepo } from "../shared/names.ts";
import type { Repo } from "../shared/names.ts";
import { readJson } from "../shared/json.ts";
import { FORGE, GITCONFIG, KEYRING, ROOT } from "./layout.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type {
  Expect,
  Given,
  Invoke,
  Mock,
  Table,
  Throws,
} from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { theOnlyFileIn } from "../.harness/root-mirrors.ts";
import type {
  emptyRoot,
  linkIn,
  makeDirIn,
  mirrorsAndClonesHere,
  pathIn,
  writeJsonIn,
} from "../.harness/root-state.ts";

/** Which forge the root reaches. GitHub in real use; a stand-in in tests (section 13.2). */
export type Forge = {
  kind: "github" | "stand-in";
  ssh: { user: string; host: string; port: number };
  /** known_hosts lines for the forge's host key. Never learned on first use. */
  knownHosts: string;
};

export const forge = (): Forge => {
  const value = readJson<Forge | null>(FORGE, null);
  if (!value) throw new Error("the root has no forge configured; run `desolate bootstrap` again");
  return value;
};

declare namespace forge {
  type Fresh = Invoke<typeof emptyRoot>;
  /** the forge the host gave at bootstrap (ops.ts, `forge.set`), as it was written */
  export type Reads = Given<
    [
      Fresh,
      Invoke<
        typeof writeJsonIn,
        [
          where: "state",
          name: "forge.json",
          value: {
            kind: "github";
            ssh: { user: "git"; host: "github.com"; port: 22 };
            knownHosts: "github.com ssh-ed25519 AAAA";
          },
        ]
      >,
    ],
    Expect<Invoke<typeof forge>, "matches", { kind: "github"; ssh: { host: "github.com" } }>
  >;
  /** none on record is a refusal that says what to run, never a default forge */
  export type None = Given<
    Fresh,
    Throws<Invoke<typeof forge>, "the root has no forge configured; run `desolate bootstrap` again">
  >;
}

export const remoteUrl = (repo: Repo, f: Forge = forge()) =>
  `ssh://${f.ssh.user}@${f.ssh.host}:${f.ssh.port}/${repo.owner}/${repo.name}.git`;

declare namespace remoteUrl {
  /** where a repository is on the forge: GitHub's address, or a stand-in's on its own port */
  export type Addresses = Table<
    typeof remoteUrl,
    [
      [
        args: [
          repo: { owner: "acme"; name: "app" },
          f: { kind: "github"; ssh: { user: "git"; host: "github.com"; port: 22 }; knownHosts: "" },
        ],
        expected: "ssh://git@github.com:22/acme/app.git",
      ],
      [
        args: [
          repo: { owner: "acme"; name: "app" },
          f: { kind: "stand-in"; ssh: { user: "git"; host: "forge"; port: 2222 }; knownHosts: "" },
        ],
        expected: "ssh://git@forge:2222/acme/app.git",
      ],
    ]
  >;
}

const KNOWN_HOSTS = `${ROOT.state}/known_hosts`;

/** ssh for one repository in one role: that role's agent, that key only, a pinned host key,
 *  no config file, no prompt. A fetch path built with the read key cannot push: the forge
 *  refuses the key, and no other identity is offered. */
export const sshCommand = (repo: Repo, role: "read" | "write") =>
  [
    "ssh",
    "-F",
    "/dev/null",
    "-o",
    `IdentityAgent=${role === "read" ? KEYRING.readAgent : KEYRING.writeAgent}`,
    "-o",
    `IdentityFile=${KEYRING.pub}/${repo.owner}/${repo.name}/${role}.pub`,
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${KNOWN_HOSTS}`,
    // Three bounds on a peer that is remote (limits.md, R4), each ssh's own to keep, and
    // each about silence, never about how long the work takes. Twenty seconds to connect:
    // the forge answers a TCP connection in well under a second from anywhere, and a name
    // that does not resolve or a port that drops packets is then said, not waited on.
    "-o",
    "ConnectTimeout=20",
    // And a connection that has gone quiet is asked, every fifteen seconds, whether the
    // forge is still there: four unanswered and ssh ends, so a fetch or a push over a link
    // that died ends within a minute, by the program that holds the connection. A forge
    // that is busy (packing, receiving) still answers these.
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=4",
  ].join(" ");

declare namespace sshCommand {
  // (Where the agents and public keys are depends on the root's layout: only the words that
  // decide what ssh may do are checked.)
  type Read = Invoke<typeof sshCommand, [repo: { owner: "acme"; name: "app" }, role: "read"]>;
  /** one key, from one agent, to a host whose key is pinned: no config, no prompt, no other identity */
  export type ReadOnly = [
    Expect<Read, "startsWith", "ssh -F /dev/null -o IdentityAgent=">,
    Expect<Read, "includes", "/keyring/read-agent.sock -o IdentityFile=">,
    Expect<
      Read,
      "includes",
      "/acme/app/read.pub -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="
    >,
  ];
  /** a forge that does not answer is not waited on for ever: twenty seconds to connect, and
   *  a connection silent for a minute (four questions, fifteen seconds apart) is ended */
  export type NotForEver = Expect<
    Read,
    "endsWith",
    " -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=4"
  >;
  /** the write role names the write agent and the write key, which only the pusher reaches */
  export type Write = [
    Expect<
      Invoke<typeof sshCommand, [repo: { owner: "acme"; name: "app" }, role: "write"]>,
      "includes",
      "/keyring-write/write-agent.sock"
    >,
    Expect<
      Invoke<typeof sshCommand, [repo: { owner: "acme"; name: "app" }, role: "write"]>,
      "includes",
      "/acme/app/write.pub"
    >,
  ];
}

export const writeKnownHosts = (f: Forge) =>
  fs.writeFileSync(KNOWN_HOSTS, f.knownHosts.trim() + "\n", { mode: 0o644 });

const baseEnv = (): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  LANG: "C.UTF-8",
  GIT_TERMINAL_PROMPT: "0",
  // The root's global config is desolate's file, not a dotfile anything else writes.
  GIT_CONFIG_GLOBAL: GITCONFIG,
  GIT_LFS_SKIP_SMUDGE: process.env.GIT_LFS_SKIP_SMUDGE,
});

/** The directory must be under the mirrors or the root clones. Checked on every call, so a
 *  bug elsewhere cannot make the root run git in a domain's repository. */
export const ownedByRoot = (dir: string): boolean => {
  let real: string;
  try {
    real = fs.realpathSync(dir);
  } catch {
    return false;
  }
  return real.startsWith(`${ROOT.mirrors}/`) || real.startsWith(`${ROOT.clones}/`);
};

declare namespace ownedByRoot {
  // The mirrors and root clones are /desolate/mirrors and /desolate/root, which only the root
  // VM has: these tests put them under the test's own root instead.
  type Fresh = Invoke<typeof emptyRoot>;
  /** a mirror and a root clone are the root's to run git in */
  export type Owned = Given<
    [
      Mock<"./layout.ts", typeof mirrorsAndClonesHere>,
      Fresh,
      Invoke<typeof makeDirIn, [where: "mirrors", name: "acme/app.git"]>,
      Invoke<typeof makeDirIn, [where: "clones", name: "acme/app"]>,
    ],
    [
      Expect<
        Invoke<
          typeof ownedByRoot,
          [dir: Invoke<typeof pathIn, [where: "mirrors", name: "acme/app.git"]>]
        >,
        "=",
        true
      >,
      Expect<
        Invoke<
          typeof ownedByRoot,
          [dir: Invoke<typeof pathIn, [where: "clones", name: "acme/app"]>]
        >,
        "=",
        true
      >,
    ]
  >;
  /** anything else is not: a domain's directory, a path that climbs out, a link under the
   *  clones that leads into a domain (the real path is what counts), nothing at all */
  export type NotOwned = Given<
    [
      Mock<"./layout.ts", typeof mirrorsAndClonesHere>,
      Fresh,
      Invoke<typeof makeDirIn, [where: "domains", name: "acme/repos/acme/app"]>,
      Invoke<
        typeof linkIn,
        [
          where: "clones",
          name: "acme/app",
          target: Invoke<typeof pathIn, [where: "domains", name: "acme/repos/acme/app"]>,
        ]
      >,
    ],
    [
      Expect<
        Invoke<
          typeof ownedByRoot,
          [dir: Invoke<typeof pathIn, [where: "domains", name: "acme/repos/acme/app"]>]
        >,
        "=",
        false
      >,
      Expect<
        Invoke<
          typeof ownedByRoot,
          [dir: Invoke<typeof pathIn, [where: "clones", name: "../domains/acme/repos/acme/app"]>]
        >,
        "=",
        false
      >,
      Expect<
        Invoke<
          typeof ownedByRoot,
          [dir: Invoke<typeof pathIn, [where: "clones", name: "acme/app"]>]
        >,
        "=",
        false
      >,
      Expect<
        Invoke<
          typeof ownedByRoot,
          [dir: Invoke<typeof pathIn, [where: "clones", name: "acme/missing"]>]
        >,
        "=",
        false
      >,
      Expect<
        Invoke<typeof ownedByRoot, [dir: Invoke<typeof pathIn, [where: "clones", name: ""]>]>,
        "=",
        false
      >,
    ]
  >;
}

/** git's ownership check, answered for the one repository desolate is running git in (and
 *  only that one; it reaches git's children through the environment). On vz a file in a
 *  share reports as owned by whichever user last asked, so the check would refuse the
 *  root's own clone whenever root had just looked at it (decisions.md, "On vz, a share is
 *  the host's files..."). It never kept the root out of a domain's repository on vz either:
 *  that is ownedByRoot's job, and the person's (P4). */
export const safeIn = (real: string) => ["-c", `safe.directory=${real}`];

export const git = (dir: string, args: string[], options: RunOptions = {}): Promise<RunResult> => {
  if (!ownedByRoot(dir))
    throw new Error(`the root does not run git in ${dir}: it is not a mirror or a root clone (P4)`);
  // A mirror is a bare repository, named outright: the root's config (safe.bareRepository)
  // lets git use a bare repository only when it is told which one, never by finding one.
  const real = fs.realpathSync(dir);
  const where = real.startsWith(`${ROOT.mirrors}/`) ? ["--git-dir", dir] : ["-C", dir];
  return run("git", [...safeIn(real), ...where, ...args], {
    ...options,
    env: { ...baseEnv(), ...(options.env ?? {}) },
  });
};

declare namespace git {
  /** git is never run anywhere but a mirror or a root clone: refused before anything runs */
  export type Refuses = Throws<
    Invoke<typeof git, [dir: "/tmp", args: ["status"]]>,
    "the root does not run git in /tmp: it is not a mirror or a root clone (P4)"
  >;
}

declare namespace safeIn {
  /** git's ownership check, answered for the one repository named and no other */
  export type One = Expect<
    Invoke<typeof safeIn, [real: "/desolate/root/acme/app"]>,
    "=",
    ["-c", "safe.directory=/desolate/root/acme/app"]
  >;
}

/** For a git whose output is bytes (a pack): its leading arguments and environment, with
 *  the same check as `git`. */
export const gitInvocation = (dir: string): { args: string[]; env: NodeJS.ProcessEnv } => {
  if (!ownedByRoot(dir))
    throw new Error(`the root does not run git in ${dir}: it is not a mirror or a root clone (P4)`);
  const real = fs.realpathSync(dir);
  return {
    args: [
      ...safeIn(real),
      ...(real.startsWith(`${ROOT.mirrors}/`) ? ["--git-dir", dir] : ["-C", dir]),
    ],
    env: baseEnv(),
  };
};

/** How long git may say nothing while it talks to the forge before it is taken to have
 *  stalled (limits.md, R4: an idle bound against a peer that is remote, never a total). A
 *  fetch is run with `--progress`, so git says something at least once a second while bytes
 *  arrive or objects are indexed, however slow the link and however large the repository.
 *  What is silent for longer is the forge preparing a pack before its first line, and one
 *  very large object being indexed; five minutes is past both, and a fetch that is ended
 *  starts again from nothing, so the bound errs long. A link that died is ended sooner, by
 *  ssh itself (sshCommand). `git lfs fetch` is run with its progress forced on
 *  (GIT_LFS_FORCE_PROGRESS), for the same reason. */
export const FORGE_IDLE_MS = 5 * 60_000;

/** Where the root keeps the whole of what a program said when a message shows only its end
 *  (shared/text.ts, `failure`): its own state, which a person reads in the root's terminal.
 *  The newest are kept, up to 64 MiB in all (what a program says is bounded by run()): the
 *  message that names one is read within minutes, not months. */
const FAILURES = path.join(ROOT.state, "failures");
const FAILURES_MOST = 64 * 1024 * 1024;
export const keepFailure = (whole: string): string | null => {
  try {
    fs.mkdirSync(FAILURES, { recursive: true, mode: 0o700 });
    const file = path.join(
      FAILURES,
      `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}.txt`,
    );
    fs.writeFileSync(file, whole, { mode: 0o600 });
    // Named by their time, so the newest sort last.
    let kept = 0;
    for (const name of fs.readdirSync(FAILURES).sort().reverse()) {
      kept += fs.statSync(path.join(FAILURES, name)).size;
      if (kept > FAILURES_MOST && path.join(FAILURES, name) !== file)
        fs.rmSync(path.join(FAILURES, name), { force: true });
    }
    return `${file} (in the root)`;
  } catch {
    return null;
  }
};

/** What a git that failed said, for a message (limits.md, R1): its last `lines` lines on
 *  one line, and, when that is not all of it, how much came before and where the whole text
 *  is kept. Progress that git wrote over itself (each update ends in a carriage return) is
 *  not what it said: only the last state of each line is. */
export const gitSaid = (result: RunResult, lines = 3): string =>
  failure(
    (result.stderr || result.stdout)
      .split("\n")
      .map((line) => line.replace(/\r+$/, "").split("\r").pop() ?? "")
      .join("\n")
      .trim(),
    lines,
    keepFailure,
  ).replace(/\n/g, " | ");

declare namespace gitSaid {
  type Fresh = Invoke<typeof emptyRoot>;
  /** the end of what git said, where it says why; nothing is kept when that is all of it */
  export type Whole = Expect<
    Invoke<
      typeof gitSaid,
      [
        result: {
          code: 128;
          stdout: "";
          stderr: "fatal: could not read from remote repository\n\nPlease make sure you have the correct access rights\n";
        },
      ]
    >,
    "=",
    "fatal: could not read from remote repository |  | Please make sure you have the correct access rights"
  >;
  /** progress git wrote over itself is not lines of the failure: the last state of each is */
  export type Progress = Expect<
    Invoke<
      typeof gitSaid,
      [
        result: {
          code: 128;
          stdout: "";
          stderr: "Receiving objects:  10% (1/10)\rReceiving objects:  20% (2/10)\rfatal: early EOF\n";
        },
      ]
    >,
    "=",
    "fatal: early EOF"
  >;
  /** longer than is shown: the count of what came before, and where the root kept all of it */
  export type Kept = Given<
    Fresh,
    [
      Expect<
        Invoke<
          typeof gitSaid,
          [result: { code: 1; stdout: ""; stderr: "one\ntwo\nthree\nfour\n" }, lines: 2]
        >,
        "matches",
        "^\\(2 earlier lines not shown; all of it: .*/failures/[0-9TZ-]+-[0-9a-f]{8}\\.txt \\(in the root\\)\\) \\| three \\| four$"
      >,
      Expect<
        Invoke<typeof theOnlyFileIn, [where: "state", dir: "failures"]>,
        "=",
        "one\ntwo\nthree\nfour"
      >,
    ]
  >;
}

export const gitOk = async (
  dir: string,
  args: string[],
  options: RunOptions = {},
): Promise<string> => {
  const result = await git(dir, args, options);
  if (result.code !== 0)
    throw new Error(`git ${args.join(" ")} failed in ${dir}: ${gitSaid(result, 10)}`);
  return result.stdout;
};

/** git with no repository (init, clone): the target is checked by the caller. */
export const gitBare = (args: string[], options: RunOptions = {}) =>
  run("git", args, { ...options, env: { ...baseEnv(), ...(options.env ?? {}) } });

export const repoOf = (value: unknown): Repo => {
  const repo = parseRepo(value);
  if (!repo) throw new Error(`not a repository name (owner/repo): ${String(value)}`);
  return repo;
};

declare namespace repoOf {
  /** owner/name, or a refusal that quotes what was given */
  export type Accepts = Expect<
    Invoke<typeof repoOf, [value: "acme/app"]>,
    "=",
    { owner: "acme"; name: "app" }
  >;
  /** a path that climbs, and nothing at all, are not repositories */
  export type Refuses = [
    Throws<Invoke<typeof repoOf, [value: "../app"]>, "not a repository name (owner/repo): ../app">,
    Throws<
      Invoke<typeof repoOf, [value: undefined]>,
      "not a repository name (owner/repo): undefined"
    >,
  ];
}
