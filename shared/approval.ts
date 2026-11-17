// What a person approves when they approve a push (P2, section 5.3): one text, made by the
// keyring in the root VM, shown and signed by the approver ON THE HOST, checked by the
// keyring again. Both ends parse it with this file, and a text that does not survive
// parse -> format unchanged is not an approval.
//
// The nonce is the keyring's: it makes each approval a single use of a challenge the
// keyring itself issued, so a signature seen once approves nothing later.
import { isBranch, isCommit, parseRepo, repoId } from "./names.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Invoke, Table } from "../../suede.nests/dsl.import.meta.vitest.ts";

/** `onto`: what the remote's branch is now, as the root last saw it (`null`: the branch is
 *  new). The push is a compare-and-swap on the remote: the branch moves from exactly `onto`
 *  to exactly `commit`, or not at all (root/pusher.ts asks the remote for that, and nothing
 *  else). Whether `commit` builds on `onto` or replaces it is what the reviewer shows the
 *  person (root/reviewer.ts); either way it is this one change of this one branch. */
export type PushApproval = { repo: string; branch: string; commit: string; onto: string | null; nonce: string };

const HEAD = "desolate push approval v2";
const NONCE = /^[0-9a-f]{32}$/;

export const formatApproval = (a: PushApproval): string =>
  [HEAD, `repo: ${a.repo}`, `branch: ${a.branch}`, `commit: ${a.commit}`, `onto: ${a.onto ?? "none"}`, `nonce: ${a.nonce}`, ""].join("\n");

declare namespace formatApproval {
  /** the text the person reads and signs: one field a line, in this order */
  export type Text = Expect<
    Invoke<typeof formatApproval, [a: { repo: "acme/widgets"; branch: "issue/12"; commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; onto: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"; nonce: "0123456789abcdef0123456789abcdef" }]>,
    "=",
    "desolate push approval v2\nrepo: acme/widgets\nbranch: issue/12\ncommit: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nonto: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\nnonce: 0123456789abcdef0123456789abcdef\n"
  >;
  /** a new branch moves from nothing: `none`, never the protocol's zero id */
  export type NewBranch = Expect<
    Invoke<typeof formatApproval, [a: { repo: "acme/widgets"; branch: "issue/12"; commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; onto: null; nonce: "0123456789abcdef0123456789abcdef" }]>,
    "includes",
    "\nonto: none\n"
  >;
}

export const parseApproval = (text: unknown): PushApproval | null => {
  if (typeof text !== "string" || text.length > 1024) return null;
  const lines = text.split("\n");
  if (lines.length !== 7 || lines[0] !== HEAD || lines[6] !== "") return null;
  const field = (line: string | undefined, name: string) => (line?.startsWith(`${name}: `) ? line.slice(name.length + 2) : null);
  const repo = parseRepo(field(lines[1], "repo"));
  const branch = field(lines[2], "branch");
  const commit = field(lines[3], "commit");
  const onto = field(lines[4], "onto");
  const nonce = field(lines[5], "nonce");
  if (!repo || !isBranch(branch) || !isCommit(commit) || nonce === null || !NONCE.test(nonce)) return null;
  if (onto !== "none" && !isCommit(onto)) return null;
  // The protocol's "no such ref" is not a commit: a branch is new by `none`, and a push
  // never deletes.
  if (/^0{40}$/.test(commit) || onto === "0".repeat(40)) return null;
  const parsed: PushApproval = { repo: repoId(repo), branch, commit, onto: onto === "none" ? null : onto, nonce };
  return formatApproval(parsed) === text ? parsed : null;
};

declare namespace parseApproval {
  /** what formatApproval wrote comes back as it was, for a branch that moves and for a new one */
  export type RoundTrip = [
    Expect<Invoke<typeof parseApproval, [text: Invoke<typeof formatApproval, [a: { repo: "acme/widgets"; branch: "issue/12"; commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; onto: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"; nonce: "0123456789abcdef0123456789abcdef" }]>]>, "=", { repo: "acme/widgets"; branch: "issue/12"; commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; onto: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"; nonce: "0123456789abcdef0123456789abcdef" }>,
    Expect<Invoke<typeof parseApproval, [text: Invoke<typeof formatApproval, [a: { repo: "acme/widgets"; branch: "issue/12"; commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; onto: null; nonce: "0123456789abcdef0123456789abcdef" }]>]>, "=", { repo: "acme/widgets"; branch: "issue/12"; commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; onto: null; nonce: "0123456789abcdef0123456789abcdef" }>,
  ];
  /** anything but that exact text approves nothing. The first row is the control; each other
   *  is it changed once: another version, a line more, no final newline, CRLF, a branch that
   *  climbs or carries an escape, a repository that is a path, a short commit, an upper-case
   *  nonce, two fields swapped */
  export type Refuses = Table<typeof parseApproval, [
    [args: [text: "desolate push approval v2\nrepo: acme/widgets\nbranch: issue/12\ncommit: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nonto: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\nnonce: 0123456789abcdef0123456789abcdef\n"], expected: { repo: "acme/widgets"; branch: "issue/12"; commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; onto: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"; nonce: "0123456789abcdef0123456789abcdef" }],
    [args: [text: "desolate push approval v1\nrepo: acme/widgets\nbranch: issue/12\ncommit: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nonto: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\nnonce: 0123456789abcdef0123456789abcdef\n"], expected: null],
    [args: [text: "desolate push approval v2\nrepo: acme/widgets\nbranch: issue/12\ncommit: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nonto: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\nnonce: 0123456789abcdef0123456789abcdef\nextra: 1\n"], expected: null],
    [args: [text: "desolate push approval v2\nrepo: acme/widgets\nbranch: issue/12\ncommit: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nonto: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\nnonce: 0123456789abcdef0123456789abcdef"], expected: null],
    [args: [text: "desolate push approval v2\r\nrepo: acme/widgets\r\nbranch: issue/12\r\ncommit: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\r\nonto: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\r\nnonce: 0123456789abcdef0123456789abcdef\r\n"], expected: null],
    [args: [text: "desolate push approval v2\nrepo: acme/widgets\nbranch: ../../etc\ncommit: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nonto: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\nnonce: 0123456789abcdef0123456789abcdef\n"], expected: null],
    [args: [text: "desolate push approval v2\nrepo: acme/widgets\nbranch: x\u001b[2J\ncommit: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nonto: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\nnonce: 0123456789abcdef0123456789abcdef\n"], expected: null],
    [args: [text: "desolate push approval v2\nrepo: acme/widgets/x\nbranch: issue/12\ncommit: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nonto: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\nnonce: 0123456789abcdef0123456789abcdef\n"], expected: null],
    [args: [text: "desolate push approval v2\nrepo: acme/widgets\nbranch: issue/12\ncommit: aaaaaaa\nonto: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\nnonce: 0123456789abcdef0123456789abcdef\n"], expected: null],
    [args: [text: "desolate push approval v2\nrepo: acme/widgets\nbranch: issue/12\ncommit: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nonto: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\nnonce: 0123456789ABCDEF0123456789ABCDEF\n"], expected: null],
    [args: [text: "desolate push approval v2\nbranch: issue/12\nrepo: acme/widgets\ncommit: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nonto: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\nnonce: 0123456789abcdef0123456789abcdef\n"], expected: null],
    [args: [text: 7], expected: null],
  ]>;
  /** the protocol's zero id means "no such ref": as the commit it would delete the branch, as
   *  `onto` it would stand in for `none`. Neither is approved */
  export type ZeroId = Table<typeof parseApproval, [
    [args: [text: "desolate push approval v2\nrepo: acme/widgets\nbranch: issue/12\ncommit: 0000000000000000000000000000000000000000\nonto: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\nnonce: 0123456789abcdef0123456789abcdef\n"], expected: null],
    [args: [text: "desolate push approval v2\nrepo: acme/widgets\nbranch: issue/12\ncommit: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nonto: 0000000000000000000000000000000000000000\nnonce: 0123456789abcdef0123456789abcdef\n"], expected: null],
  ]>;
}
