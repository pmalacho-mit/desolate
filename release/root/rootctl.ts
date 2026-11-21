// The CLI channel (section 4.6): the host execs this in the root VM with one JSON request on
// stdin and reads one JSON reply on stdout. Progress goes to stderr. It runs as the root's
// unprivileged user, with no terminal: nothing reachable from here can approve a push.
//
// `node rootctl.ts serve`: the same, kept running (start.sh), on a socket only this user can
// open: a request is a line of JSON, progress comes back as {"progress"} lines and the
// answer as one {"reply"} line. It saves loading the root's code for every call (measured on
// the M1: 240 ms a call, 140 of them that). It answers {"stale": true} and ends when the
// root's code changed under it, and the host then asks the old way, with the new code.
import * as fs from "node:fs";
import { createServer } from "node:net";
import * as path from "node:path";
import { Refusal } from "../shared/exit.ts";
import { isRecord } from "../shared/json.ts";
import { ROOT } from "./layout.ts";
import { ops } from "./ops.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Given, Invoke } from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { aRegistry, emptyRoot } from "../.harness/root-state.ts";

export const SOCKET = path.join(ROOT.run, "rootctl", "rootctl.sock");

/** The most one request line may be, in bytes, before the connection is ended (R7: a hard bound on
 *  what the host's side writes to the socket). A request is an operation's name and its
 *  JSON arguments: the largest the host sends (a forge's known hosts, a domain's
 *  environment) is a few KiB, and a mebibyte is past any of them by far while still being
 *  nothing to hold. */
const REQUEST_MOST = 1 << 20;

/** One request, answered: shared by the one-shot and the service. */
const answer = async (
  request: unknown,
  progress: (line: string) => void,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> => {
  if (!isRecord(request) || typeof request.op !== "string")
    return { ok: false, error: "a request is {op, args}", fix: "", code: 64 };
  // Its own operations only: `ops[op]` alone also finds what every object inherits
  // ("constructor" ran `Object(args)` and answered ok: in-source tests, 2026-11-16).
  const op = Object.hasOwn(ops, request.op) ? ops[request.op] : undefined;
  if (!op)
    return { ok: false, error: `the root has no operation '${request.op}'`, fix: "", code: 64 };
  try {
    return {
      ok: true,
      result: await op(isRecord(request.args) ? request.args : {}, progress, signal),
    };
  } catch (error) {
    const refusal = error instanceof Refusal ? error : null;
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      fix: refusal?.fix ?? "",
      code: refusal?.code ?? 1,
    };
  }
};

declare namespace answer {
  type Fresh = Invoke<typeof emptyRoot>;
  type Quiet = typeof console.error;
  /** one of the fixed table's operations, by name, with its JSON arguments: its result */
  export type Answers = Given<
    [Fresh, Invoke<typeof aRegistry, [repos: { "acme/app": {} }]>],
    Expect<
      Invoke<typeof answer, [request: { op: "repo.list" }, progress: Quiet]>,
      "matches",
      { ok: true; result: [{ repo: "acme/app"; pushable: true }] }
    >
  >;
  /** a refusal comes back whole: what is wrong, what to run, the exit code a script sees */
  export type Refused = Given<
    Fresh,
    Expect<
      Invoke<
        typeof answer,
        [request: { op: "domain.show"; args: { slug: "../x" } }, progress: Quiet]
      >,
      "=",
      {
        ok: false;
        error: "'../x' is not a domain name";
        fix: "a domain name is a slug: lowercase letters, digits and single dashes, at most 40, starting with a letter or digit";
        code: 64;
      }
    >
  >;
  /** what is not a request, or names no operation the table has, is a usage error: the
   *  channel never carries a command line */
  export type NotOnTheTable = [
    Expect<
      Invoke<typeof answer, [request: null, progress: Quiet]>,
      "=",
      { ok: false; error: "a request is {op, args}"; fix: ""; code: 64 }
    >,
    Expect<
      Invoke<typeof answer, [request: { op: ["ping"] }, progress: Quiet]>,
      "=",
      { ok: false; error: "a request is {op, args}"; fix: ""; code: 64 }
    >,
    Expect<
      Invoke<typeof answer, [request: { op: "sh -c id" }, progress: Quiet]>,
      "=",
      { ok: false; error: "the root has no operation 'sh -c id'"; fix: ""; code: 64 }
    >,
  ];
  /** nor a name every object inherits: only the table's own operations are on it */
  export type Inherited = [
    Expect<
      Invoke<typeof answer, [request: { op: "constructor"; args: {} }, progress: Quiet]>,
      "=",
      { ok: false; error: "the root has no operation 'constructor'"; fix: ""; code: 64 }
    >,
    Expect<
      Invoke<typeof answer, [request: { op: "toString" }, progress: Quiet]>,
      "=",
      { ok: false; error: "the root has no operation 'toString'"; fix: ""; code: 64 }
    >,
    Expect<
      Invoke<typeof answer, [request: { op: "__proto__" }, progress: Quiet]>,
      "=",
      { ok: false; error: "the root has no operation '__proto__'"; fix: ""; code: 64 }
    >,
  ];
  /** an operation that fails without a refusal says so, with no fix and exit code 1 */
  export type Failed = Given<
    Fresh,
    Expect<
      Invoke<
        typeof answer,
        [request: { op: "repo.fetch"; args: { repo: "acme" } }, progress: Quiet]
      >,
      "=",
      { ok: false; error: "not a repository name (owner/repo): acme"; fix: ""; code: 1 }
    >
  >;
}

/** The newest change to the root's code: a few dozen stats, every request. */
const HERE = path.dirname(new URL(import.meta.url).pathname);
const codeTime = () => {
  let newest = 0;
  for (const dir of [HERE, path.join(HERE, "proxy"), path.join(HERE, "..", "shared")])
    try {
      for (const name of fs.readdirSync(dir))
        if (name.endsWith(".ts"))
          newest = Math.max(newest, fs.statSync(path.join(dir, name)).mtimeMs);
    } catch {
      /* gone: stale */
      return Infinity;
    }
  return newest;
};

const serve = () => {
  const started = codeTime();
  fs.mkdirSync(path.dirname(SOCKET), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(SOCKET), 0o700);
  fs.rmSync(SOCKET, { force: true });
  // Half-open: the host's side ends its request with EOF, and a socket that closed itself on
  // that (node's default) lost the answer of every operation slower than the EOF (found on
  // the M1: doctor's answer never came).
  const server = createServer({ allowHalfOpen: true }, (connection) => {
    connection.on("error", (error) => {
      process.stderr.write(`rootctl serve: a connection failed: ${error.message}\n`);
      connection.destroy();
    });
    let text = "";
    let bytes = 0;
    connection.on("data", async (chunk: Buffer) => {
      text += chunk;
      bytes += chunk.length;
      if (bytes > REQUEST_MOST) return connection.destroy();
      const end = text.indexOf("\n");
      if (end < 0) return;
      connection.removeAllListeners("data");
      if (codeTime() !== started) {
        connection.end(JSON.stringify({ stale: true }) + "\n");
        server.close();
        setTimeout(() => process.exit(0), 100);
        return;
      }
      let request: unknown = null;
      try {
        request = JSON.parse(text.slice(0, end));
      } catch {
        /* not JSON: answered as such */
      }
      // Taken: from here the host never asks again the old way (an operation must not run twice).
      connection.write(JSON.stringify({ accepted: true }) + "\n");
      // Whoever asked is waiting on this connection, and how long it waits is its own (R4):
      // when it goes, what was asked for is ended (an operation that takes the signal).
      const asker = new AbortController();
      connection.on("close", () => asker.abort(new Error("whoever asked went away")));
      const reply = await answer(
        request,
        (line) => connection.write(JSON.stringify({ progress: line }) + "\n"),
        asker.signal,
      );
      connection.end(JSON.stringify({ reply }) + "\n");
    });
  });
  server.listen(SOCKET, () => fs.chmodSync(SOCKET, 0o600));
};

const read = async () => {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
};

const main = async () => {
  let request: unknown;
  try {
    request = JSON.parse(await read());
  } catch {
    request = null;
  }
  process.stdout.write(
    JSON.stringify(await answer(request, (line) => process.stderr.write(`${line}\n`))) + "\n",
  );
};

// Run by the host (`node rootctl.ts`, a request on stdin) and by start.sh (`rootctl.ts serve`);
// imported, it does nothing.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === new URL(import.meta.url).pathname) {
  if (process.argv[2] === "serve") serve();
  else await main();
}
