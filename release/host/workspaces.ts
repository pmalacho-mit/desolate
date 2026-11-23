// Workspaces, from the host: up, list, stop, rm, exec.
import { failure, forTerminal, printable } from "../shared/text.ts";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EXIT, refuse } from "../shared/exit.ts";
import {
  devHostname,
  editorHostname,
  editorHostPort,
  isBranch,
  isSlug,
  parseRepo,
  workspaceVmName,
} from "../shared/names.ts";
import { outlived } from "../shared/plan.ts";
import type { Unpushed, WorkspacePlan } from "../shared/plan.ts";
import { readHead } from "../shared/status.ts";
import {
  capToMac,
  checkSize,
  describe as describeSize,
  describeParts,
  merge,
  parseDisk,
  parseMemory,
  workspaceDefaults,
} from "../shared/size.ts";
import type { ProjectSize, Size } from "../shared/size.ts";
import { RUN_MAX } from "../shared/run.ts";
import { define, valueOf, whole } from "../shared/settings.ts";
import type { RunResult } from "../shared/run.ts";
import { terminalFilter } from "../shared/terminal-filter.ts";
import { BEAT_MS, elapsed } from "../shared/step.ts";
import { guest, INSTANCE, paths, RELEASE_DIR } from "./paths.ts";
import { retiredAt, stale } from "./retired.ts";
import { sharedFolderRefusal } from "./install-folder.ts";
import { backend, ensureProxyUser, rootctl } from "./stack.ts";
import type { VmSpec } from "./vm/types.ts";
import type {
  Expect,
  Given,
  Invoke,
  Mock,
  Table,
  Throws,
} from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { setEnv } from "../.harness/env.ts";
import type { emptyHome, homeHas, writeInHome } from "../.harness/home.ts";
import type {
  collect,
  fakeStack,
  rootAnswers,
  rootAsked,
  said,
  vmAnswers,
} from "../.harness/host-stack.ts";
import type { refusalOf } from "../.harness/refusal.ts";

type Out = (line: string) => void;
export type Workspace = WorkspacePlan & { state: string };
type DomainView = { slug: string; title: string; repos: string[]; workspaces: Workspace[] };

const NODE = ["node", "--disable-warning=ExperimentalWarning"];

/** A domain's environment built once, then cloned for each workspace (templates.ts). */
const TEMPLATES = define<"on" | "off">({
  name: "workspace.templates",
  env: "DESOLATE_TEMPLATES",
  side: "host",
  default: "on",
  parse: Object.assign(
    (text: string) =>
      ["on", "1"].includes(text.trim()) ? "on" : ["off", "0"].includes(text.trim()) ? "off" : null,
    { takes: "on or off (or 1 or 0)" },
  ),
  why: "Whether a domain's first workspace builds its environment once (its devcontainer, its images) for every later one to start from; off makes each from the base, slower and from nothing.",
});

export const splitTarget = (target: string | undefined): { domain: string; workspace: string } => {
  const parts = (target ?? "").split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1])
    refuse(
      `'${target ?? ""}' does not name a workspace`,
      "name it as <domain>/<workspace> (see `desolate list`)",
      EXIT.usage,
    );
  return { domain: parts[0]!, workspace: parts[1]! };
};

declare namespace splitTarget {
  /** `<domain>/<workspace>`, and nothing more or less */
  export type Names = Expect<
    Invoke<typeof splitTarget, [target: "acme/w1"]>,
    "=",
    { domain: "acme"; workspace: "w1" }
  >;
  export type Refuses = [
    Expect<
      Invoke<typeof refusalOf, [run: typeof splitTarget, args: [target: "acme"]]>,
      "=",
      {
        message: "'acme' does not name a workspace";
        fix: "name it as <domain>/<workspace> (see `desolate list`)";
        code: 64;
      }
    >,
    Throws<
      Invoke<typeof splitTarget, [target: "acme/w1/x"]>,
      "'acme/w1/x' does not name a workspace"
    >,
    Throws<Invoke<typeof splitTarget, [target: "/w1"]>, "'/w1' does not name a workspace">,
    Throws<Invoke<typeof splitTarget, [target: undefined]>, "'' does not name a workspace">,
  ];
}

export const specOf = (plan: WorkspacePlan, repos: string[]): VmSpec => ({
  name: plan.vm,
  role: "workspace",
  egress: "none",
  shares: [
    { host: RELEASE_DIR, guest: guest.release, writable: false },
    { host: paths.domainRepos(plan.domain), guest: guest.workspaces, writable: true },
    { host: paths.outbox(plan.domain), guest: guest.outbox, writable: true },
    // The inbox is the root's to write: a domain cannot forge a delivery or its own plan.
    { host: paths.inbox(plan.domain), guest: guest.inbox, writable: false },
    // The domain's package caches (section 4.7, C4): npm's, pip's and the rest, shared by
    // the domain's workspaces and nobody else's. Whatever one of them puts there, every
    // workspace of the domain could have done itself (section 2), so sharing it poisons
    // nothing; it is never shown to another domain, the root's git or the host's tools.
    { host: paths.domainCache(plan.domain), guest: guest.cache, writable: true },
    // The mirrors of this domain's repositories, and no others, each read-only and at the
    // same path in every VM (a clone's alternates file names it).
    ...repos.map((id) => {
      const repo = parseRepo(id)!;
      return { host: paths.mirror(repo), guest: guest.mirror(repo), writable: false };
    }),
  ],
  sockets: [{ host: `${paths.link(plan.vm)}/proxy.sock`, guest: guest.linkSocket }],
  // Its size, as the plan records it (shared/size.ts); a plan from before sizes were
  // recorded (a template's builder, an old workspace started again) gets the stack's defaults.
  ...(plan.size ?? stackDefaults()),
  labels: {
    title: `${plan.domain}/${plan.workspace}`,
    domain: plan.domain,
    workspace: plan.workspace,
  },
});

declare namespace specOf {
  type Plan = {
    domain: "acme";
    workspace: "w1";
    vm: "dsl-main-ddb30a57cc";
    title: "w1";
    fetch: false;
    createdAt: "2026-11-16T10:00:00Z";
    checkouts: [
      {
        repo: "acme/web";
        kind: "worktree";
        name: "fix-login";
        branch: "fix/login";
        base: "origin/main";
        path: "/workspaces/acme/web/.worktrees/fix-login";
      },
    ];
    size: { cpus: 4; memoryMiB: 8192; diskGiB: 60 };
  };
  /** no network but its link; its domain's clones, outbox and caches writable; the inbox (the
   *  root's to write) and the mirrors of its domain's repositories, and only those, read-only */
  export type Shares = Expect<
    Invoke<typeof specOf, [plan: Plan, repos: ["acme/web", "acme/api"]]>,
    "matches",
    {
      name: "dsl-main-ddb30a57cc";
      role: "workspace";
      egress: "none";
      shares: [
        { guest: "/desolate/release"; writable: false },
        { guest: "/workspaces"; writable: true },
        { guest: "/desolate/outbox"; writable: true },
        { guest: "/desolate/inbox"; writable: false },
        { guest: "/desolate/cache"; writable: true },
        { guest: "/desolate/mirrors/acme/web.git"; writable: false },
        { guest: "/desolate/mirrors/acme/api.git"; writable: false },
      ];
      sockets: [{ guest: "/desolate/link/proxy.sock" }];
      cpus: 4;
      memoryMiB: 8192;
      diskGiB: 60;
      labels: { title: "acme/w1"; domain: "acme"; workspace: "w1" };
    }
  >;
}

/** The stack's defaults: the settings workspace.cpus, .memoryMiB and .diskGiB (shared/size.ts),
 *  each from this Mac (its cores and memory, worked out each time) unless the person set it
 *  (`desolate settings set`, or DESOLATE_WORKSPACE_CPUS, _MEMORY_MIB and _DISK_GIB). */
export const stackDefaults = (): Size => workspaceDefaults();
declare namespace stackDefaults {
  type Overrides = [
    Invoke<typeof setEnv, [name: "DESOLATE_WORKSPACE_CPUS", value: "3"]>,
    Invoke<typeof setEnv, [name: "DESOLATE_WORKSPACE_MEMORY_MIB", value: "6144"]>,
    Invoke<typeof setEnv, [name: "DESOLATE_WORKSPACE_DISK_GIB", value: "40"]>,
  ];
  /** the environment overrides what this Mac would give, each part */
  export type Overridden = Given<
    Overrides,
    Expect<Invoke<typeof stackDefaults>, "=", { cpus: 3; memoryMiB: 6144; diskGiB: 40 }>
  >;
  /** within the limits a workspace may have, as whole numbers: a typo is refused, never
   *  taken for the default */
  export type Refuses = Given<
    Invoke<typeof setEnv, [name: "DESOLATE_WORKSPACE_CPUS", value: "1.5"]>,
    Throws<
      Invoke<typeof stackDefaults>,
      "DESOLATE_WORKSPACE_CPUS must be a whole number from 1 to 64, not '1.5'"
    >
  >;
}

/** `--cpus 4 --memory 8g --disk 60g`, read and checked. */
export const sizeFlags = (values: {
  cpus?: unknown;
  memory?: unknown;
  disk?: unknown;
}): Partial<Size> => {
  const size: Partial<Size> = {};
  if (values.cpus !== undefined) size.cpus = Number(values.cpus);
  if (values.memory !== undefined)
    size.memoryMiB =
      parseMemory(values.memory) ??
      refuse(
        `--memory '${String(values.memory)}' is not an amount`,
        "--memory 8g (or 4096 for MiB)",
        EXIT.usage,
      );
  if (values.disk !== undefined)
    size.diskGiB =
      parseDisk(values.disk) ??
      refuse(`--disk '${String(values.disk)}' is not an amount`, "--disk 60g", EXIT.usage);
  const why = checkSize(size);
  if (why) refuse(why, "--cpus <n> --memory <8g> --disk <60g>", EXIT.usage);
  return size;
};

declare namespace sizeFlags {
  /** each flag as `up` and `domain <d> size` take it; what is not given is left to the next */
  export type Reads = Table<
    typeof sizeFlags,
    [
      [
        args: [values: { cpus: "4"; memory: "8g"; disk: "60g" }],
        expected: { cpus: 4; memoryMiB: 8192; diskGiB: 60 },
      ],
      [args: [values: { memory: "4096" }], expected: { memoryMiB: 4096 }],
      [args: [values: {}], expected: {}],
    ]
  >;
  /** a usage error (exit 64), with the spelling that works */
  export type Refuses = [
    Expect<
      Invoke<typeof refusalOf, [run: typeof sizeFlags, args: [values: { memory: "lots" }]]>,
      "=",
      {
        message: "--memory 'lots' is not an amount";
        fix: "--memory 8g (or 4096 for MiB)";
        code: 64;
      }
    >,
    Throws<Invoke<typeof sizeFlags, [values: { cpus: "four" }]>, "CPUs must be from 1 to 64">,
    Throws<
      Invoke<typeof sizeFlags, [values: { disk: "10g" }]>,
      "disk must be from 30 GiB to 2048 GiB"
    >,
  ];
}

/** The most of a VM's error text the host keeps, in characters: the end of it, where a
 *  program says why it failed. Its bound is against the VM, which may send up to RUN_MAX:
 *  a file is written for each failure a person sees, and for the daemon's look at a running
 *  workspace every thirty seconds (one file for each workspace and step, overwritten, so
 *  they do not pile up). A megabyte is thousands of lines: more than anyone reads of one. */
const KEPT_CHARS = 1024 * 1024;

const BLANK = "\n\r\t ";
/** A VM's error text as the host keeps and shows it: its last KEPT_CHARS, from a line's
 *  start, with what was left out said in its first line; its runs of empty lines made one,
 *  and its ends trimmed. Each step is linear in the text, which the VM chooses. */
export const vmText = (output: string): string => {
  const cut = output.length > KEPT_CHARS;
  const at = cut ? output.indexOf("\n", output.length - KEPT_CHARS) : -1;
  let text = cut ? output.slice(at < 0 ? output.length - KEPT_CHARS : at + 1) : output;
  const left = output.length - text.length;
  text = text.replace(/\n(?:[ \t\r]*\n)+/g, "\n\n");
  let [start, end] = [0, text.length];
  while (end > 0 && BLANK.includes(text[end - 1]!)) end--;
  while (start < end && BLANK.includes(text[start]!)) start++;
  text = text.slice(start, end);
  return cut ? `(its first ${left} characters are not kept)\n${text}` : text;
};

declare namespace vmText {
  export type Cases = Table<
    typeof vmText,
    [
      /** what a program says, as it said it */
      [args: [output: "fatal: bad object\n"], expected: "fatal: bad object"],
      /** runs of empty lines are one, and the ends are trimmed */
      [args: [output: "\n\na\n\n\n\n  \nb\n\n"], expected: "a\n\nb"],
    ]
  >;
}

/** How an error a workspace's VM gave is shown (docs/v3/limits.md, R1): its last `lines`
 *  lines, made safe, and, when that is not all of it, how much was left out and where the
 *  whole of it is kept (vmText's whole): under the host's logs, one file for each workspace
 *  and step, the person's alone. */
const fromVm = (plan: WorkspacePlan, what: string, output: string, lines: number) =>
  failure(vmText(output), lines, (whole) => {
    fs.mkdirSync(paths.logs, { recursive: true, mode: 0o700 });
    const file = path.join(paths.logs, `${plan.domain}--${plan.workspace}-${what}.txt`);
    fs.writeFileSync(file, whole, { mode: 0o600 });
    return file;
  });

/** How long the host lets a step in a workspace's VM say nothing before it takes the step
 *  as stopped. A step that runs says it still does every BEAT_MS (shared/step.ts), so one
 *  that is running is never stopped for being slow; one whose VM stopped answering (it
 *  froze, its ssh went, the program hung before it could say so) is not waited on for ever.
 *  Two minutes is twelve beats: a VM busy with a build still runs a timer every ten seconds,
 *  and twelve of them missed is not load. At least two beats. */
const WORKSPACE_SILENT_SECONDS = define({
  name: "workspace.silentSeconds",
  env: "DESOLATE_WORKSPACE_SILENT_SECONDS",
  side: "host",
  default: 120,
  parse: whole((2 * BEAT_MS) / 1000, 24 * 60 * 60),
  why: "How long a step of a workspace's start may hear nothing from the workspace's VM (no line, no beat) before it is stopped: more on a Mac so loaded that a VM misses its beats for minutes.",
});

/** Whoever is watching this start as it happens, and how what a step says reaches them: the
 *  dashboard (DESOLATE_PROGRESS: a `progress:` line each), a person at a terminal (each
 *  step on a line of its own, and its "still ..." in place), or nobody (a script: only the
 *  answer, as before). */
type Shown = (line: string | null) => void;
/** The most of what a step says that is shown, in lines for each beat and characters for
 *  each line: a step says a line when it begins and one each beat, so this is room for many,
 *  and a VM that floods its stderr is not passed on whole to the dashboard, which every
 *  domain shares. What is not shown is counted, and said. */
const SHOWN = { lines: 20, chars: 500 };

/** (`null`: the step ended, and a line in place is cleared.) */
const watcher = (): Shown => {
  const show = rawWatcher();
  let [window, inWindow, passed] = [0, 0, 0];
  return (line) => {
    if (line === null) {
      if (passed) show(`(${passed} more lines from the workspace's VM were not shown)`);
      [inWindow, passed] = [0, 0];
      return show(null);
    }
    const now = Math.floor(Date.now() / BEAT_MS);
    if (now !== window) {
      if (passed) show(`(${passed} more lines from the workspace's VM were not shown)`);
      [window, inWindow, passed] = [now, 0, 0];
    }
    if (++inWindow > SHOWN.lines) return void passed++;
    show(printable(line, SHOWN.chars));
  };
};
const rawWatcher = (): Shown => {
  if (process.env.DESOLATE_PROGRESS)
    return (line) =>
      void (line !== null && process.stderr.write(`progress:   ${printable(line)}\n`));
  if (!process.stderr.isTTY) return () => {};
  let inPlace = false;
  return (line) => {
    const beat = line?.startsWith("still ") ?? false;
    const clear = inPlace ? "\r\x1b[K" : "";
    process.stderr.write(line === null ? clear : `${clear}  ${printable(line)}${beat ? "" : "\n"}`);
    inPlace = beat;
  };
};

/** Run a step of a start in the workspace's VM (init.ts, devcontainer.ts) for as long as it
 *  runs: it has no deadline (docs/v3/limits.md, R4: the person waiting owns that, and can
 *  Ctrl-C). It says what it is doing, and that it still is, a line at a time on stderr; each
 *  line goes to `shown`, and WORKSPACE_SILENT_SECONDS with none ends it, said as run() says
 *  it. What it writes is the VM's, so all of it is held to run()'s bound (RUN_MAX). The
 *  answer's stderr is what it said, without its "still ..." lines. */
const stepInVm = (plan: WorkspacePlan, argv: string[], shown: Shown) =>
  new Promise<RunResult>((resolve) => {
    const child = backend().spawn(plan.vm, argv);
    child.stdin?.end();
    let [stdout, stderr, partial, ended] = ["", "", "", ""];
    // Every byte it sent counts toward the bound, the "still ..." lines and a line that
    // never ends too: they are held, or were.
    let received = 0;
    let settled = false;
    const settle = (result: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(quiet);
      shown(null);
      resolve(result);
    };
    const end = (why: string) => {
      if (ended) return;
      ended = why;
      child.kill("SIGTERM");
      // A program that does not end (or a child of it that holds the pipes on) is not
      // waited for: a few seconds, then killed, and the answer given without it.
      setTimeout(() => {
        child.kill("SIGKILL");
        child.stdout?.destroy();
        child.stderr?.destroy();
        settle({ code: 128, stdout, stderr: `${stderr}${partial}${ended}` });
      }, 5000).unref();
    };
    const quietMs = valueOf(WORKSPACE_SILENT_SECONDS) * 1000;
    const quiet = setTimeout(
      () => end(`\n(nothing from the workspace's VM for ${elapsed(quietMs)}: stopped)`),
      quietMs,
    );
    const take = (chunk: string, into: "stdout" | "stderr") => {
      if (ended) return;
      quiet.refresh();
      if ((received += Buffer.byteLength(chunk)) > RUN_MAX)
        return end(`\n(more than ${RUN_MAX} bytes from the workspace's VM: stopped)`);
      if (into === "stdout") return void (stdout += chunk);
      // (Only a chunk with a newline in it is split: a line that never ends costs no more.)
      if (!chunk.includes("\n")) return void (partial += chunk);
      const lines = (partial + chunk).split("\n");
      partial = lines.pop()!;
      for (const line of lines) {
        shown(line);
        if (!line.startsWith("still ")) stderr += `${line}\n`;
      }
    };
    // (Decoded as UTF-8 across chunks: a character split between two is one character.)
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => take(chunk, "stdout"));
    child.stderr!.setEncoding("utf8").on("data", (chunk: string) => take(chunk, "stderr"));
    child.on("error", (error) => {
      settle({ code: 127, stdout, stderr: `${stderr}${partial}${error.message}` });
    });
    child.on("close", (code) => {
      settle({
        code: ended ? 128 : (code ?? 128),
        stdout,
        stderr: `${stderr}${partial}${ended}`,
      });
    });
  });

/** What `up` and `start` add for an editor that was not listening yet when they went on. */
const STILL_STARTING = "   (still starting: it opens once it listens)";

export const startServices = async (plan: WorkspacePlan) => {
  const b = backend();
  const shown = watcher();
  // Each step's time, for whoever is watching (DESOLATE_PROGRESS): where a start goes.
  let at = Date.now();
  const step = (name: string) => {
    if (process.env.DESOLATE_PROGRESS)
      process.stderr.write(`progress:   ${name} (${((Date.now() - at) / 1000).toFixed(1)} s)\n`);
    at = Date.now();
  };
  // The workspace's own proxy, in the root, as its domain's proxies' user; then its link,
  // which leads there and nowhere else.
  await ensureProxyUser(plan.domain);
  const proxy = await rootctl<{ socket: string }>(
    "proxy.start",
    { vm: plan.vm, domain: plan.domain, workspace: plan.workspace },
    { quiet: true },
  );
  const { connectWorkspace } = await import("./daemon.ts");
  step("its proxy");
  await connectWorkspace({ ...plan, proxy: proxy.socket });
  step("its link");
  // Its settings, as the person stored them on the Mac, before what reads them starts.
  await (await import("./settings.ts")).passInward(plan.vm, "workspace");
  // start.sh (and its docker step, below) start the VM's own services: a few seconds, and
  // five minutes is the bound on a VM that is not answering (they say nothing as they go).
  const services = await b.exec(
    plan.vm,
    [
      "bash",
      `${guest.release}/workspace/start.sh`,
      String(process.getuid!()),
      b.link(plan.vm).guest,
    ],
    { root: true, timeoutMs: 300_000 },
  );
  step("its services (start.sh)");
  if (services.code !== 0)
    throw new Error(
      `the workspace's services did not start: ${fromVm(plan, "services", services.stderr || services.stdout, 10)}`,
    );
  // Its key, for what it asks of the host through the root (host/spawn.ts).
  await (await import("./spawn.ts")).giveIdentity(b, plan.vm);
  // start.sh puts the user in the docker group; what the host runs next must have it.
  await b.refreshSessions?.(plan.vm, services.stdout.includes("desolate: sessions raised"));
  const init = await stepInVm(
    plan,
    [...NODE, `${guest.release}/workspace/init.ts`, plan.workspace],
    shown,
  );
  step("its checkouts (init.ts)");
  if (init.code !== 0)
    throw new Error(
      `the workspace could not make its checkouts: ${fromVm(plan, "checkouts", init.stderr || init.stdout, 10)}`,
    );
  // A docker daemon only where one is wanted: a checkout with a spec (start.sh says how).
  if (plan.checkouts.some((c) => locateSpec(paths.domainRepos(plan.domain), c)))
    await b.exec(
      plan.vm,
      [
        "bash",
        `${guest.release}/workspace/start.sh`,
        String(process.getuid!()),
        b.link(plan.vm).guest,
        "docker",
      ],
      { root: true, timeoutMs: 300_000 },
    );
  // The project's devcontainer, then the editor (which runs in it when it can). Neither
  // fails the workspace: without them it is the VM itself, and `up` says which it is.
  step("docker");
  const dev = await stepInVm(
    plan,
    [...NODE, `${guest.release}/workspace/devcontainer.ts`, plan.workspace],
    shown,
  );
  step("the devcontainer");
  // Its one line, whole as the VM said it (bounded only against a flood, and a cut is
  // marked): the terminal wraps it, the dashboard fits it.
  const line = /^devcontainer: (.*)$/m.exec(dev.stdout)?.[1]?.trim();
  const devcontainer = line
    ? printable(line)
    : `FAILED: ${fromVm(plan, "devcontainer", dev.stderr || dev.stdout, 2).replace(/\n/g, " ") || "it said nothing"}`;
  // (With the time the host last retired the tokens: a token older than that is made again.)
  // editor.sh waits a minute at most for the editor to listen, and then says it is still
  // starting; five minutes is the bound on a VM that is not answering.
  const editor = await b.exec(
    plan.vm,
    [
      "bash",
      "-lc",
      `bash ${guest.release}/workspace/editor.sh ${editorHostname(INSTANCE, plan.domain, plan.workspace)} ${retiredAt()}`,
    ],
    { timeoutMs: 300_000 },
  );
  // The person's default editor settings: its lowest layer (editor-defaults.ts). Never fails
  // the start.
  if (editor.code === 0) await (await import("./editor-defaults.ts")).applyTo(plan.vm);
  step("the editor");
  return {
    editorDown:
      editor.code === 0
        ? null
        : fromVm(plan, "editor", editor.stderr || editor.stdout, 2).replace(/\n/g, " ") ||
          "the editor did not start",
    // Not listening yet after editor.sh's minute, and not stopped either: it is there once it
    // listens.
    editorStarting: editor.code === 0 && /^editor: still starting$/m.test(editor.stdout),
    devcontainer,
  };
};

/** The address a person opens for a workspace's editor: its own hostname, the stack's
 *  editor port, the token the VM made, and the first checkout as the folder. */
export const editorUrl = async (w: Workspace): Promise<{ url: string } | { error: string }> => {
  const token = await backend().exec(w.vm, ["bash", "-lc", "cat ~/.desolate-editor/token"], {
    timeoutMs: 60_000,
  });
  if (token.code !== 0 || !/^[0-9a-f]{48}$/.test(token.stdout.trim()))
    return {
      error:
        "the editor is not running in this workspace (its image may have none: desolate doctor)",
    };
  if (await editorTokenStale(w.vm))
    return {
      error:
        "its token was retired (another program held [::1] on the editors' port), and has not been made again: desolate bootstrap, or restart the workspace",
    };
  const { editorPort } = await import("./daemon.ts");
  const { port, error } = await editorPort();
  if (error)
    return {
      error: `the editor's port is not available on this machine: ${error}. Free it, or give this stack another: desolate settings set editor.port <port>, desolate down, then desolate bootstrap`,
    };
  // One checkout: its folder. More: the workspace file the workspace's init wrote, with all
  // of them (workspace/init.ts).
  const folder = w.checkouts[0]?.path;
  const where =
    w.checkouts.length > 1
      ? `&workspace=${encodeURIComponent(`/workspaces/.desolate/${w.workspace}.code-workspace`)}`
      : folder
        ? `&folder=${encodeURIComponent(folder)}`
        : "";
  return {
    url: `http://${editorHostname(INSTANCE, w.domain, w.workspace)}:${port}/?tkn=${token.stdout.trim()}${where}`,
  };
};

export const editor = async (target: string | undefined, out: Out, json: boolean) => {
  const w = await find(target);
  if ((await backend().info(w.vm)).status !== "running")
    refuse(
      `${w.domain}/${w.workspace} is not running`,
      `desolate start ${w.domain}/${w.workspace}`,
    );
  const result = await editorUrl(w);
  if ("error" in result) refuse(result.error, `desolate start ${w.domain}/${w.workspace}`);
  out(json ? JSON.stringify(result) : (result as { url: string }).url);
};

/** Whether a checkout carries a devcontainer spec: its existence only, read on the host as
 *  data (P4), where the checkout is a directory in the domain's share. */
const locateSpec = (reposDir: string, c: { repo: string; kind: string; name: string }) => {
  const dir =
    c.kind === "main"
      ? path.join(reposDir, c.repo)
      : path.join(reposDir, c.repo, ".worktrees", c.name);
  return (
    fs.existsSync(path.join(dir, ".devcontainer", "devcontainer.json")) ||
    fs.existsSync(path.join(dir, ".devcontainer.json"))
  );
};

export const urlsOf = (plan: { domain: string; workspace: string }) => ({
  editor: `http://${editorHostname(INSTANCE, plan.domain, plan.workspace)}:${editorHostPort()}`,
  dev: `http://${devHostname(INSTANCE, plan.domain, plan.workspace)}`,
});

declare namespace urlsOf {
  /** its editor, on the stack's editor port, and its dev servers, each at a name of its own */
  export type Names = Expect<
    Invoke<typeof urlsOf, [plan: { domain: "acme"; workspace: "w1" }]>,
    "=",
    {
      editor: "http://acme-w1-editor-1a26c5.localhost:31581";
      dev: "http://acme-w1-1a26c5.localhost";
    }
  >;
}

export const up = async (
  domain: string | undefined,
  options: {
    name?: string;
    checkouts: string[];
    branch?: string;
    base?: string;
    fetch: boolean;
    size?: Partial<Size>;
    startedBy?: string;
    command?: string[];
    keep?: { startedBy?: { workspace: string; createdAt: string }; parent?: string | null };
  },
  out: Out,
  json: boolean,
) => {
  if (!domain) refuse("which domain?", "desolate up <domain> [--name <workspace>]", EXIT.usage);
  const shared = sharedFolderRefusal();
  if (shared) refuse(shared.why, shared.fix);
  // --started-by <workspace>: the workspace of this domain that asked for this one (`desolate
  // spawn` in it, run by the host's daemon once it checked the request: host/spawn.ts).
  // (`keep`: a workspace made again on its own checkouts keeps who started it.)
  let startedBy: { workspace: string; createdAt: string } | undefined = options.keep?.startedBy;
  if (options.startedBy !== undefined) {
    const parent = await rootctl<Workspace>(
      "workspace.get",
      { domain, name: options.startedBy },
      { quiet: true },
    );
    startedBy = { workspace: parent.workspace, createdAt: parent.createdAt };
  }
  const phases: [string, number][] = [];
  let mark = Date.now();
  const phase = (name: string) => {
    // For whoever is watching the start as it happens (the dashboard): each phase as it ends.
    if (process.env.DESOLATE_PROGRESS)
      process.stderr.write(`progress: ${name} (${((Date.now() - mark) / 1000).toFixed(1)} s)\n`);
    phases.push([name, Date.now() - mark]);
    mark = Date.now();
  };
  const started = Date.now();
  const b = backend();
  // A workspace is a clone of the base (or of a template made from it): one older than this
  // desolate's image would give it other tools than this desolate expects.
  const stale = b.baseStale?.() ?? null;
  if (stale)
    refuse(
      `${stale}: a workspace made now would run the older tools`,
      "desolate bootstrap (it provisions the base again: minutes, once)",
    );
  let editorDown: string | null = null;
  let editorStarting = false;
  let devcontainer = "";
  if (options.name === "template")
    refuse(
      "'template' is the name of the domain's template build",
      `desolate up ${domain} --name <another>`,
      EXIT.usage,
    );
  const view = await rootctl<DomainView>("domain.show", { slug: domain }, { quiet: true });
  // The environment: the first repository the person named with --checkout (its devcontainer,
  // if it has one), else the domain's. Before --branch adds the rest.
  const envRepo = options.checkouts[0]?.split("=")[0];
  // --branch <b>: a worktree on <b> in every repository of the domain (a --checkout names one
  // differently), so a task that spans repositories is one branch name in each.
  if (options.branch !== undefined) {
    if (!isBranch(options.branch))
      refuse(
        `'${options.branch}' is not a branch desolate will carry`,
        "letters, digits, '.', '_', '-' and '/', not starting with a dash",
        EXIT.usage,
      );
    const named = new Set(options.checkouts.map((c) => c.split("=")[0]));
    options = {
      ...options,
      checkouts: [
        ...options.checkouts,
        ...view.repos
          .filter((repo) => !named.has(repo))
          .map((repo) => `${repo}=worktree:${options.branch}`),
      ],
    };
  }
  if (options.fetch)
    for (const repo of view.repos) await rootctl("repo.fetch", { repo }, { quiet: json });
  if (options.fetch) phase("mirrors refreshed");
  // The domain's template (section 4.7, C3), before this workspace takes its checkouts:
  // made once per environment, then cloned. Not on the fake backend, whose clone carries no
  // docker images. The setting workspace.templates, off, makes every workspace from the base.
  // What the project asks for (its devcontainer.json, as the remote published it): after the
  // person's own choices, before the stack's defaults, and kept within this Mac.
  const asked = await rootctl<ProjectAsk | null>(
    "domain.projectSize",
    { slug: domain, preferred: envRepo },
    { quiet: true },
  ).catch(() => null);
  const project = asked
    ? capToMac(asked.size, os.cpus().length, Math.floor(os.totalmem() / 1024 / 1024))
    : null;
  const domainSize = (view as DomainView & { size?: Partial<Size> }).size;
  let template: string | null = null;
  if (b.kind !== "fake" && valueOf(TEMPLATES) === "on") {
    const { ensure } = await import("./templates.ts");
    const say = (line: string) =>
      json ? process.stderr.write(`${forTerminal(line)}\n`) : out(line);
    template = await ensure(
      domain,
      view.repos,
      { specOf, startServices },
      say,
      envRepo,
      merge(domainSize, project?.size, stackDefaults()),
    );
    if (template) phase("template");
  }
  // Its size: the flags, then the domain's, then the project's, then the stack's defaults
  // (each part on its own).
  const size = merge(options.size, domainSize, project?.size, stackDefaults());
  // Who commits in it: your own git identity, as on this Mac (as the git VM takes it).
  const mine = (key: string) =>
    spawnSync("git", ["config", "--global", key], { encoding: "utf8" }).stdout?.trim() ?? "";
  const author = { name: mine("user.name"), email: mine("user.email") };
  const plan = vouched(
    await rootctl<Workspace>(
      "workspace.plan",
      {
        instance: INSTANCE,
        domain,
        name: options.name,
        checkouts: options.checkouts,
        base: options.base,
        fetch: options.fetch,
        size,
        author,
        ...(startedBy ? { startedBy } : {}),
        ...(envRepo ? { env: envRepo } : {}),
      },
      { quiet: true },
    ),
    domain,
    options.name,
  );
  // A VM of that name already here is not this workspace's: refused, and never destroyed below.
  // (Names are a hash of the domain and the workspace; one domain could search for a name of
  // its own that collides with another domain's VM: audit, 2026-11-16.)
  if ((await b.info(plan.vm)).status !== "missing") {
    await rootctl("workspace.remove", { domain, name: plan.workspace }, { quiet: true }).catch(
      () => {},
    );
    refuse(
      `a VM named ${plan.vm} already exists, and it is not ${domain}/${plan.workspace}'s`,
      `desolate up ${domain} --name <another name>`,
      EXIT.busy,
    );
  }
  // (The domain, whether it has a template to make, and the plan, which is two small files:
  // asks of the root, about 0.2 s each. No network: --fetch is its own phase, above.)
  phase("asked the root");
  let made = false;
  try {
    if (template) await b.clone(template, specOf(plan, view.repos));
    else await b.create(specOf(plan, view.repos));
    made = true;
    await b.start(plan.vm);
    phase("VM booted");
    ({ editorDown, editorStarting, devcontainer } = await startServices(plan));
    phase("services, checkouts, devcontainer and editor");
  } catch (error) {
    // A workspace that did not come up holds no checkout, and leaves no proxy or link.
    const { disconnectWorkspace } = await import("./daemon.ts");
    await disconnectWorkspace(plan.vm).catch(() => {});
    await rootctl("proxy.stop", { vm: plan.vm }, { quiet: true }).catch(() => {});
    // Only a VM this run made (one that appeared between the check above and the create is
    // not this workspace's to destroy).
    if (made) await b.destroy(plan.vm).catch(() => {});
    await rootctl("workspace.remove", { domain, name: plan.workspace }, { quiet: true }).catch(
      () => {},
    );
    if (made) (await import("./spawn.ts")).forget(domain, plan.workspace);
    throw error;
  }
  await rootctl("workspace.state", { domain, name: plan.workspace, state: "up" }, { quiet: true });
  const parent = options.keep ? options.keep.parent : startedBy?.workspace;
  if (parent) (await import("./spawn.ts")).recordStarted(domain, plan.workspace, parent);
  // `-- <command...>`: an agent, started in it once it is up (host/agent.ts).
  const agent = options.command?.length
    ? await (await import("./agent.ts")).startIn(plan, options.command)
    : null;
  const seconds = (ms: number) => (ms / 1000).toFixed(1);
  const breakdown = `the start took ${seconds(Date.now() - started)} s: ${phases.map(([name, ms]) => `${name} ${seconds(ms)} s`).join(", ")}`;
  const opened = editorDown ? { error: editorDown } : await editorUrl(plan);
  const urls = {
    ...urlsOf(plan),
    ...("url" in opened ? { editorWithToken: opened.url } : { editorError: opened.error }),
  };
  if (json)
    return out(
      JSON.stringify({
        domain,
        workspace: plan.workspace,
        vm: plan.vm,
        isolated: b.isolated,
        checkouts: plan.checkouts,
        size: plan.size ?? size,
        devcontainer,
        urls,
        ...(startedBy ? { startedBy } : {}),
        ...(agent ? { agent } : {}),
        tookMs: Date.now() - started,
        phases: Object.fromEntries(phases),
      }),
    );
  out(
    `workspace ${domain}/${plan.workspace} is up${b.isolated ? "" : "  [NOT ISOLATED: fake backend]"}${startedBy ? `, started by ${domain}/${startedBy.workspace}` : ""}`,
  );
  for (const c of plan.checkouts)
    out(
      `  ${c.repo}  ${c.kind === "main" ? `main checkout (${c.branch})` : `worktree ${c.branch} from ${c.base}`}  ${c.path}`,
    );
  out(`  size         ${describeSize(plan.size ?? size)}`);
  for (const line of sizeNotes(asked, project?.capped ?? [], options.size, domainSize)) out(line);
  if (!author.name || !author.email)
    out(
      `  commits as   ${author.name || `${domain}/${plan.workspace}`} <${author.email || `${plan.workspace}@${domain}.desolate.invalid`}>: this Mac's git has no ${!author.name && !author.email ? "user.name or user.email" : !author.name ? "user.name" : "user.email"} (git config --global user.name "Your Name"; git config --global user.email you@example.com, then the next up uses them)`,
    );
  out(`  devcontainer ${devcontainer}`);
  out(
    "url" in opened
      ? `  editor       ${opened.url}${editorStarting ? STILL_STARTING : ""}`
      : `  editor       NOT AVAILABLE: ${opened.error}`,
  );
  out(`  dev servers  ${urls.dev}:<port>   (the port it listens on inside, nothing to declare)`);
  if (agent)
    out(`  agent        ${agent} is running: desolate agent attach ${domain}/${plan.workspace}`);
  out(breakdown);
  out(`next: desolate editor ${domain}/${plan.workspace} --open      its editor, in your browser`);
  out(
    `      desolate exec ${domain}/${plan.workspace} -- <command>     a command in its devcontainer (bash, for a shell)`,
  );
};

export const list = async (out: Out, json: boolean, only?: string) => {
  const b = backend();
  const domains = (await rootctl<DomainView[]>("domain.list", {}, { quiet: true })).filter(
    (d) => !only || d.slug === only,
  );
  const vms = new Map((await b.list()).map((vm) => [vm.name, vm.status]));
  const view = domains.map((d) => ({
    domain: d.slug,
    title: d.title,
    repos: d.repos,
    // Its environment, while it is built for its first workspace (templates.ts): planned
    // as a workspace named "template" meanwhile, and not one.
    building: d.workspaces.some((w) => w.workspace === "template"),
    workspaces: d.workspaces
      .filter((w) => w.workspace !== "template")
      .map((w) => ({
        workspace: w.workspace,
        vm: w.vm,
        status: vms.get(w.vm) ?? "missing",
        isolated: b.isolated,
        size: w.size ?? null,
        startedBy: w.startedBy?.workspace ?? null,
        outlived: outlived(d.workspaces, w),
        // What each checkout has checked out now (its HEAD, read here as data), beside what it
        // started on.
        checkouts: w.checkouts.map((c) => {
          const head = readHead(paths.domainRepos(d.slug), c);
          return {
            ...c,
            head,
            now: head
              ? (head.branch ?? (head.commit ? `(detached ${head.commit.slice(0, 12)})` : "(?)"))
              : c.branch,
          };
        }),
        urls: urlsOf(w),
      })),
  }));
  if (json) return out(JSON.stringify(view));
  if (view.length === 0) return out("no domains yet. Start with: desolate domain create <slug>");
  for (const d of view) {
    out(
      `${d.domain}  "${d.title}"  ${d.repos.length ? d.repos.join(", ") : "(no repositories: desolate domain " + d.domain + " add --repo <owner>/<repo>)"}`,
    );
    if (d.building)
      out(
        `  (building its environment, once: its first workspace, and every later one, starts from it)`,
      );
    else if (d.workspaces.length === 0) out(`  (no workspaces: desolate up ${d.domain})`);
    for (const w of d.workspaces)
      out(
        `  ${d.domain}/${w.workspace}  ${w.status}${w.isolated ? "" : "  [not isolated]"}  ${w.checkouts.map((c) => `${c.repo}@${c.now}`).join(", ")}${w.size ? `  (${w.size.cpus} CPU, ${Math.round(w.size.memoryMiB / 1024)} GiB)` : ""}  ${w.startedBy ? `started by ${w.startedBy}${w.outlived ? " (removed since: this one outlived it)" : ""}` : "started by you"}`,
      );
  }
};

/** Every running workspace gets its proxy and its link again. A workspace's proxy lives in
 *  the root VM, so a root VM that was restarted left each running workspace with no way out
 *  at all, while `list` still said "running" (found on the M1). Bootstrap calls this.
 *  Returns how many were reconnected. */
/** The host's retiring a VM's editor token was made after (editor.sh writes it), or 0. */
export const editorTokenEpoch = async (vm: string) => {
  const made = await backend().exec(
    vm,
    ["bash", "-lc", "cat ~/.desolate-editor/token.epoch 2>/dev/null || echo 0"],
    { timeoutMs: 60_000 },
  );
  const epoch = Number(made.stdout.trim());
  return made.code === 0 && Number.isSafeInteger(epoch) && epoch > 0 ? epoch : 0;
};
/** Whether a VM's editor token was made before the host last retired the tokens (retired.ts).
 *  One whose mark cannot be read is stale then: it is made again. */
const editorTokenStale = async (vm: string) => retiredAt() > 0 && stale(await editorTokenEpoch(vm));

export const reconnectRunning = async (): Promise<number> => {
  const b = backend();
  const running = new Set(
    (await b.list()).filter((vm) => vm.status === "running").map((vm) => vm.name),
  );
  const { connectWorkspace } = await import("./daemon.ts");
  let count = 0;
  for (const d of await rootctl<DomainView[]>("domain.list", {}, { quiet: true }))
    for (const w of d.workspaces) {
      // A record naming a VM that is not its own workspace's (the root's word, checked) gets
      // no proxy and no link: it would give one domain's VM another domain's rules.
      if (!running.has(w.vm) || w.domain !== d.slug || !isOwnVm(d.slug, w)) continue;
      await ensureProxyUser(w.domain);
      const proxy = await rootctl<{ socket: string }>(
        "proxy.start",
        { vm: w.vm, domain: w.domain, workspace: w.workspace },
        { quiet: true },
      );
      await connectWorkspace({ ...w, proxy: proxy.socket });
      // And its services (start.sh, idempotent), which restart its relay and its daemon if
      // desolate's code changed: the link's handshake is in one, the host's requests in the
      // other.
      await b.exec(
        w.vm,
        [
          "bash",
          `${guest.release}/workspace/start.sh`,
          String(process.getuid!()),
          b.link(w.vm).guest,
        ],
        { root: true, timeoutMs: 120_000 },
      );
      // Its key too: a workspace made before keys were given gets one here, without a restart.
      await (await import("./spawn.ts")).giveIdentity(b, w.vm);
      // And its editor's token, made again if the host retired the tokens since it was made.
      if (await editorTokenStale(w.vm))
        await b.exec(
          w.vm,
          [
            "bash",
            "-lc",
            `bash ${guest.release}/workspace/editor.sh ${editorHostname(INSTANCE, w.domain, w.workspace)} ${retiredAt()}`,
          ],
          { timeoutMs: 300_000 },
        );
      // And the person's default editor settings (editor-defaults.ts), as they are now.
      await (await import("./editor-defaults.ts")).applyTo(w.vm);
      count += 1;
    }
  return count;
};

/** The root's word about a workspace, checked against what the host computes itself: the root
 *  is where every domain's data is parsed, and a VM named in its answer is a VM the host
 *  stops, starts or destroys (audit, 2026-11-16: an answer naming another domain's VM would
 *  have had it removed). */
/** Whether a record of the root's names its own workspace's VM, in that domain. */
export const isOwnVm = (domain: string, w: { domain?: unknown; workspace: unknown; vm: unknown }) =>
  (w.domain === undefined || w.domain === domain) &&
  isSlug(w.workspace) &&
  w.vm === workspaceVmName(INSTANCE, domain, w.workspace);
export const vouched = <W extends { domain: string; workspace: string; vm: string }>(
  w: W,
  domain: string,
  workspace?: string,
): W => {
  if (
    w.domain !== domain ||
    (workspace !== undefined && w.workspace !== workspace) ||
    !isSlug(w.workspace) ||
    w.vm !== workspaceVmName(INSTANCE, domain, w.workspace)
  )
    refuse(
      `the root's answer about ${domain}/${workspace ?? w.workspace} does not name that workspace's own VM`,
      "desolate doctor; if it persists, the root VM is not well: desolate bootstrap",
    );
  return w;
};
declare namespace isOwnVm {
  /** the VM a record names is the one the host computes for that workspace, in that domain */
  export type Records = Table<
    typeof isOwnVm,
    [
      [
        args: [domain: "acme", w: { domain: "acme"; workspace: "w1"; vm: "dsl-main-ddb30a57cc" }],
        expected: true,
      ],
      [args: [domain: "acme", w: { workspace: "w1"; vm: "dsl-main-ddb30a57cc" }], expected: true],
      /** another domain's workspace of the same name has another VM */
      [
        args: [domain: "acme", w: { domain: "acme"; workspace: "w1"; vm: "dsl-main-41eb634ef1" }],
        expected: false,
      ],
      [
        args: [domain: "acme", w: { domain: "beta"; workspace: "w1"; vm: "dsl-main-ddb30a57cc" }],
        expected: false,
      ],
      [
        args: [
          domain: "acme",
          w: { domain: "acme"; workspace: "../w1"; vm: "dsl-main-ddb30a57cc" },
        ],
        expected: false,
      ],
      [
        args: [domain: "acme", w: { domain: "acme"; workspace: "w1"; vm: "dsl-main-root" }],
        expected: false,
      ],
    ]
  >;
}
declare namespace vouched {
  /** the root's answer is used only if it names the workspace asked about, and its own VM */
  export type Passes = Expect<
    Invoke<
      typeof vouched,
      [
        w: { domain: "acme"; workspace: "w1"; vm: "dsl-main-ddb30a57cc" },
        domain: "acme",
        workspace: "w1",
      ]
    >,
    "=",
    { domain: "acme"; workspace: "w1"; vm: "dsl-main-ddb30a57cc" }
  >;
  export type Refuses = [
    Throws<
      Invoke<
        typeof vouched,
        [
          w: { domain: "acme"; workspace: "w1"; vm: "dsl-main-41eb634ef1" },
          domain: "acme",
          workspace: "w1",
        ]
      >,
      "the root's answer about acme/w1 does not name that workspace's own VM"
    >,
    Throws<
      Invoke<
        typeof vouched,
        [
          w: { domain: "acme"; workspace: "w2"; vm: "dsl-main-ddb30a57cc" },
          domain: "acme",
          workspace: "w1",
        ]
      >,
      "the root's answer about acme/w1 does not name that workspace's own VM"
    >,
  ];
}
/** What a domain's environment asks for (the root's projectSizeOf). */
type ProjectAsk = ProjectSize & { repo: string; path: string };

/** What `up` says of the project's own size, under the size line: what it asks for and where;
 *  each part a choice of the person's decided instead (a flag, the domain's size); what this
 *  Mac lowered; and what could not be read. Nothing, for a project that asks for nothing. */
export const sizeNotes = (
  asked: ProjectAsk | null,
  capped: string[],
  flags: Partial<Size> | undefined,
  domain: Partial<Size> | undefined,
): string[] => {
  if (!asked) return [];
  const lines: string[] = [];
  const parts = describeParts(asked.size);
  if (parts) lines.push(`  project asks ${parts} (${asked.repo}, ${asked.path})`);
  for (const key of ["cpus", "memoryMiB", "diskGiB"] as const) {
    if (asked.size[key] === undefined) continue;
    const by =
      flags?.[key] !== undefined
        ? "up's flag"
        : domain?.[key] !== undefined
          ? "the domain's size"
          : null;
    const chosen = flags?.[key] ?? domain?.[key];
    if (by && chosen !== asked.size[key])
      lines.push(`    ${describeParts({ [key]: chosen })} instead: ${by} decides`);
  }
  for (const why of capped) lines.push(`    lowered: ${why}`);
  for (const why of asked.problems) lines.push(`    not used: ${why}`);
  return lines;
};

declare namespace sizeNotes {
  /** a project that asks for 16 GiB, given it: one line */
  export type Asked = Expect<
    Invoke<
      typeof sizeNotes,
      [
        asked: {
          repo: "acme/app";
          path: ".devcontainer/devcontainer.json";
          size: { memoryMiB: 16384 };
          problems: [];
        },
        capped: [],
        flags: undefined,
        domain: undefined,
      ]
    >,
    "=",
    ["  project asks 16 GiB memory (acme/app, .devcontainer/devcontainer.json)"]
  >;
  /** the person's choices decide, and say so; and what the Mac lowered and what was not read */
  export type Overridden = Expect<
    Invoke<
      typeof sizeNotes,
      [
        asked: {
          repo: "acme/app";
          path: ".devcontainer.json";
          size: { cpus: 8; memoryMiB: 16384 };
          problems: ['customizations.desolate.disk: "lots" is not an amount (write it as "16g")'];
        },
        capped: ["8 CPUs: this Mac has 4"],
        flags: { cpus: 2 },
        domain: { memoryMiB: 8192 },
      ]
    >,
    "=",
    [
      "  project asks 8 CPUs, 16 GiB memory (acme/app, .devcontainer.json)",
      "    2 CPUs instead: up's flag decides",
      "    8 GiB memory instead: the domain's size decides",
      "    lowered: 8 CPUs: this Mac has 4",
      '    not used: customizations.desolate.disk: "lots" is not an amount (write it as "16g")',
    ]
  >;
  /** no spec: nothing */
  export type NoSpec = Expect<
    Invoke<typeof sizeNotes, [asked: null, capped: [], flags: undefined, domain: undefined]>,
    "=",
    []
  >;
}

/** `desolate resize <d>/<w> [--cpus] [--memory] [--disk]`: a stopped workspace's size, changed
 *  in its VM and in the root's record (so a VM made again for it is made this size). What is
 *  not given is kept. A disk only grows. With no flags: its size, and what its project asks. */
export const resize = async (target: string | undefined, given: Partial<Size>, out: Out) => {
  const w = await find(target);
  const name = `${w.domain}/${w.workspace}`;
  // (A workspace made before sizes were recorded got the defaults of its day: these.)
  const now: Size = w.size ?? stackDefaults();
  if (Object.keys(given).length === 0) {
    out(`${name}  ${describeSize(now)}`);
    const asked = await rootctl<ProjectAsk | null>(
      "domain.projectSize",
      { slug: w.domain, preferred: w.env },
      { quiet: true },
    ).catch(() => null);
    for (const line of sizeNotes(asked, [], undefined, undefined)) out(line);
    out(
      `change it (stopped): desolate resize ${name} [--cpus <n>] [--memory <16g>] [--disk <60g>]`,
    );
    return;
  }
  const next = merge(given, now);
  if (next.diskGiB < now.diskGiB)
    refuse(
      `a workspace's disk can grow, never shrink: ${name} has ${now.diskGiB} GiB`,
      `desolate resize ${name} --disk ${now.diskGiB}g`,
      EXIT.usage,
    );
  if (next.cpus === now.cpus && next.memoryMiB === now.memoryMiB && next.diskGiB === now.diskGiB) {
    out(`${name} is already ${describeSize(now)}`);
    return;
  }
  const b = backend();
  const status = (await b.info(w.vm)).status;
  if (status === "running")
    refuse(
      `${name} is ${status}: a VM's size changes only while it is stopped`,
      `desolate stop ${name}`,
      EXIT.busy,
    );
  if (status !== "missing") await b.resize(w.vm, next);
  await rootctl(
    "workspace.resize",
    { domain: w.domain, name: w.workspace, size: next },
    { quiet: true },
  );
  out(
    `resized ${name}: ${describeSize(next)}${status === "missing" ? " (its VM is made at this size when it starts)" : ""}`,
  );
  out(`next: desolate start ${name}`);
};

const find = async (target: string | undefined) => {
  const { domain, workspace } = splitTarget(target);
  return vouched(
    await rootctl<Workspace>("workspace.get", { domain, name: workspace }, { quiet: true }),
    domain,
    workspace,
  );
};

export const stop = async (target: string | undefined, out: Out) => {
  const w = await find(target);
  const b = backend();
  const { disconnectWorkspace } = await import("./daemon.ts");
  // The VM first: its link's port is let go only once nothing in a VM can still dial it (a
  // freed port is anyone's on this machine to take; shared/link.ts).
  if ((await b.info(w.vm)).status === "running") {
    // What it holds, seen once more before it stops: what the dashboard's Delete goes by
    // while it is stopped. A look that fails says so, and Delete stays off.
    await look(w, true).catch(() => {});
    await b.stop(w.vm);
  }
  await disconnectWorkspace(w.vm);
  await rootctl("proxy.stop", { vm: w.vm }, { quiet: true }).catch(() => {});
  await rootctl(
    "workspace.state",
    { domain: w.domain, name: w.workspace, state: "stopped" },
    { quiet: true },
  );
  out(
    `stopped ${w.domain}/${w.workspace}. Its checkouts stay held; start it again with: desolate start ${w.domain}/${w.workspace}`,
  );
};

export const start = async (target: string | undefined, out: Out) => {
  const shared = sharedFolderRefusal();
  if (shared) refuse(shared.why, shared.fix);
  const w = await find(target);
  forget(w.vm);
  const b = backend();
  const started = Date.now();
  const info = await b.info(w.vm);
  if (info.status === "missing") {
    // Its VM is gone (a destroy, or a VM removed by hand), its record and checkouts are not:
    // the checkouts are in the domain's clones on the host. Made again, on the same ones.
    out(
      `the VM of ${w.domain}/${w.workspace} is gone; making it again, on the same checkouts (they are on this Mac, and kept)`,
    );
    const checkouts = w.checkouts.map((c) =>
      c.kind === "main" ? `${c.repo}=main` : `${c.repo}=worktree:${c.branch}`,
    );
    const parent = (await import("./spawn.ts")).parentOf(w.domain, w.workspace);
    await remove(`${w.domain}/${w.workspace}`, () => {});
    return up(
      w.domain,
      {
        name: w.workspace,
        checkouts,
        fetch: false,
        size: w.size ?? undefined,
        keep: { startedBy: w.startedBy, parent },
      },
      out,
      false,
    );
  }
  if (info.status !== "running") await b.start(w.vm);
  const { devcontainer, editorDown, editorStarting } = await startServices(w);
  await rootctl(
    "workspace.state",
    { domain: w.domain, name: w.workspace, state: "up" },
    { quiet: true },
  );
  out(
    `workspace ${w.domain}/${w.workspace} is up (${((Date.now() - started) / 1000).toFixed(1)} s)`,
  );
  if (w.size) out(`  size         ${describeSize(w.size)}`);
  out(`  devcontainer ${devcontainer}`);
  if (editorDown) out(`  editor       NOT AVAILABLE: ${editorDown}`);
  else if (editorStarting) out(`  editor${STILL_STARTING}`);
};

/** What would be lost: each checkout's uncommitted changes, untracked files and stashes,
 *  looked at in the workspace itself (git runs in its own VM, never on the host: P4), after
 *  its branches are written out for the root. What the VM says is its word about itself. */
const unsaved = async (w: Workspace, sync = true): Promise<string[]> => {
  const b = backend();
  if ((await b.info(w.vm)).status !== "running")
    return [
      "it is not running, so what it holds cannot be looked at (a person removes it: desolate rm)",
    ];
  const script = `${sync ? `${NODE.join(" ")} ${guest.release}/workspace/desolate.ts sync >/dev/null 2>&1 || echo "UNSYNCED"` : ""}
for p in "$@"; do
  s=$(git -C "$p" status --porcelain --untracked-files=normal 2>/dev/null) || { echo "UNREADABLE $p"; continue; }
  [ -z "$s" ] || echo "UNCOMMITTED $p"
  [ -z "$(git -C "$p" stash list 2>/dev/null)" ] || echo "STASHED $p"
done`;
  const looked = await b.exec(
    w.vm,
    ["bash", "-c", script, "_", ...w.checkouts.map((c) => c.path)],
    { timeoutMs: 120_000 },
  );
  if (looked.code !== 0)
    return [
      `it could not be looked at: ${fromVm(w, "unsaved", looked.stderr, 3).replace(/\n/g, " ")}`,
    ];
  return lostIn(
    looked.stdout,
    w.checkouts.map((c) => c.path),
  );
};

/** What the VM's look (above) says would be lost, in words: each line names what, and the
 *  checkout (one of `checkouts`, the paths the host asked about). A line that is not one of those
 *  is not passed over: a remove must not read as safe because of what it could not read. */
export const lostIn = (stdout: string, checkouts: readonly string[]): string[] => {
  const say: Record<string, string> = {
    UNSYNCED: "its branches could not be written out for the root",
    UNCOMMITTED: "uncommitted changes or untracked files in",
    STASHED: "stashed changes in",
    UNREADABLE: "a checkout git could not read:",
  };
  const lost: string[] = [];
  let unread = 0;
  for (const line of stdout.split("\n").map((l) => l.trim())) {
    if (!line) continue;
    const [word, ...rest] = line.split(" ");
    const where = rest.join(" ");
    if (word === "UNSYNCED" && !where) lost.push(say.UNSYNCED!);
    else if (word && word !== "UNSYNCED" && say[word] && checkouts.includes(where))
      lost.push(`${say[word]} ${where}`);
    else unread++;
  }
  if (unread)
    lost.push(
      `${unread} line${unread === 1 ? "" : "s"} of its answer could not be read, so something may be lost that is not named here`,
    );
  return lost;
};

declare namespace lostIn {
  /** each line read, against the checkouts asked about */
  export type Read = Expect<
    Invoke<
      typeof lostIn,
      [
        stdout: "UNSYNCED\nUNCOMMITTED /workspaces/acme/app\nSTASHED /workspaces/acme/app\n",
        checkouts: ["/workspaces/acme/app"],
      ]
    >,
    "=",
    [
      "its branches could not be written out for the root",
      "uncommitted changes or untracked files in /workspaces/acme/app",
      "stashed changes in /workspaces/acme/app",
    ]
  >;
  /** nothing said: nothing lost */
  export type Clean = Expect<
    Invoke<typeof lostIn, [stdout: "\n", checkouts: ["/workspaces/a"]]>,
    "=",
    []
  >;
  /** a line that is not one of them, or names a checkout not asked about, is counted, not
   *  dropped: the answer then never reads as clean */
  export type Unread = Expect<
    Invoke<
      typeof lostIn,
      [
        stdout: "UNCOMMITTED /workspaces/other\nwhat is this\nUNCOMMITTED /workspaces/a\n",
        checkouts: ["/workspaces/a"],
      ]
    >,
    "=",
    [
      "uncommitted changes or untracked files in /workspaces/a",
      "2 lines of its answer could not be read, so something may be lost that is not named here",
    ]
  >;
}

/** What a workspace held that a remove would lose, as last looked at, kept on the host for the
 *  dashboard's Delete: the daemon looks while the workspace runs, and `stop` looks once more
 *  just before its VM stops, so a stopped workspace's answer is the one from its stop (its
 *  files change only while it runs). `start` forgets it. */
export type Looked = { at: string; atStop: boolean; lost: string[] };
const lookedFile = (vm: string) => path.join(paths.state, "unsaved", `${vm}.json`);
export const lookedAt = (vm: string): Looked | null => {
  try {
    const value = JSON.parse(fs.readFileSync(lookedFile(vm), "utf8")) as Looked;
    return typeof value.at === "string" && Array.isArray(value.lost) ? value : null;
  } catch {
    return null;
  }
};
export const look = async (w: Workspace, atStop = false): Promise<Looked> => {
  const looked: Looked = { at: new Date().toISOString(), atStop, lost: await unsaved(w, false) };
  fs.mkdirSync(path.dirname(lookedFile(w.vm)), { recursive: true, mode: 0o700 });
  fs.writeFileSync(lookedFile(w.vm), JSON.stringify(looked));
  return looked;
};
const forget = (vm: string) => fs.rmSync(lookedFile(vm), { force: true });

/** `--if-clean`: only if nothing in it would be lost (looked at now, or at its stop).
 *  `--if-pushed`: and every checkout's commits are on the remote, as the root sees them (the
 *  dashboard's Delete asks for both). */
export const remove = async (
  target: string | undefined,
  out: Out,
  options: { ifClean?: boolean; ifPushed?: boolean } = {},
) => {
  if (target && !target.includes("/")) {
    if (!isSlug(target))
      refuse(
        `'${target}' is not a domain name`,
        "a domain name is a slug: lowercase letters, digits and single dashes, at most 40",
        EXIT.usage,
      );
    const result = await rootctl<{ domain: string; kept: string }>(
      "domain.remove",
      { slug: target },
      { quiet: true },
    );
    // The root's ordinary user answers this, so what the Mac deletes is named by the person's
    // checked name, and only once the root says it removed exactly that domain.
    if (result?.domain !== target)
      refuse(
        `the root answered about another domain than ${target}, so nothing was removed on this Mac`,
        "desolate doctor",
      );
    // Its template is its own and goes with it.
    await (await import("./templates.ts")).removeAll(target);
    fs.rmSync(paths.domain(target), { recursive: true, force: true });
    return out(`removed the domain ${target}; ${result.kept}.`);
  }
  const w = await find(target);
  // --if-clean (a workspace closing one it started, or the dashboard's Delete): only if
  // nothing would be lost. A stopped one is judged by what was seen as it stopped.
  if (options.ifClean || options.ifPushed) {
    const running = (await backend().info(w.vm)).status === "running";
    const kept = running ? null : lookedAt(w.vm);
    const lost = !options.ifClean
      ? []
      : running
        ? await unsaved(w)
        : kept?.atStop
          ? kept.lost
          : [
              "it is stopped, and was not looked at as it stopped (start it, or remove it yourself)",
            ];
    if (options.ifPushed) {
      const pushed = await rootctl<Unpushed[]>(
        "workspace.unpushed",
        { domain: w.domain, name: w.workspace },
        { quiet: true },
      );
      for (const c of pushed) if (c.why) lost.push(`${c.repo}: ${c.why}`);
    }
    if (lost.length > 0)
      refuse(
        `${w.domain}/${w.workspace} was not removed: ${lost.join("; ")}`,
        `commit, push or discard it there first (desolate exec ${w.domain}/${w.workspace} -- git status), or remove it yourself: desolate rm ${w.domain}/${w.workspace}`,
        EXIT.busy,
      );
  }
  const { disconnectWorkspace } = await import("./daemon.ts");
  await backend().destroy(w.vm);
  await disconnectWorkspace(w.vm);
  await rootctl("proxy.stop", { vm: w.vm }, { quiet: true }).catch(() => {});
  fs.rmSync(paths.link(w.vm), { recursive: true, force: true });
  await rootctl("workspace.remove", { domain: w.domain, name: w.workspace }, { quiet: true });
  (await import("./spawn.ts")).forget(w.domain, w.workspace);
  forget(w.vm);
  out(
    `removed ${w.domain}/${w.workspace}. Its branches and worktrees stay in the domain's clones.`,
  );
};

declare namespace remove {
  type Answer = { "domain.remove": { domain: "acme"; kept: "its clones are kept" } };
  /** the domain asked about, removed on the Mac once the root says it removed that one */
  export type Domain = Given<
    [
      Invoke<typeof emptyHome>,
      Mock<"./stack.ts", typeof fakeStack>,
      Invoke<typeof writeInHome, [name: "domains/acme/settings.json", text: "{}"]>,
      Invoke<typeof rootAnswers, [answers: Answer]>,
      Invoke<typeof vmAnswers, [answers: { list: [] }]>,
      Invoke<typeof remove, [target: "acme", out: typeof collect]>,
    ],
    [
      Expect<Invoke<typeof said>, "=", ["removed the domain acme; its clones are kept."]>,
      Expect<Invoke<typeof homeHas, [name: "domains/acme"]>, "=", false>,
    ]
  >;
  /** an answer that names another place (the home itself) or another domain removes nothing
   *  on the Mac; the domain's own folder stays too */
  export type AnswerNamesElsewhere = Given<
    [
      Invoke<typeof emptyHome>,
      Mock<"./stack.ts", typeof fakeStack>,
      Invoke<typeof writeInHome, [name: "sentinel", text: "kept"]>,
      Invoke<typeof writeInHome, [name: "domains/acme/settings.json", text: "{}"]>,
      Invoke<typeof writeInHome, [name: "domains/beta/settings.json", text: "{}"]>,
    ],
    [
      Given<
        [
          Invoke<typeof rootAnswers, [answers: { "domain.remove": { domain: ".."; kept: "" } }]>,
          Invoke<typeof vmAnswers, [answers: { list: [] }]>,
        ],
        Expect<
          Invoke<typeof refusalOf, [f: typeof remove, args: ["acme", typeof collect]]>,
          "=",
          {
            message: "the root answered about another domain than acme, so nothing was removed on this Mac";
            fix: "desolate doctor";
            code: 1;
          }
        >
      >,
      Given<
        [
          Invoke<typeof rootAnswers, [answers: { "domain.remove": { domain: "beta"; kept: "" } }]>,
          Invoke<typeof vmAnswers, [answers: { list: [] }]>,
        ],
        Expect<
          Invoke<typeof refusalOf, [f: typeof remove, args: ["acme", typeof collect]]>,
          "matches",
          {
            message: "the root answered about another domain than acme, so nothing was removed on this Mac";
          }
        >
      >,
      Expect<Invoke<typeof homeHas, [name: "sentinel"]>, "=", true>,
      Expect<Invoke<typeof homeHas, [name: "domains/acme/settings.json"]>, "=", true>,
      Expect<Invoke<typeof homeHas, [name: "domains/beta/settings.json"]>, "=", true>,
    ]
  >;
  /** a name that is not a domain's is refused before the root is asked */
  export type NotADomain = Given<
    [Mock<"./stack.ts", typeof fakeStack>, Invoke<typeof rootAnswers, [answers: Answer]>],
    [
      Expect<
        Invoke<typeof refusalOf, [f: typeof remove, args: ["..", typeof collect]]>,
        "matches",
        { message: "'..' is not a domain name"; code: 64 }
      >,
      Expect<Invoke<typeof rootAsked>, "=", []>,
    ]
  >;
}

/** A command, or an agent, in a workspace. stdin, stdout, stderr and the exit code pass
 *  through. */
export const exec = async (
  target: string | undefined,
  command: string[],
  options: { checkout?: string; vm?: boolean },
): Promise<number> => {
  const w = await find(target);
  if (command.length === 0)
    refuse(
      "exec needs a command",
      "desolate exec <domain>/<workspace> -- <command> [args...]",
      EXIT.usage,
    );
  const checkout = options.checkout
    ? w.checkouts.find((c) => c.repo === options.checkout)
    : w.checkouts[0];
  if (!checkout)
    refuse(
      `${options.checkout} is not checked out in ${w.domain}/${w.workspace}`,
      `it has: ${w.checkouts.map((c) => c.repo).join(", ")}`,
    );
  const b = backend();
  // (Asked first whether the VM runs: on Lima that is a few files and a connect, no process.)
  if ((await b.info(w.vm)).status !== "running")
    refuse(
      `${w.domain}/${w.workspace} is not running`,
      `desolate start ${w.domain}/${w.workspace}`,
    );
  // In the project's devcontainer when the workspace has one that is up, else in the VM
  // itself (enter.sh decides, inside the VM); --vm asks for the VM itself.
  const child = b.spawn(w.vm, [
    "bash",
    `${guest.release}/workspace/enter.sh`,
    ...(options.vm ? ["--vm"] : []),
    checkout!.path,
    "--",
    ...command,
  ]);
  process.stdin.pipe(child.stdin!);
  child.stdin!.on("error", () => {});
  // To a terminal (a person running an agent by hand): kept to what a screen needs
  // (shared/terminal-filter.ts). To a pipe or a file (a script): unchanged.
  const shown = terminalFilter();
  if (process.stdout.isTTY)
    child.stdout!.on("data", (chunk: Buffer) => process.stdout.write(shown(chunk)));
  else child.stdout!.pipe(process.stdout);
  if (process.stderr.isTTY) {
    const filter = terminalFilter();
    child.stderr!.on("data", (chunk: Buffer) => process.stderr.write(filter(chunk)));
  } else child.stderr!.pipe(process.stderr);
  const code = await new Promise<number>((resolve) =>
    child.on("close", (status) => resolve(status ?? 1)),
  );
  // A full-screen program's modes, off again: the terminal is your shell's.
  if (process.stdout.isTTY) process.stdout.write(shown.reset());
  process.stdin.unpipe();
  process.stdin.pause();
  return code;
};
