// The reviewer's account of a push (reviewer.ts): what it would send, as the host's approval
// page and terminal show it (shared/review-account.ts has the types). Asked by root for the
// host (review-ask.ts), never by the root's user: what the account says is worked out here
// from commit ids the host gives, and the remote's branches read from the forge itself.
//
// One account is made at a time (each recompresses every object of a push, twice), and it
// takes as long as it takes (R4): a large first push packs for minutes. It says what it is
// doing as it does it, and a request that waits for another says so. Its lists are counted
// and paged (R2): the account holds the first page of each and the true total, and `page`
// gives the rest; `diff` gives any diff of the push, a page of bytes at a time (R1, R8).
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { squashedFrom } from "../shared/approval.ts";
import { withLock } from "../shared/lock.ts";
import { listed, PAGE } from "../shared/listed.ts";
import type { Listed } from "../shared/listed.ts";
import { isBranch, isCommit, parseRepo, repoId } from "../shared/names.ts";
import type { Repo } from "../shared/names.ts";
import type {
  Account,
  AccountBetween,
  AccountCommit,
  AccountFile,
  AccountLine,
  DiffPage,
  Sends,
  Squash,
} from "../shared/review-account.ts";
import { SUEDE_CORE } from "../shared/suede.ts";
import { printable } from "../shared/text.ts";
import { ask } from "./keyring-client.ts";
import { KEYRING, PINNED_FORGE, REVIEWER } from "./layout.ts";
import {
  atomically,
  EMPTY_TREE,
  ensureRepo,
  gitBytes,
  gitIn,
  gitOk,
  gitStream,
  has,
  SENSITIVE,
  shown,
} from "./reviewer-git.ts";
import { PACKS, prepare, prunePacks, storedPack, touchPack } from "./reviewer-packs.ts";
import type { Say } from "./reviewer-packs.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Table } from "../../suede.nests/dsl.import.meta.vitest.ts";

/** The forge's branches, read with the repository's read key: the reviewer's own account of
 *  what the remote has, not the root's user's. */
const remoteOf = async (repo: Repo, dir: string) => {
  const reply = await ask(KEYRING.reviewer, { op: "readkey", repo: repoId(repo) });
  if (reply.ok !== true) throw new Error(String(reply.error ?? "no read key"));
  // In a folder a restart of this service leaves alone: one that cleared the home took the
  // file from under a summary in flight, and its ls-remote was refused (T2, 2026-11-20).
  const identities = path.join(REVIEWER.home, "identities");
  fs.mkdirSync(identities, { recursive: true, mode: 0o700 });
  const identity = path.join(identities, `read-${randomBytes(6).toString("hex")}.pub`);
  fs.writeFileSync(identity, `${String(reply.pubkey).trim()}\n`, { mode: 0o600, flag: "wx" });
  try {
    const f = JSON.parse(fs.readFileSync(PINNED_FORGE.config, "utf8")) as {
      ssh: { user: string; host: string; port: number };
    };
    if (
      !/^[a-z_][a-z0-9_-]*$/.test(f.ssh.user) ||
      !/^[A-Za-z0-9.-]+$/.test(f.ssh.host) ||
      !Number.isInteger(f.ssh.port)
    )
      throw new Error("the forge's address is not well formed");
    const ssh = [
      "ssh",
      "-F",
      "/dev/null",
      "-o",
      `IdentityAgent=${KEYRING.reviewerReadAgent}`,
      "-o",
      `IdentityFile=${identity}`,
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      `UserKnownHostsFile=${PINNED_FORGE.knownHosts}`,
      "-o",
      "ConnectTimeout=20",
    ].join(" ");
    const said = await gitOk(
      dir,
      [
        "ls-remote",
        "--symref",
        `ssh://${f.ssh.user}@${f.ssh.host}:${f.ssh.port}/${repo.owner}/${repo.name}.git`,
        "HEAD",
        "refs/heads/*",
      ],
      // The one conversation here with a peer that is remote: ended when the forge has said
      // nothing for a minute, however long a repository of many branches takes to list.
      { ssh, idleMs: 60_000 },
    );
    const heads = new Map<string, string>();
    let defaultBranch: string | null = null;
    for (const line of said.split("\n").filter(Boolean)) {
      const symref = /^ref: refs\/heads\/(\S+)\tHEAD$/.exec(line);
      if (symref) defaultBranch = symref[1]!;
      const ref = /^([0-9a-f]{40})\trefs\/heads\/(\S+)$/.exec(line);
      if (ref) heads.set(ref[2]!, ref[1]!);
    }
    return { heads, defaultBranch };
  } finally {
    fs.rmSync(identity, { force: true });
  }
};

// ---------------------------------------------------------------- the squash

/** How many commits' subjects the squash's message lists. The message is written into the
 *  forge's history, where nobody pages it: a hundred lines is a long commit message, and
 *  the rest are counted ("- and 412 more"). */
const SQUASH_LISTED = 100;
/** The longest name and email the squash is made with, in characters. Its author and
 *  committer are the push's own, written into the forge's history by a commit the reviewer
 *  makes: one longer is not cut (a cut name is another name), and the squash is not offered.
 *  254 is the longest address mail can carry (RFC 5321's path, less its brackets); 80 is a
 *  long name, and keeps the name and email together inside one line of the page. */
const IDENTITY = { name: 80, email: 254 } as const;

/** The person's other choice: the commits pushed as one. Its tree is the commit's own, its
 *  parent is where the commit leaves the remote's history (what it builds on: `onto`, or the
 *  branch a new one starts from), and its author, committer and dates are the commit's. So
 *  the same push, onto the same remote, always squashes to the same commit (for a new branch,
 *  where it starts depends on the remote's branches the reviewer holds; either way the
 *  approval names the very commit the person was shown). Its message: the first commit's
 *  subject, then every commit's. Null when there is nothing to squash; a sentence when there
 *  is, and it is not offered, saying why. */
const squashOf = async (
  dir: string,
  commit: string,
  from: string | null,
): Promise<Squash | string | null> => {
  const parent = from ? (await gitIn(dir, ["merge-base", commit, from])).stdout.trim() : "";
  if (from && !isCommit(parent)) return null;
  const range = parent ? [commit, `^${parent}`] : [commit];
  const count = Number((await gitOk(dir, ["rev-list", "--count", ...range])).trim()) || 0;
  if (count < 2) return null;
  const subjects = (
    await gitOk(dir, [
      "log",
      "--reverse",
      "--no-decorate",
      "--format=%s",
      "--no-show-signature",
      ...range,
    ])
  )
    .replace(/\n$/, "")
    .split("\n")
    // (An empty message is a commit too: left out, the count and the first subject were wrong.)
    // A subject is one line of the forge's history: past 200 characters it is cut, and the
    // cut is marked there.
    .map((subject) => shown(subject, 200) || "(no message)");
  const list = subjects.slice(0, SQUASH_LISTED).map((s) => `- ${s}`);
  if (subjects.length > SQUASH_LISTED) list.push(`- and ${subjects.length - SQUASH_LISTED} more`);
  const message = `${subjects[0] ?? "Squashed"}\n\nSquashed from ${count} commits:\n${list.join("\n")}\n`;
  const [anRaw, aeRaw, ad, cnRaw, ceRaw, cd] = (
    await gitOk(dir, [
      "log",
      "-1",
      "--no-show-signature",
      "--format=%an%x00%ae%x00%ad%x00%cn%x00%ce%x00%cd",
      "--date=raw",
      commit,
    ])
  )
    .replace(/\n$/, "")
    .split("\x00");
  // Who the squash names, made safe, as the page shows them (the third independent review:
  // copied as they were, an agent's 100 KB "email" would ride along unseen in a commit the
  // reviewer itself made). Dates as git keeps them, or no squash.
  const named = (text: string | undefined) =>
    shown(text ?? "", Infinity)
      .replace(/[<>\n]/g, "?")
      .trim();
  // A committer git cannot read (a line continuing it, which fsck lets by: the review of the
  // fixes) is the author's: the squash is what leaves such a commit's extra lines behind, so
  // it is offered all the same, and shows whom it names.
  const DATE = /^[0-9]{1,12} [+-][0-9]{4}$/;
  const readable = named(cnRaw) !== "" && DATE.test(cd ?? "");
  const [an, ae, cn, ce] = [
    named(anRaw),
    named(aeRaw),
    named(readable ? cnRaw : anRaw),
    named(readable ? ceRaw : aeRaw),
  ];
  for (const [what, value, most] of [
    ["author's name", an, IDENTITY.name],
    ["author's email", ae, IDENTITY.email],
    ["committer's name", cn, IDENTITY.name],
    ["committer's email", ce, IDENTITY.email],
  ] as const)
    if ([...value].length > most)
      return `no squash is offered: the last commit's ${what} is ${[...value].length} characters, over the ${most} a commit desolate's reviewer makes may name`;
  const committedAt = readable ? cd : ad;
  if (!DATE.test(ad ?? "") || !DATE.test(committedAt ?? "")) return null;
  const made = await gitIn(
    dir,
    [
      "commit-tree",
      "--no-gpg-sign",
      ...(parent ? ["-p", parent] : []),
      "-F",
      "-",
      `${commit}^{tree}`,
    ],
    {
      input: message,
      env: {
        GIT_AUTHOR_NAME: an,
        GIT_AUTHOR_EMAIL: ae,
        GIT_AUTHOR_DATE: ad!,
        GIT_COMMITTER_NAME: cn,
        GIT_COMMITTER_EMAIL: ce,
        GIT_COMMITTER_DATE: committedAt!,
      },
    },
  );
  // (git's own identity rules: an author it refuses, say an empty name, gets no squash.)
  if (made.code !== 0) return null;
  const id = made.stdout.trim();
  if (!isCommit(id)) return null;
  // Who and when, read back from the commit as git wrote it (git trims a name's punctuation:
  // what is shown is what is in it, the independent review of #169), dates too.
  const [author, committer, authored, committed] = (
    await gitOk(dir, [
      "log",
      "-1",
      "--no-show-signature",
      "--date=iso-strict",
      "--format=%an <%ae>%x00%cn <%ce>%x00%ad%x00%cd",
      id,
    ])
  )
    .replace(/\n$/, "")
    .split("\x00");
  return {
    commit: id,
    parent: parent || null,
    count,
    message,
    author: shown(author ?? ""),
    committer: shown(committer ?? ""),
    dates: `authored ${shown(authored ?? "")}, committed ${shown(committed ?? "")}`,
  };
};

// ---------------------------------------------------------------- what the commits carry

/** How many commits are read at once for their headers: each answer is held whole (gitBytes
 *  stops at 64 MiB), and 2,000 commits are well under it unless one carries megabytes. */
const COMMITS_AT_ONCE = 2000;

/** Every pushed commit's headers, other than the four every commit has: said, with their size
 *  (the third independent review; then the review of #169: only the 50 listed were read, a
 *  signature, a mergetag or an encoding was taken as git's own and never said, and a read
 *  that failed said nothing). fsck takes any well-formed header, so any could carry data. */
const headerWarnings = async (dir: string, order: string[], say: Say): Promise<string[]> => {
  // The four, as git writes them and in its order, each once (parents any number): what fsck
  // checks. After them, anything, repeated names and continuation lines too, is extra (the
  // review of the fixes: a second `committer` line, or a continuation of the first, passed
  // fsck --strict and receive.fsckObjects, and a match on the name alone took it as git's).
  const PREFIX = /^tree [0-9a-f]{40}\n(parent [0-9a-f]{40}\n)*author [^\n]*\ncommitter [^\n]*\n/;
  const odd: string[] = [];
  let unread = false;
  for (let from = 0; from < order.length && !unread; from += COMMITS_AT_ONCE) {
    say({ phase: "reading the commits' headers", done: from, of: order.length });
    const raw = await gitBytes(
      dir,
      ["cat-file", "--batch"],
      order.slice(from, from + COMMITS_AT_ONCE).join("\n") + "\n",
    );
    if (!raw) unread = true;
    for (let at = 0; raw && at < raw.length;) {
      const end = raw.indexOf(10, at);
      if (end < 0) break;
      const [id, , size] = raw.subarray(at, end).toString("latin1").split(" ");
      const body = raw.subarray(end + 1, end + 1 + Number(size)).toString("utf8");
      const split = body.indexOf("\n\n");
      const head = split < 0 ? `${body}\n` : body.slice(0, split + 1);
      const fixed = PREFIX.exec(head)?.[0] ?? "";
      // A header and its continuation lines (a signature's), with their size.
      const extra: { name: string; bytes: number; value: string }[] = [];
      if (!fixed) extra.push({ name: "malformed headers", bytes: head.length, value: "" });
      // A NUL in a commit: git shows its message only up to it, and what follows rides along
      // unseen. (submit refuses such an object; this says so should one be here all the same.)
      if (body.includes("\0"))
        extra.push({ name: "a NUL, past which git shows nothing", bytes: body.length, value: "" });
      let current: (typeof extra)[number] | null = null;
      for (const line of (fixed ? head.slice(fixed.length) : "").split("\n").slice(0, -1)) {
        if (line.startsWith(" ") && current) current.bytes += line.length + 1;
        else {
          const space = line.indexOf(" ");
          current = {
            name: shown(space < 0 ? line : line.slice(0, space), 40) || "(a line with no name)",
            bytes: line.length + 1,
            value: space < 0 ? "" : line.slice(space + 1),
          };
          extra.push(current);
        }
      }
      const said = extra.map((h) =>
        h.name === "encoding" && h.bytes < 60
          ? `encoding "${shown(h.value, 40)}"`
          : `${h.name} (${h.bytes} bytes${h.name.startsWith("gpgsig") ? ", a signature" : ""})`,
      );
      if (said.length) odd.push(`${String(id).slice(0, 12)}: ${[...new Set(said)].join(", ")}`);
      at = end + 1 + Number(size) + 1;
    }
  }
  const warnings: string[] = [];
  if (unread)
    warnings.push(
      "the commits' headers could not all be read (one over 64 MiB, or git failed): what they carry is not checked here. Squashed, the push is one commit desolate's reviewer made",
    );
  // (Twenty named, and the rest counted: the warning is one sentence of the page.)
  if (odd.length)
    warnings.push(
      `${odd.length} commit(s) carry headers this page does not show, pushed as they are: ${odd.slice(0, 20).join("; ")}${odd.length > 20 ? `; and ${odd.length - 20} more` : ""}. Squashed, the push is one commit desolate's reviewer made, without them`,
    );
  return warnings;
};

/** The commits named, in the order named, as the account lists them. */
const commitsOf = async (dir: string, ids: string[]): Promise<AccountCommit[]> => {
  if (ids.length === 0) return [];
  const said = await gitOk(dir, [
    "log",
    "--no-walk=unsorted",
    "--no-decorate",
    "--no-show-signature",
    "--format=%H%x00%an%x00%s%x00",
    ...ids,
  ]);
  return said
    .split("\x00\n")
    .filter(Boolean)
    .map((entry) => entry.replace(/^\n/, "").split("\x00"))
    .map(([id, author, subject]) => ({
      commit: id!,
      author: shown(author ?? ""),
      subject: shown(subject ?? ""),
    }));
};

// ---------------------------------------------------------------- kept accounts

/** An account as the reviewer keeps it, for `page` and `diff`: the account, and the whole of
 *  each list it pages. `raw`: a file's path as git has it (its shown `path` is made safe). */
type Kept = {
  repo: string;
  commit: string;
  base: string | null;
  order: string[];
  files: (AccountFile & { raw: string })[];
  between: AccountBetween[];
  account: Account;
  /** Each diff's size in bytes, once it has been made: "net", "file:<path>", "commit:<id>". */
  totals: Record<string, number>;
};

/** Accounts are kept for as long as their packs are (an hour since either was last asked
 *  for), and the newest 64: what a page asks for later (more of a list, a diff) is read from
 *  here, and the same push asked about again is not worked out again (the independent review
 *  of #169: a root's user that has the page ask again and again starts no new work). */
const ACCOUNTS = { dir: path.join(REVIEWER.home, "accounts"), most: 64 };
const KEY = /^[0-9a-f]{64}$/;
const keptFile = (key: string) => path.join(ACCOUNTS.dir, `${key}.json`);

const keptOf = (key: string): Kept | null => {
  if (!KEY.test(key)) return null;
  try {
    const file = keptFile(key);
    if (Date.now() - fs.statSync(file).mtimeMs > PACKS.keptMs) return null;
    return JSON.parse(fs.readFileSync(file, "utf8")) as Kept;
  } catch {
    return null;
  }
};
const keep = (kept: Kept) => {
  try {
    fs.mkdirSync(ACCOUNTS.dir, { recursive: true, mode: 0o700 });
    atomically(keptFile(kept.account.key), JSON.stringify(kept));
    const all = fs
      .readdirSync(ACCOUNTS.dir)
      .map((name) => ({
        name,
        at: fs.statSync(path.join(ACCOUNTS.dir, name), { throwIfNoEntry: false })?.mtimeMs ?? 0,
      }))
      .sort((a, b) => b.at - a.at);
    for (const [i, entry] of all.entries())
      if (i >= ACCOUNTS.most || Date.now() - entry.at > PACKS.keptMs)
        fs.rmSync(path.join(ACCOUNTS.dir, entry.name), { force: true });
  } catch {
    /* an account not kept is made again */
  }
};
/** The packs the kept accounts name: never evicted for space (reviewer-packs.ts). */
export const livePacks = (): Set<string> => {
  const live = new Set<string>();
  let names: string[] = [];
  try {
    names = fs.readdirSync(ACCOUNTS.dir).filter((name) => name.endsWith(".json"));
  } catch {
    return live;
  }
  for (const name of names) {
    const kept = keptOf(name.slice(0, -".json".length));
    if (kept?.account.sends.pack) live.add(kept.account.sends.pack);
    if (kept?.account.squash?.sends.pack) live.add(kept.account.squash.sends.pack);
  }
  return live;
};

// ---------------------------------------------------------------- the account

/** One account at a time: each recompresses every object of a push, twice (as it is, and
 *  squashed), and the root VM's memory and disk are every domain's keyring and pusher too.
 *  Held by its process (shared/lock.ts): one whose requester went away is ended, and leaves
 *  the lock to the next at once. */
const LOCK = path.join(REVIEWER.home, "summary.lock");
/** How many of the commits where a new branch leaves the remote's history are tried for the
 *  closest (below). */
const EDGES = 200;

const account = async (
  repo: Repo,
  branch: string,
  commit: string,
  onto: string | null,
  say: Say,
): Promise<AccountLine> => {
  const dir = ensureRepo(repo);
  if (!(await has(dir, commit))) return { error: "the root has not sent the reviewer this commit" };
  say({ phase: "reading the remote's branches" });
  const remote = await remoteOf(repo, dir);
  const known: string[] = [];
  for (const id of new Set(remote.heads.values())) if (await has(dir, id)) known.push(id);
  // The same push against the same remote, asked again (each challenge's page asks anew): the
  // account already made.
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        repoId(repo),
        branch,
        commit,
        onto,
        [...remote.heads].sort(),
        remote.defaultBranch,
        known,
      ]),
    )
    .digest("hex");
  const again = (): AccountLine | null => {
    const kept = keptOf(key);
    const packs = kept ? [kept.account.sends, kept.account.squash?.sends] : [];
    // (Only while the packs it names are kept: gone, it is made again.)
    if (!kept || packs.some((sends) => sends && !storedPack(repo, sends.pack))) return null;
    for (const sends of packs) if (sends) touchPack(repo, sends.pack);
    keep(kept);
    return { account: kept.account };
  };
  const found = again();
  if (found) return found;
  return withLock(LOCK, async () => again() ?? (await made()), {
    waiting: () => say({ phase: "waiting for another push's account" }),
  });

  async function made(): Promise<AccountLine> {
    const warnings: string[] = [];
    const now = remote.heads.get(branch) ?? null;
    if (now !== onto)
      warnings.push(
        now
          ? `the remote's ${branch} is now ${now.slice(0, 12)}, not the ${onto ? onto.slice(0, 12) : "absence"} this push names: the push will be refused`
          : `the remote has no ${branch} any more: the push will be refused`,
      );
    // What the commit is compared with: the branch it moves from, or (for a new branch) the
    // remote's default branch.
    let base =
      onto ?? (remote.defaultBranch ? (remote.heads.get(remote.defaultBranch) ?? null) : null);
    if (base && !(await has(dir, base)))
      return {
        error: `the root has not sent the reviewer ${base.slice(0, 12)}, which this push is compared with`,
      };
    if (known.length < new Set(remote.heads.values()).size)
      warnings.push(
        "some of the remote's branches were not sent to the reviewer: commits on them may be listed as new",
      );
    const unknown = known.map((id) => `^${id}`);
    // A new branch that is not built on the default branch (a suede proposal is built on the
    // dependency's release, which shares nothing with main): compared with where it does
    // leave the remote's history, not with the default branch's whole tree. Where it leaves
    // is one of the commits at the edge of what is new (git's boundary), whatever number of
    // branches the remote has: the one with the fewest new commits since.
    if (
      !onto &&
      base &&
      (await gitIn(dir, ["merge-base", "--is-ancestor", base, commit])).code !== 0
    ) {
      say({ phase: "finding where the branch leaves the remote's history" });
      const newSince = async (from: string) =>
        Number((await gitIn(dir, ["rev-list", "--count", commit, `^${from}`])).stdout.trim());
      const fromDefault = (await gitIn(dir, ["merge-base", commit, base])).stdout.trim();
      let best = isCommit(fromDefault) ? { at: base, count: await newSince(fromDefault) } : null;
      const edge = (await gitOk(dir, ["rev-list", "--boundary", commit, ...unknown]))
        .split("\n")
        .filter((line) => line.startsWith("-"))
        .map((line) => line.slice(1))
        .filter(isCommit);
      // Each edge is two walks of the history, and the root's user shapes the edge (a merge of
      // ten thousand old commits is ten thousand edges): the first 200 are tried, and the
      // account says when there were more, as the comparison may then not be the closest.
      if (edge.length > EDGES)
        warnings.push(
          `the branch leaves the remote's history at ${edge.length} commits: it is compared with the closest of the first ${EDGES}`,
        );
      for (const at of edge.slice(0, EDGES)) {
        const count = await newSince(at);
        if (!best || count < best.count) best = { at, count };
      }
      if (best && best.at !== base) base = best.at;
    }
    say({ phase: "reading the commits" });
    // Every commit the push sends, first to last: counted by being listed, and the list is
    // what pages it and what each commit's headers are read from.
    const order = (await gitOk(dir, ["rev-list", "--reverse", commit, ...unknown]))
      .split("\n")
      .filter(isCommit);
    say({ phase: "reading the files changed" });
    const numstat = await gitOk(dir, [
      "diff",
      "--numstat",
      "-z",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      base ?? EMPTY_TREE,
      commit,
    ]);
    const files: Kept["files"] = [];
    let core = 0;
    for (const part of numstat.split("\x00").filter(Boolean)) {
      const [added, removed, ...name] = part.split("\t");
      const raw = name.join("\t");
      files.push({
        raw,
        path: shown(raw),
        added: Number(added) || 0,
        removed: Number(removed) || 0,
        ...(added === "-" ? { binary: true } : {}),
        ...(SENSITIVE.test(raw) ? { sensitive: true } : {}),
      });
      if (SUEDE_CORE.test(raw)) core += 1;
    }
    if (core)
      warnings.push(
        `it changes suede's own machinery (${core} file(s) under .suede/core/), which every consumer of this code runs: worth a second look`,
      );
    // What runs on the forge first, so on the first page (sort keeps git's order otherwise).
    files.sort((a, b) => Number(Boolean(b.sensitive)) - Number(Boolean(a.sensitive)));
    const sensitive = files.filter((f) => f.sensitive).length;
    if (sensitive > PAGE)
      warnings.push(
        `${sensitive} files change what runs on the forge (under .github/, or the like): they come first in the list of files, past its first page`,
      );
    const fastForward = onto
      ? (await gitIn(dir, ["merge-base", "--is-ancestor", onto, commit])).code === 0
      : null;
    // A replace after a squashed push: named, so the person is told the command that catches
    // up, not only how to replace. Advice: what is pushed and signed does not depend on it.
    const remoteSquash =
      onto && fastForward === false
        ? await squashedFrom((args) => gitIn(dir, args), onto, commit)
        : null;
    warnings.push(...(await headerWarnings(dir, order, say)));
    // What the push sends, made here: the pack, its digest, and its LFS ids. And the squash,
    // with its own.
    prunePacks(livePacks());
    say({ phase: "packing the push" });
    const sends = await prepare(repo, dir, commit, onto, known, say);
    say({ phase: "making the push as one commit" });
    const squashed = await squashOf(dir, commit, onto ?? base);
    if (typeof squashed === "string") warnings.push(squashed);
    let squash: (Squash & { sends: Sends }) | undefined;
    if (squashed && typeof squashed !== "string") {
      say({ phase: "packing the push as one commit" });
      squash = { ...squashed, sends: await prepare(repo, dir, squashed.commit, onto, known, say) };
    }
    // Every file any of the commits changes (a merge: what it changed against all its
    // parents), less the net change: what was changed, then put back.
    say({ phase: "reading the files changed on the way" });
    const touched = await gitOk(dir, [
      "log",
      "--cc",
      "--name-only",
      "-z",
      "--no-renames",
      "--format=",
      "--no-show-signature",
      commit,
      ...unknown,
    ]);
    const net = new Set(files.map((f) => f.raw));
    const between = [
      ...new Set(touched.split("\x00").filter((name) => name !== "" && !net.has(name))),
    ]
      .sort()
      .map((raw) => ({ path: shown(raw), ...(SENSITIVE.test(raw) ? { sensitive: true } : {}) }))
      .sort((a, b) => Number(Boolean(b.sensitive)) - Number(Boolean(a.sensitive)));
    const first = order.slice(0, PAGE);
    const result: Account = {
      key,
      warnings,
      commits: { items: await commitsOf(dir, first), total: order.length, from: 0 },
      files: listed(files.map(({ raw: _, ...file }) => file)),
      between: listed(between),
      sends,
      ...(squash ? { squash } : {}),
      fastForward,
      ...(remoteSquash ? { squashedFrom: remoteSquash } : {}),
      base,
      remote: now,
    };
    keep({
      repo: repoId(repo),
      commit,
      base,
      order,
      files,
      between,
      account: result,
      totals: {},
    });
    return { account: result };
  }
};

// ---------------------------------------------------------------- pages and diffs

const GONE =
  "the reviewer no longer keeps this account (each is kept an hour from when it was last asked for): look at the push again";

/** More of one of a kept account's lists, from entry `from`. */
const page = async (
  key: string,
  list: "commits" | "files" | "between",
  from: number,
): Promise<AccountLine> => {
  const kept = keptOf(key);
  if (!kept) return { error: GONE };
  if (list === "files")
    return {
      page: {
        files: listed(
          kept.files.map(({ raw: _, ...file }) => file),
          from,
        ),
      },
    };
  if (list === "between") return { page: { between: listed(kept.between, from) } };
  const repo = parseRepo(kept.repo)!;
  const ids = listed(kept.order, from);
  const commits: Listed<AccountCommit> = {
    items: await commitsOf(ensureRepo(repo), ids.items),
    total: ids.total,
    from: ids.from,
  };
  return { page: { commits } };
};

/** A page of a diff is at most this many bytes. It travels as one line of the reviewer's
 *  answer (ACCOUNT_LINE_BYTES, 8 MiB), as JSON, where a byte is at most six (`\u0001`): a
 *  MiB of the worst diff is 6 MiB of line. A person reads a MiB of diff a page at a time. */
export const DIFF_PAGE_BYTES = 1024 * 1024;

/** The page of the bytes `held` (which start at `from`, and run on past the page when there
 *  is more) that ends between two lines, or, when one line is longer than a page, between two
 *  characters. `total`: the whole diff's size. */
export const cutPage = (
  bytes: Buffer | string,
  from: number,
  total: number,
  most = DIFF_PAGE_BYTES,
): DiffPage => {
  const held = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
  if (from + held.length >= total && held.length <= most)
    return { text: held.toString("utf8"), from, next: null, total };
  const line = held.lastIndexOf(10, most - 1);
  let cut = line >= 0 ? line + 1 : most;
  // (Within a long line: back to where a character starts. A continuation byte is 10xxxxxx.)
  if (line < 0) while (cut > 1 && (held[cut]! & 0xc0) === 0x80) cut -= 1;
  return { text: held.subarray(0, cut).toString("utf8"), from, next: from + cut, total };
};

declare namespace cutPage {
  /** a page ends after a whole line; the next starts where it ended; the last says so */
  export type Lines = Table<
    typeof cutPage,
    [
      [
        args: [bytes: "+one\n+two\n-x\n", from: 0, total: 12, most: 8],
        expected: { text: "+one\n"; from: 0; next: 5; total: 12 },
      ],
      [
        args: [bytes: "+two\n-x\n", from: 5, total: 12, most: 8],
        expected: { text: "+two\n-x\n"; from: 5; next: null; total: 12 },
      ],
    ]
  >;
  /** a line longer than a page is cut between two characters, never inside one (each é is
   *  two bytes): the next page goes on from there */
  export type LongLine = Table<
    typeof cutPage,
    [
      [
        args: [bytes: "\u00e9\u00e9\u00e9", from: 0, total: 6, most: 3],
        expected: { text: "\u00e9"; from: 0; next: 2; total: 6 },
      ],
    ]
  >;
}

/** The diff `args` makes, from byte `from`: the page there, and the whole diff's size, which is
 *  `total` when it is known (git is ended once the page is read), and counted to the end
 *  when it is not. Null when git failed. */
const pageOf = async (
  dir: string,
  args: string[],
  from: number,
  total: number | undefined,
  say: Say,
): Promise<DiffPage | null> => {
  const start = Math.min(Math.max(0, from), total ?? Infinity);
  // A page, and the few bytes after it that say whether it ends inside a character.
  const want = DIFF_PAGE_BYTES + 4;
  const held: Buffer[] = [];
  let kept = 0;
  let seen = 0;
  let told = 0;
  const code = await gitStream(dir, args, (chunk) => {
    const at = seen;
    seen += chunk.length;
    const a = Math.max(start, at);
    const b = Math.min(start + want, seen);
    if (b > a) {
      held.push(chunk.subarray(a - at, b - at));
      kept += b - a;
    }
    if (Date.now() - told > 1000) {
      told = Date.now();
      say({ phase: "making the diff", done: seen });
    }
    return total === undefined || kept < want;
  });
  if (code !== null && code !== 0) return null;
  return cutPage(Buffer.concat(held), Math.min(start, total ?? seen), total ?? seen);
};

const DETAILED = [
  "--no-ext-diff",
  "--no-textconv",
  "--no-color",
  "--find-renames",
  "--diff-algorithm=histogram",
  "--unified=3",
];
/** Each commit whole: who wrote and committed it, when, its whole message (what a person
 *  pushes is all of it, not the subject alone), and its diff. */
const eachArgs = (ids: string[]) => [
  "log",
  "--no-walk=unsorted",
  "-p",
  "--cc",
  ...DETAILED,
  "--no-show-signature",
  "--no-decorate",
  "--date=iso-strict",
  "--format=commit %H%nAuthor:     %an <%ae>%nAuthorDate: %ad%nCommitter:  %cn <%ce>%nCommitDate: %cd%n%n%w(0,4,4)%B",
  ...ids,
  "--",
];

/** A page of one of a kept account's diffs: the net change, one file's part of it, or one
 *  of its commits whole. */
const diff = async (key: string, of: unknown, from: number, say: Say): Promise<AccountLine> => {
  const kept = keptOf(key);
  if (!kept) return { error: GONE };
  const dir = ensureRepo(parseRepo(kept.repo)!);
  const range = [kept.base ?? EMPTY_TREE, kept.commit];
  let name: string;
  let args: string[];
  if (of === "net") {
    name = "net";
    args = ["diff", ...DETAILED, ...range, "--"];
  } else if (
    typeof of === "object" &&
    of !== null &&
    typeof (of as { file?: unknown }).file === "string"
  ) {
    const file = (of as { file: string }).file;
    // By the path as the account shows it: every file that shows so (two names that differ
    // only in what was made safe are both this one).
    const raws = kept.files.filter((f) => f.path === file).map((f) => f.raw);
    if (raws.length === 0)
      return { error: `the push does not change a file named ${printable(file, 300)}` };
    name = `file:${file}`;
    args = ["diff", ...DETAILED, ...range, "--", ...raws.map((raw) => `:(literal)${raw}`)];
  } else if (
    typeof of === "object" &&
    of !== null &&
    typeof (of as { commit?: unknown }).commit === "string"
  ) {
    const id = (of as { commit: string }).commit;
    if (!isCommit(id) || !kept.order.includes(id))
      return { error: `${printable(id, 80)} is not one of the commits this push sends` };
    name = `commit:${id}`;
    args = eachArgs([id]);
  } else return { error: "a diff is of the net change, of one file, or of one commit" };
  const made = await pageOf(dir, args, from, kept.totals[name], say);
  if (!made) return { error: "git could not make this diff" };
  if (kept.totals[name] === undefined)
    keep({ ...kept, totals: { ...kept.totals, [name]: made.total } });
  return { diff: made };
};

// ---------------------------------------------------------------- the requests

const whole = (n: unknown) => (typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : null);

/** The reviewer's answer to one request from the host (shared/review-account.ts's
 *  AccountRequest), as the one answer line; `say` is told what it is doing on the way.
 *  A request that is not one is an error, said. */
export const answer = async (request: unknown, say: Say): Promise<AccountLine> => {
  const r = (typeof request === "object" && request !== null ? request : {}) as Record<
    string,
    unknown
  >;
  if (r.op === "account") {
    const repo = parseRepo(r.repo);
    const onto = r.onto ?? null;
    if (!repo || !isBranch(r.branch) || !isCommit(r.commit) || (onto !== null && !isCommit(onto)))
      return { error: "an account names a repository, a branch, a commit and onto" };
    return account(repo, r.branch, r.commit, onto as string | null, say);
  }
  if (typeof r.key !== "string" || !KEY.test(r.key))
    return { error: "a page or a diff names the account it is of, by its key" };
  if (r.op === "page") {
    const from = whole(r.from);
    if ((r.list !== "commits" && r.list !== "files" && r.list !== "between") || from === null)
      return { error: "a page names a list (commits, files or between) and where it starts" };
    return page(r.key, r.list, from);
  }
  if (r.op === "diff") {
    const from = r.from === undefined ? 0 : whole(r.from);
    if (from === null) return { error: "a diff's page starts at a whole number of bytes" };
    return diff(r.key, r.of, from, say);
  }
  return { error: `unknown request '${printable(r.op, 40)}'` };
};
