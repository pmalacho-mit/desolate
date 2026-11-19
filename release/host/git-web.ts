// The git terminal: a bash in the git VM (host/git-vm.ts), in a browser tab on this Mac,
// served by the host daemon at GIT_HOSTNAME on the editors' port. `desolate git <repo>`
// prints its address.
//
// Who can use it: the browser tab that opened the address `desolate git` printed, as with the
// approval page (approve-web.ts): a cookie only that address gives (HttpOnly, SameSite=Strict,
// a name of this stack's own), requests from this page's own origin only (Sec-Fetch-Site,
// Origin), JSON bodies, and a token per shell that only this page's script was given. A page
// an agent wrote, on a workspace's name, can do none of that.
//
// What a person types there runs in the git VM: no network, no key, nothing of a project's,
// and a push from there still waits for the approval page. What the terminal draws is the
// shell's output, bytes an agent may have written: the page's xterm.js has links that do
// nothing, no clipboard, and no title (git-ui/git.js).
import type { ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as path from "node:path";
import {
  APPROVE_HOSTNAME,
  editorHostPort,
  GIT_HOSTNAME,
  isBranch,
  isSlug,
  parseRepo,
} from "../shared/names.ts";
import { embedAddress } from "./approve-web.ts";
import { refusal, sameSecret } from "../shared/gate.ts";
import { guest, paths, RELEASE_DIR } from "./paths.ts";
import type { Expect, Given, Invoke } from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { writeState } from "../.harness/home.ts";
import type { ask, gitVmDown, noShell, quiet } from "../.harness/host-web.ts";

export const TOKEN_FILE = path.join(paths.state, "git-token");
const UI = path.join(RELEASE_DIR, "host", "git-ui");
/** idleMs: a shell with no tab reading it ends after this (a reload opens a new one). */
const LIMIT = { sessions: 6, input: 64 * 1024, kept: 256 * 1024, idleMs: 30_000 } as const;

export const gitToken = (): string => {
  try {
    const value = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    if (/^[0-9a-f]{48}$/.test(value)) return value;
  } catch {
    /* none yet */
  }
  const made = randomBytes(24).toString("hex");
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(TOKEN_FILE, `${made}\n`, { mode: 0o600 });
  return made;
};
/** The page's own address after the token's: the repository, and a domain's branch to open
 *  on, kept only when each is one. */
export const pageOf = (search: string): string => {
  const params = new URLSearchParams(search);
  const kept = new URLSearchParams();
  const repo = params.get("repo");
  if (repo && parseRepo(repo)) {
    kept.set("repo", repo);
    const domain = params.get("domain");
    const branch = params.get("branch");
    if (isSlug(domain) && isBranch(branch)) {
      kept.set("domain", domain!);
      kept.set("branch", branch!);
    }
  }
  return kept.size ? `/?${kept}` : "/";
};

declare namespace pageOf {
  export type Kept = Expect<
    Invoke<typeof pageOf, [search: "?tkn=x&repo=acme/web&domain=dev&branch=feature/x"]>,
    "=",
    "/?repo=acme%2Fweb&domain=dev&branch=feature%2Fx"
  >;
  /** a domain or branch that is not one is dropped; a repository that is not one drops all */
  export type Dropped = [
    Expect<
      Invoke<typeof pageOf, [search: "?repo=acme/web&domain=--all&branch=main"]>,
      "=",
      "/?repo=acme%2Fweb"
    >,
    Expect<Invoke<typeof pageOf, [search: "?repo=../../etc&domain=dev&branch=main"]>, "=", "/">,
  ];
}

export const gitAddress = (repo?: string) =>
  `http://${GIT_HOSTNAME}:${editorHostPort()}/?tkn=${gitToken()}${repo ? `&repo=${encodeURIComponent(repo)}` : ""}`;

const cookieName = (token: string) =>
  `desolate_git_${createHash("sha256").update(token).digest("hex").slice(0, 12)}`;

export const SECURITY: Record<string, string> = {
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
/** The one page this one frames: the approval page's /embed, beside the terminal. */
const headers = () => ({
  ...SECURITY,
  "content-security-policy": `${SECURITY["content-security-policy"]}; frame-src http://${APPROVE_HOSTNAME}:${editorHostPort()}`,
});
const send = (res: ServerResponse, status: number, type: string, content: string | Buffer) => {
  res.writeHead(status, {
    "content-type": type,
    "content-length": Buffer.byteLength(content),
    ...headers(),
  });
  res.end(content);
};
const json = (res: ServerResponse, status: number, value: unknown) =>
  send(res, status, "application/json; charset=utf-8", JSON.stringify(value));
const STATIC: Record<string, [string, string]> = {
  "/": ["git.html", "text/html; charset=utf-8"],
  "/git.js": ["git.js", "text/javascript; charset=utf-8"],
  "/git.css": ["git.css", "text/css; charset=utf-8"],
  "/vendor/xterm.js": ["vendor/xterm.js", "text/javascript; charset=utf-8"],
  "/vendor/xterm.css": ["vendor/xterm.css", "text/css; charset=utf-8"],
  "/vendor/addon-fit.js": ["vendor/addon-fit.js", "text/javascript; charset=utf-8"],
};

type Session = {
  id: string;
  token: string;
  child: ChildProcess;
  kept: Buffer[];
  keptBytes: number;
  streams: Set<ServerResponse>;
  ended: boolean;
  seen: number;
};

/** `spawn`: a process in the git VM with pipes (the backend's). */
/** `prepare`: the git VM up and the person's clone of `repo` there (git-vm.ts), before a
 *  shell opens in it; with `at` (the dashboard's review of a domain's branch), that branch
 *  checked out. What it says, the terminal shows first. */
export const handler = (
  spawn: (argv: string[]) => ChildProcess,
  log: (line: string) => void,
  prepare: (
    repo: string | null,
    at?: { domain: string; branch: string },
  ) => Promise<string | void> = async () => {},
) => {
  const sessions = new Map<string, Session>();
  const reap = setInterval(() => {
    for (const s of sessions.values())
      if ((s.ended || s.streams.size === 0) && Date.now() - s.seen > LIMIT.idleMs) {
        s.child.kill("SIGKILL");
        sessions.delete(s.id);
      }
  }, 5_000);
  reap.unref();

  const open = (repo: string, first = "") => {
    const where = parseRepo(repo) ? `${guest.git}/${repo}` : guest.git;
    const s: Session = {
      id: randomBytes(8).toString("hex"),
      token: randomBytes(24).toString("hex"),
      child: spawn(["python3", "-I", `${guest.release}/git/terminal.py`, where]),
      kept: [],
      keptBytes: 0,
      streams: new Set(),
      ended: false,
      seen: Date.now(),
    };
    const out = (chunk: Buffer) => {
      s.kept.push(chunk);
      s.keptBytes += chunk.length;
      while (s.keptBytes > LIMIT.kept && s.kept.length > 1) s.keptBytes -= s.kept.shift()!.length;
      for (const res of s.streams) res.write(`data: ${chunk.toString("base64")}\n\n`);
    };
    // What readying it said (the branch it is on, and git status), before the shell's prompt.
    if (first) out(Buffer.from(`${first.replace(/\r?\n/g, "\r\n")}\r\n`));
    s.child.stdout?.on("data", out);
    s.child.stderr?.on("data", out);
    s.child.stdin?.on("error", () => {});
    s.child.on("close", () => {
      s.ended = true;
      for (const res of s.streams) res.end("event: end\ndata: \n\n");
    });
    sessions.set(s.id, s);
    log(`git terminal: a shell in ${where}`);
    return s;
  };

  return async (req: IncomingMessage, res: ServerResponse) => {
    // The page itself, opened from anywhere: the dashboard's "Open in git" is another site
    // (each *.localhost name is its own), and was refused, so the button opened a refusal
    // (dogfooding, 2026-11-17). The page is static; everything it does is a request of its own
    // origin that needs this stack's cookie, which only `desolate git`'s address gives.
    const url = new URL(req.url ?? "/", `http://${GIT_HOSTNAME}`);
    const toThePage =
      req.method === "GET" &&
      url.pathname === "/" &&
      req.headers["sec-fetch-mode"] === "navigate" &&
      req.headers["sec-fetch-dest"] === "document";
    const refused = refusal(GIT_HOSTNAME, req.headers, toThePage);
    // (gate.ts words its refusal for an editor: here, this page's own name and its own command.)
    if (refused)
      return send(
        res,
        refused.status,
        "text/plain; charset=utf-8",
        `desolate: refused ${refused.why.replace(/this is the editor of/, "this is the git terminal at").replace("`desolate editor`", "`desolate git`")}\n`,
      );
    const token = gitToken();
    const name = cookieName(token);
    const given = url.searchParams.get("tkn");
    if (req.method === "GET" && url.pathname === "/" && given !== null) {
      if (!sameSecret(given, token))
        return send(
          res,
          403,
          "text/plain; charset=utf-8",
          "desolate: refused: that is not this stack's git terminal address; `desolate git` prints it\n",
        );
      res.writeHead(303, {
        location: pageOf(url.search),
        "set-cookie": `${name}=${token}; HttpOnly; SameSite=Strict; Path=/`,
        "content-length": 0,
        ...SECURITY,
      });
      return res.end();
    }
    const cookie = new RegExp(`(?:^|;\\s*)${name}=([0-9a-f]{48})(?:;|$)`).exec(
      String(req.headers.cookie ?? ""),
    )?.[1];
    if (req.method === "GET" && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname]!;
      return send(res, 200, type, fs.readFileSync(path.join(UI, file)));
    }
    if (cookie === undefined || !sameSecret(cookie, token))
      return json(res, 401, {
        error:
          "open the git terminal at the address `desolate git` prints, on this Mac's terminal: it carries this stack's token",
      });
    if (String(req.headers["sec-fetch-site"] ?? "") !== "same-origin")
      return json(res, 403, { error: "a request this page did not make" });

    // The approval page's address for the frame beside the terminal (its key in the
    // fragment): to this page's own script, which only the person's browser can load.
    if (req.method === "GET" && url.pathname === "/approvals-frame")
      return json(res, 200, { url: embedAddress() });
    const match = /^\/session\/([0-9a-f]{16})\/(stream|input|resize)$/.exec(url.pathname);
    if (req.method === "GET" && match?.[2] === "stream") {
      const s = sessions.get(match[1]!);
      if (!s || !sameSecret(url.searchParams.get("token") ?? "", s.token))
        return json(res, 404, { error: "no such shell" });
      s.seen = Date.now();
      res.writeHead(200, {
        "content-type": "text/event-stream",
        ...SECURITY,
        connection: "keep-alive",
      });
      for (const chunk of s.kept) res.write(`data: ${chunk.toString("base64")}\n\n`);
      if (s.ended) return res.end("event: end\ndata: \n\n");
      s.streams.add(res);
      const beat = setInterval(() => res.write(": still here\n\n"), 15_000);
      req.on("close", () => {
        clearInterval(beat);
        s.streams.delete(res);
        s.seen = Date.now();
      });
      return;
    }
    if (req.method !== "POST") return json(res, 404, { error: "no such thing" });
    if (!/^application\/json(;|$)/.test(String(req.headers["content-type"] ?? "")))
      return json(res, 415, { error: "JSON only" });
    if (req.headers.origin !== `http://${GIT_HOSTNAME}:${editorHostPort()}`)
      return json(res, 403, { error: "a request from another origin" });
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > LIMIT.input * 2) return json(res, 413, { error: "too much at once" });
    }
    let asked: Record<string, unknown>;
    try {
      asked = JSON.parse(body) as Record<string, unknown>;
    } catch {
      return json(res, 400, { error: "not JSON" });
    }
    if (url.pathname === "/session") {
      const live = [...sessions.values()].filter((s) => !s.ended).length;
      if (live >= LIMIT.sessions)
        return json(res, 429, {
          error: `${LIMIT.sessions} shells are open already: close a tab (its shell ends half a minute later)`,
        });
      const repo = parseRepo(asked.repo) ? String(asked.repo) : null;
      const at =
        repo && isSlug(asked.domain) && isBranch(asked.branch)
          ? { domain: String(asked.domain), branch: String(asked.branch) }
          : undefined;
      let said = "";
      try {
        said = (await prepare(repo, at)) ?? "";
      } catch (error) {
        return json(res, 502, {
          error: `the git VM could not be readied: ${(error as Error).message}`,
        });
      }
      const s = open(repo ?? "", said);
      return json(res, 200, { id: s.id, token: s.token });
    }
    const s = match ? sessions.get(match[1]!) : undefined;
    if (!s || !sameSecret(String(asked.token ?? ""), s.token))
      return json(res, 404, { error: "no such shell" });
    s.seen = Date.now();
    if (s.ended) return json(res, 410, { error: "the shell ended" });
    if (match![2] === "input") {
      const data = String(asked.data ?? "");
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length > LIMIT.input)
        return json(res, 400, { error: "input is base64, at most 64 KiB at once" });
      s.child.stdin?.write(`i ${data}\n`);
      return json(res, 200, { ok: true });
    }
    const cols = Number(asked.cols);
    const rows = Number(asked.rows);
    if (
      !Number.isInteger(cols) ||
      !Number.isInteger(rows) ||
      cols < 1 ||
      cols > 1000 ||
      rows < 1 ||
      rows > 500
    )
      return json(res, 400, { error: "a size is whole columns and rows" });
    s.child.stdin?.write(`r ${cols} ${rows}\n`);
    return json(res, 200, { ok: true });
  };
};

declare namespace handler {
  /** This stack's token, as `desolate git` put it in the address. */
  type Token = "abababababababababababababababababababababababab";
  type HasToken = Invoke<typeof writeState, [name: "git-token", text: Token]>;
  type Cookie = "desolate_git_5e00ea51cf17=abababababababababababababababababababababababab";
  type Page = Invoke<typeof handler, [spawn: typeof noShell, log: typeof quiet]>;
  /** What the page's own script sends. */
  type Script = {
    host: "desolate-git.localhost:31581";
    "sec-fetch-site": "same-origin";
    origin: "http://desolate-git.localhost:31581";
    cookie: Cookie;
    "content-type": "application/json";
  };

  /** the address's token becomes a cookie; the repository it names is kept only if it is one */
  export type SignsIn = Given<
    HasToken,
    [
      Expect<
        Invoke<
          typeof ask,
          [
            handler: Page,
            request: {
              method: "GET";
              url: "/?tkn=abababababababababababababababababababababababab&repo=acme/web";
              headers: { host: "desolate-git.localhost:31581" };
            },
          ]
        >,
        "matches",
        {
          status: 303;
          headers: {
            location: "/?repo=acme%2Fweb";
            "set-cookie": "desolate_git_5e00ea51cf17=abababababababababababababababababababababababab; HttpOnly; SameSite=Strict; Path=/";
          };
        }
      >,
      Expect<
        Invoke<
          typeof ask,
          [
            handler: Page,
            request: {
              method: "GET";
              url: "/?tkn=abababababababababababababababababababababababab&repo=../../etc";
              headers: { host: "desolate-git.localhost:31581" };
            },
          ]
        >,
        "matches",
        { status: 303; headers: { location: "/" } }
      >,
      Expect<
        Invoke<
          typeof ask,
          [
            handler: Page,
            request: {
              method: "GET";
              url: "/?tkn=cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd";
              headers: { host: "desolate-git.localhost:31581" };
            },
          ]
        >,
        "matches",
        {
          status: 403;
          text: "desolate: refused: that is not this stack's git terminal address; `desolate git` prints it\n";
        }
      >,
    ]
  >;
  /** another name for this port (a workspace's, where an agent's page is) is refused first */
  export type OnlyByItsName = Given<
    HasToken,
    Expect<
      Invoke<
        typeof ask,
        [
          handler: Page,
          request: {
            method: "GET";
            url: "/approvals-frame";
            headers: { host: "acme-web-0a1b2c.localhost:31581"; cookie: Cookie };
          },
        ]
      >,
      "matches",
      {
        status: 421;
        text: "desolate: refused this is the git terminal at desolate-git.localhost; open it by that name (`desolate git` prints the address)\n";
      }
    >
  >;
  /** the dashboard's "Open in git", a navigation from another site: the page opens; anything
   *  else another site starts, a frame or a fetch of the page included, is refused */
  export type OpensFromTheDashboard = Given<
    HasToken,
    [
      Expect<
        Invoke<
          typeof ask,
          [
            handler: Page,
            request: {
              method: "GET";
              url: "/?repo=acme/web";
              headers: {
                host: "desolate-git.localhost:31581";
                "sec-fetch-site": "cross-site";
                "sec-fetch-mode": "navigate";
                "sec-fetch-dest": "document";
              };
            },
          ]
        >,
        "matches",
        { status: 200 }
      >,
      Expect<
        Invoke<
          typeof ask,
          [
            handler: Page,
            request: {
              method: "GET";
              url: "/";
              headers: {
                host: "desolate-git.localhost:31581";
                "sec-fetch-site": "cross-site";
                "sec-fetch-mode": "navigate";
                "sec-fetch-dest": "iframe";
              };
            },
          ]
        >,
        "matches",
        { status: 403 }
      >,
      Expect<
        Invoke<
          typeof ask,
          [
            handler: Page,
            request: {
              method: "GET";
              url: "/approvals-frame";
              headers: {
                host: "desolate-git.localhost:31581";
                "sec-fetch-site": "cross-site";
                "sec-fetch-mode": "navigate";
                "sec-fetch-dest": "document";
                cookie: Cookie;
              };
            },
          ]
        >,
        "matches",
        { status: 403 }
      >,
      Expect<
        Invoke<
          typeof ask,
          [
            handler: Page,
            request: {
              method: "POST";
              url: "/session";
              headers: {
                host: "desolate-git.localhost:31581";
                "sec-fetch-site": "cross-site";
                "sec-fetch-mode": "navigate";
                "sec-fetch-dest": "document";
                cookie: Cookie;
                "content-type": "application/json";
              };
              body: {};
            },
          ]
        >,
        "matches",
        { status: 403 }
      >,
    ]
  >;
  /** a shell is opened only by the page's own script: signed in, same-origin, this origin, JSON */
  export type OnlyThePage = Given<
    HasToken,
    [
      Expect<
        Invoke<
          typeof ask,
          [
            handler: Page,
            request: {
              method: "POST";
              url: "/session";
              headers: {
                host: "desolate-git.localhost:31581";
                "sec-fetch-site": "same-origin";
                "content-type": "application/json";
              };
              body: {};
            },
          ]
        >,
        "matches",
        { status: 401 }
      >,
      Expect<
        Invoke<
          typeof ask,
          [
            handler: Page,
            request: {
              method: "POST";
              url: "/session";
              headers: {
                host: "desolate-git.localhost:31581";
                cookie: Cookie;
                "content-type": "application/json";
              };
              body: {};
            },
          ]
        >,
        "matches",
        { status: 403; json: { error: "a request this page did not make" } }
      >,
      Expect<
        Invoke<
          typeof ask,
          [
            handler: Page,
            request: {
              method: "POST";
              url: "/session";
              headers: {
                host: "desolate-git.localhost:31581";
                "sec-fetch-site": "same-origin";
                origin: "http://acme-web-0a1b2c.localhost:31581";
                cookie: Cookie;
                "content-type": "application/json";
              };
              body: {};
            },
          ]
        >,
        "matches",
        {
          status: 403;
          text: "desolate: refused a request from another origin (http://acme-web-0a1b2c.localhost:31581)\n";
        }
      >,
      Expect<
        Invoke<
          typeof ask,
          [
            handler: Page,
            request: {
              method: "POST";
              url: "/session";
              headers: {
                host: "desolate-git.localhost:31581";
                "sec-fetch-site": "same-origin";
                origin: "http://desolate-git.localhost:31581";
                cookie: Cookie;
                "content-type": "text/plain";
              };
              body: "{}";
            },
          ]
        >,
        "matches",
        { status: 415 }
      >,
    ]
  >;
  /** the git VM is readied before a shell opens in it, and a VM that does not come up is said */
  export type ReadiesTheVm = Given<
    HasToken,
    Expect<
      Invoke<
        typeof ask,
        [
          handler: Invoke<
            typeof handler,
            [spawn: typeof noShell, log: typeof quiet, prepare: typeof gitVmDown]
          >,
          request: { method: "POST"; url: "/session"; headers: Script; body: { repo: "acme/web" } },
        ]
      >,
      "matches",
      { status: 502; json: { error: "the git VM could not be readied: it did not start" } }
    >
  >;
  /** a shell's input needs that shell's own token, which only the page that opened it was given */
  export type NoSuchShell = Given<
    HasToken,
    Expect<
      Invoke<
        typeof ask,
        [
          handler: Page,
          request: {
            method: "POST";
            url: "/session/0123456789abcdef/input";
            headers: Script;
            body: { token: "000000000000000000000000000000000000000000000000"; data: "bHMK" };
          },
        ]
      >,
      "matches",
      { status: 404; json: { error: "no such shell" } }
    >
  >;
  /** the approval page beside the terminal: its address, with its key in the fragment, to this
   *  page's script; and this page may frame that one and nothing else */
  export type FramesTheApprovals = Given<
    [HasToken, Invoke<typeof writeState, [name: "approve-token", text: Token]>],
    Expect<
      Invoke<
        typeof ask,
        [handler: Page, request: { method: "GET"; url: "/approvals-frame"; headers: Script }]
      >,
      "matches",
      {
        status: 200;
        headers: {
          "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'none'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; frame-src http://desolate-approve.localhost:31581";
          "x-frame-options": "DENY";
        };
        json: {
          url: "http://desolate-approve.localhost:31581/embed#k=cba2baa14dd006b2aa6983bca3c648b5ab3438eb0b303069f92240a36171f833";
        };
      }
    >
  >;
}
