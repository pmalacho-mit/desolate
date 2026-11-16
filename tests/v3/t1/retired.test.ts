// T1: the pages' tokens, retired when another program held [::1] on their port (host/retired.ts;
// final review, 2026-11-16). A tab reloaded then sent that program its cookie: the dashboard and
// each editor are not served again on a token made before.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "desolate-retired-"));
process.env.DESOLATE_HOME = home;
const state = path.join(home, "state");
fs.mkdirSync(state, { recursive: true });
const { dashboardStale, retire, retiredAt, stale } = await import("../../../release/host/retired.ts");

describe("T1 retired tokens", () => {
  after(() => fs.rmSync(home, { recursive: true, force: true }));

  it("nothing is stale until the tokens are retired (the control)", () => {
    fs.writeFileSync(path.join(state, "ui-token"), "x\n");
    assert.equal(retiredAt(), 0);
    assert.equal(stale(0), false, "even a token whose age is not known");
    assert.equal(dashboardStale(), false);
  });

  it("retiring removes the page tokens, and a token made before is stale, one made after is not", () => {
    for (const name of ["approve-token", "git-token"]) fs.writeFileSync(path.join(state, name), "x\n");
    const before = Date.now() - 1000;
    retire();
    const at = retiredAt();
    assert.ok(at >= before + 1000);
    for (const name of ["approve-token", "git-token", "ui-token"]) assert.ok(!fs.existsSync(path.join(state, name)), name);
    assert.equal(stale(before), true);
    assert.equal(stale(0), true, "a token whose age is not known is stale");
    assert.equal(stale(at + 1), false);
    assert.equal(dashboardStale(), true, "no dashboard token at all");
    fs.writeFileSync(path.join(state, "ui-token"), "y\n");
    fs.utimesSync(path.join(state, "ui-token"), new Date(at - 5000), new Date(at - 5000));
    assert.equal(dashboardStale(), true, "a dashboard token older than the retiring");
    fs.utimesSync(path.join(state, "ui-token"), new Date(at + 5000), new Date(at + 5000));
    assert.equal(dashboardStale(), false, "one made after it (bootstrap)");
  });
});
