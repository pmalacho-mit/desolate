// What a person approves when they approve a push (P2, section 5.3): one text, made by the
// keyring in the root VM, shown and signed by the approver ON THE HOST, checked by the
// keyring again. Both ends parse it with this file, and a text that does not survive
// parse -> format unchanged is not an approval.
//
// The nonce is the keyring's: it makes each approval a single use of a challenge the
// keyring itself issued, so a signature seen once approves nothing later.
import { createHash } from "node:crypto";
import { isBranch, isCommit, parseRepo, repoId } from "./names.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Invoke, Table } from "../../suede.nests/dsl.import.meta.vitest.ts";

/** `onto`: what the remote's branch is now, as the root last saw it (`null`: the branch is
 *  new). The push is a compare-and-swap on the remote: the branch moves from exactly `onto`
 *  to exactly `commit`, or not at all (root/pusher.ts asks the remote for that, and nothing
 *  else). Whether `commit` builds on `onto` or replaces it is what the reviewer shows the
 *  person (root/reviewer.ts); either way it is this one change of this one branch. */
export type PushApproval = {
  repo: string;
  branch: string;
  commit: string;
  onto: string | null;
  nonce: string;
};

const HEAD = "desolate push approval v2";
const NONCE = /^[0-9a-f]{32}$/;

export const formatApproval = (a: PushApproval): string =>
  [
    HEAD,
    `repo: ${a.repo}`,
    `branch: ${a.branch}`,
    `commit: ${a.commit}`,
    `onto: ${a.onto ?? "none"}`,
    `nonce: ${a.nonce}`,
    "",
  ].join("\n");

declare namespace formatApproval {
  /** the text the person reads and signs: one field a line, in this order */
  export type Text = Expect<
    Invoke<
      typeof formatApproval,
      [
        a: {
          repo: "acme/widgets";
          branch: "issue/12";
          commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
          onto: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
          nonce: "0123456789abcdef0123456789abcdef";
        },
      ]
    >,
    "=",
    "desolate push approval v2\nrepo: acme/widgets\nbranch: issue/12\ncommit: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nonto: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\nnonce: 0123456789abcdef0123456789abcdef\n"
  >;
  /** a new branch moves from nothing: `none`, never the protocol's zero id */
  export type NewBranch = Expect<
    Invoke<
      typeof formatApproval,
      [
        a: {
          repo: "acme/widgets";
          branch: "issue/12";
          commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
          onto: null;
          nonce: "0123456789abcdef0123456789abcdef";
        },
      ]
    >,
    "includes",
    "\nonto: none\n"
  >;
}

export const parseApproval = (text: unknown): PushApproval | null => {
  if (typeof text !== "string" || text.length > 1024) return null;
  const lines = text.split("\n");
  if (lines.length !== 7 || lines[0] !== HEAD || lines[6] !== "") return null;
  const field = (line: string | undefined, name: string) =>
    line?.startsWith(`${name}: `) ? line.slice(name.length + 2) : null;
  const repo = parseRepo(field(lines[1], "repo"));
  const branch = field(lines[2], "branch");
  const commit = field(lines[3], "commit");
  const onto = field(lines[4], "onto");
  const nonce = field(lines[5], "nonce");
  if (!repo || !isBranch(branch) || !isCommit(commit) || nonce === null || !NONCE.test(nonce))
    return null;
  if (onto !== "none" && !isCommit(onto)) return null;
  // The protocol's "no such ref" is not a commit: a branch is new by `none`, and a push
  // never deletes.
  if (/^0{40}$/.test(commit) || onto === "0".repeat(40)) return null;
  const parsed: PushApproval = {
    repo: repoId(repo),
    branch,
    commit,
    onto: onto === "none" ? null : onto,
    nonce,
  };
  return formatApproval(parsed) === text ? parsed : null;
};

/** What the person signs: the keyring's challenge (above), and what desolate's reviewer says
 *  the push sends, put in by the HOST from the reviewer's own answer (root/reviewer.ts, asked
 *  as root), never by the root's ordinary user:
 *  - `pack`: the sha256 of the very pack the reviewer made of the commits (the objects
 *    `commit` has that the remote's branches do not, and nothing else). The pusher forwards a
 *    pack only if it hashes to this, so no other object rides along;
 *  - `lfs`: how many LFS objects those commits point to, and the sha256 of their entries,
 *    each `<oid> <size>` as its pointer says (sorted, unique, one a line). The pusher uploads
 *    only those, at those sizes;
 *  - `squashes`: none, or the commit the person reviewed when they chose to push it squashed
 *    into one: `commit` is then the reviewer's squash of it (its tree, on the commit it leaves
 *    the remote's history at). Either way the keyring checks the text answers its challenge
 *    (`answers`): the same repository, branch, onto and nonce, and `squashes`, or else
 *    `commit`, the challenge's commit. That `commit` is a squash of it the keyring cannot
 *    check: the host's signature vouches for it, made from the reviewer's account.
 */
export type SignedApproval = PushApproval & {
  squashes: string | null;
  pack: string;
  lfs: { count: number; digest: string };
};

const SIGNED = "desolate push approval v3";
const SHA256 = /^[0-9a-f]{64}$/;

export const formatSigned = (a: SignedApproval): string =>
  [
    SIGNED,
    `repo: ${a.repo}`,
    `branch: ${a.branch}`,
    `commit: ${a.commit}`,
    `onto: ${a.onto ?? "none"}`,
    `squashes: ${a.squashes ?? "none"}`,
    `pack: ${a.pack}`,
    `lfs: ${a.lfs.count} ${a.lfs.digest}`,
    `nonce: ${a.nonce}`,
    "",
  ].join("\n");

export const parseSigned = (text: unknown): SignedApproval | null => {
  if (typeof text !== "string" || text.length > 1024) return null;
  const lines = text.split("\n");
  if (lines.length !== 10 || lines[0] !== SIGNED || lines[9] !== "") return null;
  const field = (line: string | undefined, name: string) =>
    line?.startsWith(`${name}: `) ? line.slice(name.length + 2) : null;
  // The challenge's five fields, read by the challenge's own rules.
  const challenge = parseApproval(
    [
      HEAD,
      lines[1],
      lines[2],
      lines[3],
      lines[4],
      lines[8]?.startsWith("nonce: ") ? lines[8] : "",
      "",
    ].join("\n"),
  );
  const squashes = field(lines[5], "squashes");
  const pack = field(lines[6], "pack");
  const lfs = /^(0|[1-9][0-9]{0,5}) ([0-9a-f]{64})$/.exec(field(lines[7], "lfs") ?? "");
  if (!challenge || squashes === null || pack === null || !SHA256.test(pack) || !lfs) return null;
  if (squashes !== "none" && (!isCommit(squashes) || /^0{40}$/.test(squashes))) return null;
  if (squashes === challenge.commit) return null;
  const parsed: SignedApproval = {
    ...challenge,
    squashes: squashes === "none" ? null : squashes,
    pack,
    lfs: { count: Number(lfs[1]), digest: lfs[2]! },
  };
  return formatSigned(parsed) === text ? parsed : null;
};

/** The digest the text carries for a push's LFS objects: sha256 over their entries (each
 *  `<oid> <size>`), sorted and unique, one a line. The pusher computes it of the list it is
 *  sent, and uploads only what is on it, at that size. */
export const lfsDigest = (oids: readonly string[]): string =>
  createHash("sha256")
    .update(
      [...new Set(oids)]
        .sort()
        .map((oid) => `${oid}\n`)
        .join(""),
    )
    .digest("hex");

/** The signed text for a challenge (the keyring's text), as the host makes it from the
 *  reviewer's answer. */
export const signedFor = (
  message: unknown,
  sends: {
    commit: string;
    squashes: string | null;
    pack: string;
    lfs: { count: number; digest: string };
  },
): string => {
  const challenge = parseApproval(message);
  if (!challenge) throw new Error("not a push approval; nothing was signed");
  return formatSigned({
    ...challenge,
    commit: sends.commit,
    squashes: sends.squashes,
    pack: sends.pack,
    lfs: { count: sends.lfs.count, digest: sends.lfs.digest },
  });
};

/** After a squashed push, the remote's branch is one commit the workspace's branch does not
 *  have, so its next push would replace the remote's. The command, run in the workspace,
 *  that puts the branch on that commit: what was squashed is dropped (the squash has the very
 *  same files), what was committed since is kept on top (a merge as a merge: the review of
 *  #169 found a plain rebase made new copies of what a merge brought in), and uncommitted
 *  work is set aside and put back. With nothing since, the branch simply becomes the remote's.
 *  `local`: the workspace's branch, when it is known to have the remote's name; without it,
 *  the branch checked out. */
export const catchUp = (branch: string, squashed: string, local?: string): string => {
  if (!isBranch(branch) || !isCommit(squashed) || (local !== undefined && !isBranch(local)))
    throw new Error("not a branch and a commit");
  return `git fetch && git rebase --rebase-merges --autostash --onto origin/${branch} ${squashed}${local ? ` ${local}` : ""}`;
};
declare namespace catchUp {
  /** the branch's name and the commit squashed, as they are (a branch name is never one a
   *  shell reads specially: names.ts) */
  export type Cases = Table<
    typeof catchUp,
    [
      [
        args: [
          branch: "fix/login",
          squashed: "0123456789abcdef0123456789abcdef01234567",
          local: "fix/login",
        ],
        expected: "git fetch && git rebase --rebase-merges --autostash --onto origin/fix/login 0123456789abcdef0123456789abcdef01234567 fix/login",
      ],
      /** the branch checked out, when the workspace's may have another name */
      [
        args: [branch: "fix", squashed: "0123456789abcdef0123456789abcdef01234567"],
        expected: "git fetch && git rebase --rebase-merges --autostash --onto origin/fix 0123456789abcdef0123456789abcdef01234567",
      ],
    ]
  >;
}

/** Whether the remote's branch, at `onto`, is a squash of a commit of `commit`'s history:
 *  one commit, with that commit's files, on a parent that commit builds on. What a squashed
 *  push leaves, and the usual reason a workspace's next push does not build on the remote's.
 *  That commit, or null. `git` runs git in a repository holding both. */
export const squashedFrom = async (
  git: (args: string[]) => Promise<{ code: number; stdout: string }>,
  onto: string,
  commit: string,
): Promise<string | null> => {
  const [, ...parents] = (await git(["rev-list", "--parents", "-n", "1", onto])).stdout
    .trim()
    .split(" ");
  const tree = (await git(["rev-parse", "--verify", "--quiet", `${onto}^{tree}`])).stdout.trim();
  const parent = parents[0];
  if (parents.length !== 1 || !parent || !isCommit(parent) || !/^[0-9a-f]{40}$/.test(tree))
    return null;
  // Newest first, so with the same files twice, the commit nearer the tip.
  const mine = await git(["log", "--format=%H %T", "--max-count=10000", commit, `^${parent}`]);
  const found =
    mine.stdout
      .split("\n")
      .map((line) => line.split(" "))
      .find(([id, t]) => t === tree && isCommit(id))?.[0] ?? null;
  return found && (await git(["merge-base", "--is-ancestor", parent, found])).code === 0
    ? found
    : null;
};

/** Is a signed text about this challenge: the same repository, branch, onto and nonce, and
 *  the challenge's commit as it is, or (`squashes`) squashed? */
export const answers = (signed: SignedApproval, challenge: PushApproval): boolean =>
  signed.repo === challenge.repo &&
  signed.branch === challenge.branch &&
  signed.onto === challenge.onto &&
  signed.nonce === challenge.nonce &&
  (signed.squashes === null
    ? signed.commit === challenge.commit
    : signed.squashes === challenge.commit);

declare namespace formatSigned {
  /** the text the person signs: the challenge's fields, then what the push sends, the nonce last */
  export type Text = Expect<
    Invoke<
      typeof formatSigned,
      [
        a: {
          repo: "acme/widgets";
          branch: "issue/12";
          commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
          onto: null;
          squashes: null;
          pack: "1111111111111111111111111111111111111111111111111111111111111111";
          lfs: {
            count: 0;
            digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
          };
          nonce: "0123456789abcdef0123456789abcdef";
        },
      ]
    >,
    "=",
    "desolate push approval v3\nrepo: acme/widgets\nbranch: issue/12\ncommit: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nonto: none\nsquashes: none\npack: 1111111111111111111111111111111111111111111111111111111111111111\nlfs: 0 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\nnonce: 0123456789abcdef0123456789abcdef\n"
  >;
}

declare namespace parseSigned {
  /** what formatSigned wrote comes back as it was */
  export type RoundTrip = Expect<
    Invoke<
      typeof parseSigned,
      [
        text: "desolate push approval v3\nrepo: acme/widgets\nbranch: issue/12\ncommit: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nonto: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\nsquashes: cccccccccccccccccccccccccccccccccccccccc\npack: 1111111111111111111111111111111111111111111111111111111111111111\nlfs: 2 2222222222222222222222222222222222222222222222222222222222222222\nnonce: 0123456789abcdef0123456789abcdef\n",
      ]
    >,
    "=",
    {
      repo: "acme/widgets";
      branch: "issue/12";
      commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      onto: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
      nonce: "0123456789abcdef0123456789abcdef";
      squashes: "cccccccccccccccccccccccccccccccccccccccc";
      pack: "1111111111111111111111111111111111111111111111111111111111111111";
      lfs: {
        count: 2;
        digest: "2222222222222222222222222222222222222222222222222222222222222222";
      };
    }
  >;
  /** anything but that exact text approves nothing. The first row is the control; each other
   *  is it changed once: the challenge's own text (v2), no pack, a short pack, an lfs line
   *  with no digest, a commit that squashes itself, a line more */
  export type Refuses = Table<
    typeof parseSigned,
    [
      [
        args: [
          text: "desolate push approval v3\nrepo: acme/widgets\nbranch: issue/12\ncommit: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nonto: none\nsquashes: none\npack: 1111111111111111111111111111111111111111111111111111111111111111\nlfs: 0 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\nnonce: 0123456789abcdef0123456789abcdef\n",
        ],
        expected: {
          repo: "acme/widgets";
          branch: "issue/12";
          commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
          onto: null;
          nonce: "0123456789abcdef0123456789abcdef";
          squashes: null;
          pack: "1111111111111111111111111111111111111111111111111111111111111111";
          lfs: {
            count: 0;
            digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
          };
        },
      ],
      [
        args: [
          text: "desolate push approval v2\nrepo: acme/widgets\nbranch: issue/12\ncommit: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nonto: none\nnonce: 0123456789abcdef0123456789abcdef\n",
        ],
        expected: null,
      ],
      [
        args: [
          text: "desolate push approval v3\nrepo: acme/widgets\nbranch: issue/12\ncommit: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nonto: none\nsquashes: none\nlfs: 0 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\nnonce: 0123456789abcdef0123456789abcdef\n",
        ],
        expected: null,
      ],
      [
        args: [
          text: "desolate push approval v3\nrepo: acme/widgets\nbranch: issue/12\ncommit: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nonto: none\nsquashes: none\npack: 1111\nlfs: 0 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\nnonce: 0123456789abcdef0123456789abcdef\n",
        ],
        expected: null,
      ],
      [
        args: [
          text: "desolate push approval v3\nrepo: acme/widgets\nbranch: issue/12\ncommit: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nonto: none\nsquashes: none\npack: 1111111111111111111111111111111111111111111111111111111111111111\nlfs: 3\nnonce: 0123456789abcdef0123456789abcdef\n",
        ],
        expected: null,
      ],
      [
        args: [
          text: "desolate push approval v3\nrepo: acme/widgets\nbranch: issue/12\ncommit: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nonto: none\nsquashes: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\npack: 1111111111111111111111111111111111111111111111111111111111111111\nlfs: 0 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\nnonce: 0123456789abcdef0123456789abcdef\n",
        ],
        expected: null,
      ],
      [
        args: [
          text: "desolate push approval v3\nrepo: acme/widgets\nbranch: issue/12\ncommit: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nonto: none\nsquashes: none\npack: 1111111111111111111111111111111111111111111111111111111111111111\nlfs: 0 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\nnonce: 0123456789abcdef0123456789abcdef\nextra: 1\n",
        ],
        expected: null,
      ],
    ]
  >;
}

declare namespace lfsDigest {
  /** over the entries sorted and unique, one a line: the same list in any order, or repeated,
   *  is the same digest; none at all is sha256 of nothing */
  export type Digests = Table<
    typeof lfsDigest,
    [
      [
        args: [oids: []],
        expected: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      ],
      [
        args: [
          oids: [
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 7",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 12",
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 7",
          ],
        ],
        expected: "ad009674bf78536e78346c47e5847044e9c607ad2c0f38f34dd848db0cbbbfaf",
      ],
    ]
  >;
}

declare namespace answers {
  /** the challenge's commit as it is, or another commit that squashes it, under its nonce;
   *  never another commit alone, a squash of another, another branch or another onto */
  export type Cases = Table<
    typeof answers,
    [
      [
        args: [
          signed: {
            repo: "acme/app";
            branch: "fix";
            commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            onto: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
            nonce: "0123456789abcdef0123456789abcdef";
            squashes: null;
            pack: "1111111111111111111111111111111111111111111111111111111111111111";
            lfs: {
              count: 0;
              digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
            };
          },
          challenge: {
            repo: "acme/app";
            branch: "fix";
            commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            onto: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
            nonce: "0123456789abcdef0123456789abcdef";
          },
        ],
        expected: true,
      ],
      [
        args: [
          signed: {
            repo: "acme/app";
            branch: "fix";
            commit: "cccccccccccccccccccccccccccccccccccccccc";
            onto: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
            nonce: "0123456789abcdef0123456789abcdef";
            squashes: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            pack: "1111111111111111111111111111111111111111111111111111111111111111";
            lfs: {
              count: 0;
              digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
            };
          },
          challenge: {
            repo: "acme/app";
            branch: "fix";
            commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            onto: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
            nonce: "0123456789abcdef0123456789abcdef";
          },
        ],
        expected: true,
      ],
      [
        args: [
          signed: {
            repo: "acme/app";
            branch: "fix";
            commit: "cccccccccccccccccccccccccccccccccccccccc";
            onto: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
            nonce: "0123456789abcdef0123456789abcdef";
            squashes: null;
            pack: "1111111111111111111111111111111111111111111111111111111111111111";
            lfs: {
              count: 0;
              digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
            };
          },
          challenge: {
            repo: "acme/app";
            branch: "fix";
            commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            onto: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
            nonce: "0123456789abcdef0123456789abcdef";
          },
        ],
        expected: false,
      ],
      [
        args: [
          signed: {
            repo: "acme/app";
            branch: "fix";
            commit: "cccccccccccccccccccccccccccccccccccccccc";
            onto: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
            nonce: "0123456789abcdef0123456789abcdef";
            squashes: "dddddddddddddddddddddddddddddddddddddddd";
            pack: "1111111111111111111111111111111111111111111111111111111111111111";
            lfs: {
              count: 0;
              digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
            };
          },
          challenge: {
            repo: "acme/app";
            branch: "fix";
            commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            onto: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
            nonce: "0123456789abcdef0123456789abcdef";
          },
        ],
        expected: false,
      ],
      [
        args: [
          signed: {
            repo: "acme/app";
            branch: "main";
            commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            onto: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
            nonce: "0123456789abcdef0123456789abcdef";
            squashes: null;
            pack: "1111111111111111111111111111111111111111111111111111111111111111";
            lfs: {
              count: 0;
              digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
            };
          },
          challenge: {
            repo: "acme/app";
            branch: "fix";
            commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            onto: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
            nonce: "0123456789abcdef0123456789abcdef";
          },
        ],
        expected: false,
      ],
      [
        args: [
          signed: {
            repo: "acme/app";
            branch: "fix";
            commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            onto: null;
            nonce: "0123456789abcdef0123456789abcdef";
            squashes: null;
            pack: "1111111111111111111111111111111111111111111111111111111111111111";
            lfs: {
              count: 0;
              digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
            };
          },
          challenge: {
            repo: "acme/app";
            branch: "fix";
            commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            onto: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
            nonce: "0123456789abcdef0123456789abcdef";
          },
        ],
        expected: false,
      ],
    ]
  >;
}

declare namespace parseApproval {
  /** what formatApproval wrote comes back as it was, for a branch that moves and for a new one */
  export type RoundTrip = [
    Expect<
      Invoke<
        typeof parseApproval,
        [
          text: Invoke<
            typeof formatApproval,
            [
              a: {
                repo: "acme/widgets";
                branch: "issue/12";
                commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
                onto: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
                nonce: "0123456789abcdef0123456789abcdef";
              },
            ]
          >,
        ]
      >,
      "=",
      {
        repo: "acme/widgets";
        branch: "issue/12";
        commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        onto: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        nonce: "0123456789abcdef0123456789abcdef";
      }
    >,
    Expect<
      Invoke<
        typeof parseApproval,
        [
          text: Invoke<
            typeof formatApproval,
            [
              a: {
                repo: "acme/widgets";
                branch: "issue/12";
                commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
                onto: null;
                nonce: "0123456789abcdef0123456789abcdef";
              },
            ]
          >,
        ]
      >,
      "=",
      {
        repo: "acme/widgets";
        branch: "issue/12";
        commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        onto: null;
        nonce: "0123456789abcdef0123456789abcdef";
      }
    >,
  ];
  /** anything but that exact text approves nothing. The first row is the control; each other
   *  is it changed once: another version, a line more, no final newline, CRLF, a branch that
   *  climbs or carries an escape, a repository that is a path, a short commit, an upper-case
   *  nonce, two fields swapped */
  export type Refuses = Table<
    typeof parseApproval,
    [
      [
        args: [
          text: "desolate push approval v2\nrepo: acme/widgets\nbranch: issue/12\ncommit: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nonto: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\nnonce: 0123456789abcdef0123456789abcdef\n",
        ],
        expected: {
          repo: "acme/widgets";
          branch: "issue/12";
          commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
          onto: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
          nonce: "0123456789abcdef0123456789abcdef";
        },
      ],
      [
        args: [
          text: "desolate push approval v1\nrepo: acme/widgets\nbranch: issue/12\ncommit: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nonto: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\nnonce: 0123456789abcdef0123456789abcdef\n",
        ],
        expected: null,
      ],
      [
        args: [
          text: "desolate push approval v2\nrepo: acme/widgets\nbranch: issue/12\ncommit: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nonto: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\nnonce: 0123456789abcdef0123456789abcdef\nextra: 1\n",
        ],
        expected: null,
      ],
      [
        args: [
          text: "desolate push approval v2\nrepo: acme/widgets\nbranch: issue/12\ncommit: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nonto: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\nnonce: 0123456789abcdef0123456789abcdef",
        ],
        expected: null,
      ],
      [
        args: [
          text: "desolate push approval v2\r\nrepo: acme/widgets\r\nbranch: issue/12\r\ncommit: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\r\nonto: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\r\nnonce: 0123456789abcdef0123456789abcdef\r\n",
        ],
        expected: null,
      ],
      [
        args: [
          text: "desolate push approval v2\nrepo: acme/widgets\nbranch: ../../etc\ncommit: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nonto: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\nnonce: 0123456789abcdef0123456789abcdef\n",
        ],
        expected: null,
      ],
      [
        args: [
          text: "desolate push approval v2\nrepo: acme/widgets\nbranch: x\u001b[2J\ncommit: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nonto: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\nnonce: 0123456789abcdef0123456789abcdef\n",
        ],
        expected: null,
      ],
      [
        args: [
          text: "desolate push approval v2\nrepo: acme/widgets/x\nbranch: issue/12\ncommit: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nonto: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\nnonce: 0123456789abcdef0123456789abcdef\n",
        ],
        expected: null,
      ],
      [
        args: [
          text: "desolate push approval v2\nrepo: acme/widgets\nbranch: issue/12\ncommit: aaaaaaa\nonto: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\nnonce: 0123456789abcdef0123456789abcdef\n",
        ],
        expected: null,
      ],
      [
        args: [
          text: "desolate push approval v2\nrepo: acme/widgets\nbranch: issue/12\ncommit: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nonto: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\nnonce: 0123456789ABCDEF0123456789ABCDEF\n",
        ],
        expected: null,
      ],
      [
        args: [
          text: "desolate push approval v2\nbranch: issue/12\nrepo: acme/widgets\ncommit: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nonto: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\nnonce: 0123456789abcdef0123456789abcdef\n",
        ],
        expected: null,
      ],
      [args: [text: 7], expected: null],
    ]
  >;
  /** the protocol's zero id means "no such ref": as the commit it would delete the branch, as
   *  `onto` it would stand in for `none`. Neither is approved */
  export type ZeroId = Table<
    typeof parseApproval,
    [
      [
        args: [
          text: "desolate push approval v2\nrepo: acme/widgets\nbranch: issue/12\ncommit: 0000000000000000000000000000000000000000\nonto: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\nnonce: 0123456789abcdef0123456789abcdef\n",
        ],
        expected: null,
      ],
      [
        args: [
          text: "desolate push approval v2\nrepo: acme/widgets\nbranch: issue/12\ncommit: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nonto: 0000000000000000000000000000000000000000\nnonce: 0123456789abcdef0123456789abcdef\n",
        ],
        expected: null,
      ],
    ]
  >;
}
