// T1. The git VM's out-box, as the host daemon watches it (host/git-vm.ts, watchGitOut): what
// the git VM leaves there is input from a VM, and nothing it leaves may stop the daemon, which
// serves every page of this Mac's (the dashboard, the approval page, the workspaces' editors).
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { after, describe, it } from "node:test";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "desolate-git-out-"));
process.env.DESOLATE_HOME = home;
const { watchGitOut } = await import("../../../release/host/git-vm.ts");
const { paths } = await import("../../../release/host/paths.ts");
const { named } = await import("../../../release/shared/git-out-box.ts");
const { FORGE } = await import("../../../release/shared/limits.ts");
after(() => fs.rmSync(home, { recursive: true, force: true }));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const answerOf = async (id: string) => {
  const file = path.join(paths.gitAnswers, `${id}.json`);
  for (const until = Date.now() + 5000; !fs.existsSync(file) && Date.now() < until;)
    await sleep(20);
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as unknown) : null;
};

describe("T1 the git VM's out-box, watched", () => {
  it("a directory where a request or a withdrawal goes is answered once and left; the daemon runs on, and takes the next request (control)", async () => {
    fs.mkdirSync(paths.gitOut, { recursive: true });
    // (Each of these stopped the daemon: a directory .gone threw from the scan, uncaught; a
    // directory request was answered again and again in one turn of the loop, for ever.)
    fs.mkdirSync(path.join(paths.gitOut, "1111111111111111.gone"));
    fs.mkdirSync(path.join(paths.gitOut, "2222222222222222.json"));
    fs.mkdirSync(path.join(paths.gitOut, "not-a-request.json"));
    const logged: string[] = [];
    let ticks = 0;
    const tick = setInterval(() => ticks++, 10);
    watchGitOut((line) => logged.push(line));
    await sleep(300);
    clearInterval(tick);
    assert.ok(ticks >= 10, `the daemon's own timers still run (${ticks} in 300 ms)`);
    assert.deepEqual(await answerOf("2222222222222222"), {
      pushed: false,
      fetched: false,
      error: "the git VM's request is not a plain file",
    });
    assert.equal(
      logged.filter((line) => /2222222222222222\.json in the out-box is not a file/.test(line))
        .length,
      1,
      logged.join("\n"),
    );
    // CONTROL: a request after them is read and answered.
    fs.writeFileSync(path.join(paths.gitOut, "3333333333333333.json"), "{");
    assert.deepEqual(await answerOf("3333333333333333"), {
      pushed: false,
      error: "the git VM's request is not JSON",
    });
    assert.deepEqual(fs.readdirSync(paths.gitOut).sort(), [
      "1111111111111111.gone",
      "2222222222222222.json",
      "not-a-request.json",
    ]);
  });

  // (The watch the first test started takes what these leave: a request's file last, as the
  // git VM's helper writes it.)
  const push = (id: string, lfs: string[]) =>
    fs.writeFileSync(
      path.join(paths.gitOut, named(id).request),
      JSON.stringify({
        repo: "acme/web",
        branch: "fix/login",
        commit: "0123456789abcdef0123456789abcdef01234567",
        lfs,
      }),
    );
  const sparse = (name: string, bytes: number) => {
    fs.writeFileSync(path.join(paths.gitOut, name), "");
    fs.truncateSync(path.join(paths.gitOut, name), bytes);
  };
  const copiedForTheRoot = () => fs.readdirSync(path.join(paths.rootClones, ".git-in"));

  it("a large push is copied while the daemon answers a page: the copy does not hold it", async () => {
    const id = "4444444444444444";
    const oid = "0".repeat(64);
    fs.writeFileSync(path.join(paths.gitOut, named(id).bundle), "a bundle");
    // 256 MiB, which is not the object its name says: it is copied whole, then refused.
    sparse(named(id).lfs(oid), 256 * 1024 * 1024);
    const page = http.createServer((_request, response) => response.end("a page"));
    await new Promise<void>((resolve) => page.listen(0, "127.0.0.1", resolve));
    const port = (page.address() as { port: number }).port;
    const notes = path.join(paths.gitAnswers, named(id).notes);
    const answered = path.join(paths.gitAnswers, named(id).answer);
    try {
      push(id, [oid]);
      for (const until = Date.now() + 5000; !fs.existsSync(notes) && Date.now() < until;)
        await new Promise((resolve) => setImmediate(resolve));
      assert.match(fs.readFileSync(notes, "utf8"), /the host is copying the push/);
      const body = await (await fetch(`http://127.0.0.1:${port}/`)).text();
      assert.equal(body, "a page");
      assert.equal(fs.existsSync(answered), false, "the page was answered before the copy ended");
      assert.deepEqual(await answerOf(id), {
        pushed: false,
        error: "the LFS object 000000000000 does not hash to its name",
      });
    } finally {
      page.close();
    }
    assert.deepEqual(copiedForTheRoot(), [], "and the host's copies are gone");
  });

  it("a push this Mac's disk cannot hold is refused before a byte is copied, saying what it needs", async () => {
    const id = "5555555555555555";
    // Sparse objects at the forge's bound, enough of them to need more than the disk has
    // free for the host's copy and the root's. The first is not what its name says: copied first, it would be refused as that.
    const disk = fs.statfsSync(paths.home);
    const count = Math.ceil((disk.bavail * disk.bsize) / 2 / FORGE.lfsObjectBytes) + 1;
    const liar = "f".repeat(64);
    const oids = [
      liar,
      ...Array.from({ length: count }, (_, i) => (i + 1).toString(16).padStart(64, "0")),
    ];
    fs.writeFileSync(path.join(paths.gitOut, named(id).bundle), "a bundle");
    fs.writeFileSync(path.join(paths.gitOut, named(id).lfs(liar)), "not that object");
    for (const oid of oids.slice(1)) sparse(named(id).lfs(oid), FORGE.lfsObjectBytes);
    push(id, oids);
    const answer = (await answerOf(id)) as { pushed: boolean; error: string };
    assert.equal(answer.pushed, false);
    assert.match(
      answer.error,
      /^the push needs [\d.]+ [KMGT]iB of this Mac's disk \([\d.]+ [KMGT]iB for the host's copy, and as much for the root's\), and [\d.]+ [KMGT]iB is free$/,
    );
    assert.deepEqual(copiedForTheRoot(), []);
    assert.deepEqual(
      fs.readdirSync(paths.gitOut).filter((name) => name.startsWith(id)),
      [],
      "and what the git VM left is gone",
    );
  });
});
