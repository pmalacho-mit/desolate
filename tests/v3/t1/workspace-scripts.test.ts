// The workspace's shell scripts cannot import TypeScript. Where one repeats a bound that
// release/shared/limits.ts names, it says so in a comment, and this checks that the two agree
// (docs/v3/limits.md, R3); and that the status script counts what its messages say (R8).
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { NAMES } from "../../../release/shared/limits.ts";

const STATUS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../release/workspace/status",
);
const script = fs.readFileSync(STATUS, "utf8");

describe("T1 workspace scripts: the bounds they repeat are shared/limits.ts's", () => {
  it("the status script's bounds are NAMES'", () => {
    assert.equal(Number(/^STATUS_MAX=(\d+)$/m.exec(script)?.[1]), NAMES.status);
    assert.equal(Number(/^NOTE_MAX=(\d+)$/m.exec(script)?.[1]), NAMES.noteBytes);
    // A worktree lock's owner is a workspace's name.
    assert.ok(script.includes(`[A-Za-z0-9_-]\\{1,${NAMES.slug}\\}`));
  });
});

describe("T1 workspace scripts: the status script counts what it says", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desolate-status-script-"));
  execFileSync("git", ["init", "-q", dir]);
  const status = (args: string[], input?: string) =>
    spawnSync("sh", [STATUS, ...args], { cwd: dir, input, encoding: "utf8" });
  const note = path.join(dir, ".git", "desolate-note.md");

  it("control: a message of NAMES.status characters, each two bytes, is not over", () => {
    const result = status(["set", "blue", "é".repeat(NAMES.status)]);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
  });

  it("one character more is, and is said in characters", () => {
    const result = status(["set", "blue", "é".repeat(NAMES.status + 1)]);
    assert.equal(
      result.stderr.trim(),
      `desolate-status: the message is ${NAMES.status + 1} characters, over the ${NAMES.status} allowed; it is shown cut`,
    );
  });

  it("control: a note within NAMES.noteBytes is kept as written", () => {
    const text = `${"é".repeat(100)}\n`;
    assert.equal(status(["note"], text).stderr, "");
    assert.equal(fs.readFileSync(note, "utf8"), text);
  });

  it("a longer note is cut between characters, within the bound, and ends in the mark", () => {
    // An odd number of bytes before the cut: it would fall inside a two-byte character.
    for (const text of ["é".repeat(9000), `a${"é".repeat(9000)}`]) {
      const result = status(["note"], text);
      assert.match(result.stderr, /the note is \d+ bytes, over the 16384 allowed; it was cut/);
      const bytes = fs.readFileSync(note);
      assert.ok(bytes.length <= NAMES.noteBytes, `${bytes.length} bytes`);
      const kept = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      assert.ok(kept.endsWith("…\n"));
    }
  });

  it("cleans up", () => fs.rmSync(dir, { recursive: true, force: true }));
});
