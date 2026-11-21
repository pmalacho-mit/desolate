// What a root clone takes in as a bundle (a domain's, from its outbox; the git VM's, from
// the host) is checked, every object, before any of it enters the clone.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { formatBytes, over } from "../shared/limits.ts";
import { printable } from "../shared/text.ts";
import { REFS_BYTES, WHY_MOST } from "./outbox.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Given, Invoke, Table } from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { aBundle } from "../.harness/root-git.ts";
import type { aBundleWithAHeaderOf } from "../.harness/root-mirrors.ts";
import type { emptyRoot } from "../.harness/root-state.ts";
import type { abortedIn } from "../.harness/shared-run.ts";

/** Check every object in a bundle BEFORE any of them enters a root clone (`gitDir`): index its
 *  pack, strictly, into a throwaway object directory that borrows that clone's objects.
 *
 *  `--strict` is git's own fsck, as fatal errors: a tree with ".git" in it (in any case, or
 *  in a form the Mac's or Windows' filesystem would fold to it), a .gitmodules that is a
 *  symlink or names an option or a path that climbs, a malformed or missing object.
 *
 *  Why not rely on fetch.fsckObjects: before git 2.46 a fetch FROM A BUNDLE checked nothing
 *  (measured on the image's 2.43: a tree containing ".git" was imported and offered). This
 *  does not depend on which git the image has. Returns why the bundle is refused, or null. */
export const bundleRefusal = async (
  copy: string,
  gitDir: string,
  signal?: AbortSignal,
): Promise<string | null> => {
  // The header: a v2 bundle, which is what a workspace's git writes. v3 exists to carry
  // capabilities (another hash, a filter that leaves objects out); neither is taken. Its
  // list of refs is the domain's list of branches in another form, and has that bound
  // (outbox.ts, REFS_BYTES); past it, how far it goes is measured, to say so.
  const fd = fs.openSync(copy, "r");
  let end: number;
  let size: number;
  try {
    size = fs.fstatSync(fd).size;
    const magic = Buffer.alloc(16);
    fs.readSync(fd, magic, 0, 16, 0);
    if (magic.toString("latin1") !== "# v2 git bundle\n")
      return "it is not a bundle a workspace's git writes (v2)";
    end = headerEnd(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (end < 0)
    return "it is not a bundle a workspace's git writes (v2): its list of refs never ends";
  if (end > REFS_BYTES)
    return over("its list of refs (the bundle's header)", REFS_BYTES, end, "bytes");
  const quarantine = fs.mkdtempSync(path.join(path.dirname(copy), "check-"));
  fs.mkdirSync(path.join(quarantine, "pack"));
  try {
    const child = spawn("git", ["index-pack", "--strict", "--fix-thin", "--stdin"], {
      stdio: ["pipe", "ignore", "pipe"],
      cwd: path.dirname(gitDir),
      env: {
        ...process.env,
        GIT_DIR: gitDir,
        GIT_OBJECT_DIRECTORY: quarantine,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(gitDir, "objects"),
      },
    });
    // What git says is kept up to a bound (the pack is the domain's, and so, in part, are
    // git's words about it): its first error is the one worth reading.
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      if (stderr.length < SAID_MOST) stderr += chunk;
    });
    child.stdin.on("error", () => {});
    fs.createReadStream(copy, { start: end + 2 }).pipe(child.stdin);
    // A pack made to be slow is refused, not waited on.
    const allowed = checkMs(size);
    let late = false;
    const timer = setTimeout(() => {
      late = true;
      child.kill("SIGKILL");
    }, allowed);
    // Whoever asked went away (`signal`): ended, and not taken.
    const asked = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", asked, { once: true });
    if (signal?.aborted) asked();
    const code = await new Promise<number>((resolve) =>
      child.on("close", (status) => resolve(status ?? 1)),
    );
    clearTimeout(timer);
    signal?.removeEventListener("abort", asked);
    if (signal?.aborted) return "whoever asked for it to be checked went away";
    if (late)
      return `checking its objects took longer than ${Math.round(allowed / 60_000)} minutes, the most a bundle of ${formatBytes(size)} is given`;
    if (code === 0) return null;
    // git names what it found ("error: object <id>: hasDotgit: contains '.git'") before its
    // last line ("fatal: fsck error in packed object"): the first is the one worth reading.
    const said = stderr.trim().split("\n");
    const why =
      said.find((line) => line.startsWith("error: ")) ??
      said.pop() ??
      "its objects did not pass git's checks";
    return printable(why.replace(/^error: /, ""), WHY_MOST);
  } finally {
    fs.rmSync(quarantine, { recursive: true, force: true });
  }
};

/** Where a bundle's header ends (the blank line before its pack), or -1: looked for a MiB
 *  at a time, on the root's own copy (of at most a pack's size), so that one past the
 *  bound is said with its size. */
const headerEnd = (fd: number): number => {
  const chunk = Buffer.alloc(1024 * 1024);
  for (let at = 0; ;) {
    const got = fs.readSync(fd, chunk, 0, chunk.length, at);
    if (got < 2) return -1;
    const found = chunk.subarray(0, got).indexOf("\n\n");
    if (found >= 0) return at + found;
    at += got - 1;
  }
};

/** What of git's words about a pack is kept, in characters: its errors come first, and a
 *  pack's worth of them is the domain's text, not git's. */
const SAID_MOST = 64 * 1024;

/** How long checking a bundle's objects may take (R7: a hard bound against the domain,
 *  whose pack it is: one can be made to be slow to check, with deltas on deltas). It grows
 *  with the bundle: a minute, and a second for each MiB beyond that (so the largest bundle
 *  the forge takes, 2 GiB, has 35 minutes). git checks an ordinary pack far faster than a
 *  MiB a second (measured on the M1: see docs/v3/limits/05-mirrors-outbox.md), so a bundle
 *  that is not made to be slow is never near it. It was 8 minutes for any size: a large
 *  bundle could not be taken, and a small one made to be slow held the fetch that long. */
export const checkMs = (bytes: number) => 60_000 + Math.ceil(bytes / (1024 * 1024)) * 1000;

declare namespace checkMs {
  /** a minute for a small bundle; for the largest the forge takes, a second a MiB more */
  export type Grows = Table<
    typeof checkMs,
    [
      [args: [bytes: 4096], expected: 61000],
      [args: [bytes: 104857600], expected: 160000],
      [args: [bytes: 2147483648], expected: 2108000],
    ]
  >;
}

declare namespace bundleRefusal {
  type Clean = Invoke<typeof aBundle, [kind: "clean"]>;
  type DotGit = Invoke<typeof aBundle, [kind: "dotgit"]>;
  /** an ordinary commit's bundle passes: every object is one git's own fsck accepts */
  export type Passes = Expect<
    Invoke<typeof bundleRefusal, [copy: Clean["copy"], gitDir: Clean["gitDir"]]>,
    "=",
    null
  >;
  /** whoever asked went away (the fetch that ran the root's helper ended): the check is
   *  ended, and the bundle is not taken, though it would have passed (Passes, the control) */
  export type AskerGone = Expect<
    Invoke<
      typeof bundleRefusal,
      [copy: Clean["copy"], gitDir: Clean["gitDir"], signal: Invoke<typeof abortedIn, [ms: 0]>]
    >,
    "=",
    "whoever asked for it to be checked went away"
  >;
  /** a tree with a `.git` in it is refused before any of it enters the clone, and git's own
   *  words say why */
  export type DotGitInATree = Expect<
    Invoke<typeof bundleRefusal, [copy: DotGit["copy"], gitDir: DotGit["gitDir"]]>,
    "includes",
    "hasDotgit: contains '.git'"
  >;
  /** only the format a workspace's git writes: v3 (another hash, objects left out) and what
   *  is not a bundle at all are refused by their header */
  export type NotV2 = [
    Expect<
      Invoke<
        typeof bundleRefusal,
        [copy: Invoke<typeof aBundle, [kind: "v3"]>["copy"], gitDir: "/nowhere"]
      >,
      "=",
      "it is not a bundle a workspace's git writes (v2)"
    >,
    Expect<
      Invoke<
        typeof bundleRefusal,
        [copy: Invoke<typeof aBundle, [kind: "text"]>["copy"], gitDir: "/nowhere"]
      >,
      "=",
      "it is not a bundle a workspace's git writes (v2)"
    >,
  ];
  /** a header past its bound is refused as that, with the bound and its size, never as
   *  "not a bundle" */
  export type HeaderOver = Given<
    Invoke<typeof emptyRoot>,
    Expect<
      Invoke<
        typeof bundleRefusal,
        [copy: Invoke<typeof aBundleWithAHeaderOf, [bytes: 4194305]>, gitDir: "/nowhere"]
      >,
      "=",
      "its list of refs (the bundle's header) is 4194305 bytes, over the 4194304 allowed"
    >
  >;
  /** control: one at the bound is read past, to its objects */
  export type HeaderAtTheBound = Given<
    Invoke<typeof emptyRoot>,
    Expect<
      Invoke<
        typeof bundleRefusal,
        [copy: Invoke<typeof aBundleWithAHeaderOf, [bytes: 4194304]>, gitDir: "/nowhere"]
      >,
      "excludes",
      "list of refs"
    >
  >;
}
