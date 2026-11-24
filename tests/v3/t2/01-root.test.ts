// T2 (fake backend). Phase 1: the root VM. Bootstrap from nothing, keys, the mirror with
// LFS, the root clone; and the exit criteria of move-to-vms.md section 13.4, phase 1.
// This tier proves no hypervisor boundary: see tests/v3/t3 for those.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { bootstrap, git, newStack } from "../lib/harness.ts";
import type { Stack } from "../lib/harness.ts";

const REPO = "acme/widgets";
let stack: Stack;

describe("T2 phase 1: the root VM", () => {
  before(() => {
    stack = newStack("root");
    stack.seed(REPO, (dir) => {
      git(dir, "lfs", "install", "--local");
      git(dir, "lfs", "track", "*.bin");
      fs.writeFileSync(path.join(dir, "big.bin"), Buffer.alloc(200_000, 7));
      fs.writeFileSync(path.join(dir, "README.md"), "# widgets\n");
      // Hostile content, for the root clone to ignore: an .lfsconfig that points LFS at
      // another repository, and a hooks directory that announces itself if it ever runs.
      fs.writeFileSync(
        path.join(dir, ".lfsconfig"),
        "[lfs]\n\turl = ssh://git@elsewhere.invalid/evil/target.git\n",
      );
      fs.mkdirSync(path.join(dir, "hooks"));
      for (const hook of ["post-checkout", "pre-commit", "post-commit", "pre-push"])
        fs.writeFileSync(
          path.join(dir, "hooks", hook),
          "#!/bin/sh\necho RAN >> /tmp/hostile-hook-ran\n",
          { mode: 0o755 },
        );
      git(dir, "add", "-A");
      git(dir, "commit", "--quiet", "-m", "seed");
    });
  });
  after(() => stack.destroy());

  it("bootstrap: one command from an empty home to a working stack", () => {
    stack.step("bootstrap from nothing");
    assert.equal(fs.existsSync(stack.home), false, "the home must not exist before bootstrap");
    const first = bootstrap(stack);
    assert.equal(first.code, 0, first.stderr + first.stdout);
    assert.match(first.stdout, /NOT ISOLATED/, "the fake backend must say what it is");
    assert.match(first.stdout, /doctor: all checks passed/);
  });

  it("bootstrap is idempotent: the second run changes nothing and says so", () => {
    stack.step("bootstrap again");
    const second = bootstrap(stack);
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /nothing changed/);
    assert.doesNotMatch(second.stdout, /^ {2}\+ /m, "no step may report a change");
  });

  it("doctor fails on the fake backend outside a test run", () => {
    stack.step("doctor, outside a test run");
    const env = { ...stack.env };
    delete env.DESOLATE_TEST_RUN;
    const saved = stack.env.DESOLATE_TEST_RUN;
    delete stack.env.DESOLATE_TEST_RUN;
    const result = stack.desolate("doctor");
    stack.env.DESOLATE_TEST_RUN = saved;
    assert.equal(result.code, 1);
    assert.match(result.stdout, /FAIL backend gives isolation/);
    assert.match(result.stdout, /fix: /);
  });

  it("the fake backend runs only when the test run loads it into this command", () => {
    stack.step("the fake backend is never a default");
    const saved = stack.env.NODE_OPTIONS;
    delete stack.env.NODE_OPTIONS;
    const result = stack.desolate("repos");
    stack.env.NODE_OPTIONS = saved;
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /gives no isolation/);
  });

  it("clone: a read key, a write key, the mirror with its LFS object, the root clone", () => {
    stack.step("clone a pushable repository");
    const result = stack.desolate("clone", REPO);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /read key: registered/);
    assert.match(result.stdout, /write key: registered/);
    assert.match(result.stdout, /1 LFS object/);
    const mirror = path.join(stack.home, "mirrors", "acme", "widgets.git");
    assert.ok(fs.existsSync(path.join(mirror, "HEAD")), "the mirror exists on the host's disk");
    const clone = path.join(stack.home, "root", "acme", "widgets");
    assert.equal(
      fs.readFileSync(path.join(clone, "big.bin")).length,
      200_000,
      "the LFS file is checked out in the root clone, from the mirror",
    );
    assert.equal(
      fs.readFileSync(path.join(clone, ".git", "objects", "info", "alternates"), "utf8").trim(),
      "/desolate/mirrors/acme/widgets.git/objects",
    );
  });

  it("the fetch used the read key alone; the write key was never used", () => {
    const access = JSON.parse(stack.forge("access")) as {
      key?: string;
      command?: string;
      verdict: string;
    }[];
    const used = new Set(access.filter((entry) => entry.key).map((entry) => entry.key));
    assert.deepEqual(
      [...used],
      ["read:acme/widgets"],
      "only the read key may appear in the forge's log",
    );
    assert.ok(access.some((entry) => /git-upload-pack/.test(entry.command ?? "")));
    assert.ok(access.some((entry) => /git-lfs-authenticate .* download/.test(entry.command ?? "")));
  });

  it("a second fetch works, and still needs nothing but the read key", () => {
    stack.step("fetch");
    const result = stack.desolate("fetch", REPO);
    assert.equal(result.code, 0, result.stderr);
    const audit = stack.inRoot(
      ["node", "--disable-warning=ExperimentalWarning", "/desolate/release/root/rootctl.ts"],
      { input: JSON.stringify({ op: "keys.audit", args: {} }) },
    );
    const entries = JSON.parse(audit.stdout).result as { event: string; role?: string }[];
    assert.equal(
      entries.filter((entry) => entry.event === "signed" || entry.event === "refused").length,
      0,
      "no write-key signature was asked for by a fetch",
    );
  });

  it("the fetch lock is held by a live fetch, not by its age: a dead holder's is taken at once, a live one's is waited for", () => {
    // (Not recorded: the holder's pid and time are in what is said.)
    const lock = "/var/lib/desolate/fetch-locks/acme--widgets";
    const holder = (pid: number) =>
      JSON.stringify({
        id: "f".repeat(32),
        pid,
        host: "root",
        since: "2026-01-01T00:00:00.000Z",
        start: null,
      });
    const leave = (pid: number) =>
      stack.inRoot([
        "bash",
        "-c",
        `mkdir -p ${lock} && printf '%s' '${holder(pid)}' > ${lock}/holder`,
      ]);
    // A holder that is gone (no process has this pid): taken at once, whatever its age.
    assert.equal(leave(4_194_000).code, 0);
    const dead = stack.quiet("fetch", REPO);
    assert.equal(dead.code, 0, dead.stderr);
    assert.doesNotMatch(
      dead.stderr,
      /waiting for another fetch/,
      "a dead holder is not waited for",
    );
    // One that lives (a process in the root, which ends in a few seconds): waited for, said,
    // and taken when it ends.
    const sleeper = stack.inRoot(["bash", "-c", "sleep 6 >/dev/null 2>&1 </dev/null & echo $!"]);
    const pid = Number(sleeper.stdout.trim());
    assert.ok(pid > 1, sleeper.stdout + sleeper.stderr);
    assert.equal(leave(pid).code, 0);
    const started = Date.now();
    const live = stack.quiet("fetch", REPO);
    assert.equal(live.code, 0, live.stderr);
    assert.match(
      live.stderr,
      new RegExp(
        `waiting for another fetch of acme/widgets to finish \\(process ${pid}, since 2026-01-01T00:00:00.000Z\\)`,
      ),
    );
    assert.ok(Date.now() - started > 3000, "it waited for the holder, and did not take its lock");
    assert.equal(stack.inRoot(["test", "-e", lock]).code, 1, "and left none behind");
  });

  it("the read key cannot push, and neither key works for another repository", () => {
    // Control first: the same ssh command, for what the key IS allowed, succeeds.
    const ssh = (role: string, command: string) =>
      stack.inRoot([
        "bash",
        "-c",
        `ssh -F /dev/null -o IdentityAgent=/run/desolate/keyring/${role}-agent.sock -o IdentityFile=/run/desolate/keyring/pub/acme/widgets/${role}.pub -o IdentitiesOnly=yes -o BatchMode=yes -o UserKnownHostsFile=/var/lib/desolate/known_hosts -p 22 git@$(jq -r .ssh.host /var/lib/desolate/forge.json) "${command}"`,
      ]);
    assert.equal(
      ssh("read", "git-lfs-authenticate acme/widgets.git download").code,
      0,
      "control: the read key authenticates an LFS download",
    );
    const upload = ssh("read", "git-lfs-authenticate acme/widgets.git upload");
    assert.notEqual(upload.code, 0);
    assert.match(upload.stderr, /read-only/);
    const other = ssh("read", "git-upload-pack 'acme/other.git'");
    assert.notEqual(other.code, 0);
    assert.match(other.stderr, /this deploy key is for acme\/widgets/);
    // The write key signs nothing without a person's approval: the agent refuses.
    const write = ssh("write", "git-lfs-authenticate acme/widgets.git upload");
    assert.notEqual(
      write.code,
      0,
      "a write-key signature with no approval on file must be refused",
    );
  });

  it("keys are never readable from outside the keyring: a test that tries", () => {
    stack.step("try to read a private key");
    // Control: the key files exist, and root in the VM can see them, so the paths are right.
    const control = stack.inRoot(
      ["bash", "-c", "ls /var/lib/desolate-root/keyring/acme/widgets/"],
      { root: true },
    );
    assert.match(control.stdout, /^read$/m, "control: the read key is where the test looks");
    assert.match(control.stdout, /^write$/m);
    const attempts: [string, string[]][] = [
      ["cat the key", ["cat", "/var/lib/desolate-root/keyring/acme/widgets/write"]],
      ["list the key directory", ["ls", "/var/lib/desolate-root/keyring"]],
      ["copy it", ["cp", "/var/lib/desolate-root/keyring/acme/widgets/read", "/tmp/stolen"]],
      [
        "connect to the approvals socket",
        [
          "bash",
          "-c",
          'echo \'{"op":"approve","repo":"acme/widgets","ref":"main","commit":"0000000000000000000000000000000000000000"}\' | socat - UNIX-CONNECT:/run/desolate/keyring/internal.sock',
        ],
      ],
      [
        "sudo to the keyring's user",
        [
          "sudo",
          "-n",
          "-u",
          "desolate-keyring",
          "cat",
          "/var/lib/desolate-root/keyring/acme/widgets/write",
        ],
      ],
      ["sudo to root", ["sudo", "-n", "cat", "/var/lib/desolate-root/keyring/acme/widgets/write"]],
    ];
    for (const [what, argv] of attempts) {
      const result = stack.inRoot(argv);
      assert.notEqual(result.code, 0, `${what} must fail for the root's own user`);
      assert.doesNotMatch(result.stdout, /OPENSSH PRIVATE KEY/, what);
    }
    // The control socket answers, and has no operation that returns a private key.
    for (const op of ["export", "read", "private", "dump"]) {
      const result = stack.inRoot([
        "bash",
        "-c",
        `echo '{"op":"${op}","repo":"acme/widgets","role":"write"}' | socat - UNIX-CONNECT:/run/desolate/keyring/control.sock`,
      ]);
      assert.match(result.stdout, /"ok":false/, `the control socket must refuse '${op}'`);
      assert.doesNotMatch(result.stdout, /PRIVATE KEY/);
    }
    // Nothing on the host's side of any share holds a key.
    const walk = (dir: string): string[] =>
      fs
        .readdirSync(dir, { withFileTypes: true })
        .flatMap((entry) =>
          entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)],
        );
    for (const file of walk(stack.home)) {
      if (fs.statSync(file).size > 10_000) continue;
      if (!fs.lstatSync(file).isFile()) continue; // a socket (the host daemon's) holds nothing to read
      assert.doesNotMatch(
        fs.readFileSync(file, "utf8"),
        /BEGIN OPENSSH PRIVATE KEY/,
        `${file} holds a private key`,
      );
    }
  });

  it("the root's own user cannot become root: no sudo, and no link in its directory that root's start-up follows", () => {
    stack.step("the root's own user against root");
    // It runs everything that reads a domain's data, so this is what a bug in a proxy or in
    // git would have. Control: root itself can do what the user is refused.
    assert.equal(
      stack.inRoot(["sudo", "-n", "true"]).code === 0,
      false,
      "sudo is refused to the root's own user",
    );
    assert.equal(
      stack.inRoot(["stat", "-c", "%U", "/usr/local/bin"], { root: true }).stdout.trim(),
      "root",
      "control: /usr/local/bin is root's",
    );
    // The user owns /var/lib/desolate, so it can replace any name there with a link. Before,
    // root's start-up ran `install -d -o <user>` on such names and gave the user what the
    // link named. Plant links where start-up looks, run it again, and see what moved.
    const planted = stack.inRoot([
      "bash",
      "-c",
      "cd /var/lib/desolate && mv approvals approvals.kept && ln -s /usr/local/bin approvals && rm -rf push-locks && ln -s /etc/desolate push-locks && ln -s /etc/profile.d hooks && echo planted",
    ]);
    assert.match(planted.stdout, /planted/, planted.stderr);
    // Start-up may refuse (the user broke its own directory): that is failing closed.
    // What it must not do is act on root's directories.
    bootstrap(stack);
    const after = stack.inRoot(
      ["stat", "-c", "%U %a %n", "/usr/local/bin", "/etc/desolate", "/etc/profile.d"],
      { root: true },
    ).stdout;
    stack.inRoot([
      "bash",
      "-c",
      "cd /var/lib/desolate && rm -f approvals push-locks hooks && mv approvals.kept approvals && mkdir -p push-locks",
    ]);
    assert.match(
      after,
      /^root 755 \/usr\/local\/bin\nroot 755 \/etc\/desolate\nroot 755 \/etc\/profile\.d\n$/,
      "root's directories stayed root's",
    );
    const again = bootstrap(stack);
    assert.equal(again.code, 0, again.stderr + again.stdout.slice(-800));
    assert.match(again.stdout, /ok {3}root: the root's own user cannot become root/);
    assert.match(again.stdout, /ok {3}root: git's settings are root's/);
  });

  it("the root's git on a root clone ignores a hostile .lfsconfig and a hostile hooks directory", () => {
    stack.step("hostile content in the root clone");
    const clone = "/desolate/root/acme/widgets";
    const run = (script: string) =>
      stack.inRoot([
        "bash",
        "-c",
        `cd ${clone} && export GIT_CONFIG_GLOBAL=/var/lib/desolate-root/gitconfig && ${script}`,
      ]);
    // Control: the hostile files are really in the checkout.
    assert.equal(
      run("test -f .lfsconfig && test -x hooks/pre-commit").code,
      0,
      "control: the hostile content is checked out",
    );
    // .lfsconfig: content says elsewhere.invalid; git-lfs must use the mirror.
    const lfsEnv = run("git lfs env");
    assert.match(lfsEnv.stdout, /Endpoint=file:\/\/\/desolate\/mirrors\/acme\/widgets\.git/);
    assert.doesNotMatch(lfsEnv.stdout, /elsewhere\.invalid/);
    // Control for that: with the pin removed, git-lfs DOES follow the content's .lfsconfig,
    // so the pin is what protects (the measurement the spec cites).
    const unpinned = run(
      "git -c lfs.url= lfs env 2>/dev/null; cp -r . /tmp/unpinned && cd /tmp/unpinned && git config --unset lfs.url && git lfs env",
    );
    assert.match(
      unpinned.stdout,
      /Endpoint=.*elsewhere\.invalid/,
      "control: without the pin, the hostile .lfsconfig wins",
    );
    // Hooks: commit, checkout and a refused push; none of the content's hooks may run.
    const work = run(
      "git checkout -q -b probe && echo x >> README.md && git commit -q -am probe && git checkout -q main && git checkout -q probe; test ! -e /tmp/hostile-hook-ran",
    );
    assert.equal(work.code, 0, `a hook from the repository's content ran: ${work.stderr}`);
    assert.equal(run("git config core.hooksPath").stdout.trim(), "/var/lib/desolate-root/hooks");
    // Control for that: the same hooks DO run when a clone points core.hooksPath at them.
    const controlRun = run(
      "cd /tmp/unpinned && git config core.hooksPath hooks && echo y >> README.md && git commit -q -am control; test -e /tmp/hostile-hook-ran",
    );
    assert.equal(
      controlRun.code,
      0,
      "control: the hostile hooks do fire when a clone is configured to run them",
    );
    // The hooks directory itself is not writable by the root's user.
    assert.notEqual(run("touch /var/lib/desolate-root/hooks/post-checkout").code, 0);
  });

  it("clone --no-push makes no write key", () => {
    stack.step("clone a repository to consume only");
    stack.seed("acme/consumer", (dir) => {
      fs.writeFileSync(path.join(dir, "README.md"), "# consumer\n");
      git(dir, "add", "-A");
      git(dir, "commit", "--quiet", "-m", "seed");
    });
    const result = stack.desolate("clone", "acme/consumer", "--no-push");
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /write key: registered/);
    const list = JSON.parse(stack.desolate("repos", "--json").stdout) as {
      repo: string;
      pushable: boolean;
    }[];
    assert.deepEqual(
      list.map((r) => [r.repo, r.pushable]),
      [
        ["acme/consumer", false],
        ["acme/widgets", true],
      ],
    );
    const keys = stack.inRoot(["bash", "-c", "ls /var/lib/desolate-root/keyring/acme/consumer/"], {
      root: true,
    });
    assert.doesNotMatch(keys.stdout, /write/, "no write key exists for it anywhere");
  });

  it("clone makes each repository a domain, owner--repo, once, and --domain or --no-domain choose", () => {
    stack.step("clone: the domain it makes");
    const domains = () =>
      (
        JSON.parse(stack.desolate("list", "--json").stdout) as { domain: string; repos: string[] }[]
      ).map((d) => [d.domain, d.repos.join(",")]);
    assert.deepEqual(
      domains(),
      [
        ["acme--consumer", "acme/consumer"],
        ["acme--widgets", "acme/widgets"],
      ],
      "each clone above made a domain named owner--repo",
    );
    const again = stack.desolate("clone", REPO);
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /domain acme--widgets: already holds acme\/widgets/);
    // Another owner's repository of the same name: a domain of its own.
    for (const repo of ["other/widgets", "acme/lib", "acme/loose"])
      stack.seed(repo, (dir) => {
        fs.writeFileSync(path.join(dir, "README.md"), `# ${repo}\n`);
        git(dir, "add", "-A");
        git(dir, "commit", "--quiet", "-m", "seed");
      });
    assert.match(
      stack.desolate("clone", "other/widgets", "--no-push").stdout,
      /domain other--widgets: made for other\/widgets/,
    );
    assert.match(
      stack.desolate("clone", "acme/lib", "--no-push", "--domain", "acme--widgets").stdout,
      /domain acme--widgets: acme\/lib added/,
    );
    const loose = stack.desolate("clone", "acme/loose", "--no-push", "--no-domain");
    assert.equal(loose.code, 0, loose.stderr);
    assert.match(loose.stdout, /next: desolate domain create <slug> --repo acme\/loose/);
    assert.deepEqual(domains(), [
      ["acme--consumer", "acme/consumer"],
      ["acme--widgets", "acme/lib,acme/widgets"],
      ["other--widgets", "other/widgets"],
    ]);
    const both = stack.desolate("clone", "acme/loose", "--domain", "x", "--no-domain");
    assert.notEqual(both.code, 0, "--domain and --no-domain together are refused");
    // Put back as the later tests expect: only the two domains of the first clones.
    for (const slug of ["other--widgets"]) assert.equal(stack.desolate("rm", slug).code, 0);
  });

  it("keys: which the root holds, and public halves only", () => {
    stack.step("keys");
    const held = stack.desolate("keys");
    assert.match(
      held.stdout,
      /acme\/widgets {2}read\nacme\/widgets {2}write {2}\(asks you before every push\)/,
    );
    const shown = stack.desolate("keys", "acme/widgets");
    assert.equal(shown.code, 0, shown.stderr);
    assert.match(
      shown.stdout,
      /read key \(a deploy key, read-only\):\n {2}ssh-ed25519 \S+ desolate-read:acme\/widgets/,
    );
    assert.doesNotMatch(shown.stdout, /PRIVATE/);
  });

  it("a refusal names what to do", () => {
    stack.step("refusals");
    const result = stack.desolate("fetch", "acme/never-cloned");
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /fix: desolate clone acme\/never-cloned/);
    const usage = stack.desolate("frobnicate");
    assert.equal(usage.code, 64);
    assert.match(usage.stderr, /fix: desolate help/);
  });

  it("a call to the root that keeps saying what it does is never given up; one that falls silent is (limits R4)", () => {
    stack.step("patience: a slow root that says what it is doing, and one that says nothing");
    // A stand-in for the root's CLI service, at its socket: it answers `repo.fetch` slowly,
    // and hands every other request to the real service (moved aside for the test). The
    // host may hear nothing for 3 seconds (the setting): the slow fetch takes 6, and says
    // what it is doing each second; the silent one says nothing for ten minutes, and the
    // call must end at the host's 3 seconds, not when the root finishes.
    const dir = "/run/desolate/rootctl";
    const standIn = (silent: boolean) =>
      [
        "IFS= read -r line",
        `case "$line" in *'"repo.fetch"'*) ;; *) { printf '%s\\n' "$line"; cat; } | socat - UNIX-CONNECT:${dir}/rootctl.sock.real; exit ;; esac`,
        `echo '{"accepted":true}'`,
        silent
          ? "sleep 600"
          : `for i in 1 2 3 4 5 6; do sleep 1; echo "{\\"progress\\":\\"still fetching: $i of 6\\"}"; done`,
        `echo '{"reply":{"ok":true,"result":{"branches":1,"lfsObjects":1}}}'`,
      ].join("\n") + "\n";
    const serve = (silent: boolean) => {
      const put = stack.inRoot(["bash", "-c", "cat >/tmp/stand-in.sh"], { input: standIn(silent) });
      assert.equal(put.code, 0, put.stderr);
      const started = stack.inRoot([
        "bash",
        "-c",
        `cd ${dir} && { [ -e rootctl.sock.real ] || mv rootctl.sock rootctl.sock.real; } && rm -f rootctl.sock && (setsid socat UNIX-LISTEN:rootctl.sock,fork,mode=600 EXEC:'bash /tmp/stand-in.sh' </dev/null >/dev/null 2>&1 & echo $! >/tmp/stand-in.pid) && for i in $(seq 50); do [ -S rootctl.sock ] && exit 0; sleep 0.1; done; exit 1`,
      ]);
      assert.equal(started.code, 0, started.stderr);
    };
    const unserve = () =>
      stack.inRoot([
        "bash",
        "-c",
        `kill $(cat /tmp/stand-in.pid) 2>/dev/null; pkill -f 'bash /tmp/stand-in[.]sh'; cd ${dir} && if [ -e rootctl.sock.real ]; then rm -f rootctl.sock && mv rootctl.sock.real rootctl.sock; fi`,
      ]);
    stack.env.DESOLATE_ROOT_SILENT_SECONDS = "3";
    try {
      serve(false);
      const slow = stack.desolate("fetch", "acme/widgets");
      unserve();
      assert.equal(slow.code, 0, slow.stderr);
      assert.match(slow.stderr, /still fetching: 6 of 6/);
      assert.match(slow.stdout, /fetched acme\/widgets/);
      serve(true);
      const silent = stack.desolate("fetch", "acme/widgets");
      unserve();
      assert.notEqual(silent.code, 0);
      assert.ok(silent.ms < 60_000, `given up after ${silent.ms} ms, not at the silence`);
      assert.match(silent.stderr, /the root said nothing for 3 seconds while asked 'repo\.fetch'/);
      assert.match(silent.stderr, /root\.silentSeconds/);
    } finally {
      delete stack.env.DESOLATE_ROOT_SILENT_SECONDS;
      unserve();
    }
    // The control: the real service again, and the setting as it was; its socket is back
    // (not only the old way, which a call would also fall back to).
    const real = stack.desolate("fetch", "acme/widgets");
    assert.equal(real.code, 0, real.stderr);
    const socket = stack.inRoot(["test", "-S", `${dir}/rootctl.sock`]);
    assert.equal(socket.code, 0, "the root's CLI service has its socket again");
  });

  it("the transcript reads as reviewed", () => {
    stack.checkTranscript("t2-01-root");
  });
});
