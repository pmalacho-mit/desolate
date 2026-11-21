// What a step of a workspace's start says while it runs, and how it learns that nobody is
// waiting for it any more (docs/v3/limits.md, R4: patience belongs to whoever is waiting).
//
// The steps a start runs in the VM (workspace/init.ts, devcontainer.ts) have no timer of their own:
// how long a start may take is the host's to decide, where the person is waiting
// (host/workspaces.ts, which reads them). What they owe the host is on stderr, a line at a time:
//   - what they are doing, when they begin it, and every BEAT_MS that they still are, with
//     how long so far. The host shows the person those lines, and takes a workspace that has
//     said nothing for many beats' time as stopped: so a step that is running is never
//     killed for being slow, and one that is not running is not waited on.
//   - nothing else: a step's answer is its stdout.
// And they stop when the host does: its end of stderr closed (the person's Ctrl-C, or the
// host giving up on a silent VM), which the next line written here finds.
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Invoke, Table } from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { saidDuring } from "../.harness/shared-step.ts";

/** How often a running step says that it still is: often enough that the person sees a
 *  start is alive before wondering, and that a cancelled start is noticed within this long;
 *  a line every ten seconds costs nothing. The host counts its own patience in these. */
export const BEAT_MS = 10_000;

/** How long something has taken, as a person reads it: "40 s", "3 min", "1 h 12 min". */
export const elapsed = (ms: number): string => {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 120) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 120 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
};

declare namespace elapsed {
  /** seconds up to two minutes, then whole minutes, then hours and minutes */
  export type Reads = Table<
    typeof elapsed,
    [
      [args: [ms: 0], expected: "0 s"],
      [args: [ms: 40500], expected: "40 s"],
      [args: [ms: 119999], expected: "119 s"],
      [args: [ms: 120000], expected: "2 min"],
      [args: [ms: 4379000], expected: "72 min"],
      [args: [ms: 7200000], expected: "2 h 0 min"],
      [args: [ms: 11580000], expected: "3 h 13 min"],
    ]
  >;
}

let gone: AbortController | undefined;
/** Fires when whoever asked for this program is no longer there to read it: its stderr or
 *  stdout was closed at the other end. What a step runs takes this as its `signal`
 *  (shared/run.ts), so a start that was cancelled does not go on building. */
export const requester = (): AbortSignal => {
  if (gone) return gone.signal;
  const controller = (gone = new AbortController());
  for (const stream of [process.stderr, process.stdout])
    stream.on("error", () => controller.abort());
  return controller.signal;
};

const toStderr = (line: string) => void process.stderr.write(`${line}\n`);

/** Say `what` now, and every `beatMs` that it still is so, with how long so far, until the
 *  answer is called. `what` reads after "still": "making the checkout of acme/app". */
export const beating = (
  what: string,
  say: (line: string) => void = toStderr,
  beatMs: number = BEAT_MS,
): (() => void) => {
  const began = Date.now();
  say(what);
  const beat = setInterval(
    () => say(`still ${what} (${elapsed(Date.now() - began)} so far)`),
    beatMs,
  );
  return () => clearInterval(beat);
};

/** Run `work` as a step that says what it is, for as long as it runs (`beating`). Its
 *  answer, or its throw, is the work's. */
export const saying = async <T>(
  what: string,
  work: () => Promise<T>,
  say: (line: string) => void = toStderr,
  beatMs: number = BEAT_MS,
): Promise<T> => {
  const done = beating(what, say, beatMs);
  try {
    return await work();
  } finally {
    done();
  }
};

declare namespace saying {
  /** a step that ends at once says what it was, once; its answer is the work's */
  export type Quick = Expect<
    Invoke<typeof saidDuring, [what: "making the checkout of acme/app", workMs: 0, beatMs: 100]>,
    "=",
    { answer: "done"; said: ["making the checkout of acme/app"] }
  >;
  /** one that takes longer says that it still is, each beat, for as long as it runs: there
   *  is no time after which it stops saying so, and none after which it is stopped */
  export type Long = Expect<
    Invoke<typeof saidDuring, [what: "building its devcontainer", workMs: 250, beatMs: 100]>,
    "=",
    {
      answer: "done";
      said: [
        "building its devcontainer",
        "still building its devcontainer (0 s so far)",
        "still building its devcontainer (0 s so far)",
      ];
    }
  >;
}
