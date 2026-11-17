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
//   4. The host leaves the answer here; this prints it.
//
// No key, no network, nothing of the root's to run: this VM can ask, and that is all.
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Invoke, Table } from "../../.suede/nests/dsl.import.meta.vitest.ts";

const OUT = "/desolate/out";
/** The host's answers: a directory this VM can read and not write. */
const ANSWERS = "/desolate/answers";
const WAIT_MS = 20 * 60_000;
const POINTER = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:([0-9a-f]{64})\nsize (\d+)\n$/;
const fail = (message: string): never => {
  process.stderr.write(`git-remote-desolate-out: ${message}\n`);
  process.exit(1);
};

/** The remote's address, as git hands it to the helper (its third argument):
 *  `desolate-out::<owner>/<repo>`: a push to the remote (origin), approved by the person.
 *  `desolate-out::<owner>/<repo>@<domain>`: a delivery to that domain (a remote named for it):
 *  the branch appears in its workspaces as root/<branch>, as `git push <domain>` in the root's
 *  terminal does. Nothing leaves the machine, so nothing is asked. */
export const remoteOf = (address: string): { repo: string; domain: string | null } | { refused: string } => {
  const [repo = "", domain = null, ...more] = address.split("@") as [string?, string?, ...string[]];
  if (more.length > 0) return { refused: `'${address}' is not a remote's address` };
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) return { refused: `'${repo}' is not a repository` };
  if (domain !== null && !/^[a-z0-9][a-z0-9-]{0,39}$/.test(domain)) return { refused: `'${domain}' is not a domain` };
  return { repo, domain };
};

declare namespace remoteOf {
  /** a repository, or a repository and the domain it is delivered to */
  export type Addresses = Table<typeof remoteOf, [
    [args: [address: "acme/app"], expected: { repo: "acme/app"; domain: null }],
    [args: [address: "acme/app@acme--app"], expected: { repo: "acme/app"; domain: "acme--app" }],
  ]>;
  /** both become paths and names in the request the host reads */
  export type Refuses = Table<typeof remoteOf, [
    [args: [address: ""], expected: { refused: "'' is not a repository" }],
    [args: [address: "acme"], expected: { refused: "'acme' is not a repository" }],
    [args: [address: "acme/app/x"], expected: { refused: "'acme/app/x' is not a repository" }],
    [args: [address: "acme/app@Dev"], expected: { refused: "'Dev' is not a domain" }],
    [args: [address: "acme/app@"], expected: { refused: "'' is not a domain" }],
    [args: [address: "acme/app@../x"], expected: { refused: "'../x' is not a domain" }],
  ]>;
  /** one @ at most: nothing of an address is dropped unread */
  export type SecondAt = Expect<Invoke<typeof remoteOf, [address: "acme/app@dev@x"]>, "=", { refused: "'acme/app@dev@x' is not a remote's address" }>;
}

/** Where a push of `repo` reads and writes, in the git VM. */
type Remote = { repo: string; domain: string | null; mirror: string; gitDir: string };

const git = (args: string[], input?: string) => spawnSync("git", args, { encoding: "utf8", input, maxBuffer: 256 * 1024 * 1024 });

/** The remote's branches, as the mirror last saw them. */
const mirrorRefs = (at: Remote) => git(["--git-dir", at.mirror, "for-each-ref", "--format=%(objectname) %(refname)", "refs/heads"]).stdout.split("\n").filter(Boolean);
/** A domain's branches, as the root holds them (its clone's refs/remotes/<domain>/*), read the
 *  way `git fetch <domain>` reads them: upload-pack, with nothing of the root's config that
 *  could name a command. */
const domainRefs = (at: Remote, slug: string) =>
  domainRefLines(git(["ls-remote", "--upload-pack=git -c core.alternateRefsCommand=true upload-pack", `/desolate/root/${at.repo}`, `refs/remotes/${slug}/*`]).stdout, slug);
/** ls-remote's lines of a domain's refs, as git's `list` wants them: `<id> refs/heads/<branch>`. */
export const domainRefLines = (lsRemote: string, slug: string): string[] =>
  lsRemote.split("\n").filter(Boolean).map((line) => line.replace(`\trefs/remotes/${slug}/`, " refs/heads/")).filter((line) => /^[0-9a-f]{40} refs\/heads\/\S+$/.test(line));

declare namespace domainRefLines {
  /** the domain's branches, named as the remote's own; anything else ls-remote printed (another
   *  domain's, a name with a space, a short id) is not listed to git */
  export type Lists = Expect<
    Invoke<typeof domainRefLines, [lsRemote: "1111111111111111111111111111111111111111\trefs/remotes/dev/main\n2222222222222222222222222222222222222222\trefs/remotes/dev/issue/12\n3333333333333333333333333333333333333333\trefs/remotes/devx/main\n4444444444444444444444444444444444444444\trefs/remotes/dev/a b\n5555555\trefs/remotes/dev/short\n", slug: "dev"]>,
    "=",
    ["1111111111111111111111111111111111111111 refs/heads/main", "2222222222222222222222222222222222222222 refs/heads/issue/12"]
  >;
}

const remoteRefs = (at: Remote) => (at.domain === null ? mirrorRefs(at) : domainRefs(at, at.domain));

/** The LFS objects a commit's history adds to what the mirror has. */
const lfsOf = (commit: string, have: string[]) => {
  const ids = git(["rev-list", "--objects", commit, ...have.map((id) => `^${id}`)]).stdout.split("\n").map((line) => line.split(" ")[0]!).filter((id) => /^[0-9a-f]{40}$/.test(id));
  if (ids.length === 0) return [];
  const sizes = git(["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], ids.join("\n") + "\n").stdout;
  const oids = new Set<string>();
  for (const line of sizes.split("\n")) {
    const [id, type, size] = line.split(" ");
    if (type !== "blob" || Number(size) >= 400) continue;
    const oid = pointerOid(git(["cat-file", "blob", id!]).stdout);
    if (oid) oids.add(oid);
  }
  return [...oids];
};

/** The LFS object a blob points to, when the blob is git-lfs's pointer exactly. */
export const pointerOid = (blob: string): string | null => POINTER.exec(blob)?.[1] ?? null;

declare namespace pointerOid {
  export type Pointer = Expect<
    Invoke<typeof pointerOid, [blob: "version https://git-lfs.github.com/spec/v1\noid sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\nsize 12\n"]>,
    "=",
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  >;
  /** a file that only looks like one: its object is not looked for, nor copied out */
  export type NotPointers = Table<typeof pointerOid, [
    [args: [blob: "version https://git-lfs.github.com/spec/v1\noid sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\nsize 12"], expected: null],
    [args: [blob: "version https://git-lfs.github.com/spec/v1\noid sha256:../../../../etc/passwd\nsize 12\n"], expected: null],
    [args: [blob: "version https://git-lfs.github.com/spec/v1\noid sha256:0123456789ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef\nsize 12\n"], expected: null],
    [args: [blob: "# notes\nversion https://git-lfs.github.com/spec/v1\noid sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\nsize 12\n"], expected: null],
  ]>;
}

/** What git asks to push (`push <src>:<dst>`, `+` when forced): a branch, from a commit. The
 *  branch's name is not judged here: the host refuses one desolate does not carry
 *  (host/git-vm.ts, isBranch). A refusal is git's own `error <ref> <why>` line. */
export const refspecOf = (spec: string): { forced: boolean; source: string; target: string; branch: string } | { error: string } => {
  const forced = spec.startsWith("+");
  const [source, target] = spec.replace(/^\+/, "").split(":");
  const branch = (target ?? "").replace(/^refs\/heads\//, "");
  if (!target?.startsWith("refs/heads/") || !branch) return { error: `error ${target} desolate pushes branches` };
  if (!source) return { error: `error ${target} deleting a branch on the remote is not something desolate does: delete it on the forge` };
  return { forced, source, target, branch };
};

declare namespace refspecOf {
  export type Branches = Table<typeof refspecOf, [
    [args: [spec: "refs/heads/fix:refs/heads/fix"], expected: { forced: false; source: "refs/heads/fix"; target: "refs/heads/fix"; branch: "fix" }],
    [args: [spec: "+HEAD:refs/heads/issue/12"], expected: { forced: true; source: "HEAD"; target: "refs/heads/issue/12"; branch: "issue/12" }],
    /** a name desolate would not carry gets this far, and no further: the host refuses it */
    [args: [spec: "HEAD:refs/heads/a..b"], expected: { forced: false; source: "HEAD"; target: "refs/heads/a..b"; branch: "a..b" }],
  ]>;
  /** a tag, a note, any ref that is not a branch; and a deletion, which desolate never does */
  export type Refuses = Table<typeof refspecOf, [
    [args: [spec: "refs/tags/v1:refs/tags/v1"], expected: { error: "error refs/tags/v1 desolate pushes branches" }],
    [args: [spec: "refs/notes/commits:refs/notes/commits"], expected: { error: "error refs/notes/commits desolate pushes branches" }],
    [args: [spec: "HEAD:refs/heads/"], expected: { error: "error refs/heads/ desolate pushes branches" }],
    [args: [spec: "HEAD:main"], expected: { error: "error main desolate pushes branches" }],
    [args: [spec: ":refs/heads/fix"], expected: { error: "error refs/heads/fix deleting a branch on the remote is not something desolate does: delete it on the forge" }],
    [args: [spec: "+:refs/heads/fix"], expected: { error: "error refs/heads/fix deleting a branch on the remote is not something desolate does: delete it on the forge" }],
  ]>;
}

/** The host's answer, as git's one line: anything the host said is kept on that line. */
export const answerLine = (target: string, answer: { pushed?: boolean; error?: string }) =>
  answer.pushed ? `ok ${target}` : `error ${target} ${String(answer.error ?? "not pushed").replace(/\n/g, " ")}`;

declare namespace answerLine {
  export type Answers = Table<typeof answerLine, [
    [args: [target: "refs/heads/fix", answer: { pushed: true }], expected: "ok refs/heads/fix"],
    [args: [target: "refs/heads/fix", answer: { pushed: false; error: "you declined it" }], expected: "error refs/heads/fix you declined it"],
    /** a reason of several lines would end git's line early, and the rest be read as commands */
    [args: [target: "refs/heads/fix", answer: { error: "rejected\nok refs/heads/main" }], expected: "error refs/heads/fix rejected ok refs/heads/main"],
    [args: [target: "refs/heads/fix", answer: {}], expected: "error refs/heads/fix not pushed"],
  ]>;
}

/** A line of git's remote-helper protocol, as this helper reads it. */
export const commandOf = (line: string): "capabilities" | "list" | { push: string } | "end" | { unknown: string } =>
  line === "capabilities" ? "capabilities" : line === "list for-push" || line === "list" ? "list" : line.startsWith("push ") ? { push: line.slice(5) } : line === "" ? "end" : { unknown: line };

declare namespace commandOf {
  /** push only: no fetch, no option, no connect; anything else stops the helper */
  export type Protocol = Table<typeof commandOf, [
    [args: [line: "capabilities"], expected: "capabilities"],
    [args: [line: "list for-push"], expected: "list"],
    [args: [line: "list"], expected: "list"],
    [args: [line: "push +HEAD:refs/heads/fix"], expected: { push: "+HEAD:refs/heads/fix" }],
    [args: [line: ""], expected: "end"],
    [args: [line: "fetch 1111111111111111111111111111111111111111 refs/heads/main"], expected: { unknown: "fetch 1111111111111111111111111111111111111111 refs/heads/main" }],
    [args: [line: "option verbosity 1"], expected: { unknown: "option verbosity 1" }],
    [args: [line: "connect git-receive-pack"], expected: { unknown: "connect git-receive-pack" }],
  ]>;
}

const pushOne = async (at: Remote, spec: string): Promise<string> => {
  const asked = refspecOf(spec);
  if ("error" in asked) return asked.error;
  const { forced, source, target, branch } = asked;
  const { repo, domain, gitDir } = at;
  const commit = git(["rev-parse", "--verify", "--quiet", `${source}^{commit}`]).stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) return `error ${target} no such commit`;
  const id = randomBytes(8).toString("hex");
  const ref = `refs/desolate/out/${id}`;
  // What need not travel: what the mirror has (a domain's clone borrows the mirror too).
  const have = mirrorRefs(at).map((line) => line.split(" ")[0]!).filter((tip) => git(["cat-file", "-e", `${tip}^{commit}`]).status === 0);
  try {
    git(["update-ref", ref, commit]);
    const bundle = path.join(OUT, `${id}.bundle`);
    let made = git(["bundle", "create", "--quiet", `${bundle}.part`, ref, ...have.map((tip) => `^${tip}`)]);
    // A commit the remote has already (a new branch at it): the bundle carries its history.
    if (made.status !== 0 && /empty bundle/i.test(made.stderr)) made = git(["bundle", "create", "--quiet", `${bundle}.part`, ref]);
    if (made.status !== 0) return `error ${target} could not bundle the commit: ${made.stderr.trim().split("\n").pop()}`;
    fs.renameSync(`${bundle}.part`, bundle);
    // LFS objects the mirror lacks, from this clone's store.
    const lfs: string[] = [];
    for (const oid of lfsOf(commit, have)) {
      const file = path.join(gitDir, "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4), oid);
      if (!fs.existsSync(file)) continue;
      if (createHash("sha256").update(fs.readFileSync(file)).digest("hex") !== oid) return `error ${target} the LFS object ${oid.slice(0, 12)} here does not hash to its name`;
      fs.copyFileSync(file, path.join(OUT, `${id}.${oid}.lfs`));
      lfs.push(oid);
    }
    const request = path.join(OUT, `${id}.json`);
    fs.writeFileSync(`${request}.part`, JSON.stringify({ repo, branch, commit, forced, lfs, ...(domain === null ? {} : { domain }) }));
    fs.renameSync(`${request}.part`, request);
    process.stderr.write(domain === null
      ? `desolate: handed to the root. Approve it beside this terminal (in the browser tab), or on the approval page (desolate approve --web).\n  ${repo}  ${branch}  ${commit}\n`
      : `desolate: handed to the root, for ${domain}: its workspaces see it as root/${branch} within seconds.\n  ${repo}  ${branch}  ${commit}\n`);
    const result = path.join(ANSWERS, `${id}.json`);
    for (const until = Date.now() + WAIT_MS; Date.now() < until; ) {
      if (fs.existsSync(result)) {
        const answer = JSON.parse(fs.readFileSync(result, "utf8")) as { pushed?: boolean; error?: string; said?: string[] };
        for (const line of answer.said ?? []) process.stderr.write(`${line}\n`);
        return answerLine(target, answer);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return `error ${target} the host did not answer in ${WAIT_MS / 60_000} minutes; nothing is known to be pushed (git fetch origin shows)`;
  } finally {
    git(["update-ref", "-d", ref]);
  }
};

const main = async (address: string) => {
  const remote = remoteOf(address);
  if ("refused" in remote) return fail(remote.refused);
  const at: Remote = { ...remote, mirror: `/desolate/mirrors/${remote.repo}.git`, gitDir: git(["rev-parse", "--absolute-git-dir"]).stdout.trim() };
  const input = readline.createInterface({ input: process.stdin, terminal: false });
  const say = (text: string) => process.stdout.write(text);
  let batch: string[] = [];
  for await (const line of input) {
    const command = commandOf(line);
    if (command === "capabilities") say("push\n\n");
    else if (command === "list") say([...remoteRefs(at), ""].join("\n") + "\n");
    else if (command === "end") {
      if (batch.length === 0) break;
      for (const spec of batch) say((await pushOne(at, spec)) + "\n");
      say("\n");
      batch = [];
    } else if ("push" in command) batch.push(command.push);
    else fail(`unknown command from git: ${line}`);
  }
};

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv[3] ?? "");
