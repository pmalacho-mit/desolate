// T2 (fake backend). Phase 5: offers and pushes, and the root's view of every domain.
// Exit criteria of move-to-vms.md section 13.4, phase 5 (all but `upstream`).
import assert from "node:assert/strict";
import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { request as httpRequest } from "node:http";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { bootstrap, git, newStack } from "../lib/harness.ts";
import type { Stack } from "../lib/harness.ts";
import { findChrome, loadPage } from "../lib/browser.ts";
import { signedFor } from "../../../release/shared/approval.ts";

let stack: Stack;
let commit = "";
let oid = "";
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
/** What desolate's reviewer says a push sends, asked as the host asks it: as root. */
const reviewerSays = (branch: string, commit: string, onto: string | null = null) =>
  JSON.parse(
    stack.inRoot(
      ["node", "--disable-warning=ExperimentalWarning", "/desolate/release/root/review-ask.ts"],
      { root: true, input: JSON.stringify({ repo: "acme/widgets", branch, commit, onto }) },
    ).stdout,
  ) as {
    ok: boolean;
    error?: string;
    sends?: { pack: string; size: number; lfs: string[] };
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
  socket.on("data", (c) => { answer += c; if (answer.includes("\\n")) { console.log(answer.split("\\n")[0]); process.exit(0); } });
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
    ) as { commit: string; files: string[]; pushable: boolean };
    assert.equal(json.commit, commit);
    assert.deepEqual(json.files.sort(), ["README.md", "new.bin"]);
  });

  it("a push is impossible without a person: every automation path is tried, and refused", () => {
    stack.step("automation tries to push");
    // 1. The CLI, driven by a script: no terminal.
    const cli = stack.desolate("push", "dev", "acme/widgets", "issue/12", "--expect", commit);
    assert.equal(cli.code, 78);
    assert.match(cli.stderr, /there is no terminal to ask on/);
    assert.match(cli.stderr, /no person confirmed the push, so nothing was pushed/);
    // 2. Raw git in the root clone: it asks for an approval on the host, none comes, it gives up.
    const raw = inRootClone(
      `DESOLATE_APPROVAL_WAIT_MS=1500 git push origin ${commit}:refs/heads/issue/12 2>&1`,
    );
    assert.notEqual(raw.code, 0);
    assert.match(raw.stdout, /needs your approval, given on the host, outside every VM/);
    assert.match(raw.stdout, /no person approved the push on the host, so nothing was pushed/);
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
    assert.deepEqual(said.sends!.lfs, [oid], "the reviewer lists the commit's LFS object");
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
    const ownPack = toPusher(real.id!, "/tmp/own.pack", [], said.sends!.lfs);
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
      [...said.sends!.lfs, planted],
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
      saidControl.sends!.lfs,
    );
    assert.equal(control.ok, true, String(control.error));
    assert.equal(
      forgeRefs("acme/widgets")["f6-control"],
      controlCommit,
      "control: the approved pack lands",
    );
    assert.equal(forgeHasLfs("acme/widgets", oid), true, "with its LFS object");
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
    const said = reviewerSays("squash-me", tip) as ReturnType<typeof reviewerSays> & {
      between?: { path: string }[];
      squash?: { commit: string; count: number; message: string };
      files?: { path: string }[];
    };
    assert.equal(said.ok, true, String(said.error));
    assert.deepEqual(
      said.files?.map((f) => f.path),
      ["README.md"],
      "the net change: README alone",
    );
    assert.deepEqual(
      said.between?.map((f) => f.path),
      ["notes.txt"],
      "and what was changed in between",
    );
    assert.equal(said.squash?.count, 2);
    assert.equal(
      said.squash?.message,
      "add notes\n\nSquashed from 2 commits:\n- add notes\n- tidy up\n",
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
      /2 commit\(s\) squashed into one\. The workspace's squash-me keeps its own commits/,
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
    assert.match(unasked.stderr, /this push REPLACES the remote's squash-me/);
    assert.match(unasked.stderr, /--replace/);
    assert.equal(forgeRefs("acme/widgets")["squash-me"], remote, "nothing was signed or pushed");
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
    assert.equal(forgeRefs("acme/widgets")["squash-me"], remote);
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
      waiting = /waiting up to/.test(inRootClone("cat /tmp/raw-push.log").stdout);
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
      /repository {2}acme\/widgets\s+branch {6}raw-push\s+commit {6}[0-9a-f]{40}\s+onto {8}none: the remote has no raw-push yet\s+pack {8}[0-9a-f]{16} {2}\(made by desolate's reviewer: nothing else is sent\)\s+LFS {9}\d+ object\(s\), only those its commits point to\s+sends {7}\d+ commit\(s\) the remote does not have, \d+ file\(s\)(, \d+ of them LFS)?\s+\(desolate's reviewer, in the root\)/,
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
    const def = inRootClone(
      `DESOLATE_APPROVAL_WAIT_MS=1500 git push origin ${commit}:refs/heads/main 2>&1`,
    );
    assert.doesNotMatch(def.stdout, /default branch/);
    assert.match(def.stdout, /this push needs your approval[\s\S]*acme\/widgets {2}main/);
    assert.notEqual(forgeRefs("acme/widgets")["main"], commit, "unapproved: not pushed");
    assert.match(
      inRootClone("DESOLATE_APPROVAL_WAIT_MS=1500 git push origin :refs/heads/raw-push 2>&1")
        .stdout,
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
      summary: {
        ok: boolean;
        error?: string;
        commits?: { commit: string; subject: string }[];
        files?: { path: string }[];
      };
    };
    const waitingFor = async (branch: string) => {
      for (let i = 0; i < 120; i++) {
        const answer = await call("GET", "/pending", asPage);
        const found = (JSON.parse(answer.body) as { pending?: Waiting[] }).pending?.find(
          (p) => p.branch === branch,
        );
        // (The reviewer's account comes in the background: the page says it is coming.)
        if (found && !(found.summary as { waiting?: boolean }).waiting) return found;
        await sleep(250);
      }
      return null;
    };
    const act = (what: string, push: Waiting) =>
      call(
        "POST",
        `/${what}`,
        { ...asPage, origin: ORIGIN, "content-type": "application/json" },
        JSON.stringify({ nonce: push.nonce, token: push.token, commit: push.commit }),
      );

    inRootClone(
      `setsid nohup git push origin ${commit}:refs/heads/web-push >/tmp/web-push.log 2>&1 </dev/null & sleep 0.2`,
    );
    const push = await waitingFor("web-push");
    assert.ok(push, inRootClone("cat /tmp/web-push.log").stdout);
    assert.equal(push!.commit, commit);
    assert.equal(push!.onto, null, "a new branch");
    // What the reviewer says the push is: from commit ids the host gave it, and the forge.
    assert.equal(push!.summary.ok, true, String(push!.summary.error));
    // The commit reached the remote above (issue/12): nothing new to list, from the forge's
    // own account; the files are against the remote's default branch.
    assert.deepEqual(
      push!.summary.commits,
      [],
      "the remote has every commit already, and the reviewer says so",
    );
    assert.ok(
      push!.summary.files!.some((f) => f.path === "big.bin" || f.path === "README.md"),
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
    assert.equal(large!.summary.ok, true, String(large!.summary.error).slice(0, 300));
    assert.deepEqual(
      large!.summary.commits!.map((c) => c.subject),
      ["a large file"],
    );
    assert.equal((await act("refuse", large!)).status, 200);
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
    fs.symlinkSync("/etc/passwd", path.join(sync, "zz-evil.bundle"));
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
    assert.match(
      lied.stdout,
      /2 file\(s\) in dev's outbox were not plain bundle files and were dropped|was refused and dropped/,
      lied.stdout,
    );
    assert.ok(
      !fs.existsSync(path.join(sync, "zz-evil.bundle")) &&
        fs.lstatSync(path.join(sync, "zz-evil.bundle"), { throwIfNoEntry: false }) === undefined,
      "the link itself is gone from the outbox",
    );
    assert.match(
      stack.inRoot(["bash", "-c", "head -c 5 /etc/passwd; stat -c %h /etc/passwd"], { root: true })
        .stdout,
      /^root:1\n$/,
      "and what it pointed at is as it was",
    );
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
    const pushed = inWs("dev/w1", `cd ${WT} && git push origin pushed-here 2>&1`);
    assert.notEqual(pushed.code, 0, "the push is not reported as done: nothing reached the remote");
    assert.match(pushed.stdout, /offered acme\/widgets pushed-here at [0-9a-f]{12}/);
    assert.match(pushed.stdout, /offered to the root, not pushed: nothing went to the remote/);
    assert.equal(
      inWs(
        "dev/w1",
        `cd ${WT} && git rev-parse --verify --quiet refs/remotes/origin/pushed-here`,
      ).stdout.trim(),
      "",
      "no origin/pushed-here",
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
    const renamed = inWs("dev/w1", `cd ${WT} && git push origin HEAD:refs/heads/other-name 2>&1`);
    assert.match(renamed.stdout, /push a branch by its own name/, renamed.stdout);
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
      inWs("dev/w1", `cd ${WT} && git push origin :elsewhere 2>&1`).stdout,
      /deleting a branch is not something a workspace does/,
    );
    assert.equal(forgeRefs("acme/widgets")["elsewhere"], theirs, "and it is still there");
  });

  it("the transcript reads as reviewed", () => {
    stack.checkTranscript("t2-04-offers");
  });
});
