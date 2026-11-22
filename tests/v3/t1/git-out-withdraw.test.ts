// T1. A request from the git VM is withdrawn when the program that asked is stopped
// (shared/git-out-box.ts, `requester`): it leaves `<id>.gone` for the host, and takes back
// what it left. Ctrl-C at a terminal reaches that program twice: the terminal sends SIGINT
// to the whole foreground job, and git, whose `git remote-<helper>` runs the helper as a
// child, passes its own SIGINT on to it (measured in the git VM's image, git 2.43: about one
// Ctrl-C in three left no withdrawal, or half of one, on 2026-11-21).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const box = fs.mkdtempSync(path.join(os.tmpdir(), "desolate-withdraw-"));
after(() => fs.rmSync(box, { recursive: true, force: true }));
const module = path.join(import.meta.dirname, "../../../release/shared/git-out-box.ts");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A program that asks, stopped by `signals` once its request is there (none: its input is
 *  closed instead): what it left in the out-box afterwards, and how it ended. */
const stoppedWith = async (round: number, signals: NodeJS.Signals[]) => {
  const at = { out: path.join(box, `out-${round}`), answers: path.join(box, `answers-${round}`) };
  for (const dir of Object.values(at)) fs.mkdirSync(dir);
  const child = spawn(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--input-type=module",
      "-e",
      // As the push helper wires it: git closing its input is git gone (git/git-remote-desolate-out.ts).
      `const { requester } = await import(${JSON.stringify(module)});
const box = requester(${JSON.stringify(at)});
process.stdin.once("close", box.left);
process.stdin.resume();
await box.ask("0123456789abcdef", { op: "fetch", repo: "acme/app" }, () => {});`,
    ],
    { stdio: ["pipe", "ignore", "ignore"] },
  );
  const ended = new Promise<string>((resolve) =>
    child.on("exit", (code, signal) => resolve(signal ?? String(code))),
  );
  for (let i = 0; i < 200 && !fs.existsSync(path.join(at.out, "0123456789abcdef.json")); i++)
    await sleep(25);
  if (signals.length === 0) {
    // No signal: its input closed, as when git is killed alone.
    child.stdin!.end();
    return { ended: await ended, left: fs.readdirSync(at.out).sort() };
  }
  // The first signal, then the rest again and again until it has ended: a second may come
  // at any moment of the first's handling (git passes its own on when it gets to it).
  child.kill(signals[0]);
  const more = setInterval(() => signals.slice(1).forEach((signal) => child.kill(signal)), 1);
  const how = await ended;
  clearInterval(more);
  return { ended: how, left: fs.readdirSync(at.out).sort() };
};

describe("T1 a git VM request, withdrawn when its asker is stopped", () => {
  it("Ctrl-C at a terminal (SIGINT, and SIGINT again while it withdraws): the host is told, and nothing is left, every time", async () => {
    for (let round = 0; round < 12; round++)
      assert.deepEqual(
        await stoppedWith(round, ["SIGINT", "SIGINT"]),
        { ended: "130", left: ["0123456789abcdef.gone"] },
        `round ${round}`,
      );
  });
  it("git killed alone (its input closes, no signal): withdrawn too", async () => {
    assert.deepEqual(await stoppedWith(200, []), { ended: "1", left: ["0123456789abcdef.gone"] });
  });
  it("the control: one signal, as a closed terminal sends", async () => {
    assert.deepEqual(await stoppedWith(100, ["SIGHUP"]), {
      ended: "129",
      left: ["0123456789abcdef.gone"],
    });
  });
});
