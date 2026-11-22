// git's remote helper for a domain (section 6.5). In a root clone each domain is a remote,
// `desolate::<domain>`, so ordinary git works in the root's terminal and editor:
//
//   git fetch <domain>            that domain's branches arrive as <domain>/*
//   git fetch --all               every domain, and the mirror
//   git push <domain> <branch>    a delivery to that domain (a local transfer, not a push
//                                 to any remote): a bundle in its inbox, imported there as
//                                 root/<branch>
//
// NOTHING HERE RUNS GIT IN A DOMAIN'S REPOSITORY (P4). Fetch reads the bundles and the list of
// refs the domain's own VM wrote to its outbox; git's local transport, which would run
// upload-pack inside the domain's clone under the domain's config, is never used.
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { writeJson } from "../shared/json.ts";
import { isBranch, isSlug, parseRepo } from "../shared/names.ts";
import { run } from "../shared/run.ts";
import { printable } from "../shared/text.ts";
import { domain as domainOf } from "./domains.ts";
import { gitSaid } from "./git.ts";
import { bundleRefusal } from "./intake.ts";
import { clearRefusal, inbox, noteRefusal, refsOf, takeBundles, WHY_MOST } from "./outbox.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Table } from "../../suede.nests/dsl.import.meta.vitest.ts";

const fail = (message: string): never => {
  process.stderr.write(`git-remote-desolate: ${message}\n`);
  process.exit(1);
};

/** One of git's push lines (`push [+]<source>:<target>`) for a domain, read: what to deliver,
 *  or the line to answer git with. A deletion is the domain's to do; a name desolate would not
 *  carry is answered as deliver answers it. */
export const deliverySpec = (
  item: string,
): { source: string; branch: string } | { answer: string } => {
  const spec = item.slice(5).replace(/^\+/, "");
  const [source, target] = spec.split(":");
  const branch = (target ?? "").replace(/^refs\/heads\//, "");
  if (!source)
    return { answer: `error ${target} deleting a branch in a domain is the domain's to do` };
  if (!isBranch(branch))
    return { answer: "error refs/heads/" + branch + " not a branch name desolate will carry" };
  return { source, branch };
};

declare namespace deliverySpec {
  /** a commit-ish to a branch of the domain's (it arrives there as root/<branch>) */
  export type Delivers = Table<
    typeof deliverySpec,
    [
      [args: [item: "push HEAD:refs/heads/fix"], expected: { source: "HEAD"; branch: "fix" }],
      [
        args: [item: "push +refs/heads/main:refs/heads/feature/login"],
        expected: { source: "refs/heads/main"; branch: "feature/login" },
      ],
    ]
  >;
  /** deleting a domain's branch is the domain's to do; a name desolate would not carry is
   *  answered, and nothing is written to the domain's inbox */
  export type Refuses = Table<
    typeof deliverySpec,
    [
      [
        args: [item: "push :refs/heads/fix"],
        expected: {
          answer: "error refs/heads/fix deleting a branch in a domain is the domain's to do";
        },
      ],
      [
        args: [item: "push HEAD:refs/heads/--upload-pack=x"],
        expected: {
          answer: "error refs/heads/--upload-pack=x not a branch name desolate will carry";
        },
      ],
      [
        args: [item: "push HEAD:refs/heads/a..b"],
        expected: { answer: "error refs/heads/a..b not a branch name desolate will carry" },
      ],
    ]
  >;
}

/** Bundles taken in one run of the helper, at most (R7: a hard bound against the domain,
 *  which writes them). A workspace writes one each time it syncs, and the helper takes them
 *  one at a time; a thousand is far past what a domain leaves between two fetches, and a
 *  domain writing bundles as fast as they are taken cannot keep a fetch (and the root's
 *  disk) busy for ever. What is left is taken by the next fetch, and that is said. */
const ROUNDS_MOST = 1000;

/** Of branch names desolate carries (names.ts, isBranch), the ones git takes as refs too:
 *  isBranch's characters and rules leave out every name git refuses but two kinds, a part
 *  that starts with a dot and a part that ends in ".lock" (git-check-ref-format(1), rule 1).
 *  git has the last word all the same: a name it refuses in a list is one it ignores
 *  ("Ignoring funny ref", measured with git 2.39). This keeps them out of the list, in
 *  this process, where asking git took a process for each branch. */
export const gitTakes = (branch: string) =>
  branch.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".lock"));

declare namespace gitTakes {
  /** what git itself takes, and the two kinds of name it does not that isBranch lets by */
  export type Names = Table<
    typeof gitTakes,
    [
      [args: [branch: "main"], expected: true],
      [args: [branch: "feature/v1.2"], expected: true],
      [args: [branch: "a.lockb"], expected: true],
      [args: [branch: "a/.b"], expected: false],
      [args: [branch: "x.lock/y"], expected: false],
    ]
  >;
}

const main = async () => {
  const slug = process.argv[3] ?? "";
  if (!isSlug(slug)) fail(`'${slug}' is not a domain`);
  // In the root clone, on the root's own disk: no peer to go quiet. How long a fetch may take
  // is the patience of whoever ran it (R4), and when that git goes (it closes its end of
  // this helper's input: ended, or killed by whoever ran it), what is under way here is
  // ended and nothing more is taken. A helper does not outlive its fetch, so a domain that
  // writes bundles made to be slow, as fast as they are taken, holds one fetch's helper at
  // most. (`untilGone` false: tidying the root clone, which is done all the same.)
  const gone = new AbortController();
  const git = (args: string[], input?: string, untilGone = true) =>
    run("git", args, { env: process.env, input, signal: untilGone ? gone.signal : undefined });
  const repo = (await git(["config", "--get", "desolate.repo"])).stdout.trim();
  if (!parseRepo(repo))
    fail("this is not one of the root's clones (no desolate.repo in its config)");
  if (!domainOf(slug).repos.includes(repo)) fail(`${repo} is not in the domain '${slug}'`);

  const refusedBy = async (copy: string) =>
    bundleRefusal(
      copy,
      (await git(["rev-parse", "--absolute-git-dir"])).stdout.trim(),
      gone.signal,
    );

  /** Bring the domain's waiting bundles into this root clone, then drop them. */
  /** One branch with an object git calls dangerous takes its whole bundle with it, and a
   *  domain's bundle carries all its branches: until that branch is gone from the domain,
   *  nothing new from the domain is taken. Said here, recorded for the dashboard and
   *  `desolate offers`, and told to the workspace that offered. */
  const refused = (why: string) => {
    noteRefusal(slug, repo, why);
    process.stderr.write(
      `git-remote-desolate: a bundle from ${slug} was refused and dropped: ${printable(why, WHY_MOST)}\n  Nothing new from ${slug} is taken while one of its branches holds what git refused: delete that branch in the workspace, then \`desolate sync\` there.\n`,
    );
  };

  const importBundles = async () => {
    // One at a time: copy, check, fetch, delete. The root's disk holds one bundle of a
    // domain's at once, however many the domain left.
    const droppedInAll: string[] = [];
    let more = true;
    for (let round = 0; more && round < ROUNDS_MOST && !gone.signal.aborted; round++) {
      const taken = takeBundles(slug, repo, 1);
      more = taken.more;
      droppedInAll.push(...taken.dropped);
      for (const copy of taken.copies) {
        // git is given a copy the root made (outbox.ts), never a path the domain controls,
        // and only after every object in it passed git's checks (refusedBy). Refs land under
        // a scratch namespace that is deleted below. What becomes <domain>/* is decided by
        // git, from `list`.
        const why = await refusedBy(copy);
        if (gone.signal.aborted) {
          fs.rmSync(copy, { force: true });
          break;
        }
        if (why === null) {
          const fetched = await git([
            "-c",
            "fetch.fsckObjects=true",
            "-c",
            "transfer.fsckObjects=true",
            "fetch",
            "--quiet",
            "--no-tags",
            "--no-write-fetch-head",
            "--no-recurse-submodules",
            copy,
            `+refs/heads/*:refs/desolate/incoming/${slug}/*`,
          ]);
          // What git says about a bundle is in part the bundle's author's text: shown as text.
          if (fetched.code !== 0) refused(`did not import: ${gitSaid(fetched, 1)}`);
          else clearRefusal(slug, repo);
        } else refused(why);
        fs.rmSync(copy, { force: true });
      }
    }
    for (const why of droppedInAll)
      process.stderr.write(
        `git-remote-desolate: dropped from ${slug}'s outbox: ${printable(why, WHY_MOST)}\n`,
      );
    if (more && !gone.signal.aborted)
      process.stderr.write(
        `git-remote-desolate: took ${ROUNDS_MOST} bundles from ${slug} in this fetch, the most one takes; the rest wait for the next\n`,
      );
    const scratch = (
      await git(
        ["for-each-ref", "--format=%(refname)", `refs/desolate/incoming/${slug}/`],
        undefined,
        false,
      )
    ).stdout
      .split("\n")
      .filter(Boolean);
    for (const ref of scratch) await git(["update-ref", "-d", ref], undefined, false);
  };

  const list = async () => {
    // The domain's whole list, or none: git prunes <domain>/* to what this answers, so a
    // list that could not be read whole fails the fetch, out loud, and nothing is pruned.
    // (Its own process, on this domain's lane: it may wait for the share to settle.)
    const listed = refsOf(slug, repo, true);
    if ("refused" in listed) {
      noteRefusal(slug, repo, listed.refused);
      return fail(
        `${printable(listed.refused, WHY_MOST)}: nothing from ${slug} is fetched, and none of its branches removed, until it is (\`desolate sync\` in a workspace writes it again)`,
      );
    }
    const entries = Object.entries(listed.refs).filter(([branch]) => gitTakes(branch));
    // A branch whose objects the root does not hold (its bundle was refused, or has not
    // come) is not listed: one branch the root will not take does not hide the others.
    // (One git for the whole list.)
    const held = await git(
      ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
      entries.map(([, commit]) => `${commit}\n`).join(""),
    );
    if (held.code !== 0) fail(`could not look for ${slug}'s commits: ${gitSaid(held)}`);
    const types = held.stdout.split("\n");
    const lines: string[] = [];
    let missing = 0;
    entries.forEach(([branch, commit], i) => {
      if (types[i] !== `${commit} commit`) missing++;
      else lines.push(`${commit} refs/heads/${branch}`);
    });
    // Everything the domain lists is here: whatever was refused before is no longer in it.
    if (missing === 0) clearRefusal(slug, repo);
    return lines;
  };

  const deliver = async (source: string, branch: string): Promise<string> => {
    if (!isBranch(branch))
      return "error refs/heads/" + branch + " not a branch name desolate will carry";
    const commit = (
      await git(["rev-parse", "--verify", "--quiet", `${source}^{commit}`])
    ).stdout.trim();
    if (!commit) return `error refs/heads/${branch} no such commit`;
    const dir = path.join(inbox(slug), "deliveries", repo);
    fs.mkdirSync(dir, { recursive: true });
    const id = `${Date.now().toString(36)}-${process.pid}`;
    // The domain borrows the mirror too, so what the mirror has need not travel. A scratch
    // branch gives the bundle a ref to carry; the domain reads the commit from the note.
    const scratch = `refs/heads/desolate-deliver-${id}`;
    await git(["update-ref", scratch, commit]);
    const made = await git([
      "bundle",
      "create",
      "--quiet",
      path.join(dir, `${id}.bundle.tmp`),
      scratch,
      "--not",
      "--remotes=origin",
    ]);
    await git(["update-ref", "-d", scratch]);
    const empty = made.code !== 0 && /empty bundle/i.test(made.stderr);
    if (made.code !== 0 && !empty) return `error refs/heads/${branch} ${gitSaid(made, 1)}`;
    if (!empty) fs.renameSync(path.join(dir, `${id}.bundle.tmp`), path.join(dir, `${id}.bundle`));
    else fs.rmSync(path.join(dir, `${id}.bundle.tmp`), { force: true });
    // With no bundle, the commit is one the mirror already has: the note alone delivers it.
    writeJson(path.join(dir, `${id}.json`), {
      branch,
      commit,
      bundle: !empty,
      at: new Date().toISOString(),
    });
    return `ok refs/heads/${branch}`;
  };

  const input = readline.createInterface({ input: process.stdin, terminal: false });
  input.on("close", () => gone.abort(new Error("the git that ran this helper went away")));
  const say = (text: string) => process.stdout.write(text);
  let batch: string[] = [];
  for await (const line of input) {
    if (line === "capabilities") say("fetch\npush\n\n");
    else if (line === "list" || line === "list for-push") {
      if (line === "list") await importBundles();
      say([...(await list()), ""].join("\n") + "\n");
    } else if (line.startsWith("fetch ") || line.startsWith("push ")) batch.push(line);
    else if (line === "") {
      if (batch.length === 0) break;
      if (batch[0]!.startsWith("fetch ")) {
        await importBundles();
        say("\n");
      } else {
        for (const item of batch) {
          const parsed = deliverySpec(item);
          say(
            ("answer" in parsed ? parsed.answer : await deliver(parsed.source, parsed.branch)) +
              "\n",
          );
        }
        say("\n");
      }
      batch = [];
    } else fail(`unknown command from git: ${line}`);
  }
};

// Run by git, for a fetch from or a push to `desolate::<domain>` (/usr/local/bin/git-remote-desolate,
// a wrapper that runs node with this file's path); imported, it does nothing.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === new URL(import.meta.url).pathname)
  await main();
