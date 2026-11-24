// Harness for the in-source tests of host/terminal-filter.ts: an agent's output as it
// arrives, in reads that split it wherever they happen to (a socket's chunks), through one
// filter.

/** `chunks` through one filter from `make`, in order, as one text. */
export const inChunks = (make: () => (chunk: Buffer) => Buffer, chunks: string[]): string => {
  const filter = make();
  return Buffer.concat(chunks.map((chunk) => filter(Buffer.from(chunk, "utf8")))).toString("utf8");
};

/** The bytes of `text`, split into reads of one byte each: the worst a read can do. */
export const byteByByte = (make: () => (chunk: Buffer) => Buffer, text: string): string => {
  const filter = make();
  return Buffer.concat(
    [...Buffer.from(text, "utf8")].map((byte) => filter(Buffer.from([byte]))),
  ).toString("utf8");
};
