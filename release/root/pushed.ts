// Whether what was pushed has landed: once the mirror shows a pushed branch's changes in the
// branch it was for (its pull request merged, by a merge, a squash or a rebase), the root's
// record of the push (record.ts) says when that was seen. The dashboard and
// `desolate branches` mark such a branch "merged into <base>", so a workspace whose work is
// all in can be stopped or removed.
//
// Read from the mirror with git alone, and only from what the remote published: a domain's
// word decides nothing here but which branch a workspace is on. The check is conservative.
// It says "landed" only when every file the branch changed is, in the base, exactly as the
// branch left it; a base that has since changed one of those files again is not recognised
// (the branch is then just not marked).
import type { RunResult } from "../shared/run.ts";
import { landed, pushes } from "./record.ts";
import type { Pushed } from "./record.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Given, Invoke, Table } from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { aRepoWhere } from "../.harness/root-git.ts";
import type { emptyRoot, writeJsonIn } from "../.harness/root-state.ts";
import type { afterPush, marked } from "./record.ts";

type Git = (args: string[]) => Promise<RunResult>;

/** Whether `commit`'s changes are all in `base`, as the repository `git` runs in has them:
 *  `base` contains the commit (a merge, or a fast-forward), or every file the commit's branch
 *  changed since it left `base` is, in `base`, exactly as the commit has it (a squash, or a
 *  rebase). Read only: no merge is made, nothing is written. */
export const landedIn = async (git: Git, commit: string, base: string): Promise<boolean> => {
  const tip = (
    await git(["rev-parse", "--verify", "--quiet", `refs/heads/${base}^{commit}`])
  ).stdout.trim();
  if (!tip || (await git(["cat-file", "-e", `${commit}^{commit}`])).code !== 0) return false;
  if ((await git(["merge-base", "--is-ancestor", commit, tip])).code === 0) return true;
  const fork = (await git(["merge-base", commit, tip])).stdout.trim();
  if (!fork) return false;
  const names = async (from: string, to: string) => {
    const out = await git([
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--name-only",
      "-z",
      from,
      to,
    ]);
    return out.code === 0 ? out.stdout.split("\0").filter(Boolean) : null;
  };
  const changed = await names(fork, commit);
  const differs = await names(tip, commit);
  if (!changed || !differs || changed.length === 0) return false;
  const different = new Set(differs);
  return changed.every((file) => !different.has(file));
};

declare namespace landedIn {
  // Each a repository where `work` changed a.txt and b.txt, and main then took...
  type Merged = Invoke<typeof aRepoWhere, [story: "merged"]>;
  type Squashed = Invoke<typeof aRepoWhere, [story: "squashed"]>;
  type ChangedAgain = Invoke<typeof aRepoWhere, [story: "changed-again"]>;
  type HalfMerged = Invoke<typeof aRepoWhere, [story: "half-merged"]>;
  type NotMerged = Invoke<typeof aRepoWhere, [story: "not-merged"]>;
  /** ...all of it, by a merge or a squash: landed */
  export type Landed = [
    Expect<
      Invoke<typeof landedIn, [git: Merged["git"], commit: Merged["commit"], base: "main"]>,
      "=",
      true
    >,
    Expect<
      Invoke<typeof landedIn, [git: Squashed["git"], commit: Squashed["commit"], base: "main"]>,
      "=",
      true
    >,
  ];
  /** ...part of it, none of it, or all of it and a.txt changed again since: not landed (the
   *  last is the conservative miss: it is just not marked) */
  export type NotLanded = [
    Expect<
      Invoke<typeof landedIn, [git: HalfMerged["git"], commit: HalfMerged["commit"], base: "main"]>,
      "=",
      false
    >,
    Expect<
      Invoke<typeof landedIn, [git: NotMerged["git"], commit: NotMerged["commit"], base: "main"]>,
      "=",
      false
    >,
    Expect<
      Invoke<
        typeof landedIn,
        [git: ChangedAgain["git"], commit: ChangedAgain["commit"], base: "main"]
      >,
      "=",
      false
    >,
  ];
  /** a base the repository does not have, or a commit it does not hold: not landed */
  export type Unknown = [
    Expect<
      Invoke<typeof landedIn, [git: Merged["git"], commit: Merged["commit"], base: "release"]>,
      "=",
      false
    >,
    Expect<
      Invoke<
        typeof landedIn,
        [git: Merged["git"], commit: "0123456789abcdef0123456789abcdef01234567", base: "main"]
      >,
      "=",
      false
    >,
  ];
}
/** After the mirror of `repo` was fetched: each push of it not yet seen landed is looked for
 *  in its base (record.ts keeps them). `git` runs in the mirror, whose refs/heads/* are the
 *  remote's branches. */
export const settle = async (repo: string, git: Git): Promise<number> => {
  const found: Pushed[] = [];
  for (const p of pushes())
    if (p.repo === repo && !p.landed && p.base && (await landedIn(git, p.commit, p.base)))
      found.push(p);
  if (found.length > 0) await landed(found);
  return found.length;
};

declare namespace settle {
  type Fresh = Invoke<typeof emptyRoot>;
  type Squashed = Invoke<typeof aRepoWhere, [story: "squashed"]>;
  /** after a fetch, a push whose changes are now in its base is marked landed, once */
  export type Marks = Given<
    [
      Fresh,
      Squashed,
      Invoke<
        typeof afterPush,
        [
          p: {
            domain: null;
            repo: "acme/app";
            branch: "work";
            commit: Squashed["commit"];
            sent: Squashed["commit"];
            fallback: "main";
          },
          warn: typeof console.error,
        ]
      >,
    ],
    [
      Expect<Invoke<typeof settle, [repo: "acme/app", git: Squashed["git"]]>, "=", 1>,
      Expect<
        Invoke<
          typeof marked,
          [domain: "acme", list: [{ repo: "acme/app"; branch: "work"; commit: Squashed["commit"] }]]
        >,
        "matches",
        [{ landed: "main" }]
      >,
      Expect<Invoke<typeof settle, [repo: "acme/app", git: Squashed["git"]]>, "=", 0>,
    ]
  >;
  /** another repository's pushes are not looked for in this one */
  export type OnlyItsOwn = Given<
    [
      Fresh,
      Squashed,
      Invoke<
        typeof afterPush,
        [
          p: {
            domain: null;
            repo: "acme/web";
            branch: "work";
            commit: Squashed["commit"];
            sent: Squashed["commit"];
            fallback: "main";
          },
          warn: typeof console.error,
        ]
      >,
    ],
    Expect<Invoke<typeof settle, [repo: "acme/app", git: Squashed["git"]]>, "=", 0>
  >;
}

/** Repositories with a push still waiting to land, pushed in the last 30 days: the root
 *  fetches these now and then, so a pull request merged on the forge shows without anyone
 *  asking. */
export const waiting = (): string[] => {
  const since = Date.now() - 30 * 24 * 3600_000;
  return [
    ...new Set(
      pushes()
        .filter((p) => !p.landed && p.base && Date.parse(p.at) > since)
        .map((p) => p.repo),
    ),
  ];
};

declare namespace waiting {
  type Fresh = Invoke<typeof emptyRoot>;
  /** the repositories the root fetches now and then: a push not yet landed, for a base, this
   *  month; not one that landed, one with no base, or one from long ago */
  export type Repos = Given<
    [
      Fresh,
      Invoke<
        typeof writeJsonIn,
        [
          where: "state",
          name: "pushed.json",
          value: [
            {
              repo: "acme/landed";
              branch: "fix";
              commit: "0123456789abcdef0123456789abcdef01234567";
              base: "main";
              at: "2026-11-16T12:00:00.000Z";
              landed: "2026-11-16T13:00:00.000Z";
            },
            {
              repo: "acme/nobase";
              branch: "fix";
              commit: "0123456789abcdef0123456789abcdef01234567";
              base: null;
              at: "2026-11-16T12:00:00.000Z";
            },
            {
              repo: "acme/old";
              branch: "fix";
              commit: "0123456789abcdef0123456789abcdef01234567";
              base: "main";
              at: "2020-01-01T00:00:00.000Z";
            },
          ],
        ]
      >,
      Invoke<
        typeof afterPush,
        [
          p: {
            domain: null;
            repo: "acme/app";
            branch: "fix";
            commit: "0123456789abcdef0123456789abcdef01234567";
            sent: "0123456789abcdef0123456789abcdef01234567";
            fallback: "main";
          },
          warn: typeof console.error,
        ]
      >,
      Invoke<
        typeof afterPush,
        [
          p: {
            domain: null;
            repo: "acme/app";
            branch: "feat";
            commit: "0123456789abcdef0123456789abcdef01234567";
            sent: "0123456789abcdef0123456789abcdef01234567";
            fallback: "main";
          },
          warn: typeof console.error,
        ]
      >,
    ],
    Expect<Invoke<typeof waiting>, "=", ["acme/app"]>
  >;
}
