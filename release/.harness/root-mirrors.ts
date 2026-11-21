// Harness for in-source tests of the root's mirrors and of what it reads from a domain's
// out-box (root/git.ts, repos.ts, outbox.ts, intake.ts): what the root kept, and files a
// domain could leave, in the shape a test names. Beside root-state.ts, whose root this
// shares.
import * as fs from "node:fs";
import * as path from "node:path";
import { pathIn } from "./root-state.ts";

type Where = Parameters<typeof pathIn>[0];

/** The text of the one file in a directory under one of the root's: what was kept there.
 *  Throws when there is none, or more than one. */
export const theOnlyFileIn = (where: Where, dir: string): string => {
  const names = fs.readdirSync(pathIn(where, dir));
  if (names.length !== 1) throw new Error(`${dir} holds ${names.length} files, not one`);
  return fs.readFileSync(path.join(pathIn(where, dir), names[0]!), "utf8");
};
