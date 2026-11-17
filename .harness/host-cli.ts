// Harness for in-source tests of the desolate command (host/cli.ts): it stands in for the
// person's terminal, keeping what a call prints to stdout instead of printing it (the help is
// ninety lines a test run need not show).

/** `run(...args)`, awaited: what it answered, and everything it wrote to stdout meanwhile. */
export const printed = async (run: (...args: any[]) => unknown, args: unknown[] = []): Promise<{ value: unknown; stdout: string }> => {
  const write = process.stdout.write;
  let stdout = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    return { value: await run(...args), stdout };
  } finally {
    process.stdout.write = write;
  }
};
