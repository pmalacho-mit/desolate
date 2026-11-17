// A page as a real browser leaves it, for the tiers' checks: headless Chrome driven over its
// DevTools protocol. It replaced `chrome --headless --dump-dom`, which Chrome 157.0.8103.79
// (2026-11-16) crashes in on macOS (exit 139, "Mach rendezvous failed"), even on a data: URL,
// so every check that read a page saw an empty one. The same Chrome over DevTools works.
//
// What comes back keeps the shape the checks were written against: `stdout` is the page's DOM,
// serialized (what --dump-dom printed), and `stderr` holds what the page said, one line each,
// as Chrome's own log wrote it: `INFO:CONSOLE ...` for the console, `Uncaught ...` for an
// exception, and the browser's own messages (a Content Security Policy refusal among them).
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** Chrome or Chromium on this machine (DESOLATE_CHROME first), or "" if there is none. */
export const findChrome = () =>
  [process.env.DESOLATE_CHROME, "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((file) => file && fs.existsSync(file)) ?? "";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type Loaded = { stdout: string; stderr: string };

/** Load `url` in a Chrome with the profile `profile` (a directory: cookies kept there are kept
 *  for the next load with it), and give back its DOM and what it said. It waits until `until`
 *  matches the DOM or what the page said, else for the page to load and `ms` to pass, as
 *  --virtual-time-budget did. `screenshot`: a PNG of the page, there, as well. */
export const loadPage = async (chrome: string, profile: string, url: string, options: { until?: RegExp; ms?: number; width?: number; height?: number; screenshot?: string } = {}): Promise<Loaded> => {
  const { until, ms = 6000, width = 1280, height = 900 } = options;
  fs.mkdirSync(profile, { recursive: true });
  const portFile = path.join(profile, "DevToolsActivePort");
  fs.rmSync(portFile, { force: true });
  const browser = spawn(chrome, ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${profile}`,
    "--host-resolver-rules=MAP *.localhost 127.0.0.1", "--remote-debugging-port=0", `--window-size=${width},${height}`, "about:blank"], { stdio: "ignore" });
  const exited = new Promise((resolve) => browser.once("exit", resolve));
  const said: string[] = [];
  let socket: WebSocket | undefined;
  try {
    // Chrome writes the port it chose into the profile.
    let port = "";
    for (let i = 0; i < 100 && !port; i++) {
      await sleep(100);
      if (fs.existsSync(portFile)) port = fs.readFileSync(portFile, "utf8").split("\n")[0]!.trim();
    }
    if (!port) throw new Error(`Chrome (${chrome}) did not start`);
    const version = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl: string };
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    socket = ws;
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error("DevTools did not answer")), { once: true });
    });
    let nextId = 1;
    const pending = new Map<number, (result: Record<string, unknown>) => void>();
    let loaded = false;
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: Record<string, unknown>; error?: { message: string }; method?: string; params?: Record<string, any> };
      if (message.id !== undefined) {
        pending.get(message.id)?.(message.result ?? { error: message.error?.message });
        pending.delete(message.id);
        return;
      }
      const p = message.params ?? {};
      if (message.method === "Runtime.consoleAPICalled")
        said.push(`INFO:CONSOLE(${p.type}) ${(p.args as { value?: unknown; description?: string }[]).map((a) => (a.value !== undefined ? String(a.value) : a.description ?? "")).join(" ")}`);
      else if (message.method === "Runtime.exceptionThrown") said.push(`Uncaught ${p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? "exception"}`);
      else if (message.method === "Log.entryAdded") said.push(`${String(p.entry?.level ?? "").toUpperCase()}:${p.entry?.source ?? "browser"} ${p.entry?.text ?? ""}`);
      else if (message.method === "Page.loadEventFired") loaded = true;
    });
    let sessionId = "";
    const send = (method: string, params: Record<string, unknown> = {}) =>
      new Promise<Record<string, unknown>>((resolve) => {
        const id = nextId++;
        pending.set(id, resolve);
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    const { targetId } = (await send("Target.createTarget", { url: "about:blank" })) as { targetId: string };
    sessionId = ((await send("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string }).sessionId;
    for (const domain of ["Page", "Runtime", "Log"]) await send(`${domain}.enable`);
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url });
    const dom = async () => String(((await send("Runtime.evaluate", { expression: "document.documentElement ? document.documentElement.outerHTML : ''", returnByValue: true })) as { result?: { value?: unknown } }).result?.value ?? "");
    let html = "";
    for (const end = Date.now() + ms; ; await sleep(250)) {
      html = await dom();
      if (until ? until.test(html) || until.test(said.join("\n")) : false) break;
      if (Date.now() >= end && (loaded || Date.now() >= end + ms)) break;
    }
    if (options.screenshot) {
      const shot = (await send("Page.captureScreenshot", { format: "png" })) as { data?: string };
      if (shot.data) fs.writeFileSync(options.screenshot, Buffer.from(shot.data, "base64"));
    }
    return { stdout: html, stderr: said.join("\n") };
  } finally {
    socket?.close();
    browser.kill();
    await exited;
  }
};
