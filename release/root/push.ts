// The push (section 6.4): root clone -> remote, approved by a person ON THE HOST, pinned to
// the commit they reviewed. The host's `desolate push` runs this twice:
//
//   node push.ts prepare <domain> <owner/repo> <branch> --expect <commit> [--allow-default]
//       every refusal that needs no person (not pushable, no --expect, the commit moved,
//       the default branch, nothing to send), then the keyring's challenge for exactly
//       this push. Prints one JSON object.
//   node push.ts run <same arguments> --message <base64> --signature <base64>
//       the challenge, signed by the host's approver. The keyring files the approval if
//       the signature verifies; then LFS objects go up, then the commit; then the approval
//       is revoked. The write key signs none of it without that approval.
//
// Nothing here can make the signature: the approver's key is not in this VM (P2).
import * as fs from "node:fs";
import * as path from "node:path";
import { parseApproval } from "../shared/approval.ts";
import { EXIT, Refusal, refuse } from "../shared/exit.ts";
import { isCommit, parseRepo } from "../shared/names.ts";
import { isDownstream } from "../shared/suede.ts";
import { ask } from "./keyring-client.ts";
import { KEYRING, ROOT } from "./layout.ts";
import { offersOf, review, withdraw } from "./offers.ts";
import type { Review } from "./offers.ts";
import { afterPush } from "./pushed.ts";
import * as repos from "./repos.ts";
import { remoteTip } from "./repos.ts";
import { submitForReview } from "./review-client.ts";
import { send } from "./send.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Invoke } from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { refusalOf } from "../.harness/refusal.ts";

/** The command line, read: which half (`prepare` or `run`), the push it names, and the flags.
 *  The approval's text arrives in base64 and is decoded here. */
export const argsOf = (argv: string[]) => {
  const [mode, ...args] = argv;
  const valued = ["--expect", "--message", "--signature"];
  const positional = args.filter(
    (arg, index) => !arg.startsWith("--") && !valued.includes(args[index - 1] ?? ""),
  );
  const value = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  const [domain, repoArg, branch] = positional;
  if ((mode !== "prepare" && mode !== "run") || !domain || !repoArg || !branch)
    refuse(
      "push what?",
      "desolate push <domain> <owner/repo> <branch> --expect <commit>",
      EXIT.usage,
    );
  return {
    mode: mode as "prepare" | "run",
    domain: domain!,
    repoArg: repoArg!,
    branch: branch!,
    expect: value("--expect"),
    allowDefault: args.includes("--allow-default"),
    message: Buffer.from(value("--message") ?? "", "base64").toString("utf8"),
    signature: value("--signature") ?? "",
  };
};

declare namespace argsOf {
  /** the host's two calls: `prepare` names the push and the commit reviewed; `run` adds the
   *  approver's text (base64, decoded here) and signature */
  export type Prepare = Expect<
    Invoke<
      typeof argsOf,
      [
        argv: [
          "prepare",
          "acme",
          "acme/app",
          "fix",
          "--expect",
          "0123456789abcdef0123456789abcdef01234567",
        ],
      ]
    >,
    "=",
    {
      mode: "prepare";
      domain: "acme";
      repoArg: "acme/app";
      branch: "fix";
      expect: "0123456789abcdef0123456789abcdef01234567";
      allowDefault: false;
      message: "";
      signature: "";
    }
  >;
  export type Run = Expect<
    Invoke<
      typeof argsOf,
      [
        argv: [
          "run",
          "acme",
          "acme/app",
          "main",
          "--allow-default",
          "--expect",
          "0123456789abcdef0123456789abcdef01234567",
          "--message",
          "ZGVzb2xhdGUgcHVzaCBhcHByb3ZhbCB2MgpyZXBvOiBhY21lL2FwcApicmFuY2g6IGZpeApjb21taXQ6IDAxMjM0NTY3ODlhYmNkZWYwMTIzNDU2Nzg5YWJjZGVmMDEyMzQ1NjcKb250bzogbm9uZQpub25jZTogMDAxMTIyMzM0NDU1NjY3Nzg4OTlhYWJiY2NkZGVlZmYK",
          "--signature",
          "c2ln",
        ],
      ]
    >,
    "matches",
    {
      mode: "run";
      branch: "main";
      allowDefault: true;
      message: "desolate push approval v2\nrepo: acme/app\nbranch: fix\ncommit: 0123456789abcdef0123456789abcdef01234567\nonto: none\nnonce: 00112233445566778899aabbccddeeff\n";
      signature: "c2ln";
    }
  >;
  /** a flag's value is never read as the push's names: `--expect main` does not make main the branch */
  export type FlagValues = Expect<
    Invoke<typeof argsOf, [argv: ["prepare", "acme", "--expect", "main", "acme/app", "fix"]]>,
    "matches",
    { repoArg: "acme/app"; branch: "fix"; expect: "main" }
  >;
  /** not one of the two halves, or a push with a name missing: usage, and what to type */
  export type PushWhat = [
    Expect<
      Invoke<
        typeof refusalOf,
        [f: typeof argsOf, args: [argv: ["push", "acme", "acme/app", "fix"]]]
      >,
      "=",
      {
        message: "push what?";
        fix: "desolate push <domain> <owner/repo> <branch> --expect <commit>";
        code: 64;
      }
    >,
    Expect<
      Invoke<typeof refusalOf, [f: typeof argsOf, args: [argv: ["prepare", "acme", "acme/app"]]]>,
      "=",
      {
        message: "push what?";
        fix: "desolate push <domain> <owner/repo> <branch> --expect <commit>";
        code: 64;
      }
    >,
  ];
}

/** Every refusal that needs no person, of the branch as the review found it: a repository the
 *  root holds no write key for, a push that does not name the commit reviewed (or names one
 *  the branch has moved from), the default branch without --allow-default, nothing to send. */
export const refusePush = (
  r: Pick<Review, "repo" | "commit" | "pushable" | "isDefault" | "commits">,
  domain: string,
  branch: string,
  expect: string | undefined,
  allowDefault: boolean,
) => {
  const again = `desolate review ${domain} ${r.repo} ${branch}`;
  if (!r.pushable)
    refuse(
      `${r.repo} is not pushable: the root holds no write key for it`,
      `it was cloned --no-push. To make it pushable: desolate clone ${r.repo}`,
    );
  if (!isCommit(expect))
    refuse(
      "a push names the commit you reviewed",
      `${again}, then: desolate push ${domain} ${r.repo} ${branch} --expect ${r.commit}`,
      EXIT.usage,
    );
  if (expect !== r.commit)
    refuse(
      `${branch} is at ${r.commit.slice(0, 12)}, not the ${expect!.slice(0, 12)} that was reviewed: it moved since`,
      `review it again (${again}), then push with --expect ${r.commit}`,
      EXIT.expectMismatch,
    );
  if (r.isDefault && !allowDefault)
    refuse(
      `${branch} is ${r.repo}'s default branch`,
      "push a branch and open a pull request; or, to push the default branch itself, add --allow-default",
      EXIT.defaultBranch,
    );
  if (r.commits.length === 0) refuse(`${branch} has nothing the remote lacks`, again);
};

declare namespace refusePush {
  // The branch fix of acme/app, as the review found it: at 0123456789ab, one commit to send.
  type Reviewed = {
    repo: "acme/app";
    commit: "0123456789abcdef0123456789abcdef01234567";
    pushable: true;
    isDefault: false;
    commits: [{ commit: "0123456789abcdef0123456789abcdef01234567"; subject: "fix" }];
  };
  /** the commit the person reviewed, on a branch that is not the default, with something to send */
  export type Passes = Expect<
    Invoke<
      typeof refusalOf,
      [
        f: typeof refusePush,
        args: [
          r: Reviewed,
          domain: "acme",
          branch: "fix",
          expect: "0123456789abcdef0123456789abcdef01234567",
          allowDefault: false,
        ],
      ]
    >,
    "=",
    null
  >;
  /** each refusal says what to run, with the exit code a script tells apart */
  export type Refuses = [
    Expect<
      Invoke<
        typeof refusalOf,
        [
          f: typeof refusePush,
          args: [
            r: {
              repo: "acme/app";
              commit: "0123456789abcdef0123456789abcdef01234567";
              pushable: false;
              isDefault: false;
              commits: [];
            },
            domain: "acme",
            branch: "fix",
            expect: "0123456789abcdef0123456789abcdef01234567",
            allowDefault: false,
          ],
        ]
      >,
      "=",
      {
        message: "acme/app is not pushable: the root holds no write key for it";
        fix: "it was cloned --no-push. To make it pushable: desolate clone acme/app";
        code: 1;
      }
    >,
    Expect<
      Invoke<
        typeof refusalOf,
        [
          f: typeof refusePush,
          args: [
            r: Reviewed,
            domain: "acme",
            branch: "fix",
            expect: undefined,
            allowDefault: false,
          ],
        ]
      >,
      "=",
      {
        message: "a push names the commit you reviewed";
        fix: "desolate review acme acme/app fix, then: desolate push acme acme/app fix --expect 0123456789abcdef0123456789abcdef01234567";
        code: 64;
      }
    >,
    Expect<
      Invoke<
        typeof refusalOf,
        [
          f: typeof refusePush,
          args: [
            r: Reviewed,
            domain: "acme",
            branch: "fix",
            expect: "89abcdef0123456789abcdef0123456789abcdef",
            allowDefault: false,
          ],
        ]
      >,
      "=",
      {
        message: "fix is at 0123456789ab, not the 89abcdef0123 that was reviewed: it moved since";
        fix: "review it again (desolate review acme acme/app fix), then push with --expect 0123456789abcdef0123456789abcdef01234567";
        code: 79;
      }
    >,
    Expect<
      Invoke<
        typeof refusalOf,
        [
          f: typeof refusePush,
          args: [
            r: {
              repo: "acme/app";
              commit: "0123456789abcdef0123456789abcdef01234567";
              pushable: true;
              isDefault: true;
              commits: [{ commit: "0123456789abcdef0123456789abcdef01234567"; subject: "fix" }];
            },
            domain: "acme",
            branch: "main",
            expect: "0123456789abcdef0123456789abcdef01234567",
            allowDefault: false,
          ],
        ]
      >,
      "=",
      {
        message: "main is acme/app's default branch";
        fix: "push a branch and open a pull request; or, to push the default branch itself, add --allow-default";
        code: 77;
      }
    >,
    Expect<
      Invoke<
        typeof refusalOf,
        [
          f: typeof refusePush,
          args: [
            r: {
              repo: "acme/app";
              commit: "0123456789abcdef0123456789abcdef01234567";
              pushable: true;
              isDefault: false;
              commits: [];
            },
            domain: "acme",
            branch: "fix",
            expect: "0123456789abcdef0123456789abcdef01234567",
            allowDefault: false,
          ],
        ]
      >,
      "=",
      {
        message: "fix has nothing the remote lacks";
        fix: "desolate review acme acme/app fix";
        code: 1;
      }
    >,
  ];
  /** the default branch itself, when the person said so */
  export type AllowDefault = Expect<
    Invoke<
      typeof refusalOf,
      [
        f: typeof refusePush,
        args: [
          r: {
            repo: "acme/app";
            commit: "0123456789abcdef0123456789abcdef01234567";
            pushable: true;
            isDefault: true;
            commits: [{ commit: "0123456789abcdef0123456789abcdef01234567"; subject: "fix" }];
          },
          domain: "acme",
          branch: "main",
          expect: "0123456789abcdef0123456789abcdef01234567",
          allowDefault: true,
        ],
      ]
    >,
    "=",
    null
  >;
}

/** The signature is over the keyring's text; this is the check that the text is about the push
 *  this command is about to make. */
export const refuseOtherApproval = (
  message: string,
  r: Pick<Review, "repo" | "commit">,
  domain: string,
  branch: string,
) => {
  const named = parseApproval(message);
  if (!named || named.repo !== r.repo || named.branch !== branch || named.commit !== r.commit)
    refuse(
      "the approval is not for this push",
      `run it again: desolate push ${domain} ${r.repo} ${branch} --expect ${r.commit}`,
      EXIT.unconfirmed,
    );
};

declare namespace refuseOtherApproval {
  type Reviewed = { repo: "acme/app"; commit: "0123456789abcdef0123456789abcdef01234567" };
  /** the approval names this repository, this branch and this commit */
  export type Ours = Expect<
    Invoke<
      typeof refusalOf,
      [
        f: typeof refuseOtherApproval,
        args: [
          message: "desolate push approval v2\nrepo: acme/app\nbranch: fix\ncommit: 0123456789abcdef0123456789abcdef01234567\nonto: none\nnonce: 00112233445566778899aabbccddeeff\n",
          r: Reviewed,
          domain: "acme",
          branch: "fix",
        ],
      ]
    >,
    "=",
    null
  >;
  /** one signed for another branch, another commit, or text that is no approval, pushes nothing */
  export type Others = [
    Expect<
      Invoke<
        typeof refusalOf,
        [
          f: typeof refuseOtherApproval,
          args: [
            message: "desolate push approval v2\nrepo: acme/app\nbranch: fix\ncommit: 0123456789abcdef0123456789abcdef01234567\nonto: none\nnonce: 00112233445566778899aabbccddeeff\n",
            r: Reviewed,
            domain: "acme",
            branch: "main",
          ],
        ]
      >,
      "=",
      {
        message: "the approval is not for this push";
        fix: "run it again: desolate push acme acme/app main --expect 0123456789abcdef0123456789abcdef01234567";
        code: 78;
      }
    >,
    Expect<
      Invoke<
        typeof refusalOf,
        [
          f: typeof refuseOtherApproval,
          args: [
            message: "desolate push approval v2\nrepo: acme/app\nbranch: fix\ncommit: 0123456789abcdef0123456789abcdef01234567\nonto: none\nnonce: 00112233445566778899aabbccddeeff\n",
            r: { repo: "acme/app"; commit: "89abcdef0123456789abcdef0123456789abcdef" },
            domain: "acme",
            branch: "fix",
          ],
        ]
      >,
      "matches",
      { message: "the approval is not for this push"; code: 78 }
    >,
    Expect<
      Invoke<
        typeof refusalOf,
        [
          f: typeof refuseOtherApproval,
          args: [message: "approve", r: Reviewed, domain: "acme", branch: "fix"],
        ]
      >,
      "matches",
      { message: "the approval is not for this push"; code: 78 }
    >,
  ];
}

const main = async () => {
  const { mode, domain, repoArg, branch, expect, allowDefault, message, signature } = argsOf(
    process.argv.slice(2),
  );
  const r = await review(domain, repoArg, branch);
  const repo = parseRepo(r.repo)!;
  refusePush(r, domain, branch, expect, allowDefault);
  // A suede proposal: its own workflows run on the remote when it lands (shared/suede.ts).
  if (isDownstream(branch)) {
    const why = await repos.downstreamCheck(repo, r.commit);
    if (why)
      refuse(
        `${branch} is a suede proposal, and ${why}`,
        "change it in the workspace and offer it again",
      );
  }

  if (mode === "prepare") {
    // What the person is shown at the prompt is the reviewer's account (host/push.ts): it is
    // sent the commit first, as a raw push sends it (raw-push.ts). Until this, a branch never
    // pushed raw was described as "the reviewer could not say" (found by T2 04).
    const unreviewed = await submitForReview(repo, r.commit);
    if (unreviewed)
      process.stderr.write(
        `desolate: the reviewer was not sent this push (${unreviewed}); the prompt will say it cannot describe it\n`,
      );
    // What the remote's branch is now, as the mirror last saw it: the push moves it from
    // exactly this (pusher.ts). If the remote moved since, the push is refused, not forced.
    const reply = await ask(KEYRING.control, {
      op: "challenge",
      repo: r.repo,
      ref: branch,
      commit: r.commit,
      onto: await remoteTip(repo, branch),
    });
    if (reply.ok !== true)
      refuse(String(reply.error ?? "the keyring gave no challenge"), "desolate doctor");
    const summary = `${r.commits.length} commit(s), ${r.stat || "no file changes"}${r.lfsObjects ? `, ${r.lfsObjects} LFS object(s)` : ""}`;
    process.stdout.write(
      JSON.stringify({
        repo: r.repo,
        branch,
        commit: r.commit,
        summary,
        warnings: r.warnings,
        message: reply.message,
      }) + "\n",
    );
    return;
  }

  refuseOtherApproval(message, r, domain, branch);

  const lock = path.join(ROOT.state, "push-locks", r.repo.replace("/", "--"));
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  try {
    fs.mkdirSync(lock);
  } catch {
    if (Date.now() - fs.statSync(lock).mtimeMs < 300_000)
      refuse(`another push to ${r.repo} is in progress`, "try again in a moment", EXIT.busy);
    fs.rmSync(lock, { recursive: true, force: true });
    fs.mkdirSync(lock);
  }
  let approval: string | null = null;
  try {
    const filed = await ask(KEYRING.control, { op: "approve", message, signature });
    if (filed.ok !== true)
      throw new Refusal(
        `the keyring did not accept the approval (${String(filed.error)}), so nothing was pushed`,
        "desolate doctor, then push again",
        EXIT.unconfirmed,
      );
    approval = String(filed.id);
    const failed = await send(repo, approval, r.commit);
    if (failed)
      throw new Refusal(
        failed.error,
        failed.moved
          ? `the remote's ${branch} has moved: desolate fetch ${r.repo}, then rebase in the workspace and offer again`
          : "try the push again; desolate doctor",
      );
  } finally {
    if (approval) await ask(KEYRING.control, { op: "revoke", id: approval }).catch(() => {});
    fs.rmSync(lock, { recursive: true, force: true });
  }
  const base =
    offersOf(domain).find((o) => o.repo === r.repo && o.branch === branch)?.base ?? r.defaultBranch;
  const link = afterPush({ repo: r.repo, branch, commit: r.commit, base }, (line) =>
    process.stderr.write(`${line}\n`),
  );
  withdraw(domain, r.repo, branch);
  // What the remote now has, the mirror has: origin/* in every clone follows.
  await repos.fetch(repo).catch(() => {});
  process.stdout.write(
    `pushed ${r.repo} ${branch} at ${r.commit} (${r.commits.length} commit(s)${r.lfsObjects ? `, ${r.lfsObjects} LFS object(s) first` : ""}).\n`,
  );
  if (link)
    process.stdout.write(
      `open a pull request into ${base}, in your browser, as yourself: ${link}\n`,
    );
};

// Run by the host's `desolate push` (host/push.ts: node with this file's path); imported, it
// does nothing.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === new URL(import.meta.url).pathname)
  try {
    await main();
  } catch (error) {
    if (error instanceof Refusal) {
      process.stderr.write(
        `desolate: ${error.message}\n${error.fix ? `  fix: ${error.fix}\n` : ""}`,
      );
      process.exit(error.code);
    }
    process.stderr.write(`desolate: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
