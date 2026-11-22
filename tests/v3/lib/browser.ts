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

/** Playwright's Chromium, where .devcontainer/setup-test-tools.sh put it (the newest first). */
const playwrightChromes = () =>
  [
    "/desolate/scratch/playwright",
    path.join(process.env.HOME ?? "/", ".cache", "ms-playwright"),
  ].flatMap((dir) => {
    try {
      return fs
        .readdirSync(dir)
        .filter((name) => name.startsWith("chromium-"))
        .sort()
        .reverse()
        .map((name) => path.join(dir, name, "chrome-linux", "chrome"));
    } catch {
      return [];
    }
  });

/** Chrome or Chromium on this machine (DESOLATE_CHROME first), or "" if there is none.
 *  Playwright's before the distribution's: arm64 Ubuntu's `chromium-browser` is a stub for a
 *  snap, which does not start in a container ("did not start": a suite run without run.sh,
 *  which looked there itself, 2026-11-17). */
export const findChrome = () =>
  [
    process.env.DESOLATE_CHROME,
    ...playwrightChromes(),
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].find((file) => file && fs.existsSync(file)) ?? "";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type Loaded = { stdout: string; stderr: string };
export type LoadOptions = { until?: RegExp; ms?: number; settle?: number; screenshot?: string };

/** A headless Chrome with the profile `profile`, kept running: what one page is given (a
 *  cookie) the next page it loads has, as in a person's browser. `close` when done. */
export const openBrowser = async (
  chrome: string,
  profile: string,
  size: { width?: number; height?: number } = {},
) => {
  const { width = 1280, height = 900 } = size;
  fs.mkdirSync(profile, { recursive: true });
  const portFile = path.join(profile, "DevToolsActivePort");
  fs.rmSync(portFile, { force: true });
  const browser = spawn(
    chrome,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${profile}`,
      "--host-resolver-rules=MAP *.localhost 127.0.0.1",
      "--remote-debugging-port=0",
      `--window-size=${width},${height}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const exited = new Promise((resolve) => browser.once("exit", resolve));
  let ws: WebSocket;
  try {
    // Chrome writes the port it chose into the profile.
    let port = "";
    for (let i = 0; i < 100 && !port; i++) {
      await sleep(100);
      if (fs.existsSync(portFile)) port = fs.readFileSync(portFile, "utf8").split("\n")[0]!.trim();
    }
    if (!port) throw new Error(`Chrome (${chrome}) did not start`);
    const version = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as {
      webSocketDebuggerUrl: string;
    };
    ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error("DevTools did not answer")), {
        once: true,
      });
    });
  } catch (error) {
    browser.kill();
    await exited;
    throw error;
  }

  let nextId = 1;
  const pending = new Map<number, (result: Record<string, unknown>) => void>();
  type Listener = (method: string, params: Record<string, any>) => void;
  const listeners = new Map<string, Listener>(); // by session
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number;
      result?: Record<string, unknown>;
      error?: { message: string };
      method?: string;
      params?: Record<string, any>;
      sessionId?: string;
    };
    if (message.id !== undefined) {
      pending.get(message.id)?.(message.result ?? { error: message.error?.message });
      pending.delete(message.id);
    } else if (message.method && message.sessionId)
      listeners.get(message.sessionId)?.(message.method, message.params ?? {});
  });
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

  /** Load `url` in a tab of its own and give back its DOM and what it said. It waits until
   *  `until` matches the DOM or what the page said, else for the page to load and `ms` to
   *  pass, as --virtual-time-budget did; then, if `settle` is given, that long more, for what
   *  the page does after (a worker's colours). `screenshot`: a PNG of the page, there, too. */
  const load = async (url: string, options: LoadOptions = {}): Promise<Loaded> => {
    const { until, ms = 6000, settle = 0 } = options;
    const { targetId } = (await send("Target.createTarget", { url: "about:blank" })) as {
      targetId: string;
    };
    const { sessionId } = (await send("Target.attachToTarget", { targetId, flatten: true })) as {
      sessionId: string;
    };
    const said: string[] = [];
    let loaded = false;
    listeners.set(sessionId, (method, p) => {
      if (method === "Runtime.consoleAPICalled")
        said.push(
          `INFO:CONSOLE(${p.type}) ${(p.args as { value?: unknown; description?: string }[]).map((a) => (a.value !== undefined ? String(a.value) : (a.description ?? ""))).join(" ")}`,
        );
      else if (method === "Runtime.exceptionThrown")
        said.push(
          `Uncaught ${p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? "exception"}`,
        );
      else if (method === "Log.entryAdded")
        said.push(
          `${String(p.entry?.level ?? "").toUpperCase()}:${p.entry?.source ?? "browser"} ${p.entry?.text ?? ""}`,
        );
      else if (method === "Page.loadEventFired") loaded = true;
    });
    try {
      for (const domain of ["Page", "Runtime", "Log"])
        await send(`${domain}.enable`, {}, sessionId);
      await send(
        "Emulation.setDeviceMetricsOverride",
        { width, height, deviceScaleFactor: 1, mobile: false },
        sessionId,
      );
      await send("Page.navigate", { url }, sessionId);
      const dom = async () =>
        String(
          (
            (await send(
              "Runtime.evaluate",
              {
                expression: "document.documentElement ? document.documentElement.outerHTML : ''",
                returnByValue: true,
              },
              sessionId,
            )) as { result?: { value?: unknown } }
          ).result?.value ?? "",
        );
      let html = "";
      for (const end = Date.now() + ms; ; await sleep(250)) {
        html = await dom();
        if (until && (until.test(html) || until.test(said.join("\n")))) break;
        if (Date.now() >= end && (loaded || Date.now() >= end + ms)) break;
      }
      if (settle) {
        await sleep(settle);
        html = await dom();
      }
      if (options.screenshot) {
        const shot = (await send("Page.captureScreenshot", { format: "png" }, sessionId)) as {
          data?: string;
        };
        if (shot.data) fs.writeFileSync(options.screenshot, Buffer.from(shot.data, "base64"));
      }
      return { stdout: html, stderr: said.join("\n") };
    } finally {
      listeners.delete(sessionId);
      await send("Target.closeTarget", { targetId });
    }
  };
  /** A tab that stays open, driven as a person drives a page: the pointer moves to what it
   *  clicks, keys are typed, and a confirm() is answered yes. For the dashboard's journeys
   *  (t2/19-journeys): what a person does there, not the requests it makes. */
  const tab = async (url: string) => {
    const { targetId } = (await send("Target.createTarget", { url: "about:blank" })) as {
      targetId: string;
    };
    const { sessionId } = (await send("Target.attachToTarget", { targetId, flatten: true })) as {
      sessionId: string;
    };
    const said: string[] = [];
    listeners.set(sessionId, (method, p) => {
      if (method === "Page.javascriptDialogOpening")
        void send("Page.handleJavaScriptDialog", { accept: true }, sessionId);
      else if (method === "Runtime.exceptionThrown")
        said.push(
          `Uncaught ${p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? ""}`,
        );
    });
    for (const domain of ["Page", "Runtime"]) await send(`${domain}.enable`, {}, sessionId);
    await send(
      "Emulation.setDeviceMetricsOverride",
      { width, height, deviceScaleFactor: 1, mobile: false },
      sessionId,
    );
    const evaluate = async <T = unknown>(expression: string): Promise<T> => {
      const r = (await send(
        "Runtime.evaluate",
        { expression, returnByValue: true, awaitPromise: true },
        sessionId,
      )) as { result?: { value?: T }; exceptionDetails?: { text?: string } };
      if (r.exceptionDetails) throw new Error(`in the page: ${r.exceptionDetails.text}`);
      return r.result?.value as T;
    };
    let pointer = { x: width / 2, y: height / 2 };
    const self = {
      said,
      evaluate,
      goto: async (to: string) => {
        await send("Page.navigate", { url: to }, sessionId);
        await sleep(1000);
      },
      /** The value of `expression` once it is truthy; or a failure that says what the page
       *  showed. */
      until: async <T = unknown>(expression: string, what: string, ms = 30_000): Promise<T> => {
        for (const end = Date.now() + ms; ; await sleep(250)) {
          const value = await evaluate<T>(expression).catch(() => undefined);
          if (value) return value;
          if (Date.now() > end)
            throw new Error(
              `the page never showed ${what}: ${String(await evaluate("document.body ? document.body.innerText : ''")).slice(0, 1500)}`,
            );
        }
      },
      /** The first element matching `selector` (and holding `text`, if given), clicked: the
       *  pointer moves there, presses and lets go (holding shift, if asked). `atOnce`: in one
       *  move, pressed straight after, unchecked: a click as the pointer arrives, which the
       *  eight moves and the check take too long to be under load (T2 04, 2026-11-22). */
      click: async (
        selector: string,
        text = "",
        options: { shift?: boolean; atOnce?: boolean } = {},
      ) => {
        // Where it is, and that it is what the pointer would press there: a page that moved
        // under the pointer (a diff loading above a button) is measured again.
        const find = `[...document.querySelectorAll(${JSON.stringify(selector)})].find((n) => n.innerText.includes(${JSON.stringify(text)}))`;
        // In front first, as the tab a person clicks in is: a tab the page opened (the
        // dashboard's Push opens the approval page) puts this one behind it, where Chrome
        // answers each pointer move after 5 s, and every click took 40 s (T2 19, 2026-11-22).
        await send("Page.bringToFront", {}, sessionId);
        let at: { x: number; y: number } | null = null;
        for (let tries = 0; tries < 10; tries++) {
          at = await evaluate<{ x: number; y: number } | null>(`(() => {
            const e = ${find};
            if (!e) return null;
            e.scrollIntoView({ block: "center" });
            const r = e.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          })()`);
          if (!at) throw new Error(`nothing to click: ${selector} ${text}`);
          if (options.atOnce) {
            await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at }, sessionId);
            pointer = at;
            break;
          }
          for (let i = 1; i <= 8; i++) {
            const p = {
              x: pointer.x + ((at.x - pointer.x) * i) / 8,
              y: pointer.y + ((at.y - pointer.y) * i) / 8,
            };
            await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...p }, sessionId);
          }
          pointer = at;
          const there = await evaluate<boolean>(
            `(() => { const e = ${find}; const hit = document.elementFromPoint(${at.x}, ${at.y}); return !!(e && hit && (hit === e || e.contains(hit))); })()`,
          );
          if (there) break;
          await sleep(300);
        }
        if (!at) throw new Error(`nothing to click: ${selector} ${text}`);
        await send(
          "Input.dispatchMouseEvent",
          {
            type: "mousePressed",
            ...at,
            button: "left",
            clickCount: 1,
            modifiers: options.shift ? 8 : 0,
          },
          sessionId,
        );
        await send(
          "Input.dispatchMouseEvent",
          {
            type: "mouseReleased",
            ...at,
            button: "left",
            clickCount: 1,
            modifiers: options.shift ? 8 : 0,
          },
          sessionId,
        );
        await sleep(300);
      },
      /** Text typed where the focus is. */
      type: async (text: string) => {
        await send("Input.insertText", { text }, sessionId);
      },
      text: () => evaluate<string>("document.body ? document.body.innerText : ''"),
      shot: async (file: string) => {
        const shot = (await send("Page.captureScreenshot", { format: "png" }, sessionId)) as {
          data?: string;
        };
        if (shot.data) fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
      },
      close: async () => {
        listeners.delete(sessionId);
        await send("Target.closeTarget", { targetId });
      },
    };
    await self.goto(url);
    return self;
  };
  const close = async () => {
    await Promise.race([send("Browser.close"), sleep(5000)]);
    ws.close();
    await Promise.race([exited, sleep(5000)]);
    browser.kill();
    await exited;
  };
  /** The pages open now (tabs a page opened among them), and the text one of them shows. */
  const pages = async () =>
    (
      (await send("Target.getTargets")) as {
        targetInfos?: { targetId: string; type: string; url: string }[];
      }
    ).targetInfos?.filter((t) => t.type === "page") ?? [];
  const textOf = async (targetId: string) => {
    const { sessionId } = (await send("Target.attachToTarget", { targetId, flatten: true })) as {
      sessionId: string;
    };
    try {
      const r = (await send(
        "Runtime.evaluate",
        { expression: "document.body ? document.body.innerText : ''", returnByValue: true },
        sessionId,
      )) as { result?: { value?: string } };
      return r.result?.value ?? "";
    } finally {
      await send("Target.detachFromTarget", { sessionId });
    }
  };
  return { load, tab, pages, textOf, close };
};

/** One page in a Chrome of its own, with the profile `profile`, closed after. */
export const loadPage = async (
  chrome: string,
  profile: string,
  url: string,
  options: LoadOptions & { width?: number; height?: number } = {},
): Promise<Loaded> => {
  const browser = await openBrowser(chrome, profile, options);
  try {
    return await browser.load(url, options);
  } finally {
    await browser.close();
  }
};
