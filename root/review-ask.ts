// The host's question to the reviewer (reviewer.ts), asked as root in the root VM through
// the host's own way in, never through the root's ordinary user (which could answer for it
// or hold it up). Root starts a reviewer process of its own for the one summary, as the
// reviewer's user, from root's copy of the code.
//
//   node review-ask.ts        (as root; {"repo","branch","commit","onto"} on stdin)
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { REVIEWER } from "./layout.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Table } from "../../suede.nests/dsl.import.meta.vitest.ts";

/** The one line the host is answered with: the reviewer's own last line, if it is JSON's
 *  start, else why there is none. */
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

const main = async () => {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  const ran = spawnSync(
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
      "node",
      "--disable-warning=ExperimentalWarning",
      "/opt/desolate/proxy-code/root/reviewer.ts",
      "summary",
    ],
    {
      input: text,
      encoding: "utf8",
      timeout: 100_000,
      killSignal: "SIGKILL",
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  process.stdout.write(answerOf(ran) + "\n");
};

// Run by the host as root (host/daemon.ts: node with this file's path, the request on stdin);
// imported, it does nothing.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === new URL(import.meta.url).pathname)
  await main();
