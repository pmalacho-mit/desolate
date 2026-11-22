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
import { setTimeout as delay } from "node:timers/promises";
import { parseApproval, signedFor } from "../shared/approval.ts";
import type { PushApproval } from "../shared/approval.ts";
import { digestOf as issueDigest, draftOf } from "../shared/issues.ts";
import type { Issue } from "../shared/issues.ts";
import { APPROVE_HOSTNAME, editorHostPort, GIT_HOSTNAME, isSlug } from "../shared/names.ts";
import { refusal, sameSecret } from "../shared/gate.ts";
import { carriesCredential, cookieValue, signedInPage } from "../shared/page-key.ts";
import { paths, RELEASE_DIR } from "./paths.ts";
import { signins } from "./signin.ts";
import type { SecretOps } from "./domains.ts";
import { ENV_MAX } from "./env-import.ts";
import type { Choice } from "./env-import.ts";
import { over } from "../shared/limits.ts";
import { printable } from "../shared/text.ts";
import type { Account, AccountLine, AccountRequest, DiffPage } from "../shared/review-account.ts";
import type { Listed } from "../shared/listed.ts";
import type { PlanRow } from "../shared/envfile.ts";
import type { Expect, Given, Invoke } from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { writeState } from "../.harness/home.ts";
import type { mint } from "./signin.ts";
import type {
  approved,
  ask,
  askedCount,
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
/** The token over the very account the page was given for a push's text: an approval names
 *  it, so what is signed is that account and no other, even if the host has since been given
 *  another for the same text (the push left the list and came back, and was asked again). */
export const shownToken = (token: string, message: string, account: unknown) =>
  createHmac("sha256", Buffer.from(token, "hex"))
    .update(`account\n${digestOf(message)}\n${digestOf(JSON.stringify(account))}`)
    .digest("hex");
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

// img-src data: is for the kinds' icons, which the page's own stylesheet draws as data: masks.
// A data: image makes no request, so it carries nothing out; only desolate's own style and
// script can place one, and the Markdown preview draws an image as a link, never as an image.
export const SECURITY: Record<string, string> = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
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
  // The page key's keeper (shared/page-key.ts): every page here loads it first.
  "/page-key.js": ["../../shared/ui/page-key.js", "text/javascript; charset=utf-8"],
  "/highlight-worker.js": ["../../shared/ui/highlight-worker.js", "text/javascript; charset=utf-8"],
};

/** What the page is given of desolate's reviewer's account of a push (shared/review-account.ts):
 *  all of it but its key, which names it to the reviewer and is the host's to keep. */
export type Shown = Omit<Account, "key">;
/** Where desolate's reviewer is with a push, as the page is told: still working (what it said
 *  it is doing, and for how long), its account, or why it has none. */
export type Review =
  | { working: { phase: string; done?: number; of?: number; seconds: number } }
  | { account: Shown }
  | { error: string };
export type Waiting = { message: string; at: string };
export type PusherSaid = {
  type: string;
  repo: string;
  branch: string;
  commit: string;
  error?: string;
};
/** How a push this page approved ended, as the pusher said: told to the page by the token
 *  over the very text signed (another text under the same nonce is another push). */
type Outcome = { token: string; pushed: boolean; error?: string; link?: string };
export type Backend = {
  /** Pushes waiting for a person, as the root lists them (the root's word: only the message
   *  is used, and it is parsed here), once they are not the list `since` tags (root/
   *  approvals.ts, pendingAfter): waited on for as long as `signal` holds. "" is answered at
   *  once. */
  pending: (since: string, signal: AbortSignal) => Promise<{ tag: string; pending: Waiting[] }>;
  /** A question to desolate's reviewer, and its answer as it streams: what it is doing, then
   *  the one answer (shared/review-account.ts). It works for as long as `signal` holds. */
  summary: (request: AccountRequest, signal: AbortSignal) => AsyncIterable<AccountLine>;
  /** Sign the approval text (the challenge with what the reviewer says the push sends:
   *  shared/approval.ts, signedFor) and give the signature to the keyring. */
  approve: (signed: string) => Promise<void>;
  /** Take a waiting push off the list: the push that asked is refused. */
  refuse: (message: string) => Promise<void>;
  /** Issues the person chose to publish on the dashboard, waiting here (the root's word:
   *  each is checked, and shown as it is). */
  issues: () => Promise<unknown[]>;
  /** Create it on GitHub, as the person, with the host's own gh: returns its page. */
  publishIssue: (issue: Issue) => Promise<string>;
  /** Not now: back to a draft on the dashboard. */
  refuseIssue: (issue: Issue) => Promise<void>;
  /** The pusher's word on each push as it ends (host/events.ts, pusherEvent: from a log only
   *  root writes), heard until the answer is called. `github`: the forge is GitHub. */
  pushes: (heard: (said: PusherSaid) => void) => () => void;
  github: () => boolean;
  /** A domain's secrets, for /secrets (domains.ts secretOps): absent, the page has none. */
  secrets?: SecretOps;
  /** Every editor's default settings (editor-defaults.ts), for /editor-defaults. */
  editorDefaults?: {
    get: () => Promise<Record<string, unknown>>;
    set: (
      settings: Record<string, unknown>,
    ) => Promise<{ settings: Record<string, unknown>; running: number; applied: number }>;
  };
  /** A .env into a domain's secrets (env-import.ts), for /secrets's Import: the plan (no
   *  value in it), and the import, which answers the .env with names in place of values. */
  envImport?: {
    plan: (domain: string, text: string) => Promise<PlanRow[]>;
    apply: (
      domain: string,
      text: string,
      choices: Choice[],
    ) => Promise<{ rows: PlanRow[]; env: string; secrets: unknown[] }>;
  };
};

// What a request's body may be, in bytes. Each is a hard bound against whatever can reach this
// port (R7): the page's own script sends far less, and a body over it is refused as that.
/** A click (/approve, /refuse, /issue): a nonce, a token, a commit and a word or two. */
const CLICK_BYTES = 4096;
/** A secret's value, in bytes: one line, as the terminal takes one (readSecretLine). */
const SECRET_BYTES = 64 * 1024;
/** What JSON makes of one byte at worst: `\u0000`. */
const ESCAPED = 6;
/** Room beside a value or a .env for the rest of the request (a name, its hosts, choices). */
const BESIDE = 16 * 1024;
/** /secrets/set and the editor defaults: a value (or the defaults, of the same 64 KiB:
 *  editor-defaults.ts), JSON-escaped, and the rest. */
const SECRET_BODY_BYTES = ESCAPED * SECRET_BYTES + BESIDE;
/** /secrets/import/: a whole .env (env-import.ts, ENV_MAX), JSON-escaped, and the rest. */
const IMPORT_BODY_BYTES = ESCAPED * ENV_MAX + BESIDE;

/** A request's body, as text; or, past `limit` bytes, the sentence that says so (the rest is
 *  not read); null if the request failed. */
const readBody = (req: IncomingMessage, limit: number): Promise<string | { over: string } | null> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        // Read no more of it: the refusal is answered, and then the connection is closed.
        req.pause();
        req.removeAllListeners("data");
        resolve({ over: over("the request", limit, size, "bytes", "this page takes") });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(null));
  });
/** A request's body as JSON: the object, or the answer that refuses it (too large, not JSON). */
const jsonBody = async (
  req: IncomingMessage,
  res: ServerResponse,
  limit: number,
): Promise<{ asked: Record<string, unknown> } | { status: number; error: string }> => {
  const body = await readBody(req, limit);
  if (body !== null && typeof body === "object") {
    res.once("finish", () => req.destroy());
    return { status: 413, error: body.over };
  }
  try {
    const asked: unknown = JSON.parse(body ?? "");
    if (typeof asked === "object" && asked !== null && !Array.isArray(asked))
      return { asked: asked as Record<string, unknown> };
  } catch {
    /* said below */
  }
  return { status: 400, error: "not JSON" };
};

const isSends = (v: unknown): v is Account["sends"] => {
  const sends = v as Partial<Account["sends"]> | null;
  return (
    typeof sends === "object" &&
    sends !== null &&
    typeof sends.pack === "string" &&
    /^[0-9a-f]{64}$/.test(sends.pack) &&
    Number.isSafeInteger(sends.size) &&
    Number.isSafeInteger(sends.lfs?.count) &&
    Number.isSafeInteger(sends.lfs?.bytes) &&
    /^[0-9a-f]{64}$/.test(String(sends.lfs?.digest))
  );
};
/** Each entry of a list, as the page and the terminal read it: its texts are text, its
 *  counts are counts. (shared/review-account.ts checks a list's shape; its entries are their
 *  reader's to check.) */
const ENTRY: Record<"commits" | "files" | "between", (item: Record<string, unknown>) => boolean> = {
  commits: (c) =>
    typeof c.commit === "string" && typeof c.subject === "string" && typeof c.author === "string",
  files: (f) =>
    typeof f.path === "string" && Number.isSafeInteger(f.added) && Number.isSafeInteger(f.removed),
  between: (f) => typeof f.path === "string",
};
export const isListed = (v: unknown, list: "commits" | "files" | "between"): boolean => {
  const listed = v as Partial<Listed<Record<string, unknown>>> | null;
  return (
    typeof listed === "object" &&
    listed !== null &&
    Array.isArray(listed.items) &&
    listed.items.every((item) => typeof item === "object" && item !== null && ENTRY[list](item)) &&
    Number.isSafeInteger(listed.total) &&
    Number.isSafeInteger(listed.from)
  );
};
/** The reviewer's account, if it is one in every part that is signed or counted: what it
 *  sends (and its squash's), its lists, its warnings. Else why not, as the reviewer's error.
 *  (The reviewer is root's; this is what makes a mistake in it a refusal, never a signature
 *  over a pack named by nothing.) The terminal's prompt reads it so too (push.ts). */
export const checkedAccount = (value: unknown): { account: Account } | { error: string } => {
  const a = value as Partial<Account> | null;
  const squash = a?.squash;
  if (
    typeof a !== "object" ||
    a === null ||
    typeof a.key !== "string" ||
    !Array.isArray(a.warnings) ||
    !a.warnings.every((w) => typeof w === "string") ||
    !isListed(a.commits, "commits") ||
    !isListed(a.files, "files") ||
    !isListed(a.between, "between") ||
    (a.base !== null && typeof a.base !== "string") ||
    !isSends(a.sends) ||
    ![true, false, null].includes(a.fastForward as boolean | null) ||
    (squash !== undefined &&
      (typeof squash !== "object" ||
        squash === null ||
        typeof squash.commit !== "string" ||
        !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(squash.commit) ||
        typeof squash.message !== "string" ||
        (squash.parent !== null && typeof squash.parent !== "string") ||
        ![squash.author, squash.committer, squash.dates].every((t) => typeof t === "string") ||
        !isSends(squash.sends)))
  )
    return { error: "the reviewer's account of the push is not one desolate can read" };
  return { account: a as Account };
};

// How much of the reviewer the page asks for. Hard bounds against the root's ordinary user,
// which lists the pushes waiting and can list as many as it likes (R7): each push listed is a
// question to the reviewer, a process in the root and on this Mac, and an account held here.
/** Questions answered at once: the rest wait their turn, and say so. A person reads one push
 *  at a time; four is room for a push from each of a few places at once. */
const ASKING_MOST = 4;
/** Pushes the page keeps an account of: past it, a push is listed and said to wait. Far more
 *  than a person has waiting; at the account's own bound (8 MiB a line) it is 256 MiB. */
const LISTED_MOST = 32;
/** Approvals whose end the page is told of: the last few are all a person looks back at. */
const OUTCOMES_KEPT = 16;
/** How long the pusher's log is followed for an approval it has not said the end of: a push
 *  ends in seconds, a large one in minutes. Past it, the dashboard's activity says. */
const HEARD_MS = 30 * 60_000;

/** GitHub's page for opening a pull request of `branch`, into the repository's default branch
 *  (GitHub's choice when the address names no base): the person opens it signed in as
 *  themselves. From the names the person signed, each part escaped. */
const pullRequestPage = (repo: string, branch: string) =>
  `https://github.com/${[repo, "compare", branch].join("/").split("/").map(encodeURIComponent).join("/")}?expand=1`;

/** The one answer to a question asked of the reviewer, past what it says while it works. */
const answerOf = async (lines: AsyncIterable<AccountLine>): Promise<AccountLine | null> => {
  for await (const line of lines) if (!("progress" in line)) return line;
  return null;
};
/** A signal that fires with `signal`, or when this answer's connection closes first (whoever
 *  asked went away): a question to the reviewer is ended with either. */
const whileAsked = (res: ServerResponse, signal: AbortSignal): AbortSignal => {
  const gone = new AbortController();
  res.once("close", () => gone.abort());
  return AbortSignal.any([signal, gone.signal]);
};

export const handler = (backend: Backend, log: (line: string) => void) => {
  // What the reviewer says of each text, by the text's own digest: a text listed again under
  // the same nonce is another push, with an account of its own. Asked once per text, in the
  // background, for as long as the text is listed (R4: no deadline here; the person waits, or
  // refuses). When the root no longer lists it, the question is dropped, and the reviewer
  // stops; until then, its answer is kept: the page signs only what it was given to show.
  type Asking = {
    stop: AbortController;
    since: number;
    /** The lists asked for of the root before it was asked about (`rootListAfter`). */
    born: number;
    progress: { phase: string; done?: number; of?: number } | null;
    answer: { account: Account } | { error: string } | null;
    /** The page was given the answer (/pending): from here it may be signed. */
    listed: boolean;
  };
  const reviews = new Map<string, Asking>();
  // The approvals this page signed, newest last, and how each ended once the pusher said. Its
  // log is followed only while a page is open and has a push in front of it, or one approved
  // that has not ended (the daemon reads it only while someone listens).
  const approvals: {
    repo: string;
    branch: string;
    commit: string;
    at: number;
    outcome: Outcome;
  }[] = [];
  const unsaid = (a: (typeof approvals)[number]) =>
    !a.outcome.pushed && a.outcome.error === undefined && Date.now() - a.at < HEARD_MS;
  let pages = 0;
  let unhear: (() => void) | null = null;
  const hearPusher = () => {
    const want = pages > 0 && (reviews.size > 0 || approvals.some(unsaid));
    if (want && !unhear)
      unhear = backend.pushes((said) => {
        const done = approvals.find(
          (a) =>
            a.repo === said.repo &&
            a.branch === said.branch &&
            a.commit === said.commit &&
            unsaid(a),
        );
        if (!done) return;
        if (said.type === "pushed") {
          done.outcome.pushed = true;
          if (backend.github()) done.outcome.link = pullRequestPage(said.repo, said.branch);
        } else
          done.outcome.error =
            said.type === "push-uncertain"
              ? `it may or may not have reached the remote (${printable(said.error ?? "")})`
              : printable(said.error || "the push failed");
        tell();
        hearPusher();
      });
    else if (!want && unhear) {
      unhear();
      unhear = null;
    }
  };
  /** The pages waiting for what they show to change (/pending?since=): told when a review
   *  says something new. */
  const moved = new Set<() => void>();
  const tell = () => {
    for (const wake of [...moved]) wake();
  };
  /** Questions not yet asked, first come first asked, and how many are being answered. */
  const queued: (() => void)[] = [];
  let answering = 0;
  const next = () => {
    while (answering < ASKING_MOST && queued.length) queued.shift()!();
  };
  const askingOf = (push: PushApproval, message: string): Asking => {
    const known = reviews.get(digestOf(message));
    if (known) return known;
    const asking: Asking = {
      stop: new AbortController(),
      since: Date.now(),
      born: looks,
      progress: { phase: "waiting for another push's account" },
      answer: null,
      listed: false,
    };
    reviews.set(digestOf(message), asking);
    const request = {
      op: "account" as const,
      repo: push.repo,
      branch: push.branch,
      commit: push.commit,
      onto: push.onto,
    };
    const ask = async () => {
      if (asking.stop.signal.aborted) return;
      answering += 1;
      asking.progress = null;
      try {
        for await (const line of backend.summary(request, asking.stop.signal)) {
          if ("progress" in line) {
            if (JSON.stringify(line.progress) === JSON.stringify(asking.progress)) continue;
            asking.progress = line.progress;
            tell();
          } else
            return void (asking.answer =
              "account" in line
                ? checkedAccount(line.account)
                : "error" in line
                  ? { error: line.error }
                  : { error: "the reviewer answered another question than the one asked" });
        }
        if (!asking.stop.signal.aborted) asking.answer = { error: "the reviewer gave no answer" };
      } catch (error) {
        asking.answer = { error: (error as Error).message };
      } finally {
        answering -= 1;
        next();
        tell();
      }
    };
    queued.push(() => void ask());
    next();
    return asking;
  };
  /** What the page is told of a push's account, now. */
  const reviewOf = (asking: Asking): Review => {
    if (!asking.answer)
      return {
        working: {
          ...(asking.progress ?? { phase: "starting" }),
          seconds: Math.floor((Date.now() - asking.since) / 1000),
        },
      };
    if ("error" in asking.answer) return { error: asking.answer.error };
    const { key: _key, ...shown } = asking.answer.account;
    return { account: shown };
  };
  /** The push a page names (its nonce and the token it was given for its very text), as the
   *  root lists it now, with the reviewer's account the page was given; or the answer that
   *  refuses the request. */
  const shownPush = async (
    nonce: string,
    given: string,
    token: string,
  ): Promise<{ account: Account; asking: Asking } | { status: number; error: string }> => {
    if (!/^[0-9a-f]{32}$/.test(nonce) || !/^[0-9a-f]{64}$/.test(given))
      return { status: 403, error: "not a push this page showed" };
    const waiting = (await listedNow().catch(() => [] as Waiting[])).find(
      (w) => parseApproval(w.message)?.nonce === nonce,
    );
    if (!waiting || !sameSecret(given, pushToken(token, waiting.message)))
      return {
        status: 410,
        error: "that push is no longer waiting, or is not the one this page showed",
      };
    const asking = reviews.get(digestOf(waiting.message));
    if (!asking?.listed || !asking.answer || !("account" in asking.answer))
      return { status: 404, error: "the page has not been given the reviewer's account of it" };
    return { account: asking.answer.account, asking };
  };
  /** What the page is told of the pushes the root lists: each push's parsed text, the token
   *  over it, and the reviewer's account. A push the root no longer lists is dropped here. */
  const answerFor = (listed: Waiting[], look: number, token: string) => {
    // A text the root no longer lists is a push that is gone (approved, refused, or given
    // up): its question to the reviewer is dropped, and so is what it answered.
    const now = new Set(listed.map((w) => digestOf(w.message)));
    for (const [digest, asking] of reviews)
      if (!now.has(digest) && asking.born < look) {
        asking.stop.abort();
        reviews.delete(digest);
      }
    const out = [];
    for (const waiting of listed) {
      const push = parseApproval(waiting.message);
      if (!push) continue;
      // Past the most this page keeps an account of, a push is listed, and not asked about.
      if (!reviews.has(digestOf(waiting.message)) && reviews.size >= LISTED_MOST) {
        out.push({
          nonce: push.nonce,
          repo: push.repo,
          branch: push.branch,
          commit: push.commit,
          onto: push.onto,
          token: pushToken(token, waiting.message),
          review: {
            error: `over ${LISTED_MOST} pushes are waiting, more than this page asks the reviewer about at once: refuse the ones that are not yours, and this one is asked about then`,
          },
        });
        continue;
      }
      // Everything shown is the parsed text and the reviewer's account; the root's user's own
      // words about a push are not shown at all. A diff, and the rest of a long list, are
      // asked for when the person wants them (/diff, /page): not in the list the page waits on.
      const asking = askingOf(push, waiting.message);
      const review = reviewOf(asking);
      // The page is given this account now: from here it may be signed.
      // (An account that says the reviewer could not describe it is given too: the click is
      // then refused for that, not for an account not shown.)
      if (!("working" in review)) asking.listed = true;
      out.push({
        nonce: push.nonce,
        repo: push.repo,
        branch: push.branch,
        commit: push.commit,
        onto: push.onto,
        token: pushToken(token, waiting.message),
        review,
        ...("account" in review
          ? { shown: shownToken(token, waiting.message, review.account) }
          : {}),
      });
    }
    return out;
  };
  /** The answer's tag: the same pushes and accounts, the same tag. (How long the reviewer has
   *  been at it is counted by the page, from `seconds`: not a change.) */
  const tagOfAnswer = (out: ReturnType<typeof answerFor>) =>
    digestOf(
      JSON.stringify(
        out.map((p) =>
          "working" in p.review
            ? { ...p, review: { working: { ...p.review.working, seconds: 0 } } }
            : p,
        ),
      ),
    );
  /** The root's list once it is not the one `since` tags, for as long as `signal` holds.
   *  `look`: when it was asked for, in lists asked for (`answerFor` drops only the reviews of
   *  pushes asked about before it: another page's may come from a later list). */
  let looks = 0;
  const rootListAfter = async (since: string, signal: AbortSignal) => {
    const look = ++looks;
    const listed = await backend.pending(since, signal);
    // A root that answers the same list at once (asked the old way, with no connection to
    // wait on) is asked again a second later, not at once.
    if (listed.tag === since) await delay(1000, undefined, { signal }).catch(() => {});
    return { ...listed, look };
  };
  /** What the root lists now. */
  const listedNow = async () => (await backend.pending("", new AbortController().signal)).pending;
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
    // And the approval page itself, which the dashboard's Push opens in a tab of its own
    // (2026-11-19): its bare address only, never one carrying a token, and never in a frame.
    // In a tab, the page is the person's: Approve arms only on the pointer's own movement, and
    // everything it shows or does is a same-origin request with its cookie. (The root's user,
    // which serves the dashboard, can already make a push wait here: opening the tab shows it.)
    const toSecrets =
      req.method === "GET" &&
      (url.pathname === "/secrets" ||
        url.pathname === "/editor-defaults" ||
        (url.pathname === "/" && url.search === "")) &&
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
    // The first page of `desolate ui --open`'s chain (signin.ts): a code of its own, spent once,
    // for this page's cookie, and the browser sent on to the git terminal's. Opened by the
    // command, never by another site: the gate above refused that (only the bare address is).
    const code = url.searchParams.get("signin");
    if (req.method === "GET" && url.pathname === "/" && code !== null) {
      const next = signins.take("approve", code);
      if (next === undefined)
        return text(
          res,
          403,
          "refused: that sign-in link is spent or too old; `desolate ui --open` makes another",
        );
      // A page of this origin's own, which keeps its key and sends the browser on.
      return send(res, 200, "text/html; charset=utf-8", signedInPage(token, next), {
        "set-cookie": `${name}=${cookieValue(token)}; HttpOnly; SameSite=Strict; Path=/`,
      });
    }
    const given = url.searchParams.get("tkn");
    if (req.method === "GET" && url.pathname === "/" && given !== null) {
      if (!sameSecret(given, token))
        return text(
          res,
          403,
          "refused: that is not this stack's approval address; `desolate approve --web` prints it",
        );
      return send(res, 200, "text/html; charset=utf-8", signedInPage(token, "/"), {
        "set-cookie": `${name}=${cookieValue(token)}; HttpOnly; SameSite=Strict; Path=/`,
      });
    }
    // The page's own credential: its cookie and its key (shared/page-key.ts).
    const credential = carriesCredential(req.headers, name, token);
    const embedded = String(req.headers["x-desolate-embed"] ?? "");
    const signedIn =
      credential || (/^[0-9a-f]{64}$/.test(embedded) && sameSecret(embedded, embedKey(token)));
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
          "this browser is not signed in to the approval page. On the Mac, `desolate ui --open` signs it in to every page (`desolate approve --web` prints this page's address alone)",
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
      if (!credential)
        return json(res, 401, {
          error:
            "this browser is not signed in to the approval page. On the Mac, `desolate ui --open` signs it in to every page, this one too",
        });
      if (req.method === "GET" && url.pathname === "/editor-defaults/get")
        return json(res, 200, { settings: await ops.get() });
      if (req.method !== "POST" || url.pathname !== "/editor-defaults/set")
        return json(res, 404, { error: "no such thing" });
      if (!/^application\/json(;|$)/.test(String(req.headers["content-type"] ?? "")))
        return json(res, 415, { error: "JSON only" });
      if (req.headers.origin !== `http://${APPROVE_HOSTNAME}:${editorHostPort()}`)
        return json(res, 403, { error: "a request from another origin" });
      const body = await jsonBody(req, res, SECRET_BODY_BYTES);
      if (!("asked" in body)) return json(res, body.status, { error: body.error });
      try {
        const done = await ops.set(body.asked.settings as Record<string, unknown>);
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
      if (!credential)
        return json(res, 401, {
          error:
            "this browser is not signed in to the approval page, which keeps the secrets. On the Mac, `desolate ui --open` signs it in to every page, this one too",
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
      const body = await jsonBody(
        req,
        res,
        url.pathname.startsWith("/secrets/import/") ? IMPORT_BODY_BYTES : SECRET_BODY_BYTES,
      );
      if (!("asked" in body)) return json(res, body.status, { error: body.error });
      const asked = body.asked;
      if (!isSlug(asked.domain)) return json(res, 400, { error: "which domain?" });
      const name = String(asked.name ?? "");
      const list = (value: unknown) =>
        Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
      try {
        if (url.pathname === "/secrets/set") {
          const value = String(asked.value ?? "");
          // One line, as the terminal takes it (readSecretLine): no line breaks inside.
          if (!value || /[\r\n]/.test(value) || Buffer.byteLength(value) > SECRET_BYTES)
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

    // `since`: the tag of the answer the page has. Then the answer waits until it would be
    // another: the root's list changed, or a reviewer said something new; for as long as the
    // page holds the request (R4). Without it, the answer is now's.
    if (req.method === "GET" && url.pathname === "/pending") {
      const since = url.searchParams.get("since");
      const gone = new AbortController();
      pages += 1;
      res.once("close", () => {
        gone.abort();
        pages -= 1;
        hearPusher();
      });
      try {
        let root = await rootListAfter("", gone.signal);
        // One wait on the root at a time, kept across a reviewer's news: each wake is not
        // another call into the root.
        let fromRoot: ReturnType<typeof rootListAfter> | null = null;
        for (;;) {
          const out = answerFor(root.pending, root.look, token);
          hearPusher();
          const done = approvals
            .map((a) => a.outcome)
            .filter((o) => o.pushed || o.error !== undefined);
          const tag = digestOf(tagOfAnswer(out) + JSON.stringify(done));
          if (since === null || tag !== since) return json(res, 200, { pending: out, done, tag });
          fromRoot ??= rootListAfter(root.tag, gone.signal);
          const round = new AbortController();
          const next = await Promise.race([
            fromRoot,
            new Promise<null>((resolve) => {
              const wake = () => resolve(null);
              moved.add(wake);
              round.signal.addEventListener("abort", () => moved.delete(wake), { once: true });
            }),
          ]).finally(() => round.abort());
          if (gone.signal.aborted) return;
          if (next) [root, fromRoot] = [next, null];
        }
      } catch (error) {
        if (gone.signal.aborted) return;
        // (Nothing is dropped for a list that could not be had: the pushes may all still wait.)
        return json(res, 502, {
          error: `the root's list of pushes waiting could not be had: ${printable((error as Error).message)}`,
        });
      }
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
      const body = await jsonBody(req, res, CLICK_BYTES);
      if (!("asked" in body)) return json(res, body.status, { error: body.error });
      const asked = body.asked;
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
    // More of the account of a push this page showed (the next page of a list), and its diff
    // (the net change, a file's, a commit's whole), a page at a time: named by its nonce and
    // the token the page was given for its very text, as an approval is, and asked of the
    // reviewer under the key of the account the page was given. Asked for as long as the page
    // waits for it and the push is listed (R4).
    if (req.method === "GET" && (url.pathname === "/page" || url.pathname === "/diff")) {
      const shown = await shownPush(
        url.searchParams.get("nonce") ?? "",
        url.searchParams.get("token") ?? "",
        token,
      );
      if (!("account" in shown)) return json(res, shown.status, { error: shown.error });
      const from = Number(url.searchParams.get("from") ?? "0");
      if (!Number.isSafeInteger(from) || from < 0)
        return json(res, 400, { error: "from where? A place in it: 0, or more" });
      const key = shown.account.key;
      const list = url.searchParams.get("list") ?? "";
      const file = url.searchParams.get("file");
      const commit = url.searchParams.get("commit") ?? "";
      let request: AccountRequest;
      if (url.pathname === "/page") {
        if (list !== "commits" && list !== "files" && list !== "between")
          return json(res, 400, { error: "which list? commits, files or between" });
        request = { op: "page", key, list, from };
      } else if (file !== null) request = { op: "diff", key, of: { file }, from };
      else if (url.searchParams.has("commit")) {
        if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(commit))
          return json(res, 400, { error: "not a commit" });
        request = { op: "diff", key, of: { commit }, from };
      } else request = { op: "diff", key, of: "net", from };
      const answer = await answerOf(
        backend.summary(request, whileAsked(res, shown.asking.stop.signal)),
      ).catch((error: Error): AccountLine => ({ error: error.message }));
      if (res.destroyed) return;
      if (answer === null) return json(res, 410, { error: "that push is no longer waiting" });
      if ("error" in answer) return json(res, 502, { error: answer.error });
      if (
        request.op === "page" &&
        "page" in answer &&
        isListed((answer.page as Record<string, unknown>)[request.list], request.list)
      )
        return json(res, 200, {
          page: (answer.page as Record<string, Listed<unknown>>)[request.list],
        });
      if (request.op === "diff" && "diff" in answer)
        return json(res, 200, { diff: answer.diff satisfies DiffPage });
      return json(res, 502, {
        error: "the reviewer answered another question than the one asked",
      });
    }
    if (req.method === "POST" && (url.pathname === "/approve" || url.pathname === "/refuse")) {
      if (!/^application\/json(;|$)/.test(String(req.headers["content-type"] ?? "")))
        return json(res, 415, { error: "JSON only" });
      if (req.headers.origin !== `http://${APPROVE_HOSTNAME}:${editorHostPort()}`)
        return json(res, 403, { error: "a request from another origin" });
      const body = await jsonBody(req, res, CLICK_BYTES);
      if (!("asked" in body)) return json(res, body.status, { error: body.error });
      const asked = body.asked;
      const nonce = String(asked.nonce ?? "");
      const given = String(asked.token ?? "");
      if (!/^[0-9a-f]{32}$/.test(nonce) || !/^[0-9a-f]{64}$/.test(given))
        return json(res, 403, { error: "not a push this page showed" });
      // The push, as the root lists it now. Signed only if it is the very text the page showed:
      // the token is over that text, so another text under the same nonce does not match.
      const waiting = (await listedNow()).find((w) => parseApproval(w.message)?.nonce === nonce);
      const push = waiting ? parseApproval(waiting.message) : null;
      if (!waiting || !push)
        return json(res, 410, {
          error: "that push is no longer waiting: approved elsewhere, refused, or given up",
        });
      if (!sameSecret(given, pushToken(token, waiting.message)))
        return json(res, 409, {
          error:
            "that push is not the one this page showed: it changed, so nothing was signed; look at it again",
        });
      if (asked.commit !== push.commit)
        return json(res, 409, { error: "that is not the commit this push names" });
      // What is signed: the challenge, with what the reviewer says the push sends (it made the
      // pack, and the pusher sends no other). No account of it, no approval.
      // Only an account the page was given (/pending listed it): what is signed is what the
      // person could read, never one asked for at the click (the independent review of #165's
      // fix: a button armed while the reviewer was still working signed what came after).
      const entry = reviews.get(digestOf(waiting.message));
      const reviewed =
        entry?.listed && entry.answer && "account" in entry.answer ? entry.answer.account : null;
      let signed = "";
      if (url.pathname === "/approve") {
        // (Two refusals, told apart: the page has not shown an account yet, or the reviewer
        // had none to give.)
        if (!entry?.listed)
          return json(res, 409, {
            error:
              "the page has not shown desolate's reviewer's account of this push yet, so it cannot be approved: nothing was signed. Look at it, then approve",
          });
        // The very account the page showed: the click names it (`shown`, from /pending).
        if (
          reviewed &&
          !sameSecret(
            String(asked.shown ?? ""),
            shownToken(token, waiting.message, (reviewOf(entry!) as { account: Shown }).account),
          )
        )
          return json(res, 409, {
            error:
              "that is not the account of this push the page has now: it changed, so nothing was signed; look at it again",
          });
        if (!reviewed)
          return json(res, 409, {
            error: `desolate's reviewer could not say what this push would send (${printable(entry?.answer && "error" in entry.answer ? entry.answer.error : "no answer")}), so it cannot be approved: nothing was signed`,
          });
        // A push that replaces the remote's branch, only when the page said so and the
        // person confirmed that, apart from Approve (approve.js: the branch's name, typed).
        if (reviewed.fastForward === false && asked.replace !== true)
          return json(res, 409, {
            error:
              "this push replaces the remote's branch: confirm the replace on the page, or nothing is signed",
          });
        if (asked.squash === true && !reviewed.squash)
          return json(res, 409, { error: "there is nothing to squash: it is one commit" });
        signed = signedFor(
          waiting.message,
          // (Named one by one: what the reviewer says a push sends names its pack and LFS
          // objects, never the commit.)
          asked.squash === true
            ? {
                commit: reviewed.squash!.commit,
                squashes: push.commit,
                pack: reviewed.squash!.sends.pack,
                lfs: reviewed.squash!.sends.lfs,
              }
            : {
                commit: push.commit,
                squashes: null,
                pack: reviewed.sends.pack,
                lfs: reviewed.sends.lfs,
              },
        );
      }
      try {
        if (url.pathname === "/approve") {
          await backend.approve(signed);
          approvals.push({
            repo: push.repo,
            branch: push.branch,
            commit: asked.squash === true ? reviewed!.squash!.commit : push.commit,
            at: Date.now(),
            outcome: { token: given, pushed: false },
          });
          if (approvals.length > OUTCOMES_KEPT) approvals.shift();
          hearPusher();
          log(
            `approve page: approved ${push.repo} ${push.branch} ${push.commit}${asked.squash === true ? ` squashed into ${reviewed!.squash!.commit}` : ""}${push.onto ? ` (from ${push.onto}${reviewed!.fastForward === false ? ", replacing it" : ""})` : " (a new branch)"}`,
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
  /** The cookie that address gave the person's browser: a name of this stack's own, and a
   *  value derived from the token (shared/page-key.ts), never the token. */
  type Cookie =
    "desolate_approve_5e00ea51cf17=a68dde9918abf2477e02d622c6f39ef452f5b629efb668fbe721f74a83b5665c";
  /** The key the page keeps in its own storage and sends beside the cookie. */
  type Key = "d06d2405795a703a9cc213d47a96539f21c9f2e783374a7b0ded41d75a690f59";
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
    "x-desolate-key": Key;
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
                "x-desolate-key": Key;
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

  /** the approval page opens from the dashboard's Push (another site), at its bare address in
   *  a tab: a token's address from another site, or the page in another site's frame, is not */
  export type FromPush = Given<
    HasToken,
    [
      Expect<
        Invoke<
          typeof ask,
          [
            handler: Secrets,
            request: {
              method: "GET";
              url: "/";
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
              url: "/?tkn=abababababababababababababababababababababababab";
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
        { status: 403 }
      >,
      Expect<
        Invoke<
          typeof ask,
          [
            handler: Secrets,
            request: {
              method: "GET";
              url: "/";
              headers: {
                host: "desolate-approve.localhost:31581";
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
    ]
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
                "x-desolate-key": Key;
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

  /** the address's token is traded for a cookie a script cannot read and another site never
   *  sends (derived, not the token), and a page of this origin's own that keeps the page's key
   *  and opens the page */
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
        status: 200;
        headers: {
          "set-cookie": "desolate_approve_5e00ea51cf17=a68dde9918abf2477e02d622c6f39ef452f5b629efb668fbe721f74a83b5665c; HttpOnly; SameSite=Strict; Path=/";
        };
        text: '<!doctype html><meta charset="utf-8"><meta name="desolate-key" content="d06d2405795a703a9cc213d47a96539f21c9f2e783374a7b0ded41d75a690f59"><meta name="desolate-next" content="/"><title>desolate</title><script src="/page-key.js"></script><p>Signed in.</p>\n';
      }
    >
  >;
  /** `desolate ui --open`'s link: its code, spent once, for the cookie, and on to the git
   *  terminal's link; the same link again, or another site's, gets nothing */
  export type SignsInByCode = Given<
    [
      HasToken,
      Invoke<
        typeof mint,
        [
          page: "approve",
          next: "http://desolate-git.localhost:31581/?signin=121212121212121212121212121212121212121212121212",
          code: "efefefefefefefefefefefefefefefefefefefefefefefef",
        ]
      >,
    ],
    [
      Expect<
        Invoke<
          typeof ask,
          [
            handler: Page,
            request: {
              method: "GET";
              url: "/?signin=efefefefefefefefefefefefefefefefefefefefefefefef";
              headers: { host: "desolate-approve.localhost:31581"; "sec-fetch-site": "none" };
            },
          ]
        >,
        "matches",
        {
          status: 200;
          headers: {
            "set-cookie": "desolate_approve_5e00ea51cf17=a68dde9918abf2477e02d622c6f39ef452f5b629efb668fbe721f74a83b5665c; HttpOnly; SameSite=Strict; Path=/";
          };
          text: '<!doctype html><meta charset="utf-8"><meta name="desolate-key" content="d06d2405795a703a9cc213d47a96539f21c9f2e783374a7b0ded41d75a690f59"><meta name="desolate-next" content="http://desolate-git.localhost:31581/?signin=121212121212121212121212121212121212121212121212"><title>desolate</title><script src="/page-key.js"></script><p>Signed in.</p>\n';
        }
      >,
      Expect<
        Invoke<
          typeof ask,
          [
            handler: Page,
            request: {
              method: "GET";
              url: "/?signin=efefefefefefefefefefefefefefefefefefefefefefefef";
              headers: { host: "desolate-approve.localhost:31581"; "sec-fetch-site": "none" };
            },
          ]
        >,
        "matches",
        {
          status: 403;
          text: "desolate: refused: that sign-in link is spent or too old; `desolate ui --open` makes another\n";
        }
      >,
    ]
  >;
  /** a link another site sends the browser to is refused before its code is looked at (a
   *  control: the same code, opened by the command, still works after) */
  export type SignInNotFromAnotherSite = Given<
    [
      HasToken,
      Invoke<
        typeof mint,
        [
          page: "approve",
          next: "http://desolate-git.localhost:31581/",
          code: "343434343434343434343434343434343434343434343434",
        ]
      >,
    ],
    [
      Expect<
        Invoke<
          typeof ask,
          [
            handler: Page,
            request: {
              method: "GET";
              url: "/?signin=343434343434343434343434343434343434343434343434";
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
              url: "/?signin=343434343434343434343434343434343434343434343434";
              headers: { host: "desolate-approve.localhost:31581"; "sec-fetch-site": "none" };
            },
          ]
        >,
        "matches",
        {
          status: 200;
          text: '<!doctype html><meta charset="utf-8"><meta name="desolate-key" content="d06d2405795a703a9cc213d47a96539f21c9f2e783374a7b0ded41d75a690f59"><meta name="desolate-next" content="http://desolate-git.localhost:31581/"><title>desolate</title><script src="/page-key.js"></script><p>Signed in.</p>\n';
        }
      >,
    ]
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
              review: { working: { phase: "starting"; seconds: 0 } };
            },
          ];
        };
      }
    >
  >;
  /** a reviewer asked about four pushes at once, and no more: the fifth waits its turn, and
   *  says so (the root's user can list as many as it likes) */
  export type FourAtOnce = Given<
    HasToken,
    [
      Expect<
        Invoke<
          typeof ask,
          [
            handler: Invoke<
              typeof handler,
              [
                backend: Invoke<
                  typeof waiting,
                  [
                    messages: [
                      "desolate push approval v2\nrepo: acme/web\nbranch: fix/1\ncommit: 0123456789abcdef0123456789abcdef01234567\nonto: none\nnonce: 00000000000000000000000000000001\n",
                      "desolate push approval v2\nrepo: acme/web\nbranch: fix/2\ncommit: 0123456789abcdef0123456789abcdef01234567\nonto: none\nnonce: 00000000000000000000000000000002\n",
                      "desolate push approval v2\nrepo: acme/web\nbranch: fix/3\ncommit: 0123456789abcdef0123456789abcdef01234567\nonto: none\nnonce: 00000000000000000000000000000003\n",
                      "desolate push approval v2\nrepo: acme/web\nbranch: fix/4\ncommit: 0123456789abcdef0123456789abcdef01234567\nonto: none\nnonce: 00000000000000000000000000000004\n",
                      "desolate push approval v2\nrepo: acme/web\nbranch: fix/5\ncommit: 0123456789abcdef0123456789abcdef01234567\nonto: none\nnonce: 00000000000000000000000000000005\n",
                    ],
                  ]
                >,
                log: typeof quiet,
              ]
            >,
            request: { method: "GET"; url: "/pending"; headers: Script },
          ]
        >,
        "matches",
        {
          json: {
            pending: [
              { review: { working: { phase: "starting" } } },
              { review: { working: { phase: "starting" } } },
              { review: { working: { phase: "starting" } } },
              { review: { working: { phase: "starting" } } },
              { review: { working: { phase: "waiting for another push's account" } } },
            ];
          };
        }
      >,
      Expect<Invoke<typeof askedCount>, "=", 4>,
    ]
  >;
  /** no cookie: nothing; the cookie alone, from the page's own origin (what a program on another
   *  port of this name is sent): nothing; the cookie and key without the browser's same-origin
   *  word (a script, curl): nothing */
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
              headers: {
                host: "desolate-approve.localhost:31581";
                "sec-fetch-site": "same-origin";
                cookie: Cookie;
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
              headers: {
                host: "desolate-approve.localhost:31581";
                cookie: Cookie;
                "x-desolate-key": Key;
              };
            },
          ]
        >,
        "matches",
        { status: 403; json: { error: "a request this page did not make" } }
      >,
    ]
  >;

  /** What desolate's reviewer says the push sends: its pack, no LFS object, and the other
   *  choice, its two commits squashed into one. */
  type Sends = {
    pack: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    size: 100;
    lfs: {
      count: 0;
      bytes: 0;
      digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    };
  };
  type Reviewed = {
    key: "k1";
    warnings: [];
    commits: { items: []; total: 2; from: 0 };
    files: { items: []; total: 0; from: 0 };
    between: { items: []; total: 0; from: 0 };
    fastForward: null;
    base: null;
    remote: null;
    sends: Sends;
    squash: {
      commit: "5555555555555555555555555555555555555555";
      parent: null;
      count: 2;
      message: "Fix it\n";
      author: "A <a@example.com>";
      committer: "A <a@example.com>";
      dates: "";
      sends: {
        pack: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
        size: 90;
        lfs: {
          count: 0;
          bytes: 0;
          digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        };
      };
    };
  };
  type ReviewedPage = Invoke<
    typeof handler,
    [
      backend: Invoke<typeof waiting, [messages: [Push], says: [{ account: Reviewed }]]>,
      log: typeof quiet,
    ]
  >;
  /** The click on Approve, as the page's script sends it. */
  type Click = {
    method: "POST";
    url: "/approve";
    headers: Script;
    body: {
      nonce: "00000000000000000000000000000001";
      token: Invoke<typeof pushToken, [token: Token, message: Push]>;
      commit: "0123456789abcdef0123456789abcdef01234567";
    };
  };
  /** a click before the page listed the reviewer's account signs nothing, though the reviewer
   *  has one: what is signed is what the page was given to show (the T1 node test signs
   *  after the page's own poll, squashed and replacing too, and is refused after it for a
   *  push the reviewer could not describe) */
  export type NotListed = Given<
    HasToken,
    [
      Expect<
        Invoke<typeof ask, [handler: ReviewedPage, request: Click]>,
        "matches",
        { status: 409 }
      >,
      Expect<Invoke<typeof approved>, "=", []>,
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
                "x-desolate-key": Key;
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
            "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors http://desolate-git.localhost:31581";
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
