// Harness for sync.ts's tests: shared/run.ts replaced (with Mock) by a git that gives the
// answers the test set out and nothing else. No git runs and there is no repository: what
// the code under test does with git's output is the claim, not git.
import type { RunOptions, RunResult } from "../../release/shared/run.ts";

/** A git command, by how its words start (after `-C <dir>`), and what it prints. */
type Answer = [asked: string, stdout: string];
// On globalThis: the test's effect and the mocked module may each be given a copy of this file.
const ANSWERS = "__desolateNestsGitAnswers";

/** What git answers in this test: the first entry whose words start the command. */
export const gitAnswers = (answers: Answer[]) => {
  (globalThis as Record<string, unknown>)[ANSWERS] = answers;
};

/** The replacement for shared/run.ts. An unscripted command fails, as git would on a
 *  repository that has none of it. */
export const scriptedGit = {
  run: async (command: string, args: string[], _options?: RunOptions): Promise<RunResult> => {
    const words = command === "git" && args[0] === "-C" ? args.slice(2) : args;
    const asked = words.join(" ");
    const answers = ((globalThis as Record<string, unknown>)[ANSWERS] ?? []) as Answer[];
    const found = answers.find(([start]) => asked.startsWith(start));
    return found ? { code: 0, stdout: found[1], stderr: "" } : { code: 1, stdout: "", stderr: `fatal: not scripted: ${command} ${asked}` };
  },
};
