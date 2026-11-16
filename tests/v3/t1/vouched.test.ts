// T1: the host checks what the root says about a workspace before it acts on its VM
// (host/workspaces.ts, vouched). The root's ordinary user parses every domain's data; an
// answer naming another domain's VM would have had the host stop, start or remove that VM
// (security audit, 2026-11-16).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { workspaceVmName } from "../../../release/shared/names.ts";
import { INSTANCE } from "../../../release/host/paths.ts";
import { vouched } from "../../../release/host/workspaces.ts";

const own = (domain: string, workspace: string) => ({ domain, workspace, vm: workspaceVmName(INSTANCE, domain, workspace) });

describe("T1 the host vouches for the root's answer about a workspace", () => {
  it("takes an answer that names the workspace's own VM (the control)", () => {
    assert.deepEqual(vouched(own("acme", "w1"), "acme", "w1"), own("acme", "w1"));
    assert.deepEqual(vouched(own("acme", "w2"), "acme"), own("acme", "w2"), "a name the root chose, in the right domain");
  });
  it("refuses another domain's VM, another domain, another workspace, or a name that is not one", () => {
    assert.throws(() => vouched({ ...own("acme", "w1"), vm: own("other", "w1").vm }, "acme", "w1"), /does not name that workspace's own VM/);
    assert.throws(() => vouched(own("other", "w1"), "acme", "w1"), /does not name/);
    assert.throws(() => vouched(own("acme", "w2"), "acme", "w1"), /does not name/);
    assert.throws(() => vouched({ domain: "acme", workspace: "--x", vm: workspaceVmName(INSTANCE, "acme", "--x") }, "acme"), /does not name/);
  });
});
