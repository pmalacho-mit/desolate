// Harness for the in-source tests of shared/names.ts: names too long to write out in a test.

/** A branch-shaped name of `length` characters: `b` and then `x`s. */
export const branchOf = (length: number): string => `b${"x".repeat(length - 1)}`;
