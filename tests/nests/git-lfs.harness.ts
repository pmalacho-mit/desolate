// Harness for lfs-file.ts's tests: the two LFS stores the git VM reads (the mirror's, the
// root clone's) and a clone's .git, stood in for by a temporary directory removed when the
// test finishes; and two stand-ins for fetchOne, for the protocol's tests.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { onTestFinished } from "vitest";

type Fetch = (oid: string, size: number, stores: string[], gitDir: string) => string | null;
/** An object in a store: a file of that content at the oid's place, a link there to a file
 *  of that content elsewhere, or a directory there. */
type Placed = [store: "mirror" | "root", oid: string, content: string, kind: "file" | "link" | "dir"];

/** What `fetch` copied out (read back), and how many files it left in the clone's LFS temp
 *  directory besides it. */
export const fetchedFrom = (fetch: Fetch, objects: Placed[], oid: string, size: number): { copied: string | null; leftovers: number } => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desolate-lfs-"));
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stores = { mirror: path.join(dir, "mirror"), root: path.join(dir, "root") };
  for (const [store, at, content, kind] of objects) {
    const place = path.join(stores[store], at.slice(0, 2), at.slice(2, 4), at);
    fs.mkdirSync(path.dirname(place), { recursive: true });
    if (kind === "dir") fs.mkdirSync(place);
    else if (kind === "file") fs.writeFileSync(place, content);
    else {
      fs.writeFileSync(path.join(dir, "elsewhere"), content);
      fs.symlinkSync(path.join(dir, "elsewhere"), place);
    }
  }
  const gitDir = path.join(dir, "clone", ".git");
  const file = fetch(oid, size, [stores.mirror, stores.root], gitDir);
  const tmp = path.join(gitDir, "lfs", "tmp");
  const copied = file === null ? null : fs.readFileSync(file, "utf8");
  return { copied, leftovers: fs.readdirSync(tmp).filter((name) => path.join(tmp, name) !== file).length };
};

/** A fetchOne that finds every object, at a path named for it. */
export const holdsEverything = (oid: string) => `/lfs/tmp/${oid}`;
/** A fetchOne that finds none. */
export const holdsNothing = (): string | null => null;
