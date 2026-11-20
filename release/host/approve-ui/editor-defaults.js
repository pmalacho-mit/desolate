// The editor-defaults page (host/approve-web.ts, /editor-defaults): every workspace's editor's
// default settings, as JSON, with the two most asked for (theme, auto save) as choices.
"use strict";
const $ = (id) => document.getElementById(id);
const say = (text) => { $("status").textContent = text; };
const THEME = "workbench.colorTheme";
const AUTOSAVE = "files.autoSave";
const parsed = () => {
  const value = JSON.parse($("json").value || "{}");
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not a settings object");
  return value;
};
const show = (settings) => {
  $("json").value = JSON.stringify(settings, null, 2);
  fromJson();
};
// The two choices follow the JSON, and the JSON follows them.
const fromJson = () => {
  try {
    const s = parsed();
    for (const [id, key] of [["theme", THEME], ["autosave", AUTOSAVE]]) {
      const select = $(id);
      const value = typeof s[key] === "string" ? s[key] : "";
      if (value && ![...select.options].some((o) => o.value === value)) { const o = document.createElement("option"); o.value = value; o.textContent = value; select.append(o); }
      select.value = value;
    }
    $("said").textContent = "";
  } catch (error) { $("said").textContent = `not JSON yet: ${error.message}`; }
};
const fromChoice = (key, value) => {
  try {
    const s = parsed();
    if (value) s[key] = value; else delete s[key];
    $("json").value = JSON.stringify(s, null, 2);
  } catch { /* the JSON is being edited: leave it */ }
};
$("theme").addEventListener("change", () => fromChoice(THEME, $("theme").value));
$("autosave").addEventListener("change", () => fromChoice(AUTOSAVE, $("autosave").value));
$("json").addEventListener("input", fromJson);
const save = async (settings) => {
  try {
    const answer = await fetch("/editor-defaults/set", { method: "POST", headers: { "content-type": "application/json", ...window.desolateKey.headers }, body: JSON.stringify({ settings }), credentials: "same-origin" });
    const done = await answer.json().catch(() => ({}));
    if (!answer.ok) throw new Error(done.error || `HTTP ${answer.status}`);
    show(done.settings);
    say(`Saved. ${done.applied} of ${done.running} running editor${done.running === 1 ? "" : "s"} have them now; an open editor takes them when its tab is reloaded.`);
  } catch (error) { say(`not saved: ${error.message}`); }
};
$("save").addEventListener("click", () => { try { save(parsed()); } catch (error) { say(`not saved: ${error.message}`); } });
$("reset").addEventListener("click", () => save({ [AUTOSAVE]: "off" }));
(async () => {
  try {
    const answer = await fetch("/editor-defaults/get", { credentials: "same-origin", headers: window.desolateKey.headers });
    const body = await answer.json().catch(() => ({}));
    if (answer.status === 401) { say("This browser has not opened the approval page's own address yet. On the Mac, run desolate approve --web --open once: it gives this browser the cookie this page needs too. Then reload this page."); return; }
    if (!answer.ok) throw new Error(body.error || `HTTP ${answer.status}`);
    $("main").hidden = false;
    show(body.settings);
  } catch (error) { say(`not read: ${error.message}`); }
})();
