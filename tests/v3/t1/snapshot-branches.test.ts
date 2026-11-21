// T1. What a dashboard snapshot carries of a domain's branches (root/stated.ts): a page, the
// total, and every branch a workspace has checked out, however many the domain lists.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BRANCHES_SHOWN, snapshotBranches } from "../../../release/root/stated.ts";

describe("T1 a snapshot's branches", () => {
  const all = Array.from({ length: 5000 }, (_, i) => ({ repo: "acme/app", branch: `b${i}` }));
  it("a page of them, with how many there are; a workspace's own branch is always among them", () => {
    const out = snapshotBranches(all, new Set(["acme/app\nb4999"]), () => null);
    assert.equal(out.branchesTotal, 5000);
    assert.equal(out.branches.length, BRANCHES_SHOWN);
    assert.equal(out.branches[0]!.branch, "b4999", "the one checked out, though last in the list");
    // CONTROL: with nothing checked out, the last branch is not in the page.
    const none = snapshotBranches(all, new Set(), () => null);
    assert.equal(
      none.branches.some((b) => b.branch === "b4999"),
      false,
    );
  });
  it("a short list is whole", () => {
    const out = snapshotBranches(all.slice(0, 3), new Set(), (b) => b.branch);
    assert.deepEqual(
      out.branches.map((b) => b.landed),
      ["b0", "b1", "b2"],
    );
    assert.equal(out.branchesTotal, 3);
  });
});
