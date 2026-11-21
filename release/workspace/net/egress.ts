// The egress relay in a workspace VM. It makes the proxy transparent to programs: they need
// no proxy settings, because every outbound connection to port 80 or 443 is redirected here
// (net/up.sh), and this reads the host the connection wants from its TLS SNI or HTTP Host
// and asks the workspace's proxy for it over the link.
//
// THIS IS NOT A BOUNDARY, and nothing depends on it being honest. It runs inside the VM, where
// an agent may be root: stop it, replace it, or speak to the link directly, and the proxy on
// the other end still decides what this workspace reaches. With no link there is no way out
// at all: that is the backend's doing, outside the VM (P5).
//
//   node egress.ts <link>      link: unix:/path  or  tcp:host:port[#token]  (shared/link.ts)
import * as fs from "node:fs";
import { connect, createServer } from "node:net";
import type { Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { open as openLink, parseLink } from "../../shared/link.ts";
import { sniffSocket } from "../../shared/sniff.ts";
import { printable } from "../../shared/text.ts";
import type { Sniffed } from "../../shared/sniff.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Invoke, Table } from "../../../suede.nests/dsl.import.meta.vitest.ts";
import type { bytes } from "../../.harness/shared-bytes.ts";
import type { repeatedReason, throughEgress, utf8, xs } from "../../.harness/workspace-egress.ts";

type Link = NonNullable<ReturnType<typeof parseLink>>;

/** A connection to the proxy, ready for a CONNECT; null if there is none. A link carried
 *  over a port is used only once the host at the other end has proved it holds this
 *  workspace's token (shared/link.ts): nothing is sent to a program that took the port. */
const dial = (link: Link): Promise<Socket | null> =>
  new Promise((resolve) => {
    const socket = "unix" in link ? connect(link.unix) : connect(link.port, link.host);
    socket.once("error", () => resolve(null));
    socket.once("connect", () => {
      if ("unix" in link || !link.token) return resolve(socket);
      void openLink(socket, link.token).then((ok) => resolve(ok ? socket : null));
    });
  });

/** What a refused client is sent: plain HTTP gets the reason as a page; anything else
 *  (TLS) is closed without a word (null), since no reply could be read there. */
export const refusalOf = (http: boolean, status: string, text: string): string | null => {
  if (!http) return null;
  const body = `desolate: ${text}\n`;
  return `HTTP/1.1 ${status}\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
};

declare namespace refusalOf {
  export type Http = Expect<
    Invoke<
      typeof refusalOf,
      [http: true, status: "403 Forbidden", text: "café.example is not allowed"]
    >,
    "=",
    "HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\nContent-Length: 39\r\n\r\ndesolate: café.example is not allowed\n"
  >;
  export type Tls = Expect<
    Invoke<typeof refusalOf, [http: false, status: "403 Forbidden", text: "x"]>,
    "=",
    null
  >;
}

const refuse = (client: Socket, http: boolean, status: string, text: string) => {
  const refusal = refusalOf(http, status, text);
  if (refusal === null) return client.destroy();
  client.end(refusal);
};

/** Where the proxy is asked to connect: the name the connection gave, at the port it was
 *  sent to. Null for one that names no host: an address alone leaves nothing. */
export const targetOf = (sniffed: Sniffed, scheme: "http" | "https"): string | null =>
  (sniffed.kind !== "http" && sniffed.kind !== "tls") || !sniffed.name
    ? null
    : `${sniffed.name}:${scheme === "https" ? 443 : 80}`;

declare namespace targetOf {
  /** named HTTP and TLS, each at its scheme's port */
  export type Named = Table<
    typeof targetOf,
    [
      [
        args: [sniffed: { kind: "http"; name: "registry.npmjs.org" }, scheme: "http"],
        expected: "registry.npmjs.org:80",
      ],
      [
        args: [sniffed: { kind: "tls"; name: "github.com" }, scheme: "https"],
        expected: "github.com:443",
      ],
      /** the port is the one redirected here, never one the client names */
      [
        args: [sniffed: { kind: "tls"; name: "github.com" }, scheme: "http"],
        expected: "github.com:80",
      ],
      /** a Host that is an address goes to the proxy as it is: the proxy, not this, decides */
      [
        args: [sniffed: { kind: "http"; name: "10.0.0.1" }, scheme: "http"],
        expected: "10.0.0.1:80",
      ],
    ]
  >;
  /** no name, and no protocol that carries one: refused before the proxy is asked */
  export type Unnamed = Table<
    typeof targetOf,
    [
      [args: [sniffed: { kind: "http"; name: null }, scheme: "http"], expected: null],
      [args: [sniffed: { kind: "tls"; name: null }, scheme: "https"], expected: null],
      [args: [sniffed: { kind: "raw" }, scheme: "https"], expected: null],
      [args: [sniffed: { kind: "more" }, scheme: "http"], expected: null],
    ]
  >;
}

/** The most of the proxy's answer's head that is read: as much as node's own HTTP server
 *  reads of a request's (`maxHeaderSize`, 16 KiB). What answers is the workspace's proxy, or
 *  the host's end of the link (daemon.ts), neither of which says more. */
const HEAD_MOST = 16 * 1024;

/** The proxy's answer to the CONNECT, as far as it has come: more to read, too much without
 *  an end, a refusal with the proxy's reason, or open, its own bytes ending at `bodyAt`. The
 *  reason is its whole line (it was cut at 300 characters), as UTF-8, made safe to show. A
 *  503 is `busy`: the link's room is full for now (host/daemon.ts), which a program may try
 *  again, unlike a refused destination (403). */
export const proxyAnswer = (
  answer: Buffer,
): "more" | "too much" | { refused: string; busy?: true } | { bodyAt: number } => {
  const end = answer.indexOf("\r\n\r\n");
  if (end < 0 ? answer.length > HEAD_MOST : end > HEAD_MOST) return "too much";
  if (end < 0) return "more";
  const status = answer.subarray(0, answer.indexOf("\r\n")).toString("latin1");
  if (!/^HTTP\/1\.[01] 200 /.test(status)) {
    const reason = /\r\nX-Desolate-Reason: ([^\r\n]*)/i.exec(
      answer.subarray(0, end).toString("utf8"),
    )?.[1];
    return {
      refused: reason ? printable(reason) : "the proxy refused this destination",
      ...(/^HTTP\/1\.[01] 503 /.test(status) ? { busy: true as const } : {}),
    };
  }
  return { bodyAt: end + 4 };
};

declare namespace proxyAnswer {
  /** open: what follows the answer's head is already the destination's */
  export type Open = Table<
    typeof proxyAnswer,
    [
      [
        args: [answer: Invoke<typeof bytes, [text: "HTTP/1.1 200 Connection established\r\n\r\n"]>],
        expected: { bodyAt: 39 },
      ],
      [
        args: [
          answer: Invoke<typeof bytes, [text: "HTTP/1.0 200 OK\r\nVia: desolate\r\n\r\nSSH-2.0"]>,
        ],
        expected: { bodyAt: 34 },
      ],
    ]
  >;
  /** anything but a 200 is a refusal, with the proxy's reason when it gave one */
  export type Refused = Table<
    typeof proxyAnswer,
    [
      [
        args: [
          answer: Invoke<
            typeof bytes,
            [
              text: "HTTP/1.1 403 Forbidden\r\nx-desolate-reason: example.com is not on this domain's list\r\n\r\n",
            ]
          >,
        ],
        expected: { refused: "example.com is not on this domain's list" },
      ],
      [
        args: [
          answer: Invoke<
            typeof bytes,
            [text: "HTTP/1.1 407 Proxy Authentication Required\r\n\r\n"]
          >,
        ],
        expected: { refused: "the proxy refused this destination" },
      ],
      /** 200 only as the status: not in a reason, not as HTTP/2 */
      [
        args: [answer: Invoke<typeof bytes, [text: "HTTP/1.1 502 200 OK\r\n\r\n"]>],
        expected: { refused: "the proxy refused this destination" },
      ],
      [
        args: [answer: Invoke<typeof bytes, [text: "HTTP/2 200 \r\n\r\n"]>],
        expected: { refused: "the proxy refused this destination" },
      ],
      /** a reason is one line: a header after it is not read as part of it */
      [
        args: [
          answer: Invoke<
            typeof bytes,
            [text: "HTTP/1.1 403 Forbidden\r\nX-Desolate-Reason: no\r\nX-Other: yes\r\n\r\n"]
          >,
        ],
        expected: { refused: "no" },
      ],
      /** a 503, the link's room full for now, is said to be so */
      [
        args: [
          answer: Invoke<
            typeof bytes,
            [
              text: "HTTP/1.1 503 Service Unavailable\r\nX-Desolate-Reason: full\r\nContent-Length: 0\r\n\r\n",
            ]
          >,
        ],
        expected: { refused: "full"; busy: true },
      ],
      /** the whole line, however long, in the UTF-8 the proxy writes, and only made safe */
      [
        args: [
          answer: Invoke<
            typeof utf8,
            [
              text: "HTTP/1.1 403 Forbidden\r\nX-Desolate-Reason: café.example is not on this domain's list; to allow it: desolate domain dev net allow café.example\u001b[2J\r\n\r\n",
            ]
          >,
        ],
        expected: {
          refused: "café.example is not on this domain's list; to allow it: desolate domain dev net allow café.example?[2J";
        },
      ],
      [
        args: [answer: Invoke<typeof repeatedReason, [length: 2000]>],
        expected: { refused: Invoke<typeof xs, [length: 2000]> },
      ],
    ]
  >;
  /** a head past HEAD_MOST is not an answer, ended or not */
  export type TooMuch = Table<
    typeof proxyAnswer,
    [[args: [answer: Invoke<typeof repeatedReason, [length: 17000]>], expected: "too much"]]
  >;
  export type Incomplete = Table<
    typeof proxyAnswer,
    [
      [
        args: [answer: Invoke<typeof bytes, [text: "HTTP/1.1 200 Connection established\r\n"]>],
        expected: "more",
      ],
    ]
  >;
}

export const serve = (link: Link, port: number, scheme: "http" | "https", host = "0.0.0.0") =>
  createServer(async (client) => {
    client.on("error", () => client.destroy());
    const { sniffed, head } = await sniffSocket(client, 5000);
    const http = sniffed.kind === "http";
    const target = targetOf(sniffed, scheme);
    if (target === null)
      return refuse(
        client,
        http,
        "403 Forbidden",
        "this connection names no host (no TLS server name, no Host header). Only named HTTP and TLS leave a workspace; an address alone does not.",
      );
    const upstream = await dial(link);
    if (!upstream)
      return refuse(
        client,
        http,
        "502 Bad Gateway",
        "this workspace's proxy is not answering, or what answered was not it. On the host: desolate doctor",
      );
    let answer = Buffer.alloc(0);
    let open = false;
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    upstream.on("error", () =>
      open
        ? close()
        : refuse(
            client,
            http,
            "502 Bad Gateway",
            "this workspace's proxy is not answering. On the host: desolate doctor",
          ),
    );
    upstream.on("close", close);
    client.on("close", close);
    upstream.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    const onAnswer = (chunk: Buffer) => {
      answer = Buffer.concat([answer, chunk]);
      const read = proxyAnswer(answer);
      if (read === "more") return undefined;
      if (read === "too much") return close();
      upstream.off("data", onAnswer);
      if ("refused" in read) {
        // The proxy's refusal, with its reason, reaches a plain-HTTP client as text; a link
        // that is full for now as such (503, which a program may retry), not as forbidden.
        upstream.destroy();
        return refuse(
          client,
          http,
          read.busy ? "503 Service Unavailable" : "403 Forbidden",
          read.refused,
        );
      }
      open = true;
      const rest = answer.subarray(read.bodyAt);
      if (rest.length > 0) client.write(rest);
      upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
      client.resume();
    };
    upstream.on("data", onAnswer);
  }).listen(port, host);

declare namespace serve {
  /** a named connection is asked of the proxy as CONNECT, and once it is open the client's
   *  own first bytes go on, and the destination's come back */
  export type Relays = Expect<
    Invoke<
      typeof throughEgress,
      [
        serve: typeof serve,
        scheme: "http",
        sent: "GET / HTTP/1.1\r\nHost: registry.npmjs.org\r\n\r\n",
        proxy: "HTTP/1.1 200 Connection established\r\n\r\n",
      ]
    >,
    "=",
    {
      proxyAsked: "CONNECT registry.npmjs.org:80 HTTP/1.1\r\nHost: registry.npmjs.org:80\r\n\r\n";
      destinationGot: "GET / HTTP/1.1\r\nHost: registry.npmjs.org\r\n\r\n";
      client: "the destination's answer";
    }
  >;
  export type RelaysTls = Expect<
    Invoke<
      typeof throughEgress,
      [
        serve: typeof serve,
        scheme: "https",
        sent: { tls: "github.com" },
        proxy: "HTTP/1.1 200 Connection established\r\n\r\n",
      ]
    >,
    "matches",
    {
      proxyAsked: "CONNECT github.com:443 HTTP/1.1\r\nHost: github.com:443\r\n\r\n";
      client: "the destination's answer";
    }
  >;
  /** the proxy's refusal reaches a plain-HTTP client with its reason; a TLS client is closed */
  export type ProxyRefuses = [
    Expect<
      Invoke<
        typeof throughEgress,
        [
          serve: typeof serve,
          scheme: "http",
          sent: "GET / HTTP/1.1\r\nHost: example.com\r\n\r\n",
          proxy: "HTTP/1.1 403 Forbidden\r\nX-Desolate-Reason: example.com is not on this domain's list\r\n\r\n",
        ]
      >,
      "=",
      {
        proxyAsked: "CONNECT example.com:80 HTTP/1.1\r\nHost: example.com:80\r\n\r\n";
        destinationGot: null;
        client: "HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\nContent-Length: 51\r\n\r\ndesolate: example.com is not on this domain's list\n";
      }
    >,
    Expect<
      Invoke<
        typeof throughEgress,
        [
          serve: typeof serve,
          scheme: "https",
          sent: { tls: "example.com" },
          proxy: "HTTP/1.1 403 Forbidden\r\n\r\n",
        ]
      >,
      "matches",
      { destinationGot: null; client: "" }
    >,
  ];
  /** a connection that names no host never reaches the proxy */
  export type Unnamed = [
    Expect<
      Invoke<
        typeof throughEgress,
        [
          serve: typeof serve,
          scheme: "http",
          sent: "GET / HTTP/1.1\r\nAccept: */*\r\n\r\n",
          proxy: "HTTP/1.1 200 Connection established\r\n\r\n",
        ]
      >,
      "matches",
      { proxyAsked: null; destinationGot: null }
    >,
    Expect<
      Invoke<
        typeof throughEgress,
        [
          serve: typeof serve,
          scheme: "https",
          sent: { tls: null },
          proxy: "HTTP/1.1 200 Connection established\r\n\r\n",
        ]
      >,
      "=",
      { proxyAsked: null; destinationGot: null; client: "" }
    >,
  ];
  /** no proxy at the link's end: the client is told, and nothing else is tried */
  export type NoProxy = Expect<
    Invoke<
      typeof throughEgress,
      [
        serve: typeof serve,
        scheme: "http",
        sent: "GET / HTTP/1.1\r\nHost: example.com\r\n\r\n",
        proxy: null,
      ]
    >,
    "=",
    {
      proxyAsked: null;
      destinationGot: null;
      client: "HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\nContent-Length: 109\r\n\r\ndesolate: this workspace's proxy is not answering, or what answered was not it. On the host: desolate doctor\n";
    }
  >;
}

const main = (address: string) => {
  const link = parseLink(address);
  if (!link) throw new Error(`egress: '${address}' is not a link address`);
  serve(link, 15080, "http");
  serve(link, 15443, "https");
};

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv[2] ?? "");
