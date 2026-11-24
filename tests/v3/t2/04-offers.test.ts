// T2 (fake backend). Phase 5: offers and pushes, and the root's view of every domain.
// Exit criteria of move-to-vms.md section 13.4, phase 5 (all but `upstream`).
import assert from "node:assert/strict";
import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { request as httpRequest } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { bootstrap, git, newStack, outboxSaid } from "../lib/harness.ts";
import type { Stack } from "../lib/harness.ts";
import { findChrome, loadPage, openBrowser } from "../lib/browser.ts";
import { lfsDigest, signedFor } from "../../../release/shared/approval.ts";
import { NAMES } from "../../../release/shared/limits.ts";

let stack: Stack;
let commit = "";
let oid = "";
/** The commit's LFS object as the reviewer lists it for the pusher, by its pointer's size. */
const lfsListed = () => [`${oid} 50000`];
const vms = new Map<string, string>();
const vmOf = (target: string) => {
  if (!vms.has(target)) {
    const list = JSON.parse(stack.quiet("list", "--json").stdout) as {
      domain: string;
      workspaces: { workspace: string; vm: string }[];
    }[];
    for (const d of list) for (const w of d.workspaces) vms.set(`${d.domain}/${w.workspace}`, w.vm);
  }
  return vms.get(target)!;
};
const inWs = (target: string, script: string) => stack.inVm(vmOf(target), ["bash", "-lc", script]);
const WT = "/workspaces/acme/widgets/.worktrees/issue-12";
const ROOT_CLONE = "/desolate/root/acme/widgets";
const inRootClone = (script: string) =>
  stack.inRoot([
    "bash",
    "-c",
    `export GIT_CONFIG_GLOBAL=/var/lib/desolate-root/gitconfig; cd ${ROOT_CLONE} && ${script}`,
  ]);
const forgeRefs = (repo: string) =>
  Object.fromEntries(
    stack
      .forge("refs", repo)
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(" ") as [string, string]),
  );
const audit = () =>
  JSON.parse(
    stack.inRoot(
      ["node", "--disable-warning=ExperimentalWarning", "/desolate/release/root/rootctl.ts"],
      { input: JSON.stringify({ op: "keys.audit", args: { last: 500 } }) },
    ).stdout,
  ).result as { event: string; repo?: string; ref?: string; commit?: string }[];
/** One request to the keyring's public socket, made by the root's ordinary user. */
const keyring = (request: Record<string, unknown>) =>
  JSON.parse(
    stack.inRoot([
      "node",
      "--disable-warning=ExperimentalWarning",
      "--input-type=module",
      "-e",
      'import { ask } from "/desolate/release/root/keyring-client.ts"; console.log(JSON.stringify(await ask("/run/desolate/keyring/control.sock", JSON.parse(process.argv[1]))));',
      JSON.stringify(request),
    ]).stdout,
  ) as { ok: boolean; error?: string; message?: string; id?: string };
const forgeHas = (repo: string, id: string) => {
  try {
    stack.forge("has", repo, id);
    return true;
  } catch {
    return false;
  }
};
const forgeHasLfs = (repo: string, id: string) => {
  try {
    stack.forge("lfs-has", repo, id);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** The approval page's line under "Pushed" for a branch of acme/widgets (and that commit, if
 *  given: a branch pushed twice has two lines), as an expression. */
const pushedLine = (branch: string, commit = "") =>
  `[...document.querySelectorAll('#pushed li')].find((li) => li.textContent.startsWith(${JSON.stringify(`acme/widgets ${branch} ${commit.slice(0, 12)}`)}))`;
/** A button pressed as a person does on the approval page: the pointer comes to it, rests until
 *  it arms (or `card`, an expression, has already decided: approving, approved, not pushed;
 *  `card` "" for Dismiss, which is pressed on a card that has), and presses where it is. */
const armedPress = async (
  page: {
    move: (s: string, t?: string) => Promise<unknown>;
    until: (e: string, w: string, ms?: number) => Promise<unknown>;
    evaluate: <T>(e: string) => Promise<T>;
    pressHere: () => Promise<void>;
  },
  selector: string,
  label: string,
  card = "document.querySelector('.card.asked')",
) => {
  await page.move(selector, label);
  const decided = card
    ? `/^(approving|Approved|Not pushed)/.test(${card}?.querySelector('.hint')?.textContent ?? '')`
    : "false";
  const button = `[...document.querySelectorAll(${JSON.stringify(selector)})].find((b) => b.offsetParent && b.innerText.includes(${JSON.stringify(label)}))`;
  await page.until(`${pressable(button)} || ${decided}`, `${label} armed`, 10_000);
  if (!(await page.evaluate<boolean>(decided))) await page.pressHere();
};
/** A button pressable now: Approve by `disabled`, Refuse and Dismiss by aria-disabled (a key
 *  still reaches them). */
const pressable = (button: string) =>
  `((b) => !!b && b.disabled === false && b.getAttribute('aria-disabled') !== 'true')(${button})`;
type Hand = {
  moveTo: (x: number, y: number) => Promise<void>;
  until: (e: string, w: string, ms?: number) => Promise<unknown>;
  evaluate: <T>(e: string) => Promise<T>;
  pressHere: () => Promise<void>;
};
/** The pointer brought to `button` (an expression) and rested there until it arms. */
const restOn = async (page: Hand, button: string, what: string) => {
  const at = await page.evaluate<{ x: number; y: number }>(
    `(() => { const r = ${button}.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
  );
  await page.moveTo(at.x, at.y);
  await page.until(`${pressable(button)}`, `${what} armed`, 10_000);
};
/** Where a picture of the approval page goes, for a person to look at. */
const shot = (name: string) =>
  path.join(process.env.DESOLATE_SCREENSHOTS || os.tmpdir(), `approve-283-${name}.png`);
/** A raw `git push` in the root's terminal, left waiting for the person as it would be, in a
 *  session of its own; `stop` ends its process group, as a closed terminal does (SIGTERM: a
 *  job started in the background of a shell with no job control ignores SIGINT, so Ctrl-C's
 *  signal would not reach it here). */
const rawPushWaiting = async (spec: string, name: string) => {
  const log = `/tmp/${name}.log`;
  // The pid is written by the process that becomes git: `$!` here would be the subshell of
  // `cd ... && ...`, not the session setsid makes, and its group is not the push's.
  inRootClone(
    `setsid nohup sh -c 'echo $$ >${log}.pid; exec git push origin ${spec}' >${log} 2>&1 </dev/null & sleep 0.2`,
  );
  const said = () => inRootClone(`cat ${log}`).stdout;
  let waiting = false;
  for (let i = 0; i < 80 && !waiting; i++) {
    waiting = /waiting for it for as long as this push waits/.test(said());
    if (!waiting) await sleep(250);
  }
  assert.ok(waiting, said());
  const ps = () =>
    inRootClone(
      `echo pid $(cat ${log}.pid); ps -eo pid,pgid,sid,stat,args | grep -v ' ps -eo' | grep -E 'git|node' ; ls -l /var/lib/desolate/approvals/ 2>&1; cat /var/lib/desolate/approvals/*.json 2>&1 | cut -c1-80`,
    );
  return {
    said,
    stop: () => {
      const killed = inRootClone(`kill -TERM -- -$(cat ${log}.pid) 2>&1; echo kill=$?`);
      return `${killed.stdout}${killed.stderr}`;
    },
    ps: () => {
      const seen = ps();
      return `${seen.stdout}${seen.stderr}`;
    },
  };
};
/** Waits until nothing is waiting for the person on the host (or a few seconds pass). */
const nothingWaits = async () => {
  for (let i = 0; i < 40; i++) {
    if (/nothing is waiting for approval/.test(stack.quiet("approve").stdout)) return true;
    await sleep(250);
  }
  return false;
};
/** What desolate's reviewer answers, asked as the host asks it (as root): its lines
 *  (shared/review-account.ts), progress and then the one answer. */
const askReviewer = (request: Record<string, unknown>) =>
  stack
    .inRoot(
      ["node", "--disable-warning=ExperimentalWarning", "/desolate/release/root/review-ask.ts"],
      { root: true, input: `${JSON.stringify(request)}\n` },
    )
    .stdout.split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
type Listed<T> = { items: T[]; total: number; from: number };
type Said = {
  ok: boolean;
  error?: string;
  key?: string;
  warnings?: string[];
  commits?: Listed<{ commit: string; subject: string; author: string }>;
  files?: Listed<{ path: string }>;
  between?: Listed<{ path: string }>;
  sends?: { pack: string; size: number; lfs: { count: number; bytes: number; digest: string } };
  squash?: { commit: string; message: string; count: number; committer: string };
  lines: Record<string, unknown>[];
};
/** What desolate's reviewer says a push sends: its account, or its error. */
const reviewerSays = (branch: string, commit: string, onto: string | null = null): Said => {
  const lines = askReviewer({ op: "account", repo: "acme/widgets", branch, commit, onto });
  const last = lines.at(-1) ?? {};
  return "account" in last
    ? { ok: true, ...(last.account as object), lines }
    : { ok: false, error: String(last.error ?? JSON.stringify(last)), lines };
};
/** A page of one of the reviewer's diffs of an account. */
const reviewerDiff = (key: string, of: unknown, from = 0) =>
  askReviewer({ op: "diff", key, of, from }).at(-1) as {
    diff?: { text: string; from: number; next: number | null; total: number };
    error?: string;
  };
/** As the root's user: send the reviewer a commit, as a push would before it is approved. */
const submitted = (commit: string) => {
  const sent = stack.inRoot([
    "node",
    "--disable-warning=ExperimentalWarning",
    "--input-type=module",
    "-e",
    `import { submitForReview } from "/desolate/release/root/review-client.ts"; const why = await submitForReview({ owner: "acme", name: "widgets" }, process.argv[1]); if (why) { console.error(why); process.exit(1); }`,
    commit,
  ]);
  assert.equal(sent.code, 0, sent.stderr);
};
/** As the root's ordinary user, taken over: hand the pusher an approval's id, a pack of its
 *  own making (a file in the root VM), and LFS objects (files there too). */
const toPusher = (
  approval: string,
  pack: string,
  lfs: { oid: string; file: string }[],
  lfsListed: string[],
) =>
  JSON.parse(
    stack.inRoot([
      "node",
      "--disable-warning=ExperimentalWarning",
      "--input-type=module",
      "-e",
      `import * as fs from "node:fs"; import { connect } from "node:net";
const [approval, pack, lfs, listed] = [process.argv[1], process.argv[2], JSON.parse(process.argv[3]), JSON.parse(process.argv[4])];
// The pusher is one request per process: between two, it is starting (send.ts waits too).
const attempt = (tries) => {
  const socket = connect("/run/desolate/pusher/control.sock");
  let answer = "";
  let connected = false;
  // Lines saying how far it is come first ({"progress"}); the answer is the line after them.
  socket.on("data", (c) => { answer += c; for (const line of answer.split("\\n").slice(0, -1)) if (!("progress" in JSON.parse(line))) { console.log(line); process.exit(0); } });
  socket.on("error", (e) => { if (!connected && tries > 0) setTimeout(() => attempt(tries - 1), 500); else { console.log(JSON.stringify({ ok: false, error: "no answer: " + e.message })); process.exit(0); } });
  socket.on("connect", () => {
    connected = true;
    socket.write(JSON.stringify({ op: "push", approval, pack: fs.statSync(pack).size, lfs: lfs.map((o) => ({ oid: o.oid, size: fs.statSync(o.file).size })), lfsListed: listed }) + "\\n");
    for (const o of lfs) socket.write(fs.readFileSync(o.file));
    socket.write(fs.readFileSync(pack));
  });
};
attempt(60);`,
      approval,
      pack,
      JSON.stringify(lfs),
      JSON.stringify(lfsListed),
    ]).stdout,
  ) as { ok: boolean; error?: string };

describe("T2 phase 5: offers, the root's view, and pushes", () => {
  before(() => {
    stack = newStack("offers");
    stack.seed("acme/widgets", (dir) => {
      git(dir, "lfs", "install", "--local");
      git(dir, "lfs", "track", "*.bin");
      fs.writeFileSync(path.join(dir, "big.bin"), Buffer.alloc(100_000, 7));
      fs.writeFileSync(path.join(dir, "README.md"), "# widgets\n");
      git(dir, "add", "-A");
      git(dir, "commit", "--quiet", "-m", "seed");
    });
    stack.seed("acme/consumer", (dir) => {
      fs.writeFileSync(path.join(dir, "README.md"), "# consumer\n");
      git(dir, "add", "-A");
      git(dir, "commit", "--quiet", "-m", "seed");
    });
    assert.equal(bootstrap(stack).code, 0);
    assert.equal(stack.quiet("clone", "acme/widgets", "--no-domain").code, 0);
    assert.equal(stack.quiet("clone", "acme/consumer", "--no-push", "--no-domain").code, 0);
    assert.equal(stack.quiet("domain", "create", "dev").code, 0);
    assert.equal(stack.quiet("domain", "dev", "add", "--repo", "acme/widgets").code, 0);
    assert.equal(stack.quiet("domain", "dev", "add", "--repo", "acme/consumer").code, 0);
    const up = stack.quiet(
      "up",
      "dev",
      "--name",
      "w1",
      "--checkout",
      "acme/widgets=worktree:issue/12",
    );
    assert.equal(up.code, 0, up.stderr);
  });
  after(() => stack.destroy());

  it("an agent finishes: commits, a new LFS file, and `desolate offer`", () => {
    stack.step("offer a branch from a workspace");
    const work = inWs(
      "dev/w1",
      `cd ${WT} && head -c 50000 /dev/urandom > new.bin && echo 'fix #12' >> README.md && git add -A && git commit -qm 'fix: issue 12' && git rev-parse HEAD && sha256sum new.bin | cut -d' ' -f1`,
    );
    assert.equal(work.code, 0, work.stderr);
    [commit, oid] = work.stdout.trim().split("\n") as [string, string];
    const offered = stack.desolate(
      "exec",
      "dev/w1",
      "--checkout",
      "acme/widgets",
      "--",
      "desolate",
      "offer",
    );
    assert.equal(offered.code, 0, offered.stderr);
    assert.match(
      offered.stdout,
      /offered acme\/widgets issue\/12 at [0-9a-f]{12}, with 1 LFS object\(s\)/,
    );
    assert.match(offered.stdout, /Offering is not pushing/);
    const offers = stack.desolate("offers");
    assert.match(
      offers.stdout,
      /Needs you:\n {2}dev {2}acme\/widgets {2}issue\/12 {2}[0-9a-f]{12} {2}from w1 {2}1 LFS object/,
    );
    assert.equal(forgeRefs("acme/widgets")["issue/12"], undefined, "offering pushed nothing");
    // And it says so, for the person and for a harness: shown, never acted on.
    assert.equal(
      inWs(
        "dev/w1",
        `cd ${WT} && /desolate/status set green "ready: fix for issue 12" && /desolate/status note "touches README only"`,
      ).code,
      0,
    );
    const status = JSON.parse(stack.quiet("status", "dev/w1", "--json").stdout) as {
      status: { color: string; message: string };
    };
    assert.deepEqual(
      [status.status.color, status.status.message],
      ["green", "ready: fix for issue 12"],
    );
    assert.match(
      stack.desolate("board", "dev").stdout,
      /dev\/w1 {2}\[green\] ready: fix for issue 12\n[\s\S]*\| touches README only/,
    );
    assert.equal(
      forgeRefs("acme/widgets")["issue/12"],
      undefined,
      "saying green pushed nothing either",
    );
  });

  it("the root sees every domain's branches with ordinary git, without an offer", async () => {
    stack.step("the root's view");
    const fetched = inRootClone(
      "git fetch --all --quiet && git branch -r --format='%(refname:short)' && git log -1 --format=%s dev/issue/12 && git remote -v | grep dev",
    );
    assert.equal(fetched.code, 0, fetched.stderr);
    assert.match(fetched.stdout, /^dev\/issue\/12$/m);
    assert.match(fetched.stdout, /^dev\/main$/m);
    assert.match(fetched.stdout, /^fix: issue 12$/m);
    assert.match(fetched.stdout, /desolate::dev/);
    // A branch nobody offered arrives too: the workspace's daemon writes it out on its own.
    inWs("dev/w1", `cd ${WT} && git branch experiment && git commit -q --allow-empty -m wip`);
    let seen = false;
    for (let waited = 0; waited < 15_000 && !seen; waited += 1000) {
      await sleep(1000);
      seen = /^dev\/experiment$/m.test(
        inRootClone("git fetch dev --quiet; git branch -r --format='%(refname:short)'").stdout,
      );
    }
    assert.ok(seen, "an unoffered branch reaches the root's view within seconds");
    // The amended tip: the offer names the commit that was offered, and the branch moved on.
    commit = inWs(
      "dev/w1",
      `cd ${WT} && git reset -q --hard HEAD~1 && git rev-parse HEAD`,
    ).stdout.trim();
    stack.quiet("exec", "dev/w1", "--", "desolate", "sync");
  });

  it("review shows what a push would send", () => {
    stack.step("review");
    const text = stack.desolate("review", "dev", "acme/widgets", "issue/12");
    assert.equal(text.code, 0, text.stderr);
    assert.match(
      text.stdout,
      /a push would send 1 commit\(s\): 2 files changed.*, and 1 LFS object\(s\) first/,
    );
    assert.match(
      text.stdout,
      new RegExp(
        `to push exactly this: desolate push dev acme/widgets issue/12 --expect ${commit}`,
      ),
    );
    const json = JSON.parse(
      stack.quiet("review", "dev", "acme/widgets", "issue/12", "--json").stdout,
    ) as { commit: string; changes: { items: { path: string }[]; total: number } };
    assert.equal(json.commit, commit);
    assert.deepEqual(json.changes.items.map((c) => c.path).sort(), ["README.md", "new.bin"]);
    assert.equal(json.changes.total, 2);
  });

  it("a push is impossible without a person: every automation path is tried, and refused", async () => {
    stack.step("automation tries to push");
    // 1. The CLI, driven by a script: no terminal.
    const cli = stack.desolate("push", "dev", "acme/widgets", "issue/12", "--expect", commit);
    assert.equal(cli.code, 78);
    assert.match(cli.stderr, /there is no terminal to ask on/);
    assert.match(cli.stderr, /no person confirmed the push, so nothing was pushed/);
    // 2. Raw git in the root clone: it asks for an approval on the host, and waits for as long
    //    as it is waited for; none comes, and stopped, it takes its request with it.
    const raw = await rawPushWaiting(`${commit}:refs/heads/issue/12`, "automation-push");
    assert.match(raw.said(), /needs your approval, given on the host, outside every VM/);
    const killed = raw.stop();
    assert.ok(
      await nothingWaits(),
      `stopped, it is no longer waiting on the host\n${killed}\n${raw.ps()}\n${raw.said()}`,
    );
    assert.equal(forgeRefs("acme/widgets")["issue/12"], undefined);
    // 3. Skipping desolate's hook: straight to the remote's own address, around desolate's
    //    helper and its hook. This user has no way to a write key at all (the pusher does).
    const noVerify = inRootClone(
      `git push --no-verify "$(git config lfs.pushurl)" ${commit}:refs/heads/issue/12 2>&1`,
    );
    assert.notEqual(noVerify.code, 0);
    assert.match(
      inRootClone("git config remote.origin.pushurl; git config lfs.pushurl").stdout,
      /^desolate-push::acme\/widgets\nssh:\/\//,
      "control: that address is the remote's",
    );
    assert.match(
      noVerify.stdout,
      /Permission denied|agent refused|signing failed|Host key verification failed|Could not read from remote/i,
    );
    // 4. Skipping the LFS-first rule changes nothing either.
    assert.notEqual(inRootClone(`git lfs push origin --object-id ${oid} 2>&1`).code, 0);
    // 5. Approving it from inside the root VM. Anyone there may ask the keyring for a
    //    challenge; answering takes the host approver's key, which is not in the VM.
    const challenge = keyring({ op: "challenge", repo: "acme/widgets", ref: "issue/12", commit });
    assert.equal(challenge.ok, true, String(challenge.error));
    assert.match(
      challenge.message!,
      new RegExp(
        `^desolate push approval v2\\nrepo: acme/widgets\\nbranch: issue/12\\ncommit: ${commit}\\nonto: none\\nnonce: [0-9a-f]{32}\\n$`,
      ),
    );
    // What the host signs: the challenge, with what desolate's reviewer says the push sends
    // (its pack and LFS objects: shared/approval.ts).
    const said = reviewerSays("issue/12", commit);
    assert.equal(said.ok, true, String(said.error));
    const signed = signedFor(challenge.message, {
      commit,
      squashes: null,
      pack: said.sends!.pack,
      lfs: said.sends!.lfs,
    });
    assert.deepEqual(
      said.sends!.lfs,
      { count: 1, bytes: 50000, digest: lfsDigest(lfsListed()) },
      "the reviewer counts the commit's LFS object, by the size its pointer says, and digests the list",
    );
    const own = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
    const forged = keyring({
      op: "approve",
      message: signed,
      signature: sign("sha256", Buffer.from(signed), own).toString("base64"),
    });
    assert.equal(forged.ok, false);
    assert.match(forged.error!, /signature is not the host approver's/);
    assert.equal(
      keyring({ op: "approve", message: signed, signature: "" }).ok,
      false,
      "no signature",
    );
    assert.equal(
      keyring({ op: "approve", repo: "acme/widgets", ref: "issue/12", commit }).ok,
      false,
      "v3's first protocol, with no signature at all",
    );
    //    Swapping in a key of its own: the installed key is root's alone to write.
    const swap = stack.inRoot([
      "bash",
      "-c",
      "echo x > /etc/desolate/approver.pub; echo x > /etc/desolate/other; sudo -n true; ls -ld /etc/desolate /etc/desolate/approver.pub",
    ]);
    assert.match(swap.stderr, /approver\.pub: Permission denied/);
    assert.match(swap.stdout, /^drwxr-xr-x \d+ root root .*\n-rw-r--r-- \d+ root root /);
    //    The write agent's own question ("is there an approval?") is not answerable from outside it.
    assert.notEqual(
      stack.inRoot([
        "bash",
        "-c",
        `echo '{"op":"consume","repo":"acme/widgets"}' | socat - UNIX-CONNECT:/run/desolate/keyring/internal.sock`,
      ]).code,
      0,
    );
    // 6. Reaching the write agent at all: its directory is the keyring's and the pusher's.
    const agent = stack.inRoot([
      "bash",
      "-c",
      "ls /run/desolate/keyring-write 2>&1; SSH_AUTH_SOCK=/run/desolate/keyring-write/write-agent.sock ssh-add -l 2>&1; ls -ld /run/desolate/keyring-write",
    ]);
    assert.match(
      agent.stdout,
      /cannot open directory '\/run\/desolate\/keyring-write': Permission denied/,
    );
    assert.match(agent.stdout, /Error connecting to agent: Permission denied/);
    assert.match(
      agent.stdout,
      /^drwxr-x--- \d+ desolate-keyring desolate-pusher /m,
      "control: it is there, and whose it is",
    );
    // 7. Asking the pusher to push with no approval, or with one made up.
    const pusher = (request: Record<string, unknown>) =>
      JSON.parse(
        stack.inRoot([
          "node",
          "--disable-warning=ExperimentalWarning",
          "--input-type=module",
          "-e",
          'import { ask } from "/desolate/release/root/keyring-client.ts"; console.log(JSON.stringify(await ask("/run/desolate/pusher/control.sock", JSON.parse(process.argv[1]), 30000)));',
          JSON.stringify(request),
        ]).stdout,
      ) as { ok: boolean; error?: string };
    const madeUp = pusher({ op: "push", approval: "lzz-000000000000", bundle: 0, lfs: [] });
    assert.equal(madeUp.ok, false);
    assert.match(madeUp.error!, /holds no live approval/);
    // The outcome: the remote has nothing, and the audit shows refusals and no signature.
    assert.equal(forgeRefs("acme/widgets")["issue/12"], undefined, "nothing reached the remote");
    assert.equal(forgeHasLfs("acme/widgets", oid), false, "nor its LFS object");
    const entries = audit();
    assert.ok(
      entries.some((e) => e.event === "refused" && e.repo === "acme/widgets"),
      "the write key's refused uses are audited",
    );
    assert.equal(
      entries.filter((e) => e.event === "signed" || e.event === "approved").length,
      0,
      "no approval was filed and nothing was signed",
    );
    // CONTROL: the same request, signed with the approver's key (which this test, being on
    // the host, can read: the terminal approver's documented limit), IS accepted. So the
    // refusals above are about whose key signed, not about the request being malformed.
    const hostKey = createPrivateKey(
      fs.readFileSync(path.join(stack.home, "approver", "key"), "utf8"),
    );
    const signedBy = (text: string) =>
      sign("sha256", Buffer.from(text), hostKey).toString("base64");
    const real = keyring({ op: "approve", message: signed, signature: signedBy(signed) });
    assert.equal(real.ok, true, String(real.error));
    // A signature approves once: replayed, the challenge is no longer outstanding.
    const replay = keyring({ op: "approve", message: signed, signature: signedBy(signed) });
    assert.equal(replay.ok, false);
    assert.match(replay.error!, /not outstanding/);
    // The audit's F6, with a real approval live: the root's user, as if a bug in what it
    // parses had given it to an attacker, hands the pusher that approval's id and a pack of
    // its own: the approved commit, and an object nothing refers to (bytes of its choosing,
    // which would stay in the repository's storage under the write key, #165), whole, and
    // then 32 bytes more: a first version of the pusher forwarded all but the last 32 bytes
    // before checking, and so sent this pack whole, which the forge took (found by an
    // independent review). The pusher takes the pack whole, and it is not the approved one:
    // nothing is sent, and the forge takes nothing.
    const before = forgeRefs("acme/widgets");
    const extra = inRootClone(
      `printf 'bytes the attacker chose\\n' | git hash-object -w --stdin`,
    ).stdout.trim();
    inRootClone(
      `(git rev-list --objects ${commit} --not --remotes=origin | cut -d' ' -f1; echo ${extra}) | git pack-objects --stdout --delta-base-offset --quiet > /tmp/own.pack && head -c 32 /dev/urandom >> /tmp/own.pack`,
    );
    const lfsFile = inRootClone(
      `ls .git/lfs/objects/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`,
    ).stdout.trim();
    const ownPack = toPusher(real.id!, "/tmp/own.pack", [], lfsListed());
    assert.equal(ownPack.ok, false);
    assert.match(ownPack.error!, /the pack is not the one approved .*nothing was pushed/);
    assert.deepEqual(forgeRefs("acme/widgets"), before, "no ref of the remote moved");
    assert.equal(
      forgeHas("acme/widgets", extra),
      false,
      "the object it added is nowhere in the forge's repository",
    );
    assert.equal(stack.forge("quarantine", "acme/widgets").trim(), "", "nor kept aside");
    assert.equal(audit().pop()?.event, "revoked", "and the approval it tried to use is spent");
    // An LFS object the approved commits do not point to, named in the list beside them: the
    // list's digest is not the approved one, and nothing goes up.
    const second = keyring({ op: "challenge", repo: "acme/widgets", ref: "issue/12", commit });
    const secondText = signedFor(second.message, {
      commit,
      squashes: null,
      pack: said.sends!.pack,
      lfs: said.sends!.lfs,
    });
    const approved2 = keyring({
      op: "approve",
      message: secondText,
      signature: signedBy(secondText),
    });
    assert.equal(approved2.ok, true, String(approved2.error));
    const planted = inRootClone(
      `printf 'an LFS object nothing points to\\n' > /tmp/planted && sha256sum /tmp/planted | cut -d' ' -f1`,
    ).stdout.trim();
    const reviewerPack = "/tmp/reviewer.pack";
    stack.inRoot([
      "node",
      "--disable-warning=ExperimentalWarning",
      "--input-type=module",
      "-e",
      `import { packFor } from "/desolate/release/root/review-client.ts"; await packFor({ owner: "acme", name: "widgets" }, process.argv[1], process.argv[2]);`,
      said.sends!.pack,
      reviewerPack,
    ]);
    const plantedLfs = toPusher(
      approved2.id!,
      reviewerPack,
      [
        { oid, file: `${ROOT_CLONE}/${lfsFile}` },
        { oid: planted, file: "/tmp/planted" },
      ],
      [...lfsListed(), `${planted} 32`],
    );
    assert.equal(plantedLfs.ok, false);
    assert.match(
      plantedLfs.error!,
      /the LFS objects listed are not the ones approved: nothing was pushed/,
    );
    assert.equal(
      forgeHasLfs("acme/widgets", planted),
      false,
      "the planted object is not on the forge",
    );
    assert.equal(forgeHasLfs("acme/widgets", oid), false, "nor the commit's own: nothing went up");
    assert.deepEqual(forgeRefs("acme/widgets"), before);
    // The list as approved, and an object sent that is not on it: the pusher checks each object
    // sent against the list, not only the list against the approval (the review of #169: the
    // case above is refused by the digest, and never reached this check).
    const fourth = keyring({ op: "challenge", repo: "acme/widgets", ref: "issue/12", commit });
    const fourthText = signedFor(fourth.message, {
      commit,
      squashes: null,
      pack: said.sends!.pack,
      lfs: said.sends!.lfs,
    });
    const approved4 = keyring({
      op: "approve",
      message: fourthText,
      signature: signedBy(fourthText),
    });
    assert.equal(approved4.ok, true, String(approved4.error));
    const unlisted = toPusher(
      approved4.id!,
      reviewerPack,
      [
        { oid, file: `${ROOT_CLONE}/${lfsFile}` },
        { oid: planted, file: "/tmp/planted" },
      ],
      lfsListed(),
    );
    assert.equal(unlisted.ok, false);
    assert.match(
      unlisted.error!,
      /an LFS object sent is not one the approved commits point to, of the size they say: nothing was pushed/,
    );
    assert.equal(
      forgeHasLfs("acme/widgets", planted),
      false,
      "the unlisted object is not on the forge",
    );
    assert.equal(forgeHasLfs("acme/widgets", oid), false, "nor the listed one: nothing went up");
    assert.deepEqual(forgeRefs("acme/widgets"), before);
    // CONTROL: the reviewer's own pack and the approved LFS object, under a third approval,
    // land. (Of a commit of its own, the same files on the same parent, on another branch: the
    // person's push below is still the first of the reviewed commit.)
    const controlCommit = inRootClone(
      `git -c user.name=control -c user.email=control@example.invalid commit-tree ${commit}^{tree} -p ${commit}^ -m control`,
    ).stdout.trim();
    const sentControl = stack.inRoot([
      "node",
      "--disable-warning=ExperimentalWarning",
      "--input-type=module",
      "-e",
      `import { submitForReview } from "/desolate/release/root/review-client.ts"; const why = await submitForReview({ owner: "acme", name: "widgets" }, process.argv[1]); if (why) { console.error(why); process.exit(1); }`,
      controlCommit,
    ]);
    assert.equal(sentControl.code, 0, sentControl.stderr);
    const saidControl = reviewerSays("f6-control", controlCommit);
    assert.equal(saidControl.ok, true, String(saidControl.error));
    const controlPack = "/tmp/control.pack";
    stack.inRoot([
      "node",
      "--disable-warning=ExperimentalWarning",
      "--input-type=module",
      "-e",
      `import { packFor } from "/desolate/release/root/review-client.ts"; await packFor({ owner: "acme", name: "widgets" }, process.argv[1], process.argv[2]);`,
      saidControl.sends!.pack,
      controlPack,
    ]);
    const third = keyring({
      op: "challenge",
      repo: "acme/widgets",
      ref: "f6-control",
      commit: controlCommit,
    });
    const thirdText = signedFor(third.message, {
      commit: controlCommit,
      squashes: null,
      pack: saidControl.sends!.pack,
      lfs: saidControl.sends!.lfs,
    });
    const approved3 = keyring({
      op: "approve",
      message: thirdText,
      signature: signedBy(thirdText),
    });
    assert.equal(approved3.ok, true, String(approved3.error));
    const control = toPusher(
      approved3.id!,
      controlPack,
      [{ oid, file: `${ROOT_CLONE}/${lfsFile}` }],
      lfsListed(),
    );
    assert.equal(control.ok, true, String(control.error));
    assert.equal(
      forgeRefs("acme/widgets")["f6-control"],
      controlCommit,
      "control: the approved pack lands",
    );
    // Once the pusher is done with it, the approval is gone: its claim was the pusher's
    // connection to the keyring, closed when the push ended. Handed over again (the control
    // is the push just above, which it allowed), it allows nothing.
    const reused = toPusher(
      approved3.id!,
      controlPack,
      [{ oid, file: `${ROOT_CLONE}/${lfsFile}` }],
      lfsListed(),
    );
    assert.equal(reused.ok, false);
    assert.match(String(reused.error), /holds no live approval/);
    assert.ok(
      (audit() as Record<string, unknown>[]).some(
        (e) =>
          e.event === "revoked" &&
          e.approval === approved3.id &&
          e.why === "the pusher is done with it",
      ),
      "the claim ended with the pusher's push",
    );
    assert.equal(forgeHasLfs("acme/widgets", oid), true, "with its LFS object");
    // CONTROL for the checks above that something is NOT on the forge: they see what is.
    assert.equal(
      forgeHas("acme/widgets", controlCommit),
      true,
      "control: the forge has the commit",
    );
    const controlBlob = inRootClone(`git rev-parse ${controlCommit}:README.md`).stdout.trim();
    assert.equal(forgeHas("acme/widgets", controlBlob), true, "control: and its blobs");
    // The pack goes as desolate's reviewer compressed it, not as the root's user did: an object
    // stored uncompressed (zlib's stored blocks) carries its bytes as they are, and a pack that
    // copied them would carry a channel of the root's user's choosing to the forge (the second
    // independent review; untested until the review of #169).
    const stored = inRootClone(
      [
        `blob=$(head -c 65536 /dev/zero | tr '\\0' A | git -c core.looseCompression=0 hash-object -w --stdin)`,
        `tree=$(printf '100644 blob %s\\tstored.txt\\n' "$blob" | git mktree)`,
        `c=$(git -c user.name=stored -c user.email=stored@example.invalid commit-tree "$tree" -p ${controlCommit} -m stored)`,
        // (Packed at level 0 by pack-objects itself: \`repack\` compressed it all the same.)
        `printf '%s\\n^%s\\n' "$c" ${controlCommit} | git -c pack.compression=0 pack-objects --revs -q .git/objects/pack/pack >/dev/null`,
        `git prune-packed`,
        `printf '%s\\n^%s\\n' "$c" ${controlCommit} | git pack-objects --stdout --revs --quiet > /tmp/reused.pack`,
        `echo "$c"`,
      ].join(" && "),
    );
    assert.equal(stored.code, 0, stored.stderr);
    const storedCommit = stored.stdout.trim().split("\n").pop()!;
    const sentStored = stack.inRoot([
      "node",
      "--disable-warning=ExperimentalWarning",
      "--input-type=module",
      "-e",
      `import { submitForReview } from "/desolate/release/root/review-client.ts"; const why = await submitForReview({ owner: "acme", name: "widgets" }, process.argv[1]); if (why) { console.error(why); process.exit(1); }`,
      storedCommit,
    ]);
    assert.equal(sentStored.code, 0, sentStored.stderr);
    const saidStored = reviewerSays("stored", storedCommit, null);
    assert.equal(saidStored.ok, true, String(saidStored.error));
    stack.inRoot([
      "node",
      "--disable-warning=ExperimentalWarning",
      "--input-type=module",
      "-e",
      `import { packFor } from "/desolate/release/root/review-client.ts"; await packFor({ owner: "acme", name: "widgets" }, process.argv[1], "/tmp/recompressed.pack");`,
      saidStored.sends!.pack,
    ]);
    const runOf = (file: string) =>
      stack
        .inRoot([
          "node",
          "-e",
          `console.log(require("node:fs").readFileSync(process.argv[1]).includes(Buffer.alloc(4096, "A")))`,
          file,
        ])
        .stdout.trim();
    assert.equal(
      runOf("/tmp/reused.pack"),
      "true",
      "control: a pack that reuses what the root's user stored carries its bytes as they are",
    );
    assert.equal(
      runOf("/tmp/recompressed.pack"),
      "false",
      "the reviewer's pack does not: it compressed the object itself",
    );
    // What a commit carries beyond its four headers is said, every pushed commit's; a file whose
    // name holds a newline is one file; an empty message is a commit of the squash; and each
    // commit's diff goes first to last (the review of #169 found each of these wrong).
    const chain = inRootClone(String.raw`set -e
base=${storedCommit}
secret=$(printf 'secret\n' | git hash-object -w --stdin)
t1=$( { git ls-tree -z "$base"; printf '100644 blob %s\tREADME.md\nkey.env\0' "$secret"; } | git mktree -z )
c1=$(git -c user.name=chain -c user.email=chain@example.invalid commit-tree "$t1" -p "$base" -F /dev/null)
c2=$(git -c user.name=chain -c user.email=chain@example.invalid commit-tree "$base^{tree}" -p "$c1" -m 'put back')
plain=$(git -c user.name=chain -c user.email=chain@example.invalid commit-tree "$base^{tree}" -p "$c2" -m 'with headers')
c3=$(git cat-file commit "$plain" | awk '/^committer /{print; print "encoding ISO-8859-1"; print "x-data a payload of the attacker"; print "gpgsig -----BEGIN PGP SIGNATURE-----"; print " AAAA"; print " -----END PGP SIGNATURE-----"; next} {print}' | git hash-object -t commit -w --stdin)
plain4=$(git -c user.name=chain -c user.email=chain@example.invalid commit-tree "$base^{tree}" -p "$c3" -m 'hidden')
c4=$(git cat-file commit "$plain4" | awk '/^committer /{print; print " a continuation of the committer"; print "committer a second, which fsck does not read"; next} {print}' | git hash-object -t commit -w --stdin)
echo "$c1 $c2 $c3 $c4"`);
    assert.equal(chain.code, 0, chain.stderr);
    const [c1, c2, c3, c4] = chain.stdout.trim().split("\n").pop()!.split(" ") as [
      string,
      string,
      string,
      string,
    ];
    const sentChain = stack.inRoot([
      "node",
      "--disable-warning=ExperimentalWarning",
      "--input-type=module",
      "-e",
      `import { submitForReview } from "/desolate/release/root/review-client.ts"; const why = await submitForReview({ owner: "acme", name: "widgets" }, process.argv[1]); if (why) { console.error(why); process.exit(1); }`,
      c4,
    ]);
    assert.equal(sentChain.code, 0, sentChain.stderr);
    const saidChain = reviewerSays("chain", c4);
    assert.equal(saidChain.ok, true, String(saidChain.error));
    const headers = (saidChain.warnings ?? []).find((w) => /carry headers/.test(w)) ?? "";
    assert.match(headers, /^2 commit\(s\) carry headers this page does not show/);
    assert.match(
      headers,
      new RegExp(
        `${c3.slice(0, 12)}: encoding "ISO-8859-1", x-data \\(\\d+ bytes\\), gpgsig \\(\\d+ bytes, a signature\\)`,
      ),
    );
    // A continuation of the committer line, and a second committer line: fsck reads neither,
    // so neither is git's own, whatever its name.
    assert.match(
      headers,
      new RegExp(
        `${c4.slice(0, 12)}: \\(a line with no name\\) \\(\\d+ bytes\\), committer \\(\\d+ bytes\\)`,
      ),
    );
    assert.equal(
      ((saidStored as { warnings?: string[] }).warnings ?? []).some((w) => /carry headers/.test(w)),
      false,
      "control: a commit with only git's four headers is not warned of",
    );
    // (The list has the earlier tests' files too: what matters is this one, whole.)
    const inBetween = saidChain.between?.items.map((f) => f.path) ?? [];
    assert.ok(inBetween.includes("README.md?key.env"), String(inBetween));
    assert.ok(
      !inBetween.includes("key.env") && !inBetween.includes("README.md"),
      `the file with a newline in its name is one file, not two: ${inBetween}`,
    );
    // Offered though git cannot read the last commit's committer (the line continuing it): the
    // squash names the author for both, and leaves the extra lines behind.
    // (A new branch squashes from where it leaves main: the two commits of the tests above
    // this one too.)
    assert.equal(saidChain.squash?.count, 6);
    assert.equal(saidChain.squash?.committer, "chain <chain@example.invalid>");
    assert.equal(
      saidChain.squash?.message,
      "hidden\n\nSquashed from 6 commits:\n- control\n- stored\n- (no message)\n- put back\n- with headers\n- hidden\n",
    );
    // The commits are listed first to last, and each one's own diff is its own: asked for by
    // the commit, it is that commit whole, and no other.
    const at = (id: string) => saidChain.commits?.items.findIndex((c) => c.commit === id) ?? -1;
    assert.ok(
      at(c1) >= 0 && at(c1) < at(c2) && at(c2) < at(c3) && at(c3) < at(c4),
      "each commit, first to last",
    );
    const ofC1 = reviewerDiff(saidChain.key!, { commit: c1 });
    assert.ok(ofC1.diff?.text.startsWith(`commit ${c1}\n`), JSON.stringify(ofC1));
    assert.ok(ofC1.diff?.text.includes("+secret"), "with its diff: the file it added");
    assert.ok(!ofC1.diff?.text.includes(`commit ${c2}`), "and not the next commit");
    assert.match(
      reviewerDiff(saidChain.key!, { commit: "0".repeat(40) }).error ?? "",
      /is not one of the commits this push sends/,
      "a commit that is not the push's is not shown",
    );
  });

  it("the reviewer's account: counted and paged, its diffs by file, by commit and in pages of bytes", () => {
    stack.step("the reviewer's account: paged, diffs on demand");
    // 105 commits, the last of which adds 120 files, one of over a MiB of diff, and one that
    // changes what runs (devcontainer.json, which git lists after big.txt).
    const made = inRootClone(String.raw`set -e
base=$(git rev-parse origin/main)
c=$base
for i in $(seq 1 104); do c=$(git -c user.name=many -c user.email=many@example.invalid commit-tree "$base^{tree}" -p "$c" -m "commit $i"); done
t=$( { git ls-tree "$base"; for i in $(seq -w 1 120); do printf '100644 blob %s\tf-%s.txt\n' "$(printf 'file %s\n' "$i" | git hash-object -w --stdin)" "$i"; done; printf '100644 blob %s\tbig.txt\n' "$(seq 1 200000 | git hash-object -w --stdin)"; printf '100644 blob %s\tdevcontainer.json\n' "$(echo '{}' | git hash-object -w --stdin)"; } | git mktree )
c=$(git -c user.name=many -c user.email=many@example.invalid commit-tree "$t" -p "$c" -m "commit 105")
echo "$c"`);
    assert.equal(made.code, 0, made.stderr);
    const many = made.stdout.trim().split("\n").pop()!;
    submitted(many);
    const said = reviewerSays("many", many);
    assert.equal(said.ok, true, String(said.error));
    // Counted, not cut: the first page, first commit first, and the true total.
    assert.equal(said.commits?.total, 105);
    assert.equal(said.commits?.items.length, 100);
    assert.equal(said.commits?.items[0]?.subject, "commit 1");
    const more = askReviewer({ op: "page", key: said.key, list: "commits", from: 100 }).at(-1) as {
      page?: { commits?: Listed<{ subject: string }> };
    };
    assert.deepEqual(more.page?.commits, {
      items: more.page?.commits?.items,
      total: 105,
      from: 100,
    });
    assert.deepEqual(
      more.page?.commits?.items.map((c) => c.subject),
      ["commit 101", "commit 102", "commit 103", "commit 104", "commit 105"],
      "the page past the first is the rest, in order",
    );
    assert.equal(said.files?.total, 122);
    assert.equal(said.files?.items.length, 100);
    // What changes what runs comes first, whatever git's order: the page and the terminal
    // show the first page (CONTROL below: git's own order has big.txt before it).
    assert.deepEqual(
      said.files?.items.slice(0, 2).map((f) => f.path),
      ["devcontainer.json", "big.txt"],
    );
    const files = askReviewer({ op: "page", key: said.key, list: "files", from: 100 }).at(-1) as {
      page?: { files?: Listed<{ path: string }> };
    };
    assert.equal(files.page?.files?.items.length, 22);
    assert.equal(
      new Set([...said.files!.items, ...files.page!.files!.items].map((f) => f.path)).size,
      122,
      "the two pages are every file once",
    );
    // A file's diff is that file's (CONTROL: the net change has both).
    const one = reviewerDiff(said.key!, { file: "f-007.txt" });
    assert.ok(one.diff?.text.includes("+file 007"), JSON.stringify(one));
    assert.ok(!one.diff?.text.includes("f-008.txt"), "and no other file's");
    assert.equal(one.diff?.next, null);
    // The net change, in pages of bytes: each ends a line, each starts where the last said,
    // and together they are the whole diff, every byte of it.
    const pages = [reviewerDiff(said.key!, "net")];
    while (pages.at(-1)?.diff?.next != null && pages.length < 10)
      pages.push(reviewerDiff(said.key!, "net", pages.at(-1)!.diff!.next!));
    assert.ok(pages.length >= 2, `a diff over a MiB is more than one page: ${pages.length}`);
    const total = pages[0]!.diff!.total;
    let at = 0;
    for (const p of pages) {
      assert.equal(p.diff?.from, at);
      assert.ok(Buffer.byteLength(p.diff!.text) <= 1024 * 1024);
      at += Buffer.byteLength(p.diff!.text);
      if (p.diff!.next !== null) assert.ok(p.diff!.text.endsWith("\n"), "a page ends a line");
    }
    assert.equal(at, total, "the pages are the whole diff");
    const all = pages.map((p) => p.diff!.text).join("");
    assert.ok(all.includes("+file 007") && all.includes("+file 008") && all.includes("+200000\n"));
    // CONTROL for the order of the files above: git's own puts big.txt first.
    assert.ok(all.indexOf("b/big.txt\n") < all.indexOf("b/devcontainer.json\n"));
    // A commit git shows only in part (a NUL in its message, past which git log prints
    // nothing) is refused before the reviewer takes any of it: what follows the NUL would ride
    // in the pack unseen. (CONTROL: the commits above, sent the same way, were taken.)
    const hidden = inRootClone(
      String.raw`printf 'tree %s\nparent %s\nauthor a <a@example.invalid> 1700000000 +0000\ncommitter a <a@example.invalid> 1700000000 +0000\n\nvisible\n\0hidden payload\n' "$(git rev-parse origin/main^{tree})" "$(git rev-parse origin/main)" | git hash-object -t commit --literally -w --stdin`,
    );
    assert.equal(hidden.code, 0, hidden.stderr);
    const refused = stack.inRoot([
      "node",
      "--disable-warning=ExperimentalWarning",
      "--input-type=module",
      "-e",
      `import { submitForReview } from "/desolate/release/root/review-client.ts"; const why = await submitForReview({ owner: "acme", name: "widgets" }, process.argv[1]); console.log(why ?? "taken");`,
      hidden.stdout.trim(),
    ]);
    assert.match(
      refused.stdout,
      /^the bundle's objects are refused: .*nul/im,
      refused.stdout + refused.stderr,
    );
  });

  it("the reviewer's account takes as long as it takes, says so, waits its turn, and ends when its asker goes", () => {
    stack.step("the reviewer's account: no deadline");
    const fresh = (name: string) =>
      inRootClone(
        `git -c user.name=slow -c user.email=slow@example.invalid commit-tree origin/main^{tree} -p origin/main -m '${name}'`,
      ).stdout.trim();
    const [a, b] = [fresh("slow a"), fresh("slow b")];
    submitted(a);
    submitted(b);
    const ask = (branch: string, commit: string) =>
      JSON.stringify({ op: "account", repo: "acme/widgets", branch, commit, onto: null });
    // Packing made slow: the reviewer's first pack-objects after the mark is set waits 20 s
    // first, four of its 5 s beats. (The 95 s that used to kill an account is gone: nothing on
    // the account's path has a deadline now, root/reviewer.ts. What is tried here is that a
    // slow one says so, waits its turn, and ends with its asker.)
    const ran = stack.inRoot(
      [
        "bash",
        "-c",
        String.raw`set -e
[ ! -e /usr/local/bin/git ]
trap 'rm -f /usr/local/bin/git; rm -rf /tmp/slowpack' EXIT
cat > /usr/local/bin/git <<'W'
#!/bin/sh
if [ "$(id -un)" = desolate-reviewer ]; then case " $* " in *" pack-objects "*) rm /tmp/slowpack/once 2>/dev/null && sleep 20;; esac; fi
exec /usr/bin/git "$@"
W
chmod 755 /usr/local/bin/git
mkdir -p /tmp/slowpack && chmod 777 /tmp/slowpack && touch /tmp/slowpack/once
ask() { node --disable-warning=ExperimentalWarning /desolate/release/root/review-ask.ts; }
count() { pgrep -u desolate-reviewer -fc "$1" || true; }
# Its asker goes away while it packs: read until it says so, then stop reading. (In the
# background: a pipeline is waited for until review-ask, last, has ended.)
rm -f /tmp/gone
{ printf '%s\n' "$1" | ask | { grep -m1 -q '"packing the push"'; touch /tmp/gone; }; } &
until [ -e /tmp/gone ]; do sleep 0.2; done
sleep 1
echo "during $(count 'sleep 20') $(count 'reviewer.ts account')"
# Gone within a beat and the asker's grace (review-ask.ts): looked for up to 12 s.
for _ in $(seq 1 48); do [ "$(count 'sleep 20') $(count 'reviewer.ts account')" = "0 0" ] && break; sleep 0.25; done
echo "after $(count 'sleep 20') $(count 'reviewer.ts account')"
wait
# Asked again and read to the end; and another account asked for meanwhile, which waits.
touch /tmp/slowpack/once
start=$(date +%s)
printf '%s\n' "$1" | ask > /tmp/slow.lines &
sleep 3
printf '%s\n' "$2" | ask > /tmp/waits.lines
wait
echo "took $(( $(date +%s) - start ))"
echo "=====slow"; cat /tmp/slow.lines
echo "=====waits"; cat /tmp/waits.lines`,
        "_",
        ask("slow-a", a),
        ask("slow-b", b),
      ],
      { root: true },
    );
    assert.equal(ran.code, 0, ran.stdout + ran.stderr);
    const [head, slowText, waitsText] = ran.stdout.split(/^=====\w+\n/m) as [
      string,
      string,
      string,
    ];
    // CONTROL: while it packed, its processes were there to be seen; once its asker had
    // gone, none of them is.
    assert.match(head, /^during [1-9]\d* [1-9]\d*$/m, head);
    assert.match(head, /^after 0 0$/m, "nothing the account started outlives its asker");
    const took = Number(/^took (\d+)$/m.exec(head)?.[1]);
    assert.ok(took >= 20, `the account took ${took} s`);
    const lines = (text: string) =>
      text
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, { phase?: string } | object>);
    const slow = lines(slowText);
    const waits = lines(waitsText);
    assert.ok("account" in slow.at(-1)!, slowText.slice(-500));
    const saying = slow.filter(
      (l) => "progress" in l && (l.progress as { phase: string }).phase === "packing the push",
    );
    assert.ok(
      saying.length >= 3,
      `it says what it is doing while it packs: ${saying.length} times`,
    );
    assert.ok("account" in waits.at(-1)!, waitsText.slice(-500));
    assert.ok(
      waits.some(
        (l) =>
          "progress" in l &&
          (l.progress as { phase: string }).phase === "waiting for another push's account",
      ),
      "the other account says it waits its turn",
    );
  });

  it("refusals that need no person: --expect, the default branch, a terminal answer that is not the branch", () => {
    stack.step("refusals before and at the prompt");
    const moved = stack.desolate(
      "push",
      "dev",
      "acme/widgets",
      "issue/12",
      "--expect",
      "0".repeat(40),
    );
    assert.equal(moved.code, 79);
    assert.match(moved.stderr, /it moved since/);
    const none = stack.desolate("push", "dev", "acme/widgets", "issue/12");
    assert.equal(none.code, 64);
    const main = JSON.parse(
      stack.quiet("review", "dev", "acme/widgets", "main", "--json").stdout,
    ) as { commit: string };
    // The default branch is pushed like any other (2026-11-18): not refused for being it. (Here
    // it has nothing the remote lacks, which is what stops it.)
    const def = stack.desolate("push", "dev", "acme/widgets", "main", "--expect", main.commit);
    assert.notEqual(def.code, 77);
    assert.doesNotMatch(def.stderr, /default branch/);
    const wrong = stack.person(
      "Type the branch name",
      "yes",
      "push",
      "dev",
      "acme/widgets",
      "issue/12",
      "--expect",
      commit,
    );
    assert.equal(wrong.code, 78, "a 'yes' is not the branch name");
    assert.equal(forgeRefs("acme/widgets")["issue/12"], undefined);
  });

  it("a person pushes: the prompt names repository, branch and commit; LFS objects go first", () => {
    stack.step("a person pushes");
    const pushed = stack.person(
      "Type the branch name",
      "issue/12",
      "push",
      "dev",
      "acme/widgets",
      "issue/12",
      "--expect",
      commit,
    );
    assert.equal(pushed.code, 0, pushed.stdout);
    assert.match(
      pushed.stdout,
      /this push needs your confirmation\.\s+repository {2}acme\/widgets\s+branch {6}issue\/12\s+commit {6}[0-9a-f]{40}/,
    );
    assert.match(
      pushed.stdout,
      /pushed acme\/widgets issue\/12 at [0-9a-f]{40} \(1 commit\(s\), 1 LFS object\(s\) first\)/,
    );
    assert.equal(
      forgeRefs("acme/widgets")["issue/12"],
      commit,
      "the remote has exactly the reviewed commit",
    );
    assert.equal(forgeHasLfs("acme/widgets", oid), true, "the remote serves the new LFS object");
    const access = JSON.parse(stack.forge("access")) as {
      key?: string;
      command?: string;
      lfs?: string;
    }[];
    // (The last of each: the refused attempt above also reached receive-pack.)
    const upload = access.map((e) => e.lfs === "upload").lastIndexOf(true);
    const receive = access.map((e) => /git-receive-pack/.test(e.command ?? "")).lastIndexOf(true);
    assert.ok(
      upload >= 0 && receive > upload,
      "the LFS object was uploaded before the commit was pushed",
    );
    assert.ok(
      access
        .filter((e) => /receive-pack|upload$/.test(e.command ?? ""))
        .every((e) => e.key === "write:acme/widgets"),
      "writes used the write key",
    );
    const entries = audit();
    const approved = entries.filter((e) => e.event === "approved").pop();
    assert.deepEqual(
      [approved?.repo, approved?.ref, approved?.commit],
      ["acme/widgets", "issue/12", commit],
      "the approval names what was pushed",
    );
    assert.ok(
      entries.some((e) => e.event === "signed"),
      "each use of the write key is audited",
    );
    assert.ok(
      entries.some((e) => e.event === "revoked"),
      "the approval did not outlive the push",
    );
    assert.doesNotMatch(
      stack.desolate("offers").stdout,
      /issue\/12/,
      "the offer is no longer waiting",
    );
    // The mirror followed: every clone's origin/* now has the branch.
    assert.equal(
      inWs(
        "dev/w1",
        "cd /workspaces/acme/widgets && git fetch -q origin && git rev-parse origin/issue/12",
      ).stdout.trim(),
      commit,
    );
    // And the approval is spent: the same push again, by a script, is refused.
    assert.notEqual(
      inRootClone(
        `git push --no-verify "$(git config lfs.pushurl)" ${commit}:refs/heads/again 2>&1`,
      ).code,
      0,
    );
    assert.equal(forgeRefs("acme/widgets")["again"], undefined);
  });

  it("two commits, a file added and taken out again: the approval says so; squashed, the history has none of it; a replace waits for --replace", () => {
    stack.step("a squashed push, then a replace");
    const SQ = "/workspaces/acme/widgets/.worktrees/squash-me";
    const made = inWs(
      "dev/w1",
      `cd /workspaces/acme/widgets && git fetch -q origin && git worktree add -q ${SQ} -b squash-me origin/main && cd ${SQ} && echo 'not for the remote' > notes.txt && git add notes.txt && git commit -qm 'add notes' && git rev-parse HEAD:notes.txt && git rm -q notes.txt && echo 'squashed' >> README.md && git commit -qam 'tidy up' && git rev-parse HEAD && desolate offer >/dev/null`,
    );
    assert.equal(made.code, 0, made.stdout + made.stderr);
    const [notes, tip] = made.stdout.trim().split("\n") as [string, string];
    // (The reviewer is sent a branch when a push of it is prepared; here, before, as a push
    // would send it, to read what it says.)
    const sent = stack.inRoot([
      "node",
      "--disable-warning=ExperimentalWarning",
      "--input-type=module",
      "-e",
      `import { submitForReview } from "/desolate/release/root/review-client.ts"; const why = await submitForReview({ owner: "acme", name: "widgets" }, process.argv[1]); if (why) { console.error(why); process.exit(1); }`,
      tip,
    ]);
    assert.equal(sent.code, 0, sent.stderr);
    // What the net change hides, the reviewer lists: notes.txt was added, then taken out.
    const said = reviewerSays("squash-me", tip);
    assert.equal(said.ok, true, String(said.error));
    assert.deepEqual(
      said.files?.items.map((f) => f.path),
      ["README.md"],
      "the net change: README alone",
    );
    assert.deepEqual(
      said.between?.items.map((f) => f.path),
      ["notes.txt"],
      "and what was changed in between",
    );
    assert.equal(said.squash?.count, 2);
    assert.equal(
      said.squash?.message,
      "tidy up\n\nSquashed from 2 commits:\n- add notes\n- tidy up\n",
    );
    // Squashed: one commit, the tip's tree, on main; the file in between is nowhere on the forge.
    const squashed = stack.person(
      "Type the branch name",
      "squash-me",
      "push",
      "dev",
      "acme/widgets",
      "squash-me",
      "--expect",
      tip,
      "--squash",
    );
    assert.equal(squashed.code, 0, squashed.stdout);
    assert.match(squashed.stdout, new RegExp(`squashes {4}${tip}`));
    assert.match(
      squashed.stdout,
      /2 commit\(s\) squashed into one\.\ndesolate \(on the Mac\): the workspace's squash-me still has the commits that were squashed/,
    );
    assert.ok(
      squashed.stdout.includes(
        `  git fetch && git rebase --rebase-merges --autostash --onto origin/squash-me ${tip} squash-me\n`,
      ),
      squashed.stdout,
    );
    const remote = forgeRefs("acme/widgets")["squash-me"];
    assert.equal(remote, said.squash?.commit, "the remote has the reviewer's squash");
    assert.equal(
      inRootClone(
        `git fetch -q origin; [ "$(git rev-parse origin/squash-me^{tree})" = "$(git rev-parse ${tip}^{tree})" ] && git rev-list --count origin/main..origin/squash-me`,
      ).stdout.trim(),
      "1",
      "its tree is the tip's, one commit on main",
    );
    assert.equal(forgeHas("acme/widgets", notes), false, "notes.txt never reached the remote");
    const approved = audit()
      .filter((e) => e.event === "approved")
      .pop() as { commit?: string; squashes?: string } | undefined;
    assert.deepEqual([approved?.commit, approved?.squashes], [remote, tip]);
    // The workspace's branch keeps its two commits: pushed as they are now, it would replace
    // the remote's. That is refused unless asked for.
    const unasked = stack.desolate("push", "dev", "acme/widgets", "squash-me", "--expect", tip);
    assert.notEqual(unasked.code, 0);
    assert.match(
      unasked.stderr,
      /this push REPLACES the remote's squash-me, which is the squash of/,
    );
    assert.match(unasked.stderr, /--replace/);
    assert.equal(forgeRefs("acme/widgets")["squash-me"], remote, "nothing was signed or pushed");
    // The command it names catches the branch up: run in the workspace, with a commit made
    // since and an edit not committed, the branch is that commit on the squash, the edit still
    // there; pushed, it builds on the remote's, with no --replace.
    const catchUp = /run `(git fetch && git rebase [^`]+)` in the workspace/.exec(
      unasked.stderr,
    )?.[1];
    assert.equal(
      catchUp,
      `git fetch && git rebase --rebase-merges --autostash --onto origin/squash-me ${tip} squash-me`,
    );
    const caught = inWs(
      "dev/w1",
      `cd ${SQ} && echo 'after the squash' >> README.md && git commit -qam 'carry on' && echo 'not yet' >> README.md && { ${catchUp}; } >/dev/null 2>&1 && git rev-parse HEAD HEAD^ && git rev-list --count origin/squash-me..HEAD && git diff --stat | tail -1 && git checkout -q -- README.md && desolate offer >/dev/null`,
    );
    assert.equal(caught.code, 0, caught.stdout + caught.stderr);
    const [next, onSquash, ahead, edit] = caught.stdout.trim().split("\n");
    assert.equal(onSquash, remote, "the commit made since is on the squash");
    assert.equal(ahead, "1", "and only it: the squashed commits are gone");
    assert.match(edit ?? "", /1 file changed/, "the edit not committed was put back");
    const onward = stack.person(
      "Type the branch name",
      "squash-me",
      "push",
      "dev",
      "acme/widgets",
      "squash-me",
      "--expect",
      next!,
    );
    assert.equal(onward.code, 0, onward.stdout);
    assert.doesNotMatch(onward.stdout, /REPLACES/);
    assert.equal(forgeRefs("acme/widgets")["squash-me"], next, "built on the squash, no replace");
    // Back to the two commits, for the replace: the remote's is no squash of them now, so the
    // refusal is the plain one.
    const back = inWs(
      "dev/w1",
      `cd ${SQ} && git reset -q --hard ${tip} && desolate offer >/dev/null`,
    );
    assert.equal(back.code, 0, back.stdout + back.stderr);
    const plain = stack.desolate("push", "dev", "acme/widgets", "squash-me", "--expect", tip);
    assert.notEqual(plain.code, 0);
    assert.match(
      plain.stderr,
      /this push REPLACES the remote's squash-me: it does not build on it/,
    );
    // Asked for, the prompt wants `replace <branch>`: the branch's name alone is not that.
    const nameOnly = stack.person(
      "Type 'replace squash-me'",
      "squash-me",
      "push",
      "dev",
      "acme/widgets",
      "squash-me",
      "--expect",
      tip,
      "--replace",
    );
    assert.equal(nameOnly.code, 78, nameOnly.stdout);
    assert.match(nameOnly.stdout, /REPLACES {4}the remote's squash-me/);
    assert.equal(forgeRefs("acme/widgets")["squash-me"], next);
    const replaced = stack.person(
      "Type 'replace squash-me'",
      "replace squash-me",
      "push",
      "dev",
      "acme/widgets",
      "squash-me",
      "--expect",
      tip,
      "--replace",
    );
    assert.equal(replaced.code, 0, replaced.stdout);
    assert.equal(forgeRefs("acme/widgets")["squash-me"], tip, "control: replaced, as asked");
  });

  it("a raw git push in the root's terminal waits for `desolate approve` on the host", async () => {
    stack.step("a raw git push, approved on the host");
    assert.match(stack.desolate("approve").stdout, /nothing is waiting for approval/);
    // The person's `git push` in the root shell, left running as it would be in their terminal.
    inRootClone(
      `setsid nohup git push origin ${commit}:refs/heads/raw-push >/tmp/raw-push.log 2>&1 </dev/null & sleep 0.2`,
    );
    let waiting = false;
    for (let i = 0; i < 40 && !waiting; i++) {
      waiting = /waiting for it for as long as this push waits/.test(
        inRootClone("cat /tmp/raw-push.log").stdout,
      );
      if (!waiting) await sleep(250);
    }
    assert.ok(waiting, "the push is waiting for the host");
    // A script on the host cannot answer it either: no terminal.
    assert.equal(stack.desolate("approve").code, 78);
    assert.equal(forgeRefs("acme/widgets")["raw-push"], undefined);
    const approved = stack.person("Type the branch name", "raw-push", "approve");
    assert.equal(approved.code, 0, approved.stdout);
    assert.match(
      approved.stdout,
      /repository {2}acme\/widgets\s+branch {6}raw-push\s+commit {6}[0-9a-f]{40}\s+onto {8}none: the remote has no raw-push yet\s+pack {8}[0-9a-f]{12}, [0-9.]+ (KiB|MiB) {2}\(made by desolate's reviewer: nothing else is sent\)\s+LFS {9}\d+ object\(s\), only those its commits point to\s+sends {7}\d+ commit\(s\) the remote does not have, \d+ file\(s\)(, \d+ LFS object\(s\) with them)?\s+\(desolate's reviewer, in the root\)/,
      "the reviewer's account, not the root's ordinary user's",
    );
    let landed = false;
    for (let i = 0; i < 80 && !landed; i++) {
      landed = forgeRefs("acme/widgets")["raw-push"] === commit;
      if (!landed) await sleep(250);
    }
    assert.ok(landed, inRootClone("cat /tmp/raw-push.log").stdout);
    const entries = audit();
    const last = entries.filter((e) => e.event === "approved").pop();
    assert.deepEqual([last?.repo, last?.ref, last?.commit], ["acme/widgets", "raw-push", commit]);
    assert.equal(entries.pop()?.event, "revoked", "the approval did not outlive the push");
    // The default branch is pushed this way too, and waits for the person like any branch
    // (since 2026-11-18; unanswered here, so nothing goes); nothing is ever deleted.
    const def = await rawPushWaiting(`${commit}:refs/heads/main`, "main-push");
    assert.doesNotMatch(def.said(), /default branch/);
    assert.match(def.said(), /this push needs your approval[\s\S]*acme\/widgets {2}main/);
    // It waits for as long as its asker does, and no longer: stopped (its terminal closed),
    // its request goes from the host's list, and the keyring will not take an answer to it,
    // even one signed with the approver's key. (Control: while it waited, the keyring held it,
    // refusing an answer only for its signature.)
    const request = JSON.parse(
      stack.inRoot(["bash", "-c", "cat /var/lib/desolate/approvals/*.json"]).stdout,
    ) as { message: string };
    // (What it says it sends is not what is looked at here: the challenge is.)
    const text = signedFor(request.message, {
      commit,
      squashes: null,
      pack: "e".repeat(64),
      lfs: { count: 0, digest: "0".repeat(64) },
    });
    assert.match(
      String(keyring({ op: "approve", message: text, signature: "" }).error),
      /signature is not the host approver's/,
      "control: outstanding while its asker waits",
    );
    const killedDef = def.stop();
    assert.ok(
      await nothingWaits(),
      `stopped, it is no longer listed on the host\n${killedDef}\n${def.ps()}\n${def.said()}`,
    );
    const hostKey = createPrivateKey(
      fs.readFileSync(path.join(stack.home, "approver", "key"), "utf8"),
    );
    const late = keyring({
      op: "approve",
      message: text,
      signature: sign("sha256", Buffer.from(text), hostKey).toString("base64"),
    });
    assert.equal(late.ok, false);
    assert.match(String(late.error), /not outstanding/);
    assert.notEqual(forgeRefs("acme/widgets")["main"], commit, "unapproved: not pushed");
    assert.match(
      inRootClone("git push origin :refs/heads/raw-push 2>&1").stdout,
      /deleting a branch on the remote is not something desolate does/,
    );
    assert.equal(forgeRefs("acme/widgets")["raw-push"], commit);
  });

  it("the approval page: a raw push, described by the reviewer, approved with one click; another refused", async () => {
    stack.step("a raw git push, approved on the approval page");
    const address =
      /approvals {4}(http:\/\/desolate-approve\.localhost:(\d+)\/\?tkn=[0-9a-f]{48})/.exec(
        stack.desolate("approve", "--web").stdout,
      );
    assert.ok(address, "the page's address");
    const port = Number(address![2]);
    const ORIGIN = `http://desolate-approve.localhost:${port}`;
    const call = (
      method: string,
      url: string,
      headers: Record<string, string>,
      body?: string,
    ): Promise<{ status: number; headers: Record<string, unknown>; body: string }> =>
      new Promise((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port,
            method,
            path: url,
            headers: { host: `desolate-approve.localhost:${port}`, ...headers },
          },
          (res) => {
            let text = "";
            res.on("data", (chunk) => (text += chunk));
            res.on("end", () =>
              resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }),
            );
          },
        );
        req.on("error", reject);
        req.end(body);
      });
    const at = new URL(address![1]!);
    const login = await call("GET", at.pathname + at.search, {});
    // The cookie, and the page key its sign-in page carries (shared/page-key.ts).
    assert.equal(login.status, 200);
    const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
    const key = /<meta name="desolate-key" content="([0-9a-f]{64})">/.exec(login.body)![1]!;
    const asPage = { cookie, "x-desolate-key": key, "sec-fetch-site": "same-origin" };
    type Waiting = {
      nonce: string;
      token: string;
      branch: string;
      commit: string;
      onto: string | null;
      /** The token over the account the page was given: a click names it. */
      shown?: string;
      review: {
        working?: { phase: string };
        error?: string;
        account?: {
          commits: { items: { commit: string; subject: string }[]; total: number };
          files: { items: { path: string }[]; total: number };
        };
      };
    };
    const waitingFor = async (branch: string) => {
      for (let i = 0; i < 120; i++) {
        const answer = await call("GET", "/pending", asPage);
        const found = (JSON.parse(answer.body) as { pending?: Waiting[] }).pending?.find(
          (p) => p.branch === branch,
        );
        // (The reviewer's account comes in the background: the page says it is coming.)
        if (found && !found.review.working) return found;
        await sleep(250);
      }
      return null;
    };
    const act = (what: string, push: Waiting) =>
      call(
        "POST",
        `/${what}`,
        { ...asPage, origin: ORIGIN, "content-type": "application/json" },
        JSON.stringify({
          nonce: push.nonce,
          token: push.token,
          shown: push.shown,
          commit: push.commit,
        }),
      );

    inRootClone(
      `setsid nohup git push origin ${commit}:refs/heads/web-push >/tmp/web-push.log 2>&1 </dev/null & sleep 0.2`,
    );
    const push = await waitingFor("web-push");
    assert.ok(push, inRootClone("cat /tmp/web-push.log").stdout);
    assert.equal(push!.commit, commit);
    assert.equal(push!.onto, null, "a new branch");
    // What the reviewer says the push is: from commit ids the host gave it, and the forge.
    assert.ok(push!.review.account, String(push!.review.error));
    // The commit reached the remote above (issue/12): nothing new to list, from the forge's
    // own account; the files are against the remote's default branch.
    assert.deepEqual(
      push!.review.account!.commits.items,
      [],
      "the remote has every commit already, and the reviewer says so",
    );
    assert.ok(
      push!.review.account!.files.items.some((f) => f.path === "big.bin" || f.path === "README.md"),
      "the files it changes against the default branch",
    );
    // In a real browser: the card is drawn as text, and Approve waits for a person.
    const chrome = findChrome();
    assert.ok(
      chrome,
      "this check needs Chrome or Chromium: install one, or set DESOLATE_CHROME to its path",
    );
    const profile = fs.mkdtempSync(path.join(stack.work, "chrome-"));
    const dom = await loadPage(chrome, profile, address![1]!, {
      until: /<dd class="branch">web-push<\/dd>/,
    });
    assert.match(dom.stdout, /<dd class="branch">web-push<\/dd>/, dom.stdout.slice(0, 600));
    assert.match(
      dom.stdout,
      /<button type="button" class="approve" disabled="">Approve push<\/button>/,
      "Approve is not armed by loading the page",
    );
    assert.equal(
      forgeRefs("acme/widgets")["web-push"],
      undefined,
      "and loading it approved nothing",
    );
    // Not from another origin, and not without the push's own token.
    assert.equal(
      (
        await call(
          "POST",
          "/approve",
          {
            ...asPage,
            origin: "http://dev-w1-abc123.localhost:1",
            "content-type": "application/json",
          },
          JSON.stringify({ nonce: push!.nonce, token: push!.token, commit }),
        )
      ).status,
      403,
    );
    assert.equal(forgeRefs("acme/widgets")["web-push"], undefined);
    const approved = await act("approve", push!);
    assert.equal(approved.status, 200, approved.body);
    let landed = false;
    for (let i = 0; i < 80 && !landed; i++) {
      landed = forgeRefs("acme/widgets")["web-push"] === commit;
      if (!landed) await sleep(250);
    }
    assert.ok(landed, inRootClone("cat /tmp/web-push.log").stdout);
    // And the host heard the pusher say so, though no page was open between these asks (the
    // daemon read the pusher's log from where it left it: it once started at the log's end
    // and lost this word, under load).
    let heard = false;
    for (let i = 0; i < 80 && !heard; i++) {
      const told = JSON.parse((await call("GET", "/pending", asPage)).body) as {
        approved: { token: string; pushed: boolean }[];
      };
      heard = told.approved.some((a) => a.token === push!.token && a.pushed);
      if (!heard) await sleep(250);
    }
    assert.ok(heard, "the pusher's word on it, heard");

    // Refused on the page: the push that asked gives up, and nothing reaches the remote.
    inRootClone(
      `setsid nohup git push origin ${commit}:refs/heads/web-refused >/tmp/web-refused.log 2>&1 </dev/null & sleep 0.2`,
    );
    const other = await waitingFor("web-refused");
    assert.ok(other);
    assert.equal((await act("refuse", other!)).status, 200);
    let gaveUp = false;
    for (let i = 0; i < 40 && !gaveUp; i++) {
      gaveUp = /refused on the host, so nothing was pushed/.test(
        inRootClone("cat /tmp/web-refused.log").stdout,
      );
      if (!gaveUp) await sleep(250);
    }
    assert.ok(gaveUp, inRootClone("cat /tmp/web-refused.log").stdout);
    assert.equal(forgeRefs("acme/widgets")["web-refused"], undefined);

    // A large text diff (as a first push with a lockfile is): the reviewer's account is far
    // bigger than a pipe's buffer, and still reaches the page whole. (It once ended at
    // 146,175 bytes, cut by process.exit, and the page said the reviewer could not be asked.)
    const big = inRootClone(
      `git checkout -q --detach ${commit} && seq 1 40000 | sed 's/^/a line of a large generated file, number /' > large.txt && git add large.txt && git -c user.name=t -c user.email=t@example.invalid commit -qm "a large file" && git rev-parse HEAD && git checkout -q -`,
    );
    const bigCommit = big.stdout.trim().split("\n").pop()!;
    inRootClone(
      `setsid nohup git push origin ${bigCommit}:refs/heads/web-large >/tmp/web-large.log 2>&1 </dev/null & sleep 0.2`,
    );
    const large = await waitingFor("web-large");
    assert.ok(large, inRootClone("cat /tmp/web-large.log").stdout);
    assert.ok(large!.review.account, String(large!.review.error));
    assert.deepEqual(
      large!.review.account!.commits.items.map((c) => c.subject),
      ["a large file"],
    );
    assert.equal((await act("refuse", large!)).status, 200);
  });

  it("the approval page by a person's pointer: the tab's push is marked, Approve arms under a pointer at rest once the page stands still, the card says it is being pushed, and goes when it landed", async (t) => {
    stack.step("the approval page, by a person's pointer");
    const address = /approvals {4}(http:\S+)/.exec(stack.desolate("approve", "--web").stdout)![1]!;
    const origin = new URL(address).origin;
    inRootClone(
      `setsid nohup git push origin ${commit}:refs/heads/web-pointer >/tmp/web-pointer.log 2>&1 </dev/null & sleep 0.2`,
    );
    const chrome = findChrome();
    assert.ok(chrome, "this check needs Chrome or Chromium");
    const browser = await openBrowser(chrome, fs.mkdtempSync(path.join(stack.work, "chrome-")));
    try {
      const page = await browser.tab(address);
      const opened = async (named: string) => {
        await page.goto("about:blank");
        await page.goto(`${origin}/#repo=acme%2Fwidgets&branch=web-pointer&commit=${named}`);
        await page.until(
          "[...document.querySelectorAll('.card')].some((c) => c.querySelector('.branch')?.textContent === 'web-pointer' && c.querySelector('button.approve') && !c.innerText.includes('working out'))",
          "the push's card, its account shown",
        );
        return page.evaluate<string[]>(
          "[...document.querySelectorAll('.card.asked .branch')].map((e) => e.textContent)",
        );
      };
      // The tab's address names the push it was opened for: another commit marks nothing (the
      // control); its own marks its card alone, which then signs just what it shows.
      assert.deepEqual(await opened("0".repeat(40)), []);
      assert.deepEqual(await opened(commit), ["web-pointer"]);
      // (The driver centres what it clicks, and a sticky bar is never centred, so it would
      // scroll the page at each click. A person's pointer does not.)
      await page.evaluate("Element.prototype.scrollIntoView = function () {}");
      await sleep(1500);
      const card = "document.querySelector('.card.asked')";
      const bar = () => page.evaluate<number>(`${card}.querySelector('.actions').offsetHeight`);
      const before = await bar();
      // A click as the pointer arrives is said, not taken: it has not been over Approve a second.
      // (From elsewhere on the card first: only a pointer that came to Approve arms it.)
      // (Timed by the page: from the pointer's arrival over Approve to its press.)
      await page.click(".card.asked .onto");
      await page.evaluate(
        `(() => { const w = ${card}.querySelector('button.approve').parentElement; window.arrivedAt = 0; w.addEventListener('pointermove', () => { window.arrivedAt ||= performance.now(); }); window.addEventListener('pointerdown', () => { window.pressedAt = performance.now(); }, { capture: true }); return true; })()`,
      );
      await page.click(".card.asked button.approve", "Approve push", { atOnce: true });
      const took = await page.evaluate<number>("window.pressedAt - window.arrivedAt");
      assert.ok(took < 1000, `the press came ${took} ms after the pointer arrived: not at once`);
      assert.match(
        await page.evaluate<string>(`${card}.querySelector('.hint').textContent`),
        /^not armed yet/,
      );
      assert.equal(
        forgeRefs("acme/widgets")["web-pointer"],
        undefined,
        "a click at once pushed nothing",
      );
      // The pointer at rest on it, sending nothing: Approve arms within a second or so (the
      // page's own clock, under load: waited for, not slept), and the bar keeps its height.
      const armed = `${card}.querySelector('button.approve').disabled === false`;
      await page.until(armed, "Approve armed under a pointer at rest", 10_000);
      assert.equal(
        await bar(),
        before,
        "arming kept the bar's height: Approve stayed under the pointer",
      );
      // A change to the page (a scroll moves Approve under a still pointer) disarms it at once,
      // and a still pointer never arms it again: only one that moves onto it, a second later.
      await page.evaluate("window.dispatchEvent(new Event('scroll')); true");
      assert.equal(await page.evaluate(armed), false, "a change disarms at once");
      await sleep(3000);
      assert.equal(await page.evaluate(armed), false, "a still pointer does not arm it again");
      const movedAt = await page.evaluate<number>("performance.now()");
      await page.moveTo(page.pointer().x + 2, page.pointer().y);
      await page.until(armed, "Approve armed once the pointer moved onto it", 10_000);
      assert.ok(
        (await page.evaluate<number>("performance.now()")) - movedAt >= 1000,
        "not before it rested on it a second",
      );
      await page.shot(shot("waiting"));
      // The click is the approval. What the card says from then on is recorded as it changes.
      await page.evaluate(
        `(() => { window.theCard = ${card}; window.hints = []; const h = theCard.querySelector('.hint'); new MutationObserver(() => hints.push(h.textContent)).observe(h, { childList: true, characterData: true, subtree: true }); window.clickedAt = Date.now(); return true; })()`,
      );
      await page.pressHere();
      const line = pushedLine("web-pointer");
      // Its place is kept while the pointer is on the list of cards, then goes.
      await page.until(
        `${line} && theCard.classList.contains('kept')`,
        "its place kept, and its line under Pushed",
        60_000,
      );
      assert.equal(forgeRefs("acme/widgets")["web-pointer"], commit);
      await sleep(1500);
      assert.equal(await page.evaluate("theCard.isConnected"), true, "kept under a still pointer");
      await page.moveTo(4, 4);
      await page.until("!theCard.isConnected", "its place gone, the pointer off the list");
      const after = await page.evaluate<{ hints: string[]; line: string; focused: boolean }>(
        `({ hints, line: ${line}.textContent, focused: document.activeElement === ${line} })`,
      );
      t.diagnostic(
        `pushed, as the page heard it, ${await page.evaluate<number>("Date.now() - clickedAt")} ms after the click`,
      );
      assert.ok(
        after.hints.includes(
          "Approved: the root is pushing it to the remote now. This card goes when the root's pusher reports the remote has it.",
        ),
        JSON.stringify(after.hints),
      );
      assert.match(
        after.line,
        /^acme\/widgets web-pointer [0-9a-f]{12}: the root's pusher reports the remote has it\. Approved at \d\d:\d\d:\d\d\.( Open a pull request on GitHub, as yourself\.)?$/,
      );
      assert.ok(after.focused, "the focus, on the card, went to its line: not lost");
      await page.shot(shot("pushed"));
    } finally {
      await browser.close();
    }
  });

  it("after Approve: being pushed while the forge takes its time, through a reload; no word, dismissed, back when word comes; word of other pushes and a flood touch nothing; a report in hostile text is quoted text; a forge's refusal stays until dismissed", async () => {
    stack.step("the approval page after Approve: being pushed, not pushed, no word");
    const address = /approvals {4}(http:\S+)/.exec(stack.desolate("approve", "--web").stdout)![1]!;
    const origin = new URL(address).origin;
    const chrome = findChrome();
    assert.ok(chrome, "this check needs Chrome or Chromium");
    const browser = await openBrowser(chrome, fs.mkdtempSync(path.join(stack.work, "chrome-")));
    /** The card of a branch of acme/widgets, as an expression. */
    const cardOf = (branch: string) =>
      `[...document.querySelectorAll('.card')].find((c) => c.querySelector('.branch')?.textContent === ${JSON.stringify(branch)})`;
    const hintOf = (branch: string) => `${cardOf(branch)}?.querySelector('.hint').textContent`;
    const quoteOf = (branch: string) =>
      `${cardOf(branch)}?.querySelector('blockquote').textContent`;
    type Page = Awaited<ReturnType<typeof browser.tab>>;
    /** The tab opened for a raw push of `branch`, its card drawn with its account. */
    const opened = async (page: Page, branch: string) => {
      await page.goto("about:blank");
      await page.goto(`${origin}/#repo=acme%2Fwidgets&branch=${branch}&commit=${commit}`);
      await page.until(
        `${cardOf(branch)} && ${cardOf(branch)}.querySelector('button.approve') && !${cardOf(branch)}.innerText.includes('working out')`,
        "the push's card, its account shown",
      );
      await page.evaluate("Element.prototype.scrollIntoView = function () {}; true");
    };
    /** Dismissed as a person does (it arms as Approve does), and its place gone once the
     *  pointer is off the list. */
    const dismissed = async (page: Page, branch: string) => {
      await restOn(page, `${cardOf(branch)}.querySelector('button.dismiss')`, "Dismiss");
      await page.pressHere();
      await page.until(
        `!${cardOf(branch)} && document.querySelector('.card.kept')`,
        "its place kept",
      );
      await page.moveTo(4, 4);
      await page.until("!document.querySelector('.card.kept')", "its place gone");
    };
    const forged = (lines: Record<string, unknown>[]) =>
      stack.inRoot(["bash", "-c", "cat >> /var/lib/desolate-root/pusher.log && echo written"], {
        root: true,
        input: lines
          .map((l) => `EVENT ${JSON.stringify({ at: new Date().toISOString(), ...l })}\n`)
          .join(""),
      });
    try {
      const page = await browser.tab(address);
      // A forge slow to take it, as a large push is: the card says it is being pushed.
      stack.forge("hold", "acme/widgets", "90");
      inRootClone(
        `setsid nohup git push origin ${commit}:refs/heads/web-held >/tmp/web-held.log 2>&1 </dev/null & sleep 0.2`,
      );
      await opened(page, "web-held");
      // A failure of this very move already in the pusher's log, from before this approval
      // (as a push of it approved earlier would have left): it ends nothing signed after it.
      const stale = {
        type: "push-failed",
        repo: "acme/widgets",
        branch: "web-held",
        commit,
        onto: null,
        error: "an earlier push's failure",
      };
      assert.match(
        stack.inRoot(["bash", "-c", "cat >> /var/lib/desolate-root/pusher.log && echo written"], {
          root: true,
          input: `EVENT ${JSON.stringify({ at: new Date().toISOString(), ...stale })}\n`,
        }).stdout,
        /written/,
      );
      await armedPress(page, ".card.asked button.approve", "Approve push");
      const pushing =
        "Approved: the root is pushing it to the remote now. This card goes when the root's pusher reports the remote has it.";
      await page.until(`${hintOf("web-held")} === ${JSON.stringify(pushing)}`, "being pushed");
      assert.deepEqual(
        await page.evaluate(
          `[...${cardOf("web-held")}.querySelectorAll('.actions button')].filter((b) => b.offsetParent).map((b) => [b.textContent, b.disabled || b.getAttribute('aria-disabled') === 'true'])`,
        ),
        [
          ["Approve push", true],
          ["Refuse", true],
        ],
        "its buttons stay where they were, and none can be pressed: it cannot be approved twice",
      );
      await sleep(5000);
      assert.equal(
        await page.evaluate(hintOf("web-held")),
        pushing,
        "the failure written before the signature ended nothing",
      );
      await page.shot(shot("pushing"));
      // A reload mid-push: the card is drawn from the host's record, being pushed, with no
      // button to approve or refuse it.
      await page.reload();
      await page.until(
        `${hintOf("web-held")} === ${JSON.stringify(pushing)}`,
        "being pushed, after a reload",
      );
      assert.deepEqual(
        await page.evaluate(
          `[...${cardOf("web-held")}.querySelectorAll('.actions button')].filter((b) => b.offsetParent).map((b) => b.textContent)`,
        ),
        [],
      );
      // No word for a while (the page's clock moved on four minutes): said, with what to look
      // at, in a line that stays the same while it stands.
      await page.evaluate(
        "window.realNow = Date.now; Date.now = () => realNow() + 4 * 60_000; true",
      );
      const noWord =
        "No word from the root's pusher in the 3 minutes since you approved this. A large push can take longer, and this changes when word comes. If none does, desolate events --all on this Mac says what the pusher did, and the terminal or dashboard that pushed says how it ended; to try again, push it again.";
      await page.until(`${hintOf("web-held")} === ${JSON.stringify(noWord)}`, "no word");
      await page.shot(shot("no-word"));
      // Put away; it comes back when its word does (below), as its line said.
      await page.evaluate("Element.prototype.scrollIntoView = function () {}; true");
      await dismissed(page, "web-held");
      await page.evaluate("Date.now = realNow; true");
      // The pusher's log is root's alone: the root's ordinary user cannot add a word to it.
      // (Control: root can, below.)
      const ordinary = stack.inRoot([
        "bash",
        "-c",
        "echo x >> /var/lib/desolate-root/pusher.log && echo written",
      ]);
      assert.doesNotMatch(
        ordinary.stdout,
        /written/,
        "the root's ordinary user wrote the pusher's log",
      );
      // What the page shows of web-held from here on, sampled as it changes.
      await page.evaluate(
        `(() => { window.held = []; setInterval(() => { const s = JSON.stringify([${hintOf("web-held")} ?? null, !!${pushedLine("web-held")}]); if (held.at(-1) !== s) held.push(s); }, 50); return true; })()`,
      );
      // As a root that is taken over could: a flood of words on other pushes (another commit of
      // the branch, another repository, the same commit from elsewhere), then a word on this
      // very push, in text that holds a terminal's escapes, markup and a direction override.
      const move = { type: "pushed", repo: "acme/widgets", branch: "web-held", commit, onto: null };
      const flood = [
        ...Array.from({ length: 3000 }, (_, i) => ({
          ...move,
          commit: i.toString(16).padStart(40, "0"),
        })),
        { ...move, repo: "acme/other" },
        { ...move, onto: "f".repeat(40) },
      ];
      const hostile =
        "refused \u001b[31mred\u001b[0m <b>bold</b> <img src=x onerror=alert(1)> &amp; \u202eevil";
      // (Its time an hour before the Mac's: where it is in the log decides, not when it says.)
      assert.match(
        forged([
          ...flood,
          {
            ...move,
            type: "push-failed",
            error: hostile,
            at: new Date(Date.now() - 3_600_000).toISOString(),
          },
        ]).stdout,
        /written/,
      );
      const failed =
        "Not pushed: the root's pusher reports it failed, in its words above. To try again, push it again (the dashboard's Push, desolate push, or git push in the git VM) and approve it here.";
      await page.until(
        `${hintOf("web-held")} === ${JSON.stringify(failed)}`,
        "the word on this push, back",
        60_000,
      );
      const seen = await page.evaluate<{
        held: string[];
        quote: string;
        caption: string;
        markup: number;
        records: number;
      }>(
        `({ held, quote: ${quoteOf("web-held")}, caption: ${cardOf("web-held")}.querySelector('figcaption').textContent, markup: ${cardOf("web-held")}.querySelectorAll('b, img').length, records: records.length })`,
      );
      // The flood was read before it (the log is read in order): it showed nothing. (The
      // sampler looks every 50 ms: it may not have seen this word yet, never another.)
      assert.deepEqual(
        seen.held.filter((h) => h !== JSON.stringify([failed, false])),
        [JSON.stringify([null, false])],
        `nothing came between the card dismissed and this word: ${JSON.stringify(seen.held)}`,
      );
      assert.equal(
        seen.quote,
        "refused ?[31mred?[0m <b>bold</b> <img src=x onerror=alert(1)> &amp; ?evil",
      );
      assert.equal(seen.caption, "The root's pusher, in its own words:");
      assert.equal(seen.markup, 0, "its words are text");
      assert.ok(seen.records <= 16, `${seen.records} approvals told to the page`);
      await page.shot(shot("failed-quoted"));
      // The forge then takes the push: the pusher's own word comes second, and the first stands.
      // A forged report is a wrong line on this card at worst, never more (it signs nothing).
      stack.forge("hold", "acme/widgets", "0");
      for (let i = 0; i < 240 && forgeRefs("acme/widgets")["web-held"] !== commit; i++)
        await sleep(500);
      assert.equal(forgeRefs("acme/widgets")["web-held"], commit, "the real push landed");
      await sleep(3000);
      assert.equal(await page.evaluate(hintOf("web-held")), failed);
      // Until dismissed; and dismissed, a reload does not bring it back.
      await dismissed(page, "web-held");
      await page.reload();
      await sleep(3000);
      assert.equal(await page.evaluate(`!!${cardOf("web-held")}`), false);

      // The forge refuses it, its branch moved after the card was drawn: the card says so in
      // the pusher's words, and stays.
      inRootClone(
        `setsid nohup git push origin ${commit}:refs/heads/web-moved >/tmp/web-moved.log 2>&1 </dev/null & sleep 0.2`,
      );
      await opened(page, "web-moved");
      const moved = stack.forge("commit", "acme/widgets", "web-moved", "moved.txt", "moved").trim();
      await armedPress(page, ".card.asked button.approve", "Approve push");
      await page.until(
        `${hintOf("web-moved")} === ${JSON.stringify(failed)}`,
        "the forge's refusal",
        60_000,
      );
      assert.equal(
        await page.evaluate(quoteOf("web-moved")),
        `the remote's web-moved is at ${moved.slice(0, 12)}, not absent, as the approval names: nothing was pushed`,
      );
      await sleep(5000);
      assert.equal(await page.evaluate(hintOf("web-moved")), failed, "it stays");
      assert.deepEqual(
        await page.evaluate(
          `[...${cardOf("web-moved")}.querySelectorAll('.actions button')].filter((b) => b.offsetParent).map((b) => b.textContent)`,
        ),
        ["Dismiss"],
      );
      assert.equal(forgeRefs("acme/widgets")["web-moved"], moved, "nothing was pushed");
      await page.shot(shot("failed"));
      // Dismissed by keyboard: Tab to it, a second's rest, Enter.
      const movedDismiss = `${cardOf("web-moved")}.querySelector('button.dismiss')`;
      await page.tabTo(movedDismiss);
      await page.until(pressable(movedDismiss), "Dismiss armed for a key", 10_000);
      await page.key("Enter");
      await page.until(
        `!${cardOf("web-moved")} && [...document.querySelectorAll('.kept-note')].some((n) => n.textContent === 'Dismissed.')`,
        "dismissed by Enter, its place kept",
      );
    } finally {
      stack.forge("hold", "acme/widgets", "0");
      await browser.close();
    }
  });

  it("nothing comes under a still pointer: a card that ended keeps its place until the pointer is off the list, a press where Approve was signs and refuses nothing, and a button that came under the pointer arms only once it moves onto it (control: moving onto the next card's Approve arms it)", async () => {
    stack.step("the approval page: nothing comes under a still pointer");
    const address = /approvals {4}(http:\S+)/.exec(stack.desolate("approve", "--web").stdout)![1]!;
    const origin = new URL(address).origin;
    const chrome = findChrome();
    assert.ok(chrome, "this check needs Chrome or Chromium");
    const browser = await openBrowser(chrome, fs.mkdtempSync(path.join(stack.work, "chrome-")));
    const cardOf = (branch: string) =>
      `[...document.querySelectorAll('.card')].find((c) => c.querySelector('.branch')?.textContent === ${JSON.stringify(branch)})`;
    const hintOf = (branch: string) => `${cardOf(branch)}?.querySelector('.hint').textContent`;
    const rect = (expression: string) =>
      `(() => { const r = ${expression}.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; })()`;
    try {
      for (const branch of ["web-a", "web-b"])
        inRootClone(
          `setsid nohup git push origin ${commit}:refs/heads/${branch} >/tmp/${branch}.log 2>&1 </dev/null & sleep 0.5`,
        );
      // (Signed in by the page's own address first, as `desolate approve --web --open` does.)
      const page = await browser.tab(address);
      await page.until(
        ["web-a", "web-b"]
          .map((b) => `${cardOf(b)} && !${cardOf(b)}.innerText.includes('working out')`)
          .join(" && "),
        "both cards, their accounts shown",
      );
      // A is the card above, B the one below it (in the order the root lists them).
      const [a, b] = await page.evaluate<[string, string]>(
        "[...document.querySelectorAll('.card .branch')].map((n) => n.textContent).filter((n) => n === 'web-a' || n === 'web-b')",
      );
      await page.evaluate(
        "window.posted = []; const f = window.fetch; window.fetch = (u, o) => { if (o && o.method === 'POST') posted.push(u); return f(u, o); }; Element.prototype.scrollIntoView = function () {}; true",
      );
      // A approved, the hand left where it pressed.
      await restOn(page, `${cardOf(a!)}.querySelector('button.approve')`, "A's Approve");
      await page.pressHere();
      await page.until(`/^Approved/.test(${hintOf(a!)})`, "A being pushed");
      const bApprove = `${cardOf(b!)}.querySelector('button.approve')`;
      const bRefuse = `${cardOf(b!)}.querySelector('button.refuse')`;
      const before = await page.evaluate<number[][]>(`[${rect(bApprove)}, ${rect(bRefuse)}]`);
      // A's word arrives (the forge takes it): its place is kept, B does not move.
      await page.until(
        `[...document.querySelectorAll('.card.kept .kept-note')].some((n) => n.textContent.startsWith(${JSON.stringify(`acme/widgets ${a} `)}))`,
        "A's place kept, saying it was pushed",
        60_000,
      );
      await sleep(2000);
      assert.deepEqual(
        await page.evaluate(`[${rect(bApprove)}, ${rect(bRefuse)}]`),
        before,
        "B did not move",
      );
      assert.ok(
        await page.evaluate("!!document.querySelector('.card.kept')"),
        "kept under a still pointer",
      );
      await page.shot(shot("kept"));
      // A press where A's Approve was: nothing.
      await page.pressHere();
      assert.deepEqual(await page.evaluate("posted"), ["/approve"], "nothing signed or refused");
      assert.doesNotMatch(await page.evaluate<string>(hintOf(b!)), /^(approving|Approved|refused)/);
      // By keyboard: Tab brings the focus to B's Refuse, and a second later a key would refuse
      // it. Then A's place goes (the pointer leaves the list): the cards move, and Enter on the
      // Refuse that had the focus refuses nothing until the person's Tab comes to it again.
      await page.tabTo(bRefuse);
      await page.until(pressable(bRefuse), "B's Refuse armed for a key", 10_000);
      await page.moveTo(4, 4);
      await page.until("!document.querySelector('.card.kept')", "A's place gone");
      await page.key("Enter");
      await sleep(1000);
      assert.deepEqual(await page.evaluate("posted"), ["/approve"], "Enter refused nothing");
      assert.equal(await page.evaluate(`document.activeElement === ${bRefuse}`), true);
      // CONTROL: moving onto B's Approve and resting arms it.
      const armedB = `${bApprove}.disabled === false`;
      await restOn(page, bApprove, "B's Approve, once the pointer came to it");
      // Anything the page does under it disarms it, and a still pointer does not arm it again.
      await page.evaluate("window.dispatchEvent(new Event('scroll')); true");
      await sleep(2500);
      assert.equal(await page.evaluate(armedB), false, "a still pointer arms nothing");
      // B is refused by the forge (its branch moves), and its Dismiss is not where Approve was.
      const moved = stack.forge("commit", "acme/widgets", b!, "moved.txt", "moved").trim();
      await page.moveTo(page.pointer().x + 2, page.pointer().y);
      await page.until(armedB, "B armed after the pointer moved", 10_000);
      await page.pressHere();
      await page.until(`/^Not pushed/.test(${hintOf(b!)})`, "B refused by the forge", 60_000);
      const at = page.pointer();
      const bDismiss = `${cardOf(b!)}.querySelector('button.dismiss')`;
      const dismissAt = await page.evaluate<number[]>(rect(bDismiss));
      assert.ok(
        !(
          at.x >= dismissAt[0]! &&
          at.x <= dismissAt[0]! + dismissAt[2]! &&
          at.y >= dismissAt[1]! &&
          at.y <= dismissAt[1]! + dismissAt[3]!
        ),
        "Dismiss is not under the pointer that approved",
      );
      await page.pressHere();
      assert.match(
        await page.evaluate<string>(hintOf(b!)),
        /^Not pushed/,
        "a press there dismissed nothing",
      );
      // By keyboard: Tab to B's Dismiss; a push arrives (C's card, below: the cards change),
      // and Enter dismisses nothing.
      await page.tabTo(bDismiss);
      await page.until(pressable(bDismiss), "B's Dismiss armed for a key", 10_000);
      inRootClone(
        `setsid nohup git push origin ${commit}:refs/heads/web-c >/tmp/web-c.log 2>&1 </dev/null & sleep 0.5`,
      );
      await page.until(
        `${cardOf("web-c")} && !${cardOf("web-c")}.innerText.includes('working out')`,
        "C's card, its account shown",
      );
      await page.key("Enter");
      await sleep(1000);
      assert.match(
        await page.evaluate<string>(hintOf(b!)),
        /^Not pushed/,
        "Enter dismissed nothing",
      );
      // Dismiss arms as Approve does: a press as the pointer arrives is not taken. (Where it is
      // now: Tab scrolled the page.)
      const dismissNow = await page.evaluate<number[]>(rect(bDismiss));
      await page.moveTo(dismissNow[0]! + dismissNow[2]! / 2, dismissNow[1]! + dismissNow[3]! / 2);
      await page.pressHere();
      assert.match(await page.evaluate<string>(hintOf(b!)), /^Not pushed/, "not at once");
      await page.until(pressable(bDismiss), "Dismiss armed", 10_000);
      await page.pressHere();
      await page.until(
        `!${cardOf(b!)} && [...document.querySelectorAll('.kept-note')].some((n) => n.textContent === 'Dismissed.')`,
        "B dismissed, its place kept",
      );
      await page.moveTo(4, 4);
      await page.until(
        "!document.querySelector('.card.kept')",
        "the places gone, the pointer off the list",
      );
      assert.deepEqual(await page.evaluate("posted"), ["/approve", "/approve"]);
      // CONTROL, by keyboard: Tab to C's Refuse, a second's rest, Enter: refused.
      const cRefuse = `${cardOf("web-c")}.querySelector('button.refuse')`;
      await page.tabTo(cRefuse);
      await page.until(pressable(cRefuse), "C's Refuse armed for a key", 10_000);
      await page.key("Enter");
      await page.until(
        `${hintOf("web-c")} === "refused: the push that asked gives up"`,
        "C refused by Enter",
      );
      assert.deepEqual(await page.evaluate("posted"), ["/approve", "/approve", "/refuse"]);
      assert.equal(forgeRefs("acme/widgets")[b!], moved);
    } finally {
      await browser.close();
    }
  });

  it("the approval page shows an adversarial push as it is: names that read as no other, the message and author made safe, every forge file flagged, and Approve signs just the commit (control: an ordinary push, as written)", async () => {
    stack.step("the approval page, an adversarial push");
    const address = /approvals {4}(http:\S+)/.exec(stack.desolate("approve", "--web").stdout)![1]!;
    const origin = new URL(address).origin;
    // A commit made in the root clone on `commit`: its files (each holding a line) and its
    // message as bytes, by printf's octal escapes, so the script itself is plain ASCII.
    const octal = (text: string) =>
      [...Buffer.from(text, "utf8")]
        .map((b) =>
          b >= 0x20 && b < 0x7f && !"\\%'".includes(String.fromCharCode(b))
            ? String.fromCharCode(b)
            : `\\${b.toString(8).padStart(3, "0")}`,
        )
        .join("");
    const made = (files: string[], message: string, author: string, branch: string) => {
      const out = inRootClone(
        [
          `git checkout -q --detach ${commit}`,
          ...files.map(
            (f) =>
              `mkdir -p "$(dirname "$(printf '${octal(f)}')")" && printf 'a line\\n' > "$(printf '${octal(f)}')"`,
          ),
          `printf '${octal(message)}' > /tmp/${branch}.msg`,
          `git add -A`,
          `git -c user.name='${author}' -c user.email=someone@example.invalid commit -q --cleanup=verbatim -F /tmp/${branch}.msg`,
          `git rev-parse HEAD`,
          `git checkout -q -`,
        ].join(" && "),
      );
      assert.equal(out.code, 0, out.stdout + out.stderr);
      const id = out.stdout.trim().split("\n").pop()!;
      inRootClone(
        `setsid nohup git push origin ${id}:refs/heads/${branch} >/tmp/${branch}.log 2>&1 </dev/null & sleep 0.2`,
      );
      return id;
    };
    const chrome = findChrome();
    assert.ok(chrome, "this check needs Chrome or Chromium");
    const browser = await openBrowser(chrome, fs.mkdtempSync(path.join(stack.work, "chrome-")));
    const card = "document.querySelector('.card.asked')";
    try {
      const page = await browser.tab(address);
      /** The push's card, its account shown, and what a person reads on it. */
      const opened = async (branch: string, id: string) => {
        await page.goto("about:blank");
        await page.goto(`${origin}/#repo=acme%2Fwidgets&branch=${branch}&commit=${id}`);
        await page.until(
          `${card} && ${card}.querySelector('button.approve') && !${card}.innerText.includes('working out')`,
          `the card of ${branch}, its account shown`,
          120_000,
        );
        // Its one commit whole, opened by the pointer: who wrote it, and its whole message.
        await page.click(".card.asked .summary > button", "Show each commit whole");
        await page.click(".card.asked li.whole > button", id.slice(0, 12));
        await page.until(`${card}.querySelector('li.whole pre.diff')`, "the commit whole", 60_000);
        return page.evaluate<{
          commit: string;
          files: { name: string; sensitive: boolean; looks: string }[];
          whole: string;
          outside: string;
          approve: string[];
          wide: boolean;
        }>(`(() => {
          const c = ${card};
          const whole = c.querySelector('li.whole pre.diff');
          return {
            commit: c.querySelector('li.commit').textContent,
            files: [...c.querySelectorAll('li.file')].map((li) => ({ name: li.querySelector('code').textContent, sensitive: li.classList.contains('sensitive'), looks: li.querySelector('.looks')?.textContent ?? '' })),
            whole: whole.innerText,
            outside: c.innerText.replace(whole.innerText, ''),
            approve: [...c.querySelectorAll('button.approve')].map((b) => b.textContent),
            wide: document.documentElement.scrollWidth > window.innerWidth,
          };
        })()`);
      };

      // CONTROL: an ordinary push is shown as written, its message whole, nothing flagged.
      const plain = made(
        ["notes/plain.md", "docs/café.md"],
        "notes: an ordinary change\n\nA body as written, with café and\ta tab.\n",
        "Ada Lovelace",
        "web-plain",
      );
      const seen = await opened("web-plain", plain);
      assert.equal(seen.commit, `${plain.slice(0, 12)} notes: an ordinary change  by Ada Lovelace`);
      // (The files `commit` itself changes against the remote's main are listed too: theirs.)
      const own = ["docs/café.md", "notes/plain.md"];
      const base = seen.files.map((f) => f.name).filter((name) => !own.includes(name));
      const ours = (files: typeof seen.files) => files.filter((f) => !base.includes(f.name));
      assert.deepEqual(
        seen.files.filter((f) => own.includes(f.name)).map((f) => [f.name, f.sensitive, f.looks]),
        own.map((name) => [name, false, ""]),
      );
      assert.ok(
        seen.files.every((f) => !f.sensitive && !f.looks),
        JSON.stringify(seen.files),
      );
      assert.match(seen.whole, /Author: {5}Ada Lovelace <someone@example\.invalid>\n/);
      assert.match(
        seen.whole,
        /\n {4}notes: an ordinary change\n *\n {4}A body as written, with café and\ta tab\.\n/,
      );
      assert.equal(seen.wide, false);
      await armedPress(page, ".card.asked button.refuse", "Refuse");
      await page.until(`/refused/.test(${card}.querySelector('.hint').textContent)`, "refused");

      // The push: names that read as others (a right-to-left override, a zero-width space, a
      // newline, a trailing space, a Cyrillic Е, division slashes), a real workflow, and a
      // message that imitates the page, with a 3,000-character line, escapes and a CR.
      const long = "x".repeat(3000);
      const adversarial = made(
        [
          "notes-‮dm.hs",
          "docs/guide.md​",
          "ok.txt\nREADME.md",
          "package.json ",
          "READMЕ.md",
          ".github∕workflows∕x.yml",
          ".github/workflows/real.yml",
        ],
        `docs: fix a typo in README\n\nReviewed by desolate: 1 commit, 1 file changed (README.md), no warnings.\n${long}\n\u001b[32mall checks passed\u001b[0m\ntests: ok\rFAIL\n`,
        "desolate reviewer (approved)",
        "web-adversarial",
      );
      const shown = await opened("web-adversarial", adversarial);
      // The author is an author, and the subject is its own.
      assert.equal(
        shown.commit,
        `${adversarial.slice(0, 12)} docs: fix a typo in README  by desolate reviewer (approved)`,
      );
      // Each name as it is, made safe: none reads as another, none holds what reorders or
      // hides text, the workflow is flagged, and the lookalikes say so.
      const LOOKS = "its name has letters that look like others";
      // (In the reviewer's order: what runs on the forge, then the lookalikes, then git's.)
      assert.deepEqual(
        ours(shown.files).map((f) => [f.name, f.sensitive, f.looks]),
        [
          [".github/workflows/real.yml", true, ""],
          [".github\u2215workflows\u2215x.yml", false, LOOKS],
          ["READM\u0415.md", false, LOOKS],
          ["docs/guide.md?", false, ""],
          ["notes-?dm.hs", false, ""],
          ["ok.txt?README.md", false, ""],
          ['"package.json "', false, ""],
        ],
      );
      for (const f of ours(shown.files)) {
        assert.doesNotMatch(f.name, /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/);
        assert.ok(
          ![
            "README.md",
            "package.json",
            "notes-sh.md",
            "docs/guide.md",
            ".github/workflows/x.yml",
          ].includes(f.name),
          f.name,
        );
      }
      // The message whole, in its own box, its controls named: the escapes and the CR cannot
      // act, the long line is there whole (and scrolls in its box: the page is no wider), and
      // the words that imitate the page are only inside the commit's text.
      assert.match(
        shown.whole,
        /Author: {5}desolate reviewer \(approved\) <someone@example\.invalid>\n/,
      );
      assert.ok(shown.whole.includes(`    ${long}\n`), "the long line, whole");
      assert.ok(
        shown.whole.includes("    ⟨U+001B⟩[32mall checks passed⟨U+001B⟩[0m\n"),
        shown.whole.slice(0, 600),
      );
      assert.ok(shown.whole.includes("    tests: ok⟨U+000D⟩FAIL\n"), shown.whole.slice(0, 600));
      assert.doesNotMatch(shown.whole, /[\u001b‮​]|\r(?!\n)/);
      assert.doesNotMatch(shown.outside, /Reviewed by desolate/);
      assert.equal(shown.wide, false, "the long line does not widen the page");
      // Nothing of it changes what Approve does: the same buttons, and the click signs the
      // commit pushed, unsquashed, which the remote then has (its id is its whole content).
      assert.deepEqual(shown.approve, seen.approve);
      await page.click(".card.asked .summary > button", "Hide each commit");
      await page.evaluate(
        "window.posted = []; const f = window.fetch; window.fetch = (u, o) => { if (o && o.method === 'POST') window.posted.push(JSON.parse(o.body)); return f(u, o); }; Element.prototype.scrollIntoView = function () {}",
      );
      await sleep(1500);
      await armedPress(page, ".card.asked button.approve", "Approve push");
      await page.until(pushedLine("web-adversarial"), "its line under Pushed", 60_000);
      const posted = await page.evaluate<{ commit: string; squash: boolean }[]>("window.posted");
      assert.deepEqual(
        posted.map((p) => [p.commit, p.squash]),
        [[adversarial, false]],
      );
      assert.equal(forgeRefs("acme/widgets")["web-adversarial"], adversarial);
      assert.equal(forgeRefs("acme/widgets")["web-plain"], undefined, "the control, refused");
    } finally {
      await browser.close();
    }
  });

  it("the approval page is never wider than its window, whatever a push's names: each long text whole, and Approve arms and signs the commit (control: a replace of a long branch, on the old stylesheet)", async () => {
    stack.step("the approval page, a push of long names");
    const address = /approvals {4}(http:\S+)/.exec(stack.desolate("approve", "--web").stdout)![1]!;
    const origin = new URL(address).origin;
    // A branch as long as a branch may be, and a subject and a file's path of 300 characters
    // with no space (a path is cut in parts of 255 at most; its slash is its only break).
    // Shown on the card as the names, the commit and the file; and, for a replace, in the
    // prompt to type the branch's name and on the Replace button, where it made the page
    // 1,988 px wide in a 1,280 px window, Replace out of sight (found 2026-11-23).
    const branch = `web-${"b".repeat(NAMES.branch - 4)}`;
    const subject = "s".repeat(300);
    const file = `${"d".repeat(150)}/${"f".repeat(145)}.txt`;
    assert.equal(file.length, 300);
    /** A commit on `commit`, of `made` (a shell command), pushed raw to the long branch. */
    const pushed = (made: string, plus: string) => {
      const out = inRootClone(
        [
          `git checkout -q --detach ${commit}`,
          made,
          "git add -A",
          `git -c user.name=t -c user.email=t@example.invalid commit -qm ${subject}`,
          "git rev-parse HEAD",
          "git checkout -q -",
        ].join(" && "),
      );
      assert.equal(out.code, 0, out.stdout + out.stderr);
      const id = out.stdout.trim().split("\n").pop()!;
      inRootClone(
        `setsid nohup git push origin ${plus}${id}:refs/heads/${branch} >/tmp/web-long.log 2>&1 </dev/null & sleep 0.2`,
      );
      return id;
    };
    const chrome = findChrome();
    assert.ok(chrome, "this check needs Chrome or Chromium");
    const browser = await openBrowser(chrome, fs.mkdtempSync(path.join(stack.work, "chrome-")));
    const card = "document.querySelector('.card.asked')";
    // How far the page scrolls sideways, which of the card's buttons end past the window's
    // right edge, and each long text as the card shows it.
    const measure = `(() => {
      const page = document.documentElement, c = ${card};
      return { sideways: page.scrollWidth - page.clientWidth,
        outside: [...c.querySelectorAll("button.approve, button.refuse")].filter((b) => b.getBoundingClientRect().right > page.clientWidth + 1).map((b) => b.textContent),
        branch: c.querySelector(".branch").textContent, commit: c.querySelector("li.commit").textContent,
        files: [...c.querySelectorAll("li.file code")].map((e) => e.textContent), typed: c.querySelector(".branch-name").textContent,
        approve: c.querySelector("button.approve").textContent };
    })()`;
    type Measured = {
      sideways: number;
      outside: string[];
      branch: string;
      commit: string;
      files: string[];
      typed: string;
      approve: string;
    };
    try {
      const page = await browser.tab(address);
      /** The push's card, its account shown, measured. */
      const opened = async (id: string, approve: string) => {
        await page.goto("about:blank");
        await page.goto(`${origin}/#repo=acme%2Fwidgets&branch=${branch}&commit=${id}`);
        await page.until(
          `${card} && ${card}.querySelector('button.approve').textContent === ${JSON.stringify(approve)} && !${card}.innerText.includes('working out')`,
          "the card of the long branch, its account shown",
          120_000,
        );
        const seen = await page.evaluate<Measured>(measure);
        assert.ok(
          seen.sideways <= 1,
          `${approve}: the page scrolls sideways by ${seen.sideways} px`,
        );
        assert.deepEqual(seen.outside, [], `${approve}: past the window's right edge`);
        assert.equal(seen.branch, branch);
        assert.equal(seen.commit, `${id.slice(0, 12)} ${subject}  by t`);
        return seen;
      };
      /** Approve (or Replace) armed under the pointer, clicked: what the page signed, and what
       *  the remote then has. */
      const approved = async (id: string, label: string) => {
        await page.evaluate(
          "window.posted = []; const f = window.fetch; window.fetch = (u, o) => { if (o && o.method === 'POST') window.posted.push(JSON.parse(o.body)); return f(u, o); }; Element.prototype.scrollIntoView = function () {}",
        );
        await sleep(1500);
        await armedPress(page, ".card.asked button.approve", label);
        await page.until(pushedLine(branch, id), "its line under Pushed", 60_000);
        assert.equal(forgeRefs("acme/widgets")[branch], id);
        return page.evaluate<{ commit: string; squash: boolean; replace: boolean }[]>(
          "window.posted",
        );
      };
      // A new branch: its names, its commit and its file, each whole.
      const first = pushed(`mkdir -p ${"d".repeat(150)} && echo a line > ${file}`, "");
      const seen = await opened(first, "Approve push");
      assert.ok(seen.files.includes(file), JSON.stringify(seen.files));
      assert.deepEqual(
        (await approved(first, "Approve push")).map((p) => [p.commit, p.squash, p.replace]),
        [[first, false, false]],
      );
      // A replace of it: the prompt and the button name the branch, whole, and the page is
      // still its window's width (the control: on the old stylesheet, it was not).
      const second = pushed("echo another > other.txt", "+");
      const replace = `Replace ${branch}`;
      const asked = await opened(second, replace);
      assert.equal(asked.typed, branch);
      assert.equal(asked.approve, replace);
      // A picture of it, for a person to look at, beside the suite's own files.
      await page.shot(
        path.join(process.env.DESOLATE_SCREENSHOTS || os.tmpdir(), "approve-long-names.png"),
      );
      await page.click(".card.asked .replace-name");
      await page.type(branch);
      assert.deepEqual(
        (await approved(second, "Replace")).map((p) => [p.commit, p.squash, p.replace]),
        [[second, false, true]],
      );
    } finally {
      await browser.close();
    }
  });

  it("a repository cloned --no-push is never written: there is no key to write it with", () => {
    stack.step("a repository the root cannot push");
    inWs(
      "dev/w1",
      "cd /workspaces/acme/consumer && git checkout -q -b tweak && echo x >> README.md && git commit -qam tweak",
    );
    assert.equal(
      stack.quiet("exec", "dev/w1", "--checkout", "acme/consumer", "--", "desolate", "offer").code,
      0,
    );
    const review = JSON.parse(
      stack.quiet("review", "dev", "acme/consumer", "tweak", "--json").stdout,
    ) as { commit: string; pushable: boolean };
    assert.equal(review.pushable, false);
    const pushed = stack.person(
      "Type the branch name",
      "tweak",
      "push",
      "dev",
      "acme/consumer",
      "tweak",
      "--expect",
      review.commit,
    );
    assert.equal(pushed.code, 1);
    assert.match(pushed.stdout, /is not pushable: the root holds no write key for it/);
    assert.equal(
      inRootClone(
        "cd /desolate/root/acme/consumer && git push --no-verify origin HEAD:refs/heads/x 2>&1",
      ).code === 0,
      false,
    );
    const mirrorRefs = stack
      .inRoot([
        "bash",
        "-c",
        "git -C /desolate/mirrors/acme/consumer.git for-each-ref --format='%(refname)'",
      ])
      .stdout.trim();
    assert.equal(mirrorRefs, "refs/heads/main", "nothing was pushed into the mirror either");
    const pushes = JSON.parse(stack.forge("pushes")) as { repo: string }[];
    assert.ok(
      pushes.every((p) => p.repo !== "acme/consumer"),
      "the consumer's remote was never written",
    );
    assert.ok(
      pushes.some((p) => p.repo === "acme/widgets"),
      "control: the forge does log pushes",
    );
  });

  it("the root never runs git in a domain's repository: a booby-trapped clone and a lying outbox", () => {
    stack.step("a hostile domain repository");
    // The trap: config and hooks in the domain clone that run a command when git works there.
    const trap = inWs(
      "dev/w1",
      `cd /workspaces/acme/widgets && git config core.fsmonitor 'touch /tmp/PWNED-fsmonitor; false' && git config uploadpack.packObjectsHook 'touch /tmp/PWNED-uploadpack; cat' && git config core.hooksPath /workspaces/acme/widgets/.git/trap-hooks && mkdir -p .git/trap-hooks && for h in post-checkout reference-transaction pre-auto-gc post-index-change; do printf '#!/bin/sh\\ntouch /tmp/PWNED-hook\\n' > .git/trap-hooks/$h; chmod +x .git/trap-hooks/$h; done && git status >/dev/null 2>&1; ls /tmp/PWNED-*`,
    );
    assert.match(
      trap.stdout,
      /PWNED-fsmonitor/,
      "control: the trap fires when git runs in the domain clone (here, in its own workspace)",
    );
    // Then everything the root does with this domain.
    inWs(
      "dev/w1",
      `cd ${WT} && echo more >> README.md && git commit -qam 'more' && desolate offer`,
    );
    assert.equal(
      inRootClone("git fetch --all --quiet && git log -1 --format=%s dev/issue/12").stdout.trim(),
      "more",
    );
    assert.equal(stack.quiet("review", "dev", "acme/widgets", "issue/12").code, 0);
    stack.quiet("push", "dev", "acme/widgets", "issue/12", "--expect", "0".repeat(40));
    const rootTmp = stack.inRoot(["bash", "-c", "ls /tmp/PWNED-* 2>/dev/null; true"], {
      root: true,
    });
    assert.equal(
      rootTmp.stdout.trim(),
      "",
      "nothing from the domain's config or hooks ran in the root",
    );
    // A lying outbox: ref names that are paths or options, a commit that is not one, a
    // bundle that is a symlink out of the outbox.
    inWs("dev/w1", "pkill -f wsd.ts; true");
    const sync = path.join(stack.home, "domains/dev/outbox/sync/acme/widgets");
    const good = commit;
    const said = outboxSaid(stack);
    fs.writeFileSync(
      path.join(sync, "refs.json"),
      JSON.stringify({
        refs: {
          "../../../etc/evil": good,
          "-oProxyCommand=evil": good,
          "ok/../../x": good,
          notasha: "zz",
          honest: good,
          "refs/heads/double": good,
        },
      }),
    );
    fs.symlinkSync("/etc/passwd", path.join(sync, "zz-link.bundle"));
    fs.writeFileSync(path.join(sync, "zy-garbage.bundle"), "this is not a bundle");
    const lied = inRootClone(
      "git fetch dev 2>&1; git for-each-ref --format='%(refname)' refs/remotes/dev refs/desolate; ls /desolate/root/acme/widgets/.git/refs/remotes/dev",
    );
    assert.match(
      lied.stdout,
      /^refs\/remotes\/dev\/honest$/m,
      "control: a well-formed ref from the same list is accepted",
    );
    assert.doesNotMatch(lied.stdout, /evil|notasha|ProxyCommand|refs\/desolate/);
    // The root removes what it finds by NAME, in the directory it checked: the link goes,
    // what it pointed at is never opened, and the person is told something was dropped.
    const dropped = /dropped from dev's outbox: the bundle zz-link\.bundle is not a plain file/;
    assert.match(said(lied, dropped), dropped, lied.stdout);
    assert.ok(
      !fs.existsSync(path.join(sync, "zz-link.bundle")) &&
        fs.lstatSync(path.join(sync, "zz-link.bundle"), { throwIfNoEntry: false }) === undefined,
      "the link itself is gone from the outbox",
    );
    assert.match(
      stack.inRoot(["bash", "-c", "head -c 5 /etc/passwd; stat -c %h /etc/passwd"], { root: true })
        .stdout,
      /^root:1\n$/,
      "and what it pointed at is as it was",
    );
  });

  it("a domain's list of branches is taken whole or refused out loud: none is cut, and none pruned on a part", () => {
    stack.step("a domain with many branches");
    // (The workspace's daemon is stopped, above: what is in the outbox is what this writes.)
    const sync = path.join(stack.home, "domains/dev/outbox/sync/acme/widgets");
    const kept = fs.readFileSync(path.join(sync, "refs.json"), "utf8");
    const many = Object.fromEntries(Array.from({ length: 6000 }, (_, i) => [`many/b${i}`, commit]));
    const countMany = () =>
      Number(
        inRootClone("git for-each-ref --format=x refs/remotes/dev/many/ | wc -l").stdout.trim(),
      );
    // More than the old cut of 5,000: every one arrives.
    fs.writeFileSync(path.join(sync, "refs.json"), JSON.stringify({ refs: many }));
    const fetched = inRootClone("git fetch --prune dev 2>&1");
    assert.equal(fetched.code, 0, fetched.stdout);
    assert.equal(countMany(), 6000, "control: a long list, whole");
    // Past the list's bound (4 MiB): the fetch fails, says which bound, and prunes nothing.
    fs.writeFileSync(
      path.join(sync, "refs.json"),
      JSON.stringify({ refs: { "many/b0": commit }, pad: "x".repeat(4 * 1024 * 1024) }),
    );
    const refused = inRootClone("git fetch --prune dev 2>&1");
    assert.notEqual(refused.code, 0, "a list that cannot be read whole fails the fetch");
    assert.match(
      refused.stdout,
      /acme\/widgets's list of branches \(refs\.json\) is \d+ bytes, over the 4194304 allowed/,
    );
    assert.equal(countMany(), 6000, "and no branch was pruned on it");
    // A bundle whose header (its list of refs) is past the same bound: refused as that.
    const saidOfHeader = outboxSaid(stack);
    fs.writeFileSync(path.join(sync, "refs.json"), JSON.stringify({ refs: many }));
    const line = `${commit} refs/heads/b\n`;
    fs.writeFileSync(
      path.join(sync, "zz-header.bundle"),
      `# v2 git bundle\n${line.repeat(Math.ceil((4 * 1024 * 1024) / line.length))}\nPACK`,
    );
    const header = inRootClone("git fetch dev 2>&1");
    const over =
      /was refused and dropped: its list of refs \(the bundle's header\) is \d+ bytes, over the 4194304 allowed/;
    assert.match(saidOfHeader(header, over), over);
    // Control: the list as the workspace wrote it, and the many branches it does not name
    // are pruned, as an honest list says.
    fs.writeFileSync(path.join(sync, "refs.json"), kept);
    assert.equal(inRootClone("git fetch --prune dev 2>&1").code, 0);
    assert.equal(countMany(), 0, "an honest list prunes what it does not name");
  });

  it("a person moves work between domains through the root: git push <domain> delivers", () => {
    stack.step("a delivery to another domain");
    assert.equal(stack.quiet("domain", "create", "other").code, 0);
    assert.equal(stack.quiet("domain", "other", "add", "--repo", "acme/widgets").code, 0);
    assert.equal(stack.quiet("up", "other", "--name", "w1").code, 0);
    const delivered = inRootClone(`git push other ${commit}:refs/heads/fix-from-dev 2>&1`);
    assert.equal(delivered.code, 0, delivered.stdout);
    // The workspace's daemon may import it first; either way it is there after a fetch.
    const got = stack.quiet("exec", "other/w1", "--", "desolate", "fetch", "acme/widgets");
    assert.equal(got.code, 0, got.stderr);
    const there = inWs(
      "other/w1",
      "cd /workspaces/acme/widgets && git rev-parse refs/remotes/root/fix-from-dev && git branch --format='%(refname:short)'",
    );
    assert.equal(there.stdout.split("\n")[0], commit);
    assert.deepEqual(
      there.stdout.trim().split("\n").slice(1),
      ["main"],
      "it arrived as root/<branch>, not over a branch of the domain's own",
    );
    assert.equal(
      forgeRefs("acme/widgets")["fix-from-dev"],
      undefined,
      "a delivery is a local transfer: the remote was not written",
    );
  });

  it("a pushed branch whose pull request was merged is marked merged, once the mirror shows it", () => {
    stack.step("a pushed branch, squash-merged on the forge");
    const branchesOf = () =>
      JSON.parse(stack.quiet("branches", "dev", "--json").stdout) as {
        repo: string;
        branch: string;
        commit: string;
        landed: string | null;
      }[];
    const issue = () =>
      branchesOf().find((b) => b.repo === "acme/widgets" && b.branch === "issue/12");
    // The branch as it is now (the tests above added to it, and one wrote over the domain's
    // list of its branches: written again here), pushed by a person.
    inWs("dev/w1", `cd ${WT} && desolate sync >/dev/null`);
    const tip = (
      JSON.parse(stack.quiet("review", "dev", "acme/widgets", "issue/12", "--json").stdout) as {
        commit: string;
      }
    ).commit;
    const pushed = stack.person(
      "Type the branch name",
      "issue/12",
      "push",
      "dev",
      "acme/widgets",
      "issue/12",
      "--expect",
      tip,
    );
    assert.equal(pushed.code, 0, pushed.stdout);
    assert.equal(issue()?.commit, tip);
    assert.equal(issue()?.landed, null, "CONTROL: pushed, but not merged: not marked");
    stack.forge("squash-merge", "acme/widgets", "issue/12", "main");
    assert.equal(
      forgeRefs("acme/widgets")["issue/12"],
      undefined,
      "the forge deleted the branch, as GitHub does after a merge",
    );
    assert.equal(issue()?.landed, null, "the root has not looked yet");
    assert.equal(stack.quiet("fetch", "acme/widgets").code, 0);
    assert.equal(
      issue()?.landed,
      "main",
      "a squash merge counts: every file the branch changed is in main as it left it",
    );
    assert.match(
      stack.desolate("branches", "dev").stdout,
      /issue\/12 {2}[0-9a-f]{12}.* {2}merged into main/,
    );
    // A new commit on the branch is new work: not marked.
    inWs(
      "dev/w1",
      `cd ${WT} && echo after >> README.md && git commit -qam 'after the merge' && desolate sync >/dev/null`,
    );
    let now = issue();
    for (let waited = 0; now?.commit === tip && waited < 10_000; waited += 250) {
      spawnSync("sleep", ["0.25"]);
      now = issue();
    }
    assert.notEqual(now?.commit, tip, "the root sees the branch's new commit");
    assert.equal(now?.landed, null, "the branch moved on: no longer marked");
  });

  it("git in a workspace: a fetch gets what the remote has now; a push offers, and says nothing went out", () => {
    stack.step("git fetch and git push in a workspace");
    // Someone else pushes to the remote. A plain `git fetch` in the workspace sees it: the
    // root refreshes the mirror first (git-remote-desolate-mirror).
    const theirs = stack
      .forge("commit", "acme/widgets", "elsewhere", "THEIRS.md", "pushed by someone else\n")
      .trim();
    const fetched = inWs("dev/w1", `cd ${WT} && git fetch 2>&1 && git rev-parse origin/elsewhere`);
    assert.equal(fetched.stdout.trim().split("\n").pop(), theirs, fetched.stdout + fetched.stderr);
    // A push offers the branch, and is reported refused so no origin/<branch> appears.
    inWs(
      "dev/w1",
      `cd ${WT} && git switch -q -c pushed-here && echo more >> README.md && git commit -qam 'from git push'`,
    );
    const tip = inWs("dev/w1", `cd ${WT} && git rev-parse HEAD`).stdout.trim();
    // Recorded: what it says is what an agent (or a person pressing Sync) acts on.
    const gitPush = (...args: string[]) => {
      const r = stack.desolate(
        "exec",
        "dev/w1",
        "--checkout",
        "acme/widgets",
        "--",
        "git",
        "push",
        ...args,
      );
      return { code: r.code, said: r.stdout + r.stderr };
    };
    const pushed = gitPush("origin", "pushed-here");
    assert.notEqual(pushed.code, 0, "the push is not reported as done: nothing reached the remote");
    assert.match(pushed.said, /offered acme\/widgets pushed-here at [0-9a-f]{12}/);
    assert.match(pushed.said, /The offer is of this commit: after more commits, offer again/);
    assert.match(pushed.said, /git reports this push as rejected below, on purpose/);
    assert.match(
      pushed.said,
      /! \[remote rejected\] pushed-here -> pushed-here \(offered for review, not pushed: this is the expected result/,
    );
    assert.equal(
      inWs(
        "dev/w1",
        `cd ${WT} && git rev-parse --verify --quiet refs/remotes/origin/pushed-here`,
      ).stdout.trim(),
      "",
      "no origin/pushed-here",
    );
    // ...and its upstream is origin/pushed-here, so `git pull` gets it once pushed (it said
    // "no tracking information": dogfooding, 2026-11-21).
    assert.equal(
      inWs("dev/w1", `cd ${WT} && git config branch.pushed-here.merge`).stdout.trim(),
      "refs/heads/pushed-here",
    );
    const offers = JSON.parse(stack.quiet("offers", "dev", "--json").stdout) as {
      branch: string;
      commit: string;
    }[];
    assert.ok(
      offers.some((o) => o.branch === "pushed-here" && o.commit === tip),
      JSON.stringify(offers),
    );
    // As agents push a new branch: `git push -u origin HEAD`. HEAD is that branch, so it is
    // offered (refused until 2026-11-18: an agent's branch never reached the dashboard). Its
    // control: HEAD under another branch's name is still refused, since what is offered is a
    // branch itself.
    inWs(
      "dev/w1",
      `cd ${WT} && git switch -q -c by-head && git commit -q --allow-empty -m 'by head'`,
    );
    const byHead = inWs("dev/w1", `cd ${WT} && git push -u origin HEAD 2>&1`);
    assert.match(byHead.stdout, /offered acme\/widgets by-head at [0-9a-f]{12}/, byHead.stdout);
    const renamed = gitPush("origin", "HEAD:refs/heads/other-name");
    assert.match(renamed.said, /not offered: only a branch is offered, under its own name/);
    assert.doesNotMatch(
      renamed.said,
      /rejected below, on purpose/,
      "it was not the expected result",
    );
    // A branch desolate does not carry is refused by `desolate offer`, which says why: not as
    // the expected result. And what it says of a hostile name is printable (git's own lines
    // show the name as git has it).
    inWs("dev/w1", `cd ${WT} && git branch -q fix+plus && git branch -q $'bidi-\u202ename'`);
    const refused = gitPush("origin", "fix+plus");
    assert.match(refused.said, /'fix\+plus' is not a branch desolate will carry/);
    assert.match(refused.said, /not offered: desolate offer says why above, with its fix/);
    assert.doesNotMatch(refused.said, /rejected below, on purpose/);
    const hostile = inWs("dev/w1", `cd ${WT} && git push origin $'bidi-\u202ename' 2>&1`);
    const ours = hostile.stdout
      .split("\n")
      .filter((l) => /desolate|offer/.test(l) && !/->/.test(l));
    assert.ok(ours.length > 0, hostile.stdout);
    for (const line of ours)
      assert.doesNotMatch(line, /[\u0000-\u001f\u202e]/, JSON.stringify(line));
    inWs("dev/w1", `cd ${WT} && git branch -q -D fix+plus $'bidi-\u202ename'`);
    assert.equal(
      forgeRefs("acme/widgets")["pushed-here"],
      undefined,
      "and the remote has nothing of it",
    );
    // The person dismisses it: off "Needs you", the branch kept; offering it again brings it back.
    const dismissed = stack.quiet("offers", "dismiss", "dev", "acme/widgets", "pushed-here");
    assert.equal(dismissed.code, 0, dismissed.stderr);
    assert.match(dismissed.stdout, /no longer under "Needs you"/);
    assert.ok(
      !(JSON.parse(stack.quiet("offers", "dev", "--json").stdout) as { branch: string }[]).some(
        (o) => o.branch === "pushed-here",
      ),
      "gone from the offers",
    );
    assert.match(
      stack.quiet("branches", "dev").stdout,
      /pushed-here/,
      "the branch stays in the domain",
    );
    assert.notEqual(
      stack.quiet("offers", "dismiss", "dev", "acme/widgets", "pushed-here").code,
      0,
      "a second dismissal says there is nothing to dismiss",
    );
    inWs("dev/w1", `cd ${WT} && git push origin pushed-here 2>&1`);
    assert.ok(
      (JSON.parse(stack.quiet("offers", "dev", "--json").stdout) as { branch: string }[]).some(
        (o) => o.branch === "pushed-here",
      ),
      "offered again: back",
    );
    // The repository by its GitHub address (as suede's install, a package.json git dependency
    // or `git clone` names it): read from the domain's mirror, with no credential, even from
    // outside every checkout; and a push to it is an offer, not a push.
    const byAddress = inWs(
      "dev/w1",
      "cd /tmp && git ls-remote git@github.com:acme/widgets.git refs/heads/elsewhere && git ls-remote https://github.com/acme/widgets.git refs/heads/elsewhere",
    );
    assert.deepEqual(
      byAddress.stdout
        .trim()
        .split("\n")
        .map((l) => l.split("\t")[0]),
      [theirs, theirs],
      byAddress.stderr,
    );
    const control = inWs(
      "dev/w1",
      "cd /tmp && GIT_TERMINAL_PROMPT=0 git ls-remote https://github.com/acme/widgets-other.git 2>&1; echo exit=$?",
    );
    assert.match(
      control.stdout,
      /exit=[1-9]/,
      "control: a repository the domain does not hold is not rewritten (prefix matches stop at .git)",
    );
    // A delete of a branch the remote has is refused, saying where branches are deleted.
    assert.match(
      gitPush("origin", ":elsewhere").said,
      /not deleted: a workspace changes nothing on the remote; the person deletes branches there/,
    );
    assert.equal(forgeRefs("acme/widgets")["elsewhere"], theirs, "and it is still there");
    // With git-lfs's own pre-push hook (`git lfs install` adds it), an LFS file's push is
    // offered with its object: the hook's upload goes to an agent that sends nothing
    // (desolate-lfs-offer). Control: aimed at the mirror, as before, it fails the push.
    const hooks = "/workspaces/acme/widgets/.git/hooks";
    inWs(
      "dev/w1",
      `cd ${WT} && git lfs update --force && git switch -q --no-track -c lfs/hooked origin/main && git lfs track '*.bin' >/dev/null && head -c 20000 /dev/urandom > hooked.bin && git add .gitattributes hooked.bin && git commit -qm hooked`,
    );
    const aimed = inWs(
      "dev/w1",
      `cd ${WT} && git -c lfs.pushurl=file:///desolate/mirrors/acme/widgets.git push origin lfs/hooked 2>&1`,
    );
    assert.match(aimed.stdout, /error trying to create local storage directory/, aimed.stdout);
    const hooked = inWs("dev/w1", `cd ${WT} && git push origin lfs/hooked 2>&1`);
    inWs(
      "dev/w1",
      `rm -f ${hooks}/pre-push ${hooks}/post-checkout ${hooks}/post-commit ${hooks}/post-merge`,
    );
    assert.match(
      hooked.stdout,
      /offered acme\/widgets lfs\/hooked at [0-9a-f]{12}, with 1 LFS object\(s\)/,
      hooked.stdout,
    );
  });

  it("desolate offer --check says whether the branch as it is now is offered: not, yes, moved, yes again", () => {
    stack.step("desolate offer --check");
    const inCheckout = (...argv: string[]) =>
      stack.desolate("exec", "dev/w1", "--checkout", "acme/widgets", "--", "desolate", ...argv);
    inWs(
      "dev/w1",
      `cd ${WT} && git switch -q --no-track -c checked origin/main && git commit -q --allow-empty -m 'to check'`,
    );
    const not = inCheckout("offer", "--check");
    assert.equal(not.code, 1, not.stdout + not.stderr);
    assert.match(not.stdout, /^acme\/widgets checked is not offered: desolate offer$/m);
    assert.equal(inCheckout("offer").code, 0);
    // How long the root took to say so in the inbox, after it took the offer: `desolate offer`
    // waits that long (its offers.json written, then the state service's publish).
    const at = stack
      .inRoot(
        [
          "sh",
          "-c",
          "date -r /desolate/domains/dev/offers.json +%s%N; date -r /desolate/domains/dev/inbox/domain.json +%s%N",
        ],
        { root: true },
      )
      .stdout.trim()
      .split("\n")
      .map(Number);
    const window = Math.round((at[1]! - at[0]!) / 1e6);
    console.log(`offer --check: the inbox showed the offer ${window} ms after the root took it`);
    assert.ok(window >= 0 && window < 12_000, String(window));
    const yes = inCheckout("offer", "--check");
    assert.equal(yes.code, 0, "straight after `desolate offer` returns: " + yes.stdout);
    assert.match(
      yes.stdout,
      /^acme\/widgets checked is offered at [0-9a-f]{12}: it is with the person for review$/m,
    );
    inWs("dev/w1", `cd ${WT} && git commit -q --allow-empty -m 'after the offer'`);
    const moved = inCheckout("offer", "--check");
    assert.equal(moved.code, 79, moved.stdout + moved.stderr);
    const [, was, now] =
      /^acme\/widgets checked was offered at ([0-9a-f]{12}); the branch is at ([0-9a-f]{12}) now, which is not offered: offer again \(desolate offer\)$/m.exec(
        moved.stdout,
      ) ?? [];
    assert.ok(was && now && was !== now, moved.stdout);
    assert.equal(inCheckout("offer").code, 0);
    const again = inCheckout("offer", "--check");
    assert.equal(again.code, 0, again.stdout);
    assert.match(again.stdout, new RegExp(`offered at ${now}: it is with the person`));
  });

  it("an offer of more LFS objects than the old cap of 2,000 is taken whole, and reviewed whole", () => {
    stack.step("an offer of 2,001 LFS objects");
    // (Before, the root took the first 2,000 an offer named and then found the commits
    // pointing at one it did not have: refused, and "offer again" refused it again. The
    // control is the first offer here, of one object, taken the same way.)
    const work = inWs(
      "dev/w1",
      `cd ${WT} && git fetch -q && git switch -q -c lfs/many origin/main && mkdir many && for i in $(seq 1 2001); do echo "object $i" > many/$i.bin; done && git add many && git commit -qm 'many LFS objects' && git rev-parse HEAD`,
    );
    assert.equal(work.code, 0, work.stderr);
    const tip = work.stdout.trim().split("\n").pop()!;
    const offered = stack.desolate(
      "exec",
      "dev/w1",
      "--checkout",
      "acme/widgets",
      "--",
      "desolate",
      "offer",
    );
    assert.equal(offered.code, 0, offered.stdout + offered.stderr);
    assert.match(
      offered.stdout,
      /offered acme\/widgets lfs\/many at [0-9a-f]{12}, with 2001 LFS object\(s\)/,
    );
    const offers = JSON.parse(stack.quiet("offers", "dev", "--json").stdout) as {
      branch: string;
      commit: string;
      lfs: number;
    }[];
    assert.deepEqual(
      offers.filter((o) => o.branch === "lfs/many").map((o) => [o.commit, o.lfs]),
      [[tip, 2001]],
      "the root took it, with every object",
    );
    const review = JSON.parse(
      stack.quiet("review", "dev", "acme/widgets", "lfs/many", "--json").stdout,
    ) as { lfsObjects: number; changes: { total: number }; commits: { total: number } };
    assert.deepEqual(
      [review.lfsObjects, review.changes.total, review.commits.total],
      [2001, 2001, 1],
      "and the review counts every one",
    );
  });

  it("the transcript reads as reviewed", () => {
    stack.checkTranscript("t2-04-offers");
  });
});
