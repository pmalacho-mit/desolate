// Harness for the in-source tests of shared/review-account.ts: it stands in for the
// connection the reviewer's answer arrives on, which hands over bytes in chunks cut anywhere
// (inside a line, inside a character), and for a reviewer that writes a line with no end.

/** A stream of `parts`, each a chunk, one byte a character: so a test can end a chunk
 *  between the two bytes of one UTF-8 character. */
export async function* chunks(parts: string[]): AsyncGenerator<Buffer> {
  for (const part of parts) yield Buffer.from(part, "latin1");
}

/** A line with no end: `bytes` of it, a megabyte at a time, and then a failure if any more
 *  is asked for: a reader that stops at its bound never asks. */
export async function* longLine(bytes: number): AsyncGenerator<Buffer> {
  for (let sent = 0; sent < bytes; sent += 1_000_000)
    yield Buffer.alloc(Math.min(1_000_000, bytes - sent), "x");
  throw new Error("the reader went on reading a line past its bound");
}

/** A stream of `parts` that then fails, as a connection reset under its reader does. */
export async function* failsAfter(parts: string[], error: string): AsyncGenerator<Buffer> {
  for (const part of parts) yield Buffer.from(part, "latin1");
  throw new Error(error);
}

/** Everything a stream of lines gives, in order. */
export const all = async <T>(lines: AsyncIterable<T>): Promise<T[]> => {
  const got: T[] = [];
  for await (const line of lines) got.push(line);
  return got;
};
