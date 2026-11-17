// A domain's secrets (section 4.3, Phase 4): where they are kept, and the one process that
// can use them.
//
// A secret's VALUE lives here, in the root, in a file only the root's user reads. A
// workspace holds the secret's NAME, a placeholder it sends in place of the value. The
// domain's secrets proxy (mitmproxy with secrets_addon.py, one per domain that has any)
// swaps name for value on the way out, for the hosts the secret names and no others.
// Workspaces reach it only through their own proxy (proxy.ts), and only for those hosts;
// everything else they send stays end-to-end TLS.
//
// What a workspace is given, in its inbox (which it cannot write): the names, hosts and
// headers of its domain's secrets (never a value), and the CA its secrets proxy signs with,
// which it must trust for those hosts to work.
import * as fs from "node:fs";
import { createServer } from "node:net";
import * as path from "node:path";
import { refuse } from "../../shared/exit.ts";
import { readJson, writeJson } from "../../shared/json.ts";
import { ROOT } from "../layout.ts";
import { inbox } from "../outbox.ts";
import { indexFile, storeFile } from "./secret-store.ts";
import type { Indexed } from "./secret-store.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Given, Invoke } from "../../../.suede/nests/dsl.import.meta.vitest.ts";
import type { aDomain, emptyRoot, jsonListIn, linkIn, pathIn, readIn, writeIn, writeJsonIn } from "../../../tests/nests/root-state.harness.ts";
import { alive, ensureLinkToken, hasProxyUser, linkTokenFile, listenerUid, PROXY_CODE, proxyDomainDir, proxyOutDir, proxyUid, spawnAsProxy, stopProxy } from "./as-proxy.ts";

const DIR = `${ROOT.state}/proxy`;
const MITMDUMP = "/opt/desolate/proxy-venv/bin/mitmdump";
type Store = { domain: string; secrets: Record<string, Omit<Indexed, "name">> };
export type Running = { port: number; pid: number; hosts: string[] };

// The values are root's (secret-store.ts); this user reads the index: names, hosts,
// headers, switches.
/** Where its secrets proxy listens, for its workspaces' proxies. */
export const runningFile = (domain: string) => path.join(proxyDomainDir(domain), "secrets-proxy.json");
/** The domain's CA and mitmproxy's own state: the domain's proxies' (as-proxy.ts). Made by
 *  mitmproxy, as that user, in the directory root made for it. */
const confdir = (domain: string) => path.join(proxyOutDir(domain), "ca");
const store = (domain: string): Store => ({ domain, secrets: Object.fromEntries(readJson<Indexed[]>(indexFile(domain), []).filter((s) => s && typeof s.name === "string").map(({ name, ...rest }) => [name, rest])) });

const free = (port: number) =>
  new Promise<boolean>((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });

/** What the domain's workspaces may know: names, hosts, headers. Never a value. */
export const list = (domain: string) =>
  Object.entries(store(domain).secrets).map(([name, s]) => {
    const now = Date.now() / 1000;
    const on = s.off !== true && (s.until === undefined || now < s.until);
    return { name, hosts: s.hosts, headers: s.headers ?? null, on, ...(on && s.until !== undefined ? { secondsLeft: Math.max(0, Math.round(s.until - now)) } : {}) };
  }).sort((a, b) => a.name.localeCompare(b.name));

declare namespace list {
  type Fresh = Invoke<typeof emptyRoot>;
  /** what workspaces may know of a secret, from root's index (there is no value in it to
   *  leak): its name, its hosts, its headers, and whether it is on now */
  export type Names = Given<
    [Fresh, Invoke<typeof writeJsonIn, [where: "proxies", name: "secrets/acme.index.json", value: [
      { name: "MYAPP-OPENAI-KEY"; hosts: ["api.openai.com"]; headers: ["authorization"] },
      { name: "MYAPP-OFF-SECRET"; hosts: ["x.example.com"]; off: true },
      { name: "MYAPP-EXPIRED-KEY"; hosts: ["x.example.com"]; until: 1577836800 },
      { name: "MYAPP-TIMED-KEY"; hosts: ["x.example.com"]; until: 4102444800 },
    ]]>],
    Expect<Invoke<typeof list, [domain: "acme"]>, "matches", [
      { name: "MYAPP-EXPIRED-KEY"; on: false },
      { name: "MYAPP-OFF-SECRET"; headers: null; on: false },
      { name: "MYAPP-OPENAI-KEY"; hosts: ["api.openai.com"]; headers: ["authorization"]; on: true },
      { name: "MYAPP-TIMED-KEY"; on: true },
    ]>
  >;
  /** none, or no index yet: none */
  export type None = Given<Fresh, Expect<Invoke<typeof list, [domain: "acme"]>, "=", []>>;
}

declare namespace publish {
  type Fresh = Invoke<typeof emptyRoot>;
  type Acme = Invoke<typeof aDomain, [slug: "acme", repos: []]>;
  type Index = Invoke<typeof writeJsonIn, [where: "proxies", name: "secrets/acme.index.json", value: [{ name: "MYAPP-OPENAI-KEY"; hosts: ["api.openai.com"]; off: true }]]>;
  /** into the domain's inbox: its secrets' names and switches as stored, and the CA its
   *  workspaces must trust for those hosts */
  export type Inbox = Given<
    [Fresh, Acme, Index, Invoke<typeof writeIn, [where: "proxies", name: "out/acme/ca/mitmproxy-ca-cert.pem", text: "-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUQ0FfZXhhbXBsZQ==\n-----END CERTIFICATE-----\n"]>, Invoke<typeof publish, [domain: "acme"]>],
    [
      Expect<Invoke<typeof jsonListIn, [where: "domains", name: "acme/inbox/secrets.json"]>, "=", [{ name: "MYAPP-OPENAI-KEY"; hosts: ["api.openai.com"]; headers: null; off: true }]>,
      Expect<Invoke<typeof readIn, [where: "domains", name: "acme/inbox/ca.pem"]>, "=", "-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUQ0FfZXhhbXBsZQ==\n-----END CERTIFICATE-----\n">,
    ]
  >;
  /** the CA is the proxies' user's file: one that is a link (to a file of the root's, say), or
   *  is not a certificate, is not handed to the workspaces */
  export type NotACertificate = [
    Given<
      [Fresh, Acme, Index, Invoke<typeof writeIn, [where: "state", name: "registry.json", text: "-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUQ0FfZXhhbXBsZQ==\n-----END CERTIFICATE-----\n"]>, Invoke<typeof linkIn, [where: "proxies", name: "out/acme/ca/mitmproxy-ca-cert.pem", target: Invoke<typeof pathIn, [where: "state", name: "registry.json"]>]>, Invoke<typeof publish, [domain: "acme"]>],
      Expect<Invoke<typeof readIn, [where: "domains", name: "acme/inbox/ca.pem"]>, "=", null>
    >,
    Given<
      [Fresh, Acme, Index, Invoke<typeof writeIn, [where: "proxies", name: "out/acme/ca/mitmproxy-ca-cert.pem", text: "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n"]>, Invoke<typeof publish, [domain: "acme"]>],
      Expect<Invoke<typeof readIn, [where: "domains", name: "acme/inbox/ca.pem"]>, "=", null>
    >,
  ];
}

const publish = (domain: string) => {
  // For the workspaces: the switch as stored (`off`, `until`), not "on right now", which
  // would go stale in a file when a time to live ran out.
  writeJson(path.join(inbox(domain), "secrets.json"), Object.entries(store(domain).secrets).map(([name, s]) => ({ name, hosts: s.hosts, headers: s.headers ?? null, ...(s.off ? { off: true } : {}), ...(s.until !== undefined ? { until: s.until } : {}) })).sort((a, b) => a.name.localeCompare(b.name)));
  // The certificate is the proxies' user's file, put where every workspace of the domain
  // reads it: taken only if it is a plain, small file (not a link that user planted to a
  // file of the root's).
  const ca = path.join(confdir(domain), "mitmproxy-ca-cert.pem");
  try {
    const fd = fs.openSync(ca, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      if (stat.isFile() && stat.size < 64 * 1024) {
        const pem = fs.readFileSync(fd, "utf8");
        if (/^-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\n]+-----END CERTIFICATE-----\n?$/.test(pem)) writeText(path.join(inbox(domain), "ca.pem"), pem);
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* no CA yet */
  }
};
const writeText = (file: string, text: string) => {
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, text, { mode: 0o644 });
  fs.renameSync(temp, file);
};

/** The domain's secrets proxy: running if the domain has a secret, stopped if it has none. */
export const ensure = async (domain: string): Promise<Running | null> => {
  const hosts = [...new Set(Object.values(store(domain).secrets).flatMap((s) => s.hosts))].sort();
  const existing = readJson<Running | null>(runningFile(domain), null);
  if (hosts.length === 0) {
    if (existing && alive(existing.pid) && !(await free(existing.port))) stopProxy(domain, existing.pid);
    fs.rmSync(runningFile(domain), { force: true });
    publish(domain);
    return null;
  }
  // Alive means listening: a process that was killed can linger as a pid (unreaped) and
  // answer nothing.
  if (existing && alive(existing.pid) && !(await free(existing.port)) && listenerUid(existing.port) === proxyUid(domain)) {
    // The addon reloads the store by itself; the hosts are what proxy.ts routes by.
    if (existing.hosts.join() !== hosts.join()) writeJson(runningFile(domain), { ...existing, hosts }, 0o640);
    publish(domain);
    return { ...existing, hosts };
  }
  if (!fs.existsSync(MITMDUMP)) refuse("this image has no mitmproxy, so secrets cannot be substituted", "rebuild the base image (release/image/build.sh)");
  if (!hasProxyUser(domain)) refuse(`the domain ${domain} has no proxies' user yet`, "desolate bootstrap (the host makes it: root/proxy-user.sh)");
  ensureLinkToken(domain);
  let port = 0;
  for (let candidate = 22000; candidate < 23000 && port === 0; candidate++) if (await free(candidate)) port = candidate;
  if (port === 0) throw new Error("no free port for a secrets proxy in the root");
  // Its output, as the root's user saw it start (its audit log is its own, in out/<domain>).
  fs.mkdirSync(path.join(DIR, "logs"), { recursive: true, mode: 0o700 });
  const log = fs.openSync(path.join(DIR, "logs", `secrets-${domain}.log`), "a");
  const child = spawnAsProxy(domain, MITMDUMP, [
    "--mode", "regular", "--listen-host", "127.0.0.1", "--listen-port", String(port),
    "--set", `confdir=${confdir(domain)}`,
    // Upstream certificates are checked against this VM's own trust store.
    "--set", "ssl_verify_upstream_trusted_ca=/etc/ssl/certs/ca-certificates.crt",
    "--set", "flow_detail=0", "--set", "termlog_verbosity=warn",
    "-s", path.join(PROXY_CODE, "root", "proxy", "secrets_addon.py"),
  ], { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: confdir(domain), DESOLATE_SECRETS: storeFile(domain), DESOLATE_POLICY: path.join(proxyDomainDir(domain), "policy.json"), DESOLATE_AUDIT: path.join(proxyOutDir(domain), "audit.log"), DESOLATE_LINK_TOKEN: linkTokenFile(domain) }, log);
  fs.closeSync(log);
  const ca = path.join(confdir(domain), "mitmproxy-ca-cert.pem");
  for (let waited = 0; waited < 180_000 && ((await free(port)) || !fs.existsSync(ca)); waited += 100) await new Promise((resolve) => setTimeout(resolve, 100));
  if ((await free(port)) || !fs.existsSync(ca)) throw new Error(`the secrets proxy for ${domain} did not start; see ${DIR}/logs/secrets-${domain}.log`);
  // What listens there must be what was started: the domain's proxies' user.
  if (listenerUid(port) !== proxyUid(domain)) {
    stopProxy(domain, child.pid!);
    throw new Error(`the port chosen for ${domain}'s secrets proxy (${port}) was taken by another user first; nothing was recorded. Try again`);
  }
  const running = { port, pid: child.pid!, hosts };
  writeJson(runningFile(domain), running, 0o640);
  publish(domain);
  return running;
};

declare namespace ensure {
  type Fresh = Invoke<typeof emptyRoot>;
  /** a domain with no secret has no secrets proxy: what was recorded as running is gone, and
   *  its workspaces are told there are none. (One with secrets starts mitmproxy as the
   *  domain's proxies' user: T2's 07-secrets.) */
  export type NoneNoProxy = Given<
    [Fresh, Invoke<typeof aDomain, [slug: "acme", repos: []]>, Invoke<typeof writeJsonIn, [where: "proxies", name: "domains/acme/secrets-proxy.json", value: { port: 1; pid: 999999; hosts: [] }]>],
    [
      Expect<Invoke<typeof ensure, [domain: "acme"]>, "=", null>,
      Expect<Invoke<typeof readIn, [where: "proxies", name: "domains/acme/secrets-proxy.json"]>, "=", null>,
      Expect<Invoke<typeof jsonListIn, [where: "domains", name: "acme/inbox/secrets.json"]>, "=", []>,
    ]
  >;
}

/** After root changed the domain's secrets (proxy/secret-store.ts, by the host): its
 *  secrets proxy running if it has any, its workspaces told the names. Values are not this
 *  user's to see, and are not seen here. */
export const apply = async (domain: string) => {
  await ensure(domain);
  return list(domain);
};
