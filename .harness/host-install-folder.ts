// Harness for in-source tests of host/install-folder.ts. It stands in for the folder desolate is
// installed in: a new folder under the test file's home holding `files`, which `check` is
// given. What comes back names that folder `<dir>`.
import * as fs from "node:fs";
import * as path from "node:path";

export const sharedFolderWith = (
  check: (dir: string) => { why: string; fix: string } | null,
  files: Record<string, string>,
) => {
  const dir = fs.mkdtempSync(path.join(process.env.DESOLATE_HOME!, "install-"));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  const said = check(dir);
  return said && { why: said.why.split(dir).join("<dir>"), fix: said.fix.split(dir).join("<dir>") };
};
