// Harness for in-source tests of code that waits on timers (a retry's pause, a step's beat):
// it runs the code on Vitest's fake clock, so a test takes no time and cannot be late. The
// DSL's FakeTimers cannot do this for an async call: a Given awaits the call before an
// AdvanceTimers after it runs, and the call waits on a timer that nothing moves.
import { onTestFinished, vi } from "./vitest.ts";

/** What `run` answers (or the error it rejects with) given `args`, on a fake clock that every
 *  timer it sets falls due on, in order, until none is left. */
export const onFakeTime = async (
  run: (...args: any[]) => Promise<any>,
  ...args: any[]
): Promise<any> => {
  vi.useFakeTimers();
  onTestFinished(() => vi.useRealTimers());
  const answer = run(...args);
  answer.catch(() => {});
  await vi.runAllTimersAsync();
  return answer;
};
