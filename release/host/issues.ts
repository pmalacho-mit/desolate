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

type Out = (line: string) => void;

/** Create it on GitHub with the host's gh (DESOLATE_GH names another), and tell the root
 *  where it is. Returns its page. */
export const publish = async (issue: Issue): Promise<string> => {
  const draft = draftOf(issue);
  if ("error" in draft) throw new Error(`not published: ${draft.error}`);
  fs.mkdirSync(paths.state, { recursive: true, mode: 0o700 });
  // Once, whatever the page, the terminal or a retry after a failure that was not one: the
  // text's digest, recorded here before gh runs and kept with its page after, and a lock for
  // the moment between (audit, 2026-11-16: a publish reported failed invited a second issue).
  const digest = digestOf(draft);
  const record = path.join(paths.state, "issues-published.json");
  const done = readJson<Record<string, string>>(record, {});
  if (done[digest]) throw new Error(`not published again: this exact issue was published already, as ${done[digest]} (or the attempt that did is not known to have failed)`);
  const lock = path.join(paths.state, `issue-${digest.slice(0, 16)}.lock`);
  try {
    fs.mkdirSync(lock);
  } catch {
    throw new Error("not published: it is being published right now, from another page or terminal");
  }
  const dir = fs.mkdtempSync(path.join(paths.state, "issue-"));
  try {
    const body = path.join(dir, "body.md");
    fs.writeFileSync(body, draft.body, { mode: 0o600 });
    // `--flag=value`: a title or a label that starts with a dash is still that flag's value.
    const args = ["issue", "create", "--repo", draft.repo, `--title=${draft.title}`, "--body-file", body, ...draft.labels.map((label) => `--label=${label}`)];
    // Recorded as maybe-published before gh runs: if it is killed after GitHub made the
    // issue, a second attempt is refused rather than making a second issue.
    writeJson(record, { ...done, [digest]: "(an attempt whose outcome is not known: look on GitHub)" });
    const ran = spawnSync(process.env.DESOLATE_GH || "gh", args, { encoding: "utf8", timeout: 120_000, env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" } });
    const where = issueUrl(draft.repo, (ran.stdout ?? "").trim().split("\n").pop());
    if (ran.error || ran.status !== 0) {
      // gh said it did not: the attempt is forgotten, and it can be tried again.
      const { [digest]: _, ...rest } = readJson<Record<string, string>>(record, {});
      writeJson(record, rest);
      if (ran.error) throw new Error(`gh could not be run: ${ran.error.message} (brew install gh, then gh auth login)`);
      throw new Error(`gh did not create it: ${printable((ran.stderr || ran.stdout || "").trim(), 400)}${/label/i.test(ran.stderr ?? "") ? " (a label must exist in the repository first)" : ""}`);
    }
    writeJson(record, { ...readJson<Record<string, string>>(record, {}), [digest]: where ?? `(published; gh answered with no page of ${draft.repo}'s)` });
    if (!where) throw new Error(`gh created it, but answered with no page of ${draft.repo}'s: look on GitHub (it will not be published again)`);
    await rootctl("issue.done", { id: issue.id, url: where, digest }, { quiet: true, timeoutMs: 30_000 }).catch((error: Error) => {
      throw new Error(`published as ${where}, but the root did not take it: ${printable(error.message, 200)}`);
    });
    return where;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(lock, { recursive: true, force: true });
  }
};
export const refuseIssue = async (issue: Issue) => {
  await rootctl("issue.done", { id: issue.id, refused: "not published: you said not now, on the Mac" }, { quiet: true, timeoutMs: 30_000 });
};

const waiting = async () => (await rootctl<Issue[]>("issue.list", { waiting: true }, { quiet: true })).filter((i) => i.state === "offered" || i.state === "approving");

export const list = async (out: Out, json: boolean) => {
  const all = await waiting();
  if (json) return out(JSON.stringify(all));
  if (all.length === 0) return out("no issues waiting. A workspace offers one with: desolate issue offer --title ... (inside it)");
  for (const i of all)
    out(`  ${i.id}  ${i.state === "approving" ? "to publish" : "offered  "}  ${i.repo}  "${printable(i.title, 100)}"${i.labels.length ? `  [${i.labels.map((l) => printable(l, 50)).join(", ")}]` : ""}  from ${i.domain}/${i.workspace}`);
  out("edit them on the dashboard (desolate ui); publish one here: desolate issue publish <id>");
};

/** The person's confirmation on this Mac's terminal: the controlling terminal, opened by
 *  name (as a push's is: host/approver.ts), not stdin. */
const confirm = async (question: string): Promise<string> => {
  let tty: number;
  try {
    tty = fs.openSync("/dev/tty", "r+");
  } catch {
    throw new Refusal("publishing needs your confirmation, and there is no terminal to ask on", "run it from a terminal of your own, or publish it on the approval page: desolate approve --web", EXIT.unconfirmed);
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

export const decide = async (what: "publish" | "refuse", id: string | undefined, out: Out) => {
  if (!id) refuse(`${what} which issue?`, "desolate issues", EXIT.usage);
  let issue = (await waiting()).find((i) => i.id === id) ?? refuse(`no issue '${id}' is waiting`, "desolate issues");
  if (what === "refuse") {
    if (issue.state === "approving") await refuseIssue(issue);
    return out(`${issue.id} is a draft on the dashboard again${issue.state === "offered" ? " (it was one)" : ""}. Reject it there to drop it.`);
  }
  // From the terminal, a draft is frozen first: what is shown below is then what is sent.
  if (issue.state === "offered") issue = await rootctl<Issue>("issue.freeze", { id: issue.id }, { quiet: true });
  // What is shown is the checked draft, the very object gh is given, and the rest is checked
  // too: the root's answer is written to this terminal (audit, 2026-11-16: its domain and
  // workspace fields went to the tty as they were, and could have repainted the question).
  const draft = draftOf(issue);
  if ("error" in draft) refuse(`not published: ${draft.error}`, "desolate issues");
  if (!isSlug(issue.domain) || !isSlug(issue.workspace)) refuse("the root's account of this issue is not one desolate makes", "desolate doctor");
  const shown = [
    "", "desolate: this issue is created on GitHub, as you, only if you confirm it.",
    `  repository  ${draft.repo}`, `  title       ${printable(draft.title, 256)}`, `  labels      ${draft.labels.length ? draft.labels.map((l) => printable(l, 50)).join(", ") : "none"}`,
    `  offered by  ${issue.domain}/${issue.workspace} (the root's account)`, "  body:", "",
    ...printableLines(draft.body || "(no body)").split("\n").map((line) => `    ${line}`), "",
  ];
  const answer = await confirm(`${shown.join("\n")}\nType publish to create it, or anything else to leave it waiting: `);
  if (answer !== "publish") throw new Refusal("not confirmed: nothing was published", `desolate issue publish ${issue.id}, and type publish when it asks`, EXIT.unconfirmed);
  out(`published: ${await publish({ ...issue, ...draft })}`);
};
