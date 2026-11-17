// Your agents, from your phone: what each is showing, and a line typed into it. Over Tailscale
// (`desolate phone on`), at an address of its own: https://<mac>.<tailnet>.ts.net:8444.
//
// Why the host serves it, at an origin of its own, and not the dashboard (which the root
// serves): typing into an agent is running something in its workspace. The root's ordinary
// user, which reads every domain's data, must not be able to do that (as it cannot start a
// command in a workspace: spawn requests are signed by the workspace, shared/spawn.ts). So
// these requests never reach the root, and the dashboard's script, which the root serves,
// is on another origin and cannot call them. Like the approval page, and for the same reason.
//
// What a request must have: Tailscale Serve's word that it is from the login `desolate phone
// on` recorded, for this Mac's tailnet name (phone.ts), and this page's own token, exchanged
// once for a cookie. A request that does something (say) must also be the page's own: same
// origin, with the header only its script sends.
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as path from "node:path";
import { sameSecret } from "../shared/gate.ts";
import { paths, RELEASE_DIR } from "./paths.ts";
import { readPhone, tailnetRequest } from "./phone.ts";
import type { Phone } from "./phone.ts";
import type { Expect, Invoke, Table } from "../../suede.nests/dsl.import.meta.vitest.ts";

const TOKEN_FILE = () => path.join(paths.state, "agents-token");
const UI = path.join(RELEASE_DIR, "host", "agents-ui");
const VENDOR = path.join(RELEASE_DIR, "host", "git-ui", "vendor");

/** This page's token: made once, kept with the stack's state. */
export const agentsToken = (): string => {
  try {
    const value = fs.readFileSync(TOKEN_FILE(), "utf8").trim();
    if (/^[0-9a-f]{48}$/.test(value)) return value;
  } catch {
    /* none yet */
  }
  const made = randomBytes(24).toString("hex");
  fs.mkdirSync(paths.state, { recursive: true, mode: 0o700 });
  fs.writeFileSync(TOKEN_FILE(), `${made}\n`, { mode: 0o600 });
  return made;
};

const cookieName = (token: string) =>
  `desolate_agents_${createHash("sha256").update(token).digest("hex").slice(0, 12)}`;

const SECURITY: Record<string, string> = {
  // xterm.js makes <style> elements of its own: styles may be inline, scripts may not.
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'none'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

const STATIC: Record<string, [string, string]> = {
  "/": [path.join(UI, "agents.html"), "text/html; charset=utf-8"],
  "/agents.js": [path.join(UI, "agents.js"), "text/javascript; charset=utf-8"],
  "/agents.css": [path.join(UI, "agents.css"), "text/css; charset=utf-8"],
  "/vendor/xterm.js": [path.join(VENDOR, "xterm.js"), "text/javascript; charset=utf-8"],
  "/vendor/xterm.css": [path.join(VENDOR, "xterm.css"), "text/css; charset=utf-8"],
};

/** The keys a phone's keyboard does not have, by name: what each sends to the terminal. */
export const KEYS: Record<string, string> = {
  enter: "\r",
  escape: "\x1b",
  "ctrl-c": "\x03",
  tab: "\t",
  up: "\x1b[A",
  down: "\x1b[B",
};

/** A request that does something: it must be the page's own (same origin, its header). */
export const pagesOwn = (headers: IncomingMessage["headers"], phone: Phone): boolean => {
  const origin = String(headers.origin ?? "");
  return (
    headers["x-desolate-agents"] === "1" &&
    String(headers["sec-fetch-site"] ?? "same-origin") === "same-origin" &&
    origin === `https://${phone.name}:${phone.httpsPort + 1}`
  );
};

declare namespace pagesOwn {
  /** the page's script, from its own origin, with its header */
  export type Own = Table<
    typeof pagesOwn,
    [
      [
        args: [
          headers: {
            "x-desolate-agents": "1";
            "sec-fetch-site": "same-origin";
            origin: "https://mac.tail1234.ts.net:8444";
          },
          phone: { login: "you@example.com"; name: "mac.tail1234.ts.net"; httpsPort: 8443 },
        ],
        expected: true,
      ],
      [
        args: [
          headers: {
            "x-desolate-agents": "1";
            "sec-fetch-site": "same-site";
            origin: "https://mac.tail1234.ts.net:8443";
          },
          phone: { login: "you@example.com"; name: "mac.tail1234.ts.net"; httpsPort: 8443 },
        ],
        expected: false,
      ],
      [
        args: [
          headers: { "sec-fetch-site": "same-origin"; origin: "https://mac.tail1234.ts.net:8444" },
          phone: { login: "you@example.com"; name: "mac.tail1234.ts.net"; httpsPort: 8443 },
        ],
        expected: false,
      ],
    ]
  >;
}

const where = (value: unknown) =>
  typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,39}\/[a-z0-9][a-z0-9-]{0,39}$/.test(value)
    ? value
    : null;
const nameOf = (value: unknown) =>
  typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,39}$/.test(value) ? value : undefined;

/** The page's port, on 127.0.0.1 only: the phone's port plus one. */
export const serveAgents = (log: (line: string) => void, port: number) => {
  const send = (res: ServerResponse, status: number, type: string, body: string | Buffer) => {
    res.writeHead(status, {
      "content-type": type,
      "content-length": Buffer.byteLength(body),
      ...SECURITY,
    });
    res.end(body);
  };
  const text = (res: ServerResponse, status: number, message: string) =>
    send(res, status, "text/plain; charset=utf-8", `desolate: ${message}\n`);
  const json = (res: ServerResponse, status: number, value: unknown) =>
    send(res, status, "application/json; charset=utf-8", JSON.stringify(value));
  const server = createServer(async (req, res) => {
    const phone = readPhone();
    const checked = tailnetRequest(phone, req.headers);
    if ("refused" in checked) return text(res, checked.refused.status, checked.refused.text);
    // Only this page, or a navigation to it: the dev servers on the tailnet share its name,
    // and so its site, and a page of theirs could otherwise make it read (the dashboard's rule).
    const site = String(req.headers["sec-fetch-site"] ?? "");
    if (site !== "" && site !== "same-origin" && site !== "none")
      return text(
        res,
        403,
        `a request another page started (Sec-Fetch-Site: ${site.slice(0, 40).replace(/[^\x20-\x7e]/g, "?")})`,
      );
    const token = agentsToken();
    const name = cookieName(token);
    const url = new URL(req.url ?? "/", "http://agents");
    const given = url.searchParams.get("tkn");
    if (req.method === "GET" && url.pathname === "/" && given !== null) {
      if (!sameSecret(given, token))
        return text(res, 403, "that is not this page's address; `desolate phone on` prints it");
      res.writeHead(303, {
        location: "/",
        "set-cookie": `${name}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/`,
        "content-length": 0,
        ...SECURITY,
      });
      return res.end();
    }
    const cookie = new RegExp(`(?:^|;\\s*)${name}=([0-9a-f]{48})(?:;|$)`).exec(
      String(req.headers.cookie ?? ""),
    )?.[1];
    if (!cookie || !sameSecret(cookie, token))
      return text(
        res,
        401,
        "open this page at the address `desolate phone on` prints: it carries its token",
      );
    try {
      const agents = await import("./agent.ts");
      if (req.method === "GET" && STATIC[url.pathname]) {
        const [file, type] = STATIC[url.pathname]!;
        return send(res, 200, type, fs.readFileSync(file));
      }
      if (req.method === "GET" && url.pathname === "/list")
        return json(
          res,
          200,
          (await agents.agents()).map((a) => ({
            workspace: a.workspace,
            name: a.name,
            state: a.state,
            lastOutput: a.lastOutput,
            command: a.command.join(" "),
          })),
        );
      if (req.method === "GET" && url.pathname === "/output") {
        const at = where(url.searchParams.get("at"));
        if (!at) return text(res, 400, "which workspace? (?at=<domain>/<workspace>)");
        const shown = await agents.output(
          at,
          nameOf(url.searchParams.get("name")),
          Number(url.searchParams.get("from") ?? -1),
        );
        return json(res, 200, { data: shown.data.toString("base64"), next: shown.next });
      }
      if (req.method === "POST" && url.pathname === "/say") {
        if (!pagesOwn(req.headers, phone!))
          return text(res, 403, "a request this page did not make");
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 100_000) return text(res, 413, "too much to type at once");
        }
        const asked = JSON.parse(body) as {
          at?: unknown;
          name?: unknown;
          text?: unknown;
          key?: unknown;
        };
        const at = where(asked.at);
        if (!at) return text(res, 400, "which workspace?");
        const bytes =
          typeof asked.key === "string" && KEYS[asked.key] !== undefined
            ? KEYS[asked.key]!
            : typeof asked.text === "string" && asked.text !== ""
              ? `${asked.text}\r`
              : null;
        if (bytes === null) return text(res, 400, "say what?");
        await agents.say(at, nameOf(asked.name), Buffer.from(bytes));
        log(
          `agents page: said ${Buffer.byteLength(bytes)} byte(s) to ${nameOf(asked.name) ?? "agent"} in ${at}`,
        );
        return json(res, 200, { ok: true });
      }
      return text(res, 404, "no such thing");
    } catch (error) {
      return text(res, 400, String((error as Error).message ?? error).slice(0, 300));
    }
  });
  server.on("error", (error: NodeJS.ErrnoException) =>
    log(`agents port ${port}: ${error.message}`),
  );
  server.listen({ port, host: "127.0.0.1", exclusive: true });
  return server;
};
