// Screenshots of every theme in tests/v3/demo/themes/ (and the shipped style), from the
// preview server (preview.ts, which this starts): the dashboard, the dashboard with a review
// open, and the approval page, each light and dark.
//
//   node tests/v3/demo/preview-shots.ts <out dir> [theme...]
// Writes <out>/<theme>-<page>-<light|dark>.png.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const [outArg = "preview-shots", ...only] = process.argv.slice(2);
const OUT = path.resolve(outArg);
fs.mkdirSync(OUT, { recursive: true });
const PORT = 4790 + Math.floor(Math.random() * 100);
const DEBUG = 9400 + Math.floor(Math.random() * 100);
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const themes = only.length
  ? only
  : ["shipped", ...fs.readdirSync(path.join(HERE, "themes")).filter((t) => !t.startsWith("."))];

const server = spawn(process.execPath, [path.join(HERE, "preview.ts"), String(PORT)], {
  stdio: "ignore",
});
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "preview-chrome-"));
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${DEBUG}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--hide-scrollbars",
    "about:blank",
  ],
  { stdio: "ignore" },
);
let target = "";
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  target = await fetch(`http://127.0.0.1:${DEBUG}/json`)
    .then((r) => r.json() as Promise<{ type: string; webSocketDebuggerUrl: string }[]>)
    .then((list) => list.find((t) => t.type === "page")?.webSocketDebuggerUrl ?? "")
    .catch(() => "");
}
const socket = new WebSocket(target);
await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
let nextId = 1;
const pending = new Map<number, (value: Record<string, unknown>) => void>();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data)) as {
    id?: number;
    result?: Record<string, unknown>;
  };
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)!(message.result ?? {});
    pending.delete(message.id);
  }
});
const send = (method: string, params: Record<string, unknown> = {}) =>
  new Promise<Record<string, unknown>>((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: 1440,
  height: 1000,
  deviceScaleFactor: 2,
  mobile: false,
});
const PAGES = [
  ["dashboard", (t: string) => `http://desolate.localhost:${PORT}/?theme=${t}`],
  ["review", (t: string) => `http://desolate.localhost:${PORT}/?theme=${t}&review`],
  ["approve", (t: string) => `http://desolate-approve.localhost:${PORT}/?theme=${t}`],
] as const;
for (const theme of themes)
  for (const scheme of ["dark", "light"])
    for (const [name, address] of PAGES) {
      await send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: scheme }],
      });
      await send("Page.navigate", { url: address(theme) });
      await sleep(name === "review" ? 2200 : 1400);
      const shot = await send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(
        path.join(OUT, `${theme}-${name}-${scheme}.png`),
        Buffer.from(String(shot.data), "base64"),
      );
      process.stderr.write(`preview-shots: ${theme} ${name} ${scheme}\n`);
    }
socket.close();
server.kill();
// Chrome writes to its profile until it has quit.
await new Promise((resolve) => (chrome.once("exit", resolve), chrome.kill()));
fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
