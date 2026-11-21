// The root's user's side of the reviewer (reviewer.ts): before it asks a person to approve a
// push, it sends the reviewer what the reviewer needs to say what the push is. That is
// all it can do there: what the summary says, the reviewer works out from commit ids the
// host gives it.
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { connect } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { repoId } from "../shared/names.ts";
import type { Repo } from "../shared/names.ts";
import { git } from "./git.ts";
import { ask } from "./keyring-client.ts";
import { clonePath, REVIEWER } from "./layout.ts";
import { BUNDLE_REF } from "./reviewer-git.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type {
  Call,
  Expect,
  Given,
  Invoke,
  Throws,
} from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { attemptsThat } from "../.harness/root-retry.ts";

const RETRY = new Set(["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE"]);
/** The reviewer is one request per process: between two, it is starting. */
export const withReviewer = async <T>(attempt: () => Promise<T>): Promise<T> => {
  for (const until = Date.now() + 30_000; ;) {
    try {
      return await attempt();
    } catch (error) {
      if (!RETRY.has((error as NodeJS.ErrnoException).code ?? "") || Date.now() > until)
        throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
};

declare namespace withReviewer {
  type Starting = Invoke<
    typeof attemptsThat,
    [outcomes: [{ fails: "ENOENT" }, { fails: "ECONNRESET" }, { tips: [] }]]
  >;
  /** between two requests the reviewer is starting: a missing socket, or one that drops the
   *  connection, is asked again */
  export type Starts = Given<
    Starting,
    [
      Expect<Invoke<typeof withReviewer, [attempt: Starting["attempt"]]>, "=", { tips: [] }>,
      Expect<Call<Starting, "calls">, "=", 3>,
    ]
  >;
  type Denied = Invoke<typeof attemptsThat, [outcomes: [{ fails: "EACCES" }, { tips: [] }]]>;
  /** a failure that is not that is the caller's to report, at once */
  export type NotStarting = Given<
    Denied,
    [
      Throws<Invoke<typeof withReviewer, [attempt: Denied["attempt"]]>, "connect EACCES">,
      Expect<Call<Denied, "calls">, "=", 1>,
    ]
  >;
}

const handOver = (
  header: Record<string, unknown>,
  file: string,
): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const socket = connect(REVIEWER.control);
    let answer = "";
    let done = false;
    const finish = (value: Record<string, unknown> | Error) => {
      if (done) return;
      done = true;
      socket.destroy();
      if (value instanceof Error) reject(value);
      else resolve(value);
    };
    socket.on("error", finish);
    socket.on("data", (chunk) => {
      answer += chunk.toString();
      const end = answer.indexOf("\n");
      if (end >= 0)
        try {
          finish(JSON.parse(answer.slice(0, end)) as Record<string, unknown>);
        } catch {
          finish(new Error("the reviewer's answer was not JSON"));
        }
    });
    socket.on("close", () =>
      finish(new Error("the reviewer closed the connection without an answer")),
    );
    socket.on("connect", async () => {
      socket.write(JSON.stringify(header) + "\n");
      for await (const chunk of fs.createReadStream(file))
        if (!socket.write(chunk)) await new Promise((r) => socket.once("drain", r));
    });
  });

/** Send the reviewer the commit and what the remote has (as the mirror saw it), less what it
 *  holds already. Returns why not, or null. A reviewer that is down is not a reason to stop
 *  a push: the page says it could not say what the push is. */
export const submitForReview = async (repo: Repo, commit: string): Promise<string | null> => {
  const clone = clonePath(repo);
  try {
    const held = await withReviewer(() =>
      ask(REVIEWER.control, { op: "tips", repo: repoId(repo) }, 30_000),
    );
    const have: string[] = [];
    for (const tip of Array.isArray(held.tips) ? (held.tips as string[]) : [])
      if ((await git(clone, ["cat-file", "-e", `${tip}^{commit}`])).code === 0) have.push(tip);
    const ref = `refs/desolate/review/${randomBytes(8).toString("hex")}`;
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "desolate-review-"));
    try {
      await git(clone, ["update-ref", ref, commit]);
      const bundle = path.join(work, "review.bundle");
      // The clone's view of the remote's branches, those the reviewer takes (BUNDLE_REF): one
      // it does not is left out, and the account says some branches were not sent, rather
      // than the whole push going without one. On stdin: a remote of many branches is many.
      const remotes = (
        await git(clone, ["for-each-ref", "--format=%(refname)", "refs/remotes/origin"])
      ).stdout
        .split("\n")
        .filter((name) => BUNDLE_REF.test(name));
      // No deadline (R4): the first bundle of a repository is its whole history, and the
      // push it is for waits for it.
      const made = await git(clone, ["bundle", "create", "--quiet", bundle, "--stdin"], {
        input: [ref, ...remotes, ...have.map((id) => `^${id}`)].join("\n") + "\n",
      });
      if (made.code !== 0)
        return /empty bundle/i.test(made.stderr)
          ? null
          : `cannot bundle for the reviewer: ${made.stderr.trim().split("\n").pop()}`;
      const reply = await withReviewer(() =>
        handOver({ op: "submit", repo: repoId(repo), bundle: fs.statSync(bundle).size }, bundle),
      );
      return reply.ok === true ? null : String(reply.error);
    } finally {
      await git(clone, ["update-ref", "-d", ref]).catch(() => {});
      fs.rmSync(work, { recursive: true, force: true });
    }
  } catch (error) {
    return (error as Error).message;
  }
};

/** A pack the reviewer made and keeps (reviewer.ts, `prepare`), by its sha256, into `file`, and
 *  what it says the push sends. The root's user carries it to the pusher and can change
 *  nothing in it: the approval names its digest. */
export const packFor = (
  repo: Repo,
  pack: string,
  file: string,
): Promise<{ pack: string; size: number; lfs: string[] }> =>
  withReviewer(
    () =>
      new Promise((resolve, reject) => {
        const socket = connect(REVIEWER.control);
        let head: Buffer = Buffer.alloc(0);
        let header: { pack: string; size: number; lfs: string[] } | null = null;
        let out: number | null = null;
        let left = 0;
        let done = false;
        const finish = (error?: Error) => {
          if (done) return;
          done = true;
          socket.destroy();
          if (out !== null) fs.closeSync(out);
          if (error) reject(error);
          else resolve(header!);
        };
        const take = (chunk: Buffer) => {
          const part = chunk.subarray(0, left);
          if (part.length) fs.writeSync(out!, part);
          left -= part.length;
          if (left === 0) finish();
        };
        socket.on("error", (error) => finish(error));
        socket.on("close", () =>
          finish(new Error("the reviewer closed the connection before the pack had come")),
        );
        socket.on("data", (chunk: Buffer) => {
          if (header) return take(chunk);
          head = Buffer.concat([head, chunk]);
          const end = head.indexOf(10);
          if (end < 0)
            return head.length > 1024 * 1024 ? finish(new Error("no answer")) : undefined;
          let said: Record<string, unknown>;
          try {
            said = JSON.parse(head.subarray(0, end).toString("utf8")) as Record<string, unknown>;
          } catch {
            return finish(new Error("the reviewer's answer was not JSON"));
          }
          if (said.ok !== true) return finish(new Error(String(said.error ?? "no pack")));
          if (
            typeof said.pack !== "string" ||
            !Number.isInteger(said.size) ||
            (said.size as number) < 1 ||
            !Array.isArray(said.lfs)
          )
            return finish(new Error("the reviewer's answer was not a pack's"));
          header = { pack: said.pack, size: said.size as number, lfs: said.lfs as string[] };
          out = fs.openSync(file, "w", 0o600);
          left = header.size;
          take(head.subarray(end + 1));
        });
        socket.on("connect", () =>
          socket.write(JSON.stringify({ op: "pack", repo: repoId(repo), pack }) + "\n"),
        );
      }),
  );
