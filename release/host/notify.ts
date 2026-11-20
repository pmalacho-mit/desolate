// `desolate notify`: macOS notifications for what needs the person, until stopped: a push
// waiting for approval, a branch offered, an agent asking for a human, a push that went out
// or failed. It reads `desolate events` (events.ts) and shows a few of them.
//
// What an agent wrote (a status message, a branch name) is shown as the agent's words, under
// its workspace's name: a notification is not desolate saying so. It is passed to osascript
// as an argument, never as script.
import { spawn } from "node:child_process";
import { printable } from "../shared/text.ts";
import { EXIT, refuse } from "../shared/exit.ts";
import { readPhone } from "./phone.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Invoke, Table } from "../../suede.nests/dsl.import.meta.vitest.ts";

export type Notice = { title: string; body: string };

const short = (commit: unknown) => String(commit ?? "").slice(0, 12);

/** The notification for an event, or null for one not worth interrupting anyone for. */
export const notice = (e: Record<string, unknown>): Notice | null => {
  const text = (value: unknown, max = 160) => printable(value, max);
  const where = `${text(e.domain, 40)}/${text(e.workspace, 40)}`;
  if (e.source === "root" && e.type === "approval-waiting" && e.repo)
    return {
      title: "desolate: a push waits for you",
      body: `${text(e.repo)} ${text(e.branch)}: approve it beside the git terminal, or desolate approve --web`,
    };
  if (e.source === "root" && e.type === "offered" && e.repo)
    return {
      title: `desolate: ${where} offered a branch`,
      body: `${text(e.repo)} ${text(e.branch)} at ${short(e.commit)}: desolate review, or the dashboard`,
    };
  if (e.source === "root" && e.type === "status" && (e.color === "orange" || e.color === "red"))
    return {
      title: `desolate: ${where} ${e.color === "red" ? "failed" : "asks for you"}`,
      body: `${where} says: ${text(e.message)}`,
    };
  if (e.source === "root" && e.type === "bundle-refused")
    return {
      title: `desolate: refused work from ${text(e.domain, 40)}`,
      body: `${text(e.repo)}: ${text(e.why)}`,
    };
  if (e.source === "pusher" && e.type === "pushed")
    return {
      title: "desolate: pushed",
      body: `${text(e.repo)} ${text(e.branch)} is now ${short(e.commit)}`,
    };
  if (e.source === "pusher" && (e.type === "push-failed" || e.type === "push-uncertain"))
    return {
      title: `desolate: a push ${e.type === "push-failed" ? "failed" : "may not have landed"}`,
      body: `${text(e.repo)} ${text(e.branch)}: ${text(e.error)}`,
    };
  return null;
};

declare namespace notice {
  /** what needs the person interrupts */
  export type Waiting = Expect<
    Invoke<
      typeof notice,
      [e: { source: "root"; type: "approval-waiting"; repo: "acme/widgets"; branch: "issue/12" }]
    >,
    "=",
    {
      title: "desolate: a push waits for you";
      body: "acme/widgets issue/12: approve it beside the git terminal, or desolate approve --web";
    }
  >;
  /** an agent's words come under its workspace's name, made printable */
  export type AgentWords = Expect<
    Invoke<
      typeof notice,
      [
        e: {
          source: "root";
          type: "status";
          domain: "dev";
          workspace: "w1";
          color: "orange";
          message: "approve it now\u001b]0;x";
        },
      ]
    >,
    "=",
    { title: "desolate: dev/w1 asks for you"; body: "dev/w1 says: approve it now?]0;x" }
  >;
  /** green is not an interruption, and a source cannot claim another's event */
  export type Quiet = [
    Expect<
      Invoke<
        typeof notice,
        [
          e: {
            source: "root";
            type: "status";
            domain: "dev";
            workspace: "w1";
            color: "green";
            message: "done";
          },
        ]
      >,
      "=",
      null
    >,
    Expect<
      Invoke<
        typeof notice,
        [e: { source: "pusher"; type: "approval-waiting"; repo: "acme/widgets" }]
      >,
      "=",
      null
    >,
  ];
  /** red is a failure, said as the workspace's own words */
  export type Failed = Expect<
    Invoke<
      typeof notice,
      [
        e: {
          source: "root";
          type: "status";
          domain: "dev";
          workspace: "w1";
          color: "red";
          message: "the tests cannot run";
        },
      ]
    >,
    "=",
    { title: "desolate: dev/w1 failed"; body: "dev/w1 says: the tests cannot run" }
  >;
  /** an offer names its branch and the commit's first twelve digits */
  export type Offered = Expect<
    Invoke<
      typeof notice,
      [
        e: {
          source: "root";
          type: "offered";
          domain: "dev";
          workspace: "w1";
          repo: "acme/widgets";
          branch: "issue/12";
          commit: "0123456789abcdef0123456789abcdef01234567";
        },
      ]
    >,
    "=",
    {
      title: "desolate: dev/w1 offered a branch";
      body: "acme/widgets issue/12 at 0123456789ab: desolate review, or the dashboard";
    }
  >;
  /** work the root would not take from a domain, and why, under that domain's name */
  export type BundleRefused = Expect<
    Invoke<
      typeof notice,
      [
        e: {
          source: "root";
          type: "bundle-refused";
          domain: "dev";
          repo: "acme/widgets";
          why: "a .git directory inside a tree";
        },
      ]
    >,
    "=",
    {
      title: "desolate: refused work from dev";
      body: "acme/widgets: a .git directory inside a tree";
    }
  >;
  /** what the forge answered, from the pusher only: landed, failed, or not known */
  export type Pushes = [
    Expect<
      Invoke<
        typeof notice,
        [
          e: {
            source: "pusher";
            type: "pushed";
            repo: "acme/widgets";
            branch: "issue/12";
            commit: "0123456789abcdef0123456789abcdef01234567";
          },
        ]
      >,
      "=",
      { title: "desolate: pushed"; body: "acme/widgets issue/12 is now 0123456789ab" }
    >,
    Expect<
      Invoke<
        typeof notice,
        [
          e: {
            source: "pusher";
            type: "push-failed";
            repo: "acme/widgets";
            branch: "issue/12";
            error: "rejected: non-fast-forward";
          },
        ]
      >,
      "=",
      {
        title: "desolate: a push failed";
        body: "acme/widgets issue/12: rejected: non-fast-forward";
      }
    >,
    Expect<
      Invoke<
        typeof notice,
        [
          e: {
            source: "pusher";
            type: "push-uncertain";
            repo: "acme/widgets";
            branch: "issue/12";
            error: "the forge did not answer";
          },
        ]
      >,
      "=",
      {
        title: "desolate: a push may not have landed";
        body: "acme/widgets issue/12: the forge did not answer";
      }
    >,
  ];
  /** the root's user cannot say a push landed: that is the pusher's word, from a log only root writes */
  export type RootSaysPushed = Expect<
    Invoke<
      typeof notice,
      [
        e: {
          source: "root";
          type: "pushed";
          repo: "acme/widgets";
          branch: "main";
          commit: "0123456789abcdef0123456789abcdef01234567";
        },
      ]
    >,
    "=",
    null
  >;
}

const show = (n: Notice) => {
  if (process.platform === "darwin")
    spawn(
      "osascript",
      [
        "-e",
        "on run argv",
        "-e",
        'display notification (item 2 of argv) with title (item 1 of argv) sound name "Glass"',
        "-e",
        "end run",
        n.title,
        n.body,
      ],
      { stdio: "ignore" },
    ).on("error", () => {});
  else spawn("notify-send", [n.title, n.body], { stdio: "ignore" }).on("error", () => {});
};

/** One notification for ntfy (ntfy.sh, or a server of your own), as its JSON publish: the
 *  topic is the URL's path, which is the only secret a topic has, so `desolate notify` is
 *  given the whole URL and prints none of it. `click`: what tapping it opens (the dashboard
 *  on the tailnet, when `desolate phone` is on). */
export const ntfyRequest = (
  topicUrl: string,
  n: Notice,
  click?: string,
): { endpoint: string; body: string } | { refused: string } => {
  let url: URL;
  try {
    url = new URL(topicUrl);
  } catch {
    return {
      refused: "--ntfy takes the topic's whole address: https://ntfy.sh/<a long random topic>",
    };
  }
  const topic = url.pathname.replace(/^\//, "");
  if (url.protocol !== "https:")
    return { refused: "--ntfy takes an https address: the alert's text crosses the internet" };
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(topic))
    return {
      refused: "--ntfy takes https://<server>/<topic>, a topic of letters, digits, - and _",
    };
  // The topic is the only secret an ntfy topic has: anyone who knows it reads every message
  // (repositories, branches, what agents say) and can publish to it. A short one is guessed.
  if (topic.length < 20)
    return {
      refused:
        "--ntfy needs a topic of 20 characters or more, hard to guess: anyone who knows it reads what is sent (desolate-$(openssl rand -hex 8))",
    };
  return {
    endpoint: `${url.origin}/`,
    body: JSON.stringify({ topic, title: n.title, message: n.body, ...(click ? { click } : {}) }),
  };
};

declare namespace ntfyRequest {
  /** the topic from the address, the notification's words as JSON (never as a header) */
  export type Publishes = Expect<
    Invoke<
      typeof ntfyRequest,
      [
        topicUrl: "https://ntfy.sh/desolate-x7Kq2b9Lm4Pz",
        n: { title: "desolate: dev/w1 asks for you"; body: "dev/w1 says: which API version?" },
        click: "https://mac.tail1234.ts.net:8443/",
      ]
    >,
    "=",
    {
      endpoint: "https://ntfy.sh/";
      body: '{"topic":"desolate-x7Kq2b9Lm4Pz","title":"desolate: dev/w1 asks for you","message":"dev/w1 says: which API version?","click":"https://mac.tail1234.ts.net:8443/"}';
    }
  >;
  /** not https, no topic, or a path that is not one topic */
  export type Refuses = Table<
    typeof ntfyRequest,
    [
      [
        args: [topicUrl: "http://ntfy.sh/t", n: { title: "t"; body: "b" }],
        expected: {
          refused: "--ntfy takes an https address: the alert's text crosses the internet";
        },
      ],
      [
        args: [topicUrl: "https://ntfy.sh/", n: { title: "t"; body: "b" }],
        expected: {
          refused: "--ntfy takes https://<server>/<topic>, a topic of letters, digits, - and _";
        },
      ],
      [
        args: [topicUrl: "https://ntfy.sh/desolate", n: { title: "t"; body: "b" }],
        expected: {
          refused: "--ntfy needs a topic of 20 characters or more, hard to guess: anyone who knows it reads what is sent (desolate-$(openssl rand -hex 8))";
        },
      ],
      [
        args: [topicUrl: "https://ntfy.sh/a/b", n: { title: "t"; body: "b" }],
        expected: {
          refused: "--ntfy takes https://<server>/<topic>, a topic of letters, digits, - and _";
        },
      ],
      [
        args: [topicUrl: "ntfy", n: { title: "t"; body: "b" }],
        expected: {
          refused: "--ntfy takes the topic's whole address: https://ntfy.sh/<a long random topic>";
        },
      ],
    ]
  >;
}

export const notify = async (out: (line: string) => void, ntfy?: string) => {
  if (ntfy !== undefined) {
    const checked = ntfyRequest(ntfy, { title: "", body: "" });
    if ("refused" in checked)
      refuse(
        checked.refused,
        "desolate notify --ntfy https://ntfy.sh/<a long random topic>",
        EXIT.usage,
      );
  }
  const { followEvents } = await import("./daemon.ts");
  const said = new Map<string, number>();
  const sentAt: number[] = [];
  let held = false;
  out(
    "desolate notify: notifications for pushes waiting, offers, agents asking for you, and pushes. Ctrl-C stops.",
  );
  if (ntfy !== undefined)
    out(
      `  each is also sent to ${new URL(ntfy).origin}: its operator, and anyone who knows the topic, can read them (repositories, branches, what agents say).`,
    );
  await followEvents(
    0,
    (line) => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      const n = notice(event);
      if (!n) return;
      // What a workspace makes happen (its status, its offers), at most once a minute of each
      // kind for each: an agent flipping its colour, or offering in a loop, must not teach
      // anyone to ignore desolate's notifications, nor use up an ntfy server's quota, so that
      // a push waiting for you no longer reaches your phone (audit, 2026-11-20).
      if (event.source === "root" && (event.type === "status" || event.type === "offered")) {
        const key = `${String(event.type)} ${String(event.domain)}/${String(event.workspace)}`;
        if (Date.now() - (said.get(key) ?? 0) < 60_000) return;
        said.set(key, Date.now());
      }
      out(`${new Date().toLocaleTimeString()}  ${n.title}: ${n.body}`);
      show(n);
      // At most 60 an hour to the phone, whatever sends them: a server's quota (ntfy.sh's is a
      // few hundred a day) must be left for a push waiting for you (audit, 2026-11-20).
      const now = Date.now();
      while (sentAt.length && now - sentAt[0]! > 3_600_000) sentAt.shift();
      if (ntfy !== undefined && sentAt.length >= 60) {
        if (!held)
          out(
            "  (60 sent to your phone this hour: the rest are shown here only, until the hour is up)",
          );
        held = true;
      } else if (ntfy !== undefined) {
        held = false;
        sentAt.push(now);
        const phone = readPhone();
        const sent = ntfyRequest(
          ntfy,
          n,
          phone ? `https://${phone.name}:${phone.httpsPort}/` : undefined,
        );
        if ("endpoint" in sent)
          void fetch(sent.endpoint, {
            method: "POST",
            body: sent.body,
            signal: AbortSignal.timeout(10_000),
          })
            .then((r) => !r.ok && out(`  (ntfy answered ${r.status}: not sent to your phone)`))
            .catch(() => out("  (ntfy did not answer: not sent to your phone)"));
      }
    },
    (resume) => resume(),
  );
};
