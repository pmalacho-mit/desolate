// Offers (section 6.4): a branch a workspace marked ready. Taking one brings the branch into
// the root clone (through the domain's remote), verifies and imports the LFS objects its
// commits reference, and records it under "Needs you". Offering is not pushing.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { refuse } from "../shared/exit.ts";
import { readJson, writeJson } from "../shared/json.ts";
import { LFS_POINTER_BYTES } from "../shared/limits.ts";
import { listed, PAGE } from "../shared/listed.ts";
import type { Listed } from "../shared/listed.ts";
import { isBranch, isCommit, isLfsOid, isSlug, parseRepo } from "../shared/names.ts";
import type { Repo } from "../shared/names.ts";
import { domain as domainOf, domains, workspaces } from "./domains.ts";
import { git, gitOk, ownedByRoot, safeIn } from "./git.ts";
import { clonePath, domainPath, GITCONFIG, mirrorPath } from "./layout.ts";
import { dropLfs, refusalsOf, takeLfs, UNREAD } from "./outbox.ts";
import { recordOf } from "./repos.ts";
import { lookalike } from "./reviewer-git.ts";
import type { Unpushed, WorkspacePlan } from "../shared/plan.ts";
import type { DiffPage } from "../shared/review-account.ts";
import { readHead } from "../shared/status.ts";
import { CUT, failure, printable, printableLines, SAFE_MOST } from "../shared/text.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type {
  Expect,
  Given,
  Invoke,
  Table,
  Throws,
} from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { aDomain, emptyRoot, writeJsonIn } from "../.harness/root-state.ts";
import type { repeated } from "../.harness/shared-bytes.ts";

/** `base`: the branch a pull request of this one would go into, as the workspace said
 *  (`desolate offer --base`); without it, the repository's default branch. */
export type Offer = {
  domain: string;
  repo: string;
  branch: string;
  commit: string;
  workspace: string;
  lfs: number;
  at: string;
  base?: string;
};
const file = (domain: string) => path.join(domainPath(domain), "offers.json");
export const offersOf = (domain: string): Offer[] => readJson<Offer[]>(file(domain), []);
export const allOffers = (only?: string): Offer[] =>
  domains()
    .filter((d) => !only || d.slug === only)
    .flatMap((d) => offersOf(d.slug));

declare namespace allOffers {
  type Fresh = Invoke<typeof emptyRoot>;
  /** every domain's offers, or one domain's; a domain that never offered has none */
  export type ByDomain = Given<
    [
      Fresh,
      Invoke<typeof aDomain, [slug: "acme", repos: ["acme/app"]]>,
      Invoke<typeof aDomain, [slug: "beta", repos: ["acme/app"]]>,
      Invoke<typeof aDomain, [slug: "quiet", repos: ["acme/app"]]>,
      Invoke<
        typeof writeJsonIn,
        [
          where: "domains",
          name: "acme/offers.json",
          value: [
            {
              domain: "acme";
              repo: "acme/app";
              branch: "fix";
              commit: "0123456789abcdef0123456789abcdef01234567";
              workspace: "w1";
              lfs: 0;
              at: "2026-11-16T12:00:00.000Z";
            },
          ],
        ]
      >,
      Invoke<
        typeof writeJsonIn,
        [
          where: "domains",
          name: "beta/offers.json",
          value: [
            {
              domain: "beta";
              repo: "acme/app";
              branch: "feat";
              commit: "0123456789abcdef0123456789abcdef01234567";
              workspace: "w1";
              lfs: 0;
              at: "2026-11-16T12:00:00.000Z";
            },
          ],
        ]
      >,
    ],
    [
      Expect<
        Invoke<typeof allOffers>,
        "matches",
        [{ domain: "acme"; branch: "fix" }, { domain: "beta"; branch: "feat" }]
      >,
      Expect<Invoke<typeof allOffers, [only: "beta"]>, "matches", [{ domain: "beta" }]>,
      Expect<Invoke<typeof offersOf, [domain: "quiet"]>, "=", []>,
    ]
  >;
}

const lfsStore = (dir: string, oid: string) =>
  path.join(dir, oid.slice(0, 2), oid.slice(2, 4), oid);

/** Bring a domain's branches into the root clone: `git fetch <domain>`, by the helper. It
 *  has no timer of its own (docs/v3/limits.md, R4): it reads a bundle from a share, which is
 *  work and not a wait on a peer, and it is quiet, so there is no silence to time either. Nor
 *  is it ended when whoever asked goes away: it writes the clone every domain of the
 *  repository shares, and git killed mid-write leaves its ref locks behind, which stop every
 *  fetch after it (found by the review of this change). It runs until it is done.
 *
 *  What the helper said (a bundle it dropped or refused) goes in the log of the service that
 *  fetched: rootd's import, the state service's count of a workspace's commits, an offer. The
 *  first fetch after a domain writes takes what it wrote, so whichever fetch that is says so;
 *  given back to the caller, it was said only when rootd fetched. Only to a log (a file): a
 *  command's stderr is a person's terminal or an answer (push.ts, a one-shot rootctl), which
 *  did not say it before either. A failure said already (a refused list stays refused until
 *  the domain writes it again) is not said again at every count. */
const failedLast = new Map<string, string>();
const toLog = () => {
  try {
    return fs.fstatSync(2).isFile();
  } catch {
    return false;
  }
};
/** The fetch running in each clone in this process. A domain's branches come in by a forced
 *  refspec, so of two fetches at once the one that read the domain first could write last and
 *  set a branch back (a review read 249 of a branch's 250 commits: the dashboard's count was
 *  fetching as the review did). One at a time, each after the last: a review's fetch reads
 *  the domain after any fetch already running has written. */
const fetching = new Map<string, Promise<void>>();
export const fetchDomain = (domain: string, repo: Repo): Promise<void> => {
  const key = clonePath(repo);
  const mine = (fetching.get(key) ?? Promise.resolve())
    .catch(() => {})
    .then(() => fetchDomainNow(domain, repo));
  fetching.set(key, mine);
  void mine
    .catch(() => {})
    .finally(() => {
      if (fetching.get(key) === mine) fetching.delete(key);
    });
  return mine;
};
const fetchDomainNow = async (domain: string, repo: Repo): Promise<void> => {
  const fetch = () => git(clonePath(repo), ["fetch", "--quiet", "--prune", domain]);
  // rootd imports as a domain writes, and a review imports too: two at once in one clone
  // can meet on a ref's lock, and the later one tries again, a little later each time (the
  // lock is held for as long as one ref takes to write).
  let result = await fetch();
  let said = result.stderr;
  for (
    let tries = 0;
    result.code !== 0 && /\.lock\b|cannot lock/i.test(result.stderr) && tries < 5;
    tries++
  ) {
    await new Promise((resolve) => setTimeout(resolve, 300 + 300 * tries));
    result = await fetch();
    said += result.stderr;
  }
  const id = `${domain} ${repo.owner}/${repo.name}`;
  const lines = [...new Set(said.split("\n").filter(Boolean))];
  if (result.code !== 0 && !lines.length) lines.push(`git fetch ended with ${result.code}`);
  const text = lines.join("\n");
  if (text && toLog() && !(result.code !== 0 && failedLast.get(id) === text)) {
    const who = path.basename(process.argv[1] ?? "root", ".ts");
    for (const line of lines)
      fs.writeSync(2, `${new Date().toISOString()} ${who}: ${id}: ${printable(line)}\n`);
  }
  if (result.code !== 0) failedLast.set(id, text);
  else failedLast.delete(id);
  if (result.code !== 0)
    throw new Error(
      `could not bring ${domain}'s branches of ${repo.owner}/${repo.name} into the root clone: ${failure(result.stderr.trim(), 6, () => null)}`,
    );
};

/** Each checkout of a workspace against the remote: the commits its HEAD has that no branch of
 *  origin has, counted in the root clone after the domain's branches are brought in (git in
 *  the root's own clone, never in the domain's: P4). The HEAD is read as data. For the
 *  dashboard's Delete, and `desolate rm --if-pushed`. */
export const unpushedOf = async (domain: string, w: WorkspacePlan): Promise<Unpushed[]> => {
  const reposDir = path.join(domainPath(domain), "repos");
  const fetched = new Set<string>();
  const out: Unpushed[] = [];
  for (const c of w.checkouts) {
    const head = readHead(reposDir, c);
    const repo = parseRepo(c.repo);
    const branch = head?.branch ?? null;
    if (!repo) continue;
    if (!head?.commit) {
      out.push({
        repo: c.repo,
        branch,
        commit: null,
        count: null,
        why: "its HEAD could not be read",
      });
      continue;
    }
    const clone = clonePath(repo);
    if (!fetched.has(c.repo)) {
      fetched.add(c.repo);
      await fetchDomain(domain, repo).catch(() => {});
    }
    if ((await git(clone, ["cat-file", "-e", `${head.commit}^{commit}`])).code !== 0) {
      out.push({
        repo: c.repo,
        branch,
        commit: head.commit,
        count: null,
        why: "its latest commit has not reached the root yet (a commit there is written out within seconds)",
      });
      continue;
    }
    const counted = await git(clone, [
      "rev-list",
      "--count",
      head.commit,
      "--not",
      "--remotes=origin",
    ]);
    const count = counted.code === 0 ? Number(counted.stdout.trim()) : null;
    out.push({
      repo: c.repo,
      branch,
      commit: head.commit,
      count,
      why:
        count === null
          ? "its commits could not be counted against the remote"
          : count > 0
            ? `${count} commit(s) on ${branch ?? "a detached HEAD"} that the remote does not have`
            : null,
    });
  }
  return out;
};

/** What a workspace is told to do about a bundle the root refused, by the refusal's reason.
 *  A list the root could not open is no verdict on a branch: the share between the two VMs
 *  showed the root something other than the directory the workspace made (T4, 2026-11-23; outbox.ts, openDir). */
const refusedFix = (why: string) =>
  why.includes(UNREAD)
    ? "the share between this workspace's VM and the root's had not yet shown the root what this workspace wrote: offer again (desolate offer)"
    : "a branch in this domain holds an object git calls dangerous (a .git inside a tree, a .gitmodules that is a symlink or names an option, a malformed object). Nothing new is taken until that branch is deleted here; then offer again";

declare namespace refusedFix {
  /** an outbox directory the root could not open is offered again; what git refused is
   *  deleted first (the control: the fix every other refusal had) */
  export type ByReason = Table<
    typeof refusedFix,
    [
      [
        args: [
          why: "acme/app's list of branches (refs.json) could not be read: its directory in the outbox is not a plain one (a link, or not a directory, at each of 5 looks over a second; lstat saw a directory)",
        ],
        expected: "the share between this workspace's VM and the root's had not yet shown the root what this workspace wrote: offer again (desolate offer)",
      ],
      [
        args: [
          why: "did not import: error: object 0123456789abcdef0123456789abcdef01234567: hasDotgit: contains '.git'",
        ],
        expected: "a branch in this domain holds an object git calls dangerous (a .git inside a tree, a .gitmodules that is a symlink or names an option, a malformed object). Nothing new is taken until that branch is deleted here; then offer again",
      ],
    ]
  >;
}

export const take = async (
  domain: string,
  request: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const d = domainOf(domain);
  const repo = parseRepo(request.repo);
  if (!repo || !d.repos.includes(String(request.repo)))
    return { ok: false, error: "that repository is not in this domain" };
  if (!isBranch(request.branch) || !isCommit(request.commit))
    return { ok: false, error: "an offer names a branch and a commit" };
  if (request.base !== undefined && (!isBranch(request.base) || request.base === request.branch))
    return {
      ok: false,
      error: "--base names another branch, the one a pull request would go into",
    };
  const id = String(request.repo);
  const clone = clonePath(repo);
  // Two VMs see a share each through its own cache, and nothing makes them agree at once:
  // on vz an entry a workspace has just replaced (a link turned back into a directory, a
  // refs list renamed over) can look as it was to the root for about a second (measured).
  // So what the workspace says it sent is looked for again, briefly, before it is refused.
  let have = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 700));
    await fetchDomain(domain, repo);
    have = (
      await git(clone, [
        "rev-parse",
        "--verify",
        "--quiet",
        `refs/remotes/${domain}/${request.branch}`,
      ])
    ).stdout.trim();
    if (have === request.commit || refusalsOf(domain).some((r) => r.repo === id)) break;
  }
  if (have !== request.commit) {
    const refusal = refusalsOf(domain).find((r) => r.repo === id);
    if (refusal)
      return {
        ok: false,
        error: `the root refused this domain's bundle of ${id}: ${refusal.why}`,
        fix: refusedFix(refusal.why),
      };
    return {
      ok: false,
      error: `the root received ${have ? have.slice(0, 12) : "nothing"} for ${request.branch}, not ${request.commit.slice(0, 12)}`,
      fix: "run `desolate sync`, then offer again",
    };
  }

  // LFS: every object the offer names is verified against its id and its pointer's size
  // before it is the root's. Then every pointer in the offered commits must resolve. All of
  // them: an offer cut to its first 2,000 could never pass, offered again or not. What
  // bounds the list is the request that carries it (docs/v3/limits.md, limits.ts).
  const staged = Array.isArray(request.lfs) ? request.lfs : [];
  for (const item of staged as { oid?: unknown; size?: unknown }[]) {
    if (!isLfsOid(item.oid) || !Number.isInteger(item.size))
      return { ok: false, error: "an LFS object is named by its sha256 and its size" };
    const target = lfsStore(path.join(clone, ".git", "lfs", "objects"), item.oid);
    if (!fs.existsSync(target)) {
      const taken = await takeLfs(domain, id, item.oid, item.size as number, target);
      if ("error" in taken) return { ok: false, error: taken.error, fix: "offer again" };
    } else dropLfs(domain, id, item.oid);
  }
  const missing = await missingLfs(repo, request.commit);
  if (missing.length > 0)
    return {
      ok: false,
      error: `the offered commits reference ${missing.length} LFS object(s) the root does not have (${missing[0]!.slice(0, 12)}...)`,
      fix: "offer again from the workspace that made them",
    };

  // An offer again without --base (a `git push`) keeps the base the branch was offered for.
  const before = offersOf(domain).find((o) => o.repo === id && o.branch === request.branch);
  const base = isBranch(request.base) ? request.base : before?.base;
  const offers = offersOf(domain).filter((o) => !(o.repo === id && o.branch === request.branch));
  // Which workspace offered it, as the workspace says: kept only when it names one of this
  // domain's own (it is shown, and a domain could name another, or write escapes into it).
  const from =
    isSlug(request.workspace) && workspaces(domain).some((w) => w.workspace === request.workspace)
      ? request.workspace
      : "";
  offers.push({
    domain,
    repo: id,
    branch: request.branch,
    commit: request.commit,
    workspace: from,
    lfs: staged.length,
    at: new Date().toISOString(),
    ...(base ? { base } : {}),
  });
  writeJson(file(domain), offers);
  return { ok: true };
};

declare namespace take {
  type Fresh = Invoke<typeof emptyRoot>;
  type Acme = Invoke<typeof aDomain, [slug: "acme", repos: ["acme/app"]]>;
  /** what a workspace's offer must name before the root looks at anything: one of its own
   *  repositories, a branch the root carries, a whole commit, and a base that is another branch.
   *  (Taking one that passes brings the branch into the root clone: T2's.) */
  export type Refuses = Given<
    [Fresh, Acme],
    [
      Expect<
        Invoke<
          typeof take,
          [
            domain: "acme",
            request: {
              repo: "other/app";
              branch: "fix";
              commit: "0123456789abcdef0123456789abcdef01234567";
            },
          ]
        >,
        "=",
        { ok: false; error: "that repository is not in this domain" }
      >,
      Expect<
        Invoke<
          typeof take,
          [
            domain: "acme",
            request: {
              repo: "acme/app";
              branch: "--upload-pack=x";
              commit: "0123456789abcdef0123456789abcdef01234567";
            },
          ]
        >,
        "=",
        { ok: false; error: "an offer names a branch and a commit" }
      >,
      Expect<
        Invoke<
          typeof take,
          [domain: "acme", request: { repo: "acme/app"; branch: "fix"; commit: "HEAD" }]
        >,
        "=",
        { ok: false; error: "an offer names a branch and a commit" }
      >,
      Expect<
        Invoke<
          typeof take,
          [
            domain: "acme",
            request: {
              repo: "acme/app";
              branch: "fix";
              commit: "0123456789abcdef0123456789abcdef01234567";
              base: "fix";
            },
          ]
        >,
        "=",
        { ok: false; error: "--base names another branch, the one a pull request would go into" }
      >,
      Expect<
        Invoke<
          typeof take,
          [
            domain: "acme",
            request: {
              repo: "acme/app";
              branch: "fix";
              commit: "0123456789abcdef0123456789abcdef01234567";
              base: "a..b";
            },
          ]
        >,
        "=",
        { ok: false; error: "--base names another branch, the one a pull request would go into" }
      >,
    ]
  >;
}

export const withdraw = (domain: string, repo: string, branch: string) => {
  writeJson(
    file(domain),
    offersOf(domain).filter((o) => !(o.repo === repo && o.branch === branch)),
  );
};
/** The person's "not this one": the offer leaves "Needs you"; the branch stays in the domain
 *  (`desolate branches`), and offering it again brings it back. Before, an offer left only by
 *  being pushed: one from a removed workspace, or a stand-in agent's, stayed there for good. */
export const dismiss = (
  domainArg: unknown,
  repoArg: unknown,
  branchArg: unknown,
): { ok: true } | { error: string } => {
  const domain = typeof domainArg === "string" && isSlug(domainArg) ? domainArg : null;
  if (!domain || typeof repoArg !== "string" || typeof branchArg !== "string")
    return { error: "an offer is named by its domain, repository and branch" };
  if (!offersOf(domain).some((o) => o.repo === repoArg && o.branch === branchArg))
    return { error: `${domain} has offered no ${repoArg} ${branchArg}` };
  withdraw(domain, repoArg, branchArg);
  return { ok: true };
};

declare namespace dismiss {
  type Fresh = Invoke<typeof emptyRoot>;
  type Offered = Invoke<
    typeof writeJsonIn,
    [
      where: "domains",
      name: "acme/offers.json",
      value: [
        {
          domain: "acme";
          repo: "acme/app";
          branch: "fix";
          commit: "0123456789abcdef0123456789abcdef01234567";
          workspace: "w1";
          lfs: 0;
          at: "2026-11-16T12:00:00.000Z";
        },
        {
          domain: "acme";
          repo: "acme/app";
          branch: "feat";
          commit: "0123456789abcdef0123456789abcdef01234567";
          workspace: "w2";
          lfs: 0;
          at: "2026-11-16T12:00:00.000Z";
        },
      ],
    ]
  >;
  /** the person's "not this one": that offer leaves "Needs you", the others stay */
  export type Dismisses = Given<
    [Fresh, Invoke<typeof aDomain, [slug: "acme", repos: ["acme/app"]]>, Offered],
    [
      Expect<
        Invoke<typeof dismiss, [domainArg: "acme", repoArg: "acme/app", branchArg: "fix"]>,
        "=",
        { ok: true }
      >,
      Expect<Invoke<typeof offersOf, [domain: "acme"]>, "matches", [{ branch: "feat" }]>,
    ]
  >;
  /** an offer is named by its domain, repository and branch, and must be one that was made */
  export type Refuses = Given<
    [Fresh, Invoke<typeof aDomain, [slug: "acme", repos: ["acme/app"]]>, Offered],
    [
      Expect<
        Invoke<typeof dismiss, [domainArg: "acme", repoArg: "acme/app", branchArg: "gone"]>,
        "=",
        { error: "acme has offered no acme/app gone" }
      >,
      Expect<
        Invoke<typeof dismiss, [domainArg: "../acme", repoArg: "acme/app", branchArg: "fix"]>,
        "=",
        { error: "an offer is named by its domain, repository and branch" }
      >,
      Expect<
        Invoke<typeof dismiss, [domainArg: "acme", repoArg: ["acme/app"], branchArg: "fix"]>,
        "=",
        { error: "an offer is named by its domain, repository and branch" }
      >,
      Expect<
        Invoke<typeof offersOf, [domain: "acme"]>,
        "matches",
        [{ branch: "fix" }, { branch: "feat" }]
      >,
    ]
  >;
}

const POINTER =
  /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:([0-9a-f]{64})\nsize (\d+)\n$/;

/** The empty tree: what a branch with nothing before it is compared with. */
const EMPTY = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** git in a root clone, its output as bytes, as they come: for what is too long to hold (a
 *  diff) or is not text (blobs). Nothing the content could steer: no pager, no prompt, no
 *  external diff program, and the root's own config. Ended when `signal` fires (whoever
 *  asked went away). */
const gitBytes = (clone: string, args: string[], signal?: AbortSignal) => {
  if (!ownedByRoot(clone)) throw new Error("not a root clone");
  const child = spawn("git", [...safeIn(clone), "-C", clone, "--no-pager", ...args], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LANG: "C.UTF-8",
      GIT_CONFIG_GLOBAL: GITCONFIG,
      GIT_TERMINAL_PROMPT: "0",
      GIT_PAGER: "cat",
      GIT_EXTERNAL_DIFF: "",
    },
  });
  const end = () => child.kill("SIGKILL");
  if (signal?.aborted) end();
  signal?.addEventListener("abort", end, { once: true });
  // What git says of a failure is short, and its own: kept for the error, against a flood.
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr = (stderr + chunk).slice(-SAFE_MOST)));
  child.stdin.on("error", () => {});
  const ended = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      signal?.removeEventListener("abort", end);
      if (signal?.aborted) reject(new Error("cancelled: whoever asked went away"));
      else if (code !== 0)
        reject(new Error(`git ${args[0]} failed in the root clone: ${printable(stderr.trim())}`));
      else resolve();
    });
  });
  // (Awaited by every caller after its output; a failure before then is not unhandled.)
  ended.catch(() => {});
  return { child, ended };
};

/** How many blobs one `git cat-file --batch` is asked for: each is under LFS_POINTER_BYTES,
 *  so its whole answer is about a megabyte, held while it is read. */
const POINTERS_AT_ONCE = 1000;

/** LFS objects referenced by commits reachable from `commit` and not from origin: each blob
 *  small enough to be a pointer (LFS_POINTER_BYTES) is read, in git's own batches (one git a
 *  thousand blobs, not one a blob: a branch of small files is mostly such blobs). */
export const lfsOf = async (repo: Repo, commit: string): Promise<string[]> => {
  const clone = clonePath(repo);
  const listed = await gitOk(clone, ["rev-list", "--objects", commit, "--not", "--remotes=origin"]);
  const ids = listed
    .split("\n")
    .map((line) => line.split(" ")[0]!)
    .filter((id) => /^[0-9a-f]{40,64}$/.test(id));
  if (ids.length === 0) return [];
  const sizes = await gitOk(
    clone,
    ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
    { input: ids.join("\n") + "\n" },
  );
  const small = sizes
    .split("\n")
    .map((line) => line.split(" "))
    .filter(([, type, size]) => type === "blob" && Number(size) < LFS_POINTER_BYTES)
    .map(([id]) => id!);
  const oids = new Set<string>();
  for (let at = 0; at < small.length; at += POINTERS_AT_ONCE) {
    const { child, ended } = gitBytes(clone, ["cat-file", "--batch"]);
    child.stdin.end(small.slice(at, at + POINTERS_AT_ONCE).join("\n") + "\n");
    const chunks: Buffer[] = [];
    for await (const chunk of child.stdout) chunks.push(chunk as Buffer);
    await ended;
    for (const blob of blobsOf(Buffer.concat(chunks))) {
      const match = POINTER.exec(blob);
      if (match) oids.add(match[1]!);
    }
  }
  return [...oids];
};

/** The blobs in `git cat-file --batch`'s answer, each as text: a line "<id> <type> <size>",
 *  then that many bytes, then a newline. Read by the sizes git states, never by looking for
 *  a line in a blob's own bytes. */
export const blobsOf = (answer: Uint8Array): string[] => {
  const bytes = Buffer.from(answer.buffer, answer.byteOffset, answer.byteLength);
  const out: string[] = [];
  for (let at = 0; at < bytes.length;) {
    const line = bytes.indexOf(10, at);
    if (line < 0) break;
    const size = Number(bytes.subarray(at, line).toString("latin1").split(" ")[2]);
    // ("<id> missing", or anything that is not a size: nothing to read, and the next line.)
    if (!Number.isInteger(size)) {
      at = line + 1;
      continue;
    }
    out.push(bytes.subarray(line + 1, line + 1 + size).toString("utf8"));
    at = line + 1 + size + 1;
  }
  return out;
};

declare namespace blobsOf {
  /** each blob by the size git states for it: one whose own text holds a line that looks
   *  like the next blob's is still one blob; one git does not have is no blob */
  export type Reads = Table<
    typeof blobsOf,
    [
      [
        args: [
          answer: Invoke<
            typeof repeated,
            [
              text: "1111 blob 3\nabc\n2222 blob 12\nx\n3333 blob \n3333 missing\n4444 blob 0\n\n",
              count: 1,
            ]
          >,
        ],
        expected: ["abc", "x\n3333 blob ", ""],
      ],
      [args: [answer: Invoke<typeof repeated, [text: "", count: 1]>], expected: []],
    ]
  >;
}

const missingLfs = async (repo: Repo, commit: string) =>
  (await lfsOf(repo, commit)).filter(
    (oid) =>
      !fs.existsSync(lfsStore(path.join(clonePath(repo), ".git", "lfs", "objects"), oid)) &&
      !fs.existsSync(lfsStore(path.join(mirrorPath(repo), "lfs", "objects"), oid)),
  );

// ------------------------------------------------------------------ the review
// What a push would send (section 8: `desolate review`, and the dashboard's Review), read
// from the root clone only. Its lists are counted and paged (docs/v3/limits.md, R2): each
// travels as a page and the true total (shared/listed.ts), and the next page is asked for
// (`more`). Its diff is asked for a file at a time, in pages of bytes (`diff`). So no list
// has a cap, no number a person is shown is the size of a cut, and nothing here has a timer:
// git runs until it is done, or until whoever asked goes away (R4).

/** `author`: its name and email; `body`: its message after the subject (bodyOf). */
export type Commit = { commit: string; subject: string; author: string; body: string };
/** A file a diff changes: how, and how many lines (null: binary). `was`: the path a renamed
 *  file had. */
export type Change = {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "changed";
  added: number | null;
  removed: number | null;
  was?: string;
  /** Its name only looks like one that runs on the forge, or like README.md (lookalike). */
  lookalike?: boolean;
};
export type Review = {
  domain: string;
  repo: string;
  branch: string;
  commit: string;
  base: string;
  against: Against;
  againstLabel: string;
  defaultBranch: string | null;
  pushable: boolean;
  isDefault: boolean;
  /** Newest first. `total`: every commit between what it is compared with and its tip. */
  commits: Listed<Commit>;
  /** Each file changed, for the review's list. `total`: every file the branch changes. */
  changes: Listed<Change>;
  stat: string;
  lfsObjects: number;
  warnings: string[];
  /** How many commits a push would send: against origin, whatever the view compares with. */
  pushCommits: number;
};

/** The files a diff changes, from git's own `--name-status -z` and `--numstat -z`, both made
 *  with renames found: a moved file is one entry, with the path it had. All of them: the
 *  list is paged where it is sent, never cut where it is made. Paths are data, shown as text. */
export const changesOf = (nameStatus: string, numstat: string): Change[] => {
  const counts = new Map<string, { added: number | null; removed: number | null }>();
  const counted = numstat.split("\0");
  for (let i = 0; i < counted.length && counted[i]; i++) {
    const [added, removed, ...rest] = counted[i]!.split("\t");
    // (A renamed file: no path on the line itself, then the old path and the new.)
    const path = rest.join("\t") || counted[(i += 2)]!;
    counts.set(path, {
      added: added === "-" ? null : Number(added),
      removed: removed === "-" ? null : Number(removed),
    });
  }
  const parts = nameStatus.split("\0");
  const out: Change[] = [];
  for (let i = 0; i + 1 < parts.length && parts[i]; i += 2) {
    const letter = parts[i]![0]!;
    const moved = letter === "R" || letter === "C";
    const path = parts[moved ? i + 2 : i + 1]!;
    out.push({
      path,
      status:
        letter === "A"
          ? "added"
          : letter === "D"
            ? "deleted"
            : letter === "M"
              ? "modified"
              : letter === "R"
                ? "renamed"
                : "changed",
      ...(counts.get(path) ?? { added: null, removed: null }),
      ...(letter === "R" ? { was: parts[i + 1]! } : {}),
      ...(lookalike(path) ? { lookalike: true } : {}),
    });
    if (moved) i += 1;
  }
  return out;
};

declare namespace changesOf {
  export type Three = Expect<
    Invoke<
      typeof changesOf,
      [
        nameStatus: "M\u0000src/a.ts\u0000A\u0000docs/new.md\u0000D\u0000logo.png\u0000",
        numstat: "3\t1\tsrc/a.ts\u000010\t0\tdocs/new.md\u0000-\t-\tlogo.png\u0000",
      ]
    >,
    "=",
    [
      { path: "src/a.ts"; status: "modified"; added: 3; removed: 1 },
      { path: "docs/new.md"; status: "added"; added: 10; removed: 0 },
      { path: "logo.png"; status: "deleted"; added: null; removed: null },
    ]
  >;
  /** a moved file is one change, with the path it had and the lines that differ; what
   *  follows it is read from the right place */
  export type Renamed = Expect<
    Invoke<
      typeof changesOf,
      [
        nameStatus: "R087\u0000lib/old.ts\u0000src/new.ts\u0000M\u0000README.md\u0000",
        numstat: "2\t1\t\u0000lib/old.ts\u0000src/new.ts\u00001\t0\tREADME.md\u0000",
      ]
    >,
    "=",
    [
      { path: "src/new.ts"; status: "renamed"; added: 2; removed: 1; was: "lib/old.ts" },
      { path: "README.md"; status: "modified"; added: 1; removed: 0 },
    ]
  >;
  export type Nothing = Expect<Invoke<typeof changesOf, [nameStatus: "", numstat: ""]>, "=", []>;
  /** a name that only looks like README.md (its E is Cyrillic) says so */
  export type Lookalike = Expect<
    Invoke<
      typeof changesOf,
      [nameStatus: "A\u0000READM\u0415.md\u0000", numstat: "1\t0\tREADM\u0415.md\u0000"]
    >,
    "=",
    [{ path: "READM\u0415.md"; status: "added"; added: 1; removed: 0; lookalike: true }]
  >;
}

/** What a branch is compared with: the remote's default branch as the mirror has it
 *  ("origin"), or the domain's own copy of it ("domain": what this domain's agents built on,
 *  which may be ahead of the remote with their merged work). */
export type Against = "origin" | "domain";
export const againstOf = (value: unknown): Against => (value === "domain" ? "domain" : "origin");
declare namespace againstOf {
  /** what a review compares with: the domain's own copy of the default branch when asked, else
   *  the remote's (what a push is against) */
  export type Choices = Table<
    typeof againstOf,
    [
      [args: [value: "domain"], expected: "domain"],
      [args: [value: "origin"], expected: "origin"],
      [args: [value: "anything else"], expected: "origin"],
      [args: [value: null], expected: "origin"],
    ]
  >;
}

/** git's diff of two commits in a root clone, with nothing the content could steer: no
 *  external diff program, no textconv, and renames found the same way for every part of a
 *  review (its list of files, its counts, its text). */
const DIFF = ["diff", "--no-ext-diff", "--no-textconv", "--find-renames"];
const changesBetween = async (clone: string, left: string, right: string, signal?: AbortSignal) =>
  changesOf(
    await gitOk(clone, [...DIFF, "--name-status", "-z", left, right], { signal }),
    await gitOk(clone, [...DIFF, "--numstat", "-z", left, right], { signal }),
  );

/** The branch a review is of, as the root clone has it now, and what it is compared with. */
type Target = {
  domain: string;
  repo: Repo;
  id: string;
  branch: string;
  clone: string;
  commit: string;
  base: string;
  against: Against;
  defaultBranch: string | null;
  pushable: boolean;
};
/** `fetch`: bring the domain's branches into the root clone first (a review does; a page of
 *  one reads the clone as it is, and says which commit it read, so a branch that moved
 *  between two pages is seen by whoever put them together). */
const targetOf = async (
  domain: string,
  repoArg: unknown,
  branch: unknown,
  againstArg: unknown,
  fetch: boolean,
  signal?: AbortSignal,
): Promise<Target> => {
  const against = againstOf(againstArg);
  const d = domainOf(domain);
  const repo =
    parseRepo(repoArg) ??
    refuse(`'${String(repoArg)}' is not a repository`, "name it as <owner>/<repo>");
  const id = `${repo.owner}/${repo.name}`;
  if (!d.repos.includes(id))
    refuse(`${id} is not in the domain '${domain}'`, `desolate domain ${domain} show`);
  if (!isBranch(branch)) refuse(`'${String(branch)}' is not a branch`, `desolate offers ${domain}`);
  const record = recordOf(repo);
  if (fetch) await fetchDomain(domain, repo);
  const clone = clonePath(repo);
  const commit = (
    await git(clone, ["rev-parse", "--verify", "--quiet", `refs/remotes/${domain}/${branch}`])
  ).stdout.trim();
  if (!commit)
    refuse(
      `the domain '${domain}' has no branch '${branch}' of ${id}`,
      `desolate offers ${domain}`,
    );
  const upstream = !record.defaultBranch
    ? ""
    : against === "domain"
      ? `refs/remotes/${domain}/${record.defaultBranch}`
      : `refs/remotes/origin/${record.defaultBranch}`;
  if (
    upstream &&
    against === "domain" &&
    !(await git(clone, ["rev-parse", "--verify", "--quiet", upstream])).stdout.trim()
  )
    refuse(
      `the domain '${domain}' has no ${record.defaultBranch} of ${id} to compare with`,
      "compare with origin instead",
    );
  const base = upstream ? (await git(clone, ["merge-base", commit, upstream])).stdout.trim() : "";
  return {
    domain,
    repo,
    id,
    branch,
    clone,
    commit,
    base,
    against,
    defaultBranch: record.defaultBranch,
    pushable: record.pushable,
  };
};

/** A whole number from 0 up, from whoever asks for a page: anything else is the start. */
const placeOf = (value: unknown): number => {
  const n = typeof value === "string" && /^\d{1,15}$/.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
};

/** How many commits `range` holds, by git's own count: the cheap exact tool. */
const countIn = async (clone: string, range: string) =>
  Number((await gitOk(clone, ["rev-list", "--count", range])).trim()) || 0;

/** A commit's message after its subject, as the review shows it on asking: its lines kept,
 *  made safe, and bounded against a flood as any one text is (SAFE_MOST), the cut marked
 *  (also when what was cut is only spaces before more: the fresh review of this change). */
const bodyOf = (body: string) => {
  const long = body.length > SAFE_MOST * 4;
  const chars = [...printableLines(long ? body.slice(0, SAFE_MOST * 4) : body.trimEnd())];
  return long || chars.length > SAFE_MOST
    ? `${chars.slice(0, SAFE_MOST - 1).join("")}${CUT}`
    : chars.join("");
};

/** A page of a range's commits, newest first, and how many it holds in all. Its subject,
 *  author and message are a commit's own text: made safe to show, and bounded against a
 *  flood (shared/text.ts). (git shows no message past a NUL, so one ends each field.) */
const commitsIn = async (clone: string, range: string, from: number): Promise<Listed<Commit>> => {
  const total = await countIn(clone, range);
  const start = Math.min(from, total);
  const log =
    start < total
      ? await gitOk(clone, [
          "log",
          "--format=%H%x00%an <%ae>%x00%s%x00%b%x00",
          `--skip=${start}`,
          `--max-count=${PAGE}`,
          range,
        ])
      : "";
  return {
    items: log
      .split("\x00\n")
      .filter(Boolean)
      .map((entry) => entry.split("\x00"))
      .map(([commit, author, subject, body]) => ({
        commit: commit!,
        subject: printable(subject),
        author: printable(author),
        body: bodyOf(body ?? ""),
      })),
    total,
    from: start,
  };
};

export const review = async (
  domain: string,
  repoArg: unknown,
  branch: unknown,
  againstArg: unknown = "origin",
  signal?: AbortSignal,
): Promise<Review> => {
  const t = await targetOf(domain, repoArg, branch, againstArg, true, signal);
  const { clone, commit, base, against } = t;
  const commits = await commitsIn(clone, base ? `${base}..${commit}` : commit, 0);
  const changes = await changesBetween(clone, base || EMPTY, commit, signal);
  const stat = (await gitOk(clone, [...DIFF, "--shortstat", base || EMPTY, commit])).trim();
  // What a push would actually send is always against origin, whatever the view compares
  // with: the warnings, and the count of commits a push sends, are worked out over that range
  // (a domain's own main is the agent's to write: a change hidden there is still sent).
  const originHead = t.defaultBranch ? `refs/remotes/origin/${t.defaultBranch}` : "";
  const originBase =
    against === "origin"
      ? base
      : originHead
        ? (await git(clone, ["merge-base", commit, originHead])).stdout.trim()
        : "";
  // Every path a push touches: where each file is, and where a moved one was.
  const pushFiles = (
    against === "origin"
      ? changes
      : await changesBetween(clone, originBase || EMPTY, commit, signal)
  ).flatMap((c) => (c.was === undefined ? [c.path] : [c.path, c.was]));
  const pushCommits =
    against === "origin"
      ? commits.total
      : await countIn(clone, originBase ? `${originBase}..${commit}` : commit);
  const warnings: string[] = [];
  if (pushFiles.some((f) => f === ".github" || f.startsWith(".github/")))
    warnings.push(
      "changes .github/: a pushed branch's own workflows run on the remote, with the repository's secrets",
    );
  if (pushFiles.some((f) => /(^|\/)\.suede\/core\//.test(f)))
    warnings.push(
      "changes a vendored .suede/core/: a proposal that rewrites suede's own machinery is worth a second look",
    );
  if (pushFiles.some((f) => f === ".lfsconfig" || f === ".gitattributes" || f === ".gitmodules"))
    warnings.push(
      "changes .lfsconfig, .gitattributes or .gitmodules: these steer what git does with this repository elsewhere",
    );
  return {
    domain,
    repo: t.id,
    branch: t.branch,
    commit,
    base,
    against,
    againstLabel: t.defaultBranch
      ? against === "domain"
        ? `${domain}'s ${t.defaultBranch}`
        : `origin/${t.defaultBranch}`
      : "nothing (no default branch)",
    defaultBranch: t.defaultBranch,
    pushable: t.pushable,
    isDefault: t.branch === t.defaultBranch,
    commits,
    changes: listed(changes),
    stat,
    lfsObjects: (await lfsOf(t.repo, commit)).length,
    warnings,
    pushCommits,
  };
};

/** Some of a review's commits, picked on the dashboard: `from` (the oldest picked) to `to`
 *  (the newest), each named whole. None asked: null, the whole review. Half a run, or a
 *  name that is not a commit's id, is refused, never guessed. (That each is one of the
 *  review's own, and in order, is asked of git: `picked`.) */
export const pickOf = (from: unknown, to: unknown): { from: string; to: string } | null => {
  if ((from === null || from === undefined) && (to === null || to === undefined)) return null;
  for (const end of [from, to])
    if (typeof end !== "string" || !/^[0-9a-f]{40}$/.test(end))
      refuse(
        `'${printable(String(end), 40)}' is not one of this review's commits`,
        "pick commits from the review's list",
      );
  return { from: from as string, to: to as string };
};

declare namespace pickOf {
  /** none asked: the whole review; a run named by two whole commits: those; anything else (a
   *  name, half a run): refused */
  export type Picks = [
    Expect<Invoke<typeof pickOf, [from: null, to: null]>, "=", null>,
    Expect<
      Invoke<
        typeof pickOf,
        [
          from: "2222222222222222222222222222222222222222",
          to: "1111111111111111111111111111111111111111",
        ]
      >,
      "=",
      {
        from: "2222222222222222222222222222222222222222";
        to: "1111111111111111111111111111111111111111";
      }
    >,
  ];
  export type Refused = [
    Throws<
      Invoke<typeof pickOf, [from: "HEAD", to: "1111111111111111111111111111111111111111"]>,
      "'HEAD' is not one of this review's commits"
    >,
    Throws<
      Invoke<typeof pickOf, [from: "1111111111111111111111111111111111111111", to: null]>,
      "'null' is not one of this review's commits"
    >,
  ];
}

/** What is compared for a view of a review: all of it (its base with its tip), or the
 *  commits picked (the oldest one's parent, or the empty tree for a first commit, with the
 *  newest). A commit picked is one of the review's own, whichever page of its list it is
 *  on: git says whether it is between the base and the tip. And the run is in order. */
const picked = async (
  t: Target,
  from: unknown,
  to: unknown,
): Promise<{ left: string; right: string; pick: { from: string; to: string } | null }> => {
  const pick = pickOf(from, to);
  if (!pick) return { left: t.base || EMPTY, right: t.commit, pick };
  const within = async (older: string, newer: string) =>
    (await git(t.clone, ["merge-base", "--is-ancestor", older, newer])).code === 0;
  for (const end of [pick.from, pick.to])
    if (!(await within(end, t.commit)) || (t.base && (await within(end, t.base))))
      refuse(`'${end}' is not one of this review's commits`, "pick commits from the review's list");
  if (!(await within(pick.from, pick.to)))
    refuse(
      "the commits picked are not in order: the first is not before the last",
      "pick a run of the review's commits",
    );
  const parent = (
    await git(t.clone, ["rev-parse", "--verify", "--quiet", `${pick.from}^`])
  ).stdout.trim();
  return { left: parent || EMPTY, right: pick.to, pick };
};

/** What whoever shows a review asks for after its first page. Every field is theirs, so
 *  each is checked here: a place that is not one is the start, and a text is text. */
type Ask = Record<string, unknown> | null | undefined;
const textOf = (value: unknown): string => (typeof value === "string" ? value : "");

/** The next page of one of a review's lists. `list: "commits"` from entry `from`; else its
 *  files, from entry `from`: of the commits picked (`pickFrom`, `pickTo`) when some are, and
 *  only those whose path holds `filter`, when one is given (then `of` is how many there are
 *  before the filter). It reads the root clone as it is, and says which commit it read. */
export const more = async (
  domain: string,
  repoArg: unknown,
  branch: unknown,
  againstArg: unknown,
  ask: Ask,
  signal?: AbortSignal,
): Promise<
  | { commit: string; commits: Listed<Commit> }
  | { commit: string; changes: Listed<Change>; of: number; pick?: { from: string; to: string } }
> => {
  const t = await targetOf(domain, repoArg, branch, againstArg, false, signal);
  const from = placeOf(ask?.from);
  if (ask?.list === "commits")
    return {
      commit: t.commit,
      commits: await commitsIn(t.clone, t.base ? `${t.base}..${t.commit}` : t.commit, from),
    };
  const { left, right, pick } = await picked(t, ask?.pickFrom, ask?.pickTo);
  const all = await changesBetween(t.clone, left, right, signal);
  const filter = textOf(ask?.filter).toLowerCase();
  return {
    commit: t.commit,
    changes: listed(filter ? all.filter((c) => c.path.toLowerCase().includes(filter)) : all, from),
    of: all.length,
    ...(pick ? { pick } : {}),
  };
};

/** A page of a diff, not a cap: the next is asked for. One answer between two layers, and
 *  what a page draws at once: 3,000 lines is where drawing a diff stopped being quick (a
 *  long one drawn again cost up to half a second: measured for the dashboard), and 256 KiB
 *  is those lines at their usual length, so that a few very long lines are a page too. */
export const DIFF_PAGE = { bytes: 256 * 1024, lines: 3000 } as const;

/** The page of a diff that starts at byte `from`, from the diff's bytes as they come: cut
 *  after a line (the last that fits in `most.bytes`, and no more than `most.lines` of
 *  them), `next` where the following page starts (null: this one ends the diff), `total`
 *  the whole diff's size. Only the page is held, whatever the diff's length. A single line
 *  longer than a page is cut inside itself, between two characters: its rest starts the
 *  next page, so the pages put end to end are always the diff, byte for byte. */
export const diffPage = async (
  bytes: AsyncIterable<Uint8Array | string> | Iterable<Uint8Array | string>,
  from = 0,
  most: { bytes: number; lines: number } = DIFF_PAGE,
): Promise<DiffPage> => {
  const held: Buffer[] = [];
  let size = 0;
  let total = 0;
  for await (const piece of bytes) {
    const chunk = Buffer.isBuffer(piece) ? piece : Buffer.from(piece);
    const skip = Math.min(chunk.length, Math.max(0, from - total));
    total += chunk.length;
    // One byte more than a page is held: enough to know that the diff goes on.
    const take = chunk.subarray(skip, skip + Math.max(0, most.bytes + 1 - size));
    if (take.length > 0) held.push(take);
    size += take.length;
  }
  const start = Math.min(from, total);
  const all = Buffer.concat(held);
  let cut = Math.min(all.length, most.bytes);
  let lines = 0;
  for (let at = all.indexOf(10); at >= 0 && at < cut; at = all.indexOf(10, at + 1))
    if (++lines === most.lines) cut = at + 1;
  if (cut < all.length) {
    const line = all.lastIndexOf(10, cut - 1);
    if (line >= 0) cut = line + 1;
    // No line ends in the page: cut between two characters, not inside one. A character is
    // at most 4 bytes, so at most 3 are given back: bytes that are not UTF-8 at all (a run of
    // continuation bytes, which a branch can hold) are cut where the page ends, and a page is
    // never one byte (found by the review of this change).
    else for (let back = 0; back < 3 && cut > 1 && (all[cut]! & 0xc0) === 0x80; back++) cut -= 1;
  }
  return {
    text: all.subarray(0, cut).toString("utf8"),
    from: start,
    next: cut < all.length ? start + cut : null,
    total,
  };
};

declare namespace diffPage {
  /** a diff that fits is one page, whole, however its bytes arrived */
  export type Whole = Expect<
    Invoke<typeof diffPage, [bytes: ["+a\n-", "b\n c\n"]]>,
    "=",
    { text: "+a\n-b\n c\n"; from: 0; next: null; total: 9 }
  >;
  /** a longer one is cut after a line: the last that fits in the bytes, and no more lines
   *  than a page has; `next` is where the following page starts */
  export type Pages = [
    Expect<
      Invoke<
        typeof diffPage,
        [bytes: ["+one\n+two\n+three\n"], from: 0, most: { bytes: 12; lines: 9 }]
      >,
      "=",
      { text: "+one\n+two\n"; from: 0; next: 10; total: 17 }
    >,
    Expect<
      Invoke<
        typeof diffPage,
        [bytes: ["+one\n+two\n+three\n"], from: 10, most: { bytes: 12; lines: 9 }]
      >,
      "=",
      { text: "+three\n"; from: 10; next: null; total: 17 }
    >,
    Expect<
      Invoke<
        typeof diffPage,
        [bytes: ["+one\n+two\n+three\n"], from: 0, most: { bytes: 99; lines: 1 }]
      >,
      "=",
      { text: "+one\n"; from: 0; next: 5; total: 17 }
    >,
    /** a page that ends exactly where the diff does has no next */
    Expect<
      Invoke<typeof diffPage, [bytes: ["+one\n+two\n"], from: 5, most: { bytes: 5; lines: 9 }]>,
      "=",
      { text: "+two\n"; from: 5; next: null; total: 10 }
    >,
  ];
  /** one line longer than a page: cut inside it, between two characters (é is two bytes),
   *  and its rest starts the next page */
  export type LongLine = [
    Expect<
      Invoke<typeof diffPage, [bytes: ["+aé", "éz\n"], from: 0, most: { bytes: 5; lines: 9 }]>,
      "=",
      { text: "+aé"; from: 0; next: 4; total: 8 }
    >,
    Expect<
      Invoke<typeof diffPage, [bytes: ["+aé", "éz\n"], from: 4, most: { bytes: 5; lines: 9 }]>,
      "=",
      { text: "éz\n"; from: 4; next: null; total: 8 }
    >,
  ];
  /** bytes that are not UTF-8 (a run of continuation bytes, from a branch): at most three
   *  are given back, so a page is never a byte (control: é above is given back one) */
  export type NotUtf8 = Expect<
    Invoke<
      typeof diffPage,
      [
        bytes: [Invoke<typeof repeated, [text: "\u0080", count: 10]>],
        from: 0,
        most: { bytes: 6; lines: 9 },
      ]
    >,
    "=",
    { text: "\ufffd\ufffd\ufffd"; from: 0; next: 3; total: 10 }
  >;
  /** a place past the end, from whoever asked: the empty page at the end */
  export type Past = Expect<
    Invoke<typeof diffPage, [bytes: ["+a\n"], from: 40]>,
    "=",
    { text: ""; from: 3; next: null; total: 3 }
  >;
}

/** A page of the diff a push would send, as text, for a person to read before they push it.
 *  Made by git from objects in the root clone, with nothing the content could steer
 *  (`gitBytes`, `DIFF`), and no checkout: two commits are compared, and no file of the branch
 *  is ever written into the root's working tree. The text is the content's, so whoever shows
 *  it shows it as text.
 *
 *  `ask` is whoever shows it's: `file` (and `was`, the path a renamed one had), for that
 *  file's diff alone, else every file's; `at`, the byte the page starts at; `pickFrom` and
 *  `pickTo`, for the commits picked; `whitespace: "ignore"`. A path is taken as it is
 *  written, never as a pattern. There is no size past which a diff is not made, and no time:
 *  it comes in pages (DIFF_PAGE), and git runs until the page's diff is done or `signal`
 *  says whoever asked went away. It reads the root clone as it is, and says which commit. */
export const diff = async (
  domain: string,
  repoArg: unknown,
  branch: unknown,
  against: unknown = "origin",
  ask: Ask = null,
  signal?: AbortSignal,
): Promise<
  DiffPage & {
    repo: string;
    branch: string;
    commit: string;
    base: string;
    against: Against;
    whitespace: "show" | "ignore";
    file?: string;
    pick?: { from: string; to: string };
  }
> => {
  // Asked for whole (`desolate review --diff`, with nothing said): the branch as it is now.
  const t = await targetOf(domain, repoArg, branch, against, ask === null, signal);
  const { left, right, pick } = await picked(t, ask?.pickFrom, ask?.pickTo);
  const paths = [ask?.file, ask?.was].map(textOf).filter(Boolean);
  if (paths.some((p) => p.includes("\0"))) refuse("that is not a file's path", "name a file");
  const whitespace = ask?.whitespace === "ignore" ? "ignore" : "show";
  const { child, ended } = gitBytes(
    t.clone,
    [
      "--literal-pathspecs",
      ...DIFF,
      "--no-color",
      "--unified=3",
      // histogram: hunks that follow the code's own structure (git's, no new parser); -w on asking,
      // for a change that is mostly re-indentation.
      "--diff-algorithm=histogram",
      ...(whitespace === "ignore" ? ["-w"] : []),
      left,
      right,
      "--",
      ...paths,
    ],
    signal,
  );
  child.stdin.end();
  const page = await diffPage(child.stdout, placeOf(ask?.at));
  await ended;
  return {
    repo: t.id,
    branch: t.branch,
    commit: t.commit,
    base: t.base,
    against: t.against,
    whitespace,
    ...(paths[0] ? { file: paths[0] } : {}),
    ...(pick ? { pick } : {}),
    ...page,
  };
};
