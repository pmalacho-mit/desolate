// The git VM's LFS transfer agent (git-lfs's custom transfer protocol): downloads only, from
// the two stores this VM can read, read-only: the mirror's (what the remote has) and the
// root clone's (what domains offered, and what was pushed through desolate).
//
// git-lfs's own file transfer cannot be used here: it runs `git rev-parse` inside the bare
// mirror, which the git VM's `safe.bareRepository=explicit` (kept: it is a guard against a
// clone's embedded repositories) refuses. So no LFS file was ever checked out in the git VM.
//
// Each object is copied without following a link and kept only if it hashes to its name.
//
//   lfs.standalonetransferagent = desolate-file
//   lfs.customtransfer.desolate-file.path = /usr/local/bin/desolate-lfs-file
//   lfs.customtransfer.desolate-file.args = <owner>/<repo>
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { parseRepo } from "../shared/names.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Invoke, Table } from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { fetchedFrom, holdsEverything, holdsNothing } from "../.harness/git-lfs.ts";

/** The two stores of a repository this VM reads (its argument, from git's config): none for
 *  anything that is not a repository by names.ts's rule (each store is a path). */
export const storesFor = (repo: string) =>
  parseRepo(repo)
    ? [`/desolate/mirrors/${repo}.git/lfs/objects`, `/desolate/root/${repo}/.git/lfs/objects`]
    : [];

declare namespace storesFor {
  /** the mirror's store first (what the remote has), then the root clone's */
  export type Stores = Expect<
    Invoke<typeof storesFor, [repo: "acme/app"]>,
    "=",
    ["/desolate/mirrors/acme/app.git/lfs/objects", "/desolate/root/acme/app/.git/lfs/objects"]
  >;
  export type NoStores = Table<
    typeof storesFor,
    [
      [args: [repo: ""], expected: []],
      [args: [repo: "acme"], expected: []],
      [args: [repo: "acme/app/../../etc"], expected: []],
      [args: [repo: "acme/.."], expected: []],
      [args: [repo: "../app"], expected: []],
    ]
  >;
}

/** The object, copied into the clone's LFS temp directory, if a store has it whole. */
export const fetchOne = (
  oid: string,
  size: number,
  stores: string[],
  gitDir: string,
): string | null => {
  const tmp = path.join(gitDir, "lfs", "tmp");
  fs.mkdirSync(tmp, { recursive: true });
  for (const store of stores) {
    let fd: number | null = null;
    const to = path.join(tmp, `${oid}.desolate-${process.pid}`);
    try {
      fd = fs.openSync(
        path.join(store, oid.slice(0, 2), oid.slice(2, 4), oid),
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
      );
      if (!fs.fstatSync(fd).isFile()) continue;
      const out = fs.openSync(to, "w", 0o644);
      const hash = createHash("sha256");
      const buffer = Buffer.alloc(1024 * 1024);
      let total = 0;
      try {
        for (let read = fs.readSync(fd, buffer); read > 0; read = fs.readSync(fd, buffer)) {
          hash.update(buffer.subarray(0, read));
          fs.writeSync(out, buffer, 0, read);
          total += read;
        }
      } finally {
        fs.closeSync(out);
      }
      if (hash.digest("hex") === oid && total === size) return to;
      fs.rmSync(to, { force: true });
    } catch {
      fs.rmSync(to, { force: true });
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  }
  return null;
};

declare namespace fetchOne {
  /** an object a store holds whole, copied out (the content is what the harness reads back) */
  export type Whole = Expect<
    Invoke<
      typeof fetchedFrom,
      [
        fetch: typeof fetchOne,
        objects: [
          [
            store: "mirror",
            oid: "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03",
            content: "hello\n",
            kind: "file",
          ],
        ],
        oid: "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03",
        size: 6,
      ]
    >,
    "=",
    { copied: "hello\n"; leftovers: 0 }
  >;
  /** a copy that does not hash to its name is passed over for the next store's */
  export type NextStore = Expect<
    Invoke<
      typeof fetchedFrom,
      [
        fetch: typeof fetchOne,
        objects: [
          [
            store: "mirror",
            oid: "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03",
            content: "hellO\n",
            kind: "file",
          ],
          [
            store: "root",
            oid: "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03",
            content: "hello\n",
            kind: "file",
          ],
        ],
        oid: "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03",
        size: 6,
      ]
    >,
    "=",
    { copied: "hello\n"; leftovers: 0 }
  >;
  /** nothing that is not the object itself, and nothing left behind: a wrong size, a link (even
   *  to the right bytes), a directory, no object at all */
  export type Refuses = Table<
    typeof fetchedFrom,
    [
      [
        args: [
          fetch: typeof fetchOne,
          objects: [
            [
              store: "mirror",
              oid: "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03",
              content: "hello\n",
              kind: "file",
            ],
          ],
          oid: "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03",
          size: 7,
        ],
        expected: { copied: null; leftovers: 0 },
      ],
      [
        args: [
          fetch: typeof fetchOne,
          objects: [
            [
              store: "mirror",
              oid: "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03",
              content: "hello\n",
              kind: "link",
            ],
          ],
          oid: "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03",
          size: 6,
        ],
        expected: { copied: null; leftovers: 0 },
      ],
      [
        args: [
          fetch: typeof fetchOne,
          objects: [
            [
              store: "root",
              oid: "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03",
              content: "hello\n",
              kind: "dir",
            ],
          ],
          oid: "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03",
          size: 6,
        ],
        expected: { copied: null; leftovers: 0 },
      ],
      [
        args: [
          fetch: typeof fetchOne,
          objects: [],
          oid: "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03",
          size: 6,
        ],
        expected: { copied: null; leftovers: 0 },
      ],
    ]
  >;
}

const NOT_AN_OID = { code: 2, message: "not an LFS object id" };

/** git-lfs's one message (a JSON line), and this agent's reply: something to say, "stop" for
 *  the end, or null for a line it says nothing to. `fetch` copies an object out (fetchOne). */
export const replyTo = (
  line: string,
  fetch: (oid: string, size: number) => string | null,
): { say: unknown } | "stop" | null => {
  let message: { event?: string; operation?: string; oid?: string; size?: number };
  try {
    message = JSON.parse(line) as typeof message;
  } catch {
    return null;
  }
  if (message.event === "init")
    return {
      say:
        message.operation === "download"
          ? {}
          : {
              error: {
                code: 1,
                message:
                  "the git VM's LFS agent only downloads: a push carries its LFS objects itself",
              },
            },
    };
  if (message.event === "download") {
    const oid = String(message.oid ?? "");
    if (!/^[0-9a-f]{64}$/.test(oid) || !Number.isInteger(message.size))
      return { say: { event: "complete", oid, error: NOT_AN_OID } };
    const file = fetch(oid, message.size!);
    return {
      say: file
        ? { event: "complete", oid, path: file }
        : {
            event: "complete",
            oid,
            error: {
              code: 2,
              message: `neither the mirror nor the root has ${oid.slice(0, 12)}: on the Mac, desolate fetch, or have the agent offer the branch`,
            },
          },
    };
  }
  return message.event === "terminate" ? "stop" : null;
};

declare namespace replyTo {
  /** downloads only: a push carries its LFS objects itself */
  export type Init = Table<
    typeof replyTo,
    [
      [
        args: [
          line: '{"event":"init","operation":"download","remote":"origin","concurrent":true}',
          fetch: typeof holdsEverything,
        ],
        expected: { say: {} },
      ],
      [
        args: [
          line: '{"event":"init","operation":"upload","remote":"origin"}',
          fetch: typeof holdsEverything,
        ],
        expected: {
          say: {
            error: {
              code: 1;
              message: "the git VM's LFS agent only downloads: a push carries its LFS objects itself";
            };
          };
        },
      ],
    ]
  >;
  export type Download = Table<
    typeof replyTo,
    [
      [
        args: [
          line: '{"event":"download","oid":"5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03","size":6}',
          fetch: typeof holdsEverything,
        ],
        expected: {
          say: {
            event: "complete";
            oid: "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03";
            path: "/lfs/tmp/5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03";
          };
        },
      ],
      [
        args: [
          line: '{"event":"download","oid":"5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03","size":6}',
          fetch: typeof holdsNothing,
        ],
        expected: {
          say: {
            event: "complete";
            oid: "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03";
            error: {
              code: 2;
              message: "neither the mirror nor the root has 5891b5b522d5: on the Mac, desolate fetch, or have the agent offer the branch";
            };
          };
        },
      ],
    ]
  >;
  /** the oid becomes a path in the stores: only sha256 hex, and a whole size, are looked for */
  export type NotAnObject = Table<
    typeof replyTo,
    [
      [
        args: [
          line: '{"event":"download","oid":"../../../../etc/passwd","size":6}',
          fetch: typeof holdsEverything,
        ],
        expected: {
          say: {
            event: "complete";
            oid: "../../../../etc/passwd";
            error: { code: 2; message: "not an LFS object id" };
          };
        },
      ],
      [
        args: [
          line: '{"event":"download","oid":"5891B5B522D5DF086D0FF0B110FBD9D21BB4FC7163AF34D08286A2E846F6BE03","size":6}',
          fetch: typeof holdsEverything,
        ],
        expected: {
          say: {
            event: "complete";
            oid: "5891B5B522D5DF086D0FF0B110FBD9D21BB4FC7163AF34D08286A2E846F6BE03";
            error: { code: 2; message: "not an LFS object id" };
          };
        },
      ],
      [
        args: [
          line: '{"event":"download","oid":"5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03","size":"6"}',
          fetch: typeof holdsEverything,
        ],
        expected: {
          say: {
            event: "complete";
            oid: "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03";
            error: { code: 2; message: "not an LFS object id" };
          };
        },
      ],
      [
        args: [line: '{"event":"download","size":6}', fetch: typeof holdsEverything],
        expected: {
          say: { event: "complete"; oid: ""; error: { code: 2; message: "not an LFS object id" } };
        },
      ],
    ]
  >;
  /** terminate ends it; a line that is not JSON, or an event it does not know, gets no answer */
  export type Others = Table<
    typeof replyTo,
    [
      [args: [line: '{"event":"terminate"}', fetch: typeof holdsEverything], expected: "stop"],
      [args: [line: "not json", fetch: typeof holdsEverything], expected: null],
      [
        args: [
          line: '{"event":"progress","oid":"5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03"}',
          fetch: typeof holdsEverything,
        ],
        expected: null,
      ],
    ]
  >;
}

const main = async (repo: string) => {
  const say = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const stores = storesFor(repo);
  const gitDir =
    spawnSync("git", ["rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).stdout.trim() ||
    path.resolve(".git");
  const lines = readline.createInterface({ input: process.stdin, terminal: false });
  for await (const line of lines) {
    const reply = replyTo(line, (oid, size) => fetchOne(oid, size, stores, gitDir));
    if (reply === "stop") break;
    if (reply) say(reply.say);
  }
};

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  await main(process.argv[2] ?? "");
