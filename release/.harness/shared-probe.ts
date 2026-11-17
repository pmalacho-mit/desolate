// Harness for the in-source tests of shared/run.ts's waitFor: probes that stand in for a
// service coming up (true from a given call on), one that throws while it is not there yet,
// and one that never comes.

/** A probe that is false until its `n`th call, and true from then on. */
export const trueOnCall = (n: number) => {
  let calls = 0;
  return () => ++calls >= n;
};

/** A probe that throws (a connection refused, say) until its `n`th call, then is true. */
export const throwsUntil = (n: number) => {
  let calls = 0;
  return () => {
    if (++calls < n) throw new Error("ECONNREFUSED");
    return true;
  };
};

/** A probe that is never true. */
export const never = () => () => false;
