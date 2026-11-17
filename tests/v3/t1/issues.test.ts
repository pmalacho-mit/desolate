// T1. Issues a workspace offers (shared/issues.ts) and their Markdown preview
// (shared/ui/markdown.js), which builds elements from text and never parses HTML.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import * as vm from "node:vm";
import { digestOf, draftOf } from "../../../release/shared/issues.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
type Item = { text: string } | { tag: string; attrs: Record<string, string>; children: Item[] };
const markdown = (() => {
  const context = { module: { exports: {} as { parse: (s: string) => Item[] } } };
  vm.runInNewContext(
    fs.readFileSync(path.join(HERE, "../../../release/shared/ui/markdown.js"), "utf8"),
    context,
  );
  // (Copied out as JSON: arrays made in another context are another Array to assert.)
  return {
    parse: (source: string): Item[] =>
      JSON.parse(JSON.stringify(context.module.exports.parse(source))),
  };
})();
const show = (items: Item[]): string =>
  items
    .map((i) =>
      "text" in i
        ? i.text
        : `<${i.tag}${i.attrs.href ? ` href=${i.attrs.href}` : ""}>${show(i.children)}</${i.tag}>`,
    )
    .join("");
const tags = (items: Item[]): string[] =>
  items.flatMap((i) => ("text" in i ? [] : [i.tag, ...tags(i.children)]));

describe("T1 an offered issue", () => {
  it("its fields are text desolate carries: nothing hidden, labels gh reads as one", () => {
    assert.deepEqual(
      draftOf({ repo: "acme/app", title: "x", body: "a\tb\nc", labels: ["-x", "needs triage"] }),
      { repo: "acme/app", title: "x", body: "a\tb\nc", labels: ["-x", "needs triage"] },
    );
    for (const bad of [
      { title: "a\nb" },
      { body: "a\u0007b" },
      { body: "x".repeat(65_537) },
      { labels: ["a,b"] },
      {
        labels: Array(21)
          .fill("x")
          .map((x, n) => `${x}${n}`),
      },
      { title: "​hidden" },
      { repo: "../x" },
    ])
      assert.ok(
        "error" in draftOf({ repo: "acme/app", title: "ok", ...bad }),
        JSON.stringify(bad).slice(0, 80),
      );
  });
  it("what an approval covers changes with any word of it", () => {
    const d = { repo: "acme/app", title: "t", body: "b", labels: ["x"] };
    assert.notEqual(digestOf(d), digestOf({ ...d, body: "b " }));
    assert.notEqual(digestOf(d), digestOf({ ...d, labels: ["x", "desolate:run"] }));
    assert.notEqual(digestOf(d), digestOf({ ...d, repo: "acme/other" }));
  });
});

describe("T1 the Markdown preview", () => {
  it("GitHub's Markdown, as elements", () => {
    assert.equal(
      show(
        markdown.parse("# Fix it\n\nThe **login** loop, `--x`, ~~old~~ and *new*.\nsecond line"),
      ),
      "<h1>Fix it</h1><p>The <strong>login</strong> loop, <code>--x</code>, <del>old</del> and <em>new</em>.<br></br>second line</p>",
    );
    assert.deepEqual(
      tags(markdown.parse("- [x] done\n- [ ] not\n\n| a |\n|---|\n| 1 |\n\n> q\n\n```\ncode\n```")),
      [
        "ul",
        "li",
        "input",
        "li",
        "input",
        "table",
        "thead",
        "tr",
        "th",
        "tbody",
        "tr",
        "td",
        "blockquote",
        "p",
        "pre",
        "code",
      ],
    );
  });
  it("HTML is text, a link goes only where it says, and an image is never loaded", () => {
    const items = markdown.parse(
      "<script>alert(1)</script> <img src=x onerror=alert(1)> [a](javascript:alert(1)) [b](https://example.com) ![c](https://tracker.example/p.png)",
    );
    assert.deepEqual(
      tags(items),
      ["p", "span", "a", "a"],
      "no element but the fixed set; the javascript: link has no address",
    );
    assert.match(
      show(items),
      /<script>alert\(1\)<\/script> <img src=x onerror=alert\(1\)>/,
      "as the text it is",
    );
    assert.match(show(items), /<a href=https:\/\/tracker\.example\/p\.png>image: c<\/a>/);
  });
  it("costs little whatever it is given: unclosed emphasis, code and links", () => {
    for (const body of [
      "*".repeat(65_536),
      "*a ".repeat(21_000),
      "_a ".repeat(21_000),
      "**a ".repeat(16_000),
      "`a ``b ".repeat(9_000),
      "[a](".repeat(16_000),
      "> ".repeat(30_000),
      // A heading, or a table's rule, with a long run of blanks: 15 s and 7 s before (audit).
      `# a${" ".repeat(65_000)}b`,
      `a|b\n-${" ".repeat(65_000)}x`,
    ]) {
      const started = performance.now();
      markdown.parse(body);
      assert.ok(
        performance.now() - started < 500,
        `${body.slice(0, 8)}...: ${Math.round(performance.now() - started)} ms`,
      );
    }
  });
});
