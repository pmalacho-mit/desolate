// T1. The git VM's out-box, as the host daemon watches it (host/git-vm.ts, watchGitOut): what
// the git VM leaves there is input from a VM, and nothing it leaves may stop the daemon, which
// serves every page of this Mac's (the dashboard, the approval page, the workspaces' editors).
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "desolate-git-out-"));
process.env.DESOLATE_HOME = home;
const { watchGitOut } = await import("../../../release/host/git-vm.ts");
const { paths } = await import("../../../release/host/paths.ts");
after(() => fs.rmSync(home, { recursive: true, force: true }));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const answerOf = async (id: string) => {
  const file = path.join(paths.gitAnswers, `${id}.json`);
  for (const until = Date.now() + 5000; !fs.existsSync(file) && Date.now() < until; ) await sleep(20);
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
});
