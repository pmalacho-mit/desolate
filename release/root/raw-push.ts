// One push a person asked for with git itself, not with `desolate push`: a raw `git push
// origin` in the root's terminal (git-remote-desolate-push.ts), or a `git push` in the git
// VM, which the host hands to the root (ops.ts, `git.push`). Both end here, and both wait
// for the person's approval on the host (the approval page, or `desolate approve`).
//
// The commit is in the root clone by now. What goes out is decided by the approval
// (pusher.ts); what the person is shown is the reviewer's (reviewer.ts).
import * as fs from "node:fs";
import * as path from "node:path";
import { parseApproval } from "../shared/approval.ts";
import { isBranch, repoId } from "../shared/names.ts";
import { isDownstream } from "../shared/suede.ts";
import type { Repo } from "../shared/names.ts";
import { git } from "./git.ts";
import { ask } from "./keyring-client.ts";
import { APPROVALS, clonePath, KEYRING } from "./layout.ts";
import { allOffers } from "./offers.ts";
import { afterPush } from "./pushed.ts";
import * as repos from "./repos.ts";
import { submitForReview } from "./review-client.ts";
import { send } from "./send.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Given, Invoke, Throws } from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { aRegistry, emptyRoot } from "../.harness/root-state.ts";

export const WAIT_MS = Number(process.env.DESOLATE_APPROVAL_WAIT_MS) || 110_000;

/** The live approval for this push, if the person gave one: its id, and what it pushes (the
 *  commit, or the squash of it they chose). */
const approvedId = async (
  push: Record<string, unknown>,
): Promise<{ id: string; commit: string; onto: string | null } | null> => {
  const reply = await ask(KEYRING.control, { op: "approved", ...push });
  return reply.ok === true
    ? {
        id: String(reply.id),
        commit: String(reply.commit),
        onto: typeof reply.onto === "string" ? reply.onto : null,
      }
    : null;
};

/** Returns null when pushed, or why not (one line). `say` is for the person waiting. */
export const pushCommit = async (
  repo: Repo,
  commit: string,
  branch: string,
  forced: boolean,
  from: string,
  say: (line: string) => void,
): Promise<string | null> => {
  const name = repoId(repo);
  const clone = clonePath(repo);
  if (!isBranch(branch)) return "desolate pushes branches";
  if (!repos.recordOf(repo).pushable)
    return `${name} is not pushable: the root holds no write key for it`;
  // A suede proposal: its own workflows run on the remote when it lands (shared/suede.ts).
  if (isDownstream(branch)) {
    const why = await repos.downstreamCheck(repo, commit);
    if (why) return `${branch} is a suede proposal, and ${why}`;
  }
  // The approval names what the remote's branch is now, as the mirror last saw it: the push
  // moves it from exactly that, or not at all (pusher.ts). Like git, an update that does
  // not build on it needs a `+`; the person approving sees which it is.
  const onto = await repos.remoteTip(repo, branch);
  if (
    onto &&
    !forced &&
    (await git(clone, ["merge-base", "--is-ancestor", onto, commit])).code !== 0
  )
    return `the remote's ${branch} has commits this does not (non-fast-forward): fetch and rebase, or push with + to replace it`;
  const push = { repo: name, ref: branch, commit, onto };
  let approval = await approvedId(push);
  if (!approval) {
    // What the approval page shows of this push is the reviewer's (reviewer.ts): it gets the
    // objects first, before the challenge's two minutes start. It makes the pack the push
    // sends, too, which the approval names: a reviewer that cannot be reached stops the push.
    const unreviewed = await submitForReview(repo, commit);
    if (unreviewed)
      return `the reviewer was not sent this push (${unreviewed}), and a push is approved only as the reviewer describes it: desolate doctor`;
    const challenge = await ask(KEYRING.control, { op: "challenge", ...push });
    const nonce = parseApproval(challenge.message)?.nonce;
    if (challenge.ok !== true || !nonce)
      return String(challenge.error ?? "the keyring gave no challenge");
    const request = path.join(APPROVALS, `${nonce}.json`);
    // Whole or not at all: a half-written request read as broken would be thrown away, and
    // this push would take that for a refusal.
    fs.writeFileSync(
      `${request}.tmp`,
      JSON.stringify({ message: challenge.message, summary: from, at: new Date().toISOString() }),
      { mode: 0o600 },
    );
    fs.renameSync(`${request}.tmp`, request);
    say(
      `desolate: this push needs your approval, given on the host, outside every VM.\n  ${name}  ${branch}  ${commit}\n  On the host: the approval page (desolate approve --web prints it), or run  desolate approve\n  waiting up to ${Math.round(WAIT_MS / 1000)} s ...`,
    );
    let refused = false;
    try {
      for (const until = Date.now() + WAIT_MS; Date.now() < until && !approval && !refused;) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        approval = await approvedId(push);
        // Refused on the page: the request is gone, and no approval came.
        refused = !approval && !fs.existsSync(request);
      }
    } finally {
      fs.rmSync(request, { force: true });
    }
    if (refused) return "refused on the host, so nothing was pushed";
    if (!approval) return "no person approved the push on the host, so nothing was pushed";
  }
  try {
    const failed = await send(repo, approval.id, { commit: approval.commit, onto: approval.onto });
    if (failed) return failed.error.replace(/\n/g, " ");
  } finally {
    await ask(KEYRING.control, { op: "revoke", id: approval.id }).catch(() => {});
  }
  if (approval.commit !== commit)
    say(
      `desolate: pushed squashed into one commit, ${approval.commit}. This ${branch} keeps its own commits: reset it to origin/${branch} before working on, or its next push replaces the remote's.`,
    );
  // The base a pull request goes into: what an offer of this commit named, else the default.
  const base =
    allOffers().find((o) => o.repo === name && o.branch === branch && o.commit === commit)?.base ??
    repos.registry().repos[name]?.defaultBranch ??
    null;
  const link = afterPush({ repo: name, branch, commit: approval.commit, base }, say);
  await repos.fetch(repo).catch(() => {});
  if (link)
    say(`desolate: open a pull request into ${base}, in your browser, as yourself: ${link}`);
  return null;
};

declare namespace pushCommit {
  type Fresh = Invoke<typeof emptyRoot>;
  type Registry = Invoke<
    typeof aRegistry,
    [repos: { "acme/app": { defaultBranch: "main" }; "acme/docs": { pushable: false } }]
  >;
  /** refused before anything is asked of the keyring or the person: a ref that is not a
   *  branch, and a repository the root holds no write key for. (The default branch is pushed
   *  like any other, since 2026-11-18.) (A push that passes these waits for the
   *  person's approval on the host: T2's and T4's.) */
  export type Refuses = Given<
    [Fresh, Registry],
    [
      Expect<
        Invoke<
          typeof pushCommit,
          [
            repo: { owner: "acme"; name: "app" },
            commit: "0123456789abcdef0123456789abcdef01234567",
            branch: "refs/tags/v1..x",
            forced: false,
            from: "a raw git push",
            say: typeof console.error,
          ]
        >,
        "=",
        "desolate pushes branches"
      >,
      Expect<
        Invoke<
          typeof pushCommit,
          [
            repo: { owner: "acme"; name: "docs" },
            commit: "0123456789abcdef0123456789abcdef01234567",
            branch: "fix",
            forced: false,
            from: "a raw git push",
            say: typeof console.error,
          ]
        >,
        "=",
        "acme/docs is not pushable: the root holds no write key for it"
      >,
    ]
  >;
  /** and one the root never cloned is not a push at all */
  export type Unknown = Given<
    [Fresh, Registry],
    Throws<
      Invoke<
        typeof pushCommit,
        [
          repo: { owner: "acme"; name: "other" },
          commit: "0123456789abcdef0123456789abcdef01234567",
          branch: "fix",
          forced: false,
          from: "a raw git push",
          say: typeof console.error,
        ]
      >,
      "acme/other is not cloned into the root"
    >
  >;
}
