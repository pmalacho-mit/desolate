// The workspace's shell scripts cannot import TypeScript. Where one repeats a bound that
// release/shared/limits.ts names, it says so in a comment, and this checks that the two agree
// (docs/v3/limits.md, R3); that the status script counts what its messages say (R8); and what
// `git push` in a workspace answers git and tells the person.
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
const OFFER_HELPER = path.join(path.dirname(STATUS), "git-remote-desolate-offer");

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
    for (const text of ["é".repeat(9000), `a${"é".repeat(9000)}`, "a".repeat(20000)]) {
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

describe("T1 workspace scripts: git push offers, and is answered refused on purpose", () => {
  // The helper as git runs it, with a stand-in `desolate` on PATH whose offer is taken (or,
  // with REFUSE set, refused as `desolate offer` refuses: a reason on stderr, exit 1).
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "desolate-offer-helper-"));
  fs.writeFileSync(
    path.join(bin, "desolate"),
    '#!/bin/sh\n[ -z "$REFUSE" ] || { echo "desolate: refused" >&2; exit 1; }\necho "offered $2 $3 at 0123456789ab."\n',
    { mode: 0o755 },
  );
  const push = (specs: string[], refuse = false) =>
    spawnSync("sh", [OFFER_HELPER, "origin", "acme/widgets"], {
      cwd: bin,
      encoding: "utf8",
      input: `capabilities\n${specs.map((s) => `push ${s}\n`).join("")}\n`,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, REFUSE: refuse ? "1" : "" },
    });
  const REASON =
    "offered for review, not pushed: this is the expected result, the person reviews and pushes it";
  const EXPECTED = /git reports this push as rejected below, on purpose/;

  it("an offered branch is answered `error`, so git records no remote branch; and is said expected", () => {
    const result = push(["refs/heads/fix:refs/heads/fix"]);
    // Not `ok`: with `ok`, git would write refs/remotes/origin/fix for a branch GitHub lacks.
    assert.equal(result.stdout, `push\n\nerror refs/heads/fix ${REASON}\n\n`);
    // Control: the offer was taken (the stand-in's line, then the helper's two).
    assert.match(result.stderr, /^offered acme\/widgets fix at 0123456789ab\.\n/);
    assert.match(result.stderr, EXPECTED);
    assert.match(result.stderr, /Nothing more is needed now: do not retry the push/);
  });

  it("control: an offer refused is answered so, without saying the push went as expected", () => {
    const result = push(["refs/heads/fix:refs/heads/fix"], true);
    assert.equal(
      result.stdout,
      "push\n\nerror refs/heads/fix not offered: desolate offer says why above, with its fix\n\n",
    );
    assert.doesNotMatch(result.stderr, EXPECTED);
  });

  it("what it says of a hostile branch name is printable: the name is not in it", () => {
    const hostile = "a\u001b[2J\u202eb\u0007";
    const result = push([
      `refs/heads/${hostile}:refs/heads/${hostile}`,
      "refs/heads/x:refs/heads/x",
    ]);
    const said = result.stderr.split("\n").filter((line) => line && !line.startsWith("offered "));
    assert.equal(said.length, 2, result.stderr);
    for (const line of said) assert.match(line, /^[\x20-\x7e]+$/, JSON.stringify(line));
    // Once per push, however many branches it offered.
    assert.equal(result.stderr.match(EXPECTED)?.length, 1);
  });

  it("cleans up", () => fs.rmSync(bin, { recursive: true, force: true }));
});
