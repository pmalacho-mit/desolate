// T1. The approval page (host/approve-web.ts): what it takes before it signs. A real HTTP
// server on loopback, a stand-in for the stack behind it, and each way a request that is not
// the person's own page could arrive: another name, another origin, no cookie, a form, a
// made-up push, a push with another commit. Only the page's own request signs.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createServer, request } from "node:http";
import type { AddressInfo, Server } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it, mock } from "node:test";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "desolate-approve-"));
process.env.DESOLATE_HOME = home;
process.env.DESOLATE_EDITOR_PORT = "31599";
const { approveToken, embedAddress, handler, issueToken, pushToken } =
  await import("../../../release/host/approve-web.ts");
const { formatApproval, lfsDigest, signedFor } =
  await import("../../../release/shared/approval.ts");

const NAME = "desolate-approve.localhost";
const ORIGIN = `http://${NAME}:31599`;
const push = {
  repo: "acme/widgets",
  branch: "issue/12",
  commit: "a".repeat(40),
  onto: null,
  nonce: "1".repeat(32),
};
const message = formatApproval(push);
// What desolate's reviewer says the push sends: the host signs the challenge with it.
// (Its LFS objects as the reviewer says them: the digest of the list the pusher is given.)
const SENDS = {
  pack: "e".repeat(64),
  size: 100,
  lfs: { count: 1, bytes: 12, digest: lfsDigest([`${"f".repeat(64)} 12`]) },
};
const signed = signedFor(message, { commit: push.commit, squashes: null, ...SENDS });
// A second push, which replaces the remote's branch, with two commits to squash.
const other = { ...push, branch: "issue/13", onto: "b".repeat(40), nonce: "2".repeat(32) };
const otherMessage = formatApproval(other);
const SQUASH_SENDS = {
  pack: "d".repeat(64),
  size: 90,
  lfs: { count: 0, bytes: 0, digest: lfsDigest([]) },
};
// A third, which desolate's reviewer cannot describe.
const unreviewed = { ...push, branch: "issue/14", nonce: "3".repeat(32) };
const unreviewedMessage = formatApproval(unreviewed);
/** The page's own poll, as the page makes it: what it lists is what it may then sign. */
const listedNow = async () => {
  for (let i = 0; i < 2; i++) {
    await call("GET", "/pending", asPage());
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
// What the root's user lists: a test can change it under the page, as a compromised one could.
let listed = [{ message, at: "2026-11-12T00:00:00Z" }];
const approved: string[] = [];
let issuesListed: unknown[] = [];
const published: string[] = [];
const notNow: string[] = [];
const refused: string[] = [];
/** Who hears the pusher now (host/daemon.ts: the events it reads from the pusher's log). */
type Said = {
  type: string;
  repo: string;
  branch: string;
  commit: string;
  onto: string | null;
  error?: string;
};
let pusherHeard: ((said: Said) => void) | null = null;
const pusherSays = (said: Said) => pusherHeard!(said);
/** The keyring's answer to the next approvals, when a test holds it: an error, or "" to take it. */
let keyringSays: Promise<string> | null = null;
/** Every approval signed, across the tests (`approved` is emptied by each). */
const everSigned: string[] = [];
let server: Server;
let port = 0;

/** What desolate's reviewer says, as its stream (shared/review-account.ts): an account for
 *  each push by its branch, a page of a list, a diff. `slow`: the branch whose account waits
 *  until `release` is called, saying what it is doing meanwhile. `dropped`: the questions
 *  whose asker went away. */
const account = (extra: Record<string, unknown> = {}) => ({
  key: "k-12",
  warnings: [],
  commits: {
    items: [{ commit: "a".repeat(40), subject: "<img src=x onerror=alert(1)>", author: "agent" }],
    total: 101,
    from: 0,
  },
  files: { items: [], total: 0, from: 0 },
  between: { items: [], total: 0, from: 0 },
  sends: SENDS,
  fastForward: null,
  base: null,
  remote: null,
  ...extra,
});
let rootMoved = () => {};
let askedOfRoot = 0;
let rootWaits = true;
const waitsEnded: string[] = [];
let slow = "";
/** The branch whose account names another pack each time it is asked (`changing`). */
let changing = "";
let asked_ = 0;
let release = () => {};
const dropped: string[] = [];
const asks: Record<string, unknown>[] = [];
async function* reviewer(
  asked: Record<string, unknown> & { op: string },
  signal: AbortSignal,
): AsyncGenerator<never> {
  asks.push(asked);
  const drop = () => dropped.push(String(asked.branch ?? asked.op));
  signal.addEventListener("abort", drop, { once: true });
  try {
    yield* answering(asked, signal);
  } finally {
    signal.removeEventListener("abort", drop);
  }
}
async function* answering(
  asked: Record<string, unknown> & { op: string },
  signal: AbortSignal,
): AsyncGenerator<never> {
  if (asked.op === "page")
    return void (yield {
      page: {
        commits: {
          items: [{ commit: "c".repeat(40), subject: "the 101st", author: "agent" }],
          total: 101,
          from: asked.from,
        },
      },
    } as never);
  if (asked.op === "diff")
    return void (yield {
      diff: {
        text: "diff --git a/x b/x\n+<script>alert(1)</script>\n",
        from: asked.from,
        next: null,
        total: 44,
      },
    } as never);
  if (asked.branch === slow) {
    yield { progress: { phase: "packing", done: 1200, of: 8000 } } as never;
    await new Promise<void>((resolve) => {
      release = resolve;
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    if (signal.aborted) return;
  }
  if (asked.branch === unreviewed.branch) return void (yield { error: "bad object" } as never);
  if (asked.branch === changing)
    return void (yield {
      account: account({ sends: { ...SENDS, pack: String(++asked_).repeat(64).slice(0, 64) } }),
    } as never);
  if (asked.branch === other.branch)
    return void (yield {
      account: account({
        key: "k-13",
        fastForward: false,
        squash: {
          commit: "5".repeat(40),
          parent: null,
          count: 2,
          message: "x\n",
          author: "agent",
          committer: "agent",
          dates: "",
          sends: SQUASH_SENDS,
        },
      }),
    } as never);
  yield { account: account() } as never;
}

before(async () => {
  server = createServer(
    handler(
      {
        // The root's wait for its list to change (root/approvals.ts, pendingAfter): woken by
        // `rootMoved`, and ended with its asker (`waitsEnded`). `askedOfRoot` counts the calls;
        // `rootWaits` false is a root that answers at once (asked the old way).
        pending: async (since, signal) => {
          askedOfRoot += 1;
          for (;;) {
            const tag = `list:${listed.map((w) => w.message).join("\n")}`;
            if (tag !== since || signal.aborted || !rootWaits) return { tag, pending: listed };
            await new Promise<void>((resolve) => {
              rootMoved = resolve;
              signal.addEventListener("abort", () => (waitsEnded.push(since), resolve()), {
                once: true,
              });
            });
          }
        },
        summary: (asked, signal) => reviewer(asked, signal),
        approve: async (m) => {
          // A keyring slow to answer, then refusing (`keyringSays`): what a page sees meanwhile.
          if (keyringSays) {
            const said = await keyringSays;
            if (said) throw new Error(said);
          }
          approved.push(m);
          everSigned.push(m);
        },
        refuse: async (m) => void refused.push(m),
        issues: async () => issuesListed,
        publishIssue: async (issue) => {
          published.push(issue.title);
          return `https://github.com/${issue.repo}/issues/7`;
        },
        refuseIssue: async (issue) => void notNow.push(issue.id),
        pushes: (heard) => {
          pusherHeard = heard;
          return () => (pusherHeard = null);
        },
        github: () => true,
      },
      () => {},
    ),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});
after(() => {
  server.close();
  fs.rmSync(home, { recursive: true, force: true });
});

type Answer = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
};
const call = (
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: string,
): Promise<Answer> =>
  new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: url,
        headers: { host: `${NAME}:31599`, ...headers },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => {
          // What the page was last given for each push: its click names that account.
          if (url.startsWith("/pending") && res.statusCode === 200)
            for (const p of (JSON.parse(text) as { pending: { nonce: string; shown?: string }[] })
              .pending)
              if (p.shown) lastShown.set(p.nonce, p.shown);
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text });
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });

/** A request the page holds open (/pending?since=): its answer, whether it has come, and a
 *  way to go away, as a closed tab does. */
const held = (url: string) => {
  const answer = { done: false, body: null as null | Record<string, unknown> };
  let gone = () => {};
  const asked = new Promise<void>((resolve) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method: "GET",
        path: url,
        headers: { host: `${NAME}:31599`, ...asPage() },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => {
          answer.done = true;
          answer.body = JSON.parse(text) as Record<string, unknown>;
          for (const p of (answer.body.pending ?? []) as { nonce: string; shown?: string }[])
            if (p.shown) lastShown.set(p.nonce, p.shown);
          resolve();
        });
      },
    );
    req.on("error", () => resolve());
    gone = () => req.destroy();
    req.end();
  });
  return { answer, asked, gone };
};
const tagNow = async () =>
  (JSON.parse((await call("GET", "/pending", asPage())).body) as { tag: string }).tag;
const moment = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

const lastShown = new Map<string, string>();
let cookie = "";
/** The page key the sign-in page carried, which the page's script keeps and sends. */
let storedKey = "";
const page = { "sec-fetch-site": "same-origin" };
const asPage = () => ({ cookie, "x-desolate-key": storedKey, ...page });
const approve = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  call(
    "POST",
    "/approve",
    { ...asPage(), origin: ORIGIN, "content-type": "application/json", ...headers },
    JSON.stringify({ shown: lastShown.get(String(body.nonce)), ...body }),
  );
const good = () => ({
  nonce: push.nonce,
  token: pushToken(approveToken(), message),
  shown: lastShown.get(push.nonce),
  commit: push.commit,
});

describe("T1 the approval page", () => {
  it("the address with the token gives a cookie the page's script cannot read; a wrong token gives nothing", async () => {
    const wrong = await call("GET", `/?tkn=${"0".repeat(48)}`, {});
    assert.equal(wrong.status, 403);
    assert.equal(wrong.headers["set-cookie"], undefined);
    const right = await call("GET", `/?tkn=${approveToken()}`, {});
    assert.equal(right.status, 200);
    const set = String(right.headers["set-cookie"]);
    assert.match(set, /HttpOnly/);
    assert.match(set, /SameSite=Strict/);
    cookie = set.split(";")[0]!;
    assert.ok(!cookie.includes(approveToken()), "the cookie is not the token");
    // The answer is a page of this origin's own, with the key for its script to keep.
    assert.match(right.body, /<script src="\/page-key\.js"><\/script>/);
    storedKey = /<meta name="desolate-key" content="([0-9a-f]{64})">/.exec(right.body)![1]!;
    assert.equal(
      (await call("GET", "/pending", { cookie, ...page })).status,
      401,
      "the cookie alone opens nothing (what a program on another port of this name is sent)",
    );
    assert.equal(
      (await call("GET", "/pending", asPage())).status,
      200,
      "control: the cookie and the key open the page",
    );
  });

  it("every answer forbids framing, inline script and an opener", async () => {
    const html = await call("GET", "/", { cookie });
    assert.equal(html.status, 200);
    assert.match(String(html.headers["content-security-policy"]), /frame-ancestors 'none'/);
    assert.match(String(html.headers["content-security-policy"]), /script-src 'self'/);
    assert.doesNotMatch(String(html.headers["content-security-policy"]), /unsafe-inline/);
    assert.equal(html.headers["x-frame-options"], "DENY");
    assert.equal(html.headers["cross-origin-opener-policy"], "same-origin");
    assert.doesNotMatch(html.body, /<script>[^<]/, "no inline script in the page");
  });

  it("another name, another origin, another site: refused before anything", async () => {
    assert.equal(
      (await call("GET", "/pending", { ...asPage(), host: `evil.example:31599` })).status,
      421,
      "a DNS-rebound name",
    );
    assert.equal(
      (
        await call("GET", "/pending", {
          ...asPage(),
          host: `web-one-editor-abc123.localhost:31599`,
        })
      ).status,
      421,
      "a workspace's editor name",
    );
    assert.equal(
      (
        await call("GET", "/pending", {
          cookie,
          "x-desolate-key": storedKey,
          "sec-fetch-site": "same-site",
        })
      ).status,
      403,
      "a request a workspace's page started",
    );
    assert.equal(
      (
        await call("GET", "/pending", {
          cookie,
          "x-desolate-key": storedKey,
          "sec-fetch-site": "cross-site",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await call("GET", "/pending", {
          cookie,
          "x-desolate-key": storedKey,
          origin: "http://web-one-abc123.localhost:31599",
        })
      ).status,
      403,
    );
    assert.equal(
      (await call("GET", "/pending", { cookie, "x-desolate-key": storedKey })).status,
      403,
      "a request that says nothing of where it came from is not the page's",
    );
    assert.equal((await call("GET", "/pending", page)).status, 401, "no cookie");
  });

  it("control: the page's own request lists the push, and the summary is data", async () => {
    await call("GET", "/pending", asPage());
    // (The summary is worked out in the background: the first answer says it is coming.)
    await new Promise((resolve) => setTimeout(resolve, 50));
    const listed = await call("GET", "/pending", asPage());
    assert.equal(listed.status, 200);
    const body = JSON.parse(listed.body) as {
      pending: {
        nonce: string;
        token: string;
        review: { account: { key?: string; commits: { items: { subject: string }[] } } };
      }[];
    };
    assert.equal(body.pending.length, 1);
    assert.equal(body.pending[0]!.token, pushToken(approveToken(), message));
    assert.equal(
      "key" in body.pending[0]!.review.account,
      false,
      "the account's key is the host's, to ask the reviewer with",
    );
    assert.equal(
      body.pending[0]!.review.account.commits.items[0]!.subject,
      "<img src=x onerror=alert(1)>",
      "passed on as JSON text; the page sets it as text, never markup",
    );
    assert.match(String(listed.headers["content-type"]), /^application\/json/);
  });

  it("the diff and the rest of a list: not in the list polled every second, but on asking, for the push the page showed and no other", async () => {
    const listed = JSON.parse((await call("GET", "/pending", asPage())).body) as {
      pending: { review: { account: Record<string, unknown> } }[];
    };
    assert.equal("diff" in listed.pending[0]!.review.account, false, "the list carries no diff");
    const ask = (
      nonce: string,
      token: string,
      headers: Record<string, string> = asPage(),
      what = "/diff?from=0",
    ) => call("GET", `${what}&nonce=${nonce}&token=${token}`, headers);
    const right = pushToken(approveToken(), message);
    const shown = await ask(push.nonce, right);
    assert.equal(shown.status, 200, shown.body);
    assert.deepEqual(
      JSON.parse(shown.body),
      {
        diff: {
          text: "diff --git a/x b/x\n+<script>alert(1)</script>\n",
          from: 0,
          next: null,
          total: 44,
        },
      },
      "JSON text; the page sets it as text",
    );
    assert.deepEqual(
      asks.at(-1),
      { op: "diff", key: "k-12", of: "net", from: 0 },
      "asked of the reviewer under the key of the account the page was given",
    );
    // By file, by commit, a page of a list: each asked of the reviewer as it was asked here.
    assert.equal(
      (await ask(push.nonce, right, asPage(), "/diff?file=a%2Fb.ts&from=7")).status,
      200,
    );
    assert.deepEqual(asks.at(-1), { op: "diff", key: "k-12", of: { file: "a/b.ts" }, from: 7 });
    assert.equal(
      (await ask(push.nonce, right, asPage(), `/diff?commit=${"a".repeat(40)}`)).status,
      200,
    );
    assert.deepEqual(asks.at(-1), {
      op: "diff",
      key: "k-12",
      of: { commit: "a".repeat(40) },
      from: 0,
    });
    const more = await ask(push.nonce, right, asPage(), "/page?list=commits&from=1");
    assert.equal(more.status, 200, more.body);
    assert.equal(
      (JSON.parse(more.body) as { page: { items: { subject: string }[] } }).page.items[0]!.subject,
      "the 101st",
    );
    assert.deepEqual(asks.at(-1), { op: "page", key: "k-12", list: "commits", from: 1 });
    assert.equal(
      (await ask(push.nonce, right, asPage(), "/page?list=secrets&from=0")).status,
      400,
      "a list an account does not have",
    );
    assert.equal(
      (await ask(push.nonce, right, asPage(), "/diff?commit=HEAD")).status,
      400,
      "not a commit",
    );
    assert.equal(
      (await ask(push.nonce, right, asPage(), "/diff?from=-1")).status,
      400,
      "not a place in it",
    );
    assert.equal(
      (await ask(push.nonce, pushToken(approveToken(), `${message}x`))).status,
      410,
      "a token for another text",
    );
    assert.equal(
      (await ask("f".repeat(32), pushToken(approveToken(), message))).status,
      410,
      "a push that is not waiting",
    );
    assert.equal((await ask("../x", "y")).status, 403, "not a nonce and a token");
    assert.equal(
      (await ask(push.nonce, pushToken(approveToken(), message), page)).status,
      401,
      "no cookie",
    );
    assert.equal(
      (
        await ask(push.nonce, pushToken(approveToken(), message), {
          cookie,
          "x-desolate-key": storedKey,
          "sec-fetch-site": "cross-site",
        })
      ).status,
      403,
      "another site",
    );
  });

  it("a slow reviewer: the page says what it is doing, and its account, three minutes on, is shown and signs", async () => {
    const slowPush = { ...push, branch: "issue/16", nonce: "6".repeat(32) };
    const slowMessage = formatApproval(slowPush);
    slow = slowPush.branch;
    listed = [{ message: slowMessage, at: "2026-11-12T00:00:00Z" }];
    approved.length = 0;
    mock.timers.enable({ apis: ["Date"], now: Date.now() });
    try {
      await listedNow();
      mock.timers.tick(3 * 60_000);
      const waiting = JSON.parse((await call("GET", "/pending", asPage())).body) as {
        pending: { review: unknown }[];
      };
      assert.deepEqual(waiting.pending[0]!.review, {
        working: { phase: "packing", done: 1200, of: 8000, seconds: 180 },
      });
      const click = () =>
        approve({
          nonce: slowPush.nonce,
          token: pushToken(approveToken(), slowMessage),
          commit: slowPush.commit,
        });
      const early = await click();
      assert.equal(early.status, 409, "while it works, nothing signs");
      assert.match(early.body, /has not shown desolate's reviewer's account/);
      release();
      await listedNow();
      const signs = await click();
      assert.equal(signs.status, 200, signs.body);
      assert.deepEqual(approved, [
        signedFor(slowMessage, { commit: slowPush.commit, squashes: null, ...SENDS }),
      ]);
      assert.deepEqual(dropped, [], "nothing was dropped while the push waited");
    } finally {
      mock.timers.reset();
      slow = "";
      approved.length = 0;
      listed = [{ message, at: "2026-11-12T00:00:00Z" }];
    }
  });

  it("a push that leaves the list: its question to the reviewer is dropped; one still listed is not", async () => {
    const gone = { ...push, branch: "issue/17", nonce: "7".repeat(32) };
    const goneMessage = formatApproval(gone);
    slow = gone.branch;
    dropped.length = 0;
    try {
      listed = [
        { message, at: "2026-11-12T00:00:00Z" },
        { message: goneMessage, at: "2026-11-12T00:00:00Z" },
      ];
      await listedNow();
      assert.deepEqual(dropped, [], "control: both listed, neither dropped");
      listed = [{ message, at: "2026-11-12T00:00:00Z" }];
      await listedNow();
      assert.deepEqual(dropped, [gone.branch], "the one gone, and only it");
      const again = JSON.parse((await call("GET", "/pending", asPage())).body) as {
        pending: { review: { account?: unknown } }[];
      };
      assert.ok(again.pending[0]!.review.account, "the one still listed keeps its account");
    } finally {
      slow = "";
      listed = [{ message, at: "2026-11-12T00:00:00Z" }];
    }
  });

  it("the push leaves the list and comes back, and the reviewer gives another account: the page's click, for the one it showed, signs nothing", async () => {
    const again = { ...push, branch: "issue/18", nonce: "8".repeat(32) };
    const againMessage = formatApproval(again);
    changing = again.branch;
    approved.length = 0;
    try {
      listed = [{ message: againMessage, at: "2026-11-12T00:00:00Z" }];
      await listedNow();
      const shownFirst = lastShown.get(again.nonce)!;
      // Gone from the list (another page's poll saw it go), and back: asked again.
      listed = [];
      await call("GET", "/pending", asPage());
      listed = [{ message: againMessage, at: "2026-11-12T00:00:00Z" }];
      await call("GET", "/pending", asPage());
      await new Promise((resolve) => setTimeout(resolve, 20));
      // ...and given, but to a request whose answer never reached the page that is clicked.
      await call("GET", "/pending", asPage());
      const click = (shown: string) =>
        approve({
          nonce: again.nonce,
          token: pushToken(approveToken(), againMessage),
          commit: again.commit,
          shown,
        });
      const stale = await click(shownFirst);
      assert.equal(stale.status, 409, stale.body);
      assert.match(stale.body, /not the account of this push the page has now/);
      assert.equal((await click("")).status, 409, "and with none, nothing");
      assert.deepEqual(approved, [], "nothing signed");
      const control = await click(lastShown.get(again.nonce)!);
      assert.equal(control.status, 200, `control: the account it has now signs: ${control.body}`);
      assert.equal(approved.length, 1);
      assert.match(approved[0]!, /\npack: 2{64}\n/, "the pack of the account shown last");
    } finally {
      changing = "";
      approved.length = 0;
      listed = [{ message, at: "2026-11-12T00:00:00Z" }];
    }
  });

  it("a page that waits is answered when the reviewer has said, and that answer's account signs", async () => {
    const slowPush = { ...push, branch: "issue/19", nonce: "9".repeat(32) };
    const slowMessage = formatApproval(slowPush);
    slow = slowPush.branch;
    listed = [{ message: slowMessage, at: "2026-11-12T00:00:00Z" }];
    approved.length = 0;
    try {
      await listedNow();
      const waiting = held(`/pending?since=${await tagNow()}`);
      await moment();
      assert.equal(waiting.answer.done, false, "nothing new: the answer waits");
      release();
      await waiting.asked;
      const [shown] = waiting.answer.body!.pending as { review: Record<string, unknown> }[];
      assert.ok(shown!.review.account, "the reviewer's account, as soon as it said");
      const signs = await approve({
        nonce: slowPush.nonce,
        token: pushToken(approveToken(), slowMessage),
        commit: slowPush.commit,
      });
      assert.equal(signs.status, 200, signs.body);
      assert.deepEqual(approved, [
        signedFor(slowMessage, { commit: slowPush.commit, squashes: null, ...SENDS }),
      ]);
    } finally {
      slow = "";
      approved.length = 0;
      listed = [{ message, at: "2026-11-12T00:00:00Z" }];
    }
  });

  it("the root's user swaps the text under a page that waits: the page is told, and its click for what it drew signs nothing", async () => {
    const drawn = { ...push, branch: "issue/20", nonce: "a".repeat(32) };
    const drawnMessage = formatApproval(drawn);
    const swappedMessage = formatApproval({ ...drawn, commit: "b".repeat(40) });
    approved.length = 0;
    try {
      listed = [{ message: drawnMessage, at: "2026-11-12T00:00:00Z" }];
      await listedNow();
      const shownDrawn = lastShown.get(drawn.nonce)!;
      const waiting = held(`/pending?since=${await tagNow()}`);
      await moment();
      assert.equal(waiting.answer.done, false);
      listed = [{ message: swappedMessage, at: "2026-11-12T00:00:00Z" }];
      rootMoved();
      await waiting.asked;
      const [told] = waiting.answer.body!.pending as { token: string; commit: string }[];
      assert.equal(told!.commit, "b".repeat(40), "the page is told of the text the root lists now");
      assert.equal(told!.token, pushToken(approveToken(), swappedMessage));
      const stale = await approve({
        nonce: drawn.nonce,
        token: pushToken(approveToken(), drawnMessage),
        commit: drawn.commit,
        shown: shownDrawn,
      });
      assert.equal(stale.status, 409, stale.body);
      assert.deepEqual(approved, [], "nothing signed for what the page drew before");
      // CONTROL: the text the page is shown now, once its account is, signs: that one.
      await listedNow();
      const control = await approve({
        nonce: drawn.nonce,
        token: pushToken(approveToken(), swappedMessage),
        commit: "b".repeat(40),
      });
      assert.equal(control.status, 200, control.body);
      assert.deepEqual(approved, [
        signedFor(swappedMessage, { commit: "b".repeat(40), squashes: null, ...SENDS }),
      ]);
    } finally {
      approved.length = 0;
      listed = [{ message, at: "2026-11-12T00:00:00Z" }];
    }
  });

  it("two pages: one that waits on an older list does not drop a push the other has just been shown", async () => {
    const late = { ...push, branch: "issue/21", nonce: "b".repeat(32) };
    const lateMessage = formatApproval(late);
    listed = [{ message, at: "2026-11-12T00:00:00Z" }];
    await listedNow();
    dropped.length = 0;
    slow = late.branch;
    try {
      const first = held(`/pending?since=${await tagNow()}`);
      await moment();
      // The push comes; the other page (the frame beside the git terminal) sees it first, and
      // its reviewer's news wakes the first page, whose own wait on the root has not answered.
      listed = [...listed, { message: lateMessage, at: "2026-11-12T00:00:00Z" }];
      await call("GET", "/pending", asPage());
      await moment();
      assert.deepEqual(dropped, [], "the push the first page's list is older than is kept");
      first.gone();
      // CONTROL: a list asked for after it, without it, does drop it.
      listed = [{ message, at: "2026-11-12T00:00:00Z" }];
      await call("GET", "/pending", asPage());
      assert.deepEqual(dropped, [late.branch]);
    } finally {
      slow = "";
      release();
      listed = [{ message, at: "2026-11-12T00:00:00Z" }];
    }
  });

  it("a wait lives as long as the page's request: the root's wait ends when the page goes", async () => {
    listed = [{ message, at: "2026-11-12T00:00:00Z" }];
    await listedNow();
    waitsEnded.length = 0;
    const waiting = held(`/pending?since=${await tagNow()}`);
    await moment();
    assert.equal(waiting.answer.done, false, "control: nothing new, so the page waits");
    assert.deepEqual(waitsEnded, [], "and so does the root");
    waiting.gone();
    await moment();
    assert.equal(waitsEnded.length, 1, "the root's wait ended with the page's request");
    assert.equal(waiting.answer.done, false);
  });

  it("a page that waits has the root asked once, not once a second", async () => {
    listed = [{ message, at: "2026-11-12T00:00:00Z" }];
    await listedNow();
    const heldFor = async () => {
      askedOfRoot = 0;
      const waiting = held(`/pending?since=${await tagNow()}`);
      await moment(3500);
      assert.equal(waiting.answer.done, false, "nothing new: the page waits");
      waiting.gone();
      await moment();
      return askedOfRoot;
    };
    // The page's first look, the held request's own, then one wait for all of the 3.5 s.
    assert.equal(await heldFor(), 3);
    // CONTROL: a root that answers at once, as one asked the old way does, is asked again each
    // second: the count would show a look a second.
    rootWaits = false;
    try {
      assert.ok((await heldFor()) >= 5);
    } finally {
      rootWaits = true;
    }
  });

  it("a body over its bound is refused as too large, not as not JSON", async () => {
    const big = await approve({ ...good(), pad: "x".repeat(5000) });
    assert.equal(big.status, 413, big.body);
    assert.match(big.body, /the request is 5 KiB, over the 4 KiB this page takes/);
    const notJson = await call(
      "POST",
      "/approve",
      { ...asPage(), origin: ORIGIN, "content-type": "application/json" },
      "{nope",
    );
    assert.equal(notJson.status, 400, "control: a small body that is not JSON is that");
    assert.match(notJson.body, /not JSON/);
    assert.deepEqual(approved, []);
  });

  it("nothing signs without everything: a form, another origin, no push token, a made-up push, another commit", async () => {
    assert.equal(
      (await approve(good(), { "content-type": "application/x-www-form-urlencoded" })).status,
      415,
      "a form another site could send",
    );
    assert.equal((await approve(good(), { "content-type": "text/plain" })).status, 415);
    assert.equal(
      (await approve(good(), { origin: "http://web-one-abc123.localhost:31599" })).status,
      403,
      "another origin",
    );
    assert.equal((await approve(good(), { origin: "null" })).status, 403);
    assert.equal(
      (await approve({ ...good(), token: "0".repeat(64) })).status,
      409,
      "a push token it did not give",
    );
    assert.equal((await approve({ ...good(), token: "short" })).status, 403, "not a token at all");
    assert.equal(
      (await approve({ ...good(), nonce: "2".repeat(32) })).status,
      410,
      "a push that is not waiting",
    );
    assert.equal(
      (await approve({ ...good(), commit: "b".repeat(40) })).status,
      409,
      "a commit the push does not name",
    );
    assert.equal(
      (await approve(good(), { cookie: "desolate_approve_x=" + "0".repeat(48) })).status,
      401,
      "another cookie",
    );
    assert.deepEqual(approved, [], "nothing was signed");
  });

  it("the root's user lists another text under the same nonce after the page drew it: nothing is signed", async () => {
    // A decoy was shown (same nonce, same commit, another branch); the real text is listed at
    // the click. The token is over the text the page showed, so it does not match.
    const decoy = formatApproval({ ...push, branch: "harmless" });
    const shownToken = pushToken(approveToken(), decoy);
    const swapped = await approve({ nonce: push.nonce, token: shownToken, commit: push.commit });
    assert.equal(swapped.status, 409);
    assert.match(swapped.body, /not the one this page showed/);
    assert.deepEqual(approved, []);
    listed = [{ message, at: "2026-11-12T00:00:00Z" }];
  });

  it("control: the page's own approval signs exactly the push it showed, with what the reviewer says it sends", async () => {
    await listedNow();
    const answer = await approve(good());
    assert.equal(answer.status, 200, answer.body);
    assert.deepEqual(approved, [signed]);
    assert.ok(signed.includes(`\npack: ${"e".repeat(64)}\nlfs: 1 ${SENDS.lfs.digest}\n`));
    const no = await call(
      "POST",
      "/refuse",
      { ...asPage(), origin: ORIGIN, "content-type": "application/json" },
      JSON.stringify(good()),
    );
    assert.equal(no.status, 200);
    assert.deepEqual(refused, [message]);
  });

  it("a push signs only as the page listed it; a squash signs the reviewer's squash; a replace signs only confirmed", async () => {
    listed = [{ message: otherMessage, at: "2026-11-12T00:00:00Z" }];
    approved.length = 0;
    const click = (extra: Record<string, unknown> = {}) =>
      approve({
        nonce: other.nonce,
        token: pushToken(approveToken(), otherMessage),
        commit: other.commit,
        ...extra,
      });
    // Before the page has listed the reviewer's account: nothing is signed.
    const early = await click({ replace: true });
    assert.equal(early.status, 409, early.body);
    assert.match(early.body, /has not shown desolate's reviewer's account of this push yet/);
    await listedNow();
    const unconfirmed = await click();
    assert.equal(unconfirmed.status, 409);
    assert.match(unconfirmed.body, /replaces the remote's branch: confirm the replace/);
    assert.deepEqual(approved, [], "nothing signed without the replace confirmed");
    const squashed = await click({ replace: true, squash: true });
    assert.equal(squashed.status, 200, squashed.body);
    assert.deepEqual(approved, [
      signedFor(otherMessage, { commit: "5".repeat(40), squashes: other.commit, ...SQUASH_SENDS }),
    ]);
    listed = [{ message, at: "2026-11-12T00:00:00Z" }];
  });

  it("after approving, the page is told how the push it signed ended, by the pusher's word on that very move alone", async () => {
    listed = [{ message, at: "2026-11-12T00:00:00Z" }];
    approved.length = 0;
    // An approval not yet heard of keeps the pusher's log followed with no page open: a page
    // asks again after each answer, and a word that came between two asks was missed.
    assert.ok(pusherHeard, "the earlier tests' approvals, not heard of: followed, no page open");
    for (const signed of everSigned) {
      const field = (name: string) => new RegExp(`^${name}: (.+)$`, "m").exec(signed)![1]!;
      const [repo, branch, commit, onto] = ["repo", "branch", "commit", "onto"].map(field);
      pusherHeard?.({
        type: "push-failed",
        repo: repo!,
        branch: branch!,
        commit: commit!,
        onto: onto === "none" ? null : onto!,
        error: "ended by the test",
      });
    }
    await moment();
    assert.equal(
      pusherHeard,
      null,
      "control: nobody looks and no approval waits to be heard of, so the log is not followed",
    );
    await listedNow();
    const looking = held(`/pending?since=${await tagNow()}`);
    await moment();
    assert.ok(pusherHeard, "a page looks at a push: the pusher is heard");
    const before = Date.now();
    assert.equal((await approve(good())).status, 200);
    await looking.asked;
    // Every page is told at once that it is being pushed: the names the Mac signed, and when.
    const token = pushToken(approveToken(), message);
    type Told = { token: string; pushed: boolean; error?: string; at: number };
    const mine = (body: Record<string, unknown> | null) =>
      (body!.approved as Told[]).filter((d) => d.token === token && !d.error);
    const pushing = mine(looking.answer.body);
    assert.equal(pushing.length, 1);
    assert.ok(pushing[0]!.at >= before && pushing[0]!.at <= Date.now());
    assert.deepEqual(pushing, [
      {
        token,
        repo: push.repo,
        branch: push.branch,
        commit: push.commit,
        onto: null,
        squashes: null,
        at: pushing[0]!.at,
        pushed: false,
      },
    ]);
    const ending = held(`/pending?since=${await tagNow()}`);
    // The pusher's word on another commit of the branch, another repository, or the same
    // commit moved from elsewhere: not this push.
    const move = { repo: push.repo, branch: push.branch, commit: push.commit, onto: null };
    pusherSays({ type: "pushed", ...move, commit: "b".repeat(40) });
    pusherSays({ type: "pushed", ...move, repo: "acme/other" });
    pusherSays({ type: "pushed", ...move, onto: "c".repeat(40) });
    await moment();
    assert.equal(ending.answer.done, false, "nothing said for a push this page did not sign");
    pusherSays({ type: "pushed", ...move });
    await ending.asked;
    assert.deepEqual(mine(ending.answer.body), [
      {
        ...pushing[0]!,
        pushed: true,
        link: "https://github.com/acme/widgets/compare/issue/12?expand=1",
      },
    ]);
    await moment();
    assert.equal(
      pusherHeard,
      null,
      "no page looks and the push is heard of: the pusher is not heard",
    );
    const later = JSON.parse((await call("GET", "/pending", asPage())).body) as {
      approved: unknown;
    };
    assert.deepEqual(later.approved, ending.answer.body!.approved, "and what it said is kept");
  });

  it("a push's word that comes while no page asks (between two of a page's asks) is kept for its next ask, as a reload finds it", async () => {
    listed = [{ message, at: "2026-11-12T00:00:00Z" }];
    approved.length = 0;
    await listedNow();
    const looking = held(`/pending?since=${await tagNow()}`);
    await moment();
    assert.equal((await approve(good())).status, 200);
    // The page's ask ends (answered, or the tab reloading): no page is open.
    looking.gone();
    await moment();
    assert.ok(pusherHeard, "an approval not heard of: the pusher is still followed");
    // What the forge said, as the pusher's log has it: the page is given it as text, made
    // printable (host/events.ts made it so first; here again).
    pusherSays({
      type: "push-failed",
      repo: push.repo,
      branch: push.branch,
      commit: push.commit,
      onto: null,
      error: "refused\u001b[2J <img src=x onerror=alert(1)> \u202eevil",
    });
    await moment();
    assert.equal(pusherHeard, null, "heard of, and no page: no longer followed");
    const next = JSON.parse((await call("GET", "/pending", asPage())).body) as {
      approved: { token: string; pushed: boolean; error?: string; uncertain?: boolean }[];
    };
    assert.deepEqual(
      next.approved
        .filter((d) => d.token === pushToken(approveToken(), message))
        .map((d) => [d.pushed, d.error, d.uncertain])
        .pop(),
      [false, "refused?[2J <img src=x onerror=alert(1)> ?evil", false],
      "the page's next ask (a reload's first) is told it failed, and why, as text",
    );
  });

  it("a flood of the pusher's words: what the page is told stays as many approvals as a person made, each ended once", async () => {
    listed = [{ message, at: "2026-11-12T00:00:00Z" }];
    approved.length = 0;
    await listedNow();
    assert.equal((await approve(good())).status, 200);
    const tagBefore = await tagNow();
    const size = (await call("GET", "/pending", asPage())).body.length;
    assert.ok(pusherHeard, "an approval not heard of: the pusher is followed");
    // 100,000 words for moves nobody signed, each with 10,000 characters of why: nothing.
    const long = "x".repeat(10_000);
    for (let i = 0; i < 100_000; i++)
      pusherSays({
        type: "push-failed",
        repo: push.repo,
        branch: push.branch,
        commit: i.toString(16).padStart(40, "0"),
        onto: null,
        error: long,
      });
    assert.equal(await tagNow(), tagBefore, "no word on a move signed here: the page is not told");
    // CONTROL: the word on the move signed ends that approval, once, with at most
    // printable's 4,000 characters of why; the many after it change nothing (ended, and no
    // page open, the log is no longer followed: endedBy's own tests show the once).
    for (let i = 0; i < 1000; i++)
      pusherHeard?.({
        type: i ? "pushed" : "push-failed",
        repo: push.repo,
        branch: push.branch,
        commit: push.commit,
        onto: null,
        error: long,
      });
    const body = (await call("GET", "/pending", asPage())).body;
    const told = (JSON.parse(body) as { approved: { error?: string }[] }).approved;
    assert.ok(told.length <= 16, `${told.length} approvals told`);
    assert.equal(told.at(-1)!.error!.length, 4000);
    assert.ok(body.length < size + 4100, `${body.length} bytes, from ${size}`);
  });

  it("a click the keyring refuses is never told to a page as approved, and takes no other approval's place", async () => {
    listed = [{ message, at: "2026-11-12T00:00:00Z" }];
    approved.length = 0;
    await listedNow();
    type Told = { token: string; pushed: boolean; error?: string };
    const toldNow = async () =>
      (JSON.parse((await call("GET", "/pending", asPage())).body) as { approved: Told[] }).approved;
    // Sixteen approvals taken (the most kept), each ended, so the oldest is the one a new one
    // would push out.
    for (let i = 0; i < 16; i++) {
      assert.equal((await approve(good())).status, 200);
      pusherSays({
        type: "push-failed",
        repo: push.repo,
        branch: push.branch,
        commit: push.commit,
        onto: null,
        error: `ended ${i}`,
      });
    }
    const before = await toldNow();
    assert.equal(before.length, 16);
    // The keyring holds its answer: a page that asks meanwhile (a reload, another tab) is not
    // told of the click.
    let answer = (_: string) => {};
    keyringSays = new Promise((resolve) => (answer = resolve));
    const clicked = approve(good());
    await moment();
    assert.deepEqual(await toldNow(), before, "not told while the keyring has not taken it");
    answer("the challenge is no longer outstanding");
    const refused = await clicked;
    keyringSays = null;
    assert.equal(refused.status, 502, refused.body);
    assert.deepEqual(await toldNow(), before, "after its refusal: nothing told, nothing dropped");
    assert.ok(
      (JSON.parse((await call("GET", "/pending", asPage())).body) as { pending: unknown[] }).pending
        .length === 1,
      "and the push is listed as waiting",
    );
    // CONTROL: the same click, taken: told, and the oldest goes to make room.
    keyringSays = Promise.resolve("");
    assert.equal((await approve(good())).status, 200);
    keyringSays = null;
    const after = await toldNow();
    assert.equal(after.length, 16);
    assert.deepEqual(after.slice(0, 15), before.slice(1));
    assert.equal(after[15]!.pushed, false);
    assert.equal(after[15]!.error, undefined);
    pusherHeard?.({
      type: "push-failed",
      repo: push.repo,
      branch: push.branch,
      commit: push.commit,
      onto: null,
      error: "ended",
    });
  });

  it('the same move approved twice: the pusher\'s "pushed" ends both, whichever word comes first; a refusal ends the older alone', async () => {
    // Two texts of the same move (another nonce): pushed again after the first one's word.
    const again = { ...push, nonce: "6".repeat(32) };
    const againMessage = formatApproval(again);
    const move = { repo: push.repo, branch: push.branch, commit: push.commit, onto: null };
    type Told = { token: string; pushed: boolean; error?: string };
    const states = async () =>
      Object.fromEntries(
        (
          JSON.parse((await call("GET", "/pending", asPage())).body) as { approved: Told[] }
        ).approved
          .filter((t) =>
            [pushToken(approveToken(), message), pushToken(approveToken(), againMessage)].includes(
              t.token,
            ),
          )
          .map((t) => [t.token === pushToken(approveToken(), message) ? "first" : "again", t]),
      ) as Record<string, Told>;
    const both = async () => {
      listed = [{ message, at: "2026-11-12T00:00:00Z" }];
      await listedNow();
      assert.equal((await approve(good())).status, 200);
      listed = [{ message: againMessage, at: "2026-11-12T00:00:00Z" }];
      await listedNow();
      assert.equal(
        (
          await approve({
            nonce: again.nonce,
            token: pushToken(approveToken(), againMessage),
            commit: again.commit,
          })
        ).status,
        200,
      );
    };
    // The first one's word missed; the second finds the remote there already: "pushed".
    await both();
    pusherSays({ type: "pushed", ...move });
    await moment();
    let now = await states();
    assert.deepEqual([now.first?.pushed, now.again?.pushed], [true, true]);
    // A refusal: the older one alone, and the next word ends the next.
    await both();
    pusherSays({ type: "push-failed", ...move, error: "the forge refused" });
    await moment();
    now = await states();
    assert.deepEqual(
      [now.first?.error, now.again?.pushed, now.again?.error],
      ["the forge refused", false, undefined],
    );
    pusherSays({ type: "pushed", ...move });
    await moment();
    now = await states();
    assert.deepEqual([now.first?.error, now.again?.pushed], ["the forge refused", true]);
    listed = [{ message, at: "2026-11-12T00:00:00Z" }];
  });

  it("a push the reviewer could not describe is not signed, though the page listed it", async () => {
    listed = [{ message: unreviewedMessage, at: "2026-11-12T00:00:00Z" }];
    approved.length = 0;
    await listedNow();
    const clicked = await approve({
      nonce: unreviewed.nonce,
      token: pushToken(approveToken(), unreviewedMessage),
      commit: unreviewed.commit,
    });
    assert.equal(clicked.status, 409, clicked.body);
    assert.match(
      clicked.body,
      /desolate's reviewer could not say what this push would send \(bad object\)/,
    );
    assert.deepEqual(approved, [], "nothing signed");
    // CONTROL: the same page, the same poll, for a push the reviewer describes, signs.
    const described = { ...push, branch: "issue/15", nonce: "4".repeat(32) };
    const describedMessage = formatApproval(described);
    listed = [{ message: describedMessage, at: "2026-11-12T00:00:00Z" }];
    await listedNow();
    const control = await approve({
      nonce: described.nonce,
      token: pushToken(approveToken(), describedMessage),
      commit: described.commit,
    });
    assert.equal(control.status, 200, control.body);
    assert.deepEqual(approved, [
      signedFor(describedMessage, { commit: described.commit, squashes: null, ...SENDS }),
    ]);
    approved.length = 0;
    listed = [{ message, at: "2026-11-12T00:00:00Z" }];
  });

  it("/embed: framed by the git terminal's origin alone, and its key opens only what the page's own requests open", async () => {
    const framed = await call("GET", "/embed", {
      "sec-fetch-site": "same-site",
      "sec-fetch-dest": "iframe",
    });
    assert.equal(
      framed.status,
      200,
      "loaded as a frame, by the git terminal's page (another site)",
    );
    assert.equal(
      (
        await call("GET", "/embed", {
          "sec-fetch-site": "cross-site",
          "sec-fetch-dest": "iframe",
          host: "evil.example:31599",
        })
      ).status,
      421,
      "still by this name only",
    );
    assert.equal(
      (
        await call("GET", "/embed?tkn=x", {
          "sec-fetch-site": "cross-site",
          "sec-fetch-dest": "iframe",
        })
      ).status,
      403,
      "and only the bare page",
    );
    assert.equal(
      (
        await call("GET", "/embed", {
          "sec-fetch-site": "cross-site",
          "sec-fetch-dest": "document",
        })
      ).status,
      403,
      "not as a window another site opens",
    );
    assert.equal(
      (await call("GET", "/embed", {})).status,
      403,
      "nor as anything that does not say it is a frame",
    );
    assert.match(
      String(framed.headers["content-security-policy"]),
      /frame-ancestors http:\/\/desolate-git\.localhost:31599(;|$)/,
      "that one origin, exactly",
    );
    assert.equal(
      framed.headers["x-frame-options"],
      undefined,
      "(X-Frame-Options cannot name an origin: frame-ancestors alone governs /embed)",
    );
    assert.match(String(framed.headers["content-security-policy"]), /script-src 'self'/);
    assert.match(
      String((await call("GET", "/", {})).headers["content-security-policy"]),
      /frame-ancestors 'none'/,
      "the page at / still cannot be framed at all",
    );
    const address = embedAddress();
    assert.match(
      address,
      /^http:\/\/desolate-approve\.localhost:31599\/embed#k=[0-9a-f]{64}$/,
      "the key is in the fragment, which no request carries",
    );
    const key = /#k=([0-9a-f]{64})$/.exec(address)![1]!;
    assert.notEqual(key, approveToken(), "and it is not the address's token");
    assert.equal(
      (await call("GET", `/?tkn=${key}`, {})).status,
      403,
      "the key is no token: it gives no cookie",
    );
    const embedded = { "x-desolate-embed": key, ...page };
    assert.equal(
      (await call("GET", "/pending", embedded)).status,
      200,
      "the embedded page's own request",
    );
    assert.equal(
      (await call("GET", "/pending", { ...embedded, "x-desolate-embed": "0".repeat(64) })).status,
      401,
      "another key",
    );
    assert.equal(
      (await call("GET", "/pending", { "x-desolate-embed": key, "sec-fetch-site": "same-site" }))
        .status,
      403,
      "from the git terminal's page itself, or any page but this one",
    );
    assert.equal(
      (await call("GET", "/pending", { "x-desolate-embed": key, "sec-fetch-site": "cross-site" }))
        .status,
      403,
    );
    const before = approved.length;
    const fromElsewhere = await call(
      "POST",
      "/approve",
      {
        "x-desolate-embed": key,
        "sec-fetch-site": "same-site",
        origin: "http://desolate-git.localhost:31599",
        "content-type": "application/json",
      },
      JSON.stringify(good()),
    );
    assert.equal(
      fromElsewhere.status,
      403,
      "the git terminal's origin cannot approve with the key",
    );
    assert.equal(approved.length, before);
    // (The account of this push was dropped when the list changed under the last test: the
    // frame lists it again, as its own poll does, before it may be signed.)
    await listedNow();
    const fromFrame = await call(
      "POST",
      "/approve",
      { ...embedded, origin: ORIGIN, "content-type": "application/json" },
      JSON.stringify(good()),
    );
    assert.equal(fromFrame.status, 200, "control: the framed page's own click signs");
  });

  it("an issue is published only as the page showed it: another word in it by the time of the click, and nothing is", async () => {
    const issue = {
      id: "mh0abc12-0123abcd",
      domain: "dev",
      workspace: "w1",
      repo: "acme/widgets",
      title: "Fix <img src=x onerror=alert(1)>",
      body: "Steps: `$(id)`\n\n<script>alert(1)</script>",
      labels: ["bug", "desolate:run"],
      at: "2026-11-16T00:00:00Z",
      state: "approving",
    };
    issuesListed = [
      issue,
      { ...issue, id: "bad", title: "an id that is not one" },
      { ...issue, id: "mh0abc12-0123abce", title: "hidden \u202e text" },
    ];
    const listed = await call("GET", "/issues", asPage());
    assert.equal(listed.status, 200);
    const shown = (
      JSON.parse(listed.body) as { issues: { id: string; token: string; title: string }[] }
    ).issues;
    assert.deepEqual(
      shown.map((i) => i.id),
      [issue.id],
      "only issues whose every field is one desolate carries",
    );
    assert.equal(shown[0]!.title, issue.title, "as JSON text; the page sets it as text");
    const ask = (body: Record<string, unknown>) =>
      call(
        "POST",
        "/issue",
        { ...asPage(), origin: ORIGIN, "content-type": "application/json" },
        JSON.stringify(body),
      );
    // The root lists another body under the same id after the page showed it: refused.
    issuesListed = [{ ...issue, body: "a different body" }];
    assert.equal((await ask({ id: issue.id, token: shown[0]!.token, do: "publish" })).status, 409);
    assert.deepEqual(published, []);
    assert.equal(
      (
        await call(
          "POST",
          "/issue",
          {
            ...asPage(),
            origin: "http://evil.localhost:31599",
            "content-type": "application/json",
          },
          JSON.stringify({ id: issue.id, token: shown[0]!.token, do: "publish" }),
        )
      ).status,
      403,
      "another origin",
    );
    // Control: the very issue shown, published.
    issuesListed = [issue];
    const done = await ask({
      id: issue.id,
      token: issueToken(approveToken(), issue as never),
      do: "publish",
    });
    assert.equal(done.status, 200, done.body);
    assert.deepEqual(published, [issue.title]);
    assert.equal((await ask({ id: issue.id, token: shown[0]!.token, do: "refuse" })).status, 200);
    assert.deepEqual(notNow, [issue.id]);
  });
});
