// T1. The dev servers' slots on the tailnet (host/phone.ts serveSlots) send each request to the
// server its slot names, and nowhere else. The Mac's forwarder chooses a workspace by the first
// request on a connection, and every workspace's server on a port is behind the same
// 127.0.0.1:<port>: a proxy that reused a connection sent one workspace's requests, and its
// cookies, to another (found on real Tailscale, 2026-11-20). The forwarder here does the same.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { request } from "node:http";
import { createServer as createTcp } from "node:net";
import type { AddressInfo, Server } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "desolate-slots-"));
process.env.DESOLATE_HOME = home;
process.env.DESOLATE_EDITOR_PORT = "31599";
const base = 42000 + Math.floor(Math.random() * 2000);
process.env.DESOLATE_PHONE_PORT = String(base);
const { serveSlots, slotLocalPort, cookieTag } = await import("../../../release/host/phone.ts");
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
    JSON.stringify({ login: LOGIN, name: NAME, httpsPort: 8443 }),
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
        const body = JSON.stringify({ workspace: chosen, host, cookie });
        socket.write(
          `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: keep-alive\r\n\r\n${body}`,
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

describe("T1 the phone's dev-server slots", () => {
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
