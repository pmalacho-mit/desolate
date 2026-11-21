// Harness for the in-source tests of host/review-fallback.ts (to be removed with it): it
// stands in for the reviewer in the root that answers the old way, with one JSON object on
// one line, whatever it is asked.

/** A reviewer of the old kind, which says `says` of any push it is asked about. */
export const oldReviewer = (says: unknown) =>
  async function* (_asked: unknown): AsyncGenerator<string> {
    yield `${JSON.stringify(says)}\n`;
  };
