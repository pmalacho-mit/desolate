// The git terminal: a bash in the git VM (host/git-web.ts). What it draws is the terminal's
// output, which can hold whatever a file or a commit holds: links do nothing, the title is
// not touched, and there is no clipboard addon (xterm.js itself does not write the
// clipboard).
"use strict";
const status = document.getElementById("status");
const params = new URLSearchParams(location.search);
const repo = params.get("repo") || "";
// The dashboard's review opens this on a domain's branch: the terminal starts on it.
const domain = params.get("domain") || "";
const branch = params.get("branch") || "";
document.getElementById("where").textContent = repo ? `/git/${repo}${branch ? ` on ${branch}, as ${domain} has it` : ""}` : "/git";
const term = new Terminal({
  // (How much it keeps to scroll back through is the setting git.scrollbackLines: the host
  // says it with the shell, below.)
  cursorBlink: true, allowProposedApi: false, macOptionIsMeta: true,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 13,
  linkHandler: { activate: () => {}, allowNonHttpProtocols: false },
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open(document.getElementById("terminal"));
fit.fit();

const post = (url, body) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...window.desolateKey.headers }, body: JSON.stringify(body), credentials: "same-origin" });
const b64 = (bytes) => { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
const unb64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

// What the page waits on, or why it stopped, in the terminal itself, where the person is
// looking: said only in the header, it left a terminal with a cursor and nothing else
// (dogfooding, 2026-11-17: opened from the dashboard by a browser without this page's cookie).
const note = (text) => term.write(`\x1b[2m${text.replace(/\n/g, "\r\n")}\x1b[0m\r\n`);
const button = (label, onClick) => {
  const made = document.createElement("button");
  made.type = "button";
  made.textContent = label;
  made.addEventListener("click", onClick, { once: true });
  document.querySelector("header").insertBefore(made, document.getElementById("status"));
  return made;
};
const ago = (since) => {
  const minutes = Math.max(0, Math.round((Date.now() - since) / 60_000));
  return minutes < 1 ? "just now" : minutes < 120 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
};

// A shell whose tab went (closed, a laptop's lid, a reload) is still there, as it was: when
// this page opens, it says so and offers to go back to it, before it opens another.
const offerLeft = async () => {
  let body = null;
  try {
    const answer = await fetch("/sessions", { credentials: "same-origin", headers: window.desolateKey.headers });
    body = answer.ok ? await answer.json() : null;
  } catch {
    /* the host says why when a shell is asked for */
  }
  const left = body && Array.isArray(body.left) ? body.left : [];
  if (!left.length) return start();
  note(`${left.length === 1 ? "A shell" : `${left.length} shells`} you left without closing ${left.length === 1 ? "is" : "are"} still open in the git VM:`);
  const made = [];
  const choose = (then) => () => { for (const b of made) b.remove(); then(); };
  for (const s of left) {
    note(`  in ${s.where}, left ${ago(s.since)}`);
    made.push(button(`Back to the shell in ${s.where} (${ago(s.since)})`, choose(() => attach(s.id, s.token, body))));
  }
  made.push(button("New shell", choose(start)));
  status.textContent = "waiting for you";
};

const start = async () => {
  status.textContent = "starting...";
  const slow = setTimeout(() => note("Starting the git VM and your clone there: the first time takes a minute or two..."), 1500);
  let answer;
  try {
    answer = await post("/session", { repo, ...(domain && branch ? { domain, branch } : {}) });
  } catch (error) {
    clearTimeout(slow);
    status.textContent = "the host daemon did not answer";
    note(`The host daemon did not answer (${error.message}). Is desolate running? On the Mac: desolate doctor`);
    return;
  }
  clearTimeout(slow);
  const body = await answer.json().catch(() => ({}));
  if (!answer.ok) {
    status.textContent = body.error || `HTTP ${answer.status}`;
    note(answer.status === 401
      ? "This browser is not signed in to the git terminal. On the Mac, run:\n\n    desolate ui --open\n\nonce: it signs this browser in to every page (the dashboard, this one, the approval page) until the browser quits. (desolate ui --link prints the link, for another browser.)"
      : `The shell did not start: ${body.error || `HTTP ${answer.status}`}`);
    return;
  }
  attach(body.id, body.token, body);
};

/** Read shell `id` and type into it. `bounds`: what the host said of it (shell input in base64
 *  characters a request, and the lines to keep for scrolling back). */
const attach = (id, token, bounds) => {
  if (Number.isInteger(bounds.scrollback) && bounds.scrollback > 0) term.options.scrollback = bounds.scrollback;
  // A paste larger than one request is sent in parts, in order: base64 is 4 characters for 3 bytes.
  const part = Math.max(3, Math.floor((Number(bounds.input) || 4) / 4) * 3);
  const encoder = new TextEncoder();
  let queue = Promise.resolve();
  const send = (bytes) => {
    for (let at = 0; at < bytes.length; at += part) {
      const piece = bytes.subarray(at, at + part);
      queue = queue.then(() => post(`/session/${id}/input`, { token, data: b64(piece) })).catch(() => {});
    }
  };
  term.onData((data) => send(encoder.encode(data)));
  term.onBinary((data) => send(Uint8Array.from(data, (c) => c.charCodeAt(0) & 255)));
  const resize = () => { fit.fit(); post(`/session/${id}/resize`, { token, cols: term.cols, rows: term.rows }).catch(() => {}); };
  window.addEventListener("resize", resize);
  const stream = new EventSource(`/session/${id}/stream?token=${token}&${window.desolateKey.query}`);
  stream.onopen = () => { status.textContent = ""; resize(); term.focus(); };
  stream.onmessage = (event) => term.write(unb64(event.data));
  stream.addEventListener("end", () => { status.textContent = "the shell ended: reload for another"; stream.close(); });
  // No reconnecting by itself: a reconnect would replay what the shell printed into what this
  // tab shows already. The shell itself stays: a reload offers it back, as it was.
  stream.onerror = () => { stream.close(); status.textContent = "disconnected: reload this page to go back to the shell"; };
};
// An address that names a domain's branch changes the clone: the terminal checks that branch
// out (git-vm.ts checkoutOffered). Any page can send the browser to such an address, so the
// page says what it would do and waits for the person's click (audit, 2026-11-20). An address
// with no branch only opens a shell: at once, or after offering back one left open.
if (domain && branch) {
  note(`This address asks to check out ${branch} of ${repo}, as the domain ${domain} has it, in your clone in the git VM.`);
  note("Opened from the dashboard's Open in git, that is what you asked for. If you did not open it, close this tab.");
  const go = button(`Check out ${branch} from ${domain}`, () => { go.remove(); start(); });
  status.textContent = "waiting for you";
} else offerLeft();

// Pushes waiting for approval, beside the terminal: the approval page itself (its /embed),
// in a frame of its own origin. This page gives it its address and learns from it how many
// wait (a number, from that origin only); it opens when one does, and the button keeps it
// open or closed after that.
const aside = document.getElementById("approvals");
const toggle = document.getElementById("toggle");
const APPROVE_ORIGIN = location.origin.replace("//desolate-git.", "//desolate-approve.");
let chosen = null; // the person's choice, once made: true open, false closed
const frame = document.getElementById("frame");
const show = (open) => {
  if (aside.hidden === !open) return;
  aside.hidden = !open;
  window.dispatchEvent(new Event("resize"));
};
toggle.addEventListener("click", () => { chosen = aside.hidden; show(chosen); if (!chosen) term.focus(); });
// The person decided in the pane (approve.js says so): once nothing waits, the keys go to the
// shell again, not to the pane last clicked (dogfooding, 2026-11-21: the next command typed
// went nowhere). A push that leaves the list by itself does not take the keys from the pane.
let decided = false;
window.addEventListener("message", (event) => {
  if (event.origin !== APPROVE_ORIGIN || !event.data) return;
  if (event.data.desolateDecided === true) decided = true;
  if (typeof event.data.desolatePending !== "number") return;
  const waiting = Math.max(0, Math.floor(event.data.desolatePending));
  toggle.textContent = waiting ? `Approvals (${waiting})` : "Approvals";
  toggle.classList.toggle("waiting", waiting > 0);
  if (waiting > 0 && chosen !== false) show(true);
  if (waiting === 0 && chosen === null) show(false);
  if (waiting === 0 && decided && document.activeElement === frame) term.focus();
  if (waiting === 0) decided = false;
});
fetch("/approvals-frame", { credentials: "same-origin", headers: window.desolateKey.headers }).then((answer) => answer.ok ? answer.json() : null).then((body) => {
  if (!body || typeof body.url !== "string" || !body.url.startsWith(`${APPROVE_ORIGIN}/embed#`)) return;
  frame.src = body.url;
  toggle.hidden = false;
}).catch(() => {});
