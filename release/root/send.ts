// The one place a root clone's commits leave for the remote. Both ways a person pushes come
// here: `desolate push` on the host (push.ts) and a raw `git push origin` in the root's
// terminal (git-remote-desolate-push.ts). By the time this runs, the keyring holds an
// approval the person gave ON THE HOST for exactly this repository, branch and commit, and
// for what the remote's branch is now (`onto`).
//
// This user does not push. It cannot reach a write key at all (the independent audit's F6:
// it is the user that parses what domains send). It hands the pusher (root/pusher.ts, a user
// of its own) the approval's id, the reviewer's pack, and the LFS objects the remote lacks.
// The pusher asks the keyring what that id names, and asks the forge for that one ref update
// and no other; it reads nothing of what this sends (the pack goes to the forge as bytes),
// and sends it only if it is the pack the person approved. This user no longer makes the
// pack: when it did, it could have put any object in it (#165).
import * as fs from "node:fs";
import { connect } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { Repo } from "../shared/names.ts";
import { clonePath, PUSHER } from "./layout.ts";
import { packFor } from "./review-client.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type {
  Call,
  Expect,
  Given,
  Invoke,
  Throws,
} from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { attemptsThat } from "../.harness/root-retry.ts";

type Failed = { error: string; moved: boolean };

/** One push handed over: the header line, then each file's bytes; the pusher's answer. */
const handOver = (
  header: Record<string, unknown>,
  files: string[],
): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const socket = connect(PUSHER.control);
    let answer = "";
    let failure: NodeJS.ErrnoException | null = null;
    let connected = false;
    let done = false;
    const finish = (value: Record<string, unknown> | Error) => {
      if (done) return;
      done = true;
      socket.destroy();
      if (value instanceof Error) reject(Object.assign(value, { connected }));
      else resolve(value);
    };
    // An early answer (a refusal) can come while the pack is still going, and the write
    // then fails: the answer is what counts, so the failure waits for the close.
    socket.on("error", (error: NodeJS.ErrnoException) => (failure = error));
    socket.on("data", (chunk) => {
      answer += chunk.toString();
      const end = answer.indexOf("\n");
      if (end < 0) return;
      try {
        finish(JSON.parse(answer.slice(0, end)) as Record<string, unknown>);
      } catch {
        finish(new Error("the pusher's answer was not JSON"));
      }
    });
    socket.on("close", () =>
      finish(failure ?? new Error("the pusher closed the connection without an answer")),
    );
    socket.on("connect", async () => {
      connected = true;
      socket.write(JSON.stringify(header) + "\n");
      for (const file of files)
        for await (const chunk of fs.createReadStream(file)) {
          if (done || socket.destroyed) return;
          if (!socket.write(chunk))
            await new Promise(
              (resolve) => (socket.once("drain", resolve), socket.once("close", resolve)),
            );
        }
    });
  });

/** The pusher is one push per process (pusher.ts): a moment between pushes, it is starting.
 *  Asked again only when the push never reached it: one that did may have claimed the
 *  approval (and each approval is pushed once). */
const RETRY = new Set(["ENOENT", "ECONNREFUSED"]);
const withPusher = async <T>(attempt: () => Promise<T & { busy?: unknown }>): Promise<T> => {
  for (const until = Date.now() + 60_000; ;) {
    try {
      const result = await attempt();
      if (result.busy !== true || Date.now() > until) return result;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (!RETRY.has(code) || (error as { connected?: boolean }).connected || Date.now() > until)
        throw new Error(`the pusher: ${(error as Error).message}; desolate doctor`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
};

declare namespace withPusher {
  type Starting = Invoke<
    typeof attemptsThat,
    [outcomes: [{ fails: "ENOENT" }, { fails: "ECONNREFUSED" }, { ok: true }]]
  >;
  /** a pusher that is starting (no socket yet, or not listening yet) is asked again */
  export type Starts = Given<
    Starting,
    [
      Expect<
        Invoke<typeof withPusher<Record<string, unknown>>, [attempt: Starting["attempt"]]>,
        "=",
        { ok: true }
      >,
      Expect<Call<Starting, "calls">, "=", 3>,
    ]
  >;
  type Occupied = Invoke<
    typeof attemptsThat,
    [outcomes: [{ ok: false; busy: true; error: "another push is under way" }, { ok: true }]]
  >;
  /** one that is busy with the push before this one is asked again */
  export type Busy = Given<
    Occupied,
    [
      Expect<
        Invoke<typeof withPusher<Record<string, unknown>>, [attempt: Occupied["attempt"]]>,
        "=",
        { ok: true }
      >,
      Expect<Call<Occupied, "calls">, "=", 2>,
    ]
  >;
  type Reached = Invoke<
    typeof attemptsThat,
    [outcomes: [{ fails: "ECONNREFUSED"; connected: true }, { ok: true }]]
  >;
  /** never once the request reached it: the pusher may have claimed the approval, and each
   *  approval is pushed once. Said, with what to run */
  export type NotTwice = Given<
    Reached,
    [
      Throws<
        Invoke<typeof withPusher<Record<string, unknown>>, [attempt: Reached["attempt"]]>,
        "the pusher: connect ECONNREFUSED; desolate doctor"
      >,
      Expect<Call<Reached, "calls">, "=", 1>,
    ]
  >;
  type Denied = Invoke<typeof attemptsThat, [outcomes: [{ fails: "EACCES" }, { ok: true }]]>;
  /** and a failure that is not "starting" is not waited out */
  export type NotStarting = Given<
    Denied,
    [
      Throws<
        Invoke<typeof withPusher<Record<string, unknown>>, [attempt: Denied["attempt"]]>,
        "the pusher: connect EACCES; desolate doctor"
      >,
      Expect<Call<Denied, "calls">, "=", 1>,
    ]
  >;
}

/** Returns null when the remote took it, or why it did not. The pusher pushes what the
 *  approval names, whatever this sends; what this sends is what makes that possible, and the
 *  pusher takes nothing else: the pack desolate's reviewer made of the approved commits (its
 *  digest is in the approval), and of the LFS objects those commits point to, the ones this
 *  clone holds. */
export const send = async (
  repo: Repo,
  approval: string,
  push: { pack: string },
): Promise<Failed | null> => {
  const clone = clonePath(repo);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "desolate-send-"));
  try {
    const pack = path.join(work, "push.pack");
    let made: { pack: string; size: number; lfs: string[] };
    try {
      made = await packFor(repo, push.pack, pack);
    } catch (error) {
      return {
        error: `the reviewer has no pack for this push (${(error as Error).message}), so nothing was pushed`,
        moved: false,
      };
    }
    // LFS objects the remote lacks and this clone holds (what came with offers).
    const files: string[] = [];
    const lfs: { oid: string; size: number }[] = [];
    for (const oid of made.lfs) {
      if (!/^[0-9a-f]{64}$/.test(oid)) continue;
      const file = path.join(
        clone,
        ".git",
        "lfs",
        "objects",
        oid.slice(0, 2),
        oid.slice(2, 4),
        oid,
      );
      if (!fs.existsSync(file)) continue;
      lfs.push({ oid, size: fs.statSync(file).size });
      files.push(file);
    }
    if (lfs.length > 0) process.stderr.write(`uploading ${lfs.length} LFS object(s)\n`);
    files.push(pack);
    const reply = await withPusher(() =>
      handOver(
        { op: "push", approval, pack: fs.statSync(pack).size, lfs, lfsListed: made.lfs },
        files,
      ),
    );
    if (reply.ok === true) return null;
    return {
      error: String(reply.error ?? "the pusher refused the push"),
      moved: reply.moved === true,
    };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
};
