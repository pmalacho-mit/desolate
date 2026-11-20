// The credential of desolate's own pages (the approval page and the git terminal, served by
// the host; the dashboard, served by the root), in two parts, and why.
//
// A browser sends a name's cookies to every port of that name. So any program that listens on
// a port of 127.0.0.1, once the browser visits `desolate-approve.localhost:<its port>` (a link
// on any web page can send it there), is sent the page's cookie. A cookie alone was the whole
// credential: with it, that program could approve a push that is waiting (the audit of
// 2026-11-20, docs/v3/decisions.md). Now a request needs both:
//   - the cookie, HttpOnly, as before; and
//   - a key the page's own script keeps in its origin's storage, which is the scheme, the name
//     AND the port, and sends with each request (x-desolate-key). A page at another port of
//     the name cannot read it.
// Both are derived from the page's token, which the host (or the root, for the dashboard)
// keeps, and which only the page's sign-in addresses carry. Derived one way: the cookie is not
// the token, so a cookie that leaks cannot sign in (`?tkn=` takes only the token) and cannot be
// turned into the key. The key reaches the page in the sign-in answer only, a page of the
// origin's own that keeps it (shared/ui/page-key.js) and goes on.
//
// What this does not stop: a program that holds the page's own port (while the daemon is not
// running), which is then that origin; or a script running in the page itself.
import { createHmac } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { sameSecret } from "./gate.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Invoke, Table } from "../../suede.nests/dsl.import.meta.vitest.ts";

const derived = (token: string, purpose: string) =>
  createHmac("sha256", Buffer.from(token, "hex")).update(purpose).digest("hex");

/** The cookie's value: derived from the token, never the token. */
export const cookieValue = (token: string) => derived(token, "desolate page cookie");
/** The key the page keeps in its own storage and sends as x-desolate-key. */
export const pageKey = (token: string) => derived(token, "desolate page key");

declare namespace cookieValue {
  /** 64 hex, and not the token: a cookie that leaks is not a sign-in address */
  export type FromToken = Expect<
    Invoke<typeof cookieValue, [token: "abababababababababababababababababababababababab"]>,
    "=",
    "a68dde9918abf2477e02d622c6f39ef452f5b629efb668fbe721f74a83b5665c"
  >;
}
declare namespace pageKey {
  /** another value from the same token: the cookie does not give the key */
  export type FromToken = Expect<
    Invoke<typeof pageKey, [token: "abababababababababababababababababababababababab"]>,
    "=",
    "d06d2405795a703a9cc213d47a96539f21c9f2e783374a7b0ded41d75a690f59"
  >;
}

/** The value of the cookie `name` in a request's headers, if it is one of ours in shape. */
export const cookieIn = (headers: IncomingHttpHeaders, name: string): string | undefined =>
  new RegExp(`(?:^|;\\s*)${name}=([0-9a-f]{64})(?:;|$)`).exec(String(headers.cookie ?? ""))?.[1];

/** Does a request carry this page's whole credential: its cookie, and its key (in the header;
 *  or, where `query` is given, as `key=` in the address, for an EventSource, which cannot
 *  send a header)? */
export const carriesCredential = (
  headers: IncomingHttpHeaders,
  name: string,
  token: string,
  query?: URLSearchParams,
): boolean => {
  const cookie = cookieIn(headers, name);
  const key = String(headers["x-desolate-key"] ?? query?.get("key") ?? "");
  return (
    cookie !== undefined &&
    sameSecret(cookie, cookieValue(token)) &&
    sameSecret(key, pageKey(token))
  );
};

declare namespace carriesCredential {
  type Token = "abababababababababababababababababababababababab";
  type Cookie = "desolate_x=a68dde9918abf2477e02d622c6f39ef452f5b629efb668fbe721f74a83b5665c";
  type Key = "d06d2405795a703a9cc213d47a96539f21c9f2e783374a7b0ded41d75a690f59";
  /** both parts open the page; either alone does not, nor the token sent as the cookie (what an
   *  older desolate set), nor a key in the address where none is taken */
  export type Cases = Table<
    typeof carriesCredential,
    [
      [
        args: [
          headers: { cookie: Cookie; "x-desolate-key": Key },
          name: "desolate_x",
          token: Token,
        ],
        expected: true,
      ],
      [args: [headers: { cookie: Cookie }, name: "desolate_x", token: Token], expected: false],
      [
        args: [headers: { "x-desolate-key": Key }, name: "desolate_x", token: Token],
        expected: false,
      ],
      [
        args: [
          headers: { cookie: `desolate_x=${Token}`; "x-desolate-key": Key },
          name: "desolate_x",
          token: Token,
        ],
        expected: false,
      ],
      [
        args: [
          headers: { cookie: Cookie; "x-desolate-key": "00" },
          name: "desolate_x",
          token: Token,
        ],
        expected: false,
      ],
    ]
  >;
}

/** What a sign-in answers, on the page's own origin: a page that keeps the key in this origin's
 *  storage and goes on to `next` (this page, or the next page's sign-in link). Served with the
 *  cookie. Nothing in it runs but desolate's own script (the pages' CSP: script-src 'self'). */
export const signedInPage = (token: string, next: string) =>
  `<!doctype html><meta charset="utf-8"><meta name="desolate-key" content="${pageKey(token)}"><meta name="desolate-next" content="${next.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")}"><title>desolate</title><script src="/page-key.js"></script><p>Signed in.</p>\n`;

/** The script that page loads: served at /page-key.js by each page, with no credential (it holds
 *  none). */
export const PAGE_KEY_SCRIPT = ["shared", "ui", "page-key.js"] as const;
