// T1. A domain's egress proxies: what the secrets proxy's add-on (Python) repeats of the
// TypeScript must say the same, and the domain's audit log, which every one of its proxies
// writes at once, keeps every line while it moves from file to file.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { SLUG } from "../../../release/shared/names.ts";
import { AUDIT, auditFiles, auditLines } from "../../../release/root/proxy/audit.ts";
import { PLACEHOLDER } from "../../../release/root/proxy/secret-store.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ADDON = fs.readFileSync(path.join(ROOT, "release/root/proxy/secrets_addon.py"), "utf8");
/** The pattern of `NAME = re.compile(r"...")` in the add-on. */
const compiled = (name: string) => {
  const match = new RegExp(`^${name} = re\\.compile\\(r"([^"]+)"\\)$`, "m").exec(ADDON);
  assert.ok(match, `secrets_addon.py has no ${name}`);
  return match[1]!;
};
/** A TypeScript rule as the add-on writes it: whole-string matching is its fullmatch. */
const bare = (rule: RegExp) => rule.source.replace(/^\^/, "").replace(/\$$/, "");

describe("the secrets add-on repeats the TypeScript's bounds", () => {
  it("a placeholder name is secret-store.ts's PLACEHOLDER", () => {
    assert.equal(compiled("SECRET_NAME"), bare(PLACEHOLDER));
  });
  it("a workspace's name is names.ts's SLUG", () => {
    assert.equal(compiled("WORKSPACE_NAME"), bare(SLUG));
  });
  it("its audit log is audit.ts's series", () => {
    const match = /^AUDIT_PREFIX, AUDIT_SUFFIX, AUDIT_FILES = "([^"]+)", "([^"]+)", (\d+)$/m.exec(
      ADDON,
    );
    assert.ok(match, "secrets_addon.py has no AUDIT_PREFIX, AUDIT_SUFFIX, AUDIT_FILES");
    assert.deepEqual(
      [match[1], match[2], Number(match[3])],
      [AUDIT.prefix, AUDIT.suffix, AUDIT.files],
    );
    assert.equal(compiled("AUDIT_FILE"), `${AUDIT.prefix}([1-9][0-9]{0,15})\\${AUDIT.suffix}`);
  });
  it("a check above would notice a rule that differs (the control)", () => {
    assert.notEqual(bare(/^[a-z0-9-]{1,80}$/), bare(SLUG));
  });
});

describe("a domain's audit log, written by several proxies at once", () => {
  it("moves to a new file past each share, by one create, and loses no line", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-"));
    // Four writers, each its own process, as a domain's proxies are: 300 lines each, of about
    // 60 bytes, into a budget of 128 KiB (shares of 32 KiB). 72 KB is under the budget, so
    // every line must still be there, across at least two files.
    const writer = path.join(ROOT, "release/root/proxy/audit.ts");
    const one = (w: number) =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            "--disable-warning=ExperimentalWarning",
            "--input-type=module",
            "-e",
            `const { auditWriter } = await import(${JSON.stringify(writer)});
             const write = auditWriter(${JSON.stringify(dir)}, 128 * 1024);
             for (let i = 0; i < 300; i++) write({ time: String(i).padStart(4, "0"), w: ${w}, i });`,
          ],
          {
            stdio: ["ignore", "ignore", "inherit"],
            env: { ...process.env, DESOLATE_ROOT_PROXIES: dir },
          },
        );
        child.on("error", reject);
        child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
      });
    await Promise.all([0, 1, 2, 3].map(one));
    const files = auditFiles(dir);
    assert.ok(files.length >= 2, `one file only: ${files.join(", ")}`);
    assert.ok(files.length <= AUDIT.files, `kept ${files.length} files`);
    const seen = new Set<string>();
    for await (const entry of auditLines(dir)) seen.add(`${entry.w}:${entry.i}`);
    assert.equal(seen.size, 1200);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("lets the oldest go past the budget, and keeps the newest", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-"));
    fs.writeFileSync(path.join(dir, "audit.log"), '{"time":"old"}\n');
    const { auditWriter } = await import("../../../release/root/proxy/audit.ts");
    const write = auditWriter(dir, 4 * 1024);
    for (let i = 0; i < 400; i++) write({ time: String(i).padStart(4, "0"), i });
    const files = auditFiles(dir);
    assert.equal(files.length, AUDIT.files);
    assert.ok(!files.includes("audit.log"), "the file from before the series is let go");
    let last = -1;
    let size = 0;
    for (const name of files) size += fs.statSync(path.join(dir, name)).size;
    for await (const entry of auditLines(dir)) last = Number(entry.i);
    assert.equal(last, 399);
    assert.ok(size <= 4 * 1024 + 200, `kept ${size} bytes of a 4 KiB budget`);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("skips a line too long to be one a proxy wrote, and reads on", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-"));
    fs.writeFileSync(
      path.join(dir, "audit-1.log"),
      `{"a":1}\n${"x".repeat(200 * 1024)}\n{"a":2}\nnot json\n{"a":3}`,
    );
    const read: unknown[] = [];
    for await (const entry of auditLines(dir)) read.push(entry.a);
    assert.deepEqual(read, [1, 2, 3]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("the secrets add-on's streams (Python, without mitmproxy)", () => {
  const python = spawnSync("python3", ["--version"]).status === 0;
  it(
    "a value or a placeholder cut anywhere between chunks is seen; a named body past the bound is refused",
    { skip: python ? false : "no python3 here: the add-on's streams were not tried" },
    () => {
      const run = spawnSync(
        "python3",
        [path.join(ROOT, "tests/v3/t1/proxy/streams.py"), path.join(ROOT, "release/root/proxy")],
        { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } },
      );
      assert.equal(run.status, 0, run.stderr);
      assert.equal(run.stdout.trim(), "ok");
    },
  );
});
