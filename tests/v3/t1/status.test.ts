// What a workspace says about its work is read as data, from files the workspace owns. The
// reader must not be led anywhere else by them.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import { readHead, readNote, readStatus } from "../../../release/shared/status.ts";

describe("T1 status files: read as data, and only where they are", () => {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), "desolate-status-"));
  const base = path.join(top, "repos");
  const git = path.join(base, "acme/widgets/.git");
  fs.mkdirSync(git, { recursive: true });
  const secret = path.join(top, "the-roots-own");
  fs.mkdirSync(secret);
  fs.writeFileSync(path.join(secret, "desolate-note.md"), "ROOT SECRET\n");
  fs.writeFileSync(
    path.join(secret, "desolate-status.json"),
    JSON.stringify({ color: "red", message: "ROOT SECRET", updated: "x" }),
  );
  const status = path.join(git, "desolate-status.json");
  const note = path.join(git, "desolate-note.md");

  it("control: an honest status and note are read", () => {
    fs.writeFileSync(
      status,
      JSON.stringify({
        color: "green",
        message: "tests pass\u001b[31m",
        updated: "2026-01-01T00:00:00Z",
      }),
    );
    fs.writeFileSync(note, "# done\n\u001b]0;title\u0007");
    assert.deepEqual(readStatus(base, status), {
      color: "green",
      message: "tests pass [31m",
      updated: "2026-01-01T00:00:00Z",
    });
    assert.equal(readNote(base, note), "# done\n ]0;title");
  });

  it("a status or note that is a link is not read", () => {
    fs.rmSync(status);
    fs.rmSync(note);
    fs.symlinkSync(path.join(secret, "desolate-status.json"), status);
    fs.symlinkSync(path.join(secret, "desolate-note.md"), note);
    assert.equal(readStatus(base, status), null);
    assert.equal(readNote(base, note), "");
  });

  it("a directory on the way that is a link elsewhere is not walked through", () => {
    fs.rmSync(git, { recursive: true });
    fs.symlinkSync(secret, git);
    assert.equal(
      fs.readFileSync(note, "utf8"),
      "ROOT SECRET\n",
      "control: the path does lead to the other file",
    );
    assert.equal(readStatus(base, status), null);
    assert.equal(readNote(base, note), "");
  });

  it("a fifo, a directory, a status that is too large, an unknown colour: nothing, and no waiting", () => {
    fs.rmSync(git);
    fs.mkdirSync(git);
    fs.mkdirSync(status);
    assert.equal(readStatus(base, status), null);
    fs.rmdirSync(status);
    execFileSync("mkfifo", [status]);
    assert.equal(readStatus(base, status), null, "a fifo is not waited on");
    fs.rmSync(status);
    fs.writeFileSync(status, JSON.stringify({ color: "green", message: "x".repeat(9000) }));
    assert.equal(readStatus(base, status), null);
    fs.writeFileSync(status, JSON.stringify({ color: "javascript:alert(1)", message: "x" }));
    assert.equal(readStatus(base, status), null);
    fs.writeFileSync(note, "y".repeat(40_000));
    assert.equal(
      readNote(base, note),
      `${"y".repeat(16384)}\n…`,
      "a long note is cut, not refused, and the cut is said",
    );
    // Cut inside a character (16,384 is the second of é's two bytes): never half of one.
    fs.writeFileSync(note, `y${"é".repeat(20_000)}`);
    assert.equal(readNote(base, note), `y${"é".repeat(8191)}\n…`);
    fs.rmSync(top, { recursive: true, force: true });
  });
});

describe("T1 a checkout's HEAD: what it has checked out now, read as data", () => {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), "desolate-head-"));
  const base = path.join(top, "repos");
  const clone = path.join(base, "acme/widgets");
  const run = (dir: string, ...args: string[]) =>
    execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      encoding: "utf8",
    }).trim();
  fs.mkdirSync(clone, { recursive: true });
  run(clone, "init", "-q", "-b", "main");
  run(clone, "commit", "-q", "--allow-empty", "-m", "one");
  const main = { repo: "acme/widgets", kind: "main", name: "" };
  const tree = { repo: "acme/widgets", kind: "worktree", name: "w2" };

  it("the main checkout and a worktree, as git has them, loose refs or packed", () => {
    const one = run(clone, "rev-parse", "HEAD");
    assert.deepEqual(readHead(base, main), { branch: "main", commit: one });
    run(clone, "switch", "-q", "-c", "feature/greeting");
    run(clone, "commit", "-q", "--allow-empty", "-m", "two");
    assert.deepEqual(readHead(base, main), {
      branch: "feature/greeting",
      commit: run(clone, "rev-parse", "HEAD"),
    });
    run(clone, "pack-refs", "--all");
    assert.deepEqual(
      readHead(base, main),
      { branch: "feature/greeting", commit: run(clone, "rev-parse", "HEAD") },
      "from packed-refs",
    );
    const packed = path.join(clone, ".git", "packed-refs");
    const honest = fs.readFileSync(packed, "utf8");
    fs.writeFileSync(packed, honest + `# ${"x".repeat(300 * 1024)}\n`);
    assert.deepEqual(
      readHead(base, main),
      { branch: "feature/greeting", commit: run(clone, "rev-parse", "HEAD") },
      "a packed-refs of any size is read: what is not a ref's line is passed over",
    );
    fs.writeFileSync(packed, honest);
    run(clone, "worktree", "add", "-q", "-b", "w2", ".worktrees/w2", "main");
    assert.deepEqual(readHead(base, tree), { branch: "w2", commit: one });
    run(path.join(clone, ".worktrees/w2"), "switch", "-q", "--detach");
    assert.deepEqual(readHead(base, tree), { branch: null, commit: one }, "detached");
  });

  it("a repository with 5,000 branches shows its commits (the control: its packed-refs is past what was once read)", () => {
    const many = path.join(base, "acme/many");
    fs.mkdirSync(many, { recursive: true });
    run(many, "init", "-q", "-b", "main");
    run(many, "commit", "-q", "--allow-empty", "-m", "one");
    const one = run(many, "rev-parse", "HEAD");
    run(many, "commit", "-q", "--allow-empty", "-m", "two");
    const two = run(many, "rev-parse", "HEAD");
    // Every branch at the first commit but three, at the second: the first, one in the
    // middle and the last, as git sorts them.
    const names = Array.from(
      { length: 5000 },
      (_, i) => `team/feature-${String(i).padStart(4, "0")}`,
    );
    const moved = new Set([names[0]!, names[2500]!, names[4999]!]);
    execFileSync("git", ["-C", many, "update-ref", "--stdin"], {
      input: names.map((n) => `create refs/heads/${n} ${moved.has(n) ? two : one}\n`).join(""),
    });
    run(many, "pack-refs", "--all");
    const packed = path.join(many, ".git", "packed-refs");
    // The control: until 2026-11-20 a packed-refs over 256 KiB was not read at all, and no
    // branch of such a repository showed a commit. This one is over it.
    assert.ok(fs.statSync(packed).size > 256 * 1024, `${fs.statSync(packed).size} bytes`);
    assert.ok(!fs.existsSync(path.join(many, ".git/refs/heads/team")), "every branch is packed");
    const at = (branch: string) => {
      fs.writeFileSync(path.join(many, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
      return readHead(base, { repo: "acme/many", kind: "main", name: "" });
    };
    for (const name of ["main", names[1]!, names[1234]!, names[4998]!])
      assert.deepEqual(at(name), { branch: name, commit: name === "main" ? two : one }, name);
    for (const name of moved) assert.deepEqual(at(name), { branch: name, commit: two }, name);
    assert.deepEqual(at("team/feature-5000"), { branch: "team/feature-5000", commit: null });
    assert.deepEqual(at("a-first"), { branch: "a-first", commit: null }, "before every ref");
    assert.deepEqual(at("zz-last"), { branch: "zz-last", commit: null }, "after every ref");
    // A branch that moves is seen to: the file changed, so what was found before is not kept.
    run(many, "update-ref", `refs/heads/${names[1234]}`, two);
    run(many, "pack-refs", "--all");
    assert.deepEqual(at(names[1234]!), { branch: names[1234], commit: two });
    // A file that does not say it is sorted (an older git's, another program's) is read
    // through in order, whatever its order; past 256 KiB it is not, and no commit is shown.
    const lines = fs
      .readFileSync(packed, "utf8")
      .split("\n")
      .filter((l) => l && !l.startsWith("#"));
    const few = lines.filter((l) => /feature-00\d\d$/.test(l) || l.endsWith("refs/heads/main"));
    fs.writeFileSync(packed, `${few.reverse().join("\n")}\n`);
    assert.deepEqual(at(names[42]!), { branch: names[42], commit: one }, "unsorted, and found");
    assert.deepEqual(at("main"), { branch: "main", commit: two }, "unsorted, and found last");
    fs.writeFileSync(packed, `${lines.reverse().join("\n")}\n`);
    assert.deepEqual(at(names[42]!), { branch: names[42], commit: null }, "unsorted and large");
  });

  it("a HEAD the workspace wrote is believed only as far as a name desolate would carry", () => {
    const head = path.join(clone, ".git", "HEAD");
    const keep = fs.readFileSync(head, "utf8");
    for (const text of [
      "ref: refs/heads/../../../etc/passwd\n",
      "ref: refs/heads/-x\n",
      "ref: refs/tags/v1\n",
      "garbage\n",
      "ref: refs/heads/a\u001b[2J\n",
    ]) {
      fs.writeFileSync(head, text);
      assert.deepEqual(readHead(base, main), { branch: null, commit: null }, JSON.stringify(text));
    }
    fs.writeFileSync(head, "ref: refs/heads/live-");
    assert.equal(
      readHead(base, main),
      null,
      "half written (no newline yet): unsettled, not a branch called live-",
    );
    fs.rmSync(head);
    fs.symlinkSync(path.join(top, "elsewhere"), head);
    fs.writeFileSync(path.join(top, "elsewhere"), keep);
    assert.equal(readHead(base, main), null, "a HEAD that is a link is not followed");
    fs.rmSync(head);
    fs.writeFileSync(head, keep);
    fs.rmSync(top, { recursive: true, force: true });
  });
});
