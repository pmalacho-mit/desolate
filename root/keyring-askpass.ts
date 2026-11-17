// See keyring-askpass (the wrapper) and keyring.ts. Allows a write-key signature only if a
// person's approval for that repository is on file.
import * as fs from "node:fs";
import { ask } from "./keyring-client.ts";
import { KEYRING } from "./layout.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Table } from "../../suede.nests/dsl.import.meta.vitest.ts";

/** The repository a signature is for, from ssh-agent's prompt, which carries the key's
 *  comment (keyring.ts, commentOf); null when the key is not one of desolate's write keys. */
export const writeKeyOf = (prompt: string): string | null =>
  /desolate-write:([A-Za-z0-9_][A-Za-z0-9._-]*\/[A-Za-z0-9_][A-Za-z0-9._-]*)/.exec(prompt)?.[1] ?? null;

declare namespace writeKeyOf {
  /** ssh-agent's question, as it asks it for a write key */
  export type WriteKey = Table<typeof writeKeyOf, [
    [args: [prompt: "Allow use of key desolate-write:acme/app?\nKey fingerprint SHA256:abc."], expected: "acme/app"],
    [args: [prompt: "Allow use of key desolate-write:pmalacho-mit/suede.nests?"], expected: "pmalacho-mit/suede.nests"],
  ]>;
  /** a read key, a key of anyone else's, no prompt: not a write key, and refused (the keyring
   *  is not even asked) */
  export type NotAWriteKey = Table<typeof writeKeyOf, [
    [args: [prompt: "Allow use of key desolate-read:acme/app?"], expected: null],
    [args: [prompt: "Allow use of key ada@laptop?"], expected: null],
    [args: [prompt: "Allow use of key desolate-write:acme?"], expected: null],
    [args: [prompt: ""], expected: null],
  ]>;
}

const main = async () => {
  const repo = writeKeyOf(process.argv[2] ?? "");
  if (!repo) {
    console.error("keyring-askpass: the key being used is not one of desolate's write keys; refusing");
    process.exit(1);
  }
  try {
    const reply = await ask(KEYRING.internal, { op: "consume", repo }, 5000);
    process.exit(reply.ok === true ? 0 : 1);
  } catch (error) {
    console.error(`keyring-askpass: ${String(error)}; refusing`);
    process.exit(1);
  }
};

// Run by the write agent (ssh-agent's SSH_ASKPASS: keyring-askpass, a wrapper that runs node
// with this file's path); imported, it does nothing.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === new URL(import.meta.url).pathname) await main();
