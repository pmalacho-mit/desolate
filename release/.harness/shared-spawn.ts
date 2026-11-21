// Harness for the in-source tests of shared/spawn.ts: commands and checkouts too long to
// write out in a test.

/** `count` words, each `word` (or `x`) repeated to `length` characters' worth. */
export const wordsOf = (count: number, length: number, word = "x"): string[] =>
  Array.from({ length: count }, () => word.repeat(length));
