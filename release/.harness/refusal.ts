// Harness for in-source tests of refusals (shared/exit.ts, `refuse`): what the person is told
// when a call is refused, all of it. A Throws matcher reads only an error's message; a refusal
// also says what to do (`fix`) and which exit code a script sees, and those are part of what it
// promises.

/** `f(...args)`, awaited: its refusal's message, fix and exit code, or null when it was not
 *  refused. Any other error is thrown on, failing the test. (`any`: a function of any
 *  arguments, given them as the test names them.) */
export const refusalOf = async (f: (...args: any[]) => unknown, args: unknown[] = []): Promise<{ message: string; fix: string; code: number } | null> => {
  try {
    await f(...args);
    return null;
  } catch (error) {
    // By its fields, not `instanceof`: the module under test may have a copy of shared/exit.ts
    // of its own (each test gets its own copy of the modules it imports).
    const e = error as { message?: unknown; fix?: unknown; code?: unknown };
    if (typeof e.fix !== "string" || typeof e.code !== "number") throw error;
    return { message: String(e.message), fix: e.fix, code: e.code };
  }
};
