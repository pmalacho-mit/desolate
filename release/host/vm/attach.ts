// A session in a VM on the person's own terminal (`desolate root shell`, a push's run, the
// git VM's `desolate upstream`): the VM's program is interactive, so the terminal is passed
// to it, but what it prints is not passed through raw. The root's shell shows commit
// messages and file names an agent wrote, and a terminal acts on some escape sequences beyond
// the screen (the clipboard, files, the title). On a terminal, its output is kept to what a
// screen needs (shared/terminal-filter.ts), as `desolate exec` and `desolate agent attach`
// already did; to a pipe or a file, it is passed as it is.
import { spawn } from "node:child_process";
import { terminalFilter } from "../../shared/terminal-filter.ts";

export const attachFiltered = (command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<number> => {
  const out = process.stdout.isTTY, err = process.stderr.isTTY;
  const child = spawn(command, args, { stdio: ["inherit", out ? "pipe" : "inherit", err ? "pipe" : "inherit"], env: env ?? process.env });
  const shown = terminalFilter(), said = terminalFilter();
  let drew = false;
  if (out) child.stdout!.on("data", (chunk: Buffer) => {
    const passed = shown(chunk);
    drew ||= passed.includes(0x1b);
    process.stdout.write(passed);
  });
  if (err) child.stderr!.on("data", (chunk: Buffer) => process.stderr.write(said(chunk)));
  return new Promise((resolve) => child.on("close", (code) => {
    // A full-screen program's modes, off again: the terminal is the person's shell's. (Only
    // after one that sent escapes at all: plain output changed no mode.)
    if (out && drew) process.stdout.write(shown.reset());
    resolve(code ?? 1);
  }));
};
