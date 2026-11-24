// Harness for in-source tests of the root VM's code (release/root/): a root's state, under the
// test file's own home (setup.ts), in place of /var/lib/desolate, /desolate/domains
// and the rest.
//
// layout.ts reads where each directory is from the environment once, when it is first
// imported. A test's harness is imported before the module under test (the printed test's
// imports come first), so these are set here, at the top, before anything reads them. The
// mirrors and the root clones are not in the environment (/desolate/mirrors, /desolate/root):
// a test that needs them says so with `Mock<"./layout.ts", typeof mirrorsAndClonesHere>`.
import * as fs from "node:fs";
import * as path from "node:path";

const base = path.join(process.env.DESOLATE_HOME!, "root-vm");
const WHERE = {
  state: "DESOLATE_ROOT_STATE",
  domains: "DESOLATE_ROOT_DOMAINS",
  sys: "DESOLATE_ROOT_SYS",
  proxies: "DESOLATE_ROOT_PROXIES",
  run: "DESOLATE_ROOT_RUN",
  reviewer: "DESOLATE_REVIEWER_HOME",
  pusher: "DESOLATE_PUSHER_HOME",
} as const;
type Where = keyof typeof WHERE | "mirrors" | "clones";
for (const [dir, name] of Object.entries(WHERE)) process.env[name] = path.join(base, dir);

const at = (where: Where, name: string) => path.join(base, where, name);

/** The root's directories, each empty: no registry, no domains, no keys. */
export const emptyRoot = () => {
  fs.rmSync(base, { recursive: true, force: true });
  for (const dir of [...Object.keys(WHERE), "mirrors", "clones"])
    fs.mkdirSync(path.join(base, dir), { recursive: true });
  // keyring.ts writes its audit log here, as start.sh has made it.
  fs.mkdirSync(at("sys", "keyring"), { recursive: true });
};

/** A file under one of the root's directories, as something before the test left it. */
export const writeIn = (where: Where, name: string, text: string) => {
  fs.mkdirSync(path.dirname(at(where, name)), { recursive: true });
  fs.writeFileSync(at(where, name), text);
};

/** The same, as JSON. */
export const writeJsonIn = (where: Where, name: string, value: unknown) =>
  writeIn(where, name, JSON.stringify(value));

/** A file under one of the root's directories, or null when there is none. */
export const readIn = (where: Where, name: string): string | null => {
  try {
    return fs.readFileSync(at(where, name), "utf8");
  } catch {
    return null;
  }
};

/** The same, parsed. */
export const readJsonIn = (where: Where, name: string): Record<string, unknown> | null => {
  const text = readIn(where, name);
  return text === null ? null : JSON.parse(text);
};

/** What is in a directory under one of the root's, sorted ([] when there is none). */
export const namesIn = (where: Where, dir: string): string[] => {
  try {
    return fs.readdirSync(at(where, dir)).sort();
  } catch {
    return [];
  }
};

/** Where a name under one of the root's directories is, for a function that takes a path. */
export const pathIn = (where: Where, name: string) => at(where, name);

/** A domain as the root records it (domains.ts), with these repositories, and the
 *  directories `domain create` makes. */
export const aDomain = (slug: string, repos: string[], extra: Record<string, unknown> = {}) => {
  for (const dir of ["repos", "outbox", "inbox", "workspaces"])
    fs.mkdirSync(at("domains", `${slug}/${dir}`), { recursive: true });
  writeJsonIn("domains", `${slug}/domain.json`, {
    slug,
    title: slug,
    repos,
    createdAt: "2026-11-16T12:00:00.000Z",
    ...extra,
  });
};

/** One of a domain's workspaces, as plan made it: `checkouts` are `<owner/repo>=main` or
 *  `<owner/repo>=worktree:<name>`; `startedBy` names the workspace that started it. */
export const aWorkspace = (domain: string, name: string, checkouts: string[], startedBy?: string) =>
  writeJsonIn("domains", `${domain}/workspaces/${name}.json`, {
    domain,
    workspace: name,
    vm: `dsl-test-${domain}-${name}`,
    title: domain,
    repos: [],
    fetch: false,
    createdAt: "2026-11-16T12:00:00.000Z",
    state: "up",
    checkouts: checkouts.map((c) => {
      const [repo, how] = c.split("=") as [string, string];
      const worktree = how.startsWith("worktree:") ? how.slice("worktree:".length) : null;
      return {
        repo,
        kind: worktree ? "worktree" : "main",
        name: worktree ?? "",
        branch: worktree ?? "main",
        base: "main",
        path: `/workspaces/${repo}`,
      };
    }),
    ...(startedBy
      ? { startedBy: { workspace: startedBy, createdAt: "2026-11-16T12:00:00.000Z" } }
      : {}),
  });

/** The root's registry of repositories (repos.ts), each as the root last fetched it. */
export const aRegistry = (
  repos: Record<string, { pushable?: boolean; defaultBranch?: string | null }>,
) =>
  writeJsonIn("state", "registry.json", {
    repos: Object.fromEntries(
      Object.entries(repos).map(([id, r]) => [
        id,
        {
          pushable: r.pushable ?? true,
          anonymous: false,
          defaultBranch: r.defaultBranch === undefined ? "main" : r.defaultBranch,
          fetchedAt: null,
        },
      ]),
    ),
  });

/** A directory under one of the root's, where a file was expected. */
export const makeDirIn = (where: Where, name: string) =>
  fs.mkdirSync(at(where, name), { recursive: true });

/** A file of `bytes` bytes under one of the root's directories: one too large to be read. */
export const writeFilledIn = (where: Where, name: string, bytes: number) =>
  writeIn(where, name, "x".repeat(bytes));

/** A symbolic link under one of the root's directories, to `target`. */
export const linkIn = (where: Where, name: string, target: string) => {
  fs.mkdirSync(path.dirname(at(where, name)), { recursive: true });
  fs.symlinkSync(target, at(where, name));
};

/** layout.ts with its mirrors and root clones under this harness's root, for `Mock`: the rest
 *  as layout.ts has it (with the environment above). Named by their real path, as
 *  /desolate/mirrors is in the root VM (macOS's temporary directory is behind a link). */
export const mirrorsAndClonesHere = async (
  importOriginal: () => Promise<typeof import("../root/layout.ts")>,
) => {
  const real = await importOriginal();
  fs.mkdirSync(base, { recursive: true });
  const here = fs.realpathSync(base);
  const ROOT = {
    ...real.ROOT,
    mirrors: path.join(here, "mirrors"),
    clones: path.join(here, "clones"),
  };
  return {
    ...real,
    ROOT,
    mirrorPath: (repo: { owner: string; name: string }) =>
      `${ROOT.mirrors}/${repo.owner}/${repo.name}.git`,
    clonePath: (repo: { owner: string; name: string }) =>
      `${ROOT.clones}/${repo.owner}/${repo.name}`,
  };
};

/** The keyring's keys directory as keyring.ts finds it at start (start.sh makes it): a file
 *  where the directory should be, a directory open to others (0755), or one closed (0700) in
 *  a directory that is not root's. Its path. */
export const aKeysDir = (shape: "file" | "open" | "closed") => {
  const dir = at("sys", `keys-${shape}`);
  if (shape === "file") writeIn("sys", `keys-${shape}`, "");
  else fs.mkdirSync(dir, { recursive: true, mode: shape === "open" ? 0o755 : 0o700 });
  if (shape !== "file") fs.chmodSync(dir, shape === "open" ? 0o755 : 0o700);
  return dir;
};

/** The user the test runs as, as keyring.ts is given its own. */
export const myUid = () => process.getuid!();

/** A workspace of `domain` whose VM is called `vm`: what another domain could have chosen a
 *  name to collide with. */
export const writeVmIn = (domain: string, workspace: string, vm: string) =>
  writeJsonIn("domains", `${domain}/workspaces/${workspace}.json`, {
    domain,
    workspace,
    vm,
    title: domain,
    repos: [],
    checkouts: [],
    fetch: false,
    createdAt: "2026-11-16T12:00:00.000Z",
    state: "up",
  });

/** Every JSON file in a directory under one of the root's, parsed: what a queue holds. (In no
 *  order a test should rely on: names made of a time and a random part.) */
export const jsonFilesIn = (where: Where, dir: string): Record<string, unknown>[] =>
  namesIn(where, dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readJsonIn(where, `${dir}/${name}`)!);

/** A file under one of the root's directories as text, "" when there is none: for a test of
 *  its length or what it holds. */
export const textIn = (where: Where, name: string): string => readIn(where, name) ?? "";

/** A JSON file under one of the root's directories that holds a list, parsed; null when there
 *  is none. */
export const jsonListIn = (where: Where, name: string): unknown[] | null => {
  const text = readIn(where, name);
  return text === null ? null : (JSON.parse(text) as unknown[]);
};

/** `count` of a domain's close requests in the host's queue, as an earlier rootd wrote them
 *  (layout.ts's HOST_QUEUE: a time and a random part, then `.json`). */
export const queuedForHost = (domain: string, count: number) => {
  for (let i = 0; i < count; i++)
    writeJsonIn(
      "state",
      `host-queue/${domain.replace(/-/g, "")}${i}-${String(i).padStart(10, "0")}.json`,
      {
        kind: "workspace.close",
        args: { domain, workspace: `c${i}`, parent: "w1" },
        at: Date.now(),
      },
    );
};
