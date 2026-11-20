// The dashboard from your phone, over Tailscale.
//
// `desolate phone on` has Tailscale Serve publish one loopback port of this Mac to your
// tailnet, over HTTPS, at this Mac's tailnet name (https://<mac>.<tailnet>.ts.net:8443). The
// host daemon answers that port with the dashboard and nothing else: no approval page, no
// editor, no git terminal. Pushes are still approved here, on the Mac (a decision recorded in
// docs; the phone reviews, and the push waits for you).
//
// Each request is checked, then passed to the dashboard as if it came from this Mac's own
// browser:
//   - it came through Tailscale Serve, from the login `desolate phone on` recorded: Serve
//     names the tailnet user in Tailscale-User-Login (and drops one a client sent), so a
//     device of someone else's on a shared tailnet is refused here, before the dashboard's
//     token is even asked for;
//   - it is for this Mac's tailnet name;
//   - its Host and Origin become the dashboard's own (desolate.localhost), which the root's
//     state service checks on every request (shared/gate.ts). An Origin of any other site is
//     passed on as it is, and refused there.
// The dashboard's token is still what opens it: the phone opens the address `desolate phone`
// prints once, which sets the dashboard's cookie for the tailnet name.
//
// Anything on this Mac can reach the loopback port and claim a Tailscale login. That is no
// more than it can do already (the dashboard's own port is on loopback too): the token is the
// key, here as there.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";
import * as path from "node:path";
import { run } from "../shared/run.ts";
import { editorHostPort, ROOT_HOSTNAME } from "../shared/names.ts";
import { paths } from "./paths.ts";
import type { Expect, Invoke, Table } from "../../suede.nests/dsl.import.meta.vitest.ts";

/** What `desolate phone on` recorded: whose devices may open it, and at what name. */
export type Phone = { login: string; name: string; httpsPort: number };

const STATE = () => path.join(paths.state, "phone.json");

/** The loopback port Tailscale Serve is pointed at: the pages' port plus ten, unless set. */
export const phonePort = () => {
  const port = Number(process.env.DESOLATE_PHONE_PORT ?? editorHostPort() + 10);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error(`DESOLATE_PHONE_PORT must be a port from 1024 to 65535, not '${port}'`);
  return port;
};

/** The HTTPS port on the tailnet name: 8443, so a Serve of your own on 443 is left alone. */
export const phoneHttpsPort = () => Number(process.env.DESOLATE_PHONE_HTTPS_PORT ?? 8443);

export const readPhone = (): Phone | null => {
  try {
    const p = JSON.parse(fs.readFileSync(STATE(), "utf8")) as Partial<Phone>;
    return typeof p.login === "string" &&
      typeof p.name === "string" &&
      typeof p.httpsPort === "number"
      ? { login: p.login, name: p.name, httpsPort: p.httpsPort }
      : null;
  } catch {
    return null;
  }
};

const hostOf = (value: string | undefined) => {
  if (!value) return "";
  try {
    return new URL(value.includes("://") ? value : `http://${value}`).hostname.toLowerCase();
  } catch {
    return "\0";
  }
};
const printable = (text: string) => text.slice(0, 80).replace(/[^\x20-\x7e]/g, "?");

/** One request from the phone: refused (and why), or the headers it is passed on with. */
/** What every request over the tailnet must be, the dashboard's and the agents page's: from
 *  the login `desolate phone on` recorded, through Tailscale Serve, for this Mac's name. */
export const tailnetRequest = (
  phone: Phone | null,
  headers: IncomingHttpHeaders,
): { refused: { status: number; text: string } } | { phone: Phone } => {
  if (!phone)
    return {
      refused: {
        status: 404,
        text: "desolate is not on the tailnet: `desolate phone on`, on the Mac",
      },
    };
  const login = headers["tailscale-user-login"];
  if (typeof login !== "string" || login === "")
    return {
      refused: {
        status: 403,
        text: "this port answers Tailscale Serve only, for a person's device (not a tagged one)",
      },
    };
  if (login.toLowerCase() !== phone.login.toLowerCase())
    return {
      refused: {
        status: 403,
        text: `this is ${phone.login}'s desolate; ${printable(login)} is not`,
      },
    };
  if (hostOf(headers.host) !== phone.name.toLowerCase())
    return { refused: { status: 421, text: `this answers at ${phone.name} only` } };
  return { phone };
};

/** One request for the dashboard from the phone: refused (and why), or the headers it is
 *  passed on with. */
export const phoneRequest = (
  phone: Phone | null,
  headers: IncomingHttpHeaders,
  pagesPort: number,
): { refused: { status: number; text: string } } | { headers: OutgoingHttpHeaders } => {
  const checked = tailnetRequest(phone, headers);
  if ("refused" in checked) return checked;
  const own = `${ROOT_HOSTNAME}:${pagesPort}`;
  const passed: OutgoingHttpHeaders = { ...headers, host: own };
  // The phone's own origin becomes the dashboard's; any other is passed on, and refused there.
  if (
    typeof headers.origin === "string" &&
    hostOf(headers.origin) === checked.phone.name.toLowerCase()
  )
    passed.origin = `http://${own}`;
  if (
    typeof headers.referer === "string" &&
    hostOf(headers.referer) === checked.phone.name.toLowerCase()
  )
    passed.referer = `http://${own}${new URL(headers.referer).pathname}`;
  for (const name of Object.keys(passed)) if (name.startsWith("x-forwarded-")) delete passed[name];
  return { headers: passed };
};

declare namespace phoneRequest {
  /** your phone, over Tailscale Serve: passed to the dashboard as if from this Mac's browser */
  export type Passes = Expect<
    Invoke<
      typeof phoneRequest,
      [
        phone: { login: "you@example.com"; name: "mac.tail1234.ts.net"; httpsPort: 8443 },
        headers: {
          host: "mac.tail1234.ts.net:8443";
          origin: "https://mac.tail1234.ts.net:8443";
          cookie: "c=1";
          "tailscale-user-login": "you@example.com";
          "x-forwarded-for": "100.64.0.2";
        },
        pagesPort: 31581,
      ]
    >,
    "=",
    {
      headers: {
        host: "desolate.localhost:31581";
        origin: "http://desolate.localhost:31581";
        cookie: "c=1";
        "tailscale-user-login": "you@example.com";
      };
    }
  >;
  /** a page of another site keeps its own Origin, which the dashboard refuses */
  export type OtherOrigin = Expect<
    Invoke<
      typeof phoneRequest,
      [
        phone: { login: "you@example.com"; name: "mac.tail1234.ts.net"; httpsPort: 8443 },
        headers: {
          host: "mac.tail1234.ts.net:8443";
          origin: "https://evil.example";
          "tailscale-user-login": "you@example.com";
        },
        pagesPort: 31581,
      ]
    >,
    "matches",
    { headers: { origin: "https://evil.example" } }
  >;
  /** off, not through Serve, someone else's device, another name: refused before the token */
  export type Refuses = Table<
    typeof phoneRequest,
    [
      [
        args: [phone: null, headers: { host: "mac.tail1234.ts.net" }, pagesPort: 31581],
        expected: {
          refused: {
            status: 404;
            text: "desolate is not on the tailnet: `desolate phone on`, on the Mac";
          };
        },
      ],
      [
        args: [
          phone: { login: "you@example.com"; name: "mac.tail1234.ts.net"; httpsPort: 8443 },
          headers: { host: "mac.tail1234.ts.net" },
          pagesPort: 31581,
        ],
        expected: {
          refused: {
            status: 403;
            text: "this port answers Tailscale Serve only, for a person's device (not a tagged one)";
          };
        },
      ],
      [
        args: [
          phone: { login: "you@example.com"; name: "mac.tail1234.ts.net"; httpsPort: 8443 },
          headers: { host: "mac.tail1234.ts.net"; "tailscale-user-login": "them@example.com" },
          pagesPort: 31581,
        ],
        expected: {
          refused: {
            status: 403;
            text: "this is you@example.com's desolate; them@example.com is not";
          };
        },
      ],
      [
        args: [
          phone: { login: "you@example.com"; name: "mac.tail1234.ts.net"; httpsPort: 8443 },
          headers: { host: "desolate.localhost:31591"; "tailscale-user-login": "you@example.com" },
          pagesPort: 31581,
        ],
        expected: {
          refused: { status: 421; text: "this answers at mac.tail1234.ts.net only" };
        },
      ],
    ]
  >;
}

/** The phone's port, on 127.0.0.1 only (Tailscale Serve is pointed there; nothing else is
 *  told of it). Each request is decided by phoneRequest, then passed to this daemon's own
 *  pages port, which routes it to the dashboard by its rewritten name. */
export const servePhone = (log: (line: string) => void) => {
  const pagesPort = editorHostPort();
  const server = createServer((req, res) => {
    const decided = phoneRequest(readPhone(), req.headers, pagesPort);
    if ("refused" in decided) {
      res.writeHead(decided.refused.status, { "content-type": "text/plain; charset=utf-8" });
      return res.end(`desolate: ${decided.refused.text}\n`);
    }
    const upstream = request(
      {
        host: "127.0.0.1",
        port: pagesPort,
        method: req.method,
        path: req.url,
        headers: decided.headers,
      },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end("desolate: the dashboard did not answer\n");
    });
    req.pipe(upstream);
    res.on("close", () => upstream.destroy());
  });
  server.on("error", (error: NodeJS.ErrnoException) =>
    log(`phone port ${phonePort()}: ${error.message}`),
  );
  server.listen({ port: phonePort(), host: "127.0.0.1", exclusive: true });
  return server;
};

// ------------------------------------------------------------------ Tailscale
/** The tailscale command: DESOLATE_TAILSCALE, else on PATH, else the macOS app's. */
const tailscale = () =>
  process.env.DESOLATE_TAILSCALE ||
  ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"].find(
    (candidate) => !candidate.startsWith("/") || fs.existsSync(candidate),
  )!;

/** This Mac on its tailnet, from `tailscale status --json`: its name and its owner's login. */
export const tailnetSelf = (
  status: string,
): { name: string; login: string } | { refused: string } => {
  let parsed: {
    BackendState?: string;
    Self?: { DNSName?: string; UserID?: number };
    User?: Record<string, { LoginName?: string }>;
  };
  try {
    parsed = JSON.parse(status) as typeof parsed;
  } catch {
    return { refused: "tailscale did not say what this Mac is on its tailnet" };
  }
  if (parsed.BackendState !== "Running")
    return {
      refused: `Tailscale is not connected here (${printable(String(parsed.BackendState ?? "unknown"))})`,
    };
  const name = String(parsed.Self?.DNSName ?? "")
    .replace(/\.$/, "")
    .toLowerCase();
  const login = parsed.User?.[String(parsed.Self?.UserID)]?.LoginName ?? "";
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(name))
    return { refused: "this Mac has no name on its tailnet" };
  if (!login)
    return {
      refused:
        "this Mac's tailnet owner has no login (a tagged device): the phone could not be told from anyone's",
    };
  return { name, login };
};

declare namespace tailnetSelf {
  /** the Mac's name (without the root's dot) and the login of the person it belongs to */
  export type Running = Expect<
    Invoke<
      typeof tailnetSelf,
      [
        status: '{"BackendState":"Running","Self":{"DNSName":"Mac.tail1234.ts.net.","UserID":7},"User":{"7":{"LoginName":"you@example.com"}}}',
      ]
    >,
    "=",
    { name: "mac.tail1234.ts.net"; login: "you@example.com" }
  >;
  /** not connected, a tagged device, or no answer: nothing is published */
  export type Refuses = Table<
    typeof tailnetSelf,
    [
      [
        args: [status: '{"BackendState":"NeedsLogin"}'],
        expected: { refused: "Tailscale is not connected here (NeedsLogin)" },
      ],
      [
        args: [
          status: '{"BackendState":"Running","Self":{"DNSName":"mac.tail1234.ts.net.","UserID":9},"User":{}}',
        ],
        expected: {
          refused: "this Mac's tailnet owner has no login (a tagged device): the phone could not be told from anyone's";
        },
      ],
      [
        args: [status: "not json"],
        expected: { refused: "tailscale did not say what this Mac is on its tailnet" },
      ],
    ]
  >;
}

/** `desolate phone on`: Serve publishes the phone's port at this Mac's tailnet name. */
export const phoneOn = async (): Promise<Phone | { refused: string; fix: string }> => {
  const status = await run(tailscale(), ["status", "--json"], { timeoutMs: 15_000 });
  if (status.code !== 0)
    return {
      refused: "Tailscale is not installed or not running on this Mac",
      fix: "install Tailscale (tailscale.com/download), sign in, then: desolate phone on",
    };
  const self = tailnetSelf(status.stdout);
  if ("refused" in self)
    return { refused: self.refused, fix: "tailscale up, then: desolate phone on" };
  const httpsPort = phoneHttpsPort();
  // The dashboard at httpsPort, the agents page (agents-web.ts) at the next: two origins.
  for (const [https, local] of [
    [httpsPort, phonePort()],
    [httpsPort + 1, phonePort() + 1],
    // The dev servers' slots (serveSlots).
    ...Array.from(
      { length: SLOTS },
      (_, slot) => [slotHttpsPort(slot), slotLocalPort(slot)] as const,
    ),
  ] as const) {
    const serve = await run(
      tailscale(),
      ["serve", "--bg", `--https=${https}`, `http://127.0.0.1:${local}`],
      {
        timeoutMs: 30_000,
      },
    );
    if (serve.code !== 0)
      return {
        refused: `tailscale serve refused: ${printable(serve.stderr.trim() || serve.stdout.trim())}`,
        fix: "turn on HTTPS for your tailnet (the admin console's DNS page), then: desolate phone on",
      };
  }
  const phone: Phone = { ...self, httpsPort };
  fs.mkdirSync(paths.state, { recursive: true });
  fs.writeFileSync(STATE(), `${JSON.stringify(phone)}\n`, { mode: 0o600 });
  return phone;
};

/** `desolate phone off`: Serve stops publishing it, and the port refuses everything. */
export const phoneOff = async (): Promise<void> => {
  const phone = readPhone();
  fs.rmSync(STATE(), { force: true });
  const https = phone?.httpsPort ?? phoneHttpsPort();
  for (const port of [
    https,
    https + 1,
    ...Array.from({ length: SLOTS }, (_, slot) => slotHttpsPort(slot)),
  ])
    await run(tailscale(), ["serve", `--https=${port}`, "off"], { timeoutMs: 15_000 });
};

/** The phone's addresses, each with its page's token (opened once on the phone). */
export const phoneAddress = (phone: Phone, token: string) =>
  `https://${phone.name}${phone.httpsPort === 443 ? "" : `:${phone.httpsPort}`}/?tkn=${token}`;

// ------------------------------------------------------------------ dev servers, on the tailnet
// A workspace's dev server, from your phone. On the Mac each has a name of its own
// (<domain>-<workspace>-<hex>.localhost:<port>); the tailnet has one name for this Mac. So
// `desolate phone on` publishes a fixed block of slots, https://<mac>:9101 to :9116, and the
// daemon gives each forwarded dev server a slot while it listens. A slot's proxy asks
// tailnetRequest, then passes the request (and a WebSocket, for hot reload) to the forwarder
// on the Mac under the workspace's own name, so the server sees what it sees on the Mac.
//
// One name for every slot, and for the dashboard and the agents page, means one cookie jar:
// a browser sends a name's cookies to every port of it. So a slot's proxy never passes
// desolate's own cookies to a dev server, and never lets one set them; and the cookies a dev
// server sets are renamed for its slot, and passed back to its slot only, so one
// workspace's server does not get another's. (A cookie a page's own script sets cannot be
// renamed: it goes to every slot, as on any one host.)

/** How many slots: dev servers on the tailnet at once. */
export const SLOTS = 16;
/** A slot's port on the tailnet name. */
export const slotHttpsPort = (slot: number) => 9101 + slot;
/** A slot's loopback port, where Tailscale Serve sends it. */
export const slotLocalPort = (slot: number) => phonePort() + 10 + slot;

/** Which dev server (a key: "<vm> <port>") has which slot, as servers come and go: one that
 *  has a slot keeps it, a new one takes the first free, one that is gone frees its own. */
export const assignSlots = (previous: readonly (string | null)[], wanted: readonly string[]) => {
  const slots: (string | null)[] = Array.from({ length: SLOTS }, (_, i) =>
    wanted.includes(previous[i] ?? "\0") ? previous[i]! : null,
  );
  for (const key of wanted)
    if (!slots.includes(key)) {
      const free = slots.indexOf(null);
      if (free >= 0) slots[free] = key;
    }
  return slots;
};

declare namespace assignSlots {
  /** a server keeps its slot; a new one takes the first free; one gone frees its own */
  export type Stable = Expect<
    Invoke<
      typeof assignSlots,
      [
        previous: [
          "vm1 5173",
          "vm2 3000",
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
        ],
        wanted: ["vm2 3000", "vm3 8080"],
      ]
    >,
    "=",
    [
      "vm3 8080",
      "vm2 3000",
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ]
  >;
}

const COOKIE_PAIR = /^\s*([^=;\s]+)=(.*)$/;
/** desolate's own cookies, and every dev server's renamed ones (`slot<n>__`: the names before
 *  they were keyed by server, never passed on either). */
const ours = (name: string) =>
  /^desolate/i.test(name) || /^s[0-9a-f]{10}__/.test(name) || /^slot\d+__/.test(name);

/** The prefix a dev server's cookies are kept under on the tailnet: from the server itself (its
 *  workspace's dev hostname, which names the domain and the workspace, and its port), never from
 *  its slot. A slot is dealt to the next server when one stops, and dealt again whenever the
 *  daemon restarts: keyed by slot, one server's login session went to whichever had the slot
 *  next, in another workspace or another domain. */
export const cookieTag = (devHost: string, port: number) =>
  `s${createHash("sha256").update(`${devHost} ${port}`).digest("hex").slice(0, 10)}`;

declare namespace cookieTag {
  /** the same server, the same tag; another port, another */
  export type Cases = Table<
    typeof cookieTag,
    [
      [args: [devHost: "acme-w1-0a1b2c.localhost", port: 5173], expected: "sf650b90ea0"],
      [args: [devHost: "acme-w1-0a1b2c.localhost", port: 8080], expected: "s9ce031d08c"],
    ]
  >;
}

/** The Cookie header a dev server is sent (`tag`: cookieTag of it): none of desolate's, its own
 *  under the names it set them with, another server's not at all, and what a page's script set. */
export const slotCookies = (header: string | undefined, tag: string): string | undefined => {
  const kept: string[] = [];
  for (const part of String(header ?? "").split(";")) {
    const pair = COOKIE_PAIR.exec(part);
    if (!pair) continue;
    const [, name, value] = pair as unknown as [string, string, string];
    if (name.startsWith(`${tag}__`)) kept.push(`${name.slice(tag.length + 2)}=${value}`);
    else if (!ours(name)) kept.push(`${name}=${value}`);
  }
  return kept.length ? kept.join("; ") : undefined;
};

declare namespace slotCookies {
  /** the dashboard's and the agents page's cookies never reach a dev server; another
   *  server's neither, nor any under the old slot names; its own come back under its own names */
  export type Isolated = Expect<
    Invoke<
      typeof slotCookies,
      [
        header: "desolate_ui_ab12=tok; desolate_agents_cd34=tok2; sf650b90ea0__sid=mine; s9ce031d08c__sid=theirs; slot3__sid=old; theme=dark",
        tag: "sf650b90ea0",
      ]
    >,
    "=",
    "sid=mine; theme=dark"
  >;
  /** a server new to a slot gets none of the slot's last server's cookies */
  export type NotTheSlots = Expect<
    Invoke<typeof slotCookies, [header: "sf650b90ea0__sid=mine", tag: "s9ce031d08c"]>,
    "=",
    undefined
  >;
  /** nothing left: no Cookie header at all */
  export type Nothing = Expect<
    Invoke<typeof slotCookies, [header: "desolate_ui_ab12=tok", tag: "sf650b90ea0"]>,
    "=",
    undefined
  >;
}

/** The Set-Cookie headers a dev server may send back: each renamed for it, and HttpOnly, so no
 *  other dev server's page script can read it (they share the tailnet name, so one cookie jar);
 *  none that would set one of desolate's, or another server's. */
export const slotSetCookies = (values: readonly string[] | undefined, tag: string): string[] =>
  (values ?? []).flatMap((value) => {
    const pair = COOKIE_PAIR.exec(value);
    if (!pair || ours(pair[1]!)) return [];
    const renamed = `${tag}__${value.trimStart()}`;
    return [/;\s*httponly\s*(;|$)/i.test(renamed) ? renamed : `${renamed}; HttpOnly`];
  });

declare namespace slotSetCookies {
  /** its own, renamed for it and HttpOnly (once); desolate's, another server's, or an old slot
   *  name, dropped */
  export type Renamed = Expect<
    Invoke<
      typeof slotSetCookies,
      [
        values: [
          "sid=abc; Path=/; HttpOnly",
          "theme=dark; Path=/",
          "desolate_ui_ab12=x; Path=/",
          "s9ce031d08c__sid=y",
          "slot1__sid=z",
        ],
        tag: "sf650b90ea0",
      ]
    >,
    "=",
    ["sf650b90ea0__sid=abc; Path=/; HttpOnly", "sf650b90ea0__theme=dark; Path=/; HttpOnly"]
  >;
}

/** A redirect a dev server sends to its own name, made the slot's address on the tailnet. */
export const slotLocation = (location: string, devOrigin: string, slotOrigin: string) =>
  location.startsWith(devOrigin) ? `${slotOrigin}${location.slice(devOrigin.length)}` : location;

declare namespace slotLocation {
  export type Cases = Table<
    typeof slotLocation,
    [
      [
        args: [
          location: "http://acme-w1-0a1b2c.localhost:5173/login",
          devOrigin: "http://acme-w1-0a1b2c.localhost:5173",
          slotOrigin: "https://mac.tail1234.ts.net:9101",
        ],
        expected: "https://mac.tail1234.ts.net:9101/login",
      ],
      [
        args: [
          location: "/login",
          devOrigin: "http://acme-w1-0a1b2c.localhost:5173",
          slotOrigin: "https://mac.tail1234.ts.net:9101",
        ],
        expected: "/login",
      ],
    ]
  >;
}

/** What a slot reaches now: a workspace's dev hostname and its port, or nothing. */
export type SlotTarget = { devHost: string; port: number } | null;

/** The slots' proxies, on 127.0.0.1 only (Tailscale Serve is pointed there). `target` says
 *  what each slot reaches now, as the daemon assigned it. */
export const serveSlots = (log: (line: string) => void, target: (slot: number) => SlotTarget) => {
  const decide = (slot: number, headers: IncomingHttpHeaders) => {
    const checked = tailnetRequest(readPhone(), headers);
    if ("refused" in checked) return checked;
    const to = target(slot);
    if (!to)
      return {
        refused: {
          status: 404,
          text: "no dev server is on this address now: `desolate ports` lists them",
        },
      };
    const devOrigin = `http://${to.devHost}:${to.port}`;
    const slotOrigin = `https://${checked.phone.name}:${slotHttpsPort(slot)}`;
    const passed: OutgoingHttpHeaders = { ...headers, host: `${to.devHost}:${to.port}` };
    if (typeof headers.origin === "string" && headers.origin === slotOrigin)
      passed.origin = devOrigin;
    if (typeof headers.referer === "string" && headers.referer.startsWith(slotOrigin))
      passed.referer = `${devOrigin}${headers.referer.slice(slotOrigin.length)}`;
    const cookie = slotCookies(headers.cookie, cookieTag(to.devHost, to.port));
    if (cookie) passed.cookie = cookie;
    else delete passed.cookie;
    for (const name of Object.keys(passed))
      if (name.startsWith("x-forwarded-") || name.startsWith("tailscale-")) delete passed[name];
    return { to, devOrigin, slotOrigin, headers: passed };
  };
  for (let slot = 0; slot < SLOTS; slot++) {
    const server = createServer((req, res) => {
      const d = decide(slot, req.headers);
      if ("refused" in d) {
        res.writeHead(d.refused.status, { "content-type": "text/plain; charset=utf-8" });
        return res.end(`desolate: ${d.refused.text}\n`);
      }
      const upstream = request(
        {
          host: "127.0.0.1",
          port: d.to.port,
          method: req.method,
          path: req.url,
          headers: d.headers,
        },
        (answer) => {
          const headers = { ...answer.headers };
          const set = slotSetCookies(
            answer.headers["set-cookie"],
            cookieTag(d.to.devHost, d.to.port),
          );
          if (set.length) headers["set-cookie"] = set;
          else delete headers["set-cookie"];
          if (typeof headers.location === "string")
            headers.location = slotLocation(headers.location, d.devOrigin, d.slotOrigin);
          res.writeHead(answer.statusCode ?? 502, headers);
          answer.pipe(res);
        },
      );
      upstream.on("error", () => {
        if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        res.end("desolate: the workspace's dev server did not answer\n");
      });
      req.pipe(upstream);
      res.on("close", () => upstream.destroy());
    });
    // A WebSocket (Vite's hot reload): the same checks, then the bytes both ways.
    server.on("upgrade", (req, client, head) => {
      const d = decide(slot, req.headers);
      if ("refused" in d) {
        client.end(
          `HTTP/1.1 ${d.refused.status} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
        );
        return;
      }
      const upstream = connect(d.to.port, "127.0.0.1", () => {
        const lines = [`${req.method} ${req.url} HTTP/1.1`];
        for (const [name, value] of Object.entries(d.headers))
          for (const v of Array.isArray(value) ? value : [value])
            if (v !== undefined) lines.push(`${name}: ${v}`);
        upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
        if (head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      const end = () => {
        client.destroy();
        upstream.destroy();
      };
      upstream.on("error", end);
      client.on("error", end);
      upstream.on("close", end);
      client.on("close", end);
    });
    server.on("error", (error: NodeJS.ErrnoException) =>
      log(`phone slot ${slot} (port ${slotLocalPort(slot)}): ${error.message}`),
    );
    server.listen({ port: slotLocalPort(slot), host: "127.0.0.1", exclusive: true });
  }
};

/** A dev server's address on the tailnet, when it has a slot and the phone is on. */
export const slotAddress = (slot: number) => {
  const phone = readPhone();
  return phone ? `https://${phone.name}:${slotHttpsPort(slot)}/` : undefined;
};
