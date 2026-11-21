// T2 (fake backend). Section 4.4: ports keep their numbers, nothing is declared, several
// workspaces share a number by name, and what has no name is reserved instead.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { bootstrap, git, newStack } from "../lib/harness.ts";
import type { Stack } from "../lib/harness.ts";

let stack: Stack;
let hostHolder: ChildProcess;
type Ports = {
  workspace: string;
  forwarded: { port: number; url: string }[];
  reserved: { port: number; why: string }[];
  notes: string[];
}[];
const ports = () => JSON.parse(stack.quiet("ports", "--json").stdout) as Ports;
const vms = new Map<string, string>();
const vmOf = (target: string) => {
  if (!vms.has(target)) {
    const list = JSON.parse(stack.quiet("list", "--json").stdout) as {
      domain: string;
      workspaces: { workspace: string; vm: string }[];
    }[];
    for (const d of list) for (const w of d.workspaces) vms.set(`${d.domain}/${w.workspace}`, w.vm);
  }
  return vms.get(target)!;
};
/** Start a server in a workspace, detached. */
const serve = (target: string, args: string, root = false) =>
  stack.inVm(
    vmOf(target),
    [
      "bash",
      "-c",
      `setsid nohup node /workspaces/serve.mjs ${args} >/tmp/serve-$$.log 2>&1 </dev/null & sleep 0.3`,
    ],
    { root },
  );
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (probe: () => boolean | Promise<boolean>, ms = 8000) => {
  for (const deadline = Date.now() + ms; Date.now() < deadline;) {
    if (await probe()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return probe();
};
/** One HTTP request to the host's loopback, naming `host`. */
const request = (port: number, host: string, extra = ""): Promise<string> =>
  new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    let data = "";
    socket.setTimeout(5000, () => socket.destroy());
    socket.on("connect", () =>
      socket.write(`GET / HTTP/1.1\r\nHost: ${host}\r\n${extra}Connection: close\r\n\r\n`),
    );
    socket.on("data", (chunk) => (data += chunk));
    socket.on("close", () => resolve(data));
    socket.on("error", () => resolve(data || "ERROR"));
  });
/** Does anything accept a TCP connection at this address? */
const accepts = (address: string, port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = net.connect({ host: address, port });
    socket.setTimeout(2000, () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
  });
const otherAddresses = () =>
  Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && a.family === "IPv4" && !a.internal)
    .map((a) => a!.address);
const hostOf = (url: string) => new URL(url).host;
const urlOf = (target: string, port: number) =>
  ports()
    .find((w) => w.workspace === target)
    ?.forwarded.find((f) => f.port === port)?.url;

describe("T2 section 4.4: ports, forwarded by name", () => {
  before(() => {
    stack = newStack("ports");
    stack.seed("acme/app", (dir) => {
      fs.writeFileSync(path.join(dir, "README.md"), "# app\n");
      git(dir, "add", "-A");
      git(dir, "commit", "--quiet", "-m", "seed");
    });
    assert.equal(bootstrap(stack).code, 0);
    assert.equal(stack.quiet("clone", "acme/app", "--no-domain").code, 0);
    assert.equal(stack.quiet("domain", "create", "web").code, 0);
    assert.equal(stack.quiet("domain", "web", "add", "--repo", "acme/app").code, 0);
    assert.equal(stack.quiet("up", "web", "--name", "one").code, 0);
    assert.equal(stack.quiet("up", "web", "--name", "two").code, 0);
    // A stand-in dev server: says which workspace it is, upgrades to a WebSocket-like echo
    // (HMR), can move to the next port when its own is taken (Vite without --strictPort),
    // and can be a nameless protocol whose server speaks first.
    fs.writeFileSync(
      path.join(stack.home, "domains/web/repos/serve.mjs"),
      `
import http from "node:http"; import net from "node:net";
const [, , name, portArg, mode] = process.argv; let port = Number(portArg);
if (mode === "raw") net.createServer((s) => { s.write("raw:" + name + "\\n"); s.on("data", (d) => s.write(d)); s.on("error", () => {}); }).listen(port, "0.0.0.0");
// A server on a raw port whose greeting is an HTTP response, sent in two pieces: a browser's
// preconnected socket would take it as the answer to its request.
else if (mode === "greets-http") net.createServer((s) => { s.on("error", () => {}); s.write("H"); setTimeout(() => s.write("TTP/1.1 200 OK\\r\\nContent-Type: text/html\\r\\nContent-Length: 13\\r\\n\\r\\n<b>owned</b>\\n"), 100); }).listen(port, "0.0.0.0");
else if (mode === "greets-icy") net.createServer((s) => { s.on("error", () => {}); s.write("  ICY 200 OK\\r\\nContent-Type: text/html\\r\\n\\r\\n<b>owned</b>\\n"); }).listen(port, "0.0.0.0");
else {
  const server = http.createServer((req, res) => res.end("workspace:" + name + " host:" + req.headers.host + "\\n"));
  server.on("upgrade", (req, socket) => { socket.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\n\\r\\nhmr:" + name); socket.on("data", (d) => socket.write(d)); });
  server.on("error", (e) => { if (e.code === "EADDRINUSE" && mode === "move") server.listen(++port, "0.0.0.0"); else process.exit(1); });
  server.listen(port, mode === "loopback" ? "127.0.0.1" : "0.0.0.0");
}
`,
    );
  });
  after(() => {
    hostHolder?.kill();
    stack.destroy();
  });

  it("a dev server started in a workspace appears at its URL, with nothing declared", async () => {
    stack.step("a dev server appears on its own");
    assert.deepEqual(
      ports().map((w) => w.forwarded.length),
      [0, 0],
      "nothing is forwarded before anything listens",
    );
    serve("web/one", "one 5173");
    assert.ok(
      await until(() => urlOf("web/one", 5173) !== undefined),
      "the port is published within seconds of the server starting",
    );
    const url = urlOf("web/one", 5173)!;
    assert.match(
      url,
      /^http:\/\/web-one-[0-9a-f]{6}\.localhost:5173$/,
      "the same number as inside, at the workspace's own hostname",
    );
    assert.match(await request(5173, hostOf(url)), /workspace:one/);
    const shown = stack.desolate("ports");
    assert.match(shown.stdout, /web\/one\n {2}http:\/\/web-one-[0-9a-f]{6}\.localhost:5173/);
    assert.match(shown.stdout, /web\/two\n {2}nothing is listening yet/);
  });

  it("two workspaces on the same port: one URL each, each reaching its own server; HMR's upgrade too", async () => {
    serve("web/two", "two 5173 loopback");
    assert.ok(await until(() => urlOf("web/two", 5173) !== undefined));
    const one = hostOf(urlOf("web/one", 5173)!);
    const two = hostOf(urlOf("web/two", 5173)!);
    assert.notEqual(one, two);
    assert.match(await request(5173, one), /workspace:one/);
    assert.match(
      await request(5173, two),
      /workspace:two/,
      "a server bound to 127.0.0.1 inside is reached too",
    );
    const upgrade = await new Promise<string>((resolve) => {
      const socket = net.connect(5173, "127.0.0.1");
      let data = "";
      socket.on("connect", () =>
        socket.write(
          `GET /hmr HTTP/1.1\r\nHost: ${two}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`,
        ),
      );
      socket.on("data", (chunk) => {
        data += chunk;
        if (data.includes("hmr:two") && !data.includes("ping")) socket.write("ping");
        if (data.includes("ping")) socket.destroy();
      });
      socket.on("close", () => resolve(data));
      setTimeout(() => socket.destroy(), 5000);
    });
    assert.match(upgrade, /101 Switching Protocols/);
    assert.match(upgrade, /hmr:two/);
    assert.match(upgrade, /ping/, "bytes flow both ways after the upgrade");
  });

  it("a request that names no workspace gets 421 and reaches nothing", async () => {
    stack.step("names that are not a workspace's");
    const good = hostOf(urlOf("web/one", 5173)!);
    assert.match(
      await request(5173, good),
      /200 OK[\s\S]*workspace:one/,
      "control: the right name is answered",
    );
    for (const name of [
      "127.0.0.1:5173",
      "localhost:5173",
      "evil.example:5173",
      "web-one-000000.localhost:5173",
      good.replace("web-one", "web-three"),
      "desolate.localhost:5173",
    ]) {
      const reply = await request(5173, name);
      assert.match(reply, /^HTTP\/1\.1 421 /, `Host: ${name} must be refused`);
      assert.doesNotMatch(reply, /workspace:/, `Host: ${name} must reach no server`);
    }
    // Two workspaces serve 5173: a bare localhost is told both, and sent to neither.
    const both = await request(5173, "localhost:5173");
    assert.match(
      both,
      /served by more than one workspace[\s\S]*web\/one {2}http:\/\/[\s\S]*web\/two {2}http:\/\//,
      both,
    );
    // No Host header at all.
    const bare = await new Promise<string>((resolve) => {
      const socket = net.connect(5173, "127.0.0.1");
      let data = "";
      socket.on("connect", () => socket.write("GET / HTTP/1.0\r\n\r\n"));
      socket.on("data", (chunk) => (data += chunk));
      socket.on("close", () => resolve(data));
    });
    assert.match(bare, /^HTTP\/1\.1 421 /);
    // The editor's hostname is another site: it never answers for a dev server.
    const editor = good.replace(/-([0-9a-f]{6})\.localhost/, "-editor-$1.localhost");
    assert.match(await request(5173, editor), /^HTTP\/1\.1 502 /);
  });

  it("the forwarder listens on 127.0.0.1 only, and never below port 1024", async () => {
    serve("web/one", "one 80", true);
    serve("web/one", "one 8080");
    assert.ok(
      await until(() => urlOf("web/one", 8080) !== undefined),
      "control: an unprivileged port from the same workspace is forwarded",
    );
    assert.equal(urlOf("web/one", 80), undefined, "port 80 is never offered");
    assert.ok(
      await accepts("127.0.0.1", 5173),
      "control: the forwarder's listener answers on loopback",
    );
    const others = otherAddresses();
    assert.ok(
      others.length > 0,
      "control: this machine has an address that is not loopback to try",
    );
    for (const address of others)
      for (const port of [5173, 8080])
        assert.equal(
          await accepts(address, port),
          false,
          `port ${port} answers on ${address}: it must be on loopback only`,
        );
    assert.equal(await accepts("127.0.0.1", 80), false, "nothing listens on the host's port 80");
    // ::1 too, where browsers look first for *.localhost: a forwarded port and the pages'.
    assert.ok(await accepts("::1", 5173), "a forwarded port is held on ::1 as well");
    assert.ok(
      await accepts("::1", Number(stack.env.DESOLATE_EDITOR_PORT)),
      "the dashboard's, the editors' and the approval page's port is held on ::1 as well",
    );
  });

  it("a protocol with no name reaches the first workspace that had the port; the others keep the number taken", async () => {
    stack.step("a raw TCP port");
    serve("web/one", "one 5432 raw");
    assert.ok(await until(() => urlOf("web/one", 5432) !== undefined));
    const raw = await new Promise<string>((resolve) => {
      const socket = net.connect(5432, "127.0.0.1");
      let data = "";
      socket.on("data", (chunk) => {
        data += chunk;
        if (data.includes("\n")) socket.destroy();
      });
      socket.on("close", () => resolve(data));
      setTimeout(() => socket.destroy(), 5000);
    });
    assert.equal(
      raw,
      "raw:one\n",
      "a client that says nothing first is carried to the port's one workspace",
    );
    assert.ok(
      await until(() =>
        ports()
          .find((w) => w.workspace === "web/two")!
          .reserved.some((r) => r.port === 5432),
      ),
      "the other workspace is asked to keep 5432 taken",
    );
    const bind = (port: number) =>
      stack.inVm(vmOf("web/two"), [
        "node",
        "-e",
        `require("net").createServer().on("error", (e) => { console.log(e.code); process.exit(1); }).listen(${port}, "0.0.0.0", () => process.exit(0))`,
      ]);
    const taken = bind(5432);
    assert.equal(taken.code, 1);
    assert.match(taken.stdout, /EADDRINUSE/, "a server in the other workspace finds 5432 taken");
    assert.equal(bind(5433).code, 0, "control: the next number is free there");
    assert.match(
      stack.desolate("ports", "web/two").stdout,
      /port 5432 is kept taken here: no name in its protocol, and one had it first/,
    );
    // An HTTP request on that raw port, too long to read whole, naming another workspace (a
    // page can make a browser send one, with that workspace's cookies): never the raw owner.
    const viaRaw = await new Promise<string>((resolve) => {
      const socket = net.connect(5432, "127.0.0.1");
      let data = "";
      socket.on("connect", () =>
        socket.write(
          `GET /${"x".repeat(17_000)} HTTP/1.1\r\nHost: ${hostOf(urlOf("web/two", 5173)!).replace(":5173", ":5432")}\r\n\r\n`,
        ),
      );
      socket.on("data", (chunk) => (data += chunk));
      socket.on("close", () => resolve(data));
      socket.on("error", () => resolve(data));
      setTimeout(() => socket.destroy(), 5000);
    });
    // (The raw server echoes what it is sent: its greeting may reach whoever connected, but
    // the request itself never reaches it.)
    assert.doesNotMatch(viaRaw, /GET \/x/, "the long request did not reach the raw port's owner");
    // A preconnected socket on that raw port (silent, so its server's greeting comes), then a
    // request naming another workspace: closed, never sent on (third review, 2026-11-16).
    const preconnected = await new Promise<string>((resolve) => {
      const socket = net.connect(5432, "127.0.0.1");
      let data = "";
      socket.on("connect", () =>
        setTimeout(
          () =>
            socket.write(
              `GET / HTTP/1.1\r\nHost: ${hostOf(urlOf("web/two", 5173)!).replace(":5173", ":5432")}\r\n\r\n`,
            ),
          1500,
        ),
      );
      socket.on("data", (chunk) => (data += chunk));
      socket.on("close", () => resolve(data));
      socket.on("error", () => resolve(data));
      setTimeout(() => socket.destroy(), 8000);
    });
    assert.doesNotMatch(
      preconnected,
      /GET \//,
      "the request on a preconnected socket did not reach the raw port's owner",
    );
    // A raw port's server whose greeting is an HTTP response: never sent to a client that has
    // said nothing yet (final review, 2026-11-16). The control is 5432's greeting, above.
    serve("web/one", "one 3306 greets-http");
    assert.ok(await until(() => urlOf("web/one", 3306) !== undefined));
    const greeted = await new Promise<string>((resolve) => {
      const socket = net.connect(3306, "127.0.0.1");
      let data = "";
      socket.on("data", (chunk) => (data += chunk));
      socket.on("close", () => resolve(data));
      socket.on("error", () => resolve(data));
      setTimeout(() => socket.destroy(), 3000);
    });
    assert.doesNotMatch(
      greeted,
      /200 OK|owned/,
      "a greeting shaped as an HTTP response was not sent on",
    );
    // And Firefox's other way of reading an answer: "ICY", after white space.
    serve("web/one", "one 11211 greets-icy");
    assert.ok(await until(() => urlOf("web/one", 11211) !== undefined));
    const icy = await new Promise<string>((resolve) => {
      const socket = net.connect(11211, "127.0.0.1");
      let data = "";
      socket.on("data", (chunk) => (data += chunk));
      socket.on("close", () => resolve(data));
      socket.on("error", () => resolve(data));
      setTimeout(() => socket.destroy(), 3000);
    });
    assert.doesNotMatch(icy, /ICY|owned/, "a greeting shaped as an ICY answer was not sent on");
    // A method no list knows, from a page (PURGE): routed by its name, and teaches nothing.
    serve("web/one", "one 5190");
    assert.ok(await until(() => urlOf("web/one", 5190) !== undefined));
    assert.match(
      await new Promise<string>((resolve) => {
        const socket = net.connect(5190, "127.0.0.1");
        let data = "";
        socket.on("connect", () =>
          socket.write(
            `PURGE / HTTP/1.1\r\nHost: ${hostOf(urlOf("web/one", 5190)!)}\r\nConnection: close\r\n\r\n`,
          ),
        );
        socket.on("data", (chunk) => (data += chunk));
        socket.on("close", () => resolve(data));
      }),
      /workspace:one/,
    );
    await sleep(2000);
    assert.ok(
      !ports()
        .find((w) => w.workspace === "web/two")!
        .reserved.some((r) => r.port === 5190),
      "5190 did not become raw",
    );
  });

  it("silence is not a protocol: a socket that waits before its request still reaches the workspace it names, and the port stays HTTP", async () => {
    // A browser preconnects: a socket opened now, its request sent on it a moment later. Both
    // workspaces serve 5173 here. (It once made 5173 'raw' for good: kept taken everywhere,
    // and the request went to the workspace that had the port first.)
    const two = hostOf(urlOf("web/two", 5173)!);
    const late = await new Promise<string>((resolve) => {
      const socket = net.connect(5173, "127.0.0.1");
      let data = "";
      socket.on("connect", () =>
        setTimeout(
          () => socket.write(`GET / HTTP/1.1\r\nHost: ${two}\r\nConnection: close\r\n\r\n`),
          1500,
        ),
      );
      socket.on("data", (chunk) => (data += chunk));
      socket.on("close", () => resolve(data));
      setTimeout(() => socket.destroy(), 10_000);
    });
    assert.match(late, /workspace:two/, late);
    // A probe that connects and closes without a word (`nc -z`, a health check).
    await new Promise<void>((resolve) =>
      net.connect(5173, "127.0.0.1").on("connect", function (this: net.Socket) {
        this.end();
        resolve();
      }),
    );
    await sleep(3000);
    for (const w of ["web/one", "web/two"])
      assert.ok(
        !ports()
          .find((p) => p.workspace === w)!
          .reserved.some((r) => r.port === 5173),
        `${w} is not asked to keep 5173 taken`,
      );
    assert.match(
      await request(5173, hostOf(urlOf("web/one", 5173)!)),
      /workspace:one/,
      "control: each name still reaches its own workspace",
    );
    // 8080: only web/one serves it. A silent socket, then a request naming web/two (with what
    // a browser would send web/two): never web/one's server (audit, 2026-11-16: it once was).
    const twoOn8080 = hostOf(urlOf("web/two", 5173)!).replace(":5173", ":8080");
    const misrouted = await new Promise<string>((resolve) => {
      const socket = net.connect(8080, "127.0.0.1");
      let data = "";
      socket.on("connect", () =>
        setTimeout(
          () =>
            socket.write(
              `GET / HTTP/1.1\r\nHost: ${twoOn8080}\r\nCookie: two-secret=1\r\nConnection: close\r\n\r\n`,
            ),
          1500,
        ),
      );
      socket.on("data", (chunk) => (data += chunk));
      socket.on("close", () => resolve(data));
      setTimeout(() => socket.destroy(), 10_000);
    });
    assert.doesNotMatch(misrouted, /workspace:one/, misrouted);
    assert.match(misrouted, /^HTTP\/1\.1 502 [\s\S]*nothing is listening on port 8080 in web\/two/);
    assert.match(
      await request(8080, hostOf(urlOf("web/one", 8080)!)),
      /workspace:one/,
      "control: web/one's own name reaches it",
    );
    // A request line too long to read whole: HTTP that names no one, refused; not a protocol
    // with no name, routed to the port's first workspace.
    const long = await new Promise<string>((resolve) => {
      const socket = net.connect(8080, "127.0.0.1");
      let data = "";
      socket.on("connect", () =>
        socket.write(`GET /${"x".repeat(20_000)} HTTP/1.1\r\nHost: ${twoOn8080}\r\n\r\n`),
      );
      socket.on("data", (chunk) => (data += chunk));
      socket.on("close", () => resolve(data));
      socket.on("error", () => resolve(data));
      setTimeout(() => socket.destroy(), 10_000);
    });
    assert.doesNotMatch(long, /workspace:one/, long.slice(0, 200));
    assert.ok(
      !ports()
        .find((w) => w.workspace === "web/two")!
        .reserved.some((r) => r.port === 8080),
      "and 8080 did not turn raw",
    );
  });

  it("a port the host itself holds is not published, and not taken from the workspaces: their servers use it inside", async () => {
    stack.step("a port a program on the host holds");
    hostHolder = spawn(
      process.execPath,
      [
        "-e",
        `require("http").createServer((q, s) => s.end("the-host-program")).listen(5180, "127.0.0.1")`,
      ],
      { stdio: "ignore" },
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    serve("web/one", "one 5180");
    assert.ok(
      await until(() =>
        ports()
          .find((w) => w.workspace === "web/one")!
          .reserved.some((r) => r.port === 5180 && /not forwarded/.test(r.why)),
      ),
      "the workspace's 5180 is reported as not forwarded",
    );
    assert.match(
      await request(5180, hostOf(urlOf("web/one", 5173)!).replace(":5173", ":5180")),
      /the-host-program/,
      "the host's own program still answers on its port: nothing was taken from it",
    );
    // The other workspace is not made to keep 5180 taken (it once was: an API meant only for
    // its own workspace could then not have the port at all): its server takes 5180, and
    // answers inside the workspace.
    await sleep(3000);
    assert.ok(
      !ports()
        .find((w) => w.workspace === "web/two")!
        .reserved.some((r) => r.port === 5180 && /kept taken/.test(r.why)),
      "web/two is not asked to keep 5180 taken",
    );
    serve("web/two", "two 5180");
    assert.ok(
      await until(() =>
        ports()
          .find((w) => w.workspace === "web/two")!
          .reserved.some((r) => r.port === 5180 && /not forwarded/.test(r.why)),
      ),
      "its server has 5180, reported as not forwarded",
    );
    const inside = stack.inVm(vmOf("web/two"), [
      "bash",
      "-c",
      "curl -s -m 5 http://127.0.0.1:5180/",
    ]);
    assert.match(inside.stdout, /workspace:two/, "and answers inside its workspace");
    // Held on ::1 only (another user's program, on a shared Mac): not forwarded either, since
    // a browser would go there first.
    const v6Holder = spawn(
      process.execPath,
      [
        "-e",
        `require("net").createServer((s) => s.end("v6")).listen({ port: 5183, host: "::1", ipv6Only: true })`,
      ],
      { stdio: "ignore" },
    );
    try {
      await sleep(500);
      serve("web/one", "one 5183");
      assert.ok(
        await until(
          () =>
            ports()
              .find((w) => w.workspace === "web/one")!
              .reserved.some((r) => r.port === 5183 && /not forwarded/.test(r.why)),
          20_000,
        ),
        "a port held on ::1 is reported as not forwarded",
      );
      assert.equal(urlOf("web/one", 5183), undefined);
    } finally {
      v6Holder.kill();
    }
  });

  it("another program on [::1] of the pages' port: their tokens are retired, and the dashboard and the editors are not served on them again", async () => {
    stack.step("the pages' port held on ::1");
    const pagesPort = Number(stack.env.DESOLATE_EDITOR_PORT);
    const hostAt = (url: string) => new URL(url).host;
    const dashboard = hostAt(stack.quiet("ui").stdout.match(/http:\/\/\S+/)![0]);
    const editorBefore = JSON.parse(stack.quiet("editor", "web/one", "--json").stdout) as {
      url: string;
    };
    // Control: both served now.
    assert.doesNotMatch(await request(pagesPort, dashboard), /^HTTP\/1\.1 503 /);
    assert.doesNotMatch(await request(pagesPort, hostAt(editorBefore.url)), /^HTTP\/1\.1 503 /);
    // The daemon goes (a reboot, an upgrade), and another program takes [::1] of its port.
    const pidFile = path.join(stack.home, "state/daemon.pid");
    process.kill(Number(fs.readFileSync(pidFile, "utf8")));
    assert.ok(
      await until(async () => !(await accepts("127.0.0.1", pagesPort))),
      "the daemon is gone",
    );
    const squatter = spawn(
      process.execPath,
      [
        "-e",
        `require("net").createServer((s) => s.end("squatter")).listen({ port: ${pagesPort}, host: "::1", ipv6Only: true })`,
      ],
      { stdio: "ignore" },
    );
    try {
      await sleep(500);
      const refused = stack.quiet("ui");
      assert.notEqual(refused.code, 0, "no address with a token is printed");
      assert.ok(
        fs.existsSync(path.join(stack.home, "state/tokens-retired")),
        "the tokens are retired",
      );
      for (const name of ["approve-token", "git-token", "ui-token"])
        assert.ok(!fs.existsSync(path.join(stack.home, "state", name)), `${name} is gone`);
    } finally {
      squatter.kill();
    }
    // The program goes, and a daemon comes back (before any bootstrap): the dashboard and the
    // editor are not served on their old tokens, which the root and the VM still take.
    process.kill(Number(fs.readFileSync(pidFile, "utf8")));
    await sleep(1000);
    assert.equal(stack.quiet("ports").code, 0);
    assert.ok(await until(() => accepts("127.0.0.1", pagesPort)));
    assert.match(
      await request(pagesPort, dashboard),
      /^HTTP\/1\.1 503 [\s\S]*the dashboard's token was retired/,
    );
    // (Once the new daemon has the workspace again: before, its name is no one's, a 421.)
    let editorReply = "";
    assert.ok(
      await until(
        async () =>
          !/^HTTP\/1\.1 421 /.test(
            (editorReply = await request(pagesPort, hostAt(editorBefore.url))),
          ),
        30_000,
      ),
      "the new daemon has the workspace",
    );
    assert.match(editorReply, /^HTTP\/1\.1 503 [\s\S]*this editor's token was retired/);
    // bootstrap makes them again: both are served, the editor on a new token.
    assert.equal(bootstrap(stack).code, 0);
    const editorAfter = JSON.parse(stack.quiet("editor", "web/one", "--json").stdout) as {
      url: string;
    };
    assert.notEqual(
      new URL(editorAfter.url).searchParams.get("tkn"),
      new URL(editorBefore.url).searchParams.get("tkn"),
      "the editor's token was made again",
    );
    assert.ok(
      await until(
        async () => !/^HTTP\/1\.1 503 /.test(await request(pagesPort, hostAt(editorAfter.url))),
        20_000,
      ),
      "the editor is served again",
    );
    assert.doesNotMatch(
      await request(pagesPort, dashboard),
      /^HTTP\/1\.1 503 /,
      "and the dashboard",
    );
    assert.equal(stack.quiet("ui").code, 0);
  });

  it("past the host's 256 listeners of a workspace, the rest are not forwarded, and that is said", async () => {
    stack.step("more listeners than are forwarded");
    // 300 listeners in one workspace: the host forwards 256 of a workspace's at most (a VM
    // may not have this Mac listen on every port), and says how many more it left out.
    const many = stack.inVm(vmOf("web/one"), [
      "bash",
      "-c",
      `setsid nohup node -e 'const net = require("node:net"); for (let p = 21000; p < 21300; p++) net.createServer((s) => s.end("many:" + p + "\\n")).listen(p, "0.0.0.0"); setInterval(() => {}, 1e6)' >/tmp/many.log 2>&1 </dev/null & echo $!`,
    ]);
    const pid = many.stdout.trim();
    assert.match(pid, /^\d+$/, many.stderr);
    const past = () =>
      ports()
        .find((w) => w.workspace === "web/one")
        ?.notes.map((note) =>
          /^(\d+) more listeners are not forwarded: past the first 256 of a workspace$/.exec(note),
        )
        .find(Boolean)?.[1];
    assert.ok(await until(() => past() !== undefined, 20_000), JSON.stringify(ports()));
    const one = ports().find((w) => w.workspace === "web/one")!;
    // (What it took of the workspace's: not the rows that say a port below 1024 is left out,
    // which the workspace's own report adds since limits 08.)
    const forwarded = one.forwarded.length + one.reserved.filter((r) => r.port >= 1024).length;
    assert.ok(forwarded <= 256, `at most 256 taken: ${forwarded}`);
    assert.ok(Number(past()) >= 300 - 256, `the rest counted: ${past()}`);
    assert.deepEqual(
      ports().find((w) => w.workspace === "web/two")?.notes,
      [],
      "control: the other workspace left nothing out",
    );
    // Gone again: nothing is said, and the workspace's own server is still forwarded.
    stack.inVm(vmOf("web/one"), ["kill", pid]);
    assert.ok(await until(() => past() === undefined, 20_000), JSON.stringify(ports()));
    assert.match(await request(5173, hostOf(urlOf("web/one", 5173)!)), /workspace:one/);
  });

  it("stopping a workspace takes its ports down", async () => {
    stack.step("stop");
    assert.equal(stack.desolate("stop", "web/two").code, 0);
    assert.ok(await until(() => !ports().some((w) => w.workspace === "web/two")));
    const reply = await request(5173, "web-two-000000.localhost:5173");
    assert.match(reply, /^HTTP\/1\.1 421 /);
    assert.match(
      await request(5173, hostOf(urlOf("web/one", 5173)!)),
      /workspace:one/,
      "the other workspace's server is untouched",
    );
    // One workspace serves 5173 now: a bare localhost (a dev server's own "Local:" link,
    // clicked) is sent there, at its own name, path kept; it is not served there.
    const sent = await request(5173, "localhost:5173");
    assert.match(sent, /^HTTP\/1\.1 307 /, sent.slice(0, 200));
    assert.match(
      sent,
      new RegExp(
        `\\r\\nLocation: ${urlOf("web/one", 5173)!.replace(/\/$/, "").replace(/[.]/g, "\\.")}/\\r\\n`,
      ),
    );
    assert.doesNotMatch(sent, /workspace:/, "a redirect, never the server's page");
    assert.match(await request(5173, "127.0.0.1:5173"), /^HTTP\/1\.1 307 /);
    assert.match(
      await request(5173, "evil.example:5173"),
      /^HTTP\/1\.1 421 /,
      "CONTROL: a name that is not bare localhost still reaches nothing",
    );
  });

  it("destroy leaves no listener behind", async () => {
    assert.ok(
      await accepts("127.0.0.1", 5173),
      "control: a forwarded port is listening before destroy",
    );
    assert.equal(stack.desolate("destroy", "--all").code, 0);
    for (const port of [5173, 8080, 5432, 5181])
      assert.equal(
        await accepts("127.0.0.1", port),
        false,
        `port ${port} is still listening after destroy`,
      );
    assert.equal(fs.existsSync(stack.home), false);
  });

  it("the transcript reads as reviewed", () => {
    stack.checkTranscript("t2-03-ports");
  });
});
