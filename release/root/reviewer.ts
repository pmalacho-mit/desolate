// The reviewer: what a push would send, worked out by a user that is not the root's own
// (desolate-reviewer), for the approval page and terminal (host/approve-web.ts).
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
//     the pack's bytes: a pack an account made and kept, by its sha256 (which the approval
//     names), for send.ts to carry
// And for the host, not on the socket: `node reviewer.ts account`, started by root
// (review-ask.ts) as this user, one request per process: shared/review-account.ts's
// AccountRequest on stdin, its AccountLines on stdout.
//
// Its parts: reviewer-git.ts (how git runs here), reviewer-packs.ts (the packs a push sends),
// reviewer-account.ts (the account of a push, its pages and diffs).
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import * as path from "node:path";
import { formatBytes, over } from "../shared/limits.ts";
import { isCommit, parseRepo } from "../shared/names.ts";
import type { Repo } from "../shared/names.ts";
import { accountLine } from "../shared/review-account.ts";
import { printable } from "../shared/text.ts";
import { bundleRefusal } from "./intake.ts";
import { REVIEWER } from "./layout.ts";
import { answer, livePacks, oldAnswer } from "./reviewer-account.ts";
import { BUNDLE_REF, ensureRepo, gitOk, log, repoDir } from "./reviewer-git.ts";
import { prunePacks, storedPack } from "./reviewer-packs.ts";
import type { Say } from "./reviewer-packs.ts";

const LIMIT = {
  /** A request line on the socket, before its bundle's bytes: a few names and a number. */
  header: 64 * 1024,
  /** A bundle's bytes come from the root's user, which is not trusted to send them at all:
   *  one that sends nothing for a minute is not waited for. */
  idleMs: 60_000,
  /** The refs one bundle may name: the review ref and the clone's view of the remote's
   *  branches. Each is a refspec git fetch matches against every ref of the bundle (one by
   *  one: twice as many refs is four times the work, on the root VM's few cores), and a
   *  bundle's header is the root's user's to write. Ten thousand branches is a remote far
   *  past any a person keeps; review-client.ts sends only those the reviewer lacks. */
  refs: 10_000,
} as const;

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

/** The disk free under the reviewer's home, in bytes. */
const free = () => {
  const disk = fs.statfsSync(REVIEWER.home);
  return disk.bavail * disk.bsize;
};

const submit = async (socket: Socket, repo: Repo, size: number, rest: Buffer) => {
  if (!Number.isSafeInteger(size) || size < 1)
    return { ok: false, error: "a bundle is a whole number of bytes" };
  // What bounds a bundle is the disk that holds it: received, then stored as a pack, it takes
  // twice its size (the root's user sends it, and is not trusted to send a sensible one). Not
  // the forge's push size: the first bundle of a repository is its whole history.
  const room = free();
  if (size * 2 > room)
    return {
      ok: false,
      error: `the bundle is ${formatBytes(size)}, and the reviewer's disk has ${formatBytes(room)} free: it needs twice the bundle's size`,
    };
  const dir = ensureRepo(repo);
  const file = path.join(REVIEWER.home, `incoming-${randomBytes(8).toString("hex")}.bundle`);
  try {
    await receive(socket, rest, size, file);
    const heads = (await gitOk(dir, ["bundle", "list-heads", file]))
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(" ") as [string, string]);
    const odd = heads.find(([id, ref]) => !isCommit(id) || !BUNDLE_REF.test(ref ?? ""));
    if (heads.length === 0 || odd)
      return {
        ok: false,
        error: `a review bundle carries the clone's review ref and its origin/* refs, and nothing else${odd ? `: not ${printable(odd[1] ?? odd[0], 300)}` : ""}`,
      };
    if (heads.length > LIMIT.refs)
      return {
        ok: false,
        error: over("the bundle's list of refs", LIMIT.refs, heads.length, "refs"),
      };
    // Every object is checked before any of it is taken (git's own fsck, strictly): a fetch
    // from a bundle checks nothing before git 2.46, whatever fetch.fsckObjects says
    // (intake.ts), and an object fsck refuses (a commit message with a NUL in it, which git
    // shows only up to the NUL) would ride in the pack a person approves unseen (the
    // independent review of limits 01). Then it is the reviewer's only under a ref named by
    // its own id.
    const refused = await bundleRefusal(file, dir);
    if (refused) return { ok: false, error: `the bundle's objects are refused: ${refused}` };
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
        // (On stdin: a repository of many branches is many refspecs.)
        "--stdin",
        file,
      ],
      { input: once.map(([id, ref]) => `+${ref}:refs/seen/${id}`).join("\n") + "\n" },
    );
    return { ok: true };
  } finally {
    fs.rmSync(file, { force: true });
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
    const reply = (value: unknown) => socket.end(JSON.stringify(value) + "\n");
    let request: Record<string, unknown>;
    try {
      request = JSON.parse(head.subarray(0, end).toString("utf8")) as Record<string, unknown>;
    } catch {
      return reply({ ok: false, error: "not a request" });
    }
    if (request.op === "ping") return reply({ ok: true });
    const repo = parseRepo(request.repo);
    if (!repo) return reply({ ok: false, error: "not a repository" });
    // A pack an account made, by its sha256: its header line, then its bytes. Nothing is made
    // here: only the host's account makes one.
    if (request.op === "pack") {
      const kept = typeof request.pack === "string" ? storedPack(repo, request.pack) : null;
      if (!kept)
        return reply({
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
    else return reply({ ok: false, error: `unknown op '${printable(request.op, 40)}'` });
    void work
      .then(reply, (error: Error) => reply({ ok: false, error: error.message }))
      .finally(() => {
        socket.once("close", () => process.exit(0));
        setTimeout(() => process.exit(0), 5000).unref();
      });
  };
  socket.on("data", onData);
};

/** What is in the reviewer's home, and stays when its service starts again: the root's user
 *  restarts this service at will, with one connection, and a restart that cleared the
 *  account lock or the kept accounts undid both (the review of the fixes). The lock's
 *  siblings (shared/lock.ts: `summary.lock.new-<id>` and the like) are its own. */
const KEPT = ["repos", "packs", "accounts", "identities"];
const kept = (name: string) => KEPT.includes(name) || name.startsWith("summary.lock");

let server: ReturnType<typeof createServer>;
const main = async () => {
  fs.rmSync(REVIEWER.control, { force: true });
  for (const name of fs.readdirSync(REVIEWER.home))
    if (!kept(name)) fs.rmSync(path.join(REVIEWER.home, name), { recursive: true, force: true });
  prunePacks(livePacks());
  // (An account's identity outlives it only if its process was killed: gone after ten minutes.)
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

/** How often a reviewer working for the host says what it is doing when nothing new has
 *  happened: its words are how its reader is known to be there still (when the reader has
 *  gone, writing fails, and the work ends), and how the person sees it has not stopped. */
const SAYING_MS = 5_000;

/** The request, as root wrote it on stdin: its first line (review-ask.ts writes one line, the
 *  host before it wrote a JSON object and ended), at most LIMIT.header. */
const request = async (): Promise<unknown> => {
  process.stdin.setEncoding("utf8");
  let text = "";
  for await (const chunk of process.stdin) {
    text += chunk;
    if (text.includes("\n") || text.length > LIMIT.header) break;
  }
  try {
    return JSON.parse(text.split("\n")[0] || "{}");
  } catch {
    return null;
  }
};

/** `node reviewer.ts account` (as this user, started by root for the host: review-ask.ts):
 *  one request, and its answer as shared/review-account.ts's lines: progress while it works,
 *  then the one answer, and the process ends. The root's user can neither ask this nor hold
 *  it up. `node reviewer.ts summary` is the FALLBACK for the host before the stream: the
 *  same progress lines, and then, as the last line, the one JSON object it reads. */
const once = async (old: boolean) => {
  // Its reader gone (review-ask.ts ended: whoever asked went away), so is the work. What git
  // it was running is ended by review-ask.ts with this process's group, or, when review-ask
  // itself was killed, by its own next write to this process, which has gone.
  process.stdout.on("error", () => process.exit(1));
  let last: Parameters<Say>[0] = { phase: "starting" };
  let said = 0;
  const say: Say = (progress) => {
    last = progress;
    said = Date.now();
    process.stdout.write(accountLine({ progress }));
  };
  setInterval(() => Date.now() - said >= SAYING_MS && say(last), 1000).unref();
  say(last);
  const asked = await request();
  let line: string;
  try {
    line = old
      ? `${JSON.stringify(await oldAnswer((asked ?? {}) as Record<string, unknown>, say))}\n`
      : accountLine(await answer(asked, say));
  } catch (error) {
    const why = (error as Error).message;
    line = old ? `${JSON.stringify({ ok: false, error: why })}\n` : accountLine({ error: why });
  }
  await written(line);
};
/** Written all the way out before the process ends. To a pipe, node writes asynchronously,
 *  and process.exit() then cut a large answer short: a 146 KB summary (a first push with a
 *  package-lock.json) reached the host as 146,175 bytes of unterminated JSON, and the
 *  approval page said the reviewer "could not be asked", showing lockfile text (dogfooding,
 *  2026-11-16). Every summary in the tests had fit in the pipe's buffer. */
const written = (text: string) =>
  new Promise<void>((resolve) => process.stdout.write(text, () => resolve()));

if (process.argv[1] && fs.realpathSync(process.argv[1]) === new URL(import.meta.url).pathname) {
  if (process.argv[2] === "account" || process.argv[2] === "summary")
    once(process.argv[2] === "summary").then(
      () => process.exit(0),
      () => process.exit(1),
    );
  else void main();
}
