// T2 (fake backend). Journeys through the dashboard, as a person takes them: every step a
// click on the page, in a real browser, and what the page then shows. What is not the
// dashboard's to do is done as it is done anywhere: the clone (deploy keys are made on the
// Mac), an agent's work in its workspace, and the person's approval on the host (lib/person,
// as in 09-ui). The owner means the dashboard to be where people work (2026-11-18): these are
// the checks that its workflows keep working as desolate changes.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { bootstrap, git, newStack } from "../lib/harness.ts";
import type { Stack } from "../lib/harness.ts";
import { findChrome, openBrowser } from "../lib/browser.ts";

let stack: Stack;
let browser: Awaited<ReturnType<typeof openBrowser>>;
let page: Awaited<ReturnType<Awaited<ReturnType<typeof openBrowser>>["tab"]>>;
const DOMAIN = "acme--app";
const row = `[data-workspace="${DOMAIN}/main"]`;
/** An agent's work in the workspace, then its `git push`: an offer. */
const agent = (script: string) => {
  const done = stack.quiet(
    "exec",
    `${DOMAIN}/main`,
    "--",
    "bash",
    "-lc",
    `${script} && git rev-parse HEAD && (git push origin HEAD 2>&1 || true)`,
  );
  assert.equal(done.code, 0, done.stderr);
  return done.stdout
    .trim()
    .split("\n")
    .find((line) => /^[0-9a-f]{40}$/.test(line))!;
};
const commit = (message: string) =>
  `git -c user.name=agent -c user.email=agent@example.test commit -qm '${message}'`;
const forgeRefs = () =>
  Object.fromEntries(
    stack
      .forge("refs", "acme/app")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => [line.split(" ")[0], line.split(" ")[1]]),
  ) as Record<string, string>;

describe("T2 journeys through the dashboard", () => {
  before(async () => {
    stack = newStack("journeys");
    stack.seed("acme/app", (dir) => {
      fs.writeFileSync(path.join(dir, "README.md"), "# app\n");
      git(dir, "add", "-A");
      git(dir, "commit", "--quiet", "-m", "seed");
    });
    assert.equal(bootstrap(stack).code, 0);
    // The one step that is the Mac's: a repository's keys. It is its own domain.
    assert.equal(stack.quiet("clone", "acme/app").code, 0);
    const chrome = findChrome();
    assert.ok(chrome, "these journeys need Chrome or Chromium");
    browser = await openBrowser(chrome, fs.mkdtempSync(path.join(stack.work, "chrome-journeys-")));
    const address = (JSON.parse(stack.quiet("ui", "--json").stdout) as { dashboard: string })
      .dashboard;
    page = await browser.tab(address);
  });
  after(async () => {
    await page?.close().catch(() => {});
    await browser?.close();
    stack.destroy();
  });

  it("a first workspace from the dashboard: the home domain's Workspace on main, running", async () => {
    stack.step("a first workspace");
    await page.until(
      `document.querySelector('[data-first-workspace="${DOMAIN}"] button')`,
      "Workspace on main",
    );
    await page.click(`[data-first-workspace="${DOMAIN}"] button`, "Workspace on main");
    await page.until(
      `document.querySelector('${row}') && /running/.test(document.querySelector('${row}').innerText) && document.querySelector('${row} [data-editor]')`,
      "the workspace running, with its editor",
      180_000,
    );
    const shown = await page.evaluate<string>(`document.querySelector('${row}').innerText`);
    assert.match(shown, /WORKSPACE\s*main/, "the workspace's name, labelled as one");
    assert.match(shown, /BRANCH\s*main/, "and the branch it is on, labelled as one");
  });

  it("an agent's branch: offered, labelled, reviewed (files changed, Open in git on it), pushed with one click and an approval", async () => {
    stack.step("review and push a branch");
    const head = agent(
      `git checkout -q -b feature/greet && echo hi > greet.txt && git add greet.txt && ${commit("Greet")} && echo more >> README.md && ${commit("More")}`,
    );
    const offer = `[data-offer="${DOMAIN}/acme/app/feature/greet"]`;
    const said = await page.until<string>(
      `document.querySelector('${offer}')?.innerText`,
      "the offer in Needs you",
      60_000,
    );
    assert.match(said, /BRANCH\s*feature\/greet/);
    assert.match(said, /DOMAIN\s*acme--app/);
    assert.match(said, /WORKSPACE\s*main/);
    // Not on the remote yet, and the row says how much.
    await page.until(
      `/2 not on the remote/.test(document.querySelector('${row}').innerText)`,
      "2 not on the remote",
      60_000,
    );
    await page.click(`${offer} button`, "Review");
    await page.until(
      `document.querySelector("#review [data-files-changed]")`,
      "the files changed",
      60_000,
    );
    assert.equal(
      await page.evaluate(`!!document.querySelector("#review [data-default-branch]")`),
      false,
      "not the default branch: no warning",
    );
    const files = await page.evaluate<string>(
      `[...document.querySelectorAll("#review [data-change]")].map((li) => li.innerText.replace(/\\s+/g, " ")).join(" ; ")`,
    );
    assert.match(files, /added greet\.txt \+1 −0/);
    assert.match(files, /modified README\.md \+1 −0/);
    const git = await page.evaluate<string>(
      `document.querySelector("#review [data-open-git]").href`,
    );
    assert.match(
      git,
      /\?repo=acme%2Fapp&domain=acme--app&branch=feature%2Fgreet$/,
      "Open in git, on the branch reviewed",
    );
    // A file's name goes to it in the diff.
    await page.until(
      `document.querySelector('#review [data-file="greet.txt"]')`,
      "the diff",
      60_000,
    );
    await page.click("#review [data-change] button", "greet.txt");
    // Push, then the person approves on the host.
    await page.click("#review button[data-action='offer.push']", "Push exactly");
    await page.until(
      `[...document.querySelectorAll("#activity-list li")].some((li) => /desolate push acme--app acme\\/app feature\\/greet/.test(li.innerText))`,
      "the push in what the dashboard ran",
    );
    const approved = stack.person("Type the branch name", "feature/greet", "approve");
    assert.equal(approved.code, 0, approved.stdout);
    await page.until(
      `!document.querySelector('${offer}')`,
      "the offer gone from Needs you",
      60_000,
    );
    assert.equal(forgeRefs()["feature/greet"], head, "the remote has exactly the commit reviewed");
    // And the row no longer says it is not on the remote.
    await page.until(
      `/on the remote/.test(document.querySelector('${row}').innerText) && !/not on the remote/.test(document.querySelector('${row}').innerText)`,
      "on the remote, after the push",
      30_000,
    );
  });

  it("the default branch: the same Push, under a warning", async () => {
    stack.step("push the default branch");
    const head = agent(`git switch -q main && echo note >> README.md && ${commit("A note")}`);
    const offer = `[data-offer="${DOMAIN}/acme/app/main"]`;
    await page.until(`document.querySelector('${offer}')`, "the offer of main", 60_000);
    await page.click(`${offer} button`, "Review");
    const warning = await page.until<string>(
      `document.querySelector("#review [data-default-branch]")?.innerText`,
      "the default branch's warning",
      60_000,
    );
    assert.match(warning, /This is acme\/app's default branch, main\./);
    const push = await page.until<string>(
      `[...document.querySelectorAll("#review button[data-action='offer.push']")].map((b) => b.innerText)[0]`,
      "the Push button",
    );
    assert.equal(push, `Push exactly ${head.slice(0, 12)} to main`);
    await page.click("#review button[data-action='offer.push']", "Push exactly");
    await page.until(
      `[...document.querySelectorAll("#activity-list li")].some((li) => /desolate push acme--app acme\\/app main/.test(li.innerText))`,
      "the push of main",
    );
    const approved = stack.person("Type the branch name", "main", "approve");
    assert.equal(approved.code, 0, approved.stdout);
    await page.until(`!document.querySelector('${offer}')`, "the offer of main gone", 60_000);
    assert.equal(forgeRefs()["main"], head, "main on the remote is the commit reviewed");
  });

  it("a stopped workspace resized from the dashboard, started again, and deleted once nothing in it would be lost", async () => {
    stack.step("resize and delete");
    await page.click(`${row} button`, "Stop");
    await page.until(
      `/stopped/.test(document.querySelector('${row}').innerText) && document.querySelector('${row} [data-resize]') && !document.querySelector('${row} [data-resize]').disabled`,
      "stopped, with Resize on",
      120_000,
    );
    await page.click(`${row} [data-resize]`, "Resize");
    await page.until(
      `document.querySelector('${row} [data-resize-form] input[name=memory]')`,
      "the Resize form",
    );
    await page.evaluate(
      `(() => { const i = document.querySelector('${row} [data-resize-form] input[name=memory]'); i.value = "5"; })()`,
    );
    await page.click(`${row} [data-resize-form] button[type=submit]`, "Resize");
    await page.until(
      `/5 GiB memory/.test(document.querySelector('${row} [data-size]').innerText)`,
      "5 GiB memory",
      60_000,
    );
    await page.click(`${row} button`, "Start");
    await page.until(
      `/running/.test(document.querySelector('${row}').innerText) && document.querySelector('${row} [data-delete]') && !document.querySelector('${row} [data-delete]').disabled`,
      "running, everything pushed, and Delete on",
      180_000,
    );
    await page.click(`${row} [data-delete]`, "Delete");
    await page.until(`!document.querySelector('${row}')`, "the workspace gone", 120_000);
    assert.deepEqual(page.said, [], "nothing on the page threw");
  });

  it("the transcript reads as reviewed", () => {
    stack.checkTranscript("t2-19-journeys");
  });
});
