// The approval page's script. Everything it puts on the page is text (textContent), never
// markup: a commit's subject or a file's name is whatever an agent wrote.
//
// Arming. The Approve button takes a click only when (1) the page has been visible and
// focused for a second, (2) the card has been on the page, unchanged, for a second, (3) the
// pointer has then MOVED over the button (a card shifted under a still pointer arms
// nothing), and (4) a third of a second has passed since. Any change to the page (a card
// added, gone, or its summary arriving) disarms every button. Keys do not approve.
//
// Embedded beside the git terminal (/embed, approve-web.ts): the key from the address's
// fragment is the credential (sent as a header), the pointer over the frame counts as
// attention (the terminal keeps the focus until a click), and where the browser can tell
// (IntersectionObserver v2) a button arms only while it is visibly unobscured.
"use strict";
// Embedded only if it is a frame: the page at /embed opened as a window is not.
const EMBED = location.pathname === "/embed" && window.top !== window;
const embedKey = EMBED ? (/^#k=([0-9a-f]{64})$/.exec(location.hash) || [])[1] || "" : "";
if (EMBED) {
  history.replaceState(null, "", "/embed");
  document.documentElement.classList.add("embed");
}
// Otherwise the page's own key, beside its cookie (shared/ui/page-key.js).
const credential = embedKey ? { "x-desolate-embed": embedKey } : EMBED ? {} : window.desolateKey.headers;
// In the frame the key alone signs in: the cookie, if this browser has one, stays out.
const sendCookie = EMBED ? "omit" : "same-origin";
const VISIBILITY = EMBED && "IntersectionObserver" in window && "isVisible" in IntersectionObserverEntry.prototype;
let pointerInside = false;
const READY_MS = 1000;
const DWELL_MS = 300;
/** How long a word about a click stays before the hint says again what arming waits for. */
const SAID_MS = 3000;
const list = document.getElementById("list");
const status = document.getElementById("status");
const template = document.getElementById("card");
const cards = new Map(); // the push's token (over its exact text) -> card
// The push this tab was opened for: the dashboard's Push names it in the address's fragment
// (which the host never sees). Its card, if one names exactly that, is marked and scrolled to
// once; it arms and signs as any other.
const askedFor = EMBED ? {} : Object.fromEntries(new URLSearchParams(location.hash.slice(1)));

const attending = () => document.visibilityState === "visible" && (document.hasFocus() || (EMBED && pointerInside));
let attentiveSince = attending() ? performance.now() : 0;
// Losing attention disarms. Gaining it does not (a page that just got it cannot arm for a
// second anyway), and must not: in a frame, the click on Approve is also what focuses it.
const attention = () => {
  const now = attending();
  if (!now) {
    attentiveSince = 0;
    disarmAll();
  } else if (attentiveSince === 0) attentiveSince = performance.now();
};
document.addEventListener("visibilitychange", attention);
window.addEventListener("focus", attention);
window.addEventListener("blur", attention);
if (EMBED) {
  document.documentElement.addEventListener("pointerenter", () => { pointerInside = true; attention(); });
  document.documentElement.addEventListener("pointerleave", () => { pointerInside = false; attention(); });
}
// Each card's Approve buttons, as the browser sees them: drawn, whole, and under nothing.
const watcher = VISIBILITY ? new IntersectionObserver((entries) => {
  for (const entry of entries) {
    for (const card of cards.values()) {
      const arm = card.arms.find((a) => a.wrap === entry.target);
      if (!arm) continue;
      arm.visible = entry.isVisible && entry.intersectionRatio >= 0.99;
      if (!arm.visible) disarm(card);
    }
  }
}, { threshold: [0, 1], trackVisibility: true, delay: 100 }) : null;

const say = (text) => { status.textContent = text; };
const el = (tag, text, cls) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (cls) node.className = cls; return node; };

// A push that replaces the remote's branch arms only once its name is typed: a step of its
// own, apart from the click (the host refuses the approval without it, too: approve-web.ts).
const confirmed = (card) => !card.replaces || card.typed;
// And a push arms only once the reviewer has said what it sends, and the page shows it: what
// is signed is that (the host signs no other: approve-web.ts).
const reviewedOf = (card) => Boolean(card.issue) || card.reviewed;
// And only while the page's last look at what waits worked: a page that cannot see the list
// cannot see that what it shows has changed.
let current = false;
const ready = (card, arm) => current && reviewedOf(card) && attentiveSince !== 0 && performance.now() - attentiveSince >= READY_MS && performance.now() - card.changedAt >= READY_MS && arm.visible !== false && !arm.wrap.hidden && confirmed(card);
const armedOf = (card) => card.arms.find((a) => a.armedAt);
const disarm = (card) => {
  for (const arm of card.arms) { arm.armedAt = 0; if (!card.done) arm.button.disabled = true; }
  if (card.done || performance.now() < card.saidUntil) return;
  arming(card, whyNotArmed(card));
};
/** The hint while arming: one line, cut if it must (approve.css), so it never changes the
 *  bar's height under the pointer. */
const arming = (card, text) => { card.hint.classList.remove("said"); card.hint.textContent = text; card.hint.title = text; };
/** What happened, in full (it may take lines): kept until the next arming. */
const said = (card, text) => {
  card.hint.classList.add("said"); card.hint.textContent = text; card.hint.title = ""; card.saidUntil = Infinity;
  // Decided: nothing on it takes keys any more.
  if (card.done) for (const input of card.element.querySelectorAll("input")) input.disabled = true;
};
/** Why no button of `card` is armed now, as the hint says it. */
const whyNotArmed = (card) => {
  const first = card.arms.find((a) => !a.wrap.hidden);
  return !reviewedOf(card) ? "waiting for desolate's reviewer to say what it sends" : !confirmed(card) ? `type ${card.push.branch} above to replace it` : first && ready(card, first) ? "move the pointer on a button, then click a moment later" : "arming in a moment...";
};
const disarmAll = () => { for (const card of cards.values()) disarm(card); };
// Whatever changes a card's size (a card folded, a diff opened, what happened said on one, as
// late as the pusher's word) moves every Approve below it: each waits its second again.
// So does the page scrolling: it moves Approve under a pointer that did not move.
const moved = () => { for (const card of cards.values()) card.changedAt = performance.now(); disarmAll(); };
new ResizeObserver(moved).observe(list);
window.addEventListener("scroll", moved, { passive: true });
setInterval(() => { for (const card of cards.values()) if (!armedOf(card) && !card.done) disarm(card); }, 250);
setInterval(() => { for (const card of cards.values()) if (card.tick && !card.done) card.tick(); }, 1000);

/** Beside the git terminal: the person decided, so its page may give the keys back to the
 *  shell once nothing waits (git.js). Only a number and a word, to that one origin. */
const tellTerminal = (message) => { if (EMBED && window.parent !== window) window.parent.postMessage(message, location.origin.replace("//desolate-approve.", "//desolate-git.")); };
// A key typed in the pane: the person is still at work here (git.js keeps the keys here).
document.addEventListener("keydown", () => tellTerminal({ desolateTyping: true }), true);
const post = async (what, card, squash) => {
  const sent = card.issue ? { path: "/issue", body: { id: card.issue.id, token: card.issue.token, do: what === "approve" ? "publish" : "refuse" } } : { path: `/${what}`, body: { nonce: card.push.nonce, token: card.push.token, shown: card.push.shown, commit: card.push.commit, squash: squash === true, replace: card.replaces && card.typed } };
  const answer = await fetch(sent.path, { method: "POST", headers: { "content-type": "application/json", ...credential }, body: JSON.stringify(sent.body), credentials: sendCookie });
  const body = await answer.json().catch(() => ({}));
  if (!answer.ok) throw new Error(body.error || `HTTP ${answer.status}`);
  return body;
};

// The diff, as text: each line a text node in a span classed by its first character.
// What reorders or hides what is shown (controls, bidi and other format characters, what
// shows nothing: the classes shared/text.ts's printable replaces, and the blank Braille
// pattern), but for a tab and a carriage return that ends a line: in a diff a person
// approves from, each is shown as itself, named, so the line reads as git stores it.
const HIDES = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}\u034f\u115f\u1160\u17b4\u17b5\u180b-\u180f\u2800\u3164\uffa0\u{e0100}-\u{e01ef}]|(?<=[\ufe00-\ufe0f])[\ufe00-\ufe0f]/gu;
const unhidden = (line) => line.replace(HIDES, (c, at) => c === "\t" || c === "\n" || (c === "\r" && (at + 1 === line.length || line[at + 1] === "\n")) ? c : `⟨U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}⟩`);
const kindOf = (line) => line.startsWith("diff --git") ? "file" : line.startsWith("@@") ? "hunk" : line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "del" : "";
/** git's text, a line a span; given `tokens` (shared/ui/highlight.js), each line of code in
 *  its syntax's colours, its text unchanged. */
const diffView = (text, tokens) => {
  const pre = el("pre", undefined, "diff");
  text.split("\n").forEach((line, i) => {
    const span = el("span", undefined, kindOf(line));
    const code = tokens && tokens[i];
    // (Coloured, unhidden sees a token at a time: a line with a carriage return inside it is
    // shown plain, where the return is named.)
    if (code && !/\r(?!$)/.test(line) && typeof DesolateHighlight !== "undefined") span.append(document.createTextNode(line[0]), ...DesolateHighlight.paint(code, unhidden));
    else span.textContent = unhidden(line) || " ";
    pre.append(span);
  });
  return pre;
};
/** What the host is asked for a push the card shows: by its nonce and the token over its very
 *  text, as an approval is. */
const askHost = async (card, what, query) => {
  const answer = await fetch(`/${what}?nonce=${card.push.nonce}&token=${card.push.token}&${query}`, { credentials: sendCookie, headers: credential });
  const body = await answer.json().catch(() => ({}));
  if (!answer.ok) throw new Error(body.error || `HTTP ${answer.status}`);
  return body;
};
/** Anything added to a card changes it: Approve disarms, and arms again only as it always does. */
const changed = (card) => { card.changedAt = performance.now(); disarm(card); };
/** A diff, asked of desolate's reviewer a page at a time (its bytes from `from` up to `next`):
 *  the first when opened, the next when the person asks for more. Nothing is cut: a long diff
 *  is a longer read, never a shorter one. */
const diffToggle = (card, labels, query) => {
  const box = el("div", undefined, "diffbox");
  const button = el("button", labels[0], "quiet");
  button.type = "button";
  let open = false;
  const page = async (from) => {
    const waiting = el("p", "asking desolate's reviewer...", "hint");
    box.append(waiting);
    try {
      const { diff } = await askHost(card, "diff", `${query}&from=${from}`);
      waiting.remove();
      if (!open) return;
      const shown = diffView(diff.text);
      box.append(shown);
      // Its colours, when the worker has them (or never: the diff stays plain). The text is the
      // same; the card is redrawn all the same, so Approve disarms again.
      if (typeof DesolateHighlight !== "undefined")
        DesolateHighlight.tokensFor(diff.text).then((tokens) => {
          if (!open || !shown.isConnected || !tokens.some(Boolean)) return;
          const coloured = diffView(diff.text, tokens);
          shown.replaceWith(coloured);
          changed(card);
        });
      if (diff.next !== null) {
        const more = el("button", `Show more of it (${size(diff.next)} of ${size(diff.total)} shown)`, "quiet");
        more.type = "button";
        more.addEventListener("click", (event) => { if (!event.isTrusted) return; more.remove(); void page(diff.next); });
        box.append(more);
      } else if (diff.total === 0) box.append(el("p", "No change.", "hint"));
    } catch (error) {
      waiting.remove();
      box.append(el("p", `the diff could not be had: ${error.message}`, "error"));
    }
    changed(card);
  };
  button.addEventListener("click", (event) => {
    if (!event.isTrusted) return;
    open = !open;
    button.textContent = open ? labels[1] : labels[0];
    box.replaceChildren();
    if (open) void page(0);
    changed(card);
  });
  return [button, box];
};

/** A size, as desolate writes one (shared/limits.ts, formatBytes: the page cannot import it). */
const size = (bytes) => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KiB` : bytes < 1024 * 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MiB` : `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GiB`;
const count = (n) => Number(n).toLocaleString("en-US");
/** What the reviewer says it is doing: "packing (1,200 of 8,000), 2 min". */
const workingText = (w) => `${w.phase}${w.of !== undefined ? ` (${count(w.done || 0)} of ${count(w.of)})` : w.done !== undefined ? ` (${count(w.done)})` : ""}${w.seconds >= 60 ? `, ${Math.floor(w.seconds / 60)} min` : w.seconds >= 5 ? `, ${w.seconds} s` : ""}`;

/** A list of the account (`listed`: a page of it, and the true total) as `ul`, each item by
 *  `line`, with a button for the rest before it and after it: asked of the reviewer a page
 *  at a time (/page), never cut. `onPage`: told of each page added, in order. */
const pagedList = (card, name, listed, ul, line, noun, onPage) => {
  let first = listed.from;
  let end = listed.from + listed.items.length;
  const before = el("button", "", "quiet more");
  const after = el("button", "", "quiet more");
  before.type = after.type = "button";
  const label = () => {
    before.hidden = first <= 0;
    before.textContent = `Show the ${count(first)} ${noun} before these`;
    after.hidden = end >= listed.total;
    after.textContent = `Show ${count(listed.total - end)} more ${noun}`;
  };
  const add = (items, at) => {
    const nodes = items.map(line).filter(Boolean);
    if (at === "start") ul.prepend(...nodes);
    else ul.append(...nodes);
  };
  const ask = async (from, at) => {
    const button = at === "start" ? before : after;
    button.disabled = true;
    try {
      const { page } = await askHost(card, "page", `list=${name}&from=${from}`);
      if (at === "start") {
        const items = page.items.slice(0, Math.max(0, first - page.from));
        add(items, "start");
        first = Math.min(first, page.from);
      } else {
        // Only the page asked for, holding something: anything else ends the list, said.
        if (page.from !== from || page.items.length === 0) throw new Error("the reviewer gave another page than the one asked for");
        const items = page.items.slice(Math.max(0, end - page.from));
        add(items, "end");
        end = Math.max(end, page.from + page.items.length);
        if (onPage) onPage(items);
      }
      label();
    } catch (error) {
      button.textContent = `the rest could not be had: ${error.message}`;
    }
    button.disabled = false;
    changed(card);
  };
  before.addEventListener("click", (event) => { if (event.isTrusted) void ask(Math.max(0, first - 100), "start"); });
  after.addEventListener("click", (event) => { if (event.isTrusted) void ask(end, "end"); });
  add(listed.items, "end");
  label();
  return { before, after, more: () => ask(end, "end"), done: () => end >= listed.total };
};

/** A file whose name only looks like one that runs on the forge, or like README.md: said
 *  under it (the reviewer's lookalike). */
const looks = (f) => f.lookalike ? el("span", "its name has letters that look like others", "looks") : null;

const summaryOf = (review, card) => {
  const box = document.createDocumentFragment();
  if (!review || review.working) {
    // No deadline: the person waits as long as they choose to, or refuses (R4). How long, the
    // page counts from what the host said (the host tells it only what changes).
    // What it is doing, on one line (approve.css): ticking each second, it never changes the
    // card's height, which would make every card wait its second again.
    const p = el("p", undefined, "working");
    const since = performance.now() - (review ? review.working.seconds * 1000 : 0);
    const say = () => { p.textContent = `desolate's reviewer is working out what this push would send: ${review ? workingText({ ...review.working, seconds: Math.floor((performance.now() - since) / 1000) }) : "starting"}`; p.title = p.textContent; };
    say();
    if (card) card.tick = say;
    box.append(p, el("p", "It may take a while for a large push; Approve arms when it has said. Or refuse it."));
    return box;
  }
  if (!review.account) {
    box.append(el("p", `desolate's reviewer could not say what this push would send: ${review.error || "no answer"}. It cannot be approved: what the reviewer makes is what a push sends. Refuse it, and push again.`, "error"));
    return box;
  }
  const account = review.account;
  // Every warning: none is ever one of "and 3 more".
  for (const warning of account.warnings) box.append(el("p", `Warning: ${warning}`, "error"));
  if (account.fastForward === false) box.append(el("p", "This does not build on the remote's branch: it REPLACES it, and the commits only the remote has are dropped from the branch. To do that, type the branch's name below.", "error"));
  // After a squashed push the remote's branch is the squash, and the workspace's is not on
  // it: most likely nothing would be lost, and a rebase in the workspace is the way on.
  const branch = card.push && card.push.branch;
  if (account.fastForward === false && /^[0-9a-f]{40}$/.test(account.squashedFrom || "") && /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(branch || "")) {
    const p = el("p", `The remote's ${branch} is the squash of ${account.squashedFrom.slice(0, 12)}, a commit of this branch, pushed before. To build on it instead, refuse this, and in the workspace run `);
    p.append(el("code", `git fetch && git rebase --rebase-merges --autostash --onto origin/${branch} ${account.squashedFrom} ${branch}`), document.createTextNode(", then push again."));
    box.append(p);
  }
  const commits = account.commits;
  box.append(el("p", commits.total ? `${count(commits.total)} commit(s) the remote does not have, first to last:` : "No commit the remote does not have already."));
  // A long list scrolls in a box of its own: the card stays short enough that Approve is in
  // view, and what is scrolled away is never what needs attention (see the files below).
  // Its id, its subject, and who wrote it, quieter: the subject is what is read.
  if (commits.total) {
    const ul = el("ul", undefined, commits.total > 8 ? "long" : "");
    const list = pagedList(card, "commits", commits, ul, (c) => { const li = el("li", undefined, "commit"); li.append(el("code", c.commit.slice(0, 12)), el("span", ` ${c.subject}`), el("span", `  by ${c.author}`, "who")); return li; }, "commits");
    box.append(list.before, ul, list.after);
  }
  const files = account.files;
  if (files.total) {
    box.append(el("p", `${count(files.total)} file(s) changed${account.base ? ` against ${account.base.slice(0, 12)}` : ""}:`));
    // What runs on the forge (CI workflows, hooks) or changes how git treats the repository:
    // listed in full, outside any scrolling box, before the rest. The reviewer lists them
    // first, so while a page ends with one the next is asked for at once: not one waits
    // behind "show more".
    const line = (f) => {
      const li = el("li", undefined, f.sensitive ? "file sensitive" : "file");
      // Lines added and removed in colour, as the dashboard's review shows them.
      li.append(el("code", f.path));
      if (f.binary) li.append(el("span", "binary", "who"));
      else li.append(el("span", `+${f.added}`, "add"), el("span", `−${f.removed}`, "del"));
      // Its own diff, asked for by its path (the reviewer takes it literally).
      const [button, box] = card ? diffToggle(card, ["Diff", "Hide its diff"], `file=${encodeURIComponent(f.path)}`) : [];
      li.append(...[button, looks(f), box].filter(Boolean));
      return li;
    };
    const sensitiveNote = el("p", "", "error");
    const sl = el("ul");
    const fl = el("ul", undefined, files.total > 8 ? "long" : "");
    let sensitive = 0;
    const note = () => { sensitiveNote.hidden = sensitive === 0; sensitiveNote.textContent = `${count(sensitive)} of them run on the forge, change how git treats the repository, or are suede's own machinery:`; };
    const sort = (items) => { for (const f of items) if (f.sensitive) { sl.append(line(f)); sensitive += 1; } note(); };
    // One list of the reviewer's, in two places on the page: its sensitive files above, the
    // rest in the box (a page's items are placed by where they are in the reviewer's list).
    let list = null;
    const onward = (items) => { if (items.length && items[items.length - 1].sensitive) void list.more(); };
    list = pagedList(card, "files", files, fl, (f) => (f.sensitive ? null : line(f)), "files", (items) => { sort(items); onward(items); });
    sort(files.items);
    box.append(sensitiveNote, sl, fl, list.after);
    onward(files.items);
  }
  // What the net change does not show: files a commit changes that end as they were (changed,
  // then changed back, or as the branch it replaces has them). Every commit is pushed, so what
  // they held is in the history all the same.
  const between = account.between;
  if (between.total) {
    box.append(el("p", `${count(between.total)} more file(s) that these commits change, though the list above (the net change) does not show them. Each commit is pushed, so what they held is in the branch's history:`, "error"));
    const bl = el("ul", undefined, between.total > 8 ? "long" : "");
    const list = pagedList(card, "between", between, bl, (f) => { const li = el("li", undefined, f.sensitive ? "file sensitive" : "file"); li.append(...[el("code", f.path), looks(f)].filter(Boolean)); return li; }, "files");
    box.append(list.before, bl, list.after);
  }
  // What goes, exactly as it is signed: the reviewer's pack, its size, and the LFS objects.
  box.append(el("p", `It sends one pack desolate's reviewer made of these commits, ${size(account.sends.size)}, and ${account.sends.lfs.count} LFS object(s) they point to${account.sends.lfs.count ? `, ${size(account.sends.lfs.bytes)}` : ""}: nothing else.`));
  if (card) {
    box.append(...diffToggle(card, ["Show the diff", "Hide the diff"], "net=1"));
    // Each commit whole (what was changed in between, too), one at a time, as asked for: its
    // whole message and who wrote it, for one commit too (the list above has its subject).
    if (commits.total || between.total) {
      const each = el("div", undefined, "diffbox");
      const button = el("button", "Show each commit whole", "quiet");
      button.type = "button";
      let open = false;
      button.addEventListener("click", (event) => {
        if (!event.isTrusted) return;
        open = !open;
        button.textContent = open ? "Hide each commit" : "Show each commit whole";
        each.replaceChildren();
        if (open) {
          const ul = el("ul");
          const list = pagedList(card, "commits", commits, ul, (c) => {
            const li = el("li", undefined, "whole");
            li.append(...diffToggle(card, [`${c.commit.slice(0, 12)} ${c.subject}`, `Hide ${c.commit.slice(0, 12)}`], `commit=${c.commit}`));
            return li;
          }, "commits");
          each.append(list.before, ul, list.after);
        }
        changed(card);
      });
      box.append(button, each);
    }
  }
  // The other choice: the same push as one commit (its tree is the last commit's), so nothing
  // in between reaches the history. Its whole message: it is what is signed.
  if (account.squash) {
    const sq = account.squash;
    box.append(el("p", `Or push it squashed into one commit, ${sq.commit.slice(0, 12)}, ${sq.parent ? `on ${sq.parent.slice(0, 12)}` : "with no parent"}: the same files as the last commit, and none of what was in between. The workspace's branch keeps its ${sq.count} commits.`));
    box.append(el("pre", `${sq.message}${sq.author ? `\nAuthor:    ${sq.author}\nCommitter: ${sq.committer}` : ""}${sq.dates ? `\n${sq.dates}` : ""}`, "message"));
    // What that choice sends, as it is signed: its own pack and LFS objects.
    box.append(el("p", `Squashed, it sends a pack of its own, ${size(sq.sends.size)}, and ${sq.sends.lfs.count} LFS object(s)${sq.sends.lfs.count ? `, ${size(sq.sends.lfs.bytes)}` : ""}: nothing else.`));
  }
  return box;
};

/** An issue to publish: every field as text, the body as the very Markdown sent. */
const issueElement = (issue) => {
  const element = document.getElementById("issue-card").content.firstElementChild.cloneNode(true);
  element.querySelector(".repo").textContent = issue.repo;
  element.querySelector(".title").textContent = unhidden(issue.title);
  const labels = element.querySelector(".labels");
  if (issue.labels.length) for (const label of issue.labels) labels.append(el("code", label));
  else labels.textContent = "none";
  element.querySelector(".from").textContent = `The root says: offered by ${issue.domain}/${issue.workspace}${issue.edited ? ", then edited on the dashboard" : ""}. What is sent is exactly what is shown here.${issue.labels.some((l) => /^desolate:/.test(l)) ? " A desolate: label may start an agent on it (recipes/issues.sh)." : ""}`;
  element.querySelector(".body").textContent = issue.body ? unhidden(issue.body) : "(no body)";
  return element;
};

const add = (push, issue) => {
  const element = issue ? issueElement(issue) : template.content.firstElementChild.cloneNode(true);
  if (!issue) {
    element.querySelector(".repo").textContent = push.repo;
    element.querySelector(".branch").textContent = push.branch;
    element.querySelector(".commit").textContent = push.commit;
    element.querySelector(".onto").textContent = push.onto ? `The remote's ${push.branch} moves from ${push.onto} to this commit, or not at all.` : `The remote has no ${push.branch}: this creates it.`;
  }
  const arms = [...element.querySelectorAll(".arm")].map((wrap) => ({ wrap, button: wrap.querySelector("button"), squash: wrap.classList.contains("squash"), armedAt: 0, visible: VISIBILITY ? false : undefined }));
  const card = { element, push, issue, arms, hint: element.querySelector(".hint"), summary: element.querySelector(".summary"), changedAt: performance.now(), saidUntil: 0, done: false, busy: false, shown: "", replaces: false, typed: false, reviewed: false };
  for (const arm of arms) {
    if (watcher) watcher.observe(arm.wrap);
    // (A disabled button gets no pointer events in every browser: these are on its wrapper,
    // and the button lets them through while disabled: approve.css.)
    arm.wrap.addEventListener("pointermove", (event) => {
      if (card.done || card.busy || arm.armedAt || !ready(card, arm)) return;
      if (event.movementX === 0 && event.movementY === 0) return;
      disarm(card);
      arm.armedAt = performance.now();
      arm.button.disabled = false;
      card.saidUntil = 0;
      arming(card, issue ? "armed: click to publish" : "armed: click to approve");
    });
    arm.wrap.addEventListener("pointerleave", () => disarm(card));
    // A click on a button not armed (the wrapper has it: approve.css) does nothing, and says
    // why, for a few seconds: a click ignored in silence read as a page that did not work.
    arm.wrap.addEventListener("click", () => {
      if (arm.armedAt || card.done || card.busy) return;
      arming(card, `not armed yet: ${whyNotArmed(card)}`);
      card.saidUntil = performance.now() + SAID_MS;
    });
    arm.button.addEventListener("click", async (event) => {
      // A real pointer's click, on a button armed a moment ago: not a key, not a script.
      if (!event.isTrusted || event.detail === 0 || !arm.armedAt || card.busy || card.done || !confirmed(card)) return;
      // Armed a moment ago, and clicked at once: said, so the person knows to rest a moment.
      if (performance.now() - arm.armedAt < DWELL_MS) { arming(card, "hold still on the button a moment, then click"); return; }
      card.busy = true;
      arm.button.disabled = true;
      arming(card, issue ? "publishing..." : "approving...");
      // The issue's address, as text: the host took it from gh only if it is this repository's
      // issue page (shared/issues.ts, issueUrl).
      try { const answer = await post("approve", card, arm.squash); card.done = true; card.squashed = arm.squash; tellTerminal({ desolateDecided: true }); said(card, issue ? `published: ${typeof answer.url === "string" ? answer.url : "it is on GitHub now (its page is on the dashboard)"}` : `approved${arm.squash ? ", squashed into one commit" : ""}: the root is pushing it now.${carryOn(card)}`); }
      catch (error) { said(card, `not approved: ${error.message}`); }
      finally { card.busy = false; disarm(card); }
    });
  }
  // The replace's own step: the branch's name, typed.
  const typed = element.querySelector(".replace-name");
  if (typed) typed.addEventListener("input", () => { card.typed = typed.value === push.branch; disarm(card); });
  element.querySelector(".refuse").addEventListener("click", async (event) => {
    if (!event.isTrusted || card.busy || card.done) return;
    card.busy = true;
    try { await post("refuse", card); card.done = true; tellTerminal({ desolateDecided: true }); for (const arm of card.arms) arm.button.disabled = true; said(card, issue ? "not published: it is a draft on the dashboard again" : "refused: the push that asked gives up"); }
    catch (error) { said(card, error.message); }
    finally { card.busy = false; }
  });
  disarm(card);
  return card;
};

/** After a squash, how the workspace's branch goes on from it. */
const carryOn = (card) => card.squashed ? ` Then, to carry on from the squash, in the workspace on the branch pushed: git fetch && git rebase --rebase-merges --autostash --onto origin/${card.push.branch} ${card.push.commit}` : "";
/** How a push this page approved ended, as the host heard it from the pusher: said on its card,
 *  with the page to open its pull request (GitHub's, on github.com only). */
const ended = (outcome) => {
  const card = [...cards.values()].find((c) => c.push && c.done && !c.ended && c.push.token === outcome.token);
  if (!card) return;
  card.ended = true;
  if (!outcome.pushed) return void said(card, `approved, but the pusher said: ${outcome.error}`);
  said(card, `pushed${card.squashed ? ", squashed into one commit" : ""}: the remote's ${card.push.branch} has it. `);
  if (typeof outcome.link === "string" && outcome.link.startsWith("https://github.com/"))
    card.hint.append(Object.assign(el("a", "Open a pull request"), { href: outcome.link, target: "_blank", rel: "noopener noreferrer" }), " on GitHub, as yourself.");
  card.hint.append(carryOn(card));
};

/** What the reviewer said decides the choices: a squash, and a replace's typed name. */
const choicesOf = (card, review) => {
  const account = review && review.account;
  card.reviewed = Boolean(account);
  card.replaces = Boolean(account) && account.fastForward === false;
  const squash = card.arms.find((a) => a.squash);
  if (squash) squash.wrap.hidden = !(account && account.squash);
  const main = card.arms.find((a) => !a.squash);
  main.button.textContent = card.replaces ? `Replace ${card.push.branch}` : "Approve push";
  if (squash) squash.button.textContent = card.replaces ? `Replace ${card.push.branch}, squashed into one commit` : "Approve, squashed into one commit";
  const row = card.element.querySelector(".confirm-replace");
  if (row) {
    row.hidden = !card.replaces;
    row.querySelector(".branch-name").textContent = card.push.branch;
  }
};

const render = (pending, issues) => {
  let changed = false;
  let added = false;
  let scrollTo = null;
  const seen = new Set();
  for (const issue of issues) {
    seen.add(issue.token);
    if (cards.has(issue.token)) continue;
    const card = add(null, issue);
    cards.set(issue.token, card);
    list.append(card.element);
    changed = added = true;
  }
  for (const push of pending) {
    seen.add(push.token);
    let card = cards.get(push.token);
    if (!card) {
      card = add(push);
      cards.set(push.token, card);
      list.append(card.element);
      changed = added = true;
      if (askedFor.commit === push.commit && askedFor.repo === push.repo && askedFor.branch === push.branch) {
        askedFor.commit = "";
        card.element.classList.add("asked");
        card.element.prepend(el("p", "This tab's address names this push, as the dashboard's Push does. If you did not click Push, look twice.", "asked-note"));
        scrollTo = card.element;
      }
    }
    // (How long the reviewer has been at it is not a change: the page counts that itself.)
    const shown = JSON.stringify(push.review && push.review.working ? { working: { ...push.review.working, seconds: 0 } } : push.review);
    if (shown !== card.shown) {
      card.tick = null;
      // The click names the very account drawn (`shown`): the host signs no other.
      card.push.shown = push.shown;
      try {
        card.summary.replaceChildren(summaryOf(push.review, card));
        choicesOf(card, push.review);
        card.shown = shown;
      } catch (error) {
        // An account this page cannot draw is not one it can approve: said, and not armed.
        card.shown = "";
        card.summary.replaceChildren(el("p", `this account of the push could not be shown: ${error.message}. It cannot be approved here.`, "error"));
        choicesOf(card, null);
      }
      card.changedAt = performance.now();
      changed = true;
    }
  }
  // A push no longer waiting keeps its place (nothing shifts under the pointer), marked.
  for (const card of cards.values())
    if (!seen.has((card.issue || card.push).token) && !card.gone) {
      card.gone = true;
      if (!card.done) { card.done = true; for (const arm of card.arms) arm.button.disabled = true; said(card, "no longer waiting (approved elsewhere, refused, or given up)"); }
      card.element.classList.add("gone");
      changed = true;
    }
  // Something new to decide: what was decided before folds to its names and its outcome, so
  // the new card is not pushed below the fold (dogfooding, 2026-11-21: two refused cards above
  // the live one, beside the git terminal). The page moved: every card waits its second again.
  if (added) for (const card of cards.values()) { if (card.done) card.element.classList.add("folded"); card.changedAt = performance.now(); }
  if (scrollTo) scrollTo.scrollIntoView({ block: "start" });
  if (changed) disarmAll();
  const waiting = [...cards.values()].filter((card) => !card.gone).length;
  document.title = waiting ? `(${waiting}) desolate: waiting for you` : "desolate: nothing waiting";
  // Beside the git terminal: how many wait, so its page shows this frame when one does.
  // (A number, to that one origin.)
  tellTerminal({ desolatePending: waiting });
  // Nothing waiting: said as a state of its own, with what makes something appear here. A
  // grey line alone read as a page that did not work (dogfooding, 2026-11-17, after
  // `desolate approve --web --open` with nothing waiting).
  const empty = [...cards.values()].length === 0;
  document.getElementById("empty").hidden = !empty;
  document.body.classList.toggle("nothing", empty);
  say(waiting || empty ? "" : "Nothing else is waiting. A push that waits is shown here as it comes.");
};

// What waits: asked for once, then again with the answer's tag, which the host holds until
// there is something new to show (approve-web.ts). At most once a second, whatever comes.
// The issues to publish are asked for every second.
let pending = null;
let issues = [];
const poll = async (tag) => {
  const began = performance.now();
  let next = null;
  try {
    const answer = await fetch(tag ? `/pending?since=${tag}` : "/pending", { credentials: sendCookie, headers: credential });
    const body = await answer.json();
    if (!answer.ok) { current = false; disarmAll(); say(body.error || `HTTP ${answer.status}`); }
    else { pending = body.pending; render(pending, issues); for (const outcome of body.done || []) ended(outcome); current = true; next = body.tag; }
  } catch (error) { current = false; disarmAll(); say(`the host daemon did not answer: ${error.message}`); }
  setTimeout(() => poll(next), Math.max(0, 1000 - (performance.now() - began)));
};
const pollIssues = async () => {
  try {
    const asked = await fetch("/issues", { credentials: sendCookie, headers: credential });
    issues = asked.ok ? (await asked.json()).issues : [];
    if (pending) render(pending, issues);
  } catch { /* said by the poll of what waits */ }
  setTimeout(pollIssues, 1000);
};
poll(null);
pollIssues();
