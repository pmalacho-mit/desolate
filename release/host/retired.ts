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
import type { Expect, Given, Invoke, Table } from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { emptyHome, readState, stateFiles, writeState } from "../.harness/home.ts";

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

declare namespace retiredAt {
  /** never retired: 0, which every check below reads as "nothing is stale" */
  export type Never = Given<Invoke<typeof emptyHome>, Expect<Invoke<typeof retiredAt>, "=", 0>>;
  export type OnRecord = Given<
    [
      Invoke<typeof emptyHome>,
      Invoke<typeof writeState, [name: "tokens-retired", text: "1763300000000\n"]>,
    ],
    Expect<Invoke<typeof retiredAt>, "=", 1763300000000>
  >;
  /** a record that is not a positive number is no retiring */
  export type Unreadable = [
    Given<
      [
        Invoke<typeof emptyHome>,
        Invoke<typeof writeState, [name: "tokens-retired", text: "yesterday"]>,
      ],
      Expect<Invoke<typeof retiredAt>, "=", 0>
    >,
    Given<
      [Invoke<typeof emptyHome>, Invoke<typeof writeState, [name: "tokens-retired", text: "-5"]>],
      Expect<Invoke<typeof retiredAt>, "=", 0>
    >,
  ];
}

export const retire = () => {
  // Always a larger number than the last one, whatever the clock did.
  fs.writeFileSync(file(), `${Math.max(Date.now(), retiredAt() + 1)}\n`, { mode: 0o600 });
  for (const name of ["approve-token", "git-token", "ui-token", "agents-token"])
    fs.rmSync(path.join(paths.state, name), { force: true });
};

declare namespace retire {
  /** the page tokens go (the agents page's, for the phone, too), and the retiring is on record */
  export type RemovesTheTokens = Given<
    [
      Invoke<typeof emptyHome>,
      Invoke<typeof writeState, [name: "approve-token", text: "a"]>,
      Invoke<typeof writeState, [name: "git-token", text: "g"]>,
      Invoke<typeof writeState, [name: "ui-token", text: "u"]>,
      Invoke<typeof writeState, [name: "agents-token", text: "t"]>,
      Invoke<typeof retire>,
    ],
    Expect<Invoke<typeof stateFiles>, "=", ["tokens-retired"]>
  >;
  /** a clock that went back since the last retiring still gives a larger number */
  export type AlwaysLarger = Given<
    [
      Invoke<typeof emptyHome>,
      Invoke<typeof writeState, [name: "tokens-retired", text: "99999999999999"]>,
      Invoke<typeof retire>,
    ],
    Expect<Invoke<typeof readState, [name: "tokens-retired"]>, "=", "100000000000000\n">
  >;
}

/** Whether a token marked with `epoch` (the retiring it was made after; 0 if none, or not
 *  known) was made before the last retiring. */
export const stale = (epoch: number, at = retiredAt()) => at > 0 && epoch < at;

declare namespace stale {
  /** made after the last retiring (marked with it, or a later one) is served; before it, not */
  export type Epochs = Table<
    typeof stale,
    [
      [args: [epoch: 1763300000000, at: 1763300000000], expected: false],
      [args: [epoch: 1763300000001, at: 1763300000000], expected: false],
      [args: [epoch: 1763200000000, at: 1763300000000], expected: true],
      [args: [epoch: 0, at: 1763300000000], expected: true],
      [args: [epoch: 0, at: 0], expected: false],
    ]
  >;
}

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

declare namespace dashboardStale {
  /** never retired: the dashboard is served, whatever else is in the home */
  export type NeverRetired = Given<
    Invoke<typeof emptyHome>,
    Expect<Invoke<typeof dashboardStale>, "=", false>
  >;
  /** retired, and no token made since: refused until bootstrap */
  export type NoToken = Given<
    [
      Invoke<typeof emptyHome>,
      Invoke<typeof writeState, [name: "ui-token", text: "u"]>,
      Invoke<typeof writeState, [name: "agents-token", text: "t"]>,
      Invoke<typeof retire>,
    ],
    Expect<Invoke<typeof dashboardStale>, "=", true>
  >;
  /** a token there but no word that the root has it: a copy made before the retiring, so refused */
  export type TokenWithoutEpoch = Given<
    [
      Invoke<typeof emptyHome>,
      Invoke<typeof writeState, [name: "tokens-retired", text: "1763300000000"]>,
      Invoke<typeof writeState, [name: "ui-token", text: "u"]>,
    ],
    Expect<Invoke<typeof dashboardStale>, "=", true>
  >;
  /** marked with an older retiring than the last: refused */
  export type OlderEpoch = Given<
    [
      Invoke<typeof emptyHome>,
      Invoke<typeof writeState, [name: "tokens-retired", text: "1763300000000"]>,
      Invoke<typeof writeState, [name: "ui-token", text: "u"]>,
      Invoke<typeof writeState, [name: "ui-token.epoch", text: "1763200000000"]>,
    ],
    Expect<Invoke<typeof dashboardStale>, "=", true>
  >;
}

declare namespace dashboardMade {
  /** bootstrap's new token, marked with the last retiring: served again */
  export type ServedAgain = Given<
    [
      Invoke<typeof emptyHome>,
      Invoke<typeof writeState, [name: "tokens-retired", text: "1763300000000"]>,
      Invoke<typeof writeState, [name: "ui-token", text: "u"]>,
      Invoke<typeof dashboardMade>,
    ],
    [
      Expect<Invoke<typeof dashboardStale>, "=", false>,
      Expect<Invoke<typeof readState, [name: "ui-token.epoch"]>, "=", "1763300000000\n">,
    ]
  >;
  /** never retired: nothing to mark */
  export type NothingToMark = Given<
    [Invoke<typeof emptyHome>, Invoke<typeof dashboardMade>],
    Expect<Invoke<typeof stateFiles>, "=", []>
  >;
}
