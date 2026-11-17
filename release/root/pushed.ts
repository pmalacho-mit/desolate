// What was pushed, and whether it has landed: a record of each branch the root pushed for a
// person, and, once the mirror shows the branch's changes in the branch it was for (its pull
// request merged, by a merge, a squash or a rebase), when that was seen. The dashboard and
// `desolate branches` mark such a branch "merged into <base>", so a workspace whose work is
// all in can be stopped or removed.
//
// Read from the mirror with git alone, and only from what the remote published: a domain's
// word decides nothing here but which branch a workspace is on. The check is conservative.
// It says "landed" only when every file the branch changed is, in the base, exactly as the
// branch left it; a base that has since changed one of those files again is not recognised
// (the branch is then just not marked).
import * as fs from "node:fs";
import * as path from "node:path";
import { readJson, writeJson } from "../shared/json.ts";
import { isBranch, isCommit, pullRequestUrl } from "../shared/names.ts";
import type { RunResult } from "../shared/run.ts";
import { forge } from "./git.ts";
import { ROOT } from "./layout.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Given, Invoke, Table } from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { aRepoWhere } from "../.harness/root-git.ts";
import type { emptyRoot, writeJsonIn } from "../.harness/root-state.ts";

export type Pushed = {
  repo: string; branch: string; commit: string;
  /** The branch a pull request would go into: the offer's `--base`, else the default branch. */
  base: string | null;
  at: string;
  /** When the mirror first showed the commit's changes in `base`. */
  landed?: string;
};

const FILE = () => path.join(ROOT.state, "pushed.json");
const KEEP = 500;
/** One change to the file at a time, across processes (push.ts, raw-push.ts, rootd's fetches):
 *  a lock directory, which a process that died leaves for at most a minute. */
const changing = <T>(change: () => T): T => {
  const lock = `${FILE()}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  for (const until = Date.now() + 10_000; ; ) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() - (fs.statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? Date.now()) > 60_000) fs.rmSync(lock, { recursive: true, force: true });
      else if (Date.now() > until) throw new Error("pushed.json stayed locked for 10 s");
      else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    return change();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
};
export const pushedList = (): Pushed[] => {
  const list = readJson<unknown>(FILE(), []);
  return Array.isArray(list) ? (list as Pushed[]) : [];
};

/** After a push: the newest push of a branch replaces what was recorded for it. */
export const recordPushed = (entry: { repo: string; branch: string; commit: string; base: string | null }) => {
  if (!isBranch(entry.branch) || !isCommit(entry.commit)) return;
  const base = entry.base && isBranch(entry.base) && entry.base !== entry.branch ? entry.base : null;
  changing(() => {
    const list = pushedList().filter((p) => !(p.repo === entry.repo && p.branch === entry.branch));
    list.push({ repo: entry.repo, branch: entry.branch, commit: entry.commit, base, at: new Date().toISOString() });
    writeJson(FILE(), list.slice(-KEEP));
  });
};

declare namespace recordPushed {
  type Fresh = Invoke<typeof emptyRoot>;
  /** each push of a branch replaces what was recorded for it, and keeps the base a pull
   *  request would go into */
  export type Records = Given<
    [
      Fresh,
      Invoke<typeof recordPushed, [entry: { repo: "acme/app"; branch: "fix"; commit: "0123456789abcdef0123456789abcdef01234567"; base: "main" }]>,
      Invoke<typeof recordPushed, [entry: { repo: "acme/app"; branch: "other"; commit: "0123456789abcdef0123456789abcdef01234567"; base: "main" }]>,
      Invoke<typeof recordPushed, [entry: { repo: "acme/app"; branch: "fix"; commit: "89abcdef0123456789abcdef0123456789abcdef"; base: "main" }]>,
    ],
    Expect<Invoke<typeof pushedList>, "matches", [
      { repo: "acme/app"; branch: "other"; commit: "0123456789abcdef0123456789abcdef01234567"; base: "main" },
      { repo: "acme/app"; branch: "fix"; commit: "89abcdef0123456789abcdef0123456789abcdef"; base: "main" },
    ]>
  >;
  /** a base that is the branch itself, or not a branch, is no base; a name or commit desolate
   *  would not carry is not recorded at all */
  export type Checked = Given<
    [
      Fresh,
      Invoke<typeof recordPushed, [entry: { repo: "acme/app"; branch: "fix"; commit: "0123456789abcdef0123456789abcdef01234567"; base: "fix" }]>,
      Invoke<typeof recordPushed, [entry: { repo: "acme/app"; branch: "feat"; commit: "0123456789abcdef0123456789abcdef01234567"; base: "--all" }]>,
      Invoke<typeof recordPushed, [entry: { repo: "acme/app"; branch: "a..b"; commit: "0123456789abcdef0123456789abcdef01234567"; base: "main" }]>,
      Invoke<typeof recordPushed, [entry: { repo: "acme/app"; branch: "x"; commit: "HEAD"; base: "main" }]>,
    ],
    Expect<Invoke<typeof pushedList>, "matches", [{ branch: "fix"; base: null }, { branch: "feat"; base: null }]>
  >;
}

/** After a push that landed: record it, and return GitHub's page for opening its pull
 *  request (null on another forge, or with no base). Never throws: the push has happened,
 *  and a record that could not be written must not make it look as if it had not. */
export const afterPush = (entry: { repo: string; branch: string; commit: string; base: string | null }, warn: (line: string) => void): string | null => {
  try {
    recordPushed(entry);
  } catch (error) {
    warn(`desolate: pushed, but not recorded, so it will not be marked when merged: ${(error as Error).message}`);
  }
  try {
    return forge().kind === "github" ? pullRequestUrl(entry.repo, entry.branch, entry.base) : null;
  } catch {
    return null;
  }
};

declare namespace afterPush {
  type Fresh = Invoke<typeof emptyRoot>;
  type Push = { repo: "acme/app"; branch: "fix"; commit: "0123456789abcdef0123456789abcdef01234567"; base: "main" };
  /** pushed to GitHub: recorded, and the page for opening its pull request, in the person's
   *  own browser */
  export type GitHub = Given<
    [Fresh, Invoke<typeof writeJsonIn, [where: "state", name: "forge.json", value: { kind: "github"; ssh: { user: "git"; host: "github.com"; port: 22 }; knownHosts: "" }]>],
    [
      Expect<Invoke<typeof afterPush, [entry: Push, warn: typeof console.error]>, "=", "https://github.com/acme/app/compare/main...fix?expand=1">,
      Expect<Invoke<typeof pushedList>, "matches", [{ branch: "fix" }]>,
    ]
  >;
  /** another forge: recorded, and no link (the stand-in has no pull-request page) */
  export type Elsewhere = Given<
    [Fresh, Invoke<typeof writeJsonIn, [where: "state", name: "forge.json", value: { kind: "stand-in"; ssh: { user: "git"; host: "forge"; port: 2222 }; knownHosts: "" }]>],
    Expect<Invoke<typeof afterPush, [entry: Push, warn: typeof console.error]>, "=", null>
  >;
  /** no forge on record: still recorded (the push happened), and no link */
  export type NoForge = Given<Fresh, Expect<Invoke<typeof afterPush, [entry: Push, warn: typeof console.error]>, "=", null>>;
}

/** The base a branch's commit was pushed for and has landed in, or null. */
export const landedFor = (list: Pushed[], repo: string, branch: string, commit: string): string | null => {
  const p = list.find((e) => e.repo === repo && e.branch === branch && e.commit === commit);
  return p?.landed && p.base ? p.base : null;
};

declare namespace landedFor {
  type List = [
    { repo: "acme/app"; branch: "fix"; commit: "0123456789abcdef0123456789abcdef01234567"; base: "main"; at: "2026-11-16T12:00:00.000Z"; landed: "2026-11-16T13:00:00.000Z" },
    { repo: "acme/app"; branch: "wip"; commit: "0123456789abcdef0123456789abcdef01234567"; base: "main"; at: "2026-11-16T12:00:00.000Z" },
  ];
  /** "merged into <base>" for the commit that was pushed and has landed, and only that one: a
   *  branch moved on since is not marked */
  export type Marks = Table<typeof landedFor, [
    [args: [list: List, repo: "acme/app", branch: "fix", commit: "0123456789abcdef0123456789abcdef01234567"], expected: "main"],
    [args: [list: List, repo: "acme/app", branch: "fix", commit: "89abcdef0123456789abcdef0123456789abcdef"], expected: null],
    [args: [list: List, repo: "acme/app", branch: "wip", commit: "0123456789abcdef0123456789abcdef01234567"], expected: null],
    [args: [list: List, repo: "acme/web", branch: "fix", commit: "0123456789abcdef0123456789abcdef01234567"], expected: null],
  ]>;
}

type Git = (args: string[]) => Promise<RunResult>;

/** Whether `commit`'s changes are all in `base`, as the repository `git` runs in has them:
 *  `base` contains the commit (a merge, or a fast-forward), or every file the commit's branch
 *  changed since it left `base` is, in `base`, exactly as the commit has it (a squash, or a
 *  rebase). Read only: no merge is made, nothing is written. */
export const landedIn = async (git: Git, commit: string, base: string): Promise<boolean> => {
  const tip = (await git(["rev-parse", "--verify", "--quiet", `refs/heads/${base}^{commit}`])).stdout.trim();
  if (!tip || (await git(["cat-file", "-e", `${commit}^{commit}`])).code !== 0) return false;
  if ((await git(["merge-base", "--is-ancestor", commit, tip])).code === 0) return true;
  const fork = (await git(["merge-base", commit, tip])).stdout.trim();
  if (!fork) return false;
  const names = async (from: string, to: string) => {
    const out = await git(["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", from, to]);
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
    Expect<Invoke<typeof landedIn, [git: Merged["git"], commit: Merged["commit"], base: "main"]>, "=", true>,
    Expect<Invoke<typeof landedIn, [git: Squashed["git"], commit: Squashed["commit"], base: "main"]>, "=", true>,
  ];
  /** ...part of it, none of it, or all of it and a.txt changed again since: not landed (the
   *  last is the conservative miss: it is just not marked) */
  export type NotLanded = [
    Expect<Invoke<typeof landedIn, [git: HalfMerged["git"], commit: HalfMerged["commit"], base: "main"]>, "=", false>,
    Expect<Invoke<typeof landedIn, [git: NotMerged["git"], commit: NotMerged["commit"], base: "main"]>, "=", false>,
    Expect<Invoke<typeof landedIn, [git: ChangedAgain["git"], commit: ChangedAgain["commit"], base: "main"]>, "=", false>,
  ];
  /** a base the repository does not have, or a commit it does not hold: not landed */
  export type Unknown = [
    Expect<Invoke<typeof landedIn, [git: Merged["git"], commit: Merged["commit"], base: "release"]>, "=", false>,
    Expect<Invoke<typeof landedIn, [git: Merged["git"], commit: "0123456789abcdef0123456789abcdef01234567", base: "main"]>, "=", false>,
  ];
}

/** After the mirror of `repo` was fetched: each push of it not yet seen landed is looked for
 *  in its base. `git` runs in the mirror, whose refs/heads/* are the remote's branches. */
export const settle = async (repo: string, git: Git): Promise<number> => {
  const list = pushedList();
  let found = 0;
  for (const p of list) {
    if (p.repo !== repo || p.landed || !p.base) continue;
    if (await landedIn(git, p.commit, p.base)) {
      p.landed = new Date().toISOString();
      found++;
    }
  }
  if (found > 0) changing(() => {
    // Written over what is there now, so a push recorded meanwhile is kept.
    const now = pushedList();
    for (const p of list) if (p.landed) {
      const same = now.find((e) => e.repo === p.repo && e.branch === p.branch && e.commit === p.commit);
      if (same && !same.landed) same.landed = p.landed;
    }
    writeJson(FILE(), now);
  });
  return found;
};

declare namespace settle {
  type Fresh = Invoke<typeof emptyRoot>;
  type Squashed = Invoke<typeof aRepoWhere, [story: "squashed"]>;
  /** after a fetch, a push whose changes are now in its base is marked landed, once */
  export type Marks = Given<
    [Fresh, Squashed, Invoke<typeof recordPushed, [entry: { repo: "acme/app"; branch: "work"; commit: Squashed["commit"]; base: "main" }]>],
    [
      Expect<Invoke<typeof settle, [repo: "acme/app", git: Squashed["git"]]>, "=", 1>,
      Expect<Invoke<typeof landedFor, [list: Invoke<typeof pushedList>, repo: "acme/app", branch: "work", commit: Squashed["commit"]]>, "=", "main">,
      Expect<Invoke<typeof settle, [repo: "acme/app", git: Squashed["git"]]>, "=", 0>,
    ]
  >;
  /** another repository's pushes are not looked for in this one */
  export type OnlyItsOwn = Given<
    [Fresh, Squashed, Invoke<typeof recordPushed, [entry: { repo: "acme/web"; branch: "work"; commit: Squashed["commit"]; base: "main" }]>],
    Expect<Invoke<typeof settle, [repo: "acme/app", git: Squashed["git"]]>, "=", 0>
  >;
}

/** Repositories with a push still waiting to land, pushed in the last 30 days: the root
 *  fetches these now and then, so a pull request merged on the forge shows without anyone
 *  asking. */
export const waiting = (): string[] => {
  const since = Date.now() - 30 * 24 * 3600_000;
  return [...new Set(pushedList().filter((p) => !p.landed && p.base && Date.parse(p.at) > since).map((p) => p.repo))];
};

declare namespace waiting {
  type Fresh = Invoke<typeof emptyRoot>;
  /** the repositories the root fetches now and then: a push not yet landed, for a base, this
   *  month; not one that landed, one with no base, or one from long ago */
  export type Repos = Given<
    [
      Fresh,
      Invoke<typeof writeJsonIn, [where: "state", name: "pushed.json", value: [
        { repo: "acme/landed"; branch: "fix"; commit: "0123456789abcdef0123456789abcdef01234567"; base: "main"; at: "2026-11-16T12:00:00.000Z"; landed: "2026-11-16T13:00:00.000Z" },
        { repo: "acme/nobase"; branch: "fix"; commit: "0123456789abcdef0123456789abcdef01234567"; base: null; at: "2026-11-16T12:00:00.000Z" },
        { repo: "acme/old"; branch: "fix"; commit: "0123456789abcdef0123456789abcdef01234567"; base: "main"; at: "2020-01-01T00:00:00.000Z" },
      ]]>,
      Invoke<typeof recordPushed, [entry: { repo: "acme/app"; branch: "fix"; commit: "0123456789abcdef0123456789abcdef01234567"; base: "main" }]>,
      Invoke<typeof recordPushed, [entry: { repo: "acme/app"; branch: "feat"; commit: "0123456789abcdef0123456789abcdef01234567"; base: "main" }]>,
    ],
    Expect<Invoke<typeof waiting>, "=", ["acme/app"]>
  >;
}
