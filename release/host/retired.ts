// When the pages' tokens were last retired: the daemon found [::1] on its port held by
// another program, where browsers look first for *.localhost. A tab already open on the
// dashboard or an editor, reloaded then, sent that program its cookie, and the cookie is the
// token (final review, 2026-11-16). The approval page's and the git terminal's tokens are
// removed at once and made again when next asked for. The dashboard's (which the root holds a
// copy of) and each editor's (made once, in its VM) are not served again until they have been
// made again: the dashboard's by `desolate bootstrap`, an editor's by bootstrap for a running
// workspace and by its next start for a stopped one (workspace/editor.sh's second argument).
//
// The time is used as a number only, never compared with a clock: each token made again is
// marked with the number of the retiring it was made after (here for the dashboard's, beside
// the token in the VM for an editor's), since a VM's clock, or the Mac's, may have moved
// (review of the final fixes: a resumed VM's clock behind the Mac's kept its editor refused).
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
  // Always a larger number than the last one, whatever the clock did.
  fs.writeFileSync(file(), `${Math.max(Date.now(), retiredAt() + 1)}\n`, { mode: 0o600 });
  for (const name of ["approve-token", "git-token", "ui-token"]) fs.rmSync(path.join(paths.state, name), { force: true });
};

/** Whether a token marked with `epoch` (the retiring it was made after; 0 if none, or not
 *  known) was made before the last retiring. */
export const stale = (epoch: number, at = retiredAt()) => at > 0 && epoch < at;

const dashboardEpoch = () => path.join(paths.state, "ui-token.epoch");
/** The dashboard's token, made again since, and the root given its copy? */
export const dashboardStale = (at = retiredAt()) => {
  if (at === 0) return false;
  if (!fs.existsSync(path.join(paths.state, "ui-token"))) return true;
  try {
    return stale(Number(fs.readFileSync(dashboardEpoch(), "utf8").trim()) || 0, at);
  } catch {
    return true;
  }
};
/** Bootstrap, once the root has the dashboard's token: it is served again. */
export const dashboardMade = () => {
  const at = retiredAt();
  if (at > 0) fs.writeFileSync(dashboardEpoch(), `${at}\n`, { mode: 0o600 });
};
