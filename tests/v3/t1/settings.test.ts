// T1. The registry of settings (release/shared/settings.ts, docs/v3/limits.md R6) and
// `desolate settings` (release/host/settings.ts): where a value comes from, that the listing
// finds a setting in any file without a list to keep, that reference.md's table names exactly
// the settings there are, and that no tunable is read from the environment anywhere else.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

const repo = path.resolve(import.meta.dirname, "../../..");
const release = path.join(repo, "release");
let home = "";

/** `desolate settings ...` on the Mac, with a home of its own and `env` added. */
const desolate = (args: string[], env: Record<string, string> = {}) => {
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("DESOLATE_")),
  );
  return spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", path.join(release, "host/cli.ts"), ...args],
    { encoding: "utf8", env: { ...clean, DESOLATE_HOME: home, ...env } },
  );
};
const listed = (env: Record<string, string> = {}) => {
  const result = desolate(["settings", "--json"], env);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as {
    name: string;
    env: string;
    value: unknown;
    from: string | null;
    default: unknown;
    error?: string;
  }[];
};
const one = (name: string, env: Record<string, string> = {}) =>
  listed(env).find((row) => row.name === name)!;

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "desolate-settings-"));
});
after(() => fs.rmSync(home, { recursive: true, force: true }));

describe("T1 settings: where a value comes from", () => {
  it("the default, then what was stored, then the variable before both; unset goes back", () => {
    assert.deepEqual(
      { value: one("workspace.diskGiB").value, from: one("workspace.diskGiB").from },
      { value: 30, from: "default" },
    );
    const set = desolate(["settings", "set", "workspace.diskGiB", "60g"]);
    assert.equal(set.status, 0, set.stderr);
    assert.match(set.stdout, /^workspace\.diskGiB = 60: a workspace made from now on has it/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, "settings.json"), "utf8")), {
      "workspace.diskGiB": { value: "60g", side: "host" },
    });
    assert.deepEqual(
      { value: one("workspace.diskGiB").value, from: one("workspace.diskGiB").from },
      { value: 60, from: "stored" },
    );
    const shell = { DESOLATE_WORKSPACE_DISK_GIB: "90" };
    assert.deepEqual(
      {
        value: one("workspace.diskGiB", shell).value,
        from: one("workspace.diskGiB", shell).from,
      },
      { value: 90, from: "environment" },
    );
    // A set under a variable that comes first says so, or it looks lost.
    assert.match(
      desolate(["settings", "set", "workspace.diskGiB", "70"], shell).stdout,
      /DESOLATE_WORKSPACE_DISK_GIB is set in this shell, and comes first/,
    );
    const unset = desolate(["settings", "unset", "workspace.diskGiB"]);
    assert.equal(unset.status, 0, unset.stderr);
    assert.match(unset.stdout, /^workspace\.diskGiB: back to its default \(30\)/);
    assert.equal(one("workspace.diskGiB").from, "default");
  });

  it("a value the setting does not take is refused, in the setting's own words", () => {
    const refused = desolate(["settings", "set", "workspace.diskGiB", "10g"]);
    assert.equal(refused.status, 64);
    assert.match(
      refused.stderr,
      /workspace\.diskGiB must be a size from 30 to 2048 GiB \(as 60 or 60g\), not '10g'/,
    );
    // Control: what it takes is taken.
    assert.equal(desolate(["settings", "set", "workspace.diskGiB", "40"]).status, 0);
    assert.equal(desolate(["settings", "set", "no.suchSetting", "1"]).status, 64);
    // Stored by hand: refused where it is read, not taken for the default.
    fs.writeFileSync(
      path.join(home, "settings.json"),
      JSON.stringify({ "workspace.diskGiB": { value: "lots", side: "host" } }),
    );
    assert.match(
      one("workspace.diskGiB").error ?? "",
      /workspace\.diskGiB is stored as 'lots', and must be a size from 30 to 2048 GiB/,
    );
    const read = spawnSync(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        "--input-type=module",
        "-e",
        `const s = await import(${JSON.stringify(path.join(release, "shared/size.ts"))}); console.log(JSON.stringify(s.workspaceDefaults()));`,
      ],
      { encoding: "utf8", env: { PATH: process.env.PATH, DESOLATE_HOME: home } },
    );
    assert.notEqual(read.status, 0);
    assert.match(read.stderr, /workspace\.diskGiB is stored as 'lots'/);
    fs.rmSync(path.join(home, "settings.json"));
  });
});

describe("T1 settings: the four that were variables only", () => {
  it("each takes what its variable took, and refuses a typo (the control: what it takes)", () => {
    const at = (rows: ReturnType<typeof listed>, name: string) => {
      const row = rows.find((r) => r.name === name)!;
      return row.error ?? row.value;
    };
    const taken = listed({
      DESOLATE_EDITOR_PORT: "41581",
      DESOLATE_APPROVER: "touchid",
      DESOLATE_TEMPLATES: "0",
      DESOLATE_BROWSER: "Firefox Developer Edition",
    });
    assert.deepEqual(
      ["editor.port", "approver.kind", "workspace.templates", "browser.app"].map((n) =>
        at(taken, n),
      ),
      [41581, "touchid", "off", "Firefox Developer Edition"],
    );
    const refused = listed({
      DESOLATE_EDITOR_PORT: "80",
      DESOLATE_APPROVER: "yubikey",
      DESOLATE_TEMPLATES: "toString",
      DESOLATE_BROWSER: "-a",
    });
    assert.match(String(at(refused, "editor.port")), /must be a whole number from 1024 to 65535/);
    assert.match(
      String(at(refused, "approver.kind")),
      /must be touchid or terminal, not 'yubikey'/,
    );
    assert.match(String(at(refused, "workspace.templates")), /must be on or off \(or 1 or 0\)/);
    assert.match(String(at(refused, "browser.app")), /must be an application's name/);
  });
});

describe("T1 settings: every one is found, and named in the docs", () => {
  it("a setting declared in any file is listed, with no list to keep", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desolate-settings-files-"));
    try {
      fs.mkdirSync(path.join(dir, "shared"));
      fs.mkdirSync(path.join(dir, "elsewhere"));
      // The registry the fixture's file imports is the real one (so both see one registry).
      fs.writeFileSync(
        path.join(dir, "shared/settings.ts"),
        `export * from ${JSON.stringify(path.join(release, "shared/settings.ts"))};\n`,
      );
      fs.writeFileSync(
        path.join(dir, "elsewhere/thing.ts"),
        `import { define, whole } from "../shared/settings.ts";\nexport const T = define({ name: "elsewhere.things", env: "DESOLATE_ELSEWHERE_THINGS", side: "root", default: 3, parse: whole(1, 9), why: "A test's." });\n`,
      );
      // Control: a file that mentions define without importing the registry's is not one.
      fs.writeFileSync(
        path.join(dir, "elsewhere/other.ts"),
        `const define = (x: unknown) => x;\nexport const U = define({ name: "not.aSetting" });\n`,
      );
      const { all, declaring } = await import(path.join(release, "host/settings.ts"));
      assert.deepEqual(declaring(dir), ["elsewhere/thing.ts"]);
      const names = (await all(dir)).map((s: { name: string }) => s.name);
      assert.ok(names.includes("elsewhere.things"), names.join(" "));
      assert.ok(!names.includes("not.aSetting"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("as a person reads them: Mac-wide, when a change applies, a VM's own default said to be", () => {
    const shown = desolate(["settings"]);
    assert.equal(shown.status, 0, shown.stderr);
    assert.match(shown.stdout, /^Settings: .*for every domain and workspace on it/);
    const lines = shown.stdout.split("\n");
    for (const row of listed())
      assert.ok(
        lines.some(
          (line) => line.startsWith(`      read `) && line.includes(`${row.env}; a change: `),
        ),
        `${row.name} does not say when a change applies`,
      );
    assert.ok(
      lines.includes(
        "  reviewer.packThreads = the default, worked out when it is used (how: below)",
      ),
      shown.stdout,
    );
  });

  it("reference.md's table names exactly the settings there are, each by its variable", () => {
    const doc = fs.readFileSync(path.join(release, "docs/reference.md"), "utf8");
    const section = doc.slice(doc.indexOf("\n## Settings\n"));
    assert.ok(section.length > 0 && doc.includes("\n## Settings\n"), "no Settings section");
    const body = section.slice(0, section.indexOf("\n## ", 1));
    const rows = [...body.matchAll(/^\| `([^`]+)` \| `([^`]+)` \|/gm)].map(
      ([, name, env]) => `${name} ${env}`,
    );
    const there = listed().map((row) => `${row.name} ${row.env}`);
    assert.deepEqual(
      [...rows].sort(),
      [...there].sort(),
      "release/docs/reference.md's Settings table and `desolate settings` differ",
    );
  });
});

// ------------------------------------------------------------ no tunable read elsewhere
// Every `process.env.DESOLATE_*` read in release/ is either through the registry or one of
// these, which are not tunables: where things are, who is asking, a test's hook, or a
// protocol between desolate's own processes.
const NOT_TUNABLES = new Set([
  // where things are, and which stack this is
  "DESOLATE_HOME",
  "DESOLATE_INSTANCE",
  "DESOLATE_BACKEND",
  "DESOLATE_IMAGE_DIR",
  "DESOLATE_ROOT_DOMAINS",
  "DESOLATE_ROOT_PROXIES",
  "DESOLATE_ROOT_RUN",
  "DESOLATE_ROOT_STATE",
  "DESOLATE_ROOT_SYS",
  "DESOLATE_PUSHER_HOME",
  "DESOLATE_REVIEWER_HOME",
  "DESOLATE_PROXY_CODE",
  "DESOLATE_HOSTNAME_SUFFIX",
  // who is asking: set by desolate for the programs it starts
  "DESOLATE_DOMAIN",
  "DESOLATE_WORKSPACE_NAME",
  "DESOLATE_PROGRESS",
  // the tests' hooks
  "DESOLATE_FAKE_IMAGE",
  "DESOLATE_LIMACTL",
  "DESOLATE_ROOTCTL",
  "DESOLATE_FORGE_ADMIN",
  "DESOLATE_GH",
  "DESOLATE_TEST_RUN",
  "DESOLATE_TEST_GATEWAY_PORTS",
]);
// A read by a name the code works out (process.env[name]): only where it is the registry's,
// (and its listing's), or passes the environment on whole. host/workspaces.ts's is limits
// 08's to remove.
const COMPUTED_READS = new Set([
  "shared/settings.ts",
  "host/settings.ts",
  "root/proxy/manage.ts",
  // Passes the reviewer's own settings, and nothing else of root's environment, on to the
  // reviewer's process (limits 01): each name is a registered setting's variable.
  "root/review-ask.ts",
]);

/** Each `process.env` read of a DESOLATE_ name in `text`, and whether one is computed. */
const readsIn = (text: string) => ({
  names: [...text.matchAll(/process\.env(?:\.|\[\s*["'`])(DESOLATE_[A-Z0-9_]+)/g)].map(
    ([, name]) => name!,
  ),
  computed: /process\.env\[\s*[A-Za-z_$][\w$.]*\s*\]/.test(text),
});

const codeFiles = (dir: string, at = ""): string[] =>
  fs.readdirSync(path.join(dir, at), { withFileTypes: true }).flatMap((entry) => {
    const rel = path.join(at, entry.name);
    if (entry.isDirectory())
      return ["node_modules", ".harness"].includes(entry.name) ? [] : codeFiles(dir, rel);
    return /\.(ts|mts|js|mjs)$/.test(entry.name) ? [rel] : [];
  });

describe("T1 settings: no tunable read from the environment outside the registry", () => {
  it("finds a read by its name, and one by a computed name (the control)", () => {
    assert.deepEqual(readsIn('const a = process.env.DESOLATE_NEW_THING ?? "5";'), {
      names: ["DESOLATE_NEW_THING"],
      computed: false,
    });
    assert.deepEqual(readsIn('process.env["DESOLATE_OTHER"]; process.env[name];'), {
      names: ["DESOLATE_OTHER"],
      computed: true,
    });
    assert.deepEqual(readsIn("env: { ...process.env, DESOLATE_PROGRESS: '1' }"), {
      names: [],
      computed: false,
    });
  });

  it("every DESOLATE_ variable release/ reads is a setting's, or not a tunable", () => {
    const stray: string[] = [];
    for (const file of codeFiles(release)) {
      const { names, computed } = readsIn(fs.readFileSync(path.join(release, file), "utf8"));
      for (const name of names) if (!NOT_TUNABLES.has(name)) stray.push(`${file}: ${name}`);
      if (computed && !COMPUTED_READS.has(file)) stray.push(`${file}: process.env[<a name>]`);
    }
    assert.deepEqual(
      stray,
      [],
      "a tunable is declared with define() in shared/settings.ts and read with valueOf (docs/v3/limits.md R6); a variable that is not one is named in tests/v3/t1/settings.test.ts",
    );
  });
});
