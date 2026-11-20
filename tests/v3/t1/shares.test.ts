// T1. A VM's share is a real directory under desolate's home, reached through no symlink
// (host/vm/shares.ts): the root's ordinary user, which owns what is in domains/, could
// otherwise point a workspace's share at any folder of the Mac's.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { shareRefused } from "../../../release/host/vm/shares.ts";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "desolate-shares-"));
const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "desolate-elsewhere-"));
after(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(elsewhere, { recursive: true, force: true });
});

describe("T1 what a VM may share", () => {
  it("a real directory: shared (the control)", () => {
    fs.mkdirSync(path.join(home, "domains", "acme", "repos"), { recursive: true });
    assert.equal(shareRefused(path.join(home, "domains", "acme", "repos"), home), null);
  });
  it("not there yet: shared (desolate makes it)", () => {
    assert.equal(shareRefused(path.join(home, "domains", "new", "repos"), home), null);
  });
  it("a share replaced by a symlink to the Mac's folders: refused", () => {
    fs.mkdirSync(path.join(home, "domains", "evil"), { recursive: true });
    fs.symlinkSync(elsewhere, path.join(home, "domains", "evil", "repos"));
    assert.match(shareRefused(path.join(home, "domains", "evil", "repos"), home)!, /symlink/);
  });
  it("a symlink on the way to it: refused", () => {
    fs.symlinkSync(elsewhere, path.join(home, "domains", "linked"));
    fs.mkdirSync(path.join(elsewhere, "repos"));
    assert.match(shareRefused(path.join(home, "domains", "linked", "repos"), home)!, /symlink/);
  });
  it("a file in place of a folder: refused", () => {
    fs.mkdirSync(path.join(home, "domains", "f"), { recursive: true });
    fs.writeFileSync(path.join(home, "domains", "f", "repos"), "");
    assert.match(shareRefused(path.join(home, "domains", "f", "repos"), home)!, /not a directory/);
  });
  it("outside desolate's home (the release, read-only): not asked", () => {
    assert.equal(shareRefused(elsewhere, home), null);
  });
});
