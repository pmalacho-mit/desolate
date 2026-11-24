// Harness for the in-source tests of shared/text.ts: the keeper `failure` hands an error's
// whole text to. The real keepers write a file (the host under its logs, the root under its
// state) and answer its path. (Text too long to write out in a test is the DSL's Repeat.)

/** A keeper that kept the whole text at `path`. */
export const keptAt = (path: string) => (): string | null => path;

/** A keeper that could not keep it: a full disk, a folder that is not there. */
export const notKept = () => (): string | null => {
  throw new Error("ENOSPC: no space left on device");
};
