// T1. Text a repository or a workspace wrote, shown as itself, on every surface that shows it:
// the terminal (shared/text.ts), the reviewer's account of a push (root/reviewer-git.ts), the
// approval page and the dashboard (shared/ui/shown-text.js, a copy of text.ts's rule, which
// the pages cannot import). Each hostile character must still be there, as a visible mark,
// with the text around it: a surface that showed nothing would pass a test that looked only
// for the character's absence, so every row says exactly what is shown. Beside each, the
// same text without it, shown unchanged (the control).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vm from "node:vm";
import {
  failure,
  forTerminal,
  printable,
  printableLines,
  UNSAFE,
} from "../../../release/shared/text.ts";
import { named } from "../../../release/root/reviewer-git.ts";

const RELEASE = path.resolve(import.meta.dirname, "../../../release");
const source = (file: string) => fs.readFileSync(path.join(RELEASE, file), "utf8");

/** Anything a page's script touches as it loads: a stand-in that answers every use with another. */
const anything: unknown = new Proxy(function () {}, {
  get: (_, key) =>
    key === Symbol.iterator
      ? [][Symbol.iterator]
      : key === Symbol.toPrimitive
        ? () => ""
        : anything,
  apply: () => anything,
  construct: () => anything as object,
});

/** Just enough of the DOM for a diff: elements and text nodes, and what a page reads back. */
class Node {
  tag: string;
  className = "";
  attrs: Record<string, string> = {};
  children: Node[] = [];
  text: string | null = null;
  constructor(tag: string, text: string | null = null) {
    this.tag = tag;
    this.text = text;
  }
  setAttribute(key: string, value: string) {
    this.attrs[key] = value;
  }
  addEventListener() {}
  append(...nodes: (Node | string)[]) {
    for (const n of nodes) this.children.push(typeof n === "string" ? new Node("#text", n) : n);
  }
  get classList() {
    return { add: (c: string) => void (this.className = `${this.className} ${c}`.trim()) };
  }
  get textContent(): string {
    return this.text ?? this.children.map((c) => c.textContent).join("");
  }
  set textContent(value: string) {
    this.children = [];
    this.text = value;
  }
}
const fakeDocument = new Proxy(
  {
    createElement: (tag: string) => new Node(tag),
    createTextNode: (text: string) => new Node("#text", text),
  } as Record<string | symbol, unknown>,
  { get: (target, key) => (key in target ? target[key] : anything) },
);
/** Syntax colour as highlight.js gives it: each token's text, shown as the page says. */
const DesolateHighlight = {
  paint: (tokens: [string][], show: (t: string) => string) =>
    tokens.map(([text]) => new Node("span", show(text))),
};

type Shown = {
  HIDDEN: RegExp;
  unhidden: (text: string) => string;
  name: (text: string) => string;
  diffView: (text: string, tokens?: unknown[]) => Node;
};
type Page = {
  shown: Shown;
  unhidden: (text: string) => string;
  nameShown?: (text: string) => string;
  diffView: (text: string, tokens?: unknown[]) => Node;
  sideBySide?: (text: string, tokens?: unknown[]) => Node;
};

/** A page's script as it runs: shown-text.js first, as each page loads it, then the page's
 *  own, with what `expose` names handed out. */
const page = (script: string, expose: string): Page => {
  const context: Record<string, unknown> = {
    document: fakeDocument,
    Node,
    DesolateHighlight,
    window: { desolateKey: { headers: {}, query: "" }, top: null, addEventListener: () => {} },
    location: { search: "", pathname: "/", hash: "" },
    history: anything,
    localStorage: anything,
    matchMedia: anything,
    EventSource: anything,
    ResizeObserver: anything,
    MutationObserver: anything,
    fetch: () => new Promise(() => {}),
    setInterval: () => 0,
    setTimeout: () => 0,
    performance,
    URLSearchParams,
    console,
  };
  vm.runInNewContext(
    `${source("shared/ui/shown-text.js")}\n${source(script)}\nthis.shown = DesolateShown; ${expose}`,
    context,
  );
  return context as unknown as Page;
};
const approve = page(
  "host/approve-ui/approve.js",
  "this.unhidden = unhidden; this.diffView = diffView;",
);
const dashboard = page(
  "root/ui/dashboard.js",
  "this.unhidden = unhidden; this.nameShown = nameShown; this.diffView = diffView; this.sideBySide = sideBySide;",
);

/** Each class of character that hides or reorders text, and the mark a page shows for it. */
const HOSTILE: [what: string, char: string, mark: string][] = [
  ["NUL", "\u0000", "⟨U+0000⟩"],
  ["a bell (ends a terminal's OSC)", "\u0007", "⟨U+0007⟩"],
  ["escape (starts a terminal's sequence)", "\u001b", "⟨U+001B⟩"],
  ["DEL", "\u007f", "⟨U+007F⟩"],
  ["C1's CSI", "\u009b", "⟨U+009B⟩"],
  ["a carriage return inside a line", "\r", "⟨U+000D⟩"],
  ["the line separator", "\u2028", "⟨U+2028⟩"],
  ["the paragraph separator", "\u2029", "⟨U+2029⟩"],
  ["the Arabic letter mark", "\u061c", "⟨U+061C⟩"],
  ["a left-to-right mark", "\u200e", "⟨U+200E⟩"],
  ["a right-to-left override", "\u202e", "⟨U+202E⟩"],
  ["a left-to-right isolate", "\u2066", "⟨U+2066⟩"],
  ["a pop directional isolate", "\u2069", "⟨U+2069⟩"],
  ["a zero-width space", "\u200b", "⟨U+200B⟩"],
  ["a zero-width non-joiner", "\u200c", "⟨U+200C⟩"],
  ["a zero-width joiner", "\u200d", "⟨U+200D⟩"],
  ["a word joiner", "\u2060", "⟨U+2060⟩"],
  ["an invisible times", "\u2062", "⟨U+2062⟩"],
  ["a byte-order mark", "\ufeff", "⟨U+FEFF⟩"],
  ["a soft hyphen", "\u00ad", "⟨U+00AD⟩"],
  ["an interlinear annotation anchor", "\ufff9", "⟨U+FFF9⟩"],
  ["a tag character", "\u{e0041}", "⟨U+E0041⟩"],
  ["a private-use character", "\ue000", "⟨U+E000⟩"],
  ["a private-use character past the first plane", "\u{f0000}", "⟨U+F0000⟩"],
  ["an unassigned code point", "\u0378", "⟨U+0378⟩"],
  ["a lone high surrogate", "\ud800", "⟨U+D800⟩"],
  ["a lone low surrogate", "\udc00", "⟨U+DC00⟩"],
  ["the combining grapheme joiner", "\u034f", "⟨U+034F⟩"],
  ["the Hangul choseong filler", "\u115f", "⟨U+115F⟩"],
  ["the Hangul jungseong filler", "\u1160", "⟨U+1160⟩"],
  ["the Hangul filler", "\u3164", "⟨U+3164⟩"],
  ["the halfwidth Hangul filler", "\uffa0", "⟨U+FFA0⟩"],
  ["a Khmer vowel Unicode says not to use", "\u17b4", "⟨U+17B4⟩"],
  ["the other one", "\u17b5", "⟨U+17B5⟩"],
  ["a Mongolian free variation selector", "\u180b", "⟨U+180B⟩"],
  ["the Mongolian vowel separator", "\u180e", "⟨U+180E⟩"],
  ["the blank Braille pattern", "\u2800", "⟨U+2800⟩"],
  ["the first variation selector", "\ufe00", "⟨U+FE00⟩"],
  ["the emoji variation selector, after a letter", "\ufe0f", "⟨U+FE0F⟩"],
  ["a supplementary variation selector", "\u{e0100}", "⟨U+E0100⟩"],
  ["the last one", "\u{e01ef}", "⟨U+E01EF⟩"],
];
/** suede.sh's `say` (its line, `fn`) run on `text`, as an argument, as the recipe passes one. */
const say = (fn: string, text: string): string =>
  spawnSync("bash", ["--norc", "-c", `${fn}\nsay "$1"`, "_", text], { encoding: "utf8" }).stdout;
const BEFORE = "pay";
const AFTER = "pal.com";
/** Text no rule should touch: letters past ASCII, symbols, an emoji with no selector, and
 *  pictographs with their one presentation selector (emoji, text). */
const PLAIN =
  "caf\u00e9 \u2713 \u65e5\u672c\u8a9e \u2764 \u{1f44d} a\u00a0b \u26a0\ufe0f \u2764\ufe0e";

/** The surfaces that show text another wrote, each with the mark it shows in place. */
const SURFACES: [surface: string, show: (text: string) => string, mark: "?" | "page"][] = [
  ["the terminal, a line (printable)", (t) => printable(t), "?"],
  ["the terminal, text of lines (printableLines)", (t) => printableLines(t), "?"],
  ["the terminal, every line of the CLI (forTerminal)", (t) => forTerminal(t), "?"],
  ["the terminal, a failure's last lines (failure)", (t) => failure(t, 5, () => null), "?"],
  ["the approval page's diff and issue (unhidden)", (t) => approve.unhidden(t), "page"],
  ["the dashboard's diff (unhidden)", (t) => dashboard.unhidden(t), "page"],
  ["the dashboard's list of files (nameShown)", (t) => dashboard.nameShown!(t), "page"],
];

describe("T1 text another wrote, shown as itself on every surface", () => {
  for (const [surface, show, mark] of SURFACES)
    describe(surface, () => {
      it("plain text is shown unchanged (the control)", () => {
        assert.equal(show(PLAIN), PLAIN);
        assert.equal(show(BEFORE + AFTER), BEFORE + AFTER);
      });
      for (const [what, char, pageMark] of HOSTILE)
        it(`${what}: still there, as a visible mark, between the text around it`, () => {
          assert.equal(
            show(BEFORE + char + AFTER),
            BEFORE + (mark === "?" ? "?" : pageMark) + AFTER,
          );
        });
      it("a pictograph's one selector stays; any other selector is marked", () => {
        const m = (point: string) => (mark === "?" ? "?" : `\u27e8U+${point}\u27e9`);
        assert.equal(show("\u26a0\ufe0f"), "\u26a0\ufe0f");
        for (const [text, shown] of [
          ["a\ufe0f", `a${m("FE0F")}`],
          ["\u26a0\ufe0f\ufe0f", `\u26a0\ufe0f${m("FE0F")}`],
          ["\ufe0f", m("FE0F")],
          ["\u26a0\ufe01", `\u26a0${m("FE01")}`],
          ["\u26a0\u{e0100}", `\u26a0${m("E0100")}`],
        ])
          assert.equal(show(text!), shown, JSON.stringify(text));
      });
      it("a family emoji: its pictographs shown, each zero-width joiner marked", () => {
        const zwj = mark === "?" ? "?" : "\u27e8U+200D\u27e9";
        assert.equal(
          show("\u{1f468}\u200d\u{1f469}\u200d\u{1f467}"),
          `\u{1f468}${zwj}\u{1f469}${zwj}\u{1f467}`,
        );
      });
      it("an escape sequence: its escape named, the rest of it shown as text", () => {
        const expected = mark === "?" ? "ok?[31mred?[0m" : "ok⟨U+001B⟩[31mred⟨U+001B⟩[0m";
        assert.equal(show("ok\u001b[31mred\u001b[0m"), expected);
      });
    });

  it("the reviewer's names (named): each hidden character a question mark, in place", () => {
    for (const [what, char] of HOSTILE) {
      // (A path is git's bytes; a lone surrogate has none in UTF-8, and is not one.)
      if (/[\ud800-\udfff]/.test(char)) continue;
      const raw = Buffer.from(BEFORE + char + AFTER, "utf8").toString("latin1");
      assert.equal(named(raw), `${BEFORE}?${AFTER}`, what);
    }
    assert.equal(
      named(Buffer.from(PLAIN.replace(/ /g, "_"), "utf8").toString("latin1")),
      PLAIN.replace(/ /g, "_"),
    );
  });

  it("suede.sh's say (jq): each hidden character a question mark, in place", () => {
    const line = source("recipes/suede.sh")
      .split("\n")
      .find((each) => each.startsWith("say() {"));
    assert.ok(line, "recipes/suede.sh defines say() on one line");
    for (const [what, char] of HOSTILE) {
      // (An argument holds no NUL, and UTF-8 no lone surrogate: neither reaches say.)
      if (char === "\u0000" || /[\ud800-\udfff]/.test(char)) continue;
      assert.equal(say(line, BEFORE + char + AFTER), `${BEFORE}?${AFTER}\n`, what);
    }
    assert.equal(say(line, PLAIN), `${PLAIN}\n`);
    for (const [text, shown] of [
      ["a\ufe0f", "a?"],
      ["\u26a0\ufe0f\ufe0f", "\u26a0\ufe0f?"],
      ["\ufe0f", "?"],
      ["\u26a0\ufe01", "\u26a0?"],
      ["\u26a0\u{e0100}", "\u26a0?"],
    ])
      assert.equal(say(line, text!), `${shown}\n`, JSON.stringify(text));
  });

  it("a JSON line keeps every character, as an escape: exact, still JSON, nothing raw", () => {
    for (const [what, char] of HOSTILE) {
      const line = JSON.stringify({ m: BEFORE + char + AFTER });
      const out = forTerminal(line);
      assert.doesNotMatch(out, new RegExp(UNSAFE.source, "u"), what);
      assert.equal((JSON.parse(out) as { m: string }).m, BEFORE + char + AFTER, what);
    }
    assert.equal(forTerminal(JSON.stringify({ m: PLAIN })), JSON.stringify({ m: PLAIN }));
  });

  it("a very long line: shown whole on a page, and in a terminal up to the bound, the cut marked", () => {
    const long = `a\u202e${"x".repeat(200_000)}\u202eb`;
    for (const show of [approve.unhidden, dashboard.unhidden])
      assert.equal(show(long), `a⟨U+202E⟩${"x".repeat(200_000)}⟨U+202E⟩b`);
    assert.equal(printableLines(long), `a?${"x".repeat(200_000)}?b`);
    assert.equal(printable(long), `a?${"x".repeat(3997)}…`);
  });

  it("layout: a tab and a newline stay in text of lines, and are named in a file's name", () => {
    for (const show of [approve.unhidden, dashboard.unhidden]) {
      assert.equal(show("a\tb\nc\r"), "a\tb\nc\r");
      assert.equal(show("a\rb"), "a⟨U+000D⟩b");
    }
    assert.equal(dashboard.nameShown!("ok.txt\nREADME.md"), "ok.txt⟨U+000A⟩README.md");
    assert.equal(dashboard.nameShown!("a\tb"), "a⟨U+0009⟩b");
    assert.equal(dashboard.nameShown!("trailing  "), "trailing⟨space⟩⟨space⟩");
    assert.equal(printableLines("a\tb\nc"), "a\tb\nc");
    assert.equal(printable("a\tb"), "a?b");
  });
});

describe("T1 one rule: the pages' copy is shared/text.ts's", () => {
  it("shown-text.js's HIDDEN is text.ts's UNSAFE, character for character", () => {
    assert.equal(approve.shown.HIDDEN.source, UNSAFE.source);
    assert.equal(approve.shown.HIDDEN.flags, UNSAFE.flags);
  });
  it("suede.sh's say is UNSAFE as jq writes it", () => {
    const jq = /gsub\("(.*)"; "\?"\)/.exec(source("recipes/suede.sh"))?.[1]?.replace(/\\\\/g, "\\");
    const asJq = UNSAFE.source.replace(/\\u\{?([0-9a-f]+)\}?/g, "\\x{$1}");
    assert.equal(jq, asJq);
  });
  it("a copy that drifted is seen (the control: the dashboard's old, shorter list)", () => {
    const old = /[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
    assert.notEqual(old.source, UNSAFE.source);
    // ...and would fail the table above: a filler and a blank Braille pattern shown as nothing.
    assert.equal("a\u3164b\u2800c".replace(old, "!"), "a\u3164b\u2800c");
  });
  it("both pages use it, and hold no rule of their own", () => {
    assert.equal(dashboard.unhidden, dashboard.shown.unhidden);
    assert.equal(dashboard.nameShown, dashboard.shown.name);
    assert.equal(approve.unhidden, approve.shown.unhidden);
    for (const script of ["host/approve-ui/approve.js", "root/ui/dashboard.js"])
      assert.doesNotMatch(source(script), /\\p\{C[cf]\}|\\u202e|\\u200b/, script);
  });
  it("both pages load it before their own script, and both servers serve it", () => {
    for (const [html, own] of [
      ["host/approve-ui/approve.html", "/approve.js"],
      ["root/ui/dashboard.html", "/ui.js"],
    ] as const) {
      const text = source(html);
      const at = text.indexOf('<script src="/shown-text.js"');
      assert.ok(at > 0 && at < text.indexOf(`<script src="${own}"`), html);
    }
    for (const server of ["host/approve-web.ts", "root/stated.ts"])
      assert.match(
        source(server),
        /"\/shown-text\.js": \["\.\.\/\.\.\/shared\/ui\/shown-text\.js"/,
        server,
      );
  });
  it("what the pages show is set as text, never as markup", () => {
    for (const script of [
      "shared/ui/shown-text.js",
      "host/approve-ui/approve.js",
      "root/ui/dashboard.js",
    ])
      assert.doesNotMatch(
        source(script),
        /innerHTML|outerHTML|insertAdjacentHTML|document\.write/,
        script,
      );
  });
});

/** A diff with a renamed file, a file of the same name, and what hides in each part a page shows. */
const DIFF = [
  "diff --git a/old.txt b/new.txt",
  "similarity index 90%",
  "rename from old.txt",
  "rename to new.txt",
  "--- a/old.txt",
  "+++ b/new.txt",
  "@@ -1 +1 @@ ctx\u202e",
  "-pay\u200bpal",
  "+pay\u3164pal",
  "diff --git a/same\u2066.txt b/same\u2066.txt",
  "--- a/same\u2066.txt",
  "+++ b/same\u2066.txt",
  "@@ -1 +1 @@",
  "-a\u0000",
  "+a\u001b[2J",
].join("\n");
const raw = new RegExp(UNSAFE.source, "u");

describe("T1 one diff for both pages (shared/ui/shown-text.js diffView)", () => {
  it("both pages draw it with the one renderer", () => {
    assert.equal(approve.diffView, approve.shown.diffView);
    assert.equal(dashboard.diffView, dashboard.shown.diffView);
    assert.equal(dashboard.diffView(DIFF).attrs["data-diff"], "");
  });
  for (const [name, view] of [
    ["the approval page", approve.diffView],
    ["the dashboard, unified", dashboard.diffView],
  ] as const)
    it(`${name}: each line a span, its kind its class, what hides in it named`, () => {
      const spans = view(DIFF).children;
      const lines = DIFF.split("\n");
      assert.deepEqual(
        spans.map((span) => span.textContent),
        lines.map((line) => approve.shown.unhidden(line)),
      );
      assert.deepEqual(
        spans.map((span) => span.className),
        ["file", "", "", "", "", "", "hunk", "del", "add", "file", "", "", "hunk", "del", "add"],
      );
      for (const span of spans) assert.doesNotMatch(span.textContent, raw);
      assert.equal(spans[7]!.textContent, "-pay\u27e8U+200B\u27e9pal");
      assert.equal(spans[8]!.textContent, "+pay\u27e8U+3164\u27e9pal");
      // The header names both of a renamed file's names; the list of files finds it by the old.
      assert.equal(spans[0]!.textContent, "diff --git a/old.txt b/new.txt");
      assert.equal(spans[0]!.attrs["data-file"], "old.txt");
      assert.equal(spans[9]!.attrs["data-file"], "same\u2066.txt");
    });
  it("the dashboard, side by side: a renamed file's header names both names, every row as itself", () => {
    const rows = dashboard.sideBySide!(DIFF).children;
    const files = rows.filter((row) => row.className === "sbs-file");
    assert.deepEqual(
      files.map((row) => row.textContent),
      // The renamed file's header said only "old.txt" (the triage of 2026-11-22); a file of
      // one name says it once (the control).
      ["a/old.txt b/new.txt", "same\u27e8U+2066\u27e9.txt"],
    );
    assert.deepEqual(
      files.map((row) => row.attrs["data-file"]),
      ["old.txt", "same\u2066.txt"],
    );
    const shown = rows.map((row) => row.textContent);
    for (const text of shown) assert.doesNotMatch(text, raw);
    for (const expected of [
      "@@ -1 +1 @@ ctx\u27e8U+202E\u27e9",
      "rename from old.txt",
      "rename to new.txt",
      "1pay\u27e8U+200B\u27e9pal1pay\u27e8U+3164\u27e9pal",
      "1a\u27e8U+0000\u27e91a\u27e8U+001B\u27e9[2J",
    ])
      assert.ok(shown.includes(expected), `${expected} in ${JSON.stringify(shown)}`);
  });
  it("in colour, the text is the same; a line with a carriage return inside it is drawn plain", () => {
    const text = "+ab\n+a\rb";
    const tokens = [
      [["a"], ["b"]],
      [["a\r"], ["b"]],
    ];
    for (const view of [approve.diffView, dashboard.diffView]) {
      const [coloured, plain] = view(text, tokens).children;
      // (Coloured: the line's first character, then a span a token; the control.)
      assert.equal(coloured!.children.length, 3);
      assert.equal(coloured!.textContent, "+ab");
      // A return the token ends with would read as the line's end: drawn plain, and named.
      assert.equal(plain!.children.length, 0);
      assert.equal(plain!.textContent, "+a\u27e8U+000D\u27e9b");
    }
  });
});
