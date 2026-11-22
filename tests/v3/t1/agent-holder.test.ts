// T1. The agent holder (release/workspace/agent-holder.py), run here as it runs in a VM, with
// a stand-in for enter.sh: its log keeps the newest and says where older output was dropped,
// it is read by lines and from the start, an ended agent is read from its log, and a stop
// asks before anything is killed. And the bounds it repeats from shared/limits.ts (it is
// Python, and cannot import them) are the same numbers.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { NAMES, TERMINAL } from "../../../release/shared/limits.ts";

const RELEASE = path.resolve(import.meta.dirname, "../../../release");
const SOURCE = fs.readFileSync(path.join(RELEASE, "workspace", "agent-holder.py"), "utf8");
// Short: a socket's path must fit in 104 bytes on a Mac.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "dah-"));
after(() => {
  holder("stop", "stubborn", "--kill", "--wait");
  fs.rmSync(root, { recursive: true, force: true });
});
// The holder beside an enter.sh that runs the command where it is: no devcontainer here.
fs.mkdirSync(path.join(root, "bin"));
fs.copyFileSync(path.join(RELEASE, "workspace", "agent-holder.py"), path.join(root, "bin", "h.py"));
fs.writeFileSync(path.join(root, "bin", "enter.sh"), 'cd "$1"; shift 2; exec "$@"\n');
const home = path.join(root, "home");
fs.mkdirSync(home);
const state = path.join(home, ".desolate-agents");

const holder = (...args: string[]) => given("", ...args);
/** The holder, with `input` on its stdin. */
const given = (input: string, ...args: string[]) => {
  const ran = spawnSync("python3", ["-I", path.join(root, "bin", "h.py"), ...args], {
    encoding: "latin1",
    input,
    timeout: 20_000,
    env: { PATH: process.env.PATH, HOME: home },
  });
  return { code: ran.status ?? 1, stdout: ran.stdout, stderr: ran.stderr };
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const stateOf = (name: string) =>
  JSON.parse(fs.readFileSync(path.join(state, `${name}.json`), "utf8")) as {
    state: string;
    exit: number | null;
  };
const ended = async (name: string) => {
  for (let i = 0; i < 100 && stateOf(name).state !== "exited"; i++) await sleep(100);
  assert.equal(stateOf(name).state, "exited");
};
/** The log as read: its first line (what the holder says of the read), and the bytes (the
 *  terminal's line ends, CR LF, as LF). */
const read = (...args: string[]) => {
  const said = holder("log", ...args);
  assert.equal(said.code, 0, said.stderr);
  const end = said.stdout.indexOf("\n");
  return {
    meta: JSON.parse(said.stdout.slice(0, end)) as { first: number; before: number; most: number },
    text: said.stdout.slice(end + 1).replace(/\r\n/g, "\n"),
  };
};

describe("T1 the agent holder: its log, reads of it, and stop", () => {
  it("repeats shared/limits.ts's bounds as the same numbers", () => {
    const constant = (name: string) => {
      const m = new RegExp(`^${name} = (\\d+)$`, "m").exec(SOURCE);
      assert.ok(m, `agent-holder.py has ${name}`); // (the control: a renamed one is not passed over)
      return Number(m[1]);
    };
    assert.equal(constant("NAME_MOST"), NAMES.slug);
    assert.equal(constant("COLS_MOST"), TERMINAL.cols);
    assert.equal(constant("ROWS_MOST"), TERMINAL.rows);
  });

  it("an agent that prints more than its log's most: the newest is kept, and the drop is said", async () => {
    const started = holder(
      "start",
      "big",
      root,
      "--log-most",
      String(1024 * 1024),
      "--",
      "seq",
      "1",
      "400000",
    );
    assert.equal(started.code, 0, started.stderr);
    await ended("big");
    const kept = fs
      .readdirSync(state)
      .filter((f) => f.startsWith("big.log."))
      .reduce((sum, f) => sum + fs.statSync(path.join(state, f)).size, 0);
    assert.ok(kept <= 1024 * 1024 + 65536, `${kept} bytes kept`);
    const all = read("big", "--all");
    assert.ok(all.meta.first > 1024 * 1024, "the oldest was dropped, and the read says how much");
    assert.equal(all.meta.before, 0);
    assert.equal(all.meta.most, 1024 * 1024);
    const lines = all.text.split("\n");
    assert.equal(Number(lines[0]) + lines.length - 4, 400000, "it starts at a whole line");
    assert.match(all.text, /\n400000\n\n\[desolate: the agent ended, exit 0\]\n$/);
    // A page from the end: the last lines, and how much is kept before them.
    const last = read("big", "--lines", "3");
    assert.equal(last.text, "400000\n\n[desolate: the agent ended, exit 0]\n");
    assert.ok(last.meta.before > 1024 * 512, "what comes before is counted, in bytes");
    // Ended: there is no socket, and an attach is replayed the end of the log.
    assert.equal(fs.existsSync(path.join(state, "sockets", "big.sock")), false);
    const replayed = holder("attach", "big");
    assert.equal(replayed.code, 0, replayed.stderr);
    assert.match(replayed.stdout, /^\[desolate: earlier output is not replayed here/);
    assert.match(replayed.stdout, /400000\r\n[\s\S]*\[desolate: this agent is not running\]/);
  });

  it("(the control) an agent that prints less: all of it is kept, from its first line, and nothing is said dropped", async () => {
    assert.equal(holder("start", "small", root, "--", "seq", "1", "1000").code, 0);
    await ended("small");
    const all = read("small");
    assert.equal(all.meta.first, 0);
    assert.ok(all.text.startsWith("1\n2\n"));
    assert.doesNotMatch(holder("attach", "small").stdout, /not replayed/);
  });

  it("the command on stdin, as the host sends it: a word one shell string could not carry", async () => {
    // 40,000 quotes: 160,000 characters once quoted for a shell, past Linux's 128 KiB.
    const word = "'".repeat(40_000);
    const started = given(JSON.stringify(["printf", "%s", word]), "start", "quoted", root);
    assert.equal(started.code, 0, started.stderr);
    await ended("quoted");
    assert.ok(read("quoted").text.startsWith(word), "the word, whole");
    // The control: what is not a list of words is refused, and nothing starts.
    for (const input of ["printf hi", '["a\\u0000b"]', "[]", ""]) {
      const refused = given(input, "start", "notwords", root);
      assert.equal(refused.code, 1);
      assert.match(refused.stderr, /the command on stdin is not a JSON list of words/);
    }
    assert.equal(fs.existsSync(path.join(state, "notwords.json")), false);
  });

  it("a log from a holder before segments is read, and a new start carries on after it", async () => {
    fs.writeFileSync(path.join(state, "old.log"), "from the old holder\n");
    assert.equal(read("old").text, "from the old holder\n");
    assert.equal(holder("start", "old", root, "--", "echo", "new").code, 0);
    await ended("old");
    assert.match(read("old").text, /^from the old holder\nnew\n/);
    assert.deepEqual(
      fs.readdirSync(state).filter((f) => f.startsWith("old.log")),
      ["old.log.0"],
      "the old file is the first segment, carried on",
    );
  });

  it("stop is Ctrl-C, and nothing is killed until asked: --kill kills", async () => {
    const started = holder(
      "start",
      "stubborn",
      root,
      "--",
      "bash",
      "-c",
      'trap "echo not yet" INT; echo up; while :; do sleep 0.1; done',
    );
    assert.equal(started.code, 0, started.stderr);
    await sleep(500);
    const asked = holder("stop", "stubborn");
    assert.equal(asked.code, 0, asked.stderr);
    assert.deepEqual(JSON.parse(asked.stdout), { name: "stubborn", ended: false, exit: null });
    await sleep(4000); // past the 3 s at which the holder once killed it
    assert.equal(stateOf("stubborn").state, "running");
    assert.match(read("stubborn").text, /not yet/);
    const killed = holder("stop", "stubborn", "--kill", "--wait");
    assert.deepEqual(JSON.parse(killed.stdout), { name: "stubborn", ended: true, exit: -9 });
    assert.equal(stateOf("stubborn").state, "exited");
    // (the control) a program that ends on Ctrl-C ends on a plain stop
    assert.equal(holder("start", "meek", root, "--", "sleep", "60").code, 0);
    await sleep(300);
    const meek = holder("stop", "meek", "--wait");
    assert.equal(JSON.parse(meek.stdout).ended, true);
    assert.equal(stateOf("meek").state, "exited");
  });

  it("a name is the host's: lower-case letters, digits and dashes, at most NAMES.slug", () => {
    const long = "a".repeat(NAMES.slug + 1);
    assert.match(holder("log", long).stderr, /at most 40/);
    assert.notEqual(
      holder("log", "a".repeat(NAMES.slug)).stderr,
      "",
      "(no such agent, but a name)",
    );
    assert.doesNotMatch(holder("log", "a".repeat(NAMES.slug)).stderr, /at most/);
  });
});
