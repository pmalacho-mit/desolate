// T1. Issues a workspace offers (shared/issues.ts) and their Markdown preview
// (shared/ui/markdown.js), which builds elements from text and never parses HTML, opens only
// a link to a site on the internet by a plain name, and costs little whatever it is given.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import * as vm from "node:vm";
import { digestOf, draftOf } from "../../../release/shared/issues.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
type Item = { text: string } | { tag: string; attrs: Record<string, string>; children: Item[] };
/** Just enough of the DOM for the preview: elements, text nodes and fragments. */
class El {
  tag: string;
  className = "";
  attrs: Record<string, string> = {};
  children: El[] = [];
  text: string | null;
  style: Record<string, string> = {};
  constructor(tag: string, text: string | null = null) {
    this.tag = tag;
    this.text = text;
  }
  setAttribute(key: string, value: string) {
    this.attrs[key] = String(value);
  }
  append(...nodes: El[]) {
    for (const n of nodes) this.children.push(...(n.tag === "#fragment" ? n.children : [n]));
  }
  set textContent(value: string) {
    this.children = [];
    this.text = value;
  }
  get textContent(): string {
    return this.text ?? this.children.map((c) => c.textContent).join("");
  }
  all(): El[] {
    return [this, ...this.children.flatMap((c) => c.all())];
  }
}
const markdown = (() => {
  const context = {
    module: {
      exports: {} as {
        parse: (s: string) => Item[];
        render: (s: string, shown?: (t: string) => string, origin?: string) => El;
        BUDGET: { nodes: number; ms: number };
      },
    },
    URL,
    document: {
      createElement: (tag: string) => new El(tag),
      createTextNode: (text: string) => new El("#text", text),
      createDocumentFragment: () => new El("#fragment"),
    },
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(HERE, "../../../release/shared/ui/markdown.js"), "utf8"),
    context,
  );
  const exported = context.module.exports;
  // (Copied out as JSON: arrays made in another context are another Array to assert.)
  return {
    parse: (source: string): Item[] => JSON.parse(JSON.stringify(exported.parse(source))),
    render: exported.render,
    BUDGET: exported.BUDGET,
  };
})();
/** The dashboard's own address, as the preview is given it. */
const ORIGIN = "http://desolate.localhost:31591";
/** A body's preview, as the dashboard draws it: every element, and the text shown. */
const preview = (body: string) => {
  const root = new El("div");
  root.append(markdown.render(body, (t) => t.replace(/\u202e/g, "\u27e8U+202E\u27e9"), ORIGIN));
  return { elements: root.all().filter((n) => !n.tag.startsWith("#")), text: root.textContent };
};
const show = (items: Item[]): string =>
  items
    .map((i) =>
      "text" in i
        ? i.text
        : `<${i.tag}${i.attrs.address ? ` address=${i.attrs.address}` : ""}>${show(i.children)}</${i.tag}>`,
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
  it("HTML is text, and an image is never loaded: it is a link to itself, said so", () => {
    const items = markdown.parse(
      "<script>alert(1)</script> <img src=x onerror=alert(1)> ![c](https://tracker.example/p.png)",
    );
    assert.deepEqual(tags(items), ["p", "link"], "no element but the fixed set");
    assert.match(show(items), /<script>alert\(1\)<\/script> <img src=x onerror=alert\(1\)>/);
    const { elements, text } = preview("![c](https://tracker.example/p.png)");
    assert.deepEqual(
      elements.map((e) => e.tag),
      ["div", "p", "span", "a", "span", "span"],
      "an image's address is a link, never an img",
    );
    assert.equal(text, "image: c (goes to tracker.example: https://tracker.example/p.png)");
  });
  // [what, the link as written, what is shown beside its text]: none of these opens.
  const SHUT: [string, string, string][] = [
    [
      "a Cyrillic і in the host: its punycode, said",
      "https://gіthub.com/acme",
      " (goes to xn--gthub-n2e.com, a name in other alphabets: https://xn--gthub-n2e.com/acme; not a link here: its name is written in other alphabets)",
    ],
    [
      "a fullwidth solidus before an @: the host after it",
      "https://github.com／acme／repo@evil.example/",
      ' (goes to evil.example: https://github.com%EF%BC%8Facme%EF%BC%8Frepo@evil.example/; "github.com／acme／repo" before the "@" is not the site; not a link here: the part before "@" would be taken for the site)',
    ],
    [
      "a division slash (U+2215) before an @",
      "https://github.com∕acme@evil.example/",
      ' (goes to evil.example: https://github.com%E2%88%95acme@evil.example/; "github.com∕acme" before the "@" is not the site; not a link here: the part before "@" would be taken for the site)',
    ],
    [
      "a name before @",
      "https://github.com@evil.example/",
      ' (goes to evil.example: https://github.com@evil.example/; "github.com" before the "@" is not the site; not a link here: the part before "@" would be taken for the site)',
    ],
    [
      "this dashboard's own address",
      `${ORIGIN}/?review&domain=web&repo=acme%2Fapp&branch=x`,
      " (goes to desolate.localhost:31591: http://desolate.localhost:31591/?review&domain=web&repo=acme%2Fapp&branch=x; not a link here: it is this dashboard's own address)",
    ],
    [
      "a local name",
      "http://desolate-approve.localhost:31591/",
      " (goes to desolate-approve.localhost:31591: http://desolate-approve.localhost:31591/; not a link here: it names this computer or its network)",
    ],
    [
      "loopback, as a GET to a service",
      "http://127.0.0.1:3000/admin/delete?id=1",
      " (goes to 127.0.0.1:3000: http://127.0.0.1:3000/admin/delete?id=1; not a link here: it names an IP address, not a site)",
    ],
    [
      "loopback written in hex: parsed",
      "https://0x7f.1/",
      " (goes to 127.0.0.1: https://127.0.0.1/; not a link here: it names an IP address, not a site)",
    ],
    [
      "a LAN address",
      "http://192.168.1.1/admin",
      " (goes to 192.168.1.1: http://192.168.1.1/admin; not a link here: it names an IP address, not a site)",
    ],
    [
      "IPv6 loopback, mapped",
      "http://[::ffff:127.0.0.1]/",
      " (goes to [::ffff:7f00:1]: http://[::ffff:7f00:1]/; not a link here: it names an IP address, not a site)",
    ],
    [
      "IPv6 link-local",
      "http://[fe80::1]/",
      " (goes to [fe80::1]: http://[fe80::1]/; not a link here: it names an IP address, not a site)",
    ],
    [
      "a name with no dot",
      "http://router/",
      " (goes to router: http://router/; not a link here: it names this computer or its network)",
    ],
    ["javascript:", "javascript:alert(1)", " (not a link: javascript:alert(1)"],
    ["data:", "data:text/html,hi", " (not a link: data:text/html,hi)"],
    ["mail", "mailto:someone@example.com", " (mail to someone@example.com; not a link)"],
  ];
  for (const [what, address, beside] of SHUT)
    it(`a link to ${what}: its text and where it goes, and nothing that opens`, () => {
      const { elements, text } = preview(`[the docs](${address})`);
      assert.deepEqual(
        elements.filter((e) => e.tag === "a"),
        [],
        "no link",
      );
      assert.ok(text.startsWith(`the docs${beside}`), `${JSON.stringify(text)}`);
    });
  it("a link to a site by its plain name opens, at its parsed address (the control)", () => {
    const { elements, text } = preview("[the docs](https://github.com/acme/repo?x=1#y)");
    const links = elements.filter((e) => e.tag === "a");
    assert.equal(links.length, 1);
    assert.deepEqual(links[0]!.attrs, {
      href: "https://github.com/acme/repo?x=1#y",
      target: "_blank",
      rel: "noopener noreferrer nofollow",
    });
    assert.equal(text, "the docs (goes to github.com: https://github.com/acme/repo?x=1#y)");
    // An autolink says where it goes, not its address twice.
    assert.equal(
      preview("see https://github.com/acme").text,
      "see https://github.com/acme (goes to github.com)",
    );
  });
  it("a backslash is a path's slash to the browser: it goes to the host shown, and opens", () => {
    const { elements, text } = preview("[the docs](https://evil.example\\@github.com/)");
    assert.deepEqual(
      elements.filter((e) => e.tag === "a").map((e) => e.attrs.href),
      ["https://evil.example/@github.com/"],
    );
    assert.equal(text, "the docs (goes to evil.example: https://evil.example/@github.com/)");
  });
  it("a link's text is never a link of its own, and its title is shown", () => {
    const { elements, text } = preview('[https://github.com](https://evil.example "a title")');
    assert.deepEqual(
      elements.filter((e) => e.tag === "a").map((e) => e.attrs.href),
      ["https://evil.example/"],
    );
    assert.equal(
      text,
      'https://github.com (goes to evil.example: https://evil.example/) titled "a title"',
    );
  });
  it("an address too long to show is cut where it is shown, said so", () => {
    const long = `https://github.com/${"a".repeat(3000)}`;
    assert.match(preview(`[x](${long})`).text, /\.\.\.|… \(2,819 more characters not shown\)\)$/);
  });
  it("each piece of text is shown through the page's rule (the dashboard's: shown-text.js)", () => {
    assert.equal(preview("# right \u202eleft").text, "right \u27e8U+202E\u27e9left");
  });
  it("an address too long to look through is left as text, never linked cut (the control: one that fits is linked)", () => {
    const long = `https://example.com/${"a".repeat(3000)}`;
    assert.deepEqual(tags(markdown.parse(`see ${long} here`)), ["p"]);
    assert.match(show(markdown.parse(`see ${long} here`)), new RegExp(`see ${long} here`));
    const fits = `https://example.com/${"a".repeat(2000)}`;
    assert.match(
      show(markdown.parse(`see ${fits} here`)),
      new RegExp(`<link address=${fits}>${fits}</link>`),
    );
  });
  it("the inputs that froze it cost little now (review of #281), beside ordinary ones", () => {
    const K = 256 * 1024;
    for (const [what, body, most] of [
      ["a line of 256,000 spaces (135 s before)", `a${" ".repeat(256_000)}b`, 4],
      ["the same in a quote", `> a${" ".repeat(K)}b`, 4],
      ["the same in a list item", `- a${" ".repeat(K)}b`, 4],
      [
        "a header of 4,000 cells over a rule of one (11.6 million elements)",
        `${"|a".repeat(4000)}\n-\n${"|\n".repeat(2900)}`,
        8000,
      ],
      ["256 KiB of [ then a ]", `${"[".repeat(K)}]`, 4],
      [
        "runs of 1 to 700 backticks",
        Array.from({ length: 700 }, (_, n) => "`".repeat(n + 1)).join(" "),
        4,
      ],
      ["an ordinary table (the control)", "| a | b |\n|---|--:|\n| 1 | 2 |", 20],
      [
        "an ordinary paragraph (the control)",
        "Some *words*, `code` and a [link](https://github.com).",
        20,
      ],
    ] as const) {
      const started = performance.now();
      const items = markdown.parse(body);
      const ms = performance.now() - started;
      const count = (xs: Item[]): number =>
        xs.reduce((n, x) => n + 1 + ("children" in x ? count(x.children) : 0), 0);
      assert.ok(ms < 1500, `${what}: ${Math.round(ms)} ms`);
      assert.ok(count(items) <= most, `${what}: ${count(items)} elements`);
    }
    assert.deepEqual(tags(markdown.parse("| a | b |\n|---|--:|\n| 1 | 2 |")), [
      "table",
      "thead",
      "tr",
      "th",
      "th",
      "tbody",
      "tr",
      "td",
      "td",
    ]);
  });
  it("a table that would make too many elements is drawn as far as it can, the rest its text, said so", () => {
    // 4,000 columns over its own rule, and 2,900 rows: 11.6 million cells.
    const huge = `${"|a".repeat(4000)}\n${"|-".repeat(4000)}\n${"|x\n".repeat(2900)}`;
    const started = performance.now();
    const { elements, text } = preview(`# Title\n\n${huge}`);
    assert.ok(performance.now() - started < 3000, `${Math.round(performance.now() - started)} ms`);
    assert.ok(elements.length < markdown.BUDGET.nodes, String(elements.length));
    assert.deepEqual(
      elements.slice(0, 2).map((e) => [e.tag, e.className]),
      [
        ["div", ""],
        ["h1", ""],
      ],
    );
    const own = elements.find((e) => e.className === "md-own")!;
    assert.match(
      own.textContent,
      /^Not drawn from here on: it would make more than 200,000 elements, or take more than 1 s\. It is shown as its text\.$/,
    );
    assert.ok(text.endsWith("|x\n|x\n|x\n"), "the rest, as its text");
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
