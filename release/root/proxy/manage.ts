// Starting and stopping each workspace's proxy, and a domain's network rules.
import * as fs from "node:fs";
import { connect } from "node:net";
import * as path from "node:path";
import { refuse } from "../../shared/exit.ts";
import { readJson, writeJson } from "../../shared/json.ts";
import { listed, PAGE } from "../../shared/listed.ts";
import type { Listed } from "../../shared/listed.ts";
import { isSlug } from "../../shared/names.ts";
import { normalizeName } from "../../shared/sniff.ts";
import { printable } from "../../shared/text.ts";
import { ROOT } from "../layout.ts";
import {
  alive,
  hasProxyUser,
  PROXY_CODE,
  proxyDomainDir,
  proxyOutDir,
  spawnAsProxy,
  stopProxy,
  VM_NAME,
} from "./as-proxy.ts";
import { auditDir, auditDomains, auditEnv, auditLines } from "./audit.ts";
import { hostAllowed } from "./proxy.ts";
import { HELD_MIB } from "./secrets.ts";
import type { Policy } from "./proxy.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Given, Invoke, Throws } from "../../../suede.nests/dsl.import.meta.vitest.ts";
import type { refusalOf } from "../../.harness/refusal.ts";
import type { emptyRoot, makeDirIn, readJsonIn, writeIn } from "../../.harness/root-state.ts";

const DIR = `${ROOT.state}/proxy`;
type Running = { socket: string; pid: number; domain: string; workspace: string };
const notMade = (domain: string) =>
  refuse(
    `the domain ${domain} has no proxies' user yet`,
    "desolate bootstrap (the host makes it: root/proxy-user.sh)",
  );
const file = (vm: string) => path.join(DIR, "running", `${vm}.json`);

/** Can the root's user connect to it yet? (It is the proxy's socket only once it answers.) */
const answers = (socket: string) =>
  new Promise<boolean>((resolve) => {
    const probe = connect(socket);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });

export const start = async (
  vm: string,
  domain: string,
  workspace: string,
): Promise<{ socket: string }> => {
  if (!VM_NAME.test(vm)) throw new Error("not a VM name");
  const existing = readJson<Running | null>(file(vm), null);
  if (existing && alive(existing.pid) && typeof existing.socket === "string")
    return { socket: existing.socket };
  if (!hasProxyUser(domain)) notMade(domain);
  fs.mkdirSync(path.join(DIR, "running"), { recursive: true });
  const socket = path.join(proxyOutDir(domain), `${vm}.sock`);
  const log = fs.openSync(path.join(DIR, "proxy.log"), "a");
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    ...auditEnv(),
  };
  for (const key of ["DESOLATE_ROOT_STATE", "DESOLATE_ROOT_DOMAINS", "DESOLATE_ROOT_SYS"])
    if (process.env[key]) env[key] = process.env[key]!;
  const child = spawnAsProxy(
    domain,
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      path.join(PROXY_CODE, "root", "proxy", "proxy.ts"),
      socket,
      domain,
      workspace,
    ],
    env,
    log,
  );
  fs.closeSync(log);
  for (let waited = 0; !(await answers(socket)) && waited < 5000; waited += 50)
    await new Promise((resolve) => setTimeout(resolve, 50));
  writeJson(file(vm), { socket, pid: child.pid, domain, workspace });
  return { socket };
};

declare namespace start {
  /** a VM's name becomes the proxy's socket's: nothing else is one */
  export type NotAVm = [
    Throws<
      Invoke<typeof start, [vm: "../../etc", domain: "acme", workspace: "w1"]>,
      "not a VM name"
    >,
    Throws<Invoke<typeof start, [vm: "dsl-T-1", domain: "acme", workspace: "w1"]>, "not a VM name">,
  ];
}

export const stop = (vm: string) => {
  const existing = readJson<Running | null>(file(vm), null);
  if (existing && alive(existing.pid)) stopProxy(existing.domain, existing.pid);
  fs.rmSync(file(vm), { force: true });
};

const policyFile = (domain: string) => path.join(proxyDomainDir(domain), "policy.json");
export const policy = (domain: string): Policy => ({
  mode: "open",
  hosts: [],
  internal: [],
  ...readJson<Partial<Policy>>(policyFile(domain), {}),
});

export const setPolicy = (
  domain: string,
  change: {
    mode?: unknown;
    allow?: unknown;
    deny?: unknown;
    internal?: unknown;
    held?: unknown;
  },
): Policy => {
  const next = policy(domain);
  if (change.mode !== undefined) {
    if (change.mode !== "open" && change.mode !== "enforce")
      refuse(
        "a domain's network is 'open' or 'enforce'",
        `desolate domain ${domain} net enforce | open`,
      );
    next.mode = change.mode;
  }
  const hosts = (value: unknown) =>
    (Array.isArray(value) ? value : []).map((host) => {
      const text = String(host);
      const name = normalizeName(text.startsWith("*.") ? text.slice(2) : text);
      if (!name || text.includes(":"))
        refuse(
          `'${text}' is not a hostname or a *.wildcard`,
          "for example: api.example.com or *.example.com",
        );
      return text.startsWith("*.") ? `*.${name}` : name!;
    });
  next.hosts = [...new Set([...next.hosts, ...hosts(change.allow)])]
    .filter((host) => !hosts(change.deny).includes(host))
    .sort();
  for (const address of Array.isArray(change.internal) ? change.internal : []) {
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(String(address)))
      refuse(
        `'${String(address)}' is not an IPv4 address`,
        "name the one internal address this domain may reach",
      );
    if (!next.internal.includes(String(address))) next.internal.push(String(address));
  }
  if (change.held === "default") delete next.heldMiB;
  else if (change.held !== undefined) {
    const held = HELD_MIB.parse(String(change.held));
    if (held === null)
      refuse(
        `'${printable(change.held, 80)}' is not ${HELD_MIB.parse.takes}`,
        `desolate domain ${domain} net hold 512m | default`,
      );
    next.heldMiB = held!;
  }
  // Readable by the proxies' user, through the directory's group (root/start.sh).
  writeJson(policyFile(domain), next, 0o640);
  return next;
};

declare namespace setPolicy {
  type Fresh = Invoke<typeof emptyRoot>;
  // The domain's directory, as root/proxy-user.sh makes it.
  type Dir = Invoke<typeof makeDirIn, [where: "proxies", name: "domains/acme"]>;
  /** open until enforced; then the hosts allowed (lowercased, without a trailing dot, sorted),
   *  less those denied; an internal address the person names; kept where the proxies read it */
  export type Rules = Given<
    [Fresh, Dir],
    [
      Expect<
        Invoke<typeof policy, [domain: "acme"]>,
        "=",
        { mode: "open"; hosts: []; internal: [] }
      >,
      Expect<
        Invoke<
          typeof setPolicy,
          [
            domain: "acme",
            change: { mode: "enforce"; allow: ["Registry.npmjs.org.", "*.GitHub.com", "pypi.org"] },
          ]
        >,
        "=",
        { mode: "enforce"; hosts: ["*.github.com", "pypi.org", "registry.npmjs.org"]; internal: [] }
      >,
      Expect<
        Invoke<
          typeof setPolicy,
          [domain: "acme", change: { deny: ["pypi.org"]; internal: ["10.0.0.5"] }]
        >,
        "=",
        { mode: "enforce"; hosts: ["*.github.com", "registry.npmjs.org"]; internal: ["10.0.0.5"] }
      >,
      Expect<
        Invoke<typeof readJsonIn, [where: "proxies", name: "domains/acme/policy.json"]>,
        "matches",
        { mode: "enforce"; internal: ["10.0.0.5"] }
      >,
    ]
  >;
  /** the domain's own bound on a body its secrets proxy holds whole, as a size; and back to
   *  the stack's */
  export type Held = Given<
    [Fresh, Dir],
    [
      Expect<
        Invoke<typeof setPolicy, [domain: "acme", change: { held: "1g" }]>,
        "matches",
        { heldMiB: 1024 }
      >,
      Expect<
        Invoke<
          typeof refusalOf,
          [f: typeof setPolicy, args: [domain: "acme", change: { held: "lots" }]]
        >,
        "=",
        {
          message: "'lots' is not a size from 1 to 2048 MiB (as 4096, 4096m or 4g)";
          fix: "desolate domain acme net hold 512m | default";
          code: 1;
        }
      >,
      Expect<
        Invoke<typeof setPolicy, [domain: "acme", change: { held: "default" }]>,
        "=",
        { mode: "open"; hosts: []; internal: [] }
      >,
    ]
  >;
  /** a mode that is not one, a host with a port, a name that is not one, an internal address
   *  that is not one IPv4 address: refused, and nothing is written */
  export type Refuses = Given<
    [Fresh, Dir],
    [
      Expect<
        Invoke<
          typeof refusalOf,
          [f: typeof setPolicy, args: [domain: "acme", change: { mode: "closed" }]]
        >,
        "=",
        {
          message: "a domain's network is 'open' or 'enforce'";
          fix: "desolate domain acme net enforce | open";
          code: 1;
        }
      >,
      Expect<
        Invoke<
          typeof refusalOf,
          [f: typeof setPolicy, args: [domain: "acme", change: { allow: ["api.example.com:8443"] }]]
        >,
        "=",
        {
          message: "'api.example.com:8443' is not a hostname or a *.wildcard";
          fix: "for example: api.example.com or *.example.com";
          code: 1;
        }
      >,
      Expect<
        Invoke<
          typeof refusalOf,
          [f: typeof setPolicy, args: [domain: "acme", change: { allow: ["*"] }]]
        >,
        "matches",
        { message: "'*' is not a hostname or a *.wildcard" }
      >,
      Expect<
        Invoke<
          typeof refusalOf,
          [f: typeof setPolicy, args: [domain: "acme", change: { internal: ["10.0.0.0/8"] }]]
        >,
        "=",
        {
          message: "'10.0.0.0/8' is not an IPv4 address";
          fix: "name the one internal address this domain may reach";
          code: 1;
        }
      >,
      Expect<
        Invoke<typeof readJsonIn, [where: "proxies", name: "domains/acme/policy.json"]>,
        "=",
        null
      >,
    ]
  >;
}

/** What the domain has been reaching, against its allowlist: v2's `proxy recommend`. With
 *  the network open, this is the list to allow before enforcing; enforced, it is what was
 *  refused for not being on the list. Only names: nothing here is acted on. Every line the
 *  domain's log keeps is counted, read as a stream; each list is whole, with its count, and
 *  the host shows a page of it (R2). */
export const recommend = async (domain: string) => {
  const rules = policy(domain);
  const reached = new Map<string, number>();
  const refused = new Map<string, number>();
  for await (const entry of auditLines(auditDir(domainOf(domain)))) {
    if (entry.domain !== domain) continue;
    const host = typeof entry.host === "string" ? normalizeName(entry.host) : null;
    if (!host || hostAllowed(host, rules.hosts)) continue;
    if (entry.verdict === "allowed") reached.set(host, (reached.get(host) ?? 0) + 1);
    else if (entry.verdict === "refused" && /allowlist/.test(String(entry.reason ?? "")))
      refused.set(host, (refused.get(host) ?? 0) + 1);
  }
  const rank = (map: Map<string, number>): Listed<{ host: string; count: number }> => {
    const all = [...map]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([host, count]) => ({ host, count }));
    return listed(all, 0, all.length);
  };
  return { mode: rules.mode, listed: rules.hosts, reached: rank(reached), refused: rank(refused) };
};

/** A domain the host named: a slug, or nothing is read (it becomes a path). */
const domainOf = (domain: string) => {
  if (!isSlug(domain))
    refuse(`'${printable(domain, 80)}' is not a domain's name`, "desolate domain list");
  return domain;
};

/** What a domain's proxies audited (each domain's log is its proxies' own, in
 *  proxy-out/<domain>): every domain's, or one's, the last `last` of them (oldest first),
 *  and how many the log keeps. Read as a stream: what is held is the `last` asked for. A
 *  line that is not JSON, or names another domain than the log it is in, is not believed. */
export const auditLog = async (filter: {
  domain?: string;
  last?: number;
}): Promise<Listed<Record<string, unknown>>> => {
  const last = Math.max(0, Math.floor(Number(filter.last ?? PAGE) || 0));
  const domains = filter.domain === undefined ? auditDomains() : [domainOf(filter.domain)];
  let total = 0;
  let kept: Record<string, unknown>[] = [];
  for (const domain of domains) {
    // The last `last` of the domain's, in a ring: the oldest kept is at `seen % last`.
    const ring: Record<string, unknown>[] = [];
    let seen = 0;
    for await (const entry of auditLines(auditDir(domain))) {
      if (entry.domain !== domain) continue;
      total++;
      if (last > 0) ring[seen++ % last] = entry;
    }
    const mine = seen > last ? [...ring.slice(seen % last), ...ring.slice(0, seen % last)] : ring;
    kept = [...kept, ...mine]
      .sort((a, b) => String(a.time).localeCompare(String(b.time)))
      .slice(Math.max(0, kept.length + mine.length - last));
  }
  return { items: kept, total, from: total - kept.length };
};

declare namespace auditLog {
  type Fresh = Invoke<typeof emptyRoot>;
  /** a domain's proxies' own log, oldest first: a line that is not JSON, or that names another
   *  domain than the log it is in (a domain's proxies write their own log), is not believed */
  export type Believed = Given<
    [
      Fresh,
      Invoke<
        typeof writeIn,
        [
          where: "proxies",
          name: "out/acme/audit.log",
          text: '{"time":"2026-11-16T12:00:02Z","domain":"acme","host":"b.example","verdict":"allowed"}\nnot json\n{"time":"2026-11-16T12:00:01Z","domain":"beta","host":"forged.example","verdict":"allowed"}\n{"time":"2026-11-16T12:00:00Z","domain":"acme","host":"a.example","verdict":"refused"}\n',
        ]
      >,
    ],
    Expect<
      Invoke<typeof auditLog, [filter: { domain: "acme" }]>,
      "matches",
      { items: [{ host: "a.example" }, { host: "b.example" }]; total: 2; from: 0 }
    >
  >;
  /** the last of them, from every file the log keeps (the ones from before the series
   *  first), and how many it keeps: the count is of every line, not of the page */
  export type Last = Given<
    [
      Fresh,
      Invoke<
        typeof writeIn,
        [
          where: "proxies",
          name: "out/acme/audit.log.1",
          text: '{"time":"1","domain":"acme","host":"a.example"}\n{"time":"2","domain":"acme","host":"b.example"}\n',
        ]
      >,
      Invoke<
        typeof writeIn,
        [
          where: "proxies",
          name: "out/acme/audit-1.log",
          text: '{"time":"3","domain":"acme","host":"c.example"}\n{"time":"4","domain":"acme","host":"d.example"}',
        ]
      >,
    ],
    [
      Expect<
        Invoke<typeof auditLog, [filter: { domain: "acme"; last: 3 }]>,
        "matches",
        {
          items: [{ host: "b.example" }, { host: "c.example" }, { host: "d.example" }];
          total: 4;
          from: 1;
        }
      >,
      Expect<
        Invoke<typeof auditLog, [filter: { last: 1 }]>,
        "matches",
        { items: [{ host: "d.example" }]; total: 4; from: 3 }
      >,
    ]
  >;
  /** a domain that is not a name is not a path either */
  export type NotADomain = Given<
    Fresh,
    Expect<
      Invoke<typeof refusalOf, [f: typeof auditLog, args: [filter: { domain: "../acme" }]]>,
      "matches",
      { message: "'../acme' is not a domain's name" }
    >
  >;
}

declare namespace recommend {
  type Fresh = Invoke<typeof emptyRoot>;
  /** what the domain reached that its allowlist does not name, most first, and what was
   *  refused for not being on it: the list to read before enforcing */
  export type Reached = Given<
    [
      Fresh,
      Invoke<
        typeof writeIn,
        [
          where: "proxies",
          name: "domains/acme/policy.json",
          text: '{"mode":"enforce","hosts":["*.npmjs.org"]}',
        ]
      >,
      Invoke<
        typeof writeIn,
        [
          where: "proxies",
          name: "out/acme/audit.log",
          text: '{"time":"1","domain":"acme","host":"pypi.org","verdict":"allowed"}\n{"time":"2","domain":"acme","host":"pypi.org","verdict":"allowed"}\n{"time":"3","domain":"acme","host":"github.com","verdict":"allowed"}\n{"time":"4","domain":"acme","host":"registry.npmjs.org","verdict":"allowed"}\n{"time":"5","domain":"acme","host":"evil.example","verdict":"refused","reason":"evil.example is not on the domain acme\'s allowlist"}\n{"time":"6","domain":"acme","host":"1.2.3.4","verdict":"refused","reason":"a destination is a hostname"}\n',
        ]
      >,
    ],
    Expect<
      Invoke<typeof recommend, [domain: "acme"]>,
      "=",
      {
        mode: "enforce";
        listed: ["*.npmjs.org"];
        reached: {
          items: [{ host: "pypi.org"; count: 2 }, { host: "github.com"; count: 1 }];
          total: 2;
          from: 0;
        };
        refused: { items: [{ host: "evil.example"; count: 1 }]; total: 1; from: 0 };
      }
    >
  >;
}
