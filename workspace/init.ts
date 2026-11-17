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
import { run, sleep } from "../shared/run.ts";
import { urlRules } from "./git-urls.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Invoke, Table } from "../../suede.nests/dsl.import.meta.vitest.ts";

// (DESOLATE_MIRROR_FRESH: a `--fetch` here follows the host's own refresh of the mirror.)
const git = async (dir: string | null, args: string[]) => {
  const result = await run("git", dir ? ["-C", dir, ...args] : args, {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", DESOLATE_MIRROR_FRESH: "1" },
    timeoutMs: 600_000,
  });
  if (result.code !== 0)
    throw new Error(
      `git ${args.join(" ")} failed${dir ? ` in ${dir}` : ""}: ${(result.stderr || result.stdout).trim().slice(-800)}`,
    );
  return result.stdout.trim();
};

/** The domain's .git is shared by every workspace in it, and two can start at once. A
 *  directory is the lock: mkdir is atomic, on the share too. */
const LOCKS = "/workspaces/.desolate/locks";
const withLock = async <T>(key: string, body: () => Promise<T>): Promise<T> => {
  fs.mkdirSync(LOCKS, { recursive: true });
  const lock = path.join(LOCKS, key);
  for (let waited = 0; ; waited += 200) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch {
      // A lock older than two minutes belongs to a workspace that died mid-init.
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 120_000)
          fs.rmSync(lock, { recursive: true, force: true });
      } catch {
        /* released meanwhile */
      }
      if (waited > 180_000)
        throw new Error(`another workspace has held the init lock on ${key} for three minutes`);
      await sleep(200);
    }
  }
  try {
    return await body();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
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
    await withLock(checkout.repo.replace("/", "--"), async () => {
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
        await git(clone, ["checkout", "--quiet", branch]);
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
      if (plan.fetch) await git(clone, ["fetch", "--quiet", "--prune", "origin"]);
      if (checkout.kind === "worktree" && !fs.existsSync(path.join(checkout.path, ".git"))) {
        const exists = await run("git", [
          "-C",
          clone,
          "rev-parse",
          "--verify",
          "--quiet",
          `refs/heads/${checkout.branch}`,
        ]);
        if (exists.code === 0)
          await git(clone, ["worktree", "add", "--quiet", checkout.path, checkout.branch]);
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
          if (!from.startsWith("origin/"))
            await run("git", ["-C", clone, "fetch", "--quiet", "origin"], {
              env: { ...process.env, DESOLATE_MIRROR_FRESH: "1" },
              timeoutMs: 120_000,
            });
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
          await git(clone, [
            "worktree",
            "add",
            "--quiet",
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

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  await main(process.argv[2] ?? "");
