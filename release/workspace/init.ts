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
import { readJson } from "../shared/json.ts";
import type { WorkspacePlan } from "../shared/plan.ts";
import { run, sleep } from "../shared/run.ts";

const name = process.argv[2] ?? "";
const plan = readJson<WorkspacePlan | null>(`/desolate/inbox/workspaces/${name}.json`, null);
if (!plan) {
  console.error(`init: the root sent no plan for the workspace '${name}'`);
  process.exit(1);
}

// (DESOLATE_MIRROR_FRESH: a `--fetch` here follows the host's own refresh of the mirror.)
const git = async (dir: string | null, args: string[]) => {
  const result = await run("git", dir ? ["-C", dir, ...args] : args, { env: { ...process.env, GIT_TERMINAL_PROMPT: "0", DESOLATE_MIRROR_FRESH: "1" }, timeoutMs: 600_000 });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed${dir ? ` in ${dir}` : ""}: ${(result.stderr || result.stdout).trim().slice(-800)}`);
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
        if (Date.now() - fs.statSync(lock).mtimeMs > 120_000) fs.rmSync(lock, { recursive: true, force: true });
      } catch {
        /* released meanwhile */
      }
      if (waited > 180_000) throw new Error(`another workspace has held the init lock on ${key} for three minutes`);
      await sleep(200);
    }
  }
  try {
    return await body();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
};

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
      const head = await git(clone, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).catch(() => "");
      const branch = head.replace(/^origin\//, "") || checkout.base.replace(/^origin\//, "");
      await git(clone, ["checkout", "--quiet", branch]);
      made.push(`domain clone ${checkout.repo}`);
    }
    // `git push` offers the branch to the root instead (git-remote-desolate-offer): set on
    // every start, so a clone made before this has it too.
    await git(clone, ["config", "remote.origin.pushurl", `desolate-offer::${checkout.repo}`]);
    // And `git fetch` asks the root to refresh the mirror first (git-remote-desolate-mirror).
    await git(clone, ["config", "remote.origin.url", `desolate-mirror::${checkout.repo}`]);
    if (plan.fetch) await git(clone, ["fetch", "--quiet", "--prune", "origin"]);
    if (checkout.kind === "worktree" && !fs.existsSync(path.join(checkout.path, ".git"))) {
      const exists = await run("git", ["-C", clone, "rev-parse", "--verify", "--quiet", `refs/heads/${checkout.branch}`]);
      if (exists.code === 0) await git(clone, ["worktree", "add", "--quiet", checkout.path, checkout.branch]);
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
        if (!from.startsWith("origin/")) await run("git", ["-C", clone, "fetch", "--quiet", "origin"], { env: { ...process.env, DESOLATE_MIRROR_FRESH: "1" }, timeoutMs: 120_000 });
        if (!from.startsWith("origin/") && (await run("git", ["-C", clone, "rev-parse", "--verify", "--quiet", remote])).code === 0
          && (await run("git", ["-C", clone, "merge-base", "--is-ancestor", from, remote])).code === 0) from = remote;
        // --no-track: from origin/main, git would make origin/main the new branch's upstream,
        // and a plain `git push` on it would then refuse (its upstream's name is not its own).
        await git(clone, ["worktree", "add", "--quiet", "--no-track", "-b", checkout.branch, checkout.path, from]);
      }
      // Locked against pruning by another VM that cannot see this worktree's files as live.
      await git(clone, ["worktree", "lock", "--reason", `workspace ${plan.workspace}`, checkout.path]).catch(() => "");
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
if (who.code !== 0 || who.stdout.trim().endsWith(".desolate.invalid")) {
  await git(null, ["config", "--global", "user.name", plan.author?.name ?? `${plan.domain}/${plan.workspace}`]);
  await git(null, ["config", "--global", "user.email", plan.author?.email ?? `${plan.workspace}@${plan.domain}.desolate.invalid`]);
}
fs.mkdirSync(path.join(os.homedir(), ".desolate"), { recursive: true });
fs.writeFileSync(path.join(os.homedir(), ".desolate", "workspace.json"), JSON.stringify(plan, null, 2));
// More than one checkout: a VSCodium workspace with all of them, which `desolate editor`
// opens (a domain's task that spans repositories is one window). In the domain's own share,
// where the editor sees it from the VM and from the devcontainer alike.
if (plan.checkouts.length > 1) {
  const dir = "/workspaces/.desolate";
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${plan.workspace}.code-workspace`);
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, JSON.stringify({ folders: plan.checkouts.map((c) => ({ path: c.path, name: c.kind === "worktree" ? `${c.repo.split("/")[1]} (${c.branch})` : c.repo.split("/")[1] })), settings: {} }, null, 2), { flag: "wx" });
}
process.stdout.write(JSON.stringify({ ok: true, made, checkouts: plan.checkouts.map((c) => ({ repo: c.repo, branch: c.branch, path: c.path })) }) + "\n");
