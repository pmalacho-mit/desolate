// T1. The root reads a domain's outbox as data: what a hostile domain can put there, and
// what the root makes of it. (P4. The end-to-end version, with git, is in t2/04-offers.)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

const work = fs.mkdtempSync(path.join(os.tmpdir(), "desolate-outbox-"));
// layout.ts reads these when it is first imported.
process.env.DESOLATE_ROOT_STATE = path.join(work, "state");
process.env.DESOLATE_ROOT_DOMAINS = path.join(work, "domains");
let outbox: typeof import("../../../release/root/outbox.ts");
const domains = process.env.DESOLATE_ROOT_DOMAINS;

// outbox.ts runs only in the root VM, which is Linux everywhere: it asks /proc/self/fd where
// an open directory really is. Off Linux there is no such question to ask, and it must then
// refuse everything rather than guess. The suite proper needs Linux; the one below it proves
// the refusal, so a Mac running T1 shows a skip and a pass, never a silent hole.
const ON_LINUX = process.platform === "linux";
const NEEDS_LINUX =
  "outbox.ts runs in the root VM (Linux) and needs /proc/self/fd; run T1 on Linux, or in the root VM";

describe(
  "T1 outbox, off Linux: fails closed",
  { skip: ON_LINUX ? "this is Linux: the suite below runs instead" : false },
  () => {
    it("a real directory with honest files in it is refused, not read by some weaker route", async () => {
      const mod = await import("../../../release/root/outbox.ts");
      const dir = `${domains}/t1-dom/outbox/sync/acme/widgets`;
      fs.mkdirSync(`${domains}/t1-dom/outbox/requests`, { recursive: true });
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(`${dir}/refs.json`, JSON.stringify({ refs: { main: "a".repeat(40) } }));
      fs.writeFileSync(`${dir}/a.bundle`, "x");
      fs.writeFileSync(`${domains}/t1-dom/outbox/requests/r.json`, JSON.stringify({ op: "fetch" }));
      assert.equal(mod.openDir(dir), null);
      assert.deepEqual(mod.refsOf("t1-dom", "acme/widgets"), {
        refused:
          "acme/widgets's list of branches (refs.json) could not be read: its directory in the outbox is not a plain one",
      });
      assert.deepEqual(mod.takeBundles("t1-dom", "acme/widgets"), {
        copies: [],
        dropped: [],
        more: false,
      });
      assert.deepEqual(mod.drain(`${domains}/t1-dom/outbox/requests`, /\.json$/, 50), []);
      assert.deepEqual(
        fs.readdirSync(dir).sort(),
        ["a.bundle", "refs.json"],
        "and nothing was removed",
      );
      fs.rmSync(work, { recursive: true, force: true });
    });
  },
);

describe("T1 outbox", { skip: ON_LINUX ? false : NEEDS_LINUX }, () => {
  const sync = `${domains}/t1-dom/outbox/sync/acme/widgets`;
  const lfs = `${domains}/t1-dom/outbox/lfs/acme/widgets`;
  const refs = (repo: string) => {
    const listed = outbox.refsOf("t1-dom", repo);
    assert.ok("refs" in listed, JSON.stringify(listed));
    return listed.refs;
  };
  before(async () => {
    outbox = await import("../../../release/root/outbox.ts");
    fs.mkdirSync(sync, { recursive: true });
    fs.mkdirSync(lfs, { recursive: true });
  });
  after(() => {
    fs.rmSync(`${domains}/t1-dom`, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  });

  it("only well-formed branches and commits survive a refs list", () => {
    const sha = "a".repeat(40);
    fs.writeFileSync(
      `${sync}/refs.json`,
      JSON.stringify({
        refs: {
          main: sha,
          "issue/12": sha,
          "../../x": sha,
          "-oProxyCommand=x": sha,
          "a b": sha,
          short: "abc",
          "refs/heads/main": sha,
        },
      }),
    );
    assert.deepEqual(Object.keys(refs("acme/widgets")).sort(), [
      "issue/12",
      "main",
      "refs/heads/main",
    ]);
    assert.deepEqual(
      outbox.refsOf("t1-dom", "../../etc"),
      { refused: "'../../etc' is not a repository" },
      "a repository that is not one lists nothing",
    );
  });

  it("a refs list that is a symlink, or not JSON, is refused, and said: never taken for an empty one", () => {
    fs.rmSync(`${sync}/refs.json`);
    fs.symlinkSync("/etc/passwd", `${sync}/refs.json`);
    assert.deepEqual(outbox.refsOf("t1-dom", "acme/widgets"), {
      refused: "acme/widgets's list of branches (refs.json) is not a plain file",
    });
    fs.rmSync(`${sync}/refs.json`);
    fs.writeFileSync(`${sync}/refs.json`, "not json");
    assert.deepEqual(outbox.refsOf("t1-dom", "acme/widgets"), {
      refused: "acme/widgets's list of branches (refs.json) is not JSON",
    });
    fs.rmSync(`${sync}/refs.json`);
    assert.deepEqual(
      outbox.refsOf("t1-dom", "acme/widgets"),
      { refs: {} },
      "control: no list at all is no branches (nothing synced yet), not a refusal",
    );
  });

  it("a refs list is read whole or refused whole: past its bound it is refused by name, never cut", () => {
    const A = "a".repeat(40);
    // More than the old cut of 5,000: every one is listed, so git prunes none of them.
    fs.writeFileSync(
      `${sync}/refs.json`,
      JSON.stringify({
        refs: Object.fromEntries(Array.from({ length: 6000 }, (_, i) => [`b${i}`, A])),
      }),
    );
    assert.equal(Object.keys(refs("acme/widgets")).length, 6000, "control: every branch");
    // One byte past the bound: refused, with the bound and the size.
    const over = outbox.REFS_BYTES + 1;
    const head = JSON.stringify({ refs: { main: A }, pad: "" });
    fs.writeFileSync(
      `${sync}/refs.json`,
      head.slice(0, -2) + "x".repeat(over - head.length) + head.slice(-2),
    );
    assert.equal(fs.statSync(`${sync}/refs.json`).size, over);
    assert.deepEqual(outbox.refsOf("t1-dom", "acme/widgets"), {
      refused: `acme/widgets's list of branches (refs.json) is ${over} bytes, over the ${outbox.REFS_BYTES} allowed`,
    });
    // Control: at the bound exactly, read.
    fs.writeFileSync(
      `${sync}/refs.json`,
      head.slice(0, -2) + "x".repeat(over - 1 - head.length) + head.slice(-2),
    );
    assert.deepEqual(refs("acme/widgets"), { main: A });
  });

  it("a bundle past the largest pack the forge takes is dropped, and said as that bound", () => {
    const dir = `${domains}/t1-dom/outbox/sync/acme/huge`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/a.bundle`, "");
    fs.truncateSync(`${dir}/a.bundle`, 2 * 1024 ** 3 + 1);
    fs.writeFileSync(`${dir}/b.bundle`, "a bundle's bytes");
    const taken = outbox.takeBundles("t1-dom", "acme/huge");
    assert.deepEqual(taken.dropped, [
      "the bundle a.bundle is 2147483649 bytes, over the 2147483648 a push to the forge may carry",
    ]);
    assert.deepEqual(
      taken.copies.map((copy) => fs.readFileSync(copy, "utf8")),
      ["a bundle's bytes"],
      "control: the one beside it, within the bound, is taken",
    );
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  it("only regular bundle files with plain names are taken; every name that was looked at is removed from the outbox, and nothing else", () => {
    fs.writeFileSync(`${sync}/abc-1.bundle`, "one bundle's bytes");
    fs.writeFileSync(`${sync}/UPPER.bundle`, "x");
    fs.writeFileSync(`${sync}/a b.bundle`, "x");
    fs.symlinkSync("/etc/passwd", `${sync}/zz.bundle`);
    fs.mkdirSync(`${sync}/dir.bundle`);
    const taken = outbox.takeBundles("t1-dom", "acme/widgets");
    assert.equal(taken.copies.length, 1);
    assert.equal(fs.readFileSync(taken.copies[0]!, "utf8"), "one bundle's bytes");
    assert.ok(
      taken.copies[0]!.startsWith(path.join(work, "state", "incoming")),
      "the copy is in the root's own directory",
    );
    assert.equal(
      taken.dropped.length,
      2,
      "the symlink and the directory were dropped, not followed",
    );
    assert.deepEqual(
      fs.readdirSync(sync).sort(),
      ["UPPER.bundle", "a b.bundle", "dir.bundle", "refs.json"],
      "names that are not a bundle's are left alone; the symlink itself is gone",
    );
    assert.ok(fs.existsSync("/etc/passwd"), "and what it pointed at is not");
  });

  it("an LFS object is taken only if it hashes to its name and has the size its pointer said", async () => {
    const data = Buffer.from("large file content");
    const oid = createHash("sha256").update(data).digest("hex");
    const target = (name: string) => path.join(work, "store", name);
    fs.writeFileSync(`${lfs}/${oid}`, data);
    assert.deepEqual(
      await outbox.takeLfs("t1-dom", "acme/widgets", oid, data.length, target(oid)),
      { ok: true },
      "control: an honest object is accepted",
    );
    assert.deepEqual(fs.readFileSync(target(oid)), data, "and what was kept is what was hashed");
    assert.ok(!fs.existsSync(`${lfs}/${oid}`), "once taken, it is removed from the outbox");
    fs.writeFileSync(`${lfs}/${oid}`, data);
    assert.match(
      (
        (await outbox.takeLfs("t1-dom", "acme/widgets", oid, data.length + 1, target("size"))) as {
          error: string;
        }
      ).error,
      /its pointer says/,
    );
    const wrong = "b".repeat(64);
    fs.writeFileSync(`${lfs}/${wrong}`, data);
    assert.match(
      (
        (await outbox.takeLfs("t1-dom", "acme/widgets", wrong, data.length, target(wrong))) as {
          error: string;
        }
      ).error,
      /does not hash to its id/,
    );
    const linked = "c".repeat(64);
    fs.symlinkSync("/etc/passwd", `${lfs}/${linked}`);
    assert.match(
      (
        (await outbox.takeLfs("t1-dom", "acme/widgets", linked, 1, target(linked))) as {
          error: string;
        }
      ).error,
      /^the LFS object cccccccccccc is not a plain file$/,
      "a link is not followed, and is said to be what it is",
    );
    // Past the largest object the forge stores (a sparse file: its size is what is checked,
    // before a byte of it is read), refused by that bound, by name.
    const huge = "d".repeat(64);
    fs.writeFileSync(`${lfs}/${huge}`, "");
    fs.truncateSync(`${lfs}/${huge}`, 5 * 1024 ** 3 + 1);
    assert.equal(
      ((await outbox.takeLfs("t1-dom", "acme/widgets", huge, 1, target(huge))) as { error: string })
        .error,
      "the LFS object dddddddddddd is 5368709121 bytes, over the 5368709120 the forge stores",
    );
    fs.rmSync(`${lfs}/${huge}`);
    assert.match(
      (
        (await outbox.takeLfs("t1-dom", "acme/widgets", "../../x", 1, target("x"))) as {
          error: string;
        }
      ).error,
      /not an LFS object id/,
    );
    assert.deepEqual(
      fs.readdirSync(path.join(work, "store")),
      [oid],
      "nothing that was refused was kept, not even a partial copy",
    );
  });

  it("a large LFS object from one domain does not hold the root: a second domain's is taken meanwhile", async () => {
    // rootd answers every domain from one loop. A sparse 256 MiB object, all zeros: its
    // hash is computed here, a MiB at a time.
    const big = 256 * 1024 * 1024;
    const zeros = createHash("sha256");
    for (let at = 0; at < big; at += 1024 * 1024) zeros.update(Buffer.alloc(1024 * 1024));
    const bigOid = zeros.digest("hex");
    fs.writeFileSync(`${lfs}/${bigOid}`, "");
    fs.truncateSync(`${lfs}/${bigOid}`, big);
    const other = `${domains}/t1-other/outbox/lfs/acme/other`;
    fs.mkdirSync(other, { recursive: true });
    const small = Buffer.from("the second domain's object");
    const smallOid = createHash("sha256").update(small).digest("hex");
    fs.writeFileSync(`${other}/${smallOid}`, small);
    const store = path.join(work, "store-meanwhile");
    const done: string[] = [];
    const large = outbox
      .takeLfs("t1-dom", "acme/widgets", bigOid, big, path.join(store, bigOid))
      .then((taken) => (done.push("large"), taken));
    const second = outbox
      .takeLfs("t1-other", "acme/other", smallOid, small.length, path.join(store, smallOid))
      .then((taken) => (done.push("second"), taken));
    assert.deepEqual(await Promise.all([large, second]), [{ ok: true }, { ok: true }]);
    assert.deepEqual(done, ["second", "large"], "the second domain did not wait for the copy");
    assert.equal(fs.statSync(path.join(store, bigOid)).size, big);
    fs.rmSync(store, { recursive: true, force: true });
    fs.rmSync(`${domains}/t1-other`, { recursive: true, force: true });
  });

  it("an LFS object made shorter while it is copied is refused, and nothing of it is kept", async () => {
    const size = 64 * 1024 * 1024;
    const oid = "e".repeat(64);
    fs.writeFileSync(`${lfs}/${oid}`, "");
    fs.truncateSync(`${lfs}/${oid}`, size);
    const store = path.join(work, "store-shorter");
    const taking = outbox.takeLfs("t1-dom", "acme/widgets", oid, size, path.join(store, oid));
    // The workspace, as the root copies: what is left is a MiB.
    setImmediate(() => fs.truncateSync(`${lfs}/${oid}`, 1024 * 1024));
    assert.deepEqual(await taking, {
      error:
        "the LFS object eeeeeeeeeeee could not be copied: the file got shorter while it was copied",
    });
    assert.deepEqual(fs.readdirSync(store), [], "not even a partial copy");
    fs.rmSync(`${lfs}/${oid}`, { force: true });
  });

  it("a symlink anywhere on the way to a file is not followed: not at the end, not at a directory above", () => {
    // What a workspace can do in its outbox: make any component a symlink. In the root VM
    // it would resolve to the root's own files.
    const secret = path.join(work, "roots-own");
    fs.mkdirSync(secret, { recursive: true });
    fs.writeFileSync(
      path.join(secret, "refs.json"),
      JSON.stringify({ refs: { stolen: "a".repeat(40) } }),
    );
    fs.writeFileSync(path.join(secret, "zz.bundle"), "the root's own file");
    const honest = `${domains}/t1-dom/outbox/sync/acme/honest`;
    fs.mkdirSync(honest, { recursive: true });
    fs.writeFileSync(`${honest}/refs.json`, JSON.stringify({ refs: { fine: "b".repeat(40) } }));
    fs.writeFileSync(`${honest}/aa.bundle`, "a bundle's bytes");
    assert.deepEqual(
      refs("acme/honest"),
      { fine: "b".repeat(40) },
      "control: a plain file in a plain directory is read",
    );
    const honestTaken = outbox.takeBundles("t1-dom", "acme/honest");
    assert.deepEqual(
      honestTaken.copies.map((copy) => fs.readFileSync(copy, "utf8")),
      ["a bundle's bytes"],
      "control: a plain bundle in a plain directory is taken",
    );
    // The directory itself is a symlink to the root's files.
    fs.symlinkSync(secret, `${domains}/t1-dom/outbox/sync/acme/linked`);
    assert.deepEqual(
      outbox.refsOf("t1-dom", "acme/linked"),
      {
        refused:
          "acme/linked's list of branches (refs.json) could not be read: its directory in the outbox is not a plain one",
      },
      "a refs list reached through a symlinked directory is not read",
    );
    // A link that leads nowhere is something there, not nothing synced: taken for none, git
    // would prune every branch of the domain's on it. So is one further up the way.
    fs.symlinkSync(`${work}/nowhere`, `${domains}/t1-dom/outbox/sync/acme/dangling`);
    assert.deepEqual(outbox.refsOf("t1-dom", "acme/dangling"), {
      refused:
        "acme/dangling's list of branches (refs.json) could not be read: its directory in the outbox is not a plain one",
    });
    fs.symlinkSync(`${work}/nowhere`, `${domains}/t1-dom/outbox/sync/dangling-owner`);
    assert.ok("refused" in outbox.refsOf("t1-dom", "dangling-owner/app"));
    assert.deepEqual(
      outbox.refsOf("t1-dom", "acme/never-synced"),
      { refs: {} },
      "control: a repository nothing was synced for has no branches, and that is no refusal",
    );
    assert.deepEqual(
      outbox.takeBundles("t1-dom", "acme/linked"),
      { copies: [], dropped: [], more: false },
      "nor a bundle",
    );
    assert.equal(
      fs.readFileSync(path.join(secret, "zz.bundle"), "utf8"),
      "the root's own file",
      "and the root's own file was not removed through the domain's path",
    );
    // A directory two levels up is a symlink.
    fs.symlinkSync(path.join(work, "roots-own-tree"), `${domains}/t1-dom/outbox/requests`);
    fs.mkdirSync(path.join(work, "roots-own-tree"), { recursive: true });
    fs.writeFileSync(path.join(work, "roots-own-tree", "r.json"), JSON.stringify({ op: "fetch" }));
    assert.deepEqual(outbox.drain(`${domains}/t1-dom/outbox/requests`, /\.json$/, 50), []);
    assert.ok(
      fs.existsSync(path.join(work, "roots-own-tree", "r.json")),
      "nothing was drained from, or removed in, the directory the symlink led to",
    );
    // A FIFO where a file should be would hold a reader for ever: it is not opened to be read.
    spawnSync("mkfifo", [`${honest}/pipe.bundle`]);
    assert.deepEqual(outbox.takeBundles("t1-dom", "acme/honest"), {
      copies: [],
      dropped: ["the bundle pipe.bundle is not a plain file"],
      more: false,
    });
    // CONTROL for drain: an honest request is read once and removed.
    fs.rmSync(`${domains}/t1-dom/outbox/requests`);
    fs.mkdirSync(`${domains}/t1-dom/outbox/requests`);
    fs.writeFileSync(`${domains}/t1-dom/outbox/requests/a1.json`, JSON.stringify({ op: "fetch" }));
    assert.deepEqual(outbox.drain(`${domains}/t1-dom/outbox/requests`, /\.json$/, 50), [
      { name: "a1.json", data: { op: "fetch" } },
    ]);
    assert.deepEqual(fs.readdirSync(`${domains}/t1-dom/outbox/requests`), []);
  });

  it("size: a JSON file over the limit is not read; bundles are taken one at a time when asked", () => {
    const requests = `${domains}/t1-dom/outbox/requests`;
    const pad = (bytes: number) => JSON.stringify({ op: "fetch", pad: "x".repeat(bytes) });
    fs.writeFileSync(`${requests}/big.json`, pad(1024 * 1024));
    fs.writeFileSync(`${requests}/fits.json`, pad(1024 * 1024 - 100));
    fs.writeFileSync(`${requests}/notjson.json`, "{");
    const drained = outbox.drain<{ op: string }>(requests, /\.json$/, 50);
    assert.deepEqual(
      drained.map((d) => [d.name, d.data?.op ?? null, "why" in d ? d.why : null]),
      [
        [
          "big.json",
          null,
          `the request big.json is ${pad(1024 * 1024).length} bytes, over the 1048576 allowed`,
        ],
        ["fits.json", "fetch", null],
        ["notjson.json", null, "the request notjson.json is not JSON"],
      ],
      "a request past the bound says the bound and its size; control: just under it is read",
    );
    const many = `${domains}/t1-dom/outbox/sync/acme/many`;
    fs.mkdirSync(many, { recursive: true });
    for (const name of ["a", "b", "c"])
      fs.writeFileSync(`${many}/${name}.bundle`, `bundle ${name}`);
    const first = outbox.takeBundles("t1-dom", "acme/many", 1);
    assert.deepEqual(
      [
        first.copies.length,
        first.more,
        fs.readFileSync(first.copies[0]!, "utf8"),
        fs.readdirSync(many),
      ],
      [1, true, "bundle a", ["b.bundle", "c.bundle"]],
    );
    outbox.takeBundles("t1-dom", "acme/many", 1);
    const last = outbox.takeBundles("t1-dom", "acme/many", 1);
    assert.deepEqual([last.copies.length, last.more, fs.readdirSync(many)], [1, false, []]);
  });
});

describe(
  "T1 a domain's list of its branches: its word, read as data",
  { skip: ON_LINUX ? false : NEEDS_LINUX },
  () => {
    it("names desolate would carry, commits that are commits, every one; a link is not followed", async () => {
      const { branchesOf } = await import("../../../release/root/outbox.ts");
      const dir = `${domains}/t1-branches/outbox/sync/acme/widgets`;
      fs.mkdirSync(dir, { recursive: true });
      const A = "a".repeat(40);
      fs.writeFileSync(
        `${dir}/refs.json`,
        JSON.stringify({
          refs: { main: A, "feature/x": A, "--upload-pack=x": A, "../../etc": A, bad: "nope" },
        }),
      );
      assert.deepEqual(branchesOf("t1-branches", ["acme/widgets", "acme/absent"]), [
        { repo: "acme/widgets", branch: "main", commit: A },
        { repo: "acme/widgets", branch: "feature/x", commit: A },
      ]);
      fs.writeFileSync(
        `${dir}/refs.json`,
        JSON.stringify({
          refs: Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`b${i}`, A])),
        }),
      );
      assert.equal(
        branchesOf("t1-branches", ["acme/widgets"]).length,
        500,
        "every one: the file's size is the bound, not a count",
      );
      fs.rmSync(`${dir}/refs.json`);
      fs.writeFileSync(path.join(work, "elsewhere.json"), JSON.stringify({ refs: { main: A } }));
      fs.symlinkSync(path.join(work, "elsewhere.json"), `${dir}/refs.json`);
      assert.deepEqual(
        branchesOf("t1-branches", ["acme/widgets"]),
        [],
        "a list that is a link is not read",
      );
    });
  },
);
