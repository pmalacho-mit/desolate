// Harness for in-source tests of code that keeps state under the desolate home (host/paths.ts).
// The home is the test file's own (tests/nests/setup.ts). These are imported by the tests as
// types only, so nothing here reaches the release (release/nests-harness.d.ts).
import * as fs from "node:fs";
import * as path from "node:path";

const home = () => process.env.DESOLATE_HOME!;
const state = (name: string) => path.join(home(), "state", name);

/** The home, emptied: no state, no domains, nothing. */
export const emptyHome = () => {
  for (const entry of fs.readdirSync(home())) fs.rmSync(path.join(home(), entry), { recursive: true, force: true });
  fs.mkdirSync(path.join(home(), "state"), { recursive: true });
};

/** Writes a file under the home's state/, as something before the test left it. */
export const writeState = (name: string, text: string) => {
  fs.mkdirSync(path.dirname(state(name)), { recursive: true });
  fs.writeFileSync(state(name), text);
};

/** A file under state/, or null when there is none. */
export const readState = (name: string): string | null => {
  try {
    return fs.readFileSync(state(name), "utf8");
  } catch {
    return null;
  }
};

/** What is in state/, sorted. */
export const stateFiles = (): string[] => fs.readdirSync(path.join(home(), "state")).sort();
