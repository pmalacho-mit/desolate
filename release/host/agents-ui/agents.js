// Your agents, from your phone (host/agents-web.ts). What an agent printed is drawn by
// xterm.js as its terminal draws it, never put on the page as HTML; names and states are
// set as text. Links in it do nothing, and the title is not touched.
"use strict";
const $ = (id) => document.getElementById(id);
const status = (text) => { $("status").textContent = text; };
const post = (url, body) => fetch(url, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-desolate-agents": "1" }, body: JSON.stringify(body) });
const unb64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const ago = (when) => {
  if (!when) return "nothing printed yet";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(when)) / 1000));
  return s < 90 ? `printed ${s} s ago` : s < 5400 ? `printed ${Math.round(s / 60)} min ago` : `printed ${Math.round(s / 3600)} h ago`;
};
const el = (tag, attrs, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) k === "onclick" ? node.addEventListener("click", v) : node.setAttribute(k, v);
  for (const child of children) node.append(child);
  return node;
};

let current = null; // { at, name, term, from, timer }

const showList = async () => {
  if (current) { clearTimeout(current.timer); current.term.dispose(); current = null; }
  $("agent").hidden = true;
  $("list").hidden = false;
  status("asking...");
  const answer = await fetch("/list", { credentials: "same-origin" });
  if (!answer.ok) { status(await answer.text()); return; }
  const rows = await answer.json();
  $("agents").replaceChildren(...rows.map((a) => el("li", {},
    el("button", { class: "open", type: "button", onclick: () => open(a) },
      el("span", { class: `dot ${a.state}` }),
      el("span", { class: "what" },
        el("div", { class: "name" }, `${a.workspace}  ${a.name}`),
        el("div", { class: "line" }, `${a.state}, ${ago(a.lastOutput)}`),
        el("div", { class: "line" }, a.command))))));
  $("none").hidden = rows.length > 0;
  status("");
};

// The agent's terminal is as wide as it was made; the page draws it that wide and as small
// as it must to fit, scrolling sideways past what is readable.
const COLS = 120;
const open = (agent) => {
  $("list").hidden = true;
  $("agent").hidden = false;
  $("title").textContent = `${agent.workspace}  ${agent.name}`;
  const width = $("screen").clientWidth - 12;
  const fontSize = Math.max(7, Math.min(13, Math.floor(width / (COLS * 0.6))));
  const term = new Terminal({ cols: COLS, rows: 40, fontSize, disableStdin: true, scrollback: 3000, allowProposedApi: false,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", linkHandler: { activate: () => {}, allowNonHttpProtocols: false } });
  $("terminal").replaceChildren();
  term.open($("terminal"));
  current = { at: agent.workspace, name: agent.name, term, from: -1, timer: 0 };
  const mine = current;
  const poll = async () => {
    if (current !== mine) return;
    try {
      const answer = await fetch(`/output?at=${encodeURIComponent(mine.at)}&name=${encodeURIComponent(mine.name)}&from=${mine.from}`, { credentials: "same-origin" });
      if (answer.ok) {
        const got = await answer.json();
        if (got.data) mine.term.write(unb64(got.data));
        mine.from = got.next;
        status("");
      } else status(await answer.text());
    } catch { status("the Mac did not answer; trying again"); }
    if (current === mine) mine.timer = setTimeout(poll, document.hidden ? 10000 : 2000);
  };
  mine.poll = poll;
  poll();
};
// Now, rather than at the next tick: Refresh, or the phone woken.
const now = () => { if (current && current.poll) { clearTimeout(current.timer); current.poll(); } };

const say = async (body) => {
  if (!current) return;
  status("sending...");
  const answer = await post("/say", { at: current.at, name: current.name, ...body });
  status(answer.ok ? "sent" : await answer.text());
};

$("say").addEventListener("submit", (event) => {
  event.preventDefault();
  const line = $("line").value;
  if (line === "") return say({ key: "enter" });
  $("line").value = "";
  say({ text: line });
});
for (const button of document.querySelectorAll("[data-key]")) button.addEventListener("click", () => say({ key: button.dataset.key }));
$("back").addEventListener("click", showList);
$("refresh").addEventListener("click", () => (current ? now() : showList()));
document.addEventListener("visibilitychange", () => { if (!document.hidden) now(); });
showList();
