// What the root tells a workspace VM to be: written by the root into the domain's inbox
// (read-only to the domain), read by the workspace's init. Frozen when the workspace is made.
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Table } from "../../.suede/nests/dsl.import.meta.vitest.ts";

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

export const checkoutPath = (repo: string, kind: "main" | "worktree", name: string) =>
  kind === "main" ? `/workspaces/${repo}` : `/workspaces/${repo}/.worktrees/${name}`;

declare namespace checkoutPath {
  /** the domain clone's own checkout, or a worktree of it under `.worktrees/` */
  export type Paths = Table<typeof checkoutPath, [
    [args: [repo: "acme/app", kind: "main", name: ""], expected: "/workspaces/acme/app"],
    [args: [repo: "acme/app", kind: "worktree", name: "w1"], expected: "/workspaces/acme/app/.worktrees/w1"],
  ]>;
}

/** A workspace another workspace started, which that one is gone before: flagged, for the
 *  person to look at (nothing is removed for it). A later workspace of the same name is not
 *  the one that started it. */
export const outlived = (all: { workspace: string; createdAt: string }[], w: { startedBy?: { workspace: string; createdAt: string } }) =>
  w.startedBy !== undefined && !all.some((other) => other.workspace === w.startedBy!.workspace && other.createdAt === w.startedBy!.createdAt);

declare namespace outlived {
  /** one the person started never is; one whose parent is still there is not; one whose
   *  parent is gone, or was removed and made again under its name, is */
  export type Cases = Table<typeof outlived, [
    [args: [all: [{ workspace: "w1"; createdAt: "2026-11-16T08:00:00Z" }], w: {}], expected: false],
    [args: [all: [{ workspace: "w1"; createdAt: "2026-11-16T08:00:00Z" }], w: { startedBy: { workspace: "w1"; createdAt: "2026-11-16T08:00:00Z" } }], expected: false],
    [args: [all: [], w: { startedBy: { workspace: "w1"; createdAt: "2026-11-16T08:00:00Z" } }], expected: true],
    [args: [all: [{ workspace: "w1"; createdAt: "2026-11-16T09:30:00Z" }], w: { startedBy: { workspace: "w1"; createdAt: "2026-11-16T08:00:00Z" } }], expected: true],
  ]>;
}
