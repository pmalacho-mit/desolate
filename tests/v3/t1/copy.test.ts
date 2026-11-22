// T1. Taking in a file another side wrote (shared/copy.ts): the host from the git VM, the root
// from the host. Each hostile shape is refused, and nothing half-copied is left behind.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { copyOut, openPlain, takeHashed } from "../../../release/shared/copy.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desolate-copy-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const content = Buffer.from("an LFS object\n");
const oid = createHash("sha256").update(content).digest("hex");
const leftovers = () => fs.readdirSync(dir).filter((name) => name.includes(".part"));
let n = 0;
const target = () => path.join(dir, `to-${n++}`);

describe("T1 taking in a file another side wrote", () => {
  it("a plain file that hashes to its name is taken, as a copy", async () => {
    const from = path.join(dir, "good");
    fs.writeFileSync(from, content);
    const to = target();
    assert.equal(await takeHashed(from, to, oid, 1024), null);
    assert.deepEqual(fs.readFileSync(to), content);
    assert.notEqual(fs.statSync(to).ino, fs.statSync(from).ino);
    assert.deepEqual(leftovers(), []);
  });
  it("a wrong hash is refused, and nothing is left", async () => {
    const from = path.join(dir, "liar");
    fs.writeFileSync(from, "something else\n");
    const to = target();
    assert.equal(await takeHashed(from, to, oid, 1024), "it does not hash to its name");
    assert.equal(fs.existsSync(to), false);
    assert.deepEqual(leftovers(), []);
  });
  it("a link, even to a good file, is not followed", async () => {
    const link = path.join(dir, "link");
    fs.symlinkSync(path.join(dir, "good"), link);
    assert.equal(
      await takeHashed(link, target(), oid, 1024),
      "not a plain file of a size desolate takes",
    );
  });
  it("a FIFO is refused at once: the reader does not block on it", async () => {
    const fifo = path.join(dir, "fifo");
    execFileSync("mkfifo", [fifo]);
    const started = Date.now();
    assert.equal(
      await takeHashed(fifo, target(), oid, 1024),
      "not a plain file of a size desolate takes",
    );
    assert.ok(Date.now() - started < 1000);
  });
  it("a file over the size is refused before a byte is copied", async () => {
    const big = path.join(dir, "big");
    fs.writeFileSync(big, Buffer.alloc(4096));
    const to = target();
    assert.equal(await takeHashed(big, to, oid, 1024), "not a plain file of a size desolate takes");
    assert.equal(fs.existsSync(to), false);
    assert.deepEqual(leftovers(), []);
  });
  it("what is there already is kept, and not written through", async () => {
    const to = target();
    fs.writeFileSync(to, content);
    assert.equal(await takeHashed(path.join(dir, "liar"), to, oid, 1024), null);
    assert.deepEqual(fs.readFileSync(to), content);
  });

  // copyOut is asynchronous, so the other side has the whole copy to act in. A 64 MiB file
  // of one byte repeated, and what it hashes to.
  const SIZE = 64 * 1024 * 1024;
  const ones = Buffer.alloc(SIZE, 1);
  const onesOid = createHash("sha256").update(ones).digest("hex");
  const copying = (name: string) => {
    const from = path.join(dir, name);
    fs.writeFileSync(from, ones);
    const opened = openPlain(from, SIZE)!;
    const to = target();
    return { from, to, opened, copy: copyOut(opened, to).finally(() => fs.closeSync(opened.fd)) };
  };
  it("control: a large copy lets the loop run meanwhile, and keeps every byte", async () => {
    const { to, copy } = copying("large");
    let turns = 0;
    const turn = setInterval(() => turns++, 0);
    assert.equal(await copy, onesOid);
    clearInterval(turn);
    assert.ok(turns > 0, "a timer ran while it copied");
    assert.equal(fs.statSync(to).size, SIZE);
  });
  it("its name swapped for a link to a secret as it copies: what was opened is what is copied", async () => {
    const secret = path.join(dir, "secret");
    fs.writeFileSync(secret, Buffer.alloc(SIZE, 2));
    const { from, to, copy } = copying("swapped");
    setImmediate(() => {
      fs.rmSync(from);
      fs.symlinkSync(secret, from);
    });
    assert.equal(await copy, onesOid);
    assert.deepEqual(fs.readFileSync(to).subarray(SIZE - 4), Buffer.alloc(4, 1));
  });
  it("made shorter as it copies: refused, not taken short", async () => {
    const { from, copy } = copying("shrinks");
    setImmediate(() => fs.truncateSync(from, 1024));
    await assert.rejects(copy, /the file got shorter while it was copied/);
  });
});
