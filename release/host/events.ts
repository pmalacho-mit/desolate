// `desolate events`: what happens in the stack, as JSON lines, for a script on the Mac to act
// on (open a pull request when a branch is pushed, say). The host daemon gathers them.
//
// Every event says where it comes from, because that is how much it can be believed:
//   "host"    the host itself: a workspace it started or stopped, an approval it signed on
//             the approval page (parsed from the signed text), a push the git VM handed it.
//   "pusher"  the root's pusher (root/pusher.ts), from a log only root writes: what the
//             keyring's record of the approval named, and what the forge answered. A
//             `pushed` from here means the remote has that commit on that branch.
//   "root"    the root's ordinary user (its state service): offers, refusals, statuses,
//             pushes waiting. That user parses what domains send; these are its word, and an
//             agent wrote the text in them (a status message, a branch name). Act on them
//             as you would on an agent's word. Their strings are made safe to print (no
//             control characters, no bidirectional overrides), not true.
//
// One JSON object per line: {"v":1,"at","type","source",...}.
import { printable } from "../shared/text.ts";
import { isBranch, isCommit, isSlug, parseRepo } from "../shared/names.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Invoke, Table } from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { heardFrom } from "../.harness/host-events.ts";

export type { Event } from "../shared/events.ts";
export { stateEvents } from "../shared/events.ts";
import { branchOrNull, commitOrNull, event } from "../shared/events.ts";
import type { Event } from "../shared/events.ts";

/** A line of the pusher's log that is an event (`EVENT {...}`), checked field by field. */
export const pusherEvent = (line: string): Event | null => {
  const match = /^EVENT (\{.*\})$/.exec(line);
  if (!match) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(match[1]!) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!["pushed", "push-failed", "push-uncertain"].includes(String(raw.type))) return null;
  if (!parseRepo(raw.repo) || !isBranch(raw.branch) || !isCommit(raw.commit) || (raw.onto !== null && !isCommit(raw.onto))) return null;
  return { ...event(String(raw.type), "pusher", { repo: raw.repo, branch: raw.branch, commit: raw.commit, onto: raw.onto, ...(raw.type === "pushed" ? {} : { error: printable(raw.error) }) }), at: typeof raw.at === "string" ? printable(raw.at, 40) : new Date().toISOString() };
};

declare namespace pusherEvent {
  /** a push that landed: the pusher's fields, checked, and its time */
  export type Pushed = Expect<
    Invoke<typeof pusherEvent, [line: 'EVENT {"type":"pushed","repo":"acme/widgets","branch":"issue/12","commit":"0123456789abcdef0123456789abcdef01234567","onto":null,"at":"2026-11-16T10:00:00.000Z"}']>,
    "=",
    { at: "2026-11-16T10:00:00.000Z"; repo: "acme/widgets"; branch: "issue/12"; commit: "0123456789abcdef0123456789abcdef01234567"; onto: null; v: 1; type: "pushed"; source: "pusher" }
  >;
  /** a failure carries the forge's error, made printable; nothing else of the line is kept,
   *  and the line cannot say it came from elsewhere */
  export type Failed = Expect<
    Invoke<typeof pusherEvent, [line: 'EVENT {"type":"push-failed","source":"host","via":"terminal","repo":"acme/widgets","branch":"issue/12","commit":"0123456789abcdef0123456789abcdef01234567","onto":"fedcba9876543210fedcba9876543210fedcba98","error":"rejected\\u001b[2J","at":"2026-11-16T10:00:00.000Z"}']>,
    "=",
    { at: "2026-11-16T10:00:00.000Z"; repo: "acme/widgets"; branch: "issue/12"; commit: "0123456789abcdef0123456789abcdef01234567"; onto: "fedcba9876543210fedcba9876543210fedcba98"; error: "rejected?[2J"; v: 1; type: "push-failed"; source: "pusher" }
  >;
  /** no time in the line: the time it was read */
  export type NoTime = Expect<Invoke<typeof pusherEvent, [line: 'EVENT {"type":"push-uncertain","repo":"acme/widgets","branch":"main","commit":"0123456789abcdef0123456789abcdef01234567","onto":null,"error":"timed out"}']>, "matches", { type: "push-uncertain"; source: "pusher"; error: "timed out" }>;
  /** the log's other lines, and an event whose fields are not what a push names */
  export type Refuses = Table<typeof pusherEvent, [
    [args: [line: "pushed acme/widgets issue/12"], expected: null],
    [args: [line: "EVENT {type: pushed}"], expected: null],
    [args: [line: 'EVENT {"type":"approved","repo":"acme/widgets","branch":"issue/12","commit":"0123456789abcdef0123456789abcdef01234567","onto":null}'], expected: null],
    [args: [line: 'EVENT {"type":"pushed","repo":"acme/../widgets","branch":"issue/12","commit":"0123456789abcdef0123456789abcdef01234567","onto":null}'], expected: null],
    [args: [line: 'EVENT {"type":"pushed","repo":"acme/widgets","branch":"-x/../main","commit":"0123456789abcdef0123456789abcdef01234567","onto":null}'], expected: null],
    [args: [line: 'EVENT {"type":"pushed","repo":"acme/widgets","branch":"issue/12","commit":"0123456","onto":null}'], expected: null],
    [args: [line: 'EVENT {"type":"pushed","repo":"acme/widgets","branch":"issue/12","commit":"0123456789abcdef0123456789abcdef01234567","onto":"main"}'], expected: null],
    [args: [line: 'EVENT {"type":"pushed","repo":"acme/widgets","branch":"issue/12","commit":"0123456789abcdef0123456789abcdef01234567"}'], expected: null],
  ]>;
}

/** The daemon's hub: the last events, and whoever listens. */
export const hub = (keep = 500) => {
  const recent: Event[] = [];
  const listeners = new Set<(line: string) => void>();
  return {
    listening: () => listeners.size > 0,
    publish: (e: Event) => {
      recent.push(e);
      if (recent.length > keep) recent.shift();
      const line = JSON.stringify(e);
      for (const listen of listeners) listen(line);
    },
    host: (type: string, fields: Record<string, unknown>) => event(type, "host", fields),
    listen: (replay: number, listen: (line: string) => void) => {
      // (Nothing for 0: slice(-0) would be all of it.)
      if (replay > 0) for (const e of recent.slice(-Math.min(replay, keep))) listen(JSON.stringify(e));
      listeners.add(listen);
      return () => listeners.delete(listen);
    },
  };
};

declare namespace hub {
  /** a listener hears the last ones it asks for, of those kept, then each as it comes, and
   *  nothing once it stops */
  export type Replays = Expect<
    Invoke<typeof heardFrom, [makeHub: typeof hub, keep: 2, before: ["a", "b", "c"], replay: 5, after: ["d"]]>,
    "=",
    { heard: ["b", "c", "d"]; listening: true; afterStop: false }
  >;
  /** asking for none is none, not all of them */
  export type ReplayNone = Expect<Invoke<typeof heardFrom, [makeHub: typeof hub, keep: 500, before: ["a", "b"], replay: 0, after: ["c"]]>, "matches", { heard: ["c"] }>;
}
