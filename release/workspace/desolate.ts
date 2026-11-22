// `desolate`, inside a workspace: the two things a workspace may ask of the root, and both
// only ask. Nothing here pushes: offering is not pushing (P2).
//
//   desolate fetch [<owner/repo>]          ask the root to refresh the mirror, then git fetch
//   desolate offer [<owner/repo>] [<branch>]  bundle a branch for the root; a person pushes it
//   desolate sync                          write this domain's branches out for the root now
//   desolate status ...                    /desolate/status (the wrapper, workspace/desolate, runs it)
//   desolate spawn [--name <w>] [--branch <b>] [--checkout <owner/repo>=worktree:<b>]... [-- <command...>]
//                                          another workspace in this domain, signed by this one
//   desolate close <workspace>             remove one this workspace started (only if it is clean)
//   desolate domain stats [--json]         this domain's workspaces, who started each, its limit
//   desolate events [--follow] [--all]     what happens in this domain, as JSON lines
//   desolate issue offer --title <t> [--body <b> | --body-file <f>] [--label <l>]... [--repo <owner/repo>]
//                                          a GitHub issue, for the person to edit and publish
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { NAMES } from "../shared/limits.ts";
import { branchRefusal, isBranch, parseRepo, repoId, slugRefusal } from "../shared/names.ts";
import { run, sleep } from "../shared/run.ts";
import { checkoutsRefusal, commandRefusal, IDENTITY_FILE, KEY, sign } from "../shared/spawn.ts";
import type { Signed } from "../shared/spawn.ts";
import { statsLines } from "../shared/stats.ts";
import {
  branches,
  domainRepos,
  importDeliveries,
  INBOX,
  request,
  stageLfs,
  syncRepo,
} from "./sync.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Invoke, Table } from "../../suede.nests/dsl.import.meta.vitest.ts";

const fail = (message: string, fix: string): never => {
  process.stderr.write(`desolate: ${message}\n  fix: ${fix}\n`);
  process.exit(1);
};
const whoAmI = () => {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(os.homedir(), ".desolate", "workspace.json"), "utf8"),
    ) as { workspace: string; domain: string };
  } catch {
    // In the devcontainer: the names its environment carries (devcontainer.ts).
    return {
      workspace: process.env.DESOLATE_WORKSPACE_NAME || "unknown",
      domain: process.env.DESOLATE_DOMAIN || "unknown",
    };
  }
};

/** The repository the current directory is a checkout of, or the one named. */
const repoOf = async (named: string | undefined): Promise<string> => {
  if (named) {
    const repo =
      parseRepo(named) ?? fail(`'${named}' is not a repository`, "name it as <owner>/<repo>");
    if (!domainRepos().includes(repoId(repo)))
      fail(
        `${named} is not in this domain`,
        `this domain has: ${domainRepos().join(", ") || "no repositories"}`,
      );
    return repoId(repo);
  }
  const top = await run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return (
    checkoutRepo(top.stdout.trim()) ??
    fail(
      "this directory is not a checkout of one of the domain's repositories",
      "cd into one under /workspaces, or name the repository: desolate offer <owner>/<repo>",
    )
  );
};

/** The repository whose domain clone a git common directory is: /workspaces/<owner>/<repo>/.git,
 *  which is a worktree's too. */
export const checkoutRepo = (gitCommonDir: string): string | null =>
  /^\/workspaces\/([^/]+\/[^/]+)\/\.git$/.exec(gitCommonDir)?.[1] ?? null;

declare namespace checkoutRepo {
  /** a domain clone, from its own directory or any worktree of it */
  export type Clone = Expect<
    Invoke<typeof checkoutRepo, [gitCommonDir: "/workspaces/acme/app/.git"]>,
    "=",
    "acme/app"
  >;
  /** anything else: a clone of its own elsewhere, a nested repository, a worktree's own git dir */
  export type Elsewhere = Table<
    typeof checkoutRepo,
    [
      [args: [gitCommonDir: "/tmp/app/.git"], expected: null],
      [args: [gitCommonDir: "/workspaces/acme/app/vendor/lib/.git"], expected: null],
      [args: [gitCommonDir: "/workspaces/acme/app/.git/worktrees/w1"], expected: null],
      [args: [gitCommonDir: "/workspaces/acme/.git"], expected: null],
      [args: [gitCommonDir: ""], expected: null],
    ]
  >;
}

/** A command line refused: what was wrong, and the command that would be right. */
type Refused = { refused: string; fix: string };

/** `desolate fetch [--mirror-only] [<owner/repo>]`. --mirror-only: the request alone, for
 *  `git fetch` (git-remote-desolate-mirror). */
export const fetchArgs = (args: string[]) => ({
  only: args.includes("--mirror-only"),
  named: args.filter((a) => a !== "--mirror-only")[0],
});

declare namespace fetchArgs {
  export type Cases = Table<
    typeof fetchArgs,
    [
      [args: [args: []], expected: { only: false; named: undefined }],
      [args: [args: ["acme/app", "--mirror-only"]], expected: { only: true; named: "acme/app" }],
    ]
  >;
}

/** `desolate offer [<owner/repo>] [<branch>] [--base <branch>]`: which repository (else the
 *  checkout's), which branch (else the checked-out one), and the base a pull request of it
 *  would go into. A first word that is a repository is the repository; any other is the branch. */
export const offerArgs = (
  args: string[],
): { base: string | undefined; repo: string | undefined; branch: string | undefined } | Refused => {
  const at = args.indexOf("--base");
  const base = at >= 0 ? args[at + 1] : undefined;
  if (at >= 0 && !isBranch(base))
    return {
      refused: "--base names the branch a pull request would go into",
      fix: "desolate offer --base main",
    };
  const rest = at >= 0 ? [...args.slice(0, at), ...args.slice(at + 2)] : args;
  const isRepo = (word: string | undefined) =>
    !!word && word.includes("/") && parseRepo(word) !== null;
  return {
    base,
    repo: isRepo(rest[0]) ? rest[0] : undefined,
    branch: rest[0] && !isRepo(rest[0]) ? rest[0] : rest[1],
  };
};

declare namespace offerArgs {
  /** the repository, the branch, both, or neither (the checkout's own, at its branch) */
  export type Words = Table<
    typeof offerArgs,
    [
      [args: [args: []], expected: { base: undefined; repo: undefined; branch: undefined }],
      [
        args: [args: ["acme/app"]],
        expected: { base: undefined; repo: "acme/app"; branch: undefined },
      ],
      [
        args: [args: ["acme/app", "feature/greet"]],
        expected: { base: undefined; repo: "acme/app"; branch: "feature/greet" },
      ],
      /** a branch with a slash that is no repository (three parts) is a branch */
      [
        args: [args: ["feature/greet/now"]],
        expected: { base: undefined; repo: undefined; branch: "feature/greet/now" },
      ],
      [
        args: [args: ["fix", "--base", "v3"]],
        expected: { base: "v3"; repo: undefined; branch: "fix" },
      ],
      [
        args: [args: ["--base", "v3", "acme/app", "fix"]],
        expected: { base: "v3"; repo: "acme/app"; branch: "fix" },
      ],
    ]
  >;
  /** --base becomes a branch the root names to the forge: one desolate carries, or nothing */
  export type RefusesTheBase = Table<
    typeof offerArgs,
    [
      [
        args: [args: ["--base"]],
        expected: {
          refused: "--base names the branch a pull request would go into";
          fix: "desolate offer --base main";
        },
      ],
      [
        args: [args: ["--base", "--upload-pack=x"]],
        expected: {
          refused: "--base names the branch a pull request would go into";
          fix: "desolate offer --base main";
        },
      ],
      [
        args: [args: ["fix", "--base", "a..b"]],
        expected: {
          refused: "--base names the branch a pull request would go into";
          fix: "desolate offer --base main";
        },
      ],
    ]
  >;
}

const SPAWN_USAGE =
  "desolate spawn [--name <workspace>] [--branch <branch>] [--checkout <owner/repo>=worktree:<branch>]... [-- <command...>]";
const SPAWN_HELP = `${SPAWN_USAGE}\n  --name      its name (else one made from this workspace's)\n  --checkout  a repository it works in, on a branch of its own (repeat for more); the first one's devcontainer is its environment; a repository not named gets its main checkout if that is free, else none\n  --branch    instead: that branch in each of the domain's repositories\n  -- ...      a command it runs as its agent, as words (no shell); without one it is only made\nA branch no other workspace has checked out. Then: desolate domain stats, desolate events --follow --all, desolate close <name>. /desolate/release/AGENTS.md, "Other workspaces".\n`;

/** The name a spawned workspace gets when it is not given one: its parent's, and four hex
 *  digits to keep it apart from its siblings. The parent's part is cut to leave room for
 *  them within a name's length (NAMES.slug), and never ends in a dash (as domainNameFor
 *  does): cutting the whole would cut the digits, and two children of a long-named parent
 *  would then have one name. */
export const spawnedName = (parent: string, suffix: string): string =>
  `${parent.slice(0, NAMES.slug - suffix.length - 1).replace(/-+$/, "")}-${suffix}`;

declare namespace spawnedName {
  export type Names = Table<
    typeof spawnedName,
    [
      [args: [parent: "fix-login", suffix: "3f2a"], expected: "fix-login-3f2a"],
      /** a long parent: its part is cut, the digits are whole, and the name is a name */
      [
        args: [parent: "the-forty-character-name-of-a-workspace1", suffix: "3f2a"],
        expected: "the-forty-character-name-of-a-works-3f2a",
      ],
      /** a cut that would end in a dash ends before it */
      [
        args: [parent: "abcdefghijklmnopqrstuvwxyzabcdefgh-ijkl", suffix: "3f2a"],
        expected: "abcdefghijklmnopqrstuvwxyzabcdefgh-3f2a",
      ],
    ]
  >;
}

/** `desolate spawn ...`: what the host is asked to make. No name: one made from this
 *  workspace's. The command is words after `--`, never a shell string. */
export const spawnArgs = (
  args: string[],
):
  | { help: true }
  | Refused
  | { name: string | undefined; branch: string; checkouts: string[]; command: string[] } => {
  const dash = args.indexOf("--");
  const own = dash >= 0 ? args.slice(0, dash) : args;
  const command = dash >= 0 ? args.slice(dash + 1) : [];
  const value = (flag: string) => {
    const i = own.indexOf(flag);
    return i >= 0 ? own[i + 1] : undefined;
  };
  const takes = ["--name", "--branch", "--checkout"];
  const unknown = own.find(
    (a, i) => a.startsWith("-") && !takes.includes(a) && !takes.includes(own[i - 1] ?? ""),
  );
  if (unknown === "--help" || unknown === "-h") return { help: true };
  if (unknown)
    return {
      refused: `spawn does not take '${unknown}': it takes --name, --branch and --checkout, then -- and a command`,
      fix: SPAWN_USAGE,
    };
  const checkouts = own.flatMap((a, i) =>
    a === "--checkout" && own[i + 1] !== undefined ? [own[i + 1]!] : [],
  );
  // What the root and the host would refuse, refused before it is signed, in their words.
  const name = value("--name");
  const branch = value("--branch") ?? "";
  const refused =
    (name === undefined ? null : slugRefusal(name, "workspace")) ??
    checkoutsRefusal(checkouts) ??
    (branch ? branchRefusal(branch) : null) ??
    commandRefusal(command);
  if (refused) return { refused, fix: SPAWN_USAGE };
  return { name, branch, checkouts, command };
};

declare namespace spawnArgs {
  /** a name, a branch or checkouts, and a command as words: everything after `--` is the
   *  command's, flags included */
  export type Asks = Table<
    typeof spawnArgs,
    [
      [args: [args: []], expected: { name: undefined; branch: ""; checkouts: []; command: [] }],
      [
        args: [args: ["--name", "w2", "--branch", "issue/12", "--", "claude", "-p", "fix --it"]],
        expected: {
          name: "w2";
          branch: "issue/12";
          checkouts: [];
          command: ["claude", "-p", "fix --it"];
        },
      ],
      [
        args: [args: ["--checkout", "acme/app=worktree:issue/12", "--checkout", "acme/lib=main"]],
        expected: {
          name: undefined;
          branch: "";
          checkouts: ["acme/app=worktree:issue/12", "acme/lib=main"];
          command: [];
        },
      ],
    ]
  >;
  export type Help = Table<
    typeof spawnArgs,
    [
      [args: [args: ["--help"]], expected: { help: true }],
      [args: [args: ["--name", "w2", "-h"]], expected: { help: true }],
    ]
  >;
  /** what the root or the host would refuse is refused here, before it is signed, in the
   *  shared rules' words; a flag it does not know too */
  export type Refuses = Table<
    typeof spawnArgs,
    [
      [
        args: [args: ["--force"]],
        expected: {
          refused: "spawn does not take '--force': it takes --name, --branch and --checkout, then -- and a command";
          fix: "desolate spawn [--name <workspace>] [--branch <branch>] [--checkout <owner/repo>=worktree:<branch>]... [-- <command...>]";
        },
      ],
      /** a value that starts with a dash is the flag's value, refused as a name */
      [
        args: [args: ["--name", "-w2"]],
        expected: {
          refused: "a workspace name is a slug: lowercase letters, digits and single dashes, at most 40, starting with a letter or digit";
          fix: "desolate spawn [--name <workspace>] [--branch <branch>] [--checkout <owner/repo>=worktree:<branch>]... [-- <command...>]";
        },
      ],
      [
        args: [args: ["--checkout", "acme/app=worktree:a..b"]],
        expected: {
          refused: "'a..b' is not a branch desolate will carry";
          fix: "desolate spawn [--name <workspace>] [--branch <branch>] [--checkout <owner/repo>=worktree:<branch>]... [-- <command...>]";
        },
      ],
      [
        args: [args: ["--checkout", "../app=main"]],
        expected: {
          refused: "'../app=main' is not <owner/repo>=main or <owner/repo>=worktree:<branch>";
          fix: "desolate spawn [--name <workspace>] [--branch <branch>] [--checkout <owner/repo>=worktree:<branch>]... [-- <command...>]";
        },
      ],
      [
        args: [args: ["--branch", "--upload-pack=x"]],
        expected: {
          refused: "'--upload-pack=x' is not a branch desolate will carry";
          fix: "desolate spawn [--name <workspace>] [--branch <branch>] [--checkout <owner/repo>=worktree:<branch>]... [-- <command...>]";
        },
      ],
      [
        args: [args: ["--", "claude", "a\u0000b"]],
        expected: {
          refused: "word 2 of the command holds a NUL, which no program's argument can";
          fix: "desolate spawn [--name <workspace>] [--branch <branch>] [--checkout <owner/repo>=worktree:<branch>]... [-- <command...>]";
        },
      ],
    ]
  >;
}

/** `desolate close <workspace>`. */
export const closeArgs = (args: string[]): { name: string } | Refused => {
  const name = args[0];
  const fix = "desolate close <workspace>   (one this workspace started: desolate domain stats)";
  if (!name || name.startsWith("-")) return { refused: "close which workspace?", fix };
  const refused = slugRefusal(name, "workspace");
  return refused ? { refused, fix } : { name };
};

declare namespace closeArgs {
  export type Names = Expect<Invoke<typeof closeArgs, [args: ["w2"]]>, "=", { name: "w2" }>;
  export type Refuses = Table<
    typeof closeArgs,
    [
      [
        args: [args: []],
        expected: {
          refused: "close which workspace?";
          fix: "desolate close <workspace>   (one this workspace started: desolate domain stats)";
        },
      ],
      [
        args: [args: ["--all"]],
        expected: {
          refused: "close which workspace?";
          fix: "desolate close <workspace>   (one this workspace started: desolate domain stats)";
        },
      ],
      [
        args: [args: ["W2"]],
        expected: {
          refused: "a workspace name is a slug: lowercase letters, digits and single dashes, at most 40, starting with a letter or digit";
          fix: "desolate close <workspace>   (one this workspace started: desolate domain stats)";
        },
      ],
    ]
  >;
}

const ISSUE_USAGE =
  'desolate issue offer --title "..." [--body "..." | --body-file <file>] [--label <label>]... [--repo <owner/repo>]';
/** `desolate issue offer ...`: each flag with its value, a flag given again adding one. */
export const issueArgs = (args: string[]): { values: Record<string, string[]> } | Refused => {
  const values: Record<string, string[]> = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]!;
    if (
      !["--title", "--body", "--body-file", "--label", "--repo"].includes(flag) ||
      args[i + 1] === undefined
    )
      return { refused: `'${flag}' is not understood here`, fix: ISSUE_USAGE };
    (values[flag] ??= []).push(args[i + 1]!);
  }
  if (!values["--title"])
    return {
      refused: "an issue needs a title",
      fix: 'desolate issue offer --title "..." --body-file notes.md',
    };
  return { values };
};

declare namespace issueArgs {
  export type Flags = Table<
    typeof issueArgs,
    [
      [
        args: [
          args: [
            "--title",
            "Flaky test",
            "--label",
            "bug",
            "--label",
            "ci",
            "--body-file",
            "notes.md",
          ],
        ],
        expected: {
          values: {
            "--title": ["Flaky test"];
            "--label": ["bug", "ci"];
            "--body-file": ["notes.md"];
          };
        },
      ],
      /** a value is taken as it is, even one that looks like a flag */
      [args: [args: ["--title", "--repo"]], expected: { values: { "--title": ["--repo"] } }],
    ]
  >;
  export type Refuses = Table<
    typeof issueArgs,
    [
      [
        args: [args: ["--body", "text"]],
        expected: {
          refused: "an issue needs a title";
          fix: 'desolate issue offer --title "..." --body-file notes.md';
        },
      ],
      [
        args: [args: ["--title", "x", "--assignee", "me"]],
        expected: {
          refused: "'--assignee' is not understood here";
          fix: 'desolate issue offer --title "..." [--body "..." | --body-file <file>] [--label <label>]... [--repo <owner/repo>]';
        },
      ],
      /** a flag with no value after it, and a word that is no flag */
      [
        args: [args: ["--title"]],
        expected: {
          refused: "'--title' is not understood here";
          fix: 'desolate issue offer --title "..." [--body "..." | --body-file <file>] [--label <label>]... [--repo <owner/repo>]';
        },
      ],
      [
        args: [args: ["Flaky", "test"]],
        expected: {
          refused: "'Flaky' is not understood here";
          fix: 'desolate issue offer --title "..." [--body "..." | --body-file <file>] [--label <label>]... [--repo <owner/repo>]';
        },
      ],
    ]
  >;
}

/** An event line's `seq`, or 0 for a line that is not one. */
export const seqOf = (line: string) => {
  try {
    return Number((JSON.parse(line) as { seq?: unknown }).seq) || 0;
  } catch {
    return 0;
  }
};

declare namespace seqOf {
  export type Cases = Table<
    typeof seqOf,
    [
      [args: [line: '{"seq":12,"kind":"offer"}'], expected: 12],
      [args: [line: '{"kind":"offer"}'], expected: 0],
      [args: [line: '{"seq":"x"}'], expected: 0],
      [args: [line: "{half"], expected: 0],
    ]
  >;
}

/** The lines after `seen`, in the order they are kept, and the last seq printed. */
export const unseen = (lines: string[], seen: number): { print: string[]; seen: number } => {
  const print: string[] = [];
  for (const line of lines) {
    const n = seqOf(line);
    if (n > seen) {
      print.push(line);
      seen = n;
    }
  }
  return { print, seen };
};

declare namespace unseen {
  /** only what is newer than the last one printed; a line out of order, or not an event, is
   *  passed over */
  export type Newer = Table<
    typeof unseen,
    [
      [
        args: [lines: ['{"seq":1}', '{"seq":2}', '{"seq":3}'], seen: 1],
        expected: { print: ['{"seq":2}', '{"seq":3}']; seen: 3 },
      ],
      [
        args: [lines: ['{"seq":4}', '{"seq":3}', "garbage", '{"seq":5}'], seen: 0],
        expected: { print: ['{"seq":4}', '{"seq":5}']; seen: 5 },
      ],
      [args: [lines: ['{"seq":2}'], seen: 2], expected: { print: []; seen: 2 }],
    ]
  >;
}

/** The exit code of `desolate` with no verb it knows: 0 when the usage was asked for. */
export const usageExit = (verb: string | undefined) => (verb && verb !== "help" ? 64 : 0);

declare namespace usageExit {
  export type Cases = Table<
    typeof usageExit,
    [
      [args: [verb: undefined], expected: 0],
      [args: [verb: "help"], expected: 0],
      [args: [verb: "push"], expected: 64],
    ]
  >;
}

const main = async (argv: string[]) => {
  // Its output piped into something that stops reading (`desolate offer | head -1`): done,
  // not a crash (an agent's script with pipefail died on it).
  process.stdout.on("error", (error: NodeJS.ErrnoException) =>
    error.code === "EPIPE" ? process.exit(0) : process.exit(1),
  );
  const workspace = whoAmI();
  const [verb, ...args] = argv;
  if (verb === "fetch") {
    const { only, named } = fetchArgs(args);
    const repos = named ? [await repoOf(named)] : domainRepos();
    for (const repo of repos) {
      const reply = await request({ op: "fetch", repo, workspace: workspace.workspace });
      if (reply.ok !== true)
        fail(
          `the root could not refresh ${repo}: ${String(reply.error)}`,
          "on the host: desolate fetch " + repo,
        );
      if (only) continue;
      const fetched = await run(
        "git",
        ["-C", `/workspaces/${repo}`, "fetch", "--prune", "origin"],
        { env: { ...process.env, DESOLATE_MIRROR_FRESH: "1" } },
      );
      if (fetched.code !== 0)
        fail(
          `git fetch failed in ${repo}: ${fetched.stderr.trim()}`,
          "git -C /workspaces/" + repo + " fetch origin",
        );
      const delivered = await importDeliveries(repo);
      process.stdout.write(
        `${repo}: the mirror is refreshed and origin/* is up to date${delivered.length ? `; delivered from the root: ${delivered.map((b) => `root/${b}`).join(", ")}` : ""}.\n`,
      );
    }
  } else if (verb === "offer") {
    // --base <branch>: the branch a pull request of this one would go into (else the default).
    const asked = offerArgs(args);
    if ("refused" in asked) return fail(asked.refused, asked.fix);
    const { base, branch: named } = asked;
    const repo = await repoOf(asked.repo);
    const current = (await run("git", ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
    const branch = named ?? current;
    const notBranch = branchRefusal(branch);
    if (notBranch)
      fail(
        notBranch,
        "check out the branch to offer, or name it: desolate offer <owner>/<repo> <branch>",
      );
    const commit =
      (await branches(repo))[branch] ??
      fail(`${repo} has no branch '${branch}' in this domain`, "git branch --list");
    // Uncommitted changes in the checkout you are offering from (only commits are offered).
    // Its own: under `git push` git exports GIT_DIR, the checkout's, which `-C` on another
    // checkout would compare against that one's files and call everything changed.
    const dirty =
      branch === current
        ? await run("git", ["status", "--porcelain", "--untracked-files=no"])
        : { stdout: "" };
    const lfs = await stageLfs(repo, branch).catch((error: Error) =>
      fail(error.message, "git lfs fsck"),
    );
    await syncRepo(repo);
    const reply = await request({
      op: "offer",
      repo,
      branch,
      commit,
      workspace: workspace.workspace,
      lfs,
      ...(base ? { base } : {}),
    });
    if (reply.ok !== true)
      fail(
        `the root did not take the offer: ${String(reply.error)}`,
        String(reply.fix ?? "on the host: desolate doctor"),
      );
    // Its upstream, if it has none: origin/<it>, where a push of it lands, so that `git pull`
    // gets it then. Unset, `git pull` said "no tracking information" (dogfooding, 2026-11-21).
    const clone = `/workspaces/${repo}`;
    if ((await run("git", ["-C", clone, "config", `branch.${branch}.merge`])).code !== 0) {
      await run("git", ["-C", clone, "config", `branch.${branch}.remote`, "origin"]);
      await run("git", ["-C", clone, "config", `branch.${branch}.merge`, `refs/heads/${branch}`]);
    }
    process.stdout.write(
      `offered ${repo} ${branch} at ${commit.slice(0, 12)}${base ? `, for ${base}` : ""}${lfs.length ? `, with ${lfs.length} LFS object(s)` : ""}.\n`,
    );
    process.stdout.write(
      'It is under "Needs you" on the dashboard now (desolate ui, on the Mac): review it there and push it. Offering is not pushing: nothing in a workspace can push.\n',
    );
    if (dirty.stdout.trim())
      process.stdout.write(
        "note: this checkout has uncommitted changes; only commits are offered.\n",
      );
  } else if (verb === "spawn" || verb === "close") {
    // Signed with this workspace's own key, which only this VM and the host have: the host runs
    // it only if the signature is this workspace's (shared/spawn.ts says why).
    let key = "";
    try {
      key = fs.readFileSync(IDENTITY_FILE, "utf8").trim();
    } catch {
      /* said below */
    }
    if (!KEY.test(key))
      fail(
        "this workspace has no key of its own yet",
        "on the Mac: desolate bootstrap (or desolate stop, then start, this workspace)",
      );
    const at = new Date().toISOString(),
      nonce = randomBytes(16).toString("hex");
    let r: Signed;
    if (verb === "close") {
      const asked = closeArgs(args);
      if ("refused" in asked) return fail(asked.refused, asked.fix);
      r = {
        op: "close",
        domain: workspace.domain,
        parent: workspace.workspace,
        name: asked.name,
        at,
        nonce,
      };
    } else {
      const asked = spawnArgs(args);
      if ("help" in asked) {
        process.stdout.write(SPAWN_HELP);
        process.exit(0);
      }
      if ("refused" in asked) return fail(asked.refused, asked.fix);
      const name = asked.name ?? spawnedName(workspace.workspace, randomBytes(2).toString("hex"));
      r = {
        op: "spawn",
        domain: workspace.domain,
        parent: workspace.workspace,
        name,
        branch: asked.branch,
        checkouts: asked.checkouts,
        command: asked.command,
        at,
        nonce,
      };
    }
    const reply = await request({ ...r, mac: sign(key, r) });
    if (reply.ok !== true)
      fail(
        `the root did not take it: ${String(reply.error)}`,
        String(reply.fix ?? "desolate domain stats"),
      );
    process.stdout.write(
      verb === "spawn"
        ? `asked for ${workspace.domain}/${r.name}: the host starts it once it has checked that this workspace asked${r.op === "spawn" && r.command.length ? ", then runs the command in it as its agent" : ""}. It takes a minute or so.\nIt is labelled as started by ${workspace.workspace}. Follow it: desolate events --follow (--all for what already happened); see it: desolate domain stats. Remove it when done: desolate close ${r.name}\n`
        : `asked to close ${workspace.domain}/${r.name}: the host removes it if nothing in it would be lost (its branches stay). desolate events --follow says when it is gone, or why not.\n`,
    );
  } else if (verb === "issue" && args[0] === "offer") {
    // A draft for the person: they read it on the dashboard, may edit it, and publish it as
    // themselves, approving it on the Mac. Nothing here reaches GitHub.
    const asked = issueArgs(args.slice(1));
    if ("refused" in asked) return fail(asked.refused, asked.fix);
    const { values } = asked;
    let body = values["--body"]?.[0] ?? "";
    if (values["--body-file"]) {
      try {
        body = fs.readFileSync(values["--body-file"][0]!, "utf8");
      } catch (error) {
        fail(
          `cannot read ${values["--body-file"][0]}: ${(error as Error).message}`,
          "name a file this workspace can read",
        );
      }
    }
    const title = values["--title"]![0]!;
    const repo = await repoOf(values["--repo"]?.[0]);
    const reply = await request({
      op: "issue",
      repo,
      workspace: workspace.workspace,
      title,
      body,
      labels: values["--label"] ?? [],
    });
    if (reply.ok !== true)
      fail(
        `the root did not take the issue: ${String(reply.error)}`,
        String(reply.fix ?? "desolate issue offer --help"),
      );
    process.stdout.write(
      `offered an issue for ${repo}: "${title}"${values["--label"] ? `, labelled ${values["--label"].join(", ")}` : ""}.\nThe person reads it on the dashboard, may edit it, and publishes it as themselves (or not). desolate events --follow says when it is published, with its page.\n`,
    );
  } else if (verb === "domain" && args[0] === "stats") {
    const file = path.join(INBOX, "domain.json");
    let stats: unknown = null;
    try {
      stats = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      fail(
        "the root has not written this domain's stats yet",
        "wait a moment; on the Mac: desolate doctor",
      );
    }
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify(stats)}\n`);
    else
      process.stdout.write(
        `${statsLines(stats).join("\n")}\nthis workspace: ${workspace.workspace}\n`,
      );
  } else if (verb === "events") {
    // The domain's events, as the root writes them into the inbox: one JSON object per line,
    // each with a `seq`. --follow: and then each new one, as it comes. --all: from the start of
    // what is kept (else, with --follow, only new ones).
    const file = path.join(INBOX, "events.jsonl");
    const follow = args.includes("--follow");
    const lines = () => {
      try {
        return fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
      } catch {
        return [];
      }
    };
    let seen = follow && !args.includes("--all") ? Math.max(0, ...lines().map(seqOf)) : 0;
    for (;;) {
      const next = unseen(lines(), seen);
      for (const line of next.print) process.stdout.write(`${line}\n`);
      seen = next.seen;
      if (!follow) break;
      await sleep(500);
    }
  } else if (verb === "sync") {
    for (const repo of domainRepos()) {
      const result = await syncRepo(repo);
      await importDeliveries(repo);
      process.stdout.write(
        `${repo}: ${result.branches} branch(es) written for the root${result.bundled ? "" : " (nothing new to bundle)"}.\n`,
      );
    }
  } else {
    process.stdout.write(
      "desolate, inside a workspace:\n  desolate fetch [<owner/repo>]             ask the root to refresh the mirror, then git fetch\n  desolate offer [<owner/repo>] [<branch>]  offer a branch to the root; a person reviews and pushes it\n                    [--base <branch>]       (the branch a pull request of it would go into)\n  desolate sync                             write this domain's branches out for the root now\n  desolate status set <colour> \"<message>\"  say how the work is going (also: note, board, show, clear)\n  desolate spawn [--name <w>] [--branch <b>] [--checkout <owner/repo>=worktree:<b>]... [-- <command...>]\n                                            another workspace in this domain, the command as its agent\n  desolate close <workspace>                remove one this workspace started, if nothing in it would be lost\n  desolate domain stats [--json]            this domain's workspaces, who started each, its limit, the Mac\n  desolate events [--follow] [--all]        what happens in this domain, one JSON object per line\n  desolate issue offer --title <t> [--body <b> | --body-file <f>] [--label <l>]... [--repo <owner/repo>]\n                                            a GitHub issue, for the person to edit and publish\n",
    );
    process.exit(usageExit(verb));
  }
};

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  await main(process.argv.slice(2));
