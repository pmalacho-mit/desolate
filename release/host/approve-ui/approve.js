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
const list = document.getElementById("list");
const status = document.getElementById("status");
const template = document.getElementById("card");
const cards = new Map(); // the push's token (over its exact text) -> card

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
const ready = (card, arm) => attentiveSince !== 0 && performance.now() - attentiveSince >= READY_MS && performance.now() - card.changedAt >= READY_MS && arm.visible !== false && !arm.wrap.hidden && confirmed(card);
const armedOf = (card) => card.arms.find((a) => a.armedAt);
const disarm = (card) => {
  for (const arm of card.arms) { arm.armedAt = 0; if (!card.done) arm.button.disabled = true; }
  if (card.done) return;
  const first = card.arms.find((a) => !a.wrap.hidden);
  card.hint.textContent = !confirmed(card) ? `type ${card.push.branch} above to replace it` : first && ready(card, first) ? "move the pointer over a button to arm it" : "arming in a moment...";
};
const disarmAll = () => { for (const card of cards.values()) disarm(card); };
setInterval(() => { for (const card of cards.values()) if (!armedOf(card) && !card.done) disarm(card); }, 250);

const post = async (what, card, squash) => {
  const sent = card.issue ? { path: "/issue", body: { id: card.issue.id, token: card.issue.token, do: what === "approve" ? "publish" : "refuse" } } : { path: `/${what}`, body: { nonce: card.push.nonce, token: card.push.token, commit: card.push.commit, squash: squash === true, replace: card.replaces && card.typed } };
  const answer = await fetch(sent.path, { method: "POST", headers: { "content-type": "application/json", ...credential }, body: JSON.stringify(sent.body), credentials: sendCookie });
  const body = await answer.json().catch(() => ({}));
  if (!answer.ok) throw new Error(body.error || `HTTP ${answer.status}`);
  return body;
};

// The diff, as text: each line a text node in a span classed by its first character.
// Characters that reorder or hide what is shown (bidi controls, zero-width ones): in a diff a
// person approves from, each is shown as itself, named, so the line reads as git stores it.
const unhidden = (line) => line.replace(/[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, (c) => `⟨U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}⟩`);
const kindOf = (line) => line.startsWith("diff --git") ? "file" : line.startsWith("@@") ? "hunk" : line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "del" : "";
/** git's text, a line a span; given `tokens` (shared/ui/highlight.js), each line of code in
 *  its syntax's colours, its text unchanged. */
const diffView = (text, tokens) => {
  const pre = el("pre", undefined, "diff");
  text.split("\n").forEach((line, i) => {
    const span = el("span", undefined, kindOf(line));
    const code = tokens && tokens[i];
    if (code && typeof DesolateHighlight !== "undefined") span.append(document.createTextNode(line[0]), ...DesolateHighlight.paint(code, unhidden));
    else span.textContent = unhidden(line) || " ";
    pre.append(span);
  });
  return pre;
};
/** "Show the diff": asked of the host once, for the very text the card shows (its token).
 *  Opening it changes the card, so Approve disarms and arms again only as it always does. */
const diffToggle = (card, each) => {
  const box = el("div", undefined, "diffbox");
  const label = each ? ["Show each commit's diff", "Hide each commit's diff"] : ["Show the diff", "Hide the diff"];
  const button = el("button", label[0], "quiet");
  button.type = "button";
  let open = false;
  button.addEventListener("click", async (event) => {
    if (!event.isTrusted) return;
    open = !open;
    button.textContent = open ? label[1] : label[0];
    if (!open) box.replaceChildren();
    else {
      box.replaceChildren(el("p", "asking desolate's reviewer...", "hint"));
      try {
        const answer = await fetch(`/diff?nonce=${card.push.nonce}&token=${card.push.token}${each ? "&each=1" : ""}`, { credentials: sendCookie, headers: credential });
        const body = await answer.json();
        if (!answer.ok) throw new Error(body.error || `HTTP ${answer.status}`);
        box.replaceChildren(...(body.diff === null ? [el("p", "Too large to show here (over 20 000 lines): read it with git in the git terminal.", "error")] : [diffView(body.diff), ...(body.cut ? [el("p", "Cut at 256 KiB: read the rest with git in the git terminal.", "error")] : [])]));
        // Then its colours, when the worker has them (or never: the diff stays plain). The
        // text is the same; the card is redrawn all the same, so Approve disarms again.
        if (body.diff !== null && typeof DesolateHighlight !== "undefined") {
          const shown = box.querySelector("pre.diff");
          DesolateHighlight.tokensFor(body.diff).then((tokens) => {
            if (!open || !shown.isConnected || !tokens.some(Boolean)) return;
            const coloured = diffView(body.diff, tokens);
            coloured.scrollTop = shown.scrollTop;
            shown.replaceWith(coloured);
            coloured.scrollTop = shown.scrollTop;
            card.changedAt = performance.now();
            disarm(card);
          });
        }
      } catch (error) {
        box.replaceChildren(el("p", `the diff could not be had: ${error.message}`, "error"));
      }
    }
    card.changedAt = performance.now();
    disarm(card);
  });
  return [button, box];
};

const summaryOf = (summary, card) => {
  const box = document.createDocumentFragment();
  if (!summary || !summary.ok) {
    box.append(el("p", summary && summary.waiting ? "desolate's reviewer is working out what this push would send..." : `desolate's reviewer could not say what this push would send: ${summary && summary.error ? summary.error : "no answer"}. It cannot be approved: what the reviewer makes is what a push sends.`, summary && summary.waiting ? "" : "error"));
    return box;
  }
  for (const warning of summary.warnings || []) box.append(el("p", `Warning: ${warning}`, "error"));
  if (summary.fastForward === false) box.append(el("p", "This does not build on the remote's branch: it REPLACES it, and the commits only the remote has are dropped from the branch. To do that, type the branch's name below.", "error"));
  const commits = summary.commits || [];
  const total = commits.length + (summary.more || 0);
  box.append(el("p", total ? `${total} commit(s) the remote does not have:` : "No commit the remote does not have already."));
  // A long list scrolls in a box of its own: the card stays short enough that Approve is in
  // view, and what is scrolled away is never what needs attention (see the files below).
  const ul = el("ul", undefined, commits.length > 8 ? "long" : "");
  // Its id, its subject, and who wrote it, quieter: the subject is what is read.
  for (const c of commits) { const li = el("li", undefined, "commit"); li.append(el("code", c.commit.slice(0, 12)), el("span", ` ${c.subject}`), el("span", `  ${c.author}`, "who")); ul.append(li); }
  if (summary.more) ul.append(el("li", `and ${summary.more} more`));
  if (commits.length) box.append(ul);
  const files = summary.files || [];
  if (files.length) {
    box.append(el("p", `${files.length + (summary.moreFiles || 0)} file(s) changed${summary.base ? ` against ${summary.base.slice(0, 12)}` : ""}${summary.lfs ? `, ${summary.lfs} of them LFS objects` : ""}:`));
    // What runs on the forge (CI workflows, hooks) or changes how git treats the repository:
    // always listed in full, outside any scrolling box, before the rest.
    const line = (f) => {
      const li = el("li", undefined, f.sensitive ? "file sensitive" : "file");
      // Lines added and removed in colour, as the dashboard's review shows them.
      li.append(el("code", f.path));
      if (f.binary) li.append(el("span", "binary", "who"));
      else li.append(el("span", `+${f.added}`, "add"), el("span", `\u2212${f.removed}`, "del"));
      return li;
    };
    const sensitive = files.filter((f) => f.sensitive);
    const rest = files.filter((f) => !f.sensitive);
    if (sensitive.length) {
      box.append(el("p", `${sensitive.length} of them run on the forge, change how git treats the repository, or are suede's own machinery:`, "error"));
      const sl = el("ul");
      for (const f of sensitive) sl.append(line(f));
      box.append(sl);
    }
    const fl = el("ul", undefined, rest.length > 8 ? "long" : "");
    for (const f of rest) fl.append(line(f));
    if (summary.moreFiles) fl.append(el("li", `and ${summary.moreFiles} more (every one that runs on the forge is listed above)`));
    if (rest.length || summary.moreFiles) box.append(fl);
  }
  // What the net change does not show: files a commit changes that end as they were (changed,
  // then changed back, or as the branch it replaces has them). Every commit is pushed, so what
  // they held is in the history all the same.
  const between = summary.between || [];
  if (between.length || summary.moreBetween) {
    box.append(el("p", `${between.length + (summary.moreBetween || 0)} more file(s) that these commits change, though the list above (the net change) does not show them. Each commit is pushed, so what they held is in the branch's history:`, "error"));
    const bl = el("ul", undefined, between.length > 8 ? "long" : "");
    for (const f of between) { const li = el("li", undefined, f.sensitive ? "file sensitive" : "file"); li.append(el("code", f.path)); bl.append(li); }
    if (summary.moreBetween) bl.append(el("li", `and ${summary.moreBetween} more`));
    box.append(bl);
  }
  if (summary.hasDiff !== undefined && card) box.append(...diffToggle(card, false));
  if (summary.hasEachDiff && card) box.append(...diffToggle(card, true));
  // The other choice: the same push as one commit (its tree is the last commit's), so nothing
  // in between reaches the history.
  if (summary.squash) {
    const sq = summary.squash;
    box.append(el("p", `Or push it squashed into one commit, ${sq.commit.slice(0, 12)}, ${sq.parent ? `on ${sq.parent.slice(0, 12)}` : "with no parent"}: the same files as the last commit, and none of what was in between. The workspace's branch keeps its ${sq.count} commits.`));
    box.append(el("pre", sq.message, "message"));
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
  const card = { element, push, issue, arms, hint: element.querySelector(".hint"), summary: element.querySelector(".summary"), changedAt: performance.now(), done: false, busy: false, shown: "", replaces: false, typed: false };
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
      card.hint.textContent = "";
    });
    arm.wrap.addEventListener("pointerleave", () => disarm(card));
    arm.button.addEventListener("click", async (event) => {
      // A real pointer's click, on a button armed a moment ago: not a key, not a script.
      if (!event.isTrusted || event.detail === 0 || !arm.armedAt || performance.now() - arm.armedAt < DWELL_MS || card.busy || card.done || !confirmed(card)) return;
      card.busy = true;
      arm.button.disabled = true;
      card.hint.textContent = issue ? "publishing..." : "approving...";
      // The issue's address, as text: the host took it from gh only if it is this repository's
      // issue page (shared/issues.ts, issueUrl).
      try { const answer = await post("approve", card, arm.squash); card.done = true; card.hint.textContent = issue ? `published: ${typeof answer.url === "string" ? answer.url : "it is on GitHub now (its page is on the dashboard)"}` : arm.squash ? "approved, squashed into one commit: the push continues in the root" : "approved: the push continues in the root"; }
      catch (error) { card.hint.textContent = `not approved: ${error.message}`; }
      finally { card.busy = false; disarm(card); }
    });
  }
  // The replace's own step: the branch's name, typed.
  const typed = element.querySelector(".replace-name");
  if (typed) typed.addEventListener("input", () => { card.typed = typed.value === push.branch; disarm(card); });
  element.querySelector(".refuse").addEventListener("click", async (event) => {
    if (!event.isTrusted || card.busy || card.done) return;
    card.busy = true;
    try { await post("refuse", card); card.done = true; for (const arm of card.arms) arm.button.disabled = true; card.hint.textContent = issue ? "not published: it is a draft on the dashboard again" : "refused: the push that asked gives up"; }
    catch (error) { card.hint.textContent = error.message; }
    finally { card.busy = false; }
  });
  disarm(card);
  return card;
};

/** What the reviewer said decides the choices: a squash, and a replace's typed name. */
const choicesOf = (card, summary) => {
  const ok = Boolean(summary && summary.ok);
  card.replaces = ok && summary.fastForward === false;
  const squash = card.arms.find((a) => a.squash);
  if (squash) squash.wrap.hidden = !(ok && summary.squash);
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
  const seen = new Set();
  for (const issue of issues) {
    seen.add(issue.token);
    if (cards.has(issue.token)) continue;
    const card = add(null, issue);
    cards.set(issue.token, card);
    list.append(card.element);
    changed = true;
  }
  for (const push of pending) {
    seen.add(push.token);
    let card = cards.get(push.token);
    if (!card) {
      card = add(push);
      cards.set(push.token, card);
      list.append(card.element);
      changed = true;
    }
    const shown = JSON.stringify(push.summary);
    if (shown !== card.shown) {
      card.shown = shown;
      card.summary.replaceChildren(summaryOf(push.summary, card));
      choicesOf(card, push.summary);
      card.changedAt = performance.now();
      changed = true;
    }
  }
  // A push no longer waiting keeps its place (nothing shifts under the pointer), marked.
  for (const card of cards.values())
    if (!seen.has((card.issue || card.push).token) && !card.gone) {
      card.gone = true;
      if (!card.done) { card.done = true; for (const arm of card.arms) arm.button.disabled = true; card.hint.textContent = "no longer waiting (approved elsewhere, refused, or its two minutes ran out)"; }
      card.element.classList.add("gone");
      changed = true;
    }
  if (changed) disarmAll();
  const waiting = [...cards.values()].filter((card) => !card.gone).length;
  document.title = waiting ? `(${waiting}) desolate: waiting for you` : "desolate: nothing waiting";
  // Beside the git terminal: how many wait, so its page shows this frame when one does.
  // (A number, to that one origin.)
  if (EMBED && window.parent !== window) window.parent.postMessage({ desolatePending: waiting }, location.origin.replace("//desolate-approve.", "//desolate-git."));
  // Nothing waiting: said as a state of its own, with what makes something appear here. A
  // grey line alone read as a page that did not work (dogfooding, 2026-11-17, after
  // `desolate approve --web --open` with nothing waiting).
  const empty = [...cards.values()].length === 0;
  document.getElementById("empty").hidden = !empty;
  document.body.classList.toggle("nothing", empty);
  say(waiting || empty ? "" : "Nothing else is waiting. This page checks every second.");
};

const poll = async () => {
  try {
    const answer = await fetch("/pending", { credentials: sendCookie, headers: credential });
    const body = await answer.json();
    const asked = await fetch("/issues", { credentials: sendCookie, headers: credential });
    const issues = asked.ok ? (await asked.json()).issues : [];
    if (!answer.ok) say(body.error || `HTTP ${answer.status}`);
    else render(body.pending, issues);
  } catch (error) { say(`the host daemon did not answer: ${error.message}`); }
  setTimeout(poll, 1000);
};
poll();
