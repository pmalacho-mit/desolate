// T1. The dev servers' slots on the tailnet (host/phone.ts serveSlots) send each request to the
// server its slot names, and nowhere else. The Mac's forwarder chooses a workspace by the first
// request on a connection, and every workspace's server on a port is behind the same
// 127.0.0.1:<port>: a proxy that reused a connection sent one workspace's requests, and its
// cookies, to another (found on real Tailscale, 2026-11-20). The forwarder here does the same.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { request } from "node:http";
import { connect, createServer as createTcp } from "node:net";
import type { AddressInfo, Server } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "desolate-slots-"));
process.env.DESOLATE_HOME = home;
process.env.DESOLATE_EDITOR_PORT = "31599";
const base = 42000 + Math.floor(Math.random() * 2000);
process.env.DESOLATE_PHONE_PORT = String(base);
const { serveSlots, servePhone, slotLocalPort, cookieTag, phonePort, domainBlock } =
  await import("../../../release/host/phone.ts");
const { paths } = await import("../../../release/host/paths.ts");

const NAME = "mac.tail1234.ts.net";
const LOGIN = "you@example.com";

// A forwarder like the Mac's: each connection is the workspace its first request names.
let forwarder: Server;
let port = 0;
before(async () => {
  fs.mkdirSync(paths.state, { recursive: true });
  fs.writeFileSync(
    path.join(paths.state, "phone.json"),
    JSON.stringify({ login: LOGIN, name: NAME, httpsPort: 8443, dev: "acme", block: 0 }),
  );
  forwarder = createTcp((socket) => {
    let chosen = "";
    let buffered = "";
    socket.on("data", (chunk) => {
      buffered += chunk.toString("latin1");
      for (let end = buffered.indexOf("\r\n\r\n"); end >= 0; end = buffered.indexOf("\r\n\r\n")) {
        const head = buffered.slice(0, end);
        buffered = buffered.slice(end + 4);
        const host = /^host:\s*(\S+)/im.exec(head)?.[1] ?? "";
        const cookie = /^cookie:\s*(.*)$/im.exec(head)?.[1] ?? "";
        chosen ||= host.split(":")[0]!;
        // An upgrade it will not switch: a 200, the connection kept (a dev server bent on a
        // raw tunnel through the slot). One it switches: a 101, then an echo.
        if (/^GET \/no-switch /.test(head)) {
          socket.write("HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: keep-alive\r\n\r\n");
          continue;
        }
        if (/^GET \/status000 /.test(head)) {
          socket.write("HTTP/1.1 000 X\r\nContent-Length: 0\r\n\r\n");
          continue;
        }
        if (/^GET \/headers /.test(head)) {
          socket.write(
            'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Type: text/plain\r\nAlt-Svc: h2=":8444"\r\nStrict-Transport-Security: max-age=1\r\nCache-Control: max-age=31536000, immutable\r\n\r\nok',
          );
          continue;
        }
        if (/^GET \/switch /.test(head)) {
          socket.write(
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSet-Cookie: sid=x\r\n\r\n",
          );
          socket.removeAllListeners("data");
          if (buffered) socket.write(buffered, "latin1");
          socket.on("data", (more) => socket.write(more));
          return;
        }
        const body = JSON.stringify({ workspace: chosen, host, cookie });
        socket.write(
          `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nClear-Site-Data: "cookies"\r\nConnection: keep-alive\r\n\r\n${body}`,
        );
      }
    });
  });
  await new Promise<void>((resolve) => forwarder.listen(0, "127.0.0.1", resolve));
  port = (forwarder.address() as AddressInfo).port;
  serveSlots(
    () => {},
    (slot) =>
      slot === 0
        ? { devHost: "acme-w1-aaaaaa.localhost", port }
        : slot === 1
          ? { devHost: "other-w2-bbbbbb.localhost", port }
          : null,
  );
  servePhone(() => {});
  await new Promise((resolve) => setTimeout(resolve, 200));
});
after(() => {
  forwarder.close();
  fs.rmSync(home, { recursive: true, force: true });
  setTimeout(() => process.exit(0), 50).unref();
});

const ask = (slot: number, cookie?: string) =>
  new Promise<{ workspace: string; host: string; cookie: string }>((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: slotLocalPort(slot),
        path: "/",
        headers: {
          host: `${NAME}:${9101 + slot}`,
          "tailscale-user-login": LOGIN,
          ...(cookie ? { cookie } : {}),
        },
      },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new Error(`slot ${slot} answered ${res.statusCode}: ${text}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });

/** A raw exchange with a local port: what was sent back within `ms`. */
const raw = (port: number, text: string, ms = 600) =>
  new Promise<string>((resolve) => {
    let got = "";
    const socket = connect(port, "127.0.0.1", () => socket.write(text));
    socket.on("data", (chunk) => (got += chunk.toString("latin1")));
    socket.on("error", () => resolve(got));
    socket.on("close", () => resolve(got));
    setTimeout(() => (socket.destroy(), resolve(got)), ms);
  });
const upgrade = (path: string) =>
  `GET ${path} HTTP/1.1\r\nHost: ${NAME}:9101\r\nTailscale-User-Login: ${LOGIN}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`;

describe("T1 the phone's dev-server slots", () => {
  it("a Referer that is not a URL is answered, and the phone's port goes on answering", async () => {
    const bad = `GET / HTTP/1.1\r\nHost: ${NAME}:8443\r\nTailscale-User-Login: ${LOGIN}\r\nReferer: ${NAME}/x\r\nConnection: close\r\n\r\n`;
    assert.match(await raw(phonePort(), bad), /^HTTP\/1\.1 \d{3} /);
    // The control: it is still there to answer the next one (it once took the daemon down).
    assert.match(await raw(phonePort(), bad), /^HTTP\/1\.1 \d{3} /);
  });

  it("a refused upgrade whose connection is then reset does not stop the slots", () => {
    // In a process of its own: the test runner absorbs an error no listener takes, and a
    // daemon does not (one reset after a refusal once stopped it). Twenty, as one can land
    // after the server has let go of its socket.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desolate-reset-"));
    fs.mkdirSync(path.join(dir, "state"));
    fs.writeFileSync(
      path.join(dir, "state", "phone.json"),
      JSON.stringify({ login: LOGIN, name: NAME, httpsPort: 8443, dev: "acme", block: 0 }),
    );
    const script = path.join(dir, "reset.mts");
    fs.writeFileSync(
      script,
      `const { serveSlots, slotLocalPort } = await import(${JSON.stringify(path.resolve(import.meta.dirname, "../../../release/host/phone.ts"))});
const { connect } = await import("node:net");
serveSlots(() => {}, () => ({ devHost: "a.localhost", port: 1 }));
await new Promise((r) => setTimeout(r, 300));
for (let i = 0; i < 20; i++) {
  const s = connect(slotLocalPort(0), "127.0.0.1", () => s.write("GET / HTTP/1.1\\r\\nHost: ${NAME}:9101\\r\\nConnection: Upgrade\\r\\nUpgrade: websocket\\r\\n\\r\\n"));
  s.on("data", () => s.resetAndDestroy());
  s.on("error", () => {});
}
setTimeout(() => { console.log("still answering"); process.exit(0); }, 1500);
`,
    );
    const ran = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", script], {
      encoding: "utf8",
      timeout: 20_000,
      env: { ...process.env, DESOLATE_HOME: dir, DESOLATE_PHONE_PORT: String(base + 100) },
    });
    fs.rmSync(dir, { recursive: true, force: true });
    assert.match(ran.stdout, /still answering/, ran.stderr.slice(0, 400));
  });

  it("an upgrade the server does not switch is refused, not tunnelled; one it switches is", async () => {
    const refused = await raw(slotLocalPort(0), upgrade("/no-switch"));
    assert.match(refused, /^HTTP\/1\.1 502 /);
    const switched = await raw(slotLocalPort(0), `${upgrade("/switch")}hello`);
    assert.match(switched, /^HTTP\/1\.1 101 /);
    assert.doesNotMatch(switched, /set-cookie/i);
    assert.match(switched, /hello$/);
  });

  it("a dev server's answer with a status of 000 is a 502, and the slots go on answering", async () => {
    const odd = await raw(
      slotLocalPort(0),
      `GET /status000 HTTP/1.1\r\nHost: ${NAME}:9101\r\nTailscale-User-Login: ${LOGIN}\r\nConnection: close\r\n\r\n`,
    );
    assert.match(odd, /^HTTP\/1\.1 502 /);
    assert.equal((await ask(0)).workspace, "acme-w1-aaaaaa.localhost");
  });

  it("only the headers a page needs pass, nothing is cached, and only the slot's own address", async () => {
    const page = await raw(
      slotLocalPort(0),
      `GET /headers HTTP/1.1\r\nHost: ${NAME}:9101\r\nTailscale-User-Login: ${LOGIN}\r\nConnection: close\r\n\r\n`,
    );
    assert.match(page, /^HTTP\/1\.1 200 /);
    assert.doesNotMatch(page, /alt-svc|strict-transport-security|immutable/i);
    assert.match(page, /cache-control: no-store/i);
    const elsewhere = await raw(
      slotLocalPort(0),
      `GET / HTTP/1.1\r\nHost: ${NAME}:9102\r\nTailscale-User-Login: ${LOGIN}\r\nConnection: close\r\n\r\n`,
    );
    assert.match(elsewhere, /^HTTP\/1\.1 421 /);
  });

  it("each domain its own block of addresses, kept", () => {
    const a = domainBlock("aaa");
    const b = domainBlock("bbb");
    assert.notEqual(a, b);
    assert.equal(domainBlock("aaa"), a);
  });

  it("no service workers, and a dev server's Clear-Site-Data never reaches the browser", async () => {
    const sw = await raw(
      slotLocalPort(0),
      `GET /sw.js HTTP/1.1\r\nHost: ${NAME}:9101\r\nTailscale-User-Login: ${LOGIN}\r\nService-Worker: script\r\nConnection: close\r\n\r\n`,
    );
    assert.match(sw, /^HTTP\/1\.1 403 /);
    const page = await raw(
      slotLocalPort(0),
      `GET / HTTP/1.1\r\nHost: ${NAME}:9101\r\nTailscale-User-Login: ${LOGIN}\r\nConnection: close\r\n\r\n`,
    );
    assert.match(page, /^HTTP\/1\.1 200 /);
    // The proxy's own, for storage and cache, the first time: never the server's "cookies".
    assert.doesNotMatch(page, /clear-site-data: "cookies"/i);
    assert.match(page, /clear-site-data: "cache", "storage"/i);
  });

  it("two workspaces on one port: each slot's requests reach its own, every time", async () => {
    for (let round = 0; round < 3; round++) {
      assert.equal((await ask(0)).workspace, "acme-w1-aaaaaa.localhost");
      assert.equal((await ask(1)).workspace, "other-w2-bbbbbb.localhost");
    }
  });

  it("a slot's cookies reach only its own server", async () => {
    const w1 = cookieTag("acme-w1-aaaaaa.localhost", port);
    const w2 = cookieTag("other-w2-bbbbbb.localhost", port);
    const jar = `${w1}__sid=w1-session; ${w2}__sid=w2-session`;
    await ask(0, jar);
    const second = await ask(1, jar);
    assert.equal(second.workspace, "other-w2-bbbbbb.localhost");
    assert.equal(second.cookie, "sid=w2-session");
  });
});
