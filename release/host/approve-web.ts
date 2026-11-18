// The approval page: a push waiting for a person, approved with one click in a browser on
// this Mac. Served by the host daemon (outside every VM) at APPROVE_HOSTNAME on the editors'
// port. What it shows is parsed here, on the host, from the very text that gets signed; what
// a push would send is computed in the root by the reviewer (root/reviewer.ts), a user that
// cannot push and does not parse anything the root's user hands it until the push is named.
//
// WHY A CLICK IS ENOUGH, AND WHAT IT TAKES TO FAKE ONE. The page is the only thing that can
// ask this daemon to sign, and it asks only with:
//   - a cookie given in exchange for the address `desolate approve --web` prints on this
//     Mac's terminal (HttpOnly, SameSite=Strict, a name of this stack's own). Nothing in a VM
//     has the token: it is in the host's state directory and nowhere else;
//   - a request from this page's own origin: the Host, Origin and Sec-Fetch-Site headers are
//     checked (a page an agent wrote, on a workspace's name, is another origin, and the
//     browser does not let it read this page or send these headers as this page);
//   - a per-push token in the request's body, which only this page's own script can read
//     (it is in a JSON answer no other origin can read);
//   - a JSON body (so another origin's form cannot send it at all).
// The page cannot be framed (frame-ancestors 'none', X-Frame-Options), runs no inline
// script, keeps no opener (Cross-Origin-Opener-Policy), and its button arms only after the
// page has been visible and focused for a second and the pointer then moves onto it: a click
// that was already on its way when a window opened under it lands on nothing.
//
// ONE EXCEPTION TO "CANNOT BE FRAMED": /embed, beside the git terminal. Only the git
// terminal's own origin may frame it (frame-ancestors names it exactly), so a `git push`
// and its approval are on one screen. A cookie does not reach a frame under another site
// (SameSite), so there the credential is a key derived from the token, given to the frame in
// its address's fragment (never sent to a server) by the git terminal's page, which only the
// person's browser can open, and sent back as a header: another origin can neither send that
// header here (no preflight is ever granted) nor pass the same-origin checks below. In the
// frame, the pointer over it counts as the page's attention (focus stays with the terminal
// until a click), and where the browser can say so (IntersectionObserver v2, Chrome) Approve
// arms only while the button is visibly unobscured: if script ever ran on the git terminal's
// origin, it could not lay the frame under something else and borrow a click.
import { createHash, createHmac, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as path from "node:path";
import { parseApproval } from "../shared/approval.ts";
import type { PushApproval } from "../shared/approval.ts";
import { digestOf as issueDigest, draftOf } from "../shared/issues.ts";
import type { Issue } from "../shared/issues.ts";
import { APPROVE_HOSTNAME, editorHostPort, GIT_HOSTNAME, isSlug } from "../shared/names.ts";
import { refusal, sameSecret } from "../shared/gate.ts";
import { paths, RELEASE_DIR } from "./paths.ts";
import type { SecretOps } from "./domains.ts";
import type { Choice } from "./env-import.ts";
import type { PlanRow } from "../shared/envfile.ts";
import type { Expect, Given, Invoke } from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { writeState } from "../.harness/home.ts";
import type {
  approved,
  ask,
  quiet,
  secretsSet,
  waiting,
  withSecrets,
} from "../.harness/host-web.ts";

export const TOKEN_FILE = path.join(paths.state, "approve-token");
const UI = path.join(RELEASE_DIR, "host", "approve-ui");

/** The page's credential: made once, the host's alone (0600). */
export const approveToken = (): string => {
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
export const approveAddress = () =>
  `http://${APPROVE_HOSTNAME}:${editorHostPort()}/?tkn=${approveToken()}`;
/** The key the embedded page sends (x-desolate-embed): derived, so it opens /embed's API and
 *  is not the address's token. */
const embedKey = (token: string) =>
  createHmac("sha256", Buffer.from(token, "hex"))
    .update("embed beside the git terminal")
    .digest("hex");
/** The embedded page's address, for the git terminal's page only (git-web.ts). */
export const embedAddress = () =>
  `http://${APPROVE_HOSTNAME}:${editorHostPort()}/embed#k=${embedKey(approveToken())}`;
/** The one origin that may frame /embed. */
const embedder = () => `http://${GIT_HOSTNAME}:${editorHostPort()}`;

const cookieName = (token: string) =>
  `desolate_approve_${createHash("sha256").update(token).digest("hex").slice(0, 12)}`;
/** A push's own token: tied to the credential and to the very text the page showed. The
 *  list of waiting pushes is the root's user's: if it lists another text under the same
 *  nonce by the time of the click, the token no longer matches and nothing is signed. */
export const pushToken = (token: string, message: string) =>
  createHmac("sha256", Buffer.from(token, "hex")).update(`approve\n${message}`).digest("hex");
const digestOf = (message: string) => createHash("sha256").update(message).digest("hex");
/** An issue's own token: over its id and every word the page showed (shared/issues.ts). An
 *  issue the root lists with other words by the time of the click no longer matches. */
export const issueToken = (token: string, issue: Issue) =>
  createHmac("sha256", Buffer.from(token, "hex"))
    .update(`publish issue\n${issue.id}\n${issueDigest(issue)}`)
    .digest("hex");
/** The root's account of an issue, only if every field is one desolate carries. */
const checkedIssue = (value: unknown): Issue | null => {
  const v = value as Partial<Issue> | null;
  const draft = draftOf(v);
  if (
    !v ||
    "error" in draft ||
    typeof v.id !== "string" ||
    !/^[0-9a-z]{6,12}-[0-9a-f]{8}$/.test(v.id) ||
    !isSlug(v.domain) ||
    v.state !== "approving"
  )
    return null;
  return {
    ...draft,
    id: v.id,
    domain: v.domain,
    workspace: isSlug(v.workspace) ? v.workspace : "unknown",
    at: String(v.at ?? ""),
    state: "approving",
    edited: v.edited === true,
  };
};

export const SECURITY: Record<string, string> = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};
const send = (
  res: ServerResponse,
  status: number,
  type: string,
  content: string | Buffer,
  extra: Record<string, string> = {},
) => {
  res.writeHead(status, {
    "content-type": type,
    "content-length": Buffer.byteLength(content),
    ...SECURITY,
    ...extra,
  });
  res.end(content);
};
const text = (res: ServerResponse, status: number, message: string) =>
  send(res, status, "text/plain; charset=utf-8", `desolate: ${message}\n`);
const json = (res: ServerResponse, status: number, value: unknown) =>
  send(res, status, "application/json; charset=utf-8", JSON.stringify(value));
const STATIC: Record<string, [string, string]> = {
  "/": ["approve.html", "text/html; charset=utf-8"],
  "/approve.js": ["approve.js", "text/javascript; charset=utf-8"],
  "/approve.css": ["approve.css", "text/css; charset=utf-8"],
  "/secrets": ["secrets.html", "text/html; charset=utf-8"],
  "/secrets.js": ["secrets.js", "text/javascript; charset=utf-8"],
  "/editor-defaults": ["editor-defaults.html", "text/html; charset=utf-8"],
  "/editor-defaults.js": ["editor-defaults.js", "text/javascript; charset=utf-8"],
  // Syntax colour for the diff (shared/ui/highlight.js says how it is kept to colour).
  "/highlight.js": ["../../shared/ui/highlight.js", "text/javascript; charset=utf-8"],
  "/highlight-worker.js": ["../../shared/ui/highlight-worker.js", "text/javascript; charset=utf-8"],
};

/** What a push would send, as the reviewer in the root computed it: shown as data. */
export type Summary = {
  ok: boolean;
  error?: string;
  waiting?: boolean;
  warnings?: string[];
  commits?: { commit: string; subject: string; author: string }[];
  more?: number;
  files?: { path: string; added: number; removed: number; binary?: boolean; sensitive?: boolean }[];
  moreFiles?: number;
  base?: string | null;
  remote?: string | null;
  fastForward?: boolean | null;
  lfs?: number;
  diff?: string;
  diffCut?: boolean;
};
export type Waiting = { message: string; at: string };
const SUMMARY = { deadlineMs: 90_000, keepMs: 120_000 } as const;
export type Backend = {
  /** Pushes waiting for a person, as the root lists them (the root's word: only the
   *  message is used, and it is parsed here). */
  pending: () => Promise<Waiting[]>;
  /** What the push would send, from the reviewer. */
  summary: (push: PushApproval) => Promise<Summary>;
  /** Sign the message and give the signature to the keyring. */
  approve: (message: string) => Promise<void>;
  /** Take a waiting push off the list: the push that asked is refused. */
  refuse: (message: string) => Promise<void>;
  /** Issues the person chose to publish on the dashboard, waiting here (the root's word:
   *  each is checked, and shown as it is). */
  issues: () => Promise<unknown[]>;
  /** Create it on GitHub, as the person, with the host's own gh: returns its page. */
  publishIssue: (issue: Issue) => Promise<string>;
  /** Not now: back to a draft on the dashboard. */
  refuseIssue: (issue: Issue) => Promise<void>;
  /** A domain's secrets, for /secrets (domains.ts secretOps): absent, the page has none. */
  secrets?: SecretOps;
  /** A .env into a domain's secrets (env-import.ts), for /secrets's Import: the plan (no
   *  value in it), and the import, which answers the .env with names in place of values. */
  /** Every editor's default settings (editor-defaults.ts), for /editor-defaults. */
  editorDefaults?: {
    get: () => Promise<Record<string, unknown>>;
    set: (
      settings: Record<string, unknown>,
    ) => Promise<{ settings: Record<string, unknown>; running: number; applied: number }>;
  };
  envImport?: {
    plan: (domain: string, text: string) => Promise<PlanRow[]>;
    apply: (
      domain: string,
      text: string,
      choices: Choice[],
    ) => Promise<{ rows: PlanRow[]; env: string; secrets: unknown[] }>;
  };
};

const readBody = (req: IncomingMessage, limit = 4096): Promise<string | null> =>
  new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
      if (body.length > limit) {
        resolve(null);
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", () => resolve(null));
  });

export const handler = (backend: Backend, log: (line: string) => void) => {
  // What the reviewer said of each text, by the text's own digest: a text listed again under
  // the same nonce is another push, with a summary of its own. Asked once per text, in the
  // background, with a deadline: a slow reviewer never holds up the list.
  const summaries = new Map<string, { at: number; value: Summary | null }>();
  const summaryOf = (push: PushApproval, message: string): Summary => {
    const key = digestOf(message);
    for (const [k, entry] of summaries)
      if (Date.now() - entry.at > SUMMARY.keepMs && entry.value) summaries.delete(k);
    const known = summaries.get(key);
    if (known)
      return known.value ?? { ok: false, waiting: true, error: "the reviewer is working it out" };
    const entry: { at: number; value: Summary | null } = { at: Date.now(), value: null };
    summaries.set(key, entry);
    const deadline = new Promise<Summary>((resolve) =>
      setTimeout(
        () => resolve({ ok: false, error: "the reviewer did not answer in time" }),
        SUMMARY.deadlineMs,
      ).unref(),
    );
    void Promise.race([backend.summary(push), deadline])
      .catch((error: Error): Summary => ({ ok: false, error: error.message }))
      .then((value) => {
        entry.value = value;
        entry.at = Date.now();
      });
    return { ok: false, waiting: true, error: "the reviewer is working it out" };
  };
  return async (req: IncomingMessage, res: ServerResponse) => {
    // This name only, this origin only: a page on any other name is refused before anything.
    // (Save /embed's own page, which another site loads, as a frame: it is static and holds
    // nothing, and frame-ancestors says who may show it. Everything it then asks for is a
    // same-origin request, checked as any other.)
    const url = new URL(req.url ?? "/", `http://${APPROVE_HOSTNAME}`);
    // Only as a frame (Sec-Fetch-Dest: iframe): a window another site opens on /embed would be
    // the live page, under a pointer that site chose (found by the audit of #93).
    const asFrame =
      req.method === "GET" &&
      url.pathname === "/embed" &&
      url.search === "" &&
      req.headers["sec-fetch-dest"] === "iframe";
    // The secrets page and the editor-defaults page, opened from the dashboard (another
    // site): static, and all they do is a request of their own origin with this page's cookie
    // (as the git page).
    const toSecrets =
      req.method === "GET" &&
      (url.pathname === "/secrets" || url.pathname === "/editor-defaults") &&
      req.headers["sec-fetch-mode"] === "navigate" &&
      req.headers["sec-fetch-dest"] === "document";
    const refused = refusal(APPROVE_HOSTNAME, req.headers, asFrame || toSecrets);
    // (gate.ts words its refusal for an editor: here, this page's own name and its own command.)
    if (refused)
      return text(
        res,
        refused.status,
        `refused ${refused.why.replace(/this is the editor of/, "this is the approval page at").replace("`desolate editor`", "`desolate approve --web`")}`,
      );
    if (req.method === "GET" && url.pathname === "/embed" && !asFrame)
      return text(
        res,
        403,
        "refused: /embed is the approval page beside the git terminal, and loads only as its frame",
      );
    const token = approveToken();
    const name = cookieName(token);
    const given = url.searchParams.get("tkn");
    if (req.method === "GET" && url.pathname === "/" && given !== null) {
      if (!sameSecret(given, token))
        return text(
          res,
          403,
          "refused: that is not this stack's approval address; `desolate approve --web` prints it",
        );
      res.writeHead(303, {
        location: "/",
        "set-cookie": `${name}=${token}; HttpOnly; SameSite=Strict; Path=/`,
        "content-length": 0,
        ...SECURITY,
      });
      return res.end();
    }
    const cookie = new RegExp(`(?:^|;\\s*)${name}=([0-9a-f]{48})(?:;|$)`).exec(
      String(req.headers.cookie ?? ""),
    )?.[1];
    const embedded = String(req.headers["x-desolate-embed"] ?? "");
    const signedIn =
      (cookie !== undefined && sameSecret(cookie, token)) ||
      (/^[0-9a-f]{64}$/.test(embedded) && sameSecret(embedded, embedKey(token)));
    if (req.method === "GET" && url.pathname === "/embed") {
      // The same page, framed beside the git terminal: by that origin alone.
      const { "x-frame-options": _deny, ...rest } = SECURITY;
      const content = fs.readFileSync(path.join(UI, "approve.html"));
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": content.length,
        ...rest,
        "content-security-policy": SECURITY["content-security-policy"]!.replace(
          "frame-ancestors 'none'",
          `frame-ancestors ${embedder()}`,
        ),
      });
      return res.end(content);
    }
    if (req.method === "GET" && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname]!;
      return send(res, 200, type, fs.readFileSync(path.join(UI, file)));
    }
    if (!signedIn)
      return json(res, 401, {
        error:
          "open the approval page at the address `desolate approve --web` prints, on this Mac's terminal: it carries this stack's token",
      });
    // Below, every request is this page's own script's: the same origin, said by the browser.
    if (String(req.headers["sec-fetch-site"] ?? "") !== "same-origin")
      return json(res, 403, { error: "a request this page did not make" });

    // Every editor's default settings: by this page's cookie only, as the secrets are. Not a
    // secret, but they reach every domain's editor, so not the dashboard's (which the root's
    // ordinary user serves) to change.
    if (url.pathname.startsWith("/editor-defaults/")) {
      const ops = backend.editorDefaults;
      if (!ops) return json(res, 404, { error: "no editor defaults here" });
      if (cookie === undefined || !sameSecret(cookie, token))
        return json(res, 401, {
          error:
            "open the approval page at the address `desolate approve --web` prints once: its cookie opens this page too",
        });
      if (req.method === "GET" && url.pathname === "/editor-defaults/get")
        return json(res, 200, { settings: await ops.get() });
      if (req.method !== "POST" || url.pathname !== "/editor-defaults/set")
        return json(res, 404, { error: "no such thing" });
      if (!/^application\/json(;|$)/.test(String(req.headers["content-type"] ?? "")))
        return json(res, 415, { error: "JSON only" });
      if (req.headers.origin !== `http://${APPROVE_HOSTNAME}:${editorHostPort()}`)
        return json(res, 403, { error: "a request from another origin" });
      try {
        const asked = JSON.parse((await readBody(req, 70_000)) ?? "") as { settings?: unknown };
        const done = await ops.set(asked.settings as Record<string, unknown>);
        log(`editor defaults page: ${Object.keys(done.settings).length} setting(s) saved`);
        return json(res, 200, done);
      } catch (error) {
        return json(res, 400, { error: (error as Error).message });
      }
    }
    // A domain's secrets: by this page's cookie only (not the key of the frame beside the git
    // terminal). The value of one comes in here and goes to the root's store, and is never
    // sent back: a list names each secret and where it goes.
    if (url.pathname.startsWith("/secrets/")) {
      const ops = backend.secrets;
      if (!ops) return json(res, 404, { error: "no secrets here" });
      if (cookie === undefined || !sameSecret(cookie, token))
        return json(res, 401, {
          error:
            "open the approval page at the address `desolate approve --web` prints once: its cookie opens the secrets too",
        });
      const domain = url.searchParams.get("domain") ?? "";
      if (req.method === "GET" && url.pathname === "/secrets/list") {
        try {
          const domains = await ops.domains();
          const secrets = isSlug(domain) && domains.includes(domain) ? await ops.list(domain) : [];
          return json(res, 200, { domains, secrets });
        } catch (error) {
          return json(res, 502, { error: (error as Error).message });
        }
      }
      if (req.method !== "POST") return json(res, 404, { error: "no such thing" });
      if (!/^application\/json(;|$)/.test(String(req.headers["content-type"] ?? "")))
        return json(res, 415, { error: "JSON only" });
      if (req.headers.origin !== `http://${APPROVE_HOSTNAME}:${editorHostPort()}`)
        return json(res, 403, { error: "a request from another origin" });
      let asked: Record<string, unknown>;
      try {
        // (An import carries a whole .env, of at most 64 KiB, as JSON: room for its escapes.)
        asked = JSON.parse(
          (await readBody(req, url.pathname.startsWith("/secrets/import/") ? 200_000 : 70_000)) ??
            "",
        ) as Record<string, unknown>;
      } catch {
        return json(res, 400, { error: "not JSON" });
      }
      if (!isSlug(asked.domain)) return json(res, 400, { error: "which domain?" });
      const name = String(asked.name ?? "");
      const list = (value: unknown) =>
        Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
      try {
        if (url.pathname === "/secrets/set") {
          const value = String(asked.value ?? "");
          // One line, as the terminal takes it (readSecretLine): no line breaks inside.
          if (!value || /[\r\n]/.test(value) || value.length > 65_536)
            return json(res, 400, { error: "a value is one line, of at most 64 KiB" });
          const listed = await ops.set(asked.domain, {
            name,
            value,
            hosts: list(asked.hosts),
            headers: list(asked.headers),
          });
          log(`secrets page: set ${name} for the domain ${asked.domain}`);
          return json(res, 200, { secrets: listed });
        }
        // Import a .env: the plan first (keys, where each would go and why: never a value),
        // then the import, with what the person changed on the page.
        if (url.pathname === "/secrets/import/plan" || url.pathname === "/secrets/import/apply") {
          const importer = backend.envImport;
          if (!importer) return json(res, 404, { error: "no import here" });
          const text = typeof asked.text === "string" ? asked.text : "";
          if (!text.trim()) return json(res, 400, { error: "paste a .env, or choose one" });
          if (url.pathname === "/secrets/import/plan")
            return json(res, 200, { rows: await importer.plan(asked.domain, text) });
          const choices = (Array.isArray(asked.choices) ? asked.choices : []).filter(
            (c): c is Choice =>
              typeof c === "object" &&
              c !== null &&
              typeof (c as Choice).key === "string" &&
              ["secret", "value", "local"].includes((c as Choice).kind),
          );
          const done = await importer.apply(asked.domain, text, choices);
          log(
            `secrets page: imported a .env into the domain ${asked.domain}: ${done.rows.filter((r) => r.kind === "secret").length} secret(s)`,
          );
          return json(res, 200, done);
        }
        if (url.pathname === "/secrets/switch") {
          const listed = await ops.switch(asked.domain, name, asked.on === true);
          log(`secrets page: ${name} of ${asked.domain} ${asked.on === true ? "on" : "off"}`);
          return json(res, 200, { secrets: listed });
        }
        if (url.pathname === "/secrets/remove") {
          const listed = await ops.remove(asked.domain, name);
          log(`secrets page: removed ${name} of ${asked.domain}`);
          return json(res, 200, { secrets: listed });
        }
      } catch (error) {
        return json(res, 400, { error: (error as Error).message });
      }
      return json(res, 404, { error: "no such thing" });
    }

    if (req.method === "GET" && url.pathname === "/pending") {
      const out = [];
      for (const waiting of await backend.pending().catch(() => [] as Waiting[])) {
        const push = parseApproval(waiting.message);
        if (!push) continue;
        // Everything shown is the parsed text and the reviewer's account; the root's user's own
        // words about a push are not shown at all.
        // The diff stays here until asked for (/diff): not in a list polled every second.
        const { diff, ...summary } = summaryOf(push, waiting.message);
        out.push({
          nonce: push.nonce,
          repo: push.repo,
          branch: push.branch,
          commit: push.commit,
          onto: push.onto,
          token: pushToken(token, waiting.message),
          summary: { ...summary, hasDiff: diff !== undefined },
        });
      }
      return json(res, 200, { pending: out });
    }
    if (req.method === "GET" && url.pathname === "/issues") {
      const listed = (await backend.issues().catch(() => [] as unknown[]))
        .map(checkedIssue)
        .filter((i): i is Issue => i !== null);
      return json(res, 200, {
        issues: listed.map((issue) => ({ ...issue, token: issueToken(token, issue) })),
      });
    }
    if (req.method === "POST" && url.pathname === "/issue") {
      if (!/^application\/json(;|$)/.test(String(req.headers["content-type"] ?? "")))
        return json(res, 415, { error: "JSON only" });
      if (req.headers.origin !== `http://${APPROVE_HOSTNAME}:${editorHostPort()}`)
        return json(res, 403, { error: "a request from another origin" });
      let asked: { id?: unknown; token?: unknown; do?: unknown };
      try {
        asked = JSON.parse((await readBody(req)) ?? "") as typeof asked;
      } catch {
        return json(res, 400, { error: "not JSON" });
      }
      const given = String(asked.token ?? "");
      if (!/^[0-9a-f]{64}$/.test(given))
        return json(res, 403, { error: "not an issue this page showed" });
      // The issue as the root lists it now; published only if it is the very text the page
      // showed (the token is over it).
      const issue =
        (await backend.issues()).map(checkedIssue).find((i) => i !== null && i.id === asked.id) ??
        null;
      if (!issue) return json(res, 410, { error: "that issue is no longer waiting" });
      if (!sameSecret(given, issueToken(token, issue)))
        return json(res, 409, {
          error:
            "that issue is not the one this page showed: it changed, so nothing was published; look at it again",
        });
      try {
        if (asked.do === "publish") {
          const where = await backend.publishIssue(issue);
          log(`approve page: published an issue on ${issue.repo}: ${where}`);
          return json(res, 200, { ok: true, url: where });
        }
        await backend.refuseIssue(issue);
        log(`approve page: did not publish the issue ${issue.id} on ${issue.repo}`);
        return json(res, 200, { ok: true });
      } catch (error) {
        return json(res, 502, { error: (error as Error).message });
      }
    }
    // The diff of a push this page showed: named by its nonce and the token the page was given
    // for its very text, as an approval is.
    if (req.method === "GET" && url.pathname === "/diff") {
      const nonce = url.searchParams.get("nonce") ?? "";
      const given = url.searchParams.get("token") ?? "";
      if (!/^[0-9a-f]{32}$/.test(nonce) || !/^[0-9a-f]{64}$/.test(given))
        return json(res, 403, { error: "not a push this page showed" });
      const waiting = (await backend.pending().catch(() => [] as Waiting[])).find(
        (w) => parseApproval(w.message)?.nonce === nonce,
      );
      if (!waiting || !sameSecret(given, pushToken(token, waiting.message)))
        return json(res, 410, {
          error: "that push is no longer waiting, or is not the one this page showed",
        });
      const shown = summaries.get(digestOf(waiting.message))?.value;
      if (!shown?.ok) return json(res, 404, { error: "the reviewer has not worked it out yet" });
      return json(res, 200, { diff: shown.diff ?? null, cut: shown.diffCut === true });
    }
    if (req.method === "POST" && (url.pathname === "/approve" || url.pathname === "/refuse")) {
      if (!/^application\/json(;|$)/.test(String(req.headers["content-type"] ?? "")))
        return json(res, 415, { error: "JSON only" });
      if (req.headers.origin !== `http://${APPROVE_HOSTNAME}:${editorHostPort()}`)
        return json(res, 403, { error: "a request from another origin" });
      const body = await readBody(req);
      let asked: { nonce?: unknown; token?: unknown; commit?: unknown };
      try {
        asked = JSON.parse(body ?? "") as typeof asked;
      } catch {
        return json(res, 400, { error: "not JSON" });
      }
      const nonce = String(asked.nonce ?? "");
      const given = String(asked.token ?? "");
      if (!/^[0-9a-f]{32}$/.test(nonce) || !/^[0-9a-f]{64}$/.test(given))
        return json(res, 403, { error: "not a push this page showed" });
      // The push, as the root lists it now. Signed only if it is the very text the page showed:
      // the token is over that text, so another text under the same nonce does not match.
      const waiting = (await backend.pending()).find(
        (w) => parseApproval(w.message)?.nonce === nonce,
      );
      const push = waiting ? parseApproval(waiting.message) : null;
      if (!waiting || !push)
        return json(res, 410, { error: "that push is no longer waiting (each waits two minutes)" });
      if (!sameSecret(given, pushToken(token, waiting.message)))
        return json(res, 409, {
          error:
            "that push is not the one this page showed: it changed, so nothing was signed; look at it again",
        });
      if (asked.commit !== push.commit)
        return json(res, 409, { error: "that is not the commit this push names" });
      try {
        if (url.pathname === "/approve") {
          await backend.approve(waiting.message);
          log(
            `approve page: approved ${push.repo} ${push.branch} ${push.commit}${push.onto ? ` (from ${push.onto})` : " (a new branch)"}`,
          );
        } else {
          await backend.refuse(waiting.message);
          log(`approve page: refused ${push.repo} ${push.branch} ${push.commit}`);
        }
        return json(res, 200, { ok: true });
      } catch (error) {
        return json(res, 502, { error: (error as Error).message });
      }
    }
    return json(res, 404, { error: "no such thing" });
  };
};

declare namespace handler {
  /** This stack's token, as `desolate approve --web` put it in the address. */
  type Token = "abababababababababababababababababababababababab";
  type HasToken = Invoke<typeof writeState, [name: "approve-token", text: Token]>;
  /** The cookie that address gave the person's browser: a name of this stack's own. */
  type Cookie = "desolate_approve_5e00ea51cf17=abababababababababababababababababababababababab";
  /** A push waiting, as the keyring wrote it, and another text under the same nonce. */
  type Push =
    "desolate push approval v2\nrepo: acme/web\nbranch: fix/login\ncommit: 0123456789abcdef0123456789abcdef01234567\nonto: none\nnonce: 00000000000000000000000000000001\n";
  type Swapped =
    "desolate push approval v2\nrepo: acme/web\nbranch: fix/login\ncommit: 1111111111111111111111111111111111111111\nonto: none\nnonce: 00000000000000000000000000000001\n";
  type Page = Invoke<
    typeof handler,
    [backend: Invoke<typeof waiting, [messages: [Push]]>, log: typeof quiet]
  >;
  /** What the page's own script sends: this name and origin, the browser's word that it is
   *  same-origin, the cookie, and JSON. */
  type Script = {
    host: "desolate-approve.localhost:31581";
    "sec-fetch-site": "same-origin";
    origin: "http://desolate-approve.localhost:31581";
    cookie: Cookie;
    "content-type": "application/json";
  };

  type Secrets = Invoke<typeof handler, [backend: Invoke<typeof withSecrets>, log: typeof quiet]>;
  /** the secrets page opens from the dashboard (another site); what it does needs the cookie,
   *  this origin and JSON; a value reaches the host, and only names come back */
  export type Secrets_ = Given<
    HasToken,
    [
      Expect<
        Invoke<
          typeof ask,
          [
            handler: Secrets,
            request: {
              method: "GET";
              url: "/secrets?domain=acme";
              headers: {
                host: "desolate-approve.localhost:31581";
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
            handler: Secrets,
            request: {
              method: "GET";
              url: "/secrets/list?domain=acme";
              headers: {
                host: "desolate-approve.localhost:31581";
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
            handler: Secrets,
            request: {
              method: "GET";
              url: "/secrets/list?domain=acme";
              headers: {
                host: "desolate-approve.localhost:31581";
                "sec-fetch-site": "same-origin";
              };
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
            handler: Secrets,
            request: {
              method: "GET";
              url: "/secrets/list?domain=acme";
              headers: Script;
            },
          ]
        >,
        "matches",
        {
          status: 200;
          json: {
            domains: ["acme"];
            secrets: [{ name: "NPM-TOKEN"; hosts: ["registry.npmjs.org"]; on: true }];
          };
        }
      >,
      Expect<
        Invoke<
          typeof ask,
          [
            handler: Secrets,
            request: {
              method: "POST";
              url: "/secrets/set";
              headers: {
                host: "desolate-approve.localhost:31581";
                "sec-fetch-site": "same-origin";
                origin: "http://acme-web-0a1b2c.localhost:31581";
                cookie: Cookie;
                "content-type": "application/json";
              };
              body: { domain: "acme"; name: "API"; value: "v"; hosts: ["api.example.com"] };
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
            handler: Secrets,
            request: {
              method: "POST";
              url: "/secrets/set";
              headers: Script;
              body: { domain: "acme"; name: "API"; value: "one\ntwo"; hosts: ["api.example.com"] };
            },
          ]
        >,
        "matches",
        { status: 400; json: { error: "a value is one line, of at most 64 KiB" } }
      >,
    ]
  >;
  type SetApi = Invoke<
    typeof ask,
    [
      handler: Secrets,
      request: {
        method: "POST";
        url: "/secrets/set";
        headers: Script;
        body: {
          domain: "acme";
          name: "API";
          value: "s3cret";
          hosts: ["api.example.com"];
          headers: [];
        };
      },
    ]
  >;
  /** set: what comes back names each secret and where it goes, never a value */
  export type ShowsNames = Given<
    HasToken,
    Expect<
      SetApi,
      "matches",
      { status: 200; json: { secrets: [{ name: "NPM-TOKEN" }, { name: "API"; on: true }] } }
    >
  >;
  /** and the value went to the host's secret store (here, written down), as it was typed */
  export type SetsOne = Given<
    [HasToken, SetApi],
    Expect<
      Invoke<typeof secretsSet>,
      "=",
      [{ domain: "acme"; name: "API"; value: "s3cret"; hosts: ["api.example.com"]; headers: [] }]
    >
  >;

  /** the editor-defaults page opens from the dashboard (another site); reading or changing the
   *  defaults needs this page's cookie and origin, as the secrets do */
  export type EditorDefaults_ = Given<
    HasToken,
    [
      Expect<
        Invoke<
          typeof ask,
          [
            handler: Secrets,
            request: {
              method: "GET";
              url: "/editor-defaults";
              headers: {
                host: "desolate-approve.localhost:31581";
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
            handler: Secrets,
            request: {
              method: "GET";
              url: "/editor-defaults/get";
              headers: {
                host: "desolate-approve.localhost:31581";
                "sec-fetch-site": "same-origin";
              };
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
            handler: Secrets,
            request: { method: "GET"; url: "/editor-defaults/get"; headers: Script },
          ]
        >,
        "matches",
        { status: 200; json: { settings: { "files.autoSave": "off" } } }
      >,
      Expect<
        Invoke<
          typeof ask,
          [
            handler: Secrets,
            request: {
              method: "POST";
              url: "/editor-defaults/set";
              headers: {
                host: "desolate-approve.localhost:31581";
                "sec-fetch-site": "same-origin";
                origin: "http://acme-web-0a1b2c.localhost:31581";
                cookie: Cookie;
                "content-type": "application/json";
              };
              body: { settings: { "workbench.colorTheme": "Dark+" } };
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
            handler: Secrets,
            request: {
              method: "POST";
              url: "/editor-defaults/set";
              headers: Script;
              body: { settings: { "workbench.colorTheme": "Dark+"; "files.autoSave": "off" } };
            },
          ]
        >,
        "matches",
        {
          status: 200;
          json: { settings: { "workbench.colorTheme": "Dark+"; "files.autoSave": "off" } };
        }
      >,
      Expect<
        Invoke<
          typeof ask,
          [
            handler: Secrets,
            request: {
              method: "POST";
              url: "/editor-defaults/set";
              headers: Script;
              body: { settings: ["Dark+"] };
            },
          ]
        >,
        "matches",
        { status: 400; json: { error: "editor defaults are a settings object" } }
      >,
    ]
  >;
  type ImportAsk = Invoke<
    typeof ask,
    [
      handler: Secrets,
      request: {
        method: "POST";
        url: "/secrets/import/plan";
        headers: Script;
        body: {
          domain: "acme";
          text: "OPENAI_API_KEY=sk-proj-aaaaaaaaaaaaaaaaaaaaaaaaaaaa\nPORT=3000\n";
        };
      },
    ]
  >;
  /** Import a .env: the plan names each key, what it becomes and where it goes */
  export type ImportPlans = Given<
    HasToken,
    Expect<
      ImportAsk,
      "matches",
      {
        status: 200;
        json: {
          rows: [
            {
              key: "OPENAI_API_KEY";
              kind: "secret";
              name: "OPENAI-API-KEY";
              hosts: ["api.openai.com"];
            },
            { key: "PORT"; kind: "value" },
          ];
        };
      }
    >
  >;
  /** and the import answers the .env with the secret's name in place of its value */
  export type ImportAnswersEnv = Given<
    HasToken,
    Expect<
      Invoke<
        typeof ask,
        [
          handler: Secrets,
          request: {
            method: "POST";
            url: "/secrets/import/apply";
            headers: Script;
            body: {
              domain: "acme";
              text: "OPENAI_API_KEY=sk-proj-aaaaaaaaaaaaaaaaaaaaaaaaaaaa\nPORT=3000\n";
              choices: [];
            };
          },
        ]
      >,
      "matches",
      { status: 200; json: { env: "OPENAI_API_KEY=OPENAI-API-KEY\nPORT=3000\n" } }
    >
  >;
  /** nothing pasted: said */
  export type ImportEmpty = Given<
    HasToken,
    Expect<
      Invoke<
        typeof ask,
        [
          handler: Secrets,
          request: {
            method: "POST";
            url: "/secrets/import/plan";
            headers: Script;
            body: { domain: "acme"; text: "  " };
          },
        ]
      >,
      "matches",
      { status: 400; json: { error: "paste a .env, or choose one" } }
    >
  >;

  /** the address's token is traded for a cookie a script cannot read and another site never sends */
  export type SignsIn = Given<
    HasToken,
    Expect<
      Invoke<
        typeof ask,
        [
          handler: Page,
          request: {
            method: "GET";
            url: "/?tkn=abababababababababababababababababababababababab";
            headers: { host: "desolate-approve.localhost:31581"; "sec-fetch-site": "none" };
          },
        ]
      >,
      "matches",
      {
        status: 303;
        headers: {
          location: "/";
          "set-cookie": "desolate_approve_5e00ea51cf17=abababababababababababababababababababababababab; HttpOnly; SameSite=Strict; Path=/";
        };
      }
    >
  >;
  /** an address with any other token gets nothing */
  export type WrongAddress = Given<
    HasToken,
    Expect<
      Invoke<
        typeof ask,
        [
          handler: Page,
          request: {
            method: "GET";
            url: "/?tkn=cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd";
            headers: { host: "desolate-approve.localhost:31581" };
          },
        ]
      >,
      "matches",
      {
        status: 403;
        text: "desolate: refused: that is not this stack's approval address; `desolate approve --web` prints it\n";
      }
    >
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
            url: "/pending";
            headers: { host: "acme-web-0a1b2c.localhost:31581"; cookie: Cookie };
          },
        ]
      >,
      "matches",
      {
        status: 421;
        text: "desolate: refused this is the approval page at desolate-approve.localhost; open it by that name (`desolate approve --web` prints the address)\n";
      }
    >
  >;

  /** what is waiting: the parsed text and a token over it, and only to the page's own script */
  export type ListsWhatWaits = Given<
    HasToken,
    Expect<
      Invoke<
        typeof ask,
        [
          handler: Invoke<
            typeof handler,
            [
              backend: Invoke<typeof waiting, [messages: [Push, "not an approval at all"]]>,
              log: typeof quiet,
            ]
          >,
          request: { method: "GET"; url: "/pending"; headers: Script },
        ]
      >,
      "matches",
      {
        status: 200;
        json: {
          pending: [
            {
              nonce: "00000000000000000000000000000001";
              repo: "acme/web";
              branch: "fix/login";
              commit: "0123456789abcdef0123456789abcdef01234567";
              onto: null;
              token: Invoke<typeof pushToken, [token: Token, message: Push]>;
              summary: { ok: false; waiting: true; hasDiff: false };
            },
          ];
        };
      }
    >
  >;
  /** no cookie: nothing; the cookie without the browser's same-origin word (a script, curl): nothing */
  export type NotSignedIn = Given<
    HasToken,
    [
      Expect<
        Invoke<
          typeof ask,
          [
            handler: Page,
            request: {
              method: "GET";
              url: "/pending";
              headers: {
                host: "desolate-approve.localhost:31581";
                "sec-fetch-site": "same-origin";
              };
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
              method: "GET";
              url: "/pending";
              headers: { host: "desolate-approve.localhost:31581"; cookie: Cookie };
            },
          ]
        >,
        "matches",
        { status: 403; json: { error: "a request this page did not make" } }
      >,
    ]
  >;

  /** the click: the push the page showed, by its nonce, its token and its commit, is signed */
  export type Approves = Given<
    HasToken,
    [
      Expect<
        Invoke<
          typeof ask,
          [
            handler: Page,
            request: {
              method: "POST";
              url: "/approve";
              headers: Script;
              body: {
                nonce: "00000000000000000000000000000001";
                token: Invoke<typeof pushToken, [token: Token, message: Push]>;
                commit: "0123456789abcdef0123456789abcdef01234567";
              };
            },
          ]
        >,
        "matches",
        { status: 200; json: { ok: true } }
      >,
      Expect<Invoke<typeof approved>, "=", [Push]>,
    ]
  >;
  /** the root's list now has another text under that nonce: the page's token is not over it */
  export type NotWhatWasShown = Given<
    HasToken,
    [
      Expect<
        Invoke<
          typeof ask,
          [
            handler: Invoke<
              typeof handler,
              [backend: Invoke<typeof waiting, [messages: [Swapped]]>, log: typeof quiet]
            >,
            request: {
              method: "POST";
              url: "/approve";
              headers: Script;
              body: {
                nonce: "00000000000000000000000000000001";
                token: Invoke<typeof pushToken, [token: Token, message: Push]>;
                commit: "0123456789abcdef0123456789abcdef01234567";
              };
            },
          ]
        >,
        "matches",
        {
          status: 409;
          json: {
            error: "that push is not the one this page showed: it changed, so nothing was signed; look at it again";
          };
        }
      >,
      Expect<Invoke<typeof approved>, "=", []>,
    ]
  >;
  /** the click names the commit too: a token for the right text with another commit signs nothing */
  export type NotItsCommit = Given<
    HasToken,
    Expect<
      Invoke<
        typeof ask,
        [
          handler: Page,
          request: {
            method: "POST";
            url: "/approve";
            headers: Script;
            body: {
              nonce: "00000000000000000000000000000001";
              token: Invoke<typeof pushToken, [token: Token, message: Push]>;
              commit: "1111111111111111111111111111111111111111";
            };
          },
        ]
      >,
      "matches",
      { status: 409; json: { error: "that is not the commit this push names" } }
    >
  >;
  /** what another site's form could send: not JSON, or from its own origin */
  export type NotFromAForm = Given<
    HasToken,
    [
      Expect<
        Invoke<
          typeof ask,
          [
            handler: Page,
            request: {
              method: "POST";
              url: "/approve";
              headers: {
                host: "desolate-approve.localhost:31581";
                "sec-fetch-site": "same-origin";
                origin: "http://desolate-approve.localhost:31581";
                cookie: Cookie;
                "content-type": "application/x-www-form-urlencoded";
              };
              body: "nonce=00000000000000000000000000000001";
            },
          ]
        >,
        "matches",
        { status: 415 }
      >,
      Expect<
        Invoke<
          typeof ask,
          [
            handler: Page,
            request: {
              method: "POST";
              url: "/approve";
              headers: {
                host: "desolate-approve.localhost:31581";
                "sec-fetch-site": "cross-site";
                origin: "http://acme-web-0a1b2c.localhost:31581";
                cookie: Cookie;
                "content-type": "application/json";
              };
              body: "{}";
            },
          ]
        >,
        "matches",
        {
          status: 403;
          text: "desolate: refused a request another site started (Sec-Fetch-Site: cross-site)\n";
        }
      >,
      Expect<Invoke<typeof approved>, "=", []>,
    ]
  >;

  /** /embed, beside the git terminal: framed by that origin alone, and never as a window */
  export type EmbedsOnlyAsAFrame = Given<
    HasToken,
    [
      Expect<
        Invoke<
          typeof ask,
          [
            handler: Page,
            request: {
              method: "GET";
              url: "/embed";
              headers: {
                host: "desolate-approve.localhost:31581";
                "sec-fetch-site": "cross-site";
                "sec-fetch-dest": "iframe";
              };
            },
          ]
        >,
        "matches",
        {
          status: 200;
          headers: {
            "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors http://desolate-git.localhost:31581";
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
              url: "/embed";
              headers: {
                host: "desolate-approve.localhost:31581";
                "sec-fetch-site": "cross-site";
                "sec-fetch-dest": "document";
              };
            },
          ]
        >,
        "matches",
        {
          status: 403;
          text: "desolate: refused a request another site started (Sec-Fetch-Site: cross-site)\n";
        }
      >,
      Expect<
        Invoke<
          typeof ask,
          [
            handler: Page,
            request: {
              method: "GET";
              url: "/embed";
              headers: { host: "desolate-approve.localhost:31581"; "sec-fetch-dest": "document" };
            },
          ]
        >,
        "matches",
        {
          status: 403;
          text: "desolate: refused: /embed is the approval page beside the git terminal, and loads only as its frame\n";
        }
      >,
    ]
  >;
  /** the frame signs in with a key derived from the token (given in its address's fragment);
   *  the token itself is not that key */
  export type EmbedKey = Given<
    HasToken,
    [
      Expect<
        Invoke<
          typeof ask,
          [
            handler: Page,
            request: {
              method: "GET";
              url: "/pending";
              headers: {
                host: "desolate-approve.localhost:31581";
                "sec-fetch-site": "same-origin";
                "x-desolate-embed": "cba2baa14dd006b2aa6983bca3c648b5ab3438eb0b303069f92240a36171f833";
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
              url: "/pending";
              headers: {
                host: "desolate-approve.localhost:31581";
                "sec-fetch-site": "same-origin";
                "x-desolate-embed": Token;
              };
            },
          ]
        >,
        "matches",
        { status: 401 }
      >,
    ]
  >;
}
