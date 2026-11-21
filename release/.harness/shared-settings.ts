// Harness for the in-source tests of shared/settings.ts: what `desolate settings` does with
// the registry, as far as a test needs it. A setting holds functions (its parser, perhaps its
// default), which a test cannot compare; its name it can.
import * as fs from "node:fs";
import * as path from "node:path";
import { onTestFinished } from "./vitest.ts";

/** The names of `settings`, in their order. */
export const namesOf = (settings: readonly { name: string }[]): string[] =>
  settings.map((setting) => setting.name);

/** The person's stored settings (shared/settings.ts storeFile "host", under this test file's
 *  home), as `text`: what `desolate settings set` wrote, or a file edited by hand. Gone
 *  again when the test ends: the next test starts with nothing stored. */
export const storeText = (text: string) => {
  const file = path.join(process.env.DESOLATE_HOME!, "settings.json");
  onTestFinished(() => fs.rmSync(file, { force: true }));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
