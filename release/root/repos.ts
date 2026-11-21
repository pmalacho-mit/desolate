// Repositories in the root: keys, the mirror (what the remote published, LFS included) and
// the root clone (the person's own). Sections 5.3, 6.1-6.3.
import * as fs from "node:fs";
import * as path from "node:path";
import { readJson, writeJson } from "../shared/json.ts";
import { isBranch, repoId } from "../shared/names.ts";
import type { Repo } from "../shared/names.ts";
import { refuse } from "../shared/exit.ts";
import { withLock } from "../shared/lock.ts";
import { downstreamRefusal } from "../shared/suede.ts";
import {
  FORGE_IDLE_MS,
  forge,
  git,
  gitBare,
  gitOk,
  gitSaid,
  remoteUrl,
  safeIn,
  sshCommand,
} from "./git.ts";
import { ask } from "./keyring-client.ts";
import { clonePath, HOOKS, KEYRING, MIRROR_HOOKS, mirrorPath, REGISTRY, ROOT } from "./layout.ts";
import { settle } from "./pushed.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Given, Invoke } from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { refusalOf } from "../.harness/refusal.ts";
import type { aRegistry, emptyRoot, writeJsonIn } from "../.harness/root-state.ts";

export type RepoRecord = {
  /** The root holds a write key for it. A domain has no access level: every domain reads,
   *  only the root writes. */
  pushable: boolean;
  /** No key could be added (someone else's public repository): fetched without one. */
  anonymous: boolean;
  defaultBranch: string | null;
  fetchedAt: string | null;
};
type Registry = { repos: Record<string, RepoRecord> };

export const registry = (): Registry => readJson<Registry>(REGISTRY, { repos: {} });
const save = (value: Registry) => writeJson(REGISTRY, value);
export const recordOf = (repo: Repo): RepoRecord =>
  registry().repos[repoId(repo)] ??
  refuse(`${repoId(repo)} is not cloned into the root`, `desolate clone ${repoId(repo)}`);

declare namespace recordOf {
  type Fresh = Invoke<typeof emptyRoot>;
  /** what the root knows of a repository it cloned: whether it holds a write key, and the
   *  remote's default branch as last fetched */
  export type Known = Given<
    [
      Fresh,
      Invoke<
        typeof aRegistry,
        [repos: { "acme/app": { pushable: false; defaultBranch: "trunk" } }]
      >,
    ],
    Expect<
      Invoke<typeof recordOf, [repo: { owner: "acme"; name: "app" }]>,
      "=",
      { pushable: false; anonymous: false; defaultBranch: "trunk"; fetchedAt: null }
    >
  >;
  /** one it never cloned is a refusal that says how */
  export type Unknown = Given<
    Fresh,
    Expect<
      Invoke<typeof refusalOf, [f: typeof recordOf, args: [repo: { owner: "acme"; name: "app" }]]>,
      "=",
      { message: "acme/app is not cloned into the root"; fix: "desolate clone acme/app"; code: 1 }
    >
  >;
}

declare namespace list {
  type Fresh = Invoke<typeof emptyRoot>;
  /** every repository the root holds, by name */
  export type Sorted = Given<
    [
      Fresh,
      Invoke<
        typeof aRegistry,
        [repos: { "zeta/app": {}; "acme/web": { pushable: false }; "acme/api": {} }]
      >,
    ],
    Expect<
      Invoke<typeof list>,
      "matches",
      [
        { repo: "acme/api"; pushable: true },
        { repo: "acme/web"; pushable: false },
        { repo: "zeta/app" },
      ]
    >
  >;
  /** none yet: an empty registry, not an error */
  export type None = Given<Fresh, Expect<Invoke<typeof list>, "=", []>>;
}

const NOWHERE = "/dev/null/desolate/this-repository-is-not-pushable";

const keyring = async (request: Record<string, unknown>) => {
  const reply = await ask(KEYRING.control, request);
  if (reply.ok !== true) throw new Error(`keyring: ${String(reply.error)}`);
  return reply;
};

/** Step 1 of `desolate clone`: make the keys and say which public halves the forge needs.
 *  The host registers them (it has the person's `gh`; the root has no forge credentials). */
export const prepare = async (repo: Repo, options: { push: boolean; anonymous: boolean }) => {
  const all = registry();
  const existing = all.repos[repoId(repo)];
  const record: RepoRecord = existing ?? {
    pushable: false,
    anonymous: options.anonymous,
    defaultBranch: null,
    fetchedAt: null,
  };
  const keys: { role: "read" | "write"; pubkey: string }[] = [];
  if (!options.anonymous) {
    record.anonymous = false;
    keys.push({
      role: "read",
      pubkey: String((await keyring({ op: "create", repo: repoId(repo), role: "read" })).pubkey),
    });
  }
  if (options.push) {
    if (options.anonymous)
      refuse(
        "a repository fetched anonymously cannot be pushable: a push needs a write key",
        "drop --anonymous, or add --no-push",
      );
    record.pushable = true;
    keys.push({
      role: "write",
      pubkey: String((await keyring({ op: "create", repo: repoId(repo), role: "write" })).pubkey),
    });
  }
  all.repos[repoId(repo)] = record;
  save(all);
  return { repo: repoId(repo), pushable: record.pushable, anonymous: record.anonymous, keys };
};

const fetchUrl = (repo: Repo, record: RepoRecord) => {
  const f = forge();
  if (!record.anonymous) return remoteUrl(repo, f);
  if (f.kind !== "github")
    refuse(
      "anonymous fetches are for public GitHub repositories",
      "clone it with a read key instead (drop --anonymous)",
    );
  return `https://github.com/${repo.owner}/${repo.name}.git`;
};

declare namespace fetchUrl {
  type Fresh = Invoke<typeof emptyRoot>;
  type GitHub = Invoke<
    typeof writeJsonIn,
    [
      where: "state",
      name: "forge.json",
      value: { kind: "github"; ssh: { user: "git"; host: "github.com"; port: 22 }; knownHosts: "" },
    ]
  >;
  /** with a read key, over ssh; without one (someone else's public repository), GitHub's https */
  export type Ways = Given<
    [Fresh, GitHub],
    [
      Expect<
        Invoke<
          typeof fetchUrl,
          [
            repo: { owner: "acme"; name: "app" },
            record: { pushable: true; anonymous: false; defaultBranch: null; fetchedAt: null },
          ]
        >,
        "=",
        "ssh://git@github.com:22/acme/app.git"
      >,
      Expect<
        Invoke<
          typeof fetchUrl,
          [
            repo: { owner: "acme"; name: "app" },
            record: { pushable: false; anonymous: true; defaultBranch: null; fetchedAt: null },
          ]
        >,
        "=",
        "https://github.com/acme/app.git"
      >,
    ]
  >;
  /** anonymous fetches are GitHub's alone: a stand-in forge is reached with a key */
  export type NotGitHub = Given<
    [
      Fresh,
      Invoke<
        typeof writeJsonIn,
        [
          where: "state",
          name: "forge.json",
          value: {
            kind: "stand-in";
            ssh: { user: "git"; host: "forge"; port: 2222 };
            knownHosts: "";
          },
        ]
      >,
    ],
    Expect<
      Invoke<
        typeof refusalOf,
        [
          f: typeof fetchUrl,
          args: [
            repo: { owner: "acme"; name: "app" },
            record: { pushable: false; anonymous: true; defaultBranch: null; fetchedAt: null },
          ],
        ]
      >,
      "=",
      {
        message: "anonymous fetches are for public GitHub repositories";
        fix: "clone it with a read key instead (drop --anonymous)";
        code: 1;
      }
    >
  >;
}

const config = async (dir: string, pairs: Record<string, string>) => {
  for (const [key, value] of Object.entries(pairs)) await gitOk(dir, ["config", key, value]);
};

/** Remote -> mirror (section 6.4), with the read key alone. Then the root clone, if new. */
/** What the remote's branch is, as the mirror last saw it (null: the remote has no such
 *  branch). A push names it as the commit the branch moves from (shared/approval.ts). */
export const remoteTip = async (repo: Repo, branch: string): Promise<string | null> => {
  const found = await git(mirrorPath(repo), [
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/heads/${branch}^{commit}`,
  ]);
  const id = found.stdout.trim();
  return found.code === 0 && /^[0-9a-f]{40}$/.test(id) ? id : null;
};

/** suede's rule for a `downstream/...` branch (shared/suede.ts): asked of the root clone,
 *  against every branch the remote has, as the mirror last saw them. Why not, or null. */
export const downstreamCheck = async (repo: Repo, commit: string): Promise<string | null> => {
  const tips = (
    await git(mirrorPath(repo), ["for-each-ref", "--format=%(objectname)", "refs/heads"])
  ).stdout
    .split("\n")
    .filter((id) => /^[0-9a-f]{40}$/.test(id));
  return downstreamRefusal((args) => git(clonePath(repo), args), commit, tips);
};

const fetchNow = async (repo: Repo, log: (line: string) => void, signal?: AbortSignal) => {
  const record = recordOf(repo);
  const mirror = mirrorPath(repo);
  const url = fetchUrl(repo, record);
  if (!fs.existsSync(path.join(mirror, "HEAD"))) {
    fs.mkdirSync(path.dirname(mirror), { recursive: true });
    const made = await gitBare(["init", "--bare", "--quiet", mirror]);
    if (made.code !== 0) throw new Error(`cannot create the mirror: ${gitSaid(made)}`);
  }
  await config(mirror, {
    "remote.origin.url": url,
    // The mirror is NEVER pruned of objects: clones borrow them (alternates), and an object
    // must not vanish even after a force-push upstream (section 6.2).
    "gc.auto": "0",
    "gc.pruneExpire": "never",
    "maintenance.auto": "false",
    // Pinned here, where repository content cannot reach: a `.lfsconfig` in a commit
    // would otherwise choose where LFS goes, and with which key.
    // Over SSH (a deploy key) git-lfs finds its endpoint itself; over https (--anonymous) the
    // endpoint is the repository's /info/lfs, and the repository's own address answered
    // every batch with "Authorization error" (found cloning a public repository on the M1).
    "lfs.url": url.startsWith("https://") ? `${url.replace(/\/$/, "")}/info/lfs` : url,
    "lfs.locksverify": "false",
    // Nothing is ever pushed INTO the mirror: it holds what the remote published. The hook
    // lives in a directory only root writes.
    "core.hooksPath": `${MIRROR_HOOKS}`,
  });
  if (!record.anonymous) await config(mirror, { "core.sshCommand": sshCommand(repo, "read") });
  await git(mirror, ["config", "--unset-all", "remote.origin.fetch"]);
  await gitOk(mirror, ["config", "--add", "remote.origin.fetch", "+refs/heads/*:refs/heads/*"]);
  await gitOk(mirror, ["config", "--add", "remote.origin.fetch", "+refs/tags/*:refs/tags/*"]);

  log(
    `fetching ${repoId(repo)} ${record.anonymous ? "anonymously, over https" : "with the read key"}`,
  );
  // From the forge, which is remote: however long it takes while bytes come (R4), and ended
  // when it goes quiet (FORGE_IDLE_MS; `--progress` makes git say something every second
  // while it works) or when whoever asked goes away (`signal`).
  const fetched = await git(mirror, ["fetch", "--prune", "--no-auto-gc", "--progress", "origin"], {
    idleMs: FORGE_IDLE_MS,
    signal,
  });
  if (fetched.code !== 0)
    refuse(
      `cannot fetch ${repoId(repo)}: ${gitSaid(fetched)}`,
      record.anonymous
        ? "check the repository is public"
        : `check its read deploy key is registered: desolate keys ${repoId(repo)}`,
    );

  // The remote's default branch becomes the mirror's HEAD, so clones check it out. A forge
  // that did not answer this is not a forge with no default branch: the one known before
  // is kept, and that is said.
  const head = await git(mirror, ["ls-remote", "--symref", "origin", "HEAD"], {
    idleMs: FORGE_IDLE_MS,
    signal,
  });
  let defaultBranch: string | null;
  if (head.code !== 0) {
    defaultBranch = record.defaultBranch;
    log(
      `could not ask ${repoId(repo)} for its default branch (${gitSaid(head, 1)}): ${defaultBranch === null ? "none is known yet" : `kept ${defaultBranch}, as last fetched`}`,
    );
  } else {
    const symref = /^ref: refs\/heads\/(\S+)\s+HEAD/m.exec(head.stdout);
    defaultBranch = symref && isBranch(symref[1]) ? symref[1] : null;
  }
  if (defaultBranch) await gitOk(mirror, ["symbolic-ref", "HEAD", `refs/heads/${defaultBranch}`]);

  // LFS: what the branch tips need (question 8's proposal). Older objects on request.
  const heads = (await gitOk(mirror, ["for-each-ref", "--format=%(refname)", "refs/heads"]))
    .split("\n")
    .filter(Boolean);
  let lfsObjects = 0;
  if (heads.length > 0) {
    // As the fetch: bounded by silence, not by time. git-lfs writes its progress only to a
    // terminal unless told to.
    const lfs = await git(mirror, ["lfs", "fetch", "origin", ...heads], {
      idleMs: FORGE_IDLE_MS,
      signal,
      env: { GIT_LFS_FORCE_PROGRESS: "1" },
    });
    if (lfs.code !== 0)
      refuse(
        `fetched ${repoId(repo)}, but its LFS objects did not come: ${gitSaid(lfs)}`,
        `desolate fetch ${repoId(repo)}`,
      );
    try {
      lfsObjects = fs
        .readdirSync(path.join(mirror, "lfs", "objects"), { recursive: true })
        .filter((name) => /[0-9a-f]{64}$/.test(String(name))).length;
    } catch {
      /* no LFS objects */
    }
  }

  const all = registry();
  all.repos[repoId(repo)] = { ...record, defaultBranch, fetchedAt: new Date().toISOString() };
  save(all);
  const created = await ensureClone(repo, defaultBranch);
  // The root clone's origin/* follows the mirror (a local fetch, from what the remote
  // published). Without it, a review compared a branch with the default branch as it was
  // when the clone last fetched, and the reviewer was sent none of the remote's newer
  // commits, so it could not describe a push after the remote moved (found by T2 04, once a
  // pull request was merged on the forge).
  // (A local fetch, from the root's own disk: no peer to go quiet, so no bound but whoever
  // asked.)
  const followed = await git(
    clonePath(repo),
    ["fetch", "--quiet", "--prune", "--no-auto-gc", "origin"],
    { signal },
  );
  if (followed.code !== 0)
    log(`the root clone of ${repoId(repo)} did not follow the mirror: ${gitSaid(followed)}`);
  // A pull request merged since a push: the mirror now shows it (pushed.ts).
  await settle(repoId(repo), (args) => git(mirror, args)).catch((error: Error) =>
    log(`could not check what landed in ${repoId(repo)}: ${error.message}`),
  );
  return {
    repo: repoId(repo),
    branches: heads.length,
    defaultBranch,
    lfsObjects,
    rootClone: created ? "created" : "present",
  };
};

/** The root clone: the person's own, borrowing the mirror's objects. Its config is written
 *  here, before anything from the repository's content is checked out. */
export const ensureClone = async (repo: Repo, defaultBranch: string | null): Promise<boolean> => {
  const clone = clonePath(repo);
  const mirror = mirrorPath(repo);
  const fresh = !fs.existsSync(path.join(clone, ".git"));
  if (fresh) {
    fs.mkdirSync(path.dirname(clone), { recursive: true });
    // The mirror named as safe, for this command only (git.ts, safeIn: on vz a share reports
    // as owned by whoever last asked).
    const made = await gitBare([
      ...safeIn(fs.realpathSync(mirror)),
      "clone",
      "--shared",
      "--no-checkout",
      "--quiet",
      mirror,
      clone,
    ]);
    if (made.code !== 0) throw new Error(`cannot create the root clone: ${gitSaid(made)}`);
  }
  const record = recordOf(repo);
  await config(clone, {
    "remote.origin.url": mirror,
    // No hook in the content, and none planted in .git/hooks, ever runs: hooks come only
    // from a directory owned by root that holds desolate's own pre-push.
    "core.hooksPath": HOOKS,
    // LFS downloads read the mirror, offline. Set here, it outranks any `.lfsconfig`.
    "lfs.url": `file://${mirror}`,
    "lfs.locksverify": "false",
    "desolate.repo": repoId(repo),
  });
  await git(clone, ["config", "--unset-all", "remote.origin.lfspushurl"]);
  if (record.pushable) {
    const url = remoteUrl(repo);
    await config(clone, {
      // `git push origin <branch>` goes to desolate's helper, which asks the person (on the
      // host) before anything leaves: see git-remote-desolate-push.ts.
      "remote.origin.pushurl": `desolate-push::${repoId(repo)}`,
      // `lfs.pushurl`, not remote.origin.lfspushurl: git-lfs lets `lfs.url` outrank the
      // per-remote setting, and an upload would then go into the mirror (measured). (This
      // user cannot reach a write key: an upload from here fails. The pusher uploads.)
      "lfs.pushurl": url,
    });
    // Clones made before the pusher named the write agent here.
    await git(clone, ["config", "--unset-all", "core.sshCommand"]);
  } else {
    // Not pushable: a push, of commits or of LFS objects, has nowhere to go. Without these
    // it would land in the mirror, which the root can write.
    await config(clone, { "remote.origin.pushurl": NOWHERE, "lfs.pushurl": `file://${NOWHERE}` });
    await git(clone, ["config", "--unset-all", "core.sshCommand"]);
  }
  if (fresh && defaultBranch) {
    // (From the mirror, on the root's own disk: as long as it takes.)
    const out = await git(clone, ["checkout", "--quiet", defaultBranch]);
    if (out.code !== 0)
      throw new Error(`cannot check out ${defaultBranch} in the root clone: ${gitSaid(out)}`);
  }
  return fresh;
};

export const list = () =>
  Object.entries(registry().repos)
    .map(([name, record]) => ({ repo: name, ...record }))
    .sort((a, b) => a.repo.localeCompare(b.repo));

// One fetch of a repository at a time. Two at once (two clicks on the dashboard's Fetch, a
// push's own fetch beside a person's) raced on the mirror's config and one failed. A lock
// held by the process that fetches (shared/lock.ts, R5), in this process or another: one
// whose fetch died is taken at once, and one whose fetch lives is waited for, for as long as
// that takes, saying so. (It was a directory taken to be left by a dead fetch after ten
// minutes, whether or not that fetch was alive: a first fetch of a large repository lost
// its lock to a second, and the two raced again.)
export const fetch = (
  repo: Repo,
  log: (line: string) => void = () => {},
  signal?: AbortSignal,
): ReturnType<typeof fetchNow> =>
  withLock(
    path.join(ROOT.state, "fetch-locks", repoId(repo).replace("/", "--")),
    () => fetchNow(repo, log, signal),
    {
      waiting: (holder) =>
        log(
          `waiting for another fetch of ${repoId(repo)} to finish (process ${holder.pid}, since ${holder.since})`,
        ),
      signal,
    },
  );
