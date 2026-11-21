// The host's question to the reviewer (reviewer.ts), asked as root in the root VM through
// the host's own way in, never through the root's ordinary user (which could answer for it
// or hold it up). Root starts a reviewer process of its own for the one request, as the
// reviewer's user, from root's copy of the code.
//
//   node review-ask.ts        (as root; one AccountRequest line on stdin)
//
// The answer is shared/review-account.ts's stream, on stdout: what the reviewer is doing
// while it does it, then the one answer. There is no deadline here (R4): the reviewer works
// for as long as whoever asked holds the connection, and when it lets go (this process's
// stdout is closed, or it is told to stop), the reviewer is ended with everything it started.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { ACCOUNT_LINE_BYTES, accountLine, accountLines } from "../shared/review-account.ts";
import { REVIEWER } from "./layout.ts";
import { SETTINGS } from "./reviewer-packs.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Table } from "../../suede.nests/dsl.import.meta.vitest.ts";

/** FALLBACK, to remove when limits ticket 2 (#174) has landed: the one line the host before
 *  the stream is answered with (it asks with no `op`): the reviewer's own last line, if it is
 *  JSON's start, else why there is none. */
export const answerOf = (ran: {
  stdout?: string | null;
  stderr?: string | null;
  error?: Error;
}): string => {
  const line = (ran.stdout ?? "").trim().split("\n").pop() ?? "";
  return line.startsWith("{")
    ? line
    : JSON.stringify({
        ok: false,
        error: ran.error
          ? ran.error.message
          : `the reviewer ended without an answer: ${(ran.stderr ?? "").trim().slice(-200)}`,
      });
};

declare namespace answerOf {
  /** the summary is the reviewer's last line; what it logged before it is not passed on */
  export type Summary = Table<
    typeof answerOf,
    [
      [
        args: [ran: { stdout: 'reading objects\n{"ok":true,"commits":[]}\n'; stderr: "" }],
        expected: '{"ok":true,"commits":[]}',
      ],
    ]
  >;
  /** a reviewer that ended with no answer, or could not be started, is said so as an answer */
  export type NoSummary = Table<
    typeof answerOf,
    [
      [
        args: [ran: { stdout: "partial output"; stderr: "fatal: bad object\n" }],
        expected: '{"ok":false,"error":"the reviewer ended without an answer: fatal: bad object"}',
      ],
      [
        args: [
          ran: {
            stdout: null;
            stderr: null;
            error: { name: "Error"; message: "spawnSync runuser ENOENT" };
          },
        ],
        expected: '{"ok":false,"error":"spawnSync runuser ENOENT"}',
      ],
    ]
  >;
}

/** The request: the first line on stdin (the host before the stream wrote one JSON object
 *  and no newline). A request is a few names: past 64 KiB it is not one. */
const REQUEST_BYTES = 64 * 1024;
const requested = async (): Promise<string> => {
  let text = "";
  for await (const chunk of process.stdin) {
    text += chunk;
    if (text.includes("\n") || text.length > REQUEST_BYTES) break;
  }
  return text.split("\n")[0]!.slice(0, REQUEST_BYTES);
};

/** How long the reviewer is given to end its own git when its asker has gone (it ends the
 *  groups git's runs make of their own: shared/run.ts), before all of it is killed. */
const GRACE_MS = 2_000;

const main = async () => {
  const asked = await requested();
  let request: unknown = null;
  try {
    request = JSON.parse(asked);
  } catch {
    /* the reviewer says it is not a request */
  }
  // FALLBACK (above): a request with no `op` is the host's before the stream.
  const old = !(typeof request === "object" && request !== null && "op" in request);
  // The reviewer's settings (reviewer-packs.ts), which root's environment may set: nothing
  // else of root's environment reaches it.
  const settings = SETTINGS.filter((s) => process.env[s.env]).map(
    (s) => `${s.env}=${process.env[s.env]}`,
  );
  // A process group of its own (and a session): ended whole when the asker goes away. Killed
  // alone, runuser left node and its git running (the independent review of #169). Low
  // priority: the root VM's keyring and pushers come first.
  const child = spawn(
    "runuser",
    [
      "-u",
      REVIEWER.user,
      "--",
      "env",
      "-i",
      "PATH=/usr/local/bin:/usr/bin:/bin",
      "LANG=C.UTF-8",
      `HOME=${REVIEWER.home}`,
      ...settings,
      "nice",
      "-n",
      "10",
      "node",
      "--disable-warning=ExperimentalWarning",
      "/opt/desolate/proxy-code/root/reviewer.ts",
      old ? "summary" : "account",
    ],
    { detached: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  const group = (signal: NodeJS.Signals) => {
    try {
      if (child.pid) process.kill(-child.pid, signal);
    } catch {
      /* ended already */
    }
  };
  // Whatever way this process ends, the reviewer's does too.
  process.on("exit", () => group("SIGKILL"));
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    group("SIGTERM");
    setTimeout(() => process.exit(1), GRACE_MS);
  };
  // The asker went away: its end of stdout closed (a write fails), or it said so.
  process.stdout.on("error", stop);
  for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(name, stop);
  let failed: Error | undefined;
  child.on("error", (error) => (failed = error));
  child.stdin.on("error", () => {});
  child.stdin.end(`${asked}\n`);
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    // Its own words are the host's to see (it logs there, never on stdout).
    process.stderr.write(chunk);
    stderr = (stderr + chunk.toString()).slice(-2000);
  });
  const write = (text: string) =>
    new Promise<void>((resolve) => process.stdout.write(text, () => resolve()));
  if (!old) {
    // Line by line, as the reviewer writes them: so what reaches the host is always the
    // stream's lines, ending in one answer, whatever the reviewer did (accountLines).
    for await (const line of accountLines(child.stdout)) {
      if (stopping) return;
      await write(accountLine(line));
      if (!("progress" in line)) break;
    }
    process.exit(0);
  }
  // FALLBACK (above): progress passed on as it comes (the host before the stream reads only
  // the last line), then the one answer.
  let partial = "";
  let last = "";
  for await (const chunk of child.stdout) {
    if (stopping) return;
    const lines = (partial + (chunk as Buffer).toString()).split("\n");
    partial = lines.pop()!;
    for (const line of lines)
      if (line.startsWith('{"progress":')) await write(`${line}\n`);
      else if (line.trim()) last = line;
    if (Buffer.byteLength(partial) > ACCOUNT_LINE_BYTES) break;
  }
  await write(`${answerOf({ stdout: `${last}\n${partial}`, stderr, error: failed })}\n`);
  process.exit(0);
};

// Run by the host as root (host/daemon.ts: node with this file's path, the request on stdin);
// imported, it does nothing.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === new URL(import.meta.url).pathname)
  await main();
