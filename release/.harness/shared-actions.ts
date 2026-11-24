// Harness for the in-source tests of shared/actions.ts: arguments too many to write out.

/** `count` repositories, comma-separated, as the dashboard's Create domain sends them. */
export const reposOf = (count: number): string =>
  Array.from({ length: count }, (_, i) => `acme/r${i}`).join(",");
