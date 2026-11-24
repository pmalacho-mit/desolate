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
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat(Infinity)) if (child !== null && child !== undefined && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
};
/** "Open in git": the git terminal (the host's page, not this one) in a new tab, at the
 *  person's clone of the repository, on the domain's branch as its workspace has it (the
 *  host checks it out there: host/git-vm.ts checkoutOffered). It carries no token: the tab is
 *  signed in only if the person opened `desolate git`'s address in this browser once. */
const gitLink = (repo, at) => state && state.stack && state.stack.editorPort
  ? el("a", { class: "button quiet", "data-open-git": repo, href: `http://${state.stack.gitHostname || "desolate-git.localhost"}:${state.stack.editorPort}/?repo=${encodeURIComponent(repo)}${at ? `&domain=${encodeURIComponent(at.domain)}&branch=${encodeURIComponent(at.branch)}` : ""}`, target: "_blank", rel: "noopener noreferrer", title: at ? `A terminal in your clone of ${repo}, on ${at.branch} as ${at.domain} has it: git status, git log, git push` : `A terminal in your clone of ${repo}` }, "Open in git")
  : null;
/** The approval page (the Mac's own, not this one's): its bare address, the only one another
 *  site may open (host/approve-web.ts), and for a `push`, a fragment naming it, which the
 *  page marks (the fragment never reaches its server). */
const approvalUrl = (push) => state && state.stack && state.stack.approveHostname
  ? `http://${state.stack.approveHostname}:${state.stack.editorPort}/${push ? `#repo=${encodeURIComponent(push.repo)}&branch=${encodeURIComponent(push.branch)}&commit=${encodeURIComponent(push.commit)}` : ""}`
  : null;
/** It in a tab of its own, as Push starts a push that waits there for the person. Opened in
 *  the click itself, so the browser lets it open; with no tie back to this page (noopener,
 *  and its own Cross-Origin-Opener-Policy). */
const openApproval = (push) => {
  if (approvalUrl(push)) window.open(approvalUrl(push), "_blank", "noopener,noreferrer");
};
/** What a name is, said with it: a domain, a workspace, a repository, a branch, a commit (the
 *  same word can be several). A domain or a workspace named with `at` ("<domain>" or
 *  "<domain>/<workspace>") is also a way to it: a click goes to its card or its row. */
const named = (kind, value, title, at) => el("span", { class: `named ${kind}`, title: title || `the ${kind}`, "data-goto": at ? `${kind}:${at}` : null, role: at ? "link" : null, tabindex: at ? "0" : null },
  el("span", { class: "kind" }, kind), el("span", { class: "value mono", title: String(value) }, value));
const commitRef = (commit, title) => named("commit", short(commit), title || `the commit ${commit}`);
/** Go to a domain's card or a workspace's row: shown first (unfolded, not filtered away),
 *  then scrolled to, and marked for a moment. */
/** A domain's or a workspace's name, as typed: the root's own rule (shared/names.ts), its
 *  length from the root (shared/limits.ts NAMES.slug), so the page holds no copy of it. */
const slugPattern = () => `[a-z0-9][a-z0-9-]{0,${state.bounds.slug - 1}}`;
const goTo = (where) => {
  const kind = where.slice(0, where.indexOf(":"));
  const at = where.slice(where.indexOf(":") + 1);
  const slug = kind === "domain" ? at : at.slice(0, at.indexOf("/"));
  const find = () => document.querySelector(kind === "domain" ? `[data-domain="${CSS.escape(at)}"]` : `[data-workspace="${CSS.escape(at)}"]`);
  let changed = false;
  for (const key of ["section:domains", `domain:${slug}`]) if (folded.has(key)) { folded.delete(key); changed = true; }
  if (changed) {
    try { localStorage.setItem("desolate-folded", JSON.stringify([...folded])); } catch { /* kept for now */ }
    render();
  }
  if (!find() && domainFilter) {
    domainFilter = "";
    document.getElementById("domain-filter").value = "";
    render();
  }
  const node = find();
  if (!node) return;
  node.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: kind === "domain" ? "start" : "center" });
  node.classList.remove("flash");
  void node.offsetWidth;
  node.classList.add("flash");
};
document.addEventListener("click", (event) => {
  const to = event.target.closest && event.target.closest("[data-goto]");
  if (to) { event.preventDefault(); goTo(to.dataset.goto); }
});
document.addEventListener("keydown", (event) => {
  if ((event.key === "Enter" || event.key === " ") && event.target.matches && event.target.matches("[data-goto]")) { event.preventDefault(); goTo(event.target.dataset.goto); }
});
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
// The domains' filter is kept in this browser, as the folds are: a reload showed every domain
// again, and a click meant for one landed on another's (dogfooding, 2026-11-21).
let domainFilter = (() => {
  try {
    return localStorage.getItem("desolate-domain-filter") || "";
  } catch {
    return "";
  }
})();
let activityFilter = "";

const act = async (key, kind, args) => {
  busy.add(key);
  // (The last action's error goes with the next action: it is about that one.)
  notice = "";
  render();
  try {
    const response = await fetch("/action", { method: "POST", headers: { "content-type": "application/json", "x-desolate-ui": "1", ...window.desolateKey.headers }, body: JSON.stringify({ kind, args }) });
    if (!response.ok) alertLine((await response.json()).error || "the dashboard could not do that");
  } catch (error) {
    alertLine(String(error));
  } finally {
    setTimeout(() => { busy.delete(key); render(); }, 1500);
  }
};
/** An action's error: kept until the person dismisses it or asks for the next action (it
 *  went after 8 s, and a person who looked away never read it). */
let notice = "";
const alertLine = (text) => { notice = text; render(); };
const button = (label, key, kind, args, quiet = false) =>
  el("button", { class: quiet ? "quiet" : "", disabled: busy.has(key), "data-action": kind, onclick: () => act(key, kind, args) }, busy.has(key) ? `${label}...` : label);

// The diff, as text, and a file's name in a list: the approval page's rule and its diff
// (shared/ui/shown-text.js). Nothing in the diff is ever parsed as markup.
const { unhidden, name: nameShown, fileOf, colours, diffView } = DesolateShown;
/** A side-by-side header: the file's name, or a renamed file's two, as git gives them
 *  (`a/<old> b/<new>`: it named only the old one, the triage of 2026-11-22). */
const fileHeader = (line) => {
  const names = line.slice("diff --git ".length);
  const half = (names.length - 1) / 2;
  return names.startsWith("a/") && names.slice(half + 1, half + 3) === "b/" && names.slice(2, half) === names.slice(half + 3) ? names.slice(2, half) : names;
};
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
      rows.push({ kind: "file", file: fileOf(line), text: fileHeader(line) });
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
  if (row.kind !== "change" && row.kind !== "same") return el("div", { class: `sbs-${row.kind}`, "data-file": row.kind === "file" ? row.file : null }, unhidden(row.text));
  const code = (side, other) => {
    const pair = row.kind === "change" && row.like;
    const coloured = colours(tokens, side.at, side.text);
    if (coloured) return DesolateHighlight.paint(coloured, unhidden, pair ? differing(unhidden(side.text), other && unhidden(other.text)) : null);
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
// diff, the layout, or how much of it the root has sent changes. The root sends it in pages
// (root/offers.ts DIFF_PAGE: as much as draws quickly), so this draws all it has.
let shownDiff = null; // { diff, layout, pages, tokens, node }
const diffElement = (diff) => {
  if (shownDiff && shownDiff.diff === diff && shownDiff.layout === layout && shownDiff.pages === diff.pages && shownDiff.tokens === diff.tokens) return shownDiff.node;
  const node = el("div", { class: "diff-box" }, layout === "sides" ? sideBySide(diff.text, diff.tokens) : diffView(diff.text, diff.tokens));
  shownDiff = { diff, layout, pages: diff.pages, tokens: diff.tokens, node };
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
/** What the review asks the root for after its first answer: the next page of a list, the
 *  files of the commits picked, the diff a page at a time. Each request ends when the review
 *  closes (the root then stops git: nothing there has a timer, R4). The root says which
 *  commit it read: one that is not the reviewed one means the branch moved. */
const askReview = async (r, what, params) => {
  const extra = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => `&${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("");
  const response = await fetch(`/${what}?${query(r.offer, r.against)}${extra}`, { headers: window.desolateKey.headers, signal: r.gone.signal });
  const answer = await response.json();
  if (!response.ok) throw new Error(answer.error || `HTTP ${response.status}`);
  if (answer.commit !== r.review.commit) {
    r.moved = true;
    throw new Error("The branch moved while you were reading. Close this and review it again.");
  }
  return answer;
};
/** The commits picked, by their ids (a run: the oldest, then the newest), or none. */
const pickParams = (r) => (r.pick ? { pickFrom: r.commits.items[r.pick.hi].commit, pickTo: r.commits.items[r.pick.lo].commit } : {});
const closeReview = () => {
  if (reviewing && reviewing.gone) reviewing.gone.abort();
  reviewing = null;
  addressOf(null);
  render();
};
/** The review open, in the page's address (`?review&domain=...`), so a reload opens it again. */
const addressOf = (target, against) => {
  const params = new URLSearchParams(location.search);
  for (const key of ["review", "domain", "repo", "branch", "against"]) params.delete(key);
  if (target) {
    params.set("review", "");
    params.set("domain", target.domain);
    params.set("repo", target.repo);
    params.set("branch", target.branch);
    if (against === "domain") params.set("against", "domain");
  }
  const query = params.toString();
  try {
    history.replaceState(null, "", `${location.pathname}${query ? `?${query}` : ""}`);
  } catch {
    /* an address that cannot be changed: the review is not kept across a reload */
  }
};
/** The next page of the commits, or of the files, added to what is shown ("Show more"). */
const showMore = async (list) => {
  const r = reviewing;
  const have = list === "commits" ? r.commits : r.files;
  if (!have || have.asking) return;
  have.asking = true;
  have.error = null;
  render();
  try {
    const answer = await askReview(r, "review/more", { list, from: have.items.length, ...(list === "files" ? pickParams(r) : {}) });
    const page = list === "commits" ? answer.commits : answer.changes;
    have.items = have.items.concat(page.items);
    have.total = page.total;
  } catch (error) {
    have.error = error.message || String(error);
  }
  have.asking = false;
  if (reviewing === r) render();
};
/** The files the commits picked change (the whole review's, when none are): asked of the
 *  root, the last asked winning. Meanwhile the list shows the files it showed. */
let filesAsked = 0;
const loadFiles = async () => {
  const r = reviewing;
  const asked = ++filesAsked;
  if (!r.pick) {
    r.files = r.review.changes;
    return;
  }
  r.files = { loading: true, previous: r.files && r.files.loading ? r.files.previous : r.files };
  let files;
  try {
    files = (await askReview(r, "review/more", { list: "files", ...pickParams(r) })).changes;
  } catch (error) {
    files = { error: error.message || String(error) };
  }
  if (asked !== filesAsked || reviewing !== r) return;
  r.files = files;
  render();
};
/** Colours for the diff's text, when the worker has them (or never: the diff stays plain). */
const colour = (r, diff) => {
  if (typeof diff.text !== "string" || typeof DesolateHighlight === "undefined") return;
  const pages = diff.pages;
  DesolateHighlight.tokensFor(diff.text).then((tokens) => {
    if (reviewing === r && r.diff === diff && diff.pages === pages && tokens.some(Boolean)) {
      diff.tokens = tokens;
      render();
    }
  });
};
/** The diff of the review, or of the commits picked in it (commitList), or of one file of it
 *  (`file`: a change from the list), its first page: asked of the root, the last asked
 *  winning (a run of quick clicks shows the last one's). Making it takes what it takes: the
 *  page says it is at it, and closing the review stops it. */
let diffAsked = 0;
const loadDiff = async (file = null) => {
  const r = reviewing;
  const asked = ++diffAsked;
  const params = { ...pickParams(r), whitespace: r.whitespace === "ignore" ? "ignore" : null, file: file ? file.path : null, was: file ? file.was : null };
  r.diff = { loading: true };
  render();
  let diff;
  try {
    diff = { ...(await askReview(r, "diff", params)), params, pages: 1 };
  } catch (error) {
    diff = { error: error.message || String(error) };
  }
  if (asked !== diffAsked || reviewing !== r) return;
  r.diff = diff;
  render();
  colour(r, diff);
};
/** The diff's next page, after what is shown. */
const moreDiff = async () => {
  const r = reviewing;
  const diff = r.diff;
  if (!diff || diff.asking || diff.next === null) return;
  diff.asking = true;
  diff.more = null;
  render();
  try {
    const page = await askReview(r, "diff", { ...diff.params, at: diff.next });
    diff.text += page.text;
    diff.next = page.next;
    diff.total = page.total;
    diff.pages += 1;
  } catch (error) {
    diff.more = error.message || String(error);
  }
  diff.asking = false;
  if (reviewing === r && r.diff === diff) {
    render();
    colour(r, diff);
  }
};

/** Review any branch a domain has (offered or not), against the remote's default branch
 *  ("origin") or the domain's own copy of it ("domain"). The target names only a domain, a
 *  repository and a branch: what is shown is read in the root. */
/** What the open review was read against: the remote as last fetched, and the branch's
 *  commit, what was pushed of it and where it landed. When one changes, it is read again (a
 *  panel left open said "Not offered" after its push: dogfooding, 2026-11-22). */
const reviewMark = (offer) => {
  const d = state && state.domains.find((x) => x.slug === offer.domain);
  const b = d && branchesOf(d).find((b) => b.repo === offer.repo && b.branch === offer.branch);
  const repo = state && state.repos.find((r) => r.repo === offer.repo);
  // (And the offer's commit: offered again, the panel is read again.)
  const o = state && state.offers.find((x) => x.domain === offer.domain && x.repo === offer.repo && x.branch === offer.branch);
  return JSON.stringify([repo && repo.fetchedAt, b && b.commit, b && b.pushed && b.pushed.commit, b && b.landed, o && o.commit]);
};
const openReview = async (offer, against = "origin") => {
  if (reviewing && reviewing.gone) reviewing.gone.abort();
  const mark = reviewMark(offer);
  const gone = new AbortController();
  reviewing = { offer, against, mark, gone, loading: true };
  addressOf(offer, against);
  render();
  let review;
  try {
    const response = await fetch(`/review?${query(offer, against)}`, { headers: window.desolateKey.headers, signal: gone.signal });
    review = await response.json();
  } catch (error) {
    review = { error: String(error) };
  }
  if (!reviewing || reviewing.gone !== gone) return;
  // Its lists as the first page came: more is added to these copies as it is asked for.
  reviewing = review.error ? { offer, against, mark, gone, review }
    : { offer, against, mark, gone, review, commits: { ...review.commits, items: [...review.commits.items] }, files: review.changes, messages: new Set() };
  render();
  if (!review.error) loadDiff();
};

// ------------------------------------------------------------------ issues
// A GitHub issue a workspace offered (shared/issues.ts): read and edited here, then published
// as you, once you approve it on the Mac. Its text is an agent's: the editor's fields are
// form fields, and the preview is built as elements (shared/ui/markdown.js), never as HTML.
let editing = null; // { id, element, parts }
const dismissOffer = async (o) => {
  const response = await fetch("/offer", { method: "POST", headers: { "content-type": "application/json", "x-desolate-ui": "1", ...window.desolateKey.headers }, body: JSON.stringify({ domain: o.domain, repo: o.repo, branch: o.branch, commit: o.commit, do: "dismiss" }) });
  if (!response.ok) alert(`Not dismissed: ${(await response.json().catch(() => ({}))).error || `HTTP ${response.status}`}`);
};
const issueCall = async (id, what, fields) => {
  const response = await fetch("/issue", { method: "POST", headers: { "content-type": "application/json", "x-desolate-ui": "1", ...window.desolateKey.headers }, body: JSON.stringify({ id, do: what, ...fields }) });
  const answer = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(answer.error || `HTTP ${response.status}`);
  return answer;
};
const labelsOf = (value) => value.split(",").map((label) => label.trim()).filter(Boolean);
/** Built once when it opens, so what you type is never redrawn away; `syncIssue` keeps its
 *  status in step with the state. */
const openIssue = (issue) => {
  const title = el("input", { name: "title", value: issue.title, maxlength: String(state.bounds.issueTitle), "aria-label": "title", class: "wide" });
  const labels = el("input", { name: "labels", value: issue.labels.join(", "), "aria-label": "labels, separated by commas", class: "wide", placeholder: "labels, separated by commas" });
  const body = el("textarea", { name: "body", rows: "16", "aria-label": "body (Markdown)", class: "wide mono" });
  body.value = issue.body;
  const preview = el("div", { class: "markdown", "data-preview": "", hidden: true });
  const status = el("div", { class: "sub", "data-issue-status": "" });
  let previewing = false;
  const toggle = el("button", { class: "quiet small", type: "button", "data-preview-toggle": "", onclick: () => {
    previewing = !previewing;
    toggle.textContent = previewing ? "Write" : "Preview";
    if (previewing) preview.replaceChildren(typeof DesolateMarkdown !== "undefined" ? DesolateMarkdown.render(body.value, unhidden, location.origin) : document.createTextNode(body.value));
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
    // As an offer: what, for which repository, from where, its names in one column.
    items.push(el("li", { "data-issue-offer": i.id }, el("span", { class: `dot ${i.state === "approving" ? "orange" : "blue"}` }), el("div", { class: "what pairs" },
      el("span", { class: "label name" }, "Issue"), el("div", { class: "name" }, i.title),
      el("span", { class: "label" }, "for"), el("div", { class: "line" }, named("repo", i.repo), ...i.labels.map((label) => pill(label, "", "a label it asks for"))),
      el("span", { class: "label" }, "from"), el("div", { class: "line" }, named("domain", i.domain, null, i.domain), named("workspace", i.workspace, null, `${i.domain}/${i.workspace}`)),
      i.state === "approving" ? [el("span", {}), el("div", { class: "line warn" }, "Waits for your approval on the Mac.")] : null,
      i.problem ? [el("span", {}), el("div", { class: "line warn" }, `Not published: ${i.problem}`)] : null),
      el("div", { class: "buttons" }, el("button", { class: "quiet", onclick: () => openIssue(i) }, i.state === "approving" ? "Open" : "Read and edit"))));
  }
  for (const a of state.approvals) items.push(el("li", {}, el("span", { class: "dot orange" }), el("div", { class: "what" },
    el("div", { class: "name" }, `A push is waiting for your approval: ${a.repo} ${a.branch}`),
    el("div", { class: "line mono" }, `${a.commit}`),
    a.summary ? el("div", { class: "line sub fit", title: a.summary, "data-approval-from": "" }, a.summary) : null,
    el("div", { class: "line" }, "Approve or refuse it on the approval page, outside every VM (or ", el("code", {}, "desolate approve"), " in a terminal on the Mac).")),
    el("div", { class: "buttons" }, approvalUrl() ? el("a", { class: "button", href: approvalUrl(), target: "_blank", rel: "noopener noreferrer", "data-approval-page": "" }, "Open the approval page") : null)));
  for (const r of state.refused || []) items.push(el("li", { "data-refused": `${r.domain}/${r.repo}` }, el("span", { class: "dot red" }), el("div", { class: "what" },
    el("div", { class: "name" }, `Refused from ${r.domain}: a bundle of ${r.repo}`),
    el("div", { class: "line mono" }, r.why),
    // What to do is the root's, as the workspace and `desolate offers` say it (outbox.ts, refusalFix): text.
    el("div", { class: "line" }, r.fix)), el("div", {})));
  for (const o of state.offers) {
    const key = `push:${o.domain}:${o.repo}:${o.branch}`;
    // Two lines, their names in one column: what is offered, and where from.
    items.push(el("li", { "data-offer": `${o.domain}/${o.repo}/${o.branch}` }, el("span", { class: "dot blue" }), el("div", { class: "what pairs" },
      el("span", { class: "label name" }, "Offered"), el("div", { class: "name" }, named("branch", o.branch), named("repo", o.repo)),
      el("span", { class: "label" }, "from"), el("div", { class: "line" }, named("domain", o.domain, null, o.domain), named("workspace", o.workspace, null, `${o.domain}/${o.workspace}`), el("span", { class: "sub" }, "at"), commitRef(o.commit), o.lfs ? el("span", { class: "sub" }, `with ${o.lfs} LFS object(s)`) : null),
      // The branch has left the commit offered (a commit since, or rewritten): not pushed from here.
      o.now !== o.commit ? [el("span", {}), el("div", { class: "line warn", "data-offer-moved": "" }, `Moved since it was offered: the branch is ${o.now ? `at ${short(o.now)}` : "gone"} now. To push it from here, the workspace offers it again (`, el("code", {}, "desolate offer"), ", or its git push); or Dismiss this.")] : null),
      el("div", { class: "buttons" }, el("button", { class: "quiet", onclick: () => openReview(o) }, "Review"),
        // Not this one: off "Needs you". The branch stays, and offering it again brings it back.
        el("button", { class: "quiet", title: "Take it off this list. The branch stays in the domain; offering it again brings it back.", onclick: () => dismissOffer(o) }, "Dismiss"))));
  }
  for (const d of state.domains) for (const w of d.workspaces) {
    const says = w.says.status;
    // A workspace asking for you (orange) or stuck (red), in its own words.
    if (says && (says.color === "orange" || says.color === "red"))
      items.push(el("li", { "data-asks": `${d.slug}/${w.workspace}` }, el("span", { class: `dot ${says.color}` }), el("div", { class: "what pairs" },
        el("span", { class: "label name" }, says.color === "orange" ? "Asks" : "Stuck"), el("div", { class: "name" }, named("domain", d.slug, null, d.slug), named("workspace", w.workspace, null, `${d.slug}/${w.workspace}`)),
        el("span", {}), el("div", { class: "line" }, says.message)), el("div", {})));
    if (w.outlived)
      items.push(el("li", { "data-outlived": `${d.slug}/${w.workspace}` }, el("span", { class: "dot orange" }), el("div", { class: "what pairs" },
        el("span", { class: "label name" }, "Outlived"), el("div", { class: "name" }, named("domain", d.slug, null, d.slug), named("workspace", w.workspace, null, `${d.slug}/${w.workspace}`)),
        el("span", {}), el("div", { class: "line" }, `${w.startedBy}, which started it, is gone; this one is still here. Look at its branches, then `, el("code", {}, `desolate rm ${d.slug}/${w.workspace}`), " when you are done with it.")), el("div", {})));
    if (w.host && w.host.devcontainer && /^FAILED/.test(w.host.devcontainer))
      items.push(el("li", { "data-devcontainer-failed": `${d.slug}/${w.workspace}` }, el("span", { class: "dot red" }), el("div", { class: "what pairs" },
        el("span", { class: "label name" }, "Failed"), el("div", { class: "name" }, named("domain", d.slug, null, d.slug), named("workspace", w.workspace, null, `${d.slug}/${w.workspace}`), el("span", { class: "sub" }, "its devcontainer did not come up")),
        el("span", {}), el("div", { class: "line mono" }, w.host.devcontainer)), el("div", {})));
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

/** "and 37 more commits": what a list shown leaves unsaid (shared/listed.ts andMore). */
const andMore = (list, noun, nouns = `${noun}s`) => {
  const more = list.total - list.items.length;
  return more > 0 ? `and ${more.toLocaleString()} more ${more === 1 ? noun : nouns}` : null;
};
/** The rest of a list, for the asking: what is left, and a button for the next page. */
const moreOf = (list, which, noun) => list.items.length < list.total
  ? el("div", { class: "sub more", [`data-${which}-more`]: "" }, andMore(list, noun), " ",
      el("button", { class: "quiet small", type: "button", disabled: Boolean(list.asking), onclick: () => showMore(which) }, list.asking ? "Reading..." : "Show more"),
      list.error ? el("span", { class: "warn" }, ` ${list.error}`) : null)
  : list.error ? el("div", { class: "warn" }, list.error) : null;

/** The files a review changes: how (added, modified, deleted, renamed), and how many lines,
 *  with a filter; a file's name goes to its place in the diff (or, when the diff shown does
 *  not reach it, to its diff alone). Paths are a branch's data: text, never markup. */
let filesFilter = "";
const jumpTo = (change) => {
  const find = () => [...document.querySelectorAll("#review [data-file]")].find((n) => n.dataset.file === change.path || (change.was !== undefined && n.dataset.file === change.was));
  const at = find();
  if (at) at.scrollIntoView({ block: "start", behavior: "smooth" });
  else loadDiff(change);
};
const filesChanged = () => {
  const r = reviewing;
  // The picked commits' files once the root has them (meanwhile, the last ones shown, not a
  // flash of the whole review's).
  const files = r.files && r.files.loading ? r.files.previous : r.files;
  if (!files) return null;
  if (files.error) return el("div", { class: "warn" }, files.error);
  if (!files.total) return null;
  const changes = files.items;
  const shown = changes.filter((c) => !filesFilter || c.path.toLowerCase().includes(filesFilter.toLowerCase()));
  const colour = { added: "green", deleted: "red", modified: "blue", renamed: "blue", changed: "" };
  const one = r.pick && r.pick.lo === r.pick.hi;
  return el("details", { class: "files-changed", open: true, "data-files-changed": "" },
    el("summary", {}, r.pick ? `Files ${one ? "this commit changes" : "these commits change"} (${files.total.toLocaleString()} of ${r.review.changes.total.toLocaleString()})` : `Files changed (${files.total.toLocaleString()})`),
    files.total > 6 ? el("input", { class: "filter", placeholder: "filter files", "aria-label": "filter the files changed", value: filesFilter, oninput: (event) => { filesFilter = event.target.value; render(); const box = document.querySelector("#review .files-changed .filter"); if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); } } }) : null,
    el("ul", { class: "files" }, shown.map((c) => el("li", { "data-change": c.path },
      pill(c.status, colour[c.status] || "", c.was !== undefined ? `renamed in this branch, from ${nameShown(c.was)}` : `${c.status} in this branch`),
      el("button", { class: "link mono", type: "button", title: c.was !== undefined ? `${nameShown(c.was)} → ${nameShown(c.path)}: go to it in the diff` : "go to it in the diff", onclick: () => jumpTo(c) }, nameShown(c.path)),
      c.added === null ? el("span", { class: "sub" }, "binary") : el("span", { class: "counts" }, el("span", { class: "plus" }, `+${c.added}`), " ", el("span", { class: "minus" }, `−${c.removed}`)),
      c.lookalike ? el("span", { class: "warn looks" }, "its name has letters that look like others") : null))),
    shown.length < changes.length ? el("div", { class: "sub" }, `${changes.length - shown.length} of the ${changes.length.toLocaleString()} listed do not match`) : null,
    moreOf(files, "files", "file"));
};
/** A review's commits, newest first, each one a button: a click shows that commit's changes
 *  alone, a shift-click a run of them (from the one clicked before), and a click on the one
 *  shown alone, or "Show all", the whole review again. Push always sends the whole branch.
 *  Every one is listed as the person asks for more: what is counted is all of them. */
const pickCommit = (i, extend) => {
  const p = reviewing.pick;
  if (extend && p) reviewing.pick = { anchor: p.anchor, lo: Math.min(p.anchor, i), hi: Math.max(p.anchor, i) };
  else if (p && p.lo === i && p.hi === i) reviewing.pick = null;
  else reviewing.pick = { anchor: i, lo: i, hi: i };
  loadFiles();
  loadDiff();
};
const commitList = () => {
  const { commits, pick: p } = reviewing;
  const total = commits.total.toLocaleString();
  const picked = p ? p.hi - p.lo + 1 : 0;
  return el("div", { class: `commits${p ? " picking" : ""}`, "data-commits": "" },
    el("div", { class: "commits-head" },
      p ? [el("strong", {}, picked === 1 ? "One commit's changes" : `${picked} commits' changes`), el("span", { class: "sub" }, `of ${total}. Push still sends all ${total}.`),
        el("button", { class: "quiet small", type: "button", "data-pick-all": "", onclick: () => { reviewing.pick = null; loadFiles(); loadDiff(); } }, `Show all ${total}`)]
        : [el("strong", {}, commits.total === 1 ? "One commit" : `All ${total} commits, combined`), el("span", { class: "sub" }, commits.total > 1 ? "Click one to see its changes alone; shift-click for a run of them." : "")]),
    el("ol", { class: "commit-list" }, commits.items.map((c, i) => {
      const on = Boolean(p && i >= p.lo && i <= p.hi);
      // Who wrote it and its whole message, on asking: what a push puts on the remote (made
      // safe in the root, as its subject is).
      const open = reviewing.messages.has(c.commit);
      return el("li", {}, el("button", { type: "button", class: `commit-pick${on ? " on" : ""}`, "data-pick": c.commit, "aria-pressed": String(on), title: `${c.subject}\n\nIts changes alone (shift-click: a run of commits)`,
        onmousedown: (event) => { if (event.shiftKey) event.preventDefault(); },
        onclick: (event) => pickCommit(i, event.shiftKey) },
        el("span", { class: "hash mono" }, short(c.commit)), el("span", { class: "subject" }, c.subject)),
        el("button", { class: "quiet small", type: "button", "data-message": c.commit, "aria-expanded": String(open), title: "who wrote it, and its whole message", onclick: () => { if (open) reviewing.messages.delete(c.commit); else reviewing.messages.add(c.commit); render(); } }, open ? "Hide" : "Message"),
        open ? el("pre", { class: "mono commit-message", "data-message-text": c.commit }, `Author: ${c.author}\n\n${c.subject}${c.body ? `\n\n${c.body}` : ""}`) : null);
    })),
    moreOf(commits, "commits", "commit"));
};
/** The diff shown, its first page and as many more as the person asked for, and how much of
 *  it that is. Shown only if it is of the commit the Push button names (the root says which
 *  commit each page is of). */
const diffPart = (diff, review) => {
  if (!diff) return null;
  if (diff.loading) return el("div", { class: "sub", "data-diff-making": "" }, "making the diff... (git is at it in the root: a large one takes a while, and Close stops it)");
  if (diff.error) return el("div", { class: "warn" }, diff.error);
  if (diff.commit !== review.commit) return null;
  const file = diff.params && diff.params.file;
  return [
    el("div", { class: "toolbar" },
      el("button", { class: "quiet small", "data-whitespace": "", onclick: () => { reviewing.whitespace = reviewing.whitespace === "ignore" ? "show" : "ignore"; loadDiff(file ? { path: file, was: diff.params.was } : null); } }, reviewing.whitespace === "ignore" ? "Show whitespace changes" : "Ignore whitespace changes"),
      el("button", { class: "quiet small", "data-layout": "", onclick: () => setLayout(layout === "sides" ? "unified" : "sides") }, layout === "sides" ? "Unified" : "Side by side"),
      file ? [el("span", { class: "sub", "data-diff-file": file }, "The diff of one file: ", el("span", { class: "mono" }, file)),
        el("button", { class: "quiet small", type: "button", "data-diff-all": "", onclick: () => loadDiff() }, "Every file's diff")] : null),
    diff.total === 0 ? el("div", { class: "sub" }, "No changes to show.") : diffElement(diff),
    diff.next !== null ? el("div", { class: "sub more", "data-diff-more": "" },
      `${Math.floor((100 * diff.next) / diff.total)}% of ${file ? "this file's" : "the"} diff is shown. `,
      el("button", { class: "quiet small", type: "button", disabled: Boolean(diff.asking), onclick: moreDiff }, diff.asking ? "Reading..." : "Show more"),
      diff.more ? el("span", { class: "warn" }, ` ${diff.more}`) : null) : null,
  ];
};
const reviewPanel = () => {
  if (!reviewing) return null;
  const { offer, review, loading } = reviewing;
  const close = el("button", { class: "quiet", onclick: closeReview }, "Close");
  const header = (...title) => el("div", { class: "review-head" }, el("div", { class: "title-row" }, el("div", { class: "title" }, ...title), close));
  if (loading) return el("div", { class: "card" }, header(el("h3", {}, `Reviewing ${offer.repo} ${offer.branch}`)), el("div", { class: "sub" }, "reading what a push would send... (git is at it in the root: it takes as long as the branch needs, and Close stops it)"));
  if (review.error) return el("div", { class: "card" }, header(el("h3", {}, `${offer.repo} ${offer.branch}`)), el("div", { class: "warn" }, review.error));
  const key = `push:${offer.domain}:${offer.repo}:${offer.branch}`;
  // Pushing from here is for what the agent offered, at the commit reviewed: an offer is how
  // its new LFS objects reach the root. Anything else is pushed from the git terminal.
  // (Only while the branch is still there: a state that says it moved takes Push away.)
  const offered = state.offers.some((o) => o.domain === offer.domain && o.repo === review.repo && o.branch === review.branch && o.commit === review.commit && o.now === o.commit);
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
    header(el("h3", {}, "Review"), named("branch", review.branch, "the branch reviewed"), named("repo", review.repo), named("domain", offer.domain, "the domain its workspaces wrote it in", offer.domain), commitRef(review.commit, `the commit reviewed: Push sends exactly this, ${review.commit}`)),
    // The default branch: one way to push, the same as any branch, and said loudly.
    review.isDefault ? el("div", { class: "warnbox default-branch", "data-default-branch": "" }, el("strong", {}, `This is ${review.repo}'s default branch, ${review.branch}.`), ` A push changes ${review.branch} on the remote directly, with no pull request to review it there first. Read every change below before you push.`) : null,
    el("div", { class: "toolbar" }, gitLink(review.repo, { domain: offer.domain, branch: review.branch })),
    el("div", { class: "toolbar" }, ...against,
      // The domain's own default branch, against itself, shows nothing: offered only for
      // another branch.
      review.isDefault && reviewing.against === "origin" ? null
        : el("button", { class: "quiet small", "data-against": other, onclick: () => openReview(offer, other) }, other === "domain" ? `Compare with ${offer.domain}'s ${def}` : `Compare with the remote's ${def}`)),
    el("div", { class: "stat" },
      pill(`${review.commits.total.toLocaleString()} commit${review.commits.total === 1 ? "" : "s"}`, review.commits.total ? "blue" : "", reviewing.against === "domain" ? "beyond the domain's default branch" : "what a push would send"),
      ...statView(review.stat),
      review.lfsObjects ? pill(`${review.lfsObjects} LFS object(s)`, "accent", "large files a push would send with it") : null,
      reviewing.against === "domain" ? el("span", { class: "sub" }, `(a push would send ${review.pushCommits}, counted against the remote)`) : null),
    // Merged by a squash or a rebase, its commits are not in the base's history, so they are
    // still counted here: said, beside the count (dogfooding, 2026-11-21).
    review.commits.total && landedIn(offer.domain, review) ? el("div", { class: "line sub", "data-review-merged": "" }, pill(`merged into ${landedIn(offer.domain, review)}`, "green", "at this commit, merged on the remote"),
      ` Its changes are in the remote's ${landedIn(offer.domain, review)}. Merged by a squash or a rebase, these commits are not in its history, so they are still counted and shown here.`) : null,
    review.warnings.length ? el("div", { class: "warnbox" }, review.warnings.map((w) => el("div", {}, pill("warning", "orange"), ` a push of this branch ${w}`))) : null,
    commitList(),
    filesChanged(),
    reviewing.moved ? el("div", { class: "warn", "data-moved": "" }, "The branch moved while you were reading. Close this and review it again.") : null,
    diffPart(reviewing.diff, review),
    el("div", { class: "sub" }, "To see whole files, open the branch in a workspace's editor. The diff here is the one to trust: it is made in the root, by git alone."),
    el("div", { class: "buttons" }, !review.pushable ? el("span", { class: "sub" }, "Not pushable: cloned --no-push, so there is no write key for it.")
      : reviewing.against === "domain" ? el("span", { class: "sub" }, `A push would send ${review.pushCommits} commit(s), counted against origin: compare with origin to push.`)
      : !offered && state.offers.some((o) => o.domain === offer.domain && o.repo === review.repo && o.branch === review.branch) ? el("span", { class: "sub", "data-review-moved": "" }, "Moved since it was offered, so not pushed from here: the workspace offers it again (", el("code", {}, "desolate offer"), ", or its git push), or Dismiss the offer.")
      : !offered ? el("span", { class: "sub" }, "Not offered at this commit, so not pushed from here. Open it in git (above) and run git push there, or have the agent run ", el("code", {}, "desolate offer"), ".")
      : el("button", { disabled: busy.has(key), "data-action": "offer.push", onclick: () => { openApproval({ repo: review.repo, branch: review.branch, commit: review.commit }); act(key, "offer.push", { domain: offer.domain, repo: review.repo, branch: review.branch, commit: review.commit }); } },
          busy.has(key) ? "Pushing..." : `Push exactly ${short(review.commit)}${review.isDefault ? ` to ${review.branch}` : ""}`)),
    el("div", { class: "sub" }, "Push opens the approval page in a new tab, where you approve exactly this commit. (Or approve it with ", el("code", {}, "desolate approve"), " in a terminal on the Mac.)"));
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
      : [named("branch", head.branch, "the branch checked out now"), head.commit ? commitRef(head.commit, `the commit checked out now: ${head.commit}`) : null];
  const remote = !pushed ? null
    : pushed.carryOn ? pill("squashed on the remote", "orange", `the remote's ${head.branch} is the squash of these commits, so its next push would replace it: carry the branch on from the squash first (below)`, { "data-squashed": "" })
    : pushed.count === 0 ? pill("on the remote", "green", "every commit here is on a branch of the remote (origin)")
      : pushed.count > 0 ? pill(`${pushed.count} not on the remote`, "orange", `${pushed.why}: review and push it, or offer it`)
        : pill("not counted", "gray", pushed.why || "its commits could not be counted against the remote");
  return [pill(c.repo, "repo mono", "the repository"), ...where, remote];
};

/** A pushed branch, not merged yet: its pull request's page, and Fetch now, which shows a
 *  merge on the forge at once (the root looks by itself now and then). */
const pullRequestOf = (b) => b.pushed && typeof b.pushed.pullRequest === "string" && b.pushed.pullRequest.startsWith("https://github.com/")
  ? el("a", { class: "button quiet small", href: b.pushed.pullRequest, target: "_blank", rel: "noopener noreferrer", "data-pull-request": `${b.repo}/${b.branch}`, title: `GitHub's page for opening ${b.branch}'s pull request, in your browser, as yourself` }, "Open pull request")
  : null;
const fetchNow = (repo) => el("button", { class: "quiet small", disabled: busy.has(`fetch:${repo}`), "data-fetch": repo, title: `desolate fetch ${repo}: the remote's branches as they are now, so a pull request merged there shows here at once`, onclick: () => act(`fetch:${repo}`, "repo.fetch", { repo }) }, busy.has(`fetch:${repo}`) ? "Fetching..." : "Fetch now");
/** What a checkout's branch is on the remote, below its line: pushed (its pull request),
 *  squashed there, or merged (the command that carries it on, for each checkout as it lands:
 *  it waited for all of them, dogfooding 2026-11-22). */
const checkoutAfter = (d, w, c) => {
  const pushed = (w.pushed || []).find((p) => p.repo === c.repo);
  const b = c.head && c.head.branch ? branchesOf(d).find((b) => b.repo === c.repo && b.branch === c.head.branch) : null;
  const landed = landedOf(d, c);
  return [
    pushed && pushed.carryOn ? el("div", { class: "line sub", "data-carry-on": c.repo }, "To carry on from the squash, in the workspace (what you committed since is kept, on top): ", el("code", {}, pushed.carryOn)) : null,
    landed ? el("div", { class: "line sub", "data-carry-on-merged": c.repo }, "To carry on in this checkout, start the next branch from what was merged: ", el("code", {}, `git fetch && git switch --no-track -c <next-branch> origin/${landed}`)) : null,
    b && b.pushed && !landedOf(d, c) ? el("div", { class: "line", "data-pushed": c.repo }, pill(`pushed ${short(b.pushed.commit)}`, "green", `desolate pushed ${b.pushed.commit} to the remote's ${b.branch}`), " ", pullRequestOf(b), " ", fetchNow(c.repo)) : null,
  ];
};

/** The base a checkout's branch is merged into, when the root saw its pushed commit land
 *  there (pushed.ts) and the checkout is still at that commit; else null. */
const landedOf = (d, c) => {
  if (!c.head || !c.head.branch || !c.head.commit) return null;
  const b = branchesOf(d).find((b) => b.repo === c.repo && b.branch === c.head.branch && b.commit === c.head.commit);
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
    why.push(running ? "desolate has not looked at what it holds yet (its daemon in the VM says, once it is up)" : "it stopped before desolate looked at what it holds: start it and stop it again, and Delete can tell");
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
  // What it has; when that is not known, what a workspace gets here when nothing says
  // (shared/size.ts defaultsFor, for this Mac: the root works it out once the host has said
  // what the Mac has). Bounded by shared/size.ts's limits and by this Mac (capToMac): a tester
  // set 86 GiB on a 64 GiB Mac, and nothing said no until it would not start.
  const bounds = state.bounds.size;
  const now = w.size || bounds.defaults || { cpus: bounds.limits.cpus[0], memoryMiB: bounds.limits.memoryMiB[0], diskGiB: bounds.limits.diskGiB[0] };
  const most = bounds.most || { cpus: bounds.limits.cpus[1], memoryMiB: bounds.limits.memoryMiB[1] };
  const ask = (w.asks && w.asks.size) || {};
  const number = (name, value, min, max, label) => el("label", { class: "field" }, label,
    el("input", { type: "number", name, value: String(Math.min(value, max)), min: String(min), max: String(max), step: "1", required: true, "aria-label": label }));
  const mostGiB = Math.floor(most.memoryMiB / 1024);
  const here = bounds.most ? " here" : "";
  const cpus = number("cpus", now.cpus, bounds.limits.cpus[0], most.cpus, `CPUs (at most ${most.cpus}${here})`);
  const memory = number("memory", Math.round(now.memoryMiB / 1024), Math.ceil(bounds.limits.memoryMiB[0] / 1024), mostGiB, `Memory (GiB, at most ${mostGiB}${here})`);
  const disk = number("disk", now.diskGiB, now.diskGiB, bounds.limits.diskGiB[1], `Disk (GiB, ${now.diskGiB} or more: a disk only grows)`);
  const input = (label) => label.querySelector("input");
  const useAsked = Object.keys(askedMore(w)).length
    ? el("button", { class: "quiet small", type: "button", "data-resize-asked": "", onclick: () => {
        if (ask.cpus !== undefined) input(cpus).value = String(Math.min(ask.cpus, most.cpus));
        if (ask.memoryMiB !== undefined) input(memory).value = String(Math.min(Math.ceil(ask.memoryMiB / 1024), mostGiB));
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

/** Its agents (desolate agent start), as the host last listed them: each one's state, and on
 *  hover its command, when it last printed, and how to reach it. */
const agentsLine = (d, w, host) => {
  const agents = host.agents;
  if (!agents || !agents.total) return null;
  const at = `${d.slug}/${w.workspace}`;
  const word = (a) => (a.state === "exited" && a.exit !== null ? `exited ${a.exit}` : a.state);
  return el("div", { class: "line", "data-agents": at }, "agents: ",
    agents.items.map((a) => pill(`${a.name}: ${word(a)}`, a.state === "running" ? "green" : "gray",
      `${a.command}\nlast output ${a.lastOutput ? ago(a.lastOutput) : "never"}\ndesolate agent attach ${at} --name ${a.name} (or log, or stop)`, { "data-agent": a.name })),
    agents.total > agents.items.length ? el("span", { class: "sub" }, `and ${agents.total - agents.items.length} more: desolate agent list ${at}`) : null);
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
  const merged = allLanded(d, w);
  const remove = el("span", { class: "tip", title: why.length ? `Not deletable yet: ${why.join("; ")}.` : `Delete ${d.slug}/${w.workspace}: its VM goes, nothing in it is unsaved, and every commit is on the remote. Its branches stay in the domain.` },
    el("button", { class: "quiet danger", disabled: why.length > 0 || busy.has(`rm:${d.slug}/${w.workspace}`), "data-delete": `${d.slug}/${w.workspace}`,
      onclick: () => { if (confirm(`Delete ${d.slug}/${w.workspace}? Its VM is removed. Nothing in it is unsaved, and its commits are on the remote; its branches stay in the domain.`)) act(`rm:${d.slug}/${w.workspace}`, "workspace.remove", target); } }, "Delete"));
  return el("li", { "data-workspace": `${d.slug}/${w.workspace}` },
    el("span", { class: `dot ${making ? "blue" : running ? (says ? says.color : "gray") : "hollow"}`, title: making ? w.doing || "busy" : says ? says.color : running ? "no status set" : "stopped" }),
    el("div", { class: "what" },
      el("div", { class: "name" }, named("workspace", w.workspace), pill(word, colour, explain, { "data-making": making ? "" : null }),
        // Who started it: you, or a workspace of the domain (desolate spawn in it); and a
        // warning when that one is gone and this one is still here.
        w.startedBy
          ? pill(w.outlived ? `started by ${w.startedBy}, since removed` : `started by ${w.startedBy}`, w.outlived ? "orange" : "", w.outlived ? `${w.startedBy} was removed; this one is still here` : `${w.startedBy} asked for it (desolate spawn)`, { "data-started-by": w.startedBy })
          : pill("started by you", "", "you started it: from here, or desolate up", { "data-started-by": "" })),
      making && w.making ? el("div", { class: "line sub fit", "data-making-step": "", title: redact(w.making) }, redact(w.making)) : null,
      w.checkouts.map((c) => [el("div", { class: "checkout", "data-checkout": c.repo }, checkoutLine(d, w, c),
        landedOf(d, c) ? pill(`merged into ${landedOf(d, c)}`, "green", "its branch, at this commit, is merged on the remote", { "data-merged": landedOf(d, c) }) : null,
        c.head && c.head.branch && branchesOf(d).some((b) => b.repo === c.repo && b.branch === c.head.branch)
          ? el("button", { class: "quiet small", "data-diff-checkout": c.repo, title: `What ${c.head.branch} changes against the remote's ${(state.repos.find((r) => r.repo === c.repo) || {}).defaultBranch || "default branch"}`, onclick: () => openReview({ domain: d.slug, repo: c.repo, branch: c.head.branch }) }, "Diff") : null),
        checkoutAfter(d, w, c)]),
      // What it said of itself: its colour as a dot (the word was the dot again), then its words.
      says ? el("div", { class: "line", "data-says": says.color }, el("span", { class: `said ${says.color}`, title: `its status: ${says.color} (desolate status set)` }), says.message) : null,
      merged ? el("div", { class: "line sub", "data-done": "" }, `Its work is merged: carry on in it as each checkout says, or ${running ? "Stop frees its memory, and " : ""}Delete removes it.`) : null,
      host.devcontainer ? el("div", { class: "line" }, pill(/^FAILED/.test(host.devcontainer) ? "devcontainer failed" : "devcontainer", /^FAILED/.test(host.devcontainer) ? "red" : "", "the project's devcontainer, in its VM"), " ", host.devcontainer.replace(/^up \(/, "(")) : null,
      sizeLine(d, w, running, making),
      agentsLine(d, w, host),
      (host.ports || []).length ? el("div", { class: "line" }, "dev servers: ", host.ports.map((p, i) => [i ? " " : "", el("a", { href: p.url, target: "_blank", rel: "noopener", class: "pill accent", title: `its server on port ${p.port}, at its own name` }, `:${p.port}`)])) : null,
      // A port this Mac holds (another user's program, often, on a shared Mac): the
      // workspace's server on it is not forwarded, and its address reaches that program.
      ...(host.heldOnMac || []).map((h) => el("div", { class: "line warn", "data-held-on-mac": String(h.port) }, `not forwarded: :${h.port}. This Mac's port ${h.port} is held (${h.by}), so the workspace's address on it reaches that program, not this workspace. Run it on another port.`)),
      // What else only the host knows of its forwarding (host/forward.ts, notesOf): listeners
      // left out, connections out it refused.
      ...(host.notes || []).map((note) => el("div", { class: "line warn", "data-host-note": "" }, note))),
    el("div", { class: "buttons" }, making ? null : [
      running && host.editor ? el("a", { class: "button", href: host.editor, target: "_blank", rel: "noopener", "data-editor": "" }, "Open editor") : null,
      running ? button("Stop", key, "workspace.stop", target, true) : button("Start", key, "workspace.start", target),
      remove]));
};

/** The base a reviewed branch, at the commit reviewed, has landed in (pushed.ts), or null. */
const landedIn = (slug, review) => {
  const d = state.domains.find((x) => x.slug === slug);
  const b = d && branchesOf(d).find((b) => b.repo === review.repo && b.branch === review.branch && b.commit === review.commit);
  return b && b.landed ? b.landed : null;
};
/** A domain's branches shown: the snapshot's first page (those checked out first), then the
 *  pages asked for since (GET /branches), each branch once. */
const branchesMore = new Map(); // slug -> { items, asking, error }
const branchesOf = (d) => {
  const seen = new Set();
  return [...d.branches.items, ...((branchesMore.get(d.slug) || {}).items || [])].filter((b) => {
    const key = `${b.repo}\n${b.branch}`;
    return seen.has(key) ? false : (seen.add(key), true);
  });
};
const moreBranches = async (d, from) => {
  const more = branchesMore.get(d.slug) || { items: [] };
  branchesMore.set(d.slug, { ...more, asking: true, error: "" });
  render();
  try {
    const response = await fetch(`/branches?domain=${encodeURIComponent(d.slug)}&from=${from}`, { headers: window.desolateKey.headers });
    const page = await response.json();
    if (!response.ok) throw new Error(page.error || `HTTP ${response.status}`);
    branchesMore.set(d.slug, { items: [...more.items, ...page.items] });
  } catch (error) {
    branchesMore.set(d.slug, { ...more, error: `the rest could not be had: ${error.message}` });
  }
  render();
};
/** Every branch a domain has (its own list), offered or not: each one reviewable. */
const branchList = (d) => {
  const list = branchesOf(d);
  if (!list.length) return null;
  const more = branchesMore.get(d.slug) || {};
  const shown = { items: list, total: d.branches.total };
  const offered = (b) => state.offers.some((o) => o.domain === d.slug && o.repo === b.repo && o.branch === b.branch && o.commit === b.commit);
  const where = (b) => d.workspaces.filter((w) => w.checkouts.some((c) => c.repo === b.repo && c.head && c.head.branch === b.branch)).map((w) => w.workspace);
  const open = branchesOpen.has(d.slug);
  return el("details", { class: "branches", open, "data-branches": d.slug },
    el("summary", { onclick: (event) => { event.preventDefault(); if (open) branchesOpen.delete(d.slug); else branchesOpen.add(d.slug); render(); } }, `Branches (${shown.total > list.length ? `${list.length} of ${shown.total}` : list.length})`),
    el("ul", { class: "rows" }, list.map((b) => el("li", { "data-branch": `${b.repo}/${b.branch}` },
      el("span", { class: `dot ${offered(b) ? "blue" : "hollow"}`, title: offered(b) ? "offered" : "not offered" }),
      el("div", { class: "what" },
        el("div", { class: "name" }, named("branch", b.branch), " ", named("repo", b.repo),
          offered(b) ? pill("offered", "blue", "a workspace offered it for you to review and push") : null,
          b.landed ? pill(`merged into ${b.landed}`, "green", "at this commit, merged on the remote") : null,
          b.pushed ? pill(`pushed ${short(b.pushed.commit)}`, "green", `desolate pushed ${b.pushed.commit} to the remote's ${b.branch}`) : null),
        el("div", { class: "line" }, el("span", { class: "mono" }, short(b.commit)), where(b).length ? [" · checked out in ", where(b).map((w) => named("workspace", w))] : "")),
      el("div", { class: "buttons" }, pullRequestOf(b), el("button", { class: "quiet", onclick: () => openReview({ domain: d.slug, repo: b.repo, branch: b.branch }) }, "Review"))))),
    list.length < shown.total
      ? el("div", { class: "sub more", "data-branches-more": d.slug }, andMore(shown, "branch", "branches"), " ",
          el("button", { class: "quiet small", type: "button", disabled: Boolean(more.asking), onclick: () => moreBranches(d, d.branches.items.length + (more.items || []).length) }, more.asking ? "Reading..." : "Show more"),
          more.error ? el("span", { class: "warn" }, ` ${more.error}`) : null)
      : null);
};
const branchesOpen = new Set();

/** The workspace a domain starts with: each repository on its default branch (its main
 *  checkout), named after those branches. Repositories whose default branches differ (main
 *  and master) give a name of both, and the card says so. */
const defaultsOf = (d) => d.repos.map((repo) => ({ repo, branch: (state.repos.find((r) => r.repo === repo) || {}).defaultBranch || "main" }));
const defaultWorkspaceName = (branches) => {
  const name = [...new Set(branches)].join("-").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, state.bounds.slug).replace(/-+$/, "") || "main";
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

/** What New workspace makes, said before the click: its name (w1, w2... when none is typed,
 *  as the root names one: domains.ts plan), and for each repository the branch it is on: the
 *  domain's own checkout of the default branch while no workspace holds it, else a new
 *  branch named after the workspace, from the default branch (nothing said so: dogfooding,
 *  2026-11-21). */
const newNames = new Map(); // slug -> the name typed
const newEnvs = new Map(); // slug -> the repository whose environment was chosen
const newWorkspace = (d) => {
  let name = newNames.get(d.slug) || "";
  for (let n = 1; !name; n++) if (!d.workspaces.some((w) => w.workspace === `w${n}`)) name = `w${n}`;
  const held = (repo) => d.workspaces.some((w) => w.checkouts.some((c) => c.repo === repo && c.kind === "main"));
  const env = d.env && (newEnvs.get(d.slug) || d.env.used);
  return { name, held, env, chosen: Boolean(env && d.env.used && env !== d.env.used) };
};
/** Another repository's environment (a domain with a python API and a node front end): its
 *  checkouts are named, that one's first, as `desolate up --checkout` would be (dogfooding,
 *  2026-11-22: the page always gave the first repository's). */
const newCheckouts = (d) => {
  const { name, held, env } = newWorkspace(d);
  const repos = [env, ...d.repos.filter((r) => r !== env)];
  return repos.map((repo) => `${repo}=${held(repo) ? `worktree:${name}` : "main"}`).join(",");
};
const newWorkspaceSays = (d) => {
  const { name, held, env } = newWorkspace(d);
  return el("div", { class: "line sub", "data-new-workspace-says": d.slug }, `New workspace makes ${name}: `,
    defaultsOf(d).map((x, i) => [i ? "; " : "", el("span", { class: "mono" }, x.repo), held(x.repo) ? [" on a new branch ", el("span", { class: "mono" }, name), ` from ${x.branch}`] : [" on ", el("span", { class: "mono" }, x.branch), ", the domain's own checkout"]]), ".",
    env ? [" It runs ", el("span", { class: "mono", "data-new-workspace-env": env }, env), "'s devcontainer."] : null);
};

/** The domain `desolate clone` made a repository (owner--repo), for that repository alone. */
const homeTip = (repo) => `${repo}'s home domain: desolate made it when ${repo} was cloned, for that repository alone. Its workspaces see ${repo} and nothing else, with this domain's own secrets and network rules. To work on ${repo} together with other repositories, make a new domain with them (New domain below): each domain is a trust boundary of its own.`;

const domainCard = (d) => {
  const key = `up:${d.slug}`;
  const foldKey = `domain:${d.slug}`;
  const isFolded = folded.has(foldKey);
  const others = state.repos.filter((r) => !d.repos.includes(r.repo));
  const running = d.workspaces.filter((w) => w.host && w.host.status === "running").length;
  const head = el("div", { class: "top fold-head", title: isFolded ? "Show this domain" : "", onclick: (event) => { if (!event.target.closest("button, a, input, select, label, .pill[title], [data-goto]")) toggleFold(foldKey); } },
    el("button", { class: "fold", type: "button", "aria-expanded": String(!isFolded), "aria-label": isFolded ? "show this domain" : "hide this domain", onclick: () => toggleFold(foldKey) }),
    // Its name (what commands and workspaces use), then its title if it says more than the
    // name or its one repository already do.
    el("h3", {}, named("domain", d.slug, d.title ? `the domain ${d.slug}, titled "${d.title}" (desolate domain ${d.slug} show)` : `the domain ${d.slug} (desolate domain ${d.slug} show)`)),
    d.title && d.title !== d.slug && !(d.repos.length === 1 && d.repos[0] === d.title) ? el("span", { class: "domain-title", title: "the domain's title" }, d.title) : null,
    d.home ? pill("home domain", "accent", homeTip(d.home), { "data-home": d.home }) : null,
    el("span", { class: "grow" }),
    d.building ? pill("building", "blue pulse", "its environment is being built: before its first workspace, and again when the project's devcontainer or desolate's own VM image has changed")
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
        el("div", { class: "what" }, el("div", { class: "name" }, "Building this domain's environment", pill("being built", "blue pulse", "its workspaces start from it: built before the first, and again when the project's devcontainer or desolate's own VM image has changed since")),
          d.building.line ? el("div", { class: "line sub" }, redact(d.building.line)) : null)) : null,
      d.workspaces.map((w) => workspaceRow(d, w))),
    firstOne ? firstWorkspace(d) : null,
    (state.issues || []).some((i) => i.domain === d.slug && i.state === "published") ? el("div", { class: "line sub", "data-published-issues": "" }, "Issues published lately: ",
      (state.issues || []).filter((i) => i.domain === d.slug && i.state === "published").map((i, n) => [n ? ", " : "", i.url && /^https:\/\/github\.com\//.test(i.url) ? el("a", { href: i.url, target: "_blank", rel: "noopener noreferrer" }, i.title) : i.title])) : null,
    branchList(d),
    d.repos.length ? el("form", { class: "inline", onsubmit: (event) => { event.preventDefault();
      const args = newWorkspace(d).chosen ? { domain: d.slug, workspace: newWorkspace(d).name, checkouts: newCheckouts(d) } : { domain: d.slug, workspace: event.target.elements.name.value.trim() };
      event.target.reset(); newNames.delete(d.slug); newEnvs.delete(d.slug);
      act(key, "workspace.up", args); } },
      el("input", { name: "name", placeholder: "name (optional)", pattern: slugPattern(), "aria-label": "workspace name", oninput: (event) => { newNames.set(d.slug, event.target.value.trim()); render(); } }),
      d.env && d.env.choices.length > 1 ? el("select", { name: "env", "aria-label": "whose devcontainer it runs", title: "Whose devcontainer the workspace runs: each repository with one", "data-new-workspace-env-choice": d.slug, onchange: (event) => { newEnvs.set(d.slug, event.target.value); render(); } },
        d.env.choices.map((repo) => el("option", { value: repo, selected: repo === newWorkspace(d).env }, `${repo}'s environment`))) : null,
      el("button", { class: firstOne ? "quiet" : "", disabled: busy.has(key), title: "A workspace of its own: a VM with the repositories. The first takes each one's default branch (brought up to the remote's when it has nothing of its own); each after it, a branch named after it" }, busy.has(key) ? "Starting..." : "New workspace")) : null,
    d.repos.length ? newWorkspaceSays(d) : null,
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
  const slug = el("input", { name: "slug", required: true, pattern: slugPattern(), placeholder: "name: lower-case letters, digits, dashes", "aria-label": "the new domain's name", class: "wide" });
  // (What the dashboard may ask the host for: shared/actions.ts takes a title of 80 plain
  // characters, and the root refuses a longer one in words rather than make the domain
  // without it.)
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

/** The chip that says how things stand: an action's error, until dismissed; the root lost
 *  (the event stream has failed a few times in a row); or whether the host is connected. */
const drawHost = () => {
  const host = document.getElementById("host");
  const lostRoot = lost >= STREAM.sayAfter;
  host.className = `chip ${notice || lostRoot || (state && !state.hostConnected) ? "bad" : ""}`;
  if (notice) host.replaceChildren(el("span", { "data-notice": "" }, notice), " ", el("button", { class: "quiet small", type: "button", "data-dismiss": "", title: "Dismiss this", onclick: () => { notice = ""; render(); } }, "Dismiss"));
  else host.textContent = lostRoot ? `lost the root's dashboard service: trying again (${lost} tries so far). What is shown is as it last was.`
    : !state ? "connecting to the root..."
      : state.hostConnected ? "host connected" : "host not connected: VM states are as last known; run `desolate bootstrap` on the host";
};
/** "Needs you" rows come and go as anyone's pushes and offers do, and moved what was below
 *  them under the pointer: a click landed in the gap they left (dogfooding, 2026-11-21). With
 *  the pointer below them, what is there stays put: the page scrolls by what they grew, and
 *  holds the room of what they shrank, until the pointer goes above it or leaves the page. */
let pointerY = null;
let held = 0;
const hold = (px) => {
  held = Math.max(0, px);
  document.getElementById("domains-section").style.marginTop = held ? `${held}px` : "";
};
const keepPut = (change) => {
  const below = document.getElementById("domains-section");
  const before = below.getBoundingClientRect().top;
  change();
  if (pointerY === null || pointerY < before) return hold(0);
  const moved = below.getBoundingClientRect().top - before;
  if (moved < 0) return hold(held - moved);
  const taken = Math.min(held, moved);
  hold(held - taken);
  if (moved > taken) window.scrollBy(0, moved - taken);
};
document.addEventListener("pointermove", (event) => {
  pointerY = event.clientY;
  if (held && pointerY < document.getElementById("domains-section").getBoundingClientRect().top) hold(0);
});
document.documentElement.addEventListener("mouseleave", () => { pointerY = null; hold(0); });

const render = () => {
  if (!state) return drawHost();
  const stack = document.getElementById("stack");
  stack.textContent = state.stack ? (state.stack.isolated ? `${state.stack.backend} VMs` : "NOT ISOLATED: fake backend") : "stack: unknown";
  stack.className = `chip ${state.stack && !state.stack.isolated ? "bad" : ""}`;
  // Every editor's defaults: a page of the Mac's own (as the secrets are), not this one's.
  const defaults = document.getElementById("editor-defaults");
  defaults.hidden = !(state.stack && state.stack.approveHostname);
  if (!defaults.hidden) defaults.href = `http://${state.stack.approveHostname}:${state.stack.editorPort}/editor-defaults`;
  drawHost();
  const needs = needsYou();
  keepPut(() => {
    document.getElementById("needs").hidden = needs.length === 0;
    document.getElementById("needs-list").replaceChildren(...needs);
  });
  // (Where the diff was scrolled to, kept: its element is the same one, moved.)
  const scrolled = shownDiff && shownDiff.node.isConnected ? [...shownDiff.node.querySelectorAll("[data-diff]")].map((n) => [n, n.scrollTop, n.scrollLeft]) : [];
  // (And where the review's lists were scrolled to: they are drawn again, and grow as the
  // person asks for more.)
  const lists = ["#review ol.commit-list", "#review ul.files"].map((at) => [at, document.querySelector(at)?.scrollTop || 0]);
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
  for (const [at, top] of lists) { const node = document.querySelector(at); if (node) node.scrollTop = top; }
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
  // (replaceChildren writes a null as the text "null", el() does not: the stray "null" under
  // the domain cards, seen by every tester on 2026-11-20.)
  document.getElementById("domains").replaceChildren(...shown.map(domainCard),
    ...(shown.length === 0 && state.domains.length ? [el("div", { class: "sub" }, `No domain matches “${domainFilter}”.`)] : []));
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
      a.earlier ? el("div", { class: "sub", "data-action-earlier": "" }, `${a.earlier.toLocaleString()} earlier line${a.earlier === 1 ? "" : "s"} not shown`, a.log ? ["; all of it: ", el("span", { class: "mono" }, a.log), " in the root VM (desolate root shell)"] : "") : null,
      a.lines.length ? el("pre", { class: "mono" }, a.lines.map(redact).join("\n")) : null),
    el("div", { class: "buttons" }, typeof a.link === "string" && a.link.startsWith("https://github.com/")
      ? el("a", { class: "button", href: a.link, target: "_blank", rel: "noopener noreferrer", "data-pull-request": "" }, "Open pull request") : null))));
  document.title = needs.length ? `(${needs.length}) desolate` : "desolate";
};

// `?review&domain=<d>&repo=<owner/repo>&branch=<b>[&against=domain]`: open that branch's
// review when the state first shows its domain with that repository. A link to a review, for
// `desolate review` to print, for a screenshot, and for a reload. It names a branch; it
// carries nothing that is run.
const asked = new URLSearchParams(location.search);
let pending = asked.has("review");
const arrived = (now) => {
  state = now;
  render();
  // The remote fetched, or the branch moved or pushed, while its review is open: read again.
  if (reviewing && !reviewing.loading && reviewMark(reviewing.offer) !== reviewing.mark) openReview(reviewing.offer, reviewing.against);
  if (!pending) return;
  const d = state.domains.find((x) => x.slug === asked.get("domain"));
  if (d && d.repos.includes(asked.get("repo")) && asked.get("branch")) {
    pending = false;
    openReview({ domain: d.slug, repo: asked.get("repo"), branch: asked.get("branch") }, asked.get("against") === "domain" ? "domain" : "origin");
  }
};
/** The event stream, tried again when it fails: at once nearly (a root restarting is back in
 *  a second or two), then a little later each time, to half a minute; after a few failures in
 *  a row the page says the root is lost, and that it is trying (it tried every 1.5 s, saying
 *  nothing, and drew what it last had as if it were now). */
const STREAM = { firstMs: 1500, mostMs: 30_000, sayAfter: 3 };
let lost = 0;
const listen = () => {
  const events = new EventSource(`/events?${window.desolateKey.query}`);
  events.onmessage = (event) => {
    lost = 0;
    arrived(JSON.parse(event.data));
  };
  events.onerror = () => {
    events.close();
    lost += 1;
    if (lost >= STREAM.sayAfter) drawHost();
    setTimeout(listen, Math.min(STREAM.mostMs, STREAM.firstMs * 2 ** (lost - 1)));
  };
};
// The page's own controls, made once: folding a section, the filters, a new domain, and the
// review's width.
for (const button of document.querySelectorAll("button.fold[data-fold]")) button.addEventListener("click", () => toggleFold(button.dataset.fold));
document.getElementById("domain-filter").value = domainFilter;
document.getElementById("domain-filter").addEventListener("input", (event) => {
  domainFilter = event.target.value.trim().toLowerCase();
  try {
    localStorage.setItem("desolate-domain-filter", domainFilter);
  } catch {
    /* kept for now */
  }
  render();
});
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
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && reviewing) closeReview(); });
})();

// `?once`: the state as it is now, drawn once, with no stream left open. For a screenshot
// or a printed page; the dashboard itself always listens.
if (asked.has("once")) fetch("/state", { headers: window.desolateKey.headers }).then((response) => response.json()).then(arrived);
else listen();
