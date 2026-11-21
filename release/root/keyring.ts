// The keyring: the only process that holds private deploy keys (P3). From v2's keyring.ts,
// with v3's two changes: a key per ROLE, and a write key that signs only after a person
// approved that exact push (P2, section 5.3).
//
// THE CONTROL PROTOCOL has no export or read operation, by design. Everything it can do is
// something a root process could do by other means (make a key, read a public key); nothing
// it can do yields private key material, or deletes a key. Adding one would undo this file.
//
// TWO AGENTS, because fetches must not prompt and pushes must:
//   read-agent   holds each repository's read key. Signs freely.
//   write-agent  holds each pushable repository's write key, added with `ssh-add -c`: for
//                every signature ssh-agent runs keyring-askpass, which allows it only if an
//                approval for that repository is on file and the pusher has claimed it.
//
// AN APPROVAL IS A SIGNATURE MADE OUTSIDE THIS VM. The keyring issues a challenge naming
// the repository, branch and commit (shared/approval.ts); the approver on the HOST shows it
// to the person and signs it (on the host's terminal, or Touch ID if chosen; see host/approver.ts); the keyring files
// the approval only if that signature verifies against the approver's public key, which
// root installed at /etc/desolate/approver.pub. Nothing in this VM holds the approver's
// private key, so nothing in this VM can approve a push: not a script, not a fabricated
// terminal, not the root's own user. Anyone may ASK (challenge, approve); only the host's
// approver can answer.
/// <reference types="node" />
import { execFileSync, spawn } from "node:child_process";
import { createPublicKey, randomBytes, verify } from "node:crypto";
import * as fs from "node:fs";
import { connect, createServer } from "node:net";
import type { Socket } from "node:net";
import * as path from "node:path";
import {
  answers,
  formatApproval,
  parseApproval,
  parseSigned,
  signedFor,
} from "../shared/approval.ts";
import { parseRepo, repoId, isBranch, isCommit } from "../shared/names.ts";
import type { Repo } from "../shared/names.ts";
import { KEYRING } from "./layout.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Given, Invoke, Table } from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { aKeysDir, emptyRoot, myUid, readIn, writeIn } from "../.harness/root-state.ts";

export type Role = "read" | "write";
const isRole = (value: unknown): value is Role => value === "read" || value === "write";

const log = (message: string) => console.error(`keyring: ${message}`);
const keyFile = (repo: Repo, role: Role) => path.join(KEYRING.keys, repo.owner, repo.name, role);
const pubFile = (repo: Repo, role: Role) =>
  path.join(KEYRING.pub, repo.owner, repo.name, `${role}.pub`);
/** ssh-agent's own socket for a role. Only the keyring's user can open it. */
const agentOf = (role: Role) => path.join(KEYRING.private, `${role}-agent.sock`);
/** The key's comment is how keyring-askpass learns which repository a signature is for. */
export const commentOf = (repo: Repo, role: Role) => `desolate-${role}:${repoId(repo)}`;

declare namespace commentOf {
  /** what keyring-askpass reads to learn which repository a write signature is for */
  export type Names = Table<
    typeof commentOf,
    [
      [
        args: [repo: { owner: "acme"; name: "app" }, role: "write"],
        expected: "desolate-write:acme/app",
      ],
      [
        args: [repo: { owner: "acme"; name: "app" }, role: "read"],
        expected: "desolate-read:acme/app",
      ],
    ]
  >;
}

const audit = (entry: Record<string, unknown>) => {
  fs.appendFileSync(
    KEYRING.audit,
    JSON.stringify({ time: new Date().toISOString(), ...entry }) + "\n",
    { mode: 0o640 },
  );
};

const publish = (repo: Repo, role: Role) => {
  const target = pubFile(repo, role);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
  fs.copyFileSync(`${keyFile(repo, role)}.pub`, target);
  fs.chmodSync(target, 0o644);
};

const load = (repo: Repo, role: Role) => {
  // -c: confirm before each use. ssh-agent then runs $SSH_ASKPASS for every signature.
  const args = role === "write" ? ["-c", keyFile(repo, role)] : [keyFile(repo, role)];
  execFileSync("ssh-add", args, {
    env: { ...process.env, SSH_AUTH_SOCK: agentOf(role) },
    stdio: ["ignore", "ignore", "pipe"],
  });
};

const held = (): { repo: Repo; role: Role }[] => {
  const out: { repo: Repo; role: Role }[] = [];
  const dirs = (dir: string) => {
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
    } catch {
      return [];
    }
  };
  for (const owner of dirs(KEYRING.keys))
    for (const name of dirs(path.join(KEYRING.keys, owner))) {
      const repo = parseRepo(`${owner}/${name}`);
      if (!repo) continue;
      for (const role of ["read", "write"] as const)
        if (fs.existsSync(`${keyFile(repo, role)}.pub`)) out.push({ repo, role });
    }
  return out;
};

const create = (repo: Repo, role: Role): string => {
  const key = keyFile(repo, role);
  fs.mkdirSync(path.dirname(key), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(key)) {
    execFileSync(
      "ssh-keygen",
      ["-q", "-t", "ed25519", "-f", key, "-N", "", "-C", commentOf(repo, role)],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    fs.chmodSync(key, 0o600);
    log(`generated the ${role} key for ${repoId(repo)}`);
    audit({ event: "created", repo: repoId(repo), role });
    load(repo, role);
  }
  publish(repo, role);
  return fs.readFileSync(`${key}.pub`, "utf8").trim();
};

// ---------------------------------------------------------------- approvals (P2)
// WHAT LIVES HOW LONG. A request for an approval, and an approval, live as long as something is
// waiting for them, and that something is a connection to this process: the one who asked
// (a raw push: root/raw-push.ts) holds its challenge's connection open while it waits for the
// person, and the pusher holds its claim's open while it pushes. When the connection closes
// (Ctrl-C, a closed terminal, a process that ended however it ended) what it held goes, at
// once. The kernel closes a dead process's sockets, so no clock is needed to notice. What
// nobody holds has a clock instead (CHALLENGE, APPROVAL below), and says why.

/** `claimed`: the pusher has begun the push (pusherOps). Only then may the write key sign, and
 *  from then the approval lives while the pusher's connection does (`holder`), for that one
 *  push. Before it, `holder` is the connection of whoever asked for the push, if one does: the
 *  approval goes when it closes. */
export type Approval = {
  id: string;
  repo: string;
  ref: string;
  commit: string;
  onto: string | null;
  /** The commit the person reviewed, when they approved it squashed into `commit`. */
  squashes: string | null;
  /** What the push sends, as the person signed it: the pusher sends nothing else. */
  pack: string;
  lfs: { count: number; digest: string };
  /** Until the claim: when it can no longer be claimed. Claimed: null (it lives while the
   *  pusher's connection does). */
  expires: number | null;
  uses: number;
  by: string;
  claimed: boolean;
  holder: Socket | null;
};
const approvals = new Map<string, Approval>();
/** An approval covers one push, and is claimed by the pusher the moment it is handed the push.
 *  `lifeMs`: the most time from the person's click to that claim. It is a clock on purpose,
 *  though the one who asked holds the approval too: the root's ordinary user is that one, and
 *  without it could keep an approved push and make it land long after the person took it for
 *  failed (the compare-and-swap on `onto` stops it only if the remote moved). Two minutes
 *  is the pusher starting between two pushes (root/send.ts asks it again for as long as
 *  this) and the moment the push takes to begin. `desolate push` copies the pack from the
 *  reviewer before it files the approval, so that copy is not on this clock; a raw push
 *  learns which pack only from the approval, and copies it on it (docs/v3/limits/03-push-lifetimes.md).
 *  `uses`: write-key signatures, all of them the pusher's (only it reaches the write agent):
 *  one for the receive-pack ssh, and one for each `git-lfs-authenticate` git-lfs makes, once
 *  for the upload and again each time the token it was given expires (the T2 forge's lasts
 *  600 s). Eight is a hard bound on what a pusher gone wrong could do with one approval: it
 *  bounds an LFS upload to about seven token lifetimes, and a push that needs more is refused
 *  its next signature, in the keyring's audit. */
export const APPROVAL = { lifeMs: 120_000, uses: 8 } as const;

/** Challenges this keyring issued and nobody has answered yet. A held one (`holder`) lives as
 *  long as its asker's connection; one nobody holds lives `lifeMs`: what `desolate push` asks
 *  for (root/push.ts `prepare`) and answers in another process, after the person typed or
 *  touched on the host (the terminal approver's own wait must be shorter: host/approver.ts).
 *  Few: a process that asks in a loop gets the oldest ones dropped (and their askers told),
 *  not memory. What an asker gains by holding one for a day is that line on the approval page:
 *  answering it still takes the person's signature over its exact text, once. */
type Challenge = { message: string; expires: number | null; holder: Socket | null };
const challenges = new Map<string, Challenge>();
export const CHALLENGE = { lifeMs: 120_000, outstanding: 32 } as const;

/** Connections that hold something (a challenge, an approval): they are not counted against
 *  LIMIT.concurrent, so pushes waiting for a person never fill the socket. What bounds them is
 *  what they hold: CHALLENGE.outstanding, and approvals, each a person's signature. */
const holders = new Set<Socket>();
const uncounted = new WeakMap<Socket, () => void>();
const hold = (connection: Socket) => {
  if (holders.has(connection)) return;
  holders.add(connection);
  uncounted.get(connection)?.();
  // On the asker's end, before this side closes: so an asker that waits for the close (the
  // pusher, done) knows what it held is gone, and its record (audit) written.
  connection.once("end", () => released(connection));
  connection.once("close", () => released(connection));
};
/** Whoever held `connection` stopped waiting: what it held goes. */
const released = (connection: Socket) => {
  if (!holders.delete(connection)) return;
  for (const [nonce, entry] of challenges)
    if (entry.holder === connection) challenges.delete(nonce);
  for (const approval of approvals.values())
    if (approval.holder === connection) {
      approvals.delete(approval.id);
      audit({
        event: "revoked",
        approval: approval.id,
        why: approval.claimed
          ? "the pusher is done with it"
          : "whoever asked for it stopped waiting before its push began",
      });
    }
};
const holdsAnything = (connection: Socket) =>
  [...challenges.values()].some((entry) => entry.holder === connection) ||
  [...approvals.values()].some((approval) => approval.holder === connection);
const tell = (connection: Socket | null, line: Record<string, unknown>) => {
  if (connection && !connection.destroyed) connection.write(JSON.stringify(line) + "\n");
};

/** A challenge for one push. With `hold: true`, the asker's connection holds it: it has no
 *  clock, is dropped the moment that connection closes, and the asker is told on it when the
 *  person approves (`{"approved": ...}`) or when it was dropped for newer ones
 *  (`{"dropped": ...}`). */
const challenge = (
  request: Record<string, unknown>,
  connection?: Socket,
): Record<string, unknown> => {
  const repo = parseRepo(request.repo);
  if (
    !repo ||
    !isBranch(request.ref) ||
    !isCommit(request.commit) ||
    /^0{40}$/.test(request.commit)
  )
    return { ok: false, error: "a challenge names a repository, a branch and a 40-hex commit" };
  if (!fs.existsSync(keyFile(repo, "write")))
    return { ok: false, error: `${repoId(repo)} has no write key: it is not pushable` };
  for (const [nonce, entry] of challenges)
    if (entry.expires !== null && entry.expires < Date.now()) challenges.delete(nonce);
  while (challenges.size >= CHALLENGE.outstanding) {
    const [nonce, oldest] = challenges.entries().next().value!;
    challenges.delete(nonce);
    tell(oldest.holder, {
      dropped: nonce,
      error: `the keyring dropped this push's request: more than ${CHALLENGE.outstanding} were waiting at once`,
    });
    if (oldest.holder && !holdsAnything(oldest.holder)) oldest.holder.end();
  }
  const onto = request.onto ?? null;
  if (onto !== null && (!isCommit(onto) || /^0{40}$/.test(onto)))
    return {
      ok: false,
      error: "a push names what the remote's branch is now (a commit), or null for a new branch",
    };
  const nonce = randomBytes(16).toString("hex");
  const message = formatApproval({
    repo: repoId(repo),
    branch: request.ref,
    commit: request.commit,
    onto: onto as string | null,
    nonce,
  });
  const holder = request.hold === true && connection ? connection : null;
  challenges.set(nonce, {
    message,
    expires: holder ? null : Date.now() + CHALLENGE.lifeMs,
    holder,
  });
  if (holder) hold(holder);
  return { ok: true, message };
};

declare namespace challenge {
  // A repository is pushable when the keyring holds its write key (made by `create`).
  type Fresh = Invoke<typeof emptyRoot>;
  type Pushable = Invoke<
    typeof writeIn,
    [where: "sys", name: "keyring/acme/app/write", text: "a private key"]
  >;
  type Issued = Invoke<
    typeof challenge,
    [
      request: {
        repo: "acme/app";
        ref: "feature/login";
        commit: "0123456789abcdef0123456789abcdef01234567";
        onto: null;
      },
    ]
  >;
  /** anyone may ask: the challenge is the text the host's approver will show and sign,
   *  naming exactly this push and a nonce of the keyring's */
  export type Issues = Given<
    [Fresh, Pushable, Issued],
    [
      Expect<Issued, "matches", { ok: true }>,
      Expect<
        Invoke<typeof parseApproval, [text: Issued["message"]]>,
        "matches",
        {
          repo: "acme/app";
          branch: "feature/login";
          commit: "0123456789abcdef0123456789abcdef01234567";
          onto: null;
        }
      >,
    ]
  >;
  /** what the remote's branch is now, when it is not new: the push moves it from exactly that */
  export type Onto = Given<
    [Fresh, Pushable],
    Expect<
      Invoke<
        typeof parseApproval,
        [
          text: Invoke<
            typeof challenge,
            [
              request: {
                repo: "acme/app";
                ref: "main";
                commit: "0123456789abcdef0123456789abcdef01234567";
                onto: "89abcdef0123456789abcdef0123456789abcdef";
              },
            ]
          >["message"],
        ]
      >,
      "matches",
      { onto: "89abcdef0123456789abcdef0123456789abcdef" }
    >
  >;
  /** a repository with no write key is not pushable, and gets no challenge */
  export type NotPushable = Given<
    Fresh,
    Expect<
      Invoke<
        typeof challenge,
        [
          request: {
            repo: "acme/app";
            ref: "main";
            commit: "0123456789abcdef0123456789abcdef01234567";
          },
        ]
      >,
      "=",
      { ok: false; error: "acme/app has no write key: it is not pushable" }
    >
  >;
  /** nothing that is not a repository, a branch and a whole commit; never the all-zero id
   *  (git's "no such ref", which would make a push a deletion) */
  export type Refuses = Table<
    typeof challenge,
    [
      [
        args: [
          request: {
            repo: "acme/../x";
            ref: "main";
            commit: "0123456789abcdef0123456789abcdef01234567";
          },
        ],
        expected: {
          ok: false;
          error: "a challenge names a repository, a branch and a 40-hex commit";
        },
      ],
      [
        args: [
          request: {
            repo: "acme/app";
            ref: "--upload-pack=x";
            commit: "0123456789abcdef0123456789abcdef01234567";
          },
        ],
        expected: {
          ok: false;
          error: "a challenge names a repository, a branch and a 40-hex commit";
        },
      ],
      [
        args: [request: { repo: "acme/app"; ref: "main"; commit: "HEAD" }],
        expected: {
          ok: false;
          error: "a challenge names a repository, a branch and a 40-hex commit";
        },
      ],
      [
        args: [
          request: {
            repo: "acme/app";
            ref: "main";
            commit: "0000000000000000000000000000000000000000";
          },
        ],
        expected: {
          ok: false;
          error: "a challenge names a repository, a branch and a 40-hex commit";
        },
      ],
    ]
  >;
  /** and `onto` is a whole commit or null: never git's all-zero id, never a branch name */
  export type BadOnto = Given<
    [Fresh, Pushable],
    [
      Expect<
        Invoke<
          typeof challenge,
          [
            request: {
              repo: "acme/app";
              ref: "main";
              commit: "0123456789abcdef0123456789abcdef01234567";
              onto: "0000000000000000000000000000000000000000";
            },
          ]
        >,
        "=",
        {
          ok: false;
          error: "a push names what the remote's branch is now (a commit), or null for a new branch";
        }
      >,
      Expect<
        Invoke<
          typeof challenge,
          [
            request: {
              repo: "acme/app";
              ref: "main";
              commit: "0123456789abcdef0123456789abcdef01234567";
              onto: "main";
            },
          ]
        >,
        "=",
        {
          ok: false;
          error: "a push names what the remote's branch is now (a commit), or null for a new branch";
        }
      >,
    ]
  >;
}

/** The approver's public key. Trusted only as root installed it: a file this VM's ordinary
 *  users could have replaced is no key at all (P6). */
const approverKey = (): { key: ReturnType<typeof createPublicKey> } | { error: string } => {
  try {
    for (const file of [path.dirname(KEYRING.approver), KEYRING.approver]) {
      const stat = fs.statSync(file);
      if (stat.uid !== 0 || (stat.mode & 0o022) !== 0)
        return { error: `${file} is not root's alone to write, so it is not trusted` };
    }
    return { key: createPublicKey(fs.readFileSync(KEYRING.approver, "utf8")) };
  } catch (error) {
    return {
      error: `no approver key is installed at ${KEYRING.approver} (${(error as Error).message}); run \`desolate bootstrap\` on the host`,
    };
  }
};

/** The person's answer to a challenge, filed. The approval is held by whoever held the
 *  challenge, or, with `hold: true`, by this connection (`desolate push`, root/push.ts, whose
 *  challenge nobody held): it goes when that connection closes before the pusher claims it. */
const approve = (
  request: Record<string, unknown>,
  connection?: Socket,
): Record<string, unknown> => {
  // The text the person signed: the challenge's fields, and what the push sends, put in by
  // the host from desolate's reviewer (shared/approval.ts).
  const parsed = parseSigned(request.message);
  if (!parsed) return { ok: false, error: "that is not an approval message" };
  const refused = (reason: string) => {
    audit({
      event: "refused",
      repo: parsed.repo,
      ref: parsed.branch,
      commit: parsed.commit,
      reason,
    });
    return { ok: false, error: reason };
  };
  const issued = challenges.get(parsed.nonce);
  const asked = issued ? parseApproval(issued.message) : null;
  if (!issued || !asked || (issued.expires !== null && issued.expires < Date.now()))
    return refused(NOT_OUTSTANDING);
  // About this challenge's push: its repository, branch and onto, and its commit as it is,
  // or the squash of it the person chose.
  if (!answers(parsed, asked))
    return refused("that approval is not for the push this challenge names");
  const approver = approverKey();
  if ("error" in approver) return refused(approver.error);
  let valid = false;
  try {
    valid =
      typeof request.signature === "string" &&
      verify(
        "sha256",
        Buffer.from(String(request.message)),
        approver.key,
        Buffer.from(request.signature, "base64"),
      );
  } catch {
    valid = false;
  }
  if (!valid) return refused("the approval's signature is not the host approver's");
  challenges.delete(parsed.nonce);
  const repo = parseRepo(parsed.repo)!;
  if (!fs.existsSync(keyFile(repo, "write")))
    return refused(`${parsed.repo} has no write key: it is not pushable`);
  const id = `${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;
  const holder = request.hold === true && connection ? connection : issued.holder;
  const approval: Approval = {
    id,
    repo: parsed.repo,
    ref: parsed.branch,
    commit: parsed.commit,
    onto: parsed.onto,
    squashes: parsed.squashes,
    pack: parsed.pack,
    lfs: parsed.lfs,
    expires: Date.now() + APPROVAL.lifeMs,
    uses: APPROVAL.uses,
    by: "host approver",
    claimed: false,
    holder,
  };
  approvals.set(id, approval);
  if (holder) hold(holder);
  const { holder: _, ...recorded } = approval;
  audit({ event: "approved", ...recorded, expires: new Date(approval.expires!).toISOString() });
  const answer = { id, commit: approval.commit, pack: approval.pack };
  // The one who asked learns it on the connection it waits on (raw-push.ts), not by asking.
  if (issued.holder && issued.holder !== connection)
    tell(issued.holder, { approved: { nonce: parsed.nonce, ...answer } });
  return { ok: true, ...answer };
};

const NOT_OUTSTANDING =
  "that challenge is not outstanding: each approves once, and only while whoever asked for it waits";

declare namespace approve {
  type Fresh = Invoke<typeof emptyRoot>;
  type Pushable = Invoke<
    typeof writeIn,
    [where: "sys", name: "keyring/acme/app/write", text: "a private key"]
  >;
  type Issued = Invoke<
    typeof challenge,
    [
      request: {
        repo: "acme/app";
        ref: "feature/login";
        commit: "0123456789abcdef0123456789abcdef01234567";
        onto: null;
      },
    ]
  >;
  /** The text the host signs for that challenge: it, with what the reviewer says it sends. */
  type Signed = Invoke<
    typeof signedFor,
    [
      message: Issued["message"],
      sends: {
        commit: "0123456789abcdef0123456789abcdef01234567";
        squashes: null;
        pack: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
        lfs: [];
      },
    ]
  >;
  /** And one under the same nonce about another commit, which squashes nothing of it. */
  type Another = Invoke<
    typeof signedFor,
    [
      message: Issued["message"],
      sends: {
        commit: "89abcdef0123456789abcdef0123456789abcdef";
        squashes: null;
        pack: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
        lfs: [];
      },
    ]
  >;
  /** a text that answers the challenge's nonce but names another push is refused before any
   *  signature is looked at: a nonce approves only the push it was issued for */
  export type NotItsPush = Given<
    [Fresh, Pushable, Issued],
    Expect<
      Invoke<typeof approve, [request: { message: Another; signature: "AAAA" }]>,
      "=",
      { ok: false; error: "that approval is not for the push this challenge names" }
    >
  >;
  /** a challenge the keyring issued, answered with a signature that is not the host
   *  approver's, files no approval: the push it names is still not approved. (The approver's
   *  key is root's, at /etc/desolate: a test cannot install one, so the signature that would
   *  pass is T2's and T4's to show.) */
  export type NotTheApprovers = Given<
    [Fresh, Pushable, Issued],
    [
      Expect<
        Invoke<
          typeof approve,
          [request: { message: Signed; signature: "c2lnbmVkIGJ5IHNvbWVvbmUgZWxzZQ==" }]
        >,
        "matches",
        { ok: false }
      >,
      Expect<
        Invoke<typeof consume, [request: { repo: "acme/app" }]>,
        "=",
        { ok: false; error: "no person has approved a push to acme/app" }
      >,
    ]
  >;
  /** a well-formed approval text the keyring never issued (or issued and has forgotten) is
   *  refused before any signature is looked at, and the refusal is audited */
  export type NotIssued = Given<
    Fresh,
    [
      Expect<
        Invoke<
          typeof approve,
          [
            request: {
              message: "desolate push approval v3\nrepo: acme/app\nbranch: main\ncommit: 0123456789abcdef0123456789abcdef01234567\nonto: none\nsquashes: none\npack: eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\nlfs: 0 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\nnonce: 00112233445566778899aabbccddeeff\n";
              signature: "AAAA";
            },
          ]
        >,
        "=",
        {
          ok: false;
          error: "that challenge is not outstanding: each approves once, and only while whoever asked for it waits";
        }
      >,
      Expect<
        Invoke<typeof readIn, [where: "sys", name: "keyring/audit.log"]>,
        "includes",
        '"event":"refused","repo":"acme/app","ref":"main"'
      >,
    ]
  >;
  /** text that is not an approval is not one */
  export type NotAnApproval = Expect<
    Invoke<typeof approve, [request: { message: "approve everything"; signature: "AAAA" }]>,
    "=",
    { ok: false; error: "that is not an approval message" }
  >;
}

/** ssh-agent is about to sign with a write key. Allowed only against a live approval. */
const consume = (request: Record<string, unknown>): Record<string, unknown> => {
  const repo = String(request.repo ?? "");
  let spent: Approval | null = null;
  for (const approval of approvals.values()) {
    if (approval.expires !== null && approval.expires < Date.now()) {
      approvals.delete(approval.id);
      continue;
    }
    if (approval.repo !== repo || !approval.claimed) continue;
    if (approval.uses <= 0) {
      spent = approval;
      continue;
    }
    approval.uses -= 1;
    audit({
      event: "signed",
      repo,
      approval: approval.id,
      ref: approval.ref,
      commit: approval.commit,
    });
    return { ok: true, approval: approval.id };
  }
  if (spent) {
    audit({ event: "refused", repo, approval: spent.id, reason: "its signatures are used" });
    return {
      ok: false,
      error: `the approval of this push to ${repo} has made its ${APPROVAL.uses} signatures`,
    };
  }
  audit({ event: "refused", repo, reason: "no approval on file" });
  return { ok: false, error: `no person has approved a push to ${repo}` };
};

declare namespace consume {
  type Fresh = Invoke<typeof emptyRoot>;
  /** ssh-agent asks before every write-key signature: with no approval a person gave, the
   *  answer is no, and the refusal is audited */
  export type NoApproval = Given<
    Fresh,
    [
      Expect<
        Invoke<typeof consume, [request: { repo: "acme/app" }]>,
        "=",
        { ok: false; error: "no person has approved a push to acme/app" }
      >,
      Expect<
        Invoke<typeof readIn, [where: "sys", name: "keyring/audit.log"]>,
        "includes",
        '"event":"refused","repo":"acme/app","reason":"no approval on file"'
      >,
    ]
  >;
}

// ---------------------------------------------------------------- the sockets
/** The control socket's operations (exported for T1, which drives them on a real connection). */
export const publicOps = (
  request: Record<string, unknown>,
  connection?: Socket,
): Record<string, unknown> => {
  const { op } = request;
  if (op === "list")
    return { ok: true, keys: held().map(({ repo, role }) => ({ repo: repoId(repo), role })) };
  if (op === "audit") {
    let lines: string[] = [];
    try {
      lines = fs.readFileSync(KEYRING.audit, "utf8").trim().split("\n").filter(Boolean);
    } catch {
      /* nothing audited yet */
    }
    const last = Math.min(Number(request.last) || 50, 500);
    return { ok: true, entries: lines.slice(-last).map((line) => JSON.parse(line)) };
  }
  // Asking for an approval is open to every root process; granting one takes the host
  // approver's signature. Taking one back is closing the connection that holds it.
  if (op === "challenge") return challenge(request, connection);
  if (op === "approve") return approve(request, connection);
  if (op === "create" || op === "pubkey") {
    const repo = parseRepo(request.repo);
    if (!repo) return { ok: false, error: `not a repository: ${String(request.repo)}` };
    if (!isRole(request.role)) return { ok: false, error: "role is 'read' or 'write'" };
    if (op === "create")
      return {
        ok: true,
        pubkey: create(repo, request.role),
        identity: pubFile(repo, request.role),
      };
    if (op === "pubkey") {
      if (!fs.existsSync(`${keyFile(repo, request.role)}.pub`))
        return { ok: false, error: `no ${request.role} key for ${repoId(repo)}` };
      publish(repo, request.role);
      return {
        ok: true,
        pubkey: fs.readFileSync(`${keyFile(repo, request.role)}.pub`, "utf8").trim(),
        identity: pubFile(repo, request.role),
      };
    }
  }
  return {
    ok: false,
    error: `unknown op '${String(op)}': this socket has no operation that returns private key material, by design (see keyring.ts)`,
  };
};

declare namespace publicOps {
  type Fresh = Invoke<typeof emptyRoot>;
  /** there is no operation that returns a private key: asking for one is an unknown op, said so */
  export type NoExport = [
    Expect<
      Invoke<typeof publicOps, [request: { op: "export"; repo: "acme/app"; role: "write" }]>,
      "=",
      {
        ok: false;
        error: "unknown op 'export': this socket has no operation that returns private key material, by design (see keyring.ts)";
      }
    >,
    Expect<
      Invoke<typeof publicOps, [request: { op: "consume"; repo: "acme/app" }]>,
      "matches",
      {
        ok: false;
        error: "unknown op 'consume': this socket has no operation that returns private key material, by design (see keyring.ts)";
      }
    >,
  ];
  /** the keys held, by repository and role: names only, and only under names that are a
   *  repository's */
  export type Lists = Given<
    [
      Fresh,
      Invoke<
        typeof writeIn,
        [
          where: "sys",
          name: "keyring/acme/app/read.pub",
          text: "ssh-ed25519 AAAA desolate-read:acme/app",
        ]
      >,
      Invoke<
        typeof writeIn,
        [
          where: "sys",
          name: "keyring/acme/app/write.pub",
          text: "ssh-ed25519 BBBB desolate-write:acme/app",
        ]
      >,
      Invoke<typeof writeIn, [where: "sys", name: "keyring/acme/..bad/read.pub", text: "x"]>,
    ],
    Expect<
      Invoke<typeof publicOps, [request: { op: "list" }]>,
      "=",
      { ok: true; keys: [{ repo: "acme/app"; role: "read" }, { repo: "acme/app"; role: "write" }] }
    >
  >;
  /** a public half, for the forge's deploy keys; a key that was never made is said so */
  export type Pubkey = Given<
    [
      Fresh,
      Invoke<typeof writeIn, [where: "sys", name: "keyring/acme/app/read", text: "PRIVATE"]>,
      Invoke<
        typeof writeIn,
        [
          where: "sys",
          name: "keyring/acme/app/read.pub",
          text: "ssh-ed25519 AAAA desolate-read:acme/app\n",
        ]
      >,
    ],
    [
      Expect<
        Invoke<typeof publicOps, [request: { op: "pubkey"; repo: "acme/app"; role: "read" }]>,
        "matches",
        { ok: true; pubkey: "ssh-ed25519 AAAA desolate-read:acme/app" }
      >,
      Expect<
        Invoke<typeof publicOps, [request: { op: "pubkey"; repo: "acme/app"; role: "write" }]>,
        "=",
        { ok: false; error: "no write key for acme/app" }
      >,
    ]
  >;
  /** a key is named by a repository and one of two roles, nothing else */
  export type Names = Table<
    typeof publicOps,
    [
      [
        args: [request: { op: "pubkey"; repo: "../../etc"; role: "read" }],
        expected: { ok: false; error: "not a repository: ../../etc" },
      ],
      [
        args: [request: { op: "pubkey"; repo: "acme/app"; role: "admin" }],
        expected: { ok: false; error: "role is 'read' or 'write'" },
      ],
    ]
  >;
}

declare namespace internalOps {
  /** the askpass's socket answers the askpass's one question and nothing else: not even a
   *  challenge or an approval */
  export type OnlyConsume = Table<
    typeof internalOps,
    [
      [
        args: [request: { op: "approve"; message: "x" }],
        expected: { ok: false; error: "unknown op 'approve'" },
      ],
      [args: [request: { op: "list" }], expected: { ok: false; error: "unknown op 'list'" }],
    ]
  >;
}

/** The pusher's question (root/pusher.ts), on a socket only it reaches: what approval <id>
 *  names, exactly as the person approved it. Asking claims it: one pusher process makes the
 *  push it names, once (an approval is claimed at most once), and only a claimed approval
 *  lets the write key sign. The claim lives while the connection it was asked on is open, so
 *  as long as the push takes, LFS objects first, and not a moment after the pusher is done:
 *  it closes that connection when it ends, and the kernel does if it dies. */
const pusherOps = (
  request: Record<string, unknown>,
  connection?: Socket,
): Record<string, unknown> => {
  if (request.op === "approval") {
    const approval = approvals.get(String(request.id ?? ""));
    if (!approval || (approval.expires !== null && approval.expires < Date.now()))
      return { ok: false, error: "no live approval with that id" };
    if (approval.claimed)
      return {
        ok: false,
        error: "that approval's push was begun already: each approval is pushed once",
      };
    const repo = parseRepo(approval.repo)!;
    // The write key's public half, which names the key in the agent: the pusher cannot read
    // KEYRING.pub (the root's user's), and needs nothing else of the keyring's.
    let pubkey = "";
    try {
      pubkey = fs.readFileSync(`${keyFile(repo, "write")}.pub`, "utf8").trim();
    } catch {
      return { ok: false, error: `${approval.repo} has no write key` };
    }
    // The claim is the pusher's connection: the approval lives while it is open, and goes
    // when it closes, however the push (and the pusher's process) ends.
    if (!connection) return { ok: false, error: "a claim is held by the pusher's connection" };
    approval.claimed = true;
    approval.expires = null;
    approval.holder = connection;
    hold(connection);
    audit({
      event: "claimed",
      approval: approval.id,
      repo: approval.repo,
      ref: approval.ref,
      commit: approval.commit,
    });
    return {
      ok: true,
      approval: {
        id: approval.id,
        repo: approval.repo,
        ref: approval.ref,
        commit: approval.commit,
        onto: approval.onto,
        pack: approval.pack,
        lfs: approval.lfs,
        pubkey,
      },
    };
  }
  return { ok: false, error: `unknown op '${String(request.op)}'` };
};

declare namespace pusherOps {
  /** the pusher asks what an approval names; one that is not live names nothing */
  export type NoApproval = Expect<
    Invoke<typeof pusherOps, [request: { op: "approval"; id: "mgx1abc-0123456789ab" }]>,
    "=",
    { ok: false; error: "no live approval with that id" }
  >;
  /** it gives one back by closing the connection it claimed it on: there is no op for it */
  export type NoRevoke = Expect<
    Invoke<typeof pusherOps, [request: { op: "revoke"; id: "mgx1abc-0123456789ab" }]>,
    "=",
    { ok: false; error: "unknown op 'revoke'" }
  >;
  /** asking for a challenge or filing an approval is the control socket's, not the pusher's */
  export type Only = Table<
    typeof pusherOps,
    [
      [
        args: [request: { op: "challenge"; repo: "acme/app" }],
        expected: { ok: false; error: "unknown op 'challenge'" },
      ],
      [args: [request: { op: "approve" }], expected: { ok: false; error: "unknown op 'approve'" }],
    ]
  >;
}

/** The reviewer's one question (root/reviewer.ts), on a socket only it reaches: a read key's
 *  public half, which names the key in the read agent. */
const reviewerOps = (request: Record<string, unknown>): Record<string, unknown> => {
  if (request.op !== "readkey") return { ok: false, error: `unknown op '${String(request.op)}'` };
  const repo = parseRepo(request.repo);
  if (!repo) return { ok: false, error: "not a repository" };
  try {
    return { ok: true, pubkey: fs.readFileSync(`${keyFile(repo, "read")}.pub`, "utf8").trim() };
  } catch {
    return { ok: false, error: `${repoId(repo)} has no read key` };
  }
};

declare namespace reviewerOps {
  type Fresh = Invoke<typeof emptyRoot>;
  /** a read key's public half, and only a read key's: the write key is never named here */
  export type ReadKey = Given<
    [
      Fresh,
      Invoke<
        typeof writeIn,
        [
          where: "sys",
          name: "keyring/acme/app/read.pub",
          text: "ssh-ed25519 AAAA desolate-read:acme/app\n",
        ]
      >,
      Invoke<
        typeof writeIn,
        [
          where: "sys",
          name: "keyring/acme/app/write.pub",
          text: "ssh-ed25519 BBBB desolate-write:acme/app\n",
        ]
      >,
    ],
    [
      Expect<
        Invoke<typeof reviewerOps, [request: { op: "readkey"; repo: "acme/app" }]>,
        "=",
        { ok: true; pubkey: "ssh-ed25519 AAAA desolate-read:acme/app" }
      >,
      Expect<
        Invoke<typeof reviewerOps, [request: { op: "writekey"; repo: "acme/app" }]>,
        "=",
        { ok: false; error: "unknown op 'writekey'" }
      >,
      Expect<
        Invoke<typeof reviewerOps, [request: { op: "readkey"; repo: "acme/other" }]>,
        "=",
        { ok: false; error: "acme/other has no read key" }
      >,
      Expect<
        Invoke<typeof reviewerOps, [request: { op: "readkey"; repo: "acme/../../x" }]>,
        "=",
        { ok: false; error: "not a repository" }
      >,
    ]
  >;
}

const internalOps = (request: Record<string, unknown>): Record<string, unknown> => {
  // The askpass's question, and nothing else: ssh-agent runs it as this user.
  if (request.op === "consume") return consume(request);
  return { ok: false, error: `unknown op '${String(request.op)}'` };
};

const LIMIT = { bytes: 4096, concurrent: 16 } as const;

const serve = (
  socketPath: string,
  mode: number,
  handle: (request: Record<string, unknown>, connection: Socket) => Record<string, unknown>,
): Promise<void> => {
  let open = 0;
  const reply = (connection: Socket, value: unknown) =>
    connection.write(JSON.stringify(value) + "\n");
  const server = createServer((connection) => {
    if (open >= LIMIT.concurrent) {
      reply(connection, { ok: false, error: "too many connections" });
      return connection.destroy();
    }
    open++;
    let counted = true;
    const uncount = () => {
      if (counted) open--;
      counted = false;
    };
    uncounted.set(connection, uncount);
    connection.on("close", uncount);
    connection.on("error", () => connection.destroy());
    let buffer = "";
    connection.on("data", (chunk) => {
      buffer += chunk.toString();
      if (buffer.length > LIMIT.bytes) {
        reply(connection, { ok: false, error: "request too large" });
        return connection.destroy();
      }
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        try {
          reply(connection, handle(JSON.parse(line), connection));
        } catch (error) {
          reply(connection, { ok: false, error: `bad request: ${String(error)}` });
        }
      }
    });
  });
  // The mode is set by umask AT bind, not by a chmod after it: a chmod leaves a moment in
  // which the internal socket is connectable by anyone. One socket at a time: the umask is
  // process-wide, so the caller awaits this before anything else creates a file.
  return new Promise((resolve, reject) => {
    const before = process.umask(0o777 & ~mode);
    server.once("error", (error) => {
      process.umask(before);
      reject(error);
    });
    server.listen(socketPath, () => {
      process.umask(before);
      resolve();
    });
  });
};

/** The public face of an agent. Two reasons it exists:
 *   - ssh-agent refuses any peer whose uid is not its own, and the root's git runs as
 *     another user, so something owned by the keyring must carry the connection;
 *   - that something can filter. A client may LIST identities and ask for a SIGNATURE, and
 *     nothing else: it cannot add a key of its own, remove or lock the keys held, or (the
 *     point of the write agent) add a key that skips confirmation.
 *  The agent protocol frames each message as a uint32 length and a type byte. */
const AGENT = { requestIdentities: 11, signRequest: 13, failure: 5, maxFrame: 256 * 1024 } as const;
const relay = (publicPath: string, agentPath: string, mode = 0o660): Promise<void> => {
  const server = createServer((client) => {
    const agent = connect(agentPath);
    let pending = Buffer.alloc(0);
    const close = () => {
      client.destroy();
      agent.destroy();
    };
    client.on("error", close);
    agent.on("error", close);
    client.on("close", close);
    agent.on("close", close);
    agent.on("data", (chunk) => client.write(chunk));
    client.on("data", (chunk) => {
      pending = Buffer.concat([pending, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      while (pending.length >= 5) {
        const length = pending.readUInt32BE(0);
        if (length < 1 || length > AGENT.maxFrame) return close();
        if (pending.length < 4 + length) return;
        const frame = pending.subarray(0, 4 + length);
        pending = pending.subarray(4 + length);
        if (frame[4] === AGENT.requestIdentities || frame[4] === AGENT.signRequest)
          agent.write(frame);
        else client.write(Buffer.from([0, 0, 0, 1, AGENT.failure]));
      }
    });
  });
  return new Promise((resolve, reject) => {
    const before = process.umask(0o777 & ~mode);
    server.once("error", (error) => {
      process.umask(before);
      reject(error);
    });
    server.listen(publicPath, () => {
      process.umask(before);
      resolve();
    });
  });
};

const startAgent = (socketPath: string, env: NodeJS.ProcessEnv) => {
  const agent = spawn("ssh-agent", ["-D", "-a", socketPath], {
    stdio: ["ignore", "ignore", "inherit"],
    env,
  });
  agent.on("error", (error) => {
    log(`could not start ssh-agent: ${error.message} (the image must provide openssh-client)`);
    process.exit(1);
  });
  agent.on("exit", (code) => {
    log(
      `ssh-agent for ${path.basename(socketPath)} exited (${code}); stopping, so the keyring is restarted whole`,
    );
    process.exit(1);
  });
  process.once("exit", () => agent.kill("SIGTERM"));
  return agent;
};

/** Where the keys are must be the keyring's alone, all the way up: a directory of its own
 *  (not a link), mode 0700, in directories only root can change. Otherwise whoever could
 *  rename an entry on the way could have put a directory of theirs there before a key was
 *  made, and read the key. (start.sh makes it so; this does not take that on trust.) */
export const keysDirRefusal = (dir: string, uid: number): string | null => {
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory()) return `${dir} is not a directory`;
  if (stat.uid !== uid) return `${dir} is not the keyring's (owner ${stat.uid})`;
  if ((stat.mode & 0o077) !== 0)
    return `${dir} is open to others (mode ${(stat.mode & 0o777).toString(8)})`;
  for (let up = path.dirname(dir); ; up = path.dirname(up)) {
    const parent = fs.lstatSync(up);
    if (parent.isSymbolicLink() || parent.uid !== 0 || (parent.mode & 0o022) !== 0)
      return `${up} could be changed by someone other than root`;
    if (up === path.dirname(up)) return null;
  }
};

declare namespace keysDirRefusal {
  type Fresh = Invoke<typeof emptyRoot>;
  /** the keys directory must be a directory, the keyring's, closed to others, and every
   *  directory above it root's alone. (That last can be met only as root, in the root VM: a
   *  test's directories are its user's, so even the closed one is refused, for its parent.) */
  export type Refuses = Given<
    Fresh,
    [
      Expect<
        Invoke<
          typeof keysDirRefusal,
          [dir: Invoke<typeof aKeysDir, [shape: "file"]>, uid: Invoke<typeof myUid>]
        >,
        "endsWith",
        "keys-file is not a directory"
      >,
      Expect<
        Invoke<
          typeof keysDirRefusal,
          [dir: Invoke<typeof aKeysDir, [shape: "closed"]>, uid: 99999]
        >,
        "includes",
        "keys-closed is not the keyring's (owner "
      >,
      Expect<
        Invoke<
          typeof keysDirRefusal,
          [dir: Invoke<typeof aKeysDir, [shape: "open"]>, uid: Invoke<typeof myUid>]
        >,
        "endsWith",
        "keys-open is open to others (mode 755)"
      >,
      Expect<
        Invoke<
          typeof keysDirRefusal,
          [dir: Invoke<typeof aKeysDir, [shape: "closed"]>, uid: Invoke<typeof myUid>]
        >,
        "endsWith",
        "could be changed by someone other than root"
      >,
    ]
  >;
}

const main = async () => {
  fs.mkdirSync(KEYRING.keys, { recursive: true, mode: 0o700 });
  fs.chmodSync(KEYRING.keys, 0o700);
  const unsafe = keysDirRefusal(KEYRING.keys, process.getuid!());
  if (unsafe) {
    log(`refusing to start: ${unsafe}`);
    process.exit(1);
  }
  fs.mkdirSync(KEYRING.run, { recursive: true, mode: 0o755 });
  fs.mkdirSync(KEYRING.pub, { recursive: true, mode: 0o755 });
  fs.mkdirSync(KEYRING.private, { recursive: true, mode: 0o700 });
  fs.chmodSync(KEYRING.private, 0o700);
  for (const stale of [
    KEYRING.readAgent,
    KEYRING.writeAgent,
    KEYRING.pusher,
    KEYRING.reviewerReadAgent,
    KEYRING.reviewer,
    KEYRING.control,
    KEYRING.internal,
    agentOf("read"),
    agentOf("write"),
  ])
    fs.rmSync(stale, { force: true });

  const here = path.dirname(new URL(import.meta.url).pathname);
  startAgent(agentOf("read"), { ...process.env });
  startAgent(agentOf("write"), {
    ...process.env,
    SSH_ASKPASS: path.join(here, "keyring-askpass"),
    // Without this ssh-agent asks only when DISPLAY is set, and otherwise REFUSES. Both are
    // wrong here: the askpass is the approval check, with or without a display.
    SSH_ASKPASS_REQUIRE: "force",
    DISPLAY: "desolate:0",
  });
  for (let waited = 0; ; waited += 50) {
    if (fs.existsSync(agentOf("read")) && fs.existsSync(agentOf("write"))) break;
    if (waited > 10_000) throw new Error("ssh-agent never created its socket");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await relay(KEYRING.readAgent, agentOf("read"));
  // The write agent's relay is in a directory only the keyring and the pusher can enter
  // (root/start.sh): the directory is the gate, so the socket itself is open within it.
  await relay(KEYRING.writeAgent, agentOf("write"), 0o666);
  await serve(KEYRING.pusher, 0o666, pusherOps);
  // The reviewer's: in a directory only it and the keyring enter, like the pusher's.
  await relay(KEYRING.reviewerReadAgent, agentOf("read"), 0o666);
  await serve(KEYRING.reviewer, 0o666, reviewerOps);
  for (const { repo, role } of held())
    try {
      publish(repo, role);
      load(repo, role);
    } catch (error) {
      log(`could not load the ${role} key for ${repoId(repo)}: ${String(error)}`);
    }
  await serve(KEYRING.control, 0o660, publicOps);
  await serve(KEYRING.internal, 0o600, internalOps);
  log(`holding ${held().length} key(s); control at ${KEYRING.control}`);
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => process.exit(0));
};

if (process.argv[1] && fs.realpathSync(process.argv[1]) === new URL(import.meta.url).pathname)
  void main();
