// What each domain offered, had refused and had pushed: one record per domain, repository and
// branch (/var/lib/desolate/record.json), changed here only, one change at a time across the
// processes that change it (shared/lock.ts), and read here by all that show it. It was three
// files joined by hand twice; offers.json was written by four processes with no lock, and a
// raw push left its offer under "Needs you" (the review of 2026-11-22, A1). A workspace's text
// is data here as it was there: a branch desolate would carry (offers.ts take checks it), a
// refusal's reason printable and bounded (outbox.ts noteRefusal).
import * as fs from "node:fs";
import * as path from "node:path";
import { readJson, writeJson } from "../shared/json.ts";
import { withLock } from "../shared/lock.ts";
import { isBranch, isCommit, isSlug, pullRequestUrl } from "../shared/names.ts";
import { forge } from "./git.ts";
import { ROOT } from "./layout.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Given, Invoke } from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { changedAtOnce } from "../.harness/root-record.ts";
import type { aDomain, emptyRoot, readJsonIn, writeJsonIn } from "../.harness/root-state.ts";

/** A branch a workspace marked ready. `base`: the branch a pull request of this one would go
 *  into, as the workspace said (`desolate offer --base`); without it, the default branch. */
export type Offer = {
  domain: string;
  repo: string;
  branch: string;
  commit: string;
  workspace: string;
  lfs: number;
  at: string;
  base?: string;
};
/** What the root pushed of a branch: `commit` is what the remote got (the squash, when the
 *  person chose one), `base` the branch its pull request goes into, and `landed` when the
 *  mirror first showed its changes there. `domain` is the domain that offered it, or "" for a
 *  push no domain offered (a raw `git push` of the root's own). */
export type Pushed = {
  domain: string;
  repo: string;
  branch: string;
  commit: string;
  base: string | null;
  at: string;
  landed?: string;
};
/** A bundle of a domain's the root refused: the whole bundle is, so it is by repository. */
export type Refused = { domain: string; repo: string; at: string; why: string };
type Key = "domain" | "repo" | "branch";
type Entry = Pick<Offer, Key> & {
  offered?: Omit<Offer, Key>;
  pushed?: Omit<Pushed, Key>;
};
type Kept = { entries: Entry[]; refused: Refused[] };

const FILE = () => path.join(ROOT.state, "record.json");
/** The pushes kept: what a domain's branch list marks "merged" is the latest push of it. */
const PUSHES_KEPT = 500;
/** The refusals kept for each domain: the latest of each repository's, which is one each. */
const REFUSALS_KEPT = 20;

const read = (): Kept => {
  const kept = readJson<Partial<Kept> | null>(FILE(), null);
  return kept ? { entries: kept.entries ?? [], refused: kept.refused ?? [] } : older();
};

// THE RECORD AS STACKS BEFORE 2026-11-24 KEPT IT: each domain's offers.json on its share,
// refused/<domain>.json, and pushed.json, whose pushes had no domain (each is the root's own
// here, as it was shown to every domain). Read while there is no record.json, and removed by
// the first change, which writes it. So this is needed on a stack updated from before then
// until its first offer, push, dismissal or refusal after the update, and can go once no such
// stack is left (the owner's own: one release).
const OLD = {
  offers: (domain: string) => path.join(ROOT.domains, domain, "offers.json"),
  refused: () => path.join(ROOT.state, "refused"),
  pushed: () => path.join(ROOT.state, "pushed.json"),
};
const listIn = <T>(file: string): T[] => {
  const value = readJson<unknown>(file, []);
  return Array.isArray(value) ? (value as T[]) : [];
};
const namesIn = (dir: string) => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};
const older = (): Kept => {
  const kept: Kept = { entries: [], refused: [] };
  for (const domain of namesIn(ROOT.domains).filter(isSlug))
    for (const { repo, branch, ...offered } of listIn<Offer>(OLD.offers(domain)))
      entryOf(kept, domain, repo, branch).offered = offered;
  for (const name of namesIn(OLD.refused()))
    kept.refused.push(...listIn<Refused>(path.join(OLD.refused(), name)));
  for (const { repo, branch, ...pushed } of listIn<Omit<Pushed, "domain">>(OLD.pushed()))
    entryOf(kept, "", repo, branch).pushed = pushed;
  return kept;
};
const dropOlder = () => {
  for (const domain of namesIn(ROOT.domains).filter(isSlug))
    fs.rmSync(OLD.offers(domain), { force: true });
  fs.rmSync(OLD.refused(), { recursive: true, force: true });
  fs.rmSync(OLD.pushed(), { force: true });
};

const find = (kept: Kept, domain: string, repo: string, branch: string) =>
  kept.entries.find((e) => e.domain === domain && e.repo === repo && e.branch === branch);
const entryOf = (kept: Kept, domain: string, repo: string, branch: string): Entry => {
  const entry = find(kept, domain, repo, branch) ?? { domain, repo, branch };
  if (!kept.entries.includes(entry)) kept.entries.push(entry);
  return entry;
};

/** One change to the record, under its lock, held by the process making it for as long as it
 *  takes (moments: one read and one write). */
const change = <T>(edit: (kept: Kept) => T): Promise<T> => {
  fs.mkdirSync(ROOT.state, { recursive: true });
  return withLock(path.join(ROOT.state, "record.lock"), async () => {
    const first = !fs.existsSync(FILE());
    const kept = read();
    const answer = edit(kept);
    kept.entries = kept.entries.filter((e) => e.offered || e.pushed);
    const pushes = kept.entries.filter((e) => e.pushed && !e.offered);
    for (const e of pushes.slice(0, Math.max(0, pushes.length - PUSHES_KEPT)))
      kept.entries.splice(kept.entries.indexOf(e), 1);
    writeJson(FILE(), kept, 0o600);
    if (first) dropOlder();
    return answer;
  });
};

// ------------------------------------------------------------------ reading it
/** What the domains offered (one domain's, with `only`): what "Needs you" lists. */
export const offersOf = (only?: string): Offer[] =>
  read().entries.flatMap((e) =>
    e.offered && (only === undefined || e.domain === only)
      ? [{ domain: e.domain, repo: e.repo, branch: e.branch, ...e.offered }]
      : [],
  );

declare namespace offersOf {
  type Fresh = Invoke<typeof emptyRoot>;
  /** every domain's offers, or one domain's; a domain that never offered has none */
  export type ByDomain = Given<
    [
      Fresh,
      Invoke<
        typeof offer,
        [
          o: {
            domain: "acme";
            repo: "acme/app";
            branch: "fix";
            commit: "0123456789abcdef0123456789abcdef01234567";
            workspace: "w1";
            lfs: 0;
            at: "2026-11-16T12:00:00.000Z";
          },
        ]
      >,
      Invoke<
        typeof offer,
        [
          o: {
            domain: "beta";
            repo: "acme/app";
            branch: "feat";
            commit: "0123456789abcdef0123456789abcdef01234567";
            workspace: "w1";
            lfs: 0;
            at: "2026-11-16T12:00:00.000Z";
          },
        ]
      >,
    ],
    [
      Expect<
        Invoke<typeof offersOf>,
        "matches",
        [{ domain: "acme"; branch: "fix" }, { domain: "beta"; branch: "feat" }]
      >,
      Expect<Invoke<typeof offersOf, [only: "beta"]>, "matches", [{ domain: "beta" }]>,
      Expect<Invoke<typeof offersOf, [only: "quiet"]>, "=", []>,
    ]
  >;
  /** a stack from before the record: each domain's offers.json is read as it was, and the
   *  first change writes the record and removes the old files, keeping what they held */
  export type Older = Given<
    [
      Fresh,
      Invoke<typeof aDomain, [slug: "acme", repos: ["acme/app"]]>,
      Invoke<typeof aDomain, [slug: "beta", repos: ["acme/app"]]>,
      Invoke<
        typeof writeJsonIn,
        [
          where: "domains",
          name: "acme/offers.json",
          value: [
            {
              domain: "acme";
              repo: "acme/app";
              branch: "fix";
              commit: "0123456789abcdef0123456789abcdef01234567";
              workspace: "w1";
              lfs: 0;
              at: "2026-11-16T12:00:00.000Z";
            },
          ],
        ]
      >,
      Invoke<
        typeof writeJsonIn,
        [
          where: "domains",
          name: "beta/offers.json",
          value: [
            {
              domain: "beta";
              repo: "acme/app";
              branch: "feat";
              commit: "0123456789abcdef0123456789abcdef01234567";
              workspace: "w1";
              lfs: 0;
              at: "2026-11-16T12:00:00.000Z";
            },
          ],
        ]
      >,
    ],
    [
      Expect<
        Invoke<typeof offersOf>,
        "matches",
        [{ domain: "acme"; branch: "fix" }, { domain: "beta"; branch: "feat" }]
      >,
      Expect<Invoke<typeof readJsonIn, [where: "state", name: "record.json"]>, "=", null>,
      Given<
        Invoke<
          typeof offer,
          [
            o: {
              domain: "beta";
              repo: "acme/app";
              branch: "more";
              commit: "0123456789abcdef0123456789abcdef01234567";
              workspace: "w1";
              lfs: 0;
              at: "2026-11-16T12:00:00.000Z";
            },
          ]
        >,
        [
          Expect<
            Invoke<typeof offersOf>,
            "matches",
            [{ branch: "fix" }, { branch: "feat" }, { branch: "more" }]
          >,
          Expect<
            Invoke<typeof readJsonIn, [where: "domains", name: "acme/offers.json"]>,
            "=",
            null
          >,
        ]
      >,
    ]
  >;
}

/** Every push recorded, oldest first. */
export const pushes = (): Pushed[] =>
  read().entries.flatMap((e) =>
    e.pushed ? [{ domain: e.domain, repo: e.repo, branch: e.branch, ...e.pushed }] : [],
  );

/** What the root refused of a domain's bundles, one for each repository at most. */
export const refusedOf = (domain: string): Refused[] =>
  read().refused.filter((r) => r.domain === domain);

/** A domain's branches (as its list has them: outbox.ts branchesOf), each with what the root
 *  knows of it at that commit: offered at it; the push of it (the domain's own, else one the
 *  root made of a branch of that name) while it has not landed; and the base it landed in,
 *  when it was pushed at that commit. The dashboard and `desolate branches` read it so. */
export const marked = <B extends { repo: string; branch: string; commit: string }>(
  domain: string,
  list: B[],
) => {
  const kept = read();
  return list.map((b) => {
    const mine = find(kept, domain, b.repo, b.branch);
    const of = mine?.pushed ? mine : find(kept, "", b.repo, b.branch);
    const p: Pushed | null = of?.pushed
      ? { domain: of.domain, repo: of.repo, branch: of.branch, ...of.pushed }
      : null;
    return {
      ...b,
      offered: mine?.offered?.commit === b.commit,
      pushed: p && !p.landed ? p : null,
      landed: p?.landed && p.base && p.commit === b.commit ? p.base : null,
    };
  });
};

declare namespace marked {
  type Fresh = Invoke<typeof emptyRoot>;
  type Listed = [
    { repo: "acme/app"; branch: "fix"; commit: "0123456789abcdef0123456789abcdef01234567" },
    { repo: "acme/app"; branch: "wip"; commit: "89abcdef0123456789abcdef0123456789abcdef" },
  ];
  /** a domain's branches as it lists them: offered at that commit or not, and the base a push
   *  landed in (here the root's own push of a branch of that name), for the commit that was
   *  pushed and landed only: a branch moved on since is not marked */
  export type Marks = Given<
    [
      Fresh,
      Invoke<
        typeof offer,
        [
          o: {
            domain: "acme";
            repo: "acme/app";
            branch: "fix";
            commit: "0123456789abcdef0123456789abcdef01234567";
            workspace: "w1";
            lfs: 0;
            at: "2026-11-16T12:00:00.000Z";
          },
        ]
      >,
      Invoke<
        typeof afterPush,
        [
          p: {
            domain: null;
            repo: "acme/app";
            branch: "wip";
            commit: "0123456789abcdef0123456789abcdef01234567";
            sent: "0123456789abcdef0123456789abcdef01234567";
            fallback: "main";
          },
          warn: typeof console.error,
        ]
      >,
      Invoke<
        typeof landed,
        [
          found: [
            {
              domain: "";
              repo: "acme/app";
              branch: "wip";
              commit: "0123456789abcdef0123456789abcdef01234567";
              base: "main";
              at: "";
            },
          ],
        ]
      >,
    ],
    [
      Expect<
        Invoke<typeof marked, [domain: "acme", list: Listed]>,
        "matches",
        [
          { branch: "fix"; offered: true; pushed: null; landed: null },
          { branch: "wip"; offered: false; pushed: null; landed: null },
        ]
      >,
      Expect<
        Invoke<
          typeof marked,
          [
            domain: "acme",
            list: [
              {
                repo: "acme/app";
                branch: "fix";
                commit: "89abcdef0123456789abcdef0123456789abcdef";
              },
              {
                repo: "acme/app";
                branch: "wip";
                commit: "0123456789abcdef0123456789abcdef01234567";
              },
            ],
          ]
        >,
        "matches",
        [{ offered: false }, { landed: "main" }]
      >,
    ]
  >;
  /** a push not landed yet is shown with what it sent; once landed at the commit the domain
   *  lists, "merged into" its base */
  export type Pushed = Given<
    [
      Fresh,
      Invoke<
        typeof afterPush,
        [
          p: {
            domain: "acme";
            repo: "acme/app";
            branch: "fix";
            commit: "0123456789abcdef0123456789abcdef01234567";
            sent: "0123456789abcdef0123456789abcdef01234567";
            fallback: "main";
          },
          warn: typeof console.error,
        ]
      >,
    ],
    [
      Expect<
        Invoke<typeof marked, [domain: "acme", list: Listed]>,
        "matches",
        [
          {
            branch: "fix";
            offered: false;
            pushed: {
              domain: "acme";
              commit: "0123456789abcdef0123456789abcdef01234567";
              base: "main";
            };
          },
          { pushed: null },
        ]
      >,
      Expect<
        Invoke<typeof marked, [domain: "beta", list: Listed]>,
        "matches",
        [{ pushed: null }, { pushed: null }]
      >,
      Given<
        Invoke<
          typeof landed,
          [
            found: [
              {
                domain: "acme";
                repo: "acme/app";
                branch: "fix";
                commit: "0123456789abcdef0123456789abcdef01234567";
                base: "main";
                at: "";
              },
            ],
          ]
        >,
        Expect<
          Invoke<typeof marked, [domain: "acme", list: Listed]>,
          "matches",
          [{ branch: "fix"; pushed: null; landed: "main" }, { landed: null }]
        >
      >,
    ]
  >;
}

// ------------------------------------------------------------------ changing it
/** A workspace's offer, taken (offers.ts take): the branch is under "Needs you" at its commit.
 *  Offered again without a base (a `git push`), it keeps the base it was offered for. */
export const offer = (o: Offer) =>
  change((kept) => {
    const { domain, repo, branch, base, ...offered } = o;
    const entry = entryOf(kept, domain, repo, branch);
    const given = base ?? entry.offered?.base;
    entry.offered = { ...offered, ...(given ? { base: given } : {}) };
  });

declare namespace offer {
  type Fresh = Invoke<typeof emptyRoot>;
  /** offered again, the branch's offer is replaced, and keeps the base it was offered for
   *  when the new one names none (a `git push`) */
  export type Again = Given<
    [
      Fresh,
      Invoke<
        typeof offer,
        [
          o: {
            domain: "acme";
            repo: "acme/app";
            branch: "fix";
            commit: "0123456789abcdef0123456789abcdef01234567";
            workspace: "w1";
            lfs: 0;
            at: "2026-11-16T12:00:00.000Z";
            base: "release";
          },
        ]
      >,
      Invoke<
        typeof offer,
        [
          o: {
            domain: "acme";
            repo: "acme/app";
            branch: "fix";
            commit: "89abcdef0123456789abcdef0123456789abcdef";
            workspace: "w1";
            lfs: 0;
            at: "2026-11-16T12:00:00.000Z";
          },
        ]
      >,
    ],
    Expect<
      Invoke<typeof offersOf, [only: "acme"]>,
      "matches",
      [{ branch: "fix"; commit: "89abcdef0123456789abcdef0123456789abcdef"; base: "release" }]
    >
  >;
  /** eight processes offering 25 branches each at once lose none: one change at a time */
  export type AtOnce = Given<
    Fresh,
    Expect<Invoke<typeof changedAtOnce, [takers: 8, each: 25, locked: true]>, "=", 200>
  >;
  /** the control: the same, each reading the record and writing it back with no lock, as
   *  offers.json was written, loses some */
  export type Unlocked = Given<
    Fresh,
    Expect<Invoke<typeof changedAtOnce, [takers: 8, each: 25, locked: false]>, "<", 200>
  >;
}

/** The offer leaves "Needs you" (the person dismissed it); the branch stays the domain's. */
export const withdraw = async (domain: string, repo: string, branch: string) => {
  if (!offersOf(domain).some((o) => o.repo === repo && o.branch === branch)) return;
  await change((kept) => {
    delete find(kept, domain, repo, branch)?.offered;
  });
};

/** A domain is gone: what it offered and had refused goes with it, so a domain made again
 *  under its name starts with none. (Its pushes go too: its branches are gone.) */
export const forget = (domain: string) =>
  change((kept) => {
    kept.entries = kept.entries.filter((e) => e.domain !== domain);
    kept.refused = kept.refused.filter((r) => r.domain !== domain);
  });

declare namespace forget {
  type Fresh = Invoke<typeof emptyRoot>;
  /** a domain removed takes its offers and refusals with it; another domain's stay */
  export type Forgets = Given<
    [
      Fresh,
      Invoke<
        typeof offer,
        [
          o: {
            domain: "acme";
            repo: "acme/app";
            branch: "fix";
            commit: "0123456789abcdef0123456789abcdef01234567";
            workspace: "w1";
            lfs: 0;
            at: "2026-11-16T12:00:00.000Z";
          },
        ]
      >,
      Invoke<
        typeof offer,
        [
          o: {
            domain: "beta";
            repo: "acme/app";
            branch: "fix";
            commit: "0123456789abcdef0123456789abcdef01234567";
            workspace: "w1";
            lfs: 0;
            at: "2026-11-16T12:00:00.000Z";
          },
        ]
      >,
      Invoke<typeof refuse, [domain: "acme", repo: "acme/app", why: "x"]>,
      Invoke<typeof forget, [domain: "acme"]>,
    ],
    [
      Expect<Invoke<typeof offersOf>, "matches", [{ domain: "beta" }]>,
      Expect<Invoke<typeof refusedOf, [domain: "acme"]>, "=", []>,
    ]
  >;
}

/** After a push the remote took: `sent` (the commit, or its squash) is recorded as pushed, and
 *  what was offered of it leaves "Needs you": `domain`'s offer of the branch, or, for a push
 *  that names no domain (a raw `git push` in the root's terminal or the git VM, and the
 *  dashboard's, which is one), every domain's offer of the branch at `commit`. Answers the
 *  base its pull request goes into (the offer's, else `fallback`, the default branch) and
 *  GitHub's page for opening it (null on another forge). Never throws: the push has happened,
 *  and a record that could not be written must not make it look as if it had not. */
export const afterPush = async (
  p: {
    domain: string | null;
    repo: string;
    branch: string;
    commit: string;
    sent: string;
    fallback: string | null;
  },
  warn: (line: string) => void,
): Promise<{ base: string | null; link: string | null }> => {
  const baseOf = (b?: string | null) => (b && isBranch(b) && b !== p.branch ? b : null);
  let base = baseOf(p.fallback);
  if (!isBranch(p.branch) || !isCommit(p.sent)) return { base, link: null };
  try {
    base = await change((kept) => {
      const offered = kept.entries.filter(
        (e) =>
          e.repo === p.repo &&
          e.branch === p.branch &&
          e.offered &&
          (p.domain === null ? e.offered.commit === p.commit : e.domain === p.domain),
      );
      const said = baseOf(offered.find((e) => e.offered!.base)?.offered!.base ?? p.fallback);
      const pushed = { commit: p.sent, base: said, at: new Date().toISOString() };
      for (const e of offered.length
        ? offered
        : [entryOf(kept, p.domain ?? "", p.repo, p.branch)]) {
        // The newest push last: the oldest are the ones let go.
        kept.entries.push(...kept.entries.splice(kept.entries.indexOf(e), 1));
        delete e.offered;
        e.pushed = pushed;
      }
      return said;
    });
  } catch (error) {
    warn(
      `desolate: pushed, but not recorded, so it will not be marked when merged: ${(error as Error).message}`,
    );
  }
  return { base, link: pullRequestOf({ ...p, base }) };
};

/** GitHub's page for opening a pushed branch's pull request (null on another forge, with no
 *  base, or with no forge on record). */
export const pullRequestOf = (p: Pick<Pushed, "repo" | "branch" | "base">): string | null => {
  try {
    return forge().kind === "github" ? pullRequestUrl(p.repo, p.branch, p.base) : null;
  } catch {
    return null;
  }
};

declare namespace afterPush {
  type Fresh = Invoke<typeof emptyRoot>;
  type GitHub = Invoke<
    typeof writeJsonIn,
    [
      where: "state",
      name: "forge.json",
      value: { kind: "github"; ssh: { user: "git"; host: "github.com"; port: 22 }; knownHosts: "" },
    ]
  >;
  /** a domain's push (`desolate push`): recorded under that domain, its offer of the branch
   *  withdrawn, the base it was offered for, and GitHub's page for opening the pull request */
  export type Domain = Given<
    [
      Fresh,
      GitHub,
      Invoke<
        typeof offer,
        [
          o: {
            domain: "acme";
            repo: "acme/app";
            branch: "fix";
            commit: "0123456789abcdef0123456789abcdef01234567";
            workspace: "w1";
            lfs: 0;
            at: "2026-11-16T12:00:00.000Z";
            base: "release";
          },
        ]
      >,
      Invoke<
        typeof offer,
        [
          o: {
            domain: "acme";
            repo: "acme/app";
            branch: "other";
            commit: "0123456789abcdef0123456789abcdef01234567";
            workspace: "w1";
            lfs: 0;
            at: "2026-11-16T12:00:00.000Z";
          },
        ]
      >,
    ],
    [
      Expect<
        Invoke<
          typeof afterPush,
          [
            p: {
              domain: "acme";
              repo: "acme/app";
              branch: "fix";
              commit: "0123456789abcdef0123456789abcdef01234567";
              sent: "0123456789abcdef0123456789abcdef01234567";
              fallback: "main";
            },
            warn: typeof console.error,
          ]
        >,
        "=",
        { base: "release"; link: "https://github.com/acme/app/compare/release...fix?expand=1" }
      >,
      Expect<Invoke<typeof offersOf>, "matches", [{ branch: "other" }]>,
      Expect<
        Invoke<typeof pushes>,
        "matches",
        [{ domain: "acme"; branch: "fix"; base: "release" }]
      >,
    ]
  >;
  /** a push that names no domain (a raw `git push` in the root's terminal or the git VM, and
   *  the dashboard's): every domain's offer of that branch at that commit leaves "Needs you".
   *  The control: an offer of the branch at another commit stays */
  export type Raw = Given<
    [
      Fresh,
      Invoke<
        typeof offer,
        [
          o: {
            domain: "acme";
            repo: "acme/app";
            branch: "fix";
            commit: "0123456789abcdef0123456789abcdef01234567";
            workspace: "w1";
            lfs: 0;
            at: "2026-11-16T12:00:00.000Z";
          },
        ]
      >,
      Invoke<
        typeof offer,
        [
          o: {
            domain: "beta";
            repo: "acme/app";
            branch: "fix";
            commit: "0123456789abcdef0123456789abcdef01234567";
            workspace: "w1";
            lfs: 0;
            at: "2026-11-16T12:00:00.000Z";
          },
        ]
      >,
      Invoke<
        typeof offer,
        [
          o: {
            domain: "gamma";
            repo: "acme/app";
            branch: "fix";
            commit: "89abcdef0123456789abcdef0123456789abcdef";
            workspace: "w1";
            lfs: 0;
            at: "2026-11-16T12:00:00.000Z";
          },
        ]
      >,
    ],
    [
      Expect<
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
        "=",
        { base: "main"; link: null }
      >,
      Expect<
        Invoke<typeof offersOf>,
        "matches",
        [{ domain: "gamma"; commit: "89abcdef0123456789abcdef0123456789abcdef" }]
      >,
      Expect<
        Invoke<typeof pushes>,
        "matches",
        [{ domain: "acme"; branch: "fix" }, { domain: "beta"; branch: "fix" }]
      >,
    ]
  >;
  /** each push of a branch replaces what was recorded for it, the newest last; one no domain
   *  offered is the root's own (""); the base is one a pull request can go into, or none; a
   *  name or commit desolate would not carry is not recorded at all */
  export type Records = Given<
    [
      Fresh,
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
            branch: "other";
            commit: "0123456789abcdef0123456789abcdef01234567";
            sent: "0123456789abcdef0123456789abcdef01234567";
            fallback: "other";
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
            branch: "fix";
            commit: "89abcdef0123456789abcdef0123456789abcdef";
            sent: "89abcdef0123456789abcdef0123456789abcdef";
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
            branch: "a..b";
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
            branch: "x";
            commit: "HEAD";
            sent: "HEAD";
            fallback: "main";
          },
          warn: typeof console.error,
        ]
      >,
    ],
    Expect<
      Invoke<typeof pushes>,
      "matches",
      [
        { domain: ""; branch: "other"; base: null },
        {
          domain: "";
          branch: "fix";
          commit: "89abcdef0123456789abcdef0123456789abcdef";
          base: "main";
        },
      ]
    >
  >;
  /** another forge: recorded, and no link (the stand-in has no pull-request page); no forge
   *  on record: recorded all the same (the push happened), and no link */
  export type Elsewhere = Given<
    [
      Fresh,
      Invoke<
        typeof writeJsonIn,
        [
          where: "state",
          name: "forge.json",
          value: {
            kind: "stand-in";
            ssh: { user: "git"; host: "forge"; port: 2222 };
            knownHosts: "";
          },
        ]
      >,
    ],
    [
      Expect<
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
        "=",
        { base: "main"; link: null }
      >,
      Given<
        Fresh,
        Expect<
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
          "=",
          { base: "main"; link: null }
        >
      >,
      Expect<Invoke<typeof pushes>, "matches", [{ branch: "fix" }]>,
    ]
  >;
}

/** Pushes the mirror now shows in their base (pushed.ts settle): marked landed, once. */
export const landed = (found: Pushed[]) =>
  change((kept) => {
    const at = new Date().toISOString();
    for (const f of found) {
      const p = find(kept, f.domain, f.repo, f.branch)?.pushed;
      if (p && p.commit === f.commit && !p.landed) p.landed = at;
    }
  });

/** The root refused a domain's bundle of `repo`, for `why` (printable, and bounded by the
 *  caller: outbox.ts noteRefusal): the latest is kept, one for each repository. */
export const refuse = (domain: string, repo: string, why: string) =>
  change((kept) => {
    const others = kept.refused.filter((r) => r.domain === domain && r.repo !== repo);
    kept.refused = [
      ...kept.refused.filter((r) => r.domain !== domain),
      ...others.slice(-(REFUSALS_KEPT - 1)),
      { domain, repo, at: new Date().toISOString(), why },
    ];
  });

/** A bundle of `repo` was taken: what was refused of it before is not any more. */
export const accept = async (domain: string, repo: string) => {
  if (!refusedOf(domain).some((r) => r.repo === repo)) return;
  await change((kept) => {
    kept.refused = kept.refused.filter((r) => !(r.domain === domain && r.repo === repo));
  });
};
