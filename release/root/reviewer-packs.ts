// The reviewer's pack store (reviewer.ts): the pack a push sends is made HERE, of objects
// whose ids are their content, and kept: the approval names its sha256 (shared/approval.ts,
// put in by the host from the reviewer's account), and the pusher forwards only a pack that
// hashes to it. The root's user carries it, and can add nothing to it. Before this, the
// root's user made the pack itself, and could have put in any object it liked, uploaded to
// the forge under the write key beside an approved push (#165).
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FORGE, LFS_POINTER_BYTES, over } from "../shared/limits.ts";
import type { Repo } from "../shared/names.ts";
import { lfsDigest } from "../shared/approval.ts";
import type { Sends } from "../shared/review-account.ts";
import { startOf } from "../shared/lock.ts";
import { define, mebibytes, valueOf, whole } from "../shared/settings.ts";
import { atomically, env, gitBytes, gitOk, hardened, POINTER, shown } from "./reviewer-git.ts";
import { REVIEWER } from "./layout.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Table } from "../../suede.nests/dsl.import.meta.vitest.ts";

const MiB = 1024 * 1024;

// How hard the reviewer packs. pack-objects runs twice for an account (the push as it is,
// and squashed), recompressing every object (below), in the root VM, whose memory and
// cores are every domain's keyring and pusher too: what it may use depends on that VM's
// size, so each is a setting, worked out from the VM where it can be (R6).
export const PACK_WINDOW = define({
  name: "reviewer.packWindowMiB",
  env: "DESOLATE_REVIEWER_PACK_WINDOW_MIB",
  side: "root",
  default: 256,
  parse: mebibytes(16, 65536),
  why: "Memory each of the reviewer's packing threads may use to compare files while it packs a push for you to approve (git's pack.windowMemory): more can make a large push's pack smaller.",
});
export const PACK_THREADS = define({
  name: "reviewer.packThreads",
  env: "DESOLATE_REVIEWER_PACK_THREADS",
  side: "root",
  // A quarter of the root VM's memory for packing, at one window per thread, and no more
  // threads than it has cores: on the 2 GiB root VM this is the 2 it always was.
  default: () =>
    Math.max(
      1,
      Math.min(
        os.availableParallelism(),
        Math.floor(os.totalmem() / 4 / (valueOf(PACK_WINDOW) * MiB)),
      ),
    ),
  parse: whole(1, 256),
  why: "How many threads the reviewer packs a push with (git's pack.threads): more is faster, and each uses its own reviewer.packWindowMiB. Unset, the root VM's CPUs, at most as many as a quarter of its memory holds windows for.",
});
export const PACK_BIG_FILE = define({
  name: "reviewer.bigFileMiB",
  env: "DESOLATE_REVIEWER_BIG_FILE_MIB",
  side: "root",
  default: 64,
  parse: mebibytes(1, 65536),
  why: "The size from which the reviewer packs a file as it is, without comparing it to others (git's core.bigFileThreshold): higher can pack large files smaller, holding each whole in memory.",
});
export const KEPT_PACKS = define({
  name: "reviewer.keptPacksMiB",
  env: "DESOLATE_REVIEWER_KEPT_PACKS_MIB",
  side: "root",
  // A quarter of the disk the reviewer's home is on (the root VM's), and at least one pack
  // as large as a push may be.
  default: () => {
    try {
      const disk = fs.statfsSync(REVIEWER.home);
      return Math.max(FORGE.packBytes / MiB, Math.floor((disk.blocks * disk.bsize) / 4 / MiB));
    } catch {
      return 8192;
    }
  },
  parse: mebibytes(FORGE.packBytes / MiB, 1024 * 1024 * 1024),
  why: "How much disk the packs the reviewer made of pushes may take in all (the pack you approve is the one pushed): past it, the oldest go first, never one a review still kept names. Unset, a quarter of the root VM's disk.",
});
/** What a reviewer started for the host is told of these: they are read in its process,
 *  which root starts with an environment of nothing else (review-ask.ts). */
export const SETTINGS = [PACK_WINDOW, PACK_THREADS, PACK_BIG_FILE, KEPT_PACKS];

// Each pack is kept by its own sha256 (<sha>.pack, and <sha>.json: its size and LFS ids), and
// a push asks for the one its approval names, by that sha256: two accounts at once, or one
// made again later, make packs of their own, and never replace one an approval names (the
// independent review of #165's fix: a pack kept by push, replaced, would have failed an
// approved push). A push's own record (<commit>-<onto>-<known>.json) says which pack was made
// for it last, so an account asked again soon gives the same one.
export const PACKS = { freshMs: 10 * 60_000, keptMs: 60 * 60_000 } as const;
const packsDir = (repo: Repo) => path.join(REVIEWER.home, "packs", repo.owner, repo.name);
// (With the remote's branches it was made against: a branch deleted since, and a pack made
// before would lack what that branch had, refused by the forge until the ten minutes passed.)
const packKey = (commit: string, onto: string | null, known: string[]) =>
  `${commit}-${onto ?? "none"}-${createHash("sha256")
    .update([...known].sort().join("\n"))
    .digest("hex")
    .slice(0, 16)}`;
const SHA256 = /^[0-9a-f]{64}$/;

/** What pack-objects says it is doing (`--progress`, on stderr: "Compressing objects:  40%
 *  (1200/3000)"), as a phase and how far: null for a line that is not progress. */
export const packProgress = (
  line: string,
): { phase: string; done?: number; of?: number } | null => {
  const said = /^([A-Z][a-z]+(?: [a-z]+)*):\s+(?:\d+%\s+\((\d+)\/(\d+)\)|(\d+))/.exec(line.trim());
  if (!said) return null;
  const phase = `packing: ${said[1]!.toLowerCase()}`;
  return said[2] !== undefined
    ? { phase, done: Number(said[2]), of: Number(said[3]) }
    : { phase, done: Number(said[4]) };
};

declare namespace packProgress {
  /** git's own words for its phases, with how many of how many */
  export type Reads = Table<
    typeof packProgress,
    [
      [
        args: [line: "Compressing objects:  40% (1200/3000)"],
        expected: { phase: "packing: compressing objects"; done: 1200; of: 3000 },
      ],
      [
        args: [line: "Enumerating objects: 52, done."],
        expected: { phase: "packing: enumerating objects"; done: 52 },
      ],
      /** what is not progress is git saying something else: kept for the error */
      [args: [line: "fatal: bad object 1234"], expected: null],
    ]
  >;
}

export type Say = (progress: { phase: string; done?: number; of?: number }) => void;

/** The pack for pushing `tip` onto `onto`: of the objects `tip` has that the remote's branches
 *  (`known`) do not, kept with its sha256 and LFS ids. Asked again within ten minutes, the
 *  same pack; after, a new one (the remote may have moved on). `say` is told how the packing
 *  goes, as git says it. */
export const prepare = async (
  repo: Repo,
  dir: string,
  tip: string,
  onto: string | null,
  known: string[],
  say: Say,
): Promise<Sends> => {
  const where = packsDir(repo);
  fs.mkdirSync(where, { recursive: true, mode: 0o700 });
  const record = path.join(where, `${packKey(tip, onto, known)}.json`);
  try {
    const last = JSON.parse(fs.readFileSync(record, "utf8")) as { pack?: unknown; at?: unknown };
    const kept = typeof last.pack === "string" ? storedPack(repo, last.pack) : null;
    if (kept && Number.isFinite(last.at) && Date.now() - (last.at as number) < PACKS.freshMs) {
      touchPack(repo, kept.sends.pack);
      return sendsOf(kept.sends);
    }
  } catch {
    /* none yet */
  }
  // Named for its maker, as `incoming-<pid>-<start>-<random>`: it is pruned when that process
  // is gone, never for its age (a large push counts its objects for an hour before git writes
  // a byte of it).
  const temporary = path.join(
    where,
    `incoming-${process.pid}-${startOf(process.pid) ?? "0"}-${randomBytes(8).toString("hex")}`,
  );
  const out = fs.openSync(temporary, "w", 0o600);
  const hash = createHash("sha256");
  let size = 0;
  const packed = await new Promise<{ code: number; said: string }>((resolve) => {
    const child = spawn(
      "git",
      [
        "--git-dir",
        dir,
        ...hardened(dir),
        "-c",
        `pack.threads=${valueOf(PACK_THREADS)}`,
        "-c",
        `pack.windowMemory=${valueOf(PACK_WINDOW)}m`,
        "-c",
        `core.bigFileThreshold=${valueOf(PACK_BIG_FILE)}m`,
        "pack-objects",
        "--stdout",
        "--revs",
        // Every object compressed and deltified here, not copied as it arrived: the bytes of a
        // compressed object are not the object (zlib's choices, a delta's form), and copied, the
        // root's user's own would ride along to the forge inside an approved pack (the second
        // independent review of #165's fix, shown with git 2.39: a crafted stream was in the
        // forge's pack byte for byte).
        "--no-reuse-object",
        "--delta-base-offset",
        "--progress",
      ],
      { env: env({ GIT_DIR: dir }), stdio: ["pipe", "pipe", "pipe"] },
    );
    // Its progress is said as it comes (at most once a second, and at each new phase); what
    // else it says is kept for the error, its end.
    let said = "";
    let partial = "";
    let last = { phase: "", at: 0 };
    child.stderr.on("data", (chunk: Buffer) => {
      const parts = (partial + chunk.toString()).split(/[\r\n]/);
      partial = (parts.pop() ?? "").slice(-4000);
      for (const part of parts) {
        const progress = packProgress(part);
        if (!progress) {
          if (part.trim()) said = `${said}${part}\n`.slice(-4000);
          continue;
        }
        if (progress.phase === last.phase && Date.now() - last.at < 1000) continue;
        last = { phase: progress.phase, at: Date.now() };
        say(progress);
      }
    });
    child.stdout.on("data", (chunk: Buffer) => {
      hash.update(chunk);
      size += chunk.length;
      // As large as the forge takes, and no larger (the pusher checks the same bound).
      if (size > FORGE.packBytes) child.kill("SIGKILL");
      else fs.writeSync(out, chunk);
    });
    child.on("error", (error) => resolve({ code: 1, said: error.message }));
    child.stdin.on("error", () => {});
    child.on("close", (code) => resolve({ code: code ?? 1, said: said + partial }));
    child.stdin.end([tip, ...known.map((id) => `^${id}`), ""].join("\n"));
  });
  fs.closeSync(out);
  if (size > FORGE.packBytes) {
    fs.rmSync(temporary, { force: true });
    throw new Error(
      `${over("the push's pack", FORGE.packBytes, size, "bytes", "a push to the forge may carry")} (it was stopped there)`,
    );
  }
  if (packed.code !== 0) {
    fs.rmSync(temporary, { force: true });
    throw new Error(
      `cannot pack the push: ${shown(packed.said.trim().split("\n").slice(-1)[0] ?? "", 300)}`,
    );
  }
  say({ phase: "listing the push's LFS objects" });
  const made: Packed = { pack: hash.digest("hex"), size, lfs: await pointersIn(dir, tip, known) };
  // Its own name is its digest: the same bytes made twice are the same file.
  fs.renameSync(temporary, path.join(where, `${made.pack}.pack`));
  atomically(path.join(where, `${made.pack}.json`), JSON.stringify({ size, lfs: made.lfs }));
  atomically(record, JSON.stringify({ pack: made.pack, at: Date.now() }));
  return sendsOf(made);
};

/** A kept pack as the pusher is given it: its LFS objects listed whole, `<oid> <size>`. */
type Packed = { pack: string; size: number; lfs: string[] };
/** As the account says it: the list's count, bytes and digest, as the person signs them
 *  (shared/approval.ts, signedFor) and the pusher checks them, over the very list it is given. */
export const sendsOf = ({ pack, size, lfs }: Packed): Sends => {
  const each = [...new Set(lfs)];
  return {
    pack,
    size,
    lfs: {
      count: each.length,
      bytes: each.reduce((n, entry) => n + Number(entry.split(" ")[1] || 0), 0),
      digest: lfsDigest(each),
    },
  };
};

declare namespace sendsOf {
  /** each object once, by the size its pointer says; the digest is the signed one's */
  export type Counts = Table<
    typeof sendsOf,
    [
      [
        args: [packed: { pack: "p"; size: 9; lfs: [] }],
        expected: {
          pack: "p";
          size: 9;
          lfs: {
            count: 0;
            bytes: 0;
            digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
          };
        },
      ],
      [
        args: [
          packed: {
            pack: "p";
            size: 9;
            lfs: [
              "1111111111111111111111111111111111111111111111111111111111111111 40",
              "2222222222222222222222222222222222222222222222222222222222222222 2",
              "1111111111111111111111111111111111111111111111111111111111111111 40",
            ];
          },
        ],
        expected: {
          pack: "p";
          size: 9;
          lfs: {
            count: 2;
            bytes: 42;
            digest: "b516fe65100db0c19dca6e1e426a22ffa6dcd68d9979e0d195a7a8a67c66c1af";
          };
        },
      ],
    ]
  >;
}

/** The kept pack with this sha256, if there is one: its file, and what it sends. */
export const storedPack = (repo: Repo, pack: string): { file: string; sends: Packed } | null => {
  if (!SHA256.test(pack)) return null;
  try {
    const where = packsDir(repo);
    const file = path.join(where, `${pack}.pack`);
    const kept = JSON.parse(fs.readFileSync(path.join(where, `${pack}.json`), "utf8")) as {
      size?: unknown;
      lfs?: unknown;
    };
    if (!Number.isInteger(kept.size) || !Array.isArray(kept.lfs) || !fs.existsSync(file))
      return null;
    return { file, sends: { pack, size: kept.size as number, lfs: kept.lfs as string[] } };
  } catch {
    return null;
  }
};

/** A kept pack an account was just given again: its hour starts again. */
export const touchPack = (repo: Repo, pack: string) => {
  if (!SHA256.test(pack)) return;
  const now = new Date();
  for (const name of [`${pack}.pack`, `${pack}.json`])
    try {
      fs.utimesSync(path.join(packsDir(repo), name), now, now);
    } catch {
      /* gone: the account is made again */
    }
};

/** What is kept goes an hour after it was last named (an approval lasts two minutes, a push
 *  half an hour), and past the kept packs' size in all (KEPT_PACKS) the oldest go first: a
 *  root's user that asks for accounts of many pushes fills no disk. A pack in `live` (one an
 *  account that is still kept names) is never the one evicted for size. When the reviewer
 *  starts, and before each account is made. */
export const prunePacks = (live: Set<string>) => {
  const root = path.join(REVIEWER.home, "packs");
  const dirs = (dir: string) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
    } catch {
      return [];
    }
  };
  const all: { file: string; at: number; size: number; making?: boolean }[] = [];
  for (const owner of dirs(root))
    for (const name of dirs(path.join(root, owner.name))) {
      const where = path.join(root, owner.name, name.name);
      for (const entry of fs.readdirSync(where)) {
        const file = path.join(where, entry);
        // (One an account renames as this looks is gone: nothing to do.)
        const stat = fs.statSync(file, { throwIfNoEntry: false });
        if (!stat) continue;
        if (entry.startsWith("incoming-")) {
          // A pack being made: its maker's, until that process is gone.
          const [, pid, start] = entry.split("-");
          if (startOf(Number(pid)) !== start) fs.rmSync(file, { force: true });
          else all.push({ file, at: stat.mtimeMs, size: stat.size, making: true });
          continue;
        }
        if (Date.now() - stat.mtimeMs > PACKS.keptMs) fs.rmSync(file, { force: true });
        else if (entry.endsWith(".pack")) all.push({ file, at: stat.mtimeMs, size: stat.size });
      }
    }
  let total = all.reduce((n, p) => n + p.size, 0);
  const most = valueOf(KEPT_PACKS) * MiB;
  for (const pack of all.sort((a, b) => a.at - b.at)) {
    if (total <= most) break;
    if (pack.making || live.has(path.basename(pack.file, ".pack"))) continue;
    fs.rmSync(pack.file, { force: true });
    fs.rmSync(pack.file.replace(/\.pack$/, ".json"), { force: true });
    total -= pack.size;
  }
};

/** How many blobs are read at once for their content: each answer is held whole (gitBytes
 *  stops at 64 MiB), and 20,000 blobs under LFS_POINTER_BYTES are under 21 MiB (the
 *  independent review of #169: 250,000 small blobs in one push went over, and the push
 *  could not be approved at all). */
const BLOBS_AT_ONCE = 20_000;

/** The LFS objects a pack's commits point to: each blob in it that is a pointer (git-lfs's
 *  own form: a version line, the oid, the size, nothing else), as `<oid> <size>`. */
const pointersIn = async (dir: string, tip: string, known: string[]): Promise<string[]> => {
  const listed = await gitOk(dir, [
    "rev-list",
    "--objects",
    "--no-object-names",
    tip,
    ...known.map((id) => `^${id}`),
  ]);
  const ids = listed.split("\n").filter((id) => /^[0-9a-f]{40}$/.test(id));
  if (ids.length === 0) return [];
  const sizes = await gitOk(
    dir,
    ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
    { input: ids.join("\n") + "\n" },
  );
  const small = sizes
    .split("\n")
    .map((line) => line.split(" "))
    .filter(([, type, size]) => type === "blob" && Number(size) < LFS_POINTER_BYTES)
    .map(([id]) => id!);
  if (small.length === 0) return [];
  const oids = new Set<string>();
  for (let from = 0; from < small.length; from += BLOBS_AT_ONCE)
    readPointers(
      await gitBytes(
        dir,
        ["cat-file", "--batch"],
        small.slice(from, from + BLOBS_AT_ONCE).join("\n") + "\n",
      ),
      oids,
    );
  return [...oids].sort();
};
const readPointers = (bytes: Buffer | null, oids: Set<string>) => {
  if (!bytes) throw new Error("git cat-file failed on the push's own blobs");
  // Each: "<id> blob <size>\n", the content, "\n".
  for (let at = 0; at < bytes.length;) {
    const end = bytes.indexOf(10, at);
    if (end < 0) break;
    const size = Number(bytes.subarray(at, end).toString("latin1").split(" ")[2]);
    const content = bytes.subarray(end + 1, end + 1 + size).toString("utf8");
    // By its oid AND the size its pointer says: the pusher sends an object only of that size
    // (the third independent review: a pointer saying 12 bytes could carry gigabytes).
    const match = POINTER.exec(content);
    // Over the forge's largest, the pusher takes none (pusher.ts): said, not left out, or the
    // remote would get the pointer without its object.
    if (match && Number(match[2]) > FORGE.lfsObjectBytes)
      throw new Error(
        over(
          "the object an LFS pointer names",
          FORGE.lfsObjectBytes,
          Number(match[2]),
          "bytes",
          "the forge stores of one",
        ),
      );
    if (match) oids.add(`${match[1]} ${Number(match[2])}`);
    at = end + 1 + size + 1;
  }
};
