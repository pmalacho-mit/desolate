// Harness for the in-source tests of shared/suede.ts: a git that answers from a table, in place
// of the caller's real one in its own repository. Each key is a command line's arguments
// joined by spaces; what it maps to is that command's stdout, with code 0. Any other command
// fails, as git does for a commit or a path it does not have.

export const gitAnswering = (answers: Record<string, string>) => async (args: string[]) => {
  const stdout = answers[args.join(" ")];
  return stdout === undefined ? { code: 1, stdout: "" } : { code: 0, stdout };
};
