// `desolate`, inside a workspace: the two things a workspace may ask of the root, and both
// only ask. Nothing here pushes: offering is not pushing (P2).
//
//   desolate fetch [<owner/repo>]          ask the root to refresh the mirror, then git fetch
//   desolate offer [<owner/repo>] [<branch>]  bundle a branch for the root; a person pushes it
//   desolate sync                          write this domain's branches out for the root now
//   desolate status ...                    /desolate/status (the wrapper, workspace/desolate, runs it)
//   desolate spawn [--name <w>] [--branch <b>] [-- <command...>]
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
import { isBranch, parseRepo, repoId } from "../shared/names.ts";
import { run, sleep } from "../shared/run.ts";
import { checkoutsOf, IDENTITY_FILE, KEY, sign } from "../shared/spawn.ts";
import type { Signed } from "../shared/spawn.ts";
import { statsLines } from "../shared/stats.ts";
import { branches, domainRepos, importDeliveries, INBOX, request, stageLfs, syncRepo } from "./sync.ts";

// Its output piped into something that stops reading (`desolate offer | head -1`): done,
// not a crash (an agent's script with pipefail died on it).
process.stdout.on("error", (error: NodeJS.ErrnoException) => (error.code === "EPIPE" ? process.exit(0) : process.exit(1)));

const fail = (message: string, fix: string): never => {
  process.stderr.write(`desolate: ${message}\n  fix: ${fix}\n`);
  process.exit(1);
};
const workspace = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), ".desolate", "workspace.json"), "utf8")) as { workspace: string; domain: string };
  } catch {
    // In the devcontainer: the names its environment carries (devcontainer.ts).
    return { workspace: process.env.DESOLATE_WORKSPACE_NAME || "unknown", domain: process.env.DESOLATE_DOMAIN || "unknown" };
  }
})();

/** The repository the current directory is a checkout of, or the one named. */
const repoOf = async (named: string | undefined): Promise<string> => {
  if (named) {
    const repo = parseRepo(named) ?? fail(`'${named}' is not a repository`, "name it as <owner>/<repo>");
    if (!domainRepos().includes(repoId(repo))) fail(`${named} is not in this domain`, `this domain has: ${domainRepos().join(", ") || "no repositories"}`);
    return repoId(repo);
  }
  const top = await run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const match = /^\/workspaces\/([^/]+\/[^/]+)\/\.git$/.exec(top.stdout.trim());
  if (!match) fail("this directory is not a checkout of one of the domain's repositories", "cd into one under /workspaces, or name the repository: desolate offer <owner>/<repo>");
  return match![1]!;
};

const [, , verb, ...args] = process.argv;
if (verb === "fetch") {
  // --mirror-only: the request alone, for `git fetch` (git-remote-desolate-mirror).
  const only = args.includes("--mirror-only");
  const named = args.filter((a) => a !== "--mirror-only");
  const repos = named[0] ? [await repoOf(named[0])] : domainRepos();
  for (const repo of repos) {
    const reply = await request({ op: "fetch", repo, workspace: workspace.workspace });
    if (reply.ok !== true) fail(`the root could not refresh ${repo}: ${String(reply.error)}`, "on the host: desolate fetch " + repo);
    if (only) continue;
    const fetched = await run("git", ["-C", `/workspaces/${repo}`, "fetch", "--prune", "origin"], { env: { ...process.env, DESOLATE_MIRROR_FRESH: "1" } });
    if (fetched.code !== 0) fail(`git fetch failed in ${repo}: ${fetched.stderr.trim()}`, "git -C /workspaces/" + repo + " fetch origin");
    const delivered = await importDeliveries(repo);
    process.stdout.write(`${repo}: the mirror is refreshed and origin/* is up to date${delivered.length ? `; delivered from the root: ${delivered.map((b) => `root/${b}`).join(", ")}` : ""}.\n`);
  }
} else if (verb === "offer") {
  // --base <branch>: the branch a pull request of this one would go into (else the default).
  const at = args.indexOf("--base");
  const base = at >= 0 ? args[at + 1] : undefined;
  if (at >= 0 && !isBranch(base)) fail("--base names the branch a pull request would go into", "desolate offer --base main");
  if (at >= 0) args.splice(at, 2);
  const repo = await repoOf(args[0] && args[0].includes("/") && parseRepo(args[0]) ? args[0] : undefined);
  const named = args[0] && !(args[0].includes("/") && parseRepo(args[0])) ? args[0] : args[1];
  const current = (await run("git", ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
  const branch = named ?? current;
  if (!isBranch(branch)) fail(`'${branch}' is not a branch desolate will carry`, "check out the branch to offer, or name it: desolate offer <owner>/<repo> <branch>");
  const commit = (await branches(repo))[branch] ?? fail(`${repo} has no branch '${branch}' in this domain`, "git branch --list");
  // Uncommitted changes in the checkout you are offering from (only commits are offered).
  // Its own: under `git push` git exports GIT_DIR, the checkout's, which `-C` on another
  // checkout would compare against that one's files and call everything changed.
  const dirty = branch === current ? await run("git", ["status", "--porcelain", "--untracked-files=no"]) : { stdout: "" };
  const lfs = await stageLfs(repo, branch).catch((error: Error) => fail(error.message, "git lfs fsck"));
  await syncRepo(repo);
  const reply = await request({ op: "offer", repo, branch, commit, workspace: workspace.workspace, lfs, ...(base ? { base } : {}) });
  if (reply.ok !== true) fail(`the root did not take the offer: ${String(reply.error)}`, String(reply.fix ?? "on the host: desolate doctor"));
  process.stdout.write(`offered ${repo} ${branch} at ${commit.slice(0, 12)}${base ? `, for ${base}` : ""}${lfs.length ? `, with ${lfs.length} LFS object(s)` : ""}.\n`);
  process.stdout.write("It is under \"Needs you\" on the dashboard now (desolate ui, on the Mac): review it there and push it. Offering is not pushing: nothing in a workspace can push.\n");
  if (dirty.stdout.trim()) process.stdout.write("note: this checkout has uncommitted changes; only commits are offered.\n");
} else if (verb === "spawn" || verb === "close") {
  // Signed with this workspace's own key, which only this VM and the host have: the host runs
  // it only if the signature is this workspace's (shared/spawn.ts says why).
  let key = "";
  try {
    key = fs.readFileSync(IDENTITY_FILE, "utf8").trim();
  } catch {
    /* said below */
  }
  if (!KEY.test(key)) fail("this workspace has no key of its own yet", "on the Mac: desolate bootstrap (or desolate stop, then start, this workspace)");
  const at = new Date().toISOString(), nonce = randomBytes(16).toString("hex");
  let r: Signed;
  if (verb === "close") {
    const name = args[0];
    if (!name || name.startsWith("-")) fail("close which workspace?", "desolate close <workspace>   (one this workspace started: desolate domain stats)");
    r = { op: "close", domain: workspace.domain, parent: workspace.workspace, name: name!, at, nonce };
  } else {
    const dash = args.indexOf("--");
    const own = dash >= 0 ? args.slice(0, dash) : args;
    const command = dash >= 0 ? args.slice(dash + 1) : [];
    const value = (flag: string) => {
      const i = own.indexOf(flag);
      return i >= 0 ? own[i + 1] : undefined;
    };
    const usage = "desolate spawn [--name <workspace>] [--branch <branch>] [--checkout <owner/repo>=worktree:<branch>]... [-- <command...>]";
    const takes = ["--name", "--branch", "--checkout"];
    const unknown = own.find((a, i) => a.startsWith("-") && !takes.includes(a) && !takes.includes(own[i - 1] ?? ""));
    if (unknown === "--help" || unknown === "-h") {
      process.stdout.write(`${usage}\n  --name      its name (else one made from this workspace's)\n  --checkout  a repository it works in, on a branch of its own (repeat for more); the first one's devcontainer is its environment; a repository not named gets its main checkout if that is free, else none\n  --branch    instead: that branch in each of the domain's repositories\n  -- ...      a command it runs as its agent, as words (no shell); without one it is only made\nA branch no other workspace has checked out. Then: desolate domain stats, desolate events --follow --all, desolate close <name>. /desolate/release/AGENTS.md, "Other workspaces".\n`);
      process.exit(0);
    }
    if (unknown) fail(`spawn does not take '${unknown}': it takes --name, --branch and --checkout, then -- and a command`, usage);
    const checkouts = own.flatMap((a, i) => (a === "--checkout" && own[i + 1] !== undefined ? [own[i + 1]!] : []));
    if (checkoutsOf(checkouts) === null) fail(`a --checkout is not one desolate takes: ${checkouts.join(" ")}`, "--checkout <owner/repo>=worktree:<branch>   (or <owner/repo>=main)");
    const name = value("--name") ?? `${workspace.workspace}-${randomBytes(2).toString("hex")}`.slice(0, 40);
    const branch = value("--branch") ?? "";
    if (branch && !isBranch(branch)) fail(`'${branch}' is not a branch desolate will carry`, "letters, digits, '.', '_', '-' and '/', not starting with a dash");
    r = { op: "spawn", domain: workspace.domain, parent: workspace.workspace, name, branch, checkouts, command, at, nonce };
  }
  const reply = await request({ ...r, mac: sign(key, r) });
  if (reply.ok !== true) fail(`the root did not take it: ${String(reply.error)}`, String(reply.fix ?? "desolate domain stats"));
  process.stdout.write(verb === "spawn"
    ? `asked for ${workspace.domain}/${r.name}: the host starts it once it has checked that this workspace asked${r.op === "spawn" && r.command.length ? ", then runs the command in it as its agent" : ""}. It takes a minute or so.\nIt is labelled as started by ${workspace.workspace}. Follow it: desolate events --follow (--all for what already happened); see it: desolate domain stats. Remove it when done: desolate close ${r.name}\n`
    : `asked to close ${workspace.domain}/${r.name}: the host removes it if nothing in it would be lost (its branches stay). desolate events --follow says when it is gone, or why not.\n`);
} else if (verb === "issue" && args[0] === "offer") {
  // A draft for the person: they read it on the dashboard, may edit it, and publish it as
  // themselves, approving it on the Mac. Nothing here reaches GitHub.
  const values: Record<string, string[]> = {};
  const rest = args.slice(1);
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i]!;
    if (!["--title", "--body", "--body-file", "--label", "--repo"].includes(flag) || rest[i + 1] === undefined) fail(`'${flag}' is not understood here`, 'desolate issue offer --title "..." [--body "..." | --body-file <file>] [--label <label>]... [--repo <owner/repo>]');
    (values[flag] ??= []).push(rest[i + 1]!);
  }
  if (!values["--title"]) fail("an issue needs a title", 'desolate issue offer --title "..." --body-file notes.md');
  let body = values["--body"]?.[0] ?? "";
  if (values["--body-file"]) {
    try {
      body = fs.readFileSync(values["--body-file"][0]!, "utf8");
    } catch (error) {
      fail(`cannot read ${values["--body-file"][0]}: ${(error as Error).message}`, "name a file this workspace can read");
    }
  }
  const title = values["--title"]![0]!;
  const repo = await repoOf(values["--repo"]?.[0]);
  const reply = await request({ op: "issue", repo, workspace: workspace.workspace, title, body, labels: values["--label"] ?? [] });
  if (reply.ok !== true) fail(`the root did not take the issue: ${String(reply.error)}`, String(reply.fix ?? "desolate issue offer --help"));
  process.stdout.write(`offered an issue for ${repo}: "${title}"${values["--label"] ? `, labelled ${values["--label"].join(", ")}` : ""}.\nThe person reads it on the dashboard, may edit it, and publishes it as themselves (or not). desolate events --follow says when it is published, with its page.\n`);
} else if (verb === "domain" && args[0] === "stats") {
  const file = path.join(INBOX, "domain.json");
  let stats: unknown = null;
  try {
    stats = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    fail("the root has not written this domain's stats yet", "wait a moment; on the Mac: desolate doctor");
  }
  if (args.includes("--json")) process.stdout.write(`${JSON.stringify(stats)}\n`);
  else process.stdout.write(`${statsLines(stats).join("\n")}\nthis workspace: ${workspace.workspace}\n`);
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
  const seqOf = (line: string) => {
    try {
      return Number((JSON.parse(line) as { seq?: unknown }).seq) || 0;
    } catch {
      return 0;
    }
  };
  let seen = follow && !args.includes("--all") ? Math.max(0, ...lines().map(seqOf)) : 0;
  for (;;) {
    for (const line of lines()) {
      const n = seqOf(line);
      if (n > seen) {
        process.stdout.write(`${line}\n`);
        seen = n;
      }
    }
    if (!follow) break;
    await sleep(500);
  }
} else if (verb === "sync") {
  for (const repo of domainRepos()) {
    const result = await syncRepo(repo);
    await importDeliveries(repo);
    process.stdout.write(`${repo}: ${result.branches} branch(es) written for the root${result.bundled ? "" : " (nothing new to bundle)"}.\n`);
  }
} else {
  process.stdout.write("desolate, inside a workspace:\n  desolate fetch [<owner/repo>]             ask the root to refresh the mirror, then git fetch\n  desolate offer [<owner/repo>] [<branch>]  offer a branch to the root; a person reviews and pushes it\n                    [--base <branch>]       (the branch a pull request of it would go into)\n  desolate sync                             write this domain's branches out for the root now\n  desolate status set <colour> \"<message>\"  say how the work is going (also: note, board, show, clear)\n  desolate spawn [--name <w>] [--branch <b>] [-- <command...>]\n                                            another workspace in this domain, the command as its agent\n  desolate close <workspace>                remove one this workspace started, if nothing in it would be lost\n  desolate domain stats [--json]            this domain's workspaces, who started each, its limit, the Mac\n  desolate events [--follow] [--all]        what happens in this domain, one JSON object per line\n  desolate issue offer --title <t> [--body <b> | --body-file <f>] [--label <l>]... [--repo <owner/repo>]\n                                            a GitHub issue, for the person to edit and publish\n");
  process.exit(verb && verb !== "help" ? 64 : 0);
}
