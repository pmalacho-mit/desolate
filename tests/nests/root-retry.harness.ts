// Harness for in-source tests of how the root's user waits for a process that is one request
// per process (root/send.ts's pusher, root/review-client.ts's reviewer): between two, the next
// is starting, and its socket is missing or refuses for a moment. An attempt, scripted: each
// call has the next outcome, a failure with an errno code or an answer. Imported by the tests
// as types only, so nothing here reaches the release (release/nests-harness.d.ts).

type Outcome = { fails: string; connected?: boolean } | Record<string, unknown>;

/** An attempt that, call by call, fails with `{fails: <errno code>}` (and `connected`: whether
 *  the request had reached the other side) or answers with the value given. `calls()` says how
 *  many times it was tried. */
export const attemptsThat = (outcomes: Outcome[]) => {
  let calls = 0;
  const attempt = async () => {
    const next = outcomes[Math.min(calls++, outcomes.length - 1)]!;
    if (typeof next.fails === "string") throw Object.assign(new Error(`connect ${next.fails}`), { code: next.fails, connected: next.connected === true });
    return next;
  };
  return { attempt, calls: () => calls };
};
