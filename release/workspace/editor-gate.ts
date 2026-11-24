// What stands between a browser and this workspace's editor. v2's editor-gate.ts, with the
// editor's own hostname as an argument: in v3 each workspace's editor has a hostname of its
// own (section 4.5).
//
//   node editor-gate.ts <editor hostname> <listen port> <server port>
//
// The editor's server (codium-server) listens on this VM's loopback; so does this. The
// host's forwarder reaches only this, and only for connections that named this workspace's
// editor hostname. This passes on what a browser at the editor's own page would send, and
// nothing a page anywhere else could make it send.
//
// WHY (measured against this image's VSCodium server, in v2):
//   - `?tkn=` sets the cookie `vscode-tkn=<token>; SameSite=Lax`, not HttpOnly: the
//     workbench reads it. The cookie alone authenticates, and the WebSocket upgrade takes
//     any Origin. So whatever page can read the cookie, or make the browser send it, can
//     drive the editor: its terminals, every checkout in /workspaces.
//   - With the cookie, `/vscode-remote-resource?path=<any file>` serves that file with its
//     own type, AT THE EDITOR'S ORIGIN: an HTML file from a checkout, as a page.
//
//   Host            this workspace's editor hostname, at any port. Anything else is 421.
//   Sec-Fetch-Site  `same-origin`, `none` (typed, pasted, a bookmark), or absent (not a
//                   browser). A request another site, or another port, started is refused,
//                   WebSocket upgrades included. ONE exception: a top-level navigation to
//                   `/` that carries this editor's own token in its address. That is the
//                   dashboard's "Open editor" (another site: each *.localhost name is its
//                   own), and a page that does not know the token cannot make it. Without
//                   it, the one click the dashboard offers was refused (found on the M1,
//                   in a real browser; the test had only read the link). The gate answers
//                   that navigation itself (openingPage): the editor's own answer to it is
//                   a redirect, which the browser follows as cross-site again.
//   Origin          absent, or the editor's own hostname.
//   a document      `vscode-remote-resource` opened as a page or in a frame is answered
//                   with `Content-Security-Policy: sandbox`: an opaque origin, which reads
//                   no cookie and sends none.
//
// WHERE IT RUNS, and why that is not a P5 problem: this guards the workspace's own editor
// against other pages in the person's browser. A workspace that broke its own gate would
// expose only itself. What separates workspaces from each other, which name reaches which
// VM, is the host's forwarder (host/daemon.ts), outside every VM.
import { createHash } from "node:crypto";
import { createServer, request } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as fs from "node:fs";
import { connect } from "node:net";
import type { Socket } from "node:net";
import { openedWithToken, refusal } from "../shared/gate.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Invoke, Table } from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { throughGate } from "../.harness/workspace-gate.ts";

export { openedWithToken, refusal } from "../shared/gate.ts";

const DOCUMENTS = new Set(["document", "iframe", "frame", "embed", "object", "fencedframe"]);

/** Does this response go out sandboxed? A remote resource opened as a page. */
export const sandboxes = (url: string | undefined, headers: IncomingMessage["headers"]) =>
  (url ?? "").split("?")[0]!.includes("/vscode-remote-resource") &&
  DOCUMENTS.has(String(headers["sec-fetch-dest"] ?? ""));

declare namespace sandboxes {
  /** a remote resource the browser would show as a page (or in a frame) goes out sandboxed: an
   *  HTML file from a checkout is then no page at the editor's origin */
  export type AsAPage = Table<
    typeof sandboxes,
    [
      [
        args: [
          url: "/vscode-remote-resource?path=/workspaces/acme/app/index.html",
          headers: { "sec-fetch-dest": "document" },
        ],
        expected: true,
      ],
      [
        args: [
          url: "/stable-1a2b/vscode-remote-resource?path=/workspaces/acme/app/index.html",
          headers: { "sec-fetch-dest": "iframe" },
        ],
        expected: true,
      ],
      [
        args: [url: "/vscode-remote-resource?path=/x.svg", headers: { "sec-fetch-dest": "embed" }],
        expected: true,
      ],
    ]
  >;
  /** what the workbench itself loads (a fetch, an image) is left as it is; and only the path
   *  counts, not a query that names the resource */
  export type NotAPage = Table<
    typeof sandboxes,
    [
      [
        args: [
          url: "/vscode-remote-resource?path=/workspaces/acme/app/logo.png",
          headers: { "sec-fetch-dest": "image" },
        ],
        expected: false,
      ],
      [
        args: [
          url: "/vscode-remote-resource?path=/workspaces/acme/app/index.html",
          headers: { "sec-fetch-dest": "empty" },
        ],
        expected: false,
      ],
      [
        args: [url: "/vscode-remote-resource?path=/workspaces/acme/app/index.html", headers: {}],
        expected: false,
      ],
      [
        args: [url: "/?then=/vscode-remote-resource", headers: { "sec-fetch-dest": "document" }],
        expected: false,
      ],
      [args: [url: undefined, headers: { "sec-fetch-dest": "document" }], expected: false],
    ]
  >;
}

const refuse = (res: ServerResponse, { status, why }: { status: number; why: string }) => {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(`desolate editor-gate: refused ${why}\n`);
};

/** The answer to the one navigation from another site the gate lets in (openedWithToken):
 *  the editor's cookie, as the editor's server sets it, and a page that goes on to the same
 *  address without the token, from this origin.
 *
 *  Why not the editor's own answer: it is a 302 to that address, and a redirect keeps the
 *  request's site, so the browser sent `Sec-Fetch-Site: cross-site` again, with no token in
 *  the address now, and the gate refused it; a reload of it as well (dogfooding on the M1,
 *  2026-11-17: "Open editor" on the dashboard opened a refusal, and only typing the address
 *  opened the editor). A navigation this page starts is the editor's origin's own, which the
 *  gate passes like any other: nothing more is let in than before. */
export const openingPage = (token: string, url: string) => {
  const parsed = new URL(url, "http://editor");
  parsed.searchParams.delete("tkn");
  const next = `/${parsed.search}`;
  // In a script, and in the page: JSON for the one, and nothing a parser could take as
  // markup for either.
  const inScript = JSON.stringify(next).replace(/</g, "\\u003c");
  const inPage = next.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // What the editor's server sets (measured, VSCodium 1.116): its workbench reads it.
      "set-cookie": `vscode-tkn=${token}; Max-Age=604800; SameSite=Lax`,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "content-security-policy": `default-src 'none'; script-src 'sha256-${createHash("sha256")
        .update(`location.replace(${inScript})`)
        .digest("base64")}'`,
    },
    body: `<!doctype html><meta charset="utf-8"><title>Opening the editor</title><script>location.replace(${inScript})</script><p><a href="${inPage}">Open the editor</a></p>\n`,
  };
};

declare namespace openingPage {
  /** the cookie the editor's server would set, and on to the same address without the token
   *  @incident 2026-11-17-open-editor-refused */
  export type Opens = [
    Expect<
      Invoke<
        typeof openingPage,
        [token: "0123abcd", url: "/?tkn=0123abcd&folder=%2Fworkspaces%2Facme%2Fapp"]
      >["headers"]["set-cookie"],
      "=",
      "vscode-tkn=0123abcd; Max-Age=604800; SameSite=Lax"
    >,
    Expect<
      Invoke<
        typeof openingPage,
        [token: "0123abcd", url: "/?tkn=0123abcd&folder=%2Fworkspaces%2Facme%2Fapp"]
      >["body"],
      "includes",
      'location.replace("/?folder=%2Fworkspaces%2Facme%2Fapp")'
    >,
  ];
  /** whatever else the address says stays text: no markup in the script, or in the link */
  export type Inert = [
    Expect<
      Invoke<typeof openingPage, [token: "0123abcd", url: "/?tkn=0123abcd&x=</script><b>"]>["body"],
      "includes",
      'location.replace("/?x=%3C%2Fscript%3E%3Cb%3E")'
    >,
    Expect<
      Invoke<typeof openingPage, [token: "0123abcd", url: "/?tkn=0123abcd&x=</script><b>"]>["body"],
      "excludes",
      "<b>"
    >,
  ];
}

export const gate = (editorHost: string, serverPort: number, tokenFile?: string) => {
  const token = () => {
    try {
      const value = tokenFile ? fs.readFileSync(tokenFile, "utf8").trim() : "";
      return /^[0-9a-f]{32,128}$/.test(value) ? value : null;
    } catch {
      return null;
    }
  };
  const server = createServer((req, res) => {
    const known = token();
    const opened = openedWithToken(req, known);
    const refused = refusal(editorHost, req.headers, opened);
    if (refused) return refuse(res, refused);
    if (opened && known) {
      const page = openingPage(known, req.url ?? "/");
      res.writeHead(200, page.headers);
      return res.end(page.body);
    }
    const upstream = request(
      {
        host: "127.0.0.1",
        port: serverPort,
        method: req.method,
        path: req.url,
        headers: req.headers,
      },
      (answer) => {
        const headers = { ...answer.headers };
        if (sandboxes(req.url, req.headers)) {
          headers["content-security-policy"] = "sandbox";
          headers["x-content-type-options"] = "nosniff";
        }
        res.writeHead(answer.statusCode ?? 502, answer.statusMessage, headers);
        answer.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end("desolate editor-gate: the editor did not answer\n");
    });
    req.pipe(upstream);
  });
  server.on("upgrade", (req: IncomingMessage, client: Socket, head: Buffer) => {
    const refused = refusal(editorHost, req.headers);
    if (refused) {
      client.end(
        `HTTP/1.1 ${refused.status} Refused\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\ndesolate editor-gate: refused ${refused.why}\n`,
      );
      return;
    }
    const upstream = connect(serverPort, "127.0.0.1", () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2)
        lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    const drop = () => {
      client.destroy();
      upstream.destroy();
    };
    upstream.on("error", drop);
    client.on("error", drop);
    upstream.on("close", () => client.destroy());
    client.on("close", () => upstream.destroy());
  });
  return server;
};

// The token below is what the editor's token file holds (hex, 32 to 128 digits; the real
// one is 48). "e.localhost" is the editor's hostname; the gate is reached at any port of it.
declare namespace gate {
  /** what a browser at the editor's own page sends, and what is not a browser at all: let
   *  through to the editor
   *  @principle P1 */
  export type Passes = Table<
    typeof throughGate,
    [
      /** typed, pasted or a bookmark */
      [
        args: [
          open: typeof gate,
          editorHost: "e.localhost",
          token: "0123456789abcdef0123456789abcdef",
          sent: {
            path: "/";
            headers: {
              host: "e.localhost:31581";
              "sec-fetch-site": "none";
              "sec-fetch-mode": "navigate";
              "sec-fetch-dest": "document";
            };
          },
        ],
        expected: { status: 200; reached: true; csp: null },
      ],
      /** the workbench's own requests */
      [
        args: [
          open: typeof gate,
          editorHost: "e.localhost",
          token: "0123456789abcdef0123456789abcdef",
          sent: {
            method: "POST";
            path: "/api";
            headers: {
              host: "E.Localhost:31581";
              "sec-fetch-site": "same-origin";
              origin: "http://e.localhost:31581";
            };
          },
        ],
        expected: { status: 200; reached: true; csp: null },
      ],
      /** curl inside the VM: no Sec-Fetch-Site, no Origin */
      [
        args: [
          open: typeof gate,
          editorHost: "e.localhost",
          token: null,
          sent: { path: "/version"; headers: { host: "e.localhost" } },
        ],
        expected: { status: 200; reached: true; csp: null },
      ],
    ]
  >;

  /** what another page in the person's browser could make it send: refused, and the editor
   *  never sees it
   *  @principle P1
   *  @standsIn the editor's server (throughGate)
   *  @realIn T2 06-editor, "a page somewhere else cannot drive the editor: cross-site requests and foreign origins are refused" */
  export type RefusesOtherPages = Table<
    typeof throughGate,
    [
      /** another name routed to this VM, or none: 421, the request was misdirected */
      [
        args: [
          open: typeof gate,
          editorHost: "e.localhost",
          token: null,
          sent: {
            path: "/";
            headers: { host: "other-editor.localhost:31581"; "sec-fetch-site": "none" };
          },
        ],
        expected: { status: 421; reached: false; csp: null },
      ],
      [
        args: [
          open: typeof gate,
          editorHost: "e.localhost",
          token: null,
          sent: { path: "/"; headers: { host: "e.localhost.evil.example" } },
        ],
        expected: { status: 421; reached: false; csp: null },
      ],
      /** no Host at all: node's server answers 400 before the gate is asked */
      [
        args: [
          open: typeof gate,
          editorHost: "e.localhost",
          token: null,
          sent: { path: "/"; headers: {} },
        ],
        expected: { status: 400; reached: false; csp: null },
      ],
      /** a page on another site, and one on another *.localhost name (each is its own site) */
      [
        args: [
          open: typeof gate,
          editorHost: "e.localhost",
          token: null,
          sent: {
            path: "/api";
            headers: {
              host: "e.localhost:31581";
              "sec-fetch-site": "cross-site";
              "sec-fetch-mode": "no-cors";
            };
          },
        ],
        expected: { status: 403; reached: false; csp: null },
      ],
      [
        args: [
          open: typeof gate,
          editorHost: "e.localhost",
          token: null,
          sent: {
            path: "/api";
            headers: {
              host: "e.localhost:31581";
              "sec-fetch-site": "same-site";
              "sec-fetch-mode": "cors";
            };
          },
        ],
        expected: { status: 403; reached: false; csp: null },
      ],
      /** an Origin that is not the editor's, even with no Sec-Fetch-Site to say so */
      [
        args: [
          open: typeof gate,
          editorHost: "e.localhost",
          token: null,
          sent: {
            method: "POST";
            path: "/api";
            headers: { host: "e.localhost:31581"; origin: "http://evil.localhost:31581" };
          },
        ],
        expected: { status: 403; reached: false; csp: null },
      ],
      [
        args: [
          open: typeof gate,
          editorHost: "e.localhost",
          token: null,
          sent: {
            method: "POST";
            path: "/api";
            headers: { host: "e.localhost:31581"; origin: "null" };
          },
        ],
        expected: { status: 403; reached: false; csp: null },
      ],
    ]
  >;

  /** the dashboard's "Open editor": a navigation from another site, which the gate answers
   *  itself because its address carries this editor's token (openingPage): the editor's
   *  server never sees it, and what the page then opens is a same-origin request
   *  @incident 2026-11-17-open-editor-refused */
  export type OpenedFromTheDashboard = Expect<
    Invoke<
      typeof throughGate,
      [
        open: typeof gate,
        editorHost: "e.localhost",
        token: "0123456789abcdef0123456789abcdef",
        sent: {
          path: "/?tkn=0123456789abcdef0123456789abcdef";
          headers: {
            host: "e.localhost:31581";
            "sec-fetch-site": "cross-site";
            "sec-fetch-mode": "navigate";
            "sec-fetch-dest": "document";
          };
        },
      ]
    >,
    "matches",
    { status: 200; reached: false }
  >;

  /** that exception and nothing near it: a wrong token, a frame, a fetch, another path or
   *  method, a token file that is missing or not a token, a foreign Origin
   *  @principle P1 */
  export type OnlyThatNavigation = Table<
    typeof throughGate,
    [
      [
        args: [
          open: typeof gate,
          editorHost: "e.localhost",
          token: "0123456789abcdef0123456789abcdef",
          sent: {
            path: "/?tkn=0123456789abcdef0123456789abcdee";
            headers: {
              host: "e.localhost";
              "sec-fetch-site": "cross-site";
              "sec-fetch-mode": "navigate";
              "sec-fetch-dest": "document";
            };
          },
        ],
        expected: { status: 403; reached: false; csp: null },
      ],
      [
        args: [
          open: typeof gate,
          editorHost: "e.localhost",
          token: "0123456789abcdef0123456789abcdef",
          sent: {
            path: "/?tkn=0123456789abcdef0123456789abcdef";
            headers: {
              host: "e.localhost";
              "sec-fetch-site": "cross-site";
              "sec-fetch-mode": "navigate";
              "sec-fetch-dest": "iframe";
            };
          },
        ],
        expected: { status: 403; reached: false; csp: null },
      ],
      [
        args: [
          open: typeof gate,
          editorHost: "e.localhost",
          token: "0123456789abcdef0123456789abcdef",
          sent: {
            path: "/?tkn=0123456789abcdef0123456789abcdef";
            headers: {
              host: "e.localhost";
              "sec-fetch-site": "cross-site";
              "sec-fetch-mode": "cors";
              "sec-fetch-dest": "empty";
            };
          },
        ],
        expected: { status: 403; reached: false; csp: null },
      ],
      [
        args: [
          open: typeof gate,
          editorHost: "e.localhost",
          token: "0123456789abcdef0123456789abcdef",
          sent: {
            path: "/vscode-remote-resource?path=/etc/passwd&tkn=0123456789abcdef0123456789abcdef";
            headers: {
              host: "e.localhost";
              "sec-fetch-site": "cross-site";
              "sec-fetch-mode": "navigate";
              "sec-fetch-dest": "document";
            };
          },
        ],
        expected: { status: 403; reached: false; csp: null },
      ],
      [
        args: [
          open: typeof gate,
          editorHost: "e.localhost",
          token: "0123456789abcdef0123456789abcdef",
          sent: {
            method: "POST";
            path: "/?tkn=0123456789abcdef0123456789abcdef";
            headers: {
              host: "e.localhost";
              "sec-fetch-site": "cross-site";
              "sec-fetch-mode": "navigate";
              "sec-fetch-dest": "document";
            };
          },
        ],
        expected: { status: 403; reached: false; csp: null },
      ],
      /** an empty token, or one too short to be the editor's, is no token: nothing matches it */
      [
        args: [
          open: typeof gate,
          editorHost: "e.localhost",
          token: "",
          sent: {
            path: "/?tkn=";
            headers: {
              host: "e.localhost";
              "sec-fetch-site": "cross-site";
              "sec-fetch-mode": "navigate";
              "sec-fetch-dest": "document";
            };
          },
        ],
        expected: { status: 403; reached: false; csp: null },
      ],
      [
        args: [
          open: typeof gate,
          editorHost: "e.localhost",
          token: "0123abcd",
          sent: {
            path: "/?tkn=0123abcd";
            headers: {
              host: "e.localhost";
              "sec-fetch-site": "cross-site";
              "sec-fetch-mode": "navigate";
              "sec-fetch-dest": "document";
            };
          },
        ],
        expected: { status: 403; reached: false; csp: null },
      ],
      [
        args: [
          open: typeof gate,
          editorHost: "e.localhost",
          token: null,
          sent: {
            path: "/?tkn=0123456789abcdef0123456789abcdef";
            headers: {
              host: "e.localhost";
              "sec-fetch-site": "cross-site";
              "sec-fetch-mode": "navigate";
              "sec-fetch-dest": "document";
            };
          },
        ],
        expected: { status: 403; reached: false; csp: null },
      ],
      [
        args: [
          open: typeof gate,
          editorHost: "e.localhost",
          token: "0123456789abcdef0123456789abcdef",
          sent: {
            path: "/?tkn=0123456789abcdef0123456789abcdef";
            headers: {
              host: "e.localhost";
              "sec-fetch-site": "cross-site";
              "sec-fetch-mode": "navigate";
              "sec-fetch-dest": "document";
              origin: "http://evil.example";
            };
          },
        ],
        expected: { status: 403; reached: false; csp: null },
      ],
    ]
  >;

  /** WebSocket upgrades (the editor's terminals and files): the editor's own page only. The
   *  token exception is for loading the page, never for a socket
   *  @principle P1 */
  export type Upgrades = Table<
    typeof throughGate,
    [
      [
        args: [
          open: typeof gate,
          editorHost: "e.localhost",
          token: "0123456789abcdef0123456789abcdef",
          sent: {
            path: "/?reconnectionToken=r1";
            headers: {
              host: "e.localhost:31581";
              connection: "Upgrade";
              upgrade: "websocket";
              "sec-fetch-site": "same-origin";
              origin: "http://e.localhost:31581";
            };
          },
        ],
        expected: { status: 101; reached: true; csp: null },
      ],
      [
        args: [
          open: typeof gate,
          editorHost: "e.localhost",
          token: "0123456789abcdef0123456789abcdef",
          sent: {
            path: "/?tkn=0123456789abcdef0123456789abcdef";
            headers: {
              host: "e.localhost:31581";
              connection: "Upgrade";
              upgrade: "websocket";
              "sec-fetch-site": "cross-site";
              "sec-fetch-mode": "websocket";
            };
          },
        ],
        expected: { status: 403; reached: false; csp: null },
      ],
      [
        args: [
          open: typeof gate,
          editorHost: "e.localhost",
          token: null,
          sent: {
            path: "/";
            headers: {
              host: "e.localhost:31581";
              connection: "Upgrade";
              upgrade: "websocket";
              origin: "http://evil.example";
            };
          },
        ],
        expected: { status: 403; reached: false; csp: null },
      ],
      [
        args: [
          open: typeof gate,
          editorHost: "e.localhost",
          token: null,
          sent: {
            path: "/";
            headers: { host: "other.localhost"; connection: "Upgrade"; upgrade: "websocket" };
          },
        ],
        expected: { status: 421; reached: false; csp: null },
      ],
    ]
  >;

  /** a checkout's HTML file, opened as a page at the editor's origin, comes back sandboxed; the
   *  same file fetched by the workbench does not */
  export type SandboxesRemoteResources = Table<
    typeof throughGate,
    [
      [
        args: [
          open: typeof gate,
          editorHost: "e.localhost",
          token: null,
          sent: {
            path: "/vscode-remote-resource?path=/workspaces/acme/app/index.html";
            headers: {
              host: "e.localhost";
              "sec-fetch-site": "same-origin";
              "sec-fetch-dest": "document";
            };
          },
        ],
        expected: { status: 200; reached: true; csp: "sandbox" },
      ],
      [
        args: [
          open: typeof gate,
          editorHost: "e.localhost",
          token: null,
          sent: {
            path: "/vscode-remote-resource?path=/workspaces/acme/app/index.html";
            headers: {
              host: "e.localhost";
              "sec-fetch-site": "same-origin";
              "sec-fetch-dest": "empty";
            };
          },
        ],
        expected: { status: 200; reached: true; csp: null },
      ],
    ]
  >;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [editorHost, listen, serverPort, tokenFile] = [
    process.argv[2] ?? "",
    Number(process.argv[3]),
    Number(process.argv[4]),
    process.argv[5],
  ];
  if (
    !/^[a-z0-9-]+\.localhost$/.test(editorHost) ||
    !Number.isInteger(listen) ||
    !Number.isInteger(serverPort)
  ) {
    console.error(
      "usage: editor-gate.ts <editor hostname> <listen port> <server port> [<token file>]",
    );
    process.exit(2);
  }
  gate(editorHost, serverPort, tokenFile).listen(listen, "127.0.0.1", () =>
    console.log(`editor-gate: ${editorHost} on 127.0.0.1:${listen} -> 127.0.0.1:${serverPort}`),
  );
}
