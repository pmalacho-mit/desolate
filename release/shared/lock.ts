// Locks, held by something alive and not by their age (docs/v3/limits.md, R5). A lock here
// is a directory that names its holder, and it is stale only when that holder is gone:
// never because it is old. A push that packs for twenty minutes keeps its lock for twenty
// minutes; a holder that died leaves its lock to the next taker, at once.
//
// Two scopes, for the two ways of knowing a holder is alive:
// - `machine`: every process that takes the lock runs in one VM, or on the Mac. The lock
//   names its holder's pid and when that process started, so a pid the system has given to
//   another process since is not taken for the holder.
// - `share`: the lock is in a folder several VMs see, and one VM cannot see another's
//   processes. The holder writes a beat into the lock for as long as it lives; the lock is
//   stale only when the beat has stopped (BEAT, below, is the one number).
//
// How it is exclusive, with nothing but a rename:
// - Taking: the lock is made complete beside its place (holder written, beat started), then
//   renamed into place. A rename onto a directory that has anything in it fails, so of any
//   number of takers one succeeds, and a lock in place is never one without its holder.
// - Taking over from a dead holder: every taking carries an id of its own, and the right to
//   move a dead holder's lock away is itself taken, at a name made of that id
//   (`<dir>.heir-<id>`), the same way. So exactly one waiter moves it. A lock is known by
//   the directory it is (its device and inode), not by what its holder file says: a waiter
//   moves what is in the lock's place out of it, and then looks at what it moved; when that
//   is not the directory it found dead (it read the holder a moment too late, or was frozen
//   between, on a share), it puts it straight back. The lock a new holder made is not
//   removed by a waiter who meant the old one. (root/reviewer.ts's `oneAtATime` read the
//   dead lock and then renamed it away, two steps: a second waiter between them removed the
//   first one's new lock. Checking the holder's id before the rename is the same two steps,
//   and every lock with no holder to read has the same id.)
// - Leaving: the holder moves its own lock away under the same right, so a holder that was
//   taken for dead (possible on a share: see BEAT) does not remove its heir's lock.
//
// No timer in here ends a wait (R4): `wait` waits for as long as its caller does, says who
// it is waiting for (`waiting`), and stops when the caller's `signal` fires.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { openPlain } from "./copy.ts";
import { printable } from "./text.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type {
  Configure,
  Expect,
  Given,
  Invoke,
  Throws,
} from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { emptyScratch, scratch, scratchFiles } from "../.harness/shared-files.ts";
import type {
  answering,
  contended,
  heldBy,
  holding,
  leftByADeadProcess,
  leftByAZombie,
  danglingLinkAt,
  frozenHeir,
  holderUnreadable,
  hostileFolder,
  leftWithABeat,
} from "../.harness/shared-lock.ts";

/** Who holds a lock, as a refusal or a wait says it: the process, the machine it is on (a
 *  VM's name, or the Mac's), and since when (an ISO time, by that machine's clock). Pid 0,
 *  and the rest empty, when the lock is there and its holder file could not be read. */
export type Holder = { pid: number; host: string; since: string };

/** What a lock's `holder` file says. `id`: this taking, and no other. `start`: when the
 *  process started, as its own system says it (see `startOf`), or null where it cannot. */
type Entry = Holder & { id: string; start: string | null };

/** The pace of a lock, in milliseconds.
 *
 *  `pollMs`: how often a waiter looks again. A quarter of a second: a person waiting on a
 *  lock does not feel it, and looking costs two small reads.
 *
 *  `beatMs` and `missed` are for a share. The holder writes its beat every `beatMs`, from a
 *  thread of its own, so its work may keep the process busy without a beat being late. A
 *  waiter takes the holder for dead when it has watched `missed` beats' time go by with no
 *  new beat: by its own clock, running while it watches, so two VMs' clocks need not agree
 *  and a Mac that slept (every VM stopped, and started, together) wakes to no stale lock.
 *  Two seconds, five times: ten seconds of silence from a thread with nothing else to do is
 *  not a slow disk or a busy VM, and ten seconds is what a taker waits on a holder that
 *  crashed. It is also the one thing here that is a judgement: a holder whose whole VM is
 *  frozen for longer while the others run is taken for dead, and finds on waking that its
 *  lock is another's. What is done under a share lock must be safe to do again.
 *
 *  A parameter of `withLock` only so that a test need not take ten seconds. */
export const BEAT = { pollMs: 250, beatMs: 2_000, missed: 5 } as const;
export type Pace = { pollMs: number; beatMs: number; missed: number };

const ID = /^[0-9a-f]{32}$/;
/** A lock in place with no holder a taker can read: nobody's. Our own are never so (a lock
 *  is renamed into place complete), so this is something else's leaving, or a lock written
 *  by a side that does not keep to the form. It is cleared as a dead holder's is. */
const NOBODY: Entry = { id: "nobody", pid: 0, host: "", since: "", start: null };
/** A lock whose holder file is there and could not be read just now (no descriptor left, an
 *  I/O error on a share): taken for alive, since nothing is known of it, and read again at
 *  the next look. */
const UNREAD: Entry = { id: "unread", pid: 0, host: "", since: "", start: null };

const NOFOLLOW = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
/** A lock's holder file, read: its text; null when there is none a taker can read (no such
 *  file, a link, a FIFO, one too large: nobody's); undefined when it could not be read now,
 *  for another reason, which says nothing about the lock. */
const holderFile = (file: string): string | null | undefined => {
  let fd: number;
  try {
    fd = fs.openSync(file, NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // (EACCES: one no taker may read, since ours are open to every taker.)
    return code === "ENOENT" ||
      code === "ELOOP" ||
      code === "ENOTDIR" ||
      code === "EMLINK" ||
      code === "EACCES" ||
      code === "EPERM"
      ? null
      : undefined;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024) return null;
    const bytes = Buffer.alloc(stat.size);
    return bytes.subarray(0, fs.readSync(fd, bytes, 0, stat.size, 0)).toString("utf8");
  } catch {
    return undefined;
  } finally {
    fs.closeSync(fd);
  }
};

/** What the system says of the process `pid`: when it started; "gone" when there is no such
 *  process; "zombie" when only its remains are there (it has exited, and nothing has asked
 *  after it yet: a signal can still be sent to it, and it holds nothing); null when the
 *  system will not say. Linux: /proc/<pid>/stat, whose third field is the state and whose
 *  22nd is the start time, in clock ticks since boot. A Mac has no /proc: `ps`, in UTC and
 *  the C locale, so that two askers with different settings read the same text. */
const look = (pid: number): { start: string } | "gone" | "zombie" | null => {
  try {
    // The second field is the program's name in brackets, and may itself hold spaces and
    // brackets: the fields are counted from after the last one.
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "latin1");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (fields[0] === "Z" || fields[0] === "X") return "zombie";
    return fields[19] ? { start: fields[19] } : null;
  } catch (error) {
    // No such entry under a /proc that is there: no such process. Any other failure (no
    // descriptor left, no memory) says nothing of the process, and a lock is never taken
    // on nothing.
    if (fs.existsSync("/proc/self/stat"))
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? "gone" : null;
  }
  const ran = spawnSync("ps", ["-o", "stat=,lstart=", "-p", String(pid)], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" },
  });
  if (ran.error || ran.status === null) return null;
  const said = ran.stdout.trim();
  if (ran.status !== 0 || said === "") return "gone";
  if (said.startsWith("Z")) return "zombie";
  const start = said.replace(/^\S+\s+/, "");
  return start === said ? null : { start };
};

/** When the process `pid` started, as text that is the same each time it is asked about one
 *  process and differs for another that later has the pid; null when there is no such
 *  process, or the system will not say. */
export const startOf = (pid: number): string | null => {
  const seen = look(pid);
  return seen !== null && typeof seen === "object" ? seen.start : null;
};

let ownStart: string | null | undefined;
const me = (): Entry => ({
  id: randomBytes(16).toString("hex"),
  pid: process.pid,
  host: os.hostname(),
  since: new Date().toISOString(),
  start: (ownStart ??= startOf(process.pid)),
});

/** A small plain file's text, or null: not followed if it is a link, not waited on if it is
 *  a FIFO, not read if it is large. A lock on a share is written by another VM. */
const small = (file: string): string | null => {
  const opened = openPlain(file, 1024);
  if (!opened) return null;
  try {
    const bytes = Buffer.alloc(opened.size);
    return bytes.subarray(0, fs.readSync(opened.fd, bytes, 0, opened.size, 0)).toString("utf8");
  } finally {
    fs.closeSync(opened.fd);
  }
};

/** Which directory is at `at` (its device and inode), or null when nothing is. The lock is
 *  this, and not what its holder file says: two locks may say the same, never be the same. */
const identity = (at: string): string | null => {
  try {
    const stat = fs.lstatSync(at, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.isDirectory() ? "d" : "f"}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

/** A lock as a taker saw it: its holder, and the directory it is. */
type Seen = { entry: Entry; is: string };

/** Who holds the lock at `at`: null when there is no lock there (nothing, or an empty
 *  directory, which a rename replaces), NOBODY when there is one with no holder to read.
 *  What it says and the directory it is are read together: a lock that left, or was
 *  replaced, while it was being read is read again (a holder leaving between the listing
 *  and the reading of its holder file was taken for one that named nobody). */
const read = (at: string): Seen | null => {
  // (Bounded: a side that swaps the place without end is not waited out here, on the main
  // thread; it is a holder not read just now, and looked at again in a moment.)
  for (let tries = 0; ; tries++) {
    const is = identity(at);
    if (is === null) return null;
    if (tries === 100) return { entry: UNREAD, is };
    // Not a directory (a file, a link, one dangling): no lock of ours, and nobody's.
    if (!is.endsWith(":d")) return { entry: NOBODY, is };
    try {
      if (fs.readdirSync(at).length === 0) return null;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (identity(at) !== is) continue;
      // One no taker may read (ours are open to every taker): nobody's. Any other failure
      // (no descriptor left) is a holder not read just now.
      const nobodys =
        code === "ENOENT" || code === "ENOTDIR" || code === "EACCES" || code === "EPERM";
      return { entry: nobodys ? NOBODY : UNREAD, is };
    }
    const text = holderFile(path.join(at, "holder"));
    if (identity(at) !== is) continue;
    return { entry: text === undefined ? UNREAD : holderOf(text), is };
  }
};

/** What a holder file says, or NOBODY when it says nothing a taker can read. */
const holderOf = (text: string | null): Entry => {
  try {
    const said = JSON.parse(text ?? "") as Partial<Entry> | null;
    if (
      said &&
      typeof said.id === "string" &&
      ID.test(said.id) &&
      Number.isInteger(said.pid) &&
      (said.pid as number) > 0 &&
      (said.pid as number) <= 0x7fffffff &&
      typeof said.host === "string" &&
      typeof said.since === "string" &&
      (said.start === null || typeof said.start === "string")
    )
      return {
        id: said.id,
        pid: said.pid as number,
        host: printable(said.host, 80),
        since: printable(said.since, 40),
        start: said.start,
      };
  } catch {
    /* not JSON: nobody's */
  }
  return NOBODY;
};

/** `entry` made a lock at `at`, whole: the directory it is; or null when a lock is there
 *  already. Made beside its place and renamed into it: the rename fails onto a directory
 *  with anything in it, and that is the whole of the exclusion. What a lock holds is no
 *  secret (a pid and a time), and whoever shares the lock must be able to read it; who may
 *  take it is the folder's to say. `filled` adds to the lock before it is in place. */
const put = (at: string, entry: Entry, filled?: (fresh: string) => void): string | null => {
  const fresh = `${at}.new-${entry.id}`;
  fs.mkdirSync(fresh, { mode: 0o755 });
  let is: string | null;
  try {
    // Made, never opened: a link another side put there in the moment since the mkdir is
    // not followed (O_EXCL fails on any name that is there, a link that leads nowhere too),
    // and the taking fails, saying so: another is at the lock's own making.
    fs.writeFileSync(path.join(fresh, "holder"), JSON.stringify(entry), {
      mode: 0o644,
      flag: "wx",
    });
    filled?.(fresh);
    is = identity(fresh);
  } catch (error) {
    removed(fresh);
    throw error;
  }
  try {
    fs.renameSync(fresh, at);
    return is;
  } catch (error) {
    removed(fresh);
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOTEMPTY" || code === "EEXIST") return null;
    throw error;
  }
};

/** The lock `seen`, moved out of its place `at` and then removed: so its place is free in
 *  one step, and never holds a lock half removed. Whatever is in the place is moved, and
 *  then looked at: when it is not `seen` (the same directory, naming the same holder: an
 *  inode alone is given again to a new directory on some filesystems), it is put straight
 *  back. If, in that moment, a third took the place, the one moved has lost its lock: it is
 *  removed, and its holder finds on leaving that the lock is not its own. That needs a
 *  waiter to stop for longer than a holder's whole life between seeing a lock and moving
 *  it: on one machine, never (a waiter that stops holds the right, and is alive); on a
 *  share, a VM frozen past BEAT's window. */
const away = (at: string, seen: Seen) => {
  const gone = `${at}.gone-${randomBytes(8).toString("hex")}`;
  try {
    fs.renameSync(at, gone);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    // Something no taker made, that this one may not move (a directory closed to it): no
    // taker can ever take the lock, and waiting would not change that. Said, as such.
    if (code === "EACCES" || code === "EPERM")
      throw new Error(
        `${path.basename(at)} is in the way: what is there is no lock, and this process may not move it (${code}): ${at}`,
      );
    throw error;
  }
  if (!same(gone, seen))
    try {
      fs.renameSync(gone, at);
      return;
    } catch {
      /* the place is taken again: below */
    }
  removed(gone);
};

/** `file` unlinked, if it is there (a link: the link, never what it leads to). */
const unlinked = (file: string) => {
  try {
    fs.unlinkSync(file);
  } catch {
    /* not there, or not a file of ours */
  }
};

/** A lock directory moved out of its place, removed: the two files a lock of ours holds,
 *  and then the directory, and nothing else. Not a removal of whatever tree is there, which
 *  walks it (another side's, on a share) and follows a link swapped into it mid-walk:
 *  every file of the folder it leads to went. A directory that holds anything else is not
 *  ours, and is left where it was moved, beside the lock, for a person to see. */
const removed = (dir: string) => {
  for (const name of ["holder", "beat"])
    try {
      fs.unlinkSync(path.join(dir, name));
    } catch {
      /* not there, or not ours to remove */
    }
  try {
    fs.rmdirSync(dir);
  } catch {
    /* not empty (not ours), or not a directory: a link, a file */
    try {
      if (!fs.lstatSync(dir).isDirectory()) fs.unlinkSync(dir);
    } catch {
      /* gone already */
    }
  }
};

/** Whether the lock at `at` is the one seen: the same directory, naming the same holder (a
 *  holder file that cannot be read just now is no evidence against it). */
const same = (at: string, seen: Seen): boolean => {
  if (identity(at) !== seen.is) return false;
  const text = holderFile(path.join(at, "holder"));
  // Nobody's: still nobody's (not a lock of ours made since, given the same inode).
  if (seen.entry === NOBODY) return text !== undefined && holderOf(text) === NOBODY;
  return text === undefined || holderOf(text).id === seen.entry.id;
};

type Is = "alive" | "dead" | "watched";

/** Is the process a machine lock names still there? Gone when there is no such pid, when
 *  the pid is now a process that started at another time, and when it is a zombie: a
 *  holder that was killed and that its parent has not asked after would otherwise hold its
 *  lock for as long as the parent lived. Where the system will not say (no `ps`, or a
 *  /proc that hides other users' processes), a pid that is there is taken for the holder: a
 *  lock is never taken from a process that may be its holder. */
const running = (entry: Entry): Is => {
  if (entry === NOBODY) return "dead";
  if (entry === UNREAD) return "alive";
  let ours = true;
  try {
    process.kill(entry.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return "dead";
    // EPERM: there is such a process, and it is another user's.
    ours = false;
  }
  const seen = look(entry.pid);
  if (seen === "zombie") return "dead";
  // Not to be seen, though it took a signal a moment ago: it has just ended, unless it is
  // another user's and hidden from us.
  if (seen === "gone") return ours ? "dead" : "alive";
  return seen !== null && entry.start !== null && seen.start !== entry.start ? "dead" : "alive";
};

/** Is the holder of a share lock still beating? `seen` is this waiter's own memory of each
 *  holder's last beat and when it saw it change, by a clock that runs only while this
 *  process does. "watched": no new beat yet, and not yet long enough to say it stopped. */
const beating = (
  at: string,
  entry: Entry,
  seen: Map<string, { beat: string; at: number; looked: number; alive: boolean }>,
  pace: Pace,
): Is => {
  if (entry === NOBODY) return "dead";
  if (entry === UNREAD) return "alive";
  const beat = small(path.join(at, "beat")) ?? "";
  const now = performance.now();
  const last = seen.get(entry.id);
  // Silence counts only while it was watched: a waiter that did not look for half the
  // window (its VM paused, the Mac asleep, and its clock went on) starts watching again, so
  // that a holder paused with it is given the whole window once both run.
  if (!last || now - last.looked > (pace.beatMs * pace.missed) / 2) {
    seen.set(entry.id, { beat, at: now, looked: now, alive: last?.alive ?? false });
    return last?.alive ? "alive" : "watched";
  }
  last.looked = now;
  if (last.beat !== beat) {
    seen.set(entry.id, { beat, at: now, looked: now, alive: true });
    return "alive";
  }
  if (now - last.at >= pace.beatMs * pace.missed) return "dead";
  return last.alive ? "alive" : "watched";
};

/** The dead holder's lock `seen`, at `at`, moved away by whoever takes the right to: one
 *  taker, since the right is a lock of its own, named by the dead holder's id. The one who
 *  has it moves the lock only if it is still the one seen (`away`). An heir that died
 *  holding the right is cleared the same way, by an heir of its own. False when another has
 *  the right and is alive, or not yet known to be dead: there is nothing to do but look
 *  again in a moment.
 *  Also how a holder leaves: `seen` is then its own. */
const clear = (
  dir: string,
  at: string,
  seen: Seen,
  is: (at: string, entry: Entry) => Is,
): boolean => {
  const right = `${dir}.heir-${seen.entry.id}`;
  const heir = me();
  const mine = put(right, heir);
  if (mine !== null) {
    try {
      if (same(at, seen)) away(at, seen);
    } finally {
      away(right, { entry: heir, is: mine });
    }
    return true;
  }
  const other = read(right);
  return other !== null && is(right, other.entry) === "dead" && clear(dir, right, other, is);
};

/** The beat of a share lock: a thread that writes a count into the lock's `beat` file,
 *  through a descriptor opened before the lock was in place, so that it follows the lock
 *  wherever it is moved and never writes into another's. A thread, so that work which keeps
 *  the process busy (a `spawnSync`, a long parse) does not stop the beat; it ends with the
 *  process, which is the point. Answers once the first beat is written. */
const startBeat = async (file: string, everyMs: number): Promise<() => Promise<void>> => {
  const fd = fs.openSync(file, "wx", 0o644);
  const worker = new Worker(
    // (getBuiltinModule: the same text is a script or a module, whichever this process
    // takes evaluated code for.)
    `const { parentPort, workerData } = process.getBuiltinModule("node:worker_threads");
     const fs = process.getBuiltinModule("node:fs");
     let count = 0;
     const beat = () => { try { fs.writeSync(workerData.fd, String(++count), 0); } catch {} };
     beat();
     parentPort.postMessage("beating");
     setInterval(beat, workerData.everyMs);`,
    { eval: true, workerData: { fd, everyMs } },
  );
  const stop = async () => {
    await worker.terminate();
    fs.closeSync(fd);
  };
  try {
    await new Promise<void>((resolve, reject) => {
      worker.once("message", () => resolve());
      worker.once("error", reject);
      worker.once("exit", () => reject(new Error("the lock's beat did not start")));
    });
  } catch (error) {
    await stop();
    throw error;
  }
  worker.unref();
  return stop;
};

const pause = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

/** `work`, done while holding the lock `dir`, and its answer; the lock is left when the
 *  work ends, however it ends. `dir` is the lock's own name (`<state>/fetch.lock`): it is
 *  there while the lock is held, and its folder must be one every taker can write. Beside
 *  it, for moments, are others named after it (`<dir>.new-<id>`, `.heir-<id>`, `.gone-<id>`,
 *  `.beat-<id>`): the lock being made, taken over or removed. Whatever sweeps that folder
 *  leaves them, or sweeps only when no taker runs; one left by a process killed in such a
 *  moment is small, and harmless. A directory that was in the lock's place and was not a
 *  lock (it held other files) is moved aside and left there, as `<dir>.gone-<x>`: it is
 *  not walked to be removed, since on a share another side may swap a link into it.
 *
 *  - `scope`: how a holder is known to be alive (above). `machine` unless said.
 *  - `wait`: when the lock is held by something alive, wait for it (the default), for as
 *    long as the caller does; `waiting` is told who holds it, once for each holder, so the
 *    caller can say what it is waiting for; `signal` ends the wait (it throws the signal's
 *    reason), as when whoever asked went away, and the work is not begun if it fired while
 *    the lock was being taken. Once begun, the work is its own to end: give it the same
 *    signal. The lock is held until it returns.
 *  - `wait: false`: refuse instead, with who holds it and since when. The refusal is an
 *    Error with `holder` on it; `busy` words its message. On a share, a holder is known to
 *    be alive only by its next beat, so the refusal comes within one beat, and a lock whose
 *    beat has stopped is taken, within BEAT's `beatMs` times `missed`.
 *  - A lock whose holder is gone is taken, waiting or not, by exactly one of those who
 *    find it.
 *
 *  It is not re-entrant: work that takes the lock it is done under waits for itself. */
export const withLock = async <T>(
  dir: string,
  work: () => Promise<T>,
  options: {
    scope?: "machine" | "share";
    wait?: boolean;
    busy?: (holder: Holder) => string;
    waiting?: (holder: Holder) => void;
    signal?: AbortSignal;
  } = {},
  pace: Pace = BEAT,
): Promise<T> => {
  const share = options.scope === "share";
  const seen = new Map<string, { beat: string; at: number; looked: number; alive: boolean }>();
  const is = (at: string, entry: Entry): Is =>
    share ? beating(at, entry, seen, pace) : running(entry);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  let mine: Seen;
  let stopBeat: (() => Promise<void>) | undefined;
  let told: string | undefined;
  for (;;) {
    options.signal?.throwIfAborted();
    const seen = read(dir);
    if (!seen) {
      // Free, as far as can be seen: make ours and try to put it there.
      const entry = me();
      if (!share) {
        const there = put(dir, entry);
        if (there !== null) {
          mine = { entry, is: there };
          break;
        }
        continue;
      }
      const fresh = `${dir}.beat-${entry.id}`;
      let stop: () => Promise<void>;
      try {
        stop = await startBeat(fresh, pace.beatMs);
      } catch (error) {
        unlinked(fresh);
        throw error;
      }
      let there: string | null;
      try {
        there = put(dir, entry, (lock) => fs.renameSync(fresh, path.join(lock, "beat")));
      } catch (error) {
        await stop();
        throw error;
      } finally {
        unlinked(fresh);
      }
      if (there !== null) {
        mine = { entry, is: there };
        stopBeat = stop;
        break;
      }
      await stop();
      continue;
    }
    const holder = seen.entry;
    const state = is(dir, holder);
    // Cleared: look again at once; unless what was there is there still (it could not be
    // moved), which is looked at again in a moment like any lock that is held.
    if (state === "dead" && clear(dir, dir, seen, is) && !same(dir, seen)) continue;
    if (state === "alive") {
      const who: Holder = { pid: holder.pid, host: holder.host, since: holder.since };
      if (options.wait === false)
        throw Object.assign(
          new Error(
            options.busy?.(who) ??
              (holder === UNREAD
                ? `${path.basename(dir)} is held, by a holder that could not be read just now`
                : `${path.basename(dir)} is held by process ${who.pid} on ${who.host}, since ${who.since}`),
          ),
          { holder: who },
        );
      if (told !== holder.id) {
        told = holder.id;
        options.waiting?.(who);
      }
    }
    await pause(share ? Math.min(pace.pollMs, pace.beatMs) : pace.pollMs, options.signal);
  }
  try {
    // Whoever asked may have gone while the lock was being taken.
    options.signal?.throwIfAborted();
    return await work();
  } finally {
    try {
      await stopBeat?.();
    } catch {
      /* the thread ends with the process, and the lock is left below all the same */
    }
    try {
      clear(dir, dir, mine, is);
    } catch {
      /* below */
    }
    // Still there: the right could not be made (no descriptor left, a full disk), or what
    // was in its place was cleared instead (a directory left there, or put there). The lock
    // is left without it, as the one it is: nobody else holds a live holder's right but on
    // a share, where it is a waiter that took this holder for dead, and moves only it.
    if (same(dir, mine)) away(dir, mine);
  }
};

declare namespace withLock {
  /** the work's answer, and no lock left behind it */
  export type Works = Given<
    Invoke<typeof emptyScratch>,
    [
      Expect<
        Invoke<
          typeof withLock,
          [
            dir: Invoke<typeof scratch, [name: "locks/fetch.lock"]>,
            work: Invoke<typeof answering, [answer: "fetched"]>,
          ]
        >,
        "=",
        "fetched"
      >,
      Expect<Invoke<typeof scratchFiles, [dir: "locks"]>, "=", []>,
    ]
  >;
  /** while it is held, its folder shows who by: the lock is a directory that names its
   *  holder, this process, and is gone when the work ends */
  export type NamesItsHolder = Given<
    Invoke<typeof emptyScratch>,
    Expect<
      Invoke<typeof holding, [dir: Invoke<typeof scratch, [name: "locks/fetch.lock"]>]>,
      "=",
      { during: ["fetch.lock"]; holderIsThisProcess: true; after: [] }
    >
  >;
  /** one at a time: of four processes that take the same lock at once, no two are ever
   *  inside it together. The control, the same four with no lock, are. */
  export type OneAtATime = Given<
    Invoke<typeof emptyScratch>,
    [
      Expect<
        Invoke<
          typeof contended,
          [dir: Invoke<typeof scratch, [name: "locks/a.lock"]>, takers: 4, locked: true]
        >,
        "=",
        { entered: 4; overlapped: false }
      >,
      Expect<
        Invoke<
          typeof contended,
          [dir: Invoke<typeof scratch, [name: "locks/b.lock"]>, takers: 4, locked: false]
        >,
        "=",
        { entered: 4; overlapped: true }
      >,
    ]
  >;
  /** a holder that exited without leaving its lock (killed, crashed) does not hold it: the
   *  lock is taken at once, however new it is */
  export type HolderExited = Given<
    [
      Invoke<typeof emptyScratch>,
      Invoke<typeof leftByADeadProcess, [dir: Invoke<typeof scratch, [name: "locks/fetch.lock"]>]>,
    ],
    Expect<
      Invoke<
        typeof withLock,
        [
          dir: Invoke<typeof scratch, [name: "locks/fetch.lock"]>,
          work: Invoke<typeof answering, [answer: "fetched"]>,
          options: { wait: false },
        ]
      >,
      "=",
      "fetched"
    >
  >;
  /** two waiters (here four) and one dead holder: one of them takes the dead holder's lock
   *  away, and the lock the first then makes is not removed by a second who also found the
   *  holder dead. No two are ever inside together, and none is left out. */
  export type DeadHolderTakenOverByOne = Given<
    [
      Invoke<typeof emptyScratch>,
      Invoke<typeof leftByADeadProcess, [dir: Invoke<typeof scratch, [name: "locks/c.lock"]>]>,
    ],
    Expect<
      Invoke<
        typeof contended,
        [dir: Invoke<typeof scratch, [name: "locks/c.lock"]>, takers: 4, locked: true]
      >,
      "=",
      { entered: 4; overlapped: false }
    >
  >;
  /** not waiting, and a live holder: refused, with who holds it and since when. (The holder
   *  here is this process itself, named as a holder that started when it did.) */
  export type Refuses = Given<
    [
      Invoke<typeof emptyScratch>,
      Invoke<
        typeof heldBy,
        [
          dir: Invoke<typeof scratch, [name: "locks/push.lock"]>,
          holder: "this process",
          since: "2026-11-20T21:04:05.000Z",
        ]
      >,
    ],
    Throws<
      Invoke<
        typeof withLock,
        [
          dir: Invoke<typeof scratch, [name: "locks/push.lock"]>,
          work: Invoke<typeof answering, [answer: "pushed"]>,
          options: { wait: false },
        ]
      >,
      { matches: "^push\\.lock is held by process \\d+ on .+, since 2026-11-20T21:04:05.000Z$" }
    >
  >;
  /** a holder that was killed and not yet asked after by its parent is a zombie: a signal
   *  still reaches its pid, and it holds nothing. Its lock is taken. */
  export type HolderIsAZombie = Given<
    [
      Invoke<typeof emptyScratch>,
      Invoke<typeof leftByAZombie, [dir: Invoke<typeof scratch, [name: "locks/fetch.lock"]>]>,
    ],
    Expect<
      Invoke<
        typeof withLock,
        [
          dir: Invoke<typeof scratch, [name: "locks/fetch.lock"]>,
          work: Invoke<typeof answering, [answer: "fetched"]>,
          options: { wait: false },
        ]
      >,
      "=",
      "fetched"
    >
  >;
  /** a reused pid: the lock names a pid that is alive, but as a process that started at
   *  another time than the holder did. The holder is gone, and the lock is taken. The test
   *  above is the control: the same pid with its true start time is a live holder. */
  export type ReusedPid = Given<
    [
      Invoke<typeof emptyScratch>,
      Invoke<
        typeof heldBy,
        [
          dir: Invoke<typeof scratch, [name: "locks/push.lock"]>,
          holder: "this pid, started at another time",
          since: "2026-11-20T21:04:05.000Z",
        ]
      >,
    ],
    Expect<
      Invoke<
        typeof withLock,
        [
          dir: Invoke<typeof scratch, [name: "locks/push.lock"]>,
          work: Invoke<typeof answering, [answer: "pushed"]>,
          options: { wait: false },
        ]
      >,
      "=",
      "pushed"
    >
  >;
  /** what is in the lock's place but names no holder (another program's leaving, a file a
   *  hostile side wrote there) holds nothing */
  export type NamesNobody = Given<
    [
      Invoke<typeof emptyScratch>,
      Invoke<
        typeof heldBy,
        [
          dir: Invoke<typeof scratch, [name: "locks/push.lock"]>,
          holder: "nobody",
          since: "2026-11-20T21:04:05.000Z",
        ]
      >,
    ],
    Expect<
      Invoke<
        typeof withLock,
        [
          dir: Invoke<typeof scratch, [name: "locks/push.lock"]>,
          work: Invoke<typeof answering, [answer: "pushed"]>,
          options: { wait: false },
        ]
      >,
      "=",
      "pushed"
    >
  >;
  /** a holder file that is there and could not be read just now (no descriptor left) says
   *  nothing of its holder: a live one is not taken for nobody, and keeps its lock. Then,
   *  read, it is refused by name */
  export type HolderUnreadable = Given<
    Invoke<typeof emptyScratch>,
    Expect<
      Invoke<typeof holderUnreadable, [dir: Invoke<typeof scratch, [name: "locks/read.lock"]>]>,
      "=",
      [
        "read.lock is held, by a holder that could not be read just now",
        "read.lock is held by process <this one> on this-machine, since 2026-11-20T21:04:05.000Z",
      ]
    >
  >;
  /** what is in the lock's place and is no directory (here a link that leads nowhere) is
   *  nobody's lock: moved away, and the lock taken, at once */
  export type NotADirectory = Given<
    [
      Invoke<typeof emptyScratch>,
      Invoke<typeof danglingLinkAt, [dir: Invoke<typeof scratch, [name: "locks/link.lock"]>]>,
    ],
    [
      Expect<
        Invoke<
          typeof withLock,
          [
            dir: Invoke<typeof scratch, [name: "locks/link.lock"]>,
            work: Invoke<typeof answering, [answer: "fetched"]>,
            options: { wait: false },
          ]
        >,
        "=",
        "fetched"
      >,
      Expect<Invoke<typeof scratchFiles, [dir: "locks"]>, "=", []>,
    ]
  >;
  /** what another side puts in a shared lock folder is not followed: a link put into the
   *  lock being made is not written through (the taking fails, and says so), and a directory in the lock's place holding a link is moved aside, not walked:
   *  the taker's own files stay as they were. (Before, the first overwrote the file it led
   *  to; the second, with a link swapped in mid-removal, emptied the folder.) */
  export type HostileFolder = [
    Given<
      Invoke<typeof emptyScratch>,
      Expect<
        Invoke<
          typeof hostileFolder,
          [
            dir: Invoke<typeof scratch, [name: "shared/a.lock"]>,
            does: "link in the lock being made",
          ]
        >,
        "=",
        {
          took: "EEXIST: file already exists, open '<the lock being made>/holder'";
          untouched: true;
          left: [];
        }
      >
    >,
    Given<
      Invoke<typeof emptyScratch>,
      Expect<
        Invoke<
          typeof hostileFolder,
          [
            dir: Invoke<typeof scratch, [name: "shared/b.lock"]>,
            does: "a directory with a link in it",
          ]
        >,
        "=",
        { took: true; untouched: true; left: ["b.lock.gone-<id>"] }
      >
    >,
  ];
  /** on a share, a holder is alive by its beat: one whose beat goes on is refused to a
   *  taker that will not wait (the control for the next) */
  export type ShareBeating = Given<
    [
      Invoke<typeof emptyScratch>,
      Invoke<
        typeof leftWithABeat,
        [dir: Invoke<typeof scratch, [name: "locks/init.lock"]>, beating: true]
      >,
    ],
    Throws<
      Invoke<
        typeof withLock,
        [
          dir: Invoke<typeof scratch, [name: "locks/init.lock"]>,
          work: Invoke<typeof answering, [answer: "cloned"]>,
          options: { scope: "share"; wait: false },
          pace: { pollMs: 10; beatMs: 40; missed: 10 },
        ]
      >,
      "init.lock is held by process"
    >
  >;
  /** and one whose beat has stopped is gone, whatever pid it names (another VM's, which
   *  means nothing here): the lock is taken once `missed` beats have gone by with none */
  export type ShareBeatStopped = Given<
    [
      Invoke<typeof emptyScratch>,
      Invoke<
        typeof leftWithABeat,
        [dir: Invoke<typeof scratch, [name: "locks/init.lock"]>, beating: false]
      >,
    ],
    Expect<
      Invoke<
        typeof withLock,
        [
          dir: Invoke<typeof scratch, [name: "locks/init.lock"]>,
          work: Invoke<typeof answering, [answer: "cloned"]>,
          options: { scope: "share"; wait: false },
          pace: { pollMs: 10; beatMs: 40; missed: 10 },
        ]
      >,
      "=",
      "cloned"
    >
  >;
  /** a waiter that found a dead holder's lock, and then stopped (its VM paused) for longer
   *  than a beat's window before it moved it, does not move a new holder's lock: it looks at
   *  what it moved, sees another lock than the one it found dead, and puts it straight back.
   *  The new holder works on undisturbed, and the frozen waiter takes the lock after it.
   *  (Before, it checked first and moved after: it moved the new holder's lock away and
   *  went in beside it.) */
  export type FrozenHeirMovesNothing = Configure<
    { timeout: 20_000 },
    Given<
      Invoke<typeof emptyScratch>,
      Expect<
        Invoke<
          typeof frozenHeir,
          [dir: Invoke<typeof scratch, [name: "locks/frozen.lock"]>, freezeMs: 2500]
        >,
        "=",
        { order: ["second in", "second out", "first in", "first out"]; left: [] }
      >
    >
  >;
  /** a holder on a share beats for as long as its work takes, even work that keeps the
   *  whole process busy: here each holds for a second, more than twice what a stopped beat is given,
   *  half of it without letting its process do anything else, and a second taker waits for
   *  it all the same. No two inside together. */
  export type ShareHeldThroughLongWork = Given<
    Invoke<typeof emptyScratch>,
    Expect<
      Invoke<
        typeof contended,
        [
          dir: Invoke<typeof scratch, [name: "locks/init.lock"]>,
          takers: 2,
          locked: true,
          share: { holdMs: 1000; pace: { pollMs: 10; beatMs: 40; missed: 10 } },
        ]
      >,
      "=",
      { entered: 2; overlapped: false }
    >
  >;
}
