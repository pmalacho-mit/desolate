// T1. The root's CLI service ends what it was asked for when whoever asked goes away
// (root/rootctl.ts serve): the host holds its input open until the answer (host/stack.ts),
// so its end of input is the asker gone, though a half-open socket reports it as 'end'
// only. Driven on the real service, with `git.push` as the git VM's withdrawn push asks it:
// its bundle never comes, so it waits five seconds for it unless it is ended.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import { connect } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

// Short: a socket's path is at most 104 bytes on macOS.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "rc-"));
const socket = path.join(home, "rootctl", "rootctl.sock");
let service: ChildProcess;
before(async () => {
  service = spawn(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      path.join(import.meta.dirname, "../../../release/root/rootctl.ts"),
      "serve",
    ],
    {
      env: { ...process.env, DESOLATE_ROOT_RUN: home, DESOLATE_ROOT_STATE: home },
      stdio: "ignore",
    },
  );
  for (let i = 0; i < 100 && !fs.existsSync(socket); i++)
    await new Promise((resolve) => setTimeout(resolve, 50));
});
after(() => {
  service.kill();
  fs.rmSync(home, { recursive: true, force: true });
});

/** A push from the git VM, asked of the service; its input ended at once (`ended`) or held.
 *  The reply, and how long it took. */
const push = (ended: boolean) =>
  new Promise<{ reply: { ok: boolean; error?: string }; ms: number }>((resolve, reject) => {
    const began = Date.now();
    const asker = connect(socket);
    let text = "";
    asker.on("error", reject);
    asker.on("data", (chunk) => {
      text += chunk;
      for (const line of text.split("\n").slice(0, -1)) {
        const said = JSON.parse(line) as { reply?: { ok: boolean; error?: string } };
        if (said.reply) {
          asker.destroy();
          resolve({ reply: said.reply, ms: Date.now() - began });
        }
      }
    });
    const request = {
      op: "git.push",
      args: {
        repo: "acme/web",
        branch: "fix/login",
        commit: "0123456789abcdef0123456789abcdef01234567",
        bundle: "0123456789abcdef.bundle",
      },
    };
    asker.write(JSON.stringify(request) + "\n");
    if (ended) asker.end();
  });

describe("the root's CLI service and whoever asked", () => {
  it("ends what was asked when the asker's input ends", async () => {
    const { reply, ms } = await push(true);
    assert.deepEqual(reply, {
      ok: false,
      error: "whoever asked went away",
      fix: "",
      code: 1,
    });
    assert.ok(ms < 2000, `answered after ${ms} ms`);
  });
  it("the control: an asker that holds its input waits the whole step", async () => {
    const { reply, ms } = await push(false);
    assert.equal(reply.ok, false);
    assert.match(reply.error ?? "", /ENOENT/);
    assert.ok(ms >= 4500, `answered after ${ms} ms`);
  });
});
