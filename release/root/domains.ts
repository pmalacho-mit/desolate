// Domains and their workspaces, as the root records them (sections 2, 5). The root decides
// who holds which checkout; the domain's own VMs do the git (P4).
import * as fs from "node:fs";
import * as path from "node:path";
import { EXIT, refuse } from "../shared/exit.ts";
import { printable } from "../shared/text.ts";
import { readJson, writeJson } from "../shared/json.ts";
import { isBranch, isSlug, parseRepo, repoId, workspaceVmName } from "../shared/names.ts";
import { checkoutPath } from "../shared/plan.ts";
import { refCommit } from "../shared/status.ts";
import { checkSize, projectSize } from "../shared/size.ts";
import type { ProjectSize, Size } from "../shared/size.ts";
import { parse as parseJsonc } from "../shared/jsonc.ts";
import type { Checkout, WorkspacePlan } from "../shared/plan.ts";
import { git, gitOk } from "./git.ts";
import { clonePath, domainPath, mirrorPath, ROOT } from "./layout.ts";
import { recordOf, registry } from "./repos.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type {
  Expect,
  Given,
  Invoke,
  Mock,
  Table,
  Throws,
} from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { refusalOf } from "../.harness/refusal.ts";
import type { aMirrorCommit, countingGit, gitStarts } from "../.harness/root-mirrors.ts";
import type { repeat } from "../.harness/shared-text.ts";
import type {
  aDomain,
  aRegistry,
  aWorkspace,
  emptyRoot,
  mirrorsAndClonesHere,
  namesIn,
  readJsonIn,
  writeVmIn,
} from "../.harness/root-state.ts";

/** `env`: the repository whose devcontainer.json is the domain's environment (section 4.5,
 *  way 1). Unset: the first checkout that has one. */
/** `spawnMax`: how many workspaces its workspaces may start, as the host last said (the host
 *  holds the limit that counts: host/spawn.ts). Unset: no limit. 0: none. */
export type Domain = {
  slug: string;
  title: string;
  repos: string[];
  createdAt: string;
  env?: string;
  size?: Partial<Size>;
  spawnMax?: number;
};

const file = (slug: string) => path.join(domainPath(slug), "domain.json");
const workspacesDir = (slug: string) => path.join(domainPath(slug), "workspaces");
const workspaceFile = (slug: string, name: string) =>
  path.join(workspacesDir(slug), `${name}.json`);

export const slugOf = (value: unknown, what: string): string =>
  isSlug(value)
    ? value
    : refuse(
        `'${String(value)}' is not a ${what} name`,
        `a ${what} name is a slug: lowercase letters, digits and single dashes, at most 40, starting with a letter or digit`,
        EXIT.usage,
      );

declare namespace slugOf {
  /** a name that becomes a VM label, a hostname and a path, or a refusal that says what one is */
  export type Accepts = Expect<Invoke<typeof slugOf, [value: "acme", what: "domain"]>, "=", "acme">;
  /** a name that climbs, or has capitals, is a usage error (64) with the rule as its fix */
  export type Refuses = [
    Expect<
      Invoke<typeof refusalOf, [f: typeof slugOf, args: [value: "../w1", what: "workspace"]]>,
      "=",
      {
        message: "'../w1' is not a workspace name";
        fix: "a workspace name is a slug: lowercase letters, digits and single dashes, at most 40, starting with a letter or digit";
        code: 64;
      }
    >,
    Throws<Invoke<typeof slugOf, [value: "Acme", what: "domain"]>, "'Acme' is not a domain name">,
  ];
}

export const domain = (slug: string): Domain =>
  readJson<Domain | null>(file(slug), null) ??
  refuse(`there is no domain '${slug}'`, `desolate domain create ${slug}`);

declare namespace domain {
  type Fresh = Invoke<typeof emptyRoot>;
  /** one that was never made is a refusal that says how to make it */
  export type None = Given<
    Fresh,
    Expect<
      Invoke<typeof refusalOf, [f: typeof domain, args: [slug: "acme"]]>,
      "=",
      { message: "there is no domain 'acme'"; fix: "desolate domain create acme"; code: 1 }
    >
  >;
}

export const domains = (): Domain[] => {
  try {
    return fs
      .readdirSync(ROOT.domains, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && fs.existsSync(file(entry.name)))
      .map((entry) => domain(entry.name))
      .sort((a, b) => a.slug.localeCompare(b.slug));
  } catch {
    return [];
  }
};

/** A domain's title, in characters (code points): a few words, shown in a heading of the
 *  dashboard. The person types it (the host passes it on); 200 is past any heading. */
const TITLE_MOST = 200;

export const create = (slugArg: unknown, title: unknown) => {
  const slug = slugOf(slugArg, "domain");
  // `origin` and `root` are remote names in every clone; a domain is a remote in the root's.
  if (slug === "origin" || slug === "root")
    refuse(`a domain cannot be called '${slug}'`, "choose another name");
  if (fs.existsSync(file(slug)))
    refuse(`the domain '${slug}' already exists`, `desolate domain ${slug} show`);
  // A title is shown whole (the dashboard, `desolate domains`): one too long is refused, not
  // cut where nobody sees.
  const named = typeof title === "string" ? title.trim() : "";
  if ([...named].length > TITLE_MOST)
    refuse(
      `the title is ${[...named].length} characters, over the ${TITLE_MOST} a domain's title may have`,
      "give a shorter --title",
      EXIT.usage,
    );
  for (const dir of ["repos", "outbox", "inbox", "workspaces"])
    fs.mkdirSync(path.join(domainPath(slug), dir), { recursive: true });
  const value: Domain = {
    slug,
    title: named || slug,
    repos: [],
    createdAt: new Date().toISOString(),
  };
  writeJson(file(slug), value);
  return value;
};

declare namespace create {
  type Fresh = Invoke<typeof emptyRoot>;
  /** a domain: its record, and the directories its VMs share with the root */
  export type Makes = Given<
    [Fresh, Invoke<typeof create, [slugArg: "acme", title: "  Acme's widgets  "]>],
    [
      Expect<
        Invoke<typeof domain, [slug: "acme"]>,
        "matches",
        { slug: "acme"; title: "Acme's widgets"; repos: [] }
      >,
      Expect<
        Invoke<typeof namesIn, [where: "domains", dir: "acme"]>,
        "=",
        ["domain.json", "inbox", "outbox", "repos", "workspaces"]
      >,
    ]
  >;
  /** a title too long to show is refused, with the bound, and no domain is made; one at the
   *  bound is kept whole (the control) */
  export type LongTitle = Given<
    Fresh,
    [
      Expect<
        Invoke<
          typeof refusalOf,
          [
            f: typeof create,
            args: [slugArg: "acme", title: Invoke<typeof repeat, [text: "é", count: 201]>],
          ]
        >,
        "=",
        {
          message: "the title is 201 characters, over the 200 a domain's title may have";
          fix: "give a shorter --title";
          code: 64;
        }
      >,
      Expect<Invoke<typeof namesIn, [where: "domains", dir: "."]>, "=", []>,
      Expect<
        Invoke<
          typeof create,
          [slugArg: "acme", title: Invoke<typeof repeat, [text: "é", count: 200]>]
        >,
        "matches",
        { title: Invoke<typeof repeat, [text: "é", count: 200]> }
      >,
    ]
  >;
  /** no title: the slug is its title */
  export type Untitled = Given<
    Fresh,
    Expect<Invoke<typeof create, [slugArg: "acme", title: undefined]>, "matches", { title: "acme" }>
  >;
  /** `origin` and `root` are remotes in every clone already, and a domain is one too */
  export type Reserved = Given<
    Fresh,
    [
      Throws<
        Invoke<typeof create, [slugArg: "origin", title: undefined]>,
        "a domain cannot be called 'origin'"
      >,
      Throws<
        Invoke<typeof create, [slugArg: "root", title: undefined]>,
        "a domain cannot be called 'root'"
      >,
    ]
  >;
  /** made once: a second is refused, the first left as it was */
  export type Exists = Given<
    [Fresh, Invoke<typeof create, [slugArg: "acme", title: "first"]>],
    [
      Expect<
        Invoke<typeof refusalOf, [f: typeof create, args: [slugArg: "acme", title: "second"]]>,
        "=",
        { message: "the domain 'acme' already exists"; fix: "desolate domain acme show"; code: 1 }
      >,
      Expect<Invoke<typeof domain, [slug: "acme"]>, "matches", { title: "first" }>,
    ]
  >;
}

/** `desolate domain <d> env [--from <owner/repo>]`: which repository's spec this domain's
 *  workspaces are built from. Written here, by the root, outside every repository. */
/** The size this domain's new workspaces get (shared/size.ts): set, cleared (null), or
 *  only read. Existing workspaces keep what they were made with. */
export const setSize = (slugArg: unknown, sizeArg: unknown) => {
  const d = domain(slugOf(slugArg, "domain"));
  if (sizeArg === null) {
    delete d.size;
    writeJson(file(d.slug), d);
  } else if (sizeArg !== undefined) {
    const given = sizeArg as Partial<Size>;
    const size: Partial<Size> = {};
    for (const key of ["cpus", "memoryMiB", "diskGiB"] as const)
      if (given[key] !== undefined) size[key] = Number(given[key]);
    const why = checkSize(size);
    if (why)
      refuse(
        why,
        `desolate domain ${d.slug} size --cpus <n> --memory <8g> --disk <60g>`,
        EXIT.usage,
      );
    d.size = { ...d.size, ...size };
    writeJson(file(d.slug), d);
  }
  return { domain: d.slug, size: d.size ?? null };
};

declare namespace setSize {
  type Fresh = Invoke<typeof emptyRoot>;
  type Acme = Invoke<typeof aDomain, [slug: "acme", repos: ["acme/app"]]>;
  /** set part by part, each part kept until it is set again; cleared with null; only read without one */
  export type Parts = Given<
    [Fresh, Acme],
    [
      Expect<
        Invoke<typeof setSize, [slugArg: "acme", sizeArg: { cpus: 4 }]>,
        "=",
        { domain: "acme"; size: { cpus: 4 } }
      >,
      Expect<
        Invoke<typeof setSize, [slugArg: "acme", sizeArg: { memoryMiB: 8192 }]>,
        "=",
        { domain: "acme"; size: { cpus: 4; memoryMiB: 8192 } }
      >,
      Expect<
        Invoke<typeof setSize, [slugArg: "acme", sizeArg: undefined]>,
        "=",
        { domain: "acme"; size: { cpus: 4; memoryMiB: 8192 } }
      >,
      Expect<
        Invoke<typeof setSize, [slugArg: "acme", sizeArg: null]>,
        "=",
        { domain: "acme"; size: null }
      >,
    ]
  >;
  /** a size desolate does not make is refused, and what was set is kept */
  export type OutOfRange = Given<
    [Fresh, Acme, Invoke<typeof setSize, [slugArg: "acme", sizeArg: { cpus: 4 }]>],
    [
      Expect<
        Invoke<
          typeof refusalOf,
          [f: typeof setSize, args: [slugArg: "acme", sizeArg: { cpus: 0 }]]
        >,
        "=",
        {
          message: "CPUs must be from 1 to 64";
          fix: "desolate domain acme size --cpus <n> --memory <8g> --disk <60g>";
          code: 64;
        }
      >,
      Expect<Invoke<typeof domain, [slug: "acme"]>, "matches", { size: { cpus: 4 } }>,
    ]
  >;
}

/** The most workspaces a domain's own may start (`spawn --max`): a check on a typo, not a
 *  resource (each workspace is a VM, and the Mac runs out of memory long before this). */
const SPAWN_MOST = 1000;

export const setSpawn = (slugArg: unknown, maxArg: unknown) => {
  const d = domain(slugOf(slugArg, "domain"));
  // null (or absent): no limit, the default. 0: its workspaces start none.
  const max = maxArg === null || maxArg === undefined ? null : Number(maxArg);
  if (max !== null && (!Number.isInteger(max) || max < 0 || max > SPAWN_MOST))
    refuse(
      `'${printable(maxArg, 40)}' is not a number of workspaces: a whole number from 0 to ${SPAWN_MOST}`,
      `desolate domain ${d.slug} spawn --max 2`,
      EXIT.usage,
    );
  if (max === null) delete d.spawnMax;
  else d.spawnMax = max;
  writeJson(file(d.slug), d);
  return { domain: d.slug, max };
};

declare namespace setSpawn {
  type Fresh = Invoke<typeof emptyRoot>;
  type Acme = Invoke<typeof aDomain, [slug: "acme", repos: ["acme/app"]]>;
  /** how many workspaces its workspaces may start: a number, none (0), or no limit (null) */
  export type Limits = Given<
    [Fresh, Acme],
    [
      Expect<
        Invoke<typeof setSpawn, [slugArg: "acme", maxArg: 2]>,
        "=",
        { domain: "acme"; max: 2 }
      >,
      Expect<
        Invoke<typeof setSpawn, [slugArg: "acme", maxArg: 0]>,
        "=",
        { domain: "acme"; max: 0 }
      >,
      Expect<Invoke<typeof domain, [slug: "acme"]>, "matches", { spawnMax: 0 }>,
      Expect<
        Invoke<typeof setSpawn, [slugArg: "acme", maxArg: null]>,
        "=",
        { domain: "acme"; max: null }
      >,
    ]
  >;
  /** and nothing that is not a whole number of workspaces */
  export type Refuses = Given<
    [Fresh, Acme],
    [
      Expect<
        Invoke<typeof refusalOf, [f: typeof setSpawn, args: [slugArg: "acme", maxArg: -1]]>,
        "=",
        {
          message: "'-1' is not a number of workspaces: a whole number from 0 to 1000";
          fix: "desolate domain acme spawn --max 2";
          code: 64;
        }
      >,
      Throws<
        Invoke<typeof setSpawn, [slugArg: "acme", maxArg: 1.5]>,
        "'1.5' is not a number of workspaces"
      >,
      Throws<
        Invoke<typeof setSpawn, [slugArg: "acme", maxArg: "lots"]>,
        "'lots' is not a number of workspaces"
      >,
      /** past the range, said with the range; the end of it is in it (the control) */
      Throws<
        Invoke<typeof setSpawn, [slugArg: "acme", maxArg: 1001]>,
        "'1001' is not a number of workspaces: a whole number from 0 to 1000"
      >,
      Expect<
        Invoke<typeof setSpawn, [slugArg: "acme", maxArg: 1000]>,
        "=",
        { domain: "acme"; max: 1000 }
      >,
    ]
  >;
}

export const setEnv = (slugArg: unknown, repoArg: unknown) => {
  const d = domain(slugOf(slugArg, "domain"));
  if (repoArg !== undefined) {
    const repo =
      parseRepo(repoArg) ??
      refuse(`'${String(repoArg)}' is not a repository`, "name it as <owner>/<repo>", EXIT.usage);
    if (!d.repos.includes(repoId(repo)))
      refuse(
        `${repoId(repo)} is not in the domain ${d.slug}`,
        `desolate domain ${d.slug} add --repo ${repoId(repo)}`,
      );
    d.env = repoId(repo);
    writeJson(file(d.slug), d);
  }
  return { domain: d.slug, env: d.env ?? null, repos: d.repos };
};

declare namespace setEnv {
  type Fresh = Invoke<typeof emptyRoot>;
  type Acme = Invoke<typeof aDomain, [slug: "acme", repos: ["acme/api", "acme/web"]]>;
  /** the repository whose devcontainer is the domain's environment: one of its own */
  export type Sets = Given<
    [Fresh, Acme],
    [
      Expect<
        Invoke<typeof setEnv, [slugArg: "acme", repoArg: undefined]>,
        "=",
        { domain: "acme"; env: null; repos: ["acme/api", "acme/web"] }
      >,
      Expect<
        Invoke<typeof setEnv, [slugArg: "acme", repoArg: "acme/web"]>,
        "matches",
        { env: "acme/web" }
      >,
    ]
  >;
  /** another domain's repository is not this one's environment: the fix adds it */
  export type NotItsOwn = Given<
    [Fresh, Acme],
    Expect<
      Invoke<typeof refusalOf, [f: typeof setEnv, args: [slugArg: "acme", repoArg: "other/web"]]>,
      "=",
      {
        message: "other/web is not in the domain acme";
        fix: "desolate domain acme add --repo other/web";
        code: 1;
      }
    >
  >;
}

export const addRepo = async (slugArg: unknown, repoArg: unknown) => {
  const d = domain(slugOf(slugArg, "domain"));
  const repo =
    parseRepo(repoArg) ??
    refuse(`'${String(repoArg)}' is not a repository`, "name it as <owner>/<repo>", EXIT.usage);
  recordOf(repo);
  const id = repoId(repo);
  const added = !d.repos.includes(id);
  if (added) {
    d.repos = [...d.repos, id].sort();
    writeJson(file(d.slug), d);
  }
  // In the root clone, the domain is a remote (section 6.5), through desolate's helper.
  const clone = clonePath(repo);
  const have = await git(clone, ["remote", "get-url", d.slug]);
  if (have.code !== 0) await gitOk(clone, ["remote", "add", d.slug, `desolate::${d.slug}`]);
  const running = workspaces(d.slug).length;
  return {
    domain: d.slug,
    repo: id,
    added,
    note:
      added && running > 0
        ? `${running} existing workspace(s) of ${d.slug} were made before this and do not see it: \`desolate rm\` and \`desolate up\` them to pick it up`
        : "",
  };
};

export type Workspace = WorkspacePlan & { state: "planned" | "up" | "stopped" };

export const workspaces = (slug: string): Workspace[] => {
  try {
    return fs
      .readdirSync(workspacesDir(slug))
      .filter((name) => name.endsWith(".json"))
      .map((name) => readJson<Workspace | null>(path.join(workspacesDir(slug), name), null))
      .filter((value): value is Workspace => value !== null)
      .sort((a, b) => a.workspace.localeCompare(b.workspace));
  } catch {
    return [];
  }
};

export const workspace = (slug: string, name: string): Workspace =>
  readJson<Workspace | null>(workspaceFile(slug, name), null) ??
  refuse(`there is no workspace '${slug}/${name}'`, `desolate list ${slug}`);

type Wanted = { repo: string; kind: "main" | "worktree"; branch?: string };

/** Decide what a new workspace is: its checkouts, and that nobody else holds them. One
 *  workspace holds a given checkout at a time, the main checkout included (section 5.2). */
/** A git identity as the host read it: printable, short, or none. */
const authorOf = (value: unknown): { name: string; email: string } | undefined => {
  const v = value as { name?: unknown; email?: unknown } | null;
  const clean = (x: unknown) =>
    typeof x === "string"
      ? x
          .replace(/[\x00-\x1f\x7f]/g, "")
          .trim()
          .slice(0, 200)
      : "";
  const name = clean(v?.name),
    email = clean(v?.email);
  return name && /^[^\s@]+@[^\s@]+$/.test(email) ? { name, email } : undefined;
};

declare namespace authorOf {
  /** a git identity as the host read it: printable, short, with an address; or none */
  export type Identities = Table<
    typeof authorOf,
    [
      [
        args: [value: { name: " Ada Lovelace "; email: "ada@example.com" }],
        expected: { name: "Ada Lovelace"; email: "ada@example.com" },
      ],
      [
        args: [value: { name: "Ada\u001b[2J"; email: "ada@example.com" }],
        expected: { name: "Ada[2J"; email: "ada@example.com" },
      ],
      [args: [value: { name: "Ada"; email: "not an address" }], expected: undefined],
      [args: [value: { name: ""; email: "ada@example.com" }], expected: undefined],
      [args: [value: null], expected: undefined],
    ]
  >;
}

export const plan = (args: {
  instance: string;
  domain: unknown;
  name: unknown;
  checkouts: unknown;
  base: unknown;
  fetch: unknown;
  size?: unknown;
  author?: unknown;
  startedBy?: unknown;
  env?: unknown;
}): Workspace => {
  const d = domain(slugOf(args.domain, "domain"));
  if (d.repos.length === 0)
    refuse(
      `the domain '${d.slug}' has no repositories yet`,
      `desolate domain ${d.slug} add --repo <owner>/<repo>`,
    );
  const existing = workspaces(d.slug);
  let name = args.name;
  if (name === undefined || name === null || name === "") {
    for (let n = 1; ; n++)
      if (!existing.some((w) => w.workspace === `w${n}`)) {
        name = `w${n}`;
        break;
      }
  }
  const workspaceName = slugOf(name, "workspace");
  if (existing.some((w) => w.workspace === workspaceName))
    refuse(
      `the workspace '${d.slug}/${workspaceName}' already exists`,
      `desolate up ${d.slug} --name <another>, or desolate rm ${d.slug}/${workspaceName}`,
    );

  const wanted = new Map<string, Wanted>();
  for (const raw of Array.isArray(args.checkouts) ? args.checkouts : []) {
    // <owner/repo>=main | <owner/repo>=worktree:<branch>
    const match = /^([^=]+)=(main|worktree:(.+))$/.exec(String(raw));
    if (!match)
      refuse(
        `--checkout '${String(raw)}' is not understood`,
        "use --checkout <owner>/<repo>=main or --checkout <owner>/<repo>=worktree:<branch>",
        EXIT.usage,
      );
    const repo = match![1]!;
    if (!d.repos.includes(repo))
      refuse(
        `${repo} is not in the domain '${d.slug}'`,
        `desolate domain ${d.slug} add --repo ${repo}`,
      );
    if (match![3] !== undefined && !isBranch(match![3]))
      refuse(
        `'${match![3]}' is not a branch name desolate will carry`,
        "letters, digits, '.', '_', '-' and '/', not starting with a dash",
      );
    wanted.set(
      repo,
      match![3] !== undefined
        ? { repo, kind: "worktree", branch: match![3] }
        : { repo, kind: "main" },
    );
  }
  const baseArg = args.base === undefined || args.base === null ? null : String(args.base);
  if (baseArg !== null && !isBranch(baseArg))
    refuse(
      `--base '${baseArg}' is not a branch`,
      "use a local branch (main) or a remote-tracking one (origin/main)",
      EXIT.usage,
    );

  const held = (repo: string, kind: "main" | "worktree", worktree: string) =>
    existing.find((w) =>
      w.checkouts.some(
        (c) => c.repo === repo && c.kind === kind && (kind === "main" || c.name === worktree),
      ),
    );
  const checkouts: Checkout[] = d.repos.flatMap((repo): Checkout[] => {
    const want = wanted.get(repo);
    const defaultBranch = registry().repos[repo]?.defaultBranch ?? "main";
    // The domain clone's own branch: what its main checkout holds, unpushed work included.
    // (When that is only behind the remote's, the worktree starts from the remote's: init.ts.)
    const base = baseArg ?? defaultBranch;
    const worktree = (branch: string): Checkout => {
      const dir = branch.replace(/\//g, "-");
      const holder = held(repo, "worktree", dir);
      if (holder)
        refuse(
          `the worktree '${dir}' of ${repo} is held by the workspace '${d.slug}/${holder.workspace}'`,
          `use another branch, or desolate rm ${d.slug}/${holder.workspace}`,
          EXIT.busy,
        );
      return {
        repo,
        kind: "worktree",
        name: dir,
        branch,
        base,
        path: checkoutPath(repo, "worktree", dir),
      };
    };
    if (want?.kind === "worktree") return [worktree(want.branch!)];
    const holder = held(repo, "main", "");
    if (want?.kind === "main") {
      if (holder)
        refuse(
          `the main checkout of ${repo} is held by the workspace '${d.slug}/${holder.workspace}'. Two editors and two agents in one working tree is a corruption, not a feature`,
          `take a worktree instead: --checkout ${repo}=worktree:<branch>`,
          EXIT.busy,
        );
      return [
        {
          repo,
          kind: "main",
          name: "",
          branch: defaultBranch,
          base: defaultBranch,
          path: checkoutPath(repo, "main", ""),
        },
      ];
    }
    // Not named: the main checkout if it is free. Else, when nothing was named, a fresh worktree
    // named for the workspace; when the person named others, none: a worktree there made an
    // empty branch in every repository the work was not about (dogfooding: spawn and the
    // issues recipe left one in each).
    if (!holder)
      return [
        {
          repo,
          kind: "main",
          name: "",
          branch: defaultBranch,
          base: defaultBranch,
          path: checkoutPath(repo, "main", ""),
        },
      ];
    return wanted.size > 0 ? [] : [worktree(workspaceName)];
  });

  // The size the host worked out (flags, this domain's, the stack's defaults), checked here too.
  const size = args.size as Size | undefined;
  if (
    size !== undefined &&
    (checkSize(size) || [size.cpus, size.memoryMiB, size.diskGiB].some((v) => v === undefined))
  )
    refuse(
      `the size is not one desolate makes: ${checkSize(size) ?? "a part is missing"}`,
      "desolate up <domain> --cpus <n> --memory <8g> --disk <60g>",
      EXIT.usage,
    );
  // Who asked for it (`desolate spawn` in another workspace of the domain): a label, as the
  // host says, in its shape only. (A parent removed and remade keeps a new createdAt.)
  const by = args.startedBy as { workspace?: unknown; createdAt?: unknown } | undefined;
  const startedBy =
    by &&
    isSlug(by.workspace) &&
    typeof by.createdAt === "string" &&
    /^\d{4}-\d\d-\d\dT[\d:.]{8,12}Z$/.test(by.createdAt)
      ? { workspace: by.workspace, createdAt: by.createdAt }
      : undefined;
  // Its environment: the host's word (the first checkout the person named with --checkout,
  // or the one a template is built for), else the domain's; devcontainer.ts falls back to the
  // first checkout that has a spec.
  const envRepo =
    (typeof args.env === "string" && d.repos.includes(args.env) ? args.env : undefined) ?? d.env;
  // VM names are a hash of the domain and the workspace's name: one already some domain's
  // (another domain could have searched for a colliding name: audit, 2026-11-16) is refused.
  const vm = workspaceVmName(args.instance, d.slug, workspaceName);
  for (const other of domains())
    if (workspaces(other.slug).some((w) => w.vm === vm))
      refuse(
        `the VM name ${vm} is already ${other.slug}'s`,
        `desolate up ${d.slug} --name <another name>`,
        EXIT.busy,
      );
  const value: Workspace = {
    ...(envRepo ? { env: envRepo } : {}),
    repos: [...d.repos],
    ...(startedBy ? { startedBy } : {}),
    ...(size
      ? { size: { cpus: size.cpus, memoryMiB: size.memoryMiB, diskGiB: size.diskGiB } }
      : {}),
    ...(authorOf(args.author) ? { author: authorOf(args.author)! } : {}),
    domain: d.slug,
    workspace: workspaceName,
    vm,
    title: d.title,
    checkouts,
    fetch: args.fetch === true,
    createdAt: new Date().toISOString(),
    state: "planned",
  };
  writeJson(workspaceFile(d.slug, workspaceName), value);
  // The plan the workspace's own init reads: in the inbox, which the domain cannot write.
  writeJson(path.join(domainPath(d.slug), "inbox", "workspaces", `${workspaceName}.json`), value);
  return value;
};

declare namespace plan {
  type Fresh = Invoke<typeof emptyRoot>;
  type Acme = Invoke<typeof aDomain, [slug: "acme", repos: ["acme/app"]]>;
  /** the first workspace: named w1, with the main checkout on the default branch; the plan
   *  is kept, and put where the workspace's own init reads it */
  export type First = Given<
    [Fresh, Acme],
    [
      Expect<
        Invoke<
          typeof plan,
          [
            args: {
              instance: "t";
              domain: "acme";
              name: undefined;
              checkouts: [];
              base: undefined;
              fetch: false;
            },
          ]
        >,
        "matches",
        {
          domain: "acme";
          workspace: "w1";
          vm: "dsl-t-ddb30a57cc";
          state: "planned";
          fetch: false;
          checkouts: [
            {
              repo: "acme/app";
              kind: "main";
              name: "";
              branch: "main";
              base: "main";
              path: "/workspaces/acme/app";
            },
          ];
        }
      >,
      Expect<
        Invoke<typeof readJsonIn, [where: "domains", name: "acme/inbox/workspaces/w1.json"]>,
        "matches",
        { workspace: "w1" }
      >,
    ]
  >;
  /** the main checkout is held by w1: the next gets a worktree of its own, named for it */
  export type Second = Given<
    [
      Fresh,
      Acme,
      Invoke<
        typeof plan,
        [
          args: {
            instance: "t";
            domain: "acme";
            name: undefined;
            checkouts: [];
            base: undefined;
            fetch: false;
          },
        ]
      >,
    ],
    Expect<
      Invoke<
        typeof plan,
        [
          args: {
            instance: "t";
            domain: "acme";
            name: undefined;
            checkouts: [];
            base: undefined;
            fetch: false;
          },
        ]
      >,
      "matches",
      {
        workspace: "w2";
        checkouts: [
          {
            kind: "worktree";
            name: "w2";
            branch: "w2";
            base: "main";
            path: "/workspaces/acme/app/.worktrees/w2";
          },
        ];
      }
    >
  >;
  /** a branch named for the worktree, from the base asked for: its directory has no slashes */
  export type Worktree = Given<
    [Fresh, Acme],
    Expect<
      Invoke<
        typeof plan,
        [
          args: {
            instance: "t";
            domain: "acme";
            name: "issue-12";
            checkouts: ["acme/app=worktree:task/web"];
            base: "origin/main";
            fetch: true;
          },
        ]
      >,
      "matches",
      {
        workspace: "issue-12";
        fetch: true;
        checkouts: [
          { kind: "worktree"; name: "task-web"; branch: "task/web"; base: "origin/main" },
        ];
      }
    >
  >;
  /** one working tree, one workspace: the main checkout or a worktree another holds is refused,
   *  and says which workspace holds it */
  export type Held = Given<
    [
      Fresh,
      Acme,
      Invoke<typeof aWorkspace, [domain: "acme", name: "w1", checkouts: ["acme/app=main"]]>,
      Invoke<
        typeof aWorkspace,
        [domain: "acme", name: "w2", checkouts: ["acme/app=worktree:task-web"]]
      >,
    ],
    [
      Expect<
        Invoke<
          typeof refusalOf,
          [
            f: typeof plan,
            args: [
              args: {
                instance: "t";
                domain: "acme";
                name: "w3";
                checkouts: ["acme/app=main"];
                base: undefined;
                fetch: false;
              },
            ],
          ]
        >,
        "=",
        {
          message: "the main checkout of acme/app is held by the workspace 'acme/w1'. Two editors and two agents in one working tree is a corruption, not a feature";
          fix: "take a worktree instead: --checkout acme/app=worktree:<branch>";
          code: 75;
        }
      >,
      Expect<
        Invoke<
          typeof refusalOf,
          [
            f: typeof plan,
            args: [
              args: {
                instance: "t";
                domain: "acme";
                name: "w3";
                checkouts: ["acme/app=worktree:task/web"];
                base: undefined;
                fetch: false;
              },
            ],
          ]
        >,
        "=",
        {
          message: "the worktree 'task-web' of acme/app is held by the workspace 'acme/w2'";
          fix: "use another branch, or desolate rm acme/w2";
          code: 75;
        }
      >,
    ]
  >;
  /** what was not named gets its main checkout if free, and nothing otherwise: no empty
   *  branch in a repository the work is not about */
  export type OnlyNamed = Given<
    [
      Fresh,
      Invoke<typeof aDomain, [slug: "acme", repos: ["acme/api", "acme/web"]]>,
      Invoke<
        typeof aWorkspace,
        [domain: "acme", name: "w1", checkouts: ["acme/api=main", "acme/web=main"]]
      >,
    ],
    Expect<
      Invoke<
        typeof plan,
        [
          args: {
            instance: "t";
            domain: "acme";
            name: "w2";
            checkouts: ["acme/web=worktree:fix"];
            base: undefined;
            fetch: false;
          },
        ]
      >,
      "matches",
      {
        checkouts: [{ repo: "acme/web"; kind: "worktree"; branch: "fix" }];
      }
    >
  >;
  /** what the person typed is checked before anything is planned */
  export type Refuses = Given<
    [Fresh, Acme],
    [
      Expect<
        Invoke<
          typeof refusalOf,
          [
            f: typeof plan,
            args: [
              args: {
                instance: "t";
                domain: "acme";
                name: "w1";
                checkouts: ["acme/app"];
                base: undefined;
                fetch: false;
              },
            ],
          ]
        >,
        "=",
        {
          message: "--checkout 'acme/app' is not understood";
          fix: "use --checkout <owner>/<repo>=main or --checkout <owner>/<repo>=worktree:<branch>";
          code: 64;
        }
      >,
      Throws<
        Invoke<
          typeof plan,
          [
            args: {
              instance: "t";
              domain: "acme";
              name: "w1";
              checkouts: ["other/app=main"];
              base: undefined;
              fetch: false;
            },
          ]
        >,
        "other/app is not in the domain 'acme'"
      >,
      Throws<
        Invoke<
          typeof plan,
          [
            args: {
              instance: "t";
              domain: "acme";
              name: "w1";
              checkouts: ["acme/app=worktree:--upload-pack=x"];
              base: undefined;
              fetch: false;
            },
          ]
        >,
        "'--upload-pack=x' is not a branch name desolate will carry"
      >,
      Throws<
        Invoke<
          typeof plan,
          [
            args: {
              instance: "t";
              domain: "acme";
              name: "w1";
              checkouts: [];
              base: "--orphan";
              fetch: false;
            },
          ]
        >,
        "--base '--orphan' is not a branch"
      >,
      Throws<
        Invoke<
          typeof plan,
          [
            args: {
              instance: "t";
              domain: "acme";
              name: "W 1";
              checkouts: [];
              base: undefined;
              fetch: false;
            },
          ]
        >,
        "'W 1' is not a workspace name"
      >,
      Throws<
        Invoke<
          typeof plan,
          [
            args: {
              instance: "t";
              domain: "acme";
              name: "w1";
              checkouts: [];
              base: undefined;
              fetch: false;
              size: { cpus: 2; memoryMiB: 512; diskGiB: 30 };
            },
          ]
        >,
        "the size is not one desolate makes: memory must be from 1 GiB to 256 GiB"
      >,
      Throws<
        Invoke<
          typeof plan,
          [
            args: {
              instance: "t";
              domain: "acme";
              name: "w1";
              checkouts: [];
              base: undefined;
              fetch: false;
              size: { cpus: 2 };
            },
          ]
        >,
        "the size is not one desolate makes: a part is missing"
      >,
      Expect<Invoke<typeof namesIn, [where: "domains", dir: "acme/workspaces"]>, "=", []>,
    ]
  >;
  /** a name already taken, and a domain with nothing to check out */
  export type Taken = Given<
    [
      Fresh,
      Acme,
      Invoke<typeof aWorkspace, [domain: "acme", name: "w1", checkouts: ["acme/app=main"]]>,
      Invoke<typeof aDomain, [slug: "empty", repos: []]>,
    ],
    [
      Expect<
        Invoke<
          typeof refusalOf,
          [
            f: typeof plan,
            args: [
              args: {
                instance: "t";
                domain: "acme";
                name: "w1";
                checkouts: [];
                base: undefined;
                fetch: false;
              },
            ],
          ]
        >,
        "=",
        {
          message: "the workspace 'acme/w1' already exists";
          fix: "desolate up acme --name <another>, or desolate rm acme/w1";
          code: 1;
        }
      >,
      Expect<
        Invoke<
          typeof refusalOf,
          [
            f: typeof plan,
            args: [
              args: {
                instance: "t";
                domain: "empty";
                name: "w1";
                checkouts: [];
                base: undefined;
                fetch: false;
              },
            ],
          ]
        >,
        "=",
        {
          message: "the domain 'empty' has no repositories yet";
          fix: "desolate domain empty add --repo <owner>/<repo>";
          code: 1;
        }
      >,
    ]
  >;
  /** a VM name is a hash of the domain and the workspace: one already another domain's is
   *  refused, never shared */
  export type VmTaken = Given<
    [
      Fresh,
      Acme,
      Invoke<typeof aDomain, [slug: "other", repos: []]>,
      Invoke<typeof writeVmIn, [domain: "other", workspace: "x", vm: "dsl-t-ddb30a57cc"]>,
    ],
    Expect<
      Invoke<
        typeof refusalOf,
        [
          f: typeof plan,
          args: [
            args: {
              instance: "t";
              domain: "acme";
              name: "w1";
              checkouts: [];
              base: undefined;
              fetch: false;
            },
          ],
        ]
      >,
      "=",
      {
        message: "the VM name dsl-t-ddb30a57cc is already other's";
        fix: "desolate up acme --name <another name>";
        code: 75;
      }
    >
  >;
  /** who started it, kept only in the shape the host gives it; a size, and a git identity */
  export type Labels = Given<
    [Fresh, Acme],
    [
      Expect<
        Invoke<
          typeof plan,
          [
            args: {
              instance: "t";
              domain: "acme";
              name: "w1";
              checkouts: [];
              base: undefined;
              fetch: false;
              startedBy: { workspace: "lead"; createdAt: "2026-11-16T12:00:00.000Z" };
              size: { cpus: 2; memoryMiB: 4096; diskGiB: 30 };
              author: { name: "Ada"; email: "ada@example.com" };
            },
          ]
        >,
        "matches",
        {
          startedBy: { workspace: "lead"; createdAt: "2026-11-16T12:00:00.000Z" };
          size: { cpus: 2; memoryMiB: 4096; diskGiB: 30 };
          author: { name: "Ada"; email: "ada@example.com" };
        }
      >,
      Expect<
        Invoke<
          typeof plan,
          [
            args: {
              instance: "t";
              domain: "acme";
              name: "w2";
              checkouts: [];
              base: undefined;
              fetch: false;
              startedBy: { workspace: "../lead"; createdAt: "yesterday" };
            },
          ]
        >["startedBy"],
        "=",
        undefined
      >,
    ]
  >;
}

/** A workspace's size, changed (`desolate resize`, once the host has resized its stopped VM):
 *  in its record, so a VM made again for it (`start` after its VM is gone) is made this size,
 *  and in the copy its VM reads. */
export const setWorkspaceSize = (slug: string, name: string, sizeArg: unknown) => {
  const w = workspace(slug, name);
  const given = (typeof sizeArg === "object" && sizeArg !== null ? sizeArg : {}) as Record<
    string,
    unknown
  >;
  const size: Size = {
    cpus: Number(given.cpus),
    memoryMiB: Number(given.memoryMiB),
    diskGiB: Number(given.diskGiB),
  };
  const why =
    (Object.values(size).some((v) => Number.isNaN(v))
      ? "a size has CPUs, memory and disk"
      : null) ?? checkSize(size);
  if (why)
    refuse(
      why,
      `desolate resize ${slug}/${name} --cpus <n> --memory <16g> --disk <60g>`,
      EXIT.usage,
    );
  writeJson(workspaceFile(slug, name), { ...w, size });
  const copy = path.join(domainPath(slug), "inbox", "workspaces", `${name}.json`);
  const read = readJson<Record<string, unknown> | null>(copy, null);
  if (read) writeJson(copy, { ...read, size });
  return { ...w, size };
};

export const setState = (slug: string, name: string, state: Workspace["state"]) => {
  const w = workspace(slug, name);
  writeJson(workspaceFile(slug, name), { ...w, state });
};

export const removeWorkspace = (slug: string, name: string) => {
  const w = workspace(slug, name);
  fs.rmSync(workspaceFile(slug, name), { force: true });
  fs.rmSync(path.join(domainPath(slug), "inbox", "workspaces", `${name}.json`), { force: true });
  return w;
};

/** Remove a domain: its clones and caches, never the root's (section 8). */
export const remove = async (slugArg: unknown) => {
  const d = domain(slugOf(slugArg, "domain"));
  const left = workspaces(d.slug);
  if (left.length > 0)
    refuse(
      `the domain '${d.slug}' still has ${left.length} workspace(s): ${left.map((w) => w.workspace).join(", ")}`,
      left.map((w) => `desolate rm ${d.slug}/${w.workspace}`).join(" && "),
      EXIT.busy,
    );
  for (const id of d.repos) {
    const repo = parseRepo(id);
    if (repo && fs.existsSync(clonePath(repo)))
      await git(clonePath(repo), ["remote", "remove", d.slug]);
  }
  fs.rmSync(domainPath(d.slug), { recursive: true, force: true });
  return {
    domain: d.slug,
    kept: "the root clones keep this domain's branches for as long as they are wanted",
  };
};

/** What the domain's environment asks for (shared/size.ts projectSize): its devcontainer.json
 *  as the remote published it, read in the MIRROR (P4), as data. Remembered by the blob's id,
 *  so asking again while the branch has not moved starts no git. null: no repository of the
 *  domain has a spec, or its spec is a folder with no devcontainer.json at its top. */
export type ProjectAsk = ProjectSize & { repo: string; path: string };
const asked = new Map<string, ProjectSize>();
const SPEC_MAX = 256 * 1024;
export const projectSizeOf = async (
  slugArg: unknown,
  preferred?: unknown,
): Promise<ProjectAsk | null> => {
  const env = await envKey(slugArg, preferred);
  if (!env) return null;
  const repo = parseRepo(env.repo)!;
  const file =
    env.spec === ".devcontainer" ? ".devcontainer/devcontainer.json" : ".devcontainer.json";
  // (`.devcontainer.json` is the spec itself: envKey's id is its blob.)
  const blob = env.spec === ".devcontainer" ? await objectOnDefault(env.repo, file) : env.id;
  if (!blob) return null;
  let known = asked.get(blob);
  if (!known) {
    const bytes = Number((await git(mirrorPath(repo), ["cat-file", "-s", blob])).stdout.trim());
    if (!(bytes <= SPEC_MAX)) known = { size: {}, problems: [`${file} is over 256 KiB: not read`] };
    else {
      const text = await git(mirrorPath(repo), ["cat-file", "blob", blob]);
      try {
        known = projectSize(parseJsonc(text.stdout));
      } catch {
        known = { size: {}, problems: [`${file} is not JSON (with comments) that desolate reads`] };
      }
    }
    asked.set(blob, known);
  }
  return { repo: env.repo, path: file, ...known };
};

declare namespace projectSizeOf {
  /** asked again and again while nothing moved (the state service asks every 10 s): the same
   *  answer, and no git started after the first */
  export type Remembered = Given<
    [
      Mock<"./layout.ts", typeof mirrorsAndClonesHere>,
      Invoke<typeof emptyRoot>,
      Invoke<typeof aRegistry, [repos: { "acme/app": {} }]>,
      Invoke<typeof aDomain, [slug: "acme", repos: ["acme/app"]]>,
      Invoke<
        typeof aMirrorCommit,
        [
          repo: "acme/app",
          files: {
            ".devcontainer/devcontainer.json": '{ "customizations": { "desolate": { "cpus": 2 } } }';
          },
        ]
      >,
      Invoke<typeof projectSizeOf, [slugArg: "acme"]>,
      Invoke<typeof countingGit>,
      Invoke<typeof projectSizeOf, [slugArg: "acme"]>,
      Invoke<typeof projectSizeOf, [slugArg: "acme"]>,
    ],
    [
      Expect<
        Invoke<typeof projectSizeOf, [slugArg: "acme"]>,
        "matches",
        { repo: "acme/app"; path: ".devcontainer/devcontainer.json"; size: { cpus: 2 } }
      >,
      Expect<Invoke<typeof gitStarts>, "=", 0>,
    ]
  >;
  /** the control: the remote publishes a new spec, and the next ask has it (git, once each to
   *  find the folder and its file, and twice to read the new file) */
  export type Moved = Given<
    [
      Mock<"./layout.ts", typeof mirrorsAndClonesHere>,
      Invoke<typeof emptyRoot>,
      Invoke<typeof aRegistry, [repos: { "acme/app": {} }]>,
      Invoke<typeof aDomain, [slug: "acme", repos: ["acme/app"]]>,
      Invoke<
        typeof aMirrorCommit,
        [
          repo: "acme/app",
          files: {
            ".devcontainer/devcontainer.json": '{ "customizations": { "desolate": { "cpus": 2 } } }';
          },
        ]
      >,
      Invoke<typeof projectSizeOf, [slugArg: "acme"]>,
      Invoke<
        typeof aMirrorCommit,
        [
          repo: "acme/app",
          files: {
            ".devcontainer/devcontainer.json": '{ "customizations": { "desolate": { "cpus": 4 } } }';
          },
        ]
      >,
      Invoke<typeof countingGit>,
    ],
    [
      Expect<Invoke<typeof projectSizeOf, [slugArg: "acme"]>, "matches", { size: { cpus: 4 } }>,
      Expect<Invoke<typeof gitStarts>, "=", 4>,
    ]
  >;
}

/** The id git gives `file` on a repository's default branch in its mirror, or null (not
 *  there, or no default branch known). Remembered for as long as the branch names the same
 *  commit, read from its ref as a checkout's is read (shared/status.ts refCommit): the state
 *  service asks for every workspace's environment every 10 s, and each answer was a git
 *  process or three. An idle stack of eleven repositories started about 100 in 30 s
 *  (measured on 2026-11-23); now none while no branch moves. */
const objects = new Map<string, { commit: string; id: string | null }>();
const objectOnDefault = async (id: string, file: string): Promise<string | null> => {
  const repo = parseRepo(id);
  const branch = registry().repos[id]?.defaultBranch;
  if (!repo || !branch || !isBranch(branch)) return null;
  const mirror = mirrorPath(repo);
  const commit = refCommit(mirror, mirror, branch);
  const key = `${id}\0${file}`;
  const known = objects.get(key);
  if (commit && known?.commit === commit) return known.id;
  // Asked of that commit, not of the branch: the answer is the commit's, whatever moves since.
  const found = await git(mirror, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${commit ?? `refs/heads/${branch}`}:${file}`,
  ]);
  const object = found.stdout.trim();
  const answer = found.code === 0 && /^[0-9a-f]{40}$/.test(object) ? object : null;
  // (Kept when git answered, found or not: a git that failed is asked again.)
  if (commit && found.code <= 1) objects.set(key, { commit, id: answer });
  return answer;
};

/** The domain's environment as the remote published it, for its template (section 4.7, C3):
 *  the environment repository (the one `env --from` names, else the first whose default
 *  branch has a spec) and the id git gives the spec there: the tree of `.devcontainer/`, or
 *  the blob of `.devcontainer.json`. Two specs with the same id are the same files. Read in
 *  the MIRROR, which holds only what the remote published (P4: never a domain's clone).
 *  null: no repository of the domain has a spec. */
export const envKey = async (
  slugArg: unknown,
  preferred?: unknown,
): Promise<{ repo: string; spec: string; id: string } | null> => {
  const d = domain(slugOf(slugArg, "domain"));
  // A workspace whose first named checkout has a spec is that repository's environment (a
  // domain with a python API and a node front end: the front end's workspace gets node).
  const first = typeof preferred === "string" && d.repos.includes(preferred) ? [preferred] : [];
  const candidates = [...first, ...(d.env ? [d.env] : d.repos)];
  for (const id of candidates)
    for (const spec of [".devcontainer", ".devcontainer.json"]) {
      const object = await objectOnDefault(id, spec);
      if (object) return { repo: id, spec, id: object };
    }
  return null;
};
