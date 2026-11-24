// Text a repository or a workspace wrote, as the approval page and the dashboard show it: what
// would hide or reorder it named, so that it reads as git stores it. One rule for both pages.
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
  return { HIDDEN, unhidden, name };
})();
