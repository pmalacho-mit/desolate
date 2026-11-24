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
import { formatBytes } from "../shared/limits.ts";
import { define, valueOf, whole } from "../shared/settings.ts";
import { CUT, failure, printable } from "../shared/text.ts";
import { execFile, spawn } from "node:child_process";
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
import type { Backend as ApprovalBackend, PusherSaid } from "./approve-web.ts";
import { accountLines } from "../shared/review-account.ts";
import type { AccountLine, AccountRequest } from "../shared/review-account.ts";
import { statusDir } from "../shared/status.ts";
import type { WorkspacePlan } from "../shared/plan.ts";
import { sleep, waitFor } from "../shared/run.ts";
import { sniffSocket } from "../shared/sniff.ts";
import { guest, INSTANCE, paths, RELEASE_DIR } from "./paths.ts";
import { portHolder } from "./held-ports.ts";
import { retire, retiredAt } from "./retired.ts";
import { opened as statedReply } from "./replies.ts";
import type { Answer, Stated } from "./replies.ts";
import { backend, config, ROOT_VM, rootctl, rootctlBrief } from "./stack.ts";
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
  unasked,
  unforwardedOf,
} from "./forward.ts";
import type { Checkouts, PortView } from "./forward.ts";
import type { Listed } from "../shared/listed.ts";
import type { Row } from "./agent.ts";
import type { Looked } from "./workspaces.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type {
  Call,
  Expect,
  Given,
  Invoke,
  Mock,
  Mocked,
  Table,
  Throws,
} from "../../suede.nests/dsl.import.meta.vitest.ts";
import type {
  answerOf,
  answers,
  askedOver,
  daemonAnswering,
  failsAtOnce,
  failsHalfway,
  heldWatch,
  keepLog,
  linesInPieces,
  endsOf,
  numbered,
  opened,
  pipeEnds,
  refusedAs,
  setOf,
  shown,
  silentClients,
  sixGiB,
} from "../.harness/host-daemon.ts";
import type { emptyHome, writeState } from "../.harness/home.ts";
import type { firstOf, spawnedAs, stillRunning, vmRunning } from "../.harness/host-web.ts";
import type { all } from "../.harness/shared-review-account.ts";
import type { abortedIn } from "../.harness/shared-run.ts";
import type { repeated } from "../.harness/shared-bytes.ts";
import type { refusalOf } from "../.harness/refusal.ts";

const SOCKET = path.join(paths.state, "daemon.sock");
const PIDFILE = path.join(paths.state, "daemon.pid");
const LOG = path.join(paths.logs, "daemon.log");
const NODE = ["node", "--disable-warning=ExperimentalWarning"];

/** The workspace daemon's socket in its VM (workspace/wsd.ts). wsd runs as the VM's login
 *  user (workspace/start.sh: runuser with the Mac user's uid, which is the login user's, as
 *  Lima makes it), and a dial's socat runs as that user (the fake backend's as root): the
 *  socket's 0600 lets in all that must connect. */
const WSD_SOCKET = "/run/desolate/wsd.sock";
/** The longest line of a workspace daemon's that is read. The VM is not trusted, and an honest
 *  answer is a line of ports and a token; the daemon there caps a request at 64 KiB too. */
const WSD_MOST = 64 * 1024;

/** Lines as they come, in chunks cut anywhere: hand it each chunk, and it gives the whole
 *  lines that chunk ended, or an Error once a line is longer than `most` bytes. Never more
 *  than `most` bytes of an unfinished line are kept: what the VM sends past that is not read.
 *  The pieces of a line are joined once, when it ends: the root's state is one line of up to
 *  16 MiB (STATE_ANSWER_BYTES), and joined at every chunk, reading it was quadratic in its
 *  size. `who`: what sent the lines, as a refusal names it. */
export const lineReader = (most = WSD_MOST, who = "the workspace's daemon") => {
  let kept: Buffer[] = [];
  let size = 0;
  const tooLong = () => new Error(`${who} sent a line of more than ${most} bytes`);
  return (chunk: Buffer): string[] | Error => {
    const lines: string[] = [];
    for (let end = chunk.indexOf(10); end >= 0; end = chunk.indexOf(10)) {
      if (size + end > most) return tooLong();
      lines.push(Buffer.concat([...kept, chunk.subarray(0, end)]).toString("utf8"));
      kept = [];
      size = 0;
      chunk = chunk.subarray(end + 1);
    }
    if (size + chunk.length > most) return tooLong();
    if (chunk.length > 0) kept.push(Buffer.from(chunk));
    size += chunk.length;
    return lines;
  };
};

declare namespace lineReader {
  /** two lines in one chunk, and a line split across chunks: each whole, in order */
  export type Lines = [
    Expect<
      Invoke<typeof linesInPieces, [reader: typeof lineReader, chunks: ['{"a":1}\n{"b":2}\n']]>,
      "=",
      { lines: ['{"a":1}', '{"b":2}'] }
    >,
    Expect<
      Invoke<
        typeof linesInPieces,
        [reader: typeof lineReader, chunks: ['{"lis', 'teners":[3000]}\n{"b"', ":2}\n"]]
      >,
      "=",
      { lines: ['{"listeners":[3000]}', '{"b":2}'] }
    >,
  ];
  /** what has not ended in a newline is not a line yet: a stream that ends there gave none */
  export type Unfinished = Expect<
    Invoke<typeof linesInPieces, [reader: typeof lineReader, chunks: ['{"ok":true}']]>,
    "=",
    { lines: [] }
  >;
  /** a line of `most` bytes is read; one byte more is refused, whether it came in one chunk
   *  or in several, and whether or not its newline had come */
  export type Bound = [
    Expect<
      Invoke<typeof linesInPieces, [reader: typeof lineReader, chunks: ["12345678\n"], most: 8]>,
      "=",
      { lines: ["12345678"] }
    >,
    Expect<
      Invoke<typeof linesInPieces, [reader: typeof lineReader, chunks: ["123456789\n"], most: 8]>,
      "=",
      { lines: []; error: "the workspace's daemon sent a line of more than 8 bytes" }
    >,
    Expect<
      Invoke<
        typeof linesInPieces,
        [reader: typeof lineReader, chunks: ["1\n12345", "6789"], most: 8]
      >,
      "=",
      { lines: ["1"]; error: "the workspace's daemon sent a line of more than 8 bytes" }
    >,
  ];
}

/** A line of a workspace daemon's, as JSON: an object, or an Error saying it was none. */
const wsdReply = (line: string): Record<string, unknown> | Error => {
  try {
    const value: unknown = JSON.parse(line);
    if (value !== null && typeof value === "object" && !Array.isArray(value))
      return value as Record<string, unknown>;
  } catch {
    /* said below */
  }
  return new Error("the workspace's daemon answered something that is not an answer");
};

/** How long to wait before a workspace's watch that ended is opened again: a second, doubling
 *  to 30 s while each lasts less than 30 s, and a second again after one that lasted. Each
 *  open is one ssh session into the VM (with commands over plain ssh, ticket #250 step 2:
 *  1.5 MB and 8 ms), so a daemon there that is gone costs one every 30 s, and a daemon that
 *  comes back is watched within 30 s. In the first minute after the workspace was
 *  registered, a second: it is registered before its services start (workspaces.ts,
 *  startServices), and what its daemon says then (its editor's token, its dev servers) is
 *  wanted at once. */
export const reopenAfter = (previous: number, livedMs: number, registeredMs: number) =>
  livedMs >= 30_000 || registeredMs < 60_000
    ? 1000
    : Math.min(30_000, Math.max(1000, previous * 2));

declare namespace reopenAfter {
  export type Backoff = Table<
    typeof reopenAfter,
    [
      [args: [previous: 0, livedMs: 0, registeredMs: 600000], expected: 1000],
      [args: [previous: 1000, livedMs: 40, registeredMs: 600000], expected: 2000],
      [args: [previous: 16000, livedMs: 40, registeredMs: 600000], expected: 30000],
      [args: [previous: 30000, livedMs: 40, registeredMs: 600000], expected: 30000],
      /** one that had lasted: from a second again */
      [args: [previous: 30000, livedMs: 60000, registeredMs: 600000], expected: 1000],
      /** a workspace still starting: every second, for its first minute */
      [args: [previous: 16000, livedMs: 40, registeredMs: 5000], expected: 1000],
    ]
  >;
}

/** A watch held open: `open` makes its stream, which is sent `first()`; each line on it, as
 *  JSON, goes to `line`, one after another. A stream that ends or fails, sends a line past the
 *  bound, or whose line `line` refuses, goes to `missed`, and another is opened after
 *  `delay(previous, livedMs)` ms. So until `close`, there is always a stream, or one about to
 *  be opened: no path out of a stream's end leaves none. `write` sends on the open one, if any (the next one is sent `first()` again). */
export const holdWatch = (watch: {
  open: () => Duplex;
  first: () => string;
  line: (reply: Record<string, unknown>) => Promise<void>;
  missed: (error: unknown) => void;
  delay: (previous: number, livedMs: number) => number;
}) => {
  let stream: Duplex | null = null;
  let timer: NodeJS.Timeout | null = null;
  let closed = false;
  let previous = 0;
  const start = () => {
    timer = null;
    if (closed) return;
    const held = watch.open();
    const opened = Date.now();
    const read = lineReader();
    let applying = Promise.resolve();
    stream = held;
    const end = (error: unknown) => {
      if (stream !== held) return;
      stream = null;
      held.destroy();
      if (closed) return;
      watch.missed(error);
      previous = watch.delay(previous, Date.now() - opened);
      timer = setTimeout(start, previous);
    };
    held.on("data", (chunk: Buffer) => {
      const lines = read(chunk);
      if (lines instanceof Error) return end(lines);
      for (const line of lines) {
        const reply = wsdReply(line);
        if (reply instanceof Error) return end(reply);
        // Kept though its stream ends just after (what it said, it said), not once closed.
        applying = applying.then(() => (closed ? undefined : watch.line(reply))).catch(end);
      }
    });
    held.on("error", end);
    held.on("end", () => end(new Error("its watch closed")));
    held.on("close", () => end(new Error("its watch closed")));
    held.write(watch.first());
  };
  start();
  return {
    write: (text: string) => void stream?.write(text),
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
      const held = stream;
      stream = null;
      held?.destroy();
    },
  };
};

declare namespace holdWatch {
  /** each line is handed on; a stream that ends, one that sends a line past the bound, one
   *  whose line is refused: each a miss, and another stream is opened every time */
  export type Reopens = Expect<
    Invoke<
      typeof heldWatch,
      [
        hold: typeof holdWatch,
        streams: [
          { chunks: ['{"ok":true,"listeners":[3000]}\n']; end: true },
          { chunks: [Invoke<typeof repeated, [text: "x", count: 70000]>]; end: false },
          { chunks: ['{"ok":false,"error":"busy"}\n']; end: false },
          { chunks: ['{"ok":true,"listeners":[5173]}\n']; end: false },
        ],
      ]
    >,
    "=",
    {
      sent: ['{"op":"watch"}\n', '{"op":"watch"}\n', '{"op":"watch"}\n', '{"op":"watch"}\n'];
      lines: ['{"ok":true,"listeners":[3000]}', '{"ok":true,"listeners":[5173]}'];
      missed: [
        "its watch closed",
        "the workspace's daemon sent a line of more than 65536 bytes",
        "busy",
      ];
      openAfterClose: 0;
    }
  >;
}

type Registered = { vm: string; domain: string; workspace: string; proxy: string | null };
type Entry = Registered & {
  listeners: Set<number>;
  reserved: Set<number>;
  /** Closes its link: its servers, and every connection they took. */
  link: (() => void) | null;
  /** When its daemon last answered (Date.now()): what it said is kept a while past a miss. */
  answeredAt: number;
  /** When it was registered (Date.now()), for its watch's first minute (reopenAfter). */
  registeredAt: number;
  /** Its watch (a dial to its daemon, held: holdWatch), and the reserve last sent on it. */
  watch: ReturnType<typeof holdWatch> | null;
  watchSent: string;
  /** Its checkouts' paths, as this host knows them: what its daemon is asked to look at, and
   *  the only ones an answer may name (lostIn). */
  paths: string[];
  /** What a remove would lose, as its daemon last said, and its agents (null: not said). */
  looked: Looked | null;
  agents: Listed<Row> | null;
  /** What was last logged of it not answering, so a daemon that is gone is said once. */
  missSaid: string;
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
  /** Its connections carried each way, and of those refused how many, the last when and why,
   *  and when the daemon's log last said so (carrying). */
  carried: Record<Way, number>;
  refused: Record<Way, { count: number; at: string; why: string; logged: number }>;
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

/** What `client` says first (shared/sniff.ts), held meanwhile among `silent`: the clients
 *  that have said nothing yet. When `most` are, the one that has waited longest is closed. */
const heard = async (silent: Set<Socket>, client: Socket, quietMs: number, most = SILENT_MOST) => {
  if (silent.size >= most) {
    const oldest = silent.values().next().value;
    if (oldest) (silent.delete(oldest), oldest.destroy());
  }
  silent.add(client);
  try {
    return await sniffSocket(client, quietMs);
  } finally {
    silent.delete(client);
  }
};

declare namespace heard {
  /** clients that open and say nothing (another user's program, on a forwarded port) are
   *  held `most` at a time: one more and the longest-waiting goes, not the newest, so they
   *  cannot keep the person's own out. The control: `most` of them, all held */
  export type Bounded = [
    Expect<
      Invoke<typeof silentClients, [hear: typeof heard, count: 4, most: 3]>,
      "=",
      [true, false, false, false]
    >,
    Expect<
      Invoke<typeof silentClients, [hear: typeof heard, count: 3, most: 3]>,
      "=",
      [false, false, false]
    >,
  ];
}
/** How long a refused connection is given to read its answer and close (carrying): a
 *  workspace's relay reads it at once, and so does a browser. */
const REFUSED_MS = 5000;
/** The most connections at once in their handshake on one vz link's loopback port
 *  (openLink). Each costs a socket of this daemon's, not a session into the root, and any
 *  program of any user's can open them: so far above what a guest needs that a flood must
 *  open this many within the guest's own handshake to keep it off its link. */
const PROVING_MOST = 1024;

/** The most of one answer from the root's state service this host reads: a hard bound
 *  against the root's user, whose service parses what domains send (decisions.md, "the
 *  root's user's service is bounded"). The whole state is one line (heldAsker), and it
 *  grows with domains, offers and issues, so how near it is is said (`desolate doctor`,
 *  stateRoom): a state past it ends the stream it came on, and so stops `desolate events`
 *  and the dashboard's actions. */
const STATE_ANSWER_BYTES = 16 * 1024 * 1024;

/** How many connections out of one workspace are carried to its proxy at once; past it, one
 *  is refused at once, saying so. */
export const LINK_CONNECTIONS = define({
  name: "link.connections",
  env: "DESOLATE_LINK_CONNECTIONS",
  side: "host",
  default: () => 256,
  // Every session into the root VM is one of its sshd's, which allows 1000 on a connection
  // (root/start.sh, MaxSessions): no workspace may have more than that.
  parse: whole(1, 1000),
  why: "How many connections out of one workspace (its downloads, its installs) are carried to its proxy at once; past it, one is refused at once. Each is a plain ssh session: about 1.5 MB of this Mac's memory and 1.2 MB of the VM's.",
});

/** The most connections this Mac carries at once into and out of all its workspaces
 *  together. Each is a socket of this daemon's, which carries every workspace, and an ssh
 *  session: about 1.5 MB here, and 1.2 MB in the VM it reaches (200 held at once in the
 *  root VM, which has 3.9 GiB: measured on the M1, 2026-11-23). Every connection out is a
 *  session on the one control connection to the root VM as its login user, and so are the
 *  dashboard's pipes to the state service; sshd takes 1,000 sessions a connection, in the
 *  root VM and every workspace VM (root/start.sh, workspace/start.sh: MaxSessions). So this
 *  stays under 1,000, with room for the host's own sessions on that connection. */
const CONNECTIONS_MOST = 800;

/** `n` connections, the word agreeing with the count. */
const connections = (n: number) => `${n} connection${n === 1 ? "" : "s"}`;

/** A connection into a workspace (to its dev servers, its editor) or out of it (its link). */
type Way = "in" | "out";

/** Why a connection `way` is refused, its workspace carrying `theirs` that way and this Mac
 *  `all` (both ways, every workspace); or null: it is carried. Each way has its own `most`
 *  (link.connections), so that a flood one way does not starve the other. */
const connectionRefusal = (way: Way, theirs: number, all: number, most: number) =>
  all >= CONNECTIONS_MOST
    ? `this Mac has ${connections(CONNECTIONS_MOST)} into and out of its workspaces carried at once, the most it may (a bound of desolate's own: one must end, or a workspace be stopped: desolate stop <domain>/<workspace>)`
    : theirs >= most
      ? `this workspace has ${connections(most)} ${way} carried at once, the most it may (the setting link.connections; on the Mac: DESOLATE_LINK_CONNECTIONS=<n> desolate bootstrap)`
      : null;

declare namespace connectionRefusal {
  /** carried below the workspace's bound each way and below this Mac's; refused at either,
   *  saying which. The controls: one below each bound, carried */
  export type Verdicts = Table<
    typeof connectionRefusal,
    [
      [args: [way: "in", theirs: 0, all: 0, most: 256], expected: null],
      [args: [way: "in", theirs: 255, all: 799, most: 256], expected: null],
      [args: [way: "out", theirs: 255, all: 799, most: 256], expected: null],
      [
        args: [way: "in", theirs: 256, all: 256, most: 256],
        expected: "this workspace has 256 connections in carried at once, the most it may (the setting link.connections; on the Mac: DESOLATE_LINK_CONNECTIONS=<n> desolate bootstrap)",
      ],
      [
        args: [way: "in", theirs: 1, all: 1, most: 1],
        expected: "this workspace has 1 connection in carried at once, the most it may (the setting link.connections; on the Mac: DESOLATE_LINK_CONNECTIONS=<n> desolate bootstrap)",
      ],
      [
        args: [way: "out", theirs: 2, all: 2, most: 2],
        expected: "this workspace has 2 connections out carried at once, the most it may (the setting link.connections; on the Mac: DESOLATE_LINK_CONNECTIONS=<n> desolate bootstrap)",
      ],
      [
        args: [way: "in", theirs: 0, all: 800, most: 256],
        expected: "this Mac has 800 connections into and out of its workspaces carried at once, the most it may (a bound of desolate's own: one must end, or a workspace be stopped: desolate stop <domain>/<workspace>)",
      ],
      [
        args: [way: "out", theirs: 0, all: 800, most: 256],
        expected: "this Mac has 800 connections into and out of its workspaces carried at once, the most it may (a bound of desolate's own: one must end, or a workspace be stopped: desolate stop <domain>/<workspace>)",
      ],
    ]
  >;
}

/** An answer of the forwarder's own, as text, with `heads` before its own. */
const httpAnswer = (status: string, text: string, heads = "") =>
  `HTTP/1.1 ${status}\r\n${heads}Content-Type: text/plain; charset=utf-8\r\nX-Content-Type-Options: nosniff\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`;

/** What a refused connection is answered, out (as its proxy refuses: the workspace's relay,
 *  workspace/net/egress.ts, shows a plain-HTTP program the reason) or in (to a browser, which
 *  shows the text). */
const busyAnswer = (why: string) =>
  httpAnswer("503 Service Unavailable", `desolate: ${why}\n`, `X-Desolate-Reason: ${why}\r\n`);

declare namespace busyAnswer {
  export type Answer = Expect<
    Invoke<typeof busyAnswer, [why: "this workspace has 2 connections in carried at once"]>,
    "=",
    "HTTP/1.1 503 Service Unavailable\r\nX-Desolate-Reason: this workspace has 2 connections in carried at once\r\nContent-Type: text/plain; charset=utf-8\r\nX-Content-Type-Options: nosniff\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: 62\r\n\r\ndesolate: this workspace has 2 connections in carried at once\n"
  >;
}

/** `client` piped to `upstream`, what the client already said (`head`) first: either side's
 *  close or error ends both. */
const pipe = (client: Duplex, upstream: Duplex, head: Buffer) => {
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

/** The pipes into and out of workspaces' VMs, counted. `carry` pipes a client to `open()`
 *  while its workspace carries fewer than `most` that way and this Mac fewer than
 *  CONNECTIONS_MOST; past either nothing is dialed, and the client is answered why (`http`)
 *  or closed. A connection counts until its client closes, which every end of a pipe comes
 *  to. A refusal is kept for `desolate ports` and logged at most once a minute a way (the
 *  workspace is not trusted with this Mac's disk). A refused client is let go: what it sends
 *  is dropped, and it is destroyed after REFUSED_MS, or at once past CONNECTIONS_MOST being
 *  answered: one held open would hold a descriptor of this daemon's. `take` is the count
 *  alone, for a connection piped otherwise. */
export const carrying = (most: number, log: (line: string) => void) => {
  let all = 0;
  let answering = 0;
  const take = (entry: Pick<Entry, "vm" | "carried" | "refused">, way: Way, client: Duplex) => {
    const why = connectionRefusal(way, entry.carried[way], all, most);
    if (why === null) {
      entry.carried[way] += 1;
      all += 1;
      client.once("close", () => ((entry.carried[way] -= 1), (all -= 1)));
      return null;
    }
    const refused = entry.refused[way];
    Object.assign(refused, { count: refused.count + 1, at: new Date().toISOString(), why });
    if (Date.now() - refused.logged > 60_000) {
      refused.logged = Date.now();
      log(`${entry.vm}: refused a connection ${way} (${refused.count} so far): ${why}`);
    }
    return why;
  };
  const carry = (
    entry: Pick<Entry, "vm" | "carried" | "refused">,
    way: Way,
    client: Duplex,
    open: () => Duplex,
    head: Buffer,
    http: boolean,
  ) => {
    // A client already gone is neither counted nor carried: its close has been and gone.
    if (client.destroyed) return;
    const why = take(entry, way, client);
    if (why === null) return pipe(client, open(), head);
    if (!http || answering >= CONNECTIONS_MOST) return void client.destroy();
    answering += 1;
    const timer = setTimeout(() => client.destroy(), REFUSED_MS);
    client.once("close", () => ((answering -= 1), clearTimeout(timer)));
    client.resume();
    client.end(busyAnswer(why));
  };
  return { take, carry, all: () => all };
};

declare namespace carrying {
  /** each workspace's bound is its own, and each way's: three in to one workspace and the
   *  third is refused, while its connections out and another workspace's in are carried
   *  meanwhile (the controls); when one in ends, the next is carried */
  export type EachWay = Expect<
    Invoke<
      typeof opened,
      [
        carrying: typeof carrying,
        most: 2,
        steps: [
          [vm: "w1", way: "in", count: 3],
          [vm: "w1", way: "out", count: 2],
          [vm: "w2", way: "in", count: 2],
          [vm: "w1", way: "out", count: 1],
          [vm: "w1", way: "in", count: -1],
          [vm: "w1", way: "in", count: 1],
        ],
      ]
    >,
    "=",
    [
      {
        carried: 2;
        refused: [
          "this workspace has 2 connections in carried at once, the most it may (the setting link.connections; on the Mac: DESOLATE_LINK_CONNECTIONS=<n> desolate bootstrap)",
        ];
      },
      { carried: 2; refused: [] },
      { carried: 2; refused: [] },
      {
        carried: 0;
        refused: [
          "this workspace has 2 connections out carried at once, the most it may (the setting link.connections; on the Mac: DESOLATE_LINK_CONNECTIONS=<n> desolate bootstrap)",
        ];
      },
      { ended: 1; all: 5 },
      { carried: 1; refused: [] },
    ]
  >;
  /** this Mac's bound is in and out of every workspace together: 800 carried (the control),
   *  and the next is refused either way, in any workspace, until one ends */
  export type InAll = Expect<
    Invoke<
      typeof opened,
      [
        carrying: typeof carrying,
        most: 300,
        steps: [
          [vm: "w1", way: "in", count: 300],
          [vm: "w2", way: "out", count: 300],
          [vm: "w3", way: "in", count: 100],
          [vm: "w4", way: "out", count: 100],
          [vm: "w4", way: "in", count: 1],
          [vm: "w1", way: "out", count: 1],
          [vm: "w2", way: "out", count: -1],
          [vm: "w4", way: "in", count: 1],
        ],
      ]
    >,
    "=",
    [
      { carried: 300; refused: [] },
      { carried: 300; refused: [] },
      { carried: 100; refused: [] },
      { carried: 100; refused: [] },
      {
        carried: 0;
        refused: [
          "this Mac has 800 connections into and out of its workspaces carried at once, the most it may (a bound of desolate's own: one must end, or a workspace be stopped: desolate stop <domain>/<workspace>)",
        ];
      },
      {
        carried: 0;
        refused: [
          "this Mac has 800 connections into and out of its workspaces carried at once, the most it may (a bound of desolate's own: one must end, or a workspace be stopped: desolate stop <domain>/<workspace>)",
        ];
      },
      { ended: 1; all: 799 },
      { carried: 1; refused: [] },
    ]
  >;
  /** refused, a request is answered why (busyAnswer) and closed; anything else is closed
   *  with no word, since it named nothing that could be answered */
  export type Refused = Table<
    typeof refusedAs,
    [
      [
        args: [carrying: typeof carrying, http: true],
        expected: Invoke<
          typeof busyAnswer,
          [
            why: "this workspace has 1 connection in carried at once, the most it may (the setting link.connections; on the Mac: DESOLATE_LINK_CONNECTIONS=<n> desolate bootstrap)",
          ]
        >,
      ],
      [args: [carrying: typeof carrying, http: false], expected: ""],
    ]
  >;
  /** the count goes back down however a pipe ends: its client hanging up, the dial's end
   *  closing, an error, a dial that could not start (what dial() gives when the VM layer
   *  throws); and a client gone before it is carried is not counted. The control: a pipe
   *  that has not ended is still counted */
  export type Ends = Table<
    typeof pipeEnds,
    [
      [args: [carrying: typeof carrying, end: "client"], expected: { held: 1; after: 0 }],
      [args: [carrying: typeof carrying, end: "upstream"], expected: { held: 1; after: 0 }],
      [args: [carrying: typeof carrying, end: "error"], expected: { held: 1; after: 0 }],
      [args: [carrying: typeof carrying, end: "unstarted"], expected: { held: 1; after: 0 }],
      [args: [carrying: typeof carrying, end: "gone"], expected: { held: 0; after: 0 }],
      [args: [carrying: typeof carrying, end: "none"], expected: { held: 1; after: 1 }],
    ]
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
    const child = backend().spawn(ROOT_VM, argv, { root: true });
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
  const asked = reviewerAsked(request, signal);
  for await (const line of accountLines(asked.bytes)) {
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
    [
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
      >,
      /** asked as root in the root VM, the request on its input alone: nothing of it in the
       *  program's words or its environment */
      Expect<
        Invoke<typeof spawnedAs>,
        "=",
        [
          {
            vm: "dsl-main-root";
            argv: [
              "node",
              "--disable-warning=ExperimentalWarning",
              "/desolate/release/root/review-ask.ts",
            ];
            options: { root: true };
          },
        ]
      >,
    ]
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
        [value: Invoke<typeof vmRunning, [script: "printf 'bad \\033[2Jref' >&2; exit 2"]>]
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
          [value: Invoke<typeof vmRunning, [script: "echo null"]>]
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
          [value: Invoke<typeof vmRunning, [script: "echo '[{\"ok\":true}]'"]>]
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
    // Held by the root until its list changes, and ended with the page's request.
    pending: (since, signal) =>
      since === ""
        ? rootctlBrief("approvals.wait", { since }, { signal })
        : rootctl("approvals.wait", { since }, { quiet: true, signal }),
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
      (await rootctlBrief("issue.list", { waiting: true })).kept.filter(
        (i) => i.state === "approving",
      ),
    publishIssue: async (issue) => {
      const url = await (await import("./issues.ts")).publish(issue);
      events.publish(events.host("issue-published", { repo: issue.repo, id: issue.id, url }));
      return url;
    },
    refuseIssue: async (issue) => (await import("./issues.ts")).refuseIssue(issue),
    pushes: (heard) =>
      events.listen(0, (line) => {
        const e = JSON.parse(line) as PusherSaid & { source: string };
        if (e.source === "pusher") heard(e);
      }),
    github: () => config()?.forge.kind === "github",
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

/** A workspace's agents as the dashboard is told of them: the running first, then the one
 *  that spoke last, a few, each command cut to a line, and how many there are. A VM may list
 *  a thousand (agent.ts), and the facts are one request, of which the state service takes
 *  256 KiB (root/stated.ts BODY_BYTES); `desolate agent list` has the rest. */
const AGENTS_SHOWN = 8;
/** Three quarters of what root/stated.ts takes of a request (BODY_BYTES, 256 KiB). */
const FACTS_MOST = 192 * 1024;
const COMMAND_SHOWN = 200;
const shownAgents = (agents: {
  items: {
    name: string;
    state: string;
    exit: number | null;
    started: string;
    lastOutput: string | null;
    command: string[];
  }[];
  total: number;
}) => ({
  items: [...agents.items]
    .sort(
      (a, b) =>
        Number(b.state === "running") - Number(a.state === "running") ||
        (b.lastOutput ?? b.started).localeCompare(a.lastOutput ?? a.started),
    )
    .slice(0, AGENTS_SHOWN)
    .map((a) => ({
      name: a.name,
      state: a.state,
      exit: a.exit,
      lastOutput: a.lastOutput,
      command: a.command.join(" ").slice(0, COMMAND_SHOWN),
    })),
  total: agents.total,
});

declare namespace shownAgents {
  type Agent<Name extends string, State extends string, Last extends string> = {
    name: Name;
    state: State;
    exit: null;
    started: "2026-11-21T20:00:00Z";
    lastOutput: Last;
    command: ["npx vitest"];
  };
  /** the running first, then the one that spoke last; the count is of all of them */
  export type Order = Expect<
    Invoke<
      typeof shownAgents,
      [
        agents: {
          items: [
            Agent<"old", "exited", "2026-11-21T20:01:00Z">,
            Agent<"new", "exited", "2026-11-21T20:09:00Z">,
            Agent<"tests", "running", "2026-11-21T20:05:00Z">,
          ];
          total: 3;
        },
      ]
    >,
    "matches",
    { items: [{ name: "tests" }, { name: "new" }, { name: "old" }]; total: 3 }
  >;
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

/** The root's state service's own socket (root/stated.ts HOST_SOCKET): only the root's user,
 *  whom a dial reaches the VM as, can open it. */
const STATED_SOCKET = "/run/desolate/stated/host.sock";

/** Questions to the root's state service, all on one stream: dialed by the first, held, and
 *  dialed again by the next once it ends. A question is a line, `{n, op, args}`; a line back,
 *  `{n, reply}`, answers the question of that number, in rootctl's envelope, and the Mac takes
 *  of it what host/replies.ts takes for `stated.<op>`.
 *
 *  WHY ONE HELD STREAM. Two questions are held by the service until it has something to say
 *  (the state once it is not the one the Mac has; the dashboard's requests once there are
 *  some); the rest (facts, a nudge, a request's progress, a sign-in code) want their answer at
 *  once. rootctl's channel is one question to a connection, and its service is another
 *  process, without the state; HTTP was a client of its own, with a token, on a port every
 *  process in the root VM can open. So: one stream to the service's own socket, each question
 *  waiting on its number, as a workspace's watch is held (holdWatch).
 *
 *  A line that answers no question waiting, one past `most`, the stream's end, and a question
 *  not answered in its time each end the stream and refuse every question on it at once. An
 *  answer not in its form refuses its own question only. `ended`: told when a stream ends. */
export const heldAsker = (open: () => Duplex, ended = () => {}, most = STATE_ANSWER_BYTES) => {
  type Waiting = {
    op: Stated;
    asked: Record<string, unknown>;
    timer: NodeJS.Timeout;
    resolve: (answer: unknown) => void;
    reject: (error: Error) => void;
  };
  const waiting = new Map<number, Waiting>();
  let stream: Duplex | null = null;
  let n = 0;
  let largest = 0;
  const end = (held: Duplex, why: Error) => {
    if (stream !== held) return;
    stream = null;
    held.destroy();
    for (const question of waiting.values()) {
      clearTimeout(question.timer);
      question.reject(why);
    }
    waiting.clear();
    ended();
  };
  const start = () => {
    const held = open();
    const read = lineReader(most, "the root's state service");
    held.on("data", (chunk: Buffer) => {
      const lines = read(chunk);
      if (lines instanceof Error) return end(held, lines);
      for (const line of lines) {
        largest = Math.max(largest, Buffer.byteLength(line));
        let answer: { n?: unknown; reply?: unknown } = {};
        try {
          answer = Object(JSON.parse(line));
        } catch {
          /* answers nothing: said below */
        }
        const question = typeof answer.n === "number" ? waiting.get(answer.n) : undefined;
        if (!question)
          return end(
            held,
            new Error(
              "the root's state service sent a line that answers no question of this Mac's (n)",
            ),
          );
        waiting.delete(answer.n as number);
        clearTimeout(question.timer);
        try {
          question.resolve(statedReply(`stated.${question.op}`, answer.reply, question.asked));
        } catch (error) {
          question.reject(error as Error);
        }
      }
    });
    held.on("error", (error) => end(held, error));
    // Its end, not only its close: a dial is a program (ssh, socat) whose output ends when the
    // service's side does, and a stream left open for writing is never closed. (A question
    // held while the service was started again waited out its whole time, 70 s, with nothing
    // said on the dashboard's clicks or `desolate events` meanwhile: T2 09-ui, 2026-11-23.)
    for (const event of ["end", "close"])
      held.on(event, () => end(held, new Error("the root's state service is not there")));
    return held;
  };
  return {
    ask: <O extends Stated>(
      op: O,
      asked: Record<string, unknown> = {},
      timeoutMs = 15_000,
    ): Promise<Answer<`stated.${O}`>> =>
      new Promise((resolve, reject) => {
        const held = (stream ??= start());
        const timer = setTimeout(
          () => end(held, new Error("the root's state service did not answer")),
          timeoutMs,
        );
        waiting.set(++n, {
          op,
          asked,
          timer,
          resolve: resolve as (answer: unknown) => void,
          reject,
        });
        held.write(`${JSON.stringify({ n, op, args: asked })}\n`);
      }),
    /** The longest line the service has sent, in bytes: for doctor, to say how near
     *  STATE_ANSWER_BYTES the state is. */
    largest: () => largest,
  };
};

declare namespace heldAsker {
  type State = '{"tag":"0123456789abcdef","state":{"lookAsked":2,"bounds":{"slug":40}}}';
  /** answers in another order than the questions: each question gets its own, as its table
   *  takes it (what the Mac does not read is dropped), on one stream */
  export type ByNumber = Expect<
    Invoke<
      typeof askedOver,
      [
        asker: typeof heldAsker,
        rounds: [[["state", { since: "" }], ["nudge", {}]]],
        streams: [
          {
            replies: [
              [],
              [
                '{"n":2,"reply":{"ok":true,"result":null}}\n',
                `{"n":1,"reply":{"ok":true,"result":${State}}}\n`,
              ],
            ];
          },
        ],
      ]
    >,
    "=",
    {
      answers: [{ tag: "0123456789abcdef"; state: { lookAsked: 2 } }, undefined];
      opened: 1;
      ended: 0;
    }
  >;
  /** an answer not in its form refuses its own question, in words that name the question and
   *  the field, never what it held; the stream stays (the control: the next question is
   *  answered on it) */
  export type NotInForm = Expect<
    Invoke<
      typeof askedOver,
      [
        asker: typeof heldAsker,
        rounds: [[["state", { since: "" }]], [["nudge", {}]]],
        streams: [
          {
            replies: [
              ['{"n":1,"reply":{"ok":true,"result":{"tag":"\\u001b[2J","state":{}}}}\n'],
              ['{"n":2,"reply":{"ok":true,"result":null}}\n'],
            ];
          },
        ],
      ]
    >,
    "=",
    {
      answers: [
        "the root's answer to 'stated.state' is not in the form this Mac takes (tag)",
        undefined,
      ];
      opened: 1;
      ended: 0;
    }
  >;
  /** a line that answers no question waiting, one that is not JSON, and the stream's end:
   *  each refuses every question waiting at once, and the next question dials again and is
   *  answered (the control) */
  export type Ends = Expect<
    Invoke<
      typeof askedOver,
      [
        asker: typeof heldAsker,
        rounds: [
          [["requests", {}], ["nudge", {}]],
          [["nudge", {}]],
          [["nudge", {}]],
          [["nudge", {}]],
        ],
        streams: [
          { replies: [[], ['{"n":9,"reply":{"ok":true,"result":null}}\n']] },
          { replies: [["not json\n"]] },
          { replies: [[]]; endAfter: 1 },
          { replies: [['{"n":5,"reply":{"ok":true,"result":null}}\n']] },
        ],
      ]
    >,
    "=",
    {
      answers: [
        "the root's state service sent a line that answers no question of this Mac's (n)",
        "the root's state service sent a line that answers no question of this Mac's (n)",
        "the root's state service sent a line that answers no question of this Mac's (n)",
        "the root's state service is not there",
        undefined,
      ];
      opened: 4;
      ended: 3;
    }
  >;
  /** a line past the bound, and a question not answered in its time, end the stream */
  export type Bounds = Expect<
    Invoke<
      typeof askedOver,
      [
        asker: typeof heldAsker,
        rounds: [[["nudge", {}]], [["nudge", {}]]],
        streams: [
          { replies: [[Invoke<typeof repeated, [text: "x", count: 65]>]] },
          { replies: [[]] },
        ],
        most: 64,
      ]
    >,
    "=",
    {
      answers: [
        "the root's state service sent a line of more than 64 bytes",
        "the root's state service did not answer",
      ];
      opened: 2;
      ended: 2;
    }
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
  /** Clients that have said nothing yet, on every forwarded port and the pages' (heard). */
  const silent = new Set<Socket>();
  // Read once, at the start: a value the setting does not take stops the daemon here, saying
  // so in its log, not at the first workspace.
  const linkMost = valueOf(LINK_CONNECTIONS);
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

  // Every pipe into or out of a workspace's VM goes through this, counted (carrying).
  const { take, carry } = carrying(linkMost, log);

  const redirectHttp = (client: Socket, to: string) =>
    client.end(
      httpAnswer("307 Temporary Redirect", `desolate: served at ${to}\n`, `Location: ${to}\r\n`),
    );

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
    const sniffedHead = await heard(silent, client, raw ? SERVER_FIRST_MS : SILENT_MS);
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
    if (route.to === "refuse") return void client.end(httpAnswer(route.status, route.text));
    if (route.to === "pipe") {
      // Past its bound, a request is told why, anything else closed.
      const http = sniffedHead.sniffed.kind === "http" && sniffedHead.sniffed.name !== null;
      return carry(route.entry, "in", client, () => dial(route.entry.vm, port), head, http);
    }
    const entry = route.entry;
    // A client that already went gets no connection to the owner (final review: each one
    // held the owner's server until it hung up).
    if (client.destroyed) return;
    // Counted as any other: past its workspace's bound, closed (it named nothing to answer).
    if (take(entry, "in", client) !== null) return void client.destroy();
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
    // Among the silent, as every client is until it speaks: else each silent one held a
    // session into the VM for ten minutes, past SILENT_MOST.
    const first = await heard(silent, client, 600_000);
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
    void heard(silent, client, SILENT_MS).then(({ sniffed, head }) => {
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
      if (route.to === "dashboard") return pipe(client, toStateService(), head);
      if (route.to === "refuse") return void client.end(httpAnswer(route.status, route.text));
      if (route.to === "close") return void client.destroy();
      carry(route.entry, "in", client, () => dial(route.entry.vm, EDITOR.gate), head, true);
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
    for (const entry of entries.values()) {
      entry.reserved = reservedFor(entry, forwards.keys(), knownRaw, rawOwner);
      // On its watch, when it changed: the VM holds them within the second.
      const sent = reserveLine(entry);
      if (sent !== entry.watchSent) {
        entry.watchSent = sent;
        entry.watch?.write(sent);
      }
    }
  };
  /** A watch's first line: what to hold, and the checkouts to look at. Sent again, it asks
   *  for a look now (the dashboard opened). */
  const watchLine = (entry: Entry) =>
    `${JSON.stringify({ op: "watch", reserve: [...entry.reserved].sort((x, y) => x - y), look: entry.paths })}\n`;
  /** What its daemon said of what a remove would lose and of its agents: read as data from a
   *  side not trusted, as the host's own look is (lostIn: a line naming a checkout this host
   *  did not ask about is not passed over; rowsOf: rows of the known shape). Not said (its
   *  daemon is from before, until it is replaced): not known, and Delete says so. */
  const toldOf = async (entry: Entry, reply: Record<string, unknown>) => {
    const { lostIn } = await import("../shared/plan.ts");
    const { agentsFrom } = await import("./agent.ts");
    const lost = typeof reply.looked === "string" ? lostIn(reply.looked, entry.paths) : null;
    if (lost === null) entry.looked = null;
    else if (JSON.stringify(lost) !== JSON.stringify(entry.looked?.lost))
      entry.looked = { at: new Date().toISOString(), atStop: false, lost };
    entry.agents =
      reply.agents === undefined
        ? null
        : agentsFrom(reply.agents, `${entry.domain}/${entry.workspace}`);
  };
  const reserveLine = (entry: Entry) =>
    `${JSON.stringify({ op: "reserve", reserve: [...entry.reserved].sort((x, y) => x - y) })}\n`;

  type WsdSaid = {
    ok?: boolean;
    listeners?: number[];
    error?: unknown;
    editorToken?: unknown;
    editorTokenEpoch?: unknown;
    devcontainer?: unknown;
    folder?: unknown;
    unforwarded?: unknown;
  };
  /** What a workspace's daemon said on its watch, checked and kept; throws for an answer that
   *  does not say what listens. */
  const apply = (entry: Entry, reply: WsdSaid) => {
    // For the dashboard. Shown as text and built into an address: a token is 48 hex, the
    // rest is cut to a line.
    entry.editorToken = editorTokenOf(reply.editorToken);
    entry.editorTokenEpoch = tokenEpochOf(reply.editorTokenEpoch);
    // Whole from the VM (it once cut it, and this cut it again): made safe here, bounded
    // against a flood only, and fitted to a line by what shows it (R1).
    entry.devcontainer =
      typeof reply.devcontainer === "string" ? printable(reply.devcontainer) : "";
    entry.folder = folderFrom(entry.folder, reply.folder);
    if (!reply.ok || !Array.isArray(reply.listeners))
      throw new Error(
        typeof reply.error === "string"
          ? printable(reply.error, 200)
          : "the workspace's daemon did not say what listens",
      );
    // Fail closed on what the VM says (listenersFrom).
    const ours = b.hostPorts?.() ?? new Set<number>();
    const taken = listenersFrom(reply.listeners, ours);
    // What the VM itself left out, and what was cut here.
    const left = unforwardedOf(reply.unforwarded);
    entry.listeners = taken.listeners;
    entry.low = [...new Set([...left.low, ...taken.low])].sort((x, y) => x - y);
    entry.more = left.more;
    entry.past = taken.past;
    entry.answeredAt = Date.now();
    entry.missSaid = "";
  };

  /** A workspace that could not be asked: its stream ended or failed, its ask was not
   *  answered. That is not "stopped listening": what it said last is kept while its VM runs,
   *  for a while (forward.ts, unasked). (Dropped at once, a port with no name in its protocol
   *  passed for good to another workspace that claimed it meanwhile.) Said once in the log. */
  const missed = async (entry: Entry, error: unknown) => {
    const why = printable(error instanceof Error ? error.message : String(error), 200);
    if (why !== entry.missSaid) {
      entry.missSaid = why;
      log(`${entry.vm}: its workspace daemon could not be asked: ${why}`);
    }
    const running = await b.info(entry.vm).then(
      (info) => info.status === "running",
      () => false,
    );
    if (entries.get(entry.vm) === entry) Object.assign(entry, unasked(entry, Date.now(), running));
  };

  /** A workspace's watch: one dial to its daemon's socket, held (no program started in the VM
   *  for it: a node there was 50 ms of CPU and 64 MB at its peak, every second; ticket #250),
   *  on which the daemon says what `ports` would each time that changes (workspace/wsd.ts,
   *  portsService). Each line is checked and kept, then the forwards and the root are brought
   *  up to date. One that ends or fails is a miss, and is opened again (reopenAfter). */
  const watchOf = (entry: Entry) =>
    holdWatch({
      open: () => dial(entry.vm, WSD_SOCKET),
      first: () => {
        entry.watchSent = reserveLine(entry);
        return watchLine(entry);
      },
      line: async (reply) => {
        apply(entry, reply);
        await toldOf(entry, reply);
        reconcile();
        tellRoot().catch(() => {});
      },
      missed: (error) =>
        void missed(entry, error).then(() => {
          reconcile();
          tellRoot().catch(() => {});
        }),
      delay: (previous, livedMs) => reopenAfter(previous, livedMs, Date.now() - entry.registeredAt),
    });

  const openLink = (entry: Entry) => {
    const dir = paths.link(entry.vm);
    fs.mkdirSync(dir, { recursive: true });
    const socket = path.join(dir, "proxy.sock");
    fs.rmSync(socket, { force: true });
    // To this workspace's proxy in the root, and nowhere else; past linkMost refused at once,
    // saying so (carrying). (It was refused at 64 with no word anywhere, and a parallel
    // install saw resets.)
    const toProxy = (client: Socket, head: Buffer) =>
      entry.proxy === null
        ? void client.destroy()
        : carry(entry, "out", client, () => dial(ROOT_VM, entry.proxy!), head, true);
    // Every connection the link took, so that its workspace's going ends them: closing a
    // server only stops it taking more, and a stopped workspace's downloads went on. One
    // taken after (a listener not yet closed) is ended at once.
    const clients = new Set<Socket>();
    let gone = false;
    const took = (client: Socket) => {
      client.on("error", () => client.destroy());
      if (gone) return false;
      clients.add(client);
      client.once("close", () => clients.delete(client));
      return true;
    };
    const server = createServer((client) => {
      if (!took(client) || entry.proxy === null) return client.destroy();
      toProxy(client, Buffer.alloc(0));
    });
    server.on("error", (error) => log(`link ${entry.vm}: ${error.message}`));
    server.listen(socket, () => fs.chmodSync(socket, 0o666));
    entry.link = () => {
      gone = true;
      server.close();
      for (const client of clients) client.destroy();
    };
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
        if (!took(client) || !token || entry.proxy === null) return client.destroy();
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
      // Registered again (started again, or a bootstrap, which may start its daemon again):
      // its watch is opened again every second for a minute.
      existing.registeredAt = Date.now();
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
      answeredAt: 0,
      registeredAt: Date.now(),
      watch: null,
      watchSent: "",
      paths: [],
      looked: null,
      agents: null,
      missSaid: "",
      editorToken: "",
      editorTokenEpoch: 0,
      devcontainer: "",
      folder: "",
      watchers: [],
      low: [],
      more: 0,
      past: 0,
      carried: { in: 0, out: 0 },
      refused: {
        in: { count: 0, at: "", why: "", logged: 0 },
        out: { count: 0, at: "", why: "", logged: 0 },
      },
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
    const domainDir = paths.domain(r.domain);
    /** A watch of `dir`, calling `then` with each event's file name; null when `dir` is not
     *  a real directory inside the domain's tree (not there yet, a link, or elsewhere). */
    const watch = (dir: string, then: (file: string | null) => void) => {
      try {
        // The domain's own tree: a directory there may be a link anywhere on the Mac, which
        // a watch would follow. Nothing is read through one, but only a real directory inside
        // the domain's tree is watched.
        if (
          !fs.lstatSync(dir).isDirectory() ||
          fs.realpathSync(dir) !==
            path.join(fs.realpathSync(domainDir), path.relative(domainDir, dir))
        )
          return null;
        const watcher = fs.watch(dir, (_event, file) => then(file === null ? null : String(file)));
        // The directory is the workspace's: it can vanish or be replaced at any moment. A
        // watcher that fails is closed; it must never be an error nobody listens to,
        // which would end this daemon and with it every workspace's link.
        watcher.on("error", () => watcher.close());
        entry.watchers.push(watcher);
        return watcher;
      } catch {
        return null;
      }
    };
    /** Each directory nudged for, and which of its events are (null: any). */
    const targets = new Map<string, ((file: string | null) => boolean) | null>();
    const repos = new Set<string>();
    for (const c of checkouts) {
      // Its status or note, or what it has checked out (HEAD: a `git switch`, a commit on a
      // detached HEAD, a rebase starting or ending).
      targets.set(
        statusDir(base, c),
        (file) => file === null || file.startsWith("desolate-") || file === "HEAD",
      );
      repos.add(c.repo);
    }
    // Each repository's list of branches, which the dashboard lists: the outbox's
    // sync/<owner>/<repo>/, where the workspace's daemon writes refs.json when a branch moves
    // (workspace/wsd.ts). The root cannot watch it (a VM sees no events for a share); a VM's
    // write there is the Mac's file event. A checkout's HEAD commit, which the state reads
    // from its refs, is shown then too: the recursive watch of each refs/heads (macOS only)
    // that did it some 0.5 s sooner is gone, and a commit made on the Mac itself waits for
    // the state service's slow look. Not a tree: the outbox is the workspace's to fill, and
    // on Linux a recursive watch is one per directory there, however many it makes. So these
    // directories only, by the names of the repositories this host knows the workspace has,
    // each by itself. Nothing in them is read or listed, and no file name is looked at: any
    // event is a nudge, which the host paces.
    for (const repo of repos)
      if (typeof repo === "string" && parseRepo(repo))
        targets.set(path.join(paths.outbox(r.domain), "sync", repo), null);
    // A directory not made yet (a checkout's clone as the workspace starts, sync/ before its
    // first sync) is watched once it is: until then its nearest parent in the domain's tree
    // that is, whose every event tries again, and the first look at it is a nudge. (Tried
    // once, at registering, a checkout's .git was not there yet and its status never an
    // event, in T2: the dashboard's budget of a second for a status was met only by the
    // state service's look every 10 s, by chance. The look every second had hidden it.)
    const held = new Set<string>();
    const waiting = new Map<string, fs.FSWatcher>();
    const hold = (first = false) => {
      for (const [dir, wanted] of targets)
        if (!held.has(dir) && watch(dir, (file) => (wanted === null || wanted(file)) && nudge())) {
          held.add(dir);
          if (!first) nudge();
        }
      const parents = new Set<string>();
      for (const dir of targets.keys()) {
        if (held.has(dir)) continue;
        let at = path.dirname(dir);
        while (at.startsWith(`${domainDir}${path.sep}`) && !fs.existsSync(at))
          at = path.dirname(at);
        if (at.startsWith(`${domainDir}${path.sep}`)) parents.add(at);
      }
      for (const [at, watcher] of waiting)
        if (!parents.has(at)) {
          watcher.close();
          waiting.delete(at);
        }
      for (const at of parents)
        if (!waiting.has(at)) {
          const watcher = watch(at, () => hold());
          if (watcher) waiting.set(at, watcher);
        }
    };
    hold(true);
    openLink(entry);
    // The checkouts its daemon is asked about, and the only ones its answer may name: the
    // Mac's own set (workspaces.ts lookedCheckouts: what it recorded making the workspace, or
    // every checkout in the domain's folder, never fewer for what the root says), as a remove
    // looks at. Its watch is opened once that is known.
    void import("./workspaces.ts").then(
      (ws) => {
        if (entries.get(r.vm) !== entry) return;
        entry.paths = ws.lookedCheckouts({ vm: r.vm, domain: r.domain, checkouts });
        entry.watch = watchOf(entry);
      },
      (error: unknown) => {
        // (Its ports are on the same watch: opened, asking about no checkout.)
        log(`${r.vm}: its checkouts could not be worked out: ${String(error)}`);
        if (entries.get(r.vm) === entry) entry.watch = watchOf(entry);
      },
    );
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
    entry.link?.();
    entry.watch?.close();
    for (const watcher of entry.watchers) watcher.close();
    entries.delete(vm);
    reconcile();
  };

  const view = (): PortView[] =>
    portsView(
      [...entries.values()].map((entry) => ({ ...entry, notes: notesOf(entry) })),
      hostHeld,
      rawOwner,
      holderOf,
    );

  // ---------------------------------------------------------------- the root UI's host side
  // The root's state service cannot see the host, and cannot ask: no VM can open a
  // connection to the host. So this dials in: it tells the service what only the host
  // knows, nudges it when a share changed, and collects the dashboard's requests, which it
  // runs as desolate's own CLI, from the fixed list in shared/actions.ts.
  let rootUp = false;
  // Dialed when asked: a session into the root VM opens in 8 ms (measured on the M1,
  // 2026-11-23), against the dashboard's 300 ms for showing state. (A few were kept open
  // ahead of need while one was a `limactl shell`, tens to hundreds of milliseconds.)
  const toStateService = () => dial(ROOT_VM, ROOT_UI.port);
  // The service's own questions, on one stream (heldAsker). A new stream is told the facts
  // at the next pass of the loop below (a second at most): a service started again has none.
  let sentFacts = "";
  const toState = heldAsker(
    () => dial(ROOT_VM, STATED_SOCKET),
    () => void (sentFacts = ""),
  );

  let nudging: NodeJS.Timeout | null = null;
  // At most one a second: a workspace touching its refs in a loop costs the state service
  // one look a second, not one per touch (found by the audit of #92). The first change after
  // a quiet second is passed on at once (60 ms, for the rest of its burst of events). This is
  // the only pace between a workspace's write and the dashboard: the state service looks at
  // once on a nudge. So a change waits at most a second after the nudge before it, and a
  // change after a quiet second about 100 ms. (Paced at both ends, 0.5 s here and 1 s there,
  // a change could wait 1.5 s: T2 09-ui's budget of a second was missed at 1.1 s.)
  let nudgedAt = 0;
  const nudge = () => {
    if (nudging) return;
    nudging = setTimeout(
      () => {
        nudging = null;
        nudgedAt = Date.now();
        toState.ask("nudge").catch(() => {});
      },
      Math.max(60, 1000 - (Date.now() - nudgedAt)),
    );
  };

  const tellRoot = async () => {
    const vms = await b.list();
    rootUp = vms.find((vm) => vm.name === ROOT_VM)?.status === "running";
    if (!rootUp) return;
    const port = editorHostPort();
    const workspaces: Record<string, unknown> = {};
    for (const vm of vms) {
      if (vm.name === ROOT_VM) continue;
      const entry = entries.get(vm.name);
      // What a remove would lose, for Delete: as its daemon says while it runs, else as the
      // host looked as it stopped (workspaces.ts look).
      const looked = entry?.looked ?? (await import("./workspaces.ts")).lookedAt(vm.name);
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
              ...(vm.status === "running" && entry.agents
                ? { agents: shownAgents(entry.agents) }
                : {}),
              // What only the host knows of it, in sentences: listeners cut here, connections
              // refused. (What the VM left out is in its devcontainer line already.)
              ...((notes) => (notes.length > 0 ? { notes } : {}))(notesOf({ ...entry, more: 0 })),
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
    // Agents are what a VM may make many of (a domain's agent spawns workspaces): left out
    // when the facts would come near what the state service takes, so nothing else freezes.
    if (JSON.stringify(facts).length > FACTS_MOST)
      for (const w of Object.values(workspaces) as { agents?: unknown }[]) delete w.agents;
    const text = JSON.stringify(facts);
    // Said when it changes. (The service knows the host is there by its held questions, asked
    // again at least every 50 s.)
    if (text === sentFacts) return;
    await toState.ask("facts", facts);
    sentFacts = text;
  };

  /** Why a workspace's spawn would not fit on this Mac now, or null: the memory given to the
   *  running workspaces, with the new one's (its domain's size, else the stack's), within
   *  most of this Mac's (spawn.memoryPercent) (no fixed number of workspaces, but not past what the Mac has). */
  const roomFor = async (domain: string): Promise<string | null> => {
    try {
      const { stackDefaults } = await import("./workspaces.ts");
      const { merge } = await import("../shared/size.ts");
      const all = (await rootctlBrief("domain.list")).domains;
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
    // One report at a time, what came meanwhile in the next, and the end carrying what is
    // left: a line landing after the end would mark the action running again. An end the
    // root did not answer is sent again, a few times: one lost left the action running on
    // the page for ever (T2 19).
    let lines: string[] = [];
    let end: number | undefined;
    let due = false;
    let posting: Promise<void> | null = null;
    const post = async () => {
      for (let missed = 0; due;) {
        due = false;
        const body = {
          id: action.id,
          lines: lines.splice(0),
          ...(end === undefined ? {} : { done: true, code: end }),
        };
        const heard = await toState.ask("progress", body).then(
          () => true,
          () => false,
        );
        if (heard || !("done" in body)) continue;
        if (++missed === 10) return log(`the end of ${action.id} did not reach the root`);
        lines = lastLines([...body.lines, ...lines]);
        due = true;
        await sleep(2000);
      }
    };
    const report = (more: string[], done?: number) => {
      lines = lastLines([...lines, ...more]);
      if (done !== undefined) end = done;
      due = true;
      return (posting ??= post().finally(() => {
        posting = null;
        if (due) void report([]);
      }));
    };
    if (!argv) return void report(["the host does not do that"], 64);
    // A workspace's own request (spawn, close): run only if the workspace it names signed it,
    // with the key only it and this host have (shared/spawn.ts says why not the root's word).
    if (SIGNED_KINDS.has(String(action.kind))) {
      const signed = signedOf(
        action.kind === "workspace.spawn" ? "spawn" : "close",
        action.args as Record<string, string>,
      );
      const { admit } = await import("./spawn.ts");
      const why = await admit(signed, async () => (await b.list()).map((vm) => vm.name));
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
  /** How long to wait before asking the root again after a failure: half a second for the
   *  first 3 s (the service started again is back within a second or two: its keeper starts
   *  it after 1 s), then 3 s (the root is down). (Once at half a second and then 3 s, a click
   *  waited 3.3 s after the service was back: T2 09-ui.) */
  const again = (failures: number) => sleep(failures <= 6 ? 500 : 3000);
  const collect = async () => {
    for (let failures = 0; ;) {
      try {
        // (Held by the service until there are some, and answered within 50 s regardless.)
        const requests = await toState.ask("requests", {}, 70_000);
        for (const action of requests.kept) {
          if (taken.has(action.id)) continue;
          taken.add(action.id);
          void runAction(action).catch((error: Error) => log(`a request failed: ${error.message}`));
        }
        lastFailure = "";
        failures = 0;
      } catch (error) {
        // The root is not up, or its service is not: try again in a while.
        if (String(error) !== lastFailure)
          log(`dashboard requests: ${(lastFailure = String(error))}`);
        await again(++failures);
      }
    }
  };
  void collect();

  // `desolate events`: the root's state, as it changes (its word: events.ts), and the
  // pusher's log, read as root (a log only root writes, of what the forge answered).
  const followState = async () => {
    let tag = "";
    let before: Answer<"stated.state">["state"] | null = null;
    for (let failures = 0; ;) {
      try {
        const { tag: next, state } = await toState.ask("state", { since: tag }, 70_000);
        // The first state is where things stand, not news.
        if (before) for (const e of stateEvents(before, state)) events.publish(e);
        // A dashboard opened: each workspace's daemon is asked to look now (its watch line
        // again), so Delete shows what is there and not what was at its last event.
        if (before && state.lookAsked !== before.lookAsked)
          for (const entry of entries.values()) entry.watch?.write(watchLine(entry));
        before = state;
        tag = next;
        // At most four looks a second, whatever the root's user's service answers.
        await sleep(250);
        failures = 0;
      } catch {
        await again(++failures);
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
          // Started (again): its agents as they are now, not as before it stopped (they were
          // shown running for a look's while after a restart: dogfooding, 2026-11-22). Its
          // daemon says them on its watch.
          entry.agents = null;
          entry.looked = null;
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
            state: { largest: toState.largest(), most: STATE_ANSWER_BYTES },
          };
        } else if (request.op === "ports") {
          // As the watches last said. A listen that fails says so a moment later: one more
          // round, and the reservations decided are on their way to the VMs.
          reconcile();
          await sleep(50);
          reconcile();
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
          const refused = await toState
            .ask("signin", { digest: createHash("sha256").update(dashboard).digest("hex") })
            .then(
              () => null,
              (error: Error) => error.message,
            );
          if (refused !== null)
            reply = {
              ok: false,
              error: `the dashboard did not take its sign-in code (${refused})`,
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
          for (const entry of entries.values()) entry.link?.();
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
    const domains = (await rootctlBrief("domain.list")).domains;
    const running = new Set(
      (await b.list()).filter((vm) => vm.status === "running").map((vm) => vm.name),
    );
    for (const d of domains)
      for (const w of d.workspaces)
        // (A record naming another domain's VM is not in the list, replies.ts: it would give
        // that VM this domain's names and rules: review of the fixes.)
        if (running.has(w.vm)) {
          const proxy = await rootctlBrief("proxy.start", {
            vm: w.vm,
            domain: w.domain,
            workspace: w.workspace,
          });
          register({
            vm: w.vm,
            domain: w.domain,
            workspace: w.workspace,
            proxy: proxy.socket,
          });
        }
  } catch (error) {
    log(`could not list workspaces at start: ${String(error)}`);
  }
  // Each workspace says what changes on its watch: the loop asks none of them.
  for (;;) {
    const started = Date.now();
    reconcile();
    await tellRoot().catch(() => {});
    // The pause is never shorter than a second, and never so short that the loop is all the
    // Mac does (the root's facts are a VM listing each pass).
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
    // Its port is the one it is started with, for its life: what it listens on is what every
    // address and origin it checks names, whatever `desolate settings set` stores meanwhile.
    {
      detached: true,
      stdio: ["ignore", log, log],
      env: { ...process.env, DESOLATE_EDITOR_PORT: String(editorHostPort()) },
    },
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
      "stop what holds it, or give this stack another port: desolate settings set editor.port <port>, desolate down, then desolate bootstrap",
    );
};

declare namespace tokenAddressesSafe {
  /** the daemon holds its port on both loopback addresses: an address with a token may be printed */
  export type Held = Given<
    Invoke<typeof daemonAnswering, [reply: { ok: true; editor: { port: 31581; error: "" } }]>,
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
            port: 31581;
            error: "a program on this machine holds [::1]:31581, where browsers look first";
          };
        },
      ]
    >,
    Expect<
      Invoke<typeof refusalOf, [run: typeof tokenAddressesSafe]>,
      "=",
      {
        message: "not printed: a program on this machine holds [::1]:31581, where browsers look first, and this address carries a token";
        fix: "stop what holds it, or give this stack another port: desolate settings set editor.port <port>, desolate down, then desolate bootstrap";
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
  if (reply?.ok !== true) return null;
  const editor = reply.editor as { port?: unknown; error?: unknown } | undefined;
  // The daemon keeps the port it started with: one stored since is not held, and an address
  // on it would go to whatever holds that one.
  if (editor?.port !== editorHostPort())
    return `the host daemon holds port ${printable(editor?.port, 20)}, not ${editorHostPort()} (editor.port changed since it started: desolate down, then desolate bootstrap)`;
  return String(editor?.error ?? "");
};

declare namespace editorPortError {
  /** asked without starting a daemon: none running is null, not "" */
  export type NoDaemon = Expect<Invoke<typeof editorPortError>, "=", null>;
  /** a daemon on another port than this command's (editor.port stored since it started) */
  export type Elsewhere = Given<
    Invoke<typeof daemonAnswering, [reply: { ok: true; editor: { port: 40000; error: "" } }]>,
    Expect<
      Invoke<typeof editorPortError>,
      "=",
      "the host daemon holds port 40000, not 31581 (editor.port changed since it started: desolate down, then desolate bootstrap)"
    >
  >;
  /** "" when the daemon holds the port, else its reason, as it said it */
  export type Said = [
    Given<
      Invoke<typeof daemonAnswering, [reply: { ok: true; editor: { port: 31581; error: "" } }]>,
      Expect<Invoke<typeof editorPortError>, "=", "">
    >,
    Given<
      Invoke<
        typeof daemonAnswering,
        [
          reply: {
            ok: true;
            editor: { port: 31581; error: "a program on this machine holds port 31581" };
          },
        ]
      >,
      Expect<Invoke<typeof editorPortError>, "=", "a program on this machine holds port 31581">
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
