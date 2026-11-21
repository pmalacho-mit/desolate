// Harness for the in-source tests of shared/issues.ts: drafts too long to write out in a test.

/** A draft for acme/app whose title is `text`, `count` times over. */
export const titled = (text: string, count: number) => ({
  repo: "acme/app",
  title: text.repeat(count),
});

/** A draft for acme/app whose body is `text`, `count` times over. */
export const bodied = (text: string, count: number) => ({
  repo: "acme/app",
  title: "x",
  body: text.repeat(count),
});
