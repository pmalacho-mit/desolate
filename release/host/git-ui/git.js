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
  cursorBlink: true, scrollback: 5000, allowProposedApi: false, macOptionIsMeta: true,
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
      ? "This browser has not opened the git terminal's own address yet. On the Mac, run:\n\n    desolate git --open\n\nonce: it carries this stack's token, and gives this browser the cookie it needs. After that, Open in git on the dashboard opens it."
      : `The shell did not start: ${body.error || `HTTP ${answer.status}`}`);
    return;
  }
  const { id, token } = body;
  const encoder = new TextEncoder();
  let queue = Promise.resolve();
  const send = (bytes) => { queue = queue.then(() => post(`/session/${id}/input`, { token, data: b64(bytes) })).catch(() => {}); };
  term.onData((data) => send(encoder.encode(data)));
  term.onBinary((data) => send(Uint8Array.from(data, (c) => c.charCodeAt(0) & 255)));
  const resize = () => { fit.fit(); post(`/session/${id}/resize`, { token, cols: term.cols, rows: term.rows }).catch(() => {}); };
  window.addEventListener("resize", resize);
  const stream = new EventSource(`/session/${id}/stream?token=${token}&${window.desolateKey.query}`);
  stream.onopen = () => { status.textContent = ""; resize(); term.focus(); };
  stream.onmessage = (event) => term.write(unb64(event.data));
  stream.addEventListener("end", () => { status.textContent = "the shell ended: reload for another"; stream.close(); });
  // No reconnecting by itself: a reconnect would replay what the shell printed.
  stream.onerror = () => { stream.close(); status.textContent = "disconnected: reload for another shell"; };
};
// An address that names a domain's branch changes the clone: the terminal checks that branch
// out (git-vm.ts checkoutOffered). Any page can send the browser to such an address, so the
// page says what it would do and waits for the person's click (audit, 2026-11-20). An address
// with no branch only opens a shell, and starts at once.
if (domain && branch) {
  note(`This address asks to check out ${branch} of ${repo}, as the domain ${domain} has it, in your clone in the git VM.`);
  note("Opened from the dashboard's Open in git, that is what you asked for. If you did not open it, close this tab.");
  const go = document.createElement("button");
  go.type = "button";
  go.textContent = `Check out ${branch} from ${domain}`;
  go.addEventListener("click", () => { go.remove(); start(); }, { once: true });
  document.querySelector("header").insertBefore(go, document.getElementById("status"));
  status.textContent = "waiting for you";
} else start();

// Pushes waiting for approval, beside the terminal: the approval page itself (its /embed),
// in a frame of its own origin. This page gives it its address and learns from it how many
// wait (a number, from that origin only); it opens when one does, and the button keeps it
// open or closed after that.
const aside = document.getElementById("approvals");
const toggle = document.getElementById("toggle");
const APPROVE_ORIGIN = location.origin.replace("//desolate-git.", "//desolate-approve.");
let chosen = null; // the person's choice, once made: true open, false closed
const show = (open) => {
  if (aside.hidden === !open) return;
  aside.hidden = !open;
  window.dispatchEvent(new Event("resize"));
};
toggle.addEventListener("click", () => { chosen = aside.hidden; show(chosen); });
window.addEventListener("message", (event) => {
  if (event.origin !== APPROVE_ORIGIN || !event.data || typeof event.data.desolatePending !== "number") return;
  const waiting = Math.max(0, Math.floor(event.data.desolatePending));
  toggle.textContent = waiting ? `Approvals (${waiting})` : "Approvals";
  toggle.classList.toggle("waiting", waiting > 0);
  if (waiting > 0 && chosen !== false) show(true);
  if (waiting === 0 && chosen === null) show(false);
});
fetch("/approvals-frame", { credentials: "same-origin", headers: window.desolateKey.headers }).then((answer) => answer.ok ? answer.json() : null).then((body) => {
  if (!body || typeof body.url !== "string" || !body.url.startsWith(`${APPROVE_ORIGIN}/embed#`)) return;
  document.getElementById("frame").src = body.url;
  toggle.hidden = false;
}).catch(() => {});
