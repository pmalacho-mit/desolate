// T1: the pages' tokens, retired when another program held [::1] on their port (host/retired.ts;
// final review, 2026-11-16). A tab reloaded then sent that program its cookie: the dashboard and
// each editor are not served again on a token made before. "Before" is by the retiring's own
// number, never a clock (review of the final fixes).
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "desolate-retired-"));
process.env.DESOLATE_HOME = home;
const state = path.join(home, "state");
fs.mkdirSync(state, { recursive: true });
const { dashboardMade, dashboardStale, retire, retiredAt, stale } = await import("../../../release/host/retired.ts");

describe("T1 retired tokens", () => {
  after(() => fs.rmSync(home, { recursive: true, force: true }));

  it("nothing is stale until the tokens are retired (the control)", () => {
    fs.writeFileSync(path.join(state, "ui-token"), "x\n");
    assert.equal(retiredAt(), 0);
    assert.equal(stale(0), false, "even a token with no mark");
    assert.equal(dashboardStale(), false);
  });

  it("retiring removes the page tokens; a token not marked with this retiring is stale", () => {
    for (const name of ["approve-token", "git-token"]) fs.writeFileSync(path.join(state, name), "x\n");
    retire();
    const at = retiredAt();
    assert.ok(at > 0);
    for (const name of ["approve-token", "git-token", "ui-token"]) assert.ok(!fs.existsSync(path.join(state, name)), name);
    assert.equal(stale(0), true, "an editor token with no mark (made before, or by an older desolate)");
    assert.equal(stale(at - 1), true, "one made after an earlier retiring");
    assert.equal(stale(at), false, "one made after this one (editor.sh marks it with this number)");
    assert.equal(dashboardStale(), true, "no dashboard token at all");
    fs.writeFileSync(path.join(state, "ui-token"), "y\n");
    assert.equal(dashboardStale(), true, "a new dashboard token, but the root not yet given it");
    dashboardMade();
    assert.equal(dashboardStale(), false, "given to the root (bootstrap)");
  });

  it("a later retiring is always a larger number, whatever the clock did", () => {
    const first = retiredAt();
    fs.writeFileSync(path.join(state, "tokens-retired"), `${Date.now() + 3_600_000}\n`);   // the clock went back an hour since
    const ahead = retiredAt();
    retire();
    assert.ok(retiredAt() > ahead && ahead > first);
    assert.equal(dashboardStale(), true, "the dashboard's mark is from an earlier retiring");
  });
});
