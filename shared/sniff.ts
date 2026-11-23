// Reading the name a connection asks for, from its first bytes: the TLS SNI or the HTTP Host.
// Used on both sides of a workspace: the forwarder routes an inbound connection to the
// workspace its name belongs to (section 4.4: v2's ingress host check, turned from a filter
// into a router), and the egress relay learns which host an outbound connection wants.
// Pure functions over a Buffer, so they are unit-tested without a socket.
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Invoke, Table } from "../../suede.nests/dsl.import.meta.vitest.ts";
import type {
  bytes,
  clientHello,
  crossedHello,
  faultyHello,
  repeated,
  splitHello,
} from "../.harness/shared-bytes.ts";
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

/** The name of an HTTP request's head: its one Host header's. None if it has two (which one a
 *  server goes by is its own), or if its target names a host (`GET http://other.example/`,
 *  which a server goes by over the Host) and that is not the Host's. */
const hostHeader = (head: string): string | null => {
  const [requestLine = "", ...lines] = head.split(/\r?\n/);
  const hosts = lines.filter((line) => /^host:/i.test(line));
  if (hosts.length !== 1) return null;
  const name = normalizeName(hosts[0]!.slice("host:".length));
  const absolute = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(requestLine.split(" ")[1] ?? "");
  return absolute && normalizeName(absolute[1]!) !== name ? null : name;
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
 *  first record is not complete yet. A hello may come in several records, which a server joins
 *  before it reads; read across them as one buffer, a record's header would be taken for part
 *  of the hello, and the name read need not be the server's. So the hello must be whole in its
 *  first record, and every length is held to the hello's end (and a name to its extension):
 *  one that runs past names no one, as does a second server_name, which a server refuses. */
const sni = (data: Buffer): string | null | undefined => {
  if (data.length < 5) return undefined;
  const recordEnd = 5 + data.readUInt16BE(3);
  if (data.length < recordEnd) return undefined;
  if (recordEnd < 9 || data[5] !== 0x01) return null;
  const helloEnd = 9 + data.readUIntBE(6, 3);
  if (helloEnd > recordEnd) return null;
  let at = 9 + 2 + 32; // the version and the random
  for (const size of [1, 2, 1]) {
    // the session id, the cipher suites, the compression methods
    if (at + size > helloEnd) return null;
    at += size + data.readUIntBE(at, size);
  }
  if (at + 2 > helloEnd) return null;
  const extensionsEnd = at + 2 + data.readUInt16BE(at);
  if (extensionsEnd > helloEnd) return null;
  let name: string | null | undefined;
  for (at += 2; at < extensionsEnd;) {
    if (at + 4 > extensionsEnd) return null;
    const end = at + 4 + data.readUInt16BE(at + 2);
    if (end > extensionsEnd) return null;
    if (data.readUInt16BE(at) === 0) {
      // server_name: a list (its 2-byte length) of one host_name (type 0, 2-byte length).
      if (name !== undefined || at + 9 > end) return null;
      const listEnd = at + 6 + data.readUInt16BE(at + 4);
      const nameEnd = at + 9 + data.readUInt16BE(at + 7);
      if (listEnd !== end || data[at + 6] !== 0 || nameEnd !== listEnd) return null;
      name = normalizeName(data.subarray(at + 9, nameEnd).toString("latin1"));
    }
    at = end;
  }
  return name ?? null;
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
  /** a target that names a host (absolute form) is a server's name for the request: the
   *  Host's, when they agree */
  export type HttpAbsoluteTarget = Table<
    typeof sniff,
    [
      [
        args: [
          data: Invoke<
            typeof bytes,
            [text: "GET http://A.localhost:80/x HTTP/1.1\r\nHost: a.localhost\r\n\r\n"]
          >,
        ],
        expected: { kind: "http"; name: "a.localhost" },
      ],
      [
        args: [
          data: Invoke<
            typeof bytes,
            [text: "GET http://other.example/ HTTP/1.1\r\nHost: allowed.example\r\n\r\n"]
          >,
        ],
        expected: { kind: "http"; name: null },
      ],
      [
        args: [
          data: Invoke<
            typeof bytes,
            [
              text: "GET HTTPS://allowed.example@other.example/ HTTP/1.1\r\nHost: allowed.example\r\n\r\n",
            ]
          >,
        ],
        expected: { kind: "http"; name: null },
      ],
    ]
  >;
  /** HTTP that names no one, or not by its head: refused, never routed. Two Hosts name no
   *  one (a server may go by either); a header that only ends in "host", or one in the body,
   *  is not it */
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
        expected: { kind: "http"; name: null },
      ],
      [
        args: [
          data: Invoke<
            typeof bytes,
            [text: "GET / HTTP/1.1\r\nHost: one.localhost\r\nhost: one.localhost\r\n\r\n"]
          >,
        ],
        expected: { kind: "http"; name: null },
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
  /** a hello in more than one record names no one, wherever it was split (in its fixed part,
   *  just after its extensions' length, inside an extension): a server joins the records, and
   *  this does not. The control: the same hello, in one record, names its host */
  export type TlsSplit = Table<
    typeof sniff,
    [
      [
        args: [data: Invoke<typeof clientHello, [name: "a.example"]>],
        expected: { kind: "tls"; name: "a.example" },
      ],
      [
        args: [data: Invoke<typeof splitHello, [name: "a.example", at: 20]>],
        expected: { kind: "tls"; name: null },
      ],
      [
        args: [data: Invoke<typeof splitHello, [name: "a.example", at: 47]>],
        expected: { kind: "tls"; name: null },
      ],
      [
        args: [data: Invoke<typeof splitHello, [name: "a.example", at: 50]>],
        expected: { kind: "tls"; name: null },
      ],
      [
        args: [data: Invoke<typeof splitHello, [name: "a.example", at: 61]>],
        expected: { kind: "tls"; name: null },
      ],
    ]
  >;
  /** what this is for: a hello split so that its bytes read flat, the second record's header
   *  among them, show one name, while the joined hello a server reads carries another. Split,
   *  it names no one (it was read as allowed.example); in one record, the server's name */
  export type TlsCrossed = Table<
    typeof sniff,
    [
      [
        args: [
          data: Invoke<
            typeof crossedHello,
            [seen: "allowed.example", real: "other.example", split: false]
          >,
        ],
        expected: { kind: "tls"; name: "other.example" },
      ],
      [
        args: [
          data: Invoke<
            typeof crossedHello,
            [seen: "allowed.example", real: "other.example", split: true]
          >,
        ],
        expected: { kind: "tls"; name: null },
      ],
    ]
  >;
  /** a length that runs past what holds it names no one: the hello's past its record, the
   *  extensions' past the hello, a name's past its extension; so does a second server_name,
   *  which a server refuses rather than pick one. The control: the same hello, well formed, its
   *  server name first */
  export type TlsMalformed = Table<
    typeof sniff,
    [
      [
        args: [data: Invoke<typeof faultyHello, [fault: "none"]>],
        expected: { kind: "tls"; name: "a.example" },
      ],
      [
        args: [data: Invoke<typeof faultyHello, [fault: "longer"]>],
        expected: { kind: "tls"; name: null },
      ],
      [
        args: [data: Invoke<typeof faultyHello, [fault: "extensions"]>],
        expected: { kind: "tls"; name: null },
      ],
      [
        args: [data: Invoke<typeof faultyHello, [fault: "name"]>],
        expected: { kind: "tls"; name: null },
      ],
      [
        args: [data: Invoke<typeof faultyHello, [fault: "twice"]>],
        expected: { kind: "tls"; name: null },
      ],
    ]
  >;
  /** a recorded limit, not a check: a hello with Encrypted Client Hello (0xfe0d) is read by
   *  its outer server name, though a server that takes ECH goes by the encrypted inner one.
   *  Browsers send a placeholder ECH on ordinary connections, so it is not refused here */
  export type TlsEchOuterName = Expect<
    Invoke<typeof sniff, [data: Invoke<typeof faultyHello, [fault: "ech"]>]>,
    "=",
    { kind: "tls"; name: "public.example" }
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
