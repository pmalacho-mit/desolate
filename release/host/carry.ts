// What the root VM holds that is not on a share, carried across a rebuild of it. The keys,
// the repository registry, every domain's secrets and network rules live on the root VM's
// own disk on purpose (root/layout.ts: no share, so no other VM has a path to them). So a
// `destroy` that keeps the home must keep them too, or it keeps clones that nothing can
// fetch or push any more and domains whose secrets are gone. `destroy` takes them out of
// the root as one archive, into a directory of the home no VM mounts, and the next
// `bootstrap` puts them into the new root before its services start, then deletes it.
//
// While it exists, the archive is the Mac's copy of the root's keys. That is no new
// exposure under desolate's rule (a program running as you on the Mac can already enter the
// root VM as root: decisions.md 5.3), and it lasts from `destroy` to the next `bootstrap`.
import * as fs from "node:fs";
import * as path from "node:path";
import { formatBytes } from "../shared/limits.ts";
import { isSlug } from "../shared/names.ts";
import { because } from "./failures.ts";
import { paths } from "./paths.ts";
import { backend, ROOT_VM } from "./stack.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type {
  Call,
  Expect,
  Given,
  Invoke,
  Mock,
  Mocked,
} from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { emptyHome } from "../.harness/home.ts";
import type { carried, keptBefore, rootVm } from "../.harness/host-carry.ts";

type Out = (line: string) => void;

export const KEPT_DIR = path.join(paths.home, "root-kept");
export const KEPT = path.join(KEPT_DIR, "root-state.tgz");

/** Part of an archive, which a `destroy` stopped halfway (Ctrl-C, a crash) left: it holds
 *  part of the root's keys and is a copy of nothing, so it goes, at the start of a destroy and
 *  of a bootstrap. */
export const dropPartial = () => fs.rmSync(`${KEPT}.partial`, { force: true });

/** Whether a file begins as gzip's output does (RFC 1952: 1f 8b): tar's archive, and not
 *  some other text a root that ran no tar printed. */
const isGzip = (file: string) => {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const head = Buffer.alloc(2);
      return fs.readSync(fd, head, 0, 2, 0) === 2 && head[0] === 0x1f && head[1] === 0x8b;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
};

/** The root's own directories that hold what must survive. Not kept: what start.sh makes
 *  again (its code and layout stamps, so the services restart on what was put back),
 *  sockets, and the list of proxies that were running (rootd starts them again). */
const DIRS = ["var/lib/desolate-root", "var/lib/desolate", "var/lib/desolate-proxies"];
const EXCLUDE = [
  "var/lib/desolate-root/code",
  "var/lib/desolate-root/layout",
  "var/lib/desolate/proxy/running",
  "*.sock",
];

/** Take the root's state out, before its VM is removed. Returns false when there is no root
 *  VM (nothing to keep). Throws when there is one and its state could not be read: the
 *  caller must not remove a root whose keys it could not keep. */
export const keepRootState = async (out: Out): Promise<boolean> => {
  dropPartial();
  const b = backend();
  const info = await b.info(ROOT_VM);
  if (info.status === "missing") return false;
  if (info.status !== "running") await b.start(ROOT_VM);
  const script = `cd / && tar ${EXCLUDE.map((e) => `--exclude='${e}'`).join(" ")} -czf - $(for d in ${DIRS.join(" ")}; do [ -d "/$d" ] && echo "$d"; done)`;
  fs.mkdirSync(KEPT_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(KEPT_DIR, 0o700);
  const partial = `${KEPT}.partial`;
  // The archive goes from tar to the file as it comes, so it is whatever size the root's
  // state is (it once came back as one base64 string, which run() stops at 192 MiB). No
  // timer (R4): it reads the root's own disk, and the person who ran `destroy` is waiting.
  const taken = await b.exec(ROOT_VM, ["bash", "-c", script], { root: true, stdoutTo: partial });
  const size = fs.existsSync(partial) ? fs.statSync(partial).size : 0;
  const failed =
    taken.code !== 0
      ? because(
          "the root's keys and secrets could not be read out of it",
          "root-state-out",
          taken.stderr,
        )
      : !isGzip(partial)
        ? `the root's keys and secrets could not be read out of it: what it gave (${size} bytes) is not an archive${taken.stderr.trim() ? `: ${because("tar said", "root-state-out", taken.stderr)}` : ""}`
        : null;
  if (failed) {
    fs.rmSync(partial, { force: true });
    throw new Error(failed);
  }
  fs.renameSync(partial, KEPT);
  out(
    `  = kept the root's keys, registry, secrets and network rules (${formatBytes(size)}, ${path.relative(paths.home, KEPT)}): the next bootstrap puts them back`,
  );
  return true;
};

declare namespace keepRootState {
  /** what the root's tar wrote is kept as the archive, byte for byte, and its size said */
  export type Kept = Given<
    [
      Invoke<typeof emptyHome>,
      Mock<"./stack.ts">,
      Call<
        Mocked<typeof backend>,
        "mockReturnValue",
        [value: Invoke<typeof rootVm, [status: "stopped", code: 0, stdout: "\u001f\u008barchive"]>]
      >,
    ],
    Expect<
      Invoke<typeof carried, [command: typeof keepRootState, args: []]>,
      "=",
      {
        returned: true;
        lines: [
          "  = kept the root's keys, registry, secrets and network rules (1 KiB, root-kept/root-state.tgz): the next bootstrap puts them back",
        ];
        kept: "\u001f\u008barchive";
      }
    >
  >;
  /** no root VM: nothing to keep, and nothing kept */
  export type NoRoot = Given<
    [
      Invoke<typeof emptyHome>,
      Mock<"./stack.ts">,
      Call<
        Mocked<typeof backend>,
        "mockReturnValue",
        [value: Invoke<typeof rootVm, [status: "missing", code: 0, stdout: ""]>]
      >,
    ],
    Expect<
      Invoke<typeof carried, [command: typeof keepRootState, args: []]>,
      "=",
      { returned: false; lines: []; kept: null }
    >
  >;
  /** a root whose state could not be read throws: the caller must not remove a root whose
   *  keys it could not keep. Even when tar's exit was 0, an answer that is not gzip's is not
   *  an archive; and nothing half-written is left as if it were one */
  export type Unreadable = [
    Given<
      [
        Invoke<typeof emptyHome>,
        Mock<"./stack.ts">,
        Call<
          Mocked<typeof backend>,
          "mockReturnValue",
          [
            value: Invoke<
              typeof rootVm,
              [
                status: "running",
                code: 2,
                stdout: "",
                stderr: "tar: var/lib/desolate-root: Cannot open: Permission denied",
              ]
            >,
          ]
        >,
      ],
      Expect<
        Invoke<typeof carried, [command: typeof keepRootState, args: []]>,
        "=",
        {
          threw: "the root's keys and secrets could not be read out of it: tar: var/lib/desolate-root: Cannot open: Permission denied";
          lines: [];
          kept: null;
        }
      >
    >,
    Given<
      [
        Invoke<typeof emptyHome>,
        Mock<"./stack.ts">,
        Call<
          Mocked<typeof backend>,
          "mockReturnValue",
          [
            value: Invoke<
              typeof rootVm,
              [status: "running", code: 0, stdout: "tar: removing leading '/'"]
            >,
          ]
        >,
      ],
      Expect<
        Invoke<typeof carried, [command: typeof keepRootState, args: []]>,
        "matches",
        {
          threw: "the root's keys and secrets could not be read out of it: what it gave (25 bytes) is not an archive";
          kept: null;
        }
      >
    >,
  ];
}

/** Domains the home knows, from their records on the host: their proxies' users must exist
 *  in the new root before their files are put back, so the files keep their owners. */
const domainsOnHost = () => {
  try {
    return fs
      .readdirSync(paths.domains)
      .filter(
        (name) => isSlug(name) && fs.existsSync(path.join(paths.domains, name, "domain.json")),
      );
  } catch {
    return [];
  }
};

/** Put kept state into a new root. Only into one that holds no keys of its own: a root that
 *  has keys is the truth, and the archive is left where it is, and said. Returns whether
 *  anything was put back; the caller restarts the root's services then. */
export const restoreRootState = async (out: Out, rootHoldsKeys: boolean): Promise<boolean> => {
  dropPartial();
  if (!fs.existsSync(KEPT)) return false;
  if (rootHoldsKeys) {
    out(
      `  ! ${KEPT} is a kept copy of a root's state, but this root holds keys of its own: left as it is. If it is not wanted: rm ${KEPT}`,
    );
    return false;
  }
  const b = backend();
  // Each domain's proxies' user first (root/proxy-user.sh: a name from the domain's), so tar
  // gives their files back to them by name; then again after, for the directories it sets.
  const users = async () => {
    for (const domain of domainsOnHost()) {
      const made = await b.exec(
        ROOT_VM,
        ["bash", "/desolate/release/root/proxy-user.sh", String(process.getuid!()), domain],
        { root: true, timeoutMs: 60_000 },
      );
      if (made.code !== 0)
        throw new Error(
          because(
            `the domain ${domain}'s proxies' user could not be made`,
            "proxy-user",
            made.stderr || made.stdout,
          ),
        );
    }
  };
  await users();
  const put = await b.exec(
    ROOT_VM,
    ["bash", "-c", "tar -C / --same-owner -xzf - && rm -f /var/lib/desolate-root/code"],
    // From the file as tar takes it, under no timer, as it was taken out.
    { root: true, stdinFrom: KEPT },
  );
  if (put.code !== 0)
    throw new Error(
      because(
        `the kept state could not be put into the new root (it is still at ${KEPT})`,
        "root-state-in",
        put.stderr || put.stdout,
      ),
    );
  await users();
  fs.rmSync(KEPT, { force: true });
  out("  + put back the root's keys, registry, secrets and network rules from before the destroy");
  return true;
};

declare namespace restoreRootState {
  /** put into a new root, then the archive is gone: the Mac holds the keys no longer than it must */
  export type PutBack = Given<
    [
      Invoke<typeof emptyHome>,
      Invoke<typeof keptBefore, [text: "archive"]>,
      Mock<"./stack.ts">,
      Call<
        Mocked<typeof backend>,
        "mockReturnValue",
        [value: Invoke<typeof rootVm, [status: "running", code: 0, stdout: ""]>]
      >,
    ],
    Expect<
      Invoke<typeof carried, [command: typeof restoreRootState, args: [rootHoldsKeys: false]]>,
      "=",
      {
        returned: true;
        lines: [
          "  + put back the root's keys, registry, secrets and network rules from before the destroy",
        ];
        kept: null;
      }
    >
  >;
  /** a root that holds keys of its own is the truth: the archive is left, and said, with how to remove it */
  export type RootHasKeys = Given<
    [
      Invoke<typeof emptyHome>,
      Invoke<typeof keptBefore, [text: "archive"]>,
      Mock<"./stack.ts">,
      Call<
        Mocked<typeof backend>,
        "mockReturnValue",
        [value: Invoke<typeof rootVm, [status: "running", code: 0, stdout: ""]>]
      >,
    ],
    Expect<
      Invoke<typeof carried, [command: typeof restoreRootState, args: [rootHoldsKeys: true]]>,
      "=",
      {
        returned: false;
        lines: [
          "  ! $DESOLATE_HOME/root-kept/root-state.tgz is a kept copy of a root's state, but this root holds keys of its own: left as it is. If it is not wanted: rm $DESOLATE_HOME/root-kept/root-state.tgz",
        ];
        kept: "archive";
      }
    >
  >;
  /** a put that failed keeps the archive, and says where it is */
  export type PutFailed = Given<
    [
      Invoke<typeof emptyHome>,
      Invoke<typeof keptBefore, [text: "archive"]>,
      Mock<"./stack.ts">,
      Call<
        Mocked<typeof backend>,
        "mockReturnValue",
        [
          value: Invoke<
            typeof rootVm,
            [status: "running", code: 2, stdout: "", stderr: "gzip: stdin: not in gzip format"]
          >,
        ]
      >,
    ],
    Expect<
      Invoke<typeof carried, [command: typeof restoreRootState, args: [rootHoldsKeys: false]]>,
      "=",
      {
        threw: "the kept state could not be put into the new root (it is still at $DESOLATE_HOME/root-kept/root-state.tgz): gzip: stdin: not in gzip format";
        lines: [];
        kept: "archive";
      }
    >
  >;
  /** nothing kept: nothing to do */
  export type NothingKept = Given<
    Invoke<typeof emptyHome>,
    Expect<
      Invoke<typeof carried, [command: typeof restoreRootState, args: [rootHoldsKeys: false]]>,
      "=",
      { returned: false; lines: []; kept: null }
    >
  >;
}
