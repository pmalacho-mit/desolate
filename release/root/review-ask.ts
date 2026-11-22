// The host's question to the reviewer (reviewer.ts), asked as root in the root VM through
// the host's own way in, never through the root's ordinary user (which could answer for it
// or hold it up). Root starts a reviewer process of its own for the one request, as the
// reviewer's user, from root's copy of the code.
//
//   node review-ask.ts        (as root; one AccountRequest line on stdin)
//
// The answer is shared/review-account.ts's stream, on stdout: what the reviewer is doing
// while it does it, then the one answer. There is no deadline here (R4): the reviewer works
// for as long as whoever asked holds the connection, and when it lets go (this process's
// stdout is closed, or it is told to stop), the reviewer is ended with everything it started.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { accountLine, accountLines } from "../shared/review-account.ts";
import { REVIEWER } from "./layout.ts";
import { SETTINGS } from "./reviewer-packs.ts";

/** The request: the first line on stdin. A request is a few names: past 64 KiB it is not
 *  one. */
const REQUEST_BYTES = 64 * 1024;
const requested = async (): Promise<string> => {
  process.stdin.setEncoding("utf8");
  let text = "";
  for await (const chunk of process.stdin) {
    text += chunk;
    if (text.includes("\n") || text.length > REQUEST_BYTES) break;
  }
  return text.split("\n")[0]!.slice(0, REQUEST_BYTES);
};

/** How long the reviewer is given to end its own git when its asker has gone (it ends the
 *  groups git's runs make of their own: shared/run.ts), before all of it is killed. */
const GRACE_MS = 2_000;

const main = async () => {
  const asked = await requested();
  // The reviewer's settings (reviewer-packs.ts), which root's environment may set: nothing
  // else of root's environment reaches it.
  const settings = SETTINGS.filter((s) => process.env[s.env]).map(
    (s) => `${s.env}=${process.env[s.env]}`,
  );
  // A process group of its own (and a session): ended whole when the asker goes away. Killed
  // alone, runuser left node and its git running (the independent review of #169). Low
  // priority: the root VM's keyring and pushers come first.
  const child = spawn(
    "runuser",
    [
      "-u",
      REVIEWER.user,
      "--",
      "env",
      "-i",
      "PATH=/usr/local/bin:/usr/bin:/bin",
      "LANG=C.UTF-8",
      `HOME=${REVIEWER.home}`,
      ...settings,
      "nice",
      "-n",
      "10",
      "node",
      "--disable-warning=ExperimentalWarning",
      "/opt/desolate/proxy-code/root/reviewer.ts",
      "account",
    ],
    { detached: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  const group = (signal: NodeJS.Signals) => {
    try {
      if (child.pid) process.kill(-child.pid, signal);
    } catch {
      /* ended already */
    }
  };
  // Whatever way this process ends, the reviewer's does too.
  process.on("exit", () => group("SIGKILL"));
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    group("SIGTERM");
    setTimeout(() => process.exit(1), GRACE_MS);
  };
  // The asker went away: its end of stdout closed (a write fails), or it said so.
  process.stdout.on("error", stop);
  for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(name, stop);
  // (One that cannot be started ends its stream with no answer, which is said as that.)
  child.on("error", () => {});
  child.stdin.on("error", () => {});
  child.stdin.end(`${asked}\n`);
  // Its own words are the host's to see (it logs there, never on stdout).
  child.stderr.pipe(process.stderr);
  const write = (text: string) =>
    new Promise<void>((resolve) => process.stdout.write(text, () => resolve()));
  // Line by line, as the reviewer writes them: so what reaches the host is always the
  // stream's lines, ending in one answer, whatever the reviewer did (accountLines).
  for await (const line of accountLines(child.stdout)) {
    if (stopping) return;
    await write(accountLine(line));
    if (!("progress" in line)) break;
  }
  process.exit(0);
};

// Run by the host as root (host/daemon.ts: node with this file's path, the request on stdin);
// imported, it does nothing.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === new URL(import.meta.url).pathname)
  await main();
