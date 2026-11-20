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
//   {"op":"pack","repo","commit","onto"} -> {"ok":true,"pack","size","lfs":[oid...]}\n then
//     the pack's bytes: the pack a summary made for that push and kept, for send.ts to carry
// And for the host, not on the socket: `node reviewer.ts summary`, started by root
// (review-ask.ts) as this user, one summary per process.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import * as path from "node:path";
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
  const identity = path.join(REVIEWER.home, `read-${randomBytes(6).toString("hex")}.pub`);
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
    child.on("close", (code) => resolve(code === 0 ? Buffer.concat(chunks) : null));
    child.stdin.end(input);
  });

/** The LFS objects a pack's commits point to: each blob in it that is a pointer (git-lfs's
 *  own form: a version line, the oid, the size, nothing else), by its oid. */
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
  const bytes = await gitBytes(dir, ["cat-file", "--batch"], small.join("\n") + "\n");
  if (!bytes) throw new Error("git cat-file failed on the push's own blobs");
  const oids = new Set<string>();
  // Each: "<id> blob <size>\n", the content, "\n".
  for (let at = 0; at < bytes.length;) {
    const end = bytes.indexOf(10, at);
    if (end < 0) break;
    const size = Number(bytes.subarray(at, end).toString("latin1").split(" ")[2]);
    const content = bytes.subarray(end + 1, end + 1 + size).toString("utf8");
    const match = POINTER.exec(content);
    if (match) oids.add(match[1]!);
    at = end + 1 + size + 1;
  }
  return [...oids].sort();
};

export type Sends = { pack: string; size: number; lfs: string[] };
const PACKS_MS = { fresh: 10 * 60_000, kept: 24 * 60 * 60_000 } as const;
const packsDir = (repo: Repo) => path.join(REVIEWER.home, "packs", repo.owner, repo.name);
const packKey = (commit: string, onto: string | null) => `${commit}-${onto ?? "none"}`;

/** The pack for pushing `tip` onto `onto`: made once, of the objects `tip` has that the
 *  remote's branches (`known`) do not, and kept with its sha256 and LFS ids. Asked again while
 *  it is fresh, the same pack (the approval may name it already); once it is ten minutes old,
 *  made again (the remote may have moved on). Two askers at once: the first one's is kept. */
const prepare = async (
  repo: Repo,
  dir: string,
  tip: string,
  onto: string | null,
  known: string[],
): Promise<Sends> => {
  const where = packsDir(repo);
  fs.mkdirSync(where, { recursive: true, mode: 0o700 });
  const record = path.join(where, `${packKey(tip, onto)}.json`);
  const kept = storedPack(repo, tip, onto);
  if (kept && Date.now() - kept.at < PACKS_MS.fresh) return kept.sends;
  const name = `${packKey(tip, onto)}-${randomBytes(6).toString("hex")}`;
  const file = path.join(where, `${name}.pack`);
  const out = fs.openSync(file, "w", 0o600);
  const hash = createHash("sha256");
  let size = 0;
  const packed = await new Promise<{ code: number; stderr: string }>((resolve) => {
    const child = spawn(
      "git",
      [
        "--git-dir",
        dir,
        ...hardened(dir),
        "pack-objects",
        "--stdout",
        "--revs",
        "--delta-base-offset",
        "--quiet",
      ],
      { env: env({ GIT_DIR: dir }), stdio: ["pipe", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      hash.update(chunk);
      size += chunk.length;
      fs.writeSync(out, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-2000)));
    child.on("close", (code) => resolve({ code: code ?? 1, stderr }));
    child.stdin.end([tip, ...known.map((id) => `^${id}`), ""].join("\n"));
  });
  fs.closeSync(out);
  if (packed.code !== 0) {
    fs.rmSync(file, { force: true });
    throw new Error(`cannot pack the push: ${packed.stderr.trim().split("\n").slice(-1)[0] ?? ""}`);
  }
  const sends: Sends = { pack: hash.digest("hex"), size, lfs: await pointersIn(dir, tip, known) };
  const temporary = path.join(where, `${name}.json`);
  fs.writeFileSync(
    temporary,
    JSON.stringify({ file: path.basename(file), at: Date.now(), ...sends }),
    {
      mode: 0o600,
    },
  );
  if (kept) fs.renameSync(temporary, record);
  else
    try {
      fs.linkSync(temporary, record);
      fs.rmSync(temporary, { force: true });
    } catch {
      // Another asker's came first: that one is the push's pack.
      fs.rmSync(temporary, { force: true });
      fs.rmSync(file, { force: true });
      const first = storedPack(repo, tip, onto);
      if (!first) throw new Error("the reviewer's pack went missing as it was kept");
      return first.sends;
    }
  return sends;
};

/** The kept pack for a push, if there is one: its file, and what it sends. */
const storedPack = (
  repo: Repo,
  tip: string,
  onto: string | null,
): { file: string; at: number; sends: Sends } | null => {
  try {
    const where = packsDir(repo);
    const kept = JSON.parse(
      fs.readFileSync(path.join(where, `${packKey(tip, onto)}.json`), "utf8"),
    ) as { file?: unknown; at?: unknown; pack?: unknown; size?: unknown; lfs?: unknown };
    if (
      typeof kept.file !== "string" ||
      !/^[0-9a-f]{40}-(none|[0-9a-f]{40})-[0-9a-f]{12}\.pack$/.test(kept.file) ||
      typeof kept.pack !== "string" ||
      !Number.isInteger(kept.size) ||
      !Array.isArray(kept.lfs) ||
      !Number.isFinite(kept.at)
    )
      return null;
    return {
      file: path.join(where, kept.file),
      at: kept.at as number,
      sends: { pack: kept.pack, size: kept.size as number, lfs: kept.lfs as string[] },
    };
  } catch {
    return null;
  }
};

/** Packs kept past a day, and files no record names: gone, when the reviewer starts. */
const prunePacks = () => {
  const root = path.join(REVIEWER.home, "packs");
  const dirs = (dir: string) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
    } catch {
      return [];
    }
  };
  for (const owner of dirs(root))
    for (const name of dirs(path.join(root, owner.name))) {
      const where = path.join(root, owner.name, name.name);
      const named = new Set<string>();
      for (const entry of fs.readdirSync(where)) {
        if (!entry.endsWith(".json")) continue;
        const file = path.join(where, entry);
        if (Date.now() - fs.statSync(file).mtimeMs > PACKS_MS.kept)
          fs.rmSync(file, { force: true });
        else
          try {
            named.add(
              String((JSON.parse(fs.readFileSync(file, "utf8")) as { file?: unknown }).file),
            );
          } catch {
            fs.rmSync(file, { force: true });
          }
      }
      for (const entry of fs.readdirSync(where))
        if (entry.endsWith(".pack") && !named.has(entry))
          fs.rmSync(path.join(where, entry), { force: true });
    }
};

/** The person's other choice: the commits pushed as one. Its tree is the commit's own, its
 *  parent is where the commit leaves the remote's history (what it builds on: `onto`, or the
 *  branch a new one starts from), and its author, committer and dates are the commit's. So
 *  the same push always squashes to the same commit, whoever asks. Its message: the first
 *  commit's subject, then every commit's. */
export type Squash = { commit: string; parent: string | null; count: number; message: string };
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
    .split("\n")
    .filter((line) => line !== "")
    .map((subject) => shown(subject, 200));
  const listed = subjects.slice(0, SQUASH_LISTED).map((s) => `- ${s}`);
  if (subjects.length > SQUASH_LISTED) listed.push(`- and ${subjects.length - SQUASH_LISTED} more`);
  const message = `${subjects[0] ?? "Squashed"}\n\nSquashed from ${count} commits:\n${listed.join("\n")}\n`;
  const [an, ae, ad, cn, ce, cd] = (
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
        GIT_AUTHOR_NAME: an ?? "",
        GIT_AUTHOR_EMAIL: ae ?? "",
        GIT_AUTHOR_DATE: ad ?? "",
        GIT_COMMITTER_NAME: cn ?? "",
        GIT_COMMITTER_EMAIL: ce ?? "",
        GIT_COMMITTER_DATE: cd ?? "",
      },
    },
  );
  // (git's own identity rules: an author it refuses, say an empty name, gets no squash.)
  if (made.code !== 0) return null;
  const id = made.stdout.trim();
  return isCommit(id) ? { commit: id, parent: parent || null, count, message } : null;
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
    ...new Set(touched.split(/[\x00\n]/).filter((name) => name !== "" && !net.has(name))),
  ].sort();
  const between = inBetween
    .map((raw) => ({ path: shown(raw, 300), ...(SENSITIVE.test(raw) ? { sensitive: true } : {}) }))
    .sort((a, b) => Number(Boolean(b.sensitive)) - Number(Boolean(a.sensitive)));
  // Each commit's own diff, when there is more than one: bounded as the net diff is.
  let eachDiff: string | undefined;
  let eachDiffCut = false;
  if (counted > 1 && !diffCut) {
    const text = await gitIn(
      dir,
      [
        "log",
        "-p",
        "--cc",
        "--reverse",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--no-show-signature",
        "--no-decorate",
        "--format=commit %H%n%n    %s%n",
        `--max-count=${LIMIT.commits}`,
        commit,
        ...known.map((id) => `^${id}`),
        "--",
      ],
      { timeoutMs: 120_000 },
    );
    if (text.code === 0) {
      eachDiffCut = text.stdout.length > DIFF_MOST.bytes || counted > LIMIT.commits;
      eachDiff = text.stdout.slice(0, DIFF_MOST.bytes);
    }
  }
  return {
    ok: true,
    ...(warnings.length ? { warnings } : {}),
    commits,
    more: Math.max(0, counted - commits.length),
    files: files.slice(0, cut),
    moreFiles: Math.max(0, files.length - cut),
    base,
    remote: now,
    fastForward,
    lfs,
    ...(diff !== undefined ? { diff } : {}),
    diffCut,
    sends,
    ...(squash ? { squash } : {}),
    between: between.slice(0, LIMIT.files),
    moreBetween: Math.max(0, between.length - LIMIT.files),
    ...(eachDiff !== undefined ? { eachDiff, eachDiffCut } : {}),
  };
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
    // The pack a push sends, as kept: its header line, then its bytes. Nothing is made here:
    // only the host's summary makes one, so what is sent is what the approval may name.
    if (request.op === "pack") {
      const onto = request.onto ?? null;
      const kept =
        isCommit(request.commit) && (onto === null || isCommit(onto))
          ? storedPack(repo, request.commit, onto as string | null)
          : null;
      if (!kept || !fs.existsSync(kept.file))
        return answer({
          ok: false,
          error: "the reviewer keeps no pack for that push: look at it on the approval page again",
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
  for (const name of fs.readdirSync(REVIEWER.home))
    if (name !== "repos" && name !== "packs")
      fs.rmSync(path.join(REVIEWER.home, name), { recursive: true, force: true });
  prunePacks();
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
  await written(
    JSON.stringify(await summary(repo, request.branch, request.commit, onto as string | null)) +
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
