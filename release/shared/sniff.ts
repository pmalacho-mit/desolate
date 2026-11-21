// Reading the name a connection asks for, from its first bytes: the TLS SNI or the HTTP Host.
// Used on both sides of a workspace: the forwarder routes an inbound connection to the
// workspace its name belongs to (section 4.4: v2's ingress host check, turned from a filter
// into a router), and the egress relay learns which host an outbound connection wants.
// Pure functions over a Buffer, so they are unit-tested without a socket.
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Invoke, Table } from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { bytes, clientHello, repeated } from "../.harness/shared-bytes.ts";
import type { clientSending } from "../.harness/shared-socket.ts";

export type Sniffed =
  | { kind: "tls"; name: string | null }
  | { kind: "http"; name: string | null }
  | { kind: "raw" }
  /** Not decidable yet: read more (up to `LIMIT`) and ask again. */
  | { kind: "more" };

/** The most read of a connection before what it asks for is decided (R7: whoever connects,
 *  a browser or anything else on the network, writes it). 16 KiB is a TLS record's largest
 *  body (2^14 bytes), which holds a ClientHello and its server name, and node's own limit
 *  for HTTP headers: past it a client is not one that names a host. */
export const LIMIT = 16 * 1024;

const HTTP_START = /^[A-Z]{1,16} \S+ HTTP\/1\.[01]\r?\n/;

const hostHeader = (head: string): string | null => {
  for (const line of head.split(/\r?\n/).slice(1)) {
    const match = /^host:\s*(.*?)\s*$/i.exec(line);
    if (match) return normalizeName(match[1]!);
  }
  return null;
};

/** A hostname, lowercased, without a port or a trailing dot; null if it is not one. */
export const normalizeName = (raw: string): string | null => {
  let name = raw.trim().toLowerCase();
  if (name.startsWith("[")) return null;
  const colon = name.lastIndexOf(":");
  if (colon >= 0) {
    if (!/^\d{1,5}$/.test(name.slice(colon + 1))) return null;
    name = name.slice(0, colon);
  }
  if (name.endsWith(".")) name = name.slice(0, -1);
  return /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)*$/.test(name) &&
    name.length <= 253
    ? name
    : null;
};

declare namespace normalizeName {
  /** one spelling of a name: lower case, no port, no trailing dot */
  export type Names = Table<
    typeof normalizeName,
    [
      [args: [raw: "Web-One-abc123.Localhost"], expected: "web-one-abc123.localhost"],
      [args: [raw: "a.localhost:5173"], expected: "a.localhost"],
      [args: [raw: "a.localhost."], expected: "a.localhost"],
    ]
  >;
  /** anything else names nothing: an address in brackets, a port that is not a number, a
   *  character a hostname cannot hold, an empty label */
  export type Refuses = Table<
    typeof normalizeName,
    [
      [args: [raw: "[::1]:80"], expected: null],
      [args: [raw: "a.localhost:http"], expected: null],
      [args: [raw: "a.localhost:80:80"], expected: null],
      [args: [raw: "a_b.localhost"], expected: null],
      [args: [raw: "a b"], expected: null],
      [args: [raw: "a..b"], expected: null],
      [args: [raw: "-a.localhost"], expected: null],
      [args: [raw: ""], expected: null],
    ]
  >;
}

/** The server_name of a TLS ClientHello, or null if it carries none. `undefined` if the
 *  record is not complete yet. */
const sni = (data: Buffer): string | null | undefined => {
  if (data.length < 5) return undefined;
  const recordLength = data.readUInt16BE(3);
  if (data.length < 5 + recordLength) return undefined;
  let at = 5;
  if (data[at] !== 0x01) return null;
  at += 4 + 2 + 32;
  if (at >= data.length) return null;
  at += 1 + data[at]!;
  if (at + 2 > data.length) return null;
  at += 2 + data.readUInt16BE(at);
  if (at >= data.length) return null;
  at += 1 + data[at]!;
  if (at + 2 > data.length) return null;
  const end = at + 2 + data.readUInt16BE(at);
  at += 2;
  while (at + 4 <= end && at + 4 <= data.length) {
    const type = data.readUInt16BE(at);
    const length = data.readUInt16BE(at + 2);
    at += 4;
    if (type === 0 && at + 5 <= data.length) {
      const nameLength = data.readUInt16BE(at + 3);
      if (data[at + 2] !== 0 || at + 5 + nameLength > data.length) return null;
      return normalizeName(data.subarray(at + 5, at + 5 + nameLength).toString("latin1"));
    }
    at += length;
  }
  return null;
};

/** What could be the start of an HTTP request: a method, then a space. Such bytes are HTTP:
 *  if the request line never parses, or the head runs past LIMIT, they are HTTP that names
 *  no one (refused), never a protocol with no name. They once were taken for one, and routed
 *  to whichever workspace had the port first, with no name checked: a page could send the
 *  person's browser there with a 20 KB path and another site's cookies (audit, 2026-11-16). */
const HTTP_SHAPED = /^[A-Z]{1,16}( |$)/;

export const sniff = (data: Buffer): Sniffed => {
  if (data.length === 0) return { kind: "more" };
  if (data[0] === 0x16) {
    if (data.length >= 2 && data[1] !== 0x03) return { kind: "raw" };
    const name = sni(data);
    if (name === undefined)
      return data.length >= LIMIT ? { kind: "tls", name: null } : { kind: "more" };
    return { kind: "tls", name };
  }
  const text = data.subarray(0, Math.min(data.length, LIMIT)).toString("latin1");
  if (HTTP_START.test(text)) {
    const end = text.search(/\r?\n\r?\n/);
    if (end < 0)
      return data.length >= LIMIT ? { kind: "http", name: hostHeader(text) } : { kind: "more" };
    return { kind: "http", name: hostHeader(text.slice(0, end)) };
  }
  if (HTTP_SHAPED.test(text))
    return text.includes("\n") || data.length >= LIMIT
      ? { kind: "http", name: null }
      : { kind: "more" };
  return { kind: "raw" };
};

declare namespace sniff {
  /** HTTP: the Host header's name, by which the forwarder routes */
  export type Http = Table<
    typeof sniff,
    [
      [
        args: [
          data: Invoke<
            typeof bytes,
            [text: "GET / HTTP/1.1\r\nHost: Web-One-abc123.localhost:5173\r\nAccept: */*\r\n\r\n"]
          >,
        ],
        expected: { kind: "http"; name: "web-one-abc123.localhost" },
      ],
      [
        args: [data: Invoke<typeof bytes, [text: "PURGE /cache HTTP/1.0\nhost:a.localhost\n\n"]>],
        expected: { kind: "http"; name: "a.localhost" },
      ],
    ]
  >;
  /** HTTP that names no one, or not by its head: refused, never routed. The first Host
   *  counts; a header that only ends in "host", or one in the body, is not it */
  export type HttpNamesNoOne = Table<
    typeof sniff,
    [
      [
        args: [
          data: Invoke<
            typeof bytes,
            [text: "GET / HTTP/1.1\r\nHost: one.localhost\r\nHost: two.localhost\r\n\r\n"]
          >,
        ],
        expected: { kind: "http"; name: "one.localhost" },
      ],
      [
        args: [data: Invoke<typeof bytes, [text: "GET / HTTP/1.0\r\n\r\n"]>],
        expected: { kind: "http"; name: null },
      ],
      [
        args: [data: Invoke<typeof bytes, [text: "GET / HTTP/1.1\r\nX-Host: a.localhost\r\n\r\n"]>],
        expected: { kind: "http"; name: null },
      ],
      [
        args: [
          data: Invoke<
            typeof bytes,
            [text: "POST / HTTP/1.1\r\nContent-Length: 30\r\n\r\nHost: smuggled.localhost\r\n\r\n"]
          >,
        ],
        expected: { kind: "http"; name: null },
      ],
      [
        args: [data: Invoke<typeof bytes, [text: "GET / HTTP/9\r\n\r\n"]>],
        expected: { kind: "http"; name: null },
      ],
    ]
  >;
  /** a request line longer than a sniff reads is HTTP that names no one, not a protocol with
   *  no name (it once went, unchecked, to the port's first workspace) */
  export type LongRequestLine = Expect<
    Invoke<
      typeof sniff,
      [data: Invoke<typeof repeated, [text: "GET /xxxxxxxxxxxxxxx", count: 1000]>]
    >,
    "=",
    { kind: "http"; name: null }
  >;
  /** TLS: the ClientHello's server name; none, if it carries none */
  export type Tls = Table<
    typeof sniff,
    [
      [
        args: [data: Invoke<typeof clientHello, [name: "Web-Two-0a1b2c.localhost"]>],
        expected: { kind: "tls"; name: "web-two-0a1b2c.localhost" },
      ],
      [
        args: [data: Invoke<typeof clientHello, [name: null]>],
        expected: { kind: "tls"; name: null },
      ],
      [
        args: [data: Invoke<typeof clientHello, [name: "a b"]>],
        expected: { kind: "tls"; name: null },
      ],
    ]
  >;
  /** not decidable yet: read more and ask again */
  export type More = Table<
    typeof sniff,
    [
      [args: [data: Invoke<typeof bytes, [text: ""]>], expected: { kind: "more" }],
      [args: [data: Invoke<typeof bytes, [text: "GET / HT"]>], expected: { kind: "more" }],
      [
        args: [data: Invoke<typeof bytes, [text: "GET / HTTP/1.1\r\nHost: a.localhost\r\n"]>],
        expected: { kind: "more" },
      ],
      [
        args: [data: Invoke<typeof clientHello, [name: "a.localhost", keep: 40]>],
        expected: { kind: "more" },
      ],
    ]
  >;
  /** a protocol with no name in it (a server-speaks-first one, Redis, SSH; 0x16 not followed
   *  by TLS's version byte) */
  export type Raw = Table<
    typeof sniff,
    [
      [
        args: [data: Invoke<typeof bytes, [text: "SSH-2.0-OpenSSH_9.6\r\n"]>],
        expected: { kind: "raw" },
      ],
      [
        args: [data: Invoke<typeof bytes, [text: "*1\r\n$4\r\nPING\r\n"]>],
        expected: { kind: "raw" },
      ],
      [args: [data: Invoke<typeof bytes, [text: "\u0016\u0001\u0000"]>], expected: { kind: "raw" }],
    ]
  >;
}

/** Read from a socket until its first bytes are classified, or the wait or the size runs
 *  out. A client that says nothing within `quietMs` is a raw one (a protocol where the
 *  server speaks first). */
/** `undecided`: it ended (the wait, or the client) before its bytes said what they were. */
export const sniffSocket = (
  socket: import("node:net").Socket,
  quietMs: number,
): Promise<{ sniffed: Sniffed; head: Buffer; undecided?: boolean }> =>
  new Promise((resolve) => {
    let head = Buffer.alloc(0);
    const finish = (sniffed: Sniffed, undecided = false) => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("close", onClose);
      socket.pause();
      resolve({ sniffed, head, ...(undecided ? { undecided } : {}) });
    };
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const sniffed = sniff(head);
      if (sniffed.kind !== "more") finish(sniffed);
      else if (head.length >= LIMIT) finish({ kind: "raw" });
    };
    const onClose = () => finish({ kind: "raw" }, true);
    const timer = setTimeout(() => finish({ kind: "raw" }, true), quietMs);
    socket.on("data", onData);
    socket.on("close", onClose);
  });

declare namespace sniffSocket {
  /** read until the bytes say what they are, however they were split, and what was read is
   *  kept to be passed on */
  export type Decides = Expect<
    Invoke<
      typeof sniffSocket,
      [
        socket: Invoke<
          typeof clientSending,
          [chunks: ["GET / HT", "TP/1.1\r\nHost: a.localhost\r\n\r\n"]]
        >,
        quietMs: 5000,
      ]
    >,
    "matches",
    { sniffed: { kind: "http"; name: "a.localhost" } }
  >;
  /** a client that says nothing (the server speaks first: SMTP, MySQL) is raw, once the wait
   *  is over; so is one that leaves before it said what it was. Either is `undecided` */
  export type Quiet = [
    Expect<
      Invoke<typeof sniffSocket, [socket: Invoke<typeof clientSending, [chunks: []]>, quietMs: 20]>,
      "matches",
      { sniffed: { kind: "raw" }; undecided: true }
    >,
    Expect<
      Invoke<
        typeof sniffSocket,
        [socket: Invoke<typeof clientSending, [chunks: ["GET / HT"], end: true]>, quietMs: 5000]
      >,
      "matches",
      { sniffed: { kind: "raw" }; undecided: true }
    >,
  ];
}

/** A raw port's server's greeting so far, as a browser would read it if it came on the socket
 *  it preconnected (final review, 2026-11-16): an `answer` (Chrome takes "HTTP" within the first
 *  5 bytes; Firefox also "ICY " after up to 7 of white space, read in its source, not tried),
 *  `more` while what came could still become one, or `other`, which can no longer: only then
 *  does any of it go on. A server whose whole greeting is that short still gets through: its
 *  bytes stop looking like an answer at once ("raw:one\n" at its first byte). */
export const greetingIs = (text: string): "answer" | "more" | "other" => {
  const lower = text.toLowerCase();
  if (/^[\s\S]{0,4}http/.test(lower) || /^\s{0,7}icy /.test(lower)) return "answer";
  const could = (word: string, at: number) => word.startsWith(lower.slice(at, at + word.length));
  for (let at = 0; at <= 4; at++) if (could("http", at)) return "more";
  const space = /^\s*/.exec(lower)![0].length;
  return space <= 7 && could("icy ", space) ? "more" : "other";
};

declare namespace greetingIs {
  /** an answer, a start that could still be one, or neither */
  export type Verdict = Table<
    typeof greetingIs,
    [
      [args: [text: "HTTP/1.1 200 OK\r\n"], expected: "answer"],
      [args: [text: "\r\n\r\nhttp/1.0 200"], expected: "answer"],
      [args: [text: "  ICY 200 OK"], expected: "answer"],
      [args: [text: "H"], expected: "more"],
      [args: [text: "xxxxHT"], expected: "more"],
      [args: [text: "  IC"], expected: "more"],
      [args: [text: "raw:one\n"], expected: "other"],
      [args: [text: "220 mail.example ESMTP\r\n"], expected: "other"],
      [args: [text: "J\u0000\u0000\u0000\n8.0.36\u0000"], expected: "other"],
    ]
  >;
}
