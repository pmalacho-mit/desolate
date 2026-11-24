// The approval page's script. Everything it puts on the page is text (textContent), never
// markup: a commit's subject or a file's name is whatever an agent wrote.
//
// Arming. Approve, Refuse and Dismiss each take a click only when (1) the page has been
// visible and focused for a second, (2) the card has been on the page, unchanged, for a
// second, and (3) since the page last changed, the pointer has moved onto the button and been
// over it for that second, moving or at rest (a click soon after arriving was refused:
// dogfooding, 2026-11-22). Any change to the page (a card added, ended, its summary arriving, a
// scroll) disarms every button, and only a movement of the pointer onto one starts its second
// again: a button that came under a still pointer never arms (the review of #283: a card that
// went brought the next card's Approve under the pointer that had approved it). Nothing the
// page does moves a card from under the pointer either: one that ends keeps its place until
// the pointer is off the list of cards (`keep`). Keys do not approve. Refuse and Dismiss take a
// key too, by the same rule: only once the person moved the focus onto the button with their
// own Tab since the page last changed, and rested there a second (`keyReady`): focus the page
// moved, or that was there when the page changed, arms nothing.
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
      const visible = entry.isVisible && entry.intersectionRatio >= 0.99;
      // Covered, or shown again: a change, and the second starts again (the fresh review).
      if (visible !== arm.visible) { arm.visible = visible; changed(card); }
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
/** The page and the card have stood still for a second, and the button is in view. */
const still = (card, arm) => attentiveSince !== 0 && performance.now() - attentiveSince >= READY_MS && performance.now() - card.changedAt >= READY_MS && arm.visible !== false && !arm.wrap.hidden;
const ready = (card, arm) => current && reviewedOf(card) && still(card, arm) && confirmed(card);
const armedOf = (card) => card.arms.find((a) => a.armedAt);
/** Approve, and its squashed choice: what signs. */
const signs = (arm) => arm.kind === "approve" || arm.kind === "squash";
// Where the pointer was at its last movement, by its own events: a movement is one to
// somewhere else. (After the page changes under a still pointer, the browser may send a
// pointermove of its own, at the same place: that is not the pointer coming to anything.)
let pointerAt = null;
let pointerMoved = false;
document.addEventListener("pointermove", (event) => {
  pointerMoved = event.isTrusted && pointerAt !== null && (event.screenX !== pointerAt[0] || event.screenY !== pointerAt[1]);
  pointerAt = [event.screenX, event.screenY];
}, true);
/** The page changed: no button of `card` has had the pointer, or the person's Tab, come to it
 *  since. */
const unmoved = (card, keys = true) => { for (const arm of card.arms) { arm.came = false; arm.overSince = 0; if (keys) arm.keyedAt = 0; } };
// When the person last pressed Tab here: a button focused just after came to by their key.
let tabbedAt = -Infinity;
document.addEventListener("keydown", (event) => { if (event.isTrusted && event.key === "Tab") tabbedAt = performance.now(); }, true);
/** Refuse or Dismiss, focused by the person's own Tab since the page last changed, and a
 *  second ago; the page and the card still, and this page with the focus. */
const keyReady = (card, arm) => arm.keyedAt !== 0 && document.activeElement === arm.button && document.hasFocus() && performance.now() - arm.keyedAt >= READY_MS && still(card, arm) && !card.busy && (arm.kind === "dismiss" ? card.done : !card.done);
/** A button looks pressable, or not: Approve by `disabled` (it takes no key at all), Refuse
 *  and Dismiss by aria-disabled, so a key can still reach them. */
const pressable = (arm, yes) => { if (signs(arm)) arm.button.disabled = !yes; else arm.button.setAttribute("aria-disabled", String(!yes)); };
const disarm = (card) => {
  for (const arm of card.arms) { arm.armedAt = 0; pressable(arm, false); }
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
  const first = card.arms.find((a) => signs(a) && !a.wrap.hidden);
  return !reviewedOf(card) ? "waiting for desolate's reviewer to say what it sends" : !confirmed(card) ? `type ${card.push.branch} above to replace it` : first && ready(card, first) ? "move the pointer onto a button and rest it there: it arms after a second" : "arming in a moment...";
};
const disarmAll = () => { for (const card of cards.values()) disarm(card); };
// Whatever changes a card's size (a card folded, a diff opened, what happened said on one, as
// late as the pusher's word) moves every Approve below it: each waits its second again.
// So does the page scrolling: it moves Approve under a pointer that did not move.
// (A scroll moves the buttons under the pointer, not the focus: the focus the person's Tab
// brought to a button stays where it was, and so does what a key acts on. Tab itself scrolls.)
const moved = (keys = true) => { for (const card of cards.values()) { card.changedAt = performance.now(); unmoved(card, keys); } disarmAll(); };
new ResizeObserver(() => moved()).observe(list);
window.addEventListener("scroll", () => moved(false), { passive: true });
/** Armed, if the pointer came to it and has been over it (moving or not) for a second while
 *  nothing on the page changed. Approve, only once the push can be signed; Refuse, at any
 *  time it waits; Dismiss, once it has ended. */
const tryArm = (card, arm) => {
  if (card.busy || armedOf(card) || !arm.came || !arm.overSince || performance.now() - arm.overSince < READY_MS || !still(card, arm)) return;
  if (arm.kind === "dismiss" ? !card.done : card.done || performance.now() < card.saidUntil || (signs(arm) && !ready(card, arm))) return;
  arm.armedAt = performance.now();
  pressable(arm, true);
  // (Dismiss leaves the line as it is: it says what became of the push.)
  if (arm.kind === "dismiss") return;
  card.saidUntil = 0;
  arming(card, arm.kind === "refuse" ? `armed: click to ${card.issue ? "leave it for now" : "refuse"}` : card.issue ? "armed: click to publish" : "armed: click to approve");
};
// (The pointer over a button is read as the browser has it, :hover: a pointer at rest sends
// no events. It counts only once the pointer came to the button: `came`, set by a movement.)
setInterval(() => {
  for (const card of cards.values()) {
    for (const arm of card.arms) {
      const over = arm.wrap.matches(":hover");
      if (!over && (arm.overSince || arm.came)) { arm.overSince = 0; arm.came = false; if (arm.armedAt) disarm(card); }
      else if (over && arm.came && !arm.overSince) arm.overSince = performance.now();
      tryArm(card, arm);
    }
    if (!armedOf(card)) {
      disarm(card);
      // Reached by the person's Tab and rested on: pressable by a key.
      for (const arm of card.arms) if (!signs(arm) && keyReady(card, arm)) {
        pressable(arm, true);
        if (arm.kind === "refuse") arming(card, `armed: press Enter to ${card.issue ? "leave it for now" : "refuse"}`);
      }
    }
  }
  // A card that ended goes once the pointer is off the list of cards: nothing then moves under it.
  if (kept.size && !list.matches(":hover")) collapse();
}, 250);
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

// The diff, and an issue's text, as text: what would hide or reorder it named
// (shared/ui/shown-text.js: the dashboard's diff is the same).
const { unhidden, diffView } = DesolateShown;
/** What the host is asked for a push the card shows: by its nonce and the token over its very
 *  text, as an approval is. */
const askHost = async (card, what, query) => {
  const answer = await fetch(`/${what}?nonce=${card.push.nonce}&token=${card.push.token}&${query}`, { credentials: sendCookie, headers: credential });
  const body = await answer.json().catch(() => ({}));
  if (!answer.ok) throw new Error(body.error || `HTTP ${answer.status}`);
  return body;
};
/** Anything added to a card changes it: its buttons disarm, and each arms again only once the
 *  pointer has come to it. */
const changed = (card) => { card.changedAt = performance.now(); unmoved(card); disarm(card); };
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
  const kindOf = (wrap) => ["squash", "refuse", "dismiss"].find((kind) => wrap.classList.contains(kind)) || "approve";
  const arms = [...element.querySelectorAll(".arm")].map((wrap) => ({ wrap, button: wrap.querySelector("button"), kind: kindOf(wrap), squash: kindOf(wrap) === "squash", armedAt: 0, overSince: 0, came: false, visible: VISIBILITY ? false : undefined }));
  const card = { element, push, issue, arms, hint: element.querySelector(".hint"), summary: element.querySelector(".summary"), changedAt: performance.now(), saidUntil: 0, done: false, busy: false, shown: "", replaces: false, typed: false, reviewed: false, approved: false, refuse: arms.find((a) => a.kind === "refuse"), dismiss: arms.find((a) => a.kind === "dismiss") };
  // (Focused by the page alone, as a card's state changes: never a stop for Tab.)
  element.tabIndex = -1;
  for (const arm of arms) {
    if (watcher) watcher.observe(arm.wrap);
    // (A disabled button gets no pointer events in every browser: these are on its wrapper,
    // and the button lets them through while disabled: approve.css.)
    arm.wrap.addEventListener("pointermove", () => {
      // Only a movement brings the pointer to a button.
      if (!pointerMoved) return;
      arm.came = true;
      if (!arm.overSince) arm.overSince = performance.now();
      tryArm(card, arm);
    });
    arm.wrap.addEventListener("pointerleave", () => { arm.overSince = 0; arm.came = false; disarm(card); });
    // A click on a button not armed (the wrapper has it: approve.css) does nothing, and says
    // why, for a few seconds: a click ignored in silence read as a page that did not work.
    // (Dismiss's says it on the button itself: the line under it says what became of the push.)
    arm.wrap.addEventListener("click", () => {
      if (arm.armedAt || card.busy || arm.kind === "dismiss" || card.done) return;
      arming(card, `not armed yet: ${whyNotArmed(card)}`);
      card.saidUntil = performance.now() + SAID_MS;
    });
    // A real pointer's click, on an armed button: not a key, not a script.
    const real = (event) => event.isTrusted && event.detail !== 0 && arm.armedAt && !card.busy;
    const refuseIt = async () => {
      card.busy = true;
      try { await post("refuse", card); card.done = true; tellTerminal({ desolateDecided: true }); said(card, issue ? "not published: it is a draft on the dashboard again" : "refused: the push that asked gives up"); }
      catch (error) { said(card, error.message); }
      finally { card.busy = false; disarm(card); }
    };
    if (arm.kind === "dismiss") arm.button.addEventListener("click", (event) => { if (real(event) && card.done) dismiss(card); });
    else if (arm.kind === "refuse") arm.button.addEventListener("click", (event) => { if (real(event) && !card.done) void refuseIt(); });
    if (!signs(arm)) {
      // Focused by the person's Tab (this keydown's own default), or by anything else.
      arm.button.addEventListener("focus", () => { arm.keyedAt = performance.now() - tabbedAt < 100 ? performance.now() : 0; });
      arm.button.addEventListener("blur", () => { arm.keyedAt = 0; });
      // A key's press of its own, a second after the Tab that came to it. (Its default, a click
      // with no pointer, does nothing: `real`.)
      arm.button.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        if (!event.isTrusted || event.repeat || !keyReady(card, arm)) {
          if (arm.kind === "refuse" && !card.done) { arming(card, "not armed yet: move to Refuse with Tab, wait a second, then press Enter"); card.saidUntil = performance.now() + SAID_MS; }
          return;
        }
        if (arm.kind === "dismiss") dismiss(card);
        else void refuseIt();
      });
    }
    else arm.button.addEventListener("click", async (event) => {
      if (!real(event) || card.done || !confirmed(card)) return;
      card.busy = true;
      arm.button.disabled = true;
      arming(card, issue ? "publishing..." : "approving...");
      // The issue's address, as text: the host took it from gh only if it is this repository's
      // issue page (shared/issues.ts, issueUrl).
      try {
        const answer = await post("approve", card, arm.squash);
        card.done = true;
        tellTerminal({ desolateDecided: true });
        if (issue) said(card, `published: ${typeof answer.url === "string" ? answer.url : "it is on GitHub now (its page is on the dashboard)"}`);
        else {
          // The focus stays on the card, not on a button that can no longer be pressed.
          if (mayFocus()) card.element.focus({ preventScroll: true });
          approved(card, Date.now(), arm.squash ? push.commit : null);
          // (The host's record of it may have come before this answer did.)
          card.busy = false;
          heard();
        }
      }
      catch (error) { said(card, `not approved: ${error.message}`); card.saidUntil = performance.now() + SAID_MS; }
      finally { card.busy = false; disarm(card); }
    });
  }
  // The replace's own step: the branch's name, typed.
  const typed = element.querySelector(".replace-name");
  if (typed) typed.addEventListener("input", () => { card.typed = typed.value === push.branch; disarm(card); });
  disarm(card);
  return card;
};

/** After a squash (`squashes`: the commit squashed), how the workspace's branch goes on from it. */
const carryOn = (branch, squashes) => squashes ? ` Then, to carry on from the squash, in the workspace on the branch pushed: git fetch && git rebase --rebase-merges --autostash --onto origin/${branch} ${squashes}` : "";

// After Approve. The page's word on a push it approved is the host's record of the approval
// (approve-web.ts, `approved`): the names the Mac signed, and how the push ended once the
// root's pusher said (its log, which only root writes: host/events.ts). The page says whose
// word that is, shows its why as text, and acts on none of it: a card approved cannot arm
// again, and a record names only an approval the host signed.
/** How long a push approved here may go unheard of before its card says so. The approval
 *  lasts two minutes unless the pusher takes it (root/keyring.ts, APPROVAL); an ordinary push
 *  is then said to have landed within seconds (T2 04, 2026-11-24: the page heard it 5.5 s
 *  after the click, the pusher's log read every 2 s). A large one can take longer to upload:
 *  its card changes whenever word comes. */
const NO_WORD_MS = 3 * 60_000;
/** The host's record of each approval signed here, as its last answer gave it. */
let records = [];
/** Failures, and pushes not heard of, the person put away in this tab, with what each said
 *  then: kept by the tab alone (a reload does not bring them back; another tab still shows
 *  them), the last few. One put away with no word yet comes back when its word is not
 *  "pushed" (a pushed one is under Pushed): its line said it would change. */
const DISMISSED = "desolate-dismissed";
const dismissed = new Map((() => { try { return Object.entries(JSON.parse(sessionStorage.getItem(DISMISSED) || "{}")); } catch { return []; } })());
const remember = () => { try { sessionStorage.setItem(DISMISSED, JSON.stringify(Object.fromEntries([...dismissed].slice(-16)))); } catch { /* kept until a reload */ } };
const pushedList = document.querySelector("#pushed ul");
const pushedLines = new Map();
/** Cards that ended, holding their place (`keep`) until the pointer is off the list. */
const kept = new Set();
// The page moves the focus only when the person's last act was in it (a press or a key) and
// it has the focus: beside the git terminal, never away from the terminal.
let actedHere = false;
for (const kind of ["pointerdown", "keydown"]) document.addEventListener(kind, () => { actedHere = true; }, true);
window.addEventListener("blur", () => { actedHere = false; });
const mayFocus = () => actedHere && document.hasFocus();
/** How much of the pusher's words a card shows before "Show all": a few lines. */
const QUOTED = 300;

/** A card is approved: it cannot be approved again (its buttons go), and it says what became
 *  of the push from here on. `at`: when, by this Mac's clock. */
const approved = (card, at, squashes) => {
  card.done = card.approved = true;
  card.approvedAt = at;
  card.squashes = squashes;
  disarm(card);
  card.element.classList.remove("gone");
  showApproved(card);
};
/** The pusher's words on a card, set apart from the page's own: quoted, said to be its, a few
 *  lines of them, the rest on asking. */
const quote = (card, words) => {
  if (card.quoted === words) return;
  card.quoted = words;
  const figure = card.element.querySelector(".reported");
  const block = figure.querySelector("blockquote");
  const all = figure.querySelector(".all");
  const chars = [...words];
  block.textContent = chars.length > QUOTED ? `${chars.slice(0, QUOTED).join("")}…` : words;
  all.hidden = chars.length <= QUOTED;
  all.textContent = `Show all of it (${count(chars.length)} characters)`;
  all.onclick = () => { block.textContent = words; all.hidden = true; };
  figure.hidden = false;
};
/** What a card approved says now: being pushed; not pushed, or perhaps not, with the pusher's
 *  words quoted, kept until dismissed; or no word yet. Pushed, it ends (`keep`), and its line
 *  is added under Pushed. */
const showApproved = (card) => {
  const record = card.record;
  if (record && record.pushed) return void keep(card, pushedText(record), pushedLine(record));
  const failed = record && record.error !== undefined;
  const state = failed ? (record.uncertain ? "uncertain" : "failed") : Date.now() - card.approvedAt >= NO_WORD_MS ? "unheard" : "pushing";
  const branch = card.push.branch;
  // (Each the same while it stands: a line that changed by itself would move what is below.)
  const text =
    state === "failed" ? "Not pushed: the root's pusher reports it failed, in its words above. To try again, push it again (the dashboard's Push, desolate push, or git push in the git VM) and approve it here."
    : state === "uncertain" ? `Perhaps not pushed: the root's pusher reports it may or may not have reached the remote, in its words above. See what the remote's ${branch} has (desolate fetch, then the dashboard) before you push it again.`
    : state === "unheard" ? `No word from the root's pusher in the ${NO_WORD_MS / 60_000} minutes since you approved this. A large push can take longer, and this changes when word comes. If none does, desolate events --all on this Mac says what the pusher did, and the terminal or dashboard that pushed says how it ended; to try again, push it again.`
    : `Approved${card.squashes ? ", squashed into one commit" : ""}: the root is pushing it to the remote now. This card goes when the root's pusher reports the remote has it.`;
  if (failed) quote(card, record.error);
  for (const name of ["pushing", "failed", "uncertain", "unheard"]) card.element.classList.toggle(name, name === state);
  // Pushing, a card approved here keeps its buttons (disabled): nothing moves under the
  // pointer that clicked. Ended, or not heard of, Dismiss shows, at the far end of the bar,
  // where no Approve was.
  const bare = state !== "pushing" || card.drawn;
  for (const arm of card.arms) if (arm.kind !== "dismiss" && bare) arm.wrap.hidden = true;
  card.dismiss.wrap.hidden = state === "pushing";
  card.state = state;
  // (Said only when it changes: a live region reads each change out.)
  if (card.hint.textContent !== text) said(card, text);
};
/** A card that ended (pushed, or dismissed) keeps its place, its height, and nothing to press:
 *  what it says instead (`text`) holds it until the pointer is off the list of cards, which
 *  the page looks at four times a second (`collapse`). Then nothing can come under the
 *  pointer as it goes. The focus, if it was on the card and may move, stays on its place. */
const keep = (card, text, then) => {
  const element = card.element;
  const focused = element.contains(document.activeElement);
  element.style.height = `${element.getBoundingClientRect().height}px`;
  element.classList.add("kept");
  const note = el("p", text, "kept-note");
  note.tabIndex = -1;
  element.replaceChildren(note, el("p", "This place goes once the pointer is off the list of cards, so that nothing moves under it.", "kept-note"));
  element.then = then;
  cards.delete(card.push.token);
  kept.add(element);
  counted();
  if (focused && mayFocus()) note.focus({ preventScroll: true });
};
/** The places held go, once the pointer is off the list. The focus, if it was on one and may
 *  move, goes to what it said under Pushed, else to the first card, else to the heading. */
const collapse = () => {
  const held = [...kept].find((k) => k.contains(document.activeElement));
  for (const element of kept) element.remove();
  kept.clear();
  counted();
  if (held && mayFocus()) (held.then || list.querySelector(".card") || document.querySelector("h1")).focus({ preventScroll: true });
};
const dismiss = (card) => {
  dismissed.set(card.push.token, card.state);
  remember();
  keep(card, "Dismissed.", null);
};
/** What the pusher reports a pushed approval did, as a line of text. */
const pushedText = (record) => `${record.repo} ${record.branch} ${record.commit.slice(0, 12)}: the root's pusher reports the remote has it${record.squashes ? ", squashed into one commit" : ""}. Approved at ${new Date(record.at).toTimeString().slice(0, 8)}.`;
/** A pushed approval's line under "Pushed", newest first, once: what the pusher reports the
 *  remote took, the page to open its pull request, and how to go on after a squash. */
const pushedLine = (record) => {
  if (pushedLines.has(record.token)) return pushedLines.get(record.token);
  const li = el("li");
  li.tabIndex = -1;
  li.append(el("code", record.repo), " ", el("code", record.branch), " ", el("code", record.commit.slice(0, 12)), pushedText(record).slice(`${record.repo} ${record.branch} ${record.commit.slice(0, 12)}`.length));
  // A suede proposal (docs/suede.md): the dependency's own Action opens its pull request.
  if (/^downstream\//.test(record.branch)) li.append(" The dependency's own Action (suede-downstream-to-main) opens its pull request.");
  else if (typeof record.link === "string" && record.link.startsWith("https://github.com/"))
    li.append(" ", Object.assign(el("a", "Open a pull request"), { href: record.link, target: "_blank", rel: "noopener noreferrer" }), " on GitHub, as yourself.");
  li.append(carryOn(record.branch, record.squashes));
  pushedList.prepend(li);
  pushedLines.set(record.token, li);
  pushedList.parentElement.hidden = false;
  return li;
};
/** Each record the host gave: the card it belongs to (by the token over the text signed),
 *  drawn if this page has none (a reload, another tab's approval), and how it stands. A push
 *  still waiting here, and not approved here, is its own card's until the root takes the
 *  approval (it then leaves the list): a record never decides a card that can still arm. */
const heard = () => {
  for (const record of records) {
    let card = cards.get(record.token);
    if (card && (card.issue || card.busy || (!card.approved && !card.gone))) continue;
    if (!card) {
      if (record.pushed) { pushedLine(record); continue; }
      // Put away: back only if it said no word yet and the word has come.
      const was = dismissed.get(record.token);
      if (was !== undefined && !(was === "unheard" && record.error !== undefined)) continue;
      if (was !== undefined) { dismissed.delete(record.token); remember(); }
      card = add({ repo: record.repo, branch: record.branch, commit: record.commit, onto: record.onto, token: record.token });
      card.gone = true;
      cards.set(record.token, card);
      list.append(card.element);
    }
    card.record = record;
    // Approved, but not by a click in this tab: nothing of it was under this tab's pointer, so
    // its buttons go at once.
    if (!card.approved) { card.drawn = true; approved(card, record.at, record.squashes); }
    else { card.approvedAt = record.at; showApproved(card); }
  }
  // The lines of approvals the host no longer keeps (OUTCOMES_KEPT) go.
  for (const [token, li] of pushedLines) if (!records.some((r) => r.token === token)) { li.remove(); pushedLines.delete(token); }
  pushedList.parentElement.hidden = pushedLines.size === 0;
  counted();
};
setInterval(() => { for (const card of cards.values()) if (card.approved) showApproved(card); }, 1000);

/** What the reviewer said decides the choices: a squash, and a replace's typed name. */
const choicesOf = (card, review) => {
  const account = review && review.account;
  card.reviewed = Boolean(account);
  card.replaces = Boolean(account) && account.fastForward === false;
  const squash = card.arms.find((a) => a.squash);
  if (squash) squash.wrap.hidden = !(account && account.squash);
  const main = card.arms.find((a) => a.kind === "approve");
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
    // Drawn as approved from a record the host no longer has, and listed as waiting again (the
    // keyring refused it): drawn again as waiting.
    if (card && card.drawn && !records.some((r) => r.token === push.token)) {
      card.element.remove();
      cards.delete(push.token);
      card = undefined;
    }
    if (!card) {
      // One the host has signed is not waiting for the person, whatever the root still lists:
      // its record says what became of it (`heard`).
      if (records.some((r) => r.token === push.token)) continue;
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
    // Decided here: what the root lists of it changes nothing on its card.
    if (card.done) continue;
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
      // (One approved says what became of it, at full strength.)
      if (!card.approved) card.element.classList.add("gone");
      changed = true;
    }
  // Something new to decide: what was decided before folds to its names and its outcome, so
  // the new card is not pushed below the fold (dogfooding, 2026-11-21: two refused cards above
  // the live one, beside the git terminal). The page moved: every card waits its second again.
  if (added) for (const card of cards.values()) { if (card.done) card.element.classList.add("folded"); card.changedAt = performance.now(); }
  if (scrollTo) scrollTo.scrollIntoView({ block: "start" });
  if (changed) disarmAll();
  counted();
};
/** How many wait, in the tab's title and to the git terminal; and nothing on the page, said. */
const counted = () => {
  const waiting = [...cards.values()].filter((card) => !card.gone).length;
  document.title = waiting ? `(${waiting}) desolate: waiting for you` : "desolate: nothing waiting";
  // Beside the git terminal: how many wait, so its page shows this frame when one does.
  // (A number, to that one origin.)
  tellTerminal({ desolatePending: waiting });
  // Nothing waiting: said as a state of its own, with what makes something appear here. A
  // grey line alone read as a page that did not work (dogfooding, 2026-11-17, after
  // `desolate approve --web --open` with nothing waiting).
  // (A card that ended and holds its place counts until it goes: nothing moves before.)
  const empty = cards.size === 0 && kept.size === 0;
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
    if (!answer.ok) { current = false; moved(); say(body.error || `HTTP ${answer.status}`); }
    else { pending = body.pending; records = body.approved; render(pending, issues); heard(); current = true; next = body.tag; }
  } catch (error) { current = false; moved(); say(`the host daemon did not answer: ${error.message}`); }
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
