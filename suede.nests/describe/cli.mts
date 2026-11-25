// `cli.mts docs …`: the docs model, and what is made from it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { cli, main } from "../vendored/typescript-cli-suede/index.ts";
import { fileCards } from "./cards.mts";
import { behaviorDiff, diffMarkdown } from "./diff.mts";
import { lint } from "./lint.mts";
import { projectDocs } from "./project.mts";
import { LIBRARY } from "../vite-plugin/discovery.mts";

import type { ProjectDocs, ProjectOptions } from "./project.mts";
import type { Expect, Invoke } from "../dsl.import.meta.vitest.ts";
import type { libraryRoot } from "../_internal/harness.mts";

const DESCRIPTION = [
  "What the tests say, as documentation.",
  "",
  "  cli.mts docs model [--out file]          the docs model of every file with tests, as JSON",
  "  cli.mts docs cards [file…] [--out dir]   each file's functions: what they answer, refuse, and who calls them",
  "  cli.mts docs diff --base <ref>           what a change does to the claims, since <ref>",
  "  cli.mts docs diff <before> <after>       the same, between two saved models",
  "  cli.mts docs lint [file…]                where the words would mislead a reader",
].join("\n");

export const parseDocs = (argv: string[]) => {
  const args = main(argv, DESCRIPTION, [
    cli.flag("out", "Where to write: a file for model, a directory for cards."),
    cli.flag(
      "base",
      "For diff: the git commit, branch or tag to compare against.",
    ),
    cli.flag(
      "tsconfig",
      "The tsconfig to read the project with.",
      "tsconfig.json",
    ),
    cli.flags(
      "exclude",
      "A glob to leave out, relative to the working directory, as the plugin's `exclude` takes them. One each: --exclude 'a/**' --exclude 'b/**'.",
    ),
    cli.flag("self", "Read the library's own tests too.", false),
    cli.flag("json", "Print JSON instead of Markdown.", false),
    cli.flag(
      "check",
      "For diff: exit 1 when a claim was removed, changed or skipped, or lost a @control, @principle, @requirement or @incident. For lint: exit 1 on any finding.",
      false,
    ),
  ]);
  const [action, ...rest] = [...args];
  return {
    action,
    rest,
    out: args.out,
    base: args.base,
    tsconfig: args.tsconfig,
    exclude: args.exclude,
    self: args.self,
    json: args.json,
    check: args.check,
    help: args.help,
  };
};

declare namespace parseDocs {
  /** an action, then what it is about */
  export type Cards = Expect<
    Invoke<typeof parseDocs, [argv: ["cards", "src/a.ts", "--out", "docs"]]>,
    "matches",
    { action: "cards"; rest: ["src/a.ts"]; out: "docs"; json: false }
  >;

  export type Diff = Expect<
    Invoke<typeof parseDocs, [argv: ["diff", "--base", "main", "--check"]]>,
    "matches",
    { action: "diff"; base: "main"; check: true }
  >;
}

type Parsed = ReturnType<typeof parseDocs>;

/**
 * Why the files named are not ones to read, or null when each is there. A name
 * that is no file read as nothing and exited 0: `--exclude a b` makes `b` a
 * file to lint, so that is what the message says first.
 */
export const missingFiles = (files: string[], root = process.cwd()) => {
  const missing = files.filter((f) => !fs.existsSync(path.resolve(root, f)));
  const glob = missing.find((f) => /[*?[{]/.test(f));
  return missing.length
    ? `no such file: ${missing.join(", ")}${glob ? `. A glob to leave out is given with --exclude, one each: --exclude '${glob}'` : ""}`
    : null;
};

declare namespace missingFiles {
  /** `docs lint --exclude a b` hands `b` over as a file: there is none, and it says how to exclude it */
  export type Glob = Expect<
    Invoke<typeof missingFiles, [files: ["suede.nests/**"]]>,
    "=",
    "no such file: suede.nests/**. A glob to leave out is given with --exclude, one each: --exclude 'suede.nests/**'"
  >;
  /** a name that is no file is said as one */
  export type Name = Expect<
    Invoke<typeof missingFiles, [files: ["nope.ts"]]>,
    "=",
    "no such file: nope.ts"
  >;
  /** @control a file that is there is read */
  export type There = Expect<
    Invoke<typeof missingFiles, [files: ["cli.mts"], root: Invoke<typeof libraryRoot>]>,
    "=",
    null
  >;
}

const projectFor = (
  p: Parsed,
  { root = process.cwd(), files = p.rest, ...more }: ProjectOptions = {},
) =>
  projectDocs({
    root,
    tsconfig: p.tsconfig,
    exclude: p.exclude,
    self: p.self,
    ...(files.length ? { files } : {}),
    ...more,
  });

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

// node_modules of this checkout, outside node_modules: what the base's sources resolve their imports through
function* nodeModulesUnder(dir: string, depth = 4): Generator<string> {
  if (depth < 0) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const at = path.join(dir, entry.name);
    if (entry.name === "node_modules") yield at;
    else yield* nodeModulesUnder(at, depth - 1);
  }
}

/** What the project's tests said at `ref`, read by this printer. */
function claimsAt(p: Parsed, ref: string): ProjectDocs {
  const cwd = process.cwd();
  const top = git(cwd, "rev-parse", "--show-toplevel");
  const within = path.relative(top, cwd);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nests-docs-base-"));
  try {
    execFileSync(
      "sh",
      [
        "-c",
        `git archive ${JSON.stringify(ref)} | tar -x -C ${JSON.stringify(tmp)}`,
      ],
      { cwd: top },
    );
    for (const modules of nodeModulesUnder(top)) {
      const target = path.join(tmp, path.relative(top, modules));
      if (!fs.existsSync(target) && fs.existsSync(path.dirname(target)))
        fs.symlinkSync(modules, target, "dir");
    }
    return projectFor(p, {
      root: path.join(tmp, within),
      files: [],
      // the base's own copy of the library is skipped, not this one
      library: path.join(tmp, path.relative(top, LIBRARY)),
      filesOnly: true,
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const readModel = (file: string) =>
  JSON.parse(fs.readFileSync(file, "utf8")) as ProjectDocs;

const write = (text: string, out?: string) => {
  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, text);
  } else process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
};

const refused = (why: string) => {
  console.error(`docs: ${why}`);
  return 2;
};

export async function runDocs(argv: string[]): Promise<number> {
  const p = parseDocs(argv);
  switch (p.action) {
    case "model":
      write(JSON.stringify(projectFor(p, { files: [] }), null, 2), p.out);
      return 0;
    case "cards": {
      const missing = missingFiles(p.rest);
      if (missing) return refused(missing);
      const project = projectFor(p);
      const pages = project.files
        .filter((f) => f.subjects.length)
        .map((f) => ({ file: f.file, text: fileCards(f, project) }));
      if (p.out)
        for (const page of pages)
          write(
            page.text,
            path.join(p.out, `${page.file.replace(/\.[cm]?tsx?$/, "")}.md`),
          );
      else write(pages.map((page) => page.text).join("\n\n---\n\n"));
      return 0;
    }
    case "diff": {
      const [before, after] = p.base
        ? [claimsAt(p, p.base), projectFor(p, { files: [], filesOnly: true })]
        : p.rest.length === 2
          ? [readModel(p.rest[0]!), readModel(p.rest[1]!)]
          : [null, null];
      if (!before || !after) {
        console.error(p.help());
        return 2;
      }
      const d = behaviorDiff(before.files, after.files);
      write(p.json ? JSON.stringify(d, null, 2) : diffMarkdown(d), p.out);
      return p.check && d.needsReview ? 1 : 0;
    }
    case "lint": {
      const missing = missingFiles(p.rest);
      if (missing) return refused(missing);
      const findings = lint(projectFor(p));
      if (p.json) write(JSON.stringify(findings, null, 2));
      else
        for (const f of findings)
          console.log(`${f.file}:${f.line}  ${f.rule.padEnd(15)} ${f.message}`);
      return p.check && findings.length ? 1 : 0;
    }
    default:
      console.error(p.help());
      return 2;
  }
}

declare namespace runDocs {
  /**
   * `docs lint --exclude a b` is refused, a usage error: it linted `b` as a
   * file, found nothing, printed nothing and exited 0
   */
  export type ExcludeTwo = Expect<
    Invoke<typeof runDocs, [argv: ["lint", "--exclude", "a/**", "b/**"]]>,
    "=",
    2
  >;
}
