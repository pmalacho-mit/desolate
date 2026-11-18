// The secrets page (host/approve-web.ts, /secrets): a domain's secrets, by name, and a form
// to add or replace one. Names and hosts are shown as text; a value is typed here, sent to the
// Mac once, and never comes back.
"use strict";
const $ = (id) => document.getElementById(id);
const el = (tag, text, cls) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (cls) node.className = cls; return node; };
const form = $("form");
const importCard = $("import");
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
    // Its value is never sent to a page. The person's own terminal can have it.
    const see = el("div", "To see its value, in a terminal on your Mac: ", "hint");
    see.append(el("code", `desolate domain ${domain} secret show ${s.name}`));
    what.append(see);
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
    importCard.hidden = !domain;
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

// ---- Import a .env: plan it (the Mac judges each entry and sends back keys, hosts and why,
// never a value), change what is wrong, import, and take the .env with names.
let planned = null; // { text, rows }
const KINDS = [["secret", "secret"], ["value", "value"], ["local", "stays (the app uses it itself)"]];
const showPlan = (rows) => {
  const out = $("plan-out");
  const table = el("table", undefined, "plan");
  const head = el("tr");
  for (const title of ["Key", "Becomes", "Hosts it may go to", "Only in headers", "Why"]) head.append(el("th", title));
  table.append(head);
  for (const row of rows) {
    const tr = el("tr", undefined, row.kind === "ask" ? "ask" : "");
    tr.dataset.key = row.key;
    const kind = el("select");
    for (const [value, label] of KINDS) { const o = el("option", label); o.value = value; o.selected = value === (row.kind === "ask" ? "value" : row.kind); kind.append(o); }
    kind.setAttribute("aria-label", `what ${row.key} becomes`);
    const hosts = el("input"); hosts.value = (row.hosts || []).join(", "); hosts.className = "mono"; hosts.placeholder = "api.example.com"; hosts.setAttribute("aria-label", `where ${row.key} may go`);
    const headers = el("input"); headers.value = (row.headers || []).join(", "); headers.className = "mono"; headers.placeholder = "anywhere"; headers.setAttribute("aria-label", `the headers ${row.key} may go in`);
    const sync = () => { hosts.disabled = headers.disabled = kind.value !== "secret"; };
    kind.addEventListener("change", sync); sync();
    const why = el("td");
    why.append(el("div", row.kind === "ask" ? `${row.why}: left a value unless you name its hosts` : row.why, "why"));
    if (row.name) why.append(el("div", `in the workspace: ${row.key}=${row.name}`, "mono why"));
    for (const w of row.warnings) why.append(el("div", w, "warn"));
    const cell = (node, cls) => { const td = el("td", undefined, cls); td.append(node); return td; };
    tr.append(el("td", row.key, "key mono"), cell(kind), cell(hosts), cell(headers), why);
    tr.read = () => ({ key: row.key, kind: kind.value, hosts: csv(hosts.value), headers: csv(headers.value) });
    table.append(tr);
  }
  const go = el("button", "Import", "approve");
  go.type = "button";
  go.id = "import-go";
  go.onclick = async () => {
    const choices = [...table.querySelectorAll("tr[data-key]")].map((tr) => tr.read());
    try {
      go.disabled = true;
      const done = await post("/secrets/import/apply", { text: planned.text, choices });
      show(done.secrets);
      $("env-new").value = done.env;
      $("env-out").hidden = false;
      const made = done.rows.filter((r) => r.kind === "secret").length;
      say(`${made} secret${made === 1 ? "" : "s"} held in the root for ${domain}. The workspace's .env is below.`);
      $("env-out").scrollIntoView({ block: "nearest" });
    } catch (error) { say(`not imported: ${error.message}`); } finally { go.disabled = false; }
  };
  const counts = (kind) => rows.filter((r) => r.kind === kind).length;
  out.replaceChildren(el("p", `${counts("secret")} would become secrets, ${counts("local")} stay values the app uses itself, ${counts("ask")} could not be told${counts("ask") ? " (marked ?)" : ""}, ${counts("value")} are not secrets.`, "hint"), table, go);
};
$("plan").addEventListener("click", async () => {
  const text = $("env").value;
  try {
    const answer = await post("/secrets/import/plan", { text });
    planned = { text, rows: answer.rows };
    $("env-out").hidden = true;
    showPlan(answer.rows);
    $("plan-said").textContent = "";
  } catch (error) { $("plan-said").textContent = `not planned: ${error.message}`; }
});
$("env-file").addEventListener("change", async () => {
  const file = $("env-file").files[0];
  if (!file) return;
  if (file.size > 65536) { $("plan-said").textContent = "that file is over 64 KiB: not a .env"; return; }
  $("env").value = await file.text();
  $("plan").click();
});
$("copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("env-new").value); say("Copied."); } catch { $("env-new").select(); say("Select-all, then copy."); }
});
$("download").addEventListener("click", () => {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([$("env-new").value], { type: "text/plain" }));
  link.download = ".env";
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
});
