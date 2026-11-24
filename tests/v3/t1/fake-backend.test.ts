// T1. The tests' stand-in for VMs (lib/fake-backend.ts): how it runs a program in a container.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execArgs } from "../lib/fake-backend.ts";

describe("T1 the fake backend's exec", () => {
  it("runs as the guest user by default, with its own HOME; each variable one -e word, never a shell line", () => {
    assert.deepEqual(
      execArgs(
        "dsl-main-w",
        ["git", "status"],
        { cwd: "/workspaces/acme/web", env: { A: "x; rm -rf /" } },
        false,
      ),
      [
        ...["exec", "-u", "desolate", "-w", "/workspaces/acme/web"],
        ...["-e", "HOME=/home/desolate", "-e", "A=x; rm -rf /"],
        ...["dsl-main-w", "git", "status"],
      ],
    );
  });

  it("runs as root only when asked, and keeps stdin open only when there is input to give", () => {
    assert.deepEqual(execArgs("dsl-main-root", ["id"], { root: true }, true), [
      ...["exec", "-i", "-u", "0:0", "-e", "HOME=/root", "dsl-main-root", "id"],
    ]);
  });
});
