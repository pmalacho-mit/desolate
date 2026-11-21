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
import { printable } from "../shared/text.ts";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as os from "node:os";
import type { Size } from "../shared/size.ts";
import * as fs from "node:fs";
import { connect, createServer } from "node:net";
import type { Server, Socket } from "node:net";
import * as path from "node:path";
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
  editorHostname,
  editorHostPort,
  ROOT_HOSTNAME,
  ROOT_UI,
} from "../shared/names.ts";
import { handler as approvePage } from "./approve-web.ts";
import { secretOps } from "./domains.ts";
import { handler as gitPage } from "./git-web.ts";
import { mint } from "./signin.ts";
import { hub, pusherEvent, stateEvents } from "./events.ts";
import {
  assignSlots,
  phoneOff,
  phonePort,
  phonePortsHeld,
  readPhone,
  serveSlots,
  servePhone,
  slotAddress,
  SLOTS,
} from "./phone.ts";
import { serveAgents } from "./agents-web.ts";
import { checkoutOffered, ensureGitClone, ensureGitVm, GIT_VM, watchGitOut } from "./git-vm.ts";
import type { Backend as ApprovalBackend, Summary } from "./approve-web.ts";
import { statusDir } from "../shared/status.ts";
import type { WorkspacePlan } from "../shared/plan.ts";
import { sleep, waitFor } from "../shared/run.ts";
import { greetingIs, LIMIT, sniffSocket } from "../shared/sniff.ts";
import type { Sniffed } from "../shared/sniff.ts";
import { guest, INSTANCE, paths, RELEASE_DIR } from "./paths.ts";
import { dashboardStale, retire, retiredAt, stale } from "./retired.ts";
import { backend, ROOT_VM, rootctl } from "./stack.ts";
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
  asked,
  askedTls,
  daemonAnswering,
  failsAtOnce,
  failsHalfway,
  heldByColima,
  helloTo,
  keepLog,
  nameOf,
  rawOwners,
  said,
  setOf,
  shown,
  sixGiB,
  vmAnswering,
  wire,
  ws,
} from "../.harness/host-daemon.ts";
import type { emptyHome, writeState } from "../.harness/home.ts";
import type { repeated } from "../.harness/shared-bytes.ts";
import type { refusalOf } from "../.harness/refusal.ts";

const SOCKET = path.join(paths.state, "daemon.sock");
const PIDFILE = path.join(paths.state, "daemon.pid");
const LOG = path.join(paths.logs, "daemon.log");
const NODE = ["node", "--disable-warning=ExperimentalWarning"];
/** Protocols with no name in them, known by their port before any connection is seen. */
const RAW_PORTS = new Set([3306, 5432, 6379, 27017, 11211, 5672, 9092, 1433, 26257]);

type Registered = { vm: string; domain: string; workspace: string; proxy: string | null };
type Checkouts = { repo: string; kind: string; name: string; path?: string }[];
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
};
export type PortView = {
  workspace: string;
  forwarded: { port: number; url: string; phone?: string }[];
  reserved: { port: number; why: string }[];
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

/** How many connections one workspace's link may have open at once. */
const LINK_CONNECTIONS = 64;

/** `desolate events` (events.ts): every event the daemon learns of, for whoever listens. */
const events = hub();

/** What the approval page needs of the stack. The list of waiting pushes is the root's
 *  user's (only each one's message is used, parsed on the host); what a push would send is
 *  the reviewer's, asked as root; the signature is this host's. */
/** What a push would send, as desolate's reviewer in the root works it out (root/reviewer.ts):
 *  the approval page shows it, and so do the terminal's prompts. */
export const reviewerSummary = async (push: {
  repo: string;
  branch: string;
  commit: string;
  onto: string | null;
}): Promise<Summary> => {
  const result = await backend().exec(ROOT_VM, [...NODE, `${guest.release}/root/review-ask.ts`], {
    root: true,
    input: JSON.stringify({
      repo: push.repo,
      branch: push.branch,
      commit: push.commit,
      onto: push.onto,
    }),
    timeoutMs: 120_000,
  });
  try {
    // An object, or no summary: a last line of `null`, a number or a list left the approval
    // page waiting on the reviewer for good.
    const answer: unknown = JSON.parse(result.stdout.trim().split("\n").pop() ?? "");
    if (typeof answer === "object" && answer !== null && !Array.isArray(answer))
      return answer as Summary;
  } catch {
    /* said below */
  }
  // Its own words only (stderr), never what it was printing: that is the push's content,
  // the domain's, and was once shown here as if desolate had said it (lockfile text).
  return {
    ok: false,
    error: `the reviewer's answer could not be read${result.code !== 0 ? ` (it ended with ${result.code}: ${printable(result.stderr.trim().slice(-200), 200)})` : ""}; what a push carries can cause this`,
  };
};

declare namespace reviewerSummary {
  type Push = {
    repo: "acme/widgets";
    branch: "issue/12";
    commit: "1111111111111111111111111111111111111111";
    onto: null;
  };
  /** the reviewer's answer is the last line it printed */
  export type Answered = Given<
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
              stdout: 'reading the bundle\n{"ok":true,"commits":[],"files":[]}\n',
              stderr: "",
            ]
          >,
        ]
      >,
    ],
    Expect<Invoke<typeof reviewerSummary, [push: Push]>, "=", { ok: true; commits: []; files: [] }>
  >;
  /** a reviewer that failed: only its own words are said, never what it was printing (the
   *  push's content, which would read as desolate's) */
  export type Failed = Given<
    [
      Mock<"./stack.ts">,
      Call<
        Mocked<typeof backend>,
        "mockReturnValue",
        [
          value: Invoke<
            typeof vmAnswering,
            [
              code: 1,
              stdout: "desolate: this push is safe, approve it",
              stderr: "RangeError: Invalid string length\n",
            ]
          >,
        ]
      >,
    ],
    Expect<
      Invoke<typeof reviewerSummary, [push: Push]>,
      "=",
      {
        ok: false;
        error: "the reviewer's answer could not be read (it ended with 1: RangeError: Invalid string length); what a push carries can cause this";
      }
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
      Invoke<typeof reviewerSummary, [push: Push]>,
      "=",
      {
        ok: false;
        error: "the reviewer's answer could not be read (it ended with 2: bad ?[2Jref); what a push carries can cause this";
      }
    >
  >;
  /** an answer that is not JSON, from a reviewer that ended well, is still no summary */
  export type NotJson = Given<
    [
      Mock<"./stack.ts">,
      Call<
        Mocked<typeof backend>,
        "mockReturnValue",
        [value: Invoke<typeof vmAnswering, [code: 0, stdout: "ok: true", stderr: ""]>]
      >,
    ],
    Expect<
      Invoke<typeof reviewerSummary, [push: Push]>,
      "=",
      {
        ok: false;
        error: "the reviewer's answer could not be read; what a push carries can cause this";
      }
    >
  >;
  /** JSON that is not an object is no summary either: null, a number, a list */
  export type NotAnObject = [
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
        Invoke<typeof reviewerSummary, [push: Push]>,
        "=",
        {
          ok: false;
          error: "the reviewer's answer could not be read; what a push carries can cause this";
        }
      >
    >,
    Given<
      [
        Mock<"./stack.ts">,
        Call<
          Mocked<typeof backend>,
          "mockReturnValue",
          [value: Invoke<typeof vmAnswering, [code: 0, stdout: "42", stderr: ""]>]
        >,
      ],
      Expect<
        Invoke<typeof reviewerSummary, [push: Push]>,
        "=",
        {
          ok: false;
          error: "the reviewer's answer could not be read; what a push carries can cause this";
        }
      >
    >,
    Given<
      [
        Mock<"./stack.ts">,
        Call<
          Mocked<typeof backend>,
          "mockReturnValue",
          [value: Invoke<typeof vmAnswering, [code: 0, stdout: '[{"ok":true}]', stderr: ""]>]
        >,
      ],
      Expect<
        Invoke<typeof reviewerSummary, [push: Push]>,
        "=",
        {
          ok: false;
          error: "the reviewer's answer could not be read; what a push carries can cause this";
        }
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
    pending: async () =>
      (
        await rootctl<{ message: string; at: string }[]>(
          "approvals.pending",
          {},
          { quiet: true, timeoutMs: 30_000 },
        )
      ).map((p) => ({ message: p.message, at: p.at })),
    summary: reviewerSummary,
    approve: async (signed) => {
      const push = parseSigned(signed);
      if (!push) throw new Error("not a push approval");
      const { signClicked } = await import("./approver.ts");
      await rootctl(
        "approvals.answer",
        { message: signed, signature: signClicked(signed) },
        { quiet: true, timeoutMs: 60_000 },
      );
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
      await rootctl("approvals.refuse", { message }, { quiet: true, timeoutMs: 30_000 });
      const push = parseApproval(message);
      if (push)
        events.publish(
          events.host("refused", { repo: push.repo, branch: push.branch, commit: push.commit }),
        );
    },
    issues: async () =>
      (
        await rootctl<unknown[]>(
          "issue.list",
          { waiting: true },
          { quiet: true, timeoutMs: 30_000 },
        )
      ).filter((i) => (i as { state?: unknown }).state === "approving"),
    publishIssue: async (issue) => {
      const url = await (await import("./issues.ts")).publish(issue);
      events.publish(events.host("issue-published", { repo: issue.repo, id: issue.id, url }));
      return url;
    },
    refuseIssue: async (issue) => (await import("./issues.ts")).refuseIssue(issue),
  };
};

// ------------------------------------------------------------------ the forwarder's decisions
// What serve() decides about a connection, a workspace's answer or the root's, as functions of
// what it decides on: serve() does the reading, the writing and the dialling.

/** What the forwarder and the pages server know of a workspace when they route to it. */
type Routable = { vm: string; domain: string; workspace: string; listeners: ReadonlySet<number> };
/** What a connection said first (shared/sniff.ts, sniffSocket). */
type Heard = { sniffed: Sniffed; head: Buffer; undecided?: boolean };

/** Ports whose protocol carries no name: the known ones, and the person's (DESOLATE_RAW_PORTS,
 *  a comma list, for a server that speaks first on another port). Nothing learns a port is
 *  raw from traffic: anyone could teach it that. */
const rawPortsOf = (extra: string | undefined) =>
  new Set([
    ...RAW_PORTS,
    ...(extra ?? "")
      .split(",")
      .map(Number)
      .filter((p) => Number.isInteger(p) && p >= 1024 && p <= 65535),
  ]);

declare namespace rawPortsOf {
  /** the databases and queues known to speak without a name, and the person's own from 1024 up */
  export type Known = [
    Expect<
      Invoke<typeof shown, [value: Invoke<typeof rawPortsOf, [extra: undefined]>]>,
      "=",
      [3306, 5432, 6379, 27017, 11211, 5672, 9092, 1433, 26257]
    >,
    Expect<
      Invoke<typeof shown, [value: Invoke<typeof rawPortsOf, [extra: "4000, 80,x,70000"]>]>,
      "=",
      [3306, 5432, 6379, 27017, 11211, 5672, 9092, 1433, 26257, 4000]
    >,
  ];
}

/** What holds a port, from lsof's `-Fcp` lines, as the person is told it. */
const holderIn = (found: string) => {
  const pid = /^p(\d+)/m.exec(found)?.[1];
  const command = /^c(.+)/m.exec(found)?.[1];
  return pid && command
    ? `${printable(command, 40)}, pid ${pid}`
    : "not a program of yours: another user's, or the system's";
};

declare namespace holderIn {
  /** lsof sees only this user's programs: one it cannot name is another user's, or the
   *  system's. A program's name is shown as text */
  export type Holders = Table<
    typeof holderIn,
    [
      [args: [found: "p4242\ncnode\n"], expected: "node, pid 4242"],
      [args: [found: ""], expected: "not a program of yours: another user's, or the system's"],
      [args: [found: "p1\nc\u001b[31mevil\n"], expected: "?[31mevil, pid 1"],
    ]
  >;
}

/** The workspace a name belongs to, and which of its surfaces: its dev servers or its editor. */
const byName = <E extends { domain: string; workspace: string }>(
  workspaces: Iterable<E>,
  name: string,
): { entry: E; surface: "dev" | "editor" } | null => {
  for (const entry of workspaces) {
    const dev = devHostname(INSTANCE, entry.domain, entry.workspace);
    // A name under a workspace's dev name is that workspace's too: a desolate stack run in
    // it, developing desolate, names its pages so (shared/names.ts, HOSTNAME_SUFFIX).
    if (name === dev || name.endsWith(`.${dev}`)) return { entry, surface: "dev" };
    if (name === editorHostname(INSTANCE, entry.domain, entry.workspace))
      return { entry, surface: "editor" };
  }
  return null;
};

declare namespace byName {
  type Running = [
    Invoke<typeof ws, [at: "dev/w1", listening: [5173]]>,
    Invoke<typeof ws, [at: "dev/w2", listening: [5173]]>,
  ];
  /** a workspace's dev name, and the names under it (a stack developing desolate, run inside it) */
  export type Dev = [
    Expect<
      Invoke<
        typeof shown,
        [
          value: Invoke<
            typeof byName,
            [workspaces: Running, name: Invoke<typeof nameOf, [text: "dev-w2-HEX.localhost"]>]
          >,
        ]
      >,
      "=",
      { entry: "dev/w2"; surface: "dev" }
    >,
    Expect<
      Invoke<
        typeof shown,
        [
          value: Invoke<
            typeof byName,
            [
              workspaces: Running,
              name: Invoke<typeof nameOf, [text: "desolate.dev-w1-HEX.localhost"]>,
            ]
          >,
        ]
      >,
      "=",
      { entry: "dev/w1"; surface: "dev" }
    >,
  ];
  /** its editor's name is another surface, never its dev servers' */
  export type Editor = Expect<
    Invoke<
      typeof shown,
      [
        value: Invoke<
          typeof byName,
          [workspaces: Running, name: Invoke<typeof nameOf, [text: "dev-w1-editor-HEX.localhost"]>]
        >,
      ]
    >,
    "=",
    { entry: "dev/w1"; surface: "editor" }
  >;
  /** a name that only looks like one: another stack's hex, a workspace not running, the name
   *  with more after it or before it */
  export type NoOne = [
    Expect<
      Invoke<
        typeof byName,
        [workspaces: Running, name: Invoke<typeof nameOf, [text: "dev-w1-000000.localhost"]>]
      >,
      "=",
      null
    >,
    Expect<
      Invoke<
        typeof byName,
        [workspaces: Running, name: Invoke<typeof nameOf, [text: "dev-w9-HEX.localhost"]>]
      >,
      "=",
      null
    >,
    Expect<
      Invoke<
        typeof byName,
        [workspaces: Running, name: Invoke<typeof nameOf, [text: "dev-w1-HEX.localhost.evil.test"]>]
      >,
      "=",
      null
    >,
    Expect<
      Invoke<
        typeof byName,
        [workspaces: Running, name: Invoke<typeof nameOf, [text: "evildev-w1-HEX.localhost"]>]
      >,
      "=",
      null
    >,
  ];
}

/** The path of the request a connection opened with, for a redirect: printable ASCII and
 *  starting with "/", or "/". */
const requestPath = (head: Buffer) => {
  const path =
    /^[A-Z]{3,10} (\S{1,2048}) HTTP\/1\.[01]\r?\n/.exec(head.toString("latin1"))?.[1] ?? "/";
  return /^\/[\x21-\x7e]*$/.test(path) ? path : "/";
};

declare namespace requestPath {
  /** where a redirect sends the browser on: the request's own path, if it is plain */
  export type Paths = Table<
    typeof requestPath,
    [
      [
        args: [
          head: Invoke<typeof wire, [text: "GET /app/?q=1 HTTP/1.1\r\nHost: localhost\r\n\r\n"]>,
        ],
        expected: "/app/?q=1",
      ],
      [
        args: [head: Invoke<typeof wire, [text: "GET //evil.test/ HTTP/1.1\r\n\r\n"]>],
        expected: "//evil.test/",
      ],
      [
        args: [head: Invoke<typeof wire, [text: "GET http://evil.test/ HTTP/1.1\r\n\r\n"]>],
        expected: "/",
      ],
      [args: [head: Invoke<typeof wire, [text: "GET /caf\u00e9 HTTP/1.1\r\n\r\n"]>], expected: "/"],
      [args: [head: Invoke<typeof wire, [text: "GET / HTTP/2\r\n\r\n"]>], expected: "/"],
    ]
  >;
}

const REQUEST_LINE = /^[A-Z]{1,16} \S+ HTTP\/\d/;
/** The start of TLS or of an HTTP request, cut off before its line ended. */
const cutOff = (head: Buffer) =>
  head.length > 0 &&
  (head[0] === 0x16 ||
    REQUEST_LINE.test(head.toString("latin1")) ||
    (/^[A-Z]{1,16}( |$)/.test(head.toString("latin1")) && !head.includes(0x0a)));
/** A short line that merely looks like HTTP (Redis's `SET k v`), not a request line, and not
 *  a head that ran to LIMIT: on a raw port, that protocol's. */
const nameless = (head: Buffer) =>
  head.length < LIMIT && !REQUEST_LINE.test(head.toString("latin1"));

declare namespace cutOff {
  /** what a browser's first bytes look like when the wait ran out before they ended */
  export type Starts = Table<
    typeof cutOff,
    [
      [args: [head: Invoke<typeof wire, [text: "GET / HT"]>], expected: true],
      [args: [head: Invoke<typeof wire, [text: "GET"]>], expected: true],
      [args: [head: Invoke<typeof wire, [text: "\u0016\u0003\u0001"]>], expected: true],
      [args: [head: Invoke<typeof wire, [text: "SET k v\n"]>], expected: false],
      [args: [head: Invoke<typeof wire, [text: "\u0000\u0000\u0000\u0008"]>], expected: false],
      [args: [head: Invoke<typeof wire, [text: ""]>], expected: false],
    ]
  >;
}

declare namespace nameless {
  /** a short line that only looks like HTTP is a raw protocol's; a request line never is */
  export type Lines = Table<
    typeof nameless,
    [
      [args: [head: Invoke<typeof wire, [text: "SET k v\r\n"]>], expected: true],
      [args: [head: Invoke<typeof wire, [text: "GET / HTTP/1.1\r\n\r\n"]>], expected: false],
      [args: [head: Invoke<typeof repeated, [text: "SET k v ", count: 2048]>], expected: false],
    ]
  >;
}

/** Where an inbound connection goes: closed, told where to go, refused with an HTTP answer,
 *  piped to a workspace with what it said, or (silent, on a raw port) handed to the port's
 *  first workspace with its greeting held back (serve() does that part, with spokeAsBrowser). */
type InboundRoute<E> =
  | { to: "close" }
  | { to: "redirect"; location: string }
  | { to: "refuse"; status: string; text: string }
  | { to: "pipe"; entry: E }
  | { to: "greet"; entry: E };

/** The route of a connection to `port`, from what it said first. `raw`: the port is known to
 *  speak a protocol with no name. `rawOwner`: the workspace that had the port first. */
const inboundRoute = <E extends Routable>(
  port: number,
  heard: Heard,
  raw: boolean,
  workspaces: E[],
  rawOwner: E | undefined,
): InboundRoute<E> => {
  let { sniffed } = heard;
  const { head, undecided } = heard;
  // Not known to be raw, and its bytes never said what they were (silence, or half a line,
  // until the wait ran out): closed. Only a known raw port takes them (a server that speaks
  // first). Nothing learns a port is raw from traffic: anyone could teach it that.
  if (undecided && !raw) return { to: "close" };
  // On a raw port, one short line that merely looks like HTTP (Redis's `SET k v`) is that
  // protocol's. A real request line, or a head that ran to LIMIT, is HTTP: refused or sent
  // on below by its name, never to the port's first workspace (audit of the fixes).
  if (raw && sniffed.kind === "http" && sniffed.name === null && nameless(head))
    sniffed = { kind: "raw" };
  if (sniffed.kind === "http" || sniffed.kind === "tls") {
    const target = sniffed.name ? byName(workspaces, sniffed.name) : null;
    if (!target) {
      // A request that names no workspace reaches nothing (v2's ingress "WHOSE NAME").
      if (sniffed.kind !== "http") return { to: "close" };
      // But a bare localhost is usually a dev server's own "Local: http://localhost:5173",
      // clicked: the browser is sent to the workspace serving this port, at its own name
      // (one workspace), or told which do (several). It is only told where to go: nothing
      // is ever served at bare localhost, so no two workspaces, and no workspace and its
      // editor, share an origin, and what the request carried (its cookies) reaches no
      // server. (TLS cannot be answered so: it names no certificate this could present.)
      const serving =
        sniffed.name === "localhost" || sniffed.name === "127.0.0.1"
          ? workspaces.filter((e) => e.listeners.has(port))
          : [];
      const at = (e: E) => `http://${devHostname(INSTANCE, e.domain, e.workspace)}:${port}`;
      if (serving.length === 1)
        return { to: "redirect", location: `${at(serving[0]!)}${requestPath(head)}` };
      return {
        to: "refuse",
        status: "421 Misdirected Request",
        text:
          serving.length > 1
            ? `desolate: port ${port} is served by more than one workspace, each at its own address:\n${serving.map((e) => `  ${e.domain}/${e.workspace}  ${at(e)}/\n`).join("")}`
            : "desolate: this address names no workspace. Open a workspace's own URL: see `desolate ports`.\n",
      };
    }
    // A workspace's editor name answers for its editor only, and its dev name never for it.
    if (target.surface === "editor" || !target.entry.listeners.has(port))
      return sniffed.kind === "http"
        ? {
            to: "refuse",
            status: "502 Bad Gateway",
            text: `desolate: nothing is listening on port ${port} in ${target.entry.domain}/${target.entry.workspace}.\n`,
          }
        : { to: "close" };
    return { to: "pipe", entry: target.entry };
  }
  // No name in the protocol (bytes that cannot be HTTP or TLS: shared/sniff.ts): on a port
  // known to be raw, the first workspace that had it; on any other, nothing.
  if (!raw) return { to: "close" };
  const entry = rawOwner;
  if (!entry || !entry.listeners.has(port)) return { to: "close" };
  // A head that is the start of a request or of TLS, cut off when the wait ran out, is a
  // browser's (final review): never the port's first workspace's. (Only then: a decided
  // head was raw already, and a MongoDB hello's first byte may be 0x16.)
  if (undecided && cutOff(head)) return { to: "close" };
  if (head.length > 0) return { to: "pipe", entry };
  return { to: "greet", entry };
};

declare namespace inboundRoute {
  // Two workspaces of one domain, both with a dev server on 5173; w1 has Postgres (5432, a
  // raw port) and w2 something on 8080.
  type W1 = Invoke<typeof ws, [at: "dev/w1", listening: [5173, 5432]]>;
  type W2 = Invoke<typeof ws, [at: "dev/w2", listening: [5173, 8080]]>;
  type Both = [W1, W2];
  /** HTTP goes to the workspace its Host names, on the port it came to; so does TLS by its SNI */
  export type ByName = [
    Expect<
      Invoke<
        typeof shown,
        [
          value: Invoke<
            typeof inboundRoute,
            [
              port: 5173,
              heard: Invoke<
                typeof said,
                [text: "GET / HTTP/1.1\r\nHost: dev-w1-HEX.localhost:5173\r\n\r\n"]
              >,
              raw: false,
              workspaces: Both,
              rawOwner: undefined,
            ]
          >,
        ]
      >,
      "=",
      { to: "pipe"; entry: "dev/w1" }
    >,
    Expect<
      Invoke<
        typeof shown,
        [
          value: Invoke<
            typeof inboundRoute,
            [
              port: 5173,
              heard: Invoke<
                typeof said,
                [text: "GET / HTTP/1.1\r\nHost: dev-w2-HEX.localhost:5173\r\n\r\n"]
              >,
              raw: false,
              workspaces: Both,
              rawOwner: undefined,
            ]
          >,
        ]
      >,
      "=",
      { to: "pipe"; entry: "dev/w2" }
    >,
    Expect<
      Invoke<
        typeof shown,
        [
          value: Invoke<
            typeof inboundRoute,
            [
              port: 5173,
              heard: Invoke<typeof helloTo, [name: "dev-w2-HEX.localhost"]>,
              raw: false,
              workspaces: Both,
              rawOwner: undefined,
            ]
          >,
        ]
      >,
      "=",
      { to: "pipe"; entry: "dev/w2" }
    >,
  ];
  /** a Host for another workspace reaches that workspace or nothing, never the one listening:
   *  w1 has nothing on 8080. Nor is a workspace's editor reached by a dev port */
  export type AnotherWorkspace = [
    Expect<
      Invoke<
        typeof shown,
        [
          value: Invoke<
            typeof inboundRoute,
            [
              port: 8080,
              heard: Invoke<
                typeof said,
                [text: "GET / HTTP/1.1\r\nHost: dev-w1-HEX.localhost:8080\r\n\r\n"]
              >,
              raw: false,
              workspaces: Both,
              rawOwner: undefined,
            ]
          >,
        ]
      >,
      "=",
      {
        to: "refuse";
        status: "502 Bad Gateway";
        text: "desolate: nothing is listening on port 8080 in dev/w1.\n";
      }
    >,
    Expect<
      Invoke<
        typeof shown,
        [
          value: Invoke<
            typeof inboundRoute,
            [
              port: 5173,
              heard: Invoke<
                typeof said,
                [text: "GET / HTTP/1.1\r\nHost: dev-w1-editor-HEX.localhost:5173\r\n\r\n"]
              >,
              raw: false,
              workspaces: Both,
              rawOwner: undefined,
            ]
          >,
        ]
      >,
      "=",
      {
        to: "refuse";
        status: "502 Bad Gateway";
        text: "desolate: nothing is listening on port 5173 in dev/w1.\n";
      }
    >,
  ];
  /** a request that names no workspace reaches nothing: a workspace not running, an address,
   *  no Host at all, a name with more after it, a Host after the head */
  export type NamesNoOne = [
    Expect<
      Invoke<
        typeof shown,
        [
          value: Invoke<
            typeof inboundRoute,
            [
              port: 5173,
              heard: Invoke<
                typeof said,
                [text: "GET / HTTP/1.1\r\nHost: dev-w9-HEX.localhost:5173\r\n\r\n"]
              >,
              raw: false,
              workspaces: Both,
              rawOwner: undefined,
            ]
          >,
        ]
      >,
      "=",
      {
        to: "refuse";
        status: "421 Misdirected Request";
        text: "desolate: this address names no workspace. Open a workspace's own URL: see `desolate ports`.\n";
      }
    >,
    Expect<
      Invoke<
        typeof shown,
        [
          value: Invoke<
            typeof inboundRoute,
            [
              port: 5173,
              heard: Invoke<
                typeof said,
                [text: "GET / HTTP/1.1\r\nHost: 192.168.1.20:5173\r\n\r\n"]
              >,
              raw: false,
              workspaces: Both,
              rawOwner: undefined,
            ]
          >,
        ]
      >,
      "matches",
      { to: "refuse"; status: "421 Misdirected Request" }
    >,
    Expect<
      Invoke<
        typeof shown,
        [
          value: Invoke<
            typeof inboundRoute,
            [
              port: 5173,
              heard: Invoke<typeof said, [text: "GET / HTTP/1.1\r\nHost: [::1]:5173\r\n\r\n"]>,
              raw: false,
              workspaces: Both,
              rawOwner: undefined,
            ]
          >,
        ]
      >,
      "matches",
      { to: "refuse"; status: "421 Misdirected Request" }
    >,
    Expect<
      Invoke<
        typeof shown,
        [
          value: Invoke<
            typeof inboundRoute,
            [
              port: 5173,
              heard: Invoke<typeof said, [text: "GET / HTTP/1.0\r\n\r\n"]>,
              raw: false,
              workspaces: Both,
              rawOwner: undefined,
            ]
          >,
        ]
      >,
      "matches",
      { to: "refuse"; status: "421 Misdirected Request" }
    >,
    Expect<
      Invoke<
        typeof shown,
        [
          value: Invoke<
            typeof inboundRoute,
            [
              port: 5173,
              heard: Invoke<
                typeof said,
                [text: "GET / HTTP/1.1\r\nHost: dev-w1-HEX.localhost.evil.test\r\n\r\n"]
              >,
              raw: false,
              workspaces: Both,
              rawOwner: undefined,
            ]
          >,
        ]
      >,
      "matches",
      { to: "refuse"; status: "421 Misdirected Request" }
    >,
    Expect<
      Invoke<
        typeof shown,
        [
          value: Invoke<
            typeof inboundRoute,
            [
              port: 5173,
              heard: Invoke<
                typeof said,
                [
                  text: "POST / HTTP/1.1\r\nContent-Length: 34\r\n\r\nHost: dev-w1-HEX.localhost\r\n\r\n",
                ]
              >,
              raw: false,
              workspaces: Both,
              rawOwner: undefined,
            ]
          >,
        ]
      >,
      "matches",
      { to: "refuse"; status: "421 Misdirected Request" }
    >,
  ];
  /** TLS that names no one, or names a workspace not listening there, is closed: there is no
   *  certificate to answer it with */
  export type TlsNamesNoOne = [
    Expect<
      Invoke<
        typeof inboundRoute,
        [
          port: 5173,
          heard: Invoke<typeof helloTo, [name: null]>,
          raw: false,
          workspaces: Both,
          rawOwner: undefined,
        ]
      >,
      "=",
      { to: "close" }
    >,
    Expect<
      Invoke<
        typeof inboundRoute,
        [
          port: 5173,
          heard: Invoke<typeof helloTo, [name: "dev-w9-HEX.localhost"]>,
          raw: false,
          workspaces: Both,
          rawOwner: undefined,
        ]
      >,
      "=",
      { to: "close" }
    >,
    Expect<
      Invoke<
        typeof inboundRoute,
        [
          port: 8080,
          heard: Invoke<typeof helloTo, [name: "dev-w1-HEX.localhost"]>,
          raw: false,
          workspaces: Both,
          rawOwner: undefined,
        ]
      >,
      "=",
      { to: "close" }
    >,
    Expect<
      Invoke<
        typeof inboundRoute,
        [
          port: 5173,
          heard: Invoke<typeof helloTo, [name: "dev-w1-editor-HEX.localhost"]>,
          raw: false,
          workspaces: Both,
          rawOwner: undefined,
        ]
      >,
      "=",
      { to: "close" }
    >,
  ];
  /** bare localhost (a dev server's own "Local:" link, clicked) is told where to go, never
   *  served: to the one workspace serving the port, at its own name, with the same path */
  export type Localhost = [
    Expect<
      Invoke<
        typeof shown,
        [
          value: Invoke<
            typeof inboundRoute,
            [
              port: 8080,
              heard: Invoke<
                typeof said,
                [text: "GET /app/?q=1 HTTP/1.1\r\nHost: localhost:8080\r\nCookie: s=1\r\n\r\n"]
              >,
              raw: false,
              workspaces: Both,
              rawOwner: undefined,
            ]
          >,
        ]
      >,
      "=",
      { to: "redirect"; location: "http://dev-w2-HEX.localhost:8080/app/?q=1" }
    >,
    Expect<
      Invoke<
        typeof shown,
        [
          value: Invoke<
            typeof inboundRoute,
            [
              port: 8080,
              heard: Invoke<typeof said, [text: "GET / HTTP/1.1\r\nHost: 127.0.0.1:8080\r\n\r\n"]>,
              raw: false,
              workspaces: Both,
              rawOwner: undefined,
            ]
          >,
        ]
      >,
      "=",
      { to: "redirect"; location: "http://dev-w2-HEX.localhost:8080/" }
    >,
  ];
  /** several serve it: each one's address, and the choice is the person's. None: nothing */
  export type LocalhostShared = [
    Expect<
      Invoke<
        typeof shown,
        [
          value: Invoke<
            typeof inboundRoute,
            [
              port: 5173,
              heard: Invoke<typeof said, [text: "GET / HTTP/1.1\r\nHost: localhost:5173\r\n\r\n"]>,
              raw: false,
              workspaces: Both,
              rawOwner: undefined,
            ]
          >,
        ]
      >,
      "=",
      {
        to: "refuse";
        status: "421 Misdirected Request";
        text: "desolate: port 5173 is served by more than one workspace, each at its own address:\n  dev/w1  http://dev-w1-HEX.localhost:5173/\n  dev/w2  http://dev-w2-HEX.localhost:5173/\n";
      }
    >,
    Expect<
      Invoke<
        typeof shown,
        [
          value: Invoke<
            typeof inboundRoute,
            [
              port: 3000,
              heard: Invoke<typeof said, [text: "GET / HTTP/1.1\r\nHost: localhost:3000\r\n\r\n"]>,
              raw: false,
              workspaces: Both,
              rawOwner: undefined,
            ]
          >,
        ]
      >,
      "matches",
      {
        to: "refuse";
        status: "421 Misdirected Request";
        text: "desolate: this address names no workspace. Open a workspace's own URL: see `desolate ports`.\n";
      }
    >,
    Expect<
      Invoke<
        typeof inboundRoute,
        [
          port: 8080,
          heard: Invoke<typeof helloTo, [name: "localhost"]>,
          raw: false,
          workspaces: Both,
          rawOwner: undefined,
        ]
      >,
      "=",
      { to: "close" }
    >,
  ];
  /** a port not known to be raw takes nothing without a name: silence until the wait ran
   *  out, half a request line, bytes of no protocol with names */
  export type NotRaw = [
    Expect<
      Invoke<
        typeof inboundRoute,
        [
          port: 8080,
          heard: Invoke<typeof said, [text: "", undecided: true]>,
          raw: false,
          workspaces: Both,
          rawOwner: W2,
        ]
      >,
      "=",
      { to: "close" }
    >,
    Expect<
      Invoke<
        typeof inboundRoute,
        [
          port: 8080,
          heard: Invoke<typeof said, [text: "GET / HT", undecided: true]>,
          raw: false,
          workspaces: Both,
          rawOwner: W2,
        ]
      >,
      "=",
      { to: "close" }
    >,
    Expect<
      Invoke<
        typeof inboundRoute,
        [
          port: 8080,
          heard: Invoke<typeof said, [text: "\u0000\u0000\u0000\u0008\u0004\u00d2\u0016/"]>,
          raw: false,
          workspaces: Both,
          rawOwner: W2,
        ]
      >,
      "=",
      { to: "close" }
    >,
  ];
  /** a raw port: what has no name goes to the workspace that had the port first, and a client
   *  still silent is handed to it with its greeting held back (spokeAsBrowser, greetingGoes) */
  export type Raw = [
    Expect<
      Invoke<
        typeof shown,
        [
          value: Invoke<
            typeof inboundRoute,
            [
              port: 5432,
              heard: Invoke<typeof said, [text: "\u0000\u0000\u0000\u0008\u0004\u00d2\u0016/"]>,
              raw: true,
              workspaces: Both,
              rawOwner: W1,
            ]
          >,
        ]
      >,
      "=",
      { to: "pipe"; entry: "dev/w1" }
    >,
    Expect<
      Invoke<
        typeof shown,
        [
          value: Invoke<
            typeof inboundRoute,
            [
              port: 5432,
              heard: Invoke<typeof said, [text: "SET k v\r\n"]>,
              raw: true,
              workspaces: Both,
              rawOwner: W1,
            ]
          >,
        ]
      >,
      "=",
      { to: "pipe"; entry: "dev/w1" }
    >,
    Expect<
      Invoke<
        typeof shown,
        [
          value: Invoke<
            typeof inboundRoute,
            [
              port: 5432,
              heard: Invoke<typeof said, [text: "", undecided: true]>,
              raw: true,
              workspaces: Both,
              rawOwner: W1,
            ]
          >,
        ]
      >,
      "=",
      { to: "greet"; entry: "dev/w1" }
    >,
  ];
  /** HTTP on a raw port is routed by its name like any, never to the port's first workspace:
   *  a Host for w2, which has nothing there; no Host; a request line cut off by the wait; TLS */
  export type RawSpeaksHttp = [
    Expect<
      Invoke<
        typeof shown,
        [
          value: Invoke<
            typeof inboundRoute,
            [
              port: 5432,
              heard: Invoke<
                typeof said,
                [text: "GET / HTTP/1.1\r\nHost: dev-w2-HEX.localhost:5432\r\n\r\n"]
              >,
              raw: true,
              workspaces: Both,
              rawOwner: W1,
            ]
          >,
        ]
      >,
      "=",
      {
        to: "refuse";
        status: "502 Bad Gateway";
        text: "desolate: nothing is listening on port 5432 in dev/w2.\n";
      }
    >,
    Expect<
      Invoke<
        typeof shown,
        [
          value: Invoke<
            typeof inboundRoute,
            [
              port: 5432,
              heard: Invoke<typeof said, [text: "GET / HTTP/1.1\r\n\r\n"]>,
              raw: true,
              workspaces: Both,
              rawOwner: W1,
            ]
          >,
        ]
      >,
      "matches",
      { to: "refuse"; status: "421 Misdirected Request" }
    >,
    Expect<
      Invoke<
        typeof inboundRoute,
        [
          port: 5432,
          heard: Invoke<typeof said, [text: "GET /a HTTP/1.1\r\nHost: dev-w1-HE", undecided: true]>,
          raw: true,
          workspaces: Both,
          rawOwner: W1,
        ]
      >,
      "=",
      { to: "close" }
    >,
    Expect<
      Invoke<
        typeof inboundRoute,
        [
          port: 5432,
          heard: Invoke<typeof said, [text: "\u0016\u0003\u0001\u0002", undecided: true]>,
          raw: true,
          workspaces: Both,
          rawOwner: W1,
        ]
      >,
      "=",
      { to: "close" }
    >,
    Expect<
      Invoke<
        typeof inboundRoute,
        [
          port: 5432,
          heard: Invoke<typeof helloTo, [name: null]>,
          raw: true,
          workspaces: Both,
          rawOwner: W1,
        ]
      >,
      "=",
      { to: "close" }
    >,
  ];
  /** a raw port whose first workspace no longer listens there, or has none, reaches nothing */
  export type RawOwnerGone = [
    Expect<
      Invoke<
        typeof inboundRoute,
        [
          port: 5432,
          heard: Invoke<typeof said, [text: "\u0000\u0000\u0000\u0008\u0004\u00d2\u0016/"]>,
          raw: true,
          workspaces: Both,
          rawOwner: W2,
        ]
      >,
      "=",
      { to: "close" }
    >,
    Expect<
      Invoke<
        typeof inboundRoute,
        [
          port: 5432,
          heard: Invoke<typeof said, [text: "", undecided: true]>,
          raw: true,
          workspaces: Both,
          rawOwner: undefined,
        ]
      >,
      "=",
      { to: "close" }
    >,
  ];
}

/** What a client that was silent on a raw port said first, once it spoke: a browser's (TLS,
 *  a request line, HTTP that is not one short nameless line, or the cut-off start of one),
 *  on a socket it preconnected and would use for a request naming another workspace, with
 *  that workspace's cookies (third review). Both ends are closed then. */
const spokeAsBrowser = (first: Heard) =>
  first.sniffed.kind === "tls" ||
  REQUEST_LINE.test(first.head.toString("latin1")) ||
  (first.sniffed.kind === "http" && !nameless(first.head)) ||
  (first.undecided === true && cutOff(first.head));

declare namespace spokeAsBrowser {
  /** a browser's socket, used now: TLS, a request, HTTP too long for one line, the start of one */
  export type Browser = Table<
    typeof spokeAsBrowser,
    [
      [args: [first: Invoke<typeof helloTo, [name: "dev-w2-HEX.localhost"]>], expected: true],
      [
        args: [
          first: Invoke<
            typeof said,
            [text: "GET / HTTP/1.1\r\nHost: dev-w2-HEX.localhost:5432\r\n\r\n"]
          >,
        ],
        expected: true,
      ],
      [
        args: [first: Invoke<typeof said, [text: "GET / HTTP/1.1\r\n", undecided: true]>],
        expected: true,
      ],
      [args: [first: Invoke<typeof said, [text: "GET / H", undecided: true]>], expected: true],
    ]
  >;
  /** a database's client answering its server: a short line, binary, or nothing more */
  export type Client = Table<
    typeof spokeAsBrowser,
    [
      [args: [first: Invoke<typeof said, [text: "SET k v\r\n"]>], expected: false],
      [args: [first: Invoke<typeof said, [text: "*1\r\n$4\r\nPING\r\n"]>], expected: false],
      [
        args: [first: Invoke<typeof said, [text: "\u0000\u0000\u0001", undecided: true]>],
        expected: false,
      ],
      [args: [first: Invoke<typeof said, [text: "", undecided: true]>], expected: false],
    ]
  >;
}

/** What is done with what a raw port's first workspace says before its client has spoken: it
 *  could be read by a browser as the answer to the request it later sends on a preconnected
 *  socket, a page at another workspace's origin (final review; shared/sniff.ts, greetingIs).
 *  So: closed if it starts like an HTTP (or ICY) answer, held while it still could, sent once
 *  it can no longer become one. No database's greeting starts so. */
const greetingGoes = (greeting: Buffer): "close" | "hold" | "send" => {
  const verdict = greetingIs(greeting.toString("latin1"));
  return verdict === "answer" ? "close" : verdict === "more" ? "hold" : "send";
};

declare namespace greetingGoes {
  /** a greeting that starts like an HTTP or ICY answer is closed; one that still could, held */
  export type Greetings = Table<
    typeof greetingGoes,
    [
      [args: [greeting: Invoke<typeof wire, [text: "HTTP/1.1 200 OK\r\n"]>], expected: "close"],
      [args: [greeting: Invoke<typeof wire, [text: "\r\nhttp/1.0 200"]>], expected: "close"],
      [args: [greeting: Invoke<typeof wire, [text: "ICY 200 OK\r\n"]>], expected: "close"],
      [args: [greeting: Invoke<typeof wire, [text: "HT"]>], expected: "hold"],
      [args: [greeting: Invoke<typeof wire, [text: "  IC"]>], expected: "hold"],
      [
        args: [greeting: Invoke<typeof wire, [text: "220 mail.example ESMTP\r\n"]>],
        expected: "send",
      ],
      [
        args: [greeting: Invoke<typeof wire, [text: "J\u0000\u0000\u0000\n8.0.36\u0000"]>],
        expected: "send",
      ],
    ]
  >;
}

/** Where a connection to the pages' port (the editors', the dashboard's, the approval page's
 *  and the git terminal's) goes. Each by its own name, and nothing else. */
type PagesRoute<E> =
  | { to: "git" }
  | { to: "approvals" }
  | { to: "dashboard" }
  | { to: "editor"; entry: E }
  | { to: "refuse"; status: string; text: string }
  | { to: "close" };

const pagesRoute = <E extends { domain: string; workspace: string; editorTokenEpoch: number }>(
  sniffed: Sniffed,
  workspaces: Iterable<E>,
): PagesRoute<E> => {
  if (sniffed.kind === "http" && sniffed.name === GIT_HOSTNAME) return { to: "git" };
  if (sniffed.kind === "http" && sniffed.name === APPROVE_HOSTNAME) return { to: "approvals" };
  // The root's one surface: the dashboard. The state service checks the name and the
  // origin of every request itself.
  if (sniffed.kind === "http" && sniffed.name === ROOT_HOSTNAME) {
    // Its token was retired (retired.ts): the cookie a tab still has may be another
    // program's now, and the root still takes it until bootstrap gives it a new one.
    if (dashboardStale())
      return {
        to: "refuse",
        status: "503 Service Unavailable",
        text: "desolate: the dashboard's token was retired (another program held [::1] on this port). Run `desolate bootstrap`, then `desolate ui` for its new address.\n",
      };
    return { to: "dashboard" };
  }
  const target = sniffed.kind === "http" && sniffed.name ? byName(workspaces, sniffed.name) : null;
  if (!target || target.surface !== "editor")
    return sniffed.kind === "http"
      ? {
          to: "refuse",
          status: "421 Misdirected Request",
          text: "desolate: this port answers to a workspace's editor hostname only. `desolate editor <domain>/<workspace>` prints it.\n",
        }
      : { to: "close" };
  if (stale(target.entry.editorTokenEpoch))
    return {
      to: "refuse",
      status: "503 Service Unavailable",
      text: `desolate: this editor's token was retired (another program held [::1] on this port). Run \`desolate bootstrap\` (or start the workspace), then \`desolate editor ${target.entry.domain}/${target.entry.workspace}\` for its new address.\n`,
    };
  return { to: "editor", entry: target.entry };
};

declare namespace pagesRoute {
  type Old = Invoke<
    typeof ws,
    [at: "dev/w1", listening: [], more: { editorTokenEpoch: 1763200000000 }]
  >;
  type New = Invoke<
    typeof ws,
    [at: "dev/w2", listening: [], more: { editorTokenEpoch: 1763300000000 }]
  >;
  type Both = [Old, New];
  /** each page by its own name: the git terminal, the approval page, the dashboard, an editor */
  export type Pages = Given<
    Invoke<typeof emptyHome>,
    [
      Expect<
        Invoke<
          typeof pagesRoute,
          [
            sniffed: Invoke<
              typeof asked,
              [text: "GET / HTTP/1.1\r\nHost: desolate-git.localhost:31581\r\n\r\n"]
            >,
            workspaces: Both,
          ]
        >,
        "=",
        { to: "git" }
      >,
      Expect<
        Invoke<
          typeof pagesRoute,
          [
            sniffed: Invoke<
              typeof asked,
              [text: "GET / HTTP/1.1\r\nHost: desolate-approve.localhost:31581\r\n\r\n"]
            >,
            workspaces: Both,
          ]
        >,
        "=",
        { to: "approvals" }
      >,
      Expect<
        Invoke<
          typeof pagesRoute,
          [
            sniffed: Invoke<
              typeof asked,
              [text: "GET / HTTP/1.1\r\nHost: desolate.localhost:31581\r\n\r\n"]
            >,
            workspaces: Both,
          ]
        >,
        "=",
        { to: "dashboard" }
      >,
      Expect<
        Invoke<
          typeof shown,
          [
            value: Invoke<
              typeof pagesRoute,
              [
                sniffed: Invoke<
                  typeof asked,
                  [text: "GET / HTTP/1.1\r\nHost: dev-w2-editor-HEX.localhost:31581\r\n\r\n"]
                >,
                workspaces: Both,
              ]
            >,
          ]
        >,
        "=",
        { to: "editor"; entry: "dev/w2" }
      >,
    ]
  >;
  /** this port is the editors': a workspace's dev name, a name of no one, no name, an
   *  address, are refused; TLS, which no page here speaks, is closed */
  export type WrongHost = [
    Expect<
      Invoke<
        typeof pagesRoute,
        [
          sniffed: Invoke<
            typeof asked,
            [text: "GET / HTTP/1.1\r\nHost: dev-w2-HEX.localhost:31581\r\n\r\n"]
          >,
          workspaces: Both,
        ]
      >,
      "=",
      {
        to: "refuse";
        status: "421 Misdirected Request";
        text: "desolate: this port answers to a workspace's editor hostname only. `desolate editor <domain>/<workspace>` prints it.\n";
      }
    >,
    Expect<
      Invoke<
        typeof pagesRoute,
        [
          sniffed: Invoke<
            typeof asked,
            [text: "GET / HTTP/1.1\r\nHost: dev-w9-editor-HEX.localhost:31581\r\n\r\n"]
          >,
          workspaces: Both,
        ]
      >,
      "matches",
      { to: "refuse"; status: "421 Misdirected Request" }
    >,
    Expect<
      Invoke<
        typeof pagesRoute,
        [sniffed: Invoke<typeof asked, [text: "GET / HTTP/1.0\r\n\r\n"]>, workspaces: Both]
      >,
      "matches",
      { to: "refuse"; status: "421 Misdirected Request" }
    >,
    Expect<
      Invoke<
        typeof pagesRoute,
        [
          sniffed: Invoke<typeof asked, [text: "GET / HTTP/1.1\r\nHost: 127.0.0.1:31581\r\n\r\n"]>,
          workspaces: Both,
        ]
      >,
      "matches",
      { to: "refuse"; status: "421 Misdirected Request" }
    >,
    Expect<
      Invoke<
        typeof pagesRoute,
        [sniffed: Invoke<typeof askedTls, [name: "desolate.localhost"]>, workspaces: Both]
      >,
      "=",
      { to: "close" }
    >,
  ];
  /** an editor's token made before the last retiring is not served (a tab's cookie may be
   *  another program's now); one made after it is */
  export type EditorRetired = Given<
    [
      Invoke<typeof emptyHome>,
      Invoke<typeof writeState, [name: "tokens-retired", text: "1763300000000"]>,
    ],
    [
      Expect<
        Invoke<
          typeof pagesRoute,
          [
            sniffed: Invoke<
              typeof asked,
              [text: "GET / HTTP/1.1\r\nHost: dev-w1-editor-HEX.localhost:31581\r\n\r\n"]
            >,
            workspaces: Both,
          ]
        >,
        "=",
        {
          to: "refuse";
          status: "503 Service Unavailable";
          text: "desolate: this editor's token was retired (another program held [::1] on this port). Run `desolate bootstrap` (or start the workspace), then `desolate editor dev/w1` for its new address.\n";
        }
      >,
      Expect<
        Invoke<
          typeof shown,
          [
            value: Invoke<
              typeof pagesRoute,
              [
                sniffed: Invoke<
                  typeof asked,
                  [text: "GET / HTTP/1.1\r\nHost: dev-w2-editor-HEX.localhost:31581\r\n\r\n"]
                >,
                workspaces: Both,
              ]
            >,
          ]
        >,
        "=",
        { to: "editor"; entry: "dev/w2" }
      >,
    ]
  >;
  /** the dashboard's likewise, until bootstrap has given the root a new one */
  export type DashboardRetired = [
    Given<
      [
        Invoke<typeof emptyHome>,
        Invoke<typeof writeState, [name: "tokens-retired", text: "1763300000000"]>,
      ],
      Expect<
        Invoke<
          typeof pagesRoute,
          [
            sniffed: Invoke<
              typeof asked,
              [text: "GET / HTTP/1.1\r\nHost: desolate.localhost:31581\r\n\r\n"]
            >,
            workspaces: Both,
          ]
        >,
        "=",
        {
          to: "refuse";
          status: "503 Service Unavailable";
          text: "desolate: the dashboard's token was retired (another program held [::1] on this port). Run `desolate bootstrap`, then `desolate ui` for its new address.\n";
        }
      >
    >,
    Given<
      [
        Invoke<typeof emptyHome>,
        Invoke<typeof writeState, [name: "tokens-retired", text: "1763300000000"]>,
        Invoke<typeof writeState, [name: "ui-token", text: "u"]>,
        Invoke<typeof writeState, [name: "ui-token.epoch", text: "1763300000000"]>,
      ],
      Expect<
        Invoke<
          typeof pagesRoute,
          [
            sniffed: Invoke<
              typeof asked,
              [text: "GET / HTTP/1.1\r\nHost: desolate.localhost:31581\r\n\r\n"]
            >,
            workspaces: Both,
          ]
        >,
        "=",
        { to: "dashboard" }
      >
    >,
  ];
}

/** Which workspace a port spoken without a name reaches: the one that had it, while it still
 *  listens there; else the first that listens now. */
const rawOwnerFor = (current: string | undefined, holders: { vm: string }[]) =>
  !current || !holders.some((entry) => entry.vm === current) ? holders[0]!.vm : current;

declare namespace rawOwnerFor {
  /** the first to have it keeps it while it listens; then the next that does */
  export type Owner = Table<
    typeof rawOwnerFor,
    [
      [args: [current: undefined, holders: [{ vm: "vm-a" }, { vm: "vm-b" }]], expected: "vm-a"],
      [args: [current: "vm-b", holders: [{ vm: "vm-a" }, { vm: "vm-b" }]], expected: "vm-b"],
      [args: [current: "vm-c", holders: [{ vm: "vm-a" }, { vm: "vm-b" }]], expected: "vm-a"],
    ]
  >;
}

/** The ports a workspace is asked to keep taken, so its servers move on: a raw port another
 *  workspace had first and the host forwards. (Not a port the Mac holds: kept taken in the VM,
 *  it stopped a program there from using it at all, though only forwarding was impossible
 *  (dogfooding: an API meant only for its own workspace's Vite proxy could not have 3000,
 *  which another macOS user held; Express 5 said "listening" while every request was reset,
 *  depending on which started first). Such a port is reported as not forwarded instead.) */
const reservedFor = (
  entry: { vm: string; listeners: ReadonlySet<number> },
  forwarded: Iterable<number>,
  knownRaw: ReadonlySet<number>,
  rawOwner: { get(port: number): string | undefined },
) => {
  const reserve = new Set<number>();
  for (const port of forwarded)
    if (!entry.listeners.has(port) && knownRaw.has(port) && rawOwner.get(port) !== entry.vm)
      reserve.add(port);
  return reserve;
};

declare namespace reservedFor {
  /** kept taken: a raw port another workspace had first. Not its own raw port, not one it
   *  listens on, not a port with names (those are shared by name) */
  export type Reserved = Expect<
    Invoke<
      typeof shown,
      [
        value: Invoke<
          typeof reservedFor,
          [
            entry: Invoke<typeof ws, [at: "dev/w2", listening: [8080]]>,
            forwarded: [5173, 5432, 6379, 8080],
            knownRaw: Invoke<typeof rawPortsOf, [extra: undefined]>,
            rawOwner: Invoke<typeof rawOwners, [owners: { "5432": "dev/w1"; "6379": "dev/w2" }]>,
          ]
        >,
      ]
    >,
    "=",
    [5432]
  >;
}

// What a workspace's own daemon says, checked (sync). Shown as text and built into an
// address: a token is 48 hex, the rest is cut to a line.
const editorTokenOf = (value: unknown) =>
  typeof value === "string" && /^[0-9a-f]{48}$/.test(value) ? value : "";
const tokenEpochOf = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) ? value : 0;
/** The folder the editor opens: the workspace's word, if it is a path under /workspaces and
 *  the folder is not the workspace file register chose. */
const folderFrom = (current: string, value: unknown) =>
  !current.startsWith("workspace:") &&
  typeof value === "string" &&
  /^\/workspaces\/[A-Za-z0-9._\/-]+$/.test(value)
    ? value
    : current;
/** Fail closed on what the VM says: integers, 1024 and up, and a sane number of them.
 *  The editor's two in-VM ports are never dev-server ports: a dev hostname must not
 *  reach the editor, and nothing may reach its server around its gate. Nor any port
 *  desolate itself uses on this machine (`ours`: a VM's ssh, a link): a workspace
 *  listening there must not get the host to bind it. */
const listenersFrom = (ports: number[], ours: ReadonlySet<number>) =>
  new Set(
    ports
      .filter(
        (port) =>
          Number.isInteger(port) &&
          port >= 1024 &&
          port <= 65535 &&
          port !== EDITOR.server &&
          port !== EDITOR.gate &&
          port !== editorHostPort() &&
          // The phone's own loopback ports (phone.ts) are never a workspace's dev server's.
          !(port >= phonePort() && port < phonePort() + 10 + SLOTS) &&
          !ours.has(port),
      )
      .slice(0, 256),
  );

declare namespace editorTokenOf {
  /** a token is 48 hex and nothing else: it is built into an address the dashboard shows */
  export type Tokens = Table<
    typeof editorTokenOf,
    [
      [
        args: [value: "0123456789abcdef0123456789abcdef0123456789abcdef"],
        expected: "0123456789abcdef0123456789abcdef0123456789abcdef",
      ],
      [args: [value: "0123456789abcdef0123456789abcdef0123456789abcde"], expected: ""],
      [args: [value: "0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF"], expected: ""],
      [args: [value: "0123456789abcdef0123456789abcdef0123456789abcde&"], expected: ""],
      [args: [value: "0123456789abcdef0123456789abcdef0123456789abcdef\n"], expected: ""],
      [args: [value: 7], expected: ""],
    ]
  >;
}

declare namespace tokenEpochOf {
  /** the retiring the token was made after: a whole number, else 0 (made before any: stale) */
  export type Epochs = Table<
    typeof tokenEpochOf,
    [
      [args: [value: 1763300000000], expected: 1763300000000],
      [args: [value: "1763300000000"], expected: 0],
      [args: [value: 1.5], expected: 0],
      [args: [value: 9007199254740992], expected: 0],
      [args: [value: undefined], expected: 0],
    ]
  >;
}

declare namespace folderFrom {
  /** a plain path under /workspaces, from the workspace; never in place of the workspace file */
  export type Folders = Table<
    typeof folderFrom,
    [
      [
        args: [current: "", value: "/workspaces/acme/widgets"],
        expected: "/workspaces/acme/widgets",
      ],
      [args: [current: "", value: "/etc"], expected: ""],
      [args: [current: "", value: "/workspaces/a b"], expected: ""],
      [args: [current: "", value: '/workspaces/x"><script>'], expected: ""],
      [args: [current: "/workspaces/old", value: 7], expected: "/workspaces/old"],
      [
        args: [
          current: "workspace:/workspaces/.desolate/w1.code-workspace",
          value: "/workspaces/acme/widgets",
        ],
        expected: "workspace:/workspaces/.desolate/w1.code-workspace",
      ],
    ]
  >;
}

declare namespace listenersFrom {
  /** what the VM says it listens on, kept only if the host may bind it: from 1024, a whole
   *  number, not the editor's ports (its server, its gate, the host's editors' port), not a
   *  port desolate itself uses here */
  export type Listeners = Expect<
    Invoke<
      typeof shown,
      [
        value: Invoke<
          typeof listenersFrom,
          [
            ports: [5173, 80, 1023, 65536, 3000.5, 31580, 31581, 2222, 8080],
            ours: Invoke<typeof setOf, [items: [2222]]>,
          ]
        >,
      ]
    >,
    "=",
    [5173, 8080]
  >;
}

/** The folder the editor opens, from the plan: the first checkout, as `desolate editor`
 *  prints it, or, with more than one, the workspace file with all of them (workspace/init.ts). */
const folderFor = (checkouts: Checkouts, workspace: string) => {
  let folder = "";
  if (
    typeof checkouts[0]?.path === "string" &&
    /^\/workspaces\/[A-Za-z0-9._\/-]+$/.test(checkouts[0].path)
  )
    folder = checkouts[0].path;
  if (checkouts.length > 1) folder = `workspace:/workspaces/.desolate/${workspace}.code-workspace`;
  return folder;
};

declare namespace folderFor {
  /** the one checkout, or the workspace file with all of them; nothing for a path it cannot use */
  export type Folders = Table<
    typeof folderFor,
    [
      [
        args: [
          checkouts: [
            { repo: "acme/widgets"; kind: "main"; name: "main"; path: "/workspaces/acme/widgets" },
          ],
          workspace: "w1",
        ],
        expected: "/workspaces/acme/widgets",
      ],
      [
        args: [
          checkouts: [
            { repo: "acme/widgets"; kind: "main"; name: "main"; path: "/workspaces/acme/widgets" },
            { repo: "acme/lib"; kind: "main"; name: "main"; path: "/workspaces/acme/lib" },
          ],
          workspace: "w1",
        ],
        expected: "workspace:/workspaces/.desolate/w1.code-workspace",
      ],
      [
        args: [
          checkouts: [{ repo: "acme/widgets"; kind: "main"; name: "main"; path: "/home/x" }],
          workspace: "w1",
        ],
        expected: "",
      ],
      [args: [checkouts: [], workspace: "w1"], expected: ""],
    ]
  >;
}

/** A workspace's editor's address, with its token, for the dashboard: only while the editors'
 *  port is this daemon's, and the token was made after the last retiring. */
const editorAddress = (
  entry: {
    domain: string;
    workspace: string;
    editorToken: string;
    editorTokenEpoch: number;
    folder: string;
  },
  port: number,
  editorError: string,
) =>
  entry.editorToken && !editorError && !stale(entry.editorTokenEpoch)
    ? `http://${editorHostname(INSTANCE, entry.domain, entry.workspace)}:${port}/?tkn=${entry.editorToken}${entry.folder.startsWith("workspace:") ? `&workspace=${encodeURIComponent(entry.folder.slice(10))}` : entry.folder ? `&folder=${encodeURIComponent(entry.folder)}` : ""}`
    : undefined;

declare namespace editorAddress {
  type Fresh = {
    domain: "dev";
    workspace: "w1";
    editorToken: "0123456789abcdef0123456789abcdef0123456789abcdef";
    editorTokenEpoch: 1763300000000;
    folder: "/workspaces/acme/widgets";
  };
  /** the editor's own name and the port, its token, and the folder it opens */
  export type Address = Given<
    Invoke<typeof emptyHome>,
    [
      Expect<
        Invoke<
          typeof shown,
          [value: Invoke<typeof editorAddress, [entry: Fresh, port: 31581, editorError: ""]>]
        >,
        "=",
        "http://dev-w1-editor-HEX.localhost:31581/?tkn=0123456789abcdef0123456789abcdef0123456789abcdef&folder=%2Fworkspaces%2Facme%2Fwidgets"
      >,
      Expect<
        Invoke<
          typeof shown,
          [
            value: Invoke<
              typeof editorAddress,
              [
                entry: {
                  domain: "dev";
                  workspace: "w1";
                  editorToken: "0123456789abcdef0123456789abcdef0123456789abcdef";
                  editorTokenEpoch: 0;
                  folder: "workspace:/workspaces/.desolate/w1.code-workspace";
                },
                port: 31581,
                editorError: "",
              ]
            >,
          ]
        >,
        "=",
        "http://dev-w1-editor-HEX.localhost:31581/?tkn=0123456789abcdef0123456789abcdef0123456789abcdef&workspace=%2Fworkspaces%2F.desolate%2Fw1.code-workspace"
      >,
    ]
  >;
  /** none while the port is another program's (the token would be sent to it), with no
   *  token, or with one from before the last retiring; one made since is shown again */
  export type None = Given<
    [
      Invoke<typeof emptyHome>,
      Invoke<typeof writeState, [name: "tokens-retired", text: "1763300000000"]>,
    ],
    [
      Expect<
        Invoke<
          typeof editorAddress,
          [
            entry: Fresh,
            port: 31581,
            editorError: "a program on this machine holds [::1]:31581, where browsers look first",
          ]
        >,
        "=",
        undefined
      >,
      Expect<
        Invoke<
          typeof editorAddress,
          [
            entry: {
              domain: "dev";
              workspace: "w1";
              editorToken: "";
              editorTokenEpoch: 1763300000000;
              folder: "";
            },
            port: 31581,
            editorError: "",
          ]
        >,
        "=",
        undefined
      >,
      Expect<
        Invoke<
          typeof editorAddress,
          [
            entry: {
              domain: "dev";
              workspace: "w1";
              editorToken: "0123456789abcdef0123456789abcdef0123456789abcdef";
              editorTokenEpoch: 1763200000000;
              folder: "";
            },
            port: 31581,
            editorError: "",
          ]
        >,
        "=",
        undefined
      >,
      Expect<
        Invoke<
          typeof shown,
          [value: Invoke<typeof editorAddress, [entry: Fresh, port: 31581, editorError: ""]>]
        >,
        "startsWith",
        "http://dev-w1-editor-HEX.localhost:31581/?tkn="
      >,
    ]
  >;
}

/** `desolate ports`: each workspace's forwarded ports, and those it cannot have, with why. */
const portsView = <E extends Routable & { reserved: ReadonlySet<number> }>(
  workspaces: E[],
  hostHeld: { has(port: number): boolean },
  rawOwner: { get(port: number): string | undefined },
  holderOf: (port: number) => string,
  phoneOf: (vm: string, port: number) => string | undefined = () => undefined,
): PortView[] =>
  workspaces
    .map((entry) => ({
      workspace: `${entry.domain}/${entry.workspace}`,
      forwarded: [...entry.listeners]
        .sort((a, b) => a - b)
        .filter((port) => !hostHeld.has(port))
        .map((port) => {
          const phone = phoneOf(entry.vm, port);
          return {
            port,
            url: `http://${devHostname(INSTANCE, entry.domain, entry.workspace)}:${port}`,
            ...(phone ? { phone } : {}),
          };
        }),
      reserved: [
        ...[...entry.reserved]
          .sort((a, b) => a - b)
          .map((port) => ({
            port,
            why: hostHeld.has(port)
              ? `a program on this machine holds it (${holderOf(port)})`
              : `no name in its protocol, and ${workspaces.find((e) => e.vm === (rawOwner.get(port) ?? ""))?.workspace ?? "another workspace"} had it first`,
          })),
        ...[...entry.listeners]
          .filter((port) => hostHeld.has(port))
          .map((port) => ({
            port,
            why: `listening in the workspace, but a program on this Mac holds port ${port} (${holderOf(port)}): not forwarded, and the workspace's address on port ${port} reaches that program instead. Run it on another port`,
          })),
      ],
    }))
    .sort((a, b) => a.workspace.localeCompare(b.workspace));

declare namespace portsView {
  /** each workspace's ports at its own address; one held on the Mac, and one another workspace
   *  had first, said with why. In order of name */
  export type View = Expect<
    Invoke<
      typeof shown,
      [
        value: Invoke<
          typeof portsView,
          [
            workspaces: [
              Invoke<
                typeof ws,
                [at: "dev/w2", listening: [5173, 3000], more: { reserved: [5432] }]
              >,
              Invoke<typeof ws, [at: "dev/w1", listening: [5432, 5173]]>,
            ],
            hostHeld: Invoke<typeof setOf, [items: [3000]]>,
            rawOwner: Invoke<typeof rawOwners, [owners: { "5432": "dev/w1" }]>,
            holderOf: typeof heldByColima,
          ]
        >,
      ]
    >,
    "=",
    [
      {
        workspace: "dev/w1";
        forwarded: [
          { port: 5173; url: "http://dev-w1-HEX.localhost:5173" },
          { port: 5432; url: "http://dev-w1-HEX.localhost:5432" },
        ];
        reserved: [];
      },
      {
        workspace: "dev/w2";
        forwarded: [{ port: 5173; url: "http://dev-w2-HEX.localhost:5173" }];
        reserved: [
          { port: 5432; why: "no name in its protocol, and w1 had it first" },
          {
            port: 3000;
            why: "listening in the workspace, but a program on this Mac holds port 3000 (colima, pid 812): not forwarded, and the workspace's address on port 3000 reaches that program instead. Run it on another port";
          },
        ];
      },
    ]
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
/** Why one more workspace would not fit on this Mac, or null: what is given and coming within
 *  85% of the Mac's memory. */
const roomVerdict = (given: number, coming: number, next: number, mac: number) =>
  given + coming > mac * 0.85
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
  /** what is given and coming, within 85% of the Mac's memory; past it, said in GiB */
  export type Room = Table<
    typeof roomVerdict,
    [
      [args: [given: 16384, coming: 8192, next: 8192, mac: 32768], expected: null],
      [args: [given: 34816, coming: 0, next: 8192, mac: 40960], expected: null],
      [
        args: [given: 28672, coming: 8192, next: 8192, mac: 40960],
        expected: "this Mac has no room for another workspace: 28 GiB of its 40 GiB are given to running workspaces, and one more needs 8 GiB (close one first, or ask the person)",
      ],
    ]
  >;
}

/** The root's state service's answer, once it is all there: complete when its Content-Length
 *  has arrived, not when the stream closes (what carries the connection, ssh or an exec, may
 *  hold it open until this side closes, which it does not do first: measured, a relay that
 *  sees its input end drops the answer). null: not all there yet. */
const stateAnswer = (data: Buffer): { status: number; body: string } | Error | null => {
  const split = data.indexOf("\r\n\r\n");
  if (split < 0) return null;
  const head = data.subarray(0, split).toString("latin1");
  const status = Number(/^HTTP\/1\.1 (\d+)/.exec(head)?.[1] ?? 0);
  const length = Number(/\r\ncontent-length: (\d+)/i.exec(head)?.[1] ?? -1);
  if (status === 0 || length < 0)
    return new Error("the root's state service sent something that is not an answer");
  if (data.length >= split + 4 + length)
    return { status, body: data.subarray(split + 4, split + 4 + length).toString("utf8") };
  return null;
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
  /** not all there yet */
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
      null
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

/** Where the pusher's log was read to (its file's identity, and an offset), and what one look
 *  read (`stat -c '%i %s'`, then up to a MiB of what is new, as base64). The whole lines it
 *  read, and where the next look starts. A new file (rotated, recreated), or one cut
 *  shorter: from its start. The first look: from where it is now. A line not yet ended
 *  waits for the next look. */
type LogAt = { inode: string; offset: number } | null;
const pusherLogRead = (where: LogAt, stdout: string): { where: LogAt; lines: string[] } => {
  const [head = "", body = ""] = stdout.split("\n");
  const [inode = "", sizeText = ""] = head.split(" ");
  const size = Number(sizeText);
  if (!/^\d+$/.test(inode) || !Number.isInteger(size)) return { where, lines: [] };
  if (!where) return { where: { inode, offset: size }, lines: [] };
  if (where.inode !== inode || size < where.offset)
    return { where: { inode, offset: 0 }, lines: [] };
  const bytes = Buffer.from(body, "base64");
  const end = bytes.lastIndexOf(10);
  if (end < 0) return { where, lines: [] };
  return {
    where: { inode, offset: where.offset + end + 1 },
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
  // Asked of lsof in the background: run while the forwarder waited, it held up every timer,
  // and a 400 ms sniff could end before bytes already sent were read (T2 03, 2026-11-16).
  const holderOf = (port: number) => {
    if (!heldBy.has(port)) {
      heldBy.set(port, "a program on this Mac");
      execFile(
        "lsof",
        ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fcp"],
        { encoding: "utf8", timeout: 3000 },
        (_error, found) => {
          if (heldBy.has(port)) heldBy.set(port, holderIn(found ?? ""));
        },
      );
    }
    return heldBy.get(port)!;
  };
  /** For a port spoken without a name: the one workspace it reaches. */
  const rawOwner = new Map<number, string>();
  // Ports whose protocol carries no name: the known ones, the person's (DESOLATE_RAW_PORTS, a
  // comma list, for a server that speaks first on another port), and ones learned from bytes
  // that were not HTTP or TLS, forgotten when no workspace listens there any more.
  const knownRaw = rawPortsOf(process.env.DESOLATE_RAW_PORTS);
  const waiting = new Set<Socket>();
  const log = (line: string) => fs.appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);

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
    // socket, `nc -z`) is waited for, up to two minutes, and closed if it stays silent: it is
    // never piped anywhere before it names a workspace. (It once was: first taken for a
    // nameless protocol, then, briefly, sent to the one workspace listening on the port,
    // where the browser's request, sent on that socket later, arrived whatever its Host,
    // with the cookies of the workspace it named: found by the audit of 2026-11-16.)
    const raw = knownRaw.has(port);
    // At most 512 waiting at once, and when full the longest-waiting goes, not the newest: a
    // program of another user's opening silent sockets could otherwise lock the person out.
    if (waiting.size >= 512) {
      const oldest = waiting.values().next().value;
      if (oldest) (waiting.delete(oldest), oldest.destroy());
    }
    waiting.add(client);
    let sniffedHead: { sniffed: Sniffed; head: Buffer; undecided?: boolean };
    try {
      sniffedHead = await sniffSocket(client, raw ? 400 : 60_000);
    } finally {
      waiting.delete(client);
    }
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
    if (route.to === "pipe") return pipe(client, b.dial(route.entry.vm, port), head);
    const entry = route.entry;
    // A client that already went gets no connection to the owner (final review: each one
    // held the owner's server until it hung up).
    if (client.destroyed) return;
    // Silent so far, on a raw port: a server that speaks first gets its client, and its
    // greeting goes out now; but what the client says first is read before any of it goes on.
    // If it is HTTP or TLS (a browser's preconnected socket, used later for a request naming
    // another workspace, with its cookies: third review), both ends are closed.
    const upstream = b.dial(entry.vm, port);
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
    void sniffSocket(client, 400).then(({ sniffed, head }) => {
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
      pipe(client, b.dial(route.entry.vm, EDITOR.gate), head);
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
  // The dashboard for your phone, over Tailscale Serve (phone.ts): on 127.0.0.1 only, and it
  // refuses everything until `desolate phone on`.
  // A phone port another program holds is sent the phone's cookies (the tokens): fail closed.
  // Only when the phone is on: else nothing is sent there, and a program holding one of these
  // ports must not be able to retire everyone's tokens at every start (audit, 2026-11-20). It
  // stays refused either way (phoneReady), so `phone on` cannot point Serve at it.
  const phoneHeld = (what: string) => {
    if (!readPhone())
      return log(`${what} is held by another program: desolate phone on is refused`);
    log(`${what} is held by another program: the pages' tokens are retired, and the phone is off`);
    retire();
    void phoneOff().catch((error) => log(`phone off: ${(error as Error).message}`));
  };
  // The agents page types into agents: while the phone is on, its token is made new at each
  // start of this daemon. While the daemon is down, Tailscale Serve still sends the phone's
  // requests to its loopback ports, which any program on this Mac may take for that time;
  // a token it saw then is dead once the daemon is back (audit, 2026-11-20). `desolate phone
  // on` prints the new link.
  if (readPhone()) fs.rmSync(path.join(paths.state, "agents-token"), { force: true });
  servePhone(log, phoneHeld);
  // Your agents, from your phone (agents-web.ts): the next port, an origin of its own.
  serveAgents(log, phonePort() + 1, phoneHeld);
  // Dev servers on the tailnet (phone.ts): each forwarded one a slot, kept while it listens.
  let slots: (string | null)[] = [];
  // Only the one domain `desolate phone dev <domain>` names: every slot is the same name on the
  // tailnet, so one site, and a page of one domain's could act on another's there (phone.ts).
  const assigned = () => {
    const dev = readPhone()?.dev ?? null;
    const wanted = [...entries.values()]
      .filter((e) => dev !== null && e.domain === dev)
      .flatMap((e) =>
        [...e.listeners]
          .filter((p) => !hostHeld.has(p))
          .sort((x, y) => x - y)
          .map((p) => `${e.vm} ${p}`),
      );
    slots = assignSlots(slots, wanted);
    return slots;
  };
  const phoneOf = (vm: string, port: number) => {
    const slot = assigned().indexOf(`${vm} ${port}`);
    return slot >= 0 ? slotAddress(slot) : undefined;
  };
  serveSlots(
    log,
    (slot) => {
      const key = assigned()[slot];
      const [vm = "", port = ""] = (key ?? "").split(" ");
      const e = key ? entries.get(vm) : undefined;
      // Only a port this daemon's forwarder holds, on both loopback addresses: else a slot
      // would connect to whatever program does (audit, 2026-11-20).
      const p = Number(port);
      const forwarded =
        forwards.get(p)?.listening === true && forwards6.get(p)?.listening !== false;
      return e && forwarded
        ? { devHost: devHostname(INSTANCE, e.domain, e.workspace), port: p }
        : null;
    },
    phoneHeld,
  );

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
      };
      // For the dashboard. Shown as text and built into an address: a token is 48 hex, the
      // rest is cut to a line.
      entry.editorToken = editorTokenOf(reply.editorToken);
      entry.editorTokenEpoch = tokenEpochOf(reply.editorTokenEpoch);
      // A VM still running an older wsd says nothing of it (it is restarted only with the VM):
      // asked directly, and only once tokens have been retired (review of the final fixes).
      if (reply.editorTokenEpoch === undefined && retiredAt() > 0)
        entry.editorTokenEpoch = await (await import("./workspaces.ts")).editorTokenEpoch(entry.vm);
      entry.devcontainer =
        typeof reply.devcontainer === "string" ? printable(reply.devcontainer, 400, " ") : "";
      entry.folder = folderFrom(entry.folder, reply.folder);
      if (!reply.ok || !Array.isArray(reply.listeners))
        throw new Error(reply.error ?? `exit ${result.code}`);
      // Fail closed on what the VM says (listenersFrom).
      const ours = b.hostPorts?.() ?? new Set<number>();
      entry.listeners = listenersFrom(reply.listeners, ours);
      entry.lastError = "";
    } catch (error) {
      // A workspace that cannot be asked forwards nothing new, and what it had is dropped.
      entry.listeners = new Set();
      entry.lastError = String(error);
    }
  };

  const openLink = (entry: Entry) => {
    const dir = paths.link(entry.vm);
    fs.mkdirSync(dir, { recursive: true });
    const socket = path.join(dir, "proxy.sock");
    fs.rmSync(socket, { force: true });
    const carry = (client: Socket) => {
      client.on("error", () => client.destroy());
      if (entry.proxy === null) return client.destroy();
      // To this workspace's proxy in the root, and nowhere else.
      pipe(client, b.dial(ROOT_VM, entry.proxy), Buffer.alloc(0));
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
      // that opens with this workspace's token is carried; without a token, none is.
      // Each connection costs a session into the root VM and processes here: a workspace
      // gets this many at once, and no more.
      let open = 0;
      const tcp = createServer((client) => {
        client.on("error", () => client.destroy());
        if (!token || entry.proxy === null || open >= LINK_CONNECTIONS) return client.destroy();
        open += 1;
        client.once("close", () => (open -= 1));
        void acceptLink(client, token).then((rest) => {
          if (rest === null || entry.proxy === null) return client.destroy();
          pipe(client, b.dial(ROOT_VM, entry.proxy), rest);
        });
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

  const view = (): PortView[] =>
    portsView([...entries.values()], hostHeld, rawOwner, holderOf, phoneOf);

  // ---------------------------------------------------------------- the root UI's host side
  // The root's state service cannot see the host, and cannot ask: no VM can open a
  // connection to the host. So this dials in: it tells the service what only the host
  // knows, nudges it when a share changed, and collects the dashboard's requests, which it
  // runs as desolate's own CLI, from the fixed list in shared/actions.ts.
  const TOKEN_FILE = path.join(paths.state, "host-token");
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
      const item = { stream: b.dial(ROOT_VM, ROOT_UI.port), at: Date.now(), dead: false };
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
    if (!item || item.dead) return b.dial(ROOT_VM, ROOT_UI.port);
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
      let data = Buffer.alloc(0);
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
      // The answer is complete when its Content-Length has arrived, not when the stream
      // closes: what carries the connection (ssh, an exec) may hold it open until this
      // side closes, which it does not do first (measured: a relay that sees its input
      // end drops the answer).
      const complete = () => {
        const answer = stateAnswer(data);
        if (answer) settle(answer);
      };
      stream.on("data", (chunk: Buffer) => {
        data = Buffer.concat([data, chunk]);
        // What the root's user's service says is bounded: it parses what domains send.
        if (data.length > 16 * 1024 * 1024)
          return settle(new Error("the root's state service said too much"));
        complete();
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
                .map((p) => {
                  const phone = phoneOf(entry.vm, p);
                  return {
                    port: p,
                    url: `http://${devHostname(INSTANCE, entry.domain, entry.workspace)}:${p}`,
                    ...(phone ? { phone } : {}),
                  };
                }),
              // Listening in the workspace, held on the Mac: not forwarded, and the workspace's
              // address on that port reaches the Mac's program (the dashboard says so).
              heldOnMac: [...entry.listeners]
                .sort((x, y) => x - y)
                .filter((p) => hostHeld.has(p))
                .map((p) => ({ port: p, by: holderOf(p) })),
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
          const w = await rootctl<import("./workspaces.ts").Workspace>(
            "workspace.get",
            { domain: entry.domain, name: entry.workspace },
            { quiet: true },
          );
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
   *  85% of this Mac's (no fixed number of workspaces, but not past what the Mac has). */
  const roomFor = async (domain: string): Promise<string | null> => {
    try {
      const { stackDefaults } = await import("./workspaces.ts");
      const { merge } = await import("../shared/size.ts");
      const all = await rootctl<
        { slug: string; size?: Partial<Size>; workspaces: { vm: string; size?: Partial<Size> }[] }[]
      >("domain.list", {}, { quiet: true, timeoutMs: 30_000 });
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
      pending.push(
        ...chunk
          .toString()
          .split("\n")
          .filter((line) => line.trim() !== ""),
      );
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
        // One look: the file's identity and size, and up to a MiB of what is new, as base64
        // (bytes, so an offset is never miscounted).
        const from = where ? where.offset : -1;
        const read = await b.exec(
          ROOT_VM,
          [
            "bash",
            "-c",
            `stat -c '%i %s' "$1"; if [ "$2" -ge 0 ]; then tail -c +$(( $2 + 1 )) "$1" | head -c 1048576 | base64 -w0; fi`,
            "_",
            file,
            String(from),
          ],
          { root: true, timeoutMs: 20_000 },
        );
        const step = pusherLogRead(where, read.stdout);
        where = step.where;
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
          reply = { ok: true, editor: { port: editorHostPort(), error: editorError } };
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
        } else if (request.op === "phone-ready") {
          // `desolate phone on` and `phone dev`: whether this daemon holds every port they
          // would point Tailscale Serve at (phone.ts phonePortsHeld).
          reply = { ok: true, ...phonePortsHeld() };
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
    const domains = await rootctl<
      { slug: string; workspaces: (WorkspacePlan & { proxy?: string })[] }[]
    >("domain.list", {}, { quiet: true, timeoutMs: 30_000 });
    const running = new Set(
      (await b.list()).filter((vm) => vm.status === "running").map((vm) => vm.name),
    );
    const { isOwnVm } = await import("./workspaces.ts");
    for (const d of domains)
      for (const w of d.workspaces)
        // The root's word, checked: a record naming another domain's VM gets no link and no
        // proxy (it would give that VM this domain's names and rules: review of the fixes).
        if (running.has(w.vm) && w.domain === d.slug && isOwnVm(d.slug, w)) {
          const proxy = await rootctl<{ socket: string }>(
            "proxy.start",
            { vm: w.vm, domain: w.domain, workspace: w.workspace },
            { quiet: true, timeoutMs: 60_000 },
          );
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
/** Whether this daemon holds every phone port: what is missing, if anything. */
export const phoneReady = async (): Promise<string[]> => {
  await ensureDaemon();
  const reply = await ask({ op: "phone-ready" }, 15_000);
  return Array.isArray(reply.missing) ? reply.missing.map(String) : ["the host daemon did not say"];
};

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
