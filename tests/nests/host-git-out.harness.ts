// Harness for in-source tests of the host taking what the git VM leaves in its out-box
// (host/git-vm.ts). It stands in for the git VM: it leaves files (or links, which the git VM
// can make there too) in the out-box under the test file's own home, and reads the answer the
// host leaves for the git VM's helper.
//
// Imported by the tests as types only, so nothing here reaches the release.
import * as fs from "node:fs";
import * as path from "node:path";

const home = () => process.env.DESOLATE_HOME!;
const outBox = () => path.join(home(), "git-out");
const answers = () => path.join(home(), "git-answers");
const ready = () => {
  for (const dir of [outBox(), answers()]) fs.mkdirSync(dir, { recursive: true });
};

/** A file the git VM wrote in its out-box. */
export const leave = (name: string, text: string) => {
  ready();
  fs.writeFileSync(path.join(outBox(), name), text);
};
/** A link the git VM made in its out-box, to a file of the host's (a path under the home). */
export const leaveLink = (name: string, target: string) => {
  ready();
  fs.symlinkSync(path.join(home(), target), path.join(outBox(), name));
};
/** The host's answer to request `id`, as the git VM's helper reads it; null if there is none. */
export const answerTo = (id: string): unknown => {
  try {
    return JSON.parse(fs.readFileSync(path.join(answers(), `${id}.json`), "utf8"));
  } catch {
    return null;
  }
};
/** What is still in the out-box, sorted. */
export const outbox = (): string[] => fs.readdirSync(outBox()).sort();
