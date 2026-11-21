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
import { over } from "./limits.ts";
import { printable } from "./text.ts";
import { characters, parseRepo } from "./names.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Invoke, Table } from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { bodied, titled } from "../.harness/shared-issues.ts";

/** What an offered issue may hold (R7: an agent writes it; R8: characters are code points).
 *  `title` 256, `body` 65,536 and `label` 50 characters are GitHub's own limits, which it
 *  counts as characters, so a draft kept here is one GitHub takes. `labels` 20 a draft and
 *  `waiting` 50 a domain are choices: what a person reads through on the dashboard. */
export const LIMIT = { title: 256, body: 65_536, labels: 20, label: 50, waiting: 50 } as const;
export const ID = /^[0-9a-z]{6,12}-[0-9a-f]{8}$/;

/** Characters a title or label may not hold: controls, bidirectional overrides and invisible
 *  formatting (what would make the text on the approval page not the text published). */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/u;
/** The same for a body, which keeps its newlines and tabs. */
const HIDDEN_IN_BODY =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/u;

export type Draft = { repo: string; title: string; body: string; labels: string[] };

/** A draft's fields, if each is one desolate carries; else why not. */
export const draftOf = (value: unknown): Draft | { error: string } => {
  const v = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  if (!parseRepo(v.repo)) return { error: "an issue names its repository as <owner>/<repo>" };
  const title = typeof v.title === "string" ? v.title.trim() : "";
  // (Characters are code points, as LIMIT counts them: an emoji is one, as on GitHub.)
  if (!title) return { error: `an issue needs a title, of at most ${LIMIT.title} characters` };
  if (characters(title) > LIMIT.title)
    return {
      error: over("the title", LIMIT.title, characters(title), "characters", "GitHub takes"),
    };
  if (HIDDEN.test(title)) return { error: "the title holds a control or invisible character" };
  const body =
    typeof v.body === "string" ? v.body.replace(/\r\n?/g, "\n") : v.body === undefined ? "" : null;
  if (body === null) return { error: `the body is text, of at most ${LIMIT.body} characters` };
  if (characters(body) > LIMIT.body)
    return { error: over("the body", LIMIT.body, characters(body), "characters", "GitHub takes") };
  if (HIDDEN_IN_BODY.test(body))
    return {
      error: "the body holds a control or invisible character (newlines and tabs are fine)",
    };
  const raw = v.labels === undefined ? [] : v.labels;
  if (!Array.isArray(raw)) return { error: `labels are a list, of at most ${LIMIT.labels}` };
  if (raw.length > LIMIT.labels)
    return { error: over("the issue", LIMIT.labels, raw.length, "labels", "one draft carries") };
  const labels: string[] = [];
  for (const label of raw) {
    // No comma: gh reads one as a separator, and the label would become two.
    if (
      typeof label !== "string" ||
      !label.trim() ||
      characters(label) > LIMIT.label ||
      HIDDEN.test(label) ||
      label.includes(",")
    )
      return {
        error: `'${printable(label, 60)}' is not a label desolate carries (at most ${LIMIT.label} characters, no comma)`,
      };
    if (!labels.includes(label.trim())) labels.push(label.trim());
  }
  return { repo: String(v.repo), title, body, labels };
};

declare namespace draftOf {
  /** text as it is, trimmed; nothing that would hide on the approval page; labels gh reads as one */
  export type Cases = Table<
    typeof draftOf,
    [
      [
        args: [
          value: {
            repo: "acme/app";
            title: " Fix the login loop ";
            body: "Steps:\r\n1. log in";
            labels: ["bug", "desolate:run", "bug"];
          },
        ],
        expected: {
          repo: "acme/app";
          title: "Fix the login loop";
          body: "Steps:\n1. log in";
          labels: ["bug", "desolate:run"];
        },
      ],
      [
        args: [value: { repo: "acme/app"; title: "x"; labels: ["a,b"] }],
        expected: {
          error: "'a,b' is not a label desolate carries (at most 50 characters, no comma)";
        },
      ],
      [
        args: [value: { repo: "acme/app"; title: "ok \u202e evil" }],
        expected: { error: "the title holds a control or invisible character" },
      ],
      [
        args: [value: { repo: "acme"; title: "x" }],
        expected: { error: "an issue names its repository as <owner>/<repo>" },
      ],
      [
        args: [value: { repo: "acme/app"; title: "" }],
        expected: { error: "an issue needs a title, of at most 256 characters" },
      ],
    ]
  >;
  /** a body keeps its newlines and tabs; nothing else invisible, and it is text or nothing */
  export type Body = Table<
    typeof draftOf,
    [
      [
        args: [value: { repo: "acme/app"; title: "x"; body: "a\tb\n" }],
        expected: { repo: "acme/app"; title: "x"; body: "a\tb\n"; labels: [] },
      ],
      [
        args: [value: { repo: "acme/app"; title: "x"; body: "a\u0007" }],
        expected: {
          error: "the body holds a control or invisible character (newlines and tabs are fine)";
        },
      ],
      [
        args: [value: { repo: "acme/app"; title: "x"; body: "zero\u200bwidth" }],
        expected: {
          error: "the body holds a control or invisible character (newlines and tabs are fine)";
        },
      ],
      [
        args: [value: { repo: "acme/app"; title: "x"; body: 5 }],
        expected: { error: "the body is text, of at most 65536 characters" },
      ],
    ]
  >;
  /** characters are counted as GitHub counts them: 256 emoji are a title (512 UTF-16 units),
   *  and one more is not (the control) */
  export type TitleInCharacters = Expect<
    Invoke<typeof draftOf, [value: Invoke<typeof titled, [text: "\u{1f600}", count: 256]>]>,
    "matches",
    { repo: "acme/app"; labels: [] }
  >;
  export type TitleOver = Expect<
    Invoke<typeof draftOf, [value: Invoke<typeof titled, [text: "\u{1f600}", count: 257]>]>,
    "=",
    { error: "the title is 257 characters, over the 256 GitHub takes" }
  >;
  /** a body of 65,536 characters outside the basic plane is taken; one more is not */
  export type BodyInCharacters = Expect<
    Invoke<typeof draftOf, [value: Invoke<typeof bodied, [text: "\u{1f600}", count: 65536]>]>,
    "matches",
    { repo: "acme/app"; title: "x" }
  >;
  export type BodyOver = Expect<
    Invoke<typeof draftOf, [value: Invoke<typeof bodied, [text: "\u{1f600}", count: 65537]>]>,
    "=",
    { error: "the body is 65537 characters, over the 65536 GitHub takes" }
  >;
  /** labels are a list of names gh takes as given: not one string, not a blank one */
  export type Labels = Table<
    typeof draftOf,
    [
      [
        args: [value: { repo: "acme/app"; title: "x"; labels: "bug" }],
        expected: { error: "labels are a list, of at most 20" },
      ],
      [
        args: [value: { repo: "acme/app"; title: "x"; labels: [" "] }],
        expected: {
          error: "' ' is not a label desolate carries (at most 50 characters, no comma)";
        },
      ],
    ]
  >;
  /** not even an object: the first thing missing is said */
  export type NotADraft = Expect<
    Invoke<typeof draftOf, [value: null]>,
    "=",
    { error: "an issue names its repository as <owner>/<repo>" }
  >;
}

/** What the approval covers: the repository and every word of the issue. */
export const digestOf = (d: Draft) =>
  createHash("sha256")
    .update(JSON.stringify(["desolate-issue-v1", d.repo, d.title, d.body, d.labels]))
    .digest("hex");

declare namespace digestOf {
  /** every word is covered: a label added after the approval is another digest, so the
   *  approval no longer matches */
  export type Covers = Table<
    typeof digestOf,
    [
      [
        args: [d: { repo: "acme/app"; title: "Fix the login loop"; body: ""; labels: ["bug"] }],
        expected: "7b571941f8fbcdbe6fe2bc94948fbb1d631fd6e0d2108c5802bb5732bf0115ed",
      ],
      [
        args: [
          d: { repo: "acme/app"; title: "Fix the login loop"; body: ""; labels: ["bug", "urgent"] },
        ],
        expected: "09767c2db8b82d798f131d1a58c5bf3f1155b7dc70c5025673a14bac3343e2ea",
      ],
    ]
  >;
}

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
  // Case-insensitive: GitHub answers with the repository's own casing, which may not be the
  // one it was registered with (a publish that worked was reported as failed: audit).
  return r &&
    typeof value === "string" &&
    new RegExp(
      `^https://github\\.com/${r.owner.replace(/\./g, "\\.")}/${r.name.replace(/\./g, "\\.")}/issues/\\d{1,9}$`,
      "i",
    ).test(value.trim())
    ? value.trim()
    : null;
};

declare namespace issueUrl {
  /** the issue's page on github.com, for this repository, and nothing else */
  export type Cases = Table<
    typeof issueUrl,
    [
      [
        args: [repo: "acme/app", value: "https://github.com/acme/app/issues/12\n"],
        expected: "https://github.com/acme/app/issues/12",
      ],
      [args: [repo: "acme/app", value: "https://github.com/acme/other/issues/12"], expected: null],
      [args: [repo: "acme/app", value: "javascript:alert(1)"], expected: null],
      /** GitHub's own casing of the repository is the same repository */
      [
        args: [repo: "acme/my.app", value: "https://github.com/ACME/My.App/issues/1"],
        expected: "https://github.com/ACME/My.App/issues/1",
      ],
      /** a dot in the name is a dot, not any character */
      [
        args: [repo: "acme/my.app", value: "https://github.com/acme/myxapp/issues/1"],
        expected: null,
      ],
      [
        args: [repo: "acme/app", value: "https://github.com/acme/app/issues/12#evil"],
        expected: null,
      ],
      [args: [repo: "acme/app", value: "https://github.com/acme/app/pull/12"], expected: null],
    ]
  >;
}
