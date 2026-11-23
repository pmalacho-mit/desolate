// Reading a domain's outbox, as data (P4). Everything in an outbox was written by a domain,
// which may be hostile: names are validated, files must be regular files directly where they
// are expected (no symlink is followed), and sizes are bounded. No function here runs git in
// a domain's repository; the only git they feed is `git fetch <bundle file>` in a ROOT clone,
// and a bundle is objects with no config and no hooks.
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isBranch, isCommit, isLfsOid, parseRepo } from "../shared/names.ts";
import { readJson, writeJson } from "../shared/json.ts";
import { FORGE, over } from "../shared/limits.ts";
import { printable } from "../shared/text.ts";
import { copyOut, copyOutSync } from "../shared/copy.ts";
import { domainPath, ROOT } from "./layout.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Given, Invoke, Table } from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { aDomain, emptyRoot, pathIn } from "../.harness/root-state.ts";

export const outbox = (domain: string) => path.join(domainPath(domain), "outbox");
export const inbox = (domain: string) => path.join(domainPath(domain), "inbox");

// What the root reads from an outbox is bounded, each bound hard (R7): a domain writes these
// files, and may write anything. Each says why its number, and a file past one is refused by
// name, with the bound and its size (R3), never as "not a file".

/** A request or a note a workspace leaves (outbox/requests/, an offer's note): a few hundred
 *  bytes of JSON each. A mebibyte is far past any of them, and what the root holds of one at
 *  a time. */
const JSON_BYTES = 1024 * 1024;

/** A domain's list of its branches, in either form it is written: refs.json, one per
 *  repository (workspace/sync.ts), and a bundle's header (intake.ts), which lists the same
 *  branches and the commits the bundle leaves out. A branch is at most 200 characters
 *  (NAMES.branch) and a commit 40, so 4 MiB holds over 16,000 branches at the longest name
 *  desolate carries, and some 50,000 at a usual one. The root holds and parses the whole
 *  list, for the dashboard every time it looks: that is what the number bounds. Past it,
 *  the list is refused whole, said, and never read in part (a part is a list of branches
 *  git would prune the rest of). */
export const REFS_BYTES = 4 * 1024 * 1024;

/** A refusal's reason, as kept and shown (a row of the dashboard, a line of `desolate
 *  offers`), in characters. git's own reasons are under 200; past that the text is the
 *  bundle's author's, and is cut, with the mark. */
export const WHY_MOST = 300;

// HOW THE ROOT TOUCHES AN OUTBOX
//
// An outbox is a directory the domain's workspaces write, shown in this VM. A workspace is
// root in its own VM: it can make any name there a symlink, a directory or a pipe, at the
// last component of a path or at a directory above it, and it can swap one for another
// between any two things the root does. A symlink there resolves in THIS VM. So a path into
// an outbox is never trusted twice, and never used to remove anything:
//
//   1. The DIRECTORY is opened (not followed), and the kernel is asked where the open
//      descriptor really is. It must be exactly the path that was asked for: no symlink in
//      any component. From then on the directory is that descriptor. Whatever the workspace
//      renames afterwards, the root is still looking at the directory it checked.
//   2. A FILE in it is opened by name relative to that descriptor, not followed, and must be
//      a regular file within a size limit. Its bytes are read from the open file.
//   3. REMOVING a file is unlinking a name in that descriptor's directory: a name the
//      workspace made, in the directory that was checked. The root cannot be made to remove
//      a file of its own, because no path of its own is ever resolved through the outbox.
//
// (Found the hard way: the first version removed "the bundle it had just read" by path, and
// a symlinked directory made that path one of the root's own files. tests/v3/t2/10.)
type Dir = { at: (name: string) => string; names: () => string[]; close: () => void };
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

/** Open a directory under the domains' share and prove it is the one asked for; else why
 *  not, in a few words ("a link", "not there"), for a refusal and a log to say. Never throws.
 *  `settle`: the share may show a directory a moment before it lets it be opened, or still
 *  show a link the workspace has since replaced with one (T4, on vz, 2026-11-21: an honest
 *  offer refused as "a link, or not a directory", a moment after its workspace had put a
 *  directory where it had planted a link). So it is looked at again while every directory
 *  above is a plain one and `dir` itself one or a link, every check made again each time (a
 *  link is never opened: O_NOFOLLOW): a few tries, a second at most, blocking. Only for a
 *  process of one domain's own (git-remote-desolate), never rootd's or the state service's
 *  loop, which every domain waits on.
 *
 *  Not seen since: on 2026-11-23 a probe on real VMs (vz, virtiofs mounted rw,relatime in
 *  both VMs) opened, from the root VM, 2,400 directories a workspace VM had just made or
 *  just renamed a file into, every one at the first look (at most 12 ms after the
 *  workspace's mkdir returned), quiet and with a T2 suite loading the Mac, and watched
 *  sync/<repo> through two restarts of the workspace and 70 honest offers: no look at it
 *  failed while it was there; while 01-boundaries' first offer had failed so twice that day. So the refusal says
 *  what lstat saw at its last look (a link, or a directory that would not open as one):
 *  the next one tells which, and the wait is not lengthened on a guess. */
export const openDir = (dir: string, settle = false): Dir | string => {
  for (let tries = 1; ; tries++) {
    const opened = openOnce(dir);
    const unsettled =
      typeof opened === "string" &&
      [NOT_THERE, NOT_DIR, OPENED_GONE, OPENED_ELSEWHERE].includes(opened);
    const seen = settle && unsettled ? settling(dir) : null;
    if (!seen) return opened;
    if (tries === OPEN_TRIES)
      return `${opened}, at each of ${OPEN_TRIES} looks over a second; lstat saw ${seen}`;
    Atomics.wait(PAUSE, 0, 0, 1000 / OPEN_TRIES);
  }
};
const OPEN_TRIES = 5;
const NOT_THERE = "not there";
const LINK = "a link";
const NOT_DIR = "a link, or not a directory";
const OPENED_GONE = "opened, and removed meanwhile";
const OPENED_ELSEWHERE = "opened at another path than asked: a link on the way";
const PAUSE = new Int32Array(new SharedArrayBuffer(4));

/** Whether every directory from the domains' share down to `dir` is there and a plain one
 *  (no link), as lstat sees it now, but for `dir` itself, which may be a link: what `dir`
 *  is then ("a directory", "a link"); null on anything else, a failure too. */
const settling = (dir: string): "a directory" | "a link" | null => {
  const parts = ["", ...path.relative(ROOT.domains, path.resolve(dir)).split(path.sep)];
  let at = ROOT.domains;
  try {
    for (const [i, part] of parts.entries()) {
      at = path.join(at, part);
      const stat = fs.lstatSync(at, { throwIfNoEntry: false });
      if (stat?.isDirectory()) continue;
      return i === parts.length - 1 && stat?.isSymbolicLink() ? "a link" : null;
    }
    return "a directory";
  } catch {
    return null;
  }
};

const openOnce = (dir: string): Dir | string => {
  let fd: number | null = null;
  try {
    const wanted = path.join(
      fs.realpathSync(ROOT.domains),
      path.relative(ROOT.domains, path.resolve(dir)),
    );
    try {
      fd = fs.openSync(
        dir,
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === "ENOENT"
        ? NOT_THERE
        : code === "ELOOP"
          ? LINK
          : code === "ENOTDIR"
            ? NOT_DIR
            : `not opened (${code ?? String(error)})`;
    }
    let at: string;
    try {
      at = fs.readlinkSync(`/proc/self/fd/${fd}`);
    } catch {
      return "not proved: this system has no /proc/self/fd";
    }
    // (Not the path itself: a refusal reaches the domain, and the path is the root's.)
    if (at !== wanted) return at === `${wanted} (deleted)` ? OPENED_GONE : OPENED_ELSEWHERE;
    const held = fd;
    fd = null;
    return {
      at: (name: string) => {
        if (!NAME.test(name)) throw new Error("not a file name");
        return `/proc/self/fd/${held}/${name}`;
      },
      names: () =>
        fs
          .readdirSync(`/proc/self/fd/${held}`)
          .filter((name) => NAME.test(name))
          .sort(),
      close: () => fs.closeSync(held),
    };
  } catch {
    // (No more than that: what threw names the root's own paths, and this reaches the domain.)
    return "not opened";
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
};

/** Open a regular file of at most `max` bytes by name in a checked directory; else why not
 *  (`what` names it for that: "the bundle"; `allows`, who sets the limit, as over() has it).
 *  `absent`: there is no such name, which is not the domain doing anything. */
type Opened = { fd: number; size: number };
type NotOpened = { why: string; absent: boolean };
const openIn = (
  dir: Dir,
  name: string,
  max: number,
  what = "the file",
  allows?: string,
): Opened | NotOpened => {
  let fd: number | null = null;
  try {
    fd = fs.openSync(
      dir.at(name),
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return { why: `${what} is not a plain file`, absent: false };
    if (stat.size > max) return { why: over(what, max, stat.size, "bytes", allows), absent: false };
    const opened = fd;
    fd = null;
    return { fd: opened, size: stat.size };
  } catch (error) {
    const absent = (error as NodeJS.ErrnoException).code === "ENOENT";
    return { why: absent ? `${what} is not there` : `${what} is not a plain file`, absent };
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
};
const isOpened = (value: Opened | NotOpened): value is Opened => "fd" in value;

/** Remove a name from a checked directory. Never a path. */
const removeIn = (dir: Dir, name: string) => {
  try {
    fs.unlinkSync(dir.at(name));
  } catch {
    /* gone already, or not a file: the workspace's to tidy */
  }
};

/** The bytes of a file in a checked directory, at most `max` of them; else why not (`what`
 *  names it). The size was checked when the file was opened, and a workspace can make it
 *  grow afterwards: what is read is bounded here, by counting, and a file that turns out
 *  longer is not taken. */
const readIn = (dir: Dir, name: string, max: number, what: string): Buffer | string => {
  const opened = openIn(dir, name, max, what);
  if (!isOpened(opened)) return opened.why;
  try {
    const buffer = Buffer.alloc(Math.min(opened.size, max) + 1);
    let total = 0;
    for (
      let read = fs.readSync(opened.fd, buffer, 0, buffer.length, 0);
      read > 0;
      read = fs.readSync(opened.fd, buffer, total, buffer.length - total, total)
    ) {
      total += read;
      if (total >= buffer.length)
        return `${what} grew while it was read, past the ${max} bytes allowed`;
    }
    return buffer.subarray(0, total);
  } catch {
    return `${what} could not be read`;
  } finally {
    fs.closeSync(opened.fd);
  }
};

/** Every JSON file waiting in a directory of an outbox whose name matches, oldest name
 *  first, each read once and removed (its name, in that directory). One that could not be
 *  taken (past JSON_BYTES, a link, not JSON) is `data: null`, with `why`, to answer with. */
export const drain = <T>(
  directory: string,
  pattern: RegExp,
  most: number,
): ({ name: string; data: T } | { name: string; data: null; why: string })[] => {
  const dir = openDir(directory);
  if (typeof dir === "string") return [];
  try {
    return dir
      .names()
      .filter((name) => pattern.test(name))
      .slice(0, most)
      .map((name) => {
        const what = `the request ${name}`;
        const read = readIn(dir, name, JSON_BYTES, what);
        removeIn(dir, name);
        if (typeof read === "string") return { name, data: null, why: read };
        try {
          return { name, data: JSON.parse(read.toString("utf8")) as T };
        } catch {
          return { name, data: null, why: `${what} is not JSON` };
        }
      });
  } finally {
    dir.close();
  }
};

const syncDir = (domain: string, repo: string) => path.join(outbox(domain), "sync", repo);

/** Whether a directory under `base` is not there at all: some directory on the way to it
 *  is missing, and each before that is a plain one. Anything else in the way (a link, one
 *  that leads nowhere among them) is something there, and not taken for nothing. */
const notThere = (base: string, below: string): boolean => {
  let at = base;
  try {
    for (const part of ["", ...below.split("/")]) {
      at = path.join(at, part);
      const stat = fs.lstatSync(at, { throwIfNoEntry: false });
      if (!stat) return true;
      if (!stat.isDirectory()) return false;
    }
  } catch {
    /* something there that is in the way (a component swapped for a file): not nothing */
  }
  return false;
};

/** How a refusal of a list whose directory could not be opened begins, after the list's
 *  name: not a verdict on what the domain sent, which the offer's answer tells apart
 *  (offers.ts). */
export const UNREAD = "could not be read: its directory in the outbox is not a plain one";

/** A domain's list of the branches of one repository (refs.json, which its workspaces write
 *  beside each bundle: workspace/sync.ts), read as data: the one reader of that file, for
 *  the root's remote helper (what git fetches, and prunes the rest of) and for the dashboard.
 *  Only names desolate carries and whole commits are taken; any other entry is not a branch
 *  the root holds. A list that is not there is an empty one (nothing synced yet). One that
 *  cannot be read whole (over REFS_BYTES, a link, not JSON, not a record of branches) is
 *  `refused`, with why: never a part, and never taken for none.
 *
 *  Read as everything in an outbox is (openDir, above): so off Linux every list that is
 *  there is refused. Its cases are in tests/v3/t1/outbox.test.ts, which runs on Linux. */
export const refsOf = (
  domain: string,
  repo: string,
  settle = false,
): { refs: Record<string, string> } | { refused: string } => {
  if (!parseRepo(repo)) return { refused: `'${printable(repo, 100)}' is not a repository` };
  const what = `${repo}'s list of branches (refs.json)`;
  const dir = openDir(syncDir(domain, repo), settle);
  if (typeof dir === "string")
    return notThere(outbox(domain), path.join("sync", repo))
      ? { refs: {} }
      : {
          refused: `${what} ${UNREAD} (${dir})`,
        };
  let text: string;
  try {
    const opened = openIn(dir, "refs.json", REFS_BYTES, what);
    if (!isOpened(opened)) return opened.absent ? { refs: {} } : { refused: opened.why };
    try {
      const bytes = Buffer.alloc(opened.size);
      let total = 0;
      for (let read = -1; read !== 0 && total < bytes.length; total += read)
        read = fs.readSync(opened.fd, bytes, total, bytes.length - total, total);
      text = bytes.subarray(0, total).toString("utf8");
    } finally {
      fs.closeSync(opened.fd);
    }
  } finally {
    dir.close();
  }
  let refs: unknown;
  try {
    refs = (JSON.parse(text) as { refs?: unknown } | null)?.refs;
  } catch {
    return { refused: `${what} is not JSON` };
  }
  if (typeof refs !== "object" || refs === null || Array.isArray(refs))
    return { refused: `${what} holds no record of branches` };
  const out: Record<string, string> = {};
  for (const [branch, commit] of Object.entries(refs as Record<string, unknown>))
    if (isBranch(branch) && isCommit(commit)) out[branch] = commit;
  return { refs: out };
};

declare namespace refsOf {
  type Fresh = Invoke<typeof emptyRoot>;
  /** a repository is named as one, or nothing is read */
  export type NotARepo = Expect<
    Invoke<typeof refsOf, [domain: "acme", repo: "../../state"]>,
    "=",
    { refused: "'../../state' is not a repository" }
  >;
  /** nothing synced yet: no branches, which is not a refusal */
  export type NotThere = Given<
    [Fresh, Invoke<typeof aDomain, [slug: "acme", repos: ["acme/app"]]>],
    Expect<Invoke<typeof refsOf, [domain: "acme", repo: "acme/app"]>, "=", { refs: {} }>
  >;
}

/** `incoming` is the root's own. A copy is deleted by whoever made it, minutes later; one
 *  left by a process that died is removed here, long after anything could be using it. */
const sweep = (incoming: string) => {
  try {
    for (const name of fs.readdirSync(incoming)) {
      const file = path.join(incoming, name);
      if (Date.now() - fs.lstatSync(file).mtimeMs > 6 * 3_600_000)
        fs.rmSync(file, { recursive: true, force: true });
    }
  } catch {
    /* another process tidied first */
  }
};

/** The bundles waiting in a domain's outbox for one repository, oldest first, each as a
 *  file of the root's own: git is never given a path a domain controls. Each is removed
 *  from the outbox (its name, in the checked directory) whether or not it could be taken.
 *  The caller removes the copies. With `most`, at most that many are copied at once and
 *  `more` says whether others wait: the root's own disk then holds one bundle at a time,
 *  however many a domain leaves. */
export const takeBundles = (
  domain: string,
  repo: string,
  most = Infinity,
): { copies: string[]; dropped: string[]; more: boolean } => {
  const dir = openDir(syncDir(domain, repo));
  if (typeof dir === "string") return { copies: [], dropped: [], more: false };
  const copies: string[] = [];
  const dropped: string[] = [];
  let more = false;
  try {
    const incoming = path.join(ROOT.state, "incoming");
    fs.mkdirSync(incoming, { recursive: true, mode: 0o700 });
    sweep(incoming);
    for (const name of dir.names().filter((n) => /^[0-9a-z-]{1,60}\.bundle$/.test(n))) {
      if (copies.length >= most) {
        more = true;
        break;
      }
      // A bundle carries what a push would: no more than the forge takes.
      const opened = openIn(
        dir,
        name,
        FORGE.packBytes,
        `the bundle ${name}`,
        "a push to the forge may carry",
      );
      // A name of the root's own making, never one a domain chose, and never one already there.
      const copy = path.join(
        incoming,
        `${Date.now().toString(36)}-${randomBytes(8).toString("hex")}.bundle`,
      );
      try {
        if (!isOpened(opened)) throw new Error(opened.why);
        // What it held when it was opened and measured. (Synchronous: this runs in
        // git-remote-desolate, a process of its own.)
        copyOutSync(opened, copy);
        copies.push(copy);
      } catch (error) {
        fs.rmSync(copy, { force: true });
        dropped.push((error as Error).message);
      } finally {
        if (isOpened(opened)) fs.closeSync(opened.fd);
        removeIn(dir, name);
      }
    }
  } finally {
    dir.close();
  }
  return { copies, dropped, more };
};

// What the root refused from a domain, kept where the person looks (the dashboard, `desolate
// offers`) and told to the workspace that offered: a refusal nobody hears about is a branch
// that silently never arrives. Cleared for a repository when a bundle of it is next taken.
// Each is read with what to do about it (`fix`), chosen here and only here: the workspace's
// answer to an offer, `desolate offers` and the dashboard all show this one.
type Noted = { domain: string; repo: string; at: string; why: string };
export type Refusal = Noted & { fix: string };
const refusedFile = (domain: string) => path.join(ROOT.state, "refused", `${domain}.json`);
const noted = (domain: string): Noted[] => readJson<Noted[]>(refusedFile(domain), []);
export const refusalsOf = (domain: string): Refusal[] =>
  noted(domain).map((r) => ({ ...r, fix: refusalFix(r.why) }));

/** What to do about a refusal, by its reason. A list the root could not open is no verdict on
 *  a branch: the share between the two VMs showed the root something other than the
 *  directory the workspace made (T4, 2026-11-23; openDir, above). Anything else is what git
 *  refused in a bundle. */
export const refusalFix = (why: string) =>
  why.includes(UNREAD)
    ? "the share between the workspace's VM and the root's had not yet shown the root what the workspace wrote: offer again from the workspace (desolate offer)"
    : "a branch in this domain holds an object git calls dangerous (a .git inside a tree, a .gitmodules that is a symlink or names an option, a malformed object). Nothing new from the domain is taken until that branch is deleted in the workspace; then offer again from it (desolate offer)";

declare namespace refusalFix {
  /** an outbox directory the root could not open is offered again; a branch git refused is
   *  deleted first: each the other's control */
  export type ByReason = Table<
    typeof refusalFix,
    [
      [
        args: [
          why: "acme/app's list of branches (refs.json) could not be read: its directory in the outbox is not a plain one (a link, or not a directory, at each of 5 looks over a second; lstat saw a directory)",
        ],
        expected: "the share between the workspace's VM and the root's had not yet shown the root what the workspace wrote: offer again from the workspace (desolate offer)",
      ],
      [
        args: [
          why: "did not import: error: object 0123456789abcdef0123456789abcdef01234567: hasDotgit: contains '.git'",
        ],
        expected: "a branch in this domain holds an object git calls dangerous (a .git inside a tree, a .gitmodules that is a symlink or names an option, a malformed object). Nothing new from the domain is taken until that branch is deleted in the workspace; then offer again from it (desolate offer)",
      ],
    ]
  >;
}

export const noteRefusal = (domain: string, repo: string, why: string) => {
  fs.mkdirSync(path.dirname(refusedFile(domain)), { recursive: true, mode: 0o700 });
  // The reason is in part the bundle's author's text: printable ASCII only, and short.
  const entry = {
    domain,
    repo,
    at: new Date().toISOString(),
    why: printable(why, WHY_MOST),
  };
  writeJson(
    refusedFile(domain),
    [...noted(domain).filter((r) => r.repo !== repo), entry].slice(-20),
  );
};
export const clearRefusal = (domain: string, repo: string) => {
  const kept = noted(domain).filter((r) => r.repo !== repo);
  if (kept.length !== noted(domain).length) writeJson(refusedFile(domain), kept);
};

declare namespace noteRefusal {
  type Fresh = Invoke<typeof emptyRoot>;
  /** what the root refused from a domain is kept, one per repository, the latest; its reason
   *  (in part the bundle's author's text) printable and short */
  export type Keeps = Given<
    [
      Fresh,
      Invoke<typeof noteRefusal, [domain: "acme", repo: "acme/app", why: "first"]>,
      Invoke<
        typeof noteRefusal,
        [domain: "acme", repo: "acme/web", why: "hasDotgit: contains '.git'"]
      >,
      Invoke<typeof noteRefusal, [domain: "acme", repo: "acme/app", why: "badTree\u001b[2J\u202e"]>,
    ],
    Expect<
      Invoke<typeof refusalsOf, [domain: "acme"]>,
      "matches",
      [
        { domain: "acme"; repo: "acme/web"; why: "hasDotgit: contains '.git'" },
        { domain: "acme"; repo: "acme/app"; why: "badTree?[2J?" },
      ]
    >
  >;
  /** each is read with what to do about it, as everyone who shows it shows it (refusalFix) */
  export type WithItsFix = Given<
    [
      Fresh,
      Invoke<
        typeof noteRefusal,
        [
          domain: "acme",
          repo: "acme/app",
          why: "acme/app's list of branches (refs.json) could not be read: its directory in the outbox is not a plain one (a link, or not a directory)",
        ]
      >,
    ],
    Expect<
      Invoke<typeof refusalsOf, [domain: "acme"]>,
      "matches",
      [
        {
          repo: "acme/app";
          fix: "the share between the workspace's VM and the root's had not yet shown the root what the workspace wrote: offer again from the workspace (desolate offer)";
        },
      ]
    >
  >;
  /** once a bundle of that repository is taken, its refusal goes; the others stay */
  export type Clears = Given<
    [
      Fresh,
      Invoke<typeof noteRefusal, [domain: "acme", repo: "acme/app", why: "x"]>,
      Invoke<typeof noteRefusal, [domain: "acme", repo: "acme/web", why: "y"]>,
      Invoke<typeof clearRefusal, [domain: "acme", repo: "acme/app"]>,
    ],
    Expect<Invoke<typeof refusalsOf, [domain: "acme"]>, "matches", [{ repo: "acme/web" }]>
  >;
}

/** An LFS object the domain staged, taken into `target` only if its content hashes to its
 *  name and its size is what the pointer said (section 6.3). The bytes that are hashed are
 *  the bytes that are kept: they are copied from one open descriptor, and the copy becomes
 *  `target` only after the hash agrees. */
export const takeLfs = async (
  domain: string,
  repo: string,
  oid: string,
  size: number,
  target: string,
): Promise<{ ok: true } | { error: string }> => {
  if (!isLfsOid(oid)) return { error: "not an LFS object id" };
  const dir = openDir(path.join(outbox(domain), "lfs", repo));
  const what = `the LFS object ${oid.slice(0, 12)}`;
  const opened =
    typeof dir !== "string"
      ? openIn(dir, oid, FORGE.lfsObjectBytes, what, "the forge stores")
      : { why: `${what} is not there`, absent: true };
  const tmp = `${target}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    if (!isOpened(opened))
      return { error: opened.absent ? `${what} is not in the outbox` : opened.why };
    if (opened.size !== size)
      return {
        error: `the LFS object ${oid.slice(0, 12)} is ${opened.size} bytes; its pointer says ${size}`,
      };
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Copied without blocking rootd: the other domains are answered meanwhile.
    if ((await copyOut(opened, tmp)) !== oid)
      return { error: `the LFS object ${oid.slice(0, 12)} does not hash to its id` };
    fs.renameSync(tmp, target);
    removeIn(dir as Dir, oid);
    return { ok: true };
  } catch (error) {
    return { error: `${what} could not be copied: ${(error as Error).message}` };
  } finally {
    if (isOpened(opened)) fs.closeSync(opened.fd);
    if (typeof dir !== "string") dir.close();
    fs.rmSync(tmp, { force: true });
  }
};

declare namespace takeLfs {
  type Fresh = Invoke<typeof emptyRoot>;
  /** an object is named by its sha256, which is checked before any path is made of it */
  export type NotAnId = Expect<
    Invoke<
      typeof takeLfs,
      [
        domain: "acme",
        repo: "acme/app",
        oid: "../../../state/registry.json",
        size: 1,
        target: "/nowhere",
      ]
    >,
    "=",
    { error: "not an LFS object id" }
  >;
  /** one the domain did not stage is said so */
  export type NotStaged = Given<
    [Fresh, Invoke<typeof aDomain, [slug: "acme", repos: ["acme/app"]]>],
    Expect<
      Invoke<
        typeof takeLfs,
        [
          domain: "acme",
          repo: "acme/app",
          oid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          size: 1,
          target: Invoke<
            typeof pathIn,
            [
              where: "state",
              name: "lfs/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            ]
          >,
        ]
      >,
      "=",
      { error: "the LFS object aaaaaaaaaaaa is not in the outbox" }
    >
  >;
}

/** Drop a staged LFS object the root already has: its name, in the checked directory. */
export const dropLfs = (domain: string, repo: string, oid: string) => {
  if (!isLfsOid(oid)) return;
  const dir = openDir(path.join(outbox(domain), "lfs", repo));
  if (typeof dir === "string") return;
  try {
    removeIn(dir, oid);
  } finally {
    dir.close();
  }
};

/** Every branch a domain has, by its own list (the workspace writes it beside each bundle:
 *  workspace/sync.ts): the domain's word, read as data, each name one desolate would carry.
 *  What it holds is not believed from this: a review brings the branch into the root clone
 *  and reads it there. */
export const branchesOf = (slug: string, repoList: string[]) => {
  const out: { repo: string; branch: string; commit: string }[] = [];
  for (const repo of repoList) {
    // Every one (refsOf's bound is the bound). A list that was refused shows none here; the
    // root's helper refuses it out loud when it fetches, and the dashboard shows that.
    const listed = refsOf(slug, repo);
    if ("refs" in listed)
      for (const [branch, commit] of Object.entries(listed.refs))
        out.push({ repo, branch, commit });
  }
  return out;
};

// (branchesOf is refsOf for each repository: its cases, which read an outbox, are in
// tests/v3/t1/outbox.test.ts, on Linux.)
