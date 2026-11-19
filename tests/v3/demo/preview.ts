// The dashboard and the approval page, on fixtures: for working on how they look, with no
// stack. Each page's own HTML and script, as shipped; its data from tests/v3/demo/fixtures/;
// its stylesheet the shipped one, then (?theme=) an overlay from tests/v3/demo/themes/<name>/.
//
//   node tests/v3/demo/preview.ts [port]      (default 4790)
//   http://desolate.localhost:4790/?theme=quiet           the dashboard, in that theme
//   http://desolate.localhost:4790/?theme=quiet&review    with the review open
//   http://desolate-approve.localhost:4790/?theme=quiet   the approval page, a push waiting
//   (?theme=shipped, or none: the stylesheets as they ship)
//
// Nothing here is the product: it never runs anything, and every action answers "ok" without
// doing it. It listens on 127.0.0.1 only.
import * as fs from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const RELEASE = path.resolve(HERE, "../../../release");
const FIXTURES = path.join(HERE, "fixtures");
const THEMES = path.join(HERE, "themes");
const PORT = Number(process.argv[2] ?? 4790);
const read = (name: string) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8"));

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};
const send = (res: ServerResponse, status: number, type: string, body: string | Buffer) => {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
};
const json = (res: ServerResponse, value: unknown) =>
  send(res, 200, TYPES[".json"]!, JSON.stringify(value));
const file = (res: ServerResponse, at: string) =>
  send(res, 200, TYPES[path.extname(at)]!, fs.readFileSync(at));

/** The theme a page asked for (?theme=, kept in a cookie for its stylesheet's request). */
const themeOf = (req: IncomingMessage, url: URL) => {
  const asked =
    url.searchParams.get("theme") ??
    /(?:^|; )theme=([a-z0-9-]+)/.exec(String(req.headers.cookie ?? ""))?.[1];
  return asked && /^[a-z0-9-]+$/.test(asked) && fs.existsSync(path.join(THEMES, asked))
    ? asked
    : "shipped";
};
/** A theme is an overlay: the shipped stylesheet, then the theme's, which says only what it
 *  changes (every rule the pages rely on stays, unless a theme overrides it). */
const styled = (res: ServerResponse, theme: string, sheet: string, shipped: string) =>
  send(
    res,
    200,
    TYPES[".css"]!,
    fs.readFileSync(shipped, "utf8") +
      (theme === "shipped"
        ? ""
        : `\n/* ---- theme: ${theme} ---- */\n${fs.readFileSync(path.join(THEMES, theme, sheet), "utf8")}`),
  );
const page = (res: ServerResponse, url: URL, theme: string, html: string) => {
  res.setHeader("set-cookie", `theme=${theme}; Path=/; SameSite=Lax`);
  let text = fs.readFileSync(html, "utf8");
  // ?review: the dashboard opens its first offer's review, as a click on Review would.
  if (url.searchParams.has("review"))
    text = text.replace("</body>", `<script src="/preview-review.js"></script></body>`);
  send(res, 200, TYPES[".html"]!, text);
};

const dashboard = (req: IncomingMessage, res: ServerResponse, url: URL) => {
  const ui = path.join(RELEASE, "root/ui");
  const shared = path.join(RELEASE, "shared/ui");
  const theme = themeOf(req, url);
  const { review, diff } = read("review.json");
  switch (url.pathname) {
    case "/":
      return page(res, url, theme, path.join(ui, "dashboard.html"));
    case "/ui.css":
      return styled(res, theme, "dashboard.css", path.join(ui, "dashboard.css"));
    case "/ui.js":
      return file(res, path.join(ui, "dashboard.js"));
    case "/highlight.js":
    case "/highlight-worker.js":
    case "/markdown.js":
      return file(res, path.join(shared, url.pathname.slice(1)));
    case "/preview-review.js":
      return send(
        res,
        200,
        TYPES[".js"]!,
        `setTimeout(() => document.querySelector("[data-offer] button")?.click(), 400);`,
      );
    case "/state":
      return json(res, read("state.json"));
    case "/events":
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      res.write(`data: ${JSON.stringify(read("state.json"))}\n\n`);
      return; // kept open, as the real one is
    case "/review":
      return json(res, review);
    case "/diff":
      return json(res, diff);
    default:
      return json(res, { ok: true });
  }
};

const approvals = (req: IncomingMessage, res: ServerResponse, url: URL) => {
  const ui = path.join(RELEASE, "host/approve-ui");
  const theme = themeOf(req, url);
  const { pending, issues, diff } = read("approve.json");
  switch (url.pathname) {
    case "/":
      return page(res, url, theme, path.join(ui, "approve.html"));
    case "/approve.css":
      return styled(res, theme, "approve.css", path.join(ui, "approve.css"));
    case "/approve.js":
      return file(res, path.join(ui, "approve.js"));
    case "/highlight.js":
    case "/highlight-worker.js":
      return file(res, path.join(RELEASE, "shared/ui", url.pathname.slice(1)));
    case "/pending":
      return json(res, { pending });
    case "/issues":
      return json(res, { issues });
    case "/diff":
      return json(res, { diff, cut: false });
    default:
      return json(res, { ok: true });
  }
};

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://preview");
  const host = String(req.headers.host ?? "").replace(/:\d+$/, "");
  if (host === "desolate-approve.localhost") return approvals(req, res, url);
  return dashboard(req, res, url);
}).listen(PORT, "127.0.0.1", () =>
  process.stderr.write(
    `preview: http://desolate.localhost:${PORT}/?theme=<name>  and  http://desolate-approve.localhost:${PORT}/?theme=<name>\n` +
      `themes: shipped, ${fs.existsSync(THEMES) ? fs.readdirSync(THEMES).join(", ") : "(none yet)"}\n`,
  ),
);
