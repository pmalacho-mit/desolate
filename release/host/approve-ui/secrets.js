// The secrets page (host/approve-web.ts, /secrets): a domain's secrets, by name, and a form
// to add or replace one. Names and hosts are shown as text; a value is typed here, sent to the
// Mac once, and never comes back.
"use strict";
const $ = (id) => document.getElementById(id);
const el = (tag, text, cls) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (cls) node.className = cls; return node; };
const form = $("form");
const select = $("domain");
const asked = new URLSearchParams(location.search);
let domain = asked.get("domain") || "";
const say = (text) => { $("status").textContent = text; };
const post = async (path, body) => {
  const answer = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ domain, ...body }), credentials: "same-origin" });
  const value = await answer.json().catch(() => ({}));
  if (!answer.ok) throw new Error(value.error || `HTTP ${answer.status}`);
  return value;
};
const csv = (text) => text.split(",").map((part) => part.trim()).filter(Boolean);

const show = (secrets) => {
  const list = $("list");
  if (!domain) return list.replaceChildren(el("p", "Choose a domain.", "hint"));
  if (!secrets.length) return list.replaceChildren(el("p", `The domain ${domain} has no secrets yet. Add one below.`, "hint"));
  list.replaceChildren(...secrets.map((s) => {
    const row = el("div", undefined, "secret");
    const what = el("div", undefined, "what");
    what.append(el("div", s.name, "mono name"));
    what.append(el("div", `to ${s.hosts.join(", ")}${s.headers ? `, in ${s.headers.join(", ")} only` : ""}`, "hint"));
    const state = el("span", !s.on ? "off" : s.secondsLeft !== undefined ? `on, ${Math.round(s.secondsLeft / 60)} min left` : "on", `pill ${s.on ? "on" : "off"}`);
    const buttons = el("div", undefined, "buttons");
    const toggle = el("button", s.on ? "Switch off" : "Switch on");
    toggle.title = s.on ? "its value goes nowhere until it is switched on again" : "send it again, to its hosts";
    toggle.onclick = () => act(() => post("/secrets/switch", { name: s.name, on: !s.on }), `${s.name} is ${s.on ? "off" : "on"}.`);
    const replace = el("button", "Replace value");
    replace.title = "fill the form with its name, hosts and headers; type the new value";
    replace.onclick = () => { form.elements.name.value = s.name; form.elements.hosts.value = s.hosts.join(", "); form.elements.headers.value = (s.headers || []).join(", "); $("form-title").textContent = `Replace ${s.name}`; form.elements.value.value = ""; form.elements.value.focus(); };
    const remove = el("button", "Remove", "danger");
    remove.onclick = () => { if (confirm(`Remove ${s.name} from ${domain}? Its value is deleted in the root; a workspace that sends its name toward ${s.hosts.join(", ")} is refused.`)) act(() => post("/secrets/remove", { name: s.name }), `${s.name} is removed.`); };
    buttons.append(state, toggle, replace, remove);
    row.append(what, buttons);
    return row;
  }));
};

const load = async () => {
  try {
    const answer = await fetch(`/secrets/list?domain=${encodeURIComponent(domain)}`, { credentials: "same-origin" });
    const body = await answer.json().catch(() => ({}));
    if (answer.status === 401) {
      $("list").replaceChildren(el("p", "This browser has not opened the approval page's own address yet. On the Mac, run desolate approve --web --open once: it gives this browser the cookie the secrets page needs too. Then reload this page.", "error"));
      form.hidden = true;
      return;
    }
    if (!answer.ok) throw new Error(body.error || `HTTP ${answer.status}`);
    if (!body.domains.includes(domain)) domain = "";
    select.replaceChildren(el("option", "choose a domain"), ...body.domains.map((d) => { const o = el("option", d); o.value = d; o.selected = d === domain; return o; }));
    select.firstChild.value = "";
    form.hidden = !domain;
    show(body.secrets);
    say("");
  } catch (error) { say(`not read: ${error.message}`); }
};
const act = async (doing, done) => {
  try { const answer = await doing(); show(answer.secrets); say(done); } catch (error) { say(`not done: ${error.message}`); }
};
select.addEventListener("change", () => {
  domain = select.value;
  history.replaceState(null, "", domain ? `/secrets?domain=${encodeURIComponent(domain)}` : "/secrets");
  load();
});
form.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = form.elements.name.value.trim();
  act(() => post("/secrets/set", { name, value: form.elements.value.value, hosts: csv(form.elements.hosts.value), headers: csv(form.elements.headers.value) }), `${name} is held in the root for ${domain}. In a workspace: export SOME_API_KEY=${name} (the name is not a secret).`)
    .then(() => { form.elements.value.value = ""; });
});
$("clear").addEventListener("click", () => { form.reset(); $("form-title").textContent = "Add a secret"; });
load();
