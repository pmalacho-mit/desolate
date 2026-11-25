// What a change does, read off the tests rather than the code: the claims it
// adds, the ones it removes, the ones whose evidence changed, and the functions
// it adds with nothing said of them.
//
// A removed claim, a changed one (its setup alone included), one now skipped, and one that lost a tag
// saying what it is evidence of are what a person should approve: each is a
// guarantee the code no longer makes, or makes differently. They are
// `needsReview`, and `cli.mts docs diff --check` fails on any.
import { claimWords, subjectId } from "./model.mts";
import { codeBlock, codeSpan } from "./shorthand.mts";

import type { ClaimDoc, FileDocs } from "./model.mts";
import type * as harness from "../_internal/harness.mts";
import type { Expect, Invoke } from "../dsl.import.meta.vitest.ts";

type Keyed = { file: string; claim: ClaimDoc };

type Pair = { file: string; before: ClaimDoc; after: ClaimDoc };

export type BehaviorDiff = {
  added: Keyed[];
  removed: Keyed[];
  /** Same test, different evidence: what it runs, and so what it checks or expects, changed. */
  changed: Pair[];
  /**
   * Same test, every claim line reading as it did, and what those lines stand
   * on changed: a mock, a setup, an alias, an effect. Listed apart because the
   * claim reads the same, but not necessarily the same claim (`Want = 8` became
   * `Want = 9` under `size(…) → Want`): a person approves it, as a changed one.
   */
  setupChanged: Pair[];
  /** Same evidence, different words: its own, or how its evidence is said. */
  reworded: Pair[];
  /** Was run, now is not. */
  skipped: Keyed[];
  /** Same test, its tags changed: `@control`, `@principle P4`, … as written. */
  retagged: (Pair & { removed: string[]; added: string[] })[];
  /** Functions with tests now that had none before. */
  newSubjects: { file: string; name: string }[];
  /** What a person should approve: removed, changed, setup changed or skipped claims, and evidence tags removed. */
  needsReview: number;
};

/**
 * The tags that say what a claim is evidence of. One removed is a weaker
 * statement of evidence, as a removed claim is. One added is a stronger one:
 * listed for a reader, never a failure.
 */
export const EVIDENCE_TAGS = ["control", "principle", "requirement", "incident"];

const tagsOf = (c: ClaimDoc) =>
  c.tags.map((t) => `@${t.name}${t.text ? ` ${t.text}` : ""}`);

const keyed = (files: FileDocs[]) =>
  new Map(
    files.flatMap((f) =>
      f.claims.map((claim) => [claim.id, { file: f.file, claim }] as const),
    ),
  );

const words = (c: ClaimDoc) => JSON.stringify([claimWords(c), c.shorthand]);

// conservative: every claim line the same, in the same order, and some other
// line of the shorthand not, so the change is one a reader can see. When the
// shorthand shows no difference at all, what changed cannot be told: changed
const onlySetup = (before: ClaimDoc, after: ClaimDoc) =>
  after.checks.length > 0 &&
  JSON.stringify(before.checks) === JSON.stringify(after.checks) &&
  JSON.stringify(before.shorthand) !== JSON.stringify(after.shorthand);

const runs = (c: ClaimDoc) => c.mode === "test" || c.mode === "test.only";

/** The claims that differ between two readings of a project. */
export function behaviorDiff(
  before: FileDocs[],
  after: FileDocs[],
): BehaviorDiff {
  const a = keyed(before);
  const b = keyed(after);
  const out: BehaviorDiff = {
    added: [],
    removed: [],
    changed: [],
    setupChanged: [],
    reworded: [],
    skipped: [],
    retagged: [],
    newSubjects: [],
    needsReview: 0,
  };
  for (const [key, now] of b) {
    const was = a.get(key);
    if (was) {
      const before = tagsOf(was.claim);
      const after = tagsOf(now.claim);
      const removed = before.filter((t) => !after.includes(t));
      const added = after.filter((t) => !before.includes(t));
      if (removed.length || added.length)
        out.retagged.push({
          file: now.file,
          before: was.claim,
          after: now.claim,
          removed,
          added,
        });
    }
    if (!was) out.added.push(now);
    else if (runs(was.claim) && !runs(now.claim)) out.skipped.push(now);
    else if (was.claim.fingerprint !== now.claim.fingerprint)
      (onlySetup(was.claim, now.claim) ? out.setupChanged : out.changed).push({
        file: now.file,
        before: was.claim,
        after: now.claim,
      });
    else if (words(was.claim) !== words(now.claim))
      out.reworded.push({
        file: now.file,
        before: was.claim,
        after: now.claim,
      });
  }
  for (const [key, was] of a) if (!b.has(key)) out.removed.push(was);
  const subjectsBefore = new Set(
    before.flatMap((f) => f.subjects.map((s) => subjectId(f.file, s.name))),
  );
  out.newSubjects = after.flatMap((f) =>
    f.subjects
      .filter((s) => !subjectsBefore.has(subjectId(f.file, s.name)))
      .map((s) => ({ file: f.file, name: s.name })),
  );
  const weakened = out.retagged.filter((r) =>
    r.before.tags.some(
      (t) =>
        EVIDENCE_TAGS.includes(t.name) &&
        r.removed.includes(`@${t.name}${t.text ? ` ${t.text}` : ""}`),
    ),
  );
  out.needsReview =
    out.removed.length +
    out.changed.length +
    out.setupChanged.length +
    out.skipped.length +
    weakened.length;
  return out;
}

const said = (c: ClaimDoc) =>
  claimWords(c)?.replace(/\s+/g, " ") ?? "_(no words of its own)_";

// the evidence under a claim, after what it is (`was: `): a line as code, several as a block
const evidence = (c: ClaimDoc, lead = "") => {
  const lines = c.shorthand;
  if (!lines.length) return `\n  - ${lead}_(not written yet)_`;
  if (lines.length === 1) return `\n  - ${lead}${codeSpan(lines[0]!)}`;
  return lead
    ? `\n  - ${lead.trimEnd()}\n${codeBlock(lines, "    ").join("\n")}`
    : `\n${codeBlock(lines, "  ").join("\n")}`;
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A behavior diff, as Markdown a reviewer reads before the code. */
export function diffMarkdown(d: BehaviorDiff): string {
  const lines = [
    `**${plural(d.added.length, "claim")} added, ${d.removed.length} removed, ${d.changed.length} changed, ${d.setupChanged.length} with setup changed, ${d.skipped.length} skipped, ${d.reworded.length} reworded, ${d.retagged.length} retagged.**`,
    d.needsReview
      ? `${plural(d.needsReview, "change")} to what the code guarantees: a person should approve these.`
      : "No guarantee was removed or changed.",
    "",
  ];
  const block = (title: string, items: string[]) =>
    items.length ? [`### ${title}`, "", ...items, ""] : [];
  lines.push(
    ...block(
      "Removed",
      d.removed.map(
        ({ file, claim }) =>
          `- \`${claim.name}\` (${file}): ${said(claim)}${evidence(claim, "was: ")}`,
      ),
    ),
    ...block(
      "Changed",
      d.changed.map(
        ({ file, before, after }) =>
          `- \`${after.name}\` (${file}): ${said(after)}${evidence(before, "was: ")}${evidence(after, "now: ")}`,
      ),
    ),
    ...block(
      "Setup changed (every claim line as it was)",
      d.setupChanged.map(
        ({ file, before, after }) =>
          `- \`${after.name}\` (${file}): ${said(after)}${evidence(before, "was: ")}${evidence(after, "now: ")}`,
      ),
    ),
    ...block(
      "Skipped",
      d.skipped.map(
        ({ file, claim }) => `- \`${claim.name}\` (${file}): ${said(claim)}`,
      ),
    ),
    ...block(
      "Added",
      d.added.map(
        ({ file, claim }) =>
          `- \`${claim.name}\` (${file}): ${said(claim)}${evidence(claim)}`,
      ),
    ),
    ...block(
      "Reworded",
      d.reworded.map(({ before, after }) =>
        said(before) !== said(after)
          ? `- \`${after.name}\`: "${said(before)}" → "${said(after)}"`
          : `- \`${after.name}\`: ${said(after)}${evidence(before, "was: ")}${evidence(after, "now: ")}`,
      ),
    ),
    ...block(
      "Retagged",
      d.retagged.map(
        ({ file, after, removed, added }) =>
          `- \`${after.name}\` (${file}): ${[
            ...removed.map((t) => `removed \`${t}\``),
            ...added.map((t) => `added \`${t}\``),
          ].join(", ")}`,
      ),
    ),
    ...block(
      "Newly described",
      d.newSubjects.map(({ file, name }) => `- \`${name}\` (${file})`),
    ),
  );
  return lines.join("\n");
}

declare namespace behaviorDiff {
  type Before = `
    const isSlug = (v: string) => /^[a-z]+$/.test(v);
    declare namespace isSlug {
      /** lowercase letters */
      export type Lower = Expect<Invoke<typeof isSlug, [v: "acme"]>, "=", true>;
      /** no capitals */
      export type Upper = Expect<Invoke<typeof isSlug, [v: "Acme"]>, "=", false>;
      /** no dots */
      export type Dot = Expect<Invoke<typeof isSlug, [v: "a.b"]>, "=", false>;
    }
  `;
  type After = `
    const isSlug = (v: string) => /^[a-z.]+$/.test(v);
    declare namespace isSlug {
      /** lowercase letters, said differently */
      export type Lower = Expect<Invoke<typeof isSlug, [v: "acme"]>, "=", true>;
      /** no dots */
      export type Dot = Expect<Invoke<typeof isSlug, [v: "a.b"]>, "=", true>;
      /** no digits */
      export type Digit = Expect<Invoke<typeof isSlug, [v: "a1"]>, "=", false>;
    }
  `;

  /** a claim gone, one whose evidence changed, one reworded and one new; two of them need a person */
  export type Changes = Expect<
    Invoke<typeof harness.diffOf, [before: Before, after: After]>,
    "matches",
    {
      added: [{ claim: { name: "isSlug > Digit" } }];
      removed: [{ claim: { name: "isSlug > Upper" } }];
      changed: [
        {
          after: {
            name: "isSlug > Dot";
            shorthand: ['isSlug("a.b") → true'];
          };
        },
      ];
      reworded: [{ after: { doc: "lowercase letters, said differently" } }];
      needsReview: 2;
    }
  >;

  type Sync = `
    const load = (id: string) => id;
    const refuse = (id: string): string => { throw new Error(id); };
    declare namespace load {
      /** an id is itself */
      export type Same = Expect<Invoke<typeof load, [id: "a"]>, "=", "a">;
      /** and a bad one is refused */
      export type Refused = Throws<Invoke<typeof refuse, [id: "b"]>, "b">;
      /** its error says which */
      export type Said = Expect<Caught<Invoke<typeof refuse, [id: "b"]>>, "matches", { message: "b" }>;
      /** a value */
      export type Other = Expect<Invoke<typeof load, [id: "a"]>, "=", "a">;
    }
  `;
  type Async = `
    const load = async (id: string) => id;
    const refuse = async (id: string): Promise<string> => { throw new Error(id); };
    declare namespace load {
      /** an id is itself */
      export type Same = Expect<Invoke<typeof load, [id: "a"]>, "=", "a">;
      /** and a bad one is refused */
      export type Refused = Throws<Invoke<typeof refuse, [id: "b"]>, "b">;
      /** its error says which */
      export type Said = Expect<Caught<Invoke<typeof refuse, [id: "b"]>>, "matches", { message: "b" }>;
      /** a value */
      export type Other = Expect<Invoke<typeof load, [id: "a"]>, "=", "b">;
    }
  `;

  /**
   * a function that became async gives the same claims: its test awaits, and
   * checks the same value (it read "changed" with the same evidence before and
   * after). A refusal that became a rejection is changed: a caller that does
   * not await the guard is no longer stopped by it. The control: a different
   * value is changed too
   */
  export type BecameAsync = Expect<
    Invoke<typeof harness.diffOf, [before: Sync, after: Async]>,
    "matches",
    {
      changed: [
        {
          before: { shorthand: ['refuse("b") throws /b/'] };
          after: { shorthand: ['refuse("b") rejects /b/'] };
        },
        { after: { name: "load > Said" } },
        { after: { name: "load > Other" } },
      ];
      setupChanged: [];
      reworded: [];
      needsReview: 3;
    }
  >;

  type Fixtures = `
    const size = (dir: string) => dir.length;
    const dirOf = (name: string) => "/tmp/" + name;
    declare namespace size {
      type Dir = Invoke<typeof dirOf, [name: "abc"]>;
      /** a directory's size */
      export type Same = Expect<Invoke<typeof size, [dir: Dir]>, "=", 8>;
      /** inline */
      export type Inline = Expect<Invoke<typeof size, [dir: Invoke<typeof dirOf, [name: "abc"]>]>, "=", 8>;
      /** the claim itself */
      export type Claim = Expect<Invoke<typeof size, [dir: Dir]>, "=", 8>;
    }
  `;
  type Rebuilt = `
    const size = (dir: string) => dir.length;
    declare namespace size {
      type Dir = TempDir<{ "a.txt": "x" }>;
      /** a directory's size */
      export type Same = Expect<Invoke<typeof size, [dir: Dir]>, "=", 8>;
      /** inline */
      export type Inline = Expect<Invoke<typeof size, [dir: TempDir<{ "a.txt": "x" }>]>, "=", 8>;
      /** the claim itself */
      export type Claim = Expect<Invoke<typeof size, [dir: Dir]>, ">", 0>;
    }
  `;

  /**
   * a change to what a test stands on, every claim line as it was, is listed
   * as "setup changed"; a claim line that differs (an argument written inline
   * in it, or what is expected) is changed. Both are a person's to approve
   */
  export type Setup = Expect<
    Invoke<typeof harness.diffOf, [before: Fixtures, after: Rebuilt]>,
    "matches",
    {
      setupChanged: [{ after: { name: "size > Same" } }];
      changed: [
        { after: { name: "size > Inline" } },
        { after: { name: "size > Claim" } },
      ];
      needsReview: 3;
    }
  >;

  type Stood = `
    const size = (s: string) => s.length;
    const refuse = (path: string): string => { if (path.includes("..")) throw new Error(path); return path; };
    const added: string[] = [];
    const add = (x: string) => { added.push(x); };
    declare namespace size {
      type Want = 8;
      type Evil = "../etc/passwd";
      /** eight characters */
      export type Eight = Expect<Invoke<typeof size, [s: "abcdefgh"]>, "=", Want>;
      /**
       * a way out is refused
       * @control
       */
      export type Out = Throws<Invoke<typeof refuse, [path: Evil]>>;
      /** both were added */
      export type Both = Given<[Invoke<typeof add, [x: "a"]>, Invoke<typeof add, [x: "b"]>], Expect<typeof added, "isNotEmpty">>;
    }
  `;
  type Weakened = `
    const size = (s: string) => s.length;
    const refuse = (path: string): string => { if (path.includes("..")) throw new Error(path); return path; };
    const added: string[] = [];
    const add = (x: string) => { added.push(x); };
    declare namespace size {
      type Want = 9;
      type Evil = "a/../b";
      /** eight characters */
      export type Eight = Expect<Invoke<typeof size, [s: "abcdefgh"]>, "=", Want>;
      /**
       * a way out is refused
       * @control
       */
      export type Out = Throws<Invoke<typeof refuse, [path: Evil]>>;
      /** both were added */
      export type Both = Given<Invoke<typeof add, [x: "a"]>, Expect<typeof added, "isNotEmpty">>;
    }
  `;

  /**
   * what a claim line stands on can change the claim: the value it expects, the
   * input a control refuses, an effect left out. Each reads the same and is
   * setup changed, and --check fails on it (none of them did)
   */
  export type StoodOn = Expect<
    Invoke<typeof harness.diffOf, [before: Stood, after: Weakened]>,
    "matches",
    {
      setupChanged: [
        { after: { name: "size > Eight" } },
        { after: { name: "size > Out" } },
        { after: { name: "size > Both" } },
      ];
      changed: [];
      needsReview: 3;
    }
  >;

  type Tagged = `
    const isSlug = (v: string) => /^[a-z]+$/.test(v);
    declare namespace isSlug {
      /**
       * lowercase letters
       * @control
       * @principle P4
       */
      export type Lower = Expect<Invoke<typeof isSlug, [v: "acme"]>, "=", true>;
      /** no capitals */
      export type Upper = Expect<Invoke<typeof isSlug, [v: "Acme"]>, "=", false>;
    }
  `;
  type Untagged = `
    const isSlug = (v: string) => /^[a-z]+$/.test(v);
    declare namespace isSlug {
      /**
       * lowercase letters
       * @principle P5
       */
      export type Lower = Expect<Invoke<typeof isSlug, [v: "acme"]>, "=", true>;
      /**
       * no capitals
       * @standsIn shared/names.ts
       */
      export type Upper = Expect<Invoke<typeof isSlug, [v: "Acme"]>, "=", false>;
    }
  `;

  type MoreTagged = `
    const isSlug = (v: string) => /^[a-z]+$/.test(v);
    declare namespace isSlug {
      /**
       * lowercase letters
       * @control
       * @principle P4
       */
      export type Lower = Expect<Invoke<typeof isSlug, [v: "acme"]>, "=", true>;
      /**
       * no capitals
       * @incident 7
       */
      export type Upper = Expect<Invoke<typeof isSlug, [v: "Acme"]>, "=", false>;
    }
  `;

  /**
   * a tag removed or added is listed (it showed nothing); a removed @control
   * or @principle is a weaker statement of evidence, so a person approves it.
   * The control: an added tag alone needs no one
   */
  export type Tags = [
    Expect<
      Invoke<typeof harness.diffOf, [before: Tagged, after: Untagged]>,
      "matches",
      {
        retagged: [
          {
            after: { name: "isSlug > Lower" };
            removed: ["@control", "@principle P4"];
            added: ["@principle P5"];
          },
          {
            after: { name: "isSlug > Upper" };
            removed: [];
            added: ["@standsIn shared/names.ts"];
          },
        ];
        changed: [];
        reworded: [];
        needsReview: 1;
      }
    >,
    Expect<
      Invoke<typeof harness.diffOf, [before: Tagged, after: MoreTagged]>,
      "matches",
      { retagged: [{ added: ["@incident 7"] }]; needsReview: 0 }
    >,
  ];
}
