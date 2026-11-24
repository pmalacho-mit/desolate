// What the root tells a workspace VM to be: written by the root into the domain's inbox
// (read-only to the domain), read by the workspace's init. Frozen when the workspace is made.
// And what a workspace holds that a remove would lose: looked at in its VM, read on the host.
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Invoke, Table } from "../../suede.nests/dsl.import.meta.vitest.ts";

export type Checkout = {
  repo: string;
  /** "main": the domain clone's own checkout. "worktree": `.worktrees/<name>` on `branch`. */
  kind: "main" | "worktree";
  /** The worktree's directory name; unused for "main". */
  name: string;
  branch: string;
  /** What a new branch starts from: a local branch or a remote-tracking one (origin/main). */
  base: string;
  /** Where it is inside the workspace. */
  path: string;
};

export type WorkspacePlan = {
  domain: string;
  workspace: string;
  vm: string;
  title: string;
  checkouts: Checkout[];
  /** The repository whose devcontainer.json is the environment: the first checkout the person
   *  named, else the one the domain names, else (unset) the first that has a spec. */
  env?: string;
  /** Every repository of the domain, checked out here or not (git-urls.ts maps them all). */
  repos?: string[];
  /** The VM's size, as it was made (shared/size.ts). Absent for one made before sizes were
   *  recorded: it got the defaults of its day. */
  size?: { cpus: number; memoryMiB: number; diskGiB: number };
  /** Who commits here: the person's own git identity on the Mac, when it has one (their
   *  name and email are not credentials). Without it, the workspace's own name. */
  author?: { name: string; email: string };
  /** Which workspace of the domain asked for this one (`desolate spawn` inside it), and when
   *  that one was made (so a later workspace of the same name is not taken for it). Absent:
   *  the person started it. */
  startedBy?: { workspace: string; createdAt: string };
  /** Refresh origin/* from the mirror before creating worktrees. */
  fetch: boolean;
  createdAt: string;
};

/** One checkout's commits against the remote, as the root sees them (root/offers.ts
 *  `unpushedOf`): `count` commits its HEAD has that no branch of origin has, or null when that
 *  could not be told; `why` says what keeps it from being called pushed. */
export type Unpushed = {
  repo: string;
  branch: string | null;
  commit: string | null;
  count: number | null;
  why: string | null;
};

export const checkoutPath = (repo: string, kind: "main" | "worktree", name: string) =>
  kind === "main" ? `/workspaces/${repo}` : `/workspaces/${repo}/.worktrees/${name}`;

declare namespace checkoutPath {
  /** the domain clone's own checkout, or a worktree of it under `.worktrees/` */
  export type Paths = Table<
    typeof checkoutPath,
    [
      [args: [repo: "acme/app", kind: "main", name: ""], expected: "/workspaces/acme/app"],
      [
        args: [repo: "acme/app", kind: "worktree", name: "w1"],
        expected: "/workspaces/acme/app/.worktrees/w1",
      ],
    ]
  >;
}

/** A workspace another workspace started, which that one is gone before: flagged, for the
 *  person to look at (nothing is removed for it). A later workspace of the same name is not
 *  the one that started it. */
export const outlived = (
  all: { workspace: string; createdAt: string }[],
  w: { startedBy?: { workspace: string; createdAt: string } },
) =>
  w.startedBy !== undefined &&
  !all.some(
    (other) =>
      other.workspace === w.startedBy!.workspace && other.createdAt === w.startedBy!.createdAt,
  );

declare namespace outlived {
  /** one the person started never is; one whose parent is still there is not; one whose
   *  parent is gone, or was removed and made again under its name, is */
  export type Cases = Table<
    typeof outlived,
    [
      [
        args: [all: [{ workspace: "w1"; createdAt: "2026-11-16T08:00:00Z" }], w: {}],
        expected: false,
      ],
      [
        args: [
          all: [{ workspace: "w1"; createdAt: "2026-11-16T08:00:00Z" }],
          w: { startedBy: { workspace: "w1"; createdAt: "2026-11-16T08:00:00Z" } },
        ],
        expected: false,
      ],
      [
        args: [all: [], w: { startedBy: { workspace: "w1"; createdAt: "2026-11-16T08:00:00Z" } }],
        expected: true,
      ],
      [
        args: [
          all: [{ workspace: "w1"; createdAt: "2026-11-16T09:30:00Z" }],
          w: { startedBy: { workspace: "w1"; createdAt: "2026-11-16T08:00:00Z" } },
        ],
        expected: true,
      ],
    ]
  >;
}

/** The look at each checkout (its paths are the script's arguments). The host runs it by
 *  in the workspace's own VM (workspace/wsd.ts, when git records a change and once a minute;
 *  host/workspaces.ts, before a remove and at a stop), beside whatever a person or an agent is
 *  doing in the same repository, so it must take no lock there: a plain \`git status\` refreshes the index
 *  under .git/index.lock, and a \`git checkout\` or \`git commit\` that began in that moment
 *  failed with "Unable to create .git/index.lock: File exists" (seen on the M1, 2026-11-23:
 *  a test run's checkout, as its workspace started). */
export const LOOK_EACH = `for p in "$@"; do
  s=$(git --no-optional-locks -C "$p" status --porcelain --untracked-files=normal 2>/dev/null) || { echo "UNREADABLE $p"; continue; }
  [ -z "$s" ] || echo "UNCOMMITTED $p"
  [ -z "$(git -C "$p" stash list 2>/dev/null)" ] || echo "STASHED $p"
done`;

/** What a look (LOOK_EACH, run in the VM) says would be lost, in words: each line names what, and the
 *  checkout (one of `checkouts`, the paths the host asked about). A line that is not one of those
 *  is not passed over: a remove must not read as safe because of what it could not read. */
export const lostIn = (stdout: string, checkouts: readonly string[]): string[] => {
  const say: Record<string, string> = {
    UNSYNCED: "its branches could not be written out for the root",
    UNCOMMITTED: "uncommitted changes or untracked files in",
    STASHED: "stashed changes in",
    UNREADABLE: "a checkout git could not read:",
  };
  const lost: string[] = [];
  let unread = 0;
  for (const line of stdout.split("\n").map((l) => l.trim())) {
    if (!line) continue;
    const [word, ...rest] = line.split(" ");
    const where = rest.join(" ");
    if (word === "UNSYNCED" && !where) lost.push(say.UNSYNCED!);
    else if (word && word !== "UNSYNCED" && say[word] && checkouts.includes(where))
      lost.push(`${say[word]} ${where}`);
    else unread++;
  }
  if (unread)
    lost.push(
      `${unread} line${unread === 1 ? "" : "s"} of its answer could not be read, so something may be lost that is not named here`,
    );
  return lost;
};

declare namespace lostIn {
  /** each line read, against the checkouts asked about */
  export type Read = Expect<
    Invoke<
      typeof lostIn,
      [
        stdout: "UNSYNCED\nUNCOMMITTED /workspaces/acme/app\nSTASHED /workspaces/acme/app\n",
        checkouts: ["/workspaces/acme/app"],
      ]
    >,
    "=",
    [
      "its branches could not be written out for the root",
      "uncommitted changes or untracked files in /workspaces/acme/app",
      "stashed changes in /workspaces/acme/app",
    ]
  >;
  /** nothing said: nothing lost */
  export type Clean = Expect<
    Invoke<typeof lostIn, [stdout: "\n", checkouts: ["/workspaces/a"]]>,
    "=",
    []
  >;
  /** a line that is not one of them, or names a checkout not asked about, is counted, not
   *  dropped: the answer then never reads as clean */
  export type Unread = Expect<
    Invoke<
      typeof lostIn,
      [
        stdout: "UNCOMMITTED /workspaces/other\nwhat is this\nUNCOMMITTED /workspaces/a\n",
        checkouts: ["/workspaces/a"],
      ]
    >,
    "=",
    [
      "uncommitted changes or untracked files in /workspaces/a",
      "2 lines of its answer could not be read, so something may be lost that is not named here",
    ]
  >;
}
