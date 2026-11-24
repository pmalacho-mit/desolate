// T4 (vz, on a Mac: DESOLATE_TIER=T4). The host asks desolate's reviewer as
// root in the root VM (host/vm/lima.ts `spawn`, host/daemon.ts `reviewerAsked`), and a
// question nobody waits for any more must end there: the person's Ctrl-C at the terminal,
// a CLI killed alone, a page that let go of its question, a git VM push withdrawn with Ctrl-C. Each is tried beside a control
// asked the same at the same moment and still waited for, which is still running when the
// other has ended; and once all have ended, none of the reviewer's git is left.
//
// What keeps the reviewer working is real work, made here: a file of 3.2 million short
// lines that a push changes. Its diff takes a minute or more (measured on the M1: 1.6
// million lines, 15 s), so no delay is put in the root for the test.
//
// Run: tests/v3/run.sh t4
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { request as httpRequest } from "node:http";
import type { ClientRequest } from "node:http";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { bootstrap, git, newStack, REPO_ROOT } from "../lib/harness.ts";
import type { Stack } from "../lib/harness.ts";

let stack: Stack;
const REAL = process.env.DESOLATE_TIER === "T4";
const CLONE = "/desolate/root/acme/widgets";
const LINES = 3_200_000;
/** Within this long of being let go, no process of the question is left in the root. */
const ENDS_MS = 15_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `count` short lines from a few dozen, in an order `seed` decides: a diff of two such files
 *  is long work for git, whichever way it is asked. */
const lines = (seed: number, count: number) => {
  let x = seed;
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out.push(`x${x % 51}`);
  }
  return `${out.join("\n")}\n`;
};

const inClone = (script: string) =>
  stack.inRoot([
    "bash",
    "-c",
    `export GIT_CONFIG_GLOBAL=/var/lib/desolate-root/gitconfig; cd ${CLONE} && ${script}`,
  ]);
/** A count (pgrep's `-c`): 0 when nothing matched, and a failure when it did not run, so a
 *  root that could not be asked never reads as one with nothing left. */
const counted = (result: { code: number; stdout: string; stderr: string }) => {
  assert.ok(
    (result.code === 0 || result.code === 1) && /^\d+$/.test(result.stdout.trim()),
    `pgrep did not answer: ${result.code} ${result.stdout} ${result.stderr}`,
  );
  return Number(result.stdout.trim());
};
const inRootCount = (args: string[]) => counted(stack.inRoot(["pgrep", ...args], { root: true }));
/** How many questions to the reviewer are being answered in the root: review-ask.ts (root's,
 *  one a question) and the reviewer's own node for it (runuser, its parent, is not counted). */
const asking = () => ({
  asks: inRootCount(["-fc", "root/review-ask[.]ts"]),
  reviewers: inRootCount(["-fc", "^node .*reviewer[.]ts (account|summary)$"]),
});
/** The git the reviewer runs (its work), none left once no question is answered. */
const reviewersGit = () => inRootCount(["-c", "-u", "desolate-reviewer", "git"]);
const until = async (what: string, done: () => boolean, ms: number) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(500)) if (done()) return;
  assert.fail(`${what}: not within ${ms / 1000} s (${JSON.stringify(asking())})`);
};
/** `script` started in `vm` (as its ordinary user) and left running. It must hold nothing
 *  of the call that starts it: on Lima, a command left running with any of the session's
 *  descriptors kept that session, and the synchronous call, open (a first version held the
 *  T4 slot for 90 minutes). So it runs in a session of its own (setsid -f), every descriptor
 *  past the three it redirects closed first; and the call, as the harness's inRoot makes it,
 *  is given a minute, so a run can never hang here. */
const detached = (vm: string, script: string, log: string) => {
  const started = spawnSync(
    process.env.DESOLATE_LIMACTL ?? "limactl",
    [
      "--tty=false",
      "shell",
      "--workdir",
      "/",
      vm,
      "bash",
      "-c",
      `for fd in /proc/$$/fd/*; do n=\${fd##*/}; [ "$n" -gt 2 ] && eval "exec $n>&-"; done 2>/dev/null; setsid -f bash -c "$1" >${log} 2>&1 </dev/null; echo started`,
      "_",
      script,
    ],
    { env: stack.env, input: "", encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL" },
  );
  assert.match(started.stdout ?? "", /started/, `${started.error ?? ""} ${started.stderr}`);
};
/** A raw `git push` of HEAD from the root's terminal, left waiting for its approval. */
const rawPush = (branch: string) =>
  detached(
    `dsl-${stack.instance}-root`,
    `export GIT_CONFIG_GLOBAL=/var/lib/desolate-root/gitconfig; cd ${CLONE} && exec git push origin HEAD:refs/heads/${branch}`,
    `/tmp/${branch}.log`,
  );
/** The pushes waiting for approval, as the root's own files list them. */
const waitingPushes = () =>
  counted(
    stack.inRoot([
      "bash",
      "-c",
      "set -o pipefail; ls /var/lib/desolate/approvals | { grep -c '[.]json$' || true; }",
    ]),
  );

describe(
  "T3: a question to the reviewer in the root ends when nobody waits for it",
  { skip: REAL ? false : "set DESOLATE_TIER=T4 (tests/v3/run.sh t4, on a Mac)" },
  () => {
    before(() => {
      stack = newStack("rev");
      stack.seed("acme/widgets", (dir) => {
        fs.writeFileSync(path.join(dir, "big.txt"), lines(1, LINES));
        git(dir, "add", "-A");
        git(dir, "commit", "--quiet", "-m", "seed");
      });
    });
    after(() => stack?.destroy());

    it("T3 bootstrap, and a pushable clone", () => {
      stack.step(`bootstrap on the ${stack.backend} backend`);
      const result = bootstrap(stack);
      assert.equal(result.code, 0, result.stderr + result.stdout.slice(-1500));
      assert.equal(stack.quiet("clone", "acme/widgets", "--no-domain").code, 0);
    });

    it("T3 Ctrl-C at the terminal ends its question in the root; the control, still asked, runs on", async () => {
      stack.step("the terminal's question to the reviewer, stopped");
      // A push whose net change is the long diff: the account of it (its files' counts) is
      // the long work.
      const made = inClone(
        `git checkout -q -b slow-net && awk 'BEGIN { srand(2); for (i = 0; i < ${LINES}; i++) print "x" int(rand() * 51) }' > big.txt && git commit -qam 'the long diff' && echo made`,
      );
      assert.match(made.stdout, /made/, made.stderr);
      rawPush("slow-net");
      await until("the push waits for its approval", () => waitingPushes() === 1, 120_000);
      // Three people at three terminals, `desolate approve`, each asking the reviewer for its
      // account: each a question of its own in the root.
      const terminal = () =>
        spawn(path.join(REPO_ROOT, "release", "cli.sh"), ["approve"], {
          env: stack.env,
          detached: true,
          stdio: "ignore",
        });
      const stopped = terminal();
      const killed = terminal();
      const control = terminal();
      try {
        await until("the three questions are being answered", () => asking().asks === 3, 60_000);
        await sleep(3_000);
        assert.deepEqual(asking(), { asks: 3, reviewers: 3 }, "all three still at work");
        // Ctrl-C: SIGINT to the terminal's foreground process group.
        process.kill(-stopped.pid!, "SIGINT");
        await until("Ctrl-C's question ends in the root", () => asking().asks === 2, ENDS_MS);
        // A CLI killed alone (cli.sh execs node): its ssh is left, and ends at its next write.
        process.kill(killed.pid!, "SIGKILL");
        await until(
          "the killed CLI's question ends in the root",
          () => asking().asks === 1,
          ENDS_MS,
        );
        await sleep(2_000);
        assert.deepEqual(
          asking(),
          { asks: 1, reviewers: 1 },
          "CONTROL: the terminal still waiting is still answered",
        );
      } finally {
        for (const child of [stopped, killed, control])
          try {
            process.kill(-child.pid!, "SIGINT");
          } catch {
            /* ended */
          }
      }
      await until(
        "the control's question ends too, once stopped",
        () => asking().asks === 0,
        ENDS_MS,
      );
      assert.deepEqual(asking(), { asks: 0, reviewers: 0 });
      assert.equal(reviewersGit(), 0, "and none of the reviewer's git is left");
      // The push is withdrawn where it was asked: it leaves the list.
      inClone("pkill -f 'git push origin HEAD:refs/heads/slow-ne[t]' || true");
      await until("the withdrawn push leaves the list", () => waitingPushes() === 0, 30_000);
    });

    it("T3 a page that lets go of its question ends it in the root; the control, still asked, runs on", async () => {
      stack.step("the approval page's question to the reviewer, let go");
      // A push that changes the file and puts it back: its account is quick (no net change),
      // and the diff of its first commit is the long work.
      const made = inClone(
        `git checkout -q -b slow-commit slow-net~1 && awk 'BEGIN { srand(3); for (i = 0; i < ${LINES}; i++) print "x" int(rand() * 51) }' > big.txt && git commit -qam 'the long diff' && git rev-parse HEAD && git checkout -q HEAD~1 -- big.txt && git commit -qam 'put back' && echo made`,
      );
      assert.match(made.stdout, /made/, made.stderr);
      const changed = made.stdout.trim().split("\n")[0]!;
      rawPush("slow-commit");
      await until("the push waits for its approval", () => waitingPushes() === 1, 120_000);

      const address =
        /approvals {4}(http:\/\/desolate-approve\.localhost:(\d+)\/\?tkn=[0-9a-f]{48})/.exec(
          stack.quiet("approve", "--web").stdout,
        );
      assert.ok(address, "the page's address");
      const port = Number(address![2]);
      const call = (
        url: string,
        headers: Record<string, string>,
      ): {
        req: ClientRequest;
        answer: Promise<{ status: number; headers: Record<string, unknown>; body: string }>;
      } => {
        const req = httpRequest({
          host: "127.0.0.1",
          port,
          path: url,
          headers: { host: `desolate-approve.localhost:${port}`, ...headers },
        });
        const answer = new Promise<{
          status: number;
          headers: Record<string, unknown>;
          body: string;
        }>((resolve, reject) => {
          req.on("response", (res) => {
            let text = "";
            res.on("data", (chunk) => (text += chunk));
            res.on("end", () =>
              resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }),
            );
          });
          req.on("error", reject);
        });
        req.end();
        return { req, answer };
      };
      const at = new URL(address![1]!);
      const login = await call(at.pathname + at.search, {}).answer;
      assert.equal(login.status, 200);
      const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
      const key = /<meta name="desolate-key" content="([0-9a-f]{64})">/.exec(login.body)![1]!;
      const asPage = { cookie, "x-desolate-key": key, "sec-fetch-site": "same-origin" };
      type Waiting = {
        nonce: string;
        token: string;
        branch: string;
        review: { working?: unknown; error?: string; account?: unknown };
      };
      let push: Waiting | undefined;
      for (let i = 0; i < 240 && !push; i++) {
        const listed = JSON.parse((await call("/pending", asPage).answer).body) as {
          pending?: Waiting[];
        };
        push = listed.pending?.find((p) => p.branch === "slow-commit" && !p.review.working);
        if (!push) await sleep(500);
      }
      assert.ok(push?.review.account, `the page has the account: ${JSON.stringify(push)}`);
      await until("the account's question has ended", () => asking().asks === 0, ENDS_MS);
      // The page asks for the first commit's diff twice, on two connections.
      const diff = `/diff?nonce=${push!.nonce}&token=${push!.token}&commit=${changed}&from=0`;
      const letGo = call(diff, asPage);
      const held = call(diff, asPage);
      for (const asked of [letGo, held]) asked.answer.catch(() => {});
      try {
        await until("both questions are being answered", () => asking().asks === 2, 60_000);
        await sleep(3_000);
        assert.deepEqual(asking(), { asks: 2, reviewers: 2 }, "both still at work");
        letGo.req.destroy();
        await until("the question let go ends in the root", () => asking().asks === 1, ENDS_MS);
        await sleep(2_000);
        assert.deepEqual(
          asking(),
          { asks: 1, reviewers: 1 },
          "CONTROL: the question still held is still answered",
        );
      } finally {
        letGo.req.destroy();
        held.req.destroy();
      }
      await until(
        "the control's question ends too, once let go",
        () => asking().asks === 0,
        ENDS_MS,
      );
      assert.deepEqual(asking(), { asks: 0, reviewers: 0 });
      inClone("pkill -f 'git push origin HEAD:refs/heads/slow-commi[t]' || true");
    });

    it("T3 a git VM push, withdrawn with Ctrl-C at its terminal, leaves the list; the control, not withdrawn, stays", async () => {
      stack.step("a push from the git VM, withdrawn with Ctrl-C");
      await until("the pushes before have left the list", () => waitingPushes() === 0, 30_000);
      const made = stack.desolate("git", "acme/widgets");
      assert.equal(made.code, 0, made.stderr);
      const vm = `dsl-${stack.instance}-git`;
      const inGit = (script: string) => stack.inVm(vm, ["bash", "-c", script]);
      // A terminal of its own, as the git terminal's (git/terminal.py): bash in a pty, the
      // push typed there, and Ctrl-C typed there when the test says so (SIGUSR1).
      const terminal = `import os, pty, signal, sys
pid, fd = pty.fork()
if pid == 0:
    os.chdir("/git/acme/widgets")
    os.execvp("bash", ["bash", "--norc", "-i"])
signal.signal(signal.SIGUSR1, lambda *_: os.write(fd, b"\\x03"))
os.write(fd, sys.argv[1].encode() + b"\\n")
while True:
    try:
        data = os.read(fd, 65536)
    except OSError:
        break
    if not data:
        break
    sys.stdout.buffer.write(data)
    sys.stdout.flush()
`;
      const wrote = stack.inVm(vm, ["bash", "-c", "cat > /tmp/terminal.py"], { input: terminal });
      assert.equal(wrote.code, 0, wrote.stderr);
      const commit = inGit(
        "cd /git/acme/widgets && git switch -q -c withdrawn origin/main && echo w > w.txt && git add w.txt && git -c user.name=p -c user.email=p@example.invalid commit -qm w && echo made",
      );
      assert.match(commit.stdout, /made/, commit.stderr);
      detached(
        vm,
        "exec python3 -I /tmp/terminal.py 'git push origin HEAD:refs/heads/withdrawn'",
        "/tmp/terminal.log",
      );
      await until("the push waits for its approval", () => waitingPushes() === 1, 120_000);
      // CONTROL: not withdrawn, it stays on the list.
      await sleep(ENDS_MS);
      assert.equal(waitingPushes(), 1, "CONTROL: a push still waited for stays on the list");
      inGit("pkill -USR1 -f '/tmp/terminal[.]py'");
      await until(
        "the push withdrawn with Ctrl-C leaves the list",
        () => waitingPushes() === 0,
        ENDS_MS,
      );
      const said = inGit("cat /tmp/terminal.log").stdout;
      assert.match(said, /Until it is approved, Ctrl-C withdraws it/, said);
      // And the git VM's next push is taken at once: nothing of the last one holds the host.
      detached(
        vm,
        "cd /git/acme/widgets && exec git push origin HEAD:refs/heads/withdrawn",
        "/tmp/again.log",
      );
      await until("the next push is taken and waits", () => waitingPushes() === 1, 60_000);
      // git killed alone (no signal reaches its helper, which git runs as a grandchild): the
      // helper's input closes, and that withdraws the push too. (Found by this test's first
      // run: it stayed listed.)
      inGit(
        "pkill -f 'python3 -I /tmp/terminal[.]py'; pkill -KILL -f 'git push origin HEAD:refs/heads/withdraw[n]'",
      );
      await until(
        "a push whose git was killed alone leaves the list",
        () => waitingPushes() === 0,
        ENDS_MS,
      );
    });
  },
);
