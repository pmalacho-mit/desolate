// The reviewer: what a push would send, worked out by a user that is not the root's own
// (desolate-reviewer), for the approval page (host/approve-web.ts).
//
// WHY ANOTHER USER. The root's user chooses which commit to ask a person to approve, and it
// is the user that parses everything domains send. If one of those parsers (an outbox's
// JSON, the dashboard's state, a proxy) handed it to an attacker, a summary written by that
// user would say whatever the attacker liked. The reviewer is told only commit ids by
// anyone it believes: the host asks it, as root, about the repository, branch, commit and
// onto it parsed out of the very text the person signs. Its objects come from the root's
// user, but a commit's id is the hash of what it is, so what it shows for that id is that
// commit, and the remote's branches it reads from the forge itself, with the read key.
//
// WHAT IT IS NOT. It runs git on objects the root's user sent: a bug in git's own parsing
// that could compromise the root's user could compromise this one too, and then the summary
// would lie. It has no write key and no way to one (only the pusher does), so what it
// shows is all it could change. One request per process; root's supervisor kills its user's
// processes before the next.
//
//   node reviewer.ts        (as desolate-reviewer; started and kept by root/start.sh)
//
// On REVIEWER.control (the root's user may use it; so may root):
//   {"op":"tips","repo"}                  -> {"ok":true,"tips":[commit...]}   what it holds
//   {"op":"submit","repo","bundle":N}\n then N bytes: a bundle of refs/desolate/review/<16 hex>
//     and the clone's refs/remotes/origin/* -> {"ok":true}
//   {"op":"pack","repo","pack":sha256} -> {"ok":true,"pack","size","lfs":[oid...]}\n then
//     the pack's bytes: a pack a summary made and kept, by its sha256 (which the approval
//     names), for send.ts to carry
// And for the host, not on the socket: `node reviewer.ts summary`, started by root
// (review-ask.ts) as this user, one summary per process.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import * as path from "node:path";
import { squashedFrom } from "../shared/approval.ts";
import { isBranch, isCommit, parseRepo, repoId } from "../shared/names.ts";
import type { Repo } from "../shared/names.ts";
import { run } from "../shared/run.ts";
import { SUEDE_CORE } from "../shared/suede.ts";
import { ask } from "./keyring-client.ts";
import { GITCONFIG, KEYRING, PINNED_FORGE, REVIEWER } from "./layout.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Table } from "../../suede.nests/dsl.import.meta.vitest.ts";

const LIMIT = {
  header: 64 * 1024,
  bundle: 2 * 1024 ** 3,
  refs: 2000,
  commits: 50,
  files: 200,
  idleMs: 60_000,
  submitMs: 600_000,
} as const;
const log = (message: string) => console.error(`${new Date().toISOString()} reviewer: ${message}`);
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Text an agent wrote, made safe to show: no control characters, no bidirectional
 *  overrides (which make a name read as another), and not too long. */
export const shown = (text: string, max: number) =>
  [
    ...text
      .normalize("NFC")
      .replace(
        /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}\u{fe00}-\u{fe0f}\u{e0100}-\u{e01ef}\u{180e}]/gu,
        "?",
      ),
  ]
    .slice(0, max)
    .join("");

/** Files that run on the forge, or change how git treats the repository, or are suede's own
 *  machinery (`.suede/core/`, which every consumer of a dependency runs): always listed
 *  (first), however many files a push changes. */
export const SENSITIVE =
  /(^|\/)(\.github\/|\.gitlab-ci\.yml$|\.gitmodules$|\.gitattributes$|\.lfsconfig$|\.gitignore$|\.circleci\/|Jenkinsfile$|\.devcontainer\/|devcontainer\.json$|\.husky\/|\.pre-commit-config\.yaml$|CODEOWNERS$|\.suede\/core\/)/;
declare namespace shown {
  /** what an agent wrote, as the approval page may show it: as written, unless it would
   *  read as something else */
  export type AsWritten = Table<
    typeof shown,
    [
      [args: [text: "Fix the login loop", max: 200], expected: "Fix the login loop"],
      [args: [text: "cafe\u0301", max: 200], expected: "caf\u00e9"],
    ]
  >;
  /** controls, a right-to-left override that makes a name read backwards, invisible spaces
   *  and variation selectors: each one a question mark */
  export type Hides = Table<
    typeof shown,
    [
      [args: [text: "evil\u001b[31m red", max: 200], expected: "evil?[31m red"],
      [args: [text: "invoice\u202efdp.exe", max: 200], expected: "invoice?fdp.exe"],
      [args: [text: "pay\u200bpal", max: 200], expected: "pay?pal"],
      [args: [text: "ok\ufe0f", max: 200], expected: "ok?"],
      [args: [text: "line\u2028break", max: 200], expected: "line?break"],
    ]
  >;
  /** cut at `max` characters, never inside one */
  export type Cut = Table<
    typeof shown,
    [
      [args: [text: "abcdef", max: 3], expected: "abc"],
      [args: [text: "\u{1f600}\u{1f600}\u{1f600}", max: 2], expected: "\u{1f600}\u{1f600}"],
    ]
  >;
}

declare namespace SENSITIVE {
  /** what runs on the forge, steers git, or is suede's own machinery: listed first, always */
  export type Listed = Table<
    typeof SENSITIVE.test,
    [
      [args: [string: ".github/workflows/ci.yml"], expected: true],
      [args: [string: "packages/api/.github/dependabot.yml"], expected: true],
      [args: [string: ".gitmodules"], expected: true],
      [args: [string: ".gitattributes"], expected: true],
      [args: [string: ".lfsconfig"], expected: true],
      [args: [string: ".devcontainer/devcontainer.json"], expected: true],
      [args: [string: ".husky/pre-commit"], expected: true],
      [args: [string: "docs/CODEOWNERS"], expected: true],
      [args: [string: "vendor/x/.suede/core/sync.sh"], expected: true],
    ]
  >;
  /** and ordinary files are not, however close their names */
  export type NotListed = Table<
    typeof SENSITIVE.test,
    [
      [args: [string: "src/github/client.ts"], expected: false],
      [args: [string: "docs/gitmodules.md"], expected: false],
      [args: [string: "suede.nests/README.md"], expected: false],
      [args: [string: "README.md"], expected: false],
    ]
  >;
}

const POINTER =
  /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:([0-9a-f]{64})\nsize (\d+)\n$/;

const repoDir = (repo: Repo) => path.join(REVIEWER.home, "repos", repo.owner, `${repo.name}.git`);
const CONFIG = "[core]\n\trepositoryformatversion = 0\n\tbare = true\n";

const env = (extra: Record<string, string> = {}) => ({
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: REVIEWER.home,
  LANG: "C.UTF-8",
  GIT_CONFIG_GLOBAL: GITCONFIG,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_ATTR_NOSYSTEM: "1",
  ...extra,
});
/** The settings every git run here starts with: nothing an earlier request could have left in
 *  the repository (hooks, attributes, a commit graph, a pack index over packs) is trusted. */
const hardened = (dir: string) => [
  "-c",
  `safe.directory=${dir}`,
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.attributesFile=/dev/null",
  "-c",
  "core.commitGraph=false",
  "-c",
  "core.multiPackIndex=false",
  "-c",
  "fetch.writeCommitGraph=false",
  "-c",
  "gc.auto=0",
  "-c",
  "maintenance.auto=false",
];
const gitIn = (
  dir: string,
  args: string[],
  options: { input?: string; timeoutMs?: number; ssh?: string; env?: Record<string, string> } = {},
) =>
  run("git", ["--git-dir", dir, ...hardened(dir), ...args], {
    env: env({
      GIT_DIR: dir,
      ...(options.ssh ? { GIT_SSH_COMMAND: options.ssh } : {}),
      ...options.env,
    }),
    input: options.input,
    timeoutMs: options.timeoutMs ?? 300_000,
  });
const gitOk = async (dir: string, args: string[], options: Parameters<typeof gitIn>[2] = {}) => {
  const result = await gitIn(dir, args, options);
  if (result.code !== 0)
    throw new Error(
      `git ${args[0]} failed: ${(result.stderr || result.stdout).trim().split("\n").slice(-2).join(" | ").slice(0, 300)}`,
    );
  return result.stdout;
};

/** Its repository for one of the root's repositories, put back as it should be before git
 *  runs in it: whatever an earlier request's process could have left (config, hooks,
 *  attributes, alternates, replacements, grafts) is gone. */
const ensureRepo = (repo: Repo) => {
  const dir = repoDir(repo);
  for (const sub of ["objects/pack", "objects/info", "refs/heads", "refs/seen"])
    fs.mkdirSync(path.join(dir, sub), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, "HEAD"), "ref: refs/heads/main\n", { mode: 0o600 });
  fs.writeFileSync(path.join(dir, "config"), CONFIG, { mode: 0o600 });
  // (And what git would trust without re-reading the objects: a commit graph, a pack index
  // over several packs, packed refs. It never writes these itself here: gc and the graph are
  // off.)
  for (const extra of [
    "hooks",
    "info",
    "shallow",
    "commondir",
    "objects/info/alternates",
    "objects/info/http-alternates",
    "objects/info/grafts",
    "objects/info/commit-graph",
    "objects/info/commit-graphs",
    "objects/pack/multi-pack-index",
    "packed-refs",
    "refs/replace",
    "worktrees",
    "modules",
  ])
    fs.rmSync(path.join(dir, extra), { recursive: true, force: true });
  return dir;
};

const tips = async (repo: Repo) => {
  const dir = repoDir(repo);
  if (!fs.existsSync(path.join(dir, "config"))) return [];
  ensureRepo(repo);
  return (await gitOk(dir, ["for-each-ref", "--format=%(objectname)", "refs/seen"]))
    .split("\n")
    .filter(isCommit);
};

/** Exactly `count` bytes into a file, or a failure (with a minute's patience per chunk). */
const receive = (socket: Socket, first: Buffer, count: number, file: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const out = fs.openSync(
      file,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );
    let left = count;
    let idle: NodeJS.Timeout | undefined;
    const done = (error?: Error) => {
      clearTimeout(idle);
      socket.off("data", onData);
      socket.off("close", onClose);
      fs.closeSync(out);
      if (error) reject(error);
      else resolve();
    };
    const take = (chunk: Buffer) => {
      const part = chunk.subarray(0, left);
      if (part.length) fs.writeSync(out, part);
      left -= part.length;
    };
    const arm = () => {
      clearTimeout(idle);
      idle = setTimeout(() => done(new Error("nothing arrived for a minute")), LIMIT.idleMs);
    };
    const onData = (chunk: Buffer) => {
      arm();
      take(chunk);
      if (left === 0) done();
    };
    const onClose = () => done(new Error("the connection ended before the bundle did"));
    take(first);
    if (left === 0) return done();
    socket.on("data", onData);
    socket.on("close", onClose);
    arm();
    socket.resume();
  });

const BUNDLE_REF =
  /^refs\/(desolate\/review\/[0-9a-f]{16}|remotes\/origin\/[A-Za-z0-9._/-]{1,200})$/;

declare namespace BUNDLE_REF {
  /** a review bundle carries the clone's review ref and its origin/* refs, and nothing else */
  export type Refs = Table<
    typeof BUNDLE_REF.test,
    [
      [args: [string: "refs/desolate/review/0123456789abcdef"], expected: true],
      [args: [string: "refs/remotes/origin/main"], expected: true],
      [args: [string: "refs/remotes/origin/feature/login"], expected: true],
      [args: [string: "refs/heads/main"], expected: false],
      [args: [string: "refs/desolate/review/xyz"], expected: false],
      [args: [string: "refs/remotes/origin/a b"], expected: false],
      [args: [string: "refs/remotes/other/main"], expected: false],
      [args: [string: "refs/tags/v1"], expected: false],
    ]
  >;
}

const submit = async (socket: Socket, repo: Repo, size: number, rest: Buffer) => {
  if (!Number.isInteger(size) || size < 1 || size > LIMIT.bundle)
    return { ok: false, error: "a bundle is a whole number of bytes, at most 2 GiB" };
  const dir = ensureRepo(repo);
  const file = path.join(REVIEWER.home, `incoming-${randomBytes(8).toString("hex")}.bundle`);
  const timer = setTimeout(() => {
    log("a submit ran past its ten minutes: given up");
    process.exit(1);
  }, LIMIT.submitMs);
  try {
    await receive(socket, rest, size, file);
    const heads = (await gitOk(dir, ["bundle", "list-heads", file]))
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(" ") as [string, string]);
    if (
      heads.length === 0 ||
      heads.length > LIMIT.refs ||
      heads.some(([id, ref]) => !isCommit(id) || !BUNDLE_REF.test(ref ?? ""))
    )
      return {
        ok: false,
        error:
          "a review bundle carries the clone's review ref and its origin/* refs, and nothing else",
      };
    // Every object arrives checked (root's git settings: fsckObjects), and is the reviewer's
    // only under a ref named by its own id.
    // One ref per commit: two refs at one commit (origin/HEAD and origin/main, say) would
    // both be refs/seen/<that commit>, and git refuses to fetch two into one.
    const once = [...new Map(heads.map(([id, ref]) => [id, ref])).entries()];
    await gitOk(
      dir,
      [
        "fetch",
        "--quiet",
        "--no-tags",
        "--no-write-fetch-head",
        file,
        ...once.map(([id, ref]) => `+${ref}:refs/seen/${id}`),
      ],
      { timeoutMs: 1_800_000 },
    );
    return { ok: true };
  } finally {
    clearTimeout(timer);
    fs.rmSync(file, { force: true });
  }
};

/** The forge's branches, read with the repository's read key: the reviewer's own account of
 *  what the remote has, not the root's user's. */
const remoteOf = async (repo: Repo, dir: string) => {
  const reply = await ask(KEYRING.reviewer, { op: "readkey", repo: repoId(repo) });
  if (reply.ok !== true) throw new Error(String(reply.error ?? "no read key"));
  // In a folder a restart of this service leaves alone: one that cleared the home took the
  // file from under a summary in flight, and its ls-remote was refused (T2, 2026-11-20).
  const identities = path.join(REVIEWER.home, "identities");
  fs.mkdirSync(identities, { recursive: true, mode: 0o700 });
  const identity = path.join(identities, `read-${randomBytes(6).toString("hex")}.pub`);
  fs.writeFileSync(identity, `${String(reply.pubkey).trim()}\n`, { mode: 0o600 });
  try {
    const f = JSON.parse(fs.readFileSync(PINNED_FORGE.config, "utf8")) as {
      ssh: { user: string; host: string; port: number };
    };
    if (
      !/^[a-z_][a-z0-9_-]*$/.test(f.ssh.user) ||
      !/^[A-Za-z0-9.-]+$/.test(f.ssh.host) ||
      !Number.isInteger(f.ssh.port)
    )
      throw new Error("the forge's address is not well formed");
    const ssh = [
      "ssh",
      "-F",
      "/dev/null",
      "-o",
      `IdentityAgent=${KEYRING.reviewerReadAgent}`,
      "-o",
      `IdentityFile=${identity}`,
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      `UserKnownHostsFile=${PINNED_FORGE.knownHosts}`,
      "-o",
      "ConnectTimeout=20",
    ].join(" ");
    const listed = await gitOk(
      dir,
      [
        "ls-remote",
        "--symref",
        `ssh://${f.ssh.user}@${f.ssh.host}:${f.ssh.port}/${repo.owner}/${repo.name}.git`,
        "HEAD",
        "refs/heads/*",
      ],
      { ssh, timeoutMs: 60_000 },
    );
    const heads = new Map<string, string>();
    let defaultBranch: string | null = null;
    for (const line of listed.split("\n").filter(Boolean)) {
      const symref = /^ref: refs\/heads\/(\S+)\tHEAD$/.exec(line);
      if (symref) defaultBranch = symref[1]!;
      const ref = /^([0-9a-f]{40})\trefs\/heads\/(\S+)$/.exec(line);
      if (ref) heads.set(ref[2]!, ref[1]!);
    }
    return { heads, defaultBranch };
  } finally {
    fs.rmSync(identity, { force: true });
  }
};

const has = async (dir: string, id: string) =>
  (await gitIn(dir, ["cat-file", "-e", `${id}^{commit}`])).code === 0;

// ---------------------------------------------------------------- what a push sends
// The pack a push sends is made HERE, of objects whose ids are their content, and kept: the
// approval names its sha256 (shared/approval.ts, put in by the host from this user's answer),
// and the pusher forwards only a pack that hashes to it. The root's user carries it, and can
// add nothing to it. Before this, the root's user made the pack itself, and could have put in
// any object it liked, uploaded to the forge under the write key beside an approved push
// (#165).

/** A git command's whole output as bytes (a blob's content is not always text). */
const gitBytes = (dir: string, args: string[], input: string): Promise<Buffer | null> =>
  new Promise((resolve) => {
    const child = spawn("git", ["--git-dir", dir, ...hardened(dir), ...args], {
      env: env({ GIT_DIR: dir }),
      stdio: ["pipe", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) child.kill("SIGKILL");
      else chunks.push(chunk);
    });
    child.on("error", () => resolve(null));
    // (A git that ends before reading all its input: EPIPE on its stdin, not a crash.)
    child.stdin.on("error", () => {});
    child.on("close", (code) => resolve(code === 0 ? Buffer.concat(chunks) : null));
    child.stdin.end(input);
  });

/** The LFS objects a pack's commits point to: each blob in it that is a pointer (git-lfs's
 *  own form: a version line, the oid, the size, nothing else), as `<oid> <size>`. */
const pointersIn = async (dir: string, tip: string, known: string[]): Promise<string[]> => {
  const listed = await gitOk(
    dir,
    ["rev-list", "--objects", "--no-object-names", tip, ...known.map((id) => `^${id}`)],
    { timeoutMs: 600_000 },
  );
  const ids = listed.split("\n").filter((id) => /^[0-9a-f]{40}$/.test(id));
  if (ids.length === 0) return [];
  const sizes = await gitOk(
    dir,
    ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
    { input: ids.join("\n") + "\n", timeoutMs: 600_000 },
  );
  const small = sizes
    .split("\n")
    .map((line) => line.split(" "))
    .filter(([, type, size]) => type === "blob" && Number(size) < 400)
    .map(([id]) => id!);
  if (small.length === 0) return [];
  const oids = new Set<string>();
  // In batches: each answer is held whole (gitBytes stops at 64 MiB), and 20,000 blobs under
  // 400 bytes are under 9 MiB (the independent review of #169: 250,000 small blobs in one
  // push went over, and the push could not be approved at all).
  for (let from = 0; from < small.length; from += 20_000)
    readPointers(
      await gitBytes(
        dir,
        ["cat-file", "--batch"],
        small.slice(from, from + 20_000).join("\n") + "\n",
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
    // Over 5 GiB, the pusher takes none (pusher.ts): said, not left out, or the remote would get
    // the pointer without its object.
    if (match && Number(match[2]) > 5 * 1024 ** 3)
      throw new Error(
        `an LFS pointer names an object of ${match[2]} bytes, over the 5 GiB a push sends`,
      );
    if (match) oids.add(`${match[1]} ${Number(match[2])}`);
    at = end + 1 + size + 1;
  }
};

export type Sends = { pack: string; size: number; lfs: string[] };
// Each pack is kept by its own sha256 (<sha>.pack, and <sha>.json: its size and LFS ids), and
// a push asks for the one its approval names, by that sha256: two summaries at once, or one
// made again later, make packs of their own, and never replace one an approval names (the
// independent review of #165's fix: a pack kept by push, replaced, would have failed an
// approved push). A push's own record (<commit>-<onto>.json) says which pack was made for it
// last, so a summary asked again soon gives the same one.
const PACKS = {
  freshMs: 10 * 60_000,
  keptMs: 60 * 60_000,
  mostBytes: 8 * 1024 ** 3,
  packBytes: 2 * 1024 ** 3,
} as const;
const packsDir = (repo: Repo) => path.join(REVIEWER.home, "packs", repo.owner, repo.name);
// (With the remote's branches it was made against: a branch deleted since, and a pack made
// before would lack what that branch had, refused by the forge until the ten minutes passed.)
const packKey = (commit: string, onto: string | null, known: string[]) =>
  `${commit}-${onto ?? "none"}-${createHash("sha256")
    .update([...known].sort().join("\n"))
    .digest("hex")
    .slice(0, 16)}`;
const SHA256 = /^[0-9a-f]{64}$/;

/** The pack for pushing `tip` onto `onto`: of the objects `tip` has that the remote's branches
 *  (`known`) do not, kept with its sha256 and LFS ids. Asked again within ten minutes, the
 *  same pack; after, a new one (the remote may have moved on). */
const prepare = async (
  repo: Repo,
  dir: string,
  tip: string,
  onto: string | null,
  known: string[],
): Promise<Sends> => {
  const where = packsDir(repo);
  fs.mkdirSync(where, { recursive: true, mode: 0o700 });
  const record = path.join(where, `${packKey(tip, onto, known)}.json`);
  prunePacks();
  try {
    const last = JSON.parse(fs.readFileSync(record, "utf8")) as { pack?: unknown; at?: unknown };
    const kept = typeof last.pack === "string" ? storedPack(repo, last.pack) : null;
    if (kept && Number.isFinite(last.at) && Date.now() - (last.at as number) < PACKS.freshMs)
      return kept.sends;
  } catch {
    /* none yet */
  }
  const temporary = path.join(where, `incoming-${randomBytes(8).toString("hex")}`);
  const out = fs.openSync(temporary, "w", 0o600);
  const hash = createHash("sha256");
  let size = 0;
  const packed = await new Promise<{ code: number; stderr: string }>((resolve) => {
    const child = spawn(
      "git",
      [
        "--git-dir",
        dir,
        ...hardened(dir),
        // Bounded: the root VM's memory is every domain's keyring and pusher too.
        "-c",
        "pack.threads=2",
        "-c",
        "pack.windowMemory=256m",
        "-c",
        "core.bigFileThreshold=64m",
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
        "--quiet",
      ],
      { env: env({ GIT_DIR: dir }), stdio: ["pipe", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      hash.update(chunk);
      size += chunk.length;
      // As large as the pusher takes, and no larger (pusher.ts, LIMIT.pack).
      if (size > PACKS.packBytes) child.kill("SIGKILL");
      else fs.writeSync(out, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-2000)));
    child.on("error", (error) => resolve({ code: 1, stderr: error.message }));
    child.stdin.on("error", () => {});
    child.on("close", (code) => resolve({ code: code ?? 1, stderr }));
    child.stdin.end([tip, ...known.map((id) => `^${id}`), ""].join("\n"));
  });
  fs.closeSync(out);
  if (size > PACKS.packBytes) {
    fs.rmSync(temporary, { force: true });
    throw new Error("the push's pack is over 2 GiB, more than a push may send");
  }
  if (packed.code !== 0) {
    fs.rmSync(temporary, { force: true });
    throw new Error(`cannot pack the push: ${packed.stderr.trim().split("\n").slice(-1)[0] ?? ""}`);
  }
  const sends: Sends = { pack: hash.digest("hex"), size, lfs: await pointersIn(dir, tip, known) };
  // Its own name is its digest: the same bytes made twice are the same file.
  fs.renameSync(temporary, path.join(where, `${sends.pack}.pack`));
  const meta = path.join(where, `${sends.pack}.json`);
  // (Each its own temporary name: two summaries at once once both wrote "<file>.part", and one
  // rename found it gone.)
  const atomically = (file: string, text: string) => {
    const part = `${file}.${randomBytes(8).toString("hex")}.part`;
    fs.writeFileSync(part, text, { mode: 0o600 });
    fs.renameSync(part, file);
  };
  atomically(meta, JSON.stringify({ size, lfs: sends.lfs }));
  atomically(record, JSON.stringify({ pack: sends.pack, at: Date.now() }));
  return sends;
};

/** The kept pack with this sha256, if there is one: its file, and what it sends. */
const storedPack = (repo: Repo, pack: string): { file: string; sends: Sends } | null => {
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

/** What is kept goes after an hour (an approval lasts two minutes, a push half an hour), and
 *  the oldest first past 8 GiB in all: a root's user that asks for summaries of many pushes
 *  fills no disk. When the reviewer starts, and before each pack is made. */
const prunePacks = () => {
  const root = path.join(REVIEWER.home, "packs");
  const dirs = (dir: string) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
    } catch {
      return [];
    }
  };
  const all: { file: string; at: number; size: number }[] = [];
  for (const owner of dirs(root))
    for (const name of dirs(path.join(root, owner.name))) {
      const where = path.join(root, owner.name, name.name);
      for (const entry of fs.readdirSync(where)) {
        const file = path.join(where, entry);
        // (One a summary renames as this looks is gone: nothing to do.)
        const stat = fs.statSync(file, { throwIfNoEntry: false });
        if (!stat) continue;
        if (Date.now() - stat.mtimeMs > PACKS.keptMs) fs.rmSync(file, { force: true });
        else if (entry.endsWith(".pack")) all.push({ file, at: stat.mtimeMs, size: stat.size });
      }
    }
  let total = all.reduce((n, p) => n + p.size, 0);
  for (const pack of all.sort((a, b) => a.at - b.at)) {
    if (total <= PACKS.mostBytes) break;
    fs.rmSync(pack.file, { force: true });
    fs.rmSync(pack.file.replace(/\.pack$/, ".json"), { force: true });
    total -= pack.size;
  }
};

/** The person's other choice: the commits pushed as one. Its tree is the commit's own, its
 *  parent is where the commit leaves the remote's history (what it builds on: `onto`, or the
 *  branch a new one starts from), and its author, committer and dates are the commit's. So
 *  the same push, onto the same remote, always squashes to the same commit (for a new branch,
 *  where it starts depends on the remote's branches the reviewer holds; either way the
 *  approval names the very commit the person was shown). Its message: the first commit's
 *  subject, then every commit's. */
export type Squash = {
  commit: string;
  parent: string | null;
  count: number;
  message: string;
  author: string;
  committer: string;
  /** Its dates, the last commit's: when it says it was written, and committed. */
  dates: string;
};
const SQUASH_LISTED = 100;
const squashOf = async (
  dir: string,
  commit: string,
  from: string | null,
): Promise<Squash | null> => {
  const parent = from ? (await gitIn(dir, ["merge-base", commit, from])).stdout.trim() : "";
  if (from && !isCommit(parent)) return null;
  const range = parent ? [commit, `^${parent}`] : [commit];
  const count = Number((await gitOk(dir, ["rev-list", "--count", ...range])).trim()) || 0;
  if (count < 2) return null;
  const subjects = (
    await gitOk(dir, [
      "log",
      "--reverse",
      "--no-decorate",
      "--format=%s",
      "--no-show-signature",
      ...range,
    ])
  )
    .replace(/\n$/, "")
    .split("\n")
    // (An empty message is a commit too: left out, the count and the first subject were wrong.)
    .map((subject) => shown(subject, 200) || "(no message)");
  const listed = subjects.slice(0, SQUASH_LISTED).map((s) => `- ${s}`);
  if (subjects.length > SQUASH_LISTED) listed.push(`- and ${subjects.length - SQUASH_LISTED} more`);
  const message = `${subjects[0] ?? "Squashed"}\n\nSquashed from ${count} commits:\n${listed.join("\n")}\n`;
  const [anRaw, aeRaw, ad, cnRaw, ceRaw, cd] = (
    await gitOk(dir, [
      "log",
      "-1",
      "--no-show-signature",
      "--format=%an%x00%ae%x00%ad%x00%cn%x00%ce%x00%cd",
      "--date=raw",
      commit,
    ])
  )
    .replace(/\n$/, "")
    .split("\x00");
  // Who the squash names, made safe and short, as the page shows them (the third independent
  // review: copied as they were, an agent's 100 KB "email" would ride along unseen in a
  // commit the reviewer itself made). Dates as git keeps them, or no squash.
  const named = (text: string | undefined, max: number) =>
    shown(text ?? "", max)
      .replace(/[<>\n]/g, "?")
      .trim();
  const [an, ae, cn, ce] = [
    named(anRaw, 80),
    named(aeRaw, 120),
    named(cnRaw, 80),
    named(ceRaw, 120),
  ];
  if (!/^[0-9]{1,12} [+-][0-9]{4}$/.test(ad ?? "") || !/^[0-9]{1,12} [+-][0-9]{4}$/.test(cd ?? ""))
    return null;
  const made = await gitIn(
    dir,
    [
      "commit-tree",
      "--no-gpg-sign",
      ...(parent ? ["-p", parent] : []),
      "-F",
      "-",
      `${commit}^{tree}`,
    ],
    {
      input: message,
      env: {
        GIT_AUTHOR_NAME: an,
        GIT_AUTHOR_EMAIL: ae,
        GIT_AUTHOR_DATE: ad!,
        GIT_COMMITTER_NAME: cn,
        GIT_COMMITTER_EMAIL: ce,
        GIT_COMMITTER_DATE: cd!,
      },
    },
  );
  // (git's own identity rules: an author it refuses, say an empty name, gets no squash.)
  if (made.code !== 0) return null;
  const id = made.stdout.trim();
  if (!isCommit(id)) return null;
  // Who and when, read back from the commit as git wrote it (git trims a name's punctuation:
  // what is shown is what is in it, the independent review of #169), dates too.
  const [author, committer, authored, committed] = (
    await gitOk(dir, [
      "log",
      "-1",
      "--no-show-signature",
      "--date=iso-strict",
      "--format=%an <%ae>%x00%cn <%ce>%x00%ad%x00%cd",
      id,
    ])
  )
    .replace(/\n$/, "")
    .split("\x00");
  return {
    commit: id,
    parent: parent || null,
    count,
    message,
    author: shown(author ?? "", 210),
    committer: shown(committer ?? "", 210),
    dates: `authored ${shown(authored ?? "", 40)}, committed ${shown(committed ?? "", 40)}`,
  };
};

export type Summary = {
  ok: boolean;
  error?: string;
  warnings?: string[];
  commits?: { commit: string; subject: string; author: string }[];
  more?: number;
  files?: { path: string; added: number; removed: number; binary?: boolean; sensitive?: boolean }[];
  moreFiles?: number;
  base?: string | null;
  remote?: string | null;
  fastForward?: boolean | null;
  /** When the push replaces the remote's branch, and that branch is a squash of a commit of
   *  this one (the same files, on where this one starts): that commit. */
  squashedFrom?: string;
  lfs?: number;
  /** The diff itself, as git makes it from objects (no external program, no textconv): what
   *  the approval page shows on asking. Cut at 256 KiB; not made at all past 20 000 lines. */
  diff?: string;
  diffCut?: boolean;
  /** What the push sends: the pack the reviewer made and keeps, and the LFS objects its
   *  commits point to. The host puts these in the text the person signs. */
  sends?: Sends;
  /** The other choice, when there are two commits or more: the same push as one commit. */
  squash?: Squash & { sends: Sends };
  /** Files a commit of the push changes that the net change (`files`) does not list: changed,
   *  then put back. Every commit is pushed, so what was in between is in the history. */
  between?: { path: string; sensitive?: boolean }[];
  moreBetween?: number;
  /** Each commit's own diff, for reading what is in between (cut as the diff is). */
  eachDiff?: string;
  eachDiffCut?: boolean;
  /** Why each commit's diff is cut, or not there. */
  eachDiffWhy?: string;
};
const DIFF_MOST = { bytes: 256 * 1024, lines: 20_000 } as const;

const summary = async (
  repo: Repo,
  branch: string,
  commit: string,
  onto: string | null,
): Promise<Summary> => {
  const dir = ensureRepo(repo);
  if (!(await has(dir, commit)))
    return { ok: false, error: "the root has not sent the reviewer this commit" };
  const warnings: string[] = [];
  const remote = await remoteOf(repo, dir);
  const now = remote.heads.get(branch) ?? null;
  if (now !== onto)
    warnings.push(
      now
        ? `the remote's ${branch} is now ${now.slice(0, 12)}, not the ${onto ? onto.slice(0, 12) : "absence"} this push names: the push will be refused`
        : `the remote has no ${branch} any more: the push will be refused`,
    );
  // What the commit is compared with: the branch it moves from, or (for a new branch) the
  // remote's default branch.
  let base =
    onto ?? (remote.defaultBranch ? (remote.heads.get(remote.defaultBranch) ?? null) : null);
  if (base && !(await has(dir, base)))
    return {
      ok: false,
      error: `the root has not sent the reviewer ${base.slice(0, 12)}, which this push is compared with`,
    };
  const known = [];
  for (const id of new Set(remote.heads.values())) if (await has(dir, id)) known.push(id);
  // The same push against the same remote, asked again (each challenge's page asks anew): the
  // account already made, for ten minutes. A root's user that has the page ask again and again
  // starts no new work (the independent review of #169).
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        repoId(repo),
        branch,
        commit,
        onto,
        [...remote.heads].sort(),
        remote.defaultBranch,
        known,
      ]),
    )
    .digest("hex");
  const cached = cachedSummary(key);
  // (Only while the packs it names are kept: pruned past 8 GiB, it is made again.)
  if (
    cached?.sends &&
    storedPack(repo, cached.sends.pack) &&
    (!cached.squash || storedPack(repo, cached.squash.sends.pack))
  )
    return cached;
  if (known.length < new Set(remote.heads.values()).size)
    warnings.push(
      "some of the remote's branches were not sent to the reviewer: commits on them may be listed as new",
    );
  // A new branch that is not built on the default branch (a suede proposal is built on the
  // dependency's release, which shares nothing with main): compared with where it does leave
  // the remote's history, not with the default branch's whole tree.
  if (
    !onto &&
    base &&
    (await gitIn(dir, ["merge-base", "--is-ancestor", base, commit])).code !== 0
  ) {
    const newSince = async (from: string) =>
      Number((await gitIn(dir, ["rev-list", "--count", commit, `^${from}`])).stdout.trim());
    const fork = async (tip: string) =>
      (await gitIn(dir, ["merge-base", commit, tip])).stdout.trim();
    const fromDefault = await fork(base);
    let best = isCommit(fromDefault) ? { at: base, count: await newSince(fromDefault) } : null;
    for (const tip of known.slice(0, 200)) {
      const at = await fork(tip);
      if (!isCommit(at)) continue;
      const count = await newSince(at);
      if (!best || count < best.count) best = { at, count };
    }
    if (best && best.at !== base) base = best.at;
  }
  const listed = await gitOk(dir, [
    "log",
    "--no-decorate",
    "--no-show-signature",
    `--max-count=${LIMIT.commits + 1}`,
    "--format=%H%x00%an%x00%s%x00",
    commit,
    ...known.map((id) => `^${id}`),
  ]);
  const fields = listed
    .split("\x00\n")
    .filter(Boolean)
    .map((entry) => entry.replace(/^\n/, "").split("\x00"));
  const commits = fields.slice(0, LIMIT.commits).map(([id, author, subject]) => ({
    commit: id!,
    author: shown(author ?? "", 80),
    subject: shown(subject ?? "", 200),
  }));
  const counted =
    Number(
      (await gitOk(dir, ["rev-list", "--count", commit, ...known.map((id) => `^${id}`)])).trim(),
    ) || 0;
  const numstat = await gitOk(
    dir,
    [
      "diff",
      "--numstat",
      "-z",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      base ?? EMPTY_TREE,
      commit,
    ],
    { timeoutMs: 600_000 },
  );
  const files: {
    path: string;
    added: number;
    removed: number;
    binary?: boolean;
    sensitive?: boolean;
  }[] = [];
  let core = 0;
  for (const part of numstat.split("\x00").filter(Boolean)) {
    const [added, removed, ...name] = part.split("\t");
    const raw = name.join("\t");
    files.push({
      path: shown(raw, 300),
      added: Number(added) || 0,
      removed: Number(removed) || 0,
      ...(added === "-" ? { binary: true } : {}),
      ...(SENSITIVE.test(raw) ? { sensitive: true } : {}),
    });
    if (SUEDE_CORE.test(raw)) core += 1;
  }
  if (core)
    warnings.push(
      `it changes suede's own machinery (${core} file(s) under .suede/core/), which every consumer of this code runs: worth a second look`,
    );
  // What runs on the forge first: never past the cut.
  files.sort((a, b) => Number(Boolean(b.sensitive)) - Number(Boolean(a.sensitive)));
  // LFS objects: the new blobs that are pointers.
  const raw = await gitOk(
    dir,
    ["diff", "--raw", "-z", "--no-renames", "--no-abbrev", base ?? EMPTY_TREE, commit],
    { timeoutMs: 600_000 },
  );
  const blobs = raw
    .split("\x00")
    .filter((item) => item.startsWith(":"))
    .map((item) => item.split(" ")[3]!)
    .filter((id) => /^[0-9a-f]{40}$/.test(id) && !/^0+$/.test(id));
  let lfs = 0;
  if (blobs.length) {
    const sizes = await gitOk(
      dir,
      ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
      { input: blobs.join("\n") + "\n" },
    );
    for (const line of sizes.split("\n")) {
      const [id, type, size] = line.split(" ");
      if (
        type === "blob" &&
        Number(size) < 400 &&
        POINTER.test(await gitOk(dir, ["cat-file", "blob", id!]))
      )
        lfs += 1;
    }
  }
  // The diff, for reading before approving: bounded by its size before it is made.
  const changedLines = files.reduce((n, f) => n + f.added + f.removed, 0);
  let diff: string | undefined;
  let diffCut = changedLines > DIFF_MOST.lines;
  if (!diffCut) {
    const text = await gitOk(
      dir,
      [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--find-renames",
        "--diff-algorithm=histogram",
        "--unified=3",
        base ?? EMPTY_TREE,
        commit,
        "--",
      ],
      { timeoutMs: 120_000 },
    );
    diffCut = text.length > DIFF_MOST.bytes;
    diff = diffCut ? text.slice(0, DIFF_MOST.bytes) : text;
  }
  // Every file that changes what runs on the forge is listed, up to 2000, and their number is
  // said either way: a push of 80,000 of them made an answer too large to carry, and the page
  // lost the warning (audit, 2026-11-16).
  const sensitive = files.filter((f) => f.sensitive).length;
  if (sensitive > 2000)
    warnings.push(
      `${sensitive} files that change what runs on the forge (under .github/, or the like): the first 2000 are listed`,
    );
  const cut = Math.max(LIMIT.files, Math.min(sensitive, 2000));
  const fastForward = onto
    ? (await gitIn(dir, ["merge-base", "--is-ancestor", onto, commit])).code === 0
    : null;
  // A replace after a squashed push: named, so the person is told the command that catches
  // up, not only how to replace. Advice: what is pushed and signed does not depend on it.
  const remoteSquash =
    onto && fastForward === false
      ? await squashedFrom((args) => gitIn(dir, args), onto, commit)
      : null;
  // Every pushed commit's headers, other than the four every commit has: said, with their size
  // (the third independent review; then the review of #169: only the 50 listed were read, a
  // signature, a mergetag or an encoding was taken as git's own and never said, and a read
  // that failed said nothing). fsck takes any well-formed header, so any could carry data.
  const order = (
    await gitOk(dir, ["rev-list", "--reverse", commit, ...known.map((id) => `^${id}`)], {
      timeoutMs: 600_000,
    })
  )
    .split("\n")
    .filter(isCommit);
  // The four, as git writes them and in its order, each once (parents any number): what fsck
  // checks. After them, anything, repeated names and continuation lines too, is extra (the
  // review of the fixes: a second `committer` line, or a continuation of the first, passed
  // fsck --strict and receive.fsckObjects, and a match on the name alone took it as git's).
  const PREFIX = /^tree [0-9a-f]{40}\n(parent [0-9a-f]{40}\n)*author [^\n]*\ncommitter [^\n]*\n/;
  const odd: string[] = [];
  let unread = false;
  for (let from = 0; from < order.length && !unread; from += 2000) {
    const raw = await gitBytes(
      dir,
      ["cat-file", "--batch"],
      order.slice(from, from + 2000).join("\n") + "\n",
    );
    if (!raw) unread = true;
    for (let at = 0; raw && at < raw.length;) {
      const end = raw.indexOf(10, at);
      if (end < 0) break;
      const [id, , size] = raw.subarray(at, end).toString("latin1").split(" ");
      const body = raw.subarray(end + 1, end + 1 + Number(size)).toString("utf8");
      const split = body.indexOf("\n\n");
      const head = split < 0 ? `${body}\n` : body.slice(0, split + 1);
      const fixed = PREFIX.exec(head)?.[0] ?? "";
      // A header and its continuation lines (a signature's), with their size.
      const extra: { name: string; bytes: number; value: string }[] = [];
      if (!fixed) extra.push({ name: "malformed headers", bytes: head.length, value: "" });
      let current: (typeof extra)[number] | null = null;
      for (const line of (fixed ? head.slice(fixed.length) : "").split("\n").slice(0, -1)) {
        if (line.startsWith(" ") && current) current.bytes += line.length + 1;
        else {
          const space = line.indexOf(" ");
          current = {
            name: shown(space < 0 ? line : line.slice(0, space), 40) || "(a line with no name)",
            bytes: line.length + 1,
            value: space < 0 ? "" : line.slice(space + 1),
          };
          extra.push(current);
        }
      }
      const said = extra.map((h) =>
        h.name === "encoding" && h.bytes < 60
          ? `encoding "${shown(h.value, 40)}"`
          : `${h.name} (${h.bytes} bytes${h.name.startsWith("gpgsig") ? ", a signature" : ""})`,
      );
      if (said.length) odd.push(`${String(id).slice(0, 12)}: ${[...new Set(said)].join(", ")}`);
      at = end + 1 + Number(size) + 1;
    }
  }
  if (unread)
    warnings.push(
      "the commits' headers could not all be read (one over 64 MiB, or git failed): what they carry is not checked here. Squashed, the push is one commit desolate's reviewer made",
    );
  if (odd.length)
    warnings.push(
      `${odd.length} commit(s) carry headers this page does not show, pushed as they are: ${odd.slice(0, 20).join("; ")}${odd.length > 20 ? `; and ${odd.length - 20} more` : ""}. Squashed, the push is one commit desolate's reviewer made, without them`,
    );
  // What the push sends, made here (prepare): the pack, its digest, and its LFS ids. And the
  // squash, with its own.
  const sends = await prepare(repo, dir, commit, onto, known);
  const squashed = await squashOf(dir, commit, onto ?? base);
  const squash = squashed
    ? { ...squashed, sends: await prepare(repo, dir, squashed.commit, onto, known) }
    : undefined;
  // Every file any of the commits changes (a merge: what it changed against all its parents),
  // less the net change: what was changed, then put back.
  const touched = await gitOk(
    dir,
    [
      "log",
      "--cc",
      "--name-only",
      "-z",
      "--no-renames",
      "--format=",
      "--no-show-signature",
      commit,
      ...known.map((id) => `^${id}`),
    ],
    { timeoutMs: 600_000 },
  );
  const net = new Set(
    numstat
      .split("\x00")
      .filter(Boolean)
      .map((part) => part.split("\t").slice(2).join("\t")),
  );
  const inBetween = [
    ...new Set(touched.split("\x00").filter((name) => name !== "" && !net.has(name))),
  ].sort();
  const between = inBetween
    .map((raw) => ({ path: shown(raw, 300), ...(SENSITIVE.test(raw) ? { sensitive: true } : {}) }))
    .sort((a, b) => Number(Boolean(b.sensitive)) - Number(Boolean(a.sensitive)));
  // Each commit whole, first to last (a single one too: its message is in no other place),
  // bounded as the net diff is. Not made, or cut, the page says why (the review of #169:
  // `--max-count` with `--reverse` gave the newest 50, said "cut at 256 KiB", and a log that
  // failed left no word at all).
  let eachDiff: string | undefined;
  let eachDiffCut = false;
  let eachDiffWhy: string | undefined;
  if (counted >= 1 && !diffCut) {
    const text = await gitIn(
      dir,
      [
        "log",
        "--no-walk=unsorted",
        "-p",
        "--cc",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--no-show-signature",
        "--no-decorate",
        "--date=iso-strict",
        // Each commit whole: who wrote and committed it, when, its whole message (what a
        // person pushes is all of it, not the subject alone).
        "--format=commit %H%nAuthor:     %an <%ae>%nAuthorDate: %ad%nCommitter:  %cn <%ce>%nCommitDate: %cd%n%n%w(0,4,4)%B",
        ...order.slice(0, LIMIT.commits),
        "--",
      ],
      { timeoutMs: 120_000 },
    );
    if (text.code === 0) {
      eachDiff = text.stdout.slice(0, DIFF_MOST.bytes);
      eachDiffCut = text.stdout.length > DIFF_MOST.bytes || counted > LIMIT.commits;
      eachDiffWhy =
        counted > LIMIT.commits
          ? `the first ${LIMIT.commits} of ${counted} commits${text.stdout.length > DIFF_MOST.bytes ? ", cut at 256 KiB" : ""}`
          : text.stdout.length > DIFF_MOST.bytes
            ? "cut at 256 KiB"
            : undefined;
    } else eachDiffWhy = "git could not make it (too large, or too slow)";
  } else if (diffCut) {
    // Over 20 000 lines: no diffs, but every commit's message and who made it, all the same.
    const text = await gitIn(
      dir,
      [
        "log",
        "--no-walk=unsorted",
        "--no-show-signature",
        "--no-decorate",
        "--date=iso-strict",
        "--format=commit %H%nAuthor:     %an <%ae>%nAuthorDate: %ad%nCommitter:  %cn <%ce>%nCommitDate: %cd%n%n%w(0,4,4)%B",
        ...order.slice(0, LIMIT.commits),
      ],
      { timeoutMs: 120_000 },
    );
    if (text.code === 0) {
      eachDiff = text.stdout.slice(0, DIFF_MOST.bytes);
      eachDiffCut = true;
      eachDiffWhy = `each commit's message, without its diff (the change is over 20 000 lines)${counted > LIMIT.commits ? `, the first ${LIMIT.commits} of ${counted}` : ""}`;
    } else eachDiffWhy = "the change is over 20 000 lines, and git could not list the commits";
  }
  if (counted >= 1 && eachDiff === undefined)
    warnings.push(
      counted >= 2
        ? `each commit's own diff is not shown (${eachDiffWhy ?? "not made"}): what the commits held on the way is not seen here, and each is pushed. Squashed, only the net change is pushed`
        : `the commit's message is not shown (${eachDiffWhy ?? "not made"}): it is pushed as it is`,
    );
  return keepSummary(key, {
    ok: true,
    ...(warnings.length ? { warnings } : {}),
    commits,
    more: Math.max(0, counted - commits.length),
    files: files.slice(0, cut),
    moreFiles: Math.max(0, files.length - cut),
    base,
    remote: now,
    fastForward,
    ...(remoteSquash ? { squashedFrom: remoteSquash } : {}),
    lfs,
    ...(diff !== undefined ? { diff } : {}),
    diffCut,
    sends,
    ...(squash ? { squash } : {}),
    between: between.slice(0, LIMIT.files),
    moreBetween: Math.max(0, between.length - LIMIT.files),
    ...(eachDiff !== undefined ? { eachDiff, eachDiffCut } : {}),
    ...(eachDiffWhy ? { eachDiffWhy } : {}),
  });
};

const SUMMARIES = { dir: path.join(REVIEWER.home, "summaries"), freshMs: 10 * 60_000, most: 64 };
const cachedSummary = (key: string): Summary | null => {
  try {
    const file = path.join(SUMMARIES.dir, `${key}.json`);
    if (Date.now() - fs.statSync(file).mtimeMs > SUMMARIES.freshMs) return null;
    return JSON.parse(fs.readFileSync(file, "utf8")) as Summary;
  } catch {
    return null;
  }
};
const keepSummary = (key: string, summary: Summary): Summary => {
  try {
    fs.mkdirSync(SUMMARIES.dir, { recursive: true, mode: 0o700 });
    const part = path.join(SUMMARIES.dir, `${key}.${randomBytes(8).toString("hex")}.part`);
    fs.writeFileSync(part, JSON.stringify(summary), { mode: 0o600 });
    fs.renameSync(part, path.join(SUMMARIES.dir, `${key}.json`));
    // The newest 64, none older than ten minutes: each is at most about 600 KB.
    const kept = fs
      .readdirSync(SUMMARIES.dir)
      .map((name) => ({ name, at: fs.statSync(path.join(SUMMARIES.dir, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    for (const [i, entry] of kept.entries())
      if (i >= SUMMARIES.most || Date.now() - entry.at > SUMMARIES.freshMs)
        fs.rmSync(path.join(SUMMARIES.dir, entry.name), { force: true });
  } catch {
    /* a summary not kept is made again */
  }
  return summary;
};

/** One summary at a time: each recompresses every object of a push, twice (as it is, and
 *  squashed), and the root VM's memory and disk are every domain's keyring and pusher too.
 *  One that waits a minute is told so; one whose process died leaves its lock to the next. */
const LOCK = path.join(REVIEWER.home, "summary.lock");
const oneAtATime = async <T>(work: () => Promise<T>): Promise<T> => {
  const until = Date.now() + 60_000;
  for (;;) {
    try {
      fs.mkdirSync(LOCK, { mode: 0o700 });
      fs.writeFileSync(path.join(LOCK, "pid"), String(process.pid));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let holder = 0;
    try {
      holder = Number(fs.readFileSync(path.join(LOCK, "pid"), "utf8"));
    } catch {
      // Gone between the two: try again. (No pid yet: its holder is still writing it.)
      if (!fs.existsSync(LOCK)) continue;
    }
    const young = Date.now() - (fs.statSync(LOCK, { throwIfNoEntry: false })?.mtimeMs ?? 0) < 5000;
    let alive = young;
    if (holder > 0)
      try {
        process.kill(holder, 0);
        alive = true;
      } catch (error) {
        alive = (error as NodeJS.ErrnoException).code === "EPERM";
      }
    if (!alive) {
      // Taken away by one waiter alone: renamed, so a second that also found it dead does not
      // remove the lock the first then made.
      const away = `${LOCK}.stale-${randomBytes(8).toString("hex")}`;
      try {
        if (Number(fs.readFileSync(path.join(LOCK, "pid"), "utf8")) === holder)
          fs.renameSync(LOCK, away);
      } catch {
        /* another took it first */
      }
      fs.rmSync(away, { recursive: true, force: true });
      continue;
    }
    if (Date.now() > until)
      throw new Error(
        "desolate's reviewer is busy with another push's account: look at the push again in a moment",
      );
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  try {
    return await work();
  } finally {
    fs.rmSync(LOCK, { recursive: true, force: true });
  }
};

const handle = (socket: Socket) => {
  socket.on("error", () => socket.destroy());
  let head = Buffer.alloc(0);
  const onData = (chunk: Buffer) => {
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf(10);
    if (end < 0) return head.length > LIMIT.header ? socket.destroy() : undefined;
    socket.off("data", onData);
    socket.pause();
    const rest = head.subarray(end + 1);
    const answer = (value: unknown) => socket.end(JSON.stringify(value) + "\n");
    let request: Record<string, unknown>;
    try {
      request = JSON.parse(head.subarray(0, end).toString("utf8")) as Record<string, unknown>;
    } catch {
      return answer({ ok: false, error: "not a request" });
    }
    if (request.op === "ping") return answer({ ok: true });
    const repo = parseRepo(request.repo);
    if (!repo) return answer({ ok: false, error: "not a repository" });
    // A pack a summary made, by its sha256: its header line, then its bytes. Nothing is made
    // here: only the host's summary makes one.
    if (request.op === "pack") {
      const kept = typeof request.pack === "string" ? storedPack(repo, request.pack) : null;
      if (!kept)
        return answer({
          ok: false,
          error:
            "the reviewer keeps no such pack (each is kept an hour): look at the push on the approval page again",
        });
      socket.write(JSON.stringify({ ok: true, ...kept.sends }) + "\n");
      const stream = fs.createReadStream(kept.file);
      stream.pipe(socket);
      stream.on("error", () => socket.destroy());
      socket.once("close", () => process.exit(0));
      setTimeout(() => process.exit(0), 30 * 60_000).unref();
      return;
    }
    let work: Promise<unknown>;
    if (request.op === "tips") work = tips(repo).then((list) => ({ ok: true, tips: list }));
    else if (request.op === "submit") work = submit(socket, repo, Number(request.bundle), rest);
    else return answer({ ok: false, error: `unknown op '${String(request.op).slice(0, 40)}'` });
    void work
      .then(answer, (error: Error) => answer({ ok: false, error: error.message }))
      .finally(() => {
        socket.once("close", () => process.exit(0));
        setTimeout(() => process.exit(0), 5000).unref();
      });
  };
  socket.on("data", onData);
};

let server: ReturnType<typeof createServer>;
const main = async () => {
  fs.rmSync(REVIEWER.control, { force: true });
  // (The summary lock and kept summaries stay: the root's user restarts this service at will,
  // with one connection, and a restart that cleared them undid both, the review of the fixes.)
  for (const name of fs.readdirSync(REVIEWER.home))
    if (!["repos", "packs", "summaries", "summary.lock", "identities"].includes(name))
      fs.rmSync(path.join(REVIEWER.home, name), { recursive: true, force: true });
  prunePacks();
  // (A summary's identity outlives it only if its process was killed: gone after ten minutes.)
  try {
    for (const name of fs.readdirSync(path.join(REVIEWER.home, "identities"))) {
      const file = path.join(REVIEWER.home, "identities", name);
      if (Date.now() - (fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0) > 600_000)
        fs.rmSync(file, { force: true });
    }
  } catch {
    /* none yet */
  }
  const before = process.umask(0o111);
  // One connection per process: the first closes the door behind it.
  server = createServer({ allowHalfOpen: true }, (socket) => {
    server.close();
    handle(socket);
  });
  await new Promise<void>((resolve) => server.listen(REVIEWER.control, resolve));
  process.umask(before);
  log(`listening at ${REVIEWER.control}`);
};

/** `node reviewer.ts summary` (as this user, started by root for the host: review-ask.ts):
 *  one summary, the request on stdin, the answer on stdout, and the process ends. The root's
 *  user can neither ask this nor hold it up. */
const once = async () => {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  const request = JSON.parse(text || "{}") as Record<string, unknown>;
  const repo = parseRepo(request.repo);
  const onto = request.onto ?? null;
  if (
    !repo ||
    !isBranch(request.branch) ||
    !isCommit(request.commit) ||
    (onto !== null && !isCommit(onto))
  )
    throw new Error("a summary names a repository, a branch, a commit and onto");
  const branch = request.branch;
  const commit = request.commit;
  await written(
    JSON.stringify(await oneAtATime(() => summary(repo, branch, commit, onto as string | null))) +
      "\n",
  );
};
/** Written all the way out before the process ends. To a pipe, node writes asynchronously,
 *  and process.exit() then cut a large answer short: a 146 KB summary (a first push with a
 *  package-lock.json) reached the host as 146,175 bytes of unterminated JSON, and the
 *  approval page said the reviewer "could not be asked", showing lockfile text (dogfooding,
 *  2026-11-16). Every summary in the tests had fit in the pipe's buffer. */
const written = (text: string) =>
  new Promise<void>((resolve) => process.stdout.write(text, () => resolve()));

if (process.argv[1] && fs.realpathSync(process.argv[1]) === new URL(import.meta.url).pathname) {
  if (process.argv[2] === "summary")
    once().then(
      () => process.exit(0),
      async (error: Error) => {
        await written(JSON.stringify({ ok: false, error: error.message }) + "\n");
        process.exit(1);
      },
    );
  else void main();
}
