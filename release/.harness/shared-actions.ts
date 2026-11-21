// Harness for the in-source tests of shared/actions.ts: arguments too long to write out.

/** `length` letters: a title or a name past its bound. */
export const textOf = (length: number): string => "t".repeat(length);

/** `count` repositories, comma-separated, as the dashboard's Create domain sends them. */
export const reposOf = (count: number): string =>
  Array.from({ length: count }, (_, i) => `acme/r${i}`).join(",");
