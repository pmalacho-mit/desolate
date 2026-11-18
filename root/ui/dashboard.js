// desolate's dashboard (section 4.8). It draws from the state service's stream: nothing is
// fetched to paint, and nothing a repository wrote is ever set as HTML (everything goes
// through textContent).
"use strict";
let state = null;
let reviewing = null;
const busy = new Set();

const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "onclick") node.addEventListener("click", value);
    else if (key === "onsubmit") node.addEventListener("submit", value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat(Infinity)) if (child !== null && child !== undefined && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
};
/** "Open in git": the git terminal (the host's page, not this one) in a new tab, at the
 *  person's clone of the repository. It carries no token: the tab is signed in only if the
 *  person opened `desolate git`'s address in this browser once. */
const gitLink = (repo) => state && state.stack && state.stack.editorPort
  ? el("a", { class: "button quiet", href: `http://${state.stack.gitHostname || "desolate-git.localhost"}:${state.stack.editorPort}/?repo=${encodeURIComponent(repo)}`, target: "_blank", rel: "noopener noreferrer" }, "Open in git")
  : null;
// A token in an address is for the link, never for the label.
const redact = (text) => String(text).replace(/tkn=[0-9a-f]+/g, "tkn=...");
const short = (commit) => String(commit).slice(0, 12);
/** A pill: a word or two in a colour of its own, with more on hover. */
const pill = (text, cls = "", title = null, attrs = {}) => el("span", { class: `pill ${cls}`.trim(), title, ...attrs }, text);
/** How long ago, in words a person reads at a glance. */
const ago = (iso) => {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (!Number.isFinite(s)) return "at an unknown time";
  return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};
// What the person folded (a section, a domain's card), kept in this browser.
const folded = (() => {
  try {
    return new Set(JSON.parse(localStorage.getItem("desolate-folded") || "[]"));
  } catch {
    return new Set();
  }
})();
const toggleFold = (key) => {
  if (folded.has(key)) folded.delete(key);
  else folded.add(key);
  try {
    localStorage.setItem("desolate-folded", JSON.stringify([...folded]));
  } catch {
    /* a page without storage keeps it for now */
  }
  render();
};
let domainFilter = "";
let activityFilter = "";

const act = async (key, kind, args) => {
  busy.add(key);
  render();
  try {
    const response = await fetch("/action", { method: "POST", headers: { "content-type": "application/json", "x-desolate-ui": "1" }, body: JSON.stringify({ kind, args }) });
    if (!response.ok) alertLine((await response.json()).error || "the dashboard could not do that");
  } catch (error) {
    alertLine(String(error));
  } finally {
    setTimeout(() => { busy.delete(key); render(); }, 1500);
  }
};
let notice = "";
const alertLine = (text) => { notice = text; render(); setTimeout(() => { notice = ""; render(); }, 8000); };
const button = (label, key, kind, args, quiet = false) =>
  el("button", { class: quiet ? "quiet" : "", disabled: busy.has(key), "data-action": kind, onclick: () => act(key, kind, args) }, busy.has(key) ? `${label}...` : label);

// The diff, as text. Each line is a text node in a span whose class comes from the line's
// first character: nothing in the diff is ever parsed as markup.
// Characters that reorder or hide what is shown (bidi controls, zero-width ones): in a diff a
// person reviews, each is shown as itself, named, so the line reads as git stores it.
const unhidden = (line) => line.replace(/[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, (c) => `⟨U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}⟩`);
// Given `tokens` (shared/ui/highlight.js, a line's code in its syntax's colours), each line of
// code is drawn in colour; its text is the same either way.
const hasColour = (tokens, i) => Boolean(tokens && tokens[i] && typeof DesolateHighlight !== "undefined");
const diffView = (text, tokens) => el("pre", { class: "mono diff", "data-diff": "" }, text.split("\n").map((line, i) =>
  el("span", { class: line.startsWith("diff --git") ? "file" : line.startsWith("@@") ? "hunk" : line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "del" : "" },
    hasColour(tokens, i) ? [line[0], ...DesolateHighlight.paint(tokens[i], unhidden)] : unhidden(line) || " ")));
// Side by side: git's unified text, laid out in two columns by this script (nothing in the
// root parses anything more). A run of removed lines beside the run of added lines that
// follows it, line by line; in each such pair, the part that differs is marked (the longest
// common start and end are not), so a one-word change reads as one word.
const sides = (text) => {
  const rows = [];
  let oldNo = 0;
  let newNo = 0;
  let dels = [];
  let adds = [];
  const flush = () => {
    // Each removed line beside the added line most like it, in order (so a line inserted
    // above a changed one does not shift every pair after it). Between those, what is left
    // of each side is beside what is left of the other, unmarked: they are not alike.
    let d0 = 0;
    let a0 = 0;
    for (const [d, a] of [...pairs(dels, adds), [dels.length, adds.length]]) {
      const lefts = dels.slice(d0, d);
      const rights = adds.slice(a0, a);
      for (let k = 0; k < Math.max(lefts.length, rights.length); k++) rows.push({ kind: "change", left: lefts[k], right: rights[k], like: false });
      if (d < dels.length) rows.push({ kind: "change", left: dels[d], right: adds[a], like: true });
      d0 = d + 1;
      a0 = a + 1;
    }
    dels = [];
    adds = [];
  };
  for (const [at, line] of text.split("\n").entries()) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (line.startsWith("diff --git")) {
      flush();
      rows.push({ kind: "file", text: line.replace(/^diff --git a\/(.*) b\/.*$/, "$1") });
    } else if (hunk) {
      flush();
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      rows.push({ kind: "hunk", text: line });
    } else if (/^(index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode|Binary)/.test(line)) {
      flush();
      if (/^(new file|deleted file|rename |Binary)/.test(line)) rows.push({ kind: "meta", text: line });
    } else if (line.startsWith("-")) dels.push({ no: oldNo++, text: line.slice(1), at });
    else if (line.startsWith("+")) adds.push({ no: newNo++, text: line.slice(1), at });
    else if (line.startsWith(" ") || line === "") {
      flush();
      if (line === "" && oldNo === 0) continue;
      rows.push({ kind: "same", left: { no: oldNo++, text: line.slice(1), at }, right: { no: newNo++, text: line.slice(1), at } });
    }
  }
  flush();
  return rows;
};
/** How alike two lines are, 0 to 1: the better of their common start and end against the
 *  longer, and the words they share (a line rewritten in its middle keeps its words). */
const likeness = (a, b) => {
  const most = Math.max(a.length, b.length);
  if (most === 0) return 1;
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const words = (line) => line.match(/[\p{L}\p{N}_$]+/gu) ?? [];
  const mine = words(a);
  const theirs = new Map();
  for (const word of words(b)) theirs.set(word, (theirs.get(word) ?? 0) + 1);
  let shared = 0;
  for (const word of mine) if ((theirs.get(word) ?? 0) > 0) {
    shared++;
    theirs.set(word, theirs.get(word) - 1);
  }
  const total = mine.length + words(b).length;
  return Math.max((start + end) / most, total ? (2 * shared) / total : 0);
};
/** Which removed line goes beside which added one: pairs [d, a] in order, alike enough (half),
 *  as many and as alike as can be (a small dynamic program; a long run is paired as it comes). */
const pairs = (dels, adds) => {
  const n = dels.length;
  const m = adds.length;
  if (n === 0 || m === 0) return [];
  if (n * m > 40_000) return Array.from({ length: Math.min(n, m) }, (_, k) => [k, k]);
  const score = (d, a) => {
    const like = likeness(dels[d].text.trim(), adds[a].text.trim());
    return like >= 0.5 ? like : 0;
  };
  const best = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  for (let d = n - 1; d >= 0; d--)
    for (let a = m - 1; a >= 0; a--) {
      const here = score(d, a);
      best[d][a] = Math.max(best[d + 1][a], best[d][a + 1], here > 0 ? here + best[d + 1][a + 1] : 0);
    }
  const out = [];
  for (let d = 0, a = 0; d < n && a < m; ) {
    const here = score(d, a);
    if (here > 0 && best[d][a] === here + best[d + 1][a + 1]) out.push([d++, a++]);
    else if (best[d][a] === best[d + 1][a]) d++;
    else a++;
  }
  return out;
};
/** One side's text, the part that differs from the other side marked. */
/** Where one side differs from the other: [start, end) of `mine`, or null. */
const differing = (mine, theirs) => {
  if (theirs === undefined) return null;
  let start = 0;
  while (start < mine.length && start < theirs.length && mine[start] === theirs[start]) start++;
  let end = 0;
  while (end < mine.length - start && end < theirs.length - start && mine[mine.length - 1 - end] === theirs[theirs.length - 1 - end]) end++;
  return start < mine.length - end ? [start, mine.length - end] : null;
};
const marked = (mine, theirs) => {
  const range = differing(mine, theirs);
  return range ? [mine.slice(0, range[0]), el("mark", {}, mine.slice(range[0], range[1])), mine.slice(range[1])] : [mine];
};
const sideBySide = (text, tokens) => el("div", { class: "sbs", "data-diff": "" }, sides(text).map((row) => {
  if (row.kind !== "change" && row.kind !== "same") return el("div", { class: `sbs-${row.kind}` }, row.text);
  const code = (side, other) => {
    const pair = row.kind === "change" && row.like;
    if (hasColour(tokens, side.at)) return DesolateHighlight.paint(tokens[side.at], unhidden, pair ? differing(unhidden(side.text), other && unhidden(other.text)) : null);
    return pair ? marked(unhidden(side.text), other && unhidden(other.text)) : unhidden(side.text) || " ";
  };
  const cell = (side, other, cls) => side
    ? [el("span", { class: `no ${cls}` }, String(side.no)), el("span", { class: `code ${cls}` }, code(side, other))]
    : [el("span", { class: "no empty" }, ""), el("span", { class: "code empty" }, "")];
  return el("div", { class: "sbs-row" }, cell(row.left, row.right, row.kind === "change" ? "del" : ""), cell(row.right, row.left, row.kind === "change" ? "add" : ""));
}));
// The diff's element, kept across redraws: the dashboard redraws on every change of state (a
// workspace's status, an action's progress), and a long diff drawn again each time cost up to
// half a second, and threw away where the person had scrolled to. Drawn again only when the
// diff, the layout, or how much of it is shown changes. At first at most DIFF_LINES of it.
const DIFF_LINES = 3000;
let shownDiff = null; // { diff, layout, all, tokens, node }
const diffElement = (diff) => {
  const all = Boolean(diff.all);
  if (shownDiff && shownDiff.diff === diff && shownDiff.layout === layout && shownDiff.all === all && shownDiff.tokens === diff.tokens) return shownDiff.node;
  const lines = diff.text.split("\n");
  const cut = !all && lines.length > DIFF_LINES;
  const text = cut ? lines.slice(0, DIFF_LINES).join("\n") : diff.text;
  const node = el("div", { class: "diff-box" },
    layout === "sides" ? sideBySide(text, diff.tokens) : diffView(text, diff.tokens),
    cut ? el("div", { class: "sub" }, `The first ${DIFF_LINES.toLocaleString()} of ${lines.length.toLocaleString()} lines. `,
      el("button", { class: "quiet small", onclick: () => { diff.all = true; render(); } }, "Show the rest")) : null);
  shownDiff = { diff, layout, all, tokens: diff.tokens, node };
  return node;
};
let layout = (() => {
  try {
    return localStorage.getItem("desolate-diff-layout") === "unified" ? "unified" : "sides";
  } catch {
    return "sides";
  }
})();
const setLayout = (value) => {
  layout = value;
  try {
    localStorage.setItem("desolate-diff-layout", value);
  } catch {
    /* a page without storage keeps it for now */
  }
  render();
};

const query = (target, against) => `domain=${encodeURIComponent(target.domain)}&repo=${encodeURIComponent(target.repo)}&branch=${encodeURIComponent(target.branch)}&against=${encodeURIComponent(against)}`;
const loadDiff = async () => {
  const { offer, against } = reviewing;
  reviewing.diff = { loading: true };
  render();
  try {
    const response = await fetch(`/diff?${query(offer, against)}${reviewing.whitespace === "ignore" ? "&whitespace=ignore" : ""}`);
    reviewing.diff = await response.json();
  } catch (error) {
    reviewing.diff = { error: String(error) };
  }
  render();
  // Then its colours, when the worker has them (or never: the diff stays plain).
  const diff = reviewing && reviewing.diff;
  if (diff && typeof diff.text === "string" && typeof DesolateHighlight !== "undefined")
    DesolateHighlight.tokensFor(diff.text).then((tokens) => {
      if (reviewing && reviewing.diff === diff && tokens.some(Boolean)) {
        diff.tokens = tokens;
        render();
      }
    });
};

/** Review any branch a domain has (offered or not), against the remote's default branch
 *  ("origin") or the domain's own copy of it ("domain"). The target names only a domain, a
 *  repository and a branch: what is shown is read in the root. */
const openReview = async (offer, against = "origin") => {
  const fetchedAt = ((state && state.repos.find((r) => r.repo === offer.repo)) || {}).fetchedAt || null;
  reviewing = { offer, against, fetchedAt, loading: true };
  render();
  try {
    const response = await fetch(`/review?${query(offer, against)}`);
    reviewing = { offer, against, fetchedAt, review: await response.json() };
  } catch (error) {
    reviewing = { offer, against, fetchedAt, review: { error: String(error) } };
  }
  render();
  if (reviewing && reviewing.review && !reviewing.review.error) loadDiff();
};

// ------------------------------------------------------------------ issues
// A GitHub issue a workspace offered (shared/issues.ts): read and edited here, then published
// as you, once you approve it on the Mac. Its text is an agent's: the editor's fields are
// form fields, and the preview is built as elements (shared/ui/markdown.js), never as HTML.
let editing = null; // { id, element, parts }
const dismissOffer = async (o) => {
  const response = await fetch("/offer", { method: "POST", headers: { "content-type": "application/json", "x-desolate-ui": "1" }, body: JSON.stringify({ domain: o.domain, repo: o.repo, branch: o.branch, do: "dismiss" }) });
  if (!response.ok) alert(`Not dismissed: ${(await response.json().catch(() => ({}))).error || `HTTP ${response.status}`}`);
};
const issueCall = async (id, what, fields) => {
  const response = await fetch("/issue", { method: "POST", headers: { "content-type": "application/json", "x-desolate-ui": "1" }, body: JSON.stringify({ id, do: what, ...fields }) });
  const answer = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(answer.error || `HTTP ${response.status}`);
  return answer;
};
const labelsOf = (value) => value.split(",").map((label) => label.trim()).filter(Boolean);
/** Built once when it opens, so what you type is never redrawn away; `syncIssue` keeps its
 *  status in step with the state. */
const openIssue = (issue) => {
  const title = el("input", { name: "title", value: issue.title, maxlength: "256", "aria-label": "title", class: "wide" });
  const labels = el("input", { name: "labels", value: issue.labels.join(", "), "aria-label": "labels, separated by commas", class: "wide", placeholder: "labels, separated by commas" });
  const body = el("textarea", { name: "body", rows: "16", "aria-label": "body (Markdown)", class: "wide mono" });
  body.value = issue.body;
  const preview = el("div", { class: "markdown", "data-preview": "", hidden: true });
  const status = el("div", { class: "sub", "data-issue-status": "" });
  let previewing = false;
  const toggle = el("button", { class: "quiet small", type: "button", "data-preview-toggle": "", onclick: () => {
    previewing = !previewing;
    toggle.textContent = previewing ? "Write" : "Preview";
    if (previewing) preview.replaceChildren(typeof DesolateMarkdown !== "undefined" ? DesolateMarkdown.render(body.value) : document.createTextNode(body.value));
    preview.hidden = !previewing;
    body.hidden = previewing;
  } }, "Preview");
  const fields = () => ({ title: title.value, body: body.value, labels: labelsOf(labels.value) });
  const doing = (what, label) => el("button", { type: "button", "data-issue-do": what, class: what === "publish" ? "" : "quiet", onclick: async () => {
    try {
      const answer = await issueCall(issue.id, what, what === "save" || what === "publish" ? fields() : {});
      if (what === "reject") editing = null;
      status.textContent = what === "save" ? "saved" : what === "publish" ? "waiting for your approval on the Mac" : answer.state || "";
    } catch (error) {
      status.textContent = `not done: ${error.message}`;
    }
    render();
  } }, label);
  const element = el("div", { class: "card", "data-issue": issue.id },
    el("div", { class: "top" }, el("h3", {}, `An issue for ${issue.repo}`), el("span", { class: "grow" }), el("button", { class: "quiet", type: "button", onclick: () => { editing = null; render(); } }, "Close")),
    el("div", { class: "sub" }, `Offered by ${issue.domain}/${issue.workspace}. It is created on GitHub as you, with what is here once you publish it, and only after you approve it on the Mac.`),
    el("label", { class: "field" }, "Title", title),
    el("label", { class: "field" }, "Labels", labels),
    el("div", { class: "field" }, el("span", {}, "Body (Markdown) "), toggle),
    body, preview, status,
    el("div", { class: "buttons", "data-issue-buttons": "" }, doing("save", "Save"), doing("publish", "Publish..."), doing("draft", "Back to draft"), doing("reject", "Reject")));
  editing = { id: issue.id, element, parts: { title, labels, body, status } };
  render();
};
const syncIssue = () => {
  if (!editing) return null;
  const issue = (state.issues || []).find((i) => i.id === editing.id);
  if (!issue) return (editing = null);
  const frozen = issue.state !== "offered";
  for (const field of [editing.parts.title, editing.parts.labels, editing.parts.body]) field.disabled = frozen;
  for (const button of editing.element.querySelectorAll("[data-issue-do]")) {
    const what = button.dataset.issueDo;
    button.hidden = issue.state === "offered" ? what === "draft" : issue.state === "approving" ? what !== "draft" && what !== "reject" : true;
  }
  const said = {
    offered: issue.problem ? `Not published: ${issue.problem}` : "",
    approving: `Waiting for your approval on the Mac: the approval page (desolate approve --web), or desolate issue publish ${issue.id} in a terminal there.`,
    published: "", rejected: "Rejected: it will not be published.",
  }[issue.state];
  if (issue.state === "published") editing.parts.status.replaceChildren("Published: ", issue.url && /^https:\/\/github\.com\//.test(issue.url) ? el("a", { href: issue.url, target: "_blank", rel: "noopener noreferrer" }, issue.url) : "on GitHub");
  else if (said) editing.parts.status.textContent = said;
  return editing.element;
};

const needsYou = () => {
  const items = [];
  for (const i of state.issues || []) {
    if (i.state !== "offered" && i.state !== "approving") continue;
    items.push(el("li", { "data-issue-offer": i.id }, el("span", { class: `dot ${i.state === "approving" ? "orange" : "blue"}` }), el("div", { class: "what" },
      el("div", { class: "name" }, i.state === "approving" ? `An issue waits for your approval on the Mac: ${i.repo}` : `An issue offered for ${i.repo}`),
      el("div", { class: "line" }, i.title),
      el("div", { class: "line sub" }, `from ${i.domain}/${i.workspace}${i.labels.length ? `, labelled ${i.labels.join(", ")}` : ""}${i.problem ? `. Not published: ${i.problem}` : ""}`)),
      el("div", { class: "buttons" }, el("button", { class: "quiet", onclick: () => openIssue(i) }, i.state === "approving" ? "Open" : "Read and edit"))));
  }
  for (const a of state.approvals) items.push(el("li", {}, el("span", { class: "dot orange" }), el("div", { class: "what" },
    el("div", { class: "name" }, `A push is waiting for your approval: ${a.repo} ${a.branch}`),
    el("div", { class: "line mono" }, `${a.commit}`),
    el("div", { class: "line" }, "Approve it on the host, outside every VM: run ", el("code", {}, "desolate approve"), " in a terminal there.")), el("div", {})));
  for (const r of state.refused || []) items.push(el("li", { "data-refused": `${r.domain}/${r.repo}` }, el("span", { class: "dot red" }), el("div", { class: "what" },
    el("div", { class: "name" }, `Refused from ${r.domain}: a bundle of ${r.repo}`),
    el("div", { class: "line mono" }, r.why),
    el("div", { class: "line" }, `Nothing new from ${r.domain} is taken while one of its branches holds what git refused. Delete that branch in the workspace, then run `, el("code", {}, "desolate sync"), " there.")), el("div", {})));
  for (const o of state.offers) {
    const key = `push:${o.domain}:${o.repo}:${o.branch}`;
    items.push(el("li", { "data-offer": `${o.domain}/${o.repo}/${o.branch}` }, el("span", { class: "dot blue" }), el("div", { class: "what" },
      el("div", { class: "name" }, `Offered: ${o.repo} ${o.branch}`),
      el("div", { class: "line" }, `from ${o.domain}/${o.workspace}, at `, el("span", { class: "mono" }, short(o.commit)), o.lfs ? `, with ${o.lfs} LFS object(s)` : "")),
      el("div", { class: "buttons" }, el("button", { class: "quiet", onclick: () => openReview(o) }, "Review"), gitLink(o.repo),
        // Not this one: off "Needs you". The branch stays, and offering it again brings it back.
        el("button", { class: "quiet", title: "Take it off this list. The branch stays in the domain; offering it again brings it back.", onclick: () => dismissOffer(o) }, "Dismiss"))));
  }
  for (const d of state.domains) for (const w of d.workspaces) {
    const says = w.says.status;
    if (says && (says.color === "orange" || says.color === "red"))
      items.push(el("li", {}, el("span", { class: `dot ${says.color}` }), el("div", { class: "what" }, el("div", { class: "name" }, `${d.slug}/${w.workspace}`), el("div", { class: "line" }, says.message)), el("div", {})));
    if (w.outlived)
      items.push(el("li", { "data-outlived": `${d.slug}/${w.workspace}` }, el("span", { class: "dot orange" }), el("div", { class: "what" }, el("div", { class: "name" }, `${d.slug}/${w.workspace} outlived the workspace that started it`), el("div", { class: "line" }, `${w.startedBy} is gone; this one is still here. Look at its branches, then `, el("code", {}, `desolate rm ${d.slug}/${w.workspace}`), " when you are done with it.")), el("div", {})));
    if (w.host && w.host.devcontainer && /^FAILED/.test(w.host.devcontainer))
      items.push(el("li", {}, el("span", { class: "dot red" }), el("div", { class: "what" }, el("div", { class: "name" }, `${d.slug}/${w.workspace}: its devcontainer did not come up`), el("div", { class: "line" }, w.host.devcontainer)), el("div", {})));
  }
  return items;
};

/** git's shortstat ("2 files changed, 10 insertions(+), 3 deletions(-)"), as numbers in
 *  colour: what a branch changes, readable at a glance. */
const statView = (stat) => {
  if (!stat) return [pill("no file changes", "", "the branch changes no file against what it is compared with")];
  const files = /(\d+) files? changed/.exec(stat);
  const adds = /(\d+) insertions?\(\+\)/.exec(stat);
  const dels = /(\d+) deletions?\(-\)/.exec(stat);
  return [
    el("span", {}, el("span", { class: "num" }, files ? files[1] : "0"), files && files[1] === "1" ? " file" : " files"),
    el("span", { class: "num-add", title: "lines added" }, `+${adds ? adds[1] : 0}`),
    el("span", { class: "num-del", title: "lines removed" }, `−${dels ? dels[1] : 0}`),
  ];
};

const reviewPanel = () => {
  if (!reviewing) return null;
  const { offer, review, loading } = reviewing;
  const close = el("button", { class: "quiet", onclick: () => { reviewing = null; render(); } }, "Close");
  const header = (...title) => el("div", { class: "review-head" }, el("div", { class: "title-row" }, el("div", { class: "title" }, ...title), close));
  if (loading) return el("div", { class: "card" }, header(el("h3", {}, `Reviewing ${offer.repo} ${offer.branch}`)), el("div", { class: "sub" }, "reading what a push would send..."));
  if (review.error) return el("div", { class: "card" }, header(el("h3", {}, `${offer.repo} ${offer.branch}`)), el("div", { class: "warn" }, review.error));
  const key = `push:${offer.domain}:${offer.repo}:${offer.branch}`;
  // Pushing from here is for what the agent offered, at the commit reviewed: an offer is how
  // its new LFS objects reach the root. Anything else is pushed from the git terminal.
  const offered = state.offers.some((o) => o.domain === offer.domain && o.repo === review.repo && o.branch === review.branch && o.commit === review.commit);
  const other = reviewing.against === "domain" ? "origin" : "domain";
  const repo = state.repos.find((r) => r.repo === review.repo) || {};
  const def = review.defaultBranch || "default branch";
  // Against the remote (origin): what a push would send, and for a workspace on the default
  // branch, what it changes beyond the remote's (dogfooding: "compare with the domain's main"
  // compared main with itself). The remote as last fetched, and a way to fetch it now.
  const against = reviewing.against === "domain"
    ? [pill(`against ${offer.domain}'s ${def}`, "accent", "the domain's own copy of the default branch: what its workspaces built on, which may be ahead of the remote")]
    : [pill(`against the remote's ${def}`, "accent", `origin/${def}: the remote's ${def}, as the root last fetched it`), el("span", { class: "sub" }, repo.fetchedAt ? `fetched ${ago(repo.fetchedAt)}` : ""),
      el("button", { class: "quiet small", disabled: busy.has(`fetch:${review.repo}`), "data-fetch": review.repo, title: `desolate fetch ${review.repo}: the remote's branches as they are now; the review follows`, onclick: () => act(`fetch:${review.repo}`, "repo.fetch", { repo: review.repo }) }, busy.has(`fetch:${review.repo}`) ? "Fetching..." : "Fetch now")];
  return el("div", { class: "card", id: "review-card" },
    header(el("h3", {}, review.repo), pill(review.branch, "mono", "the branch reviewed"), el("span", { class: "mono sub", title: "the commit reviewed: Push sends exactly this" }, short(review.commit))),
    el("div", { class: "toolbar" }, ...against,
      // The domain's own default branch, against itself, shows nothing: offered only for
      // another branch.
      review.isDefault && reviewing.against === "origin" ? null
        : el("button", { class: "quiet small", "data-against": other, onclick: () => openReview(offer, other) }, other === "domain" ? `Compare with ${offer.domain}'s ${def}` : `Compare with the remote's ${def}`)),
    el("div", { class: "stat" },
      pill(`${review.commits.length} commit${review.commits.length === 1 ? "" : "s"}`, review.commits.length ? "blue" : "", reviewing.against === "domain" ? "beyond the domain's default branch" : "what a push would send"),
      ...statView(review.stat),
      review.lfsObjects ? pill(`${review.lfsObjects} LFS object(s)`, "accent", "large files a push would send with it") : null,
      reviewing.against === "domain" ? el("span", { class: "sub" }, `(a push would send ${review.pushCommits}, counted against the remote)`) : null),
    review.warnings.length ? el("div", { class: "warnbox" }, review.warnings.map((w) => el("div", {}, pill("warning", "orange"), ` a push of this branch ${w}`))) : null,
    el("pre", { class: "mono" }, review.commits.slice(0, 40).map((c) => `${short(c.commit)}  ${c.subject}`).join("\n")),
    el("pre", { class: "mono" }, review.files.slice(0, 80).join("\n")),
    reviewing.diff && reviewing.diff.loading ? el("div", { class: "sub" }, "reading the diff...") : null,
    reviewing.diff && reviewing.diff.error ? el("div", { class: "warn" }, reviewing.diff.error) : null,
    // The diff is shown only if it is of the commit the Push button names.
    reviewing.diff && reviewing.diff.text !== undefined && reviewing.diff.commit === review.commit ? [
      el("div", { class: "toolbar" },
        el("button", { class: "quiet small", "data-whitespace": "", onclick: () => { reviewing.whitespace = reviewing.whitespace === "ignore" ? "show" : "ignore"; loadDiff(); } }, reviewing.whitespace === "ignore" ? "Show whitespace changes" : "Ignore whitespace changes"),
        el("button", { class: "quiet small", "data-layout": "", onclick: () => setLayout(layout === "sides" ? "unified" : "sides") }, layout === "sides" ? "Unified" : "Side by side")),
      diffElement(reviewing.diff),
      reviewing.diff.truncated ? el("div", { class: "warn" }, "The diff is longer than is shown here. Read the rest with git, in `desolate root shell`, before you push.") : null] : null,
    reviewing.diff && reviewing.diff.commit && reviewing.diff.commit !== review.commit ? el("div", { class: "warn" }, "The branch moved while you were reading. Close this and review it again.") : null,
    el("div", { class: "sub" }, "To see whole files, open the branch in a workspace's editor. The diff here is the one to trust: it is made in the root, by git alone."),
    el("div", { class: "buttons" }, !review.pushable ? el("span", { class: "sub" }, "Not pushable: cloned --no-push, so there is no write key for it.")
      : reviewing.against === "domain" ? el("span", { class: "sub" }, `A push would send ${review.pushCommits} commit(s), counted against origin: compare with origin to push.`)
      : !offered ? el("span", { class: "sub" }, "Not offered at this commit, so not pushed from here. Push it yourself from ", gitLink(review.repo) || "the git terminal", ` (git fetch root, then git push origin root/${offer.domain}/${review.branch}:${review.branch}), or have the agent run `, el("code", {}, "desolate offer"), ".")
      : review.isDefault ? el("span", { class: "sub" }, "This is the default branch. Push it from the host: ", el("code", {}, `desolate push ${offer.domain} ${review.repo} ${review.branch} --expect ${review.commit} --allow-default`))
      : button(`Push exactly ${short(review.commit)}`, key, "offer.push", { domain: offer.domain, repo: review.repo, branch: review.branch, commit: review.commit })),
    el("div", { class: "sub" }, "Pushing waits for your approval on the host: on the approval page (", el("code", {}, "desolate approve --web --open"), "), or ", el("code", {}, "desolate approve"), " in a terminal."));
};

/** A checkout as it is NOW (its HEAD, which the host watches), not as it started: the
 *  repository, the branch it is on, its commit, and whether that is on the remote. */
const checkoutLine = (d, w, c) => {
  const head = c.head;
  const pushed = (w.pushed || []).find((p) => p.repo === c.repo);
  const where = !head
    ? [pill(c.branch, "mono", "the branch it started on: its HEAD has not been read yet"), el("span", { class: "sub" }, "(as started)")]
    : !head.branch
      ? [pill(head.commit ? `detached at ${short(head.commit)}` : "on a branch desolate does not carry", "orange", "not on a branch: commits here reach the root only from a branch")]
      : [pill(head.branch, "mono", `the branch checked out now`), head.commit ? el("span", { class: "mono" }, short(head.commit)) : null];
  const remote = !pushed ? null
    : pushed.count === 0 ? pill("on the remote", "green", "every commit here is on a branch of the remote (origin)")
      : pushed.count > 0 ? pill(`${pushed.count} not on the remote`, "orange", `${pushed.why}: review and push it, or offer it`)
        : pill("not counted", "gray", pushed.why || "its commits could not be counted against the remote");
  return [pill(c.repo, "repo mono", "the repository"), ...where, remote];
};

/** The base a checkout's branch is merged into, when the root saw its pushed commit land
 *  there (pushed.ts) and the checkout is still at that commit; else null. */
const landedOf = (d, c) => {
  if (!c.head || !c.head.branch || !c.head.commit) return null;
  const b = (d.branches || []).find((b) => b.repo === c.repo && b.branch === c.head.branch && b.commit === c.head.commit);
  return b && b.landed ? b.landed : null;
};
/** A workspace whose work is all in: some checkout's branch is merged, and every other is
 *  merged too or on its repository's default branch. */
const allLanded = (d, w) => {
  const defaultOf = (repo) => (state.repos.find((r) => r.repo === repo) || {}).defaultBranch;
  return w.checkouts.some((c) => landedOf(d, c)) && w.checkouts.every((c) => landedOf(d, c) || (c.head && c.head.branch && c.head.branch === defaultOf(c.repo)));
};

/** Whether the dashboard may delete a workspace, and if not, every reason: nothing in it that
 *  a remove would lose (the host looked, in its VM: while it runs, and as it stopped), and
 *  every commit on the remote (the root counted). The host checks again when it runs. */
const deletable = (w, running) => {
  const why = [];
  const looked = w.host && w.host.looked;
  if (!w.host) why.push("the host has not said what it holds yet");
  else if (!looked || (!running && !looked.atStop))
    why.push(running ? "desolate has not looked at what it holds yet (it does within half a minute)" : "it stopped before desolate looked at what it holds: start it and stop it again, and Delete can tell");
  else why.push(...looked.lost);
  if (!w.pushed) why.push("its commits have not been counted against the remote yet");
  else for (const c of w.pushed) if (c.why) why.push(`${c.repo}: ${c.why}`);
  return why;
};

/** A workspace's state in a word, and its colour: what the dashboard is doing to it first. */
const statusOf = (w, host, running) => {
  if (!state.hostConnected) return [`${w.state} (as last known)`, "gray", "the host is not connected: this is what it last said"];
  if (w.doing) return [w.doing, "blue pulse", "the dashboard's action is at it; the step it is at is below"];
  if (w.state === "planned" && !running) return ["not made yet", "gray", "planned, but its VM was never made: Start makes it"];
  if (running) return ["running", "green", "its VM is running"];
  if (host.status === "stopped") return ["stopped", "gray", "its VM is stopped: its files are kept, and Start brings it back"];
  return [host.status || w.state, host.status ? "red" : "gray", "what its VM says it is"];
};

// ---- a workspace's size: what it has, what its project asks for, and Resize (stopped only)
/** "16 GiB memory, 4 CPUs": the parts a size sets. */
const sizeParts = (s) => [
  s.cpus !== undefined ? `${s.cpus} CPU${s.cpus === 1 ? "" : "s"}` : null,
  s.memoryMiB !== undefined ? `${s.memoryMiB % 1024 === 0 ? s.memoryMiB / 1024 : (s.memoryMiB / 1024).toFixed(1)} GiB memory` : null,
  s.diskGiB !== undefined ? `${s.diskGiB} GiB disk` : null,
].filter(Boolean).join(", ");
/** The parts the project asks for that this workspace does not have. */
const askedMore = (w) => {
  const ask = (w.asks && w.asks.size) || {};
  const now = w.size || {};
  const more = {};
  for (const key of ["cpus", "memoryMiB", "diskGiB"]) if (ask[key] !== undefined && ask[key] !== now[key]) more[key] = ask[key];
  return more;
};
// The open Resize forms, by "<domain>/<workspace>": kept across renders, as typed.
const resizing = new Map();
const openResize = (d, w) => {
  const key = `${d.slug}/${w.workspace}`;
  const now = w.size || { cpus: 2, memoryMiB: 4096, diskGiB: 30 };
  const ask = (w.asks && w.asks.size) || {};
  const number = (name, value, min, max, label) => el("label", { class: "field" }, label,
    el("input", { type: "number", name, value: String(value), min: String(min), max: String(max), step: "1", required: true, "aria-label": label }));
  const cpus = number("cpus", now.cpus, 1, 64, "CPUs");
  const memory = number("memory", Math.round(now.memoryMiB / 1024), 1, 256, "Memory (GiB)");
  const disk = number("disk", now.diskGiB, now.diskGiB, 2048, `Disk (GiB, ${now.diskGiB} or more: a disk only grows)`);
  const input = (label) => label.querySelector("input");
  const useAsked = Object.keys(askedMore(w)).length
    ? el("button", { class: "quiet small", type: "button", "data-resize-asked": "", onclick: () => {
        if (ask.cpus !== undefined) input(cpus).value = String(ask.cpus);
        if (ask.memoryMiB !== undefined) input(memory).value = String(Math.ceil(ask.memoryMiB / 1024));
        if (ask.diskGiB !== undefined) input(disk).value = String(Math.max(ask.diskGiB, now.diskGiB));
      } }, `Use what the project asks (${sizeParts(ask)})`)
    : null;
  const element = el("form", { class: "resize", "data-resize-form": key, onsubmit: (event) => {
    event.preventDefault();
    act(`ws:${key}`, "workspace.resize", { domain: d.slug, workspace: w.workspace, cpus: String(Number(input(cpus).value)), memory: `${Number(input(memory).value) * 1024}m`, disk: `${Number(input(disk).value)}g` });
    resizing.delete(key);
    render();
  } },
    cpus, memory, disk,
    el("div", { class: "buttons" }, useAsked,
      el("button", { type: "submit" }, "Resize"),
      el("button", { class: "quiet", type: "button", onclick: () => { resizing.delete(key); render(); } }, "Cancel")),
    el("div", { class: "sub" }, "It takes effect when the workspace starts again. Its files, containers and volumes stay."));
  resizing.set(key, element);
  render();
};
/** The size line: what it has, what its project asks for (if that differs), and Resize. */
const sizeLine = (d, w, running, making) => {
  const key = `${d.slug}/${w.workspace}`;
  if (running && resizing.has(key)) resizing.delete(key);
  const more = askedMore(w);
  const asks = w.asks;
  const askTitle = asks ? `${asks.repo}'s ${asks.path} asks for ${sizeParts(asks.size) || "nothing"}${asks.problems.length ? `; not used: ${asks.problems.join("; ")}` : ""}` : "";
  return [
    el("div", { class: "line", "data-size": key },
      w.size ? sizeParts(w.size) : "size: the defaults of its day",
      Object.keys(more).length ? [" ", pill(`project asks ${sizeParts(more)}`, "orange", askTitle, { "data-size-asked": sizeParts(more) })] : asks && asks.problems.length ? [" ", pill("project's size not read", "orange", askTitle)] : null,
      making ? null : [" ", el("span", { class: "tip", title: running ? `Stop ${key} first: a VM's size changes only while it is stopped.` : `Change ${key}'s CPUs, memory or disk. It takes effect when it starts again.` },
        el("button", { class: "quiet small", type: "button", disabled: running || busy.has(`ws:${key}`) || resizing.has(key), "data-resize": key, onclick: () => openResize(d, w) }, "Resize..."))]),
    resizing.get(key) || null,
  ];
};

const workspaceRow = (d, w) => {
  const host = w.host || {};
  const running = host.status === "running";
  // Being made, started, stopped or deleted by an action of the dashboard's: said so, with
  // the step it is at, and no buttons until it is done (they were offered meanwhile, and
  // read as "it has not started"; dogfooding, 2026-11-17).
  const making = typeof w.making === "string";
  const says = w.says.status;
  const key = `ws:${d.slug}/${w.workspace}`;
  const target = { domain: d.slug, workspace: w.workspace };
  const [word, colour, explain] = statusOf(w, host, running);
  const why = deletable(w, running);
  const remove = el("span", { class: "tip", title: why.length ? `Not deletable yet: ${why.join("; ")}.` : `Delete ${d.slug}/${w.workspace}: its VM goes, nothing in it is unsaved, and every commit is on the remote. Its branches stay in the domain.` },
    el("button", { class: "quiet danger", disabled: why.length > 0 || busy.has(`rm:${d.slug}/${w.workspace}`), "data-delete": `${d.slug}/${w.workspace}`,
      onclick: () => { if (confirm(`Delete ${d.slug}/${w.workspace}? Its VM is removed. Nothing in it is unsaved, and its commits are on the remote; its branches stay in the domain.`)) act(`rm:${d.slug}/${w.workspace}`, "workspace.remove", target); } }, "Delete"));
  return el("li", { "data-workspace": `${d.slug}/${w.workspace}` },
    el("span", { class: `dot ${making ? "blue" : running ? (says ? says.color : "gray") : "hollow"}`, title: making ? w.doing || "busy" : says ? says.color : running ? "no status set" : "stopped" }),
    el("div", { class: "what" },
      el("div", { class: "name" }, w.workspace, pill(word, colour, explain, { "data-making": making ? "" : null }),
        // Who started it: you, or a workspace of the domain (desolate spawn in it); and a
        // warning when that one is gone and this one is still here.
        w.startedBy
          ? pill(w.outlived ? `started by ${w.startedBy}, since removed` : `started by ${w.startedBy}`, w.outlived ? "orange" : "", w.outlived ? `${w.startedBy} was removed; this one is still here` : `${w.startedBy} asked for it (desolate spawn)`, { "data-started-by": w.startedBy })
          : pill("started by you", "", "you started it: from here, or desolate up", { "data-started-by": "" })),
      making && w.making ? el("div", { class: "line sub", "data-making-step": "" }, redact(w.making)) : null,
      w.checkouts.map((c) => el("div", { class: "checkout", "data-checkout": c.repo }, checkoutLine(d, w, c),
        landedOf(d, c) ? pill(`merged into ${landedOf(d, c)}`, "green", "its branch, at this commit, is merged on the remote", { "data-merged": landedOf(d, c) }) : null,
        c.head && c.head.branch && (d.branches || []).some((b) => b.repo === c.repo && b.branch === c.head.branch)
          ? el("button", { class: "quiet small", "data-diff-checkout": c.repo, title: `What ${c.head.branch} changes against the remote's ${(state.repos.find((r) => r.repo === c.repo) || {}).defaultBranch || "default branch"}`, onclick: () => openReview({ domain: d.slug, repo: c.repo, branch: c.head.branch }) }, "Diff") : null)),
      says ? el("div", { class: "line", "data-says": "" }, pill(says.color, says.color === "gray" ? "" : says.color, "what the workspace said about itself (desolate status set)"), " ", says.message) : null,
      allLanded(d, w) ? el("div", { class: "line sub", "data-done": "" }, "Its work is merged. ", running ? "Stop frees its memory; " : "", "Delete removes it.") : null,
      host.devcontainer ? el("div", { class: "line" }, pill(/^FAILED/.test(host.devcontainer) ? "devcontainer failed" : "devcontainer", /^FAILED/.test(host.devcontainer) ? "red" : "", "the project's devcontainer, in its VM"), " ", host.devcontainer.replace(/^up \(/, "(")) : null,
      sizeLine(d, w, running, making),
      (host.ports || []).length ? el("div", { class: "line" }, "dev servers: ", host.ports.map((p, i) => [i ? " " : "", el("a", { href: p.url, target: "_blank", rel: "noopener", class: "pill accent", title: `its server on port ${p.port}, at its own name` }, `:${p.port}`)])) : null,
      // A port this Mac holds (another user's program, often, on a shared Mac): the
      // workspace's server on it is not forwarded, and its address reaches that program.
      ...(host.heldOnMac || []).map((h) => el("div", { class: "line warn", "data-held-on-mac": String(h.port) }, `not forwarded: :${h.port}. This Mac's port ${h.port} is held (${h.by}), so the workspace's address on it reaches that program, not this workspace. Run it on another port.`))),
    el("div", { class: "buttons" }, making ? null : [
      running && host.editor ? el("a", { class: "button", href: host.editor, target: "_blank", rel: "noopener", "data-editor": "" }, "Open editor") : null,
      running ? button("Stop", key, "workspace.stop", target, true) : button("Start", key, "workspace.start", target),
      remove]));
};

/** Every branch a domain has (its own list), offered or not: each one reviewable. */
const branchList = (d) => {
  const list = d.branches || [];
  if (!list.length) return null;
  const offered = (b) => state.offers.some((o) => o.domain === d.slug && o.repo === b.repo && o.branch === b.branch && o.commit === b.commit);
  const where = (b) => d.workspaces.filter((w) => w.checkouts.some((c) => c.repo === b.repo && c.head && c.head.branch === b.branch)).map((w) => w.workspace);
  const open = branchesOpen.has(d.slug);
  return el("details", { class: "branches", open, "data-branches": d.slug },
    el("summary", { onclick: (event) => { event.preventDefault(); if (open) branchesOpen.delete(d.slug); else branchesOpen.add(d.slug); render(); } }, `Branches (${list.length})`),
    el("ul", { class: "rows" }, list.map((b) => el("li", { "data-branch": `${b.repo}/${b.branch}` },
      el("span", { class: `dot ${offered(b) ? "blue" : "hollow"}`, title: offered(b) ? "offered" : "not offered" }),
      el("div", { class: "what" },
        el("div", { class: "name" }, pill(b.branch, "mono", "the branch"), pill(b.repo, "repo mono", "the repository"),
          offered(b) ? pill("offered", "blue", "a workspace offered it for you to review and push") : null,
          b.landed ? pill(`merged into ${b.landed}`, "green", "at this commit, merged on the remote") : null),
        el("div", { class: "line" }, el("span", { class: "mono" }, short(b.commit)), where(b).length ? ` · checked out in ${where(b).join(", ")}` : "")),
      el("div", { class: "buttons" }, el("button", { class: "quiet", onclick: () => openReview({ domain: d.slug, repo: b.repo, branch: b.branch }) }, "Review"), gitLink(b.repo))))));
};
const branchesOpen = new Set();

/** The workspace a domain starts with: each repository on its default branch (its main
 *  checkout), named after those branches. Repositories whose default branches differ (main
 *  and master) give a name of both, and the card says so. */
const defaultsOf = (d) => d.repos.map((repo) => ({ repo, branch: (state.repos.find((r) => r.repo === repo) || {}).defaultBranch || "main" }));
const defaultWorkspaceName = (branches) => {
  const name = [...new Set(branches)].join("-").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "main";
  return name === "template" ? "template-ws" : name;
};
const firstWorkspace = (d) => {
  const defaults = defaultsOf(d);
  const branches = [...new Set(defaults.map((x) => x.branch))];
  const name = defaultWorkspaceName(defaults.map((x) => x.branch));
  const key = `up:${d.slug}`;
  return el("div", { class: "empty-ws", "data-first-workspace": d.slug },
    el("div", {}, el("b", {}, "No workspaces yet."), " Start with the default branch: the domain's own checkout of each repository, where its work lands."),
    branches.length > 1 ? el("div", { class: "line warn" }, "Its repositories' default branches differ: ", defaults.map((x, i) => [i ? ", " : "", el("span", { class: "mono" }, x.repo), " on ", el("span", { class: "mono" }, x.branch)]), `. The workspace, named ${name}, has each on its own.`) : null,
    el("button", { disabled: busy.has(key), "data-default-workspace": name, title: `desolate up ${d.slug} --name ${name}: a workspace with ${branches.length > 1 ? "each repository on its default branch" : `${branches[0]} checked out`}, named ${name}`, onclick: () => act(key, "workspace.up", { domain: d.slug, workspace: name }) },
      busy.has(key) ? "Starting..." : `Workspace on ${branches.join(" + ")}`));
};

/** The domain `desolate clone` made a repository (owner--repo), for that repository alone. */
const homeTip = (repo) => `${repo}'s home domain: desolate made it when ${repo} was cloned, for that repository alone. Its workspaces see ${repo} and nothing else, with this domain's own secrets and network rules. To work on ${repo} together with other repositories, make a new domain with them (New domain below): each domain is a trust boundary of its own.`;

const domainCard = (d) => {
  const key = `up:${d.slug}`;
  const foldKey = `domain:${d.slug}`;
  const isFolded = folded.has(foldKey);
  const others = state.repos.filter((r) => !d.repos.includes(r.repo));
  const running = d.workspaces.filter((w) => w.host && w.host.status === "running").length;
  const head = el("div", { class: "top fold-head", title: isFolded ? "Show this domain" : "", onclick: (event) => { if (!event.target.closest("button, a, input, select, label, .pill[title]")) toggleFold(foldKey); } },
    el("button", { class: "fold", type: "button", "aria-expanded": String(!isFolded), "aria-label": isFolded ? "show this domain" : "hide this domain", onclick: () => toggleFold(foldKey) }),
    el("h3", {}, d.title || d.slug), pill(d.slug, "mono", `the domain's name (desolate domain ${d.slug} show)`),
    d.home ? pill("home domain", "accent", homeTip(d.home), { "data-home": d.home }) : null,
    el("span", { class: "grow" }),
    d.building ? pill("building", "blue pulse", "its environment is being built for its first workspace")
      : d.workspaces.length ? pill(`${running} of ${d.workspaces.length} running`, running ? "green" : "", "its workspaces: running, of all") : pill("no workspaces", "", "nothing made in it yet"));
  const repos = el("div", { class: "repos" }, d.repos.length ? d.repos.map((r) => pill(r, "repo mono", d.home === r ? homeTip(r) : "a repository of this domain")) : el("span", { class: "sub" }, "No repositories yet."));
  if (isFolded) return el("div", { class: "card", "data-domain": d.slug, "data-folded": "" }, head, repos);
  const firstOne = !d.building && d.workspaces.length === 0 && d.repos.length > 0;
  return el("div", { class: "card", "data-domain": d.slug },
    head, repos,
    el("div", { class: "meta" },
      d.net === "enforce" ? pill("network: listed hosts only", "green", "its workspaces reach only the hosts on its list (desolate domain net)") : pill("network: open", "yellow", "its workspaces reach any host; its proxy logs where they went (desolate net log)"),
      d.secrets.map((s) => pill(s.name, s.on ? "accent" : "", s.on ? "a secret its workspaces may use by name: the value is put in by the proxy, never in a workspace" : "a secret, switched off", { "data-secret": s.name })),
      // Secrets are set on the Mac's own page (the approval page's origin), never here: this
      // page is served by the root's ordinary user, which never sees a secret's value.
      state.stack && state.stack.approveHostname
        ? el("a", { class: "button quiet small", href: `http://${state.stack.approveHostname}:${state.stack.editorPort}/secrets?domain=${encodeURIComponent(d.slug)}`, target: "_blank", rel: "noopener noreferrer", "data-secrets": d.slug, title: "Add, replace, switch off or remove this domain's secrets, on the Mac's own page: the value never passes through the dashboard" }, d.secrets.length ? "Secrets..." : "Add a secret...") : null),
    el("ul", { class: "rows" },
      // The domain's environment, built once, before its first workspace (host/templates.ts).
      d.building ? el("li", { "data-building": d.slug }, el("span", { class: "dot blue", title: "building" }),
        el("div", { class: "what" }, el("div", { class: "name" }, "Building this domain's environment", pill("being built", "blue pulse", "once, before its first workspace: its workspaces start from it")),
          d.building.line ? el("div", { class: "line sub" }, redact(d.building.line)) : null)) : null,
      d.workspaces.map((w) => workspaceRow(d, w))),
    firstOne ? firstWorkspace(d) : null,
    (state.issues || []).some((i) => i.domain === d.slug && i.state === "published") ? el("div", { class: "line sub", "data-published-issues": "" }, "Issues published lately: ",
      (state.issues || []).filter((i) => i.domain === d.slug && i.state === "published").map((i, n) => [n ? ", " : "", i.url && /^https:\/\/github\.com\//.test(i.url) ? el("a", { href: i.url, target: "_blank", rel: "noopener noreferrer" }, i.title) : i.title])) : null,
    branchList(d),
    d.repos.length ? el("form", { class: "inline", onsubmit: (event) => { event.preventDefault(); const name = event.target.elements.name.value.trim(); act(key, "workspace.up", { domain: d.slug, workspace: name }); event.target.reset(); } },
      el("input", { name: "name", placeholder: "name (optional)", pattern: "[a-z0-9][a-z0-9-]{0,39}", "aria-label": "workspace name" }),
      el("button", { class: firstOne ? "quiet" : "", disabled: busy.has(key), title: "A workspace of its own: a VM with the repositories, each on a branch named after it" }, busy.has(key) ? "Starting..." : "New workspace")) : null,
    // Adding a repository is set apart from making a workspace: it changes the domain.
    d.home ? [el("hr", { class: "split" }), el("div", { class: "inline sub", "data-home-note": "" }, "This is ", el("span", { class: "mono" }, d.home), "'s home domain: it holds that repository alone. ",
      el("button", { class: "quiet small", type: "button", "data-new-domain-with": d.home, onclick: () => openNewDomain([d.home]) }, `New domain with ${d.home}...`), " to work on it with others.")]
      : others.length ? [el("hr", { class: "split" }), el("form", { class: "inline", onsubmit: (event) => { event.preventDefault(); act(`add:${d.slug}`, "domain.add", { domain: d.slug, repo: event.target.elements.repo.value }); } },
        el("select", { name: "repo", "aria-label": "repository to add" }, others.map((r) => el("option", { value: r.repo }, r.repo))), el("button", { class: "quiet", title: "Its workspaces made from now on have it too (running ones do not)" }, "Add repository"))] : null);
};

// ------------------------------------------------------------------ a new domain
// Built once when it opens, so what is typed is never redrawn away.
let newDomain = null; // { element }
const openNewDomain = (repos = []) => {
  const slug = el("input", { name: "slug", required: true, pattern: "[a-z0-9][a-z0-9-]{0,39}", placeholder: "name: lower-case letters, digits, dashes", "aria-label": "the new domain's name", class: "wide" });
  const title = el("input", { name: "title", maxlength: "80", placeholder: "title (optional)", "aria-label": "its title", class: "wide" });
  const boxes = state.repos.map((r) => el("label", { class: "choice" }, el("input", { type: "checkbox", value: r.repo, checked: repos.includes(r.repo) }), el("span", { class: "mono" }, r.repo)));
  const status = el("div", { class: "sub" });
  const element = el("form", { class: "card new-domain", "data-new-domain": "", onsubmit: (event) => {
    event.preventDefault();
    const chosen = boxes.map((b) => b.querySelector("input")).filter((i) => i.checked).map((i) => i.value);
    act(`new:${slug.value}`, "domain.create", { domain: slug.value.trim(), title: title.value.trim(), repos: chosen.join(",") });
    newDomain = null;
    render();
  } },
    el("div", { class: "top" }, el("h3", {}, "New domain"), el("span", { class: "grow" }), el("button", { class: "quiet", type: "button", onclick: () => { newDomain = null; render(); } }, "Cancel")),
    el("div", { class: "sub" }, "A domain is a trust boundary: its workspaces share its repositories, its secrets and its network rules, and see nothing of another domain's. Make one to work on several repositories together."),
    slug, title,
    el("div", { class: "field" }, "Its repositories (those cloned on this Mac; more with desolate clone)", el("div", { class: "choices" }, boxes.length ? boxes : el("span", { class: "sub" }, "none cloned yet"))),
    status,
    el("div", { class: "buttons" }, el("button", { type: "submit" }, "Create domain")));
  newDomain = { element };
  render();
  slug.focus();
  element.scrollIntoView({ block: "nearest" });
};

const firstRun = () => {
  const hasRepo = state.repos.length > 0, hasDomain = state.domains.length > 0;
  const hasBoth = state.domains.some((d) => d.repos.length > 0), hasWorkspace = state.domains.some((d) => d.workspaces.length > 0);
  if (hasWorkspace) return null;
  const firstDomain = state.domains[0];
  return el("div", { class: "card" }, el("h3", {}, "Getting started"), el("p", { class: "sub" }, "Each step shows the command it runs, so you can do the same from a terminal."),
    el("ol", { class: "steps" },
      el("li", { class: hasRepo ? "done" : "" }, "Clone a repository. Its deploy keys are made in the root VM; adding them at GitHub is yours to do, so this one starts on the host. It also makes the repository a domain, the trust boundary its workspaces share, named owner--repo: ", el("code", {}, "desolate clone <owner>/<repo>"), hasRepo ? `  (have: ${state.repos.map((r) => r.repo).join(", ")})` : ""),
      el("li", {}, "Start a workspace: a VM with the project's devcontainer and an editor in it, ", el("code", {}, `desolate up ${firstDomain ? firstDomain.slug : "<owner>--<repo>"}`), hasBoth ? " (or New workspace on its card below)" : "", ". Open its editor, work, commit; ", el("code", {}, "git push"), " there offers your branch, and it comes back here for you to review and push.")));
};

const render = () => {
  if (!state) return;
  const stack = document.getElementById("stack");
  stack.textContent = state.stack ? (state.stack.isolated ? `${state.stack.backend} VMs` : "NOT ISOLATED: fake backend") : "stack: unknown";
  stack.className = `chip ${state.stack && !state.stack.isolated ? "bad" : ""}`;
  const host = document.getElementById("host");
  host.textContent = notice || (state.hostConnected ? "host connected" : "host not connected: VM states are as last known; run `desolate bootstrap` on the host");
  host.className = `chip ${notice || !state.hostConnected ? "bad" : ""}`;
  const needs = needsYou();
  document.getElementById("needs").hidden = needs.length === 0;
  document.getElementById("needs-list").replaceChildren(...needs);
  // (Where the diff was scrolled to, kept: its element is the same one, moved.)
  const scrolled = shownDiff && shownDiff.node.isConnected ? [...shownDiff.node.querySelectorAll("[data-diff]")].map((n) => [n, n.scrollTop, n.scrollLeft]) : [];
  const issue = syncIssue();
  document.getElementById("issue").hidden = !issue;
  if (issue && document.getElementById("issue").firstChild !== issue) document.getElementById("issue").replaceChildren(issue);
  const panel = reviewPanel();
  document.getElementById("review").hidden = !panel;
  document.body.classList.toggle("reviewing", Boolean(panel));
  const body = document.getElementById("review-body");
  if (panel) body.replaceChildren(panel);
  else body.replaceChildren();
  for (const [node, top, left] of scrolled) if (node.isConnected) { node.scrollTop = top; node.scrollLeft = left; }
  const first = firstRun();
  document.getElementById("first-run").hidden = !first;
  document.getElementById("first-run").replaceChildren(...(first ? [first] : []));
  // What is typed into a form survives a redraw.
  const typed = new Map([...document.querySelectorAll("#domains input")].map((input) => [`${input.closest("[data-domain]")?.dataset.domain}:${input.name}`, input.value]));
  const focused = document.activeElement && document.activeElement.closest ? `${document.activeElement.closest("[data-domain]")?.dataset.domain}:${document.activeElement.name}` : null;
  // The sections the person folded, and what they filter by.
  for (const section of document.querySelectorAll(".foldable")) section.classList.toggle("folded", folded.has(section.dataset.foldKey));
  const shown = state.domains.filter((d) => !domainFilter || [d.slug, d.title || "", ...d.repos].some((text) => text.toLowerCase().includes(domainFilter)));
  document.getElementById("domain-count").textContent = domainFilter ? `${shown.length} of ${state.domains.length}` : String(state.domains.length);
  const newOne = document.getElementById("new-domain");
  newOne.hidden = !newDomain;
  if (newDomain && newOne.firstChild !== newDomain.element) newOne.replaceChildren(newDomain.element);
  if (!newDomain) newOne.replaceChildren();
  document.getElementById("domains").replaceChildren(...shown.map(domainCard),
    shown.length === 0 && state.domains.length ? el("div", { class: "sub" }, `No domain matches “${domainFilter}”.`) : null);
  for (const input of document.querySelectorAll("#domains input")) {
    const key = `${input.closest("[data-domain]")?.dataset.domain}:${input.name}`;
    if (typed.has(key)) input.value = typed.get(key);
    if (key === focused) input.focus();
  }
  const all = state.actions.slice().reverse();
  const recent = all.filter((a) => !activityFilter || redact(a.command).toLowerCase().includes(activityFilter));
  document.getElementById("activity").hidden = all.length === 0;
  document.getElementById("activity-count").textContent = activityFilter ? `${recent.length} of ${all.length}` : String(all.length);
  document.getElementById("activity-list").replaceChildren(...recent.map((a) => el("li", { "data-action-state": a.state },
    el("span", { class: `dot ${a.state === "done" ? "green" : a.state === "failed" ? "red" : "blue"}` }),
    el("div", { class: "what" }, el("div", { class: "name" }, el("span", { class: "mono" }, redact(a.command)),
      a.state === "queued" ? pill("queued", "blue pulse", "waiting for the host to take it") : a.state === "running" ? pill("running", "blue pulse", "the host is running it") : a.state === "done" ? pill("done", "green") : pill(`failed${a.code !== undefined ? ` (exit ${a.code})` : ""}`, "red", "what it said is below"),
      a.at ? el("span", { class: "sub" }, ago(a.at)) : null),
      a.lines.length ? el("pre", { class: "mono" }, a.lines.map(redact).join("\n")) : null),
    el("div", { class: "buttons" }, typeof a.link === "string" && a.link.startsWith("https://github.com/")
      ? el("a", { class: "button", href: a.link, target: "_blank", rel: "noopener noreferrer", "data-pull-request": "" }, "Open pull request") : null))));
  document.title = needs.length ? `(${needs.length}) desolate` : "desolate";
};

// `?review&domain=<d>&repo=<owner/repo>&branch=<b>`: open that offer's review when the
// state first shows it. A link to a review, for `desolate review` to print and for a
// screenshot. It names an offer; it carries nothing that is run.
const asked = new URLSearchParams(location.search);
let pending = asked.has("review");
const arrived = (now) => {
  state = now;
  render();
  // The remote was fetched while its review is open (Fetch now): the review again, against it.
  if (reviewing && !reviewing.loading) {
    const fetchedAt = (state.repos.find((r) => r.repo === reviewing.offer.repo) || {}).fetchedAt || null;
    if (fetchedAt && fetchedAt !== reviewing.fetchedAt) openReview(reviewing.offer, reviewing.against);
  }
  if (!pending) return;
  const offer = state.offers.find((o) => o.domain === asked.get("domain") && o.repo === asked.get("repo") && o.branch === asked.get("branch"));
  if (offer) { pending = false; openReview(offer); }
};
const listen = () => {
  const events = new EventSource("/events");
  events.onmessage = (event) => arrived(JSON.parse(event.data));
  events.onerror = () => { events.close(); setTimeout(listen, 1500); };
};
// The page's own controls, made once: folding a section, the filters, a new domain, and the
// review's width.
for (const button of document.querySelectorAll("button.fold[data-fold]")) button.addEventListener("click", () => toggleFold(button.dataset.fold));
document.getElementById("domain-filter").addEventListener("input", (event) => { domainFilter = event.target.value.trim().toLowerCase(); render(); });
document.getElementById("activity-filter").addEventListener("input", (event) => { activityFilter = event.target.value.trim().toLowerCase(); render(); });
document.getElementById("new-domain-open").addEventListener("click", () => (newDomain ? ((newDomain = null), render()) : openNewDomain()));
(() => {
  const root = document.documentElement;
  try {
    const kept = Number(localStorage.getItem("desolate-review-width"));
    if (kept >= 360) root.style.setProperty("--review-w", `${kept}px`);
  } catch {
    /* the default width */
  }
  const handle = document.querySelector("#review .resizer");
  handle.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    handle.classList.add("dragging");
    const move = (e) => root.style.setProperty("--review-w", `${Math.round(Math.min(window.innerWidth * 0.92, Math.max(360, window.innerWidth - e.clientX)))}px`);
    const up = () => {
      handle.classList.remove("dragging");
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      try {
        localStorage.setItem("desolate-review-width", String(parseInt(getComputedStyle(root).getPropertyValue("--review-w"), 10) || ""));
      } catch {
        /* kept for now */
      }
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && reviewing) { reviewing = null; render(); } });
})();

// `?once`: the state as it is now, drawn once, with no stream left open. For a screenshot
// or a printed page; the dashboard itself always listens.
if (asked.has("once")) fetch("/state").then((response) => response.json()).then(arrived);
else listen();
