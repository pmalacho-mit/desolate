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
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Given, Invoke, Table } from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { emptyRoot, namesIn } from "../.harness/root-state.ts";

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

declare namespace get {
  /** an id is a name the root made, never a path: one that climbs out finds nothing */
  export type OnlyIds = Table<typeof get, [
    [args: [id: "../registry"], expected: null],
    [args: [id: "mgx1abc-0123456"], expected: null],
    [args: [id: 42], expected: null],
  ]>;
}
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

declare namespace offer {
  type Fresh = Invoke<typeof emptyRoot>;
  /** what a workspace's `desolate issue offer` hands the root, kept as it was offered */
  export type Keeps = Given<
    [Fresh, Invoke<typeof offer, [domain: "acme", repos: ["acme/app"], workspaces: ["w1"], request: { repo: "acme/app"; title: " Login loops "; workspace: "w1" }]>],
    Expect<Invoke<typeof list>, "matches", [{ repo: "acme/app"; title: "Login loops"; body: ""; labels: []; domain: "acme"; workspace: "w1"; state: "offered" }]>
  >;
  /** the workspace's name is a label: one that is not this domain's is kept as "unknown" */
  export type NamesOnlyItsOwn = Given<
    [Fresh, Invoke<typeof offer, [domain: "acme", repos: ["acme/app"], workspaces: ["w1"], request: { repo: "acme/app"; title: "x"; workspace: "w9" }]>],
    Expect<Invoke<typeof list>, "matches", [{ workspace: "unknown" }]>
  >;
  /** a domain offers issues for its own repositories only, and nothing is kept */
  export type OtherRepo = Given<
    Fresh,
    [
      Expect<Invoke<typeof offer, [domain: "acme", repos: ["acme/app"], workspaces: ["w1"], request: { repo: "other/app"; title: "x" }]>, "=", { ok: false; error: "other/app is not in this domain" }>,
      Expect<Invoke<typeof namesIn, [where: "state", dir: "issues"]>, "=", []>,
    ]
  >;
  /** a draft shared/issues.ts would not carry is refused with its reason */
  export type BadDraft = Given<
    Fresh,
    Expect<Invoke<typeof offer, [domain: "acme", repos: ["acme/app"], workspaces: ["w1"], request: { repo: "acme/app"; title: "ok \u202e evil" }]>, "=", { ok: false; error: "the title holds a control or invisible character" }>
  >;
}

/** The person's edit on the dashboard, while it is still a draft. */
export const edit = (id: unknown, fields: Partial<Draft>): Issue | { error: string } => {
  const issue = get(id);
  if (!issue) return { error: "there is no such issue" };
  if (issue.state !== "offered") return { error: `that issue is ${issue.state}: it can no longer be edited` };
  const draft = draftOf({ repo: issue.repo, title: fields.title ?? issue.title, body: fields.body ?? issue.body, labels: fields.labels ?? issue.labels });
  if ("error" in draft) return draft;
  return save({ ...issue, ...draft, edited: issue.edited || draft.title !== issue.title || draft.body !== issue.body || JSON.stringify(draft.labels) !== JSON.stringify(issue.labels) });
};

declare namespace edit {
  // Bindings run first, in this order: the root is emptied, then the issue offered.
  type Fresh = Invoke<typeof emptyRoot>;
  type Offered = Invoke<typeof offer, [domain: "acme", repos: ["acme/app"], workspaces: ["w1"], request: { repo: "acme/app"; title: "Login loops" }]>;
  /** the person's words replace the agent's, and the issue says it was edited */
  export type Edits = Given<
    [Fresh, Offered],
    Expect<Invoke<typeof edit, [id: Offered["id"], fields: { title: "Login loops after a reset"; labels: ["bug"] }]>, "matches", { title: "Login loops after a reset"; labels: ["bug"]; edited: true; state: "offered" }>
  >;
  /** saved as it was is not an edit */
  export type Unchanged = Given<
    [Fresh, Offered],
    Expect<Invoke<typeof edit, [id: Offered["id"], fields: { title: "Login loops" }]>, "matches", { edited: false }>
  >;
  /** an edit is held to what an offer is: nothing hidden in the title */
  export type Checked = Given<
    [Fresh, Offered],
    Expect<Invoke<typeof edit, [id: Offered["id"], fields: { title: "" }]>, "=", { error: "an issue needs a title, of at most 256 characters" }>
  >;
  /** once frozen for the Mac's approval, the text is what will be approved: no edits */
  export type Frozen = Given<
    [Fresh, Offered, Invoke<typeof toApprove, [id: Offered["id"]]>],
    Expect<Invoke<typeof edit, [id: Offered["id"], fields: { title: "something else" }]>, "=", { error: "that issue is approving: it can no longer be edited" }>
  >;
}

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

declare namespace toApprove {
  type Fresh = Invoke<typeof emptyRoot>;
  type Offered = Invoke<typeof offer, [domain: "acme", repos: ["acme/app"], workspaces: ["w1"], request: { repo: "acme/app"; title: "Login loops" }]>;
  /** offered, frozen for the Mac, back to a draft with why, then rejected: the person's way through */
  export type Lifecycle = Given<
    [Fresh, Offered],
    [
      Expect<Invoke<typeof toApprove, [id: Offered["id"]]>, "matches", { state: "approving" }>,
      Expect<Invoke<typeof backToDraft, [id: Offered["id"], why: "refused on the Mac\u001b[2J"]>, "matches", { state: "offered"; problem: "refused on the Mac?[2J" }>,
      Expect<Invoke<typeof reject, [id: Offered["id"]]>, "matches", { state: "rejected" }>,
      Expect<Invoke<typeof toApprove, [id: Offered["id"]]>, "=", { error: "that issue is rejected" }>,
    ]
  >;
  /** a draft not frozen for approval cannot be sent back to one */
  export type NotWaiting = Given<
    [Fresh, Offered],
    Expect<Invoke<typeof backToDraft, [id: Offered["id"]]>, "=", { error: "that issue is not waiting for approval" }>
  >;
}

declare namespace published {
  type Fresh = Invoke<typeof emptyRoot>;
  type Offered = Invoke<typeof offer, [domain: "acme", repos: ["acme/app"], workspaces: ["w1"], request: { repo: "acme/app"; title: "Login loops" }]>;
  /** the host says where it published the text the person approved: its digest matches */
  export type Records = Given<
    [Fresh, Offered, Invoke<typeof toApprove, [id: Offered["id"]]>],
    Expect<Invoke<typeof published, [id: Offered["id"], url: "https://github.com/acme/app/issues/7", digest: "d4941727198d8ac21cc5f4e81af37a05bc9dc37fb7081c7202a15415ce5a1deb"]>, "matches", { state: "published"; url: "https://github.com/acme/app/issues/7" }>
  >;
  /** text that changed after it was approved is not what GitHub has: refused, still approving */
  export type ChangedSince = Given<
    [Fresh, Offered, Invoke<typeof toApprove, [id: Offered["id"]]>],
    [
      Expect<Invoke<typeof published, [id: Offered["id"], url: "https://github.com/acme/app/issues/7", digest: "0000000000000000000000000000000000000000000000000000000000000000"]>, "=", { error: "that issue's text changed after it was approved" }>,
      Expect<Invoke<typeof get, [id: Offered["id"]]>, "matches", { state: "approving" }>,
    ]
  >;
  /** nothing is published that the person did not freeze for approval */
  export type NotFrozen = Given<
    [Fresh, Offered],
    Expect<Invoke<typeof published, [id: Offered["id"], url: "https://github.com/acme/app/issues/7"]>, "=", { error: "that issue was not waiting for approval" }>
  >;
}
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
