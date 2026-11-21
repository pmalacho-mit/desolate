// Harness for the in-source tests of workspace/step.ts: a step that takes a given time, and
// what it said meanwhile.
import { saying } from "../workspace/step.ts";

/** Runs a step named `what` whose work takes `workMs` and answers "done", with a beat every
 *  `beatMs`: the work's answer, and each line the step said. */
export const saidDuring = async (
  what: string,
  workMs: number,
  beatMs: number,
): Promise<{ answer: string; said: string[] }> => {
  const said: string[] = [];
  const answer = await saying(
    what,
    () => new Promise<string>((resolve) => setTimeout(() => resolve("done"), workMs)),
    (line) => said.push(line),
    beatMs,
  );
  return { answer, said };
};
