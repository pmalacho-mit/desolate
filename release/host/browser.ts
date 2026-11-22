// `--open`: one of desolate's addresses in a browser on this Mac. (Not in cli.ts: `desolate
// settings` imports each file that declares a setting, and cli.ts is still running then.)
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { define, valueOf } from "../shared/settings.ts";

/** Chrome or Firefox if there is one: Safari cannot find desolate's *.localhost names. */
const BROWSER = define<string | null>({
  name: "browser.app",
  env: "DESOLATE_BROWSER",
  side: "host",
  default: () =>
    ["Google Chrome", "Firefox", "Chromium", "Brave Browser", "Microsoft Edge"].find((app) =>
      fs.existsSync(`/Applications/${app}.app`),
    ) ?? null,
  parse: Object.assign(
    (text: string) => (/^[^\s\p{Cc}-][^\p{Cc}]*$/u.test(text.trim()) ? text.trim() : null),
    { takes: "an application's name, as macOS's open -a takes it (Firefox)" },
  ),
  why: "The browser --open opens desolate's pages in; unset, the first of Chrome, Firefox, Chromium, Brave and Edge this Mac has (Safari cannot open *.localhost addresses).",
});

export const openInBrowser = (url: string) => {
  if (process.platform !== "darwin") return void spawnSync("xdg-open", [url], { stdio: "ignore" });
  const browser = valueOf(BROWSER);
  const opened = spawnSync("open", browser ? ["-a", browser, url] : [url], { stdio: "ignore" });
  if (opened.status !== 0 || !browser)
    process.stderr.write(
      `desolate: ${browser ? `could not open ${browser}` : "no Chrome or Firefox found: Safari cannot open *.localhost addresses"}; open the address above in Chrome or Firefox\n`,
    );
};
