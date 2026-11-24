// How each checkout says its work is going (section 5.1): a small JSON file in the domain
// clone's git directory, written from inside a workspace by /desolate/status. The host and
// the root both read those files AS DATA and never run git there (P4). What they say is
// shown, never acted on.
import { CUT, printable, printableLines } from "./text.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { NAMES } from "./limits.ts";
import { isBranch, isCommit } from "./names.ts";
import type { WorkspacePlan } from "./plan.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Given, Invoke, Table } from "../../suede.nests/dsl.import.meta.vitest.ts";
import type {
  dirScratch,
  emptyScratch,
  fifoScratch,
  linkScratch,
  readScratch,
  scratch,
  writeScratch,
} from "../.harness/shared-files.ts";

export type Status = { color: string; message: string; updated: string };
export const COLORS = ["gray", "blue", "green", "yellow", "orange", "red"];

/** A plain file under `base`, opened for reading, or null. `base` is not the workspace's to
 *  change; everything below it is (it is the domain's clone). So:
 *
 *    - the file is opened without following a link at its own name, and what is checked
 *      (a regular file, its size) is checked on the open descriptor, not on the name;
 *    - the file that was opened must be the one that was meant: a directory on the way
 *      that is a link elsewhere is refused. On Linux (the root VM) that is asked of the
 *      kernel about the open descriptor, so there is no moment to swap anything. macOS (the
 *      host) has no such question to ask from node: there the path is resolved again and
 *      must name the same file, same device and inode, as the one that is open.
 *
 *  What is read is shown and never acted on, so the worst a domain can do with the gap that
 *  is left on macOS (a link swapped in and out within one read) is put text from a file
 *  the person can already read in front of that same person. Whoever is given the
 *  descriptor closes it. */
const openUnder = (base: string, file: string): { fd: number; stat: fs.Stats } | null => {
  let fd: number | null = null;
  try {
    const wanted = path.join(fs.realpathSync(base), path.relative(base, file));
    fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return null;
    if (process.platform === "linux") {
      if (fs.readlinkSync(`/proc/self/fd/${fd}`) !== wanted) return null;
    } else {
      const named = fs.lstatSync(wanted);
      if (fs.realpathSync(file) !== wanted || named.dev !== stat.dev || named.ino !== stat.ino)
        return null;
    }
    const opened = { fd, stat };
    fd = null;
    return opened;
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
};

/** The first `most` bytes of a plain file under `base` (as openUnder opens one), or null.
 *  `refuseLarger`: a file of more than `most` bytes is not read at all. */
export const readPlain = (
  base: string,
  file: string,
  most: number,
  refuseLarger: boolean,
): string | null => {
  const opened = openUnder(base, file);
  if (!opened) return null;
  try {
    if (refuseLarger && opened.stat.size > most) return null;
    const buffer = Buffer.alloc(Math.min(opened.stat.size, most));
    return buffer.subarray(0, fs.readSync(opened.fd, buffer, 0, buffer.length, 0)).toString("utf8");
  } catch {
    return null;
  } finally {
    fs.closeSync(opened.fd);
  }
};

declare namespace readPlain {
  /** a file in the domain's clone, read; cut to `most`, or refused past it */
  export type Reads = Given<
    [
      Invoke<typeof emptyScratch>,
      Invoke<typeof writeScratch, [name: "repos/acme/app/.git/note", text: "hello"]>,
    ],
    [
      Expect<
        Invoke<
          typeof readPlain,
          [
            base: Invoke<typeof scratch, [name: "repos"]>,
            file: Invoke<typeof scratch, [name: "repos/acme/app/.git/note"]>,
            most: 100,
            refuseLarger: true,
          ]
        >,
        "=",
        "hello"
      >,
      Expect<
        Invoke<
          typeof readPlain,
          [
            base: Invoke<typeof scratch, [name: "repos"]>,
            file: Invoke<typeof scratch, [name: "repos/acme/app/.git/note"]>,
            most: 3,
            refuseLarger: false,
          ]
        >,
        "=",
        "hel"
      >,
      Expect<
        Invoke<
          typeof readPlain,
          [
            base: Invoke<typeof scratch, [name: "repos"]>,
            file: Invoke<typeof scratch, [name: "repos/acme/app/.git/note"]>,
            most: 3,
            refuseLarger: true,
          ]
        >,
        "=",
        null
      >,
    ]
  >;
  /** the file is a link to the root's own: not read
   *  @principle P4 */
  export type LinkAtTheName = Given<
    [
      Invoke<typeof emptyScratch>,
      Invoke<typeof writeScratch, [name: "roots-own/note", text: "ROOT SECRET"]>,
      Invoke<typeof linkScratch, [name: "repos/acme/app/.git/note", target: "roots-own/note"]>,
    ],
    Expect<
      Invoke<
        typeof readPlain,
        [
          base: Invoke<typeof scratch, [name: "repos"]>,
          file: Invoke<typeof scratch, [name: "repos/acme/app/.git/note"]>,
          most: 100,
          refuseLarger: true,
        ]
      >,
      "=",
      null
    >
  >;
  /** a directory on the way is a link elsewhere: not walked through, though the path does
   *  lead to a file (the control)
   *  @principle P4 */
  export type LinkOnTheWay = Given<
    [
      Invoke<typeof emptyScratch>,
      Invoke<typeof writeScratch, [name: "roots-own/note", text: "ROOT SECRET"]>,
      Invoke<typeof dirScratch, [name: "repos/acme/app"]>,
      Invoke<typeof linkScratch, [name: "repos/acme/app/.git", target: "roots-own"]>,
    ],
    [
      Expect<Invoke<typeof readScratch, [name: "repos/acme/app/.git/note"]>, "=", "ROOT SECRET">,
      Expect<
        Invoke<
          typeof readPlain,
          [
            base: Invoke<typeof scratch, [name: "repos"]>,
            file: Invoke<typeof scratch, [name: "repos/acme/app/.git/note"]>,
            most: 100,
            refuseLarger: true,
          ]
        >,
        "=",
        null
      >,
    ]
  >;
  /** a FIFO is not waited on, and a directory is not a file
   *  @principle P4 */
  export type NotAFile = Given<
    [
      Invoke<typeof emptyScratch>,
      Invoke<typeof fifoScratch, [name: "repos/acme/app/.git/fifo"]>,
      Invoke<typeof dirScratch, [name: "repos/acme/app/.git/dir"]>,
    ],
    [
      Expect<
        Invoke<
          typeof readPlain,
          [
            base: Invoke<typeof scratch, [name: "repos"]>,
            file: Invoke<typeof scratch, [name: "repos/acme/app/.git/fifo"]>,
            most: 100,
            refuseLarger: true,
          ]
        >,
        "=",
        null
      >,
      Expect<
        Invoke<
          typeof readPlain,
          [
            base: Invoke<typeof scratch, [name: "repos"]>,
            file: Invoke<typeof scratch, [name: "repos/acme/app/.git/dir"]>,
            most: 100,
            refuseLarger: true,
          ]
        >,
        "=",
        null
      >,
    ]
  >;
}

/** The most a status file may be, in bytes: a larger one is not a status, and is not read.
 *  What an honest writer makes is far under it: a message of NAMES.status characters, each
 *  written as JSON's longest escape (twelve bytes for a character outside the basic plane),
 *  is 2,400 bytes, beside a colour and a time. A workspace writes the file, and the root
 *  reads every checkout's each second: the bound is on what it will read for each. */
export const STATUS_FILE_BYTES = 8 * 1024;

/** A status file is written by a workspace, which may be hostile: a known colour, one line
 *  of printable text of at most NAMES.status characters (a longer one is cut, and ends in
 *  the mark), a bounded size. */
export const readStatus = (base: string, file: string): Status | null => {
  try {
    const text = readPlain(base, file, STATUS_FILE_BYTES, true);
    if (text === null) return null;
    const data = JSON.parse(text) as Partial<Status>;
    if (!COLORS.includes(String(data.color))) return null;
    return {
      color: String(data.color),
      message: printable(data.message, NAMES.status, " "),
      // A time, as `date -u +%FT%TZ` writes one (20 characters): what is longer is not one.
      updated: String(data.updated ?? "").slice(0, 40),
    };
  } catch {
    return null;
  }
};

declare namespace readStatus {
  /** a known colour and a message made one printable line: what /desolate/status writes */
  export type Reads = Given<
    [
      Invoke<typeof emptyScratch>,
      Invoke<
        typeof writeScratch,
        [
          name: "repos/acme/app/.git/desolate-status.json",
          text: '{"color":"green","message":"tests pass\\u001b[31m\\nnext","updated":"2026-11-16T10:00:00Z"}',
        ]
      >,
    ],
    Expect<
      Invoke<
        typeof readStatus,
        [
          base: Invoke<typeof scratch, [name: "repos"]>,
          file: Invoke<typeof scratch, [name: "repos/acme/app/.git/desolate-status.json"]>,
        ]
      >,
      "=",
      { color: "green"; message: "tests pass [31m next"; updated: "2026-11-16T10:00:00Z" }
    >
  >;
  /** a colour the dashboard has no style for, or a file that is not JSON: no status at all */
  export type Refuses = Given<
    [
      Invoke<typeof emptyScratch>,
      Invoke<
        typeof writeScratch,
        [
          name: "repos/a/.git/desolate-status.json",
          text: '{"color":"javascript:alert(1)","message":"x"}',
        ]
      >,
      Invoke<
        typeof writeScratch,
        [name: "repos/b/.git/desolate-status.json", text: "green: all good"]
      >,
    ],
    [
      Expect<
        Invoke<
          typeof readStatus,
          [
            base: Invoke<typeof scratch, [name: "repos"]>,
            file: Invoke<typeof scratch, [name: "repos/a/.git/desolate-status.json"]>,
          ]
        >,
        "=",
        null
      >,
      Expect<
        Invoke<
          typeof readStatus,
          [
            base: Invoke<typeof scratch, [name: "repos"]>,
            file: Invoke<typeof scratch, [name: "repos/b/.git/desolate-status.json"]>,
          ]
        >,
        "=",
        null
      >,
    ]
  >;
}

/** A checkout's note: Markdown a workspace wrote, its lines kept and made printable. At most
 *  NAMES.noteBytes of it are read (the writer, /desolate/status, cuts a longer one itself and
 *  says so). A file that is longer all the same is shown cut, and the cut is said: it ends
 *  in the mark, on a line of its own, and never in half a character. */
export const readNote = (base: string, file: string): string => {
  const opened = openUnder(base, file);
  if (!opened) return "";
  try {
    const buffer = Buffer.alloc(Math.min(opened.stat.size, NAMES.noteBytes));
    const read = buffer.subarray(0, fs.readSync(opened.fd, buffer, 0, buffer.length, 0));
    const text = printableLines(read.toString("utf8"), " ").trimEnd();
    return opened.stat.size > NAMES.noteBytes ? `${text.replace(/\ufffd+$/, "")}\n${CUT}` : text;
  } catch {
    return "";
  } finally {
    fs.closeSync(opened.fd);
  }
};

declare namespace readNote {
  /** Markdown, lines kept; what a terminal or a page would act on, blanked; none: "" */
  export type Reads = Given<
    [
      Invoke<typeof emptyScratch>,
      Invoke<
        typeof writeScratch,
        [
          name: "repos/acme/app/.git/desolate-note.md",
          text: "# done\n- tests\tpass\n\u001b]0;title\u0007\n\n",
        ]
      >,
    ],
    [
      Expect<
        Invoke<
          typeof readNote,
          [
            base: Invoke<typeof scratch, [name: "repos"]>,
            file: Invoke<typeof scratch, [name: "repos/acme/app/.git/desolate-note.md"]>,
          ]
        >,
        "=",
        "# done\n- tests\tpass\n ]0;title"
      >,
      Expect<
        Invoke<
          typeof readNote,
          [
            base: Invoke<typeof scratch, [name: "repos"]>,
            file: Invoke<typeof scratch, [name: "repos/acme/app/.git/none.md"]>,
          ]
        >,
        "=",
        ""
      >,
    ]
  >;
}
/** Where a checkout's status lives, under a domain's `repos` directory. */
export const statusDir = (reposDir: string, c: { repo: string; kind: string; name: string }) =>
  c.kind === "main"
    ? path.join(reposDir, c.repo, ".git")
    : path.join(reposDir, c.repo, ".git", "worktrees", c.name);

declare namespace statusDir {
  /** the clone's own git directory, or the worktree's under it, where git keeps its HEAD */
  export type Cases = Table<
    typeof statusDir,
    [
      [
        args: [reposDir: "/desolate/repos", c: { repo: "acme/app"; kind: "main"; name: "" }],
        expected: "/desolate/repos/acme/app/.git",
      ],
      [
        args: [reposDir: "/desolate/repos", c: { repo: "acme/app"; kind: "worktree"; name: "w1" }],
        expected: "/desolate/repos/acme/app/.git/worktrees/w1",
      ],
    ]
  >;
}

/** What a checkout has checked out NOW (the plan says only what it started on): read from
 *  its HEAD as data, like its status. `branch` is a name desolate would carry, or null (a
 *  detached HEAD, a rebase under way, or a name it would not carry); `commit` is what that
 *  branch names when its ref is a loose file or in packed-refs, or the detached commit. */
export type Head = { branch: string | null; commit: string | null };
const COMMIT_LINE = /^([0-9a-f]{40})\n$/;
/** Where git keeps the refs it has packed: one file, a line for each ref (`<commit>
 *  refs/heads/<branch>`), which grows with the repository: 5,000 branches are about
 *  350 KiB. It is a domain's file, so an agent can make it any size, and the state service
 *  looks at every checkout each second: so the one ref wanted is looked up, and the file is
 *  never read whole. No size is too large, and none costs more than a few reads.
 *
 *  git writes the file sorted by ref name, and says so in its first line since 2.15 (2017):
 *  such a file is searched by halving, as git itself reads it. One that does not say so (an
 *  older git's, another program's) is read through from its start, line by line, up to
 *  PACKED_UNSORTED_MOST. */
const NEWLINE = 0x0a;
/** What one read takes: room for the end of the line a search landed in, the whole line
 *  after it and that ref's peeled line (`^<commit>`), each at its longest. A line is a
 *  commit, a space, a ref's name and a newline, and a ref's name is a path under `.git`
 *  while it is loose, so no longer than a path may be (4,096 bytes on Linux): 16 KiB holds
 *  three such lines. A longer line is not one git wrote, and no commit is read from it. */
const PACKED_LOOK = 16 * 1024;
/** The most of a packed-refs that does not say it is sorted which is read through for one
 *  ref (R7: the file is a workspace's, and the reader is the root's state service, which
 *  every domain shares). 256 KiB is about 4,000 branches, and was the bound on every
 *  packed-refs before 2026-11-20; it is kept for the only files that still need one. Past
 *  it the branch is shown without its commit. */
const PACKED_UNSORTED_MOST = 256 * 1024;

/** The commit a line of packed-refs gives `ref`, if it is that ref's line. Also how the
 *  line's ref sorts against it (git's order: by byte), or null for a line that names no ref
 *  (the header, a peeled line, anything else). */
const packedLine = (line: Buffer, ref: Buffer): { order: number; commit: string } | null =>
  line.length > 41 && line[40] === 0x20 && line[0] !== 0x23 /* # */ && line[0] !== 0x5e /* ^ */
    ? {
        order: Buffer.compare(line.subarray(41), ref),
        commit: line.subarray(0, 40).toString("latin1"),
      }
    : null;

/** The commit an open packed-refs of `size` bytes has for `ref`, or null. */
const packedCommit = (fd: number, size: number, ref: Buffer): string | null => {
  const block = Buffer.alloc(PACKED_LOOK);
  const read = (at: number) => block.subarray(0, fs.readSync(fd, block, 0, block.length, at));
  const header = read(0);
  const sorted = /^# pack-refs with:.* sorted(?: |$)/.test(
    header.subarray(0, Math.max(0, header.indexOf(NEWLINE))).toString("latin1"),
  );
  if (!sorted && size > PACKED_UNSORTED_MOST) return null;
  // The ref's line, if there is one, starts in [low, high), and `low` is where a line starts.
  let low = 0;
  let high = size;
  // Sorted: halve that range until one read holds every line that starts in it.
  while (sorted && high - low > PACKED_LOOK / 2) {
    const middle = low + Math.floor((high - low) / 2);
    // Read from the byte before the middle, so that the first newline seen ends the line the
    // middle is in (or the one before it): what follows is the first line that starts at or
    // after the middle.
    const seen = read(middle - 1);
    let start = seen.indexOf(NEWLINE) + 1;
    let before: number | null = null;
    while (start > 0 && middle - 1 + start < high) {
      const end = seen.indexOf(NEWLINE, start);
      if (end < 0) break;
      const found = packedLine(seen.subarray(start, end), ref);
      start = end + 1;
      if (!found) continue;
      if (found.order === 0) return isCommit(found.commit) ? found.commit : null;
      if (found.order < 0) before = middle - 1 + start;
      break;
    }
    // That line sorts before the ref: the ref's is after it. Otherwise (it sorts after, or
    // no ref's line starts from the middle on) the ref's starts before the middle.
    if (before === null) high = middle;
    else low = before;
  }
  // Every line that starts in what is left, read in order.
  while (low < high) {
    const seen = read(low);
    let start = 0;
    for (;;) {
      const end = seen.indexOf(NEWLINE, start);
      if (end < 0 || low + start >= high) break;
      const found = packedLine(seen.subarray(start, end), ref);
      if (found?.order === 0) return isCommit(found.commit) ? found.commit : null;
      start = end + 1;
    }
    // No whole line in a read: a line longer than git writes, or a last line with no end.
    if (start === 0) return null;
    low += start;
  }
  return null;
};

/** What was found is remembered until the file changes (its identity, size and time), so
 *  that a look each second is one `lstat`. */
const packedCache = new Map<string, { key: string; commit: string | null }>();
const packedRef = (reposDir: string, file: string, branch: string): string | null => {
  const keyOf = (stat: fs.Stats) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  const name = `${file}\0${branch}`;
  try {
    const known = packedCache.get(name);
    if (known && known.key === keyOf(fs.lstatSync(file))) return known.commit;
  } catch {
    return null;
  }
  const opened = openUnder(reposDir, file);
  if (!opened) return null;
  try {
    const commit = packedCommit(opened.fd, opened.stat.size, Buffer.from(`refs/heads/${branch}`));
    // A bound on the cache, not on what is read: past it, everything is looked up again.
    if (packedCache.size > 500) packedCache.clear();
    packedCache.set(name, { key: keyOf(opened.stat), commit });
    return commit;
  } catch {
    return null;
  } finally {
    fs.closeSync(opened.fd);
  }
};
/** The commit `branch` names in the git directory `common` (its loose ref, else its line in
 *  packed-refs), read as data under `reposDir`, or null. No process: also how the root knows a
 *  mirror's branch has not moved (domains.ts, objectOnDefault). */
export const refCommit = (reposDir: string, common: string, branch: string): string | null => {
  const loose = readPlain(reposDir, path.join(common, "refs", "heads", branch), 128, true);
  if (loose !== null) return COMMIT_LINE.exec(loose)?.[1] ?? null;
  return packedRef(reposDir, path.join(common, "packed-refs"), branch);
};
export const readHead = (
  reposDir: string,
  c: { repo: string; kind: string; name: string },
): Head | null => {
  const text = readPlain(reposDir, path.join(statusDir(reposDir, c), "HEAD"), 512, true);
  // Git ends what it writes there with a newline. Without one, this read caught it half
  // written (a share's file, read from another VM while it is written): unsettled, so
  // null, and the reader keeps what it saw before.
  if (text === null || !text.endsWith("\n")) return null;
  const detached = COMMIT_LINE.exec(text);
  if (detached) return { branch: null, commit: detached[1]! };
  const named = /^ref: refs\/heads\/(\S+)\n$/.exec(text)?.[1];
  if (!isBranch(named)) return { branch: null, commit: null };
  return { branch: named, commit: refCommit(reposDir, path.join(reposDir, c.repo, ".git"), named) };
};

declare namespace readHead {
  /** a branch, and the commit its loose ref names
   *  @principle P4 */
  export type Loose = Given<
    [
      Invoke<typeof emptyScratch>,
      Invoke<
        typeof writeScratch,
        [name: "repos/acme/app/.git/HEAD", text: "ref: refs/heads/issue/12\n"]
      >,
      Invoke<
        typeof writeScratch,
        [
          name: "repos/acme/app/.git/refs/heads/issue/12",
          text: "0123456789abcdef0123456789abcdef01234567\n",
        ]
      >,
    ],
    Expect<
      Invoke<
        typeof readHead,
        [
          reposDir: Invoke<typeof scratch, [name: "repos"]>,
          c: { repo: "acme/app"; kind: "main"; name: "" },
        ]
      >,
      "=",
      { branch: "issue/12"; commit: "0123456789abcdef0123456789abcdef01234567" }
    >
  >;
  /** a worktree's HEAD is its own; its branch's ref is in the clone's packed-refs */
  export type PackedFromAWorktree = Given<
    [
      Invoke<typeof emptyScratch>,
      Invoke<
        typeof writeScratch,
        [name: "repos/acme/app/.git/worktrees/w1/HEAD", text: "ref: refs/heads/main\n"]
      >,
      Invoke<
        typeof writeScratch,
        [
          name: "repos/acme/app/.git/packed-refs",
          text: "# pack-refs with: peeled fully-peeled sorted\n89abcdef0123456789abcdef0123456789abcdef refs/heads/issue/12\n0123456789abcdef0123456789abcdef01234567 refs/heads/main\n",
        ]
      >,
    ],
    Expect<
      Invoke<
        typeof readHead,
        [
          reposDir: Invoke<typeof scratch, [name: "repos"]>,
          c: { repo: "acme/app"; kind: "worktree"; name: "w1" },
        ]
      >,
      "=",
      { branch: "main"; commit: "0123456789abcdef0123456789abcdef01234567" }
    >
  >;
  /** detached: no branch, the commit itself; a branch with no commit yet: no commit */
  export type Detached = Given<
    [
      Invoke<typeof emptyScratch>,
      Invoke<
        typeof writeScratch,
        [name: "repos/a/b/.git/HEAD", text: "0123456789abcdef0123456789abcdef01234567\n"]
      >,
      Invoke<typeof writeScratch, [name: "repos/c/d/.git/HEAD", text: "ref: refs/heads/main\n"]>,
    ],
    [
      Expect<
        Invoke<
          typeof readHead,
          [
            reposDir: Invoke<typeof scratch, [name: "repos"]>,
            c: { repo: "a/b"; kind: "main"; name: "" },
          ]
        >,
        "=",
        { branch: null; commit: "0123456789abcdef0123456789abcdef01234567" }
      >,
      Expect<
        Invoke<
          typeof readHead,
          [
            reposDir: Invoke<typeof scratch, [name: "repos"]>,
            c: { repo: "c/d"; kind: "main"; name: "" },
          ]
        >,
        "=",
        { branch: "main"; commit: null }
      >,
    ]
  >;
  /** caught half written (no newline yet): unsettled, null; a name desolate would not carry
   *  as an argument: no branch and no commit
   *  @principle P4 */
  export type Unsettled = Given<
    [
      Invoke<typeof emptyScratch>,
      Invoke<typeof writeScratch, [name: "repos/a/b/.git/HEAD", text: "ref: refs/heads/ma"]>,
      Invoke<
        typeof writeScratch,
        [name: "repos/c/d/.git/HEAD", text: "ref: refs/heads/--upload-pack=x\n"]
      >,
    ],
    [
      Expect<
        Invoke<
          typeof readHead,
          [
            reposDir: Invoke<typeof scratch, [name: "repos"]>,
            c: { repo: "a/b"; kind: "main"; name: "" },
          ]
        >,
        "=",
        null
      >,
      Expect<
        Invoke<
          typeof readHead,
          [
            reposDir: Invoke<typeof scratch, [name: "repos"]>,
            c: { repo: "c/d"; kind: "main"; name: "" },
          ]
        >,
        "=",
        { branch: null; commit: null }
      >,
    ]
  >;
}

export type StatusView = {
  workspace: string;
  checkouts: {
    repo: string;
    branch: string;
    head: Head | null;
    status: Status | null;
    note: string;
  }[];
  status: Status | null;
};
export const statusView = (reposDir: string, w: WorkspacePlan): StatusView => {
  const checkouts = w.checkouts.map((c) => ({
    repo: c.repo,
    branch: c.branch,
    head: readHead(reposDir, c),
    status: readStatus(reposDir, path.join(statusDir(reposDir, c), "desolate-status.json")),
    note: readNote(reposDir, path.join(statusDir(reposDir, c), "desolate-note.md")),
  }));
  // A workspace's status is its most recently set one.
  const latest =
    checkouts
      .map((c) => c.status)
      .filter((s): s is Status => s !== null)
      .sort((a, b) => b.updated.localeCompare(a.updated))[0] ?? null;
  return { workspace: `${w.domain}/${w.workspace}`, checkouts, status: latest };
};

declare namespace statusView {
  /** each checkout as it stands; the workspace's status is whichever checkout set one last */
  export type Latest = Given<
    [
      Invoke<typeof emptyScratch>,
      Invoke<
        typeof writeScratch,
        [name: "repos/acme/app/.git/HEAD", text: "ref: refs/heads/main\n"]
      >,
      Invoke<
        typeof writeScratch,
        [
          name: "repos/acme/app/.git/desolate-status.json",
          text: '{"color":"yellow","message":"older","updated":"2026-11-16T09:00:00Z"}',
        ]
      >,
      Invoke<
        typeof writeScratch,
        [
          name: "repos/acme/lib/.git/worktrees/w1/desolate-status.json",
          text: '{"color":"green","message":"newer","updated":"2026-11-16T10:00:00Z"}',
        ]
      >,
      Invoke<
        typeof writeScratch,
        [name: "repos/acme/lib/.git/worktrees/w1/desolate-note.md", text: "done\n"]
      >,
    ],
    Expect<
      Invoke<
        typeof statusView,
        [
          reposDir: Invoke<typeof scratch, [name: "repos"]>,
          w: {
            domain: "acme";
            workspace: "w1";
            vm: "dsl-t-0";
            title: "w1";
            fetch: false;
            createdAt: "2026-11-16T08:00:00Z";
            checkouts: [
              {
                repo: "acme/app";
                kind: "main";
                name: "";
                branch: "main";
                base: "origin/main";
                path: "/workspaces/acme/app";
              },
              {
                repo: "acme/lib";
                kind: "worktree";
                name: "w1";
                branch: "task/w1";
                base: "origin/main";
                path: "/workspaces/acme/lib/.worktrees/w1";
              },
            ];
          },
        ]
      >,
      "=",
      {
        workspace: "acme/w1";
        checkouts: [
          {
            repo: "acme/app";
            branch: "main";
            head: { branch: "main"; commit: null };
            status: { color: "yellow"; message: "older"; updated: "2026-11-16T09:00:00Z" };
            note: "";
          },
          {
            repo: "acme/lib";
            branch: "task/w1";
            head: null;
            status: { color: "green"; message: "newer"; updated: "2026-11-16T10:00:00Z" };
            note: "done";
          },
        ];
        status: { color: "green"; message: "newer"; updated: "2026-11-16T10:00:00Z" };
      }
    >
  >;
}
