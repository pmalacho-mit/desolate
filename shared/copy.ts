// Files another side wrote, taken in: the host from the git VM's out-box (host/git-vm.ts), the
// root from what the host handed it (root/ops.ts, git.push). Each opens without following a
// link and without blocking (a FIFO in a file's place would hang the reader), checks what it
// opened (fstat, not the name: the name may change between a look and an open), reads at
// most the size that check saw, and COPIES into a new file of its own, hashing on the way, so
// what is hashed is what is kept.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Given, Invoke, Throws } from "../../suede.nests/dsl.import.meta.vitest.ts";
import type {
  dirScratch,
  emptyScratch,
  fifoScratch,
  linkScratch,
  opened,
  readScratch,
  scratch,
  scratchFiles,
  writeScratch,
} from "../.harness/shared-files.ts";

const OPEN = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;

/** A plain file, opened without following a link; null if it is not one, or is over `most`. */
export const openPlain = (file: string, most: number): { fd: number; size: number } | null => {
  let fd: number;
  try {
    fd = fs.openSync(file, OPEN);
  } catch {
    return null;
  }
  const stat = fs.fstatSync(fd);
  if (!stat.isFile() || stat.size > most) {
    fs.closeSync(fd);
    return null;
  }
  return { fd, size: stat.size };
};

declare namespace openPlain {
  /** a plain file is opened, and its size is the one seen on the descriptor */
  export type Opens = Given<
    [Invoke<typeof emptyScratch>, Invoke<typeof writeScratch, [name: "out/bundle", text: "hello"]>],
    Expect<
      Invoke<typeof openPlain, [file: Invoke<typeof scratch, [name: "out/bundle"]>, most: 5]>,
      "matches",
      { size: 5 }
    >
  >;
  /** what the other side may put in a file's place: a link (to a file that is fine to read,
   *  so only the link is refused), a FIFO (opened without waiting for a writer), a
   *  directory, nothing, or a file over the size asked for */
  export type Refuses = Given<
    [
      Invoke<typeof emptyScratch>,
      Invoke<typeof writeScratch, [name: "real", text: "hello"]>,
      Invoke<typeof linkScratch, [name: "out/link", target: "real"]>,
      Invoke<typeof fifoScratch, [name: "out/fifo"]>,
      Invoke<typeof dirScratch, [name: "out/dir"]>,
    ],
    [
      Expect<
        Invoke<typeof openPlain, [file: Invoke<typeof scratch, [name: "out/link"]>, most: 100]>,
        "=",
        null
      >,
      Expect<
        Invoke<typeof openPlain, [file: Invoke<typeof scratch, [name: "out/fifo"]>, most: 100]>,
        "=",
        null
      >,
      Expect<
        Invoke<typeof openPlain, [file: Invoke<typeof scratch, [name: "out/dir"]>, most: 100]>,
        "=",
        null
      >,
      Expect<
        Invoke<typeof openPlain, [file: Invoke<typeof scratch, [name: "out/none"]>, most: 100]>,
        "=",
        null
      >,
      Expect<
        Invoke<typeof openPlain, [file: Invoke<typeof scratch, [name: "real"]>, most: 4]>,
        "=",
        null
      >,
    ]
  >;
}

/** Copy from a descriptor into a new file (never an existing one, never through a link),
 *  hashing on the way; exactly `size` bytes, what the descriptor said it held. Its sha256. */
export const copyOut = (from: { fd: number; size: number }, to: string, mode = 0o600): string => {
  const out = fs.openSync(
    to,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    mode,
  );
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    for (let done = 0; done < from.size;) {
      const read = fs.readSync(from.fd, buffer, 0, Math.min(buffer.length, from.size - done), done);
      if (read === 0) throw new Error("the file got shorter while it was copied");
      hash.update(buffer.subarray(0, read));
      fs.writeSync(out, buffer, 0, read);
      done += read;
    }
  } finally {
    fs.closeSync(out);
  }
  return hash.digest("hex");
};

declare namespace copyOut {
  /** the copy's sha256 is that of the bytes written: "hello"'s */
  export type Hashes = Given<
    [Invoke<typeof emptyScratch>, Invoke<typeof writeScratch, [name: "from", text: "hello"]>],
    Expect<
      Invoke<
        typeof copyOut,
        [from: Invoke<typeof opened, [name: "from"]>, to: Invoke<typeof scratch, [name: "to"]>]
      >,
      "=",
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    >
  >;
  /** exactly the size the descriptor was opened with: what was hashed is what is kept */
  export type Copies = Given<
    [
      Invoke<typeof emptyScratch>,
      Invoke<typeof writeScratch, [name: "from", text: "hello"]>,
      Invoke<
        typeof copyOut,
        [
          from: { fd: Invoke<typeof opened, [name: "from"]>["fd"]; size: 3 },
          to: Invoke<typeof scratch, [name: "to"]>,
        ]
      >,
    ],
    Expect<Invoke<typeof readScratch, [name: "to"]>, "=", "hel">
  >;
  /** never into a file that is there, nor through a link put where the copy goes */
  export type NewFileOnly = Given<
    [
      Invoke<typeof emptyScratch>,
      Invoke<typeof writeScratch, [name: "from", text: "hello"]>,
      Invoke<typeof writeScratch, [name: "there", text: "kept"]>,
      Invoke<typeof linkScratch, [name: "link", target: "elsewhere"]>,
    ],
    [
      Throws<
        Invoke<
          typeof copyOut,
          [from: Invoke<typeof opened, [name: "from"]>, to: Invoke<typeof scratch, [name: "there"]>]
        >,
        "EEXIST"
      >,
      Throws<
        Invoke<
          typeof copyOut,
          [from: Invoke<typeof opened, [name: "from"]>, to: Invoke<typeof scratch, [name: "link"]>]
        >,
        "EEXIST"
      >,
      Expect<Invoke<typeof scratchFiles>, "=", ["from", "link", "there"]>,
    ]
  >;
}

/** An object named by its sha256, taken from `from` to `to` only if it hashes to its name:
 *  through a `.part` file beside `to`, which is gone afterwards whatever happened. Null when
 *  it was taken (or `to` was there already), else why not. */
export const takeHashed = (
  from: string,
  to: string,
  sha256: string,
  most: number,
  mode = 0o644,
): string | null => {
  if (fs.existsSync(to)) return null;
  const source = openPlain(from, most);
  if (!source) return "not a plain file of a size desolate takes";
  const part = `${to}.part-${process.pid}`;
  try {
    if (copyOut(source, part, mode) !== sha256) return "it does not hash to its name";
    fs.renameSync(part, to);
    return null;
  } catch (error) {
    return `it could not be copied: ${(error as Error).message}`;
  } finally {
    fs.closeSync(source.fd);
    fs.rmSync(part, { force: true });
  }
};

declare namespace takeHashed {
  /** an object that hashes to its name is taken, and nothing else is left beside it */
  export type Takes = Given<
    [
      Invoke<typeof emptyScratch>,
      Invoke<typeof writeScratch, [name: "outbox/obj", text: "hello"]>,
      Invoke<
        typeof takeHashed,
        [
          from: Invoke<typeof scratch, [name: "outbox/obj"]>,
          to: Invoke<typeof scratch, [name: "kept/2cf24dba"]>,
          sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
          most: 100,
        ]
      >,
    ],
    [
      Expect<Invoke<typeof readScratch, [name: "kept/2cf24dba"]>, "=", "hello">,
      Expect<Invoke<typeof scratchFiles, [dir: "kept"]>, "=", ["2cf24dba"]>,
    ]
  >;
  /** one that does not is refused, and its partial copy is gone */
  export type WrongHash = Given<
    [
      Invoke<typeof emptyScratch>,
      Invoke<typeof writeScratch, [name: "outbox/obj", text: "hello, world"]>,
      Invoke<typeof dirScratch, [name: "kept"]>,
    ],
    [
      Expect<
        Invoke<
          typeof takeHashed,
          [
            from: Invoke<typeof scratch, [name: "outbox/obj"]>,
            to: Invoke<typeof scratch, [name: "kept/2cf24dba"]>,
            sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
            most: 100,
          ]
        >,
        "=",
        "it does not hash to its name"
      >,
      Expect<Invoke<typeof scratchFiles, [dir: "kept"]>, "=", []>,
    ]
  >;
  /** a link, or a file over the size desolate takes: refused before anything is read */
  export type NotPlain = Given<
    [
      Invoke<typeof emptyScratch>,
      Invoke<typeof writeScratch, [name: "secret", text: "hello"]>,
      Invoke<typeof linkScratch, [name: "outbox/obj", target: "secret"]>,
    ],
    [
      Expect<
        Invoke<
          typeof takeHashed,
          [
            from: Invoke<typeof scratch, [name: "outbox/obj"]>,
            to: Invoke<typeof scratch, [name: "kept/a"]>,
            sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
            most: 100,
          ]
        >,
        "=",
        "not a plain file of a size desolate takes"
      >,
      Expect<
        Invoke<
          typeof takeHashed,
          [
            from: Invoke<typeof scratch, [name: "secret"]>,
            to: Invoke<typeof scratch, [name: "kept/b"]>,
            sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
            most: 4,
          ]
        >,
        "=",
        "not a plain file of a size desolate takes"
      >,
    ]
  >;
  /** named by its hash, an object already kept is the same object: it is left as it is */
  export type AlreadyThere = Given<
    [
      Invoke<typeof emptyScratch>,
      Invoke<typeof writeScratch, [name: "outbox/obj", text: "hello"]>,
      Invoke<typeof writeScratch, [name: "kept/2cf24dba", text: "the first copy"]>,
    ],
    [
      Expect<
        Invoke<
          typeof takeHashed,
          [
            from: Invoke<typeof scratch, [name: "outbox/obj"]>,
            to: Invoke<typeof scratch, [name: "kept/2cf24dba"]>,
            sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
            most: 100,
          ]
        >,
        "=",
        null
      >,
      Expect<Invoke<typeof readScratch, [name: "kept/2cf24dba"]>, "=", "the first copy">,
    ]
  >;
}
