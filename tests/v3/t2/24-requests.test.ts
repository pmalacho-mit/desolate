// T2 (fake backend). The channel a workspace asks the root through (workspace/sync.ts asks,
// root/rootd.ts answers): `desolate fetch`, `offer`, `spawn`, `close`, `issue offer`, and a
// `git fetch` or `git push` in a workspace, which make the first two.
//
// What is claimed:
// - A request is taken, then waited on for as long as the root is there and on it: one the
//   root takes 40 s over (the forge is made slow), four beat windows, is answered, and says
//   meanwhile what the root is doing. (It gave up at two minutes, saying "Is it running?".
//   That a beating root is waited on with no total is workspace/sync.ts's verdict, whose
//   in-source test waits 240 s; here it is the whole channel.)
// - Fetches asked of one repository while one runs are one more fetch, and do not refuse an
//   offer, or keep it waiting. (Thirty in a minute refused the domain's offer.)
// - A flood of requests from one domain does not slow another's: beside the control, the same
//   offer from the other domain with no flood; and the flooding domain's own offer waits
//   behind its flood (so the flood was real), and is answered, not refused.
// - A domain's spawn and close requests waiting for the host are at most 8: a flood of 200
//   that the host refuses each of is refused past 8 by the root, in words, and another
//   domain's spawn is answered and made as fast as before the flood (the control).
// - A domain's requests folder holding 100,000 names that are not requests costs the root's
//   loop a look at 1,000: another domain's round trip is as fast as without it (the
//   control), and the domain is told why its own request may wait.
// - One domain's import held for a minute in a root clone it shares with another holds up
//   none of the other's work there: its offer is answered as fast as with nothing held (the
//   control), while the hold is still on.
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
/** The same, left running in the workspace: its output and exit code go to /tmp/<name>.*.
 *  Several names: as many at once, started by one command. */
const started = (workspace: string, names: string | string[], script: string) => {
  const ran = inside(
    workspace,
    [names]
      .flat()
      .map(
        (name) =>
          `rm -f /tmp/${name}.*; setsid bash -c 's=$(date +%s); { ${script.replace(/'/g, "'\\''")}; } >/tmp/${name}.out 2>/tmp/${name}.err; echo "$? $(( $(date +%s) - s ))" >/tmp/${name}.done' </dev/null >/dev/null 2>&1 &`,
      )
      .join("\n"),
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
    // beta shares acme/widgets with alpha: one root clone, two domains' imports into it.
    assert.equal(
      stack.quiet("domain", "create", "beta", "--repo", "acme/gadgets", "--repo", "acme/widgets")
        .code,
      0,
    );
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

  it("a fetch the root takes long over is answered; thirty more beside it are one fetch, and an offer is not kept waiting", async () => {
    // The forge's next git-upload-pack waits 40 s before it serves (once): git, at the root,
    // waiting on a slow remote, as a first fetch of a large repository does.
    const armed = forge(
      `mkdir -p /slow && chmod 777 /slow && echo 40 > /slow/armed && chmod 666 /slow/armed && printf '%s\\n' '#!/bin/sh' 'if mv /slow/armed /slow/used 2>/dev/null; then sleep "$(cat /slow/used)"; fi' 'exec /usr/bin/git-upload-pack "$@"' > /usr/local/bin/git-upload-pack && chmod 755 /usr/local/bin/git-upload-pack`,
    );
    assert.equal(armed.status, 0, armed.stderr);
    const packsBefore = uploadPacks("acme/widgets");
    started("alpha/a1", "slow", "desolate fetch --mirror-only acme/widgets");
    // The root's fetch reached the forge, and is the one held there.
    assert.ok(
      await until(() => forge("test -e /slow/used").status === 0, 60_000),
      "the root's fetch did not reach the slow forge",
    );
    started(
      "alpha/a1",
      Array.from({ length: 30 }, (_, i) => `f${i}`),
      "desolate fetch --mirror-only acme/widgets",
    );
    await sleep(3000);
    // An offer while thirty-one fetches wait: answered at once, not refused for them.
    const offered = offer("alpha/a1", "during the fetches");
    assert.equal(offered.code, 0, offered.stderr);
    assert.match(offered.stdout, /offered acme\/widgets task\/a at [0-9a-f]{12}/);
    assert.ok(offered.ms < 60_000, `the offer took ${offered.ms} ms behind the fetches`);
    assert.equal(ended("alpha/a1", "slow"), null, "the slow fetch is still under way");

    let slow: ReturnType<typeof ended> = null;
    assert.ok(await until(() => (slow = ended("alpha/a1", "slow")) !== null, 180_000));
    assert.equal(slow!.code, 0, slow!.err);
    assert.ok(slow!.seconds >= 38, `answered after ${slow!.seconds} s`);
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
    // looks for again and again before refusing (3 to 4 s each), written straight in. Six:
    // alpha's own offer then waits behind them past the 10 s after which it says why.
    const flood = inside(
      "alpha/a1",
      `for i in $(seq 1 6); do printf '{"op":"offer","repo":"acme/widgets","branch":"task/a","commit":"%040d"}' $i > /desolate/outbox/requests/flood-$i.json; done`,
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
    assert.ok(await until(() => (mine = ended("alpha/a1", "mine")) !== null, 180_000));
    assert.equal(mine!.code, 0, mine!.err);
    assert.match(
      mine!.err,
      /desolate: (waiting for \d+ earlier request\(s\) of this domain to be answered|the root has not taken it yet)/,
    );
  });

  it("a domain's spawn and close requests waiting for the host are bounded at 8, and another domain's spawn is asked and made as fast as before it (the control)", async () => {
    type Event = {
      type: string;
      workspace?: string;
      request?: string;
      ok?: boolean;
      said?: string;
    };
    const events = (workspace: string): Event[] =>
      inside(workspace, "desolate events --all")
        .stdout.split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Event);
    /** beta asks for a workspace: how long the root took to answer, and the host to make it */
    const spawned = async (name: string) => {
      const asked = inside("beta/b1", `desolate spawn --name ${name} --branch task/${name}`);
      assert.equal(asked.code, 0, asked.stderr);
      assert.match(asked.stdout, new RegExp(`asked for beta/${name}`));
      const made = (e: Event) =>
        e.type === "request" && e.request === "spawn" && e.workspace === name;
      const start = Date.now();
      assert.ok(
        await until(() => events("beta/b1").some(made), 240_000),
        `beta/${name} was not made`,
      );
      assert.equal(
        events("beta/b1").find(made)!.ok,
        true,
        JSON.stringify(events("beta/b1").find(made)),
      );
      return { asked: asked.ms, made: Date.now() - start + asked.ms };
    };
    /** and closes it, so that the Mac has as many workspaces running for the next */
    const closed = async (name: string) => {
      const asked = inside("beta/b1", `desolate close ${name}`);
      assert.equal(asked.code, 0, asked.stderr);
      const done = (e: Event) =>
        e.type === "request" && e.request === "close" && e.workspace === name;
      assert.ok(
        await until(() => events("beta/b1").some(done), 120_000),
        `beta/${name} was not closed`,
      );
    };
    // Small, so that two workspaces more fit on any Mac T2 runs on (a test VM of 10 GiB
    // refused the third of 3 GiB): the room a Mac has is not what this measures.
    assert.equal(stack.quiet("domain", "beta", "size", "--memory", "1g").code, 0);
    const control = await spawned("b2");
    await closed("b2");

    // alpha writes 200 spawn requests straight into its outbox, each of a shape the root
    // takes (it cannot check a signature) and a command of 60,000 characters, signed with
    // nothing the host gave it. The host refuses each; the root holds at most 8 of them
    // for it at once, and refuses the rest, saying so.
    const flood = inside(
      "alpha/a1",
      `w=$(head -c 15000 /dev/zero | tr '\\0' x); at=$(date -u +%Y-%m-%dT%H:%M:%S.000Z); cd /desolate/outbox/requests && for i in $(seq 1 200); do printf '{"op":"spawn","parent":"a1","name":"s%d","checkouts":[],"command":["%s","%s","%s","%s"],"at":"%s","nonce":"%032d","mac":"%064d"}' $i $w $w $w $w $at $i $i > .s$i && mv .s$i spawn-$i.json; done`,
    );
    assert.equal(flood.code, 0, flood.stderr);
    // What the host's queue holds of alpha's, looked at every 100 ms while the flood is taken.
    const looked = stack.inRoot([
      "bash",
      "-c",
      'most=0; for i in $(seq 1 60); do n=$(grep -l \'"domain": "alpha"\' /var/lib/desolate/host-queue/* 2>/dev/null | wc -l); [ "$n" -gt "$most" ] && most=$n; sleep 0.1; done; echo $most',
    ]);
    const during = await spawned("b3");
    assert.ok(
      during.asked < control.asked + 5_000 && during.made < control.made + 30_000,
      `beta's spawn was answered in ${during.asked} ms and made in ${during.made} ms during alpha's flood, ${control.asked} ms and ${control.made} ms without it`,
    );
    assert.ok(
      Number(looked.stdout.trim()) <= 8,
      `alpha had ${looked.stdout.trim()} waiting at once`,
    );
    // Every one of alpha's was answered: those over the bound in words, the rest by the host.
    const replies = () =>
      inside("alpha/a1", "cat /desolate/inbox/replies/spawn-*.json 2>/dev/null").stdout;
    assert.ok(
      await until(() => (replies().match(/"ok"/g) ?? []).length === 200, 60_000),
      "alpha's requests were not all answered",
    );
    assert.match(
      replies(),
      /alpha has 8 spawn and close requests waiting for the host, the most a domain may have waiting: ask again once one is answered/,
    );
    assert.ok(
      await until(
        () =>
          events("alpha/a1").filter(
            (e) => e.type === "request" && /not signed by alpha\/a1/.test(String(e.said)),
          ).length === (replies().match(/"ok": true/g) ?? []).length,
        120_000,
      ),
      "the host did not refuse each of alpha's queued requests",
    );
    console.log(
      `beta's spawn: answered in ${control.asked} ms, made in ${control.made} ms; during alpha's flood ${during.asked} ms and ${during.made} ms; alpha's waiting at most ${looked.stdout.trim()}`,
    );
    await closed("b3");
  });

  it("a domain's requests folder holding 100,000 names that are not requests does not slow another domain's requests (the control: the same requests without it), and the domain is told why its own may wait", async () => {
    // beta's round trip to the root, ten times: a close of a workspace it does not have,
    // which the root answers at once. The middle of the ten, in ms.
    const roundTrip = () => {
      const ran = inside(
        "beta/b1",
        "for i in $(seq 1 10); do s=$(date +%s%N); desolate close nobody-$i >/dev/null 2>&1; echo $(( ($(date +%s%N) - s) / 1000000 )); done",
      );
      assert.equal(ran.code, 0, ran.stderr);
      const ms = ran.stdout
        .trim()
        .split("\n")
        .map(Number)
        .sort((a, b) => a - b);
      return ms[5]!;
    };
    assert.match(
      inside("beta/b1", "desolate close nobody 2>&1").stdout,
      /beta has no workspace 'nobody'/,
      "the round trip is the root's answer",
    );
    const control = roundTrip();
    const filled = inside(
      "alpha/a1",
      "cd /desolate/outbox/requests && seq 1 100000 | sed 's/^/x/' | xargs touch && ls -f | wc -l",
    );
    assert.equal(filled.code, 0, filled.stderr);
    assert.ok(Number(filled.stdout.trim()) >= 100_000, filled.stdout);
    // alpha asks too: its request is taken if it is among the names the root reads, and
    // waits, saying why, if not.
    started("alpha/a1", "crowded", "desolate fetch --mirror-only acme/widgets");
    const during = roundTrip();
    console.log(`beta's round trip: ${control} ms, and ${during} ms beside alpha's 100,000 names`);
    assert.ok(
      during < control + 250,
      `beta's round trip took ${during} ms beside alpha's 100,000 names, ${control} ms without`,
    );
    assert.match(
      inside("alpha/a1", "cat /desolate/inbox/requests.crowded").stdout,
      /this domain's outbox holds more than 1000 names in requests\/, the most the root reads at a time/,
    );
    await sleep(12_000);
    const early = ended("alpha/a1", "crowded");
    if (early === null)
      assert.match(
        inside("alpha/a1", "cat /tmp/crowded.err").stdout,
        /desolate: the root has not taken it yet: this domain's outbox holds more than 1000 names in requests\//,
      );
    // The workspace removes what is not a request: its own is then taken, and the note goes.
    assert.equal(inside("alpha/a1", "find /desolate/outbox/requests -name 'x*' -delete").code, 0);
    let fetched: ReturnType<typeof ended> = early;
    assert.ok(await until(() => (fetched = ended("alpha/a1", "crowded")) !== null, 60_000));
    assert.equal(fetched!.code, 0, fetched!.err);
    assert.ok(
      await until(
        () => inside("alpha/a1", "test -e /desolate/inbox/requests.crowded").code !== 0,
        10_000,
      ),
      "the note went with the names",
    );
  });

  it("one domain's import held for a minute in a root clone another domain shares does not hold the other's offer to it (the control: the same offer with nothing held)", async () => {
    const BT = "/workspaces/acme/widgets/.worktrees/task-b";
    const offerWidgets = (note: string) =>
      inside(
        "beta/b1",
        `cd ${BT} && echo '${note}' >> notes.txt && git add notes.txt && git commit -qm '${note}' && desolate offer`,
      );
    const control = offerWidgets("before the hold");
    assert.equal(control.code, 0, control.stderr);
    assert.match(control.stdout, /offered acme\/widgets task\/b at [0-9a-f]{12}/);
    // The root's helper for git fetch <domain>, for rootd's next import of alpha only: a
    // minute before it starts, as a domain's import of bundles made to be slow would be.
    const helper = [
      "#!/bin/sh",
      // (git runs it from `git remote-desolate`, under the `git fetch` rootd started.)
      "p=$PPID; from=''; for i in 1 2 3 4; do p=$(awk '/^PPid:/{print $2}' /proc/$p/status 2>/dev/null); from=\"$from $(tr '\\0' ' ' </proc/$p/cmdline 2>/dev/null)\"; done",
      'echo "$* <-$from" >> /slow/log',
      'case "$2 $from" in "alpha "*rootd.ts*) if mv /slow/armed /slow/used 2>/dev/null; then sleep 60; fi;; esac',
      'exec node --disable-warning=ExperimentalWarning /desolate/release/root/git-remote-desolate.ts "$@"',
    ].join("\n");
    const armed = stack.inRoot(
      [
        "bash",
        "-c",
        "mkdir -p /slow && touch /slow/armed && chmod -R 777 /slow && rm /usr/local/bin/git-remote-desolate && cat > /usr/local/bin/git-remote-desolate && chmod 755 /usr/local/bin/git-remote-desolate",
      ],
      { root: true, input: `${helper}\n` },
    );
    assert.equal(armed.code, 0, armed.stderr);
    try {
      // alpha commits and syncs: rootd's import of it is the one held.
      const commit = inside(
        "alpha/a1",
        "echo held >> notes.txt && git commit -qam 'held' && desolate sync >/dev/null && git rev-parse HEAD",
      );
      assert.equal(commit.code, 0, commit.stderr);
      assert.ok(
        await until(() => stack.inRoot(["test", "-e", "/slow/used"]).code === 0, 90_000),
        `rootd did not import alpha: the helper ran for ${stack.inRoot(["cat", "/slow/log"]).stdout || "nothing"}; rootd said ${stack.inRoot(["bash", "-c", "tail -5 /var/lib/desolate/rootd.log 2>&1"]).stdout}`,
      );
      const during = offerWidgets("during the hold");
      assert.equal(during.code, 0, during.stderr);
      assert.match(during.stdout, /offered acme\/widgets task\/b at [0-9a-f]{12}/);
      console.log(
        `beta's offer to the shared clone: ${control.ms} ms, and ${during.ms} ms while alpha's import was held`,
      );
      assert.ok(
        during.ms < control.ms + 15_000,
        `beta's offer took ${during.ms} ms while alpha's import was held, ${control.ms} ms without`,
      );
      // The hold was real: alpha's import was still held when beta's offer was answered.
      const holding = stack.inRoot([
        "bash",
        "-c",
        `for p in /proc/[0-9]*; do [ "$(tr '\\0' ' ' < $p/cmdline 2>/dev/null)" = "sleep 60 " ] && exit 0; done; exit 1`,
      ]);
      assert.equal(holding.code, 0, "alpha's import was not held");
      // And it lands once it is let go.
      const alphaHas = () =>
        stack
          .inRoot([
            "git",
            "-C",
            "/desolate/root/acme/widgets",
            "rev-parse",
            "refs/remotes/alpha/task/a",
          ])
          .stdout.trim();
      assert.ok(await until(() => alphaHas() === commit.stdout.trim(), 120_000), alphaHas());
    } finally {
      stack.inRoot(
        [
          "bash",
          "-c",
          "ln -sf /desolate/release/root/git-remote-desolate /usr/local/bin/git-remote-desolate; rm -rf /slow",
        ],
        { root: true },
      );
    }
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
