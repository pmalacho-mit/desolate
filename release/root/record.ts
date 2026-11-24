// What each domain offered, had refused and had pushed: one record per domain, repository and
// branch, changed here only and read here by everything that shows it (the dashboard,
// `desolate offers`, `desolate branches`). It was three kinds of file joined by hand twice;
// offers.json was written by four processes with no lock, and a raw push left its offer under
// "Needs you" (the review of 2026-11-22, A1).
//
// WHERE. Each domain's records are its own file, /var/lib/desolate/records/<domain>.json, with
// its own lock beside it: a domain that offers 50,000 branches pays for its own reads and
// writes, and a torn file costs that domain alone. The root's own pushes (a raw `git push` of
// a branch no domain offered) are in `-root.json` there, a name no domain can have (a domain's
// name starts with a letter or a digit). Only the root VM's own user writes them: start.sh runs
// rootd, the state service and the CLI channel as that user, and `desolate push` and the
// root's terminal run as it too; root's own ways in (forge-pin, review-ask, proxy-user.sh)
// write none of this. So a write as root is refused rather than left owned by root.
//
// TRUST. A workspace's text is data here as it was there: each entry is checked as it is read
// (a branch desolate would carry, a commit, a repository), and one that is not what the root
// writes is dropped and counted, never taken for the whole file. A file that is not a record
// at all is never read as empty and written over: the next change sets it aside, says so,
// and makes no change.
import * as fs from "node:fs";
import * as path from "node:path";
import { refuse } from "../shared/exit.ts";
import { RECORD } from "../shared/limits.ts";
import { withLock } from "../shared/lock.ts";
import type { Holder } from "../shared/lock.ts";
import { isBranch, isCommit, isSlug, parseRepo, pullRequestUrl } from "../shared/names.ts";
import { forge, git } from "./git.ts";
import { clonePath, ROOT } from "./layout.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type {
  Expect,
  Given,
  Invoke,
  Mock,
  Throws,
} from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { refusalOf } from "../.harness/refusal.ts";
import type {
  aBranchPastItsOffer,
  atAWholeSecond,
  changedAtOnce,
  noRecords,
  recordFiles,
  rewrittenInPlace,
  smallRecord,
} from "../.harness/root-record.ts";
import type { heldBy } from "../.harness/shared-lock.ts";
import type {
  aDomain,
  emptyRoot,
  mirrorsAndClonesHere,
  pathIn,
  readIn,
  writeIn,
  writeJsonIn,
} from "../.harness/root-state.ts";

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
 *  mirror first showed its changes there. `domain` is whose push it was: the domain that
 *  pushed or offered it, or "" for the root's own. */
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
type Place = "domain" | "repo" | "branch";
type Entry = {
  repo: string;
  branch: string;
  offered?: Omit<Offer, Place>;
  pushed?: Omit<Pushed, Place>;
};
type Kept = { entries: Entry[]; refused: Omit<Refused, "domain">[] };
type Read = { kept: Kept; dropped: number } | { unreadable: string; file: string };

const DIR = () => path.join(ROOT.state, "records");
const EMPTY = JSON.stringify({ entries: [], refused: [] });
const fileOf = (owner: string) => path.join(DIR(), `${owner || "-root"}.json`);
const whose = (owner: string) => (owner ? `the domain '${owner}'` : "the root's own pushes");

// ------------------------------------------------------------------ reading it, checked
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown, most = 1000): v is string => typeof v === "string" && v.length <= most;
const offeredOf = (v: unknown): Entry["offered"] | null =>
  isObject(v) &&
  isCommit(v.commit) &&
  (v.workspace === "" || isSlug(v.workspace)) &&
  Number.isInteger(v.lfs) &&
  isText(v.at, 40) &&
  (v.base === undefined || isBranch(v.base))
    ? {
        commit: v.commit,
        workspace: v.workspace as string,
        lfs: v.lfs as number,
        at: v.at,
        ...(v.base === undefined ? {} : { base: v.base }),
      }
    : null;
const pushedOf = (v: unknown): Entry["pushed"] | null =>
  isObject(v) &&
  isCommit(v.commit) &&
  (v.base === null || isBranch(v.base)) &&
  isText(v.at, 40) &&
  (v.landed === undefined || isText(v.landed, 40))
    ? {
        commit: v.commit,
        base: v.base as string | null,
        at: v.at,
        ...(v.landed === undefined ? {} : { landed: v.landed as string }),
      }
    : null;
/** A record as the root writes it, entry by entry: what is not as it writes it is dropped and
 *  counted (`dropped`); a value that is no record at all is `unreadable`, never empty. */
const recordFrom = (value: unknown, file: string): Read => {
  if (!isObject(value) || !Array.isArray(value.entries) || !Array.isArray(value.refused))
    return { unreadable: "is not a record (its entries and its refusals, each a list)", file };
  const kept: Kept = { entries: [], refused: [] };
  let dropped = 0;
  for (const e of value.entries) {
    const offered = isObject(e) && e.offered !== undefined ? offeredOf(e.offered) : undefined;
    const pushed = isObject(e) && e.pushed !== undefined ? pushedOf(e.pushed) : undefined;
    if (
      !isObject(e) ||
      !parseRepo(e.repo) ||
      !isBranch(e.branch) ||
      offered === null ||
      pushed === null
    )
      dropped++;
    if (isObject(e) && parseRepo(e.repo) && isBranch(e.branch) && (offered || pushed))
      kept.entries.push({
        repo: e.repo as string,
        branch: e.branch,
        ...(offered ? { offered } : {}),
        ...(pushed ? { pushed } : {}),
      });
  }
  for (const r of value.refused)
    if (isObject(r) && parseRepo(r.repo) && isText(r.at, 40) && isText(r.why))
      kept.refused.push({ repo: r.repo as string, at: r.at, why: r.why });
    else dropped++;
  return { kept, dropped };
};

/** What a file held, read as `from` reads it: once for each version of the file (its inode,
 *  size and time), so a state built every few seconds parses only the files that changed. A
 *  file that is not a plain one, or is past RECORD.bytes, is unreadable. null: no file. What
 *  was unreadable or dropped is said once, when that version is first read. */
const seen = new Map<string, { key: string; read: Read }>();
const load = (file: string, from: (value: unknown, file: string) => Read): Read | null => {
  let fd: number;
  try {
    fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? null : { unreadable: `could not be opened (${code})`, file };
  }
  try {
    const stat = fs.fstatSync(fd);
    const key = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    const known = seen.get(file);
    if (known?.key === key) return known.read;
    let read: Read;
    if (!stat.isFile()) read = { unreadable: "is not a plain file", file };
    else if (stat.size > RECORD.bytes)
      read = { unreadable: `is ${stat.size} bytes, past the ${RECORD.bytes} a record is`, file };
    else
      try {
        read = from(JSON.parse(fs.readFileSync(fd, "utf8")), file);
      } catch {
        read = { unreadable: "is not JSON", file };
      }
    if ("unreadable" in read)
      console.error(
        `record: ${read.file} ${read.unreadable}: not read, and set aside at the next change`,
      );
    else if (read.dropped > 0)
      console.error(
        `record: ${read.dropped} entries of ${file} are not as the root writes them: left out`,
      );
    seen.set(file, { key, read });
    return read;
  } finally {
    fs.closeSync(fd);
  }
};

// THE RECORD AS STACKS BEFORE 2026-11-24 KEPT IT: each domain's offers.json on its share and
// refused/<domain>.json, and pushed.json (whose pushes had no domain: the root's own here, as
// each was shown to every domain). Read while the domain has no file in records/, through the
// same checks, its domain taken from where the file is and never from what it says. The first
// change writes the new file and only then removes the old ones; one left beside a readable
// new file (a change cut short between the two) is removed by the next change. So this is
// needed on a stack updated from before then until each domain's first change after the
// update, and can go one release after (the owner's own stacks are the only ones).
const OLD = {
  offers: (domain: string) => path.join(ROOT.domains, domain, "offers.json"),
  refused: (domain: string) => path.join(ROOT.state, "refused", `${domain}.json`),
  pushed: () => path.join(ROOT.state, "pushed.json"),
};
const listFrom =
  (as: (item: unknown) => unknown, refused = false) =>
  (value: unknown, file: string): Read =>
    Array.isArray(value)
      ? recordFrom(
          refused ? { entries: [], refused: value } : { entries: value.map(as), refused: [] },
          file,
        )
      : { unreadable: "is not a list", file };
const older = (owner: string): Read => {
  const parts = owner
    ? [
        load(
          OLD.offers(owner),
          listFrom((o) => ({ ...(isObject(o) ? o : {}), offered: o })),
        ),
        load(
          OLD.refused(owner),
          listFrom((r) => r, true),
        ),
      ]
    : [
        load(
          OLD.pushed(),
          listFrom((p) => ({ ...(isObject(p) ? p : {}), pushed: p })),
        ),
      ];
  const kept: Kept = { entries: [], refused: [] };
  let dropped = 0;
  for (const part of parts) {
    if (part && "unreadable" in part) return part;
    if (!part) continue;
    kept.entries.push(...part.kept.entries);
    kept.refused.push(...part.kept.refused);
    dropped += part.dropped;
  }
  return { kept, dropped };
};
const dropOlder = (owner: string) => {
  for (const file of owner ? [OLD.offers(owner), OLD.refused(owner)] : [OLD.pushed()])
    fs.rmSync(file, { force: true });
};

const recordOf = (owner: string): Read => load(fileOf(owner), recordFrom) ?? older(owner);
/** A domain's record as it reads now: one that is unreadable reads as none (it is said). */
const keptOf = (owner: string): Kept => {
  const read = recordOf(owner);
  return "unreadable" in read ? { entries: [], refused: [] } : read.kept;
};
const find = (kept: Kept, repo: string, branch: string) =>
  kept.entries.find((e) => e.repo === repo && e.branch === branch);
const entryOf = (kept: Kept, repo: string, branch: string): Entry => {
  const entry = find(kept, repo, branch) ?? { repo, branch };
  if (!kept.entries.includes(entry)) kept.entries.push(entry);
  return entry;
};
/** Everyone with a record: each domain's file, each domain not yet updated, and the root. */
const owners = () => {
  const names = (dir: string) => {
    try {
      return fs.readdirSync(dir);
    } catch {
      return [];
    }
  };
  return [
    ...new Set([
      "",
      ...names(DIR()).flatMap((n) =>
        n.endsWith(".json") && isSlug(n.slice(0, -5)) ? [n.slice(0, -5)] : [],
      ),
      ...names(ROOT.domains).filter(isSlug),
    ]),
  ];
};

// ------------------------------------------------------------------ changing it
/** The whole file, on disk before it takes the record's name: a crash leaves the old one or
 *  the new one, never part of one. (Its directory is not synced: a crash may lose the change,
 *  never the record.) */
const writeSynced = (file: string, value: Kept) => {
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const fd = fs.openSync(temp, "wx", 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(value));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
};
/** One change to an owner's record, under that owner's lock (held for moments: one read and
 *  one write), waited for at most RECORD.lockWaitMs, then refused saying who holds it. A
 *  record that cannot be read is set aside, said, and not changed. Nothing is written when
 *  nothing changed. */
const change = async <T>(owner: string, edit: (kept: Kept) => T): Promise<T> => {
  if (owner && !isSlug(owner)) throw new Error(`'${owner}' is not a domain`);
  if (process.getuid?.() === 0)
    throw new Error("the root's record is written by the root VM's own user, never by root");
  fs.mkdirSync(DIR(), { recursive: true, mode: 0o700 });
  const file = fileOf(owner);
  let holder: Holder | null = null;
  const waited = AbortSignal.timeout(RECORD.lockWaitMs);
  let began = false;
  try {
    return await withLock(
      `${file}.lock`,
      async () => {
        began = true;
        // What a writer that died left half made.
        for (const name of fs.readdirSync(DIR()))
          if (name.startsWith(`${path.basename(file)}.tmp-`))
            fs.rmSync(path.join(DIR(), name), { force: true });
        const read = recordOf(owner);
        if ("unreadable" in read) {
          const aside = `${read.file}.unreadable-${new Date().toISOString().replace(/[:.]/g, "-")}`;
          fs.renameSync(read.file, aside);
          refuse(
            `the root's record of ${whose(owner)} ${read.unreadable}: it was set aside as ${aside}, and nothing was changed`,
            "do it again: the record starts anew, and what was set aside is kept for a person to read",
          );
        }
        const before = JSON.stringify(read.kept);
        const kept: Kept = JSON.parse(before);
        const answer = edit(kept);
        kept.entries = kept.entries.filter((e) => e.offered || e.pushed);
        const pushes = kept.entries.filter((e) => e.pushed && !e.offered);
        for (const e of pushes.slice(0, Math.max(0, pushes.length - RECORD.pushes)))
          kept.entries.splice(kept.entries.indexOf(e), 1);
        // (A record read from the older files is written even unchanged: then they can go.)
        const there = fs.existsSync(file);
        if (JSON.stringify(kept) !== before || (!there && before !== EMPTY))
          writeSynced(file, kept);
        if (there || fs.existsSync(file)) dropOlder(owner);
        return answer;
      },
      { waiting: (h) => (holder = h), signal: waited },
    );
  } catch (error) {
    if (!began && waited.aborted)
      throw new Error(
        `the root's record of ${whose(owner)} stayed locked for ${RECORD.lockWaitMs / 1000} s${holder ? ` (by process ${(holder as Holder).pid}, since ${(holder as Holder).since})` : ""}`,
      );
    throw error;
  }
};

// ------------------------------------------------------------------ reading it
/** What a domain offered: what "Needs you" lists of it. */
export const offersOf = (domain: string): Offer[] =>
  keptOf(domain).entries.flatMap((e) =>
    e.offered ? [{ ...e.offered, repo: e.repo, branch: e.branch, domain }] : [],
  );

declare namespace offersOf {
  /** each domain's offers are its own: another's are not among them */
  export type ByDomain = Given<
    [
      Invoke<typeof emptyRoot>,
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
          listed: {},
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
          listed: {},
        ]
      >,
    ],
    [
      Expect<
        Invoke<typeof offersOf, [domain: "acme"]>,
        "matches",
        [{ domain: "acme"; branch: "fix" }]
      >,
      Expect<
        Invoke<typeof offersOf, [domain: "beta"]>,
        "matches",
        [{ domain: "beta"; branch: "feat" }]
      >,
      Expect<Invoke<typeof offersOf, [domain: "quiet"]>, "=", []>,
    ]
  >;
  /** a stack from before the records: a domain's offers.json and refused/ file are read as
   *  they were, the domain taken from where each is (a "domain" inside names another, and is
   *  not believed); the first change writes the domain's record and removes the old files */
  export type Older = Given<
    [
      Invoke<typeof emptyRoot>,
      Invoke<typeof aDomain, [slug: "acme", repos: ["acme/app"]]>,
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
          where: "state",
          name: "refused/acme.json",
          value: [{ domain: "beta"; repo: "acme/app"; at: "2026-11-16T12:00:00.000Z"; why: "old" }],
        ]
      >,
    ],
    [
      Expect<
        Invoke<typeof offersOf, [domain: "acme"]>,
        "matches",
        [{ domain: "acme"; branch: "fix" }]
      >,
      Expect<Invoke<typeof recordFiles>, "=", []>,
      Given<
        Invoke<
          typeof offer,
          [
            o: {
              domain: "acme";
              repo: "acme/app";
              branch: "more";
              commit: "0123456789abcdef0123456789abcdef01234567";
              workspace: "w1";
              lfs: 0;
              at: "2026-11-16T12:00:00.000Z";
            },
            listed: {},
          ]
        >,
        [
          Expect<
            Invoke<typeof offersOf, [domain: "acme"]>,
            "matches",
            [{ branch: "fix" }, { branch: "more" }]
          >,
          Expect<Invoke<typeof readIn, [where: "domains", name: "acme/offers.json"]>, "=", null>,
          Expect<Invoke<typeof readIn, [where: "state", name: "refused/acme.json"]>, "=", null>,
          Expect<Invoke<typeof refusedOf, [domain: "acme"]>, "matches", [{ why: "old" }]>,
          Expect<Invoke<typeof recordFiles>, "=", ["acme.json"]>,
        ]
      >,
    ]
  >;
  /** what an old file says of its domain is not where it is: beta's file naming acme gives beta
   *  an offer, and acme none */
  export type PlaceDecides = Given<
    [
      Invoke<typeof emptyRoot>,
      Invoke<
        typeof writeJsonIn,
        [
          where: "domains",
          name: "beta/offers.json",
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
    ],
    [
      Expect<
        Invoke<typeof offersOf, [domain: "beta"]>,
        "matches",
        [{ domain: "beta"; branch: "fix" }]
      >,
      Expect<Invoke<typeof offersOf, [domain: "acme"]>, "=", []>,
    ]
  >;
  /** a change cut short between writing the record and removing the old file: the record is
   *  what is read, and the next change removes the old file */
  export type Interrupted = Given<
    [
      Invoke<typeof emptyRoot>,
      Invoke<
        typeof offer,
        [
          o: {
            domain: "acme";
            repo: "acme/app";
            branch: "new";
            commit: "0123456789abcdef0123456789abcdef01234567";
            workspace: "w1";
            lfs: 0;
            at: "2026-11-16T12:00:00.000Z";
          },
          listed: {},
        ]
      >,
      Invoke<
        typeof writeJsonIn,
        [
          where: "domains",
          name: "acme/offers.json",
          value: [
            {
              domain: "acme";
              repo: "acme/app";
              branch: "stale";
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
      Expect<Invoke<typeof offersOf, [domain: "acme"]>, "matches", [{ branch: "new" }]>,
      Given<
        Invoke<
          typeof offer,
          [
            o: {
              domain: "acme";
              repo: "acme/app";
              branch: "more";
              commit: "0123456789abcdef0123456789abcdef01234567";
              workspace: "w1";
              lfs: 0;
              at: "2026-11-16T12:00:00.000Z";
            },
            listed: {},
          ]
        >,
        Expect<Invoke<typeof readIn, [where: "domains", name: "acme/offers.json"]>, "=", null>
      >,
    ]
  >;
  /** an entry that is not what the root writes is left out, and the rest read: a null, an
   *  offer at no commit, a branch desolate would not carry. The control: the good one */
  export type Entries = Given<
    [
      Invoke<typeof emptyRoot>,
      Invoke<
        typeof writeIn,
        [
          where: "state",
          name: "records/acme.json",
          text: '{"entries":[null,{"repo":"acme/app","branch":"x","offered":{"commit":"HEAD","workspace":"","lfs":0,"at":""}},{"repo":"acme/app","branch":"--all","offered":{"commit":"0123456789abcdef0123456789abcdef01234567","workspace":"","lfs":0,"at":""}},{"repo":"acme/app","branch":"fix","offered":{"commit":"0123456789abcdef0123456789abcdef01234567","workspace":"","lfs":0,"at":""}}],"refused":[7]}',
        ]
      >,
    ],
    Expect<Invoke<typeof offersOf, [domain: "acme"]>, "matches", [{ branch: "fix" }]>
  >;
  /** a record is parsed once for each version of it: rewritten in place, same size and same
   *  time, it is not read again. The control: once its time moves, it is */
  export type Once = Given<
    [
      Invoke<typeof emptyRoot>,
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
          listed: {},
        ]
      >,
      Invoke<typeof atAWholeSecond, [domain: "acme"]>,
      Invoke<typeof offersOf, [domain: "acme"]>,
      Invoke<typeof rewrittenInPlace, [domain: "acme", text: '{"entries":[],"refused":[]}']>,
    ],
    [
      Expect<Invoke<typeof offersOf, [domain: "acme"]>, "matches", [{ branch: "fix" }]>,
      Given<
        Invoke<typeof atAWholeSecond, [domain: "acme", second: 1700000001]>,
        Expect<Invoke<typeof offersOf, [domain: "acme"]>, "=", []>
      >,
    ]
  >;
}

/** A domain's offers as they stand against its own list of branches (outbox.ts branchesOf,
 *  `listed`): `now` is the commit the branch is at (null: the domain no longer has it), so an
 *  offer the branch has left is shown as moved, and not pushed from the dashboard; and
 *  `pushedAs`, the branch a push of exactly that commit went out as, if it went out under
 *  another name. */
export const offersAt = (
  domain: string,
  listed: { repo: string; branch: string; commit: string }[],
) => {
  const all = pushes();
  return offersOf(domain).map((o) => ({
    ...o,
    now: listed.find((b) => b.repo === o.repo && b.branch === o.branch)?.commit ?? null,
    pushedAs:
      all.find((p) => p.repo === o.repo && p.branch !== o.branch && p.commit === o.commit)
        ?.branch ?? null,
  }));
};

declare namespace offersAt {
  /** an offer the branch has left is shown with where the branch is now, or null once the
   *  domain no longer has it; one at the branch's commit is as offered. A commit pushed under
   *  another name says so */
  export type Moved = Given<
    [
      Invoke<typeof emptyRoot>,
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
          listed: {},
        ]
      >,
      Invoke<
        typeof offer,
        [
          o: {
            domain: "acme";
            repo: "acme/app";
            branch: "gone";
            commit: "0123456789abcdef0123456789abcdef01234567";
            workspace: "w1";
            lfs: 0;
            at: "2026-11-16T12:00:00.000Z";
          },
          listed: {},
        ]
      >,
      Invoke<
        typeof offer,
        [
          o: {
            domain: "acme";
            repo: "acme/app";
            branch: "same";
            commit: "89abcdef0123456789abcdef0123456789abcdef";
            workspace: "w1";
            lfs: 0;
            at: "2026-11-16T12:00:00.000Z";
          },
          listed: {},
        ]
      >,
      Invoke<
        typeof recordPush,
        [
          p: {
            domain: null;
            repo: "acme/app";
            branch: "elsewhere";
            commit: "89abcdef0123456789abcdef0123456789abcdef";
            sent: "89abcdef0123456789abcdef0123456789abcdef";
            fallback: "main";
          },
        ]
      >,
    ],
    Expect<
      Invoke<
        typeof offersAt,
        [
          domain: "acme",
          listed: [
            { repo: "acme/app"; branch: "fix"; commit: "89abcdef0123456789abcdef0123456789abcdef" },
            {
              repo: "acme/app";
              branch: "same";
              commit: "89abcdef0123456789abcdef0123456789abcdef";
            },
          ],
        ]
      >,
      "matches",
      [
        { branch: "fix"; now: "89abcdef0123456789abcdef0123456789abcdef"; pushedAs: null },
        { branch: "gone"; now: null },
        { branch: "same"; now: "89abcdef0123456789abcdef0123456789abcdef"; pushedAs: "elsewhere" },
      ]
    >
  >;
}

/** Every push recorded, each owner's oldest first. */
export const pushes = (): Pushed[] =>
  owners().flatMap((owner) =>
    keptOf(owner).entries.flatMap((e) =>
      e.pushed ? [{ ...e.pushed, repo: e.repo, branch: e.branch, domain: owner }] : [],
    ),
  );

/** What the root refused of a domain's bundles, one for each repository at most. */
export const refusedOf = (domain: string): Refused[] =>
  keptOf(domain).refused.map((r) => ({ ...r, domain }));

/** A domain's branches (as its list has them: outbox.ts branchesOf), each with what the root
 *  knows of it at that commit: offered at it; the newest push of it (the domain's own, or the
 *  root's own of a branch of that name), while it has not landed; and the base it landed in,
 *  when that push was of this commit. The dashboard and `desolate branches` read it so. */
export const marked = <B extends { repo: string; branch: string; commit: string }>(
  domain: string,
  list: B[],
) => {
  const [mine, roots] = [keptOf(domain), keptOf("")];
  return list.map((b) => {
    const own = find(mine, b.repo, b.branch);
    const candidates = [
      ...(own?.pushed ? [{ ...own.pushed, domain }] : []),
      ...(find(roots, b.repo, b.branch)?.pushed
        ? [{ ...find(roots, b.repo, b.branch)!.pushed!, domain: "" }]
        : []),
    ].sort((x, y) => x.at.localeCompare(y.at));
    const newest = candidates.at(-1);
    const p: Pushed | null = newest ? { ...newest, repo: b.repo, branch: b.branch } : null;
    return {
      ...b,
      offered: own?.offered?.commit === b.commit,
      pushed: p && !p.landed ? p : null,
      landed: p?.landed && p.base && p.commit === b.commit ? p.base : null,
    };
  });
};

declare namespace marked {
  type Listed = [
    { repo: "acme/app"; branch: "fix"; commit: "0123456789abcdef0123456789abcdef01234567" },
    { repo: "acme/app"; branch: "wip"; commit: "89abcdef0123456789abcdef0123456789abcdef" },
  ];
  /** offered at the commit listed or not; a push not landed yet, with what it sent; once
   *  landed at that commit, the base it is in; and not for a domain whose push it was not */
  export type Marks = Given<
    [
      Invoke<typeof emptyRoot>,
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
          listed: {},
        ]
      >,
      Invoke<
        typeof recordPush,
        [
          p: {
            domain: "acme";
            repo: "acme/app";
            branch: "wip";
            commit: "0123456789abcdef0123456789abcdef01234567";
            sent: "0123456789abcdef0123456789abcdef01234567";
            fallback: "main";
          },
        ]
      >,
    ],
    [
      Expect<
        Invoke<typeof marked, [domain: "acme", list: Listed]>,
        "matches",
        [
          { branch: "fix"; offered: true; pushed: null; landed: null },
          {
            branch: "wip";
            offered: false;
            pushed: { domain: "acme"; commit: "0123456789abcdef0123456789abcdef01234567" };
          },
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
                branch: "wip";
                commit: "0123456789abcdef0123456789abcdef01234567";
                base: "main";
                at: "";
              },
            ],
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
                  branch: "wip";
                  commit: "0123456789abcdef0123456789abcdef01234567";
                },
              ],
            ]
          >,
          "matches",
          [{ pushed: null; landed: "main" }]
        >
      >,
    ]
  >;
  /** the domain's own older push and a newer one of the root's of that branch: the newest is
   *  what is shown */
  export type Newest = Given<
    [
      Invoke<typeof emptyRoot>,
      Invoke<
        typeof recordPush,
        [
          p: {
            domain: "acme";
            repo: "acme/app";
            branch: "wip";
            commit: "0123456789abcdef0123456789abcdef01234567";
            sent: "0123456789abcdef0123456789abcdef01234567";
            fallback: "main";
          },
        ]
      >,
      Invoke<
        typeof recordPush,
        [
          p: {
            domain: null;
            repo: "acme/app";
            branch: "wip";
            commit: "89abcdef0123456789abcdef0123456789abcdef";
            sent: "89abcdef0123456789abcdef0123456789abcdef";
            fallback: "main";
          },
        ]
      >,
    ],
    Expect<
      Invoke<typeof marked, [domain: "acme", list: Listed]>,
      "matches",
      [
        { pushed: null },
        { pushed: { domain: ""; commit: "89abcdef0123456789abcdef0123456789abcdef" } },
      ]
    >
  >;
}

/** A workspace's offer, taken (offers.ts take): the branch is under "Needs you" at its commit.
 *  Offered again without a base (a `git push`), it keeps the base it was offered for. The
 *  domain's offers of branches its lists no longer have (`listed`: each repository whose list
 *  was read, and its branches) go; past RECORD.offers, a new one is refused in words. */
export const offer = (o: Offer, listed: Record<string, string[]>) =>
  change(o.domain, (kept) => {
    for (const e of kept.entries)
      if (e.offered && listed[e.repo] && !listed[e.repo]!.includes(e.branch)) delete e.offered;
    const entry = entryOf(kept, o.repo, o.branch);
    if (!entry.offered && kept.entries.filter((e) => e.offered).length >= RECORD.offers)
      refuse(
        `the domain '${o.domain}' has ${RECORD.offers} branches offered, the most the root keeps for a domain`,
        "dismiss offers you will not push (the dashboard, or desolate offers dismiss), then offer again",
      );
    const base = o.base ?? entry.offered?.base;
    entry.offered = {
      commit: o.commit,
      workspace: o.workspace,
      lfs: o.lfs,
      at: o.at,
      ...(base ? { base } : {}),
    };
  });

declare namespace offer {
  /** offered again, the offer is replaced, and keeps the base it was offered for when the new
   *  one names none (a `git push`) */
  export type Again = Given<
    [
      Invoke<typeof emptyRoot>,
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
          listed: {},
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
          listed: {},
        ]
      >,
    ],
    Expect<
      Invoke<typeof offersOf, [domain: "acme"]>,
      "matches",
      [{ branch: "fix"; commit: "89abcdef0123456789abcdef0123456789abcdef"; base: "release" }]
    >
  >;
  /** an offer of a branch the domain's list no longer has goes when the next is taken; one
   *  of a repository whose list was not read stays */
  export type Pruned = Given<
    [
      Invoke<typeof emptyRoot>,
      Invoke<
        typeof offer,
        [
          o: {
            domain: "acme";
            repo: "acme/app";
            branch: "old";
            commit: "0123456789abcdef0123456789abcdef01234567";
            workspace: "w1";
            lfs: 0;
            at: "2026-11-16T12:00:00.000Z";
          },
          listed: {},
        ]
      >,
      Invoke<
        typeof offer,
        [
          o: {
            domain: "acme";
            repo: "acme/web";
            branch: "other";
            commit: "0123456789abcdef0123456789abcdef01234567";
            workspace: "w1";
            lfs: 0;
            at: "2026-11-16T12:00:00.000Z";
          },
          listed: {},
        ]
      >,
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
          listed: { "acme/app": ["fix"] },
        ]
      >,
    ],
    Expect<
      Invoke<typeof offersOf, [domain: "acme"]>,
      "matches",
      [{ branch: "other" }, { branch: "fix" }]
    >
  >;
  /** past RECORD.offers (three, here) a new branch is refused in words; the control: offering
   *  one of those again is taken */
  export type Capped = Given<
    [
      Mock<"../shared/limits.ts", typeof smallRecord>,
      Invoke<typeof emptyRoot>,
      Invoke<
        typeof offer,
        [
          o: {
            domain: "acme";
            repo: "acme/app";
            branch: "a";
            commit: "0123456789abcdef0123456789abcdef01234567";
            workspace: "w1";
            lfs: 0;
            at: "2026-11-16T12:00:00.000Z";
          },
          listed: {},
        ]
      >,
      Invoke<
        typeof offer,
        [
          o: {
            domain: "acme";
            repo: "acme/app";
            branch: "b";
            commit: "0123456789abcdef0123456789abcdef01234567";
            workspace: "w1";
            lfs: 0;
            at: "2026-11-16T12:00:00.000Z";
          },
          listed: {},
        ]
      >,
      Invoke<
        typeof offer,
        [
          o: {
            domain: "acme";
            repo: "acme/app";
            branch: "c";
            commit: "0123456789abcdef0123456789abcdef01234567";
            workspace: "w1";
            lfs: 0;
            at: "2026-11-16T12:00:00.000Z";
          },
          listed: {},
        ]
      >,
    ],
    [
      Expect<
        Invoke<
          typeof refusalOf,
          [
            f: typeof offer,
            args: [
              o: {
                domain: "acme";
                repo: "acme/app";
                branch: "d";
                commit: "0123456789abcdef0123456789abcdef01234567";
                workspace: "";
                lfs: 0;
                at: "2026-11-16T12:00:00.000Z";
              },
              listed: {},
            ],
          ]
        >,
        "matches",
        {
          message: "the domain 'acme' has 3 branches offered, the most the root keeps for a domain";
        }
      >,
      Given<
        Invoke<
          typeof offer,
          [
            o: {
              domain: "acme";
              repo: "acme/app";
              branch: "a";
              commit: "89abcdef0123456789abcdef0123456789abcdef";
              workspace: "w1";
              lfs: 0;
              at: "2026-11-16T12:00:00.000Z";
            },
            listed: {},
          ]
        >,
        Expect<
          Invoke<typeof offersOf, [domain: "acme"]>,
          "matches",
          [{ commit: "89abcdef0123456789abcdef0123456789abcdef" }, {}, {}]
        >
      >,
    ]
  >;
  /** a record that is not JSON, or not a record, is never taken for none and written over: it
   *  is set aside, the change is refused saying so, and the next starts the record anew */
  export type Unreadable = Given<
    [
      Invoke<typeof emptyRoot>,
      Invoke<
        typeof writeIn,
        [where: "state", name: "records/acme.json", text: '{"entries":{},"refused":[]}']
      >,
    ],
    [
      Expect<Invoke<typeof offersOf, [domain: "acme"]>, "=", []>,
      Throws<
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
            listed: {},
          ]
        >,
        "is not a record (its entries and its refusals, each a list): it was set aside as"
      >,
      Expect<Invoke<typeof recordFiles>, "=", ["acme.json.unreadable-<when>"]>,
      Given<
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
            listed: {},
          ]
        >,
        Expect<Invoke<typeof recordFiles>, "=", ["acme.json", "acme.json.unreadable-<when>"]>
      >,
    ]
  >;
  /** a domain's change writes its file alone: beta's, torn, costs beta and not acme */
  export type OwnFile = Given<
    [
      Invoke<typeof emptyRoot>,
      Invoke<typeof writeIn, [where: "state", name: "records/beta.json", text: "{"]>,
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
          listed: {},
        ]
      >,
    ],
    [
      Expect<Invoke<typeof offersOf, [domain: "acme"]>, "matches", [{ branch: "fix" }]>,
      Expect<Invoke<typeof readIn, [where: "state", name: "records/beta.json"]>, "=", "{">,
    ]
  >;
  /** another process's change is waited for RECORD.lockWaitMs (300 ms, here), then refused
   *  with who holds it; a half-made file a writer left is swept by the next change */
  export type Waits = Given<
    [
      Mock<"../shared/limits.ts", typeof smallRecord>,
      Invoke<typeof emptyRoot>,
      Invoke<
        typeof heldBy,
        [
          dir: Invoke<typeof pathIn, [where: "state", name: "records/acme.json.lock"]>,
          holder: "this process",
          since: "2026-11-24T00:00:00Z",
        ]
      >,
    ],
    Throws<
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
          listed: {},
        ]
      >,
      "the root's record of the domain 'acme' stayed locked for 0.3 s (by process"
    >
  >;
  export type Sweeps = Given<
    [
      Invoke<typeof emptyRoot>,
      Invoke<typeof writeIn, [where: "state", name: "records/acme.json.tmp-1-2", text: "{"]>,
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
          listed: {},
        ]
      >,
    ],
    Expect<Invoke<typeof recordFiles>, "=", ["acme.json"]>
  >;
  /** eight processes offering 25 branches each at once lose none: one change at a time */
  export type AtOnce = Given<
    Invoke<typeof emptyRoot>,
    Expect<Invoke<typeof changedAtOnce, [takers: 8, each: 25, locked: true]>, "=", 200>
  >;
  /** the control: the same, each reading the record and writing it back with no lock, as
   *  offers.json was written, loses some */
  export type Unlocked = Given<
    Invoke<typeof emptyRoot>,
    Expect<Invoke<typeof changedAtOnce, [takers: 8, each: 25, locked: false]>, "<", 200>
  >;
}

/** The person's "not this one", of the offer at `commit`: true when it was that offer. One the
 *  workspace made again meanwhile, at another commit, stays. */
export const withdraw = (domain: string, repo: string, branch: string, commit: string) =>
  change(domain, (kept) => {
    const entry = find(kept, repo, branch);
    if (entry?.offered?.commit !== commit) return false;
    delete entry.offered;
    return true;
  });

declare namespace withdraw {
  /** the person's "not this one" names the commit seen: the offer made again meanwhile, at
   *  another commit, stays. The control: at the commit it is now, it goes */
  export type ByCommit = Given<
    [
      Invoke<typeof emptyRoot>,
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
          listed: {},
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
          listed: {},
        ]
      >,
    ],
    [
      Expect<
        Invoke<
          typeof withdraw,
          [
            domain: "acme",
            repo: "acme/app",
            branch: "fix",
            commit: "0123456789abcdef0123456789abcdef01234567",
          ]
        >,
        "=",
        false
      >,
      Expect<
        Invoke<typeof offersOf, [domain: "acme"]>,
        "matches",
        [{ commit: "89abcdef0123456789abcdef0123456789abcdef" }]
      >,
      Expect<
        Invoke<
          typeof withdraw,
          [
            domain: "acme",
            repo: "acme/app",
            branch: "fix",
            commit: "89abcdef0123456789abcdef0123456789abcdef",
          ]
        >,
        "=",
        true
      >,
      Expect<Invoke<typeof offersOf, [domain: "acme"]>, "=", []>,
    ]
  >;
}

/** A domain is gone: its record goes with it, so a domain made again under its name starts
 *  with none. */
export const forget = (domain: string) =>
  change(domain, (kept) => {
    kept.entries = [];
    kept.refused = [];
  });

declare namespace forget {
  /** a domain removed takes its offers and refusals with it; another domain's stay */
  export type Forgets = Given<
    [
      Invoke<typeof emptyRoot>,
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
          listed: {},
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
          listed: {},
        ]
      >,
      Invoke<typeof noteRefused, [domain: "acme", repo: "acme/app", why: "x"]>,
      Invoke<typeof forget, [domain: "acme"]>,
    ],
    [
      Expect<Invoke<typeof offersOf, [domain: "acme"]>, "=", []>,
      Expect<Invoke<typeof refusedOf, [domain: "acme"]>, "=", []>,
      Expect<Invoke<typeof offersOf, [domain: "beta"]>, "matches", [{ domain: "beta" }]>,
    ]
  >;
}

type Push = {
  domain: string | null;
  repo: string;
  branch: string;
  commit: string;
  sent: string;
  fallback: string | null;
};
/** Every domain's offer of the pushed branch, and the base its pull request goes into: the
 *  offer's (at the commit pushed, else the pushing domain's), else `fallback`. */
const offeredFor = (p: Push) => {
  const offers = owners()
    .filter(Boolean)
    .flatMap(offersOf)
    .filter((o) => o.repo === p.repo && o.branch === p.branch);
  const said = (
    offers.find((o) => o.commit === p.commit) ?? offers.find((o) => o.domain === p.domain)
  )?.base;
  const base = said ?? p.fallback;
  return { offers, base: base && isBranch(base) && base !== p.branch ? base : null };
};

/** A push the remote took, recorded: `sent` (the commit, or its squash) as the push of
 *  `domain` (or of the root's own, with none), and of every domain whose offer it takes: one at
 *  `commit`, or at a commit `commit` contains (the offer, and commits after it), so a raw push
 *  and `desolate push` take the same offers. One made again meanwhile at a commit the push does
 *  not contain stays; one pushed under another name stays too (offersAt says so). */
export const recordPush = async (p: Push) => {
  const repo = parseRepo(p.repo);
  if (!repo || !isBranch(p.branch) || !isCommit(p.sent) || !isCommit(p.commit)) return;
  const { offers, base } = offeredFor(p);
  const taken: Offer[] = [];
  // (A clone the root cannot read it in is no answer: the offer is not taken.)
  const contains = async (commit: string) => {
    try {
      return (
        (await git(clonePath(repo), ["merge-base", "--is-ancestor", commit, p.commit])).code === 0
      );
    } catch {
      return false;
    }
  };
  for (const o of offers) if (o.commit === p.commit || (await contains(o.commit))) taken.push(o);
  const pushed = { commit: p.sent, base, at: new Date().toISOString() };
  const whom = new Set(taken.map((o) => o.domain));
  if (p.domain !== null || whom.size === 0) whom.add(p.domain ?? "");
  for (const owner of whom)
    await change(owner, (kept) => {
      for (const o of taken)
        if (o.domain === owner && find(kept, o.repo, o.branch)?.offered?.commit === o.commit)
          delete find(kept, o.repo, o.branch)!.offered;
      const entry = entryOf(kept, p.repo, p.branch);
      entry.pushed = pushed;
      // The newest push last: the oldest are the ones let go.
      kept.entries.push(...kept.entries.splice(kept.entries.indexOf(entry), 1));
    });
};

declare namespace recordPush {
  type Past = Invoke<typeof aBranchPastItsOffer, [repo: "acme/app"]>;
  /** a push that names no domain (a raw `git push`, the git VM) of an offered commit: every
   *  domain's offer of the branch at it goes, and the push is theirs. The control: an offer of
   *  the branch at a commit the push does not contain stays */
  export type Raw = Given<
    [
      Mock<"./layout.ts", typeof mirrorsAndClonesHere>,
      Invoke<typeof noRecords>,
      Invoke<
        typeof offer,
        [
          o: {
            domain: "acme";
            repo: "acme/app";
            branch: "fix";
            commit: Past["offered"];
            workspace: "w1";
            lfs: 0;
            at: "2026-11-16T12:00:00.000Z";
          },
          listed: {},
        ]
      >,
      Invoke<
        typeof offer,
        [
          o: {
            domain: "beta";
            repo: "acme/app";
            branch: "fix";
            commit: Past["offered"];
            workspace: "w1";
            lfs: 0;
            at: "2026-11-16T12:00:00.000Z";
          },
          listed: {},
        ]
      >,
      Past,
      Invoke<
        typeof offer,
        [
          o: {
            domain: "gamma";
            repo: "acme/app";
            branch: "fix";
            commit: Past["moved"];
            workspace: "w1";
            lfs: 0;
            at: "2026-11-16T12:00:00.000Z";
          },
          listed: {},
        ]
      >,
      Invoke<
        typeof recordPush,
        [
          p: {
            domain: null;
            repo: "acme/app";
            branch: "fix";
            commit: Past["offered"];
            sent: Past["offered"];
            fallback: "main";
          },
        ]
      >,
    ],
    [
      Expect<Invoke<typeof offersOf, [domain: "gamma"]>, "matches", [{ branch: "fix" }]>,
      Expect<Invoke<typeof offersOf, [domain: "acme"]>, "=", []>,
      Expect<Invoke<typeof offersOf, [domain: "beta"]>, "=", []>,
      Expect<
        Invoke<typeof pushes>,
        "matches",
        [{ domain: "acme"; branch: "fix" }, { domain: "beta"; branch: "fix" }]
      >,
    ]
  >;
  /** a push of the offered commit and one more (the branch moved on, and was pushed whole):
   *  the offer it contains goes, and the push is the domain's */
  export type Contains = Given<
    [
      Mock<"./layout.ts", typeof mirrorsAndClonesHere>,
      Invoke<typeof noRecords>,
      Past,
      Invoke<
        typeof offer,
        [
          o: {
            domain: "acme";
            repo: "acme/app";
            branch: "fix";
            commit: Past["offered"];
            workspace: "w1";
            lfs: 0;
            at: "2026-11-16T12:00:00.000Z";
          },
          listed: {},
        ]
      >,
      Invoke<
        typeof recordPush,
        [
          p: {
            domain: null;
            repo: "acme/app";
            branch: "fix";
            commit: Past["moved"];
            sent: Past["moved"];
            fallback: "main";
          },
        ]
      >,
    ],
    [
      Expect<Invoke<typeof offersOf, [domain: "acme"]>, "=", []>,
      Expect<
        Invoke<typeof pushes>,
        "matches",
        [{ domain: "acme"; branch: "fix"; commit: Past["moved"] }]
      >,
    ]
  >;
  /** the dashboard's push of A, approved after the workspace offered B (past A): the push is
   *  the domain's, at A, and the offer of B stays */
  export type ReOffered = Given<
    [
      Mock<"./layout.ts", typeof mirrorsAndClonesHere>,
      Invoke<typeof noRecords>,
      Past,
      Invoke<
        typeof offer,
        [
          o: {
            domain: "acme";
            repo: "acme/app";
            branch: "fix";
            commit: Past["moved"];
            workspace: "w1";
            lfs: 0;
            at: "2026-11-16T12:00:00.000Z";
          },
          listed: {},
        ]
      >,
      Invoke<
        typeof recordPush,
        [
          p: {
            domain: "acme";
            repo: "acme/app";
            branch: "fix";
            commit: Past["offered"];
            sent: Past["offered"];
            fallback: "main";
          },
        ]
      >,
    ],
    [
      Expect<Invoke<typeof offersOf, [domain: "acme"]>, "matches", [{ commit: Past["moved"] }]>,
      Expect<Invoke<typeof pushes>, "matches", [{ domain: "acme"; commit: Past["offered"] }]>,
    ]
  >;
  /** pushed after the offer was dismissed: still that domain's push, at what it sent */
  export type Dismissed = Given<
    [
      Mock<"./layout.ts", typeof mirrorsAndClonesHere>,
      Invoke<typeof noRecords>,
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
          listed: {},
        ]
      >,
      Invoke<
        typeof withdraw,
        [
          domain: "acme",
          repo: "acme/app",
          branch: "fix",
          commit: "0123456789abcdef0123456789abcdef01234567",
        ]
      >,
      Invoke<
        typeof recordPush,
        [
          p: {
            domain: "acme";
            repo: "acme/app";
            branch: "fix";
            commit: "0123456789abcdef0123456789abcdef01234567";
            sent: "89abcdef0123456789abcdef0123456789abcdef";
            fallback: "main";
          },
        ]
      >,
    ],
    Expect<
      Invoke<typeof pushes>,
      "matches",
      [
        {
          domain: "acme";
          branch: "fix";
          commit: "89abcdef0123456789abcdef0123456789abcdef";
          base: "main";
        },
      ]
    >
  >;
  /** each push of a branch replaces what was recorded of it, newest last; one no domain
   *  offered is the root's own (""); a base that is the branch itself is none; past
   *  RECORD.pushes (two, here) the oldest go; a name or commit desolate would not carry is not
   *  recorded */
  export type Records = Given<
    [
      Mock<"../shared/limits.ts", typeof smallRecord>,
      Mock<"./layout.ts", typeof mirrorsAndClonesHere>,
      Invoke<typeof noRecords>,
      Invoke<
        typeof recordPush,
        [
          p: {
            domain: null;
            repo: "acme/app";
            branch: "fix";
            commit: "0123456789abcdef0123456789abcdef01234567";
            sent: "0123456789abcdef0123456789abcdef01234567";
            fallback: "main";
          },
        ]
      >,
      Invoke<
        typeof recordPush,
        [
          p: {
            domain: null;
            repo: "acme/app";
            branch: "other";
            commit: "0123456789abcdef0123456789abcdef01234567";
            sent: "0123456789abcdef0123456789abcdef01234567";
            fallback: "other";
          },
        ]
      >,
      Invoke<
        typeof recordPush,
        [
          p: {
            domain: null;
            repo: "acme/app";
            branch: "third";
            commit: "0123456789abcdef0123456789abcdef01234567";
            sent: "0123456789abcdef0123456789abcdef01234567";
            fallback: "main";
          },
        ]
      >,
      Invoke<
        typeof recordPush,
        [
          p: {
            domain: null;
            repo: "acme/app";
            branch: "fix";
            commit: "89abcdef0123456789abcdef0123456789abcdef";
            sent: "89abcdef0123456789abcdef0123456789abcdef";
            fallback: "main";
          },
        ]
      >,
      Invoke<
        typeof recordPush,
        [
          p: {
            domain: null;
            repo: "acme/app";
            branch: "a..b";
            commit: "0123456789abcdef0123456789abcdef01234567";
            sent: "0123456789abcdef0123456789abcdef01234567";
            fallback: "main";
          },
        ]
      >,
      Invoke<
        typeof recordPush,
        [
          p: {
            domain: null;
            repo: "acme/app";
            branch: "x";
            commit: "HEAD";
            sent: "HEAD";
            fallback: "main";
          },
        ]
      >,
    ],
    Expect<
      Invoke<typeof pushes>,
      "matches",
      [
        { domain: ""; branch: "third" },
        {
          domain: "";
          branch: "fix";
          commit: "89abcdef0123456789abcdef0123456789abcdef";
          base: "main";
        },
      ]
    >
  >;
}

/** After a push the remote took: at once, the base its pull request goes into and GitHub's
 *  page for opening it (null on another forge); and the push recorded (recordPush) in
 *  `recorded`, beside the caller's fetch, so the bookkeeping never holds up what the person
 *  is told. `recorded` never fails: a push that could not be recorded is said (`warn`), with
 *  what that means. */
export const afterPush = (p: Push, warn: (line: string) => void) => {
  const { base } = offeredFor(p);
  const recorded = recordPush(p).catch((error: Error) =>
    warn(
      `desolate: pushed, but the root could not record it (${error.message}): it will not be marked when merged, and its offer stays under "Needs you" until it is dismissed`,
    ),
  );
  return { base, link: pullRequestOf({ repo: p.repo, branch: p.branch, base }), recorded };
};

declare namespace afterPush {
  /** the base and the pull request's page come at once, while another process holds the
   *  record: the bookkeeping is beside the fetch and the link, never in front of them */
  export type AtOnce = Given<
    [
      Mock<"../shared/limits.ts", typeof smallRecord>,
      Invoke<typeof emptyRoot>,
      Invoke<
        typeof writeJsonIn,
        [
          where: "state",
          name: "forge.json",
          value: {
            kind: "github";
            ssh: { user: "git"; host: "github.com"; port: 22 };
            knownHosts: "";
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
            commit: "0123456789abcdef0123456789abcdef01234567";
            workspace: "w1";
            lfs: 0;
            at: "2026-11-16T12:00:00.000Z";
            base: "release";
          },
          listed: {},
        ]
      >,
      Invoke<
        typeof heldBy,
        [
          dir: Invoke<typeof pathIn, [where: "state", name: "records/acme.json.lock"]>,
          holder: "this process",
          since: "2026-11-24T00:00:00Z",
        ]
      >,
    ],
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
      "matches",
      { base: "release"; link: "https://github.com/acme/app/compare/release...fix?expand=1" }
    >
  >;
  /** another forge, or none on record: no link */
  export type Elsewhere = Given<
    Invoke<typeof emptyRoot>,
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
      "matches",
      { base: "main"; link: null }
    >
  >;
}

/** GitHub's page for opening a pushed branch's pull request (null on another forge, with no
 *  base, or with no forge on record). */
export const pullRequestOf = (p: Pick<Pushed, "repo" | "branch" | "base">): string | null => {
  try {
    return forge().kind === "github" ? pullRequestUrl(p.repo, p.branch, p.base) : null;
  } catch {
    return null;
  }
};

/** Pushes the mirror now shows in their base (pushed.ts settle): marked landed, once. */
export const landed = async (found: Pushed[]) => {
  const at = new Date().toISOString();
  for (const owner of new Set(found.map((f) => f.domain)))
    await change(owner, (kept) => {
      for (const f of found.filter((f) => f.domain === owner)) {
        const p = find(kept, f.repo, f.branch)?.pushed;
        if (p && p.commit === f.commit && !p.landed) p.landed = at;
      }
    });
};

/** The root refused a domain's bundle of `repo`, for `why` (printable, and bounded by the
 *  caller: outbox.ts noteRefusal): the latest is kept, one for each repository. */
export const noteRefused = (domain: string, repo: string, why: string) =>
  change(domain, (kept) => {
    kept.refused = [
      ...kept.refused.filter((r) => r.repo !== repo),
      { repo, at: new Date().toISOString(), why },
    ];
  });

/** A bundle of `repo` was taken: the refusal of it there was goes. Looked for first without
 *  the lock (this is asked at every fetch), and then only that refusal is removed: one noted
 *  meanwhile, of a later bundle, stays. */
export const accept = async (domain: string, repo: string) => {
  const was = refusedOf(domain).find((r) => r.repo === repo);
  if (!was) return;
  await change(domain, (kept) => {
    kept.refused = kept.refused.filter((r) => !(r.repo === repo && r.at === was.at));
  });
};
