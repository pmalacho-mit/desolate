// `desolate agent`: an agent kept running in a workspace, and your own terminal attached to
// it when you want to watch or talk to it (workspace/agent-holder.py keeps it).
//
//   desolate agent start <domain>/<workspace> [--name <n>] [--checkout <owner/repo>] -- <command...>
//   desolate agent attach <domain>/<workspace> [--name <n>]     Ctrl-] detaches; it keeps running
//   desolate agent list [<domain>[/<workspace>]] [--json]
//   desolate agent log <domain>/<workspace> [--name <n>] [--all | --lines <n> | --since <when>]
//   desolate agent stop <domain>/<workspace> [--name <n>] [--kill]
//
// "agent" is the command's name: any long-running program is one (a dev server, a watcher, a
// coding agent). No tmux: your terminal draws the agent's output itself, so its scrollback,
// selection and copy are your terminal's (replayed on attach: the end of its log is there to
// scroll back through). Its log keeps the newest of what it printed, up to the setting
// agent.logMiB, and is read for as long as it is there, after the agent has ended too. Many
// agents can run at once, one or more per workspace, each in its own VM: `desolate agent list`
// shows them all.
//
// What the holder in the VM says (its errors, its log, its list) is the VM's, where an agent
// is root: made safe before it reaches a terminal. A holder started before this file (its log
// one file, cut at 64 MiB) is still talked to: the socket's protocol is the same, and every
// command here runs the holder's file anew (workspace/agent-holder.py says how).
import { EXIT, refuse } from "../shared/exit.ts";
import { formatBytes, NAMES } from "../shared/limits.ts";
import { andMore, PAGE } from "../shared/listed.ts";
import type { Listed } from "../shared/listed.ts";
import { parseRepo, SLUG } from "../shared/names.ts";
import { define, mebibytes, valueOf } from "../shared/settings.ts";
import { terminalFilter } from "../shared/terminal-filter.ts";
import { CUT, failure, printable, printableLines } from "../shared/text.ts";
import { keep, LAST } from "./failures.ts";
import { guest } from "./paths.ts";
import { backend, rootctl } from "./stack.ts";
import type {
  Expect,
  Given,
  Invoke,
  Mock,
  Table,
  Throws,
} from "../../suede.nests/dsl.import.meta.vitest.ts";
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
type Workspace = {
  domain: string;
  workspace: string;
  vm: string;
  checkouts: { repo: string; path: string }[];
};
type Agent = {
  name: string;
  state: string;
  command: string[];
  started: string;
  lastOutput: string | null;
  exit: number | null;
  ended?: string;
};

const HOLDER = () => [`python3`, "-I", `${guest.release}/workspace/agent-holder.py`];
const DETACH = 0x1d; // Ctrl-]

/** How much of what an agent printed its log keeps: the newest, the oldest dropped past it.
 *  Unset, the holder works it out from the disk the log is on (a twentieth of it), which the
 *  host does not know. */
export const LOG_MOST = define<number | null>({
  name: "agent.logMiB",
  env: "DESOLATE_AGENT_LOG_MIB",
  side: "host",
  default: null,
  parse: mebibytes(1, 1024 * 1024),
  why: "The most of an agent's output its log keeps, in MiB: past it the oldest is dropped, and the log says so. Unset, a twentieth of its workspace's disk.",
});

/** The flags of each `desolate agent` verb (host/cli.ts parses them with these). */
export const FLAGS = {
  start: { name: { type: "string" }, checkout: { type: "string" } },
  attach: { name: { type: "string" } },
  list: {},
  log: {
    name: { type: "string" },
    all: { type: "boolean" },
    lines: { type: "string" },
    since: { type: "string" },
  },
  stop: { name: { type: "string" }, kill: { type: "boolean" } },
} as const;

/** The most this process keeps of what the holder in the VM says (an answer, an error), as
 *  an exec's `maxBytes` or gathered from a stream: the VM is not trusted (an agent is root there), and
 *  what this process holds is bounded by what it is for. A holder's answer is a line of JSON,
 *  its error a traceback at most; 1 MiB of either is a holder gone wrong, and is said to be. */
const SAID_MOST = 1024 * 1024;
const gather = (stream: NodeJS.ReadableStream) => {
  let text = "";
  stream.on("data", (chunk: Buffer) => {
    if (text.length < SAID_MOST) text += chunk.toString("utf8");
    if (text.length >= SAID_MOST)
      text = `${text.slice(0, SAID_MOST)}\n(cut at 1 MiB: the rest was not read)`;
  });
  return () => text;
};

/** The holder's error, whole (R1): its last lines, made safe, and where all of it is kept
 *  (host/failures.ts), made safe there too: the file is read with `cat` as often as not. */
const holderError = (said: { stdout: string; stderr: string }, what: string) =>
  failure((said.stderr || said.stdout).replace(/^agent-holder: /, ""), LAST, (whole) =>
    keep(`agent-${what}`)(printableLines(whole)),
  );

declare namespace holderError {
  /** what the holder said, without its own prefix, made safe; short enough to be whole */
  export type Short = Expect<
    Invoke<
      typeof holderError,
      [said: { stdout: ""; stderr: "agent-holder: 'web' is not running\n" }, what: "web"]
    >,
    "=",
    "'web' is not running"
  >;
}

const target = async (value: string | undefined): Promise<Workspace> => {
  const [domain, workspace] = String(value ?? "").split("/");
  if (!domain || !workspace)
    refuse(
      "which workspace?",
      "desolate agent <start|attach|log|stop> <domain>/<workspace>",
      EXIT.usage,
    );
  const w = (await import("./workspaces.ts")).vouched(
    await rootctl<Workspace>("workspace.get", { domain, name: workspace }, { quiet: true }),
    domain,
    workspace,
  );
  if ((await backend().info(w.vm)).status !== "running")
    refuse(`${domain}/${workspace} is not running`, `desolate start ${domain}/${workspace}`);
  return w;
};
const nameOf = (value: unknown) => {
  const name = typeof value === "string" ? value : "agent";
  if (!SLUG.test(name))
    refuse(
      `'${printable(name)}' is not an agent name`,
      `lower-case letters, digits and dashes, at most ${NAMES.slug}`,
      EXIT.usage,
    );
  return name;
};

declare namespace nameOf {
  /** "agent" unless named; a name is a file name in the VM (its log) and a word of the holder's */
  export type Names = Table<
    typeof nameOf,
    [
      [args: [value: undefined], expected: "agent"],
      [args: [value: "dev-server"], expected: "dev-server"],
    ]
  >;
  export type Refuses = [
    Expect<
      Invoke<typeof refusalOf, [run: typeof nameOf, args: [value: "../agent"]]>,
      "=",
      {
        message: "'../agent' is not an agent name";
        fix: "lower-case letters, digits and dashes, at most 40";
        code: 64;
      }
    >,
    Throws<Invoke<typeof nameOf, [value: "-x"]>, "'-x' is not an agent name">,
    Throws<Invoke<typeof nameOf, [value: "Agent"]>, "'Agent' is not an agent name">,
    Throws<Invoke<typeof nameOf, [value: "a b"]>, "'a b' is not an agent name">,
    Throws<
      Invoke<typeof nameOf, [value: "a12345678901234567890123456789012345678901"]>,
      "is not an agent name"
    >,
  ];
}

export const start = async (
  where: string | undefined,
  options: { name?: string; checkout?: string },
  command: string[],
  out: Out,
  json: boolean,
) => {
  if (command.length === 0)
    refuse("start what?", "desolate agent start <domain>/<workspace> -- <command...>", EXIT.usage);
  const w = await target(where);
  const checkout = options.checkout
    ? w.checkouts.find((c) => c.repo === options.checkout)
    : w.checkouts[0];
  if (!checkout || (options.checkout && !parseRepo(options.checkout)))
    refuse(
      `${options.checkout} is not checked out in ${w.domain}/${w.workspace}`,
      `it has: ${w.checkouts.map((c) => c.repo).join(", ")}`,
      EXIT.usage,
    );
  const name = nameOf(options.name);
  const started = await holderStart(w, name, checkout!.path, command);
  if (started.code !== 0)
    refuse(
      `the agent did not start: ${holderError(started, name)}`,
      `desolate agent list ${w.domain}/${w.workspace}`,
    );
  if (json) {
    // The holder's state file, which the agent can write: only its well-formed fields.
    let given: unknown = null;
    try {
      given = JSON.parse(started.stdout.trim());
    } catch {
      /* said nothing a script can use */
    }
    return out(JSON.stringify(rowsOf([given], `${w.domain}/${w.workspace}`).items[0] ?? null));
  }
  out(`agent ${name} is running in ${w.domain}/${w.workspace} (${checkout!.repo})`);
  out(
    `  attach: desolate agent attach ${w.domain}/${w.workspace}${name === "agent" ? "" : ` --name ${name}`}   (Ctrl-] detaches; it keeps running)`,
  );
};

declare namespace start {
  /** a command, and a workspace named as <domain>/<workspace>, before anything is asked */
  export type Usage = [
    Expect<
      Invoke<
        typeof refusalOf,
        [
          run: typeof start,
          args: [where: "acme/w1", options: {}, command: [], out: typeof collect, json: false],
        ]
      >,
      "=",
      {
        message: "start what?";
        fix: "desolate agent start <domain>/<workspace> -- <command...>";
        code: 64;
      }
    >,
    Expect<
      Invoke<
        typeof refusalOf,
        [
          run: typeof start,
          args: [where: "acme", options: {}, command: ["claude"], out: typeof collect, json: false],
        ]
      >,
      "=",
      {
        message: "which workspace?";
        fix: "desolate agent <start|attach|log|stop> <domain>/<workspace>";
        code: 64;
      }
    >,
  ];
}

/** The holder's start, with the log's most when the person set one. The command goes on
 *  stdin, as JSON: Lima's shell carries argv to the VM as one shell string, and Linux takes
 *  no argument over 128 KiB (a command may be 64 Ki characters, quoted). */
const holderStart = (w: Workspace, name: string, dir: string, command: string[]) => {
  const most = valueOf(LOG_MOST);
  return backend().exec(
    w.vm,
    [
      ...HOLDER(),
      "start",
      name,
      dir,
      ...(most === null ? [] : ["--log-most", String(most * 1024 * 1024)]),
    ],
    { timeoutMs: 60_000, input: JSON.stringify(command), maxBytes: SAID_MOST },
  );
};

/** An agent in a workspace that was just made (`desolate up ... -- <command...>`, and what a
 *  workspace's `desolate spawn` runs): named "agent", in its first checkout. The command is
 *  argv, to the holder in the VM; nothing on the host reads it. Returns the agent's name. */
export const startIn = async (w: Workspace, command: string[]): Promise<string> => {
  const checkout = w.checkouts[0];
  if (!checkout)
    refuse(`${w.domain}/${w.workspace} has no checkout to run it in`, `desolate list ${w.domain}`);
  const started = await holderStart(w, "agent", checkout!.path, command);
  if (started.code !== 0)
    refuse(
      `the workspace is up, but its agent did not start: ${holderError(started, "agent")}`,
      `desolate agent start ${w.domain}/${w.workspace} -- <command...>`,
    );
  return "agent";
};

type Row = Agent & { workspace: string };

/** How many of a workspace's agents are listed, at most: far more than one VM runs (each
 *  running one holds a pty, and Linux has 4096 by default), so a longer list is the VM's
 *  flood (an agent is root there), and is said to be by its count. */
const AGENTS_MOST = 1000;

/** The rows of a VM's account of its agents that are well formed, each name once, at most
 *  AGENTS_MOST of them, and how many there were: the VM's (an agent is root there), so only
 *  rows of the expected shape, every string made printable, a time that is not one dropped. */
const rowsOf = (given: unknown, workspace: string): Listed<Row> => {
  const iso = (v: unknown) =>
    typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(v) ? v : null;
  const rows: Row[] = [];
  const seen = new Set<string>();
  for (const a of (Array.isArray(given) ? given : []) as Agent[]) {
    if (
      typeof a?.name !== "string" ||
      !SLUG.test(a.name) ||
      seen.has(a.name) ||
      !["running", "exited", "lost"].includes(String(a.state))
    )
      continue;
    seen.add(a.name);
    if (rows.length >= AGENTS_MOST) continue;
    rows.push({
      name: a.name,
      state: String(a.state),
      workspace,
      command: [printable((Array.isArray(a.command) ? a.command : []).map(String).join(" "))],
      started: iso(a.started) ?? "",
      lastOutput: iso(a.lastOutput),
      exit: Number.isInteger(a.exit) ? a.exit : null,
      ...(iso(a.ended) ? { ended: iso(a.ended)! } : {}),
    });
  }
  return { items: rows.sort((a, b) => a.name.localeCompare(b.name)), total: seen.size, from: 0 };
};

declare namespace rowsOf {
  /** a name once (the second is the VM's, not an agent), a row not of the shape left out,
   *  and the count of what was kept */
  export type EachOnce = Expect<
    Invoke<
      typeof rowsOf,
      [
        given: [
          {
            name: "web";
            state: "running";
            command: ["npm", "run", "dev"];
            started: "2026-11-16T10:00:00Z";
            lastOutput: null;
            exit: null;
          },
          {
            name: "web";
            state: "exited";
            command: [];
            started: "2026-11-16T10:00:00Z";
            lastOutput: null;
            exit: 0;
          },
          { name: "../x"; state: "running"; command: [] },
        ],
        workspace: "acme/w1",
      ]
    >,
    "=",
    {
      items: [
        {
          name: "web";
          state: "running";
          workspace: "acme/w1";
          command: ["npm run dev"];
          started: "2026-11-16T10:00:00Z";
          lastOutput: null;
          exit: null;
        },
      ];
      total: 1;
      from: 0;
    }
  >;
}

/** A line fitted to a terminal `width` columns wide, the cut marked; whole when the width is
 *  not known (a pipe, a file: whatever reads it has all of it). Counted in code points, as
 *  what an agent's command holds is made printable before (one column each, mostly: a wide
 *  character takes two, and the terminal wraps what is still too long). */
export const fitted = (line: string, width: number | undefined): string => {
  const points = [...line];
  if (!width || points.length <= width) return line;
  return points.slice(0, Math.max(0, width - 1)).join("") + CUT;
};

declare namespace fitted {
  export type Fits = Table<
    typeof fitted,
    [
      /** to a pipe: whole */
      [
        args: [line: "  acme/w1  web  running  npm run dev -- --port 5173", width: undefined],
        expected: "  acme/w1  web  running  npm run dev -- --port 5173",
      ],
      /** to a terminal: as wide as it is, and the mark says it was cut */
      [
        args: [line: "  acme/w1  web  running  npm run dev -- --port 5173", width: 30],
        expected: "  acme/w1  web  running  npm …",
      ],
      /** short enough: as it is */
      [args: [line: "  acme/w1  web", width: 30], expected: "  acme/w1  web"],
    ]
  >;
}

export const list = async (only: string | undefined, out: Out, json: boolean) => {
  const [domain, workspace] = String(only ?? "").split("/");
  const all = await rootctl<{ slug: string; workspaces: Workspace[] }[]>(
    "domain.list",
    {},
    { quiet: true },
  );
  const b = backend();
  const running = new Set(
    (await b.list()).filter((vm) => vm.status === "running").map((vm) => vm.name),
  );
  const found: Listed<Row>[] = [];
  const { isOwnVm } = await import("./workspaces.ts");
  await Promise.all(
    all
      .filter((d) => !domain || d.slug === domain)
      .flatMap((d) =>
        d.workspaces
          .filter(
            (w) =>
              (!workspace || w.workspace === workspace) && running.has(w.vm) && isOwnVm(d.slug, w),
          )
          .map(async (w) => {
            const said = await b.exec(w.vm, [...HOLDER(), "list"], {
              timeoutMs: 30_000,
              maxBytes: SAID_MOST,
            });
            let given: unknown = [];
            try {
              given = JSON.parse(said.stdout.trim() || "[]");
            } catch {
              /* no agents there */
            }
            const rows = rowsOf(given, `${d.slug}/${w.workspace}`);
            if (rows.total) found.push(rows);
          }),
      ),
  );
  found.sort((a, b2) => a.items[0]!.workspace.localeCompare(b2.items[0]!.workspace));
  // A script gets every agent; a person, a page of each workspace's, and how many more.
  if (json) return out(JSON.stringify(found.flatMap((rows) => rows.items)));
  if (found.length === 0)
    return out("no agents. Start one: desolate agent start <domain>/<workspace> -- <command...>");
  const ago = (when: string | null) =>
    when ? `${Math.max(0, Math.round((Date.now() - Date.parse(when)) / 1000))} s ago` : "never";
  const width = process.stdout.isTTY ? process.stdout.columns : undefined;
  for (const rows of found) {
    const page = { ...rows, items: rows.items.slice(0, PAGE) };
    for (const a of page.items)
      out(
        fitted(
          `  ${a.workspace}  ${a.name}  ${a.state}${a.exit !== null ? ` (exit ${a.exit})` : ""}  started ${ago(a.started)}, last output ${ago(a.lastOutput)}  ${a.command.join(" ")}`,
          width,
        ),
      );
    const rest = andMore(page, "agent");
    if (rest)
      out(
        `  ${rows.items[0]!.workspace}: ${rest}${rows.total > rows.items.length ? ` (it lists more than ${AGENTS_MOST}: they are not shown)` : ` (every one: desolate agent list ${rows.items[0]!.workspace} --json)`}`,
      );
  }
};

declare namespace list {
  /** each VM's account of its agents is that VM's: only its own workspaces are asked, only rows
   *  of the expected shape kept, every string made printable, a time that is not one dropped */
  export type OnlyWhatIsWellFormed = Given<
    [
      Mock<"./stack.ts", typeof fakeStack>,
      Invoke<
        typeof rootAnswers,
        [
          answers: {
            "domain.list": [
              {
                slug: "acme";
                workspaces: [
                  { domain: "acme"; workspace: "w1"; vm: "dsl-main-ddb30a57cc"; checkouts: [] },
                  { domain: "acme"; workspace: "w2"; vm: "dsl-main-41eb634ef1"; checkouts: [] },
                ];
              },
            ];
          },
        ]
      >,
      Invoke<
        typeof vmAnswers,
        [
          answers: {
            list: [
              { name: "dsl-main-ddb30a57cc"; status: "running"; labels: {} },
              { name: "dsl-main-41eb634ef1"; status: "running"; labels: {} },
            ];
            exec: {
              code: 0;
              stdout: '[{"name":"agent","state":"running","command":["claude","-p","fix \\u001b[2J the docs"],"started":"2026-11-16T10:00:00Z","lastOutput":"yesterday","exit":null},{"name":"Evil\\u001b]0;x","state":"running","command":[]},{"name":"ok","state":"pwned","command":[]}]';
            };
          },
        ]
      >,
      Invoke<typeof list, [only: undefined, out: typeof collect, json: true]>,
    ],
    [
      Expect<
        Invoke<typeof said>,
        "=",
        [
          '[{"name":"agent","state":"running","workspace":"acme/w1","command":["claude -p fix ?[2J the docs"],"started":"2026-11-16T10:00:00Z","lastOutput":null,"exit":null}]',
        ]
      >,
      /** (w2's record names beta/w1's VM: it is not asked) */
      Expect<
        Invoke<typeof rootAsked>,
        "matches",
        [{ op: "domain.list" }, { op: "exec"; args: { vm: "dsl-main-ddb30a57cc" } }]
      >,
    ]
  >;
}

/** `desolate agent stop`: Ctrl-C, as a person ends a program, and then whatever the person
 *  says. Nothing kills it on a clock (docs/v3/limits.md, question 2): on a terminal it says
 *  that it is waiting and asks whether to kill it, for as long as the person waits; a script
 *  is told whether it ended, and says `--kill` to end it at once. */
export const stop = async (
  where: string | undefined,
  options: { name?: string; kill?: boolean },
  out: Out,
) => {
  const w = await target(where);
  const name = nameOf(options.name);
  const at = `${w.domain}/${w.workspace}`;
  const again = `desolate agent stop ${at}${name === "agent" ? "" : ` --name ${name}`} --kill`;
  const said = (ran: { code: number; stdout: string; stderr: string }) => {
    if (ran.code !== 0) refuse(holderError(ran, name), `desolate agent list ${at}`);
    try {
      const answer = JSON.parse(ran.stdout.trim()) as { ended?: unknown; exit?: unknown };
      return {
        ended: answer.ended === true,
        exit: Number.isInteger(answer.exit) ? answer.exit : null,
      };
    } catch {
      return { ended: false, exit: null };
    }
  };
  const ended = (exit: unknown) =>
    out(`agent ${name} in ${at} has ended${exit === null ? "" : ` (exit ${exit})`}`);
  const kill = async () => {
    // A kill ends its process group at once; the holder answers when the agent's terminal
    // closes. (A holder from before kills 3 s after the Ctrl-C it is also sent.)
    const killed = said(
      await backend().exec(w.vm, [...HOLDER(), "stop", name, "--kill", "--wait"], {
        timeoutMs: 30_000,
        maxBytes: SAID_MOST,
      }),
    );
    if (!killed.ended)
      refuse(
        `agent ${name} in ${at} was killed, and its terminal is still open: something it started outside its process group holds it`,
        `desolate exec ${at} -- ps -ef`,
      );
    ended(killed.exit);
  };
  if (options.kill) return kill();
  if (!(process.stdin.isTTY && process.stderr.isTTY)) {
    const asked = said(
      await backend().exec(w.vm, [...HOLDER(), "stop", name], {
        timeoutMs: 30_000,
        maxBytes: SAID_MOST,
      }),
    );
    if (asked.ended) return ended(asked.exit);
    return out(
      `asked agent ${name} in ${at} to stop (Ctrl-C); it has not ended yet. To end it at once: ${again}`,
    );
  }
  // A person: the holder answers when the agent has ended, and meanwhile the person is asked.
  const waiting = backend().spawn(w.vm, [...HOLDER(), "stop", name, "--wait"]);
  const stdout = gather(waiting.stdout!);
  const stderr = gather(waiting.stderr!);
  const over = new Promise<{ code: number; stdout: string; stderr: string }>((resolve) =>
    waiting.on("close", (code) => resolve({ code: code ?? 1, stdout: stdout(), stderr: stderr() })),
  );
  out(`asked agent ${name} in ${at} to stop (Ctrl-C); waiting for it to end.`);
  const { createInterface } = await import("node:readline/promises");
  const asker = createInterface({ input: process.stdin, output: process.stderr });
  const asking = new AbortController();
  const answer = asker
    .question("Kill it now? [y/N] ", { signal: asking.signal })
    .then((text) => (/^\s*y(es)?\s*$/i.test(text) ? "kill" : "leave"))
    // Rejected only when aborted below, or when the person closed the prompt (Ctrl-C, Ctrl-D):
    // that is a no, not an end the VM may then be taken to say.
    .catch(() => (asking.signal.aborted ? ("ended" as const) : "leave"));
  const first = await Promise.race([over.then(() => "ended" as const), answer]);
  asking.abort();
  asker.close();
  process.stdin.pause();
  if (first === "ended") {
    process.stderr.write("\n");
    return ended(said(await over).exit);
  }
  // Let go of the waiting holder client at once, as attach does: it must not keep this
  // process, and the person's prompt, waiting.
  for (const stream of [waiting.stdin, waiting.stdout, waiting.stderr]) stream?.destroy();
  waiting.unref();
  waiting.kill();
  if (first === "kill") return kill();
  out(
    `not killed: it may still be ending (desolate agent list ${at}). To end it at once: ${again}`,
  );
};

/** `--since 10m` (s, m, h, d: that long before `now`) or a date and time, as unix seconds;
 *  null when it is neither. */
export const sinceOf = (text: string, now: number): number | null => {
  const ago = /^\s*(\d{1,9})\s*([smhd])\s*$/.exec(text);
  if (ago)
    return (
      Math.floor(now / 1000) - Number(ago[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[ago[2] as "s"]
    );
  const at = /^\d{4}-\d\d-\d\d/.test(text.trim()) ? Date.parse(text.trim()) : NaN;
  return Number.isNaN(at) ? null : Math.floor(at / 1000);
};

declare namespace sinceOf {
  export type Spellings = Table<
    typeof sinceOf,
    [
      /** a while ago */
      [args: [text: "10m", now: 1795280000000], expected: 1795279400],
      [args: [text: "2h", now: 1795280000000], expected: 1795272800],
      [args: [text: "1d", now: 1795280000000], expected: 1795193600],
      /** a date and time (UTC unless it says) */
      [args: [text: "2026-11-21T09:00:00Z", now: 1795280000000], expected: 1795251600],
      /** neither */
      [args: [text: "yesterday", now: 1795280000000], expected: null],
      [args: [text: "10", now: 1795280000000], expected: null],
    ]
  >;
}

/** `desolate agent log`: what it printed, from its log in the VM, streamed (not held here: a
 *  log may be gigabytes). To a terminal, its last page of lines unless asked for more; to a
 *  pipe or a file, all of it. Before the bytes, the holder sends one line of JSON saying what
 *  is kept and where this read starts: a cut is said (R1) from that. */
export const log = async (
  where: string | undefined,
  options: { name?: string; all?: boolean; lines?: string; since?: string },
) => {
  const usage = "--all, --lines <n> or --since <10m, 2h, 1d, or a date and time>";
  if (
    [options.all, options.lines, options.since].filter((o) => o !== undefined && o !== false)
      .length > 1
  )
    refuse("which part of the log?", `one of ${usage}`, EXIT.usage);
  let how: string[];
  if (options.lines !== undefined) {
    if (!/^\s*\d{1,9}\s*$/.test(options.lines) || Number(options.lines) < 1)
      refuse(
        `--lines '${printable(options.lines)}' is not a number of lines`,
        "--lines 200",
        EXIT.usage,
      );
    how = ["--lines", String(Number(options.lines))];
  } else if (options.since !== undefined) {
    const since = sinceOf(options.since, Date.now());
    if (since === null)
      refuse(
        `--since '${printable(options.since)}' is not a time`,
        "--since 10m, 2h, 1d, or 2026-11-21T09:00",
        EXIT.usage,
      );
    how = ["--since", String(Math.max(0, since!))];
  } else how = options.all || !process.stdout.isTTY ? ["--all"] : ["--lines", String(PAGE)];
  const w = await target(where);
  const name = nameOf(options.name);
  const at = `${w.domain}/${w.workspace}${name === "agent" ? "" : ` --name ${name}`}`;
  const reading = backend().spawn(w.vm, [...HOLDER(), "log", name, ...how]);
  // To a terminal, what a screen needs and no more; to a pipe or file, as it was.
  const filter = process.stdout.isTTY ? terminalFilter() : (bytes: Buffer) => bytes;
  let head: Buffer | null = Buffer.alloc(0);
  const stderr = gather(reading.stderr!);
  let unlike = false;
  reading.stdout!.on("data", (chunk: Buffer) => {
    if (unlike) return;
    if (head === null) {
      if (!process.stdout.write(filter(chunk))) {
        reading.stdout!.pause();
        process.stdout.once("drain", () => reading.stdout!.resume());
      }
      return;
    }
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf(0x0a);
    // The holder's first line is a hundred bytes of JSON; one that does not end is not one.
    if (end < 0 && head.length > 64 * 1024) {
      unlike = true;
      reading.kill();
      return;
    }
    if (end < 0) return;
    const rest = head.subarray(end + 1);
    process.stdout.write(filter(Buffer.from(marks(head.subarray(0, end).toString("utf8"), at))));
    head = null;
    if (rest.length) process.stdout.write(filter(rest));
  });
  const code = await new Promise<number>((resolve) => reading.on("close", (c) => resolve(c ?? 1)));
  if (unlike)
    refuse(
      "the VM's agent holder did not answer as one: nothing of its log was shown",
      `desolate exec ${w.domain}/${w.workspace} --vm -- ls -l .desolate-agents`,
    );
  if (code !== 0 && head !== null)
    refuse(
      holderError({ stdout: "", stderr: stderr() }, name),
      `desolate agent list ${w.domain}/${w.workspace}`,
    );
};

/** What is said of a read of the log, from the holder's first line: on stderr, how much came
 *  before what is shown; in the log itself, where older output was dropped. Answers what goes
 *  before the log's bytes. */
const marks = (meta: string, at: string): string => {
  let m: { first?: unknown; before?: unknown; most?: unknown } = {};
  try {
    m = JSON.parse(meta);
  } catch {
    /* said nothing: nothing to say */
  }
  const n = (v: unknown) => (Number.isSafeInteger(v) && (v as number) > 0 ? (v as number) : 0);
  if (n(m.before))
    process.stderr.write(
      `desolate: ${formatBytes(n(m.before))} of earlier output is not shown (all of it: desolate agent log ${at} --all)\n`,
    );
  else if (n(m.first))
    return `[desolate: ${formatBytes(n(m.first))} of older output was dropped here: the log keeps the newest${n(m.most) ? ` ${formatBytes(n(m.most))}` : ""} (the setting agent.logMiB)]\r\n`;
  return "";
};

/** Your terminal, attached: raw, its size passed on, Ctrl-] to let go. */
export const attach = async (
  where: string | undefined,
  options: { name?: string },
): Promise<number> => {
  const w = await target(where);
  const name = nameOf(options.name);
  if (!process.stdin.isTTY)
    refuse(
      "attach needs a terminal",
      "run it in your terminal; for a script: desolate agent log",
      EXIT.usage,
    );
  const child = backend().spawn(w.vm, [...HOLDER(), "attach", name]);
  const send = (line: string) => child.stdin!.write(`${line}\n`);
  const size = () => send(`r ${process.stdout.columns || 120} ${process.stdout.rows || 40}`);
  process.stderr.write(
    `desolate: attached to ${name} in ${w.domain}/${w.workspace}. Ctrl-] detaches; it keeps running.\r\n`,
  );
  process.stdin.setRawMode(true);
  process.stdin.resume();
  size();
  process.stdout.on("resize", size);
  // What the agent prints, kept to what a screen needs (shared/terminal-filter.ts): your
  // terminal emulator is outside every boundary. (It knows what the reset owes, too.)
  const filter = terminalFilter();
  const done = new Promise<number>((resolve) => {
    let over = false;
    const finish = (code: number) => {
      if (over) return;
      over = true;
      process.stdin.removeAllListeners("data");
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.off("resize", size);
      // Let go of the holder's client at once: its pipes, and the process (the backend's
      // shell may take its time to end, and must not keep this one, and your prompt, waiting).
      for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy();
      child.unref();
      child.kill();
      process.stdin.unref?.();
      // Whatever modes it left on (mouse reporting, the alternate screen, ...), off: the
      // terminal is your shell's again.
      process.stdout.write(filter.reset());
      process.stderr.write(
        `\r\ndesolate: detached from ${name}; it is still running (desolate agent list).\r\n`,
      );
      resolve(code);
    };
    process.stdin.on("data", (chunk: Buffer) => {
      const at = chunk.indexOf(DETACH);
      if (at >= 0) {
        if (at > 0) send(`i ${chunk.subarray(0, at).toString("base64")}`);
        return finish(0);
      }
      send(`i ${chunk.toString("base64")}`);
    });
    child.stdout!.on("data", (chunk: Buffer) => {
      // A terminal's writes wait; a slow pipe's would gather here, as fast as the VM sends.
      if (!process.stdout.write(filter(chunk))) {
        child.stdout!.pause();
        process.stdout.once("drain", () => child.stdout!.resume());
      }
    });
    child.on("close", () => finish(0));
  });
  return done;
};
