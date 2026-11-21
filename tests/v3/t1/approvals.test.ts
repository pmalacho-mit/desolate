// T1. Pushes waiting for a person (root/approvals.ts): each file read on its own, so one bad
// one hides none of the others; one is listed while the process that asked waits, however long.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import { pendingIn } from "../../../release/root/approvals.ts";
import { formatApproval } from "../../../release/shared/approval.ts";
import { startOf } from "../../../release/shared/lock.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desolate-approvals-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const NOW = Date.parse("2026-11-13T12:00:00Z");
const message = (n: number) =>
  formatApproval({
    repo: "acme/app",
    branch: `b${n}`,
    commit: String(n).repeat(40).slice(0, 40),
    onto: null,
    nonce: String(n).repeat(32).slice(0, 32),
  });
const put = (name: string, content: string) => fs.writeFileSync(path.join(dir, name), content);
// The process that asked, as raw-push.ts names it: this one, alive; or one that has ended.
const alive = { pid: process.pid, start: startOf(process.pid) };
const ended = { pid: spawnSync("true").pid, start: "when it started" };

describe("T1 pushes waiting for a person", () => {
  it("one malformed, oversized, abandoned or foreign file hides none of the others", () => {
    put(
      "1.json",
      JSON.stringify({
        message: message(1),
        summary: "two files",
        // A day ago: a request has no age, only an asker.
        at: new Date(NOW - 86_400_000).toISOString(),
        ...alive,
      }),
    );
    put("2.json", "{not json");
    put(
      "3.json",
      JSON.stringify({
        message: "desolate push approval v2\nrepo: ../x\n",
        at: new Date(NOW).toISOString(),
        ...alive,
      }),
    );
    put(
      "4.json",
      JSON.stringify({ message: message(4), at: new Date(NOW).toISOString(), ...ended }),
    );
    put(
      "5.json",
      JSON.stringify({
        message: message(5),
        summary: "x".repeat(20_000),
        at: new Date(NOW).toISOString(),
        ...alive,
      }),
    );
    put(
      "6.json",
      JSON.stringify({
        message: message(6),
        summary: "s".repeat(500),
        at: new Date(NOW).toISOString(),
        ...alive,
      }),
    );
    fs.mkdirSync(path.join(dir, "7.json"));
    put(
      "8.txt",
      JSON.stringify({ message: message(8), at: new Date(NOW).toISOString(), ...alive }),
    );
    // Written before requests named their asker: nobody waits for it.
    put("9.json", JSON.stringify({ message: message(9), at: new Date(NOW).toISOString() }));
    const listed = pendingIn(dir, NOW);
    assert.deepEqual(
      listed.map((p) => p.approval.branch),
      ["b1", "b6"],
    );
    // Kept whole: fitting it to a line is the page's (R1).
    assert.equal(listed[1]!.summary.length, 500);
  });
  it("pruning removes what is not a waiting approval, and keeps the rest", () => {
    pendingIn(dir, NOW, true);
    assert.deepEqual(fs.readdirSync(dir).sort(), ["1.json", "6.json", "7.json", "8.txt"]);
  });
});
