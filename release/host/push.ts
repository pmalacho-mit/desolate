// offers, review, push, approve, and the root's shell: the host's part.
//
// A push is three steps, and the middle one happens here, outside every VM (P2):
//   1. the root checks the push and its keyring issues a challenge naming it;
//   2. the approver on this host shows the challenge to the person and signs it
//      (approver.ts: on your terminal, or Touch ID if chosen);
//   3. the root hands the signature to its keyring, which lets the write key sign for
//      that one push.
// Nothing in a VM can do step 2, so nothing in a VM can push.
import { printable, printableLines } from "../shared/text.ts";
import { EXIT, refuse } from "../shared/exit.ts";
import { editorHostPort, isCommit, parseRepo, repoId, ROOT_HOSTNAME } from "../shared/names.ts";
import { parseArgs } from "node:util";
import { sign } from "./approver.ts";
import { catchUp, parseApproval, parseSigned, signedFor } from "../shared/approval.ts";
import type { Summary } from "./approve-web.ts";
import { guest } from "./paths.ts";
import { backend, ROOT_VM, rootctl } from "./stack.ts";
import type { Issue } from "../shared/issues.ts";
import type {
  Expect,
  Given,
  Invoke,
  Mock,
  Table,
} from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { collect, fakeStack, rootAnswers, said } from "../.harness/host-stack.ts";
import type { refusalOf } from "../.harness/refusal.ts";

type Out = (line: string) => void;
type Offer = {
  domain: string;
  repo: string;
  branch: string;
  commit: string;
  workspace: string;
  lfs: number;
  at: string;
  base?: string;
};
type Review = {
  repo: string;
  branch: string;
  commit: string;
  pushable: boolean;
  isDefault: boolean;
  commits: { commit: string; subject: string }[];
  files: string[];
  stat: string;
  lfsObjects: number;
  warnings: string[];
};

/** Text from a repository (a branch name, a commit subject) is shown as text: control
 *  characters that could repaint a terminal are replaced. */
const plain = (text: string) => printable(text, Infinity);

export const offers = async (domain: string | undefined, out: Out, json: boolean) => {
  const list = await rootctl<Offer[]>("offers.list", { domain }, { quiet: true });
  if (json) return out(JSON.stringify(list));
  const refused = await rootctl<{ domain: string; repo: string; at: string; why: string }[]>(
    "offers.refused",
    { domain },
    { quiet: true },
  ).catch(() => []);
  for (const r of refused)
    out(
      `Refused from ${r.domain} (${r.repo}, ${r.at}): ${plain(r.why)}\n  Nothing new from ${r.domain} is taken while one of its branches holds what git refused. Delete that branch in the workspace, then \`desolate sync\` there.`,
    );
  // Issues a workspace offered need you too (the dashboard puts them under "Needs you").
  const issues = (
    await rootctl<Issue[]>("issue.list", { waiting: true }, { quiet: true }).catch(
      () => [] as Issue[],
    )
  ).filter(
    (i) => (i.state === "offered" || i.state === "approving") && (!domain || i.domain === domain),
  );
  if (list.length === 0 && issues.length === 0)
    return out("no offers. In a workspace, `desolate offer` marks a branch ready for you.");
  out("Needs you:");
  for (const o of list)
    out(
      `  ${o.domain}  ${o.repo}  ${plain(o.branch)}  ${o.commit.slice(0, 12)}  from ${plain(o.workspace) || "(a workspace of the domain)"}${o.base ? `  for ${plain(o.base)}` : ""}${o.lfs ? `  ${o.lfs} LFS object(s)` : ""}\n    review: desolate review ${o.domain} ${o.repo} ${plain(o.branch)}`,
    );
  for (const i of issues)
    out(
      `  ${i.domain}  ${i.repo}  issue "${printable(i.title, 100)}"  from ${plain(i.workspace)}${i.state === "approving" ? "  waiting for you to publish it" : ""}\n    ${i.state === "approving" ? `publish: desolate issue publish ${i.id}` : `edit it on the dashboard (desolate ui), or publish: desolate issue publish ${i.id}`}`,
    );
};

declare namespace offers {
  /** what needs the person: offers, each with the command that reviews it; a domain whose
   *  bundle git refused, and what to do; issues a workspace offered */
  export type Lists = Given<
    [
      Mock<"./stack.ts", typeof fakeStack>,
      Invoke<
        typeof rootAnswers,
        [
          answers: {
            "offers.list": [
              {
                domain: "acme";
                repo: "acme/web";
                branch: "fix/login";
                commit: "0123456789abcdef0123456789abcdef01234567";
                workspace: "w1";
                lfs: 0;
                at: "2026-11-16T10:00:00Z";
                base: "v3";
              },
            ];
            "offers.refused": [
              {
                domain: "beta";
                repo: "beta/api";
                at: "2026-11-16T09:00:00Z";
                why: "a .git directory inside a tree";
              },
            ];
            "issue.list": [
              {
                id: "abc123-0123abcd";
                domain: "acme";
                workspace: "w1";
                repo: "acme/web";
                title: "Login loops after a reset";
                body: "";
                labels: [];
                at: "2026-11-16T10:00:00Z";
                state: "offered";
              },
            ];
          },
        ]
      >,
      Invoke<typeof offers, [domain: undefined, out: typeof collect, json: false]>,
    ],
    Expect<
      Invoke<typeof said>,
      "=",
      [
        "Refused from beta (beta/api, 2026-11-16T09:00:00Z): a .git directory inside a tree",
        "  Nothing new from beta is taken while one of its branches holds what git refused. Delete that branch in the workspace, then `desolate sync` there.",
        "Needs you:",
        "  acme  acme/web  fix/login  0123456789ab  from w1  for v3",
        "    review: desolate review acme acme/web fix/login",
        '  acme  acme/web  issue "Login loops after a reset"  from w1',
        "    edit it on the dashboard (desolate ui), or publish: desolate issue publish abc123-0123abcd",
      ]
    >
  >;
  /** nothing waiting, and how something comes to */
  export type Nothing = Given<
    [
      Mock<"./stack.ts", typeof fakeStack>,
      Invoke<
        typeof rootAnswers,
        [answers: { "offers.list": []; "offers.refused": []; "issue.list": [] }]
      >,
      Invoke<typeof offers, [domain: undefined, out: typeof collect, json: false]>,
    ],
    Expect<
      Invoke<typeof said>,
      "=",
      ["no offers. In a workspace, `desolate offer` marks a branch ready for you."]
    >
  >;
  /** a branch name is the domain's text: shown as text on both its lines, whatever prints them */
  export type BranchAsText = Given<
    [
      Mock<"./stack.ts", typeof fakeStack>,
      Invoke<
        typeof rootAnswers,
        [
          answers: {
            "offers.list": [
              {
                domain: "acme";
                repo: "acme/web";
                branch: "fix/login\u001b]0;pwned\u0007";
                commit: "0123456789abcdef0123456789abcdef01234567";
                workspace: "w1";
                lfs: 0;
                at: "2026-11-16T10:00:00Z";
              },
            ];
            "offers.refused": [];
            "issue.list": [];
          },
        ]
      >,
      Invoke<typeof offers, [domain: undefined, out: typeof collect, json: false]>,
    ],
    Expect<
      Invoke<typeof said>,
      "=",
      [
        "Needs you:",
        "  acme  acme/web  fix/login?]0;pwned?  0123456789ab  from w1",
        "    review: desolate review acme acme/web fix/login?]0;pwned?",
      ]
    >
  >;
}

/** `desolate branches [<domain>]`: every branch each domain has, not only what was offered.
 *  The list is each domain's own word; `desolate review` reads the branch in the root. */
export const branches = async (domain: string | undefined, out: Out, json: boolean) => {
  const list = await rootctl<
    {
      domain: string;
      repo: string;
      branch: string;
      commit: string;
      offered: boolean;
      checkedOutIn: string[];
      landed?: string | null;
    }[]
  >("branches.list", domain ? { domain } : {}, { quiet: true });
  if (json) return out(JSON.stringify(list));
  if (list.length === 0)
    return out(
      domain
        ? `${domain} has no branches the root has heard of yet`
        : "no domain has any branch the root has heard of yet",
    );
  for (const b of list)
    out(
      `  ${b.domain}  ${b.repo}  ${plain(b.branch)}  ${b.commit.slice(0, 12)}${b.offered ? "  offered" : ""}${b.landed ? `  merged into ${plain(b.landed)}` : ""}${b.checkedOutIn.length ? `  checked out in ${b.checkedOutIn.join(", ")}` : ""}\n    review: desolate review ${b.domain} ${b.repo} ${plain(b.branch)}`,
    );
};

export const review = async (
  args: string[],
  out: Out,
  json: boolean,
  against: "origin" | "domain" = "origin",
) => {
  const diff = args.includes("--diff");
  const [domain, repo, branch] = args.filter((arg) => arg !== "--diff");
  if (!domain || !repo || !branch)
    refuse(
      "review what?",
      "desolate review <domain> <owner/repo> <branch> [--against origin|domain]   (see `desolate branches` and `desolate offers`)",
      EXIT.usage,
    );
  const r = await rootctl<Review & { againstLabel?: string; pushCommits?: number }>(
    "review",
    { domain, repo, branch, against },
    { quiet: true },
  );
  if (json) return out(JSON.stringify(r));
  out(`${r.repo}  ${plain(r.branch)}  at ${r.commit}, against ${r.againstLabel ?? "origin"}`);
  out(
    against === "domain"
      ? `beyond ${r.againstLabel ?? "the domain's default branch"}: ${r.commits.length} commit(s), ${r.stat || "no file changes"}. A push would send ${r.pushCommits} commit(s) (against origin).`
      : `a push would send ${r.commits.length} commit(s): ${r.stat || "no file changes"}${r.lfsObjects ? `, and ${r.lfsObjects} LFS object(s) first` : ""}`,
  );
  for (const c of r.commits.slice(0, 30))
    out(`  ${c.commit.slice(0, 12)}  ${plain(c.subject).slice(0, 100)}`);
  if (r.commits.length > 30) out(`  ... and ${r.commits.length - 30} more`);
  for (const file of r.files.slice(0, 40)) out(`  ${plain(file)}`);
  if (r.files.length > 40) out(`  ... and ${r.files.length - 40} more files`);
  for (const warning of r.warnings) out(`  WARNING: ${warning}`);
  if (diff) {
    // The diff is the content's own text, made in the root by git alone. Shown as text:
    // anything that could repaint a terminal is replaced.
    const d = await rootctl<{ text: string; truncated: boolean }>(
      "review.diff",
      { domain, repo, branch, against },
      { quiet: true },
    );
    out("");
    out(printableLines(d.text).trimEnd());
    if (d.truncated)
      out(
        "... the diff is longer than is shown here. The whole of it: desolate root shell, then git diff.",
      );
  } else {
    out(
      `read the diff: desolate review ${domain} ${r.repo} ${plain(r.branch)} --diff${against === "domain" ? " --against domain" : ""}`,
    );
    out(
      `  or in the dashboard: http://${ROOT_HOSTNAME}:${editorHostPort()}/?review&domain=${encodeURIComponent(domain)}&repo=${encodeURIComponent(r.repo)}&branch=${encodeURIComponent(r.branch)}`,
    );
    out("  or with git, in `desolate root shell`");
  }
  if (!r.pushable)
    out(`${r.repo} is not pushable (cloned --no-push): there is no write key for it.`);
  else
    out(
      `to push exactly this: desolate push ${domain} ${r.repo} ${plain(r.branch)} --expect ${r.commit}`,
    );
};

declare namespace review {
  /** what a push would send, the commit subjects as text (an escape is shown, not obeyed), and
   *  the exact command that pushes exactly this commit */
  export type Shows = Given<
    [
      Mock<"./stack.ts", typeof fakeStack>,
      Invoke<
        typeof rootAnswers,
        [
          answers: {
            review: {
              repo: "acme/web";
              branch: "fix/login";
              commit: "0123456789abcdef0123456789abcdef01234567";
              pushable: true;
              isDefault: false;
              commits: [
                {
                  commit: "0123456789abcdef0123456789abcdef01234567";
                  subject: "Fix the login loop\u001b[2J";
                },
              ];
              files: ["src/login.ts"];
              stat: "1 file changed, 3 insertions(+)";
              lfsObjects: 0;
              warnings: [];
            };
          },
        ]
      >,
      Invoke<
        typeof review,
        [args: ["acme", "acme/web", "fix/login"], out: typeof collect, json: false]
      >,
    ],
    Expect<
      Invoke<typeof said>,
      "=",
      [
        "acme/web  fix/login  at 0123456789abcdef0123456789abcdef01234567, against origin",
        "a push would send 1 commit(s): 1 file changed, 3 insertions(+)",
        "  0123456789ab  Fix the login loop?[2J",
        "  src/login.ts",
        "read the diff: desolate review acme acme/web fix/login --diff",
        "  or in the dashboard: http://desolate.localhost:31581/?review&domain=acme&repo=acme%2Fweb&branch=fix%2Flogin",
        "  or with git, in `desolate root shell`",
        "to push exactly this: desolate push acme acme/web fix/login --expect 0123456789abcdef0123456789abcdef01234567",
      ]
    >
  >;
  /** the default branch is pushed as any branch is; a repository cloned --no-push has no
   *  write key, and says so instead */
  export type DefaultBranch = Given<
    [
      Mock<"./stack.ts", typeof fakeStack>,
      Invoke<
        typeof rootAnswers,
        [
          answers: {
            review: {
              repo: "acme/web";
              branch: "main";
              commit: "0123456789abcdef0123456789abcdef01234567";
              pushable: true;
              isDefault: true;
              commits: [
                {
                  commit: "0123456789abcdef0123456789abcdef01234567";
                  subject: "Fix the login loop\u001b[2J";
                },
              ];
              files: ["src/login.ts"];
              stat: "1 file changed, 3 insertions(+)";
              lfsObjects: 0;
              warnings: [];
            };
          },
        ]
      >,
      Invoke<typeof review, [args: ["acme", "acme/web", "main"], out: typeof collect, json: false]>,
    ],
    Expect<
      Invoke<typeof said>,
      "includes",
      "to push exactly this: desolate push acme acme/web main --expect 0123456789abcdef0123456789abcdef01234567"
    >
  >;
  export type NotPushable = Given<
    [
      Mock<"./stack.ts", typeof fakeStack>,
      Invoke<
        typeof rootAnswers,
        [
          answers: {
            review: {
              repo: "acme/web";
              branch: "fix/login";
              commit: "0123456789abcdef0123456789abcdef01234567";
              pushable: false;
              isDefault: false;
              commits: [
                {
                  commit: "0123456789abcdef0123456789abcdef01234567";
                  subject: "Fix the login loop\u001b[2J";
                },
              ];
              files: ["src/login.ts"];
              stat: "1 file changed, 3 insertions(+)";
              lfsObjects: 0;
              warnings: [];
            };
          },
        ]
      >,
      Invoke<
        typeof review,
        [args: ["acme", "acme/web", "fix/login"], out: typeof collect, json: false]
      >,
    ],
    Expect<
      Invoke<typeof said>,
      "includes",
      "acme/web is not pushable (cloned --no-push): there is no write key for it."
    >
  >;
  /** all three names, or a usage error before the root is asked */
  export type ReviewWhat = Given<
    [Mock<"./stack.ts", typeof fakeStack>, Invoke<typeof rootAnswers, [answers: {}]>],
    Expect<
      Invoke<
        typeof refusalOf,
        [run: typeof review, args: [args: ["acme", "acme/web"], out: typeof collect, json: false]]
      >,
      "=",
      {
        message: "review what?";
        fix: "desolate review <domain> <owner/repo> <branch> [--against origin|domain]   (see `desolate branches` and `desolate offers`)";
        code: 64;
      }
    >
  >;
}

const PUSH = ["node", "--disable-warning=ExperimentalWarning", `${guest.release}/root/push.ts`];

/** Whether the approval text the root prepared names what the person asked to push: the
 *  repository and the branch they typed, and the commit they named with --expect, when they
 *  did. The text comes from the root's ordinary user, which reads every domain's data; the
 *  person's own words are here, on the Mac, and nowhere else. Without this check a root user
 *  taken over could name another commit under the same branch, and the person, typing the
 *  branch to approve, would approve it (audit, 2026-11-20). Null if it does; else why not. */
export const approvalDiffers = (
  message: string,
  repo: string | undefined,
  branch: string | undefined,
  expect: string | undefined,
): string | null => {
  const approval = parseApproval(message);
  if (!approval) return "the root's approval text is not one";
  const asked = parseRepo(repo ?? "");
  if (!asked || repoId(asked).toLowerCase() !== approval.repo.toLowerCase())
    return `the root named ${approval.repo}, not ${printable(repo ?? "")}`;
  if (approval.branch !== branch) return `the root named the branch ${approval.branch}`;
  if (
    expect !== undefined &&
    !(/^[0-9a-f]{7,40}$/.test(expect) && approval.commit.startsWith(expect))
  )
    return `the root named the commit ${approval.commit}, not ${printable(expect)}`;
  return null;
};

declare namespace approvalDiffers {
  export type Cases = Table<
    typeof approvalDiffers,
    [
      [
        args: [
          message: "desolate push approval v2\nrepo: acme/app\nbranch: fix\ncommit: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nonto: none\nnonce: 0123456789abcdef0123456789abcdef\n",
          repo: "acme/app",
          branch: "fix",
          expect: "aaaaaaaaaaaa",
        ],
        expected: null,
      ],
      [
        args: [
          message: "desolate push approval v2\nrepo: acme/app\nbranch: fix\ncommit: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\nonto: none\nnonce: 0123456789abcdef0123456789abcdef\n",
          repo: "acme/app",
          branch: "fix",
          expect: "aaaaaaaaaaaa",
        ],
        expected: "the root named the commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb, not aaaaaaaaaaaa",
      ],
      [
        args: [
          message: "desolate push approval v2\nrepo: acme/app\nbranch: main\ncommit: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nonto: none\nnonce: 0123456789abcdef0123456789abcdef\n",
          repo: "acme/app",
          branch: "fix",
          expect: undefined,
        ],
        expected: "the root named the branch main",
      ],
      [
        args: [
          message: "desolate push approval v2\nrepo: acme/other\nbranch: fix\ncommit: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nonto: none\nnonce: 0123456789abcdef0123456789abcdef\n",
          repo: "acme/app",
          branch: "fix",
          expect: undefined,
        ],
        expected: "the root named acme/other, not acme/app",
      ],
    ]
  >;
}

export const push = async (args: string[]): Promise<number> => {
  const prepared = await backend().exec(ROOT_VM, [...PUSH, "prepare", ...args], {
    cwd: guest.rootClones,
    inheritStderr: true,
    timeoutMs: 300_000,
  });
  if (prepared.code !== 0) return prepared.code;
  let plan: { summary: string; warnings: string[]; message: string };
  try {
    plan = JSON.parse(prepared.stdout.trim().split("\n").pop() ?? "");
  } catch {
    return refuse("the root did not describe the push", "desolate doctor");
  }
  // What the person typed, against what the root prepared: refused before anything is signed.
  const { values, positionals } = parseArgs({
    args,
    options: {
      expect: { type: "string" },
      "allow-default": { type: "boolean" },
      squash: { type: "boolean" },
      replace: { type: "boolean" },
    },
    allowPositionals: true,
    strict: false,
  });
  const differs = approvalDiffers(
    plan.message,
    positionals[1],
    positionals[2],
    typeof values.expect === "string" ? values.expect : undefined,
  );
  if (differs)
    return refuse(
      `${differs}: nothing was signed or pushed`,
      "desolate doctor (the root answered for another push than yours)",
    );
  for (const warning of plan.warnings)
    process.stderr.write(`desolate: WARNING: this push ${plain(warning)}\n`);
  const chosen = await chosenText(plan.message, {
    squash: values.squash === true,
    replace: values.replace === true,
    again: `desolate push ${args.filter((a) => a !== "--squash" && a !== "--replace").join(" ")}`,
  });
  if (typeof chosen === "number") return chosen;
  const signature = await sign(chosen.text, chosen.line, chosen.replaces, chosen.size);
  void (await import("./daemon.ts")).announceApproved(plan.message);
  const code = await backend().attach(
    ROOT_VM,
    [
      ...PUSH,
      "run",
      ...args.filter((a) => a !== "--squash" && a !== "--replace"),
      "--message",
      Buffer.from(chosen.text).toString("base64"),
      "--signature",
      signature,
    ],
    { cwd: guest.rootClones },
  );
  // How to carry on from a squash, said by the host, from the very text it signed: what the
  // root's user prints, it may have written itself (the independent review of #169).
  const signed = parseSigned(chosen.text);
  if (code === 0 && signed?.squashes)
    process.stdout.write(carryOn(signed.branch, signed.squashes, true));
  return code;
};

/** After a squashed push: what the workspace's branch is now, and the command to carry on. */
const carryOn = (branch: string, squashed: string, sameName: boolean): string =>
  `desolate (on the Mac): the workspace's ${sameName ? branch : "branch"} still has the commits that were squashed, so its next push would replace the remote's ${branch}. To carry on from the squash, run this in the workspace${sameName ? "" : ", on the branch you pushed"} (what you committed since is kept, on top; what you have not committed is put back):\n  ${catchUp(branch, squashed, sameName ? branch : undefined)}\n`;

/** The text the person signs for a challenge: the challenge, with what desolate's reviewer
 *  says the push sends (the host asks it, as root). The person's choices: the commits as they
 *  are, or squashed into one; and a push that replaces the remote's branch goes only with
 *  --replace. A push the reviewer cannot describe is not approved at all: what it would send
 *  is what the approval names. A number is the exit code of a refusal, said. */
export const chosenText = async (
  message: string,
  choice: { squash: boolean; replace: boolean; again: string },
): Promise<{ text: string; line: string[]; replaces: boolean; size: number } | number> => {
  const push = parseApproval(message);
  if (!push) return refuse("the root's approval text is not one", "desolate doctor");
  const { reviewerSummary } = await import("./daemon.ts");
  const s = await reviewerSummary(push);
  if (!s.ok || !s.sends)
    return refuse(
      `desolate's reviewer could not say what this push would send (${printable(s.error ?? "no answer")}), so it cannot be approved: nothing was signed`,
      "desolate doctor, then push again",
    );
  const replaces = s.fastForward === false;
  if (replaces && !choice.replace)
    return refuse(
      s.squashedFrom && isCommit(s.squashedFrom)
        ? `this push REPLACES the remote's ${push.branch}, which is the squash of ${s.squashedFrom.slice(0, 12)}, a commit of this branch, pushed before. Nothing was signed`
        : `this push REPLACES the remote's ${push.branch}: it does not build on it, and the commits only the remote has would be dropped. Nothing was signed`,
      s.squashedFrom && isCommit(s.squashedFrom)
        ? `to build on the squash, run \`${catchUp(push.branch, s.squashedFrom, push.branch)}\` in the workspace, then push again. To replace it instead: ${choice.again} --replace`
        : `to replace it, say so: ${choice.again} --replace (or fetch, and rebase in the workspace)`,
    );
  if (choice.squash && !s.squash)
    return refuse(
      "there is nothing to squash: the push is one commit on what it builds on",
      `push it as it is: ${choice.again}`,
    );
  const sends = choice.squash
    ? { commit: s.squash!.commit, squashes: push.commit, ...s.squash!.sends }
    : { commit: push.commit, squashes: null, ...s.sends };
  return {
    text: signedFor(message, sends),
    line: reviewedLines(s, choice.squash),
    replaces,
    size: sends.size,
  };
};

/** The reviewer's account of a push, for the terminal's prompt: what the approval page shows,
 *  from the root's reviewer, not the root's ordinary user (which reads what domains write).
 *  A line each, what needs attention first, none cut short by another (the independent review
 *  of #169: one 300-character line lost "changes what runs on the forge" behind a warning). */
const reviewedLines = (s: Summary, squashed: boolean): string[] => {
  const commits = (s.commits?.length ?? 0) + (s.more ?? 0);
  const files = (s.files?.length ?? 0) + (s.moreFiles ?? 0);
  const between = (s.between?.length ?? 0) + (s.moreBetween ?? 0);
  const sends = squashed ? s.squash?.sends : s.sends;
  const lfsBytes = (sends?.lfs ?? []).reduce((n, e) => n + Number(e.split(" ")[1] || 0), 0);
  const forge = (s.files ?? []).filter((f) => f.sensitive).map((f) => f.path);
  const square = s.squash;
  return [
    ...(forge.length
      ? [
          `FORGE       changes what runs on the forge: ${forge.slice(0, 5).join(", ")}${forge.length > 5 ? `, and ${forge.length - 5} more` : ""}`,
        ]
      : []),
    ...(s.warnings ?? []).slice(0, 20).map((w) => `warning     ${w}`),
    squashed
      ? `sends       ${commits} commit(s) the remote does not have, squashed into one, ${files} file(s)`
      : `sends       ${commits} commit(s) the remote does not have, ${files} file(s)`,
    ...(sends?.lfs.length
      ? [`            ${sends.lfs.length} LFS object(s) with them, ${formatBytes(lfsBytes)}`]
      : []),
    ...(!squashed && between
      ? [
          `between     ${between} more file(s) its commits change that the net change does not show: each commit is pushed, so what they held is in the history (--squash pushes only the net change)`,
        ]
      : []),
    ...(squashed && square
      ? [
          `as          ${square.author ?? ""}`,
          `committer   ${square.committer ?? ""}`,
          `            ${square.dates ?? ""}`,
          ...square.message
            .replace(/\n$/, "")
            .split("\n")
            .slice(0, 12)
            .map((line, i) => `${i === 0 ? "message     " : "            "}${line}`),
          ...(square.message.split("\n").length > 13 ? ["            (and more lines)"] : []),
        ]
      : []),
  ];
};
const formatBytes = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KiB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

/** `desolate approve`: answer the raw `git push` that is waiting in the root's terminal. */
export const approve = async (
  out: Out,
  choice: { squash: boolean; replace: boolean } = { squash: false, replace: false },
): Promise<number> => {
  const pending = await rootctl<{ message: string; summary: string }[]>(
    "approvals.pending",
    {},
    { quiet: true },
  );
  if (pending.length === 0) {
    out(
      "nothing is waiting for approval. (`desolate push` asks by itself; this is for a raw `git push` in `desolate root shell`.)",
    );
    return 0;
  }
  for (const request of pending) {
    // (A raw push that replaces the remote's branch was asked for with git's own `+`: the
    // prompt asks to type `replace <branch>` all the same.)
    const chosen = await chosenText(request.message, {
      squash: choice.squash,
      replace: true,
      again: "desolate approve",
    });
    if (typeof chosen === "number") return chosen;
    const signature = await sign(chosen.text, chosen.line, chosen.replaces, chosen.size);
    void (await import("./daemon.ts")).announceApproved(request.message);
    await rootctl("approvals.answer", { message: chosen.text, signature }, { quiet: true });
    out("approved; the push waiting in the root continues.");
    const signed = parseSigned(chosen.text);
    // (A raw push's branch in the workspace may have another name: the one checked out.)
    if (signed?.squashes) out(carryOn(signed.branch, signed.squashes, false).trimEnd());
  }
  return 0;
};

declare namespace approve {
  /** nothing waiting: said, and nothing is signed */
  export type NothingWaiting = Given<
    [
      Mock<"./stack.ts", typeof fakeStack>,
      Invoke<typeof rootAnswers, [answers: { "approvals.pending": [] }]>,
    ],
    [
      Expect<Invoke<typeof approve, [out: typeof collect]>, "=", 0>,
      Expect<
        Invoke<typeof said>,
        "=",
        [
          "nothing is waiting for approval. (`desolate push` asks by itself; this is for a raw `git push` in `desolate root shell`.)",
        ]
      >,
    ]
  >;
}

export const rootShell = (): Promise<number> =>
  backend().attach(ROOT_VM, ["bash", "-l"], { cwd: guest.rootClones });
