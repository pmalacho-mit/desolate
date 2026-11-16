// T2 (fake backend). A GitHub issue offered by a workspace (desolate issue offer, inside
// one): kept by the root as a draft, edited by the person on the dashboard, and published by
// the host's own gh once the person confirms the exact text on the Mac's terminal. Here gh is
// a stand-in that records every argument it was given and the body file's bytes.
//
// What is claimed: every field reaches gh as one argument, byte for byte, whatever an agent
// put in it (quotes, `$(...)`, a leading dash); nothing is published without the person's
// confirmation; the workspace hears how it ended.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { request } from "node:http";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { bootstrap, git, newStack } from "../lib/harness.ts";
import type { Stack } from "../lib/harness.ts";

let stack: Stack;
let port = 0;
let cookie = "";
let gh = "";
let record = "";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const inside = (script: string) => stack.desolate("exec", "dev/w1", "--vm", "--", "bash", "-c", script);
type Issue = { id: string; state: string; title: string; body: string; labels: string[]; edited?: boolean; url?: string; problem?: string };
const waiting = () => JSON.parse(stack.quiet("issues", "--json").stdout || "[]") as Issue[];
type Event = { type: string; title?: string; url?: string | null; id?: string };
const events = (): Event[] => inside("desolate events --all").stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Event);
const until = async (probe: () => boolean, ms: number) => {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await sleep(400)) if (probe()) return true;
  return false;
};
/** The dashboard's own request, as its page sends it. */
const dashboard = (body: unknown): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = request({ host: "127.0.0.1", port, method: "POST", path: "/issue", headers: { host: `desolate.localhost:${port}`, origin: `http://desolate.localhost:${port}`, "sec-fetch-site": "same-origin", cookie, "x-desolate-ui": "1", "content-type": "application/json", "content-length": Buffer.byteLength(payload) } }, (res) => {
      let text = "";
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    req.on("error", reject);
    req.end(payload);
  });

const TITLE = `Login loops: "quoted" $(id) --help`;
const BODY = "Steps:\n\n1. log in\n2. `$(rm -rf ~)` and <script>alert(1)</script>\n\ttabbed\n";

describe("T2 issues offered by a workspace, published by the person", () => {
  before(async () => {
    stack = newStack("issues");
    stack.seed("acme/widgets", (dir) => {
      fs.writeFileSync(path.join(dir, "README.md"), "# widgets\n");
      git(dir, "add", "-A");
      git(dir, "commit", "--quiet", "-m", "seed");
    });
    assert.equal(bootstrap(stack).code, 0);
    assert.equal(stack.quiet("clone", "acme/widgets", "--no-domain").code, 0);
    assert.equal(stack.quiet("domain", "create", "dev", "--repo", "acme/widgets").code, 0);
    assert.equal(stack.quiet("up", "dev", "--name", "w1").code, 0);
    const address = new URL((JSON.parse(stack.quiet("ui", "--json").stdout) as { dashboard: string }).dashboard);
    port = Number(address.port);
    // The browser's cookie, for the address `desolate ui` prints.
    cookie = await new Promise<string>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: `/?tkn=${address.searchParams.get("tkn")}`, headers: { host: `desolate.localhost:${port}` } }, (res) => {
        res.resume();
        resolve(String(res.headers["set-cookie"] ?? "").split(";")[0]!);
      });
      req.on("error", reject);
      req.end();
    });
    // The stand-in gh: each argument on a line of its own (NUL-separated in the file), the
    // body file's bytes beside, and the page GitHub would answer with.
    record = path.join(stack.work, "gh-args");
    gh = path.join(stack.work, "gh");
    fs.writeFileSync(gh, `#!/usr/bin/env bash\nprintf '%s\\0' "$@" > ${JSON.stringify(record)}\nwhile [ $# -gt 0 ]; do [ "$1" = --body-file ] && cp "$2" ${JSON.stringify(record + ".body")}; shift; done\necho https://github.com/acme/widgets/issues/7\n`, { mode: 0o755 });
    stack.env.DESOLATE_GH = gh;
  });
  after(() => stack.destroy());

  it("a workspace offers one: the root keeps it as a draft, and the workspace hears of it", async () => {
    // The body, as the agent wrote it: a file in the domain's share (/workspaces in the VM).
    fs.writeFileSync(path.join(stack.home, "domains", "dev", "repos", "body.md"), BODY);
    const offered = inside(`cd /workspaces/acme/widgets && desolate issue offer --title '${TITLE.replace(/'/g, "'\\''")}' --body-file /workspaces/body.md --label bug --label -x`);
    assert.equal(offered.code, 0, offered.stderr);
    assert.match(offered.stdout, /offered an issue for acme\/widgets/);
    const [issue] = waiting();
    assert.ok(issue, "listed on the Mac");
    assert.equal(issue!.state, "offered");
    assert.equal(issue!.title, TITLE);
    assert.equal(issue!.body, BODY);
    assert.deepEqual(issue!.labels, ["bug", "-x"]);
    assert.ok(await until(() => events().some((e) => e.type === "issue-offered" && e.title === TITLE), 20_000));
    // Not one desolate carries: refused at once, said why.
    // (Its bytes, written out: the VM's bash may run in the C locale, where $'\u202e' stays text.)
    const hidden = inside(`cd /workspaces/acme/widgets && desolate issue offer --title "$(printf 'hidden \\342\\200\\256 text')"`);
    assert.equal(hidden.code, 1);
    assert.match(hidden.stderr, /control or invisible character/);
  });

  it("the person edits it on the dashboard; publishing waits for the Mac, and only the exact text goes", async () => {
    const [issue] = waiting();
    const saved = await dashboard({ id: issue!.id, do: "save", title: TITLE, body: `${BODY}\nEdited by a person.\n`, labels: ["bug", "-x", "desolate:run"] });
    assert.equal(saved.status, 200, saved.body);
    assert.equal(waiting()[0]!.edited, true);
    assert.equal((await dashboard({ id: issue!.id, do: "publish" })).status, 200);
    assert.equal(waiting()[0]!.state, "approving");
    assert.equal((await dashboard({ id: issue!.id, do: "save", title: "changed after" })).status, 400, "frozen once it waits for the Mac");
    assert.ok(!fs.existsSync(record), "nothing published yet");
    // Not confirmed: nothing goes.
    const no = stack.person("Type publish", "no", "issue", "publish", issue!.id);
    assert.notEqual(no.code, 0);
    assert.ok(!fs.existsSync(record), "not confirmed: gh was not run");
    // Confirmed: gh, with each field one argument, byte for byte.
    const yes = stack.person("Type publish", "publish", "issue", "publish", issue!.id);
    assert.equal(yes.code, 0, yes.stdout + yes.stderr);
    assert.match(yes.stdout, /published: https:\/\/github\.com\/acme\/widgets\/issues\/7/);
    const args = fs.readFileSync(record, "utf8").split("\0").slice(0, -1);
    assert.deepEqual(args.filter((a) => !a.endsWith("body.md")), ["issue", "create", "--repo", "acme/widgets", `--title=${TITLE}`, "--body-file", "--label=bug", "--label=-x", "--label=desolate:run"]);
    assert.equal(fs.readFileSync(`${record}.body`, "utf8"), `${BODY}\nEdited by a person.\n`);
    assert.ok(await until(() => events().some((e) => e.type === "issue-published" && e.url === "https://github.com/acme/widgets/issues/7"), 20_000));
    assert.deepEqual(waiting(), [], "nothing waits any more");
  });

  it("not now, and rejected: back to a draft, then gone, and nothing is published", async () => {
    fs.rmSync(record, { force: true });
    assert.equal(inside("cd /workspaces/acme/widgets && desolate issue offer --title 'Second thought'").code, 0);
    const second = waiting().find((i) => i.title === "Second thought")!;
    assert.equal((await dashboard({ id: second.id, do: "publish" })).status, 200);
    assert.equal(stack.desolate("issue", "refuse", second.id).code, 0);
    assert.equal(waiting().find((i) => i.id === second.id)!.state, "offered", "a draft again");
    assert.equal((await dashboard({ id: second.id, do: "reject" })).status, 200);
    assert.ok(!waiting().some((i) => i.id === second.id));
    assert.ok(await until(() => events().some((e) => e.type === "issue-rejected" && e.title === "Second thought"), 20_000));
    assert.ok(!fs.existsSync(record), "gh never ran");
  });
});
