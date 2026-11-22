// T1. The git terminal (host/git-web.ts): who may open a shell, type in it and read it. A
// real HTTP server on loopback, a stand-in shell (`cat`), and each way a request that is not
// the person's own tab could arrive. And the vendored xterm.js is the package's own.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { createServer, request } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ChildProcess } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "desolate-git-"));
process.env.DESOLATE_HOME = home;
process.env.DESOLATE_EDITOR_PORT = "31598";
const { gitToken, handler, INPUT_CHARS } = await import("../../../release/host/git-web.ts");
const { TERMINAL } = await import("../../../release/shared/limits.ts");

const NAME = "desolate-git.localhost";
const ORIGIN = `http://${NAME}:31598`;
const spawned: string[][] = [];
const children: ChildProcess[] = [];
let server: Server;
let port = 0;
before(async () => {
  // The stand-in for terminal.py: echoes what it is given, protocol and all.
  server = createServer(
    handler(
      (argv) => {
        spawned.push(argv);
        const child = spawn("cat", [], { stdio: ["pipe", "pipe", "pipe"] });
        children.push(child);
        return child;
      },
      () => {},
    ),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});
after(() => {
  for (const child of children) child.kill("SIGKILL");
  server.closeAllConnections();
  server.close();
  fs.rmSync(home, { recursive: true, force: true });
});

type Answer = { status: number; headers: Record<string, unknown>; body: string };
const call = (
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: string,
  untilMs?: number,
): Promise<Answer> =>
  new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: url,
        headers: { host: `${NAME}:31598`, ...headers },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }),
        );
        if (untilMs)
          setTimeout(
            () => (
              req.destroy(),
              resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text })
            ),
            untilMs,
          );
      },
    );
    req.on("error", (error) => (untilMs ? undefined : reject(error)));
    req.end(body);
  });

let cookie = "";
/** The page key the sign-in page carried, which the page's script keeps and sends. */
let storedKey = "";
const page = () => ({ cookie, "x-desolate-key": storedKey, "sec-fetch-site": "same-origin" });
const post = (url: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  call(
    "POST",
    url,
    { ...page(), origin: ORIGIN, "content-type": "application/json", ...headers },
    JSON.stringify(body),
  );

describe("T1 the git terminal", () => {
  it("the vendored xterm.js is the npm package's own, byte for byte", () => {
    const vendor = path.join(import.meta.dirname, "../../../release/host/git-ui/vendor");
    const sha = (file: string) =>
      createHash("sha256")
        .update(fs.readFileSync(path.join(vendor, file)))
        .digest("hex");
    assert.equal(
      sha("xterm.js"),
      "1f991ac3b4b283ebf96e60ae23a00a52765dd3a2e46fa6fdda9f1aab032f7495",
    );
    assert.equal(
      sha("xterm.css"),
      "ba8e6985669488981ccf40c0cefe3aba80722cb6c92de7ad628b0bd717faf2b6",
    );
    assert.equal(
      sha("addon-fit.js"),
      "bdaefa370b1bfc42ee88d46fe6072400902a4d4b2d45cd93438dda9b23c97089",
    );
  });

  it("the address gives the cookie; nothing opens a shell without it, or from another origin", async () => {
    assert.equal((await call("GET", `/?tkn=${"0".repeat(48)}`, {})).status, 403);
    const login = await call("GET", `/?tkn=${gitToken()}&repo=acme%2Fwidgets`, {});
    // A page of this origin's own, which keeps the key and goes on to the page.
    assert.equal(login.status, 200);
    assert.match(login.body, /<meta name="desolate-next" content="\/\?repo=acme%2Fwidgets">/);
    cookie = String(login.headers["set-cookie"]).split(";")[0]!;
    assert.ok(!cookie.includes(gitToken()), "the cookie is not the token");
    storedKey = /<meta name="desolate-key" content="([0-9a-f]{64})">/.exec(login.body)![1]!;
    assert.equal(
      (await call("GET", "/approvals-frame", { cookie, "sec-fetch-site": "same-origin" })).status,
      401,
      "the cookie alone opens nothing (what a program on another port of this name is sent)",
    );
    const html = await call("GET", "/", { cookie });
    assert.match(String(html.headers["content-security-policy"]), /script-src 'self'/);
    assert.match(String(html.headers["content-security-policy"]), /frame-ancestors 'none'/);
    assert.match(
      String(html.headers["content-security-policy"]),
      /; frame-src http:\/\/desolate-approve\.localhost:31598$/,
      "it frames the approval page and nothing else",
    );
    // The approval page's address for its frame: to this page's own script only.
    assert.equal(
      (await call("GET", "/approvals-frame", { "sec-fetch-site": "same-origin" })).status,
      401,
      "no cookie",
    );
    assert.equal(
      (
        await call("GET", "/approvals-frame", {
          cookie,
          "x-desolate-key": storedKey,
          "sec-fetch-site": "same-site",
        })
      ).status,
      403,
      "another page's request",
    );
    const frame = await call("GET", "/approvals-frame", page());
    assert.match(
      JSON.parse(frame.body).url,
      /^http:\/\/desolate-approve\.localhost:31598\/embed#k=[0-9a-f]{64}$/,
    );
    assert.equal((await post("/session", {}, { cookie: "" })).status, 401, "no cookie");
    assert.equal(
      (await post("/session", {}, { origin: "http://dev-w1-abc123.localhost:31598" })).status,
      403,
      "another origin",
    );
    assert.equal(
      (await post("/session", {}, { "sec-fetch-site": "same-site" })).status,
      403,
      "a request a workspace's page started",
    );
    assert.equal(
      (await post("/session", {}, { "content-type": "text/plain" })).status,
      415,
      "a form",
    );
    assert.equal(
      (
        await call(
          "POST",
          "/session",
          {
            ...page(),
            origin: ORIGIN,
            "content-type": "application/json",
            host: `evil.example:31598`,
          },
          "{}",
        )
      ).status,
      421,
      "another name",
    );
    assert.equal(spawned.length, 0, "no shell was started");
  });

  it("control: the page's own tab opens a shell where the repository is, types in it, and reads it; another shell's token does nothing", async () => {
    const opened = await post("/session", { repo: "acme/widgets" });
    assert.equal(opened.status, 200, opened.body);
    const { id, token } = JSON.parse(opened.body) as { id: string; token: string };
    assert.deepEqual(spawned.at(-1), [
      "python3",
      "-I",
      "/desolate/release/git/terminal.py",
      "/git/acme/widgets",
    ]);
    assert.equal(
      (await post(`/session/${id}/input`, { token: "0".repeat(48), data: "aGk=" })).status,
      404,
      "another token",
    );
    assert.equal((await post(`/session/${id}/input`, { token, data: "not base64!" })).status, 400);
    assert.equal(
      (
        await post(`/session/${id}/input`, {
          token,
          data: Buffer.from("echo hi\n").toString("base64"),
        })
      ).status,
      200,
    );
    assert.equal((await post(`/session/${id}/resize`, { token, cols: 100, rows: 30 })).status, 200);
    // As an EventSource asks, which sends no header: the key in the address.
    const asEventSource = { cookie, "sec-fetch-site": "same-origin" };
    assert.equal(
      (await call("GET", `/session/${id}/stream?token=${token}`, asEventSource, undefined, 200))
        .status,
      401,
      "a stream asked for with the cookie alone",
    );
    const stream = await call(
      "GET",
      `/session/${id}/stream?token=${token}&key=${storedKey}`,
      asEventSource,
      undefined,
      400,
    );
    assert.equal(stream.status, 200);
    const said = stream.body
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => Buffer.from(line.slice(6), "base64").toString())
      .join("");
    assert.match(
      said,
      /i ZWNobyBoaQo=\nr 100 30\n/,
      "what was typed and the size reached the far end, in its protocol",
    );
    assert.equal(
      (await call("GET", `/session/${id}/stream?token=${"0".repeat(48)}`, page(), undefined, 200))
        .status,
      404,
      "a stream needs the shell's own token",
    );
    assert.equal((await post("/session", { repo: "../../etc" })).status, 200);
    assert.deepEqual(
      spawned.at(-1),
      ["python3", "-I", "/desolate/release/git/terminal.py", "/git"],
      "a name that is not a repository opens at /git, nowhere else",
    );
  });

  it("a shell whose tab went is not ended: the page is offered it back, with what it printed; an ended one is not offered", async () => {
    const listed = async () => {
      const answer = await call("GET", "/sessions", page());
      assert.equal(answer.status, 200, answer.body);
      return JSON.parse(answer.body) as {
        input: number;
        scrollback: number;
        left: { id: string; token: string; where: string; since: number; last: string }[];
      };
    };
    assert.equal(
      (await call("GET", "/sessions", { cookie, "sec-fetch-site": "same-origin" })).status,
      401,
      "the cookie alone lists nothing",
    );
    const opened = await post("/session", { repo: "acme/widgets" });
    const { id, token } = JSON.parse(opened.body) as { id: string; token: string };
    await post(`/session/${id}/input`, {
      token,
      data: Buffer.from("left here\n").toString("base64"),
    });
    // Read, then the tab goes (a closed tab: its stream ends).
    await call("GET", `/session/${id}/stream?token=${token}`, page(), undefined, 300);
    await new Promise((resolve) => setTimeout(resolve, 100));
    // (The old page ended such a shell half a minute later, whatever it was doing.)
    const offered = await listed();
    assert.equal(offered.input, INPUT_CHARS, "the page is told how much one request carries");
    assert.equal(offered.scrollback, 5000);
    const back = offered.left.find((s) => s.id === id);
    assert.deepEqual(back && { token: back.token, where: back.where, last: back.last }, {
      token,
      where: "/git/acme/widgets",
      // (The shell here is cat: what it shows last is the protocol's line it was given.)
      last: "i bGVmdCBoZXJlCg==",
    });
    const again = await call("GET", `/session/${id}/stream?token=${token}`, page(), undefined, 300);
    assert.match(
      again.body
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => Buffer.from(line.slice(6), "base64").toString())
        .join(""),
      /i bGVmdCBoZXJlCg==/,
      "what it printed before is replayed to the tab that came back",
    );
    children.at(-1)!.kill("SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(
      (await listed()).left.find((s) => s.id === id),
      undefined,
      "an ended shell is not offered",
    );
  });

  it("how many shells at once is the setting git.shells, and the refusal says so and what to do", async () => {
    process.env.DESOLATE_GIT_SHELLS = "1";
    try {
      const refused = await post("/session", { repo: "acme/widgets" });
      assert.equal(refused.status, 429, refused.body);
      assert.match(
        refused.body,
        /shells are open already, the most at once \(the setting git\.shells: DESOLATE_GIT_SHELLS\)\. \d+ of them no tab is reading: reload this page to go back to one/,
      );
    } finally {
      delete process.env.DESOLATE_GIT_SHELLS;
    }
    assert.equal((await post("/session", { repo: "acme/widgets" })).status, 200, "the default");
  });

  it("a size or input past the host's bound is refused with the bound", async () => {
    const opened = await post("/session", {});
    const { id, token } = JSON.parse(opened.body) as { id: string; token: string };
    const big = await post(`/session/${id}/resize`, {
      token,
      cols: TERMINAL.cols + 1,
      rows: 10,
    });
    assert.equal(big.status, 400);
    assert.match(big.body, /at most 1000 by 500/);
    const much = await post(`/session/${id}/input`, { token, data: "A".repeat(INPUT_CHARS + 4) });
    assert.equal(much.status, 400);
    assert.match(
      much.body,
      /at most 65536 characters a request \(the page sends a paste in parts\)/,
    );
  });

  it("terminal.py's bounds are the host's, by name", () => {
    const py = fs.readFileSync(
      path.join(import.meta.dirname, "../../../release/git/terminal.py"),
      "utf8",
    );
    const terminal =
      /^TERMINAL = \{"cols": (\d+), "rows": (\d+)\}  # shared\/limits\.ts TERMINAL$/m.exec(py);
    assert.deepEqual(terminal && [Number(terminal[1]), Number(terminal[2])], [
      TERMINAL.cols,
      TERMINAL.rows,
    ]);
    const input = /^INPUT_CHARS = (\d+) \* (\d+)  # host\/git-web\.ts INPUT_CHARS/m.exec(py);
    assert.equal(input && Number(input[1]) * Number(input[2]), INPUT_CHARS);
  });

  it("terminal.py drops a protocol line longer than the host sends, and reads the next", async () => {
    const child = spawn("python3", ["-I", "release/git/terminal.py", os.tmpdir()], {
      cwd: path.join(import.meta.dirname, "../../.."),
      stdio: ["pipe", "pipe", "pipe"],
      // No history: the bash outlives its kill a moment and wrote ~/.bash_history while
      // after() removed HOME (ENOTEMPTY, on a busy Mac).
      env: { PATH: process.env.PATH, HOME: home, HISTFILE: "/dev/null" },
    });
    children.push(child);
    let said = "";
    child.stdout.on("data", (chunk) => (said += chunk));
    // More than a line can be, unended (the old far end held it all), then a typed line.
    child.stdin.write("i " + "A".repeat(INPUT_CHARS * 3));
    child.stdin.write("AAAA\n");
    child.stdin.write(`i ${Buffer.from("echo read-$((40+2))\n").toString("base64")}\n`);
    for (const until = Date.now() + 10_000; !said.includes("read-42") && Date.now() < until;)
      await new Promise((resolve) => setTimeout(resolve, 100));
    child.kill("SIGKILL");
    assert.match(said, /read-42/, said.slice(-500));
  });
});
