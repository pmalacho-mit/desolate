// When the pages' tokens were last retired: the daemon found [::1] on its port held by
// another program, where browsers look first for *.localhost. A tab already open on the
// dashboard or an editor, reloaded then, sent that program its cookie, and the cookie is the
// token (final review, 2026-11-16). The approval page's and the git terminal's tokens are
// removed at once and made again when next asked for. The dashboard's (which the root holds a
// copy of) and each editor's (made once, in its VM) are not served again until they have been
// made again: the dashboard's by `desolate bootstrap`, an editor's by bootstrap for a running
// workspace and by its next start for a stopped one (workspace/editor.sh's second argument).
import * as fs from "node:fs";
import * as path from "node:path";
import { paths } from "./paths.ts";

const file = () => path.join(paths.state, "tokens-retired");

/** The time (ms since the epoch) the tokens were last retired, or 0. */
export const retiredAt = (): number => {
  try {
    const at = Number(fs.readFileSync(file(), "utf8").trim());
    return Number.isFinite(at) && at > 0 ? at : 0;
  } catch {
    return 0;
  }
};

export const retire = () => {
  fs.writeFileSync(file(), `${Date.now()}\n`, { mode: 0o600 });
  for (const name of ["approve-token", "git-token", "ui-token"]) fs.rmSync(path.join(paths.state, name), { force: true });
};

/** Whether a token made at `madeAt` (ms; 0 if not known) was made before the last retiring. */
export const stale = (madeAt: number, at = retiredAt()) => at > 0 && madeAt <= at;

/** The dashboard's token, made again since? (bootstrap makes it, and gives the root its copy) */
export const dashboardStale = (at = retiredAt()) => {
  if (at === 0) return false;
  try {
    return stale(fs.statSync(path.join(paths.state, "ui-token")).mtimeMs, at);
  } catch {
    return true;
  }
};
