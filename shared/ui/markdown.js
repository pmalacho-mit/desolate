// GitHub-flavoured Markdown, previewed on the dashboard (an issue a workspace offered,
// shared/issues.ts). The text is an agent's: it is never parsed as HTML. `parse` makes a tree
// of a fixed set of elements whose text is always text; `render` builds that tree with
// createElement and text nodes. HTML written in the Markdown is shown as the text it is.
//
// What is drawn: headings, paragraphs (a newline is a line break, as on GitHub), emphasis,
// strong, strikethrough, code spans and blocks, block quotes, lists (nested, ordered, task
// lists), tables, rules, links and autolinks. Every piece of text goes through `shown`
// (shown-text.js's rule, on the dashboard). An image is never fetched: it is drawn as a link
// to itself, so nothing on the page loads anything an agent named.
//
// A link is its text and, beside it, where it goes as the browser parses it (`new URL`): the
// host set apart, a name before "@" said not to be the site, an address that does not parse
// or is not http or https said not to be a link. It opens (a new tab, no opener, no referrer,
// at `URL.href`) only to a site on the internet by a plain name: see `closed`. A link's text
// said one site and went to another, and one could GET this dashboard or a service on the
// Mac or its network with the person's cookies (review of #281).
//
// Bounded work: where each kind of emphasis may close is worked out once per run of text, and
// an opener finds its closer by binary search; a code span's closer is looked up among the
// runs of backticks, found once; a link's closer, once found, is remembered; nesting stops at
// a depth; a table's alignment row must have its header's cells. So a body of 64 KiB of
// unclosed `*`, `_` or `**` costs a pass or two (measured: each under 50 ms). Whatever is
// missed, one rendering makes at most BUDGET in elements and time: past it the rest is its
// text, said so. (Before: a line of 256,000 spaces took 135 s, and a 14 KB table made 11.6
// million elements: review of #281.)
"use strict";
const DesolateMarkdown = (() => {
  /** What one rendering may make, in elements and in time: a long issue makes a few thousand
   *  elements, in a few milliseconds. */
  const BUDGET = { nodes: 200_000, ms: 1000 };
  let spent = null;
  class TooMuch extends Error {}
  const count = () => {
    if (!spent) return;
    spent.nodes += 1;
    if (spent.nodes > BUDGET.nodes || ((spent.nodes & 1023) === 0 && Date.now() > spent.until)) throw new TooMuch();
  };
  const node = (tag, attrs, children) => (count(), { tag, attrs: attrs || {}, children: children || [] });
  const text = (value) => (count(), { text: value });

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
    // The next `closer` at or after `from`, or -1: the last one found is still the next for
    // any `from` up to it (256 KiB of `[` then a `]` looked for it once per `[`: a second).
    const found = new Map();
    const find = (closer, from) => {
      const last = found.get(closer);
      if (last && last[0] <= from && (last[1] < 0 || from <= last[1])) return last[1];
      const at = source.indexOf(closer, from);
      found.set(closer, [from, at]);
      return at;
    };
    // Each run of backticks, by its length: a code span closes at the next run of its own
    // length (runs of 1 to 700 backticks, each looked for through the rest: 1.3 s).
    let ticks = null;
    const tickRuns = () => {
      if (ticks) return ticks;
      ticks = new Map();
      for (let at = source.indexOf("`"); at >= 0; ) {
        let end = at;
        while (source[end] === "`") end += 1;
        if (!ticks.has(end - at)) ticks.set(end - at, []);
        ticks.get(end - at).push(at);
        at = source.indexOf("`", end);
      }
      return ticks;
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
        const same = tickRuns().get(run);
        const at = same ? above(same, i + run - 1) : -1;
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
          const end = find(")", close + 2);
          if (end >= 0) {
            const target = /^\s*<?([^\s<>]*)>?(?:\s+"([^"]*)")?\s*$/.exec(source.slice(close + 2, end));
            if (target) {
              flush();
              const label = source.slice(open + 1, close);
              const href = target[1];
              if (c === "!") out.push(node("link", { address: href }, [text(`image: ${label || href}`)]));
              else out.push(node("link", target[2] === undefined ? { address: href } : { address: href, title: target[2] }, unlinked(inline(label, depth + 1))));
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
          out.push(node("link", { address: m[1] }, [text(m[1])]));
          i += m[0].length;
          continue;
        }
      }
      if ((c === "h" || c === "H") && /[\s(*_~]/.test(before)) {
        const m = /^https?:\/\/[^\s<]*[^\s<.,:;"')\]!?*_~]/i.exec(source.slice(i, i + LINK_MOST));
        // (One that runs on past the window was cut by it: not a link.)
        if (m && /^[^\s<]*/.exec(source.slice(i, i + LINK_MOST + 1))[0].length <= LINK_MOST) {
          flush();
          out.push(node("link", { address: m[0] }, [text(m[0])]));
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
  /** A link's text, with no link inside it (an address in it is its text, not another link). */
  const unlinked = (items) => items.map((item) => (item.tag === "link" ? node("span", {}, unlinked(item.children)) : item));

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
  /** A table starts here: a line with a `|`, then its alignment row, of as many cells (GitHub's
   *  rule; a header of 4,000 cells over a rule of one made 11.6 million elements). */
  const tableAt = (line, next) => line.includes("|") && next !== undefined && TABLE_RULE.test(next) && cells(next).length === cells(line).length;
  const startsBlock = (line, next) => FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || ITEM.test(line) || tableAt(line, next);

  const blocks = (lines, depth) => {
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        i += 1;
        continue;
      }
      const from = i;
      try {
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
      if (tableAt(line, lines[i + 1])) {
        const head = cells(line);
        const align = cells(lines[i + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : null));
        const cell = (tag, value, n) => node(tag, align[n] ? { style: `text-align: ${align[n]}` } : {}, inline(value));
        const rows = [];
        i += 2;
        while (i < lines.length && lines[i].trim() && lines[i].includes("|")) rows.push(cells(lines[i++]));
        out.push(node("table", {}, [node("thead", {}, [node("tr", {}, head.map((c, n) => cell("th", c, n)))]), node("tbody", {}, rows.map((r) => node("tr", {}, head.map((_, n) => cell("td", r[n] || "", n)))))]));
        continue;
      }
      // (Each line trimmed, so no run of spaces is left before a line's end. A replace of
      // / {2,}\n/ here, over a line of 256,000 spaces, took 135 s: review of #281.)
      const paragraph = [];
      while (i < lines.length && lines[i].trim() && !(paragraph.length && startsBlock(lines[i], lines[i + 1]))) paragraph.push(lines[i++].trim());
      out.push(node("p", {}, inline(paragraph.join("\n"))));
      } catch (error) {
        // Past the budget: the rest as its text, said so (made without counting).
        if (!(error instanceof TooMuch) || depth > 0) throw error;
        out.push({ tag: "pre", attrs: {}, children: [{ text: lines.slice(from).join("\n") }], why: `Not drawn from here on: it would make more than ${BUDGET.nodes.toLocaleString("en")} elements, or take more than ${BUDGET.ms / 1000} s. It is shown as its text.` });
        return out;
      }
    }
    return out;
  };

  const parse = (source) => {
    const outer = spent;
    spent = { nodes: 0, until: Date.now() + BUDGET.ms };
    try {
      return blocks(String(source || "").replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n"), 0);
    } finally {
      spent = outer;
    }
  };

  // ---------------------------------------------------------------- links
  /** At most this much of an address is shown; the rest is counted. */
  const ADDRESS_MOST = 200;
  const cut = (value) => (value.length > ADDRESS_MOST ? `${value.slice(0, ADDRESS_MOST)}… (${(value.length - ADDRESS_MOST).toLocaleString("en")} more characters not shown)` : value);
  const decoded = (value) => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  /** An address as the browser takes it: parsed, or null. */
  const parsed = (address) => {
    try {
      const url = new URL(address);
      return /^(https?|mailto):$/.test(url.protocol) ? url : null;
    } catch {
      return null;
    }
  };
  // Names of this computer and its network (a page there sees the person's own cookies).
  const LOCAL = /(^|\.)(localhost|local|internal|lan|home\.arpa)$/;
  /** Why a link of an issue's preview does not open, or null: it opens only to a site on the
   *  internet, by a plain name, as written. An IP address (any form: https://0x7f.1/ is
   *  127.0.0.1, parsed), a name with no dot, a local name, this dashboard's own address, a name
   *  before "@", or a name in other alphabets, is text. (A public name whose address is a
   *  private one cannot be seen from here.) */
  const closed = (url, origin) => {
    if (!url || !/^https?:$/.test(url.protocol)) return "it is not an http or https address";
    if (url.username || url.password) return "the part before \"@\" would be taken for the site";
    if (url.origin === origin) return "it is this dashboard's own address";
    const host = url.hostname.toLowerCase();
    if (host.startsWith("[") || /^[\d.]+$/.test(host)) return "it names an IP address, not a site";
    if (!host.includes(".") || LOCAL.test(host)) return "it names this computer or its network";
    if (host.split(".").some((label) => label.startsWith("xn--"))) return "its name is written in other alphabets";
    return null;
  };
  /** Where a link goes, said beside it: the host the browser will use, set apart, the address
   *  (unless the link's text is that address), what before "@" is not the site, its title. */
  const where = (item, label, url, why) => {
    const parts = [];
    if (!url) parts.push(` (not a link: ${cut(item.attrs.address)})`);
    else if (url.protocol === "mailto:") parts.push(` (mail to ${cut(decoded(url.pathname))}${why ? "; not a link" : ""})`);
    else {
      parts.push(" (goes to ", node("span", { class: "host" }, [text(url.host)]));
      if (url.host.split(".").some((part) => part.startsWith("xn--"))) parts.push(", a name in other alphabets");
      if (label !== url.href) parts.push(`: ${cut(url.href)}`);
      if (url.username || url.password) parts.push(`; "${cut(decoded(url.username + (url.password ? `:${url.password}` : "")))}" before the "@" is not the site`);
      if (why) parts.push(`; not a link here: ${why}`);
      parts.push(")");
    }
    if (item.attrs.title !== undefined) parts.push(` titled "${cut(item.attrs.title)}"`);
    return parts.map((part) => (typeof part === "string" ? text(part) : part));
  };

  // ---------------------------------------------------------------- the page
  const ALLOWED = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "p", "br", "strong", "em", "del", "code", "pre", "blockquote", "ul", "ol", "li", "input", "table", "thead", "tbody", "tr", "th", "td", "hr", "span"]);
  const ATTRIBUTES = new Set(["start", "type", "disabled", "checked", "class", "style"]);
  /** `items` as elements of the fixed set, each text through `shown`; a link opens only if
   *  `closed` finds nothing against it (`origin`: this page's own). A part not drawn (BUDGET)
   *  says so in a line of the page's own, which no Markdown can draw (dashboard.css .md-own). */
  const build = (items, shown = String, origin = null) => {
    const fragment = document.createDocumentFragment();
    const one = (item) => {
      if ("text" in item) return document.createTextNode(shown(item.text));
      if (item.tag === "link") {
        const url = parsed(item.attrs.address);
        const label = item.children.map((child) => ("text" in child ? child.text : "")).join("");
        const why = closed(url, origin);
        const element = document.createElement(why ? "span" : "a");
        element.className = "link";
        if (!why) {
          element.setAttribute("href", url.href);
          element.setAttribute("target", "_blank");
          element.setAttribute("rel", "noopener noreferrer nofollow");
        }
        for (const child of item.children) element.append(one(child));
        const address = document.createElement("span");
        address.className = "address";
        for (const part of where(item, label, url, why)) address.append(one(part));
        const both = document.createElement("span");
        both.append(element, address);
        return both;
      }
      if (!ALLOWED.has(item.tag)) return document.createTextNode("");
      const element = document.createElement(item.tag);
      for (const [key, value] of Object.entries(item.attrs)) {
        if (!ATTRIBUTES.has(key)) continue;
        // (A column's alignment, set as a property: the page's CSP refuses a style attribute.)
        if (key === "style") {
          if (/^text-align: (left|right|center)$/.test(value)) element.style.textAlign = value.slice(12);
          continue;
        }
        if (key === "type" && value !== "checkbox") continue;
        element.setAttribute(key, value);
      }
      for (const child of item.children) element.append(one(child));
      if (!item.why) return element;
      const own = document.createElement("div");
      own.className = "md-own";
      own.textContent = item.why;
      const both = document.createDocumentFragment();
      both.append(own, element);
      return both;
    };
    for (const item of items) fragment.append(one(item));
    return fragment;
  };
  const render = (source, shown, origin) => build(parse(source), shown, origin);
  return { parse, render, BUDGET };
})();
if (typeof module !== "undefined") module.exports = DesolateMarkdown;
