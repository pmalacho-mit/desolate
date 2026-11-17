// Harness for the in-source tests of release/host/image.ts: a release folder of a few files,
// made in the test file's own home (tests/nests/setup.ts), where the real one is the checkout's
// release/. Imported by the tests as types only, so nothing here reaches the release
// (release/nests-harness.d.ts).
import * as fs from "node:fs";
import * as path from "node:path";

/** A release folder named `name` under the home, holding `files` (path: text) and nothing
 *  else: made again from nothing each time. Its path. */
export const releaseWith = (name: string, files: Record<string, string>): string => {
  const dir = path.join(process.env.DESOLATE_HOME!, name);
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  return dir;
};
