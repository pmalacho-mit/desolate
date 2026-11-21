// The host daemon: one per stack, outside every VM (P5). Two jobs.
//
// THE FORWARDER (section 4.4). One listener per port on the host's 127.0.0.1, never another
// address. A port is published under the number it has inside the VM, with nothing declared:
// the daemon asks each workspace's own daemon what is listening. Several workspaces share a
// number BY NAME: each connection is routed by its HTTP Host or TLS SNI to the workspace
// that name belongs to, and a request that names no workspace gets 421 and reaches nothing.
// What has no name in its protocol (Postgres, Redis) reaches the first workspace that had
// the port; the others are asked to keep the number taken, so their servers move on.
// A port the host itself holds cannot be listened on: it is not forwarded, and `desolate
// ports` and the dashboard say so. Ports below 1024 are never forwarded.
//
// THE LINK. Each workspace's only way out is one stream to its own proxy in the root. The
// daemon owns the host end of it and carries each connection to that workspace's proxy and
// nowhere else: which link a connection arrived on is what attributes it.
import { formatBytes, over } from "../shared/limits.ts";
import { define, valueOf, whole } from "../shared/settings.ts";
import { CUT, failure, printable } from "../shared/text.ts";
import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as os from "node:os";
import type { Size } from "../shared/size.ts";
import * as fs from "node:fs";
import { connect, createServer } from "node:net";
import type { Server, Socket } from "node:net";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { refuse } from "../shared/exit.ts";
import { accept as acceptLink } from "../shared/link.ts";
import { hostArgv, SIGNED_KINDS, signedOf } from "../shared/actions.ts";
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { parseApproval, parseSigned } from "../shared/approval.ts";
import {
  APPROVE_HOSTNAME,
  GIT_HOSTNAME,
  parseRepo,
  devHostname,
  EDITOR,
  editorHostPort,
  ROOT_HOSTNAME,
  ROOT_UI,
} from "../shared/names.ts";
import { handler as approvePage } from "./approve-web.ts";
import { secretOps } from "./domains.ts";
import { handler as gitPage } from "./git-web.ts";
import { mint } from "./signin.ts";
import { hub, pusherEvent, stateEvents } from "./events.ts";
import { checkoutOffered, ensureGitClone, ensureGitVm, GIT_VM, watchGitOut } from "./git-vm.ts";
import type { Backend as ApprovalBackend } from "./approve-web.ts";
import { accountLines } from "../shared/review-account.ts";
import type { AccountLine, AccountRequest } from "../shared/review-account.ts";
import { isOldKey, oldAnswer, withOld } from "./review-fallback.ts";
import { statusDir } from "../shared/status.ts";
import type { WorkspacePlan } from "../shared/plan.ts";
import { sleep, waitFor } from "../shared/run.ts";
import { sniffSocket } from "../shared/sniff.ts";
import { guest, INSTANCE, paths, RELEASE_DIR } from "./paths.ts";
import { portHolder } from "./held-ports.ts";
import { retire, retiredAt } from "./retired.ts";
import { backend, ROOT_VM, rootctlBrief } from "./stack.ts";
import {
  editorAddress,
  editorTokenOf,
  folderFor,
  folderFrom,
  greetingGoes,
  inboundRoute,
  listenersFrom,
  notesOf,
  pagesRoute,
  portsView,
  rawOwnerFor,
  rawPortsOf,
  reservedFor,
  spokeAsBrowser,
  tokenEpochOf,
  unforwardedOf,
} from "./forward.ts";
import type { Checkouts, PortView } from "./forward.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type {
  Call,
  Expect,
  Given,
  Invoke,
  Mock,
  Mocked,
  Table,
} from "../../suede.nests/dsl.import.meta.vitest.ts";
import type {
  answerOf,
  answers,
  daemonAnswering,
  failsAtOnce,
  failsHalfway,
  keepLog,
  endsOf,
  numbered,
  readInPieces,
  setOf,
  shown,
  sixGiB,
  vmAnswering,
  wire,
} from "../.harness/host-daemon.ts";
import type { emptyHome, writeState } from "../.harness/home.ts";
import type { firstOf, stillRunning, vmRunning } from "../.harness/host-web.ts";
import type { all } from "../.harness/shared-review-account.ts";
import type { abortedIn } from "../.harness/shared-run.ts";
import type { repeated } from "../.harness/shared-bytes.ts";
import type { refusalOf } from "../.harness/refusal.ts";

const SOCKET = path.join(paths.state, "daemon.sock");
const PIDFILE = path.join(paths.state, "daemon.pid");
const LOG = path.join(paths.logs, "daemon.log");
const NODE = ["node", "--disable-warning=ExperimentalWarning"];

type Registered = { vm: string; domain: string; workspace: string; proxy: string | null };
type Entry = Registered & {
  listeners: Set<number>;
  reserved: Set<number>;
  link: Server | null;
  lastError: string;
  editorToken: string;
  editorTokenEpoch: number;
  devcontainer: string;
  folder: string;
  watchers: fs.FSWatcher[];
  /** Its listeners not forwarded for a bound's sake: below PORTS.min (`low`), a compose
   *  service's past its mirrors (`more`, the VM's count), past FORWARDS_MOST (`past`). */
  low: number[];
  more: number;
  past: number;
  /** Its connections out that its link refused (LINK_CONNECTIONS): how many, the last when,
   *  and when the daemon's log last said so. */
  refused: { count: number; at: string; logged: number };
};

/** A page's request that throws is that request's 500, logged: never the daemon's end (it
 *  carries every workspace's editor, ports and link). */
export const guarded =
  (
    log: (line: string) => void,
    page: (req: IncomingMessage, res: ServerResponse) => Promise<unknown>,
  ) =>
  (req: IncomingMessage, res: ServerResponse) =>
    void page(req, res).catch((error: unknown) => {
      log(`a page's request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent)
        res.writeHead(500, {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
        });
      res.end("desolate: that request failed; the daemon's log says why\n");
    });

declare namespace guarded {
  /** a page that fails is that request's 500, with the reason in the log and not on the page */
  export type FailsAtOnce = Expect<
    Invoke<
      typeof answerOf,
      [handler: Invoke<typeof guarded, [log: typeof keepLog, page: typeof failsAtOnce]>]
    >,
    "=",
    {
      status: 500;
      heads: 1;
      body: "desolate: that request failed; the daemon's log says why\n";
      ended: true;
      logged: ["a page's request failed: the root's state service is not there"];
    }
  >;
  /** a page that already began its answer is ended, not given a second head */
  export type FailsHalfway = Expect<
    Invoke<
      typeof answerOf,
      [handler: Invoke<typeof guarded, [log: typeof keepLog, page: typeof failsHalfway]>]
    >,
    "matches",
    {
      status: 200;
      heads: 1;
      body: "<p>halfdesolate: that request failed; the daemon's log says why\n";
      logged: ["a page's request failed: the reviewer went away"];
    }
  >;
  /** a page that answers is untouched, and nothing is logged */
  export type Answers = Expect<
    Invoke<
      typeof answerOf,
      [handler: Invoke<typeof guarded, [log: typeof keepLog, page: typeof answers]>]
    >,
    "=",
    { status: 200; heads: 1; body: "ok"; ended: true; logged: [] }
  >;
}

// ------------------------------------------------------------------ the daemon itself
/** What code this daemon runs: the host's and the shared files. An updated desolate means
 *  nothing to a daemon still running the old (a fix to the link's handshake, say). */
const codeOf = () => {
  const hash = createHash("sha256");
  for (const dir of ["host", "host/vm", "shared"])
    for (const name of fs
      .readdirSync(path.join(RELEASE_DIR, dir))
      .filter((n) => n.endsWith(".ts"))
      .sort())
      hash.update(name).update(fs.readFileSync(path.join(RELEASE_DIR, dir, name)));
  return hash.digest("hex").slice(0, 16);
};
const CODE = codeOf();

/** How long a client that has said nothing yet is held, on a forwarded port or the pages',
 *  before it is closed: as long as an HTTP server waits for a request's head (node's own,
 *  `headersTimeout`, is a minute). An idle bound against a browser (R4): one that
 *  preconnects a socket says its request on it within this, or closes it itself (Chrome lets
 *  an unused socket go after 10 s). */
const SILENT_MS = 60_000;
/** On a port known to speak without a name (forward.ts, rawPortsOf), how long a client's
 *  silence takes to mean that its server speaks first (a database's greeting): a client of
 *  such a protocol says nothing at all, so a short wait is a decision, not a cut. */
const SERVER_FIRST_MS = 400;
/** The most clients held silent at once, on every forwarded port and the pages' together:
 *  each is a socket of this daemon's, which carries every workspace. When full, the one
 *  that has waited longest goes, not the newest: a program of another user's opening silent
 *  sockets could otherwise lock the person out (decisions.md, the audit of 2026-11-16). */
const SILENT_MOST = 512;
/** How long a refused connection out is given to read its answer and close (openLink): a
 *  workspace's relay reads it at once. */
const REFUSED_MS = 5000;
/** The most connections at once in their handshake on one vz link's loopback port
 *  (openLink). Each costs a socket of this daemon's, not a session into the root, and any
 *  program of any user's can open them: so far above what a guest needs that a flood must
 *  open this many within the guest's own handshake to keep it off its link. */
const PROVING_MOST = 1024;

/** The most of one answer from the root's state service this host reads: a hard bound
 *  against the root's user, whose service parses what domains send (decisions.md, "the
 *  root's user's service is bounded"). The whole state is one answer (/host/state), and it
 *  grows with domains, offers and issues, so how near it is is said (`desolate doctor`,
 *  stateRoom): a state past it stops `desolate events` and the dashboard's actions. */
const STATE_ANSWER_BYTES = 16 * 1024 * 1024;

/** What one connection a link carries costs this Mac: a session into the root VM, which on
 *  Lima is a `limactl shell` of its own (83 MB, and 2 MB for its ssh: measured on the M1,
 *  2026-11-21, `footprint`). */
const LINK_CONNECTION_MIB = 85;

/** How many connections out one workspace has carried to its proxy at once. Past it, as many
 *  more wait their turn, and past those a connection is refused, saying so (linkVerdict). */
export const LINK_CONNECTIONS = define({
  name: "link.connections",
  env: "DESOLATE_LINK_CONNECTIONS",
  side: "host",
  default: () =>
    Math.min(256, Math.max(16, Math.floor(os.totalmem() / 1048576 / 8 / LINK_CONNECTION_MIB))),
  // Every session into the root VM is one of its sshd's, which allows 1000 on a connection
  // (root/start.sh, MaxSessions): no workspace may have more than that.
  parse: whole(1, 1000),
  why: "How many connections out of one workspace (its downloads, its installs) are carried to its proxy at once; as many more wait their turn, and past those one is refused. Each carried one is a session into the root VM, about 85 MB of this Mac's memory: by default an eighth of this Mac's memory's worth, from 16 to 256.",
});

/** What a workspace's link does with a connection out that has proved it is the workspace's:
 *  carry it, while fewer than `most` are carried; else have it wait its turn, while fewer
 *  than `most` wait; else refuse it. A connection waits for as long as its program does:
 *  the program's own patience, not a timer here (R4). */
const linkVerdict = (carried: number, waiting: number, most: number) =>
  carried < most ? "carry" : waiting < most ? "wait" : "refuse";

declare namespace linkVerdict {
  /** carried while there is room, then waiting as many again, then refused */
  export type Verdicts = Table<
    typeof linkVerdict,
    [
      [args: [carried: 0, waiting: 0, most: 48], expected: "carry"],
      [args: [carried: 47, waiting: 0, most: 48], expected: "carry"],
      [args: [carried: 48, waiting: 0, most: 48], expected: "wait"],
      [args: [carried: 48, waiting: 47, most: 48], expected: "wait"],
      [args: [carried: 48, waiting: 48, most: 48], expected: "refuse"],
    ]
  >;
}

/** What a refused connection out is answered: as its proxy refuses (an HTTP status and
 *  `X-Desolate-Reason`), which the workspace's relay (workspace/net/egress.ts) shows a
 *  plain-HTTP program as text. */
const linkRefusal = (most: number) => {
  const reason = `this workspace has ${most} connections out carried at once and ${most} more waiting their turn, the most it may (the setting link.connections; on the Mac: DESOLATE_LINK_CONNECTIONS=<n> desolate bootstrap)`;
  return `HTTP/1.1 503 Service Unavailable\r\nX-Desolate-Reason: ${reason}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`;
};

declare namespace linkRefusal {
  export type Refusal = Expect<
    Invoke<typeof linkRefusal, [most: 2]>,
    "=",
    "HTTP/1.1 503 Service Unavailable\r\nX-Desolate-Reason: this workspace has 2 connections out carried at once and 2 more waiting their turn, the most it may (the setting link.connections; on the Mac: DESOLATE_LINK_CONNECTIONS=<n> desolate bootstrap)\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
  >;
}

/** `desolate events` (events.ts): every event the daemon learns of, for whoever listens. */
const events = hub();

/** What the approval page needs of the stack. The list of waiting pushes is the root's
 *  user's (only each one's message is used, parsed on the host); what a push would send is
 *  the reviewer's, asked as root; the signature is this host's. */
/** The reviewer's answer to one request, as bytes: what root/review-ask.ts writes, asked as
 *  root in the root VM through the host's own way in. `ended`, once the bytes have run out:
 *  how its process ended and what it said of itself (stderr); null while it still runs. */
const reviewerAsked = (request: AccountRequest, signal?: AbortSignal) => {
  const argv = [...NODE, `${guest.release}/root/review-ask.ts`];
  // One line, and then the host's side of the input ends: what holds the reviewer to its
  // work is the answer's stream, which the host reads until it has the answer or goes away.
  const input = `${JSON.stringify(request)}\n`;
  let ended: Promise<{ code: number; stderr: string }> | null = null;
  let ranOut = false;
  async function* bytes(): AsyncGenerator<Uint8Array | string, void, void> {
    if (signal?.aborted) return;
    let child: ChildProcess;
    try {
      child = backend().spawn(ROOT_VM, argv, { root: true });
    } catch {
      // FALLBACK, until host/vm/lima.ts offers `spawn` as root in the root VM (limits ticket
      // 11, #183: this ticket's pull request has the exact change). With `exec` the answer
      // arrives when it is whole: no progress is seen on the way, and a request that is
      // dropped is not ended in the root. It is still not ended for being long (R4).
      const result = await backend().exec(ROOT_VM, argv, { root: true, input });
      ended = Promise.resolve({ code: result.code, stderr: result.stderr });
      ranOut = true;
      return void (yield result.stdout);
    }
    let stderr = "";
    ended = new Promise((resolve) => {
      child.once("error", (error) => resolve({ code: 127, stderr: stderr + error.message }));
      child.once("close", (code) => resolve({ code: code ?? 128, stderr }));
    });
    child.stderr?.on("data", (chunk) => {
      // The end of it is where a program says why it stopped; a reviewer that logs for an
      // hour is not held whole. What was dropped is marked (R1).
      stderr += chunk;
      if (stderr.length > 2 * REVIEWER_WORDS) stderr = `${CUT}\n${stderr.slice(-REVIEWER_WORDS)}`;
    });
    // Whoever asked went away: the connection is dropped, and the reviewer's end of it
    // closing is what stops the work there.
    const drop = () => child.kill();
    signal?.addEventListener("abort", drop, { once: true });
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
    try {
      for await (const chunk of child.stdout!) yield chunk as Buffer;
      ranOut = true;
    } catch {
      ranOut = true;
    } finally {
      signal?.removeEventListener("abort", drop);
      // Left before the stream ran out (it gave its answer; the reader went away): dropped.
      if (!ranOut) child.kill();
    }
  }
  return { bytes: bytes(), ended: () => (ranOut ? ended : null) };
};
/** What is kept of the reviewer's own words (its stderr) for an error, in characters: 64
 *  KiB of text is a long stack trace many times over. It is the host's memory this bounds,
 *  against a program in a VM. */
const REVIEWER_WORDS = 64 * 1024;
/** Where the whole of the last such error is kept (shared/text.ts, failure). */
const REVIEWER_FAILURE = path.join(paths.logs, "reviewer-failure.txt");
const keepFailure = (whole: string): string | null => {
  fs.mkdirSync(paths.logs, { recursive: true });
  fs.writeFileSync(REVIEWER_FAILURE, whole, { mode: 0o600 });
  return REVIEWER_FAILURE;
};

/** What desolate's reviewer in the root (root/reviewer.ts) says of a push, as it says it: the
 *  lines of its answer (shared/review-account.ts), progress while it works and then the one
 *  answer, which is the last thing given. The approval page shows them, and so do the
 *  terminal's prompts.
 *
 *  There is no deadline here (R4): the reviewer works for as long as whoever asked reads
 *  this. When `signal` fires (the push left the list, the person went away) the connection
 *  is dropped, and nothing more is given: no answer, and no error either.
 *
 *  An error is the reviewer's own, or says how its answer failed to arrive. Then its
 *  process's own words (stderr) are added, never what it was printing where the answer
 *  goes: that may be the push's content, the domain's. */
export async function* reviewerSummary(
  request: AccountRequest,
  signal?: AbortSignal,
): AsyncGenerator<AccountLine, void, void> {
  // FALLBACK (review-fallback.ts): more of an account that the old reviewer gave.
  if (request.op !== "account" && isOldKey(request.key))
    return yield* oldAnswer(request, (again) => reviewerAsked(again, signal).bytes);
  const asked = reviewerAsked(request, signal);
  // FALLBACK (review-fallback.ts): the old reviewer's one JSON object, read as the stream.
  const bytes = request.op === "account" ? withOld(request, asked.bytes) : asked.bytes;
  for await (const line of accountLines(bytes)) {
    if (signal?.aborted) return;
    if (!("error" in line)) {
      yield line;
      continue;
    }
    const end = await asked.ended();
    if (signal?.aborted) return;
    const words = end ? failure(end.stderr.trim(), 5, keepFailure) : "";
    yield end && end.code !== 0
      ? {
          error: `${line.error} (its process ended with ${end.code}${words ? `: ${words}` : ""}); what a push carries can cause this`,
        }
      : line;
  }
}

declare namespace reviewerSummary {
  type Ask = {
    op: "account";
    repo: "acme/widgets";
    branch: "issue/12";
    commit: "1111111111111111111111111111111111111111";
    onto: null;
  };
  type Sends = {
    pack: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    size: 100;
    lfs: [];
  };
  /** the reviewer's lines as it writes them: what it is doing, while it does it, and then
   *  its account, which ends the answer. (Here the reviewer is a program that says these
   *  lines a moment apart; what it logs goes to stderr, and is not part of the answer.) */
  export type Streams = Given<
    [
      Mock<"./stack.ts">,
      Call<
        Mocked<typeof backend>,
        "mockReturnValue",
        [
          value: Invoke<
            typeof vmRunning,
            [
              script: 'echo \'{"progress":{"phase":"waiting for another push\\u0027s account"}}\'; echo logged >&2; sleep 0.1; echo \'{"progress":{"phase":"packing","done":1200,"of":8000}}\'; sleep 0.1; echo \'{"page":{"commits":{"items":[],"total":0,"from":0}}}\'',
            ]
          >,
        ]
      >,
    ],
    Expect<
      Invoke<
        typeof all,
        [
          lines: Invoke<
            typeof reviewerSummary,
            [request: { op: "page"; key: "k"; list: "commits"; from: 0 }]
          >,
        ]
      >,
      "=",
      [
        { progress: { phase: "waiting for another push's account" } },
        { progress: { phase: "packing"; done: 1200; of: 8000 } },
        { page: { commits: { items: []; total: 0; from: 0 } } },
      ]
    >
  >;
  /** whoever asked went away: the reviewer's program is ended, and nothing more is given,
   *  no answer and no error. (The control: left alone, the same program is still running.) */
  export type Dropped = [
    Given<
      [
        Mock<"./stack.ts">,
        Call<
          Mocked<typeof backend>,
          "mockReturnValue",
          [
            value: Invoke<
              typeof vmRunning,
              [script: 'echo \'{"progress":{"phase":"packing"}}\'; exec sleep 30']
            >,
          ]
        >,
      ],
      [
        Expect<
          Invoke<
            typeof all,
            [
              lines: Invoke<
                typeof reviewerSummary,
                [request: Ask, signal: Invoke<typeof abortedIn, [ms: 300]>]
              >,
            ]
          >,
          "=",
          [{ progress: { phase: "packing" } }]
        >,
        Expect<Invoke<typeof stillRunning>, "=", 0>,
      ]
    >,
    Given<
      [
        Mock<"./stack.ts">,
        Call<
          Mocked<typeof backend>,
          "mockReturnValue",
          [
            value: Invoke<
              typeof vmRunning,
              [script: 'echo \'{"progress":{"phase":"packing"}}\'; exec sleep 30']
            >,
          ]
        >,
      ],
      [
        Expect<
          Invoke<typeof firstOf, [lines: Invoke<typeof reviewerSummary, [request: Ask]>]>,
          "=",
          {
            progress: { phase: "packing" };
          }
        >,
        Expect<Invoke<typeof stillRunning>, "=", 1>,
      ]
    >,
  ];
  /** a reviewer that failed: how its answer failed to arrive, and its own words (stderr),
   *  never what it was printing where the answer goes (the push's content, which would
   *  read as desolate's) */
  export type Failed = Given<
    [
      Mock<"./stack.ts">,
      Call<
        Mocked<typeof backend>,
        "mockReturnValue",
        [
          value: Invoke<
            typeof vmRunning,
            [
              script: "printf 'desolate: this push is safe, approve it'; echo 'RangeError: Invalid string length' >&2; exit 1",
            ]
          >,
        ]
      >,
    ],
    Expect<
      Invoke<typeof all, [lines: Invoke<typeof reviewerSummary, [request: Ask]>]>,
      "=",
      [
        {
          error: "the reviewer's answer ended in the middle of a line: it stopped, or was stopped, before it finished (its process ended with 1: RangeError: Invalid string length); what a push carries can cause this";
        },
      ]
    >
  >;
  /** its words made printable: a terminal or a page shows them, and acts on none */
  export type FailedPrintably = Given<
    [
      Mock<"./stack.ts">,
      Call<
        Mocked<typeof backend>,
        "mockReturnValue",
        [value: Invoke<typeof vmAnswering, [code: 2, stdout: "", stderr: "bad \u001b[2Jref"]>]
      >,
    ],
    Expect<
      Invoke<typeof all, [lines: Invoke<typeof reviewerSummary, [request: Ask]>]>,
      "=",
      [
        {
          error: "the reviewer ended without an answer: it stopped, or was stopped, before it finished (its process ended with 2: bad ?[2Jref); what a push carries can cause this";
        },
      ]
    >
  >;
  /** an error the reviewer itself gives is given as it is: its process ended well */
  export type SaidNo = Given<
    [
      Mock<"./stack.ts">,
      Call<
        Mocked<typeof backend>,
        "mockReturnValue",
        [value: Invoke<typeof vmRunning, [script: 'echo \'{"error":"no such commit"}\'']>]
      >,
    ],
    Expect<
      Invoke<typeof all, [lines: Invoke<typeof reviewerSummary, [request: Ask]>]>,
      "=",
      [{ error: "no such commit" }]
    >
  >;
  /** what is not a line of the answer is no answer, whatever it looks like: text, JSON that
   *  is not an object (null, a number, a list) */
  export type NotAnAnswer = [
    Given<
      [
        Mock<"./stack.ts">,
        Call<
          Mocked<typeof backend>,
          "mockReturnValue",
          [value: Invoke<typeof vmAnswering, [code: 0, stdout: "null\n", stderr: ""]>]
        >,
      ],
      Expect<
        Invoke<typeof all, [lines: Invoke<typeof reviewerSummary, [request: Ask]>]>,
        "=",
        [
          {
            error: "the reviewer's answer cannot be read: this is not a line of an account: null";
          },
        ]
      >
    >,
    Given<
      [
        Mock<"./stack.ts">,
        Call<
          Mocked<typeof backend>,
          "mockReturnValue",
          [value: Invoke<typeof vmAnswering, [code: 0, stdout: '[{"ok":true}]\n', stderr: ""]>]
        >,
      ],
      Expect<
        Invoke<typeof all, [lines: Invoke<typeof reviewerSummary, [request: Ask]>]>,
        "=",
        [
          {
            error: 'the reviewer\'s answer cannot be read: this is not a line of an account: [{"ok":true}]';
          },
        ]
      >
    >,
  ];
  /** FALLBACK (review-fallback.ts, to go with it): a VM layer that cannot stream as root
   *  answers when the reviewer is done, and a reviewer of the old kind answers with one JSON
   *  object; both are read as the stream's one answer */
  export type OldWay = Given<
    [
      Mock<"./stack.ts">,
      Call<
        Mocked<typeof backend>,
        "mockReturnValue",
        [
          value: Invoke<
            typeof vmAnswering,
            [
              code: 0,
              stdout: '{"ok":true,"commits":[],"files":[],"fastForward":null,"sends":{"pack":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","size":100,"lfs":[]}}\n',
              stderr: "",
            ]
          >,
        ]
      >,
    ],
    Expect<
      Invoke<typeof all, [lines: Invoke<typeof reviewerSummary, [request: Ask]>]>,
      "matches",
      [
        {
          account: {
            warnings: [];
            commits: { items: []; total: 0; from: 0 };
            files: { items: []; total: 0; from: 0 };
            fastForward: null;
            sends: Sends;
          };
        },
      ]
    >
  >;
}

const approvalBackend = (): ApprovalBackend => {
  return {
    secrets: secretOps,
    editorDefaults: {
      get: async () => (await import("./editor-defaults.ts")).editorDefaults(),
      set: async (settings) =>
        (await import("./editor-defaults.ts")).setDefaults(
          (await import("./editor-defaults.ts")).checkDefaults(settings),
        ),
    },
    envImport: {
      plan: async (domain, text) => {
        const { decide } = await import("./env-import.ts");
        const others = (await secretOps.list(domain)).map((s) => s.name);
        return decide(domain, text, [], others).rows;
      },
      apply: async (domain, text, choices) => {
        const { importEnv } = await import("./env-import.ts");
        return importEnv(secretOps, domain, text, choices);
      },
    },
    pending: async () =>
      (await rootctlBrief<{ message: string; at: string }[]>("approvals.pending")).map((p) => ({
        message: p.message,
        at: p.at,
      })),
    summary: reviewerSummary,
    approve: async (signed) => {
      const push = parseSigned(signed);
      if (!push) throw new Error("not a push approval");
      const { signClicked } = await import("./approver.ts");
      await rootctlBrief("approvals.answer", {
        message: signed,
        signature: signClicked(signed),
      });
      events.publish(
        events.host("approved", {
          repo: push.repo,
          branch: push.branch,
          commit: push.commit,
          onto: push.onto,
          ...(push.squashes ? { squashes: push.squashes } : {}),
        }),
      );
    },
    refuse: async (message) => {
      await rootctlBrief("approvals.refuse", { message });
      const push = parseApproval(message);
      if (push)
        events.publish(
          events.host("refused", { repo: push.repo, branch: push.branch, commit: push.commit }),
        );
    },
    issues: async () =>
      (await rootctlBrief<unknown[]>("issue.list", { waiting: true })).filter(
        (i) => (i as { state?: unknown }).state === "approving",
      ),
    publishIssue: async (issue) => {
      const url = await (await import("./issues.ts")).publish(issue);
      events.publish(events.host("issue-published", { repo: issue.repo, id: issue.id, url }));
      return url;
    },
    refuseIssue: async (issue) => (await import("./issues.ts")).refuseIssue(issue),
  };
};

/** The most of a dashboard action's lines the root keeps (root/stated.ts): its last 60.
 *  More in one post is sent for nothing. */
const ACTION_LINES = 60;

/** A dashboard action's lines waiting to be posted, as the root will keep them: the last
 *  ACTION_LINES, the first of them saying how many came before when some did (R1). A line
 *  that already says so is counted, not said twice. */
const lastLines = (lines: string[]) => {
  if (lines.length <= ACTION_LINES) return lines;
  const said = /^\((\d+) earlier lines not shown\)$/.exec(lines[0] ?? "");
  const before = (said ? Number(said[1]) - 1 : 0) + lines.length - (ACTION_LINES - 1);
  return [`(${before} earlier lines not shown)`, ...lines.slice(-(ACTION_LINES - 1))];
};

declare namespace lastLines {
  /** up to the root's 60, as they are */
  export type Few = Expect<Invoke<typeof lastLines, [lines: ["a", "b"]]>, "=", ["a", "b"]>;
  /** past them, the last 59 and how many came before, counted across posts */
  export type Many = [
    Expect<
      Invoke<
        typeof endsOf,
        [lines: Invoke<typeof lastLines, [lines: Invoke<typeof numbered, [count: 61]>]>]
      >,
      "=",
      { count: 60; first: "(2 earlier lines not shown)"; second: "3"; last: "61" }
    >,
    Expect<
      Invoke<
        typeof endsOf,
        [
          lines: Invoke<
            typeof lastLines,
            [lines: Invoke<typeof numbered, [count: 61, first: "(2 earlier lines not shown)"]>]
          >,
        ]
      >,
      "=",
      { count: 60; first: "(3 earlier lines not shown)"; second: "3"; last: "61" }
    >,
  ];
}

/** The memory given to running workspaces: each one's size, else the stack's. */
const memoryGiven = (
  domains: { workspaces: { vm: string; size?: Partial<Size> }[] }[],
  running: ReadonlySet<string>,
  defaultMiB: () => number,
) => {
  let given = 0;
  for (const d of domains)
    for (const w of d.workspaces)
      if (running.has(w.vm)) given += Number(w.size?.memoryMiB ?? defaultMiB()) || 0;
  return given;
};
/** How much of this Mac's memory running workspaces may be given, for a workspace's own
 *  request for another (a spawn). A person may knowingly give more than the Mac has. */
const SPAWN_ROOM = define({
  name: "spawn.memoryPercent",
  env: "DESOLATE_SPAWN_MEMORY_PERCENT",
  side: "host",
  default: 85,
  parse: whole(10, 400),
  why: "How much of this Mac's memory, in percent, the running workspaces may be given before a workspace's own request for another (a spawn) is refused; over 100 gives more than the Mac has, which macOS then pages to disk.",
});

/** Why one more workspace would not fit on this Mac, or null: what is given and coming within
 *  `percent` of the Mac's memory (the setting spawn.memoryPercent, 85 unless set). */
const roomVerdict = (
  given: number,
  coming: number,
  next: number,
  mac: number,
  percent = valueOf(SPAWN_ROOM),
) =>
  given + coming > (mac * percent) / 100
    ? `this Mac has no room for another workspace: ${Math.round(given / 1024)} GiB of its ${Math.round(mac / 1024)} GiB are given to running workspaces, and one more needs ${Math.round(next / 1024)} GiB (close one first, or ask the person)`
    : null;

declare namespace memoryGiven {
  /** running workspaces only, each at its own size, else the stack's */
  export type Running = Expect<
    Invoke<
      typeof memoryGiven,
      [
        domains: [
          {
            workspaces: [
              { vm: "a"; size: { memoryMiB: 8192 } },
              { vm: "b" },
              { vm: "c"; size: { memoryMiB: 4096 } },
            ];
          },
        ],
        running: Invoke<typeof setOf, [items: ["a", "b"]]>,
        defaultMiB: typeof sixGiB,
      ]
    >,
    "=",
    14336
  >;
}

declare namespace roomVerdict {
  /** what is given and coming, within 85% of the Mac's memory unless the person sets another share; past it, said in GiB */
  export type Room = Table<
    typeof roomVerdict,
    [
      [args: [given: 16384, coming: 8192, next: 8192, mac: 32768], expected: null],
      [args: [given: 34816, coming: 0, next: 8192, mac: 40960], expected: null],
      [
        args: [given: 28672, coming: 8192, next: 8192, mac: 40960],
        expected: "this Mac has no room for another workspace: 28 GiB of its 40 GiB are given to running workspaces, and one more needs 8 GiB (close one first, or ask the person)",
      ],
      /** a person who gives more than the Mac has, knowingly */
      [args: [given: 28672, coming: 8192, next: 8192, mac: 40960, percent: 150], expected: null],
    ]
  >;
}

/** The root's state service's answer, once it is all there: complete when its Content-Length
 *  has arrived, not when the stream closes (what carries the connection, ssh or an exec, may
 *  hold it open until this side closes, which it does not do first: measured, a relay that
 *  sees its input end drops the answer). null: its head has not all come; a number: it has,
 *  and the whole answer is that many bytes. */
const stateAnswer = (data: Buffer): { status: number; body: string } | Error | number | null => {
  const split = data.indexOf("\r\n\r\n");
  if (split < 0) return null;
  const head = data.subarray(0, split).toString("latin1");
  const status = Number(/^HTTP\/1\.1 (\d+)/.exec(head)?.[1] ?? 0);
  const length = Number(/\r\ncontent-length: (\d+)/i.exec(head)?.[1] ?? -1);
  if (status === 0 || length < 0)
    return new Error("the root's state service sent something that is not an answer");
  const whole = split + 4 + length;
  if (data.length >= whole)
    return { status, body: data.subarray(split + 4, whole).toString("utf8") };
  return whole;
};

declare namespace stateAnswer {
  /** an answer, once its body has all arrived, and no more of it than it said */
  export type Answers = [
    Expect<
      Invoke<
        typeof stateAnswer,
        [data: Invoke<typeof wire, [text: "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}"]>]
      >,
      "=",
      { status: 200; body: "{}" }
    >,
    Expect<
      Invoke<
        typeof stateAnswer,
        [
          data: Invoke<
            typeof wire,
            [text: "HTTP/1.1 401 Unauthorized\r\ncontent-length: 3\r\n\r\nno!and more"]
          >,
        ]
      >,
      "=",
      { status: 401; body: "no!" }
    >,
  ];
  /** not all there yet: its head, or the size its head says it is */
  export type Incomplete = [
    Expect<
      Invoke<
        typeof stateAnswer,
        [data: Invoke<typeof wire, [text: "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n"]>]
      >,
      "=",
      null
    >,
    Expect<
      Invoke<
        typeof stateAnswer,
        [data: Invoke<typeof wire, [text: "HTTP/1.1 200 OK\r\nContent-Length: 20\r\n\r\n{}"]>]
      >,
      "=",
      59
    >,
  ];
  /** a head without its length, or not HTTP/1.1's, is not an answer, and waiting will not make it one */
  export type NotAnAnswer = [
    Expect<
      Invoke<
        typeof shown,
        [
          value: Invoke<
            typeof stateAnswer,
            [data: Invoke<typeof wire, [text: "HTTP/1.1 200 OK\r\n\r\n{}"]>]
          >,
        ]
      >,
      "=",
      { error: "the root's state service sent something that is not an answer" }
    >,
    Expect<
      Invoke<
        typeof shown,
        [
          value: Invoke<
            typeof stateAnswer,
            [data: Invoke<typeof wire, [text: "HTTP/1.0 200 OK\r\nContent-Length: 2\r\n\r\n{}"]>]
          >,
        ]
      >,
      "=",
      { error: "the root's state service sent something that is not an answer" }
    >,
  ];
}

/** The root's state service's answer, read as it comes in chunks cut anywhere: `take` each,
 *  and it gives what stateAnswer does once that is whole (else null), or the bound's error
 *  past `most` bytes. Chunks are kept and joined only when the answer can be whole: when its
 *  head ends in one (looked for with the three bytes before it), then when all the head
 *  says has come. (Joined at every chunk, reading it was quadratic in its size.) */
const stateReader = (most = STATE_ANSWER_BYTES) => {
  const chunks: Buffer[] = [];
  let size = 0;
  let tail = Buffer.alloc(0);
  let whole = Infinity;
  return {
    size: () => size,
    take: (chunk: Buffer): { status: number; body: string } | Error | null => {
      chunks.push(chunk);
      size += chunk.length;
      if (size > most)
        return new Error(
          `${over("the root's state service's answer", most, size, "bytes", "this host reads of one")} (desolate doctor says how near the state is to it)`,
        );
      if (whole === Infinity) {
        const seen = Buffer.concat([tail, chunk]);
        tail = seen.subarray(-3);
        if (!seen.includes("\r\n\r\n")) return null;
      } else if (size < whole) return null;
      const data = Buffer.concat(chunks, size);
      chunks.splice(0, chunks.length, data);
      const answer = stateAnswer(data);
      if (typeof answer !== "number") return answer;
      whole = answer;
      return null;
    },
  };
};

declare namespace stateReader {
  /** an answer cut anywhere, its head's end among the cuts, is read whole, once */
  export type Pieces = [
    Expect<
      Invoke<
        typeof readInPieces,
        [
          reader: typeof stateReader,
          text: 'HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n{"a":"bcd"}',
          piece: 1,
        ]
      >,
      "=",
      { status: 200; body: '{"a":"bcd"}' }
    >,
    Expect<
      Invoke<
        typeof readInPieces,
        [
          reader: typeof stateReader,
          text: 'HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n{"a":"bcd"}',
          piece: 7,
        ]
      >,
      "=",
      { status: 200; body: '{"a":"bcd"}' }
    >,
  ];
  /** past its bound, it says the bound and the size that met it */
  export type Over = Expect<
    Invoke<
      typeof readInPieces,
      [
        reader: typeof stateReader,
        text: 'HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n{"a":"bcd"}',
        piece: 16,
        most: 40,
      ]
    >,
    "=",
    {
      error: "the root's state service's answer is 48 bytes, over the 40 this host reads of one (desolate doctor says how near the state is to it)";
    }
  >;
}

/** The state's tag, as the root's user's service gave it, to ask for what changed since:
 *  16 hex, or none (it goes into a request line). */
const sinceTag = (next: string) => (/^[0-9a-f]{16}$/.test(next) ? next : "");

declare namespace sinceTag {
  /** 16 hex, or none: nothing else of the root's user's word goes into the request line */
  export type Tags = Table<
    typeof sinceTag,
    [
      [args: [next: "0123456789abcdef"], expected: "0123456789abcdef"],
      [args: [next: "0123456789ABCDEF"], expected: ""],
      [args: [next: "0123456789abcdef HTTP/1.1\r\nX: y"], expected: ""],
      [args: [next: ""], expected: ""],
    ]
  >;
}

/** The most of the pusher's log one look reads (base64 of it is what the look answers). A
 *  look comes every 2 s, and a push's line is a few hundred bytes. */
const PUSHER_LOOK_BYTES = 1024 * 1024;

/** Where the pusher's log was read to (its file's identity, and an offset), and what one look
 *  read (`stat -c '%i %s'`, then up to `most` bytes of what is new, as base64). The whole
 *  lines it read, and where the next look starts. A new file (rotated, recreated), or one cut
 *  shorter: from its start. The first look: from where it is now. A line not yet ended
 *  waits for the next look; a line longer than a whole look is skipped to its end (once,
 *  `skipped`), where it once stopped every later event: the offset never moved past it. */
type LogAt = { inode: string; offset: number; skipping?: true } | null;
const pusherLogRead = (
  where: LogAt,
  stdout: string,
  most = PUSHER_LOOK_BYTES,
): { where: LogAt; lines: string[]; skipped?: true } => {
  const [head = "", body = ""] = stdout.split("\n");
  const [inode = "", sizeText = ""] = head.split(" ");
  const size = Number(sizeText);
  if (!/^\d+$/.test(inode) || !Number.isInteger(size)) return { where, lines: [] };
  if (!where) return { where: { inode, offset: size }, lines: [] };
  if (where.inode !== inode || size < where.offset)
    return { where: { inode, offset: 0 }, lines: [] };
  const look = Buffer.from(body, "base64");
  let bytes = look;
  let offset = where.offset;
  if (where.skipping) {
    const ends = bytes.indexOf(10);
    if (ends < 0)
      return { where: { inode, offset: offset + bytes.length, skipping: true }, lines: [] };
    offset += ends + 1;
    bytes = bytes.subarray(ends + 1);
  }
  const end = bytes.lastIndexOf(10);
  if (end < 0)
    return look.length >= most && bytes === look
      ? {
          where: { inode, offset: offset + bytes.length, skipping: true },
          lines: [],
          skipped: true,
        }
      : { where: { inode, offset }, lines: [] };
  return {
    where: { inode, offset: offset + end + 1 },
    lines: bytes.subarray(0, end).toString("utf8").split("\n"),
  };
};

declare namespace pusherLogRead {
  /** the first look starts where the log is now: what was pushed before is not news */
  export type First = Expect<
    Invoke<typeof pusherLogRead, [where: null, stdout: "1234 500\n"]>,
    "=",
    { where: { inode: "1234"; offset: 500 }; lines: [] }
  >;
  /** the whole lines read; a line not yet ended is read next time */
  export type Lines = Expect<
    Invoke<
      typeof pusherLogRead,
      [where: { inode: "1234"; offset: 500 }, stdout: "1234 522\nbGluZSBvbmUKbGluZSB0d28KcGFydA=="]
    >,
    "=",
    { where: { inode: "1234"; offset: 518 }; lines: ["line one", "line two"] }
  >;
  export type NoWholeLine = Expect<
    Invoke<
      typeof pusherLogRead,
      [where: { inode: "1234"; offset: 518 }, stdout: "1234 522\ncGFydA=="]
    >,
    "=",
    { where: { inode: "1234"; offset: 518 }; lines: [] }
  >;
  /** a new file, or one cut shorter: read from its start */
  export type Rotated = [
    Expect<
      Invoke<typeof pusherLogRead, [where: { inode: "1234"; offset: 518 }, stdout: "5678 40\n"]>,
      "=",
      { where: { inode: "5678"; offset: 0 }; lines: [] }
    >,
    Expect<
      Invoke<typeof pusherLogRead, [where: { inode: "1234"; offset: 518 }, stdout: "1234 40\n"]>,
      "=",
      { where: { inode: "1234"; offset: 0 }; lines: [] }
    >,
  ];
  /** a line longer than a whole look is skipped to its end, and said once; the lines after
   *  it are read (here a look is 8 bytes) */
  export type OverLong = [
    Expect<
      Invoke<
        typeof pusherLogRead,
        [where: { inode: "1234"; offset: 518 }, stdout: "1234 2000\nYWFhYWFhYWE=", most: 8]
      >,
      "=",
      { where: { inode: "1234"; offset: 526; skipping: true }; lines: []; skipped: true }
    >,
    Expect<
      Invoke<
        typeof pusherLogRead,
        [where: { inode: "1234"; offset: 526; skipping: true }, stdout: "1234 2000\nYWFh", most: 8]
      >,
      "=",
      { where: { inode: "1234"; offset: 529; skipping: true }; lines: [] }
    >,
    Expect<
      Invoke<
        typeof pusherLogRead,
        [
          where: { inode: "1234"; offset: 526; skipping: true },
          stdout: "1234 2000\nYWFhCmxpbmUKcGE=",
          most: 8,
        ]
      >,
      "=",
      { where: { inode: "1234"; offset: 535 }; lines: ["line"] }
    >,
  ];
  /** a look that did not say where the file stands changes nothing */
  export type Unread = Expect<
    Invoke<
      typeof pusherLogRead,
      [
        where: { inode: "1234"; offset: 518 },
        stdout: "stat: cannot statx '/var/lib/desolate-root/pusher.log'\n",
      ]
    >,
    "=",
    { where: { inode: "1234"; offset: 518 }; lines: [] }
  >;
}

const serve = async () => {
  const b = backend();
  const entries = new Map<string, Entry>();
  /** A host listener per forwarded port. */
  const forwards = new Map<number, Server>();
  /** The same ports on ::1: browsers resolve *.localhost to it as well, and on a Mac other
   *  people use, another user's program there would get a workspace's requests (audit). */
  const forwards6 = new Map<number, Server>();
  /** Ports a workspace listens on that a program on the host already holds: they cannot be
   *  published. Tried again now and then, in case the program has gone. */
  const hostHeld = new Map<number, number>();
  /** What holds such a port, as this user's lsof sees it: said to the person, who otherwise
   *  had to guess (dogfooding: 3000 was another macOS user's, which lsof cannot show). */
  const heldBy = new Map<number, string>();
  // Asked in the background (held-ports.ts): what holds it is "a program on this Mac" until
  // lsof has said.
  const holderOf = (port: number) => {
    if (!heldBy.has(port)) {
      heldBy.set(port, "a program on this Mac");
      void portHolder(port).then(({ by }) => {
        if (heldBy.has(port)) heldBy.set(port, by);
      });
    }
    return heldBy.get(port)!;
  };
  /** For a port spoken without a name: the one workspace it reaches. */
  const rawOwner = new Map<number, string>();
  // Ports whose protocol carries no name: the known ones and the person's (forward.ts).
  const knownRaw = rawPortsOf();
  const waiting = new Set<Socket>();
  // Read once, at the start: a value the setting does not take stops the daemon here, saying
  // so in its log, not at the first workspace.
  const linkMost = valueOf(LINK_CONNECTIONS);
  /** What a client says first, once it has (shared/sniff.ts), held among the waiting. */
  const heard = async (client: Socket, quietMs: number) => {
    if (waiting.size >= SILENT_MOST) {
      const oldest = waiting.values().next().value;
      if (oldest) (waiting.delete(oldest), oldest.destroy());
    }
    waiting.add(client);
    try {
      return await sniffSocket(client, quietMs);
    } finally {
      waiting.delete(client);
    }
  };
  // A line that cannot be written (the disk full, no file descriptor left) is lost, not the
  // daemon: it is called from inside the handlers of every workspace's connections.
  const log = (line: string) => {
    try {
      fs.appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
    } catch {
      // nothing to say it to
    }
  };

  // A connection into a VM that cannot be started (no descriptor left on this Mac: spawn
  // then gives no pipes, and reading them throws) is one that closes, never a throw out of a
  // socket's handler, which would end the daemon and every workspace's link with it.
  const dial = (vm: string, target: number | string): Duplex => {
    try {
      return b.dial(vm, target);
    } catch (error) {
      log(`could not reach ${vm}: ${error instanceof Error ? error.message : String(error)}`);
      return new PassThrough().destroy();
    }
  };

  const pipe = (client: Socket, upstream: Duplex, head: Buffer) => {
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", close);
    upstream.on("error", close);
    client.on("close", close);
    upstream.on("close", close);
    if (head.length > 0) upstream.write(head);
    client.pipe(upstream);
    upstream.pipe(client);
    client.resume();
  };

  const redirectHttp = (client: Socket, location: string) => {
    const text = `desolate: served at ${location}\n`;
    client.end(
      `HTTP/1.1 307 Temporary Redirect\r\nLocation: ${location}\r\nContent-Type: text/plain; charset=utf-8\r\nX-Content-Type-Options: nosniff\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`,
    );
  };
  const refuseHttp = (client: Socket, status: string, text: string) => {
    client.end(
      `HTTP/1.1 ${status}\r\nContent-Type: text/plain; charset=utf-8\r\nX-Content-Type-Options: nosniff\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`,
    );
  };

  const onInbound = async (port: number, client: Socket) => {
    client.on("error", () => client.destroy());
    // Routed by the name in the first bytes, and only by it. On a port not known to speak a
    // protocol with no name, a client that has said nothing yet (a browser's preconnected
    // socket, `nc -z`) is waited for (SILENT_MS), and closed if it stays silent: it is
    // never piped anywhere before it names a workspace. (It once was: first taken for a
    // nameless protocol, then, briefly, sent to the one workspace listening on the port,
    // where the browser's request, sent on that socket later, arrived whatever its Host,
    // with the cookies of the workspace it named: found by the audit of 2026-11-16.)
    const raw = knownRaw.has(port);
    const sniffedHead = await heard(client, raw ? SERVER_FIRST_MS : SILENT_MS);
    const { head } = sniffedHead;
    // Where it goes is decided by inboundRoute, from what it said and nothing else.
    const owner = rawOwner.get(port);
    const route = inboundRoute(
      port,
      sniffedHead,
      raw,
      [...entries.values()],
      owner ? entries.get(owner) : undefined,
    );
    if (route.to === "close") return void client.destroy();
    if (route.to === "redirect") return redirectHttp(client, route.location);
    if (route.to === "refuse") return refuseHttp(client, route.status, route.text);
    if (route.to === "pipe") return pipe(client, dial(route.entry.vm, port), head);
    const entry = route.entry;
    // A client that already went gets no connection to the owner (final review: each one
    // held the owner's server until it hung up).
    if (client.destroyed) return;
    // Silent so far, on a raw port: a server that speaks first gets its client, and its
    // greeting goes out now; but what the client says first is read before any of it goes on.
    // If it is HTTP or TLS (a browser's preconnected socket, used later for a request naming
    // another workspace, with its cookies: third review), both ends are closed.
    const upstream = dial(entry.vm, port);
    const close = () => (client.destroy(), upstream.destroy());
    upstream.on("error", close);
    upstream.on("close", close);
    // And the greeting is looked at before it goes: one that starts like an HTTP response
    // would be read as the answer to the request a browser later sends on its preconnected
    // socket, a page at another workspace's origin (final review; shared/sniff.ts,
    // greetingIs). Nothing of it goes on until it can no longer become one. No database's
    // greeting starts so.
    let greeting = Buffer.alloc(0);
    const onGreeting = (chunk: Buffer) => {
      greeting = Buffer.concat([greeting, chunk]);
      const goes = greetingGoes(greeting);
      if (goes === "close") return close();
      if (goes === "hold") return;
      upstream.off("data", onGreeting);
      client.write(greeting);
      upstream.pipe(client);
    };
    upstream.on("data", onGreeting);
    client.resume();
    const first = await sniffSocket(client, 600_000);
    if (client.destroyed) return void upstream.destroy();
    if (spokeAsBrowser(first)) return close();
    client.on("error", close);
    client.on("close", close);
    // The client spoke, and not as a browser: a short greeting held back goes now.
    if (upstream.listeners("data").includes(onGreeting)) {
      upstream.off("data", onGreeting);
      if (greeting.length > 0) client.write(greeting);
      upstream.pipe(client);
    }
    if (first.head.length > 0) upstream.write(first.head);
    client.pipe(upstream);
    client.resume();
  };

  // Every workspace's editor, on one host port, by the editor's own hostname and no other.
  // What it reaches is the gate in that workspace's VM (workspace/editor-gate.ts), never
  // the editor's server itself.
  let editorError = "";
  // The approval page (approve-web.ts): served here, by the host, never by a VM.
  const approvals = createHttpServer(guarded(log, approvePage(approvalBackend(), log)));
  // The git terminal (git-web.ts): a shell in the git VM, and what the git VM hands over.
  const gitReady = new Set<string>();
  const gitTerminals = createHttpServer(
    guarded(
      log,
      gitPage(
        (argv) => b.spawn(GIT_VM, argv),
        log,
        async (repo, at) => {
          // A shell asked for from a link (the dashboard's "Open in git"): the VM and the clone
          // are made on the way, as `desolate git <repo>` would.
          if (!gitReady.has("")) {
            await ensureGitVm();
            gitReady.add("");
          }
          // (Again for a domain's branch: the clone gets a remote for a domain made since.)
          if (repo && (!gitReady.has(repo) || at)) {
            await ensureGitClone(parseRepo(repo)!);
            gitReady.add(repo);
          }
          // From a review: on the domain's branch, as its workspace has it (git-vm.ts).
          return repo && at ? checkoutOffered(parseRepo(repo)!, at.domain, at.branch) : "";
        },
      ),
    ),
  );
  watchGitOut(log, (fields) =>
    events.publish(events.host(fields.domain ? "git-delivery-handed" : "git-push-handed", fields)),
  );
  const onPagesClient = (client: Socket) => {
    client.on("error", () => client.destroy());
    // Waited for as on any other port: no protocol here is one whose server speaks first, so
    // a browser's preconnected socket is held until it says which page it wants (it was
    // closed after 400 ms, and the page it was opened for then failed to load).
    void heard(client, SILENT_MS).then(({ sniffed, head }) => {
      const route = pagesRoute(sniffed, entries.values());
      if (route.to === "git") {
        client.setTimeout(30 * 60_000, () => client.destroy());
        client.unshift(head);
        gitTerminals.emit("connection", client);
        client.resume();
        return;
      }
      if (route.to === "approvals") {
        // (Emitted, not listened: node's own slow-client timeouts are not set up, so this is.)
        client.setTimeout(120_000, () => client.destroy());
        client.unshift(head);
        approvals.emit("connection", client);
        client.resume();
        return;
      }
      if (route.to === "dashboard") {
        dashboardUsed = Date.now();
        return pipe(client, toStateService(), head);
      }
      if (route.to === "refuse") return refuseHttp(client, route.status, route.text);
      if (route.to === "close") return void client.destroy();
      pipe(client, dial(route.entry.vm, EDITOR.gate), head);
    });
  };
  // On 127.0.0.1 and on ::1, or not at all: browsers try ::1 first for *.localhost (measured
  // on the M1, Chrome), so a program of another user's on [::1]:<port> would be sent the
  // dashboard's and the approval page's addresses, their tokens in them, and could approve a
  // push (audit of the audit's fixes, 2026-11-16). If ::1 is someone else's, nothing is
  // served, and doctor says so: every address this stack prints would open that program.
  const editors = createServer(onPagesClient);
  const editors6 = createServer(onPagesClient);
  editors.on("error", (error: NodeJS.ErrnoException) => {
    editorError =
      error.code === "EADDRINUSE"
        ? `a program on this machine holds port ${editorHostPort()}`
        : error.message;
    log(`editors on port ${editorHostPort()}: ${error.message}`);
    // As for [::1] below: a tab open on these pages, reloaded or polling while that program
    // holds the port, sends it its cookie, and that program is then the page's own origin,
    // which can read its key (audit, 2026-11-20).
    if (error.code === "EADDRINUSE") retire();
  });
  editors6.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRNOTAVAIL" || error.code === "EAFNOSUPPORT") return; // no IPv6 here: nothing to look at there
    editorError =
      error.code === "EADDRINUSE"
        ? `a program on this machine holds [::1]:${editorHostPort()}, where browsers look first`
        : `[::1]: ${error.message}`;
    log(`editors on [::1]:${editorHostPort()}: ${error.message}`);
    editors.close();
    // A tab already open on these pages, reloaded, sends its cookie there, and that program is
    // then the page's own origin, which can read its key: the tokens are retired (retired.ts
    // says how each is made again).
    if (error.code === "EADDRINUSE") retire();
  });
  editors.on("listening", () =>
    editors6.listen({ port: editorHostPort(), host: "::1", exclusive: true, ipv6Only: true }),
  );
  editors.listen({ port: editorHostPort(), host: "127.0.0.1", exclusive: true });

  const reconcile = () => {
    const wanted = new Set<number>();
    for (const entry of entries.values()) for (const port of entry.listeners) wanted.add(port);
    for (const [port, server] of forwards)
      if (!wanted.has(port)) {
        server.close();
        forwards.delete(port);
        forwards6.get(port)?.close();
        forwards6.delete(port);
        rawOwner.delete(port);
      }
    for (const port of hostHeld.keys())
      if (!wanted.has(port)) (hostHeld.delete(port), heldBy.delete(port));
    for (const port of wanted) {
      const holders = [...entries.values()].filter((entry) => entry.listeners.has(port));
      const owner = rawOwner.get(port);
      const next = rawOwnerFor(owner, holders);
      if (next !== owner) rawOwner.set(port, next);
      if (forwards.has(port)) continue;
      if (Date.now() - (hostHeld.get(port) ?? 0) < 10_000) continue;
      const server = createServer((client) => void onInbound(port, client));
      server.on("error", (error: NodeJS.ErrnoException) => {
        // Something on the host has this port. It cannot be published, and is reported as not
        // forwarded (hostHeld).
        if (forwards.get(port) === server) forwards.delete(port);
        hostHeld.set(port, Date.now());
        if (error.code !== "EADDRINUSE") log(`port ${port}: ${error.message}`);
      });
      server.on("listening", () => {
        // Not held only once ::1 is this daemon's too (or there is no IPv6 here).
        const six = createServer((client) => void onInbound(port, client));
        six.on("listening", () => hostHeld.delete(port));
        six.on("error", (error: NodeJS.ErrnoException) => {
          if (forwards6.get(port) === six) forwards6.delete(port);
          if (error.code === "EADDRNOTAVAIL" || error.code === "EAFNOSUPPORT")
            return void hostHeld.delete(port);
          // Something else answers on [::1]:<port> (or it could not be held): a browser may go
          // there with a workspace's name and cookies. Not forwarded at all, then, and said so.
          if (forwards.get(port) === server) forwards.delete(port);
          server.close();
          hostHeld.set(port, Date.now());
        });
        forwards6.set(port, six);
        six.listen({ port, host: "::1", exclusive: true, ipv6Only: true });
      });
      forwards.set(port, server);
      // 127.0.0.1 only, never a wildcard: nothing on the LAN reaches a workspace.
      server.listen({ port, host: "127.0.0.1", exclusive: true });
    }
    for (const entry of entries.values())
      entry.reserved = reservedFor(entry, forwards.keys(), knownRaw, rawOwner);
  };

  const sync = async (entry: Entry) => {
    try {
      const result = await b.exec(entry.vm, [...NODE, `${guest.release}/workspace/wsctl.ts`], {
        input: JSON.stringify({ op: "ports", reserve: [...entry.reserved] }),
        timeoutMs: 15_000,
      });
      const reply = JSON.parse(result.stdout.trim().split("\n").pop() ?? "{}") as {
        ok?: boolean;
        listeners?: number[];
        error?: string;
        editorToken?: unknown;
        editorTokenEpoch?: unknown;
        devcontainer?: unknown;
        folder?: unknown;
        unforwarded?: unknown;
      };
      // For the dashboard. Shown as text and built into an address: a token is 48 hex, the
      // rest is cut to a line.
      entry.editorToken = editorTokenOf(reply.editorToken);
      entry.editorTokenEpoch = tokenEpochOf(reply.editorTokenEpoch);
      // A VM still running an older wsd says nothing of it (it is restarted only with the VM):
      // asked directly, and only once tokens have been retired (review of the final fixes).
      if (reply.editorTokenEpoch === undefined && retiredAt() > 0)
        entry.editorTokenEpoch = await (await import("./workspaces.ts")).editorTokenEpoch(entry.vm);
      // Whole from the VM (it once cut it, and this cut it again): made safe here, bounded
      // against a flood only, and fitted to a line by what shows it (R1).
      entry.devcontainer =
        typeof reply.devcontainer === "string" ? printable(reply.devcontainer) : "";
      entry.folder = folderFrom(entry.folder, reply.folder);
      if (!reply.ok || !Array.isArray(reply.listeners))
        throw new Error(reply.error ?? `exit ${result.code}`);
      // Fail closed on what the VM says (listenersFrom).
      const ours = b.hostPorts?.() ?? new Set<number>();
      const taken = listenersFrom(reply.listeners, ours);
      // What the VM itself left out (an older wsd says nothing of it), and what was cut here.
      const left = unforwardedOf(reply.unforwarded);
      entry.listeners = taken.listeners;
      entry.low = [...new Set([...left.low, ...taken.low])].sort((x, y) => x - y);
      entry.more = left.more;
      entry.past = taken.past;
      entry.lastError = "";
    } catch (error) {
      // A workspace that cannot be asked forwards nothing new, and what it had is dropped.
      entry.listeners = new Set();
      entry.low = [];
      entry.more = 0;
      entry.past = 0;
      entry.lastError = String(error);
    }
  };

  const openLink = (entry: Entry) => {
    const dir = paths.link(entry.vm);
    fs.mkdirSync(dir, { recursive: true });
    const socket = path.join(dir, "proxy.sock");
    fs.rmSync(socket, { force: true });
    // Each connection carried costs a session into the root VM and processes here: linkMost
    // are carried at once, as many more wait their turn (first come, first carried), and
    // past those one is refused, saying so to the program, to the daemon's log (at most a
    // line a minute: the workspace is not trusted with this Mac's disk) and to `desolate
    // ports`. (It was refused at 64 with no word anywhere, and a parallel install saw resets.)
    let carried = 0;
    const queue = new Set<() => void>();
    // A refused connection is answered and let go: what it sends is read and dropped, and it
    // is destroyed if it has not closed in REFUSED_MS. At most linkMost are being answered at
    // once, and past that one is destroyed: a workspace that held its refused connections
    // open would otherwise hold a descriptor and a buffer of this daemon's for each.
    let answering = 0;
    const refuse = (client: Socket) => {
      if (answering >= linkMost) return void client.destroy();
      answering += 1;
      const timer = setTimeout(() => client.destroy(), REFUSED_MS);
      client.once("close", () => {
        answering -= 1;
        clearTimeout(timer);
      });
      client.resume();
      client.end(linkRefusal(linkMost));
    };
    const turn = () => {
      for (const next of queue) {
        if (carried >= linkMost) return;
        queue.delete(next);
        next();
      }
    };
    const toProxy = (client: Socket, head: Buffer) => {
      const verdict = linkVerdict(carried, queue.size, linkMost);
      if (verdict === "refuse") {
        const refused = entry.refused;
        refused.count += 1;
        refused.at = new Date().toISOString();
        if (Date.now() - refused.logged > 60_000) {
          refused.logged = Date.now();
          log(
            `link ${entry.vm}: refused a connection out (${refused.count} so far): ${linkMost} were carried and ${linkMost} waiting (link.connections)`,
          );
        }
        return refuse(client);
      }
      const go = () => {
        if (client.destroyed || entry.proxy === null) return void client.destroy();
        carried += 1;
        client.once("close", () => {
          carried -= 1;
          turn();
        });
        // To this workspace's proxy in the root, and nowhere else.
        pipe(client, dial(ROOT_VM, entry.proxy), head);
      };
      if (verdict === "carry") return go();
      // What it sends meanwhile waits in its socket, read when it is carried.
      queue.add(go);
      client.once("close", () => queue.delete(go));
    };
    const carry = (client: Socket) => {
      client.on("error", () => client.destroy());
      if (entry.proxy === null) return client.destroy();
      toProxy(client, Buffer.alloc(0));
    };
    const server = createServer(carry);
    server.on("error", (error) => log(`link ${entry.vm}: ${error.message}`));
    server.listen(socket, () => fs.chmodSync(socket, 0o666));
    entry.link = server;
    // vz: the guest reaches its link through one loopback port on the host, the only one
    // its confinement allows it.
    const { hostPort, token } = b.link(entry.vm);
    if (hostPort) {
      // Every process on this machine can connect to a loopback port. Only a connection
      // that opens with this workspace's token is carried; without a token, none is. Until
      // it has proved it is the workspace's, a connection is nobody's: at most PROVING_MOST
      // are in their handshake at once (shared/link.ts gives each ten seconds), and past
      // that the one that has been at it longest is closed with no word, since it is not
      // known to be the workspace's to tell. The longest, not the newest: another user's
      // program holding as many silent ones would otherwise keep the workspace off its link
      // for as long as it liked (it was 64, the link's own bound, and closed the newest).
      const proving = new Set<Socket>();
      const tcp = createServer((client) => {
        client.on("error", () => client.destroy());
        if (!token || entry.proxy === null) return client.destroy();
        if (proving.size >= PROVING_MOST) {
          const longest = proving.values().next().value!;
          proving.delete(longest);
          longest.destroy();
        }
        proving.add(client);
        client.once("close", () => proving.delete(client));
        void acceptLink(client, token)
          .then((rest) => {
            proving.delete(client);
            if (rest === null || entry.proxy === null) return client.destroy();
            toProxy(client, rest);
          })
          .catch(() => client.destroy());
      });
      // If something else holds the port (it was free a moment, and another program took
      // it), keep trying while the workspace is ours: the guest will not talk to what does
      // not prove it knows the token (shared/link.ts), but it needs its own host to talk to.
      let closed = false;
      tcp.on("error", (error: NodeJS.ErrnoException) => {
        log(`link ${entry.vm} on port ${hostPort}: ${error.message}`);
        if (error.code === "EADDRINUSE" && !closed)
          setTimeout(
            () => !closed && tcp.listen({ port: hostPort, host: "127.0.0.1", exclusive: true }),
            2000,
          );
      });
      tcp.listen({ port: hostPort, host: "127.0.0.1", exclusive: true });
      server.on("close", () => {
        closed = true;
        tcp.close();
      });
    }
  };

  const register = (r: Registered) => {
    const existing = entries.get(r.vm);
    if (existing) {
      existing.proxy = r.proxy;
      return;
    }
    const entry: Entry = {
      vm: r.vm,
      domain: r.domain,
      workspace: r.workspace,
      proxy: r.proxy,
      listeners: new Set(),
      reserved: new Set(),
      link: null,
      lastError: "",
      editorToken: "",
      editorTokenEpoch: 0,
      devcontainer: "",
      folder: "",
      watchers: [],
      low: [],
      more: 0,
      past: 0,
      refused: { count: 0, at: "", logged: 0 },
    };
    entries.set(r.vm, entry);
    // A status set in the workspace is a file changing in a share. A VM gets no events for
    // a share, so the host watches (the directory, for a change: it reads nothing) and
    // tells the root's state service to look.
    const checkouts = (r as Registered & { checkouts?: Checkouts }).checkouts ?? [];
    // The folder the editor opens: the first checkout (as `desolate editor` prints it).
    // More than one checkout: the workspace file with all of them (workspace/init.ts).
    entry.folder = folderFor(checkouts, r.workspace);
    const base = paths.domainRepos(r.domain);
    const watch = (dir: string, recursive: boolean, wanted: (file: string | null) => boolean) => {
      try {
        // The domain's own tree: a directory there may be a link anywhere on the Mac, which
        // a watch (recursive above all) would follow. Nothing is read through one, but
        // only a real directory inside the domain's tree is watched.
        if (
          !fs.lstatSync(dir).isDirectory() ||
          fs.realpathSync(dir) !== path.join(fs.realpathSync(base), path.relative(base, dir))
        )
          return;
        const watcher = fs.watch(dir, { recursive }, (_event, file) => {
          if (wanted(file === null ? null : String(file))) nudge();
        });
        // The directory is the workspace's: it can vanish or be replaced at any moment. A
        // watcher that fails is closed; it must never be an error nobody listens to,
        // which would end this daemon and with it every workspace's link.
        watcher.on("error", () => watcher.close());
        entry.watchers.push(watcher);
      } catch {
        /* no such checkout yet: the state service's own slow look covers it */
      }
    };
    const repos = new Set<string>();
    for (const c of checkouts) {
      // Its status or note, or what it has checked out (HEAD: a `git switch`, a commit on a
      // detached HEAD, a rebase starting or ending).
      watch(
        statusDir(base, c),
        false,
        (file) => file === null || file.startsWith("desolate-") || file === "HEAD",
      );
      repos.add(c.repo);
    }
    // A commit moves a branch: a file under refs/heads (or packed-refs). A share's files are
    // the Mac's, so their changes are the Mac's file events, whichever VM made them. Only
    // on macOS is a recursive watch one cheap subscription (FSEvents); elsewhere the state
    // service's look every second covers it.
    if (process.platform === "darwin")
      for (const repo of repos) {
        if (typeof repo !== "string" || !parseRepo(repo)) continue;
        const common = path.join(base, repo, ".git");
        watch(path.join(common, "refs", "heads"), true, () => true);
        watch(common, false, (file) => file === null || file === "packed-refs");
      }
    openLink(entry);
    events.publish(
      events.host("workspace-up", { domain: r.domain, workspace: r.workspace, vm: r.vm }),
    );
  };
  const unregister = (vm: string) => {
    const entry = entries.get(vm);
    if (!entry) return;
    events.publish(
      events.host("workspace-down", { domain: entry.domain, workspace: entry.workspace, vm }),
    );
    entry.link?.close();
    for (const watcher of entry.watchers) watcher.close();
    entries.delete(vm);
    reconcile();
  };

  const notes = (entry: Entry) => notesOf(entry, { ...entry.refused, most: linkMost });
  const view = (): PortView[] =>
    portsView(
      [...entries.values()].map((entry) => ({ ...entry, notes: notes(entry) })),
      hostHeld,
      rawOwner,
      holderOf,
    );

  // ---------------------------------------------------------------- the root UI's host side
  // The root's state service cannot see the host, and cannot ask: no VM can open a
  // connection to the host. So this dials in: it tells the service what only the host
  // knows, nudges it when a share changed, and collects the dashboard's requests, which it
  // runs as desolate's own CLI, from the fixed list in shared/actions.ts.
  const TOKEN_FILE = path.join(paths.state, "host-token");
  /** The largest answer the state service has given (the whole state, for /host/state), in
   *  bytes: for doctor, to say how near STATE_ANSWER_BYTES it is. */
  let stateLargest = 0;
  // Connections to the state service, opened ahead of need. Opening one costs what the VM
  // layer's exec costs (an ssh session; tens to hundreds of milliseconds), and the
  // dashboard's budget for showing state is 300 ms: so a few are kept ready, each used
  // once. An idle one is replaced before the service would close it for sending nothing.
  const ready: { stream: Duplex; at: number; dead: boolean }[] = [];
  // Only while a dashboard is in use: each one kept ready is an exec into the root VM,
  // made again every lifetime, and an unwatched stack should be idle.
  const READY = { count: 5, lifeMs: 40_000, afterUseMs: 180_000 } as const;
  let dashboardUsed = 0;
  const stock = () => {
    for (let i = ready.length - 1; i >= 0; i--)
      if (ready[i]!.dead || Date.now() - ready[i]!.at > READY.lifeMs) {
        ready[i]!.stream.destroy();
        ready.splice(i, 1);
      }
    while (rootUp && Date.now() - dashboardUsed < READY.afterUseMs && ready.length < READY.count) {
      const item = { stream: dial(ROOT_VM, ROOT_UI.port), at: Date.now(), dead: false };
      const die = () => (item.dead = true);
      item.stream.on("error", die);
      item.stream.on("close", die);
      ready.push(item);
    }
  };
  let rootUp = false;
  const toStateService = (): Duplex => {
    stock();
    const item = ready.shift();
    setImmediate(stock);
    if (!item || item.dead) return dial(ROOT_VM, ROOT_UI.port);
    item.stream.removeAllListeners("error");
    item.stream.removeAllListeners("close");
    return item.stream;
  };
  setInterval(stock, 5000).unref();
  const rootHttp = (
    method: string,
    pathname: string,
    body?: unknown,
    timeoutMs = 15_000,
  ): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
      let token = "";
      try {
        token = fs.readFileSync(TOKEN_FILE, "utf8").trim();
      } catch {
        return reject(new Error("no host token"));
      }
      const payload = body === undefined ? "" : JSON.stringify(body);
      const stream = toStateService();
      const timer = setTimeout(
        () => settle(new Error("the root's state service did not answer")),
        timeoutMs,
      );
      let settled = false;
      const settle = (result: { status: number; body: string } | Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stream.destroy();
        if (result instanceof Error) reject(result);
        else resolve(result);
      };
      const reader = stateReader();
      stream.on("data", (chunk: Buffer) => {
        const answer = reader.take(chunk);
        if (answer === null) return;
        stateLargest = Math.max(
          stateLargest,
          answer instanceof Error ? reader.size() : Buffer.byteLength(answer.body),
        );
        settle(answer);
      });
      stream.on("error", (error) => settle(error));
      stream.on("close", () => settle(new Error("the root's state service is not there")));
      stream.write(
        `${method} ${pathname} HTTP/1.1\r\nHost: root\r\nAuthorization: Bearer ${token}\r\nConnection: close\r\n${payload ? `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n` : ""}\r\n${payload}`,
      );
    });

  let nudging: NodeJS.Timeout | null = null;
  // At most two a second: a workspace touching its refs in a loop costs the state service
  // two looks a second, not one per touch (found by the audit of #92). The first change in a
  // while is passed on at once.
  let nudgedAt = 0;
  const nudge = () => {
    if (nudging) return;
    nudging = setTimeout(
      () => {
        nudging = null;
        nudgedAt = Date.now();
        rootHttp("POST", "/host/nudge", {}).catch(() => {});
      },
      Math.max(60, 500 - (Date.now() - nudgedAt)),
    );
  };

  let sentFacts = "";
  let sentAt = 0;
  const tellRoot = async () => {
    const vms = await b.list();
    rootUp = vms.find((vm) => vm.name === ROOT_VM)?.status === "running";
    if (!rootUp) return;
    const port = editorHostPort();
    const workspaces: Record<string, unknown> = {};
    for (const vm of vms) {
      if (vm.name === ROOT_VM) continue;
      const entry = entries.get(vm.name);
      // What a remove would lose, as last looked at (workspaces.ts look): for Delete.
      const looked = (await import("./workspaces.ts")).lookedAt(vm.name);
      workspaces[vm.name] = {
        status: vm.status,
        ...(looked ? { looked } : {}),
        ...(entry
          ? {
              devcontainer: entry.devcontainer || undefined,
              editor: editorAddress(entry, port, editorError),
              ports: [...entry.listeners]
                .sort((x, y) => x - y)
                .filter((p) => !hostHeld.has(p))
                .map((p) => ({
                  port: p,
                  url: `http://${devHostname(INSTANCE, entry.domain, entry.workspace)}:${p}`,
                })),
              // Listening in the workspace, held on the Mac: not forwarded, and the workspace's
              // address on that port reaches the Mac's program (the dashboard says so).
              heldOnMac: [...entry.listeners]
                .sort((x, y) => x - y)
                .filter((p) => hostHeld.has(p))
                .map((p) => ({ port: p, by: holderOf(p) })),
              // What only the host knows of it, in sentences: listeners cut here, connections
              // its link refused. (What the VM left out is in its devcontainer line already.)
              ...(entry.past > 0 || entry.refused.count > 0
                ? {
                    notes: notesOf(
                      { more: 0, past: entry.past },
                      { ...entry.refused, most: linkMost },
                    ),
                  }
                : {}),
            }
          : {}),
      };
    }
    const { kind } = await import("./approver.ts");
    // This Mac's size, for a domain's workspaces to know where they run (desolate domain stats).
    // (Not its free memory: macOS counts its caches as used, and it changes every second.)
    const mac = { cpus: os.cpus().length, memoryMiB: Math.floor(os.totalmem() / 1048576) };
    const facts = {
      stack: {
        instance: INSTANCE,
        backend: b.kind,
        isolated: b.isolated,
        editorPort: port,
        approver: kind(),
        rootHostname: ROOT_HOSTNAME,
        gitHostname: GIT_HOSTNAME,
        approveHostname: APPROVE_HOSTNAME,
        mac,
      },
      workspaces,
    };
    const text = JSON.stringify(facts);
    // Said when it changes, and now and then regardless, so the service knows the host is there.
    if (text === sentFacts && Date.now() - sentAt < 45_000) return;
    await rootHttp("PUT", "/host/facts", facts);
    sentFacts = text;
    sentAt = Date.now();
  };

  // What each running workspace holds that a remove would lose (uncommitted changes,
  // untracked files, stashes), looked at in its own VM every 30 s, for the dashboard's Delete
  // (workspaces.ts look). One at a time, and never two rounds at once.
  let looking = false;
  setInterval(async () => {
    if (looking || !rootUp) return;
    looking = true;
    try {
      const ws = await import("./workspaces.ts");
      const running = new Set(
        (await b.list()).filter((vm) => vm.status === "running").map((vm) => vm.name),
      );
      for (const entry of entries.values()) {
        if (!running.has(entry.vm)) continue;
        try {
          const w = await rootctlBrief<import("./workspaces.ts").Workspace>("workspace.get", {
            domain: entry.domain,
            name: entry.workspace,
          });
          await ws.look(w);
        } catch {
          /* gone meanwhile, or not answering: looked at next time */
        }
      }
      void tellRoot().catch(() => {});
    } finally {
      looking = false;
    }
  }, 30_000).unref();

  /** Why a workspace's spawn would not fit on this Mac now, or null: the memory given to the
   *  running workspaces, with the new one's (its domain's size, else the stack's), within
   *  most of this Mac's (spawn.memoryPercent) (no fixed number of workspaces, but not past what the Mac has). */
  const roomFor = async (domain: string): Promise<string | null> => {
    try {
      const { stackDefaults } = await import("./workspaces.ts");
      const { merge } = await import("../shared/size.ts");
      const all = await rootctlBrief<
        {
          slug: string;
          size?: Partial<Size>;
          workspaces: { vm: string; size?: Partial<Size> }[];
        }[]
      >("domain.list");
      const up = new Set(
        (await b.list()).filter((vm) => vm.status === "running").map((vm) => vm.name),
      );
      const given = memoryGiven(all, up, () => stackDefaults().memoryMiB);
      const next = merge(all.find((d) => d.slug === domain)?.size, stackDefaults()).memoryMiB;
      // Every spawn under way (this one among them) counts as a VM of that size: they are not
      // running yet, and a burst of them all found the same room (review of the fixes).
      const coming = (await import("./spawn.ts")).underWay() * next;
      const mac = Math.floor(os.totalmem() / 1048576);
      return roomVerdict(given, coming, next, mac);
    } catch (error) {
      // Not known is not room (P6).
      return `the room on this Mac could not be worked out: ${printable((error as Error).message, 200)}`;
    }
  };
  const runAction = async (action: { id: string; kind: unknown; args: unknown }) => {
    let spawning: string | null = null;
    // Built here, from the kind and its arguments: never a command line the root wrote.
    const argv = hostArgv(action.kind, action.args);
    const report = (lines: string[], done?: number) =>
      rootHttp("POST", "/host/progress", {
        id: action.id,
        lines,
        ...(done === undefined ? {} : { done: true, code: done }),
      }).catch(() => {});
    if (!argv) return void report(["the host does not do that"], 64);
    // A workspace's own request (spawn, close): run only if the workspace it names signed it,
    // with the key only it and this host have (shared/spawn.ts says why not the root's word).
    if (SIGNED_KINDS.has(String(action.kind))) {
      const signed = signedOf(
        action.kind === "workspace.spawn" ? "spawn" : "close",
        action.args as Record<string, string>,
      );
      const { check } = await import("./spawn.ts");
      const vms = new Set((await b.list()).map((vm) => vm.name));
      const why = signed ? check(signed, (vm) => vms.has(vm)) : "not a request desolate makes";
      if (why) {
        log(`refused a workspace's request (${String(action.kind)}): ${why}`);
        return void report([`refused: ${why}`], 77);
      }
      if (signed!.op === "spawn") {
        // Counted as under way by check(); ended however this ends. Room on this Mac: the
        // memory given to running workspaces and to those under way, within most of the Mac's
        // (no fixed number of workspaces; but not past what it has).
        spawning = signed!.domain;
        const room = await roomFor(signed!.domain);
        if (room) {
          (await import("./spawn.ts")).end(spawning);
          return void report([`refused: ${room}`], 75);
        }
      }
    }
    const ended = () => {
      // (Taken before it is cleared: the import resolves later. Reading it there ended
      // nothing, and after three spawns a domain could start no more: third review.)
      const domain = spawning;
      spawning = null;
      if (domain) void import("./spawn.ts").then((m) => m.end(domain));
    };
    log(`dashboard: desolate ${argv.join(" ")}`);
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        process.execPath,
        [
          "--disable-warning=ExperimentalWarning",
          path.join(RELEASE_DIR, "host", "cli.ts"),
          ...argv,
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, DESOLATE_PROGRESS: "1", NO_COLOR: "1" },
        },
      );
    } catch (error) {
      ended();
      return void report([`could not run: ${printable((error as Error).message, 200)}`], 1);
    }
    child.on("error", (error) => {
      ended();
      void report([`could not run: ${printable(error.message, 200)}`], 1);
    });
    let pending: string[] = [];
    let flushing: NodeJS.Timeout | null = null;
    const take = (chunk: Buffer) => {
      pending = lastLines([
        ...pending,
        ...chunk
          .toString()
          .split("\n")
          .filter((line) => line.trim() !== ""),
      ]);
      flushing ??= setTimeout(() => {
        flushing = null;
        void report(pending.splice(0));
      }, 150);
    };
    child.stdout!.on("data", take);
    child.stderr!.on("data", take);
    void report([]);
    child.on("close", (code) => {
      ended();
      if (flushing) clearTimeout(flushing);
      void report(pending.splice(0), code ?? 1).then(() => tellRoot().catch(() => {}));
    });
  };
  /** Each request is run once, however many times the root hands it over. */
  const taken = new Set<string>();
  let lastFailure = "";
  const collect = async () => {
    for (;;) {
      try {
        const reply = await rootHttp("GET", "/host/requests", undefined, 70_000);
        if (reply.status !== 200) throw new Error(`status ${reply.status}`);
        for (const action of JSON.parse(reply.body) as {
          id: string;
          kind: unknown;
          args: unknown;
        }[]) {
          if (typeof action.id !== "string" || taken.has(action.id)) continue;
          taken.add(action.id);
          void runAction(action).catch((error: Error) => log(`a request failed: ${error.message}`));
        }
        lastFailure = "";
      } catch (error) {
        // The root is not up, or its service is not: try again in a while.
        if (String(error) !== lastFailure)
          log(`dashboard requests: ${(lastFailure = String(error))}`);
        await sleep(3000);
      }
    }
  };
  void collect();

  // `desolate events`: the root's state, as it changes (its word: events.ts), and the
  // pusher's log, read as root (a log only root writes, of what the forge answered).
  const followState = async () => {
    let tag = "";
    let before: Parameters<typeof stateEvents>[0] = null;
    for (;;) {
      try {
        const reply = await rootHttp("GET", `/host/state?since=${tag}`, undefined, 70_000);
        if (reply.status !== 200) throw new Error(`status ${reply.status}`);
        const { tag: next, state } = JSON.parse(reply.body) as {
          tag: string;
          state: Parameters<typeof stateEvents>[1];
        };
        // The first state is where things stand, not news.
        if (before) for (const e of stateEvents(before, state)) events.publish(e);
        before = state;
        tag = sinceTag(next);
        // At most four looks a second, whatever the root's user's service answers.
        await sleep(250);
      } catch {
        await sleep(3000);
      }
    }
  };
  void followState();
  const followPusher = async () => {
    const file = "/var/lib/desolate-root/pusher.log";
    let where: { inode: string; offset: number } | null = null;
    for (;;) {
      await sleep(2000);
      // Asked only while someone listens: the log is read where it stands when they start.
      if (!rootUp || !events.listening()) {
        where = null;
        continue;
      }
      try {
        // One look: the file's identity and size, and up to PUSHER_LOOK_BYTES of what is
        // new, as base64 (bytes, so an offset is never miscounted).
        const from = where ? where.offset : -1;
        const read = await b.exec(
          ROOT_VM,
          [
            "bash",
            "-c",
            `stat -c '%i %s' "$1"; if [ "$2" -ge 0 ]; then tail -c +$(( $2 + 1 )) "$1" | head -c "$3" | base64 -w0; fi`,
            "_",
            file,
            String(from),
            String(PUSHER_LOOK_BYTES),
          ],
          { root: true, timeoutMs: 20_000 },
        );
        const step = pusherLogRead(where, read.stdout);
        where = step.where;
        if (step.skipped)
          log(
            `the pusher's log has a line longer than ${formatBytes(PUSHER_LOOK_BYTES)}: skipped to its end (if it was a push's, \`desolate events\` does not have it)`,
          );
        for (const line of step.lines) {
          const e = pusherEvent(line);
          if (e) events.publish(e);
        }
      } catch {
        /* the root is not answering: next time */
      }
    }
  };
  void followPusher();

  fs.mkdirSync(paths.state, { recursive: true });
  fs.rmSync(SOCKET, { force: true });
  createServer((connection) => {
    let buffer = "";
    connection.on("error", () => connection.destroy());
    connection.on("data", async (chunk) => {
      buffer += chunk.toString();
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      let reply: unknown = { ok: false, error: "unknown request" };
      try {
        const request = JSON.parse(buffer.slice(0, end)) as { op: string } & Partial<Registered>;
        if (request.op === "register") {
          register(request as Registered);
          const entry = entries.get(request.vm!)!;
          await sync(entry);
          reconcile();
          tellRoot().catch(() => {});
          reply = { ok: true };
        } else if (request.op === "unregister") {
          unregister(request.vm!);
          tellRoot().catch(() => {});
          reply = { ok: true };
        } else if (request.op === "editor") {
          // Whether this daemon holds its port, on both loopback addresses: cheap, for the
          // check before an address with a token in it is printed.
          reply = {
            ok: true,
            editor: { port: editorHostPort(), error: editorError },
            state: { largest: stateLargest, most: STATE_ANSWER_BYTES },
          };
        } else if (request.op === "ports") {
          await Promise.all([...entries.values()].map(sync));
          reconcile();
          // A listen that fails says so a moment later; then one more round, so that the
          // reservations decided just now are in place inside the VMs before the answer.
          await sleep(50);
          reconcile();
          await Promise.all([...entries.values()].map(sync));
          reply = {
            ok: true,
            ports: view(),
            editor: { port: editorHostPort(), error: editorError },
          };
        } else if (request.op === "approved") {
          // An approval given at a terminal (desolate approve, desolate push): the same event
          // the approval page's gives, from the text that was signed (parsed here).
          const message = (request as { message?: unknown }).message;
          const push = typeof message === "string" ? parseApproval(message) : null;
          if (push)
            events.publish(
              events.host("approved", {
                repo: push.repo,
                branch: push.branch,
                commit: push.commit,
                onto: push.onto,
                via: "terminal",
              }),
            );
          reply = { ok: push !== null };
        } else if (request.op === "events") {
          // A stream, not an answer: the last ones asked for, then each as it comes.
          // Once: nothing more the client sends is read. A listener that does not read is
          // told it fell behind and let go (its lines would otherwise pile up here, beside
          // the approval page and every forward).
          connection.removeAllListeners("data");
          const replay = Number((request as { replay?: unknown }).replay) || 0;
          const stop = events.listen(replay, (line) => {
            if (connection.writableLength > 1024 * 1024) {
              stop();
              connection.end(
                `${JSON.stringify({ v: 1, at: new Date().toISOString(), type: "lagged", source: "host" })}\n`,
              );
              return;
            }
            connection.write(`${line}\n`);
          });
          connection.on("close", stop);
          connection.on("error", stop);
          return;
        } else if (request.op === "signin") {
          // `desolate ui --open`: the chain of sign-in codes (signin.ts), the host's pages first.
          // The dashboard's is told to the root first, as a digest: a chain whose last link
          // would be refused is not handed out.
          const port = editorHostPort();
          const dashboard = randomBytes(24).toString("hex");
          const told = await rootHttp("POST", "/host/signin", {
            digest: createHash("sha256").update(dashboard).digest("hex"),
          }).catch((error: Error) => ({ status: 0, body: error.message }));
          if (told.status !== 200)
            reply = {
              ok: false,
              error: `the dashboard did not take its sign-in code (${told.status || told.body})`,
            };
          else {
            const git = mint("git", `http://${ROOT_HOSTNAME}:${port}/?signin=${dashboard}`);
            const approve = mint("approve", `http://${GIT_HOSTNAME}:${port}/?signin=${git}`);
            reply = { ok: true, address: `http://${APPROVE_HOSTNAME}:${port}/?signin=${approve}` };
          }
        } else if (request.op === "code") {
          reply = { ok: true, code: CODE };
        } else if (request.op === "stop") {
          connection.end(JSON.stringify({ ok: true }) + "\n");
          editors.close();
          editors6.close();
          for (const server of [...forwards.values(), ...forwards6.values()]) server.close();
          for (const entry of entries.values()) entry.link?.close();
          fs.rmSync(SOCKET, { force: true });
          fs.rmSync(PIDFILE, { force: true });
          process.exit(0);
        }
      } catch (error) {
        reply = { ok: false, error: String(error) };
      }
      connection.end(JSON.stringify(reply) + "\n");
    });
  }).listen(SOCKET, () => fs.chmodSync(SOCKET, 0o600));
  fs.writeFileSync(PIDFILE, String(process.pid));
  log(`daemon up, pid ${process.pid}`);

  // After a restart of the host: take up every workspace whose VM is running.
  try {
    const domains =
      await rootctlBrief<{ slug: string; workspaces: (WorkspacePlan & { proxy?: string })[] }[]>(
        "domain.list",
      );
    const running = new Set(
      (await b.list()).filter((vm) => vm.status === "running").map((vm) => vm.name),
    );
    const { isOwnVm } = await import("./workspaces.ts");
    for (const d of domains)
      for (const w of d.workspaces)
        // The root's word, checked: a record naming another domain's VM gets no link and no
        // proxy (it would give that VM this domain's names and rules: review of the fixes).
        if (running.has(w.vm) && w.domain === d.slug && isOwnVm(d.slug, w)) {
          const proxy = await rootctlBrief<{ socket: string }>("proxy.start", {
            vm: w.vm,
            domain: w.domain,
            workspace: w.workspace,
          });
          register({
            vm: w.vm,
            domain: w.domain,
            workspace: w.workspace,
            proxy: proxy.socket,
            checkouts: w.checkouts,
          } as Registered);
        }
  } catch (error) {
    log(`could not list workspaces at start: ${String(error)}`);
  }
  for (;;) {
    const started = Date.now();
    await Promise.all([...entries.values()].map(sync));
    reconcile();
    await tellRoot().catch(() => {});
    // Asking a VM costs what its exec costs: little on a Mac, seconds under emulation. The
    // pause is never shorter than a second, and never so short that asking is all the VMs do.
    await sleep(Math.max(1000, 3 * (Date.now() - started)));
  }
};

// ------------------------------------------------------------------ talking to it
const ask = (
  request: Record<string, unknown>,
  timeoutMs = 60_000,
): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const connection = connect(SOCKET);
    let buffer = "";
    const timer = setTimeout(() => {
      connection.destroy();
      reject(new Error("the host daemon did not answer"));
    }, timeoutMs);
    connection.on("connect", () => connection.write(JSON.stringify(request) + "\n"));
    connection.on("data", (chunk) => (buffer += chunk));
    connection.on("end", () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(buffer));
      } catch {
        reject(new Error("the host daemon sent no answer"));
      }
    });
    connection.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

const alive = () =>
  ask({ op: "ping" }, 3000).then(
    () => true,
    () => false,
  );

/** Tell `desolate events` of an approval given at a terminal. Best effort: no daemon, no event. */
export const announceApproved = (message: string) =>
  ask({ op: "approved", message }, 3000).catch(() => ({}));

declare namespace announceApproved {
  /** best effort: with no daemon there is no event, and the approval it follows is not undone */
  export type NoDaemon = Expect<
    Invoke<typeof announceApproved, [message: "desolate-approve v1 ..."]>,
    "=",
    {}
  >;
}

export const ensureDaemon = async () => {
  if (await alive()) {
    const running = await ask({ op: "code" }).catch(() => ({}) as Record<string, unknown>);
    if (running.code === CODE) return;
    // Started from other code: stopped, and started again below (it registers every
    // running workspace again as it starts).
    await stopForwarder();
    await waitFor(async () => !(await alive()), 10_000, 100);
  }
  fs.mkdirSync(paths.logs, { recursive: true });
  const log = fs.openSync(LOG, "a");
  const child = spawn(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", fileURLToPath(import.meta.url), "serve"],
    { detached: true, stdio: ["ignore", log, log], env: process.env },
  );
  child.unref();
  if (!(await waitFor(alive, 20_000, 100)))
    throw new Error(`the host daemon did not start; see ${LOG}`);
};

export const connectWorkspace = async (plan: WorkspacePlan & { proxy?: string | null }) => {
  await ensureDaemon();
  const reply = await ask({
    op: "register",
    vm: plan.vm,
    domain: plan.domain,
    workspace: plan.workspace,
    proxy: plan.proxy ?? null,
    checkouts: plan.checkouts,
  });
  if (reply.ok !== true)
    throw new Error(`the host daemon refused the workspace: ${String(reply.error)}`);
};

export const disconnectWorkspace = async (vm: string) => {
  if (await alive()) await ask({ op: "unregister", vm });
};

/** Why the daemon could not take the editors' port ("" when it holds it), or null when the
 *  daemon does not answer. Asked without starting a daemon: doctor reports, it does not fix. */
/** Refuses unless this daemon says it holds its port on both loopback addresses: an address
 *  with a token in it is printed only then (else it would be sent to whatever holds it). Not
 *  known is not held (P6): a daemon that does not answer refuses too. */
export const tokenAddressesSafe = async () => {
  const held = await editorPortError();
  if (held === null)
    refuse(
      "not printed: the host daemon did not say it holds its port, and this address carries a token",
      "desolate doctor",
    );
  if (held)
    refuse(
      `not printed: ${held}, and this address carries a token`,
      "stop what holds it, or give this stack another port: DESOLATE_EDITOR_PORT=<port> desolate bootstrap",
    );
};

declare namespace tokenAddressesSafe {
  /** the daemon holds its port on both loopback addresses: an address with a token may be printed */
  export type Held = Given<
    Invoke<typeof daemonAnswering, [reply: { ok: true; editor: { port: 31580; error: "" } }]>,
    Expect<Invoke<typeof refusalOf, [run: typeof tokenAddressesSafe]>, "=", null>
  >;
  /** another program has [::1] on that port, where browsers look first: it would be sent the token */
  export type HeldByAnother = Given<
    Invoke<
      typeof daemonAnswering,
      [
        reply: {
          ok: true;
          editor: {
            port: 31580;
            error: "a program on this machine holds [::1]:31580, where browsers look first";
          };
        },
      ]
    >,
    Expect<
      Invoke<typeof refusalOf, [run: typeof tokenAddressesSafe]>,
      "=",
      {
        message: "not printed: a program on this machine holds [::1]:31580, where browsers look first, and this address carries a token";
        fix: "stop what holds it, or give this stack another port: DESOLATE_EDITOR_PORT=<port> desolate bootstrap";
        code: 1;
      }
    >
  >;
  /** no daemon: not known is not held */
  export type NoDaemon = Expect<
    Invoke<typeof refusalOf, [run: typeof tokenAddressesSafe]>,
    "=",
    {
      message: "not printed: the host daemon did not say it holds its port, and this address carries a token";
      fix: "desolate doctor";
      code: 1;
    }
  >;
  /** a daemon that answers without saying (an older one, or a refusal) is not known either */
  export type NotSaid = Given<
    Invoke<typeof daemonAnswering, [reply: { ok: false; error: "unknown request" }]>,
    Expect<
      Invoke<typeof refusalOf, [run: typeof tokenAddressesSafe]>,
      "matches",
      { fix: "desolate doctor" }
    >
  >;
}
export const editorPortError = async (): Promise<string | null> => {
  if (!(await alive())) return null;
  const reply = await ask({ op: "editor" }, 10_000).catch(() => null);
  const editor = reply?.editor as { error?: unknown } | undefined;
  return reply?.ok === true ? String(editor?.error ?? "") : null;
};

declare namespace editorPortError {
  /** asked without starting a daemon: none running is null, not "" */
  export type NoDaemon = Expect<Invoke<typeof editorPortError>, "=", null>;
  /** "" when the daemon holds the port, else its reason, as it said it */
  export type Said = [
    Given<
      Invoke<typeof daemonAnswering, [reply: { ok: true; editor: { port: 31580; error: "" } }]>,
      Expect<Invoke<typeof editorPortError>, "=", "">
    >,
    Given<
      Invoke<
        typeof daemonAnswering,
        [
          reply: {
            ok: true;
            editor: { port: 31580; error: "a program on this machine holds port 31580" };
          },
        ]
      >,
      Expect<Invoke<typeof editorPortError>, "=", "a program on this machine holds port 31580">
    >,
  ];
  /** a daemon that refused the question has not said, so null */
  export type Refused = Given<
    Invoke<typeof daemonAnswering, [reply: { ok: false; error: "unknown request" }]>,
    Expect<Invoke<typeof editorPortError>, "=", null>
  >;
}

/** How near the root's state is to what this host reads of it (STATE_ANSWER_BYTES): the
 *  largest answer the running daemon has had, and the bound, in bytes; null when no daemon
 *  answers, or an older one that does not say. For `desolate doctor`. */
export const stateRoom = async (): Promise<{ largest: number; most: number } | null> => {
  if (!(await alive())) return null;
  const reply = await ask({ op: "editor" }, 10_000).catch(() => null);
  const state = reply?.state as { largest?: unknown; most?: unknown } | undefined;
  return reply?.ok === true &&
    Number.isSafeInteger(state?.largest) &&
    Number.isSafeInteger(state?.most)
    ? { largest: state!.largest as number, most: state!.most as number }
    : null;
};

declare namespace stateRoom {
  /** asked without starting a daemon: none running is null */
  export type NoDaemon = Expect<Invoke<typeof stateRoom>, "=", null>;
  /** what the daemon said, or null from one that does not say */
  export type Said = [
    Given<
      Invoke<
        typeof daemonAnswering,
        [reply: { ok: true; state: { largest: 2202009; most: 16777216 } }]
      >,
      Expect<Invoke<typeof stateRoom>, "=", { largest: 2202009; most: 16777216 }>
    >,
    Given<
      Invoke<typeof daemonAnswering, [reply: { ok: true; editor: { port: 31580; error: "" } }]>,
      Expect<Invoke<typeof stateRoom>, "=", null>
    >,
  ];
}

export const ports = async (): Promise<PortView[]> => {
  await ensureDaemon();
  const reply = await ask({ op: "ports" });
  if (reply.ok !== true) throw new Error(String(reply.error));
  return reply.ports as PortView[];
};

/** The host port every editor is on, and why it is not, if it is not. */
export const editorPort = async (): Promise<{ port: number; error: string }> => {
  await ensureDaemon();
  const reply = await ask({ op: "ports" });
  if (reply.ok !== true) throw new Error(String(reply.error));
  return reply.editor as { port: number; error: string };
};

/** Where the dashboard is, for a browser on this machine. */
/** The dashboard's address, with the token that lets a browser in (the root's state
 *  service exchanges it for a cookie). Like an editor's address, it is the person's to
 *  open, and not to paste anywhere else. */
export const ui = async (): Promise<{ dashboard: string; approvals: string }> => {
  await ensureDaemon();
  let token = "";
  try {
    token = fs.readFileSync(path.join(paths.state, "ui-token"), "utf8").trim();
  } catch {
    /* not bootstrapped */
  }
  if (!/^[0-9a-f]{48}$/.test(token))
    refuse("this stack has no dashboard credential yet", "desolate bootstrap");
  // An address with a token in it is printed only when this daemon holds its port, on both
  // loopback addresses: else it would be sent to whatever does.
  await tokenAddressesSafe();
  const { approveAddress } = await import("./approve-web.ts");
  return {
    dashboard: `http://${ROOT_HOSTNAME}:${editorHostPort()}/?tkn=${token}`,
    approvals: approveAddress(),
  };
};

/** `desolate ui --open`: one address that signs a browser in to the approval page, the git
 *  terminal and the dashboard, then shows the dashboard (signin.ts). Good once, for a minute. */
export const signinAddress = async (): Promise<string> => {
  await ensureDaemon();
  await tokenAddressesSafe();
  const reply = await ask({ op: "signin" }, 30_000);
  if (reply.ok !== true || typeof reply.address !== "string")
    refuse(
      `no sign-in link: ${String(reply.error ?? "the host daemon did not make one")}`,
      "desolate doctor",
    );
  return reply.address as string;
};

/** `desolate events`: the daemon's events, as they come, to `onLine`, for as long as this
 *  process runs (a daemon that restarts is connected to again; what it missed meanwhile is
 *  not replayed, but `replay` asks for the last ones the daemon still holds). */
export const followEvents = async (
  replay: number,
  onLine: (line: string) => boolean | void,
  drained?: (resume: () => void) => void,
): Promise<never> => {
  for (let first = true; ; first = false) {
    // The daemon is started once, here. A daemon that went away later (desolate down,
    // destroy) is waited for, never started again: a listener left running must not bring
    // back a stack that was taken down (found: one did, in a home destroy then deleted).
    if (first) await ensureDaemon();
    else while (!(await alive())) await sleep(2000);
    await new Promise<void>((resolve) => {
      const connection = connect(SOCKET);
      let buffer = "";
      connection.setEncoding("utf8");
      connection.on("connect", () =>
        connection.write(JSON.stringify({ op: "events", replay: first ? replay : 0 }) + "\n"),
      );
      connection.on("data", (chunk: string) => {
        buffer += chunk;
        let full = false;
        for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
          if (onLine(buffer.slice(0, end)) === false) full = true;
          buffer = buffer.slice(end + 1);
        }
        // Where the lines go is full: read no more until it drains.
        if (full && drained) {
          connection.pause();
          drained(() => connection.resume());
        }
      });
      connection.on("close", () => resolve());
      connection.on("error", () => resolve());
    });
    await sleep(1000);
  }
};

export const stopForwarder = async () => {
  if (await alive()) await ask({ op: "stop" }).catch(() => {});
};

if (
  process.argv[2] === "serve" &&
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
)
  void serve();
