// Harness for in-source tests of the root's record (root/record.ts): several processes of the
// root changing it at once, as rootd, the state service, the CLI channel and a push do.
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const RECORD_TS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "root",
  "record.ts",
);
const NODE = ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e"];

/** `takers` processes at once, each offering `each` branches of acme/app for the domain
 *  `acme`, all its own: through record.ts (`locked`), or, the control, by reading the record
 *  and writing it back with no lock, as each domain's offers.json was written before. They
 *  start together (each waits for a file). Answers how many offers the record holds after. */
export const changedAtOnce = async (
  takers: number,
  each: number,
  locked: boolean,
): Promise<number> => {
  const state = process.env.DESOLATE_ROOT_STATE!;
  fs.mkdirSync(state, { recursive: true });
  const go = path.join(state, "go");
  fs.rmSync(go, { force: true });
  const code = `
    import * as fs from "node:fs";
    import * as path from "node:path";
    import { offer, offersOf } from ${JSON.stringify(RECORD_TS)};
    const [taker, each, locked, go] = JSON.parse(process.argv[1]);
    const file = path.join(process.env.DESOLATE_ROOT_STATE, "records", "acme.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    process.stdout.write("ready\\n");
    while (!fs.existsSync(go)) await new Promise((resolve) => setTimeout(resolve, 5));
    for (let i = 0; i < each; i++) {
      const o = { domain: "acme", repo: "acme/app", branch: "b" + taker + "-" + i,
        commit: "0123456789abcdef0123456789abcdef01234567", workspace: "w1", lfs: 0, at: "2026-11-16T12:00:00.000Z" };
      if (locked) await offer(o, {});
      else {
        let kept = { entries: [], refused: [] };
        try { kept = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
        kept.entries.push({ repo: o.repo, branch: o.branch, offered: { commit: o.commit, workspace: o.workspace, lfs: 0, at: o.at } });
        fs.writeFileSync(file + ".tmp" + taker, JSON.stringify(kept));
        fs.renameSync(file + ".tmp" + taker, file);
      }
    }`;
  const started = Array.from({ length: takers }, (_, taker) => {
    const child = spawn(
      process.execPath,
      [...NODE, code, JSON.stringify([taker, each, locked, go])],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    return {
      ready: new Promise<void>((resolve) => child.stdout.once("data", () => resolve())),
      ended: new Promise<void>((resolve, reject) =>
        child.on("close", (status) =>
          status === 0 ? resolve() : reject(new Error(`a taker failed (${status}): ${stderr}`)),
        ),
      ),
    };
  });
  await Promise.race([
    Promise.all(started.map((taker) => taker.ready)),
    ...started.map((taker) => taker.ended),
  ]);
  fs.writeFileSync(go, "");
  await Promise.all(started.map((taker) => taker.ended));
  // (Read as written: what any process reading the record would find.)
  const kept = JSON.parse(fs.readFileSync(path.join(state, "records", "acme.json"), "utf8")) as {
    entries: { offered?: unknown }[];
  };
  return kept.entries.filter((e) => e.offered).length;
};

/** A root clone of `repo` (where the root keeps it, as `Mock<"./layout.ts", typeof
 *  mirrorsAndClonesHere>` puts it) in which the domain `acme`'s branch `fix` is at `moved`,
 *  one commit past `offered`: an agent that committed again after its offer. (Made before
 *  the test's other effects, as a value its steps name: so not wiped by an emptyRoot.) */
export const aBranchPastItsOffer = (repo: string) => {
  const clones = path.join(process.env.DESOLATE_HOME!, "root-vm", "clones");
  fs.mkdirSync(clones, { recursive: true });
  const clone = path.join(fs.realpathSync(clones), repo);
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.invalid",
  };
  const sh = (...args: string[]) =>
    execFileSync("git", ["-C", clone, ...args], { encoding: "utf8", env }).trim();
  fs.rmSync(clone, { recursive: true, force: true });
  fs.mkdirSync(clone, { recursive: true });
  sh("init", "-q", "-b", "main");
  sh("commit", "-q", "--allow-empty", "-m", "offered");
  const offered = sh("rev-parse", "HEAD");
  sh("commit", "-q", "--allow-empty", "-m", "after the offer");
  const moved = sh("rev-parse", "HEAD");
  sh("update-ref", "refs/remotes/acme/fix", moved);
  return { offered, moved };
};

/** shared/limits.ts with a small record, for `Mock<"../shared/limits.ts", typeof smallRecord>`:
 *  three offers to a domain, two pushes kept, and a lock waited for 300 ms. */
export const smallRecord = async (
  importOriginal: () => Promise<typeof import("../shared/limits.ts")>,
) => {
  const real = await importOriginal();
  return { ...real, RECORD: { ...real.RECORD, offers: 3, pushes: 2, lockWaitMs: 300 } };
};

/** A domain's record rewritten in place with `text` (made as long as the file was, with
 *  spaces after it), and its time set back to what it was: a file that looks unchanged to
 *  anything that goes by its inode, size and time. */
export const rewrittenInPlace = (domain: string, text: string) => {
  const file = path.join(process.env.DESOLATE_ROOT_STATE!, "records", `${domain}.json`);
  const before = fs.statSync(file);
  if (Buffer.byteLength(text) > before.size) throw new Error("longer than the file");
  const fd = fs.openSync(file, "r+");
  fs.writeSync(fd, text.padEnd(before.size, " "), 0);
  fs.closeSync(fd);
  fs.utimesSync(file, before.atimeMs / 1000, before.mtimeMs / 1000);
};

/** The names in the records' directory, a set-aside file's time shown as <when>. */
export const recordFiles = (): string[] => {
  try {
    return fs
      .readdirSync(path.join(process.env.DESOLATE_ROOT_STATE!, "records"))
      .map((n) => n.replace(/\.unreadable-.*$/, ".unreadable-<when>"))
      .sort();
  } catch {
    return [];
  }
};

/** No domain's records at all (the rest of the root's state as it was). */
export const noRecords = () =>
  fs.rmSync(path.join(process.env.DESOLATE_ROOT_STATE!, "records"), {
    recursive: true,
    force: true,
  });

/** A domain's record's time set to a whole second, which a file's time can be set back to
 *  exactly (a time with nanoseconds cannot, from node). */
export const atAWholeSecond = (domain: string, second = 1_700_000_000) => {
  const file = path.join(process.env.DESOLATE_ROOT_STATE!, "records", `${domain}.json`);
  fs.utimesSync(file, second, second);
};
