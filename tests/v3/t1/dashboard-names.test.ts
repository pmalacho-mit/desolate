// T1. A file's name in the dashboard's Review (release/root/ui/dashboard.js, nameShown): shown as
// git stores it. A right-to-left override made notes-<U+202E>dm.hs read "notes-sh.md" in the list
// of files changed, and a newline read as a space (safety-colleague, dogfooding 2026-11-22).
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vm from "node:vm";

const SOURCE = path.resolve(import.meta.dirname, "../../../release/root/ui/dashboard.js");

/** Anything the script touches as it loads: a stand-in that answers every use with another. */
const anything: unknown = new Proxy(function () {}, {
  get: (_, key) =>
    key === Symbol.iterator ? [][Symbol.iterator] : key === Symbol.toPrimitive ? () => "" : anything,
  apply: () => anything,
  construct: () => anything as object,
});

const nameShown = (() => {
  const context: Record<string, unknown> = {
    document: anything,
    window: { desolateKey: { headers: {}, query: "" } },
    localStorage: anything,
    location: { search: "", pathname: "/" },
    history: anything,
    matchMedia: anything,
    EventSource: anything,
    fetch: () => new Promise(() => {}),
    URLSearchParams,
    setTimeout,
    console,
  };
  vm.runInNewContext(`${fs.readFileSync(SOURCE, "utf8")}\nthis.nameShown = nameShown;`, context);
  return context.nameShown as (name: string) => string;
})();

describe("T1 a file's name in the dashboard's Review, as git stores it", () => {
  it("an ordinary name is shown as it is, non-ASCII letters included (the control)", () => {
    assert.equal(nameShown("web/src/pantry.ts"), "web/src/pantry.ts");
    assert.equal(nameShown("docs/café.md"), "docs/café.md");
  });
  it("a right-to-left override is named, so the name does not read as another", () => {
    assert.equal(nameShown("notes-‮dm.hs"), "notes-⟨U+202E⟩dm.hs");
  });
  it("zero-width characters, a newline and a trailing space are named", () => {
    assert.equal(nameShown("a​b"), "a⟨U+200B⟩b");
    assert.equal(nameShown("two\nlines"), "two⟨U+000A⟩lines");
    assert.equal(nameShown("trailing  "), "trailing⟨space⟩⟨space⟩");
  });
});
