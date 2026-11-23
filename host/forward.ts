// The forwarder's decisions (the host daemon, daemon.ts): where a connection that came to a
// forwarded port or to the pages' port goes, which workspace has a port spoken without a
// name, which ports a workspace is asked to keep taken, and what of a workspace's own word
// (its listeners, its editor's token, its folder) is believed. Functions of what they decide
// on and nothing else: the daemon does the reading, the writing and the dialling.
import {
  APPROVE_HOSTNAME,
  GIT_HOSTNAME,
  devHostname,
  EDITOR,
  editorHostname,
  editorHostPort,
  ROOT_HOSTNAME,
} from "../shared/names.ts";
import { greetingIs, LIMIT } from "../shared/sniff.ts";
import type { Sniffed } from "../shared/sniff.ts";
import { define, ports, valueOf } from "../shared/settings.ts";
import { PORTS } from "../shared/limits.ts";
import { INSTANCE } from "./paths.ts";
import { dashboardStale, stale } from "./retired.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type {
  Expect,
  Given,
  Invoke,
  Table,
  Throws,
} from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { setEnv } from "../.harness/env.ts";
import type {
  asked,
  askedTls,
  heldByColima,
  helloTo,
  nameOf,
  portRange,
  rawOwnerAmong,
  rawOwners,
  said,
  setOf,
  shown,
  wire,
  ws,
} from "../.harness/host-daemon.ts";
import type { emptyHome, writeState } from "../.harness/home.ts";
import type { repeated } from "../.harness/shared-bytes.ts";

/** Protocols with no name in them, known by their port before any connection is seen. */
const RAW_PORTS = new Set([3306, 5432, 6379, 27017, 11211, 5672, 9092, 1433, 26257]);

type Checkouts = { repo: string; kind: string; name: string; path?: string }[];
export type PortView = {
  workspace: string;
  forwarded: { port: number; url: string }[];
  reserved: { port: number; why: string }[];
  /** what else is said of its forwarding: listeners left out, connections refused (notesOf) */
  notes: string[];
};

// ------------------------------------------------------------------ the forwarder's decisions
// What serve() decides about a connection, a workspace's answer or the root's, as functions of
// what it decides on: serve() does the reading, the writing and the dialling.

/** What the forwarder and the pages server know of a workspace when they route to it. */
type Routable = { vm: string; domain: string; workspace: string; listeners: ReadonlySet<number> };
/** What a connection said first (shared/sniff.ts, sniffSocket). */
type Heard = { sniffed: Sniffed; head: Buffer; undecided?: boolean };

/** The person's own ports whose protocol carries no name, besides RAW_PORTS. */
const RAW_PORTS_TOO = define({
  name: "forward.rawPorts",
  env: "DESOLATE_RAW_PORTS",
  side: "host",
  default: (): number[] => [],
  parse: ports,
  why: "Ports of your own where a workspace's server speaks first, as a database does, so a connection there cannot be sent on by the address it was opened to: it goes to the workspace that listened on the port first. On a port not listed, a client that waits for the server is disconnected. The databases' and queues' are listed already (3306, 5432, 6379, 27017, 11211, 5672, 9092, 1433, 26257).",
});

/** Ports whose protocol carries no name: the known ones, and the person's (`extra`, the
 *  setting forward.rawPorts). Nothing learns a port is raw from traffic: anyone could teach
 *  it that. */
const rawPortsOf = (extra: readonly number[] = valueOf(RAW_PORTS_TOO)) =>
  new Set([...RAW_PORTS, ...extra]);

declare namespace rawPortsOf {
  /** the databases and queues known to speak without a name, and the person's own */
  export type Known = [
    Expect<
      Invoke<typeof shown, [value: Invoke<typeof rawPortsOf, [extra: []]>]>,
      "=",
      [3306, 5432, 6379, 27017, 11211, 5672, 9092, 1433, 26257]
    >,
    Expect<
      Invoke<typeof shown, [value: Invoke<typeof rawPortsOf, [extra: [4000, 5432]]>]>,
      "=",
      [3306, 5432, 6379, 27017, 11211, 5672, 9092, 1433, 26257, 4000]
    >,
  ];
  /** with nothing said, the setting's: the person's list, or none; a list with a port the
   *  forwarder never forwards is refused, not shortened */
  export type FromTheSetting = [
    Given<
      Invoke<typeof setEnv, [name: "DESOLATE_RAW_PORTS", value: "7000, 7001"]>,
      Expect<
        Invoke<typeof shown, [value: Invoke<typeof rawPortsOf>]>,
        "=",
        [3306, 5432, 6379, 27017, 11211, 5672, 9092, 1433, 26257, 7000, 7001]
      >
    >,
    Given<
      Invoke<typeof setEnv, [name: "DESOLATE_RAW_PORTS", value: "4000,80"]>,
      Throws<
        Invoke<typeof rawPortsOf>,
        "DESOLATE_RAW_PORTS must be ports from 1024 to 65535, separated by commas, not '4000,80'"
      >
    >,
  ];
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
  /** the one that had it could not be asked (unasked) and another workspace claims the port
   *  meanwhile: while its VM runs it keeps it. The controls: once its VM has stopped, or two
   *  minutes after its last answer, the port passes on */
  export type Unasked = [
    Expect<
      Invoke<
        typeof rawOwnerAmong,
        [
          rawOwnerFor: typeof rawOwnerFor,
          port: 5432,
          owner: "dev/w1",
          entries: [
            Invoke<
              typeof unasked,
              [
                entry: Invoke<
                  typeof ws,
                  [at: "dev/w1", listening: [5432], more: { answeredAt: 1000 }]
                >,
                now: 31000,
                running: true,
              ]
            >,
            Invoke<typeof ws, [at: "dev/w2", listening: [5432]]>,
          ],
        ]
      >,
      "=",
      "dev/w1"
    >,
    Expect<
      Invoke<
        typeof rawOwnerAmong,
        [
          rawOwnerFor: typeof rawOwnerFor,
          port: 5432,
          owner: "dev/w1",
          entries: [
            Invoke<
              typeof unasked,
              [
                entry: Invoke<
                  typeof ws,
                  [at: "dev/w1", listening: [5432], more: { answeredAt: 1000 }]
                >,
                now: 31000,
                running: false,
              ]
            >,
            Invoke<typeof ws, [at: "dev/w2", listening: [5432]]>,
          ],
        ]
      >,
      "=",
      "dev/w2"
    >,
    Expect<
      Invoke<
        typeof rawOwnerAmong,
        [
          rawOwnerFor: typeof rawOwnerFor,
          port: 5432,
          owner: "dev/w1",
          entries: [
            Invoke<
              typeof unasked,
              [
                entry: Invoke<
                  typeof ws,
                  [at: "dev/w1", listening: [5432], more: { answeredAt: 1000 }]
                >,
                now: 121000,
                running: true,
              ]
            >,
            Invoke<typeof ws, [at: "dev/w2", listening: [5432]]>,
          ],
        ]
      >,
      "=",
      "dev/w2"
    >,
  ];
}

/** How long a workspace that could not be asked keeps what it said last, while its VM runs:
 *  past a daemon started again and its watch reopened (that waits up to 30 s, and the check
 *  asks every 30 s: this is four of either), and short enough that what a daemon gone for
 *  good held passes on within minutes. */
const KEPT_MS = 120_000;

/** A workspace that could not be asked (its watch ended, its ask was not answered), as the
 *  host then takes it: as it last said, while its VM runs and for KEPT_MS after that answer;
 *  else listening on nothing. Not being asked is not having stopped listening. */
const unasked = <E extends { listeners: ReadonlySet<number>; answeredAt: number }>(
  entry: E,
  now: number,
  running: boolean,
): E =>
  running && now - entry.answeredAt < KEPT_MS
    ? entry
    : { ...entry, listeners: new Set<number>(), low: [], more: 0, past: 0 };

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

// What a workspace's own daemon says, checked (daemon.ts, apply). Shown as text and built
// into an address: a token is 48 hex, the rest is cut to a line.
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
/** The most listeners of one workspace the host forwards. Against the VM, which is not
 *  trusted (R7): each is two listeners of this daemon's (127.0.0.1 and ::1), and the daemon
 *  carries every workspace. As many as a compose service gets mirrors (workspace/bridge.ts):
 *  no dev stack listens on more. */
const FORWARDS_MOST = 256;

/** Fail closed on what the VM says: whole numbers from PORTS.min, and FORWARDS_MOST of them.
 *  The editor's two in-VM ports are never dev-server ports: a dev hostname must not
 *  reach the editor, and nothing may reach its server around its gate. Nor any port
 *  desolate itself uses on this machine (`ours`: a VM's ssh, a link): a workspace
 *  listening there must not get the host to bind it. What is left out for a bound's sake
 *  is said: `low`, the ports below PORTS.min (the Mac's system's), and `past`, how many
 *  came after the first FORWARDS_MOST. */
const listenersFrom = (ports: number[], ours: ReadonlySet<number>) => {
  const whole = ports.filter((port) => Number.isInteger(port) && port >= 1 && port <= PORTS.max);
  const may = whole.filter(
    (port) =>
      port >= PORTS.min &&
      port !== EDITOR.server &&
      port !== EDITOR.gate &&
      port !== editorHostPort() &&
      !ours.has(port),
  );
  return {
    listeners: new Set(may.slice(0, FORWARDS_MOST)),
    low: [...new Set(whole.filter((port) => port < PORTS.min))].sort((a, b) => a - b),
    past: Math.max(0, may.length - FORWARDS_MOST),
  };
};

/** What the VM says it did not offer for a bound's sake (wsd's `unforwarded`, ticket 8): its
 *  listeners below PORTS.min, and how many of a compose service's came after its mirrors.
 *  Its word, so only whole ports below PORTS.min and a whole count are taken, and a VM that
 *  says nothing of it has none. */
const unforwardedOf = (value: unknown): { low: number[]; more: number } => {
  const said = (value ?? {}) as { low?: unknown; more?: unknown };
  const low = Array.isArray(said.low)
    ? said.low.filter(
        (port): port is number => Number.isInteger(port) && port >= 1 && port < PORTS.min,
      )
    : [];
  const more =
    Number.isSafeInteger(said.more) && (said.more as number) > 0 ? (said.more as number) : 0;
  return { low: [...new Set(low)].sort((a, b) => a - b), more };
};

declare namespace unforwardedOf {
  /** the VM's word for what it left out: ports below 1024, and a count */
  export type Said = Table<
    typeof unforwardedOf,
    [
      [args: [value: { low: [443, 80]; more: 44 }], expected: { low: [80, 443]; more: 44 }],
      [args: [value: undefined], expected: { low: []; more: 0 }],
      /** anything else in it is not taken: a port from 1024 (forwarded, or said otherwise), a
       *  count that is not one */
      [
        args: [value: { low: [80, 3000, "22", 80.5, 0, 80]; more: -3 }],
        expected: { low: [80]; more: 0 },
      ],
      [args: [value: { low: "80"; more: "44" }], expected: { low: []; more: 0 }],
    ]
  >;
}

/** What `desolate ports` says of a workspace beside its ports: how many of its listeners
 *  were not forwarded for a bound's sake (each bound by its number), and how many of its
 *  connections in or out were refused, with the last one's reason (daemon.ts, carrying). */
const notesOf = (left: {
  more: number;
  past: number;
  refused: Record<"in" | "out", { count: number; at: string; why: string }>;
}) => [
  ...(left.more > 0
    ? [
        `${left.more} more listener${left.more === 1 ? " is" : "s are"} not forwarded: a compose service's past the first 256 (workspace/bridge.ts)`,
      ]
    : []),
  ...(left.past > 0
    ? [
        `${left.past} more listener${left.past === 1 ? " is" : "s are"} not forwarded: past the first ${FORWARDS_MOST} of a workspace`,
      ]
    : []),
  ...(["in", "out"] as const).flatMap((way) => {
    const { count, at, why } = left.refused[way];
    return count > 0
      ? [
          `${count} connection${count === 1 ? "" : "s"} ${way} ${count === 1 ? "was" : "were"} refused, the last at ${at}: ${why}`,
        ]
      : [];
  }),
];

declare namespace notesOf {
  /** nothing left out and nothing refused: nothing said */
  export type None = Expect<
    Invoke<
      typeof notesOf,
      [
        left: {
          more: 0;
          past: 0;
          refused: { in: { count: 0; at: ""; why: "" }; out: { count: 0; at: ""; why: "" } };
        },
      ]
    >,
    "=",
    []
  >;
  /** each bound by its number, and each way's refusals with the last one's reason */
  export type Said = Expect<
    Invoke<
      typeof notesOf,
      [
        left: {
          more: 44;
          past: 1;
          refused: {
            in: {
              count: 1;
              at: "2026-11-23T06:00:00.000Z";
              why: "this workspace has 2 connections in carried at once";
            };
            out: {
              count: 3;
              at: "2026-11-21T06:00:00.000Z";
              why: "this workspace has 48 connections out carried at once";
            };
          };
        },
      ]
    >,
    "=",
    [
      "44 more listeners are not forwarded: a compose service's past the first 256 (workspace/bridge.ts)",
      "1 more listener is not forwarded: past the first 256 of a workspace",
      "1 connection in was refused, the last at 2026-11-23T06:00:00.000Z: this workspace has 2 connections in carried at once",
      "3 connections out were refused, the last at 2026-11-21T06:00:00.000Z: this workspace has 48 connections out carried at once",
    ]
  >;
}

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
    { listeners: [5173, 8080]; low: [80, 1023]; past: 0 }
  >;
  /** past FORWARDS_MOST, the rest are counted, not taken */
  export type Past = Expect<
    Invoke<
      typeof shown,
      [
        value: Invoke<
          typeof listenersFrom,
          [
            ports: Invoke<typeof portRange, [from: 2000, count: 300]>,
            ours: Invoke<typeof setOf, [items: []]>,
          ]
        >,
      ]
    >,
    "matches",
    { low: []; past: 44 }
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
const portsView = <
  E extends Routable & {
    reserved: ReadonlySet<number>;
    low?: readonly number[];
    notes?: readonly string[];
  },
>(
  workspaces: E[],
  hostHeld: { has(port: number): boolean },
  rawOwner: { get(port: number): string | undefined },
  holderOf: (port: number) => string,
): PortView[] =>
  workspaces
    .map((entry) => ({
      workspace: `${entry.domain}/${entry.workspace}`,
      forwarded: [...entry.listeners]
        .sort((a, b) => a - b)
        .filter((port) => !hostHeld.has(port))
        .map((port) => ({
          port,
          url: `http://${devHostname(INSTANCE, entry.domain, entry.workspace)}:${port}`,
        })),
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
        ...(entry.low ?? []).map((port) => ({
          port,
          why: `listening in the workspace, below ${PORTS.min}: not forwarded (below ${PORTS.min} a port is this Mac's system's). Run it on a port from ${PORTS.min} up`,
        })),
      ],
      notes: [...(entry.notes ?? [])],
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
                [
                  at: "dev/w2",
                  listening: [5173, 3000],
                  more: {
                    reserved: [5432];
                    low: [80];
                    notes: ["1 more listener is not forwarded: past the first 256 of a workspace"];
                  },
                ]
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
        notes: [];
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
          {
            port: 80;
            why: "listening in the workspace, below 1024: not forwarded (below 1024 a port is this Mac's system's). Run it on a port from 1024 up";
          },
        ];
        notes: ["1 more listener is not forwarded: past the first 256 of a workspace"];
      },
    ]
  >;
}

export {
  byName,
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
  unasked,
  spokeAsBrowser,
  tokenEpochOf,
  unforwardedOf,
};
export type { Checkouts, Heard, Routable };
