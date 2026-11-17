// What changed in the root's state, as events: the host's `desolate events` (host/events.ts)
// and each domain's own events, which the root writes into the domain's inbox for its
// workspaces (`desolate events`, inside one; root/stated.ts). Pure: a state in, events out.
import { printable } from "./text.ts";
import { isBranch, isCommit, isSlug, parseRepo } from "./names.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Invoke, Table } from "../../.suede/nests/dsl.import.meta.vitest.ts";
import type { offersIn, perDomain } from "../../tests/nests/shared-events.harness.ts";

export type Event = { v: 1; at: string; type: string; source: "host" | "pusher" | "root" } & Record<string, unknown>;

/** A root-sourced name, only if it is one desolate would make (else null): a script may pass
 *  it on as an argument (`gh --head "$branch"`), and no valid one starts with `-`. */
export const repoOrNull = (value: unknown) => (parseRepo(value) ? String(value) : null);
export const branchOrNull = (value: unknown) => (isBranch(value) ? value : null);
export const commitOrNull = (value: unknown) => (isCommit(value) ? value : null);
export const slugOrNull = (value: unknown) => (isSlug(value) ? String(value) : null);

declare namespace branchOrNull {
  /** a name a script may pass on as an argument, or null: never one that starts with `-` */
  export type Cases = Table<typeof branchOrNull, [
    [args: [value: "issue/12"], expected: "issue/12"],
    [args: [value: "--upload-pack=x"], expected: null],
    [args: [value: 12], expected: null],
  ]>;
}
declare namespace repoOrNull {
  /** owner/name, or null: never an option, never a path that climbs */
  export type Cases = Table<typeof repoOrNull, [
    [args: [value: "acme/app"], expected: "acme/app"],
    [args: [value: "-acme/app"], expected: null],
    [args: [value: "acme/app/../x"], expected: null],
  ]>;
}
declare namespace commitOrNull {
  /** a full object id, or null: never a ref git would resolve */
  export type Cases = Table<typeof commitOrNull, [
    [args: [value: "0123456789abcdef0123456789abcdef01234567"], expected: "0123456789abcdef0123456789abcdef01234567"],
    [args: [value: "HEAD"], expected: null],
  ]>;
}
declare namespace slugOrNull {
  /** a domain or workspace name, or null */
  export type Cases = Table<typeof slugOrNull, [
    [args: [value: "dev"], expected: "dev"],
    [args: [value: "-dev"], expected: null],
  ]>;
}
/** At most this many events from one change of the root's state. */
const PER_CHANGE = 200;

// (The fixed keys last: no field can stand in for them.)
export const event = (type: string, source: Event["source"], fields: Record<string, unknown>): Event => ({ at: new Date().toISOString(), ...fields, v: 1, type, source });

declare namespace event {
  /** the fields as given, and the version, type and source after them: a field named `type`
   *  in what a domain wrote cannot make an event of another type */
  export type FixedKeysWin = Expect<
    Invoke<typeof event, [type: "offered", source: "root", fields: { domain: "dev"; type: "approved"; source: "host"; v: 2 }]>,
    "matches",
    { domain: "dev"; type: "offered"; source: "root"; v: 1 }
  >;
}

type State = {
  offers?: { domain?: unknown; workspace?: unknown; repo?: unknown; branch?: unknown; commit?: unknown }[];
  refused?: { domain?: unknown; repo?: unknown; why?: unknown }[];
  approvals?: { repo?: unknown; branch?: unknown; commit?: unknown }[];
  issues?: { id?: unknown; domain?: unknown; workspace?: unknown; repo?: unknown; title?: unknown; state?: unknown; url?: unknown }[];
  domains?: { slug?: unknown; workspaces?: { workspace?: unknown; state?: unknown; startedBy?: unknown; checkouts?: { repo?: unknown; head?: { branch?: unknown; commit?: unknown } | null }[]; says?: { status?: { color?: unknown; message?: unknown; updated?: unknown } | null } }[] }[];
};

/** What changed between two of the root's states, as events (source "root"). */
export const stateEvents = (before: State | null, after: State): Event[] => {
  const out: Event[] = [];
  const key = (...parts: unknown[]) => parts.map((p) => String(p)).join("\0");
  const offerKey = (o: NonNullable<State["offers"]>[number]) => key(o.domain, o.repo, o.branch, o.commit);
  const was = new Map((before?.offers ?? []).map((o) => [offerKey(o), o]));
  const now = new Map((after.offers ?? []).map((o) => [offerKey(o), o]));
  for (const [k, o] of now) if (!was.has(k)) out.push(event("offered", "root", { domain: slugOrNull(o.domain), workspace: slugOrNull(o.workspace), repo: repoOrNull(o.repo), branch: branchOrNull(o.branch), commit: commitOrNull(o.commit) }));
  for (const [k, o] of was) if (!now.has(k)) out.push(event("offer-gone", "root", { domain: slugOrNull(o.domain), repo: repoOrNull(o.repo), branch: branchOrNull(o.branch), commit: commitOrNull(o.commit) }));
  const refusedKey = (r: NonNullable<State["refused"]>[number]) => key(r.domain, r.repo, r.why);
  const refusedBefore = new Set((before?.refused ?? []).map(refusedKey));
  for (const r of after.refused ?? []) if (!refusedBefore.has(refusedKey(r))) out.push(event("bundle-refused", "root", { domain: slugOrNull(r.domain), repo: repoOrNull(r.repo), why: printable(r.why) }));
  const waitingKey = (a: NonNullable<State["approvals"]>[number]) => key(a.repo, a.branch, a.commit);
  const waitingBefore = new Set((before?.approvals ?? []).map(waitingKey));
  for (const a of after.approvals ?? []) if (!waitingBefore.has(waitingKey(a))) out.push(event("approval-waiting", "root", { repo: repoOrNull(a.repo), branch: branchOrNull(a.branch), commit: commitOrNull(a.commit) }));
  const says = (state: State | null) => {
    const map = new Map<string, { domain: unknown; workspace: unknown; color?: unknown; message?: unknown; updated?: unknown }>();
    for (const d of state?.domains ?? []) for (const w of d.workspaces ?? []) if (w.says?.status) map.set(key(d.slug, w.workspace), { domain: d.slug, workspace: w.workspace, ...w.says.status });
    return map;
  };
  const saidBefore = says(before);
  for (const [k, s] of says(after)) {
    const old = saidBefore.get(k);
    if (!old || old.updated !== s.updated || old.color !== s.color || old.message !== s.message)
      out.push(event("status", "root", { domain: slugOrNull(s.domain), workspace: slugOrNull(s.workspace), color: /^(gray|blue|green|yellow|orange|red)$/.test(String(s.color)) ? s.color : null, message: printable(s.message, 200) }));
  }
  // Issues offered, published (with their page) and rejected.
  const issuesBefore = new Map((before?.issues ?? []).map((i) => [String(i.id), i]));
  for (const i of after.issues ?? []) {
    const old = issuesBefore.get(String(i.id));
    if (old && old.state === i.state) continue;
    const fields = { domain: slugOrNull(i.domain), workspace: slugOrNull(i.workspace), repo: repoOrNull(i.repo), id: /^[0-9a-z-]{1,40}$/.test(String(i.id)) ? i.id : null, title: printable(i.title, 256) };
    if (!old && i.state === "offered") out.push(event("issue-offered", "root", fields));
    else if (i.state === "published") out.push(event("issue-published", "root", { ...fields, url: typeof i.url === "string" && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+$/.test(i.url) ? i.url : null }));
    else if (i.state === "rejected") out.push(event("issue-rejected", "root", fields));
  }
  // Workspaces made, started, stopped and removed, with who started each: so a workspace can
  // follow the ones it asked for (desolate spawn), and the person every one.
  const spaces = (state: State | null) => {
    const map = new Map<string, { domain: unknown; workspace: unknown; state: unknown; startedBy: unknown }>();
    for (const d of state?.domains ?? []) for (const w of d.workspaces ?? []) map.set(key(d.slug, w.workspace), { domain: d.slug, workspace: w.workspace, state: w.state, startedBy: w.startedBy });
    return map;
  };
  const spacesBefore = spaces(before);
  const spacesAfter = spaces(after);
  const stateOf = (value: unknown) => (["planned", "up", "stopped"].includes(String(value)) ? String(value) : null);
  for (const [k, w] of spacesAfter) {
    const old = spacesBefore.get(k);
    const fields = { domain: slugOrNull(w.domain), workspace: slugOrNull(w.workspace), state: stateOf(w.state), startedBy: slugOrNull(w.startedBy) };
    if (!old) out.push(event("workspace-made", "root", fields));
    else if (old.state !== w.state) out.push(event("workspace-state", "root", { ...fields, was: stateOf(old.state) }));
  }
  for (const [k, w] of spacesBefore) if (!spacesAfter.has(k)) out.push(event("workspace-removed", "root", { domain: slugOrNull(w.domain), workspace: slugOrNull(w.workspace), startedBy: slugOrNull(w.startedBy) }));
  // What each checkout has checked out: a `git switch`, or a commit moving its branch.
  const heads = (state: State | null) => {
    const map = new Map<string, { domain: unknown; workspace: unknown; repo: unknown; branch: unknown; commit: unknown }>();
    for (const d of state?.domains ?? []) for (const w of d.workspaces ?? []) for (const c of w.checkouts ?? []) if (c.head) map.set(key(d.slug, w.workspace, c.repo), { domain: d.slug, workspace: w.workspace, repo: c.repo, branch: c.head.branch, commit: c.head.commit });
    return map;
  };
  const headsBefore = heads(before);
  for (const [k, h] of heads(after)) {
    const old = headsBefore.get(k);
    if (!old || old.branch !== h.branch || old.commit !== h.commit)
      out.push(event("head", "root", { domain: slugOrNull(h.domain), workspace: slugOrNull(h.workspace), repo: repoOrNull(h.repo), branch: branchOrNull(h.branch), commit: commitOrNull(h.commit), was: old ? { branch: branchOrNull(old.branch), commit: commitOrNull(old.commit) } : null }));
  }
  // At most PER_CHANGE per domain: one domain's busy change must not push the others' events
  // out (audit, 2026-11-16: the cap was across all domains, before they were split).
  const per = new Map<string, number>();
  return out.filter((e) => {
    const k = String((e as { domain?: unknown }).domain ?? "");
    const n = (per.get(k) ?? 0) + 1;
    per.set(k, n);
    return n <= PER_CHANGE;
  });
};

declare namespace stateEvents {
  /** from no state to one offer: that offer, its names as desolate would make them */
  export type Offered = Expect<
    Invoke<typeof stateEvents, [before: null, after: { offers: [{ domain: "dev"; workspace: "w1"; repo: "acme/app"; branch: "issue/12"; commit: "0123456789abcdef0123456789abcdef01234567" }] }]>,
    "matches",
    [{ v: 1; type: "offered"; source: "root"; domain: "dev"; workspace: "w1"; repo: "acme/app"; branch: "issue/12"; commit: "0123456789abcdef0123456789abcdef01234567" }]
  >;
  /** the same state again: nothing happened, so nothing is said */
  export type Unchanged = Expect<
    Invoke<typeof stateEvents, [before: { offers: [{ domain: "dev"; repo: "acme/app"; branch: "issue/12"; commit: "0123456789abcdef0123456789abcdef01234567" }] }, after: { offers: [{ domain: "dev"; repo: "acme/app"; branch: "issue/12"; commit: "0123456789abcdef0123456789abcdef01234567" }] }]>,
    "=",
    []
  >;
  /** an offer that moved to another commit is a new offer and the old one gone */
  export type Moved = Expect<
    Invoke<typeof stateEvents, [before: { offers: [{ domain: "dev"; repo: "acme/app"; branch: "issue/12"; commit: "0123456789abcdef0123456789abcdef01234567" }] }, after: { offers: [{ domain: "dev"; repo: "acme/app"; branch: "issue/12"; commit: "89abcdef0123456789abcdef0123456789abcdef" }] }]>,
    "matches",
    [{ type: "offered"; commit: "89abcdef0123456789abcdef0123456789abcdef" }, { type: "offer-gone"; commit: "0123456789abcdef0123456789abcdef01234567" }]
  >;
  /** what a domain wrote is carried only as desolate's own names, else null; a refusal's
   *  reason is printable text */
  export type HostileNames = Expect<
    Invoke<typeof stateEvents, [before: null, after: {
      offers: [{ domain: "Dev"; workspace: "-w"; repo: "../x"; branch: "--upload-pack=touch x"; commit: "HEAD" }];
      refused: [{ domain: "dev"; repo: "acme/app"; why: "bad bundle\u001b]52;c;eA==\u0007" }];
    }]>,
    "matches",
    [
      { type: "offered"; domain: null; workspace: null; repo: null; branch: null; commit: null },
      { type: "bundle-refused"; domain: "dev"; why: "bad bundle?]52;c;eA==?" },
    ]
  >;
  /** a status said again with a new time, and one in a colour with no meaning: each an event,
   *  the colour null and the message printable */
  export type Status = Expect<
    Invoke<typeof stateEvents, [
      before: { domains: [{ slug: "dev"; workspaces: [{ workspace: "w1"; says: { status: { color: "green"; message: "ok"; updated: "1" } } }] }] },
      after: { domains: [{ slug: "dev"; workspaces: [{ workspace: "w1"; says: { status: { color: "green"; message: "ok"; updated: "2" } } }, { workspace: "w2"; says: { status: { color: "javascript:x"; message: "a\u202eb"; updated: "1" } } }] }] },
    ]>,
    "matches",
    [
      { type: "status"; workspace: "w1"; color: "green"; message: "ok" },
      { type: "status"; workspace: "w2"; color: null; message: "a?b" },
      { type: "workspace-made"; workspace: "w2" },
    ]
  >;
  /** an issue offered, then published: its page only if it is a GitHub issue's */
  export type Issues = Expect<
    Invoke<typeof stateEvents, [
      before: { issues: [{ id: "abc123-0a1b2c3d"; state: "offered" }, { id: "def456-0a1b2c3d"; state: "offered" }] },
      after: { issues: [{ id: "abc123-0a1b2c3d"; domain: "dev"; state: "published"; title: "Fix it"; url: "https://github.com/acme/app/issues/12" }, { id: "def456-0a1b2c3d"; domain: "dev"; state: "published"; title: "Other"; url: "javascript:alert(1)" }] },
    ]>,
    "matches",
    [
      { type: "issue-published"; id: "abc123-0a1b2c3d"; title: "Fix it"; url: "https://github.com/acme/app/issues/12" },
      { type: "issue-published"; id: "def456-0a1b2c3d"; title: "Other"; url: null },
    ]
  >;
  /** a workspace started by another, then stopped, then removed: who started it travels with
   *  each, so the one that asked can follow it */
  export type Workspaces = [
    Expect<
      Invoke<typeof stateEvents, [before: { domains: [{ slug: "dev"; workspaces: [] }] }, after: { domains: [{ slug: "dev"; workspaces: [{ workspace: "helper"; state: "up"; startedBy: "w1" }] }] }]>,
      "matches",
      [{ type: "workspace-made"; domain: "dev"; workspace: "helper"; state: "up"; startedBy: "w1" }]
    >,
    Expect<
      Invoke<typeof stateEvents, [before: { domains: [{ slug: "dev"; workspaces: [{ workspace: "helper"; state: "up"; startedBy: "w1" }] }] }, after: { domains: [{ slug: "dev"; workspaces: [{ workspace: "helper"; state: "stopped"; startedBy: "w1" }] }] }]>,
      "matches",
      [{ type: "workspace-state"; workspace: "helper"; state: "stopped"; was: "up" }]
    >,
    Expect<
      Invoke<typeof stateEvents, [before: { domains: [{ slug: "dev"; workspaces: [{ workspace: "helper"; state: "stopped"; startedBy: "w1" }] }] }, after: { domains: [{ slug: "dev"; workspaces: [] }] }]>,
      "matches",
      [{ type: "workspace-removed"; workspace: "helper"; startedBy: "w1" }]
    >,
  ];
  /** a commit moving a checkout's branch: where it is, and where it was */
  export type Head = Expect<
    Invoke<typeof stateEvents, [
      before: { domains: [{ slug: "dev"; workspaces: [{ workspace: "w1"; state: "up"; checkouts: [{ repo: "acme/app"; head: { branch: "main"; commit: "0123456789abcdef0123456789abcdef01234567" } }] }] }] },
      after: { domains: [{ slug: "dev"; workspaces: [{ workspace: "w1"; state: "up"; checkouts: [{ repo: "acme/app"; head: { branch: "main"; commit: "89abcdef0123456789abcdef0123456789abcdef" } }] }] }] },
    ]>,
    "matches",
    [{ type: "head"; repo: "acme/app"; branch: "main"; commit: "89abcdef0123456789abcdef0123456789abcdef"; was: { branch: "main"; commit: "0123456789abcdef0123456789abcdef01234567" } }]
  >;
  /** at most 200 events per domain from one change: one busy domain does not push out
   *  another's */
  export type PerDomain = Expect<
    Invoke<typeof perDomain, [events: Invoke<typeof stateEvents, [before: null, after: Invoke<typeof offersIn, [counts: { busy: 250; quiet: 1 }]>]>]>,
    "=",
    { busy: 200; quiet: 1 }
  >;
}

