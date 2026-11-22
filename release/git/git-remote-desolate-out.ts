// In the git VM, a clone's push address for `origin` is `desolate-out::<owner>/<repo>`, and
// git runs this for it: `git push origin <branch>` works as it does anywhere, and still goes
// through the person on the host.
//
//   1. git says which commit goes to which branch.
//   2. This writes a bundle of that commit (what the mirror lacks of it), its new LFS
//      objects, and the request, into /desolate/out: the only place this VM writes that the
//      host reads.
//   3. The host hands it to the root, which checks every object (as it does a domain's),
//      and pushes it as a raw push is: after you approve it on the approval page.
//   4. The host says what it does with it, and leaves the answer here; this prints both.
//
// No key, no network, nothing of the root's to run: this VM can ask, and that is all. The
// bounds the host and the forge hold a push to (shared/git-out-box.ts, shared/limits.ts) are checked
// here first, before anything is bundled or copied: a push they would refuse is refused here,
// with the bound and the size. And it waits for the answer for as long as you do: Ctrl-C (or
// closing the terminal) withdraws it.
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { FORGE, LFS_POINTER_BYTES, over } from "../shared/limits.ts";
import { named, newId, requester, requestRefusal } from "../shared/git-out-box.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Invoke, Table } from "../../suede.nests/dsl.import.meta.vitest.ts";

const POINTER =
  /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:([0-9a-f]{64})\nsize (\d+)\n$/;
const fail = (message: string): never => {
  process.stderr.write(`git-remote-desolate-out: ${message}\n`);
  process.exit(1);
};

/** The remote's address, as git hands it to the helper (its third argument):
 *  `desolate-out::<owner>/<repo>`: a push to the remote (origin), approved by the person.
 *  `desolate-out::<owner>/<repo>@<domain>`: a delivery to that domain (a remote named for it):
 *  the branch appears in its workspaces as root/<branch>, as `git push <domain>` in the root's
 *  terminal does. Nothing leaves the machine, so nothing is asked. */
export const remoteOf = (
  address: string,
): { repo: string; domain: string | null } | { refused: string } => {
  const [repo = "", domain = null, ...more] = address.split("@") as [string?, string?, ...string[]];
  if (more.length > 0) return { refused: `'${address}' is not a remote's address` };
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo))
    return { refused: `'${repo}' is not a repository` };
  if (domain !== null && !/^[a-z0-9][a-z0-9-]{0,39}$/.test(domain))
    return { refused: `'${domain}' is not a domain` };
  return { repo, domain };
};

declare namespace remoteOf {
  /** a repository, or a repository and the domain it is delivered to */
  export type Addresses = Table<
    typeof remoteOf,
    [
      [args: [address: "acme/app"], expected: { repo: "acme/app"; domain: null }],
      [args: [address: "acme/app@acme--app"], expected: { repo: "acme/app"; domain: "acme--app" }],
    ]
  >;
  /** both become paths and names in the request the host reads */
  export type Refuses = Table<
    typeof remoteOf,
    [
      [args: [address: ""], expected: { refused: "'' is not a repository" }],
      [args: [address: "acme"], expected: { refused: "'acme' is not a repository" }],
      [args: [address: "acme/app/x"], expected: { refused: "'acme/app/x' is not a repository" }],
      [args: [address: "acme/app@Dev"], expected: { refused: "'Dev' is not a domain" }],
      [args: [address: "acme/app@"], expected: { refused: "'' is not a domain" }],
      [args: [address: "acme/app@../x"], expected: { refused: "'../x' is not a domain" }],
    ]
  >;
  /** one @ at most: nothing of an address is dropped unread */
  export type SecondAt = Expect<
    Invoke<typeof remoteOf, [address: "acme/app@dev@x"]>,
    "=",
    { refused: "'acme/app@dev@x' is not a remote's address" }
  >;
}

/** Where a push of `repo` reads and writes, in the git VM. */
type Remote = { repo: string; domain: string | null; mirror: string; gitDir: string };

/** git, for what answers in a line or a list of refs. A list the size of a history is read
 *  as a stream (lfsOf), never held here. */
const git = (args: string[], input?: string) => spawnSync("git", args, { encoding: "utf8", input });

/** The remote's branches, as the mirror last saw them. */
const mirrorRefs = (at: Remote) =>
  git(["--git-dir", at.mirror, "for-each-ref", "--format=%(objectname) %(refname)", "refs/heads"])
    .stdout.split("\n")
    .filter(Boolean);
/** A domain's branches, as the root holds them (its clone's refs/remotes/<domain>/*), read the
 *  way `git fetch <domain>` reads them: upload-pack, with nothing of the root's config that
 *  could name a command. */
const domainRefs = (at: Remote, slug: string) =>
  domainRefLines(
    git([
      "ls-remote",
      "--upload-pack=git -c core.alternateRefsCommand=true upload-pack",
      `/desolate/root/${at.repo}`,
      `refs/remotes/${slug}/*`,
    ]).stdout,
    slug,
  );
/** ls-remote's lines of a domain's refs, as git's `list` wants them: `<id> refs/heads/<branch>`. */
export const domainRefLines = (lsRemote: string, slug: string): string[] =>
  lsRemote
    .split("\n")
    .filter(Boolean)
    .map((line) => line.replace(`\trefs/remotes/${slug}/`, " refs/heads/"))
    .filter((line) => /^[0-9a-f]{40} refs\/heads\/\S+$/.test(line));

declare namespace domainRefLines {
  /** the domain's branches, named as the remote's own; anything else ls-remote printed (another
   *  domain's, a name with a space, a short id) is not listed to git */
  export type Lists = Expect<
    Invoke<
      typeof domainRefLines,
      [
        lsRemote: "1111111111111111111111111111111111111111\trefs/remotes/dev/main\n2222222222222222222222222222222222222222\trefs/remotes/dev/issue/12\n3333333333333333333333333333333333333333\trefs/remotes/devx/main\n4444444444444444444444444444444444444444\trefs/remotes/dev/a b\n5555555\trefs/remotes/dev/short\n",
        slug: "dev",
      ]
    >,
    "=",
    [
      "1111111111111111111111111111111111111111 refs/heads/main",
      "2222222222222222222222222222222222222222 refs/heads/issue/12",
    ]
  >;
}

const remoteRefs = (at: Remote) =>
  at.domain === null ? mirrorRefs(at) : domainRefs(at, at.domain);

/** The LFS objects a commit's history adds to what the mirror has: each blob small enough to
 *  be a pointer (git-lfs's own cutoff), read as git lists it. One pipeline, streamed: the
 *  objects of a whole history (a first push) are never held as one text. */
const lfsOf = async (commit: string, have: string[]): Promise<string[]> => {
  const child = spawn(
    "bash",
    [
      "-c",
      'set -o pipefail; git rev-list --objects --no-object-names "$@" | git cat-file --buffer --batch-check="%(objecttype) %(objectsize) %(objectname)" | awk -v most="$MOST" \'$1 == "blob" && $2 < most { print $3 }\' | git cat-file --buffer --batch',
      "_",
      commit,
      ...have.map((id) => `^${id}`),
    ],
    { env: { ...process.env, MOST: String(LFS_POINTER_BYTES) }, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderr.length < 4096) stderr += chunk.toString("utf8");
  });
  const oids = new Set<string>();
  // `cat-file --batch`: "<id> blob <size>\n", the blob, "\n"; each under LFS_POINTER_BYTES.
  let held = Buffer.alloc(0);
  for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
    held = Buffer.concat([held, chunk]);
    for (;;) {
      const end = held.indexOf(10);
      if (end < 0) break;
      const size = Number(/ blob (\d+)$/.exec(held.subarray(0, end).toString("latin1"))?.[1]);
      if (!Number.isInteger(size) || held.length < end + 1 + size + 1) break;
      const oid = pointerOid(held.subarray(end + 1, end + 1 + size).toString("utf8"));
      if (oid) oids.add(oid);
      held = held.subarray(end + 1 + size + 1);
    }
  }
  const code = await new Promise<number>((resolve) => child.on("close", (c) => resolve(c ?? 1)));
  if (code !== 0) throw new Error(`git could not list what the push adds: ${stderr.trim()}`);
  return [...oids];
};

/** A file's sha256, read in parts: an LFS object may be larger than node holds at once. */
const sha256Of = (file: string) => {
  const hash = createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    for (let read; (read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0;)
      hash.update(buffer.subarray(0, read));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
};

/** The LFS object a blob points to, when the blob is git-lfs's pointer exactly. */
export const pointerOid = (blob: string): string | null => POINTER.exec(blob)?.[1] ?? null;

declare namespace pointerOid {
  export type Pointer = Expect<
    Invoke<
      typeof pointerOid,
      [
        blob: "version https://git-lfs.github.com/spec/v1\noid sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\nsize 12\n",
      ]
    >,
    "=",
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  >;
  /** a file that only looks like one: its object is not looked for, nor copied out */
  export type NotPointers = Table<
    typeof pointerOid,
    [
      [
        args: [
          blob: "version https://git-lfs.github.com/spec/v1\noid sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\nsize 12",
        ],
        expected: null,
      ],
      [
        args: [
          blob: "version https://git-lfs.github.com/spec/v1\noid sha256:../../../../etc/passwd\nsize 12\n",
        ],
        expected: null,
      ],
      [
        args: [
          blob: "version https://git-lfs.github.com/spec/v1\noid sha256:0123456789ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef\nsize 12\n",
        ],
        expected: null,
      ],
      [
        args: [
          blob: "# notes\nversion https://git-lfs.github.com/spec/v1\noid sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\nsize 12\n",
        ],
        expected: null,
      ],
    ]
  >;
}

/** What git asks to push (`push <src>:<dst>`, `+` when forced): a branch, from a commit. The
 *  branch's name is not judged here: the host refuses one desolate does not carry
 *  (host/git-vm.ts, isBranch). A refusal is git's own `error <ref> <why>` line. */
export const refspecOf = (
  spec: string,
): { forced: boolean; source: string; target: string; branch: string } | { error: string } => {
  const forced = spec.startsWith("+");
  const [source, target] = spec.replace(/^\+/, "").split(":");
  const branch = (target ?? "").replace(/^refs\/heads\//, "");
  if (!target?.startsWith("refs/heads/") || !branch)
    return { error: `error ${target} desolate pushes branches` };
  if (!source)
    return {
      error: `error ${target} deleting a branch on the remote is not something desolate does: delete it on the forge`,
    };
  return { forced, source, target, branch };
};

declare namespace refspecOf {
  export type Branches = Table<
    typeof refspecOf,
    [
      [
        args: [spec: "refs/heads/fix:refs/heads/fix"],
        expected: {
          forced: false;
          source: "refs/heads/fix";
          target: "refs/heads/fix";
          branch: "fix";
        },
      ],
      [
        args: [spec: "+HEAD:refs/heads/issue/12"],
        expected: {
          forced: true;
          source: "HEAD";
          target: "refs/heads/issue/12";
          branch: "issue/12";
        },
      ],
      /** a name desolate would not carry gets this far, and no further: the host refuses it */
      [
        args: [spec: "HEAD:refs/heads/a..b"],
        expected: { forced: false; source: "HEAD"; target: "refs/heads/a..b"; branch: "a..b" },
      ],
    ]
  >;
  /** a tag, a note, any ref that is not a branch; and a deletion, which desolate never does */
  export type Refuses = Table<
    typeof refspecOf,
    [
      [
        args: [spec: "refs/tags/v1:refs/tags/v1"],
        expected: { error: "error refs/tags/v1 desolate pushes branches" },
      ],
      [
        args: [spec: "refs/notes/commits:refs/notes/commits"],
        expected: { error: "error refs/notes/commits desolate pushes branches" },
      ],
      [
        args: [spec: "HEAD:refs/heads/"],
        expected: { error: "error refs/heads/ desolate pushes branches" },
      ],
      [args: [spec: "HEAD:main"], expected: { error: "error main desolate pushes branches" }],
      [
        args: [spec: ":refs/heads/fix"],
        expected: {
          error: "error refs/heads/fix deleting a branch on the remote is not something desolate does: delete it on the forge";
        },
      ],
      [
        args: [spec: "+:refs/heads/fix"],
        expected: {
          error: "error refs/heads/fix deleting a branch on the remote is not something desolate does: delete it on the forge";
        },
      ],
    ]
  >;
}

/** The host's answer, as git's one line: anything the host said is kept on that line. */
export const answerLine = (target: string, answer: { pushed?: boolean; error?: string }) =>
  answer.pushed
    ? `ok ${target}`
    : `error ${target} ${String(answer.error ?? "not pushed").replace(/\n/g, " ")}`;

declare namespace answerLine {
  export type Answers = Table<
    typeof answerLine,
    [
      [args: [target: "refs/heads/fix", answer: { pushed: true }], expected: "ok refs/heads/fix"],
      [
        args: [target: "refs/heads/fix", answer: { pushed: false; error: "you declined it" }],
        expected: "error refs/heads/fix you declined it",
      ],
      /** a reason of several lines would end git's line early, and the rest be read as commands */
      [
        args: [target: "refs/heads/fix", answer: { error: "rejected\nok refs/heads/main" }],
        expected: "error refs/heads/fix rejected ok refs/heads/main",
      ],
      [args: [target: "refs/heads/fix", answer: {}], expected: "error refs/heads/fix not pushed"],
    ]
  >;
}

/** A line of git's remote-helper protocol, as this helper reads it. */
export const commandOf = (
  line: string,
): "capabilities" | "list" | { push: string } | "end" | { unknown: string } =>
  line === "capabilities"
    ? "capabilities"
    : line === "list for-push" || line === "list"
      ? "list"
      : line.startsWith("push ")
        ? { push: line.slice(5) }
        : line === ""
          ? "end"
          : { unknown: line };

declare namespace commandOf {
  /** push only: no fetch, no option, no connect; anything else stops the helper */
  export type Protocol = Table<
    typeof commandOf,
    [
      [args: [line: "capabilities"], expected: "capabilities"],
      [args: [line: "list for-push"], expected: "list"],
      [args: [line: "list"], expected: "list"],
      [args: [line: "push +HEAD:refs/heads/fix"], expected: { push: "+HEAD:refs/heads/fix" }],
      [args: [line: ""], expected: "end"],
      [
        args: [line: "fetch 1111111111111111111111111111111111111111 refs/heads/main"],
        expected: { unknown: "fetch 1111111111111111111111111111111111111111 refs/heads/main" },
      ],
      [args: [line: "option verbosity 1"], expected: { unknown: "option verbosity 1" }],
      [args: [line: "connect git-receive-pack"], expected: { unknown: "connect git-receive-pack" }],
    ]
  >;
}

/** What one push carries past what the remote has, checked against the bounds the host and
 *  the forge hold it to before anything is bundled (R3): the request's size, and each LFS
 *  object's. The bundle's own size is known once it is made, and checked then, before the
 *  request is written. A refusal is the sentence for the bound that was hit. */
export const pushRefusal = (
  request: Record<string, unknown>,
  lfs: { oid: string; bytes: number }[],
): string | null => {
  const refused = requestRefusal(JSON.stringify(request));
  if (refused) return `${refused}: it names ${lfs.length} LFS objects; push fewer at once`;
  for (const { oid, bytes } of lfs)
    if (bytes > FORGE.lfsObjectBytes)
      return over(
        `the LFS object ${oid.slice(0, 12)}`,
        FORGE.lfsObjectBytes,
        bytes,
        "bytes",
        "the forge stores",
      );
  return null;
};

declare namespace pushRefusal {
  /** within every bound: nothing to say */
  export type Within = Expect<
    Invoke<
      typeof pushRefusal,
      [
        request: { repo: "acme/app"; lfs: [] },
        lfs: [
          { oid: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"; bytes: 12 },
        ],
      ]
    >,
    "=",
    null
  >;
  /** an LFS object over what the forge stores, named by its id */
  export type TooLarge = Expect<
    Invoke<
      typeof pushRefusal,
      [
        request: { repo: "acme/app"; lfs: [] },
        lfs: [
          {
            oid: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
            bytes: 6442450944;
          },
        ],
      ]
    >,
    "=",
    "the LFS object 0123456789ab is 6.0 GiB, over the 5 GiB the forge stores"
  >;
}

const pushOne = async (
  at: Remote,
  spec: string,
  box: ReturnType<typeof requester>,
): Promise<string> => {
  const asked = refspecOf(spec);
  if ("error" in asked) return asked.error;
  const { forced, source, target, branch } = asked;
  const { repo, domain, gitDir } = at;
  const commit = git(["rev-parse", "--verify", "--quiet", `${source}^{commit}`]).stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) return `error ${target} no such commit`;
  const id = newId();
  const names = named(id);
  const ref = `refs/desolate/out/${id}`;
  // What need not travel: what the mirror has (a domain's clone borrows the mirror too).
  const have = mirrorRefs(at)
    .map((line) => line.split(" ")[0]!)
    .filter((tip) => git(["cat-file", "-e", `${tip}^{commit}`]).status === 0);
  try {
    // LFS objects the mirror lacks, from this clone's store (one it does not have is not
    // sent: the remote may have it already), and the request that names them: checked first.
    const lfs: { oid: string; file: string; bytes: number }[] = [];
    for (const oid of await lfsOf(commit, have)) {
      const file = path.join(gitDir, "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4), oid);
      const stat = fs.statSync(file, { throwIfNoEntry: false });
      if (stat?.isFile()) lfs.push({ oid, file, bytes: stat.size });
    }
    const request = {
      repo,
      branch,
      commit,
      forced,
      lfs: lfs.map(({ oid }) => oid),
      ...(domain === null ? {} : { domain }),
    };
    const refused = pushRefusal(request, lfs);
    if (refused) return `error ${target} ${refused}`;
    git(["update-ref", ref, commit]);
    const bundle = box.leave(names.bundle);
    const part = box.leave(`${names.bundle}.part`);
    let made = git(["bundle", "create", "--quiet", part, ref, ...have.map((tip) => `^${tip}`)]);
    // A commit the remote has already (a new branch at it): the bundle carries its history.
    if (made.status !== 0 && /empty bundle/i.test(made.stderr))
      made = git(["bundle", "create", "--quiet", part, ref]);
    if (made.status !== 0) {
      box.withdraw();
      return `error ${target} could not bundle the commit: ${made.stderr.trim().replace(/\n/g, " ")}`;
    }
    const bytes = fs.statSync(part).size;
    if (bytes > FORGE.packBytes) {
      box.withdraw();
      return `error ${target} ${over("the push's bundle", FORGE.packBytes, bytes, "bytes", "a push to the forge may carry")}`;
    }
    fs.renameSync(part, bundle);
    for (const { oid, file } of lfs) {
      if (sha256Of(file) !== oid) {
        box.withdraw();
        return `error ${target} the LFS object ${oid.slice(0, 12)} here does not hash to its name`;
      }
      fs.copyFileSync(file, box.leave(names.lfs(oid)));
    }
    const answer = (await box.ask(id, request, (line) => process.stderr.write(`${line}\n`))) as {
      pushed?: boolean;
      error?: string;
      said?: string[];
    };
    for (const line of answer.said ?? []) process.stderr.write(`${line}\n`);
    return answerLine(target, answer);
  } catch (error) {
    box.withdraw();
    return `error ${target} ${(error as Error).message.replace(/\n/g, " ")}`;
  } finally {
    git(["update-ref", "-d", ref]);
  }
};

const main = async (address: string) => {
  const remote = remoteOf(address);
  if ("refused" in remote) return fail(remote.refused);
  const at: Remote = {
    ...remote,
    mirror: `/desolate/mirrors/${remote.repo}.git`,
    gitDir: git(["rev-parse", "--absolute-git-dir"]).stdout.trim(),
  };
  // What this leaves in the out-box, and the request it asks: withdrawn if it is stopped, or
  // if git goes without a signal reaching this (killed alone: its end of the input closes).
  const box = requester();
  process.stdin.once("close", box.left);
  const input = readline.createInterface({ input: process.stdin, terminal: false });
  const say = (text: string) => process.stdout.write(text);
  let batch: string[] = [];
  for await (const line of input) {
    const command = commandOf(line);
    if (command === "capabilities") say("push\n\n");
    else if (command === "list") say([...remoteRefs(at), ""].join("\n") + "\n");
    else if (command === "end") {
      if (batch.length === 0) break;
      for (const spec of batch) say((await pushOne(at, spec, box)) + "\n");
      say("\n");
      batch = [];
    } else if ("push" in command) batch.push(command.push);
    else fail(`unknown command from git: ${line}`);
  }
};

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  await main(process.argv[3] ?? "");
