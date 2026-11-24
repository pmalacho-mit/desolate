// Text a repository or a workspace wrote, as the approval page and the dashboard show it: what
// would hide or reorder it named, so that it reads as git stores it, and a diff drawn from it.
// One rule and one diff for both pages: the two diffs a person compares cannot differ.
// Everything is set as text (textContent, text nodes), never as markup.
"use strict";
const DesolateShown = (() => {
  // shared/text.ts's UNSAFE, which a page cannot import (tests/v3/t1/shown-text.test.ts compares).
  const HIDDEN = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}\u034f\u115f\u1160\u17b4\u17b5\u180b-\u180f\u2800\u3164\ufe00-\ufe0d\uffa0\u{e0100}-\u{e01ef}]|(?<!\p{Extended_Pictographic})[\ufe0e\ufe0f]/gu;
  const mark = (c) => `⟨U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}⟩`;
  /** Text of lines (a diff's line, an issue's body) with each such character named, but for a
   *  tab, a newline and a carriage return that ends a line: there, each is layout. */
  const unhidden = (text) => String(text).replace(HIDDEN, (c, at, all) => c === "\t" || c === "\n" || (c === "\r" && (at + 1 === all.length || all[at + 1] === "\n")) ? c : mark(c));
  /** A file's name in a list: each one named, a newline and a tab too, a trailing space marked
   *  (notes-<U+202E>dm.hs read "notes-sh.md": safety-colleague, dogfooding 2026-11-22). */
  const name = (text) => String(text).replace(HIDDEN, mark).replace(/ +$/, (spaces) => "⟨space⟩".repeat(spaces.length));
  /** What a line of git's diff is, as its span's class. */
  const kindOf = (line) => line.startsWith("diff --git") ? "file" : line.startsWith("@@") ? "hunk" : line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "del" : "";
  /** A header's file by its old name, as the dashboard's list finds it (`data-file`). */
  const fileOf = (line) => line.replace(/^diff --git a\/(.*) b\/.*$/, "$1");
  /** A line's colours (shared/ui/highlight.js), or null. `unhidden` then sees a token at a time,
   *  where a return that ends one reads as the line's end: such a line is drawn plain. */
  const colours = (tokens, i, line) => tokens && tokens[i] && typeof DesolateHighlight !== "undefined" && !/\r(?!$)/.test(line) ? tokens[i] : null;
  /** git's text, a line a span classed by what it is; given `tokens`, in colour, the same text. */
  const diffView = (text, tokens) => {
    const pre = document.createElement("pre");
    pre.className = "diff";
    pre.setAttribute("data-diff", "");
    text.split("\n").forEach((line, i) => {
      const span = document.createElement("span");
      span.className = kindOf(line);
      if (span.className === "file") span.setAttribute("data-file", fileOf(line));
      const code = colours(tokens, i, line);
      if (code) span.append(document.createTextNode(line[0]), ...DesolateHighlight.paint(code, unhidden));
      else span.textContent = unhidden(line) || " ";
      pre.append(span);
    });
    return pre;
  };
  return { HIDDEN, unhidden, name, fileOf, colours, diffView };
})();
