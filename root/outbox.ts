// Reading a domain's outbox, as data (P4). Everything in an outbox was written by a domain,
// which may be hostile: names are validated, files must be regular files directly where they
// are expected (no symlink is followed), and sizes are bounded. No function here runs git in
// a domain's repository; the only git they feed is `git fetch <bundle file>` in a ROOT clone,
// and a bundle is objects with no config and no hooks.
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isBranch, isCommit, isLfsOid, parseRepo } from "../shared/names.ts";
import { readJson, writeJson } from "../shared/json.ts";
import { readPlain } from "../shared/status.ts";
import { domainPath, ROOT } from "./layout.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Given, Invoke } from "../../.suede/nests/dsl.import.meta.vitest.ts";
import type { aDomain, emptyRoot, linkIn, pathIn, writeFilledIn, writeIn, writeJsonIn } from "../../tests/nests/root-state.harness.ts";

export const outbox = (domain: string) => path.join(domainPath(domain), "outbox");
export const inbox = (domain: string) => path.join(domainPath(domain), "inbox");

const LIMIT = { json: 1024 * 1024, bundle: 2 * 1024 ** 3, lfs: 5 * 1024 ** 3 } as const;

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

/** Open a directory under the domains' share and prove it is the one asked for; else null. */
export const openDir = (dir: string): Dir | null => {
  let fd: number | null = null;
  try {
    const wanted = path.join(fs.realpathSync(ROOT.domains), path.relative(ROOT.domains, path.resolve(dir)));
    fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    if (fs.readlinkSync(`/proc/self/fd/${fd}`) !== wanted) throw new Error("not the directory that was asked for");
    const held = fd;
    fd = null;
    return {
      at: (name) => {
        if (!NAME.test(name)) throw new Error("not a file name");
        return `/proc/self/fd/${held}/${name}`;
      },
      names: () => fs.readdirSync(`/proc/self/fd/${held}`).filter((name) => NAME.test(name)).sort(),
      close: () => fs.closeSync(held),
    };
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
};

/** Open a regular file of at most `max` bytes by name in a checked directory; else null. */
const openIn = (dir: Dir, name: string, max: number): { fd: number; size: number } | null => {
  let fd: number | null = null;
  try {
    fd = fs.openSync(dir.at(name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > max) throw new Error("not a plain file within the limit");
    const opened = fd;
    fd = null;
    return { fd: opened, size: stat.size };
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
};

/** Remove a name from a checked directory. Never a path. */
const removeIn = (dir: Dir, name: string) => {
  try {
    fs.unlinkSync(dir.at(name));
  } catch {
    /* gone already, or not a file: the workspace's to tidy */
  }
};

/** The bytes of a file in a checked directory, at most `max` of them. The size was checked
 *  when the file was opened, and a workspace can make it grow afterwards: what is read is
 *  bounded here, by counting, and a file that turns out longer is not taken. */
const readIn = (dir: Dir, name: string, max: number): Buffer | null => {
  const opened = openIn(dir, name, max);
  if (!opened) return null;
  try {
    const buffer = Buffer.alloc(Math.min(opened.size, max) + 1);
    let total = 0;
    for (let read = fs.readSync(opened.fd, buffer, 0, buffer.length, 0); read > 0; read = fs.readSync(opened.fd, buffer, total, buffer.length - total, total)) {
      total += read;
      if (total >= buffer.length) return null;
    }
    return buffer.subarray(0, total);
  } catch {
    return null;
  } finally {
    fs.closeSync(opened.fd);
  }
};

/** Copy what a descriptor holds into a file of the root's own, hashing as it goes. At most
 *  `max` bytes: a file that grew after it was opened is not taken. */
const copyOut = (fd: number, target: string, max: number): string | null => {
  const hash = createHash("sha256");
  const out = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  let total = 0;
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    for (let read = fs.readSync(fd, buffer); read > 0; read = fs.readSync(fd, buffer)) {
      total += read;
      if (total > max) return null;
      hash.update(buffer.subarray(0, read));
      fs.writeSync(out, buffer, 0, read);
    }
    return hash.digest("hex");
  } finally {
    fs.closeSync(out);
  }
};

const parse = <T>(data: Buffer | null): T | null => {
  if (!data) return null;
  try {
    return JSON.parse(data.toString("utf8")) as T;
  } catch {
    return null;
  }
};

/** One JSON file a domain wrote, as data; null for anything else. */
export const readData = <T>(file: string): T | null => {
  const dir = openDir(path.dirname(file));
  if (!dir) return null;
  try {
    return parse<T>(readIn(dir, path.basename(file), LIMIT.json));
  } catch {
    return null;
  } finally {
    dir.close();
  }
};

/** Every JSON file waiting in a directory of an outbox whose name matches, oldest name
 *  first, each read once and removed (its name, in that directory). */
export const drain = <T>(directory: string, pattern: RegExp, most: number): { name: string; data: T | null }[] => {
  const dir = openDir(directory);
  if (!dir) return [];
  try {
    return dir.names().filter((name) => pattern.test(name)).slice(0, most).map((name) => {
      const data = parse<T>(readIn(dir, name, LIMIT.json));
      removeIn(dir, name);
      return { name, data };
    });
  } finally {
    dir.close();
  }
};

const syncDir = (domain: string, repo: string) => path.join(outbox(domain), "sync", repo);

/** The domain's branches, as it listed them: only well-formed names and commits survive. */
export const listedRefs = (domain: string, repo: string): Record<string, string> => {
  if (!parseRepo(repo)) return {};
  const data = readData<{ refs?: unknown }>(path.join(syncDir(domain, repo), "refs.json"));
  const out: Record<string, string> = {};
  if (data && typeof data.refs === "object" && data.refs !== null)
    for (const [branch, commit] of Object.entries(data.refs as Record<string, unknown>).slice(0, 5000))
      if (isBranch(branch) && isCommit(commit)) out[branch] = commit;
  return out;
};

declare namespace listedRefs {
  // (A list that is there is read through openDir, which asks Linux's /proc where an open
  // directory is: on macOS it finds nothing, so only what is refused before that is here.)
  /** a repository is named as one, or nothing is read */
  export type NotARepo = Expect<Invoke<typeof listedRefs, [domain: "acme", repo: "../../state"]>, "=", {}>;
}

/** `incoming` is the root's own. A copy is deleted by whoever made it, minutes later; one
 *  left by a process that died is removed here, long after anything could be using it. */
const sweep = (incoming: string) => {
  try {
    for (const name of fs.readdirSync(incoming)) {
      const file = path.join(incoming, name);
      if (Date.now() - fs.lstatSync(file).mtimeMs > 6 * 3_600_000) fs.rmSync(file, { recursive: true, force: true });
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
export const takeBundles = (domain: string, repo: string, most = Infinity): { copies: string[]; dropped: number; more: boolean } => {
  const dir = openDir(syncDir(domain, repo));
  if (!dir) return { copies: [], dropped: 0, more: false };
  const copies: string[] = [];
  let dropped = 0;
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
      const opened = openIn(dir, name, LIMIT.bundle);
      // A name of the root's own making, never one a domain chose, and never one already there.
      const copy = path.join(incoming, `${Date.now().toString(36)}-${randomBytes(8).toString("hex")}.bundle`);
      try {
        if (!opened || copyOut(opened.fd, copy, LIMIT.bundle) === null) throw new Error("not a plain bundle file within the limit");
        copies.push(copy);
      } catch {
        fs.rmSync(copy, { force: true });
        dropped++;
      } finally {
        if (opened) fs.closeSync(opened.fd);
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
export type Refusal = { domain: string; repo: string; at: string; why: string };
const refusedFile = (domain: string) => path.join(ROOT.state, "refused", `${domain}.json`);
export const refusalsOf = (domain: string): Refusal[] => readJson<Refusal[]>(refusedFile(domain), []);
export const noteRefusal = (domain: string, repo: string, why: string) => {
  fs.mkdirSync(path.dirname(refusedFile(domain)), { recursive: true, mode: 0o700 });
  // The reason is in part the bundle's author's text: printable ASCII only, and short.
  const entry = { domain, repo, at: new Date().toISOString(), why: why.replace(/[^\x20-\x7e]/g, "?").slice(0, 300) };
  writeJson(refusedFile(domain), [...refusalsOf(domain).filter((r) => r.repo !== repo), entry].slice(-20));
};
export const clearRefusal = (domain: string, repo: string) => {
  const kept = refusalsOf(domain).filter((r) => r.repo !== repo);
  if (kept.length !== refusalsOf(domain).length) writeJson(refusedFile(domain), kept);
};

declare namespace noteRefusal {
  type Fresh = Invoke<typeof emptyRoot>;
  /** what the root refused from a domain is kept, one per repository, the latest; its reason
   *  (in part the bundle's author's text) printable and short */
  export type Keeps = Given<
    [
      Fresh,
      Invoke<typeof noteRefusal, [domain: "acme", repo: "acme/app", why: "first"]>,
      Invoke<typeof noteRefusal, [domain: "acme", repo: "acme/web", why: "hasDotgit: contains '.git'"]>,
      Invoke<typeof noteRefusal, [domain: "acme", repo: "acme/app", why: "badTree\u001b[2J\u202e"]>,
    ],
    Expect<Invoke<typeof refusalsOf, [domain: "acme"]>, "matches", [
      { domain: "acme"; repo: "acme/web"; why: "hasDotgit: contains '.git'" },
      { domain: "acme"; repo: "acme/app"; why: "badTree?[2J?" },
    ]>
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
export const takeLfs = (domain: string, repo: string, oid: string, size: number, target: string): { ok: true } | { error: string } => {
  if (!isLfsOid(oid)) return { error: "not an LFS object id" };
  const dir = openDir(path.join(outbox(domain), "lfs", repo));
  const opened = dir ? openIn(dir, oid, LIMIT.lfs) : null;
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    if (!dir || !opened) return { error: `the LFS object ${oid.slice(0, 12)} is not in the outbox` };
    if (opened.size !== size) return { error: `the LFS object ${oid.slice(0, 12)} is ${opened.size} bytes; its pointer says ${size}` };
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.rmSync(tmp, { force: true });
    if (copyOut(opened.fd, tmp, size) !== oid) return { error: `the LFS object ${oid.slice(0, 12)} does not hash to its id` };
    fs.renameSync(tmp, target);
    removeIn(dir, oid);
    return { ok: true };
  } finally {
    if (opened) fs.closeSync(opened.fd);
    dir?.close();
    fs.rmSync(tmp, { force: true });
  }
};

declare namespace takeLfs {
  type Fresh = Invoke<typeof emptyRoot>;
  /** an object is named by its sha256, which is checked before any path is made of it */
  export type NotAnId = Expect<Invoke<typeof takeLfs, [domain: "acme", repo: "acme/app", oid: "../../../state/registry.json", size: 1, target: "/nowhere"]>, "=", { error: "not an LFS object id" }>;
  /** one the domain did not stage is said so */
  export type NotStaged = Given<
    [Fresh, Invoke<typeof aDomain, [slug: "acme", repos: ["acme/app"]]>],
    Expect<Invoke<typeof takeLfs, [domain: "acme", repo: "acme/app", oid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", size: 1, target: Invoke<typeof pathIn, [where: "state", name: "lfs/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]>]>, "=", { error: "the LFS object aaaaaaaaaaaa is not in the outbox" }>
  >;
}

/** Drop a staged LFS object the root already has: its name, in the checked directory. */
export const dropLfs = (domain: string, repo: string, oid: string) => {
  if (!isLfsOid(oid)) return;
  const dir = openDir(path.join(outbox(domain), "lfs", repo));
  if (!dir) return;
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
const BRANCHES_PER_REPO = 200;
export const branchesOf = (slug: string, repoList: string[]) => {
  const out: { repo: string; branch: string; commit: string }[] = [];
  const base = outbox(slug);
  for (const repo of repoList) {
    const text = readPlain(base, path.join(base, "sync", repo, "refs.json"), 256 * 1024, true);
    if (text === null) continue;
    let refs: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(text) as { refs?: unknown };
      if (parsed.refs && typeof parsed.refs === "object" && !Array.isArray(parsed.refs)) refs = parsed.refs as Record<string, unknown>;
    } catch {
      continue;
    }
    for (const [branch, commit] of Object.entries(refs).slice(0, BRANCHES_PER_REPO)) if (isBranch(branch) && isCommit(commit)) out.push({ repo, branch, commit });
  }
  return out;
};

declare namespace branchesOf {
  type Fresh = Invoke<typeof emptyRoot>;
  type Acme = Invoke<typeof aDomain, [slug: "acme", repos: ["acme/app", "acme/web"]]>;
  /** the domain's own list of its branches, read as data: only names desolate carries, and
   *  whole commits, survive */
  export type Lists = Given<
    [Fresh, Acme, Invoke<typeof writeJsonIn, [where: "domains", name: "acme/outbox/sync/acme/app/refs.json", value: { refs: { main: "0123456789abcdef0123456789abcdef01234567"; "feature/login": "0123456789abcdef0123456789abcdef01234567"; "--upload-pack=x": "0123456789abcdef0123456789abcdef01234567"; "a..b": "0123456789abcdef0123456789abcdef01234567"; short: "0123456"; "x@{1}": "0123456789abcdef0123456789abcdef01234567" } }]>],
    Expect<Invoke<typeof branchesOf, [slug: "acme", repoList: ["acme/app", "acme/web"]]>, "=", [
      { repo: "acme/app"; branch: "main"; commit: "0123456789abcdef0123456789abcdef01234567" },
      { repo: "acme/app"; branch: "feature/login"; commit: "0123456789abcdef0123456789abcdef01234567" },
    ]>
  >;
  /** a list that is a link (to a file of the root's, say), too large, not JSON, or not a
   *  record of branches is no list: that repository shows none, the others theirs */
  export type NotAList = Given<
    [
      Fresh, Acme,
      Invoke<typeof writeJsonIn, [where: "state", name: "secret.json", value: { refs: { main: "0123456789abcdef0123456789abcdef01234567" } }]>,
      Invoke<typeof linkIn, [where: "domains", name: "acme/outbox/sync/acme/app/refs.json", target: Invoke<typeof pathIn, [where: "state", name: "secret.json"]>]>,
      Invoke<typeof writeFilledIn, [where: "domains", name: "acme/outbox/sync/acme/web/refs.json", bytes: 300000]>,
    ],
    Expect<Invoke<typeof branchesOf, [slug: "acme", repoList: ["acme/app", "acme/web"]]>, "=", []>
  >;
  /** a list that is not JSON, or whose refs are not a record, is none either */
  export type NotJson = Given<
    [Fresh, Acme, Invoke<typeof writeIn, [where: "domains", name: "acme/outbox/sync/acme/app/refs.json", text: "{"]>, Invoke<typeof writeJsonIn, [where: "domains", name: "acme/outbox/sync/acme/web/refs.json", value: { refs: ["main"] }]>],
    Expect<Invoke<typeof branchesOf, [slug: "acme", repoList: ["acme/app", "acme/web"]]>, "=", []>
  >;
}
