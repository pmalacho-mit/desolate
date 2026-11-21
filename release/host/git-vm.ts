// The git VM: where the person types git, in a browser tab (host/git-web.ts), in clones of
// their own. Not the root VM: the root's user parses what domains send and talks to the
// keyring, and a shell there is a shell beside all of that. Not a workspace: nothing of a
// project's runs here (no devcontainer, no direnv, no hook), and there is no network at all.
//
//   /git/<owner>/<repo>      the person's clones (on the Mac: ~/.desolate/git), read-write
//   /desolate/mirrors        what each remote published, read-only (`origin` fetches here)
//   /desolate/root           the root's clones, read-only: `git fetch root` brings what the
//                            domains offered, as root/<domain>/<branch>
//   /desolate/out            pushes, handed to the host (~/.desolate/git-out)
//
// `git push origin <branch>` there writes a bundle and a request to /desolate/out
// (git/git-remote-desolate-out.ts); the host hands it to the root (ops.ts, `git.push`),
// which checks every object as it does a domain's and pushes after the person approves on
// the approval page. The git VM cannot write anything the root reads but what the host
// copies on.
import { copyOut, openPlain } from "../shared/copy.ts";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { refuse } from "../shared/exit.ts";
import {
  gitVmName,
  isBranch,
  isCommit,
  isLfsOid,
  isSlug,
  parseRepo,
  repoId,
} from "../shared/names.ts";
import type { Repo } from "../shared/names.ts";
import { vmSize } from "../shared/size.ts";
import { guest, INSTANCE, paths, RELEASE_DIR } from "./paths.ts";
import { backend, rootctl } from "./stack.ts";
import type { VmSpec } from "./vm/types.ts";
import type { Expect, Given, Invoke, Throws } from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { emptyHome, readState, writeState } from "../.harness/home.ts";
import type {
  answerTo,
  inHome,
  leave,
  leaveLink,
  linkInHome,
  outbox,
} from "../.harness/host-git-out.ts";
import type { collect } from "../.harness/host-stack.ts";

export const GIT_VM = gitVmName(INSTANCE);

export const gitSpec = (): VmSpec => ({
  name: GIT_VM,
  role: "git",
  egress: "none",
  shares: [
    { host: RELEASE_DIR, guest: guest.release, writable: false },
    { host: paths.mirrors, guest: guest.mirrors, writable: false },
    { host: paths.rootClones, guest: guest.rootClones, writable: false },
    { host: paths.git, guest: guest.git, writable: true },
    { host: paths.gitOut, guest: guest.gitOut, writable: true },
    // The host's answers: the git VM reads them, and cannot leave a link where one is written.
    { host: paths.gitAnswers, guest: guest.gitAnswers, writable: false },
  ],
  sockets: [],
  ...vmSize("git"), // its CPUs and memory: settings (shared/size.ts), from this Mac
  diskGiB: 30, // (the base's: a clone's disk cannot be smaller; 10 was never applied)
  labels: { title: "git" },
});

declare namespace gitSpec {
  /** no network; the mirrors, the root's clones and the host's answers read-only; only the
   *  person's clones and the out-box writable */
  export type Shares = Expect<
    Invoke<typeof gitSpec>,
    "matches",
    {
      role: "git";
      egress: "none";
      sockets: [];
      shares: [
        { guest: "/desolate/release"; writable: false },
        { guest: "/desolate/mirrors"; writable: false },
        { guest: "/desolate/root"; writable: false },
        { guest: "/git"; writable: true },
        { guest: "/desolate/out"; writable: true },
        { guest: "/desolate/answers"; writable: false },
      ];
    }
  >;
}

/** Make the git VM if there is none, start it, and give it its settings. Idempotent. */
export const ensureGitVm = async (log: (line: string) => void = () => {}) => {
  const b = backend();
  for (const dir of [paths.git, paths.gitOut, paths.gitAnswers])
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let info = await b.info(GIT_VM);
  if (info.status !== "missing" && b.kind !== "fake") {
    // Older than this desolate's image: made again. It has no network to be provisioned
    // again in place, and nothing of its own to keep: the person's clones and what it
    // hands the host are on the host (paths.git, gitOut), and its git identity is set below.
    if (info.status !== "running") await b.start(GIT_VM);
    const { imageFingerprint, stampOf } = await import("./image.ts");
    const stamp = stampOf(
      (await b.exec(GIT_VM, ["cat", "/opt/desolate/image-info"], { timeoutMs: 30_000 })).stdout,
    );
    if (stamp !== imageFingerprint()) {
      log(
        `git VM: made from ${stamp ? `image ${stamp}` : "an unstamped image"}, older than this desolate's (${imageFingerprint()}); making it again (your clones are on the Mac, and kept)`,
      );
      await b.destroy(GIT_VM);
      info = await b.info(GIT_VM);
    }
  }
  if (info.status === "missing") {
    log("git VM: making it (once)");
    await b.ensureImage(log);
    await b.create(gitSpec());
  }
  if ((await b.info(GIT_VM)).status !== "running") await b.start(GIT_VM);
  const provisioned = await b.exec(GIT_VM, ["bash", `${guest.release}/git/provision.sh`], {
    root: true,
    timeoutMs: 120_000,
  });
  if (provisioned.code !== 0)
    refuse(
      `the git VM could not be set up: ${(provisioned.stderr || provisioned.stdout).trim().slice(-300)}`,
      "desolate doctor",
    );
  // Who you are, for your commits: the Mac's own git identity, unless the git VM has one
  // already (yours to change there: git config --global user.name ...).
  const mine = (key: string) =>
    spawnSync("git", ["config", "--global", key], { encoding: "utf8" })
      .stdout.trim()
      .replace(/[\x00-\x1f\x7f]/g, "")
      .slice(0, 200);
  const [name, email] = [mine("user.name"), mine("user.email")];
  if (name || email)
    await b.exec(
      GIT_VM,
      [
        "bash",
        "-c",
        'for kv in "user.name=$1" "user.email=$2"; do k=${kv%%=*}; v=${kv#*=}; [ -n "$v" ] && ! git config --global "$k" >/dev/null && git config --global "$k" "$v"; done; true',
        "_",
        name,
        email,
      ],
      { timeoutMs: 60_000 },
    );
};

/** The person's clone of a repository in the git VM: from the mirror, with `root` as a
 *  second remote (what the domains offered), and `origin`'s push going to the host. */
export const ensureGitClone = async (repo: Repo) => {
  const id = repoId(repo);
  const mirror = guest.mirror(repo);
  const dir = `${guest.git}/${repo.owner}/${repo.name}`;
  // A remote for each domain that has this repository: `git fetch <domain>` brings what its
  // workspaces wrote (<domain>/<branch>), and `git push <domain> <branch>` delivers a branch
  // to it (its workspaces see root/<branch>). (A domain named like a remote already here is
  // reached through `root` alone.)
  const domainList = (
    await rootctl<{ slug: string; repos: string[] }[]>("domain.list", {}, { quiet: true }).catch(
      () => [],
    )
  )
    .filter(
      (d) => d.repos.includes(id) && isSlug(d.slug) && d.slug !== "origin" && d.slug !== "root",
    )
    .map((d) => d.slug);
  const perDomain = domainList.flatMap((d) => [
    `git remote get-url ${d} >/dev/null 2>&1 || git remote add ${d} "$4"`,
    `git config remote.${d}.url "$4"`,
    `git config --replace-all remote.${d}.fetch '+refs/remotes/${d}/*:refs/remotes/${d}/*'`,
    `git config remote.${d}.pushurl "desolate-out::$3@${d}"`,
    `git config remote.${d}.uploadpack "git -c core.alternateRefsCommand=true upload-pack"`,
  ]);
  const script = [
    "set -euo pipefail",
    `if [ ! -d "$2/.git" ]; then mkdir -p "$(dirname "$2")"; GIT_LFS_SKIP_SMUDGE=1 git clone --no-local --quiet "$1" "$2"; fi`,
    'cd "$2"',
    `git config remote.origin.url "$1"`,
    `git config remote.origin.pushurl "desolate-out::$3"`,
    `git config lfs.url "file://$1"`,
    // LFS objects come through desolate's own agent (git/lfs-file.ts): from the mirror, or
    // from the root clone, where domains' offered objects are.
    "git config lfs.standalonetransferagent desolate-file",
    "git config lfs.customtransfer.desolate-file.path /usr/local/bin/desolate-lfs-file",
    `git config lfs.customtransfer.desolate-file.args "$3"`,
    "git config lfs.locksverify false",
    `git remote get-url root >/dev/null 2>&1 || git remote add root "$4"`,
    `git config remote.root.url "$4"`,
    // What the root holds of each domain's offers: root/<domain>/<branch>.
    `git config --replace-all remote.root.fetch '+refs/remotes/*:refs/remotes/root/*'`,
    `git config remote.root.pushurl /nonexistent/the-root-is-not-pushed-to`,
    // `origin` and `root` are the root's user's repositories (the mirror; its clone), and a
    // local fetch runs upload-pack under THEIR config. What of it could name a command is
    // set here, on this side, where the root's user cannot write: the alternates' refs come
    // from a command that prints nothing. (uploadpack.packObjectsHook needs no setting: git
    // reads it from no repository's own config. Set empty, it was a command to run, and
    // every fetch failed: "unable to fork git-pack-objects".)
    `git config remote.origin.uploadpack "git -c core.alternateRefsCommand=true upload-pack"`,
    `git config remote.root.uploadpack "git -c core.alternateRefsCommand=true upload-pack"`,
    ...perDomain,
    "git lfs pull >/dev/null 2>&1 || true",
  ].join("\n");
  const made = await backend().exec(
    GIT_VM,
    ["bash", "-c", script, "_", mirror, dir, id, `${guest.rootClones}/${repo.owner}/${repo.name}`],
    { timeoutMs: 1_800_000 },
  );
  if (made.code !== 0)
    refuse(
      `the git VM could not clone ${id}: ${(made.stderr || made.stdout).trim().slice(-300)}`,
      `desolate clone ${id} first, if the root has not`,
    );
  return dir;
};

/** Your clone, on the branch a domain offered, as the dashboard's review of it opens the
 *  terminal: what a workspace had in its editor (dogfooding, 2026-11-18: "up to date with
 *  origin/main" here, two commits ahead there). Fetches the remote's mirror and the domain,
 *  then puts your <branch> at the domain's: made if you have none, fast-forwarded if it is
 *  behind, and otherwise left as it is (never moved back, never past work of your own), and
 *  never switched to over uncommitted changes. Its upstream is the remote's branch of that
 *  name, which a push updates: `git status` then says how far ahead it is. What happened,
 *  and `git status`, as text for the terminal. */
export const checkoutOffered = async (repo: Repo, domain: string, branch: string) => {
  if (!isSlug(domain) || !isBranch(branch)) return "";
  const dir = `${guest.git}/${repo.owner}/${repo.name}`;
  const script = [
    "set -u",
    'cd "$1" || exit 0',
    'D=$2; B=$3; THEIRS="refs/remotes/$D/$B"',
    "git fetch --quiet origin 2>&1 | tail -2",
    'if ! git remote get-url "$D" >/dev/null 2>&1; then echo "desolate: no remote for the domain $D in this clone yet"; git status; exit 0; fi',
    'git fetch --quiet "$D" 2>&1 | tail -2',
    'if ! git rev-parse -q --verify "$THEIRS^{commit}" >/dev/null; then echo "desolate: $D has no branch $B (yet): staying where you are"; git status; exit 0; fi',
    "NOW=$(git symbolic-ref -q --short HEAD || true)",
    'if [ "$NOW" != "$B" ] && [ -n "$(git status --porcelain --untracked-files=no)" ]; then echo "desolate: staying on ${NOW:-a detached HEAD}: it has changes not committed. Commit or stash them, then: git switch $B"; git status; exit 0; fi',
    'if ! git show-ref -q --verify "refs/heads/$B"; then',
    '  git switch -q -c "$B" "$THEIRS" && echo "desolate: made $B at $D/$B"',
    'elif git merge-base --is-ancestor "refs/heads/$B" "$THEIRS"; then',
    '  if [ "$NOW" = "$B" ]; then git merge -q --ff-only "$THEIRS"; else git branch -q -f "$B" "$THEIRS" && git switch -q "$B"; fi',
    '  echo "desolate: $B is at $D/$B"',
    "else",
    '  [ "$NOW" = "$B" ] || git switch -q "$B"',
    '  if git merge-base --is-ancestor "$THEIRS" "refs/heads/$B"; then echo "desolate: your $B already has $D/$B, and more"; else echo "desolate: your $B and $D/$B have both moved: yours is left as it is (git log --oneline --graph $B $D/$B shows both)"; fi',
    "fi",
    // What a push updates: the remote's branch of the same name. A branch the remote does
    // not have yet is made there by the first push (push.default current).
    'if git show-ref -q --verify "refs/remotes/origin/$B"; then git branch -q --set-upstream-to "origin/$B" "$B"; else git branch -q --unset-upstream "$B" 2>/dev/null; git config push.default current; fi',
    "git status",
  ].join("\n");
  const done = await backend().exec(GIT_VM, ["bash", "-c", script, "_", dir, domain, branch], {
    timeoutMs: 300_000,
  });
  return `${done.stdout}${done.stderr}`.slice(-20_000);
};

// ---------------------------------------------------------------- pushes from the git VM
// The out-box is the git VM's to write: any name in it may be a link, a FIFO, a directory, or
// a file the git VM still holds open and will change. So the host never follows a name
// there, never moves a file out of it, and never writes into it: it opens each file without
// following links, checks it is a plain file of a bounded size, and COPIES what it reads into
// a file of its own; answers go to a directory only the host writes (read-only to the git VM).
const GIT_IN = path.join(paths.rootClones, ".git-in");
const LIMIT = {
  request: 64 * 1024,
  bundle: 2 * 1024 ** 3,
  lfs: 5 * 1024 ** 3,
  objects: 2000,
} as const;
/** A directory the host made, in a share the root's user can write: a real directory, not
 *  a link it left there, at its name or anywhere on the way to it from the home. A link above
 *  the home is the Mac's own (macOS's /var is one) and is not refused: every push from the git
 *  VM failed with a home under one (found by the in-source tests). */
const ownDirectory = (dir: string) => {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  const real = path.join(fs.realpathSync(paths.home), path.relative(paths.home, path.resolve(dir)));
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(dir) !== real)
    throw new Error(`${dir} is not the host's own directory`);
};

declare namespace ownDirectory {
  /** the host's own directory in the root's share: made, and taken */
  export type Made = Given<
    Invoke<typeof emptyHome>,
    Expect<
      Invoke<typeof ownDirectory, [dir: Invoke<typeof inHome, [name: "root/.git-in"]>]>,
      "=",
      undefined
    >
  >;
  /** a link the root's user left there, at its name or at the share above it, or a way to it
   *  through a link inside the home: refused, though each leads to a directory of the home's */
  export type Refuses = [
    Given<
      [
        Invoke<typeof emptyHome>,
        Invoke<typeof linkInHome, [name: "root/.git-in", target: "state"]>,
      ],
      Throws<
        Invoke<typeof ownDirectory, [dir: Invoke<typeof inHome, [name: "root/.git-in"]>]>,
        "is not the host's own directory"
      >
    >,
    Given<
      [Invoke<typeof emptyHome>, Invoke<typeof linkInHome, [name: "root", target: "state"]>],
      Throws<
        Invoke<typeof ownDirectory, [dir: Invoke<typeof inHome, [name: "root/.git-in"]>]>,
        "is not the host's own directory"
      >
    >,
    Given<
      [Invoke<typeof emptyHome>, Invoke<typeof linkInHome, [name: "again", target: "."]>],
      Throws<
        Invoke<typeof ownDirectory, [dir: Invoke<typeof inHome, [name: "again/root/.git-in"]>]>,
        "is not the host's own directory"
      >
    >,
  ];
}

/** The answer the git VM's helper waits for: in the host's own directory. */
const answerFile = (id: string) => path.join(paths.gitAnswers, `${id}.json`);
const answer = (id: string, value: Record<string, unknown>) => {
  const temp = path.join(paths.gitAnswers, `.${id}.${randomBytes(4).toString("hex")}`);
  fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o644, flag: "wx" });
  fs.renameSync(temp, answerFile(id));
};

/** One request the git VM left: read safely, its files copied where the root reads them,
 *  handed to the root, and the answer left where the git VM reads it. */
const FETCH_GAP_MS = 5000;
const fetchedAt = new Map<string, number>();
const take = async (
  id: string,
  log: (line: string) => void,
  announce: (fields: Record<string, unknown>) => void = () => {},
) => {
  const out = paths.gitOut;
  const opened = openPlain(path.join(out, `${id}.json`), LIMIT.request);
  fs.rmSync(path.join(out, `${id}.json`), { force: true });
  if (!opened) return;
  let asked: {
    op?: unknown;
    repo?: unknown;
    branch?: unknown;
    commit?: unknown;
    forced?: unknown;
    lfs?: unknown;
    domain?: unknown;
  };
  try {
    const text = Buffer.alloc(opened.size);
    fs.readSync(opened.fd, text, 0, opened.size, 0);
    asked = JSON.parse(text.toString("utf8")) as typeof asked;
  } catch {
    return answer(id, { pushed: false, error: "the git VM's request is not JSON" });
  } finally {
    fs.closeSync(opened.fd);
  }
  const repo = parseRepo(asked.repo);
  // `desolate fetch` in the git VM: the root refreshes the mirror (with its read key), and
  // the git VM then fetches from it. At most once every few seconds a repository.
  if (asked.op === "fetch") {
    if (!repo)
      return answer(id, {
        fetched: false,
        error: "the git VM's request is not one desolate makes",
      });
    const last = fetchedAt.get(repoId(repo)) ?? 0;
    if (Date.now() - last < FETCH_GAP_MS)
      return answer(id, { fetched: true, said: [`${repoId(repo)}: refreshed a moment ago`] });
    fetchedAt.set(repoId(repo), Date.now());
    try {
      await rootctl("repo.fetch", { repo: repoId(repo) }, { quiet: true, timeoutMs: 10 * 60_000 });
      return answer(id, { fetched: true });
    } catch (error) {
      return answer(id, { fetched: false, error: (error as Error).message });
    }
  }
  const domain =
    asked.domain === undefined ? null : isSlug(asked.domain) ? String(asked.domain) : false;
  if (domain === false)
    return answer(id, {
      pushed: false,
      error: "the git VM's request names no domain desolate would make",
    });
  const lfs = Array.isArray(asked.lfs) ? asked.lfs : [];
  if (
    !repo ||
    !isBranch(asked.branch) ||
    !isCommit(asked.commit) ||
    lfs.length > LIMIT.objects ||
    !lfs.every(isLfsOid) ||
    new Set(lfs).size !== lfs.length
  )
    return answer(id, { pushed: false, error: "the git VM's request is not one desolate makes" });
  ownDirectory(GIT_IN);
  const name = randomBytes(8).toString("hex");
  const bundleTo = path.join(GIT_IN, `${name}.bundle`);
  const lfsTo = path.join(GIT_IN, `${name}.lfs`);
  try {
    // Copied, never moved: the git VM keeps no hold on the root's copy.
    const bundle = openPlain(path.join(out, `${id}.bundle`), LIMIT.bundle);
    if (!bundle)
      return answer(id, {
        pushed: false,
        error: "the push's bundle is not a plain file of at most 2 GiB",
      });
    try {
      copyOut(bundle, bundleTo);
    } finally {
      fs.closeSync(bundle.fd);
    }
    if (lfs.length) {
      fs.mkdirSync(lfsTo, { mode: 0o700 });
      for (const oid of lfs as string[]) {
        // Flat names in the out-box: no directory of the git VM's is ever walked into.
        const object = openPlain(path.join(out, `${id}.${oid}.lfs`), LIMIT.lfs);
        if (!object)
          return answer(id, {
            pushed: false,
            error: `the LFS object ${oid.slice(0, 12)} is not a plain file`,
          });
        try {
          if (copyOut(object, path.join(lfsTo, oid)) !== oid)
            return answer(id, {
              pushed: false,
              error: `the LFS object ${oid.slice(0, 12)} does not hash to its name`,
            });
        } finally {
          fs.closeSync(object.fd);
        }
      }
    }
    log(
      `git VM: ${domain ? `a delivery to ${domain}` : "a push"} of ${repoId(repo)} ${String(asked.branch)} at ${String(asked.commit)}, handed to the root`,
    );
    announce({
      repo: repoId(repo),
      branch: asked.branch,
      commit: asked.commit,
      ...(domain ? { domain } : {}),
    });
    const reply = await rootctl<{ pushed: boolean; error?: string; said?: string[] }>(
      "git.push",
      {
        repo: repoId(repo),
        branch: asked.branch,
        commit: asked.commit,
        forced: asked.forced === true,
        bundle: `${name}.bundle`,
        lfs,
        ...(domain ? { domain } : {}),
      },
      { quiet: true, timeoutMs: 20 * 60_000 },
    );
    answer(id, reply);
  } catch (error) {
    answer(id, { pushed: false, error: (error as Error).message });
  } finally {
    fs.rmSync(bundleTo, { force: true });
    fs.rmSync(lfsTo, { recursive: true, force: true });
    for (const leftover of [`${id}.bundle`, ...lfs.map((oid) => `${id}.${String(oid)}.lfs`)])
      fs.rmSync(path.join(out, leftover), { force: true });
  }
};

declare namespace take {
  type Id = "0123456789abcdef";

  /** a request that is not JSON is answered so, and is gone from the out-box */
  export type NotJson = Given<
    [
      Invoke<typeof emptyHome>,
      Invoke<typeof leave, [name: "0123456789abcdef.json", text: "{"]>,
      Invoke<typeof take, [id: Id, log: typeof collect]>,
    ],
    [
      Expect<
        Invoke<typeof answerTo, [id: Id]>,
        "=",
        { pushed: false; error: "the git VM's request is not JSON" }
      >,
      Expect<Invoke<typeof outbox>, "=", []>,
    ]
  >;
  /** names that would become argv words or paths in the root, refused before anything is copied */
  export type NotOneDesolateMakes = [
    Given<
      [
        Invoke<typeof emptyHome>,
        Invoke<
          typeof leave,
          [
            name: "0123456789abcdef.json",
            text: '{"op":"push","repo":"acme/web","branch":"--upload-pack=touch x","commit":"0123456789abcdef0123456789abcdef01234567"}',
          ]
        >,
        Invoke<typeof take, [id: Id, log: typeof collect]>,
      ],
      Expect<
        Invoke<typeof answerTo, [id: Id]>,
        "=",
        { pushed: false; error: "the git VM's request is not one desolate makes" }
      >
    >,
    Given<
      [
        Invoke<typeof emptyHome>,
        Invoke<
          typeof leave,
          [
            name: "0123456789abcdef.json",
            text: '{"op":"push","repo":"acme/web","branch":"fix/login","commit":"HEAD"}',
          ]
        >,
        Invoke<typeof take, [id: Id, log: typeof collect]>,
      ],
      Expect<
        Invoke<typeof answerTo, [id: Id]>,
        "=",
        { pushed: false; error: "the git VM's request is not one desolate makes" }
      >
    >,
    Given<
      [
        Invoke<typeof emptyHome>,
        Invoke<
          typeof leave,
          [
            name: "0123456789abcdef.json",
            text: '{"op":"push","repo":"acme/web","branch":"fix/login","commit":"0123456789abcdef0123456789abcdef01234567","lfs":["../../state/ui-token"]}',
          ]
        >,
        Invoke<typeof take, [id: Id, log: typeof collect]>,
      ],
      Expect<
        Invoke<typeof answerTo, [id: Id]>,
        "=",
        { pushed: false; error: "the git VM's request is not one desolate makes" }
      >
    >,
    Given<
      [
        Invoke<typeof emptyHome>,
        Invoke<
          typeof leave,
          [
            name: "0123456789abcdef.json",
            text: '{"op":"push","repo":"acme/web","branch":"fix/login","commit":"0123456789abcdef0123456789abcdef01234567","domain":"../acme"}',
          ]
        >,
        Invoke<typeof take, [id: Id, log: typeof collect]>,
      ],
      Expect<
        Invoke<typeof answerTo, [id: Id]>,
        "=",
        { pushed: false; error: "the git VM's request names no domain desolate would make" }
      >
    >,
    Given<
      [
        Invoke<typeof emptyHome>,
        Invoke<
          typeof leave,
          [name: "0123456789abcdef.json", text: '{"op":"fetch","repo":"acme/.."}']
        >,
        Invoke<typeof take, [id: Id, log: typeof collect]>,
      ],
      Expect<
        Invoke<typeof answerTo, [id: Id]>,
        "=",
        { fetched: false; error: "the git VM's request is not one desolate makes" }
      >
    >,
  ];
  /** a request that is a link (to a file of the host's) is not followed, not read and not
   *  answered: the link is removed, and what it pointed at is as it was */
  export type ALinkIsNotFollowed = Given<
    [
      Invoke<typeof emptyHome>,
      Invoke<typeof writeState, [name: "ui-token", text: "the dashboard's"]>,
      Invoke<typeof leaveLink, [name: "0123456789abcdef.json", target: "state/ui-token"]>,
      Invoke<typeof take, [id: Id, log: typeof collect]>,
    ],
    [
      Expect<Invoke<typeof answerTo, [id: Id]>, "=", null>,
      Expect<Invoke<typeof outbox>, "=", []>,
      Expect<Invoke<typeof readState, [name: "ui-token"]>, "=", "the dashboard's">,
    ]
  >;
  /** nor a bundle that is a link. (This and the next could not run on macOS until ownDirectory
   *  let the home be under a link: a test's home is under /var, which is one.) */
  export type TheBundleIsAPlainFile = Given<
    [
      Invoke<typeof emptyHome>,
      Invoke<typeof writeState, [name: "ui-token", text: "the dashboard's"]>,
      Invoke<
        typeof leave,
        [
          name: "0123456789abcdef.json",
          text: '{"op":"push","repo":"acme/web","branch":"fix/login","commit":"0123456789abcdef0123456789abcdef01234567"}',
        ]
      >,
      Invoke<typeof leaveLink, [name: "0123456789abcdef.bundle", target: "state/ui-token"]>,
      Invoke<typeof take, [id: Id, log: typeof collect]>,
    ],
    [
      Expect<
        Invoke<typeof answerTo, [id: Id]>,
        "=",
        { pushed: false; error: "the push's bundle is not a plain file of at most 2 GiB" }
      >,
      Expect<Invoke<typeof outbox>, "=", []>,
      Expect<Invoke<typeof readState, [name: "ui-token"]>, "=", "the dashboard's">,
    ]
  >;
  /** an LFS object is taken only if it is what its name says it is */
  export type LfsByItsHash = Given<
    [
      Invoke<typeof emptyHome>,
      Invoke<
        typeof leave,
        [
          name: "0123456789abcdef.json",
          text: '{"op":"push","repo":"acme/web","branch":"fix/login","commit":"0123456789abcdef0123456789abcdef01234567","lfs":["0000000000000000000000000000000000000000000000000000000000000000"]}',
        ]
      >,
      Invoke<typeof leave, [name: "0123456789abcdef.bundle", text: "a bundle"]>,
      Invoke<
        typeof leave,
        [
          name: "0123456789abcdef.0000000000000000000000000000000000000000000000000000000000000000.lfs",
          text: "not that object",
        ]
      >,
      Invoke<typeof take, [id: Id, log: typeof collect]>,
    ],
    [
      Expect<
        Invoke<typeof answerTo, [id: Id]>,
        "=",
        { pushed: false; error: "the LFS object 000000000000 does not hash to its name" }
      >,
      Expect<Invoke<typeof outbox>, "=", []>,
    ]
  >;
}

/** Watch what the git VM leaves: one request at a time (a git VM cannot crowd the root, or
 *  the approval page). (The host daemon runs this.) */
export const watchGitOut = (
  log: (line: string) => void,
  announce: (fields: Record<string, unknown>) => void = () => {},
) => {
  for (const dir of [paths.gitOut, paths.gitAnswers])
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let busy = false;
  const scan = () => {
    if (busy) return;
    let names: string[] = [];
    try {
      names = fs.readdirSync(paths.gitOut);
    } catch {
      return;
    }
    // Answers nobody read within the hour: gone.
    try {
      for (const old of fs.readdirSync(paths.gitAnswers)) {
        const file = path.join(paths.gitAnswers, old);
        if (Date.now() - fs.lstatSync(file).mtimeMs > 3_600_000) fs.rmSync(file, { force: true });
      }
    } catch {
      /* nothing there */
    }
    const id = names.map((file) => /^([0-9a-f]{16})\.json$/.exec(file)?.[1]).find(Boolean);
    if (!id) return;
    busy = true;
    void take(id, log, announce)
      .catch((error: Error) => {
        log(`git VM: a request could not be taken: ${error.message}`);
        try {
          answer(id, { pushed: false, error: error.message });
        } catch {
          /* nothing more to say */
        }
      })
      .finally(() => {
        busy = false;
        // One that landed while this was taken: its event came and went.
        scan();
      });
  };
  // The share's files are the Mac's, so a request the git VM writes is a file event here:
  // taken as it lands. The look every few seconds is for an event missed (or a watch that
  // failed), not the way requests arrive.
  try {
    const watcher = fs.watch(paths.gitOut, (_event, file) => {
      if (file === null || /\.json$/.test(String(file))) scan();
    });
    watcher.on("error", () => watcher.close());
    watcher.unref();
  } catch {
    /* no outbox yet: the look below finds requests */
  }
  const timer = setInterval(scan, 5000);
  timer.unref();
  scan();
};
