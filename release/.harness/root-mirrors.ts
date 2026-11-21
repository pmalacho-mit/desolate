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

/** A bundle's copy, in the root's state, whose header (its list of refs) is `bytes` long
 *  before the blank line that ends it, and a pack that is no pack. Its path. */
export const aBundleWithAHeaderOf = (bytes: number): string => {
  const file = pathIn("state", `incoming/header-${bytes}.bundle`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const magic = "# v2 git bundle\n";
  const line = `${"0".repeat(40)} refs/heads/b\n`;
  let header = magic + line.repeat(Math.floor((bytes - magic.length) / line.length));
  header += "x".repeat(bytes - header.length);
  fs.writeFileSync(file, `${header}\n\nPACK`);
  return file;
};
