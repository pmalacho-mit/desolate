// Harness for the in-source tests of shared/events.ts: it stands in for a busy change of the
// root's state (more offers at once than a literal could list), and counts what came of it
// by domain. Imported by the tests as types only, so nothing here reaches the release.

/** A root state with `count` new offers in each domain named. */
export const offersIn = (counts: Record<string, number>) => ({
  offers: Object.entries(counts).flatMap(([domain, count]) =>
    Array.from({ length: count }, (_, i) => ({ domain, repo: "acme/app", branch: `b${i}`, commit: i.toString(16).padStart(40, "0") })),
  ),
});

/** How many of these events each domain has. */
export const perDomain = (events: Record<string, unknown>[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const e of events) out[String(e.domain)] = (out[String(e.domain)] ?? 0) + 1;
  return out;
};
