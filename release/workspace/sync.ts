// A domain's branches, written out as data for the root (sections 6.4, 6.5). This runs in the
// domain's own VM, with the domain's trust: it is the domain running git on the domain's
// repository. What it writes to the outbox is a bundle (objects, no config, no hooks), a list
// of refs, and LFS object files. The root reads those as data and never comes here (P4).
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { readJson, writeJson } from "../shared/json.ts";
import { LFS_POINTER_BYTES } from "../shared/limits.ts";
import { BEAT } from "../shared/lock.ts";
import { isBranch, isCommit, parseRepo } from "../shared/names.ts";
import { run, sleep } from "../shared/run.ts";
import { failure, printable } from "../shared/text.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type {
  Expect,
  Given,
  Invoke,
  Mock,
  Throws,
} from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { gitAnswers, scriptedGit } from "../.harness/workspace-git.ts";

export const OUTBOX = "/desolate/outbox";
export const INBOX = "/desolate/inbox";
export const clone = (repo: string) => `/workspaces/${repo}`;
const syncDir = (repo: string) => path.join(OUTBOX, "sync", repo);

// No timer (R4): this is git on the domain's own clone, in its own VM, with no remote peer to
// wait on (a bundle is a local file both ways), and a first bundle of a large repository takes
// as long as it takes. Whoever waits (`desolate offer`, a person) is the one to stop it.
const git = async (repo: string, args: string[], input?: string) => {
  const result = await run("git", ["-C", clone(repo), ...args], {
    input,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return { ok: result.code === 0, out: result.stdout.trim(), err: result.stderr.trim() };
};

export const domainRepos = (): string[] => {
  const out: string[] = [];
  try {
    for (const owner of fs.readdirSync("/workspaces", { withFileTypes: true })) {
      if (!owner.isDirectory() || owner.name.startsWith(".")) continue;
      for (const name of fs.readdirSync(path.join("/workspaces", owner.name), {
        withFileTypes: true,
      }))
        if (
          name.isDirectory() &&
          parseRepo(`${owner.name}/${name.name}`) &&
          fs.existsSync(path.join("/workspaces", owner.name, name.name, ".git"))
        )
          out.push(`${owner.name}/${name.name}`);
    }
  } catch {
    /* no clones yet */
  }
  return out.sort();
};

export const branches = async (repo: string): Promise<Record<string, string>> => {
  const listed = await git(repo, [
    "for-each-ref",
    "--format=%(objectname) %(refname:strip=2)",
    "refs/heads",
  ]);
  const out: Record<string, string> = {};
  for (const line of listed.out.split("\n")) {
    const [commit, ...rest] = line.split(" ");
    const branch = rest.join(" ");
    if (isCommit(commit) && isBranch(branch)) out[branch] = commit;
  }
  return out;
};

declare namespace branches {
  /** what is synced: each branch at its full commit id. The root reads this list as data, so
   *  a ref an agent wrote by hand into .git/refs/heads under a name no branch may have (an
   *  option, a range, a short id) is left out here, before it is ever written down */
  export type OnlyWhatTheRootCarries = Given<
    [
      Mock<"../shared/run.ts", typeof scriptedGit>,
      Invoke<
        typeof gitAnswers,
        [
          answers: [
            [
              "for-each-ref",
              "1111111111111111111111111111111111111111 main\n2222222222222222222222222222222222222222 feature/greet\n1111111111111111111111111111111111111111 --upload-pack=touch x\n1111111111111111111111111111111111111111 a..b\n1111111111111111111111111111111111111111 x.lock\n1111111 short\n",
            ],
          ],
        ]
      >,
    ],
    Expect<
      Invoke<typeof branches, [repo: "acme/app"]>,
      "=",
      {
        main: "1111111111111111111111111111111111111111";
        "feature/greet": "2222222222222222222222222222222222222222";
      }
    >
  >;
  /** a clone git cannot read has no branches, rather than an error */
  export type NoClone = Given<
    [Mock<"../shared/run.ts", typeof scriptedGit>, Invoke<typeof gitAnswers, [answers: []]>],
    Expect<Invoke<typeof branches, [repo: "acme/app"]>, "=", {}>
  >;
}

/** `changed` on each event in the branches of the repository at `dir`: under refs/heads,
 *  each directory below too (a branch feature/x is a file in one), and packed-refs, in its
 *  common git directory (a checkout whose `.git` is a file, a worktree, has its branches
 *  there). Index and HEAD changes (a status, a checkout) move no branch. Answers what stops
 *  it. Throws when it cannot start (no repository, ENOSPC: inotify's limit); `failed`, once,
 *  when it stops later. Measured in a workspace VM (2026-11-23, the share, git in the
 *  devcontainer): git there gives these events; a change made on the Mac does not. */
export const watchRefs = async (
  dir: string,
  changed: () => void,
  failed: (error: Error) => void,
): Promise<() => void> => {
  const named = await run("git", [
    "-C",
    dir,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  if (named.code !== 0) throw new Error(failure(named.stderr, 3, () => null));
  const common = named.stdout.trim();
  const heads = path.join(common, "refs", "heads");
  if (!fs.lstatSync(heads).isDirectory()) throw new Error(`${heads} is not a directory`);
  // Each directory by itself, not node's recursive watch: on Linux that watches each file
  // too, and a ref git replaces (it writes <name>.lock and renames it over the ref) is never
  // heard of again. Seen in T2 (2026-11-23, node 24): a branch's first two moves heard, then
  // none, so the third waited for the minute's look. A directory hears every rename in it.
  const watchers = new Map<string, fs.FSWatcher>();
  let stopped = false;
  const stop = () => {
    stopped = true;
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear();
  };
  const watch = (at: string, wanted: (file: string | null) => boolean) => {
    const watcher = fs.watch(at, (_, file) => wanted(file) && changed());
    watcher.on("error", (error: NodeJS.ErrnoException) => {
      watcher.close();
      watchers.delete(at);
      // A directory gone (refs/heads/feature/, its last branch deleted): it was a change.
      if (error.code === "ENOENT") return changed();
      if (stopped) return;
      stop();
      failed(error);
    });
    watchers.set(at, watcher);
  };
  // refs/heads and each directory below it (a branch feature/x is a file in one; a link is
  // not followed), looked at again on each event there, so that a new one is watched.
  const tree = () => {
    const dirs = new Set([heads]);
    for (const at of dirs)
      try {
        for (const entry of fs.readdirSync(at, { withFileTypes: true }))
          if (entry.isDirectory()) dirs.add(path.join(at, entry.name));
      } catch {
        /* gone meanwhile */
      }
    for (const [at, watcher] of watchers)
      if (at !== common && !dirs.has(at)) {
        watcher.close();
        watchers.delete(at);
      }
    for (const at of dirs)
      if (!watchers.has(at) && !stopped)
        try {
          watch(at, () => {
            try {
              tree();
            } catch (error) {
              stop();
              failed(error as Error);
            }
            return true;
          });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; // gone meanwhile
        }
  };
  try {
    watch(common, (file) => !file || file.startsWith("packed-refs"));
    tree();
  } catch (error) {
    stop();
    throw error;
  }
  return stop;
};

/** Write the domain's branches of one repository to the outbox: an incremental bundle, less
 *  what the mirror has, and the list of refs. */
export const syncRepo = async (repo: string): Promise<{ branches: number; bundled: boolean }> => {
  const dir = syncDir(repo);
  fs.mkdirSync(dir, { recursive: true });
  const refs = await branches(repo);
  const names = Object.keys(refs);
  let bundled = false;
  if (names.length > 0) {
    const file = path.join(dir, `${Date.now().toString(36)}-${process.pid}.bundle`);
    const made = await git(repo, [
      "bundle",
      "create",
      "--quiet",
      `${file}.tmp`,
      ...names.map((name) => `refs/heads/${name}`),
      "--not",
      "--remotes=origin",
    ]);
    if (made.ok) {
      fs.renameSync(`${file}.tmp`, file);
      bundled = true;
    } else {
      fs.rmSync(`${file}.tmp`, { force: true });
      if (!/empty bundle/i.test(made.err))
        throw new Error(`could not bundle ${repo}: ${failure(made.err, 5, () => null)}`);
    }
  }
  writeJson(path.join(dir, "refs.json"), { refs, at: new Date().toISOString() });
  return { branches: names.length, bundled };
};

const POINTER =
  /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:([0-9a-f]{64})\nsize (\d+)\n$/;

/** The LFS objects that `branch`'s commits reference and the mirror does not hold, copied to
 *  the outbox by oid. Pointers are found in every new commit, not only at the tip: the
 *  remote refuses a push that references an object it was never sent. */
export const stageLfs = async (
  repo: string,
  branch: string,
): Promise<{ oid: string; size: number }[]> => {
  const listed = await git(repo, [
    "rev-list",
    "--objects",
    `refs/heads/${branch}`,
    "--not",
    "--remotes=origin",
  ]);
  const ids = listed.out
    .split("\n")
    .map((line) => line.split(" ")[0]!)
    .filter((id) => /^[0-9a-f]{40,64}$/.test(id));
  if (ids.length === 0) return [];
  const sizes = await git(
    repo,
    ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
    ids.join("\n") + "\n",
  );
  const small = sizes.out
    .split("\n")
    .map((line) => line.split(" "))
    .filter(([, type, size]) => type === "blob" && Number(size) < LFS_POINTER_BYTES)
    .map(([id]) => id!);
  const staged: { oid: string; size: number }[] = [];
  const mirror = `/desolate/mirrors/${repo}.git/lfs/objects`;
  for (const id of small) {
    const blob = await git(repo, ["cat-file", "blob", id]);
    const match = POINTER.exec(blob.out + "\n");
    if (!match) continue;
    const [, oid, size] = match as unknown as [string, string, string];
    const where = path.join(oid.slice(0, 2), oid.slice(2, 4), oid);
    if (fs.existsSync(path.join(mirror, where)) || staged.some((s) => s.oid === oid)) continue;
    const local = path.join(clone(repo), ".git", "lfs", "objects", where);
    if (!fs.existsSync(local))
      throw new Error(
        `${branch} references the LFS object ${oid.slice(0, 12)}, which is neither in this clone nor in the mirror`,
      );
    const target = path.join(OUTBOX, "lfs", repo, oid);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(local, target);
    staged.push({ oid, size: Number(size) });
  }
  return staged;
};

declare namespace stageLfs {
  /** a branch with nothing the remote lacks has nothing to stage, and git is not asked more */
  export type NothingNew = Given<
    [
      Mock<"../shared/run.ts", typeof scriptedGit>,
      Invoke<typeof gitAnswers, [answers: [["rev-list", ""]]]>,
    ],
    Expect<Invoke<typeof stageLfs, [repo: "acme/app", branch: "main"]>, "=", []>
  >;
  /** only a small blob can be a pointer: a large one is never read, and a small one that is not
   *  a pointer is an ordinary file */
  export type OrdinaryFiles = Given<
    [
      Mock<"../shared/run.ts", typeof scriptedGit>,
      Invoke<
        typeof gitAnswers,
        [
          answers: [
            [
              "rev-list",
              "1111111111111111111111111111111111111111\naaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa README.md\nbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb big.bin\n",
            ],
            [
              "cat-file --batch-check",
              "1111111111111111111111111111111111111111 commit 200\naaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa blob 120\nbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb blob 5000\n",
            ],
            ["cat-file blob aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "# app\nA small file.\n"],
          ],
        ]
      >,
    ],
    Expect<Invoke<typeof stageLfs, [repo: "acme/app", branch: "main"]>, "=", []>
  >;
  /** a pointer is exactly git-lfs's three lines: another spec, an id that is not sha256 hex
   *  in lower case, or a line more is a file that happens to look like one */
  export type NotQuitePointers = Given<
    [
      Mock<"../shared/run.ts", typeof scriptedGit>,
      Invoke<
        typeof gitAnswers,
        [
          answers: [
            [
              "rev-list",
              "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa a\nbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb b\ndddddddddddddddddddddddddddddddddddddddd d\n",
            ],
            [
              "cat-file --batch-check",
              "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa blob 130\nbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb blob 130\ndddddddddddddddddddddddddddddddddddddddd blob 140\n",
            ],
            [
              "cat-file blob aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              "version https://git-lfs.github.com/spec/v2\noid sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\nsize 12\n",
            ],
            [
              "cat-file blob bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              "version https://git-lfs.github.com/spec/v1\noid sha256:0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF\nsize 12\n",
            ],
            [
              "cat-file blob dddddddddddddddddddddddddddddddddddddddd",
              "version https://git-lfs.github.com/spec/v1\noid sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\nsize 12\nx-extra 1\n",
            ],
          ],
        ]
      >,
    ],
    Expect<Invoke<typeof stageLfs, [repo: "acme/app", branch: "main"]>, "=", []>
  >;
  /** a pointer to an object that neither this clone nor the mirror holds stops the offer: the
   *  remote would refuse a push that names an object it was never sent */
  export type MissingObject = Given<
    [
      Mock<"../shared/run.ts", typeof scriptedGit>,
      Invoke<
        typeof gitAnswers,
        [
          answers: [
            ["rev-list", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa data/model.bin\n"],
            ["cat-file --batch-check", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa blob 130\n"],
            [
              "cat-file blob aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              "version https://git-lfs.github.com/spec/v1\noid sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\nsize 12\n",
            ],
          ],
        ]
      >,
    ],
    Throws<
      Invoke<typeof stageLfs, [repo: "acme/app", branch: "main"]>,
      "main references the LFS object 0123456789ab, which is neither in this clone nor in the mirror"
    >
  >;
}

/** Deliveries from the root (section 6.4): bundles in the inbox, imported as `root/<branch>`,
 *  never over a branch of the domain's own. */
export const importDeliveries = async (repo: string): Promise<string[]> => {
  const dir = path.join(INBOX, "deliveries", repo);
  const record = readJson<unknown>(path.join(clone(repo), ".git", "desolate-delivered.json"), []);
  const done = Array.isArray(record) ? record.filter((id) => typeof id === "string") : [];
  const imported: string[] = [];
  let names: string[] = [];
  try {
    names = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .sort();
  } catch {
    return [];
  }
  // What was imported is remembered only while the root still has it in the inbox: so the
  // record is never longer than the inbox's own list, and needs no cut (one at 500 would
  // import an older delivery again, moving root/<branch> back).
  const present = new Set(names.map((name) => name.slice(0, -5)));
  const kept = done.filter((id) => present.has(id));
  for (const name of names) {
    const id = name.slice(0, -5);
    if (kept.includes(id)) continue;
    const meta = readJson<{ branch?: string; commit?: string; bundle?: boolean } | null>(
      path.join(dir, name),
      null,
    );
    if (!meta || !isBranch(meta.branch) || !isCommit(meta.commit)) continue;
    if (meta.bundle !== false) {
      await git(repo, [
        "fetch",
        "--quiet",
        "--no-tags",
        path.join(dir, `${id}.bundle`),
        "+refs/heads/*:refs/desolate/delivery/*",
      ]);
      const scratch = await git(repo, [
        "for-each-ref",
        "--format=%(refname)",
        "refs/desolate/delivery/",
      ]);
      for (const ref of scratch.out.split("\n").filter(Boolean))
        await git(repo, ["update-ref", "-d", ref]);
    }
    // As root/<branch>: never over a branch of the domain's own.
    if (
      (await git(repo, ["cat-file", "-e", `${meta.commit}^{commit}`])).ok &&
      (await git(repo, ["update-ref", `refs/remotes/root/${meta.branch}`, meta.commit])).ok
    )
      imported.push(meta.branch);
    kept.push(id);
  }
  if (imported.length > 0 || kept.length !== done.length)
    writeJson(path.join(clone(repo), ".git", "desolate-delivered.json"), kept);
  return imported;
};

// THE REQUEST CHANNEL (section 6.4): a fixed vocabulary, written to the outbox as
// `requests/<id>.json`; the root answers in the inbox, which the domain cannot write. Between
// the two, the root says it is there, and what it is doing (rootd.ts writes them):
//
//   inbox/rootd.beat           `<boot> <count>`: rewritten every BEAT.beatMs, by a thread of
//                              rootd's own, for as long as it runs, whatever its work is
//   inbox/replies/<id>.taken   `{ boot, doing }`: the root took this request and is on it
//   inbox/replies/<id>.json    the answer
//
// So the wait has no deadline (R4). It lasts while the root is alive and on the request, which
// can be minutes (the first fetch of a large repository, a push's offer of a large branch), and
// ends when whoever asked stops waiting. What else ends it is the root being gone, said as
// such: its beat stopped (BEAT's 10 s of nothing: the root is on the same Mac, and a thread
// that does nothing but write a small file is never that late), before it took the request
// or after; or a beat from another start of rootd than the one that took it.
//
// No beat file at all is a root that has never beaten for this domain: not running. It is
// watched as a beat that does not move. (A root from before the beat, which got the old wait
// of 2 minutes, is not in a current install: the root's services are started again when
// their code changes, at every `desolate bootstrap`, which is how desolate is updated; and
// rootd writes every domain's beat in its first quarter second.)

const BEAT_FILE = path.join(INBOX, "rootd.beat");
/** How often a waiter looks: three small reads. */
const POLL_MS = 150;
/** How often a long wait says again what the root is doing, when that has not changed. */
const RETELL_MS = 60_000;

/** What a waiter remembers of the root's beat: the last one read, and when (by its own
 *  clock) that changed and it last looked. */
export type Watched = { beat: string; changed: number; looked: number };

/** Has the root's beat stopped? Read as lock.ts reads a share lock's (BEAT): it has when the
 *  waiter has watched `missed` beats' time go by with no new one, by its own clock, which runs
 *  while it watches; so the VMs' clocks need not agree. A waiter that did not look for half
 *  that time (its own VM paused, the Mac asleep) watches again from then: a root paused with
 *  it is given the whole window once both run. */
export const watchBeat = (
  seen: Watched | null,
  beat: string,
  now: number,
  pace: { beatMs: number; missed: number } = BEAT,
): { seen: Watched; stopped: boolean } => {
  const window = pace.beatMs * pace.missed;
  if (!seen || beat !== seen.beat || now - seen.looked > window / 2)
    return { seen: { beat, changed: now, looked: now }, stopped: false };
  return { seen: { ...seen, looked: now }, stopped: now - seen.changed >= window };
};

declare namespace watchBeat {
  /** a beat that moves is a root that is there; one that has not moved for 10 s, watched all
   *  the while, is a root that is gone */
  export type Beats = [
    Expect<
      Invoke<
        typeof watchBeat,
        [seen: { beat: "b0 4"; changed: 0; looked: 9000 }, beat: "b0 5", now: 9150]
      >,
      "=",
      { seen: { beat: "b0 5"; changed: 9150; looked: 9150 }; stopped: false }
    >,
    Expect<
      Invoke<
        typeof watchBeat,
        [seen: { beat: "b0 4"; changed: 0; looked: 9000 }, beat: "b0 4", now: 9150]
      >,
      "=",
      { seen: { beat: "b0 4"; changed: 0; looked: 9150 }; stopped: false }
    >,
    Expect<
      Invoke<
        typeof watchBeat,
        [seen: { beat: "b0 4"; changed: 0; looked: 9900 }, beat: "b0 4", now: 10000]
      >,
      "=",
      { seen: { beat: "b0 4"; changed: 0; looked: 10000 }; stopped: true }
    >,
  ];
  /** silence counts only while it was watched: a waiter that did not look for 6 s (its VM
   *  paused) starts watching again, and does not take the root for gone */
  export type PausedWatcher = Expect<
    Invoke<
      typeof watchBeat,
      [seen: { beat: "b0 4"; changed: 0; looked: 4000 }, beat: "b0 4", now: 10000]
    >,
    "=",
    { seen: { beat: "b0 4"; changed: 10000; looked: 10000 }; stopped: false }
  >;
  /** no beat file ever ("") is a beat that does not move: a root not running, gone after 10 s
   *  watched (the control: the same 10 s with a beat that moved, Beats above) */
  export type NoBeat = Expect<
    Invoke<typeof watchBeat, [seen: { beat: ""; changed: 0; looked: 9900 }, beat: "", now: 10000]>,
    "=",
    { seen: { beat: ""; changed: 0; looked: 10000 }; stopped: true }
  >;
  /** the first look starts the watch */
  export type First = Expect<
    Invoke<typeof watchBeat, [seen: null, beat: "b0 4", now: 500]>,
    "=",
    { seen: { beat: "b0 4"; changed: 500; looked: 500 }; stopped: false }
  >;
}

/** What a waiter has seen of its request at one look. */
export type Look = {
  reply: Record<string, unknown> | null;
  /** The request is still in the outbox: the root has not taken it. */
  asked: boolean;
  taken: { boot?: unknown; doing?: unknown } | null;
  /** The beat's text ("" while there has never been one). */
  beat: string;
  /** The beat has stopped, as watchBeat says. */
  stopped: boolean;
  /** How long it has waited, and how long the request has been neither in the outbox nor
   *  taken (between the two, for a moment, as the root takes it). */
  waited: number;
  lost: number;
};

/** What a waiter does after a look: wait on (and what the root is doing, to say so in a long
 *  wait); withdraw the request and answer, if it is still there to withdraw (else the root
 *  took it at the last moment, and the wait goes on); or answer. */
export type Verdict =
  { wait: string } | { withdraw: Record<string, unknown> } | { answer: Record<string, unknown> };

export const verdict = (look: Look, window = BEAT.beatMs * BEAT.missed): Verdict => {
  if (look.reply) return { answer: look.reply };
  const quiet = `${window / 1000} s`;
  if (look.stopped)
    return look.asked
      ? {
          withdraw: {
            ok: false,
            error: `nothing has been heard from the root for ${quiet}: it is not running, or its VM is stopped (the request was withdrawn)`,
            fix: "on the host: desolate doctor",
          },
        }
      : {
          answer: {
            ok: false,
            error: `the root took it, then nothing was heard from it for ${quiet}: it stopped, or its VM did, and whether it was done is not known`,
            fix: "on the host: desolate doctor; then ask again",
          },
        };
  if (look.asked)
    return {
      wait: "the root has not taken it yet (it takes each domain's requests in turn)",
    };
  const boot = look.beat.split(" ")[0];
  if (look.taken ? look.taken.boot !== boot : look.lost >= window)
    return {
      answer: {
        ok: false,
        error:
          "the root restarted while it was working on it, and whether it was done is not known",
        fix: "ask again",
      },
    };
  return {
    wait: typeof look.taken?.doing === "string" ? look.taken.doing : "the root has taken it",
  };
};

declare namespace verdict {
  /** the answer, whenever it is there */
  export type Answered = Expect<
    Invoke<
      typeof verdict,
      [
        look: {
          reply: { ok: true };
          asked: false;
          taken: null;
          beat: "b0 9";
          stopped: true;
          waited: 600000;
          lost: 0;
        },
      ]
    >,
    "=",
    { answer: { ok: true } }
  >;
  /** a root that is there and on it is waited on, however long it takes, and says what it is
   *  doing; one that has not taken it yet is waited on too */
  export type Waits = [
    Expect<
      Invoke<
        typeof verdict,
        [
          look: {
            reply: null;
            asked: false;
            taken: { boot: "b0"; doing: "fetching acme/app with the read key" };
            beat: "b0 120";
            stopped: false;
            waited: 240000;
            lost: 0;
          },
        ]
      >,
      "=",
      { wait: "fetching acme/app with the read key" }
    >,
    Expect<
      Invoke<
        typeof verdict,
        [
          look: {
            reply: null;
            asked: true;
            taken: null;
            beat: "b0 7";
            stopped: false;
            waited: 30000;
            lost: 0;
          },
        ]
      >,
      "=",
      { wait: "the root has not taken it yet (it takes each domain's requests in turn)" }
    >,
    Expect<
      Invoke<
        typeof verdict,
        [
          look: {
            reply: null;
            asked: false;
            taken: null;
            beat: "b0 7";
            stopped: false;
            waited: 400;
            lost: 150;
          },
        ]
      >,
      "=",
      { wait: "the root has taken it" }
    >,
  ];
  /** a root that is gone is said to be, in 10 s: before it took the request (which is then
   *  withdrawn, so it is not done later unasked), or after */
  export type Gone = [
    Expect<
      Invoke<
        typeof verdict,
        [
          look: {
            reply: null;
            asked: true;
            taken: null;
            beat: "b0 7";
            stopped: true;
            waited: 10000;
            lost: 0;
          },
        ]
      >,
      "=",
      {
        withdraw: {
          ok: false;
          error: "nothing has been heard from the root for 10 s: it is not running, or its VM is stopped (the request was withdrawn)";
          fix: "on the host: desolate doctor";
        };
      }
    >,
    Expect<
      Invoke<
        typeof verdict,
        [
          look: {
            reply: null;
            asked: false;
            taken: { boot: "b0"; doing: "fetching acme/app with the read key" };
            beat: "b0 7";
            stopped: true;
            waited: 90000;
            lost: 0;
          },
        ]
      >,
      "=",
      {
        answer: {
          ok: false;
          error: "the root took it, then nothing was heard from it for 10 s: it stopped, or its VM did, and whether it was done is not known";
          fix: "on the host: desolate doctor; then ask again";
        };
      }
    >,
  ];
  /** a root that started again has no memory of what the one before took: said, not waited
   *  on forever (its beat is another start's, or the request is neither waiting nor taken) */
  export type Restarted = [
    Expect<
      Invoke<
        typeof verdict,
        [
          look: {
            reply: null;
            asked: false;
            taken: { boot: "b0"; doing: "x" };
            beat: "b1 2";
            stopped: false;
            waited: 30000;
            lost: 0;
          },
        ]
      >,
      "matches",
      {
        answer: {
          error: "the root restarted while it was working on it, and whether it was done is not known";
        };
      }
    >,
    Expect<
      Invoke<
        typeof verdict,
        [
          look: {
            reply: null;
            asked: false;
            taken: null;
            beat: "b1 9";
            stopped: false;
            waited: 30000;
            lost: 10000;
          },
        ]
      >,
      "matches",
      {
        answer: {
          error: "the root restarted while it was working on it, and whether it was done is not known";
        };
      }
    >,
  ];
}

/** The beat's text, or null when there is no beat file (or none could be read just now). */
const readBeat = (): string | null => {
  try {
    return fs.readFileSync(BEAT_FILE, "utf8").trim();
  } catch {
    return null;
  }
};

/** Ask the root, and wait for its answer for as long as it is there and on it (see above).
 *  A wait longer than the beat's window says, on stderr, what the root is doing; one that
 *  is answered sooner says nothing. */
export const request = async (
  body: Record<string, unknown>,
  tell: (line: string) => void = (line) => process.stderr.write(`desolate: ${line}\n`),
): Promise<Record<string, unknown>> => {
  const id = `${Date.now().toString(36)}-${createHash("sha256").update(`${process.pid}${Math.random()}`).digest("hex").slice(0, 10)}`;
  const dir = path.join(OUTBOX, "requests");
  fs.mkdirSync(dir, { recursive: true });
  const asked = path.join(dir, `${id}.json`);
  writeJson(asked, body);
  const replies = path.join(INBOX, "replies");
  const window = BEAT.beatMs * BEAT.missed;
  const started = performance.now();
  // Once a beat has been read, a beat file that cannot be read is the same beat: one that
  // does not move. None ever read is "", which does not move either (above).
  let heard = "";
  let seen: Watched | null = null;
  let lostSince: number | null = null;
  let said = "";
  let saidAt = 0;
  for (; ; await sleep(POLL_MS)) {
    const now = performance.now();
    // In this order: the root takes the request, then writes `.taken`, then the reply, then
    // removes `.taken`; a look between two of those reads at worst nothing for a moment.
    const reply = readJson<Record<string, unknown> | null>(path.join(replies, `${id}.json`), null);
    const waiting = fs.existsSync(asked);
    const taken = readJson<{ boot?: unknown; doing?: unknown } | null>(
      path.join(replies, `${id}.taken`),
      null,
    );
    heard = readBeat() ?? heard;
    const watched = watchBeat(seen, heard, now);
    seen = watched.seen;
    lostSince = reply || waiting || taken ? null : (lostSince ?? now);
    const next = verdict(
      {
        reply,
        asked: waiting,
        taken,
        beat: heard,
        stopped: watched.stopped,
        waited: now - started,
        lost: now - (lostSince ?? now),
      },
      window,
    );
    if ("answer" in next) {
      fs.rmSync(asked, { force: true });
      return next.answer;
    }
    if ("withdraw" in next) {
      try {
        fs.rmSync(asked);
        return next.withdraw;
      } catch (error) {
        // Gone already: the root took it at the last moment, and the wait goes on.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return next.withdraw;
        continue;
      }
    }
    if (now - started >= window && (next.wait !== said || now - saidAt >= RETELL_MS)) {
      tell(`${printable(next.wait)} (${Math.round((now - started) / 1000)} s so far)`);
      said = next.wait;
      saidAt = now;
    }
  }
};
