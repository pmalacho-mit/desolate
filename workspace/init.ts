// A workspace's first act, as the domain's own user: make this workspace's checkouts. This is
// the domain running git in the domain's repositories (P4): the root never does it for it.
//
//   node init.ts <workspace>     reads /desolate/inbox/workspaces/<workspace>.json
//
// A domain clone borrows the mirror's objects (git clone --shared), so it costs no download
// and almost no disk, and holds only what was made in it (section 6.2).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson } from "../shared/json.ts";
import type { Checkout, WorkspacePlan } from "../shared/plan.ts";
import { withLock } from "../shared/lock.ts";
import { run } from "../shared/run.ts";
import { printable } from "../shared/text.ts";
import { urlRules } from "./git-urls.ts";
import { beating, requester, saying } from "../shared/step.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Invoke, Table } from "../../suede.nests/dsl.import.meta.vitest.ts";

/** How long a git step may say nothing before it is taken as stuck. Not how long it may
 *  take: a step that reports its progress (`--progress`, below) runs for as long as it has
 *  something to report (docs/v3/limits.md, R4). What it reads is on a share (the mirror, the
 *  domain's .git), which is the Mac's disk through the hypervisor: a peer that can stop
 *  answering. Ten minutes is what every git step here was once given in all, so no step
 *  that finished before is stopped now. */
const GIT_QUIET_MS = 600_000;

// (DESOLATE_MIRROR_FRESH: a `--fetch` here follows the host's own refresh of the mirror.)
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", DESOLATE_MIRROR_FRESH: "1" };
// Where git-lfs's pre-push sends: a name nothing resolves, should its agent not be used.
const LFS_OFFER_URL = "https://offer.desolate.invalid";

/** git's output with its progress settled: a line that git rewrote in place (`\r`, as
 *  `--progress` does) is what it last said there. */
export const settled = (output: string): string =>
  output
    .split("\n")
    .map((line) => line.split("\r").filter(Boolean).at(-1) ?? "")
    .join("\n");

declare namespace settled {
  export type Lines = Table<
    typeof settled,
    [
      [
        args: [
          output: "Updating files:  50% (1/2)\rUpdating files: 100% (2/2)\rUpdating files: 100% (2/2), done.\nfatal: x\n",
        ],
        expected: "Updating files: 100% (2/2), done.\nfatal: x\n",
      ],
      [args: [output: "a\r\nb"], expected: "a\nb"],
    ]
  >;
}

/** One git command of the init, ended only by its own silence or by the host going away.
 *  Its failure is git's whole output and then one line that says which command it was: the
 *  host shows the end of it and keeps all of it (host/workspaces.ts). */
const git = async (dir: string | null, args: string[]) => {
  const result = await run("git", dir ? ["-C", dir, ...args] : args, {
    env: GIT_ENV,
    idleMs: GIT_QUIET_MS,
    signal: requester(),
  });
  if (result.code !== 0)
    throw new Error(
      `${settled(result.stderr || result.stdout).trim()}\ngit ${args.join(" ")} failed${dir ? ` in ${dir}` : ""}`,
    );
  return result.stdout.trim();
};

/** A git command that may be long (a first checkout with its LFS files, a fetch): said
 *  while it runs, and asked for its progress, which is what its silence is measured by. */
const longGit = (what: string, dir: string | null, args: string[]) =>
  saying(what, () => git(dir, args));

/** The domain's .git is shared by every workspace in it, and two can start at once: one
 *  makes a repository's checkouts at a time. The lock is on the share, so it is held by a
 *  beat and stale only when its holder has stopped (shared/lock.ts, R5): a first checkout
 *  that takes twenty minutes keeps it for twenty minutes, and a workspace that died in its
 *  init leaves it to the next, in ten seconds. Waiting for it has no timer: the host's
 *  person is told who holds it, and waits or does not. What is done under it is safe to do
 *  again: each step looks first at what is there. */
// (shared/lock.ts asks why a share lock is safe where an agent can write: /workspaces is the
// domain's share, and anything in any of its workspaces can write this folder. What such a
// side can do with it, it can do already: remove the lock and run git in the domain's .git
// at the same time as another (it can write that .git itself), or swap a link in, so that an
// init in another workspace of the domain writes a file named `holder` in, or unlinks one
// named `holder` or `beat` from, a folder that workspace's user may write. Nothing reaches
// past the domain, whose workspaces are one project's, and the lock is not a boundary.)
const LOCKS = "/workspaces/.desolate/locks";
const oneAtATime = <T>(key: string, repo: string, body: () => Promise<T>): Promise<T> => {
  fs.mkdirSync(LOCKS, { recursive: true });
  let release = () => {};
  return withLock(
    path.join(LOCKS, key),
    async () => {
      release();
      return body();
    },
    {
      scope: "share",
      signal: requester(),
      // Said for as long as the wait lasts, naming the holder, until the lock is ours (or
      // another's: then `waiting` is told again).
      waiting: (holder) => {
        release();
        release = beating(
          `waiting for ${printable(holder.host, 80)} to finish making its checkouts of ${repo} (it began at ${printable(holder.since, 40)})`,
        );
      },
    },
  ).finally(() => release());
};

/** Fast-forward the checked-out branch of a main checkout to the remote's (as the mirror has it
 *  now), only when it is behind and nothing else: no commit of its own, no change to a
 *  tracked file. What was done, or null. */
const catchUpMain = async (clone: string): Promise<string | null> => {
  const ran = (args: string[], env?: Record<string, string>) =>
    run("git", ["-C", clone, ...args], {
      ...(env ? { env: { ...process.env, ...env } } : {}),
      idleMs: GIT_QUIET_MS,
      signal: requester(),
    });
  const branch = (await ran(["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout.trim();
  if (!branch) return null;
  // origin/* as the mirror has it now: over the share, the root not asked to refresh it.
  await ran(["fetch", "--quiet", "origin"], { DESOLATE_MIRROR_FRESH: "1" });
  const remote = `refs/remotes/origin/${branch}`;
  const [here, there] = [
    (await ran(["rev-parse", "--verify", "--quiet", "HEAD"])).stdout.trim(),
    (await ran(["rev-parse", "--verify", "--quiet", remote])).stdout.trim(),
  ];
  if (!here || !there || here === there) return null;
  if ((await ran(["merge-base", "--is-ancestor", "HEAD", remote])).code !== 0) return null;
  if ((await ran(["status", "--porcelain", "--untracked-files=no"])).stdout.trim())
    return `${branch}: behind the remote's, and not brought up to it: it has uncommitted changes`;
  const merged = await ran(["merge", "--ff-only", "--quiet", remote]);
  return merged.code === 0
    ? `${branch}: brought up to the remote's (${there.slice(0, 12)})`
    : `${branch}: behind the remote's, and not brought up to it: ${merged.stderr.trim().split("\n")[0] ?? ""}`;
};

/** The branch a new domain clone checks out: the remote's default, else what the checkout
 *  starts from. */
export const firstBranch = (originHead: string, base: string) =>
  originHead.replace(/^origin\//, "") || base.replace(/^origin\//, "");

declare namespace firstBranch {
  export type Cases = Table<
    typeof firstBranch,
    [
      [args: [originHead: "origin/main", base: "origin/v3"], expected: "main"],
      /** a mirror with no HEAD (an empty repository, a remote that names none) */
      [args: [originHead: "", base: "origin/v3"], expected: "v3"],
      [args: [originHead: "", base: "develop"], expected: "develop"],
    ]
  >;
}

/** Whether to set the workspace's git identity: there is none, or it is one of desolate's
 *  own fallbacks (`...desolate.invalid`), which a templated workspace inherits. */
export const identityWanted = (code: number, email: string) =>
  code !== 0 || email.trim().endsWith(".desolate.invalid");

declare namespace identityWanted {
  /** none, or desolate's: set; the person's own, set in the workspace: kept */
  export type Cases = Table<
    typeof identityWanted,
    [
      [args: [code: 1, email: ""], expected: true],
      [args: [code: 0, email: "template@standup.desolate.invalid\n"], expected: true],
      [args: [code: 0, email: "ada@example.com\n"], expected: false],
      /** a real address that only mentions the fallback's name */
      [args: [code: 0, email: "desolate.invalid@example.com"], expected: false],
    ]
  >;
}

/** The identity it is set to: the person's (their git identity on the Mac, in the plan), else
 *  the workspace's own name. */
export const identityOf = (
  plan: Pick<WorkspacePlan, "domain" | "workspace" | "author">,
): [name: string, email: string] => [
  plan.author?.name ?? `${plan.domain}/${plan.workspace}`,
  plan.author?.email ?? `${plan.workspace}@${plan.domain}.desolate.invalid`,
];

declare namespace identityOf {
  export type Cases = Table<
    typeof identityOf,
    [
      [
        args: [
          plan: {
            domain: "acme";
            workspace: "w1";
            author: { name: "Ada"; email: "ada@example.com" };
          },
        ],
        expected: ["Ada", "ada@example.com"],
      ],
      [
        args: [plan: { domain: "acme"; workspace: "w1" }],
        expected: ["acme/w1", "w1@acme.desolate.invalid"],
      ],
    ]
  >;
}

/** The VSCodium workspace file of a workspace with more than one checkout: each folder, a
 *  worktree named by its branch. */
export const codeWorkspace = (
  checkouts: Pick<Checkout, "repo" | "kind" | "branch" | "path">[],
) => ({
  folders: checkouts.map((c) => ({
    path: c.path,
    name: c.kind === "worktree" ? `${c.repo.split("/")[1]} (${c.branch})` : c.repo.split("/")[1],
  })),
  settings: {},
});

declare namespace codeWorkspace {
  export type Folders = Expect<
    Invoke<
      typeof codeWorkspace,
      [
        checkouts: [
          {
            repo: "acme/app";
            kind: "worktree";
            branch: "issue/12";
            path: "/workspaces/acme/app/.worktrees/w1";
          },
          { repo: "acme/lib"; kind: "main"; branch: "main"; path: "/workspaces/acme/lib" },
        ],
      ]
    >,
    "=",
    {
      folders: [
        { path: "/workspaces/acme/app/.worktrees/w1"; name: "app (issue/12)" },
        { path: "/workspaces/acme/lib"; name: "lib" },
      ];
      settings: {};
    }
  >;
}

const main = async (name: string) => {
  const plan = readJson<WorkspacePlan | null>(`/desolate/inbox/workspaces/${name}.json`, null);
  if (!plan) {
    console.error(`init: the root sent no plan for the workspace '${name}'`);
    process.exit(1);
  }
  const made: string[] = [];
  for (const checkout of plan.checkouts) {
    const clone = `/workspaces/${checkout.repo}`;
    const mirror = `/desolate/mirrors/${checkout.repo}.git`;
    await oneAtATime(checkout.repo.replace("/", "--"), checkout.repo, async () => {
      if (!fs.existsSync(path.join(clone, ".git"))) {
        fs.mkdirSync(path.dirname(clone), { recursive: true });
        await git(null, ["clone", "--shared", "--no-checkout", "--quiet", mirror, clone]);
        // LFS reads the read-only mirror, offline. Set before the first checkout smudges.
        await git(clone, ["config", "lfs.url", `file://${mirror}`]);
        await git(clone, ["config", "lfs.locksverify", "false"]);
        // Several VMs write this .git: git's own housekeeping must not race across them.
        await git(clone, ["config", "gc.auto", "0"]);
        await git(clone, ["config", "maintenance.auto", "false"]);
        fs.appendFileSync(path.join(clone, ".git", "info", "exclude"), "/.worktrees/\n");
        const head = await git(clone, [
          "symbolic-ref",
          "--short",
          "refs/remotes/origin/HEAD",
        ]).catch(() => "");
        const branch = firstBranch(head, checkout.base);
        // (--progress: git says how far it is, files and LFS objects, with no terminal too.)
        await longGit(`checking out ${branch} in the domain's clone of ${checkout.repo}`, clone, [
          "checkout",
          "--progress",
          branch,
        ]);
        made.push(`domain clone ${checkout.repo}`);
      }
      // `git push` offers the branch to the root instead (git-remote-desolate-offer): set on
      // every start, so a clone made before this has it too.
      await git(clone, ["config", "remote.origin.pushurl", `desolate-offer::${checkout.repo}`]);
      // And `git fetch` asks the root to refresh the mirror first (git-remote-desolate-mirror).
      await git(clone, ["config", "remote.origin.url", `desolate-mirror::${checkout.repo}`]);
      // A plain `git push` on a branch with no upstream (every worktree's: made --no-track,
      // below) pushes it under its own name. Without this, git's default stopped it with
      // "has no upstream branch" before the push reached the helper (a person trying desolate
      // as a new user, 2026-11-16). The refusal that follows sets no upstream, so the next
      // `git push` offers it again.
      await git(clone, ["config", "push.autoSetupRemote", "true"]);
      // git-lfs's pre-push (`git lfs install` adds it) uploads to an agent that sends nothing:
      // the offer carries the objects, and the mirror is read-only (desolate-lfs-offer).
      for (const [key, value] of [
        ["lfs.pushurl", LFS_OFFER_URL],
        [`lfs.${LFS_OFFER_URL}.standalonetransferagent`, "desolate-offer"],
        [
          "lfs.customtransfer.desolate-offer.path",
          "/desolate/release/workspace/desolate-lfs-offer",
        ],
        ["lfs.customtransfer.desolate-offer.concurrent", "false"],
      ] as const)
        await git(clone, ["config", key, value]);
      if (plan.fetch)
        await longGit(`fetching ${checkout.repo} from its mirror`, clone, [
          "fetch",
          "--progress",
          "--prune",
          "origin",
        ]);
      // The main checkout, when its branch is only behind the remote's (nothing of its own, and
      // nothing uncommitted): brought up to the remote's, as a new worktree is started from it
      // (below). Nothing else moves it, so a domain's first workspace came up days behind, on
      // code that did not have the app yet (dogfooding, 2026-11-20: all three testers).
      if (checkout.kind === "main") {
        const caught = await catchUpMain(clone);
        if (caught) made.push(`${checkout.repo} ${caught}`);
      }
      if (checkout.kind === "worktree" && !fs.existsSync(path.join(checkout.path, ".git"))) {
        const exists = await run("git", [
          "-C",
          clone,
          "rev-parse",
          "--verify",
          "--quiet",
          `refs/heads/${checkout.branch}`,
        ]);
        // (Not --quiet, here and below: git then says how far the checkout is.)
        const adding = `making the worktree of ${checkout.repo} on ${checkout.branch}`;
        if (exists.code === 0)
          await longGit(adding, clone, ["worktree", "add", checkout.path, checkout.branch]);
        else {
          // A local branch that is only behind the remote's (nothing of its own: an ancestor of
          // origin/<it>) is stale, not a choice: nothing moves the main checkout's branch, so
          // every branch started from it lacked what was merged since (dogfooding: a branch made
          // right after a merge, with --fetch, did not have the merge). Start from the remote's
          // then. A local branch with commits of its own is the person's work: start from it.
          let from = checkout.base;
          const remote = `refs/remotes/origin/${from}`;
          // origin/* as the mirror has it now, first: the clone's are as old as its last fetch,
          // and without --fetch (and for every spawn) a branch started from a main the domain
          // had not fetched in days (dogfooding again, after the fix above). From the mirror,
          // over the share: no network, and the root is not asked to refresh it.
          // A fetch that fails does not stop the start: the branch then starts from what
          // the clone last fetched, and that is said.
          if (!from.startsWith("origin/"))
            await longGit(`fetching ${checkout.repo} from its mirror`, clone, [
              "fetch",
              "--progress",
              "origin",
            ]).catch(() =>
              process.stderr.write(
                `${checkout.repo} could not be fetched from its mirror: ${checkout.branch} starts from what this domain last fetched\n`,
              ),
            );
          if (
            !from.startsWith("origin/") &&
            (await run("git", ["-C", clone, "rev-parse", "--verify", "--quiet", remote])).code ===
              0 &&
            (await run("git", ["-C", clone, "merge-base", "--is-ancestor", from, remote])).code ===
              0
          )
            from = remote;
          // --no-track: from origin/main, git would make origin/main the new branch's upstream,
          // and a plain `git push` on it would then refuse (its upstream's name is not its own).
          await longGit(adding, clone, [
            "worktree",
            "add",
            "--no-track",
            "-b",
            checkout.branch,
            checkout.path,
            from,
          ]);
        }
        // Locked against pruning by another VM that cannot see this worktree's files as live.
        await git(clone, [
          "worktree",
          "lock",
          "--reason",
          `workspace ${plan.workspace}`,
          checkout.path,
        ]).catch(() => "");
        made.push(`worktree ${checkout.repo} ${checkout.branch}`);
      }
    });
  }

  // An identity for commits, if the workspace has none: the person's (their git identity on
  // the Mac, in the plan), else the workspace's own name. The devcontainer gets the same
  // (devcontainer.ts). Changed with `git config --global user.name ...` as anywhere.
  // Also when the one there is a fallback of desolate's own (`...desolate.invalid`): a workspace
  // made from its domain's template inherits the template's, `<domain>/template`, and one made
  // before the person set theirs on the Mac would keep the workspace's name for good
  // (dogfooding: every VM commit of a templated workspace was `standup/template`). One the
  // person set in the workspace is theirs, and kept.
  const who = await run("git", ["config", "--global", "user.email"]);
  if (identityWanted(who.code, who.stdout)) {
    const [userName, userEmail] = identityOf(plan);
    await git(null, ["config", "--global", "user.name", userName]);
    await git(null, ["config", "--global", "user.email", userEmail]);
  }
  // The domain's repositories by their GitHub addresses, for any tool that names one (git-urls.ts).
  for (const args of urlRules(plan.repos ?? plan.checkouts.map((c) => c.repo)))
    await git(null, ["config", "--global", ...args]).catch(() => "");
  fs.mkdirSync(path.join(os.homedir(), ".desolate"), { recursive: true });
  fs.writeFileSync(
    path.join(os.homedir(), ".desolate", "workspace.json"),
    JSON.stringify(plan, null, 2),
  );
  // More than one checkout: a VSCodium workspace with all of them, which `desolate editor`
  // opens (a domain's task that spans repositories is one window). In the domain's own share,
  // where the editor sees it from the VM and from the devcontainer alike.
  if (plan.checkouts.length > 1) {
    const dir = "/workspaces/.desolate";
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${plan.workspace}.code-workspace`);
    fs.rmSync(file, { force: true });
    fs.writeFileSync(file, JSON.stringify(codeWorkspace(plan.checkouts), null, 2), { flag: "wx" });
  }
  process.stdout.write(
    JSON.stringify({
      ok: true,
      made,
      checkouts: plan.checkouts.map((c) => ({ repo: c.repo, branch: c.branch, path: c.path })),
    }) + "\n",
  );
};

// A failure is its text and then one line, on stderr, and exit 1: the host shows the end of
// what a step said (not a stack: the line that says what failed is the last one).
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  await main(process.argv[2] ?? "").catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
