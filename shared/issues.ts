// A GitHub issue a workspace offers (`desolate issue offer`, inside one): a draft the person
// reads and edits on the dashboard, then publishes. Publishing acts as the person on GitHub,
// so, like a push, it is approved on the Mac: the approval page (or `desolate issue publish`
// on the Mac's terminal) shows the exact text, and the host's own `gh` creates the issue from
// that text and nothing else.
//
// Every field was written by an agent: it is data. On the dashboard it is set as text (and
// its Markdown preview is built as elements, never parsed as HTML: shared/ui/markdown.js); on
// the Mac each field is one argv element of `gh`, never a line a shell reads.
import { createHash } from "node:crypto";
import { parseRepo } from "./names.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Table } from "../.suede/nests/dsl.import.meta.vitest.ts";

export const LIMIT = { title: 256, body: 65_536, labels: 20, label: 50, waiting: 50 } as const;
export const ID = /^[0-9a-z]{6,12}-[0-9a-f]{8}$/;

/** Characters a title or label may not hold: controls, bidirectional overrides and invisible
 *  formatting (what would make the text on the approval page not the text published). */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/u;
/** The same for a body, which keeps its newlines and tabs. */
const HIDDEN_IN_BODY = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/u;

export type Draft = { repo: string; title: string; body: string; labels: string[] };

/** A draft's fields, if each is one desolate carries; else why not. */
export const draftOf = (value: unknown): Draft | { error: string } => {
  const v = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  if (!parseRepo(v.repo)) return { error: "an issue names its repository as <owner>/<repo>" };
  const title = typeof v.title === "string" ? v.title.trim() : "";
  if (!title || title.length > LIMIT.title) return { error: `an issue needs a title, of at most ${LIMIT.title} characters` };
  if (HIDDEN.test(title)) return { error: "the title holds a control or invisible character" };
  const body = typeof v.body === "string" ? v.body.replace(/\r\n/g, "\n") : v.body === undefined ? "" : null;
  if (body === null || body.length > LIMIT.body) return { error: `the body is text, of at most ${LIMIT.body} characters` };
  if (HIDDEN_IN_BODY.test(body)) return { error: "the body holds a control or invisible character (newlines and tabs are fine)" };
  const raw = v.labels === undefined ? [] : v.labels;
  if (!Array.isArray(raw) || raw.length > LIMIT.labels) return { error: `labels are a list, of at most ${LIMIT.labels}` };
  const labels: string[] = [];
  for (const label of raw) {
    // No comma: gh reads one as a separator, and the label would become two.
    if (typeof label !== "string" || !label.trim() || label.length > LIMIT.label || HIDDEN.test(label) || label.includes(",")) return { error: `'${String(label).slice(0, 60)}' is not a label desolate carries (at most ${LIMIT.label} characters, no comma)` };
    if (!labels.includes(label.trim())) labels.push(label.trim());
  }
  return { repo: String(v.repo), title, body, labels };
};

declare namespace draftOf {
  /** text as it is, trimmed; nothing that would hide on the approval page; labels gh reads as one */
  export type Cases = Table<typeof draftOf, [
    [args: [value: { repo: "acme/app"; title: " Fix the login loop "; body: "Steps:\r\n1. log in"; labels: ["bug", "desolate:run", "bug"] }], expected: { repo: "acme/app"; title: "Fix the login loop"; body: "Steps:\n1. log in"; labels: ["bug", "desolate:run"] }],
    [args: [value: { repo: "acme/app"; title: "x"; labels: ["a,b"] }], expected: { error: "'a,b' is not a label desolate carries (at most 50 characters, no comma)" }],
    [args: [value: { repo: "acme/app"; title: "ok \u202e evil" }], expected: { error: "the title holds a control or invisible character" }],
    [args: [value: { repo: "acme"; title: "x" }], expected: { error: "an issue names its repository as <owner>/<repo>" }],
    [args: [value: { repo: "acme/app"; title: "" }], expected: { error: "an issue needs a title, of at most 256 characters" }],
  ]>;
}

/** What the approval covers: the repository and every word of the issue. */
export const digestOf = (d: Draft) => createHash("sha256").update(JSON.stringify(["desolate-issue-v1", d.repo, d.title, d.body, d.labels])).digest("hex");

export type Issue = Draft & {
  id: string;
  domain: string;
  /** The workspace that offered it, as it said (a label: the domain is what is checked). */
  workspace: string;
  at: string;
  /** offered: the person may edit it. approving: frozen, waiting for the Mac. published:
   *  on GitHub, at `url`. rejected: the person said no. */
  state: "offered" | "approving" | "published" | "rejected";
  edited?: boolean;
  url?: string;
  /** Why the last attempt to publish it did not (refused on the Mac, or gh failed). */
  problem?: string;
};

/** The issue's page, if it is one GitHub gives for this repository: the only link shown. */
export const issueUrl = (repo: string, value: unknown): string | null => {
  const r = parseRepo(repo);
  return r && typeof value === "string" && new RegExp(`^https://github\\.com/${r.owner.replace(/\./g, "\\.")}/${r.name.replace(/\./g, "\\.")}/issues/\\d{1,9}$`).test(value.trim()) ? value.trim() : null;
};

declare namespace issueUrl {
  export type Cases = Table<typeof issueUrl, [
    [args: [repo: "acme/app", value: "https://github.com/acme/app/issues/12\n"], expected: "https://github.com/acme/app/issues/12"],
    [args: [repo: "acme/app", value: "https://github.com/acme/other/issues/12"], expected: null],
    [args: [repo: "acme/app", value: "javascript:alert(1)"], expected: null],
  ]>;
}
