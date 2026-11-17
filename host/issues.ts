// Issues workspaces offered, on the Mac (shared/issues.ts says how they come here):
//
//   desolate issues [--json]                 what is waiting: offered (a draft on the
//                                            dashboard) and to publish (waiting for you here)
//   desolate issue publish <id>              shows every word of it; type `publish` to create it
//   desolate issue refuse <id>               back to a draft on the dashboard
//
// The approval page (desolate approve --web) publishes them with one click as well. Either
// way the issue is created by YOUR gh, on this Mac, as you: each field one argument, the body
// in a file of this host's own. No shell reads any of it.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { EXIT, Refusal, refuse } from "../shared/exit.ts";
import { digestOf, draftOf, issueUrl } from "../shared/issues.ts";
import { readJson, writeJson } from "../shared/json.ts";
import { isSlug } from "../shared/names.ts";
import type { Issue } from "../shared/issues.ts";
import { printable, printableLines } from "../shared/text.ts";
import { paths } from "./paths.ts";
import { rootctl } from "./stack.ts";
import type { Expect, Given, Invoke, Mock } from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { emptyHome } from "../.harness/home.ts";
import type { errorOf, fakeGh, ghCalls } from "../.harness/host-gh.ts";
import type { collect, fakeStack, rootAnswers, rootAsked, said } from "../.harness/host-stack.ts";
import type { refusalOf } from "../.harness/refusal.ts";

type Out = (line: string) => void;

/** Create it on GitHub with the host's gh (DESOLATE_GH names another), and tell the root
 *  where it is. Returns its page. */
export const publish = async (issue: Issue): Promise<string> => {
  const draft = draftOf(issue);
  if ("error" in draft) throw new Error(`not published: ${draft.error}`);
  fs.mkdirSync(paths.state, { recursive: true, mode: 0o700 });
  // Once, whatever the page, the terminal or a retry after a failure that was not one: the
  // text's digest, recorded before gh runs and kept with its page after (audit, 2026-11-16:
  // a publish reported failed invited a second issue). One publish at a time, under one lock
  // (a lock a crash left is taken back after ten minutes).
  const digest = digestOf(draft);
  const record = path.join(paths.state, "issues-published.json");
  const lock = path.join(paths.state, "issues-publish.lock");
  try {
    fs.mkdirSync(lock);
  } catch {
    if (Date.now() - fs.statSync(lock).mtimeMs < 10 * 60_000)
      throw new Error(
        "not published: another issue is being published right now, from another page or terminal: try again in a moment",
      );
    // A stale lock is taken by renaming it aside, which only one of two can do (third review:
    // removing it then making it let both through).
    const aside = `${lock}.stale-${process.pid}`;
    try {
      fs.renameSync(lock, aside);
    } catch {
      throw new Error(
        "not published: another issue is being published right now: try again in a moment",
      );
    }
    // What was renamed may be a fresh lock, made by another that took the stale one a moment
    // before (final review): put back, and this one waits.
    if (Date.now() - fs.statSync(aside).mtimeMs < 10 * 60_000) {
      fs.renameSync(aside, lock);
      throw new Error(
        "not published: another issue is being published right now: try again in a moment",
      );
    }
    fs.rmSync(aside, { recursive: true, force: true });
    fs.mkdirSync(lock);
  }
  const forget = () => {
    const { [digest]: _, ...rest } = readJson<Record<string, string>>(record, {});
    writeJson(record, rest);
  };
  const dir = fs.mkdtempSync(path.join(paths.state, "issue-"));
  try {
    const known = readJson<Record<string, string>>(record, {})[digest];
    if (known !== undefined) {
      // Published already: the root is told again (it may not have taken it), and that is all.
      const page = issueUrl(draft.repo, known);
      if (page) {
        await rootctl(
          "issue.done",
          { id: issue.id, url: page, digest },
          { quiet: true, timeoutMs: 30_000 },
        ).catch(() => {});
        return page;
      }
      throw new Refusal(
        `not published again: an earlier attempt at this exact issue did not say how it ended (${printable(known, 120)})`,
        `look for it on GitHub (${draft.repo}); if it is not there, remove its line from ${record}, then publish again`,
      );
    }
    const body = path.join(dir, "body.md");
    fs.writeFileSync(body, draft.body, { mode: 0o600 });
    // `--flag=value`: a title or a label that starts with a dash is still that flag's value.
    const args = [
      "issue",
      "create",
      "--repo",
      draft.repo,
      `--title=${draft.title}`,
      "--body-file",
      body,
      ...draft.labels.map((label) => `--label=${label}`),
    ];
    writeJson(record, {
      ...readJson<Record<string, string>>(record, {}),
      [digest]: "an attempt whose outcome is not known",
    });
    const ran = spawnSync(process.env.DESOLATE_GH || "gh", args, {
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
    });
    if ((ran.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      forget();
      throw new Error(
        "gh could not be run: it is not installed (brew install gh, then gh auth login)",
      );
    }
    if (ran.error || ran.signal) {
      // Killed (its two minutes ran out): GitHub may have made it. Kept as not known, so a
      // second attempt cannot make a second issue (review of the fixes).
      throw new Error(
        `gh did not finish (${ran.signal ?? ran.error?.message}): GitHub may have made it; look on GitHub (${draft.repo}) before anything else`,
      );
    }
    if (ran.status !== 0) {
      forget();
      throw new Error(
        `gh did not create it: ${printable((ran.stderr || ran.stdout || "").trim(), 400)}${/label/i.test(ran.stderr ?? "") ? " (a label must exist in the repository first)" : ""}`,
      );
    }
    const where = issueUrl(draft.repo, (ran.stdout ?? "").trim().split("\n").pop());
    writeJson(record, {
      ...readJson<Record<string, string>>(record, {}),
      [digest]: where ?? `published; gh answered with no page of ${draft.repo}'s`,
    });
    if (!where)
      throw new Error(
        `gh created it, but answered with no page of ${draft.repo}'s: look on GitHub (it will not be published again)`,
      );
    await rootctl(
      "issue.done",
      { id: issue.id, url: where, digest },
      { quiet: true, timeoutMs: 30_000 },
    ).catch((error: Error) => {
      throw new Error(
        `published as ${where}, but the root did not take it: ${printable(error.message, 200)} (publishing it again only tells the root again)`,
      );
    });
    return where;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(lock, { recursive: true, force: true });
  }
};
declare namespace publish {
  type Issue = {
    id: "abc123-0123abcd";
    domain: "acme";
    workspace: "w1";
    repo: "acme/web";
    title: "--web is slow";
    body: "Steps:\n1. open it";
    labels: ["bug"];
    at: "2026-11-16T10:00:00Z";
    state: "approving";
  };
  /** made by the person's gh, each field one argument (a title starting with dashes is still
   *  the title), the body from a file of the host's; the root is told where it is */
  export type Publishes = Given<
    [
      Invoke<typeof emptyHome>,
      Mock<"./stack.ts", typeof fakeStack>,
      Invoke<typeof rootAnswers, [answers: { "issue.done": {} }]>,
      Invoke<typeof fakeGh, [stdout: "https://github.com/acme/web/issues/7\n", status: 0]>,
    ],
    [
      Expect<Invoke<typeof publish, [issue: Issue]>, "=", "https://github.com/acme/web/issues/7">,
      Expect<
        Invoke<typeof ghCalls>,
        "=",
        [
          [
            "issue",
            "create",
            "--repo",
            "acme/web",
            "--title=--web is slow",
            "--body-file",
            "<home>/state/issue-<tmp>/body.md",
            "--label=bug",
          ],
        ]
      >,
      Expect<
        Invoke<typeof rootAsked>,
        "matches",
        [
          {
            op: "issue.done";
            args: { id: "abc123-0123abcd"; url: "https://github.com/acme/web/issues/7" };
          },
        ]
      >,
    ]
  >;
  /** once, whatever asks again: the same text is not made a second issue */
  export type Once = Given<
    [
      Invoke<typeof emptyHome>,
      Mock<"./stack.ts", typeof fakeStack>,
      Invoke<typeof rootAnswers, [answers: { "issue.done": {} }]>,
      Invoke<typeof fakeGh, [stdout: "https://github.com/acme/web/issues/7\n", status: 0]>,
      Invoke<typeof publish, [issue: Issue]>,
    ],
    [
      Expect<Invoke<typeof publish, [issue: Issue]>, "=", "https://github.com/acme/web/issues/7">,
      Expect<Invoke<typeof ghCalls>["length"], "=", 1>,
    ]
  >;
  /** gh said no: said, with what usually causes it, and nothing kept, so it can be tried again */
  export type GhRefused = Given<
    [
      Invoke<typeof emptyHome>,
      Mock<"./stack.ts", typeof fakeStack>,
      Invoke<typeof rootAnswers, [answers: {}]>,
      Invoke<
        typeof fakeGh,
        [stdout: "", status: 1, stderr: "could not add label: 'bug' not found"]
      >,
    ],
    [
      Expect<
        Invoke<typeof errorOf, [run: typeof publish, args: [issue: Issue]]>,
        "=",
        "gh did not create it: could not add label: 'bug' not found (a label must exist in the repository first)"
      >,
      Expect<
        Invoke<typeof errorOf, [run: typeof publish, args: [issue: Issue]]>,
        "=",
        "gh did not create it: could not add label: 'bug' not found (a label must exist in the repository first)"
      >,
      Expect<Invoke<typeof ghCalls>["length"], "=", 2>,
    ]
  >;
  /** an answer that is not a page of this repository's is not taken for one, and is not run again */
  export type NoPage = Given<
    [
      Invoke<typeof emptyHome>,
      Mock<"./stack.ts", typeof fakeStack>,
      Invoke<typeof rootAnswers, [answers: {}]>,
      Invoke<typeof fakeGh, [stdout: "https://evil.example/acme/web/issues/7NL", status: 0]>,
    ],
    [
      Expect<
        Invoke<typeof errorOf, [run: typeof publish, args: [issue: Issue]]>,
        "=",
        "gh created it, but answered with no page of acme/web's: look on GitHub (it will not be published again)"
      >,
      Expect<
        Invoke<typeof refusalOf, [run: typeof publish, args: [issue: Issue]]>,
        "matches",
        {
          message: "not published again: an earlier attempt at this exact issue did not say how it ended (published; gh answered with no page of acme/web's)";
        }
      >,
      Expect<Invoke<typeof ghCalls>["length"], "=", 1>,
    ]
  >;
  /** text that would not read on the approval page as it is published is never handed to gh */
  export type NotADraft = Given<
    [
      Invoke<typeof emptyHome>,
      Mock<"./stack.ts", typeof fakeStack>,
      Invoke<typeof rootAnswers, [answers: {}]>,
      Invoke<typeof fakeGh, [stdout: "https://github.com/acme/web/issues/7\n", status: 0]>,
    ],
    [
      Expect<
        Invoke<
          typeof errorOf,
          [
            run: typeof publish,
            args: [
              issue: {
                id: "abc123-0123abcd";
                domain: "acme";
                workspace: "w1";
                repo: "acme/web";
                title: "ok \u202e evil";
                body: "Steps:\n1. open it";
                labels: ["bug"];
                at: "2026-11-16T10:00:00Z";
                state: "approving";
              },
            ],
          ]
        >,
        "=",
        "not published: the title holds a control or invisible character"
      >,
      Expect<Invoke<typeof ghCalls>, "=", []>,
    ]
  >;
}

export const refuseIssue = async (issue: Issue) => {
  await rootctl(
    "issue.done",
    { id: issue.id, refused: "not published: you said not now, on the Mac" },
    { quiet: true, timeoutMs: 30_000 },
  );
};

const waiting = async () =>
  (await rootctl<Issue[]>("issue.list", { waiting: true }, { quiet: true })).filter(
    (i) => i.state === "offered" || i.state === "approving",
  );

export const list = async (out: Out, json: boolean) => {
  const all = await waiting();
  if (json) return out(JSON.stringify(all));
  if (all.length === 0)
    return out(
      "no issues waiting. A workspace offers one with: desolate issue offer --title ... (inside it)",
    );
  for (const i of all)
    out(
      `  ${i.id}  ${i.state === "approving" ? "to publish" : "offered  "}  ${i.repo}  "${printable(i.title, 100)}"${i.labels.length ? `  [${i.labels.map((l) => printable(l, 50)).join(", ")}]` : ""}  from ${i.domain}/${i.workspace}`,
    );
  out("edit them on the dashboard (desolate ui); publish one here: desolate issue publish <id>");
};

/** The person's confirmation on this Mac's terminal: the controlling terminal, opened by
 *  name (as a push's is: host/approver.ts), not stdin. */
const confirm = async (question: string): Promise<string> => {
  let tty: number;
  try {
    tty = fs.openSync("/dev/tty", "r+");
  } catch {
    throw new Refusal(
      "publishing needs your confirmation, and there is no terminal to ask on",
      "run it from a terminal of your own, or publish it on the approval page: desolate approve --web",
      EXIT.unconfirmed,
    );
  }
  fs.writeSync(tty, question);
  return new Promise<string>((resolve) => {
    let text = "";
    const input = fs.createReadStream("", { fd: tty, autoClose: false });
    input.on("data", (chunk) => {
      text += chunk.toString();
      const end = text.indexOf("\n");
      if (end >= 0) {
        input.destroy();
        resolve(text.slice(0, end).trim());
      }
    });
    input.on("end", () => resolve(text.trim()));
    input.on("error", () => resolve(""));
  });
};

declare namespace list {
  /** what is waiting: drafts and those to publish, their text kept to text */
  export type Waiting = Given<
    [
      Mock<"./stack.ts", typeof fakeStack>,
      Invoke<
        typeof rootAnswers,
        [
          answers: {
            "issue.list": [
              {
                id: "abc123-0123abcd";
                domain: "acme";
                workspace: "w1";
                repo: "acme/web";
                title: "Login \u001b[31mloops";
                body: "Steps:\n1. open it";
                labels: ["bug"];
                at: "2026-11-16T10:00:00Z";
                state: "approving";
              },
              {
                id: "def456-89abcdef";
                domain: "acme";
                workspace: "w1";
                repo: "acme/web";
                title: "Docs";
                body: "Steps:\n1. open it";
                labels: [];
                at: "2026-11-16T10:00:00Z";
                state: "offered";
              },
              {
                id: "aaa111-00000000";
                domain: "acme";
                workspace: "w1";
                repo: "acme/web";
                title: "--web is slow";
                body: "Steps:\n1. open it";
                labels: ["bug"];
                at: "2026-11-16T10:00:00Z";
                state: "published";
              },
            ];
          },
        ]
      >,
      Invoke<typeof list, [out: typeof collect, json: false]>,
    ],
    Expect<
      Invoke<typeof said>,
      "=",
      [
        '  abc123-0123abcd  to publish  acme/web  "Login ?[31mloops"  [bug]  from acme/w1',
        '  def456-89abcdef  offered    acme/web  "Docs"  from acme/w1',
        "edit them on the dashboard (desolate ui); publish one here: desolate issue publish <id>",
      ]
    >
  >;
}

export const decide = async (what: "publish" | "refuse", id: string | undefined, out: Out) => {
  if (!id) refuse(`${what} which issue?`, "desolate issues", EXIT.usage);
  let issue =
    (await waiting()).find((i) => i.id === id) ??
    refuse(`no issue '${id}' is waiting`, "desolate issues");
  if (what === "refuse") {
    if (issue.state === "approving") await refuseIssue(issue);
    return out(
      `${issue.id} is a draft on the dashboard again${issue.state === "offered" ? " (it was one)" : ""}. Reject it there to drop it.`,
    );
  }
  // From the terminal, a draft is frozen first: what is shown below is then what is sent.
  if (issue.state === "offered")
    issue = await rootctl<Issue>("issue.freeze", { id: issue.id }, { quiet: true });
  // What is shown is the checked draft, the very object gh is given, and the rest is checked
  // too: the root's answer is written to this terminal (audit, 2026-11-16: its domain and
  // workspace fields went to the tty as they were, and could have repainted the question).
  const draft = draftOf(issue);
  if ("error" in draft) refuse(`not published: ${draft.error}`, "desolate issues");
  if (!isSlug(issue.domain) || !isSlug(issue.workspace))
    refuse("the root's account of this issue is not one desolate makes", "desolate doctor");
  const shown = [
    "",
    "desolate: this issue is created on GitHub, as you, only if you confirm it.",
    `  repository  ${draft.repo}`,
    `  title       ${printable(draft.title, 256)}`,
    `  labels      ${draft.labels.length ? draft.labels.map((l) => printable(l, 50)).join(", ") : "none"}`,
    `  offered by  ${issue.domain}/${issue.workspace} (the root's account)`,
    "  body:",
    "",
    ...printableLines(draft.body || "(no body)")
      .split("\n")
      .map((line) => `    ${line}`),
    "",
  ];
  const answer = await confirm(
    `${shown.join("\n")}\nType publish to create it, or anything else to leave it waiting: `,
  );
  if (answer !== "publish")
    throw new Refusal(
      "not confirmed: nothing was published",
      `desolate issue publish ${issue.id}, and type publish when it asks`,
      EXIT.unconfirmed,
    );
  out(`published: ${await publish({ ...issue, ...draft })}`);
};

declare namespace decide {
  /** which one, and only one that is waiting */
  export type Refuses = Given<
    [
      Mock<"./stack.ts", typeof fakeStack>,
      Invoke<typeof rootAnswers, [answers: { "issue.list": [] }]>,
    ],
    [
      Expect<
        Invoke<
          typeof refusalOf,
          [run: typeof decide, args: [what: "publish", id: undefined, out: typeof collect]]
        >,
        "=",
        { message: "publish which issue?"; fix: "desolate issues"; code: 64 }
      >,
      Expect<
        Invoke<
          typeof refusalOf,
          [run: typeof decide, args: [what: "publish", id: "abc123-0123abcd", out: typeof collect]]
        >,
        "=",
        { message: "no issue 'abc123-0123abcd' is waiting"; fix: "desolate issues"; code: 1 }
      >,
    ]
  >;
  /** not now: one waiting to be published goes back to a draft, and the root is told */
  export type NotNow = Given<
    [
      Mock<"./stack.ts", typeof fakeStack>,
      Invoke<
        typeof rootAnswers,
        [
          answers: {
            "issue.list": [
              {
                id: "abc123-0123abcd";
                domain: "acme";
                workspace: "w1";
                repo: "acme/web";
                title: "--web is slow";
                body: "Steps:\n1. open it";
                labels: ["bug"];
                at: "2026-11-16T10:00:00Z";
                state: "approving";
              },
            ];
            "issue.done": {};
          },
        ]
      >,
      Invoke<typeof decide, [what: "refuse", id: "abc123-0123abcd", out: typeof collect]>,
    ],
    [
      Expect<
        Invoke<typeof said>,
        "=",
        ["abc123-0123abcd is a draft on the dashboard again. Reject it there to drop it."]
      >,
      Expect<
        Invoke<typeof rootAsked>,
        "matches",
        [
          { op: "issue.list" },
          { op: "issue.done"; args: { refused: "not published: you said not now, on the Mac" } },
        ]
      >,
    ]
  >;
}
