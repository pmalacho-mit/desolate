// T2 (fake backend). Section 4.8: the root UI. A state service in the root VM holds the
// stack's state and pushes changes; the dashboard draws from it; actions go to the host
// through a fixed list; a push from the dashboard still waits for the person on the host.
// The budgets are the spec's: state shown <= 300 ms after opening, a workspace's status
// change <= 1 s later, a click acknowledged <= 100 ms later.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { bootstrap, git, newStack, REPO_ROOT } from "../lib/harness.ts";
import type { Stack } from "../lib/harness.ts";
import { findChrome, loadPage } from "../lib/browser.ts";

let stack: Stack;
let port = 0;
let commit = "";
const HOST = "desolate.localhost";
/** The dashboard's address from `desolate ui`, and the cookie a browser gets for it. */
let token = "";
let cookie = "";
/** The page key (shared/page-key.ts) the dashboard's page keeps and sends beside the cookie. */
let key = "";
type Answer = { status: number; headers: string; body: string; ms: number };
/** One request to the host's loopback, as a browser at the dashboard would send it. */
const http = (
  method: string,
  pathAndQuery: string,
  options: {
    host?: string;
    headers?: string[];
    body?: unknown;
    cookie?: string | null;
    key?: string | null;
    /** How long the socket is open and silent before the request goes on it, as a
     *  browser's preconnected socket is. */
    silentMs?: number;
  } = {},
): Promise<Answer> =>
  new Promise((resolve) => {
    const started = performance.now();
    const socket = net.connect(port, "127.0.0.1");
    const payload = options.body === undefined ? "" : JSON.stringify(options.body);
    let data = "";
    socket.setTimeout(20_000, () => socket.destroy());
    socket.on("connect", () =>
      setTimeout(
        () =>
          socket.write(
            [
              `${method} ${pathAndQuery} HTTP/1.1`,
              `Host: ${options.host ?? HOST}:${port}`,
              ...((options.cookie === undefined ? cookie : options.cookie)
                ? [`Cookie: ${options.cookie ?? cookie}`]
                : []),
              // The page's key goes with the page's own cookie, as its script sends it.
              ...((
                options.key === undefined ? (options.cookie === undefined ? key : "") : options.key
              )
                ? [`X-Desolate-Key: ${options.key ?? key}`]
                : []),
              ...(options.headers ?? []),
              ...(payload
                ? [
                    "Content-Type: application/json",
                    `Content-Length: ${Buffer.byteLength(payload)}`,
                  ]
                : []),
              "Connection: close",
              "",
              payload,
            ].join("\r\n"),
          ),
        options.silentMs ?? 0,
      ),
    );
    // `ms` is when the whole answer had arrived (its Content-Length), as a browser sees
    // it: the connection itself may be closed a moment later by whatever carries it.
    let ms = 0;
    socket.on("data", (chunk) => {
      data += chunk;
      const split = data.indexOf("\r\n\r\n");
      const length = Number(/\r\ncontent-length: (\d+)/i.exec(data.slice(0, split))?.[1] ?? -1);
      if (
        ms === 0 &&
        split >= 0 &&
        length >= 0 &&
        Buffer.byteLength(data.slice(split + 4)) >= length
      )
        ms = performance.now() - started;
    });
    socket.on("close", () => {
      const split = data.indexOf("\r\n\r\n");
      resolve({
        status: Number(/^HTTP\/1\.1 (\d+)/.exec(data)?.[1] ?? 0),
        headers: data.slice(0, split),
        body: data.slice(split + 4),
        ms: ms || performance.now() - started,
      });
    });
    socket.on("error", () =>
      resolve({ status: 0, headers: "", body: data, ms: performance.now() - started }),
    );
  });
type State = {
  stack: { backend: string; isolated: boolean } | null;
  hostConnected: boolean;
  repos: { repo: string }[];
  offers: { repo: string; branch: string; commit: string }[];
  approvals: { repo: string; branch: string; commit: string }[];
  domains: {
    slug: string;
    workspaces: {
      workspace: string;
      says: { status: { color: string; message: string } | null };
      host: { status: string; editor?: string; devcontainer?: string } | null;
    }[];
  }[];
  actions: { id: string; kind: string; command: string; state: string; lines: string[] }[];
};
const state = async () => JSON.parse((await http("GET", "/state")).body) as State;
const ws = (s: State, target: string) =>
  s.domains
    .find((d) => d.slug === target.split("/")[0])
    ?.workspaces.find((w) => w.workspace === target.split("/")[1]);
const action = (kind: string, args: Record<string, string>) =>
  http("POST", "/action", {
    headers: ["X-Desolate-UI: 1", "Sec-Fetch-Site: same-origin", `Origin: http://${HOST}:${port}`],
    body: { kind, args },
  });
const until = async (probe: () => Promise<boolean>, ms = 30_000) => {
  for (const deadline = Date.now() + ms; Date.now() < deadline;) {
    if (await probe()) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return probe();
};
/** The event stream: resolves with the first pushed state that satisfies `wanted`, and when. */
const pushed = (
  wanted: (s: State) => boolean,
  ms = 15_000,
): Promise<{ at: number; state: State } | null> =>
  new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(null);
    }, ms);
    socket.on("connect", () =>
      socket.write(
        // As an EventSource asks, which sends no header: the page's key in the address.
        `GET /events?key=${key} HTTP/1.1\r\nHost: ${HOST}:${port}\r\nCookie: ${cookie}\r\nAccept: text/event-stream\r\n\r\n`,
      ),
    );
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (const match of buffer.matchAll(/data: (\{.*\})\n\n/g)) {
        const s = JSON.parse(match[1]!) as State;
        if (wanted(s)) {
          clearTimeout(timer);
          socket.destroy();
          return resolve({ at: performance.now(), state: s });
        }
      }
      buffer = buffer.slice(buffer.lastIndexOf("\n\n") + 2);
    });
    socket.on("error", () => resolve(null));
  });

describe("T2 section 4.8: the root UI", () => {
  before(() => {
    stack = newStack("ui");
    stack.seed("acme/app", (dir) => {
      fs.writeFileSync(path.join(dir, "README.md"), "# app\n");
      git(dir, "add", "-A");
      git(dir, "commit", "--quiet", "-m", "seed");
    });
    const booted = bootstrap(stack);
    assert.equal(booted.code, 0);
    assert.match(
      booted.stdout,
      /^ {2}dashboard {4}http:\/\/desolate\.localhost:\d+\/\?tkn=[0-9a-f]{48} {3}\(and: desolate ui\)$/m,
    );
    const address = new URL(
      (JSON.parse(stack.quiet("ui", "--json").stdout) as { dashboard: string }).dashboard,
    );
    port = Number(address.port);
    token = address.searchParams.get("tkn") ?? "";
    // What the browser is given in exchange for the address (checked in a test below).
    // Both from the token, one way (shared/page-key.ts): the cookie is not the token.
    const derived = (purpose: string) =>
      createHmac("sha256", Buffer.from(token, "hex")).update(purpose).digest("hex");
    cookie = `desolate_ui_${createHash("sha256").update(token).digest("hex").slice(0, 12)}=${derived("desolate page cookie")}`;
    key = derived("desolate page key");
  });
  after(() => stack.destroy());

  it("first run: the dashboard is there before anything else is, and walks through setting up", async () => {
    stack.step("an empty stack");
    const page = await http("GET", "/");
    assert.equal(page.status, 200);
    assert.match(
      page.headers,
      /content-security-policy: default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'/i,
      "its own code only: no inline script, no remote resource",
    );
    assert.doesNotMatch(
      page.body,
      /<script(?![^>]* src="\/(page-key|ui|highlight|markdown)\.js")|\son[a-z]+="|https?:\/\//i,
      "no inline script, handler or remote address in the page: its own four scripts",
    );
    for (const file of ["/ui.js", "/ui.css"])
      assert.equal((await http("GET", file)).status, 200, file);
    const empty = await state();
    assert.deepEqual([empty.repos, empty.domains, empty.offers], [[], [], []]);
    assert.ok(
      await until(async () => (await state()).hostConnected),
      "the host's daemon has told the state service about the host",
    );
    assert.deepEqual((await state()).stack, {
      instance: stack.instance,
      backend: "fake",
      isolated: false,
      editorPort: port,
      approver: "terminal",
      rootHostname: "desolate.localhost",
      gitHostname: "desolate-git.localhost",
      approveHostname: "desolate-approve.localhost",
      mac: { cpus: os.cpus().length, memoryMiB: Math.floor(os.totalmem() / 1048576) },
    });
    // The first-run steps, done from the dashboard; each records the command it ran.
    assert.equal(stack.quiet("clone", "acme/app", "--no-domain").code, 0);
    assert.equal(
      (await action("domain.create", { domain: "web", title: "the web app" })).status,
      202,
    );
    assert.ok(await until(async () => (await state()).domains.some((d) => d.slug === "web")));
    assert.equal((await action("domain.add", { domain: "web", repo: "acme/app" })).status, 202);
    assert.ok(
      await until(
        async () => (await state()).actions.filter((a) => a.state === "done").length === 2,
      ),
    );
    const up = await action("workspace.up", { domain: "web", workspace: "one" });
    assert.equal(up.status, 202);
    assert.equal(
      (JSON.parse(up.body) as { command: string }).command,
      "desolate up web --name one",
      "the dashboard shows the command the host runs",
    );
    assert.ok(
      await until(
        async () =>
          ws(await state(), "web/one")?.host?.status === "running" &&
          (await state()).actions.at(-1)?.state === "done",
        120_000,
      ),
    );
    const done = (await state()).actions.at(-1)!;
    assert.ok(
      done.lines.some((line) => /^progress: VM booted \([\d.]+ s\)$/.test(line)),
      `a start shows its phases as they end: ${done.lines.join(" | ")}`,
    );
    const one = ws(await state(), "web/one")!;
    assert.match(
      one.host!.editor ?? "",
      /^http:\/\/web-one-editor-[0-9a-f]+\.localhost:\d+\/\?tkn=[0-9a-f]{48}&folder=/,
      "the editor's address is known: one click, no token to copy",
    );
    assert.equal(one.host!.devcontainer, "none");
  });

  it("only the browser the dashboard was opened in gets in: not another program on this machine", async () => {
    stack.step("the dashboard's credential");
    // Another program here (another user of the Mac, a sandboxed app) can send any Host and
    // no Origin. Without the cookie it gets nothing: not the state with its editor tokens,
    // not the stream, not a diff, not a button.
    for (const [method, target] of [
      ["GET", "/"],
      ["GET", "/state"],
      ["GET", "/events"],
      ["GET", "/ui.js"],
      ["GET", "/diff?domain=web&repo=acme%2Fapp&branch=x"],
      ["POST", "/action"],
    ] as const) {
      const refused = await http(method, target, {
        cookie: null,
        headers: [
          "X-Desolate-UI: 1",
          "Sec-Fetch-Site: same-origin",
          `Origin: http://${HOST}:${port}`,
        ],
        body: method === "POST" ? { kind: "repo.fetch", args: { repo: "acme/app" } } : undefined,
      });
      assert.equal(refused.status, 401, `${method} ${target} without the cookie`);
      assert.doesNotMatch(refused.body, /tkn=|"domains"/, "and nothing of the state");
    }
    assert.equal(
      (await http("GET", "/state", { cookie: cookie.replace(/=.*/, `=${"0".repeat(48)}`) })).status,
      401,
      "a cookie with another value",
    );
    assert.equal(
      (await http("GET", `/?tkn=${"0".repeat(48)}`, { cookie: null })).status,
      403,
      "an address with another token",
    );
    // The address `desolate ui` prints is exchanged for a cookie the page cannot read, sent
    // to this name only and never on a request another site starts, and it leaves the bar.
    // And a page of this origin's own, which keeps the page's key and goes on to the page.
    const opened = await http("GET", `/?tkn=${token}&once`, { cookie: null });
    assert.equal(opened.status, 200);
    assert.match(
      opened.headers,
      new RegExp(`\\r\\nset-cookie: ${cookie}; HttpOnly; SameSite=Strict; Path=/\\r\\n`, "i"),
    );
    assert.match(opened.body, new RegExp(`<meta name="desolate-key" content="${key}">`));
    assert.match(opened.body, /<meta name="desolate-next" content="\/\?once">/);
    // The cookie alone (what a program on another port of this name is sent): the page and
    // its scripts, which hold nothing, and nothing else.
    assert.equal((await http("GET", "/", { key: null })).status, 200, "the page, by the cookie");
    for (const target of ["/state", "/events", "/diff?domain=web&repo=acme%2Fapp&branch=x"])
      assert.equal(
        (await http("GET", target, { key: null })).status,
        401,
        `${target}, the cookie alone`,
      );
    // Control: with both, the state is there.
    assert.equal((await http("GET", "/state")).status, 200);
  });

  it("one sign-in link: the approval page, the git terminal, then the dashboard, each a code spent once", async () => {
    stack.step("one sign-in link for all three pages");
    const link = new URL(stack.quiet("ui", "--link").stdout.trim());
    assert.equal(link.hostname, "desolate-approve.localhost", "it starts on the host's own page");
    const navigate = (site: string) => [
      `Sec-Fetch-Site: ${site}`,
      "Sec-Fetch-Mode: navigate",
      "Sec-Fetch-Dest: document",
    ];
    const hop = async (url: URL, site: string) => {
      const answer = await http("GET", `${url.pathname}${url.search}`, {
        host: url.hostname,
        cookie: null,
        headers: navigate(site),
      });
      // Where a sign-in sends the browser on: its page's (shared/page-key.ts).
      const location = /<meta name="desolate-next" content="([^"]+)">/.exec(answer.body)?.[1];
      return { answer, next: location ? new URL(location, `http://${url.host}`) : undefined };
    };
    // Another site cannot start the chain (the command opens it, as no site's).
    assert.equal((await hop(link, "cross-site")).answer.status, 403, "the first link, from a site");
    const approve = await hop(link, "none");
    assert.equal(approve.answer.status, 200);
    assert.match(
      approve.answer.headers,
      /\r\nset-cookie: desolate_approve_[0-9a-f]{12}=[0-9a-f]{64}; HttpOnly; SameSite=Strict; Path=\/\r\n/i,
    );
    assert.equal(approve.next?.hostname, "desolate-git.localhost");
    const git = await hop(approve.next!, "cross-site");
    assert.equal(git.answer.status, 200);
    assert.match(
      git.answer.headers,
      /\r\nset-cookie: desolate_git_[0-9a-f]{12}=[0-9a-f]{64}; HttpOnly; SameSite=Strict; Path=\/\r\n/i,
    );
    assert.equal(git.next?.hostname, HOST);
    // The dashboard's: the cookie, and a page that keeps its key and goes on to the dashboard.
    const dashboard = await hop(git.next!, "cross-site");
    assert.equal(dashboard.answer.status, 200);
    assert.match(
      dashboard.answer.headers,
      new RegExp(`\\r\\nset-cookie: ${cookie}; HttpOnly; SameSite=Strict; Path=/\\r\\n`, "i"),
    );
    assert.match(dashboard.answer.body, new RegExp(`<meta name="desolate-key" content="${key}">`));
    assert.match(dashboard.answer.body, /<meta name="desolate-next" content="\/">/);
    // Each link once: the same three again get nothing.
    for (const [url, site] of [
      [link, "none"],
      [approve.next!, "cross-site"],
      [git.next!, "cross-site"],
    ] as const) {
      const again = await hop(url, site);
      assert.equal(again.answer.status, 403, `${url.hostname} a second time`);
      assert.match(again.answer.body, /spent or too old/);
    }
    // The dashboard takes only its own link from another site, and nothing else with it.
    const code = git.next!.searchParams.get("signin");
    assert.equal(
      (
        await http("GET", `/?signin=${code}&tkn=${token}`, {
          cookie: null,
          headers: navigate("cross-site"),
        })
      ).status,
      403,
      "a token beside a code, from another site",
    );
  });

  it("only the dashboard's own page may talk to it, and only the host's daemon to the host's side", async () => {
    stack.step("who may talk to the state service");
    assert.equal((await http("GET", "/state", { host: "127.0.0.1" })).status, 421);
    assert.equal(
      (await http("GET", "/state", { host: "web-one-editor-000000.localhost" })).status,
      421,
    );
    assert.equal(
      (await http("GET", "/state", { headers: ["Sec-Fetch-Site: cross-site"] })).status,
      403,
    );
    assert.equal(
      (await http("GET", "/events", { headers: ["Origin: http://evil.example"] })).status,
      403,
    );
    // A page elsewhere cannot press a button: no header, no JSON, another origin.
    assert.equal(
      (
        await http("POST", "/action", {
          body: { kind: "workspace.stop", args: { domain: "web", workspace: "one" } },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await http("POST", "/action", {
          headers: ["X-Desolate-UI: 1", "Sec-Fetch-Site: same-site"],
          body: { kind: "workspace.stop", args: { domain: "web", workspace: "one" } },
        })
      ).status,
      403,
    );
    // The host's side takes the host's token, which no browser has.
    for (const [method, target] of [
      ["GET", "/host/requests"],
      ["PUT", "/host/facts"],
      ["POST", "/host/progress"],
    ] as const)
      assert.equal((await http(method, target, { body: {} })).status, 403, target);
    assert.equal(
      (
        await http("PUT", "/host/facts", {
          headers: [`Authorization: Bearer ${"0".repeat(48)}`],
          body: { stack: { isolated: true } },
        })
      ).status,
      403,
    );
    // Only what is on the list, with arguments that are names.
    for (const [kind, args] of [
      ["workspace.rm", { domain: "web", workspace: "one" }],
      ["workspace.stop", { domain: "../etc", workspace: "one" }],
      ["workspace.up", { domain: "web", workspace: "--fetch" }],
      ["repo.fetch", { repo: "--upload-pack=x" }],
      ["domain.create", { domain: "ok", title: "--help" }],
      ["constructor", {}],
    ] as [string, Record<string, string>][]) {
      const refused = await action(kind, args);
      // An option-like title is never passed on, and the domain is not made without it in
      // silence (it was, until limits 04): refused, saying what a title may be.
      if (kind === "domain.create")
        assert.match(refused.body, /that title is not one the dashboard takes/);
      assert.equal(refused.status, 400, `${kind} ${JSON.stringify(args)}`);
    }
    assert.equal(
      ws(await state(), "web/one")?.host?.status,
      "running",
      "control: nothing above stopped it",
    );
    assert.equal((await state()).stack?.isolated, false, "nor changed what the host said");
  });

  it("a browser's socket that is silent a while before its request is served, on every page of the port", async () => {
    // Chrome opens sockets ahead of the requests it expects, and sends one on it later. The
    // pages' port closed a socket silent for 400 ms, and the page it was opened for failed.
    const now = await http("GET", "/state");
    assert.equal(now.status, 200, "control: the same request, sent at once, is answered");
    const later = await http("GET", "/state", { silentMs: 1500 });
    assert.equal(later.status, 200, later.body);
    assert.deepEqual(JSON.parse(later.body).stack, JSON.parse(now.body).stack);
    // The approval page and the git terminal are on the same port, behind the same wait:
    // without their cookies they refuse, but they answer (a closed socket is status 0).
    for (const host of ["desolate-approve.localhost", "desolate-git.localhost"]) {
      const answer = await http("GET", "/", { host, cookie: null, key: null, silentMs: 1500 });
      assert.notEqual(answer.status, 0, `${host}: answered, not closed`);
    }
  });

  it("budgets: state at once, a status change within a second, a click acknowledged within 100 ms", async () => {
    stack.step("the budgets");
    // Opening: the page, its script, its style and the first pushed state, as a browser asks for them.
    const opens: number[] = [];
    for (let i = 0; i < 3; i++) {
      const started = performance.now();
      const [page, script, style, first] = await Promise.all([
        http("GET", "/"),
        http("GET", "/ui.js"),
        http("GET", "/ui.css"),
        pushed(() => true),
      ]);
      opens.push(Math.max(page.ms, script.ms, style.ms, first!.at - started));
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    assert.ok(
      Math.min(...opens) <= 300,
      `the dashboard has current state ${Math.round(Math.min(...opens))} ms after it opens (budget 300)`,
    );
    // A workspace says something: the dashboard is told, it does not ask.
    const waiting = pushed(
      (s) =>
        ws(s, "web/one")?.says.status?.message ===
        "need: a decision about <b>the API</b> <script>alert(1)</script>",
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    const child = spawn(
      path.join(REPO_ROOT, "release", "cli.sh"),
      [
        "exec",
        "web/one",
        "--",
        "/desolate/status",
        "set",
        "orange",
        "need: a decision about <b>the API</b> <script>alert(1)</script>",
      ],
      { env: stack.env, stdio: "ignore" },
    );
    const exited = await new Promise<number>((resolve) =>
      child.on("close", () => resolve(performance.now())),
    );
    const told = await waiting;
    assert.ok(told, "the change was pushed");
    assert.ok(
      told!.at - exited <= 1000,
      `pushed ${Math.round(told!.at - exited)} ms after the command that set it returned (budget 1000)`,
    );
    assert.equal(ws(told!.state, "web/one")!.says.status!.color, "orange");
    // A click: acknowledged with the command it will run, before anything has run.
    const clicks: number[] = [];
    for (let i = 0; i < 3; i++) clicks.push((await action("repo.fetch", { repo: "acme/app" })).ms);
    assert.ok(
      Math.min(...clicks) <= 100,
      `a click is acknowledged in ${Math.round(Math.min(...clicks))} ms (budget 100)`,
    );
    assert.ok(
      await until(
        async () =>
          (await state()).actions.filter((a) => a.kind === "repo.fetch" && a.state === "done")
            .length === 3,
      ),
    );
  });

  // The dashboard in a real browser. `?once` draws the current state and leaves no stream
  // open, so the browser finishes.
  const browser = (query: string, until?: RegExp, settle = 0, screenshot?: string) => {
    const chrome = findChrome();
    assert.ok(
      chrome,
      "this check needs Chrome or Chromium: install one, or set DESOLATE_CHROME to its path",
    );
    const profile = fs.mkdtempSync(path.join(stack.work, "chrome-"));
    return loadPage(chrome, profile, `http://${HOST}:${port}/?tkn=${token}&${query}`, {
      until,
      ms: 4000,
      settle,
      width: 1180,
      height: 1500,
      screenshot,
    });
  };

  it("in a browser: cards, Needs you, and a workspace's words shown as text, never run", async () => {
    stack.step("the dashboard in a browser");
    let page = await browser("once", /data-domain="web"/);
    for (let i = 0; i < 4 && !/data-domain="web"/.test(page.stdout); i++)
      page = await browser("once", /data-domain="web"/);
    // A picture of it, for a person to look at (section 4.8: the owner reviews screenshots).
    if (process.env.DESOLATE_SCREENSHOTS)
      await browser(
        "once",
        /data-domain="web"/,
        0,
        path.join(process.env.DESOLATE_SCREENSHOTS, "dashboard.png"),
      );
    const dom = page.stdout;
    assert.match(
      dom,
      /<div class="card" data-domain="web">[\s\S]*<h3><span class="named domain"[^>]*><span class="kind">domain<\/span><span class="value mono" title="web">web<\/span><\/span><\/h3><span class="domain-title"[^>]*>the web app<\/span>/,
      dom.slice(0, 600),
    );
    assert.match(
      dom,
      /<li data-workspace="web\/one"><span class="dot orange"/,
      "the workspace's colour, visible at a glance",
    );
    assert.match(
      dom,
      /<section id="needs">[\s\S]*web\/one[\s\S]*need: a decision about &lt;b&gt;the API&lt;\/b&gt; &lt;script&gt;alert\(1\)&lt;\/script&gt;/,
      "what the workspace said is on the page as text",
    );
    assert.deepEqual(
      dom.match(/<script[^>]*>/g),
      [
        '<script src="/page-key.js">',
        '<script src="/highlight.js">',
        '<script src="/markdown.js">',
        '<script src="/ui.js">',
      ],
      "and the only scripts on the page are the dashboard's own (its page key's keeper, its diff colours, an issue's Markdown preview, and itself)",
    );
    assert.doesNotMatch(
      page.stderr,
      /Refused to|Content Security Policy|Uncaught/i,
      "nothing the page did was refused by its own policy, and nothing threw",
    );
    assert.match(
      dom,
      /<a class="button" href="http:\/\/web-one-editor-[0-9a-f]+\.localhost:\d+\/\?tkn=[0-9a-f]{48}[^"]*" target="_blank" rel="noopener" data-editor="">Open editor<\/a>/,
    );
    assert.doesNotMatch(
      dom.replace(/href="[^"]*"/g, ""),
      /tkn=[0-9a-f]{8}/,
      "a token is in a link's address and never in what is shown",
    );
    assert.match(dom, /NOT ISOLATED: fake backend/);
    assert.match(
      dom,
      /<span class="tip" title="Stop web\/one first: a VM's size changes only while it is stopped\."><button [^>]*disabled=""[^>]*data-resize="web\/one"[^>]*>Resize\.\.\.<\/button>/,
      "Resize is there, off while it runs, and says why",
    );
  });

  it("stop and start from the dashboard", async () => {
    stack.step("stop and start");
    assert.equal((await action("workspace.stop", { domain: "web", workspace: "one" })).status, 202);
    assert.ok(
      await until(async () => ws(await state(), "web/one")?.host?.status === "stopped", 60_000),
    );
    assert.equal(
      (await action("workspace.start", { domain: "web", workspace: "one" })).status,
      202,
    );
    assert.ok(
      await until(
        async () =>
          ws(await state(), "web/one")?.host?.status === "running" &&
          (await state()).actions.at(-1)?.state === "done",
        120_000,
      ),
    );
    assert.equal((await state()).actions.at(-1)!.command, "desolate start web/one");
  });

  it("Resize from the dashboard: refused while it runs, done once it is stopped", async () => {
    stack.step("resize from the dashboard");
    const last = async () => {
      assert.ok(
        await until(
          async () => ["done", "failed"].includes((await state()).actions.at(-1)?.state ?? ""),
          120_000,
        ),
      );
      return (await state()).actions.at(-1)!;
    };
    const to = { domain: "web", workspace: "one", cpus: "3", memory: "5120m", disk: "40g" };
    // CONTROL: running, the host refuses it, and says how.
    assert.equal((await action("workspace.resize", to)).status, 202);
    const refused = await last();
    assert.equal(refused.command, "desolate resize web/one --cpus 3 --memory 5120m --disk 40g");
    assert.equal(refused.state, "failed");
    assert.match(refused.lines.join("\n"), /a VM's size changes only while it is stopped/);
    // A size the page would never send is refused before anything runs.
    assert.equal(
      (await action("workspace.resize", { ...to, memory: "5g" })).status,
      400,
      "memory goes as MiB",
    );
    assert.equal((await action("workspace.stop", { domain: "web", workspace: "one" })).status, 202);
    assert.ok(
      await until(async () => ws(await state(), "web/one")?.host?.status === "stopped", 60_000),
    );
    assert.equal((await action("workspace.resize", to)).status, 202);
    const done = await last();
    assert.equal(done.state, "done", done.lines.join("\n"));
    assert.ok(
      await until(async () => {
        const size = (ws(await state(), "web/one") as { size?: unknown } | undefined)?.size;
        return JSON.stringify(size) === JSON.stringify({ cpus: 3, memoryMiB: 5120, diskGiB: 40 });
      }, 30_000),
      "the dashboard shows the new size",
    );
    assert.equal(
      (await action("workspace.start", { domain: "web", workspace: "one" })).status,
      202,
    );
    assert.ok(
      await until(
        async () =>
          ws(await state(), "web/one")?.host?.status === "running" &&
          (await state()).actions.at(-1)?.state === "done",
        120_000,
      ),
    );
  });

  it("an offer appears, is reviewed, and a push from the dashboard still waits for the person on the host", async () => {
    stack.step("review and push");
    const work = stack.quiet(
      "exec",
      "web/one",
      "--",
      "sh",
      "-c",
      "git checkout -q -b fix && echo fixed >> README.md && git -c user.name=t -c user.email=t@example.test commit -qam 'fix: the thing' && desolate offer && git rev-parse HEAD",
    );
    assert.equal(work.code, 0, work.stderr);
    commit = work.stdout.trim().split("\n").pop()!;
    assert.ok(
      await until(async () =>
        (await state()).offers.some((o) => o.branch === "fix" && o.commit === commit),
      ),
      "the offer is on the dashboard",
    );
    const review = JSON.parse(
      (await http("GET", "/review?domain=web&repo=acme%2Fapp&branch=fix")).body,
    ) as {
      commit: string;
      commits: { items: { subject: string }[]; total: number };
      changes: { items: { path: string }[]; total: number };
      pushable: boolean;
    };
    assert.deepEqual(
      [
        review.commit,
        review.commits.items.map((c) => c.subject),
        review.commits.total,
        review.changes.items.map((c) => c.path),
        review.changes.total,
        review.pushable,
      ],
      [commit, ["fix: the thing"], 1, ["README.md"], 1, true],
    );
    // Not the commit that was reviewed: refused before anything is asked.
    assert.equal(
      (
        await action("offer.push", {
          domain: "web",
          repo: "acme/app",
          branch: "fix",
          commit: "0".repeat(40),
        })
      ).status,
      400,
    );
    const asked = await action("offer.push", {
      domain: "web",
      repo: "acme/app",
      branch: "fix",
      commit,
    });
    assert.equal(asked.status, 202);
    assert.ok(
      await until(async () =>
        (await state()).approvals.some((a) => a.branch === "fix" && a.commit === commit),
      ),
      "it is waiting, and the dashboard says so under Needs you",
    );
    assert.equal(
      stack.forge("refs", "acme/app").includes("fix"),
      false,
      "nothing has been pushed: the dashboard cannot approve",
    );
    // The workspace's commits against the remote, as the dashboard counts them: one, before.
    type Counted = { pushed?: { repo: string; count: number | null }[] | null };
    const counted = async () =>
      ((ws(await state(), "web/one") as Counted | undefined)?.pushed ?? []).find(
        (c) => c.repo === "acme/app",
      )?.count;
    assert.ok(
      await until(async () => (await counted()) === 1, 60_000),
      `counted before the push: ${await counted()}`,
    );
    const approved = stack.person("Type the branch name", "fix", "approve");
    assert.equal(approved.code, 0, approved.stdout);
    assert.ok(
      await until(async () =>
        (await state()).actions.some((a) => a.kind === "offer.push" && a.state === "done"),
      ),
      JSON.stringify((await state()).actions.at(-1)),
    );
    assert.match(stack.forge("refs", "acme/app"), new RegExp(`^fix ${commit}$`, "m"));
    const end = await state();
    assert.deepEqual(
      [end.offers.length, end.approvals.length],
      [0, 0],
      "the offer is no longer waiting",
    );
    // And none once it has landed: the push fetches, and the dashboard counts again (it said
    // "2 not on the remote" after a push until its two minutes were up: dogfooding, 2026-11-18).
    assert.ok(
      await until(async () => (await counted()) === 0, 30_000),
      `counted after the push: ${await counted()}`,
    );
  });

  it("the diff is read in the dashboard, as text made by git in the root; the root has no editor", async () => {
    stack.step("the diff, and no root editor");
    const work = stack.quiet(
      "exec",
      "web/one",
      "--",
      "sh",
      "-c",
      "git checkout -q -b markup && printf '<img src=x onerror=alert(1)>\\n' >> README.md && git -c user.name=t -c user.email=t@example.test commit -qam 'markup in a file' && desolate offer && git rev-parse HEAD",
    );
    assert.equal(work.code, 0, work.stderr);
    const tip = work.stdout.trim().split("\n").pop()!;
    assert.ok(
      await until(async () =>
        (await state()).offers.some((o) => o.branch === "markup" && o.commit === tip),
      ),
    );
    const diff = JSON.parse(
      (await http("GET", "/diff?domain=web&repo=acme%2Fapp&branch=markup")).body,
    ) as { commit: string; text: string; from: number; next: number | null; total: number };
    assert.equal(
      diff.commit,
      tip,
      "the diff says which commit it is of: the one a push would name",
    );
    assert.match(
      diff.text,
      /^diff --git a\/README\.md b\/README\.md\n[\s\S]*\n\+<img src=x onerror=alert\(1\)>\n/,
    );
    assert.deepEqual(
      [diff.from, diff.next, diff.total],
      [0, null, Buffer.byteLength(diff.text)],
      "one page, the whole diff: its size is the bytes sent",
    );
    assert.equal(
      (await http("GET", "/diff?domain=web&repo=acme%2Fapp&branch=no-such")).status,
      400,
    );
    assert.equal(
      (
        await http("GET", "/diff?domain=web&repo=acme%2Fapp&branch=markup", {
          headers: ["Sec-Fetch-Site: cross-site"],
        })
      ).status,
      403,
    );
    // Some of a review's commits (the dashboard's commit picker): a run of the review's own
    // commits, in order, and that run's changes alone; anything else is refused.
    const second = stack.quiet(
      "exec",
      "web/one",
      "--",
      "sh",
      "-c",
      "echo second > SECOND.md && git add SECOND.md && git -c user.name=t -c user.email=t@example.test commit -qm 'a second file' && desolate offer && git rev-parse HEAD",
    );
    assert.equal(second.code, 0, second.stderr);
    const next = second.stdout.trim().split("\n").pop()!;
    assert.ok(
      await until(async () =>
        (await state()).offers.some((o) => o.branch === "markup" && o.commit === next),
      ),
    );
    const picked = (from: string, to: string) =>
      http("GET", `/diff?domain=web&repo=acme%2Fapp&branch=markup&pickFrom=${from}&pickTo=${to}`);
    // (The files a pick changes: the review's next page of its files, for those commits.)
    const pickedFiles = async (from: string, to: string) =>
      (
        JSON.parse(
          (
            await http(
              "GET",
              `/review/more?domain=web&repo=acme%2Fapp&branch=markup&list=files&pickFrom=${from}&pickTo=${to}`,
            )
          ).body,
        ) as { changes: { items: { path: string }[]; total: number } }
      ).changes;
    const one = JSON.parse((await picked(next, next)).body) as {
      commit: string;
      text: string;
      pick: { from: string; to: string };
    };
    assert.equal(one.commit, next, "still the branch's commit, the one Push names");
    assert.deepEqual(
      (await pickedFiles(next, next)).items.map((c) => c.path),
      ["SECOND.md"],
      "that commit's file alone",
    );
    assert.doesNotMatch(one.text, /README\.md/, "and its diff alone");
    assert.deepEqual((await pickedFiles(tip, next)).items.map((c) => c.path).sort(), [
      "README.md",
      "SECOND.md",
    ]);
    assert.match((await picked(next, tip)).body, /not in order/, "a run backwards is refused");
    assert.equal((await picked(next, tip)).status, 400);
    assert.equal(
      (await picked("0".repeat(40), next)).status,
      400,
      "a commit the review does not list",
    );
    assert.equal((await picked("HEAD", next)).status, 400, "a name, not a commit");
    assert.equal(
      (await http("GET", `/diff?domain=web&repo=acme%2Fapp&branch=markup&pickFrom=${next}`)).status,
      400,
      "half a run",
    );
    // In the browser: the review opens at the offer, side by side (the default layout), and
    // the diff's markup is text on the page, in a span, not an element of it.
    const at = "once&review&domain=web&repo=acme%2Fapp&branch=markup";
    // Drawn, then coloured by a worker, which splits a line's text into spans of its colours:
    // what is asserted is the same either way (the line is an added one, and its markup is
    // text), read with those spans taken out.
    const drawn = /<div class="sbs" data-diff="">[\s\S]*<span class="code add">/;
    let page = await browser(at, drawn, 2000);
    for (let i = 0; i < 4 && !drawn.test(page.stdout); i++) page = await browser(at, drawn, 2000);
    const diffText = page.stdout
      .slice(Math.max(0, page.stdout.indexOf('<div class="sbs" data-diff="">')))
      .replace(/<\/?(span class="hl"[^>]*|span|mark)>/g, "");
    assert.match(page.stdout, drawn, page.stdout.slice(0, 800));
    assert.match(
      diffText,
      /&lt;img src=x onerror=alert\(1\)&gt;/,
      "the diff's markup is on the page as text",
    );
    assert.doesNotMatch(page.stdout, /<img/i, "no element was made from the diff");
    assert.doesNotMatch(page.stderr, /alert|Uncaught/i, "and nothing of it ran");
    if (process.env.DESOLATE_SCREENSHOTS)
      await browser(at, drawn, 2000, path.join(process.env.DESOLATE_SCREENSHOTS, "review.png"));
    // The state service is kept running: ended, it is back, and its log says what happened.
    assert.equal(
      stack.inRoot(["bash", "-c", "pkill -f '^node .*stated\\.ts$'"]).code,
      0,
      "control: it was running, and was ended",
    );
    assert.ok(
      await until(
        async () => (await http("GET", "/state").catch(() => ({ status: 0 }))).status === 200,
      ),
      "the dashboard answers again",
    );
    assert.match(
      stack.inRoot(["bash", "-c", "tail -3 /var/lib/desolate/stated.log"]).stdout,
      /stated: ended with \d+ at .*; starting it again\n/,
    );
    // There is one surface in the root, and it is the dashboard.
    assert.match(
      stack.desolate("ui").stdout,
      new RegExp(
        `^dashboard    http://${HOST}:${port}/\\?tkn=${token}\napprovals    http://desolate-approve\\.localhost:${port}/\\?tkn=[0-9a-f]{48}\nto sign this browser in to every page at once: desolate ui --open \\(or --link, to print the link\\)\n$`,
      ),
    );
    assert.equal(
      (await http("GET", "/", { host: "desolate-editor.localhost" })).status,
      421,
      "the name the root's editor had answers nothing",
    );
    assert.equal(
      stack
        .inRoot([
          "bash",
          "-c",
          "ss -ltnH | grep -cE ':(31580|31581) '; pgrep -fc 'codium-serve[r]|server-mai[n].js'; true",
        ])
        .stdout.replace(/\s+/g, " ")
        .trim(),
      "0 0",
      "no editor's server runs in the root VM",
    );
  });

  it("a branch of 250 commits: the review counts every one, pages them, and the 41st is pickable", async () => {
    stack.step("a long branch, counted and paged");
    // (Before, the root listed 200 and every count said 200; the page let a person pick from
    // the first 40, and `desolate review` said "a push would send 200 commit(s)".)
    const work = stack.quiet(
      "exec",
      "web/one",
      "--",
      "sh",
      "-c",
      'git switch -q -c long main && for i in $(seq 1 250); do echo $i > f$i.txt && git add f$i.txt && git -c user.name=t -c user.email=t@example.test commit -qm "commit $i"; done && desolate offer && git rev-parse HEAD',
    );
    assert.equal(work.code, 0, work.stderr);
    const tip = work.stdout.trim().split("\n").pop()!;
    assert.ok(
      await until(async () =>
        (await state()).offers.some((o) => o.branch === "long" && o.commit === tip),
      ),
    );
    type Page<T> = { items: T[]; total: number; from: number };
    type Commit = { commit: string; subject: string };
    const at = "domain=web&repo=acme%2Fapp&branch=long";
    const review = JSON.parse((await http("GET", `/review?${at}`)).body) as {
      commits: Page<Commit>;
      changes: Page<{ path: string }>;
      pushCommits: number;
    };
    assert.deepEqual(
      [review.commits.total, review.pushCommits, review.commits.items.length, review.changes.total],
      [250, 250, 100, 250],
      "every commit and file counted; a page of each listed",
    );
    assert.equal(review.commits.items[0]!.subject, "commit 250", "newest first");
    const more = async (list: string, from: number) =>
      JSON.parse((await http("GET", `/review/more?${at}&list=${list}&from=${from}`)).body) as {
        commit: string;
        commits?: Page<Commit>;
        changes?: Page<{ path: string }>;
      };
    const second = await more("commits", 100);
    assert.equal(second.commit, tip, "the next page says which commit it read");
    assert.deepEqual(
      [second.commits!.from, second.commits!.items[0]!.subject, second.commits!.total],
      [100, "commit 150", 250],
    );
    const last = await more("commits", 200);
    assert.deepEqual(
      [last.commits!.items.length, last.commits!.items.at(-1)!.subject],
      [50, "commit 1"],
      "the last page ends at the first commit",
    );
    assert.equal((await more("files", 200)).changes!.items.length, 50);
    // The 41st: picked alone, its own change.
    const forty1 = review.commits.items[40]!;
    assert.equal(forty1.subject, "commit 210");
    const its = JSON.parse(
      (await http("GET", `/diff?${at}&pickFrom=${forty1.commit}&pickTo=${forty1.commit}`)).body,
    ) as { text: string };
    assert.match(its.text, /^diff --git a\/f210\.txt b\/f210\.txt\n/);
    assert.doesNotMatch(its.text, /f209\.txt|f211\.txt/);
    // desolate review says the same numbers.
    const said = stack.desolate("review", "web", "acme/app", "long");
    assert.equal(said.code, 0, said.stderr);
    assert.match(said.stdout, /a push would send 250 commit\(s\)/);
    assert.match(said.stdout, /\.\.\. and 220 more commits/);
    assert.match(said.stdout, /\.\.\. and 210 more files/);
    // On the page: the counts are the totals, a page of commits is listed, each a button, and
    // the rest are asked for.
    const shown = /data-commits-more=""/;
    let page = await browser(`once&review&${at}`, shown, 1000);
    for (let i = 0; i < 4 && !shown.test(page.stdout); i++)
      page = await browser(`once&review&${at}`, shown, 1000);
    assert.match(page.stdout, /All 250 commits, combined/, page.stdout.slice(0, 800));
    assert.match(page.stdout, />250 commits</);
    assert.match(page.stdout, /and 150 more commits/);
    assert.match(page.stdout, /Files changed \(250\)/);
    assert.match(page.stdout, /and 150 more files/);
    const picks = [...page.stdout.matchAll(/data-pick="([0-9a-f]{40})"/g)].map((m) => m[1]);
    assert.equal(picks.length, 100);
    assert.equal(picks[40], forty1.commit, "the 41st is a button, as the first is");
  });

  it("Delete from the dashboard removes only a workspace with nothing to lose", async () => {
    stack.step("delete from the dashboard");
    // A workspace of its own, on the remote's main: nothing in it is unpushed.
    const made = stack.quiet("up", "web", "--name", "spare", "--base", "origin/main");
    assert.equal(made.code, 0, made.stderr);
    type Seen = {
      doing?: string | null;
      pushed?: { repo: string; count: number | null; why: string | null }[] | null;
      host?: { looked?: { lost: string[] } } | null;
    };
    const spare = async () => ws(await state(), "web/spare") as Seen | undefined;
    const lost = async () => (await spare())?.host?.looked?.lost;
    // The host looks at it while it runs (every 30 s); the root counts its commits.
    assert.ok(
      await until(
        async () => Array.isArray(await lost()) && Array.isArray((await spare())?.pushed),
        120_000,
      ),
      `looked at and counted: ${JSON.stringify(await spare())}`,
    );
    assert.deepEqual(
      (await spare())!.pushed!.map((c) => c.count),
      [0],
      "on the remote's main, nothing is unpushed",
    );
    const removeIt = async () => {
      assert.equal(
        (await action("workspace.remove", { domain: "web", workspace: "spare" })).status,
        202,
      );
      assert.ok(
        await until(
          async () => ["done", "failed"].includes((await state()).actions.at(-1)?.state ?? ""),
          120_000,
        ),
      );
      return (await state()).actions.at(-1)!;
    };
    // CONTROL: an untracked file in it. The dashboard is told why, and the host refuses too
    // when asked anyway: the workspace is still there.
    assert.equal(stack.quiet("exec", "web/spare", "--", "touch", "notes.txt").code, 0);
    assert.ok(
      await until(
        async () => ((await lost()) ?? []).some((l) => /untracked files/.test(l)),
        90_000,
      ),
      `seen: ${JSON.stringify(await lost())}`,
    );
    const refused = await removeIt();
    assert.equal(refused.command, "desolate rm web/spare --if-clean --if-pushed");
    assert.equal(refused.state, "failed");
    assert.match(
      refused.lines.join("\n"),
      /was not removed: uncommitted changes or untracked files/,
    );
    assert.ok(await spare(), "still there");
    // Nothing left in it: removed.
    assert.equal(stack.quiet("exec", "web/spare", "--", "rm", "notes.txt").code, 0);
    assert.ok(
      await until(async () => (await lost())?.length === 0, 90_000),
      `seen: ${JSON.stringify(await lost())}`,
    );
    const done = await removeIt();
    assert.equal(done.state, "done", done.lines.join("\n"));
    assert.ok(
      await until(async () => (await spare()) === undefined, 30_000),
      "gone from the state",
    );
  });

  it("the transcript reads as reviewed", () => {
    stack.checkTranscript("t2-09-ui");
  });
});
