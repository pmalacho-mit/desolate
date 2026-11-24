// One push a person asked for with git itself, not with `desolate push`: a raw `git push
// origin` in the root's terminal (git-remote-desolate-push.ts), or a `git push` in the git
// VM, which the host hands to the root (ops.ts, `git.push`). Both end here, and both wait
// for the person's approval on the host (the approval page, or `desolate approve`).
//
// The commit is in the root clone by now. What goes out is decided by the approval
// (pusher.ts); what the person is shown is the reviewer's (reviewer.ts).
import * as fs from "node:fs";
import * as path from "node:path";
import { catchUp, parseApproval, squashedFrom } from "../shared/approval.ts";
import { isBranch, repoId } from "../shared/names.ts";
import { isDownstream } from "../shared/suede.ts";
import type { Repo } from "../shared/names.ts";
import { git } from "./git.ts";
import { startOf } from "../shared/lock.ts";
import { hold } from "./keyring-client.ts";
import { APPROVALS, clonePath, KEYRING } from "./layout.ts";
import { afterPush } from "./record.ts";
import * as repos from "./repos.ts";
import { submitForReview } from "./review-client.ts";
import { send } from "./send.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type {
  Expect,
  Given,
  Invoke,
  Mock,
  Throws,
} from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { aRegistry, emptyRoot, mirrorsAndClonesHere } from "../.harness/root-state.ts";
import type { offer, offersOf } from "./record.ts";

/** Returns null when pushed, or why not (one line). `say` is for the person waiting.
 *  It waits for the person for as long as it is waited for (R4): until they approve or refuse
 *  it on the host, or `signal` fires (whoever asked went away), or this process ends. Its
 *  request to the keyring is held on a connection of this process's, so whichever ends it,
 *  the request is gone with it, and nothing can approve it after (keyring.ts). */
export const pushCommit = async (
  repo: Repo,
  commit: string,
  branch: string,
  forced: boolean,
  from: string,
  say: (line: string) => void,
  signal?: AbortSignal,
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
  ) {
    // After a squashed push, the remote's branch is the squash: say how to build on it.
    const squashed = await squashedFrom((args) => git(clone, args), onto, commit).catch(() => null);
    return squashed
      ? `the remote's ${branch} is the squash of ${squashed.slice(0, 12)}, a commit of this branch, pushed before. To build on it, run \`${catchUp(branch, squashed)}\` in the workspace, on the branch you pushed, then push again; or push with + to replace it`
      : `the remote's ${branch} has commits this does not (non-fast-forward): fetch and rebase, or push with + to replace it`;
  }
  // What the approval page shows of this push is the reviewer's (reviewer.ts): it gets the
  // objects first. It makes the pack the push sends, too, which the approval names: a
  // reviewer that cannot be reached stops the push.
  const unreviewed = await submitForReview(repo, commit);
  if (unreviewed)
    return `the reviewer was not sent this push (${unreviewed}), and a push is approved only as the reviewer describes it: desolate doctor`;
  // A caller that cannot yet say when its asker went away (ops.ts's `git.push`, the remote
  // helper) waits as long as the longest asker does: the git VM's push helper, which gives up
  // after 20 minutes (git/git-remote-desolate-out.ts). Past that nobody waits, said or not.
  signal ??= AbortSignal.timeout(UNSAID_MS);
  if (signal.aborted) return GONE;
  const heard: { approved?: Approved; dropped?: string; ended?: boolean } = {};
  let wake = () => {};
  const held = await hold(
    KEYRING.control,
    { op: "challenge", repo: name, ref: branch, commit, onto, hold: true },
    (line) => {
      const said = line.approved as Record<string, unknown> | undefined;
      if (said && typeof said === "object" && typeof said.id === "string")
        heard.approved = { id: said.id, commit: String(said.commit), pack: String(said.pack) };
      else if (line.dropped) heard.dropped = String(line.error ?? "the keyring dropped it");
      wake();
    },
  );
  try {
    const nonce = parseApproval(held.answer.message)?.nonce;
    if (held.answer.ok !== true || !nonce)
      return String(held.answer.error ?? "the keyring gave no challenge");
    void held.ended.then(() => ((heard.ended = true), wake()));
    const request = path.join(APPROVALS, `${nonce}.json`);
    // Whole or not at all: a half-written request read as broken would be thrown away, and
    // this push would take that for a refusal. It names this process: the list shows it while
    // the process lives (approvals.ts).
    fs.writeFileSync(
      `${request}.tmp`,
      JSON.stringify({
        message: held.answer.message,
        summary: from,
        at: new Date().toISOString(),
        pid: process.pid,
        start: startOf(process.pid),
      }),
      { mode: 0o600 },
    );
    fs.renameSync(`${request}.tmp`, request);
    say(
      `desolate: this push needs your approval, given on the host, outside every VM.\n  ${name}  ${branch}  ${commit}\n  On the host: the approval page (desolate approve --web prints it), or run  desolate approve\n  waiting for it for as long as this push waits; stopping the push takes it off the list ...`,
    );
    let refused = false;
    const onAbort = () => wake();
    signal?.addEventListener("abort", onAbort);
    try {
      // The approval comes on the held connection; a refusal on the page removes the request
      // (ops.ts, approvals.refuse), which is looked for every half second.
      while (!heard.approved && !heard.dropped && !heard.ended && !signal?.aborted) {
        if (!fs.existsSync(request)) {
          refused = true;
          break;
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 500);
          wake = () => (clearTimeout(timer), resolve());
        });
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      fs.rmSync(request, { force: true });
    }
    const approval = heard.approved;
    if (!approval) {
      if (refused) return "refused on the host, so nothing was pushed";
      if (signal?.aborted) return GONE;
      if (heard.dropped) return `${heard.dropped}, so nothing was pushed`;
      return "the keyring stopped holding this push's request (it was restarted), so nothing was pushed: push again";
    }
    // The approval is this connection's until the pusher claims it; released below, it goes
    // if the push never began.
    const failed = await send(repo, approval.id, { pack: approval.pack }, (line) =>
      say(`desolate: ${line}`),
    );
    if (failed) return failed.error.replace(/\n/g, " ");
    return pushed(repo, commit, branch, approval.commit, say);
  } finally {
    await held.release();
  }
};

type Approved = { id: string; commit: string; pack: string };
const GONE = "whoever asked for this push stopped waiting, so nothing was pushed";
const UNSAID_MS = 20 * 60_000;

/** After the push of `sent` (the commit, or the squash of it the person chose): what the
 *  person waiting is told, and the root's own records. */
const pushed = async (
  repo: Repo,
  commit: string,
  branch: string,
  sent: string,
  say: (line: string) => void,
): Promise<null> => {
  const name = repoId(repo);
  if (sent !== commit) {
    say(
      `desolate: pushed squashed into one commit, ${sent}. The branch you pushed still has the commits that were squashed, so its next push would replace the remote's. To carry on from the squash, in the workspace, on that branch (what you committed since is kept, on top):`,
    );
    say(`desolate:   ${catchUp(branch, commit)}`);
  }
  // Recorded, and every domain's offer of this commit withdrawn: the base a pull request goes
  // into is what that offer named, else the default branch.
  const { base, link } = await afterPush(
    {
      domain: null,
      repo: name,
      branch,
      commit,
      sent,
      fallback: repos.registry().repos[name]?.defaultBranch ?? null,
    },
    say,
  );
  await repos.fetch(repo).catch(() => {});
  if (link)
    say(`desolate: open a pull request into ${base}, in your browser, as yourself: ${link}`);
  return null;
};

declare namespace pushed {
  /** a raw push (the root's terminal, the git VM) of an offered commit withdraws that offer:
   *  it was left under "Needs you" (the review of 2026-11-22, A1). The control: another
   *  domain's offer of the branch at another commit stays */
  export type Withdraws = Given<
    [
      Mock<"./layout.ts", typeof mirrorsAndClonesHere>,
      Invoke<typeof emptyRoot>,
      Invoke<typeof aRegistry, [repos: { "acme/app": {} }]>,
      Invoke<
        typeof offer,
        [
          o: {
            domain: "acme";
            repo: "acme/app";
            branch: "fix";
            commit: "0123456789abcdef0123456789abcdef01234567";
            workspace: "w1";
            lfs: 0;
            at: "2026-11-16T12:00:00.000Z";
          },
        ]
      >,
      Invoke<
        typeof offer,
        [
          o: {
            domain: "beta";
            repo: "acme/app";
            branch: "fix";
            commit: "89abcdef0123456789abcdef0123456789abcdef";
            workspace: "w1";
            lfs: 0;
            at: "2026-11-16T12:00:00.000Z";
          },
        ]
      >,
    ],
    [
      Expect<
        Invoke<
          typeof pushed,
          [
            repo: { owner: "acme"; name: "app" },
            commit: "0123456789abcdef0123456789abcdef01234567",
            branch: "fix",
            sent: "0123456789abcdef0123456789abcdef01234567",
            say: typeof console.error,
          ]
        >,
        "=",
        null
      >,
      Expect<
        Invoke<typeof offersOf>,
        "matches",
        [{ domain: "beta"; commit: "89abcdef0123456789abcdef0123456789abcdef" }]
      >,
    ]
  >;
}

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
