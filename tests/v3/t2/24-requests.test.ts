// T2 (fake backend). The channel a workspace asks the root through (workspace/sync.ts asks,
// root/rootd.ts answers): `desolate fetch`, `offer`, `spawn`, `close`, `issue offer`, and a
// `git fetch` or `git push` in a workspace, which make the first two.
//
// What is claimed:
// - A request is taken, then waited on for as long as the root is there and on it: one the
//   root takes four minutes over (the forge is made slow) is answered, and says meanwhile what
//   the root is doing. (It gave up at two minutes, saying "Is it running?".)
// - Fetches asked of one repository while one runs are one more fetch, and do not refuse an
//   offer, or keep it waiting. (Thirty in a minute refused the domain's offer.)
// - A flood of requests from one domain does not slow another's: beside the control, the same
//   offer from the other domain with no flood; and the flooding domain's own offer waits
//   behind its flood (so the flood was real), and is answered, not refused.
// - A root that is down is said to be down within the beat's 10 s, and the request is
//   withdrawn; the same offer once it runs again is answered (the control).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { bootstrap, git, newStack } from "../lib/harness.ts";
import type { Stack } from "../lib/harness.ts";

let stack: Stack;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (probe: () => boolean, ms: number) => {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await sleep(1000))
    if (probe()) return true;
  return false;
};
/** A command in a workspace, in its checkout, as its agent would run it. */
const inside = (workspace: string, script: string) =>
  stack.quiet("exec", workspace, "--", "bash", "-c", script);
/** The same, left running in the workspace: its output and exit code go to /tmp/<name>.*. */
const started = (workspace: string, name: string, script: string) => {
  const ran = inside(
    workspace,
    `rm -f /tmp/${name}.*; setsid bash -c 's=$(date +%s); { ${script.replace(/'/g, "'\\''")}; } >/tmp/${name}.out 2>/tmp/${name}.err; echo "$? $(( $(date +%s) - s ))" >/tmp/${name}.done' </dev/null >/dev/null 2>&1 &`,
  );
  assert.equal(ran.code, 0, ran.stderr);
};
/** How one left running ended: its exit code and seconds, or null while it runs. */
const ended = (workspace: string, name: string) => {
  const done = inside(workspace, `cat /tmp/${name}.done 2>/dev/null`).stdout.trim();
  if (!done) return null;
  const [code, seconds] = done.split(" ").map(Number);
  return { code: code!, seconds: seconds!, err: inside(workspace, `cat /tmp/${name}.err`).stdout };
};
const forge = (script: string) =>
  spawnSync("docker", ["exec", "-u", "0:0", `dsl-forge-${stack.instance}`, "sh", "-c", script], {
    encoding: "utf8",
  });
const uploadPacks = (repo: string) =>
  forge("cat /forge-state/access.log")
    .stdout.split("\n")
    .filter((line) => line.includes(`git-upload-pack`) && line.includes(repo)).length;
/** A commit on the workspace's own branch, offered. */
const offer = (workspace: string, note: string) =>
  inside(
    workspace,
    `echo '${note}' >> notes.txt && git add notes.txt && git commit -qm '${note}' && desolate offer`,
  );

describe("T2 the request channel: taken, then waited on, and one domain never slows another", () => {
  before(() => {
    stack = newStack("requests");
    for (const repo of ["acme/widgets", "acme/gadgets"])
      stack.seed(repo, (dir) => {
        fs.writeFileSync(path.join(dir, "README.md"), `# ${repo}\n`);
        git(dir, "add", "-A");
        git(dir, "commit", "--quiet", "-m", "seed");
      });
    assert.equal(bootstrap(stack).code, 0);
    for (const repo of ["acme/widgets", "acme/gadgets"])
      assert.equal(stack.quiet("clone", repo, "--no-domain").code, 0);
    assert.equal(stack.quiet("domain", "create", "alpha", "--repo", "acme/widgets").code, 0);
    assert.equal(stack.quiet("domain", "create", "beta", "--repo", "acme/gadgets").code, 0);
    for (const [domain, name, branch] of [
      ["alpha", "a1", "task/a"],
      ["beta", "b1", "task/b"],
    ] as const) {
      const up = stack.quiet("up", domain, "--name", name, "--branch", branch);
      assert.equal(up.code, 0, up.stderr);
    }
    // Each is on its own branch, in its checkout.
    assert.equal(inside("alpha/a1", "git rev-parse --abbrev-ref HEAD").stdout.trim(), "task/a");
    assert.equal(inside("beta/b1", "git rev-parse --abbrev-ref HEAD").stdout.trim(), "task/b");
  });
  after(() => stack.destroy());

  it("a fetch the root takes four minutes over is answered; thirty more beside it are one fetch, and an offer is not kept waiting", async () => {
    // The forge's next git-upload-pack waits four minutes before it serves (once): git, at the
    // root, waiting on a slow remote, as a first fetch of a large repository does.
    const armed = forge(
      `mkdir -p /slow && chmod 777 /slow && echo 240 > /slow/armed && chmod 666 /slow/armed && printf '%s\\n' '#!/bin/sh' 'if mv /slow/armed /slow/used 2>/dev/null; then sleep "$(cat /slow/used)"; fi' 'exec /usr/bin/git-upload-pack "$@"' > /usr/local/bin/git-upload-pack && chmod 755 /usr/local/bin/git-upload-pack`,
    );
    assert.equal(armed.status, 0, armed.stderr);
    const packsBefore = uploadPacks("acme/widgets");
    started("alpha/a1", "slow", "desolate fetch --mirror-only acme/widgets");
    // The root's fetch reached the forge, and is the one held there.
    assert.ok(
      await until(() => forge("test -e /slow/used").status === 0, 60_000),
      "the root's fetch did not reach the slow forge",
    );
    for (let i = 0; i < 30; i++)
      started("alpha/a1", `f${i}`, "desolate fetch --mirror-only acme/widgets");
    await sleep(3000);
    // An offer while thirty-one fetches wait: answered at once, not refused for them.
    const offered = offer("alpha/a1", "during the fetches");
    assert.equal(offered.code, 0, offered.stderr);
    assert.match(offered.stdout, /offered acme\/widgets task\/a at [0-9a-f]{12}/);
    assert.ok(offered.ms < 60_000, `the offer took ${offered.ms} ms behind the fetches`);
    assert.equal(ended("alpha/a1", "slow"), null, "the slow fetch is still under way");

    let slow: ReturnType<typeof ended> = null;
    assert.ok(await until(() => (slow = ended("alpha/a1", "slow")) !== null, 420_000));
    assert.equal(slow!.code, 0, slow!.err);
    assert.ok(slow!.seconds >= 230, `answered after ${slow!.seconds} s`);
    // What the root was doing, said while it did it: not "Is it running?".
    assert.match(slow!.err, /desolate: fetching acme\/widgets.*\(\d+ s so far\)/);
    assert.doesNotMatch(slow!.err, /Is it running/);
    for (let i = 0; i < 30; i++) {
      let fetched: ReturnType<typeof ended> = null;
      assert.ok(await until(() => (fetched = ended("alpha/a1", `f${i}`)) !== null, 120_000));
      assert.equal(fetched!.code, 0, `fetch ${i}: ${fetched!.err}`);
    }
    // Thirty-one asked; the forge saw the slow fetch and one more (each is a fetch and a
    // look at the remote's HEAD): not thirty-one.
    const packs = uploadPacks("acme/widgets") - packsBefore;
    assert.ok(packs <= 4, `the forge served ${packs} git-upload-packs for 31 fetches`);
    forge("rm -f /usr/local/bin/git-upload-pack");
  });

  it("a flood from one domain does not slow another's offer (the control: the same offer with no flood)", async () => {
    const control = offer("beta/b1", "before the flood");
    assert.equal(control.code, 0, control.stderr);
    // alpha floods its outbox: offers of a commit it does not have, each of which the root
    // looks for again and again before refusing (seconds each), written straight in.
    const flood = inside(
      "alpha/a1",
      `for i in $(seq 1 20); do printf '{"op":"offer","repo":"acme/widgets","branch":"task/a","commit":"%040d"}' $i > /desolate/outbox/requests/flood-$i.json; done`,
    );
    assert.equal(flood.code, 0, flood.stderr);
    await sleep(1000);
    started(
      "alpha/a1",
      "mine",
      "echo more >> notes.txt && git commit -qam 'behind the flood' && desolate offer",
    );
    await sleep(2000);
    const during = offer("beta/b1", "during the flood");
    assert.equal(during.code, 0, during.stderr);
    assert.ok(
      during.ms < control.ms + 15_000,
      `beta's offer took ${during.ms} ms during alpha's flood, ${control.ms} ms without it`,
    );
    // The flood was real: alpha's own offer is still behind it.
    assert.equal(ended("alpha/a1", "mine"), null, "alpha's offer was not behind its flood");
    // And it is waited on, saying why, and answered: not refused.
    let mine: ReturnType<typeof ended> = null;
    assert.ok(await until(() => (mine = ended("alpha/a1", "mine")) !== null, 400_000));
    assert.equal(mine!.code, 0, mine!.err);
    assert.match(
      mine!.err,
      /desolate: (waiting for \d+ earlier request\(s\) of this domain to be answered|the root has not taken it yet)/,
    );
  });

  it("a root that is down is said to be within the beat's 10 s, and the request withdrawn (the control: answered once it runs)", () => {
    const stopped = stack.inRoot(["pkill", "-STOP", "-f", "rootd.ts"], { root: true });
    assert.equal(stopped.code, 0, stopped.stderr);
    let down: ReturnType<typeof offer>;
    try {
      down = offer("beta/b1", "while the root is stopped");
    } finally {
      stack.inRoot(["pkill", "-CONT", "-f", "rootd.ts"], { root: true });
    }
    assert.equal(down.code, 1);
    assert.match(
      down.stderr,
      /the root did not take the offer: nothing has been heard from the root for 10 s: it is not running, or its VM is stopped \(the request was withdrawn\)/,
    );
    assert.match(down.stderr, /fix: on the host: desolate doctor/);
    assert.ok(down.ms < 30_000, `said after ${down.ms} ms`);
    assert.equal(
      inside("beta/b1", "ls /desolate/outbox/requests | wc -l").stdout.trim(),
      "0",
      "withdrawn: the root will not do it later, unasked",
    );
    const again = inside("beta/b1", "desolate offer");
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /offered acme\/gadgets task\/b at [0-9a-f]{12}/);
  });
});
