// Harness for the in-source tests of shared/text.ts: text too long to write out in a test
// (a flood), and the keeper `failure` hands an error's whole text to. The real keepers write
// a file (the host under its logs, the root under its state) and answer its path.

/** `text`, `count` times over: a megabyte of it stands in for a flood. */
export const repeat = (text: string, count: number): string => text.repeat(count);

/** A keeper that kept the whole text at `path`. */
export const keptAt = (path: string) => (): string | null => path;

/** A keeper that could not keep it: a full disk, a folder that is not there. */
export const notKept = () => (): string | null => {
  throw new Error("ENOSPC: no space left on device");
};
