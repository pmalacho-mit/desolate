// GitHub-flavoured Markdown, previewed on the dashboard (an issue a workspace offered,
// shared/issues.ts). The text is an agent's: it is never parsed as HTML. `parse` makes a tree
// of a fixed set of elements whose text is always text; `render` builds that tree with
// createElement and text nodes. HTML written in the Markdown is shown as the text it is.
//
// What is drawn: headings, paragraphs (a newline is a line break, as on GitHub), emphasis,
// strong, strikethrough, code spans and blocks, block quotes, lists (nested, ordered, task
// lists), tables, rules, links and autolinks. A link keeps its address only if it is http,
// https or mailto, opens in a new tab with no opener and no referrer, and shows where it goes
// as its title. An image is never fetched: it is drawn as a link to itself, so nothing on the
// page loads anything an agent named. Everything else is text.
//
// Bounded work: where each kind of emphasis may close is worked out once per run of text, and
// an opener finds its closer by binary search; a code span's or link's closer that is not
// there is remembered; nesting stops at a depth. So a body of 64 KiB of unclosed `*`, `_` or
// `**` costs a pass or two, not a pass per opener (measured: each under 50 ms).
"use strict";
const DesolateMarkdown = (() => {
  const SAFE = /^(https?:\/\/|mailto:)[^\s]*$/i;
  const node = (tag, attrs, children) => ({ tag, attrs: attrs || {}, children: children || [] });
  const text = (value) => ({ text: value });

  // ---------------------------------------------------------------- inline
  const DEEPEST = 8;
  /** How far an autolink is looked for: past a common browser's URL limit (about 2,000),
   *  so scanning costs little whatever the text. A bare address longer than this is left as
   *  text, never linked cut (it would go somewhere else). */
  const LINK_MOST = 2100;
  /** The first value in a sorted list above `from`, or -1. */
  const above = (list, from) => {
    let lo = 0, hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid] > from) hi = mid;
      else lo = mid + 1;
    }
    return lo < list.length ? list[lo] : -1;
  };
  const inline = (source, depth = 0) => {
    if (depth > DEEPEST) return [text(source)];
    const out = [];
    // Where each emphasis may close: after a character that is not a space, and (for `_`)
    // not inside a word; a single `*` or `_` that is not part of a pair.
    const closersOf = new Map();
    const closers = (kind) => {
      if (closersOf.has(kind)) return closersOf.get(kind);
      const list = [];
      for (let at = source.indexOf(kind); at >= 0; at = source.indexOf(kind, at + 1)) {
        if (at === 0 || /\s/.test(source[at - 1])) continue;
        if (kind.length === 1 && (source[at + 1] === kind || source[at - 1] === kind)) continue;
        if (kind[0] === "_" && /\w/.test(source[at + kind.length] || "")) continue;
        list.push(at);
      }
      closersOf.set(kind, list);
      return list;
    };
    let buffer = "";
    const flush = () => {
      if (buffer) out.push(text(buffer));
      buffer = "";
    };
    const missing = new Set();
    /** The next `closer` after `from`, or -1, remembered when there is none. */
    const find = (closer, from) => {
      if (missing.has(closer)) return -1;
      const at = source.indexOf(closer, from);
      if (at < 0) missing.add(closer);
      return at;
    };
    let i = 0;
    while (i < source.length) {
      const c = source[i];
      const before = i === 0 ? " " : source[i - 1];
      if (c === "\\" && i + 1 < source.length) {
        if (source[i + 1] === "\n") {
          flush();
          out.push(node("br"));
          i += 2;
          continue;
        }
        if (/[!-/:-@[-`{-~]/.test(source[i + 1])) {
          buffer += source[i + 1];
          i += 2;
          continue;
        }
      }
      if (c === "\n") {
        flush();
        out.push(node("br"));
        i += 1;
        continue;
      }
      if (c === "`") {
        let run = 1;
        while (source[i + run] === "`") run += 1;
        const fence = "`".repeat(run);
        let at = find(fence, i + run);
        // A closer of the same length exactly, not part of a longer run.
        while (at >= 0 && source[at + run] === "`") {
          let end = at;
          while (source[end] === "`") end += 1;
          at = source.indexOf(fence, end);
        }
        if (at >= 0) {
          flush();
          let code = source.slice(i + run, at).replace(/\n/g, " ");
          if (/^ .* $/.test(code) && code.trim()) code = code.slice(1, -1);
          out.push(node("code", {}, [text(code)]));
          i = at + run;
          continue;
        }
        buffer += fence;
        i += run;
        continue;
      }
      // [text](url "title") and ![alt](url)
      if (c === "[" || (c === "!" && source[i + 1] === "[")) {
        const open = c === "!" ? i + 1 : i;
        const close = find("]", open + 1);
        if (close >= 0 && source[close + 1] === "(") {
          const end = source.indexOf(")", close + 2);
          if (end >= 0) {
            const target = /^\s*<?([^\s<>]*)>?(?:\s+"([^"]*)")?\s*$/.exec(source.slice(close + 2, end));
            if (target) {
              flush();
              const label = source.slice(open + 1, close);
              const href = target[1];
              if (c === "!") out.push(link(href, [text(`image: ${label || href}`)], "image"));
              else out.push(link(href, inline(label, depth + 1), target[2]));
              i = end + 1;
              continue;
            }
          }
        }
      }
      // <https://...> and a bare https://... (GitHub's autolinks)
      if (c === "<") {
        const m = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(source.slice(i, i + LINK_MOST));
        if (m) {
          flush();
          out.push(link(m[1], [text(m[1])]));
          i += m[0].length;
          continue;
        }
      }
      if ((c === "h" || c === "H") && /[\s(*_~]/.test(before)) {
        const m = /^https?:\/\/[^\s<]*[^\s<.,:;"')\]!?*_~]/i.exec(source.slice(i, i + LINK_MOST));
        // (One that runs on past the window was cut by it: not a link.)
        if (m && /^[^\s<]*/.exec(source.slice(i, i + LINK_MOST + 1))[0].length <= LINK_MOST) {
          flush();
          out.push(link(m[0], [text(m[0])]));
          i += m[0].length;
          continue;
        }
      }
      // **strong**, __strong__, ~~struck~~, *em*, _em_
      const pair = source.slice(i, i + 2);
      if ((pair === "**" || pair === "__" || pair === "~~") && source[i + 2] && !/\s/.test(source[i + 2]) && (pair !== "__" || !/\w/.test(before))) {
        const at = above(closers(pair), i + 2);
        if (at >= 0) {
          flush();
          out.push(node(pair === "~~" ? "del" : "strong", {}, inline(source.slice(i + 2, at), depth + 1)));
          i = at + 2;
          continue;
        }
      }
      if ((c === "*" || c === "_") && source[i + 1] && !/\s/.test(source[i + 1]) && source[i + 1] !== c && (c === "*" || !/\w/.test(before))) {
        const at = above(closers(c), i + 1);
        if (at >= 0) {
          flush();
          out.push(node("em", {}, inline(source.slice(i + 1, at), depth + 1)));
          i = at + 1;
          continue;
        }
      }
      buffer += c;
      i += 1;
    }
    flush();
    return out;
  };
  /** A link, only to where it says it goes; anything else is its text. */
  const link = (href, children, title) => (SAFE.test(href) ? node("a", { href, title: title === "image" ? href : title ? `${title}  (${href})` : href }, children) : node("span", {}, children));

  // ---------------------------------------------------------------- blocks
  const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
  // No two runs of [ \t]* side by side, here or in TABLE_RULE: on a line of 65,000 spaces they
  // backtracked for 15 s (audit, 2026-11-16). The closing #s go by hand (headingText).
  const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/;
  const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
  const QUOTE = /^ {0,3}> ?(.*)$/;
  const ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])([ \t]+(.*)|[ \t]*)$/;
  const TABLE_RULE_TRIMMED = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?$/;
  const TABLE_RULE = { test: (line) => TABLE_RULE_TRIMMED.test(line.trimEnd()) };
  /** A heading's text: without its trailing blanks, and without a closing run of #s that a
   *  blank (or nothing) comes before. */
  const headingText = (raw) => {
    let text = raw.trimEnd();
    let end = text.length;
    while (end > 0 && text[end - 1] === "#") end -= 1;
    if (end < text.length && (end === 0 || text[end - 1] === " " || text[end - 1] === "\t")) text = text.slice(0, end).trimEnd();
    return text;
  };
  const cells = (line) => {
    let row = line.trim();
    if (row.startsWith("|")) row = row.slice(1);
    if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
    const out = [];
    let cell = "";
    for (let i = 0; i < row.length; i++) {
      if (row[i] === "\\" && row[i + 1] === "|") {
        cell += "|";
        i += 1;
      } else if (row[i] === "|") {
        out.push(cell.trim());
        cell = "";
      } else cell += row[i];
    }
    out.push(cell.trim());
    return out;
  };
  const startsBlock = (line, next) => FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || ITEM.test(line) || (line.includes("|") && next !== undefined && TABLE_RULE.test(next));

  const blocks = (lines, depth) => {
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        i += 1;
        continue;
      }
      let m;
      if ((m = FENCE.exec(line))) {
        const fence = m[1];
        const body = [];
        i += 1;
        while (i < lines.length && !new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}[ \\t]*$`).test(lines[i])) body.push(lines[i++]);
        i += 1;
        const lang = m[2].trim().split(/\s+/)[0];
        out.push(node("pre", lang ? { "data-lang": lang } : {}, [node("code", {}, [text(body.join("\n"))])]));
        continue;
      }
      if ((m = HEADING.exec(line))) {
        out.push(node(`h${m[1].length}`, {}, inline(headingText(m[2] || ""))));
        i += 1;
        continue;
      }
      if (RULE.test(line)) {
        out.push(node("hr"));
        i += 1;
        continue;
      }
      if (QUOTE.test(line)) {
        const inner = [];
        while (i < lines.length && lines[i].trim() && (QUOTE.test(lines[i]) || !startsBlock(lines[i], lines[i + 1]))) inner.push((QUOTE.exec(lines[i]) || [null, lines[i]])[1]), (i += 1);
        out.push(node("blockquote", {}, depth < 12 ? blocks(inner, depth + 1) : [node("p", {}, [text(inner.join("\n"))])]));
        continue;
      }
      if ((m = ITEM.exec(line))) {
        const ordered = /\d/.test(m[2]);
        const marker = m[2].slice(-1);
        const items = [];
        while (i < lines.length) {
          const head = ITEM.exec(lines[i]);
          if (!head || /\d/.test(head[2]) !== ordered || head[2].slice(-1) !== marker) break;
          const indent = head[1].length + head[2].length + Math.max(1, Math.min(4, (head[3] || " ").length - (head[4] || "").length));
          const body = [head[4] || ""];
          i += 1;
          // The item's own lines: indented under it, or a paragraph carried on.
          while (i < lines.length) {
            const l = lines[i];
            if (!l.trim()) {
              if (i + 1 < lines.length && /^\s/.test(lines[i + 1]) && lines[i + 1].length - lines[i + 1].trimStart().length >= indent) {
                body.push("");
                i += 1;
                continue;
              }
              break;
            }
            if (l.length - l.trimStart().length >= indent) body.push(l.slice(indent));
            else if (!startsBlock(l, lines[i + 1]) && body[body.length - 1].trim()) body.push(l.trim());
            else break;
            i += 1;
          }
          let content = body;
          let checked = null;
          const task = /^\[([ xX])\][ \t]+(.*)$/.exec(content[0]);
          if (task) {
            checked = task[1] !== " ";
            content = [task[2], ...content.slice(1)];
          }
          const inner = depth < 12 ? blocks(content, depth + 1) : [node("p", {}, [text(content.join("\n"))])];
          // A tight item's single paragraph is drawn without the paragraph around it.
          const children = inner.length === 1 && inner[0].tag === "p" ? inner[0].children : inner;
          items.push(node("li", checked === null ? {} : { class: "task" }, checked === null ? children : [node("input", { type: "checkbox", disabled: "", ...(checked ? { checked: "" } : {}) }), text(" "), ...children]));
          while (i < lines.length && !lines[i].trim() && i + 1 < lines.length && ITEM.test(lines[i + 1])) i += 1;
        }
        const start = ordered ? Number(/\d+/.exec(m[2])[0]) : 1;
        out.push(node(ordered ? "ol" : "ul", ordered && start !== 1 ? { start: String(start) } : {}, items));
        continue;
      }
      if (line.includes("|") && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1])) {
        const head = cells(line);
        const align = cells(lines[i + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : null));
        const cell = (tag, value, n) => node(tag, align[n] ? { style: `text-align: ${align[n]}` } : {}, inline(value));
        const rows = [];
        i += 2;
        while (i < lines.length && lines[i].trim() && lines[i].includes("|")) rows.push(cells(lines[i++]));
        out.push(node("table", {}, [node("thead", {}, [node("tr", {}, head.map((c, n) => cell("th", c, n)))]), node("tbody", {}, rows.map((r) => node("tr", {}, head.map((_, n) => cell("td", r[n] || "", n)))))]));
        continue;
      }
      const paragraph = [];
      while (i < lines.length && lines[i].trim() && !(paragraph.length && startsBlock(lines[i], lines[i + 1]))) paragraph.push(lines[i++].trim());
      out.push(node("p", {}, inline(paragraph.join("\n").replace(/ {2,}\n/g, "\n"))));
    }
    return out;
  };

  const parse = (source) => blocks(String(source || "").replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n"), 0);

  // ---------------------------------------------------------------- the page
  const ALLOWED = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "p", "br", "strong", "em", "del", "code", "pre", "blockquote", "ul", "ol", "li", "input", "table", "thead", "tbody", "tr", "th", "td", "hr", "a", "span"]);
  const ATTRIBUTES = new Set(["href", "title", "start", "type", "disabled", "checked", "class", "data-lang", "style"]);
  const render = (source) => {
    const fragment = document.createDocumentFragment();
    const build = (item) => {
      if ("text" in item) return document.createTextNode(item.text);
      if (!ALLOWED.has(item.tag)) return document.createTextNode("");
      const element = document.createElement(item.tag);
      for (const [key, value] of Object.entries(item.attrs)) {
        if (!ATTRIBUTES.has(key)) continue;
        if (key === "href" && !SAFE.test(value)) continue;
        if (key === "style" && !/^text-align: (left|right|center)$/.test(value)) continue;
        if (key === "type" && value !== "checkbox") continue;
        element.setAttribute(key, value);
      }
      if (item.tag === "a") {
        element.setAttribute("target", "_blank");
        element.setAttribute("rel", "noopener noreferrer nofollow");
      }
      for (const child of item.children) element.append(build(child));
      return element;
    };
    for (const item of parse(source)) fragment.append(build(item));
    return fragment;
  };
  return { parse, render };
})();
if (typeof module !== "undefined") module.exports = DesolateMarkdown;
