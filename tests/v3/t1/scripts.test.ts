// T1. The shell around the stack: the copies of a rule that shell cannot import, the recipes'
// workspace names, and the restart loop that keeps the root's services running.
//
// Shell cannot import shared/names.ts, so the slug rule is written again in three scripts
// (root/start.sh, root/proxy-user.sh, completion.bash). This reads each copy out of its
// script and runs it, in bash, beside isSlug, on the same names: one rule, kept one by this.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { isSlug } from "../../../release/shared/names.ts";

const RELEASE = path.resolve(import.meta.dirname, "../../../release");
let work = "";
before(() => (work = fs.mkdtempSync(path.join(os.tmpdir(), "desolate-scripts-"))));
after(() => fs.rmSync(work, { recursive: true, force: true }));

/** The names every copy is tried on: isSlug's own table, each edge of the rule, and many
 *  more made from the characters that matter (a fixed sequence, so a failure is repeatable). */
const names = (): string[] => {
  const edges = [
    ...["acme", "issue-12", "Acme", "-acme", "acme-", "acme--widgets", "a--b--c", "a---b"],
    ...["xn--widgets", "a.b", "x".repeat(40), "x".repeat(41), "", "a", "0", "-", "--", "a b"],
    ...["xn-a", "axn--b", "a--b-", "a-b-c", "é", "aé", "ａ", "a\nb", "a/b", "$(id)", "a_b"],
  ];
  const alphabet = "ab0-x-n.-A_";
  let seed = 7;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31);
  const made = Array.from({ length: 3000 }, () => {
    const length = next() % 44;
    return Array.from({ length }, () => alphabet[next() % alphabet.length]).join("");
  });
  return [...edges, ...made];
};

/** The line that defines `fn` in `script`: the copy, as the script itself has it. */
const copyOf = (script: string, fn: string): string => {
  const line = fs
    .readFileSync(path.join(RELEASE, script), "utf8")
    .split("\n")
    .find((each) => each.startsWith(`${fn}() {`));
  assert.ok(line, `${script} defines ${fn}() on one line`);
  return line;
};

describe("T1 the slug rule's shell copies are shared/names.ts's isSlug", () => {
  for (const [script, fn] of [
    ["root/start.sh", "is_slug"],
    ["root/proxy-user.sh", "is_slug"],
    ["completion.bash", "_desolate_slug"],
  ] as const)
    it(`${script}'s ${fn}, in the C locale and in a UTF-8 one`, () => {
      const all = names();
      for (const locale of ["C", "C.UTF-8", "en_US.UTF-8"]) {
        // One name per NUL-ended record, so a name with a newline in it is one name.
        const ran = spawnSync(
          "bash",
          [
            "--norc",
            "--noprofile",
            "-c",
            `${copyOf(script, fn)}\nwhile IFS= read -r -d '' name; do if ${fn} "$name"; then echo 1; else echo 0; fi; done`,
          ],
          {
            input: all.map((name) => `${name}\0`).join(""),
            encoding: "utf8",
            env: { PATH: process.env.PATH, LC_ALL: locale },
          },
        );
        assert.equal(ran.status, 0, ran.stderr);
        const said = ran.stdout.split("\n").slice(0, -1);
        assert.equal(said.length, all.length);
        const differ = all.filter((name, i) => (said[i] === "1") !== isSlug(name));
        assert.deepEqual(differ, [], `${fn} and isSlug disagree (${locale})`);
      }
      // Control: the check would see a copy that drifted (the old copy in completion.bash
      // allowed a trailing dash and any number of `--`).
      const old = spawnSync(
        "bash",
        ["-c", `f() { [[ "$1" =~ ^[a-z0-9][a-z0-9-]{0,39}$ ]]; }; f a--b--c && f acme-`],
        { env: { PATH: process.env.PATH, LC_ALL: "C" } },
      );
      assert.equal(old.status, 0, "control: the old copy takes what isSlug refuses");
      assert.equal(isSlug("a--b--c") || isSlug("acme-"), false);
    });
});

describe("T1 a recipe's workspace name (recipes/name.sh)", () => {
  /** name.sh run against a domain whose workspaces are `taken`: its `desolate` is a stand-in
   *  beside it that lists them, as `desolate list <domain> --json` does. */
  const nameFor = (task: string, taken: string[]) => {
    const dir = fs.mkdtempSync(path.join(work, "release-"));
    fs.mkdirSync(path.join(dir, "recipes"));
    fs.copyFileSync(path.join(RELEASE, "recipes", "name.sh"), path.join(dir, "recipes", "name.sh"));
    const listed = JSON.stringify([
      { domain: "dev", workspaces: taken.map((workspace) => ({ workspace })) },
    ]);
    fs.writeFileSync(path.join(dir, "cli.sh"), `#!/bin/bash\ncat <<'J'\n${listed}\nJ\n`, {
      mode: 0o755,
    });
    const ran = spawnSync("bash", [path.join(dir, "recipes", "name.sh"), "dev", task], {
      encoding: "utf8",
    });
    assert.equal(ran.status, 0, ran.stderr);
    return ran.stdout.trim();
  };

  it("is the task's first words, and the next number that is free, however many are taken", () => {
    assert.equal(nameFor("Add a shout() greeting\nand more", []), "add-a-shout-greeting");
    assert.equal(
      nameFor("Add a shout() greeting", ["add-a-shout-greeting"]),
      "add-a-shout-greeting-2",
    );
    // Before: 2 to 9 were tried, and the tenth workspace of a name was refused by `up`.
    const base = "fix-it";
    const taken = [base, ...Array.from({ length: 11 }, (_, i) => `${base}-${i + 2}`)];
    assert.equal(nameFor("Fix it!", taken), "fix-it-13");
    assert.equal(nameFor("!!!", []), "task", "no words: a name still");
  });

  it("is at most 30 characters, in whole words where it can, with its number", () => {
    const task = "Make the login page remember the person across restarts";
    const first = nameFor(task, []);
    assert.equal(first, "make-the-login-page-remember");
    // The number is part of the 30: the words are cut to make room for it.
    const numbered = (n: number) =>
      `${first.slice(0, 29 - String(n).length).replace(/-$/, "")}-${n}`;
    assert.equal(numbered(2), "make-the-login-page-remember-2");
    const later = nameFor(task, [first, ...Array.from({ length: 98 }, (_, i) => numbered(i + 2))]);
    assert.equal(later, "make-the-login-page-rememb-100");
    for (const name of [first, later]) {
      assert.ok(name.length <= 30, name);
      assert.ok(isSlug(name), name);
    }
  });
});

describe("T1 a kept service is started again, more slowly while it keeps failing (root/kept.sh)", () => {
  /** kept.sh run on `command` with a stand-in `sleep` that records each pause and, at the
   *  `pauses`th, ends kept.sh (its parent). */
  const kept = (ends: "always" | "once", command: string, pauses: number) => {
    const dir = fs.mkdtempSync(path.join(work, "kept-"));
    fs.writeFileSync(
      path.join(dir, "sleep"),
      `#!/bin/bash\necho "$1" >>"${dir}/pauses"\n[ "$(wc -l <"${dir}/pauses")" -lt ${pauses} ] || kill "$PPID"\n`,
      { mode: 0o755 },
    );
    const ran = spawnSync(
      "bash",
      [
        path.join(RELEASE, "root", "kept.sh"),
        "svc",
        ends,
        path.join(dir, "ended"),
        "bash",
        "-c",
        command,
      ],
      { encoding: "utf8", cwd: dir, env: { PATH: `${dir}:${process.env.PATH}` }, timeout: 20_000 },
    );
    return {
      pauses: fs.readFileSync(path.join(dir, "pauses"), "utf8").split("\n").filter(Boolean),
      ended: fs.readFileSync(path.join(dir, "ended"), "utf8").trim(),
      log: ran.stderr,
    };
  };

  it("a service that keeps failing waits 1, 2, 4 ... up to 60 s between starts, and says so", () => {
    const ran = kept("always", "exit 3", 9);
    assert.deepEqual(ran.pauses, ["1", "2", "4", "8", "16", "32", "60", "60", "60"]);
    assert.equal(ran.ended, "9", "each failure counted, for start.sh to see");
    // The line the T2 tests and the person read in the service's log. (How long the service
    // ran is the machine's: a busy one took 1 s to start `exit 3`.)
    assert.match(
      ran.log,
      /^svc: ended with 3 at \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ, \d+ s after it started \(the next start waits 1 s\); starting it again$/m,
    );
    assert.match(ran.log, /\(the next start waits 60 s\); starting it again$/m);
  });

  it("a service of one request at a time is started again at once after each, and waits only after a failure", () => {
    // Two requests answered (0), then failures.
    const ran = kept(
      "once",
      'n=$(cat runs 2>/dev/null || echo 0); echo $((n + 1)) >runs; [ "$n" -lt 2 ]',
      3,
    );
    assert.deepEqual(ran.pauses, ["1", "2", "4"], "no pause after an answered request");
    assert.equal(ran.ended, "3");
    assert.equal((ran.log.match(/starting it again/g) ?? []).length, 3, "only failures are logged");
  });
});

describe("T1 shellcheck on the shell around the stack", () => {
  // The recipes and the completion are in no other list. The root's and the image's scripts
  // are in run.sh's too: here as well, so that running this file where shellcheck is (a test
  // workspace) checks every script this file is about.
  const have = spawnSync("shellcheck", ["--version"]).status === 0;
  it("finds no warning", { skip: have ? false : "shellcheck is not installed here" }, () => {
    const scripts = (dir: string) =>
      fs
        .readdirSync(path.join(RELEASE, dir))
        .filter((file) => file.endsWith(".sh"))
        .map((file) => path.join(RELEASE, dir, file));
    const ran = spawnSync(
      "shellcheck",
      [
        ...["-S", "warning", "-s", "bash", ...scripts("recipes"), ...scripts("image")],
        ...["root/start.sh", "root/kept.sh", "root/proxy-user.sh", "completion.bash"].map((file) =>
          path.join(RELEASE, file),
        ),
        path.resolve(RELEASE, "../tests/v3/forge/gh.sh"),
      ],
      { encoding: "utf8" },
    );
    assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  });
});
