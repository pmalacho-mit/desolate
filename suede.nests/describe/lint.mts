// What a reader of the docs would trip on, said where it is written. Every
// finding is a suggestion about the words: none of them is a failing test.
import path from "node:path";

import { claimWords, groupClaims, qualifiedName } from "./model.mts";
import { LIBRARY } from "../vite-plugin/discovery.mts";

import type { ClaimDoc } from "./model.mts";
import type { ProjectDocs } from "./project.mts";
import type * as harness from "../_internal/harness.mts";
import type { Expect, Invoke, Table } from "../dsl.import.meta.vitest.ts";

export type Finding = {
  file: string;
  line: number;
  rule: Rule;
  message: string;
};

export type Rule =
  | "missing-claim"
  | "restates"
  | "unresolved-link"
  | "uncited"
  | "no-control"
  | "refusal-first"
  | "unclaimed-hot"
  | "stale-stub";

const STOP = new Set(
  "a an the of to is are be it its and or in on for with as by at not no that this what which".split(
    " ",
  ),
);

const words = (text: string) =>
  new Set(
    text
      .toLowerCase()
      .replace(/`[^`]*`/g, (m) => ` ${m.slice(1, -1)} `)
      .split(/[^a-z0-9]+/)
      .filter((w) => (w.length > 1 || /\d/.test(w)) && !STOP.has(w)),
  );

/**
 * How much of a claim its evidence already says: the share of the claim's
 * words that are in the test's shorthand. A claim that only says the
 * assertion again tells the reader nothing the test did not.
 */
export const restatement = (claim: string, shorthand: string[]) => {
  const said = words(claim);
  if (said.size < 2) return 0;
  const evidence = words(shorthand.join("\n"));
  return [...said].filter((w) => evidence.has(w)).length / said.size;
};

declare namespace restatement {
  /** "4 plus 5 is 9" over add(4, 5) = 9 says nothing new; a reason does */
  export type Scores = Table<
    typeof restatement,
    [
      [
        args: [
          claim: "add 4 and 5 is 9",
          shorthand: ["add(a: 4, b: 5) → 9"],
        ],
        expected: 1,
      ],
      [
        args: [
          claim: "addition commutes for small integers",
          shorthand: ["add(a: 4, b: 5) → 9"],
        ],
        expected: 0,
      ],
    ]
  >;
}

const RESTATES = 0.8;

// a line's `// …` is a harness function's own words, filled in: not what the test checks
const ownCode = (line: string) => line.replace(/  \/\/ .*$/, "");

// a function that never returns has no case to accept: every claim of it is a refusal by nature
const neverReturns = (signature: string) => /\): never$/.test(signature);

const HOT = 10;

const at = (file: string, c: ClaimDoc) => ({ file, line: c.line });

// the command that writes the stub again, from where it is run
const stubCommand = (root: string, stub: string) =>
  `bash ${path.relative(process.cwd(), path.join(LIBRARY, "scripts/install-optional-dependency-stub.sh")) || "."} ${path.relative(process.cwd(), path.join(root, path.dirname(stub))) || "."}`;

/** Findings over a project's docs. */
export function lint(
  project: Pick<ProjectDocs, "files" | "links" | "unclaimed"> &
    Partial<Pick<ProjectDocs, "root" | "staleStubs">>,
): Finding[] {
  const out: Finding[] = [];
  for (const f of project.files) {
    // a table's rows share its words: one finding for the table, not one per row
    for (const group of groupClaims(f.claims)) {
      const c = group[0]!;
      if (c.mode === "test.todo") continue;
      const words = claimWords(c);
      if (!c.doc && group.every((r) => !r.rowDoc))
        out.push({
          ...at(f.file, c),
          rule: "missing-claim",
          message: `${c.row === null ? c.name : qualifiedName(c).replaceAll(".", " > ")} has no /** … */ saying what it shows`,
        });
      else if (words && restatement(words, c.shorthand.map(ownCode)) >= RESTATES)
        out.push({
          ...at(f.file, c),
          rule: "restates",
          message: `"${words}" says what the test checks (${c.shorthand.join("; ")}), not why it matters`,
        });
    }
    for (const s of f.subjects) {
      const claims = f.claims.filter((c) => s.claims.includes(c.name));
      const kinds = claims.map((c) => c.kind);
      if (
        kinds.length &&
        !neverReturns(s.signature) &&
        kinds.every((k) => k === "refuses") &&
        !claims.some((c) => c.tags.some((t) => t.name === "control"))
      )
        out.push({
          file: f.file,
          line: s.line,
          rule: "no-control",
          message: `every claim about ${s.name} is a refusal: add one it accepts, or tag one @control, so a reader sees the tests would notice it refusing everything`,
        });
      const firstAnswer = kinds.indexOf("answers");
      if (firstAnswer > 0)
        out.push({
          file: f.file,
          line: claims[0]!.line,
          rule: "refusal-first",
          message: `${s.name}'s claims open with a refusal: the usual case first, then the edges, then the refusals`,
        });
      // cited prose: once a subject cites some of its claims, the rest are uncited
      const cited = project.links
        .filter((l) => l.file === f.file && l.from === s.name && l.resolved)
        .map((l) => l.target.split(".").at(-1));
      if (cited.length) {
        const aliases = [...new Set(claims.map((c) => c.alias))];
        for (const alias of aliases.filter((a) => !cited.includes(a)))
          out.push({
            file: f.file,
            line: s.line,
            rule: "uncited",
            message: `${s.name}'s description cites some of its claims but not ${alias}`,
          });
      }
    }
  }
  for (const l of project.links.filter((l) => !l.resolved))
    out.push({
      file: l.file,
      line: l.line,
      rule: "unresolved-link",
      message: `{@link ${l.target}} names nothing: a claim renamed or removed?`,
    });
  for (const stub of project.staleStubs ?? [])
    out.push({
      file: stub.file,
      line: stub.line,
      rule: "stale-stub",
      message: `declares no ${stub.missing.join(", ")}: the DSL exports them now, and a test that uses one fails to type-check where suede.nests is not installed. Write the stub again: ${stubCommand(project.root ?? process.cwd(), stub.file)}`,
    });
  for (const u of project.unclaimed.filter((u) => u.callers >= HOT))
    out.push({
      file: u.file,
      line: u.line,
      rule: "unclaimed-hot",
      message: `${u.name} is called from ${u.callers} places and has no claims of its own`,
    });
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

declare namespace lint {
  type Docs = Invoke<
    typeof harness.projectOf,
    [
      source: `
        /** Reads a port ({@link parsePort.Reads}, {@link parsePort.Gone}). */
        export const parsePort = (t: string) => Number(t);
        declare namespace parsePort {
          export type Reads = Expect<Invoke<typeof parsePort, [t: "80"]>, "=", 80>;
          /** parsePort 81 is 81 */
          export type Again = Expect<Invoke<typeof parsePort, [t: "81"]>, "=", 81>;
        }
        export const refuse = (t: string): number => { if (t) throw new Error(t); return 0; };
        declare namespace refuse {
          /** anything is refused */
          export type Throws_ = Throws<Invoke<typeof refuse, [t: "x"]>>;
        }
        export const stop = (t: string): never => { throw new Error(t); };
        declare namespace stop {
          /** it never returns, so there is no case it accepts to show */
          export type Throws_ = Throws<Invoke<typeof stop, [t: "x"]>>;
        }
      `,
    ]
  >;

  /**
   * words that say again what a harness function says of itself (its own
   * JSDoc, written beside its call) do not restate what the test checks: 4 of
   * desolate's restates findings were such
   */
  export type HarnessWords = Expect<
    Invoke<
      typeof harness.ruleNames,
      [
        findings: Invoke<
          typeof lint,
          [project: Invoke<typeof harness.projectAt, [file: "harnessed/code.ts"]>]
        >,
      ]
    >,
    "excludes",
    "restates"
  >;

  /** a stub that lacks the DSL's newer exports is said, with the command that writes it again */
  export type StaleStub = Expect<
    Invoke<
      typeof lint,
      [project: Invoke<typeof harness.projectAt, [file: "stub/code.ts"]>]
    >,
    "matches",
    [
      {
        file: "nests.d.ts";
        line: 2;
        rule: "stale-stub";
        message: "declares no Construct, Call, Fixture, Widen, FromFile, Env, Snapshot, Nothing, Throws, Given, ExpectGiven, Mock, Mocked, Caught, Spy, Calls, FakeTimers, AdvanceTimers, StubEnv, TempDir, WriteFile, Exists, ListDir, Repeat, Table, Skip, SkipIfNotFound, Only, Todo, Configure: the DSL exports them now, and a test that uses one fails to type-check where suede.nests is not installed. Write the stub again: bash scripts/install-optional-dependency-stub.sh _internal/fixtures/stub";
      },
    ]
  >;

  /**
   * each rule, where the reader would trip; a function that never returns
   * (`stop`) is not asked for a case it accepts, since it has none
   */
  export type Rules = Expect<
    Invoke<
      typeof harness.ruleNames,
      [findings: Invoke<typeof lint, [project: Docs]>]
    >,
    "=",
    ["unresolved-link", "uncited", "missing-claim", "restates", "no-control"]
  >;
}
