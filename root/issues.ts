// The issues workspaces have offered (shared/issues.ts), as the root keeps them: one file
// each, in the root's ordinary user's state. rootd takes an offer from a domain's outbox;
// the state service shows them and takes the person's edits; the host, once the person
// approves one on the Mac, publishes it and says where it is.
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { readJson, writeJson } from "../shared/json.ts";
import { digestOf, draftOf, ID, LIMIT } from "../shared/issues.ts";
import type { Draft, Issue } from "../shared/issues.ts";
import { isSlug } from "../shared/names.ts";
import { printable } from "../shared/text.ts";
import { ROOT } from "./layout.ts";

const DIR = () => path.join(ROOT.state, "issues");
const fileOf = (id: string) => path.join(DIR(), `${id}.json`);

export const list = (): Issue[] => {
  try {
    return fs.readdirSync(DIR()).filter((name) => name.endsWith(".json")).map((name) => readJson<Issue | null>(path.join(DIR(), name), null)).filter((i): i is Issue => i !== null).sort((a, b) => a.at.localeCompare(b.at));
  } catch {
    return [];
  }
};
export const get = (id: unknown): Issue | null => (typeof id === "string" && ID.test(id) ? readJson<Issue | null>(fileOf(id), null) : null);
const save = (issue: Issue) => {
  fs.mkdirSync(DIR(), { recursive: true });
  writeJson(fileOf(issue.id), issue);
  return issue;
};

/** A workspace's offer: checked, and kept as offered. */
export const offer = (domain: string, repos: string[], workspaces: string[], request: Record<string, unknown>): Record<string, unknown> => {
  const draft = draftOf(request);
  if ("error" in draft) return { ok: false, error: draft.error };
  if (!repos.includes(draft.repo)) return { ok: false, error: `${draft.repo} is not in this domain` };
  const waiting = list().filter((i) => i.domain === domain && (i.state === "offered" || i.state === "approving"));
  if (waiting.length >= LIMIT.waiting) return { ok: false, error: `${domain} already has ${waiting.length} issues waiting for the person`, fix: "wait for them to be published or rejected" };
  const workspace = isSlug(request.workspace) && workspaces.includes(request.workspace) ? request.workspace : "unknown";
  const id = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  save({ ...draft, id, domain, workspace, at: new Date().toISOString(), state: "offered" });
  return { ok: true, id };
};

/** The person's edit on the dashboard, while it is still a draft. */
export const edit = (id: unknown, fields: Partial<Draft>): Issue | { error: string } => {
  const issue = get(id);
  if (!issue) return { error: "there is no such issue" };
  if (issue.state !== "offered") return { error: `that issue is ${issue.state}: it can no longer be edited` };
  const draft = draftOf({ repo: issue.repo, title: fields.title ?? issue.title, body: fields.body ?? issue.body, labels: fields.labels ?? issue.labels });
  if ("error" in draft) return draft;
  return save({ ...issue, ...draft, edited: issue.edited || draft.title !== issue.title || draft.body !== issue.body || JSON.stringify(draft.labels) !== JSON.stringify(issue.labels) });
};

/** Publish: frozen as it is now, for the person to approve on the Mac. */
export const toApprove = (id: unknown): Issue | { error: string } => {
  const issue = get(id);
  if (!issue) return { error: "there is no such issue" };
  if (issue.state !== "offered" && issue.state !== "approving") return { error: `that issue is ${issue.state}` };
  return save({ ...issue, state: "approving", problem: undefined });
};
/** Back to a draft (the person refused it on the Mac, or wants to edit it again). */
export const backToDraft = (id: unknown, why?: string): Issue | { error: string } => {
  const issue = get(id);
  if (!issue || issue.state !== "approving") return { error: "that issue is not waiting for approval" };
  return save({ ...issue, state: "offered", ...(why ? { problem: printable(why, 300) } : {}) });
};
export const reject = (id: unknown): Issue | { error: string } => {
  const issue = get(id);
  if (!issue || (issue.state !== "offered" && issue.state !== "approving")) return { error: "that issue is not waiting" };
  return save({ ...issue, state: "rejected" });
};
/** Where the host published it (its URL checked by the host, shared/issues.ts issueUrl). */
export const published = (id: unknown, url: string, digest?: unknown): Issue | { error: string } => {
  const issue = get(id);
  if (!issue || issue.state !== "approving") return { error: "that issue was not waiting for approval" };
  // Only the text that was approved: a draft sent back and edited while gh ran is not what
  // GitHub has (audit, 2026-11-16).
  const draft = draftOf(issue);
  if (digest !== undefined && ("error" in draft || digestOf(draft) !== digest)) return { error: "that issue's text changed after it was approved" };
  return save({ ...issue, state: "published", url, problem: undefined });
};
