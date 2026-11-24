// Harness for the in-source tests of release/host/status.ts: what the root would answer about
// a domain, a checkout's status as a workspace leaves it in the domain's share, and what the
// command printed. All in the test file's own home (setup.ts).
import * as fs from "node:fs";
import * as path from "node:path";
import { workspaceVmName } from "../shared/names.ts";
import { INSTANCE } from "../host/paths.ts";
import { checkoutPath } from "../shared/plan.ts";
import type { WorkspacePlan } from "../shared/plan.ts";
import type { status } from "../host/status.ts";

/** A workspace as the root records it, with one checkout of `repo` (the main one when
 *  `branch` is "main", else a worktree of that name). Its VM is the one desolate names for
 *  `vmOf`'s workspace of that name: the domain's own, unless a test says otherwise. */
export const rootRecord = (
  domain: string,
  workspace: string,
  repo: string,
  branch: string,
  vmOf = domain,
): WorkspacePlan & { state: string } => ({
  domain,
  workspace,
  vm: workspaceVmName(INSTANCE, vmOf, workspace),
  title: workspace,
  fetch: false,
  createdAt: "2026-11-16T09:00:00Z",
  state: "up",
  checkouts: [
    {
      repo,
      kind: branch === "main" ? "main" : "worktree",
      name: branch === "main" ? "" : branch,
      branch,
      base: "main",
      path: checkoutPath(
        repo,
        branch === "main" ? "main" : "worktree",
        branch === "main" ? "" : branch,
      ),
    },
  ],
});

/** A checkout's status and note, written where /desolate/status writes them in the domain's
 *  clone (shared/status.ts, statusDir). */
export const checkoutSays = (
  domain: string,
  repo: string,
  branch: string,
  statusJson: string,
  note: string,
) => {
  const git = path.join(process.env.DESOLATE_HOME!, "domains", domain, "repos", repo, ".git");
  const dir = branch === "main" ? git : path.join(git, "worktrees", branch);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "desolate-status.json"), statusJson);
  if (note) fs.writeFileSync(path.join(dir, "desolate-note.md"), note);
};

/** What `desolate status <target>` printed, or the refusal it ended with and its fix. */
export const statusSays = async (
  command: typeof status,
  target: string | undefined,
  json: boolean,
  notes?: Record<string, string[]>,
): Promise<{ lines: string[] } | { refused: string; fix: string }> => {
  const lines: string[] = [];
  try {
    await command(
      target,
      (line) => void lines.push(line),
      json,
      notes && (async () => new Map(Object.entries(notes))),
    );
    return { lines };
  } catch (error) {
    return { refused: (error as Error).message, fix: String((error as { fix?: unknown }).fix) };
  }
};
