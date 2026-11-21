// T1. The root's side of the request channel (root/rootd.ts): fetches asked of one repository
// while one runs are one more fetch, not one each, and each asker is answered by a fetch that
// began after it asked. (The channel end to end, a slow root, a root that is down and a flood
// from one domain beside another: t2/24-requests.)
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

const work = fs.mkdtempSync(path.join(os.tmpdir(), "desolate-requests-"));
// layout.ts reads these when it is first imported.
process.env.DESOLATE_ROOT_STATE = path.join(work, "state");
process.env.DESOLATE_ROOT_DOMAINS = path.join(work, "domains");
const { coalesced } = await import("../../../release/root/rootd.ts");

/** A run that ends when the test says so. */
const gate = () => {
  let open = () => {};
  let fail = (_: Error) => {};
  const done = new Promise<void>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  return { done, open, fail };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("T1 the root's queue of fetches, one per repository", () => {
  it("askers during a run share the one run after it; a later asker gets a run of its own", async () => {
    const gates: ReturnType<typeof gate>[] = [];
    const started: string[] = [];
    const fetch = coalesced(async (key, said) => {
      started.push(key);
      said(`fetching ${key}`);
      const g = gate();
      const run = gates.push(g);
      await g.done;
      return `${key} #${run}`;
    });
    const told: string[] = [];
    const first = fetch("acme/app", (line) => told.push(`first: ${line}`));
    assert.equal(first.behind, false);
    await tick();
    assert.deepEqual(started, ["acme/app"]);
    const during = Array.from({ length: 10 }, () => fetch("acme/app"));
    assert.ok(during.every((d) => d.behind));
    // Another repository is not behind this one.
    const other = fetch("acme/web");
    assert.equal(other.behind, false);
    await tick();
    assert.deepEqual(started, ["acme/app", "acme/web"]);
    gates[0]!.open();
    assert.equal(await first.result, "acme/app #1");
    await tick();
    await tick();
    // The ten waiting began one run, after the first ended: not ten.
    assert.deepEqual(started, ["acme/app", "acme/web", "acme/app"]);
    const later = fetch("acme/app");
    assert.equal(later.behind, true, "a run is under way: the next one is after it");
    gates[2]!.open();
    const answers = await Promise.all(during.map((d) => d.result));
    assert.ok(
      answers.every((a) => a === answers[0]),
      "the ten share one answer",
    );
    await tick();
    await tick();
    assert.equal(started.length, 4, "the later asker's run began after it asked");
    gates[3]!.open();
    gates[1]!.open();
    await later.result;
    await other.result;
    assert.deepEqual(told, ["first: fetching acme/app"]);
    // Nothing waits now: the next asker starts at once.
    await tick();
    const after = fetch("acme/app");
    assert.equal(after.behind, false);
    await tick();
    gates[4]!.open();
    await after.result;
  });

  it("a run that fails answers its askers with the failure, and the queue goes on (the control)", async () => {
    let runs = 0;
    const g = gate();
    const fetch = coalesced(async () => {
      runs++;
      if (runs === 1) {
        await g.done;
        throw new Error("cannot fetch acme/app: the forge is down");
      }
      return "fetched";
    });
    const first = fetch("acme/app");
    await tick();
    const next = fetch("acme/app");
    g.open();
    await assert.rejects(first.result, /the forge is down/);
    assert.equal(await next.result, "fetched");
    assert.equal(runs, 2);
  });
});
