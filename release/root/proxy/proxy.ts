// A workspace's proxy (section 4.3). One instance per running workspace, in the root VM,
// reached only over that workspace's link. Which instance a connection arrives at is what
// attributes it: `domain=<d> workspace=<w>` comes from this process's arguments, never from
// anything the workspace says.
//
//   node proxy.ts <port> <domain> <workspace>
//
// It speaks one thing: `CONNECT <name>:<80|443>`. For each it
//   - refuses a destination that is not a hostname, or a port other than 80 and 443;
//   - applies the DOMAIN's network rules (open, or enforce an allowlist of hosts);
//   - resolves the name itself, outside the workspace, and refuses an internal address
//     (loopback, private, link-local, CGNAT, metadata) unless the domain was given that
//     address explicitly; then connects to the address it checked, not to the name again;
//   - audits the verdict.
//
// SECRETS (Phase 4): this process never sees one. A connection to port 443 of a host that
// one of the domain's secrets names is handed, after every check above, to the domain's
// secrets proxy (secrets.ts, secrets_addon.py), with the name and the ADDRESS checked here:
// that proxy terminates TLS for that name only, substitutes placeholders, and connects to
// that address, never resolving again. Every other connection stays end-to-end TLS between
// the workspace and the real server.
import { lookup } from "node:dns/promises";
import * as fs from "node:fs";
import { connect, createServer, isIP } from "node:net";
import type { Socket } from "node:net";
import { readJson } from "../../shared/json.ts";
import { normalizeName } from "../../shared/sniff.ts";
import { ROOT } from "../layout.ts";
import type { Running } from "./secrets.ts";
import { listenerUid } from "./as-proxy.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Invoke, Table } from "../../../suede.nests/dsl.import.meta.vitest.ts";

const [, , socketArg, domain, workspace] = process.argv;
/** Run as a proxy (manage.ts starts one: node with this file's path), not imported. */
const running = Boolean(
  process.argv[1] && fs.realpathSync(process.argv[1]) === new URL(import.meta.url).pathname,
);
// The domain names this proxy's directories: a slug, or nothing at all. Its socket is in
// its domain's out/ (root/proxy-user.sh): there and nowhere else.
if (
  running &&
  process.argv[1]?.endsWith("proxy.ts") &&
  (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(domain ?? "") ||
    !(socketArg ?? "").startsWith(`${ROOT.proxies}/out/${domain}/`) ||
    !/^[a-z0-9-]{1,60}\.sock$/.test(
      (socketArg ?? "").slice(`${ROOT.proxies}/out/${domain}/`.length),
    ))
) {
  console.error(
    "proxy.ts: usage: proxy.ts <its socket, in its domain's out/> <domain> <workspace>",
  );
  process.exit(2);
}
// What it reads is its domain's directory, and what it writes is its domain's proxies' own
// (as-proxy.ts; it runs as that domain's proxies' user).
const DOMAIN_DIR = `${ROOT.proxies}/domains/${domain}`;
const AUDIT = `${ROOT.proxies}/out/${domain}/audit.log`;
export type Policy = { mode: "open" | "enforce"; hosts: string[]; internal: string[] };
const policy = (): Policy => ({
  mode: "open",
  hosts: [],
  internal: [],
  ...readJson<Partial<Policy>>(`${DOMAIN_DIR}/policy.json`, {}),
});

const audit = (entry: Record<string, unknown>) =>
  fs.appendFileSync(
    AUDIT,
    JSON.stringify({ time: new Date().toISOString(), domain, workspace, ...entry }) + "\n",
  );

/** Addresses a workspace must never be carried to: this machine, the LAN, link-local,
 *  carrier NAT, cloud metadata, multicast, and anything that is not a public unicast IPv4. */
export const isInternal = (address: string): boolean => {
  if (isIP(address) !== 4) return true;
  const [a, b] = address.split(".").map(Number) as [number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
};

/** `*.example.com` matches any depth below example.com, never example.com itself. */
export const hostAllowed = (host: string, patterns: string[]): boolean =>
  patterns.some((pattern) =>
    pattern.startsWith("*.")
      ? host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1
      : host === pattern,
  );

declare namespace isInternal {
  /** a public address is carried to */
  export type Public = Table<
    typeof isInternal,
    [
      [args: [address: "140.82.112.3"], expected: false],
      [args: [address: "8.8.8.8"], expected: false],
      [args: [address: "172.32.0.1"], expected: false],
    ]
  >;
  /** this machine, the LAN, link-local and cloud metadata, carrier NAT, the proxies' own
   *  placeholder range, multicast, and anything that is not IPv4 */
  export type Internal = Table<
    typeof isInternal,
    [
      [args: [address: "127.0.0.1"], expected: true],
      [args: [address: "10.0.0.5"], expected: true],
      [args: [address: "172.16.0.1"], expected: true],
      [args: [address: "192.168.1.1"], expected: true],
      [args: [address: "169.254.169.254"], expected: true],
      [args: [address: "100.64.0.1"], expected: true],
      [args: [address: "198.18.0.1"], expected: true],
      [args: [address: "0.0.0.0"], expected: true],
      [args: [address: "224.0.0.1"], expected: true],
      [args: [address: "::1"], expected: true],
      [args: [address: "example.com"], expected: true],
    ]
  >;
}

declare namespace hostAllowed {
  /** a name, or `*.name` for any depth below it */
  export type Allowed = Table<
    typeof hostAllowed,
    [
      [args: [host: "api.example.com", patterns: ["api.example.com"]], expected: true],
      [args: [host: "a.b.example.com", patterns: ["*.example.com"]], expected: true],
    ]
  >;
  /** never the name itself for a wildcard, never a name that only ends the same way */
  export type NotAllowed = Table<
    typeof hostAllowed,
    [
      [args: [host: "example.com", patterns: ["*.example.com"]], expected: false],
      [args: [host: "evilexample.com", patterns: ["*.example.com"]], expected: false],
      [args: [host: "api.example.com.evil.net", patterns: ["api.example.com"]], expected: false],
      [args: [host: "api.example.com", patterns: []], expected: false],
    ]
  >;
}

const answer = (client: Socket, status: string, reason: string) =>
  client.end(
    `HTTP/1.1 ${status}\r\nX-Desolate-Reason: ${reason.replace(/[\r\n]/g, " ").slice(0, 300)}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
  );

/** What a workspace asked to reach, from the first line it sent: a hostname (never an address
 *  alone) and port 80 or 443; else why it is refused. (`host` and `port` as read, for the
 *  audit, either way.) */
export const destinationOf = (
  head: string,
): { host: string | null; target: string; port: number; refused: string | null } => {
  const match = /^CONNECT (\S+) HTTP\/1\.[01]\r\n/.exec(head);
  const target = match?.[1] ?? "";
  const colon = target.lastIndexOf(":");
  const host = normalizeName(target.slice(0, colon));
  const port = Number(target.slice(colon + 1));
  const refused =
    !match || !host || isIP(host) !== 0
      ? "a destination is a hostname: an address alone is not carried"
      : port !== 80 && port !== 443
        ? "only ports 80 and 443 leave a workspace"
        : null;
  return { host, target, port, refused };
};

/** The domain's network rules for a host: open, or on its allowlist when enforced. */
export const allowlistRefusal = (
  rules: Policy,
  host: string,
  domain: string | undefined,
): string | null =>
  rules.mode === "enforce" && !hostAllowed(host, rules.hosts)
    ? `${host} is not on the domain ${domain}'s allowlist`
    : null;

/** Where the name resolved, outside the workspace: never an internal address, unless the
 *  domain was given that one. */
export const addressRefusal = (rules: Policy, host: string, address: string): string | null =>
  isInternal(address) && !rules.internal.includes(address)
    ? `${host} resolves to an internal address (${address}), which a workspace is not carried to`
    : null;

/** Whether the connection goes through the domain's secrets proxy: port 443 to a host one of
 *  its secrets names, when one is running. (`secrets`: what secrets.ts says is running.) */
export const viaSecretsProxy = (port: number, host: string, secrets: Running | null): boolean =>
  secrets !== null && port === 443 && hostAllowed(host, secrets.hosts);

/** What the secrets proxy is told, before the workspace's own bytes: the ADDRESS checked
 *  here (it connects there and never resolves again), and in headers the workspace cannot
 *  set, which workspace it is, the name it asked for, and the domain's token. */
export const handoff = (
  address: string,
  workspace: string | undefined,
  host: string,
  token: string,
) =>
  `CONNECT ${address}:443 HTTP/1.1\r\nHost: ${address}:443\r\nX-Desolate-Workspace: ${workspace}\r\nX-Desolate-Host: ${host}\r\nX-Desolate-Token: ${token}\r\n\r\n`;

declare namespace destinationOf {
  /** a hostname, lowercased, to 443 or 80 */
  export type Carried = Table<
    typeof destinationOf,
    [
      [
        args: [head: "CONNECT API.Example.com:443 HTTP/1.1\r\nHost: x\r\n\r\n"],
        expected: {
          host: "api.example.com";
          target: "API.Example.com:443";
          port: 443;
          refused: null;
        },
      ],
      [
        args: [head: "CONNECT example.com:80 HTTP/1.0\r\n\r\n"],
        expected: { host: "example.com"; target: "example.com:80"; port: 80; refused: null },
      ],
    ]
  >;
  /** an address alone (it would skip the domain's rules), another port, or not a CONNECT */
  export type Refused = Table<
    typeof destinationOf,
    [
      [
        args: [head: "CONNECT 1.2.3.4:443 HTTP/1.1\r\n\r\n"],
        cond: "matches",
        expected: { refused: "a destination is a hostname: an address alone is not carried" },
      ],
      [
        args: [head: "CONNECT [::1]:443 HTTP/1.1\r\n\r\n"],
        cond: "matches",
        expected: { refused: "a destination is a hostname: an address alone is not carried" },
      ],
      [
        args: [head: "CONNECT example.com:22 HTTP/1.1\r\n\r\n"],
        cond: "matches",
        expected: {
          host: "example.com";
          port: 22;
          refused: "only ports 80 and 443 leave a workspace";
        },
      ],
      [
        args: [head: "GET http://example.com/ HTTP/1.1\r\n\r\n"],
        cond: "matches",
        expected: { refused: "a destination is a hostname: an address alone is not carried" },
      ],
      [
        args: [head: "CONNECT exa mple.com:443 HTTP/1.1\r\n\r\n"],
        cond: "matches",
        expected: { refused: "a destination is a hostname: an address alone is not carried" },
      ],
    ]
  >;
}

declare namespace allowlistRefusal {
  /** an open network carries any name; an enforced one only what it lists */
  export type Rules = Table<
    typeof allowlistRefusal,
    [
      [
        args: [
          rules: { mode: "open"; hosts: []; internal: [] },
          host: "anything.example",
          domain: "acme",
        ],
        expected: null,
      ],
      [
        args: [
          rules: { mode: "enforce"; hosts: ["*.npmjs.org"]; internal: [] },
          host: "registry.npmjs.org",
          domain: "acme",
        ],
        expected: null,
      ],
      [
        args: [
          rules: { mode: "enforce"; hosts: ["*.npmjs.org"]; internal: [] },
          host: "evil.example",
          domain: "acme",
        ],
        expected: "evil.example is not on the domain acme's allowlist",
      ],
    ]
  >;
}

declare namespace addressRefusal {
  /** a public address; an internal one only when the person gave the domain that very one */
  export type Addresses = Table<
    typeof addressRefusal,
    [
      [
        args: [
          rules: { mode: "open"; hosts: []; internal: [] },
          host: "example.com",
          address: "93.184.216.34",
        ],
        expected: null,
      ],
      [
        args: [
          rules: { mode: "open"; hosts: []; internal: ["10.0.0.5"] },
          host: "db.lan",
          address: "10.0.0.5",
        ],
        expected: null,
      ],
      [
        args: [
          rules: { mode: "open"; hosts: []; internal: ["10.0.0.5"] },
          host: "rebind.example",
          address: "10.0.0.6",
        ],
        expected: "rebind.example resolves to an internal address (10.0.0.6), which a workspace is not carried to",
      ],
      [
        args: [
          rules: { mode: "open"; hosts: []; internal: [] },
          host: "meta.example",
          address: "169.254.169.254",
        ],
        expected: "meta.example resolves to an internal address (169.254.169.254), which a workspace is not carried to",
      ],
    ]
  >;
}

declare namespace viaSecretsProxy {
  // The domain's secrets proxy, running, for the hosts its secrets name.
  type Running = { port: 22000; pid: 4242; hosts: ["api.openai.com", "*.anthropic.com"] };
  /** to 443 of a host a secret names: through the secrets proxy, where the name is swapped
   *  for the value */
  export type Through = Table<
    typeof viaSecretsProxy,
    [
      [args: [port: 443, host: "api.openai.com", secrets: Running], expected: true],
      [args: [port: 443, host: "api.anthropic.com", secrets: Running], expected: true],
    ]
  >;
  /** anything else stays end to end, and a placeholder sent there arrives as a name: another
   *  host, port 80 (no TLS to terminate), or no secrets proxy at all */
  export type EndToEnd = Table<
    typeof viaSecretsProxy,
    [
      [args: [port: 443, host: "api.openai.com.evil.net", secrets: Running], expected: false],
      [args: [port: 443, host: "anthropic.com", secrets: Running], expected: false],
      [args: [port: 80, host: "api.openai.com", secrets: Running], expected: false],
      [args: [port: 443, host: "api.openai.com", secrets: null], expected: false],
    ]
  >;
}

declare namespace handoff {
  /** the secrets proxy connects to the address checked here, for the name asked, and believes
   *  the connection is this domain's only with its token */
  export type Says = Expect<
    Invoke<
      typeof handoff,
      [address: "162.159.140.245", workspace: "w1", host: "api.openai.com", token: "t0k"]
    >,
    "=",
    "CONNECT 162.159.140.245:443 HTTP/1.1\r\nHost: 162.159.140.245:443\r\nX-Desolate-Workspace: w1\r\nX-Desolate-Host: api.openai.com\r\nX-Desolate-Token: t0k\r\n\r\n"
  >;
}

const handle = async (client: Socket, head: string) => {
  const { host, target, port, refused } = destinationOf(head);
  const refuse = (reason: string) => {
    audit({ host: host ?? target.slice(0, 100), port, verdict: "refused", reason });
    answer(client, "403 Forbidden", reason);
  };
  if (refused || !host)
    return refuse(refused ?? "a destination is a hostname: an address alone is not carried");
  const rules = policy();
  const notListed = allowlistRefusal(rules, host, domain);
  if (notListed) return refuse(notListed);
  let address: string;
  try {
    address = (await lookup(host, { family: 4 })).address;
  } catch {
    return refuse(`${host} does not resolve`);
  }
  const internal = addressRefusal(rules, host, address);
  if (internal) return refuse(internal);
  // A host one of the domain's secrets names goes through the domain's secrets proxy. If
  // that proxy is not running the connection is refused, not passed around it: a
  // placeholder must never reach such a host as if it were the value (P6).
  const secrets =
    port === 443 ? readJson<Running | null>(`${DOMAIN_DIR}/secrets-proxy.json`, null) : null;
  const viaSecrets = viaSecretsProxy(port, host, secrets);
  // And only to a secrets proxy that is this domain's: the same user as this process is what
  // listens on that port (a port is anyone's to take first).
  const notOurs = viaSecrets
    ? secretsProxyRefusal(host, listenerUid(secrets!.port), process.getuid!())
    : null;
  if (notOurs) return refuse(notOurs);
  // To the address that was checked: a second lookup could answer differently.
  const upstream = viaSecrets
    ? connect({ host: "127.0.0.1", port: secrets!.port })
    : connect({ host: address, port });
  let open = false;
  upstream.setTimeout(30_000, () => upstream.destroy(new Error("timed out")));
  const established = () => {
    open = true;
    upstream.setTimeout(0);
    audit({ host, port, address, verdict: "allowed", ...(viaSecrets ? { via: "secrets" } : {}) });
    client.write("HTTP/1.1 200 Connection established\r\n\r\n");
    client.pipe(upstream);
    upstream.pipe(client);
  };
  upstream.on("connect", () => {
    if (!viaSecrets) return established();
    // The tunnel into the secrets proxy: the checked address as the destination, and what
    // this process knows about the connection in headers the workspace cannot set (its own
    // bytes begin after this exchange).
    // And the domain's token: the secrets proxy listens on the root VM's loopback, where any
    // user of the VM can connect, and substitutes only for a connection that shows it.
    let token = "";
    try {
      token = fs.readFileSync(`${DOMAIN_DIR}/link-token`, "utf8").trim();
    } catch {
      return refuse(
        `${host} is a host of one of this domain's secrets, and its handoff token cannot be read`,
      );
    }
    upstream.write(handoff(address, workspace, host, token));
    let reply = "";
    const onReply = (chunk: Buffer) => {
      reply += chunk.toString("latin1");
      if (!reply.includes("\r\n\r\n") && reply.length < 8192) return;
      upstream.off("data", onReply);
      if (!/^HTTP\/1\.[01] 200/.test(reply))
        return refuse(`the domain's secrets proxy refused the connection to ${host}`);
      established();
    };
    upstream.on("data", onReply);
  });
  const close = () => {
    client.destroy();
    upstream.destroy();
  };
  upstream.on("error", (error) =>
    open
      ? close()
      : refuse(
          viaSecrets
            ? `${host} is a host of one of this domain's secrets, and the domain's secrets proxy is not running (${error.message})`
            : `could not connect to ${host}: ${error.message}`,
        ),
  );
  upstream.on("close", close);
  client.on("close", close);
};

/** Whether the connection to a secret's host may go to the domain's secrets proxy: only when
 *  what listens on its port is this domain's proxies' user (`mine`). Nothing listening and
 *  something else listening are both refused, each said as it is: the first is mended by
 *  starting a workspace of the domain, the second is a program to look for. */
export const secretsProxyRefusal = (
  host: string,
  listener: number | null,
  mine: number,
): string | null =>
  listener === null
    ? `${host} is a host of one of this domain's secrets, and the domain's secrets proxy is not running (starting a workspace of the domain starts it)`
    : listener !== mine
      ? `${host} is a host of one of this domain's secrets, and what listens where its secrets proxy should is not this domain's`
      : null;

declare namespace secretsProxyRefusal {
  /** the domain's own proxy listens: the connection goes to it */
  export type Ours = Expect<
    Invoke<typeof secretsProxyRefusal, [host: "api.example.test", listener: 1001, mine: 1001]>,
    "=",
    null
  >;
  /** nothing listens (it was ended), or another user does (the port taken first): refused, each said as it is */
  export type Refused = Table<
    typeof secretsProxyRefusal,
    [
      [
        args: [host: "api.example.test", listener: null, mine: 1001],
        expected: "api.example.test is a host of one of this domain's secrets, and the domain's secrets proxy is not running (starting a workspace of the domain starts it)",
      ],
      [
        args: [host: "api.example.test", listener: 1002, mine: 1001],
        expected: "api.example.test is a host of one of this domain's secrets, and what listens where its secrets proxy should is not this domain's",
      ],
    ]
  >;
}

if (running && socketArg) {
  // A unix socket, not a loopback port: a port in the root VM is any of its users' to
  // connect to, and the proxies of another domain would have been one of them, asking this
  // workspace's proxy for this domain's secret hosts (it adds the domain's handoff token to
  // what it is asked): found by an audit on the M1. The socket is in the domain's out/,
  // which its proxies own and the root's user's group reads (root/proxy-user.sh): the host
  // daemon reaches it as that user, and no other domain's proxies can.
  try {
    fs.unlinkSync(socketArg);
  } catch {
    /* none left over */
  }
  createServer((client) => {
    client.on("error", () => client.destroy());
    // A client that does not finish asking in ten seconds holds nothing open.
    client.setTimeout(10_000, () => client.destroy());
    let head = "";
    const onData = (chunk: Buffer) => {
      head += chunk.toString("latin1");
      if (head.length > 8192) return client.destroy();
      if (!head.includes("\r\n\r\n")) return;
      client.off("data", onData);
      client.setTimeout(0);
      void handle(client, head);
    };
    client.on("data", onData);
  }).listen(socketArg, () => fs.chmodSync(socketArg, 0o660));
}
