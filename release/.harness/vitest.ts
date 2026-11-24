// The parts of Vitest the harnesses use. A harness runs only under Vitest, which a development
// checkout has and the release does not, though the release carries these files. So Vitest is
// imported by a name the type checker does not follow (`as string`: node strips it, and the
// import Vitest runs is the ordinary one), and what is used of it is spelled out here. The
// release then type-checks with nothing but release/nests.d.ts (tests/v3/t1/release-alone).
type Vitest = {
  /** Runs `fn` when the current test ends, passed or failed. */
  onTestFinished(fn: () => unknown): void;
  /** Runs `fn` when the current test file ends. */
  afterAll(fn: () => unknown): void;
  vi: {
    stubGlobal(name: string, value: unknown): unknown;
    unstubAllGlobals(): unknown;
    useFakeTimers(): unknown;
    useRealTimers(): unknown;
    runAllTimersAsync(): Promise<unknown>;
  };
};

export const { onTestFinished, afterAll, vi } = (await import("vitest" as string)) as Vitest;
