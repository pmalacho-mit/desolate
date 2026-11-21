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
import { FORGE, formatBytes, over } from "../shared/limits.ts";
import { failure } from "../shared/text.ts";
import { isId, named, REQUEST_BYTES } from "../shared/git-out-box.ts";
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
import { passInward, sizeBeforeStart } from "./settings.ts";
import { guest, INSTANCE, paths, RELEASE_DIR } from "./paths.ts";
import { backend, rootctl, rootctlBrief } from "./stack.ts";
import type { VmSpec } from "./vm/types.ts";
import type { Expect, Given, Invoke, Throws } from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { emptyHome, readState, writeState } from "../.harness/home.ts";
import type {
  answerTo,
  inHome,
  leave,
  leaveLink,
  leavePush,
  leaveSparse,
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

/** Where the whole of what a step in the git VM said is kept when it failed and only its end
 *  is shown (text.ts, `failure`): under the host's logs, one file a step, the last failure's. */
const kept = (step: string) => (whole: string) => {
  const file = path.join(paths.logs, `git-vm-${step}.txt`);
  fs.mkdirSync(paths.logs, { recursive: true });
  fs.writeFileSync(file, whole, { mode: 0o600 });
  return file;
};
/** How much of a failed step's output a refusal shows: where git and bash say why. */
const SHOWN_LINES = 5;

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
    if (info.status === "stopped") await sizeBeforeStart(GIT_VM, "git");
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
  const now = (await b.info(GIT_VM)).status;
  if (now === "stopped") await sizeBeforeStart(GIT_VM, "git");
  if (now !== "running") await b.start(GIT_VM);
  const provisioned = await b.exec(GIT_VM, ["bash", `${guest.release}/git/provision.sh`], {
    root: true,
    timeoutMs: 120_000,
  });
  if (provisioned.code !== 0)
    refuse(
      `the git VM could not be set up:\n${failure(provisioned.stderr || provisioned.stdout, SHOWN_LINES, kept("provision"))}`,
      "desolate doctor",
    );
  await passInward(GIT_VM, "git");
  // Who you are, for your commits: the Mac's own git identity, unless the git VM has one
  // already (yours to change there: git config --global user.name ...). It is the person's
  // own, from their own Mac: nothing bounds its length here, and git takes what it takes.
  const mine = (key: string) =>
    spawnSync("git", ["config", "--global", key], { encoding: "utf8" })
      .stdout.trim()
      .replace(/[\x00-\x1f\x7f]/g, "");
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
 *  second remote (what the domains offered), and `origin`'s push going to the host.
 *
 *  It runs until it is done: the clone reads a mirror on this Mac (the git VM has no
 *  network to stall on), a large one takes as long as its size, and whoever asked for it
 *  (`desolate git`, a tab that says it is starting) is the one waiting. A clone killed part
 *  of the way was worse than a slow one: its directory was taken for a whole clone after. */
export const ensureGitClone = async (repo: Repo) => {
  const id = repoId(repo);
  const mirror = guest.mirror(repo);
  const dir = `${guest.git}/${repo.owner}/${repo.name}`;
  // A remote for each domain that has this repository: `git fetch <domain>` brings what its
  // workspaces wrote (<domain>/<branch>), and `git push <domain> <branch>` delivers a branch
  // to it (its workspaces see root/<branch>). (A domain named like a remote already here is
  // reached through `root` alone.)
  const domainList = (
    await rootctlBrief<{ slug: string; repos: string[] }[]>("domain.list").catch(() => [])
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
  const made = await backend().exec(GIT_VM, [
    "bash",
    "-c",
    script,
    "_",
    mirror,
    dir,
    id,
    `${guest.rootClones}/${repo.owner}/${repo.name}`,
  ]);
  if (made.code !== 0)
    refuse(
      `the git VM could not clone ${id}:\n${failure(made.stderr || made.stdout, SHOWN_LINES, kept("clone"))}`,
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
 *  and `git status`, as text for the terminal: all of it (the terminal keeps what it keeps),
 *  and for as long as it takes (two fetches from this Mac's own disk, and a switch). */
export const checkoutOffered = async (repo: Repo, domain: string, branch: string) => {
  if (!isSlug(domain) || !isBranch(branch)) return "";
  const dir = `${guest.git}/${repo.owner}/${repo.name}`;
  const script = [
    "set -u",
    'cd "$1" || exit 0',
    'D=$2; B=$3; THEIRS="refs/remotes/$D/$B"',
    "git fetch --quiet origin 2>&1",
    'if ! git remote get-url "$D" >/dev/null 2>&1; then echo "desolate: no remote for the domain $D in this clone yet"; git status; exit 0; fi',
    'git fetch --quiet "$D" 2>&1',
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
  const done = await backend().exec(GIT_VM, ["bash", "-c", script, "_", dir, domain, branch]);
  return `${done.stdout}${done.stderr}`;
};

// ---------------------------------------------------------------- what the git VM asks
// The out-box is the git VM's to write: any name in it may be a link, a FIFO, a directory, or
// a file the git VM still holds open and will change. So the host never follows a name
// there, never moves a file out of it, and never writes into it: it opens each file without
// following links, checks it is a plain file of a bounded size, and COPIES what it reads into
// a file of its own; answers go to a directory only the host writes (read-only to the git VM).
//
// The git VM is the person's own git, but what it leaves here is read by the host as input
// from a VM, so each bound on it is a hard one (docs/v3/limits.md, R7), and each is named
// where both sides read it: the request's in shared/git-out-box.ts, the pack's and an LFS object's in
// shared/limits.ts (FORGE: what the forge itself takes, and so what the root's out-box and
// the pusher hold a push to as well). A request refused by one is answered at once, with
// that bound and the size that met it: none is left for its asker to wait out.
const GIT_IN = path.join(paths.rootClones, ".git-in");
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
const answerFile = (id: string) => path.join(paths.gitAnswers, named(id).answer);
const answer = (id: string, value: Record<string, unknown>) => {
  const temp = path.join(paths.gitAnswers, `.${id}.${randomBytes(4).toString("hex")}`);
  fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o644, flag: "wx" });
  fs.renameSync(temp, answerFile(id));
};
/** What the host is doing with a request, said to whoever waits for it, as it is done. */
const note = (id: string, line: string) =>
  fs.appendFileSync(path.join(paths.gitAnswers, named(id).notes), `${line}\n`, { mode: 0o644 });

/** Remove a name the git VM left in the out-box: a file or a link, never followed, never a
 *  directory (which the git VM can make in place of any file). Never throws: whether the
 *  name is gone now. */
const drop = (file: string) => {
  try {
    fs.unlinkSync(file);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
};

/** A file the git VM left, opened as copy.ts opens one (no link followed, no writer waited
 *  for) and held to `most` bytes: the open file, or the sentence that refuses it, which names
 *  the bound and the size when that is why. `what`: the file, as the person knows it;
 *  `allows`: whose bound it is (limits.ts, `over`). */
const within = (
  file: string,
  most: number,
  what: string,
  allows: string,
): { fd: number; size: number } | { refused: string } => {
  const opened = openPlain(file, Number.MAX_SAFE_INTEGER);
  if (!opened) return { refused: `${what} is not a plain file` };
  if (opened.size <= most) return opened;
  fs.closeSync(opened.fd);
  return { refused: over(what, most, opened.size, "bytes", allows) };
};

const NOT_ONE = "the git VM's request is not one desolate makes";
/** At most once every few seconds a repository: `desolate fetch` typed twice. */
const FETCH_GAP_MS = 5000;
const fetchedAt = new Map<string, number>();

/** One request the git VM left: read safely, its files copied where the root reads them,
 *  handed to the root, and the answer left where the git VM reads it. Once whoever asked has
 *  gone (shared/git-out-box.ts: they leave `<id>.gone`), nothing more is begun for them, and
 *  the call to the root is ended with what it waits on there (a push's line on the approval
 *  page). No clock of this layer's ends it: the root's silence does (host/stack.ts). */
const take = async (
  id: string,
  log: (line: string) => void,
  announce: (fields: Record<string, unknown>) => void = () => {},
) => {
  const asker = new AbortController();
  const gone = path.join(paths.gitOut, named(id).gone);
  const looking = setInterval(() => {
    try {
      if (fs.lstatSync(gone, { throwIfNoEntry: false })) asker.abort();
    } catch {
      /* what the git VM does to its out-box (a chmod) must not stop the daemon */
    }
  }, 500);
  try {
    return await takeOne(id, log, announce, asker.signal);
  } finally {
    clearInterval(looking);
    // Whatever it was answered (or withdrawn), what it left is the host's to remove: every
    // name of its id's (flat names; a directory among them is left, and is the git VM's).
    let left: string[] = [];
    try {
      left = fs.readdirSync(paths.gitOut);
    } catch {
      /* no out-box */
    }
    for (const name of left) if (name.startsWith(`${id}.`)) drop(path.join(paths.gitOut, name));
  }
};
const takeOne = async (
  id: string,
  log: (line: string) => void,
  announce: (fields: Record<string, unknown>) => void,
  signal: AbortSignal,
) => {
  const out = paths.gitOut;
  const names = named(id);
  const gone = () =>
    fs.lstatSync(path.join(out, names.gone), { throwIfNoEntry: false }) !== undefined;
  const file = path.join(out, names.request);
  // (Withdrawn before it was taken: nothing was asked.)
  if (!fs.lstatSync(file, { throwIfNoEntry: false })) return;
  const opened = within(file, REQUEST_BYTES, "the git VM's request", "the host takes of one");
  drop(file);
  if ("refused" in opened)
    return answer(id, { pushed: false, fetched: false, error: opened.refused });
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
    const read: unknown = JSON.parse(text.toString("utf8"));
    if (typeof read !== "object" || read === null) throw new Error("not an object");
    asked = read;
  } catch {
    return answer(id, { pushed: false, error: "the git VM's request is not JSON" });
  } finally {
    fs.closeSync(opened.fd);
  }
  const repo = parseRepo(asked.repo);
  // `desolate fetch` in the git VM: the root refreshes the mirror (with its read key), and
  // the git VM then fetches from it. How long the root's fetch may take is the root's to say
  // (the forge is its peer): the host adds no clock of its own, and the person waits.
  if (asked.op === "fetch") {
    if (!repo) return answer(id, { fetched: false, error: NOT_ONE });
    const last = fetchedAt.get(repoId(repo)) ?? 0;
    if (Date.now() - last < FETCH_GAP_MS)
      return answer(id, { fetched: true, said: [`${repoId(repo)}: refreshed a moment ago`] });
    if (gone()) return;
    fetchedAt.set(repoId(repo), Date.now());
    note(id, `desolate: the root is refreshing ${repoId(repo)} from its remote...`);
    try {
      await rootctl("repo.fetch", { repo: repoId(repo) }, { quiet: true, signal });
      return answer(id, { fetched: true });
    } catch (error) {
      return answer(id, { fetched: false, error: (error as Error).message });
    }
  }
  // A delivery to a domain (`git push <domain>`): its workspaces see it, nothing leaves.
  const domain = asked.domain === undefined ? null : asked.domain;
  if (domain !== null && !isSlug(domain))
    return answer(id, {
      pushed: false,
      error: "the git VM's request names no domain desolate would make",
    });
  // (No count of LFS objects: the request's own size is what bounds how many it names.)
  const lfs = Array.isArray(asked.lfs) ? asked.lfs : [];
  if (
    !repo ||
    !isBranch(asked.branch) ||
    !isCommit(asked.commit) ||
    !lfs.every(isLfsOid) ||
    new Set(lfs).size !== lfs.length
  )
    return answer(id, { pushed: false, error: NOT_ONE });
  ownDirectory(GIT_IN);
  const name = randomBytes(8).toString("hex");
  const bundleTo = path.join(GIT_IN, `${name}.bundle`);
  const lfsTo = path.join(GIT_IN, `${name}.lfs`);
  try {
    // Copied, never moved: the git VM keeps no hold on the root's copy.
    const bundle = within(
      path.join(out, names.bundle),
      FORGE.packBytes,
      "the push's bundle",
      "a push to the forge may carry",
    );
    if ("refused" in bundle) return answer(id, { pushed: false, error: bundle.refused });
    note(
      id,
      `desolate: the host is copying the push for the root (${formatBytes(bundle.size)}${lfs.length ? `, and ${lfs.length} LFS object${lfs.length === 1 ? "" : "s"}` : ""})...`,
    );
    try {
      copyOut(bundle, bundleTo);
    } finally {
      fs.closeSync(bundle.fd);
    }
    if (lfs.length) {
      fs.mkdirSync(lfsTo, { mode: 0o700 });
      for (const oid of lfs as string[]) {
        if (gone()) return;
        // Flat names in the out-box: no directory of the git VM's is ever walked into.
        const object = within(
          path.join(out, names.lfs(oid)),
          FORGE.lfsObjectBytes,
          `the LFS object ${oid.slice(0, 12)}`,
          "the forge stores",
        );
        if ("refused" in object) return answer(id, { pushed: false, error: object.refused });
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
    if (gone())
      return log(
        `git VM: the ${domain ? "delivery" : "push"} of ${repoId(repo)} ${String(asked.branch)} was withdrawn where it was asked, before it was handed to the root`,
      );
    log(
      `git VM: ${domain ? `a delivery to ${domain}` : "a push"} of ${repoId(repo)} ${String(asked.branch)} at ${String(asked.commit)}, handed to the root`,
    );
    announce({
      repo: repoId(repo),
      branch: asked.branch,
      commit: asked.commit,
      ...(domain ? { domain } : {}),
    });
    note(
      id,
      domain
        ? `desolate: handed to the root, for ${domain}: its workspaces see it as root/${String(asked.branch)} within seconds.`
        : "desolate: handed to the root. Approve it beside this terminal (in the browser tab), or on the approval page (desolate approve --web). Until it is approved, Ctrl-C withdraws it.",
    );
    note(id, `  ${repoId(repo)}  ${String(asked.branch)}  ${String(asked.commit)}`);
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
      { quiet: true, signal },
    );
    answer(id, reply);
  } catch (error) {
    answer(id, { pushed: false, error: (error as Error).message });
  } finally {
    // The host's own copies (its directory): what the git VM left goes in take's finally.
    fs.rmSync(bundleTo, { force: true });
    fs.rmSync(lfsTo, { recursive: true, force: true });
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
  /** a request that is a link (to a file of the host's) is not followed and not read: the
   *  link is removed, what it pointed at is as it was, and the asker is told why (in the
   *  host's own answer box, which the git VM cannot write) */
  export type ALinkIsNotFollowed = Given<
    [
      Invoke<typeof emptyHome>,
      Invoke<typeof writeState, [name: "ui-token", text: "the dashboard's"]>,
      Invoke<typeof leaveLink, [name: "0123456789abcdef.json", target: "state/ui-token"]>,
      Invoke<typeof take, [id: Id, log: typeof collect]>,
    ],
    [
      Expect<
        Invoke<typeof answerTo, [id: Id]>,
        "=",
        { pushed: false; fetched: false; error: "the git VM's request is not a plain file" }
      >,
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
        { pushed: false; error: "the push's bundle is not a plain file" }
      >,
      Expect<Invoke<typeof outbox>, "=", []>,
      Expect<Invoke<typeof readState, [name: "ui-token"]>, "=", "the dashboard's">,
    ]
  >;
  /** a request over the bound the host reads is answered at once, with the bound and its
   *  size (it was removed unanswered, and its push waited 20 minutes for nothing) */
  export type ARequestOverItsBound = Given<
    [
      Invoke<typeof emptyHome>,
      Invoke<typeof leaveSparse, [name: "0123456789abcdef.json", bytes: 1048576]>,
      Invoke<typeof take, [id: Id, log: typeof collect]>,
    ],
    [
      Expect<
        Invoke<typeof answerTo, [id: Id]>,
        "=",
        {
          pushed: false;
          fetched: false;
          error: "the git VM's request is 1.0 MiB, over the 1020 KiB the host takes of one";
        }
      >,
      Expect<Invoke<typeof outbox>, "=", []>,
    ]
  >;
  /** a push adding 1,500 LFS objects is read (over the 64 KiB the host once took, which
   *  dropped any push of more than about 970): here it goes on to look for its bundle */
  export type FifteenHundredObjects = Given<
    [
      Invoke<typeof emptyHome>,
      Invoke<typeof leavePush, [id: Id, lfs: 1500]>,
      Invoke<typeof take, [id: Id, log: typeof collect]>,
    ],
    Expect<
      Invoke<typeof answerTo, [id: Id]>,
      "=",
      { pushed: false; error: "the push's bundle is not a plain file" }
    >
  >;
  /** a bundle or an LFS object over what the forge takes: refused with that bound, not as
   *  "not a plain file" (sparse files: nothing that size is written) */
  export type OverWhatTheForgeTakes = [
    Given<
      [
        Invoke<typeof emptyHome>,
        Invoke<typeof leavePush, [id: Id, lfs: 0]>,
        Invoke<typeof leaveSparse, [name: "0123456789abcdef.bundle", bytes: 2147483649]>,
        Invoke<typeof take, [id: Id, log: typeof collect]>,
      ],
      [
        Expect<
          Invoke<typeof answerTo, [id: Id]>,
          "=",
          {
            pushed: false;
            error: "the push's bundle is 2147483649 bytes, over the 2147483648 a push to the forge may carry";
          }
        >,
        Expect<Invoke<typeof outbox>, "=", []>,
      ]
    >,
    Given<
      [
        Invoke<typeof emptyHome>,
        Invoke<typeof leavePush, [id: Id, lfs: 1]>,
        Invoke<typeof leave, [name: "0123456789abcdef.bundle", text: "a bundle"]>,
        Invoke<
          typeof leaveSparse,
          [
            name: "0123456789abcdef.0000000000000000000000000000000000000000000000000000000000000000.lfs",
            bytes: 5368709121,
          ]
        >,
        Invoke<typeof take, [id: Id, log: typeof collect]>,
      ],
      [
        Expect<
          Invoke<typeof answerTo, [id: Id]>,
          "=",
          {
            pushed: false;
            error: "the LFS object 000000000000 is 5368709121 bytes, over the 5368709120 the forge stores";
          }
        >,
        Expect<Invoke<typeof outbox>, "=", []>,
      ]
    >,
  ];
  /** whoever asked has gone (Ctrl-C): nothing is copied or handed on, nobody is answered,
   *  and nothing of theirs is left */
  export type Withdrawn = Given<
    [
      Invoke<typeof emptyHome>,
      Invoke<typeof leavePush, [id: Id, lfs: 0]>,
      Invoke<typeof leave, [name: "0123456789abcdef.bundle", text: "a bundle"]>,
      Invoke<typeof leave, [name: "0123456789abcdef.gone", text: ""]>,
      Invoke<typeof take, [id: Id, log: typeof collect]>,
    ],
    [Expect<Invoke<typeof answerTo, [id: Id]>, "=", null>, Expect<Invoke<typeof outbox>, "=", []>]
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
 *  the approval page), and the next only when the call for the last has ended. Its asker
 *  going ends that call at once; the root then ends what it began before it begins the next
 *  (root/ops.ts, `git.push`). (The host daemon runs this.) */
export const watchGitOut = (
  log: (line: string) => void,
  announce: (fields: Record<string, unknown>) => void = () => {},
) => {
  for (const dir of [paths.gitOut, paths.gitAnswers])
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let busy = false;
  /** Requests whose file could not be removed (the git VM made a directory of that name):
   *  answered once, and not taken again by this daemon. */
  const stuck = new Set<string>();
  const scan = () => {
    if (busy) return;
    // Nothing the git VM leaves may stop the daemon (every page it serves would go with it).
    try {
      look();
    } catch (error) {
      log(`git VM: the out-box could not be read: ${(error as Error).message}`);
    }
  };
  const look = () => {
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
    // A name that is none of a request's is nobody's; nor is a withdrawal of a request that
    // was never taken (or was answered as it went).
    const there = new Set(names);
    for (const file of names) {
      const dot = file.indexOf(".");
      const of = dot < 0 ? file : file.slice(0, dot);
      if (!isId(of) || (file === named(of).gone && !there.has(named(of).request)))
        drop(path.join(paths.gitOut, file));
    }
    const id = names
      .filter((file) => file.endsWith(".json"))
      .map((file) => file.slice(0, -5))
      .find((of) => isId(of) && !stuck.has(of));
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
        if (fs.lstatSync(path.join(paths.gitOut, named(id).request), { throwIfNoEntry: false })) {
          stuck.add(id);
          log(`git VM: ${named(id).request} in the out-box is not a file: it is not taken again`);
        }
        busy = false;
        // One that landed while this was taken: its event came and went. (On the next turn:
        // never in the same one, so no request answered at once can keep the daemon here.)
        setImmediate(scan);
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
