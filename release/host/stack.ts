// The stack as the host sees it: which backend, the root VM, and the CLI channel to it.
import { spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { Refusal, refuse } from "../shared/exit.ts";
import { readJson, writeJson } from "../shared/json.ts";
import { formatBytes } from "../shared/limits.ts";
import { rootVmName } from "../shared/names.ts";
import { RUN_MAX } from "../shared/run.ts";
import { define, valueOf, whole } from "../shared/settings.ts";
import { forTerminal } from "../shared/text.ts";
import { because } from "./failures.ts";
import { guest, INSTANCE, paths, RELEASE_DIR } from "./paths.ts";
import { fakeBackend } from "./vm/fake.ts";
import { limaBackend } from "./vm/lima.ts";
import type { Backend, VmSpec } from "./vm/types.ts";
import type { Expect, Given, Invoke } from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { emptyHome, writeState } from "../.harness/home.ts";
import type { setEnv } from "../.harness/env.ts";
import type { refusalOf } from "../.harness/refusal.ts";

export type ForgeConfig = {
  kind: "github" | "stand-in";
  ssh: { user: string; host: string; port: number };
  knownHosts: string;
};
export type Config = { backend: "fake" | "qemu" | "vz"; forge: ForgeConfig };

const CONFIG = path.join(paths.state, "config.json");
export const config = (): Config | null => readJson<Config | null>(CONFIG, null);
export const saveConfig = (value: Config) => writeJson(CONFIG, value);

export const defaultBackend = (): Config["backend"] =>
  process.platform === "darwin" ? "vz" : "qemu";

/** Which backend this invocation uses. `fake` is never remembered and never a default: it
 *  runs only when DESOLATE_BACKEND=fake is in the environment of this very command
 *  (section 13.2), so a stack cannot quietly be the unisolated kind. */
export const backendKind = (): Config["backend"] => {
  const env = process.env.DESOLATE_BACKEND;
  const stored = config()?.backend;
  if (env !== undefined && env !== "fake" && env !== "qemu" && env !== "vz")
    refuse(`DESOLATE_BACKEND is '${env}'`, "use fake, qemu or vz");
  if (stored === "fake" && env !== "fake")
    refuse(
      "this stack was bootstrapped on the fake backend, which gives no isolation and runs only when asked for by name",
      "set DESOLATE_BACKEND=fake for each command (tests only), or `desolate destroy --all` and bootstrap a real backend",
    );
  if (env === "fake" && stored && stored !== "fake")
    refuse(
      `DESOLATE_BACKEND=fake, but this stack was bootstrapped on ${stored}`,
      "unset DESOLATE_BACKEND",
    );
  return (env as Config["backend"] | undefined) ?? stored ?? defaultBackend();
};

declare namespace backendKind {
  /** what bootstrap recorded, when this command names none */
  export type Recorded = Given<
    [
      Invoke<typeof emptyHome>,
      Invoke<typeof writeState, [name: "config.json", text: '{"backend":"qemu"}']>,
      Invoke<typeof setEnv, [name: "DESOLATE_BACKEND", value: null]>,
    ],
    Expect<Invoke<typeof backendKind>, "=", "qemu">
  >;
  /** the fake backend (no isolation at all) only when this very command asks for it by name */
  export type FakeOnlyByName = [
    Given<
      [Invoke<typeof emptyHome>, Invoke<typeof setEnv, [name: "DESOLATE_BACKEND", value: "fake"]>],
      Expect<Invoke<typeof backendKind>, "=", "fake">
    >,
    Given<
      [
        Invoke<typeof emptyHome>,
        Invoke<typeof writeState, [name: "config.json", text: '{"backend":"fake"}']>,
        Invoke<typeof setEnv, [name: "DESOLATE_BACKEND", value: null]>,
      ],
      Expect<
        Invoke<typeof refusalOf, [run: typeof backendKind, args: []]>,
        "=",
        {
          message: "this stack was bootstrapped on the fake backend, which gives no isolation and runs only when asked for by name";
          fix: "set DESOLATE_BACKEND=fake for each command (tests only), or `desolate destroy --all` and bootstrap a real backend";
          code: 1;
        }
      >
    >,
  ];
  /** nor on a stack that was bootstrapped on a real one; and no backend it does not know */
  export type Refuses = [
    Given<
      [
        Invoke<typeof emptyHome>,
        Invoke<typeof writeState, [name: "config.json", text: '{"backend":"vz"}']>,
        Invoke<typeof setEnv, [name: "DESOLATE_BACKEND", value: "fake"]>,
      ],
      Expect<
        Invoke<typeof refusalOf, [run: typeof backendKind, args: []]>,
        "=",
        {
          message: "DESOLATE_BACKEND=fake, but this stack was bootstrapped on vz";
          fix: "unset DESOLATE_BACKEND";
          code: 1;
        }
      >
    >,
    Given<
      [
        Invoke<typeof emptyHome>,
        Invoke<typeof setEnv, [name: "DESOLATE_BACKEND", value: "docker"]>,
      ],
      Expect<
        Invoke<typeof refusalOf, [run: typeof backendKind, args: []]>,
        "=",
        { message: "DESOLATE_BACKEND is 'docker'"; fix: "use fake, qemu or vz"; code: 1 }
      >
    >,
  ];
}

let cached: Backend | null = null;
export const backend = (): Backend => {
  if (cached) return cached;
  const kind = backendKind();
  cached = kind === "fake" ? fakeBackend() : limaBackend(kind);
  return cached;
};

export const ROOT_VM = rootVmName(INSTANCE);

export const rootSpec = (): VmSpec => ({
  name: ROOT_VM,
  role: "root",
  egress: "open",
  shares: [
    { host: RELEASE_DIR, guest: guest.release, writable: false },
    { host: paths.mirrors, guest: guest.mirrors, writable: true },
    { host: paths.rootClones, guest: guest.rootClones, writable: true },
    // One share for every domain, so a new domain needs no restart of the root. The root
    // reads a domain's repos/ as data only and never runs git there (P4): that is enforced
    // by root/git.ts, not by this mount.
    { host: paths.domains, guest: guest.domains, writable: true },
  ],
  sockets: [],
  cpus: 2,
  memoryMiB: 2048,
  diskGiB: 30, // (the base's: a clone's disk cannot be smaller; 20 was never applied)
  labels: { title: "root" },
});

declare namespace rootSpec {
  /** the root reaches the network (it fetches and pushes); it reads desolate's code and cannot
   *  change it, and holds the mirrors, its clones and every domain's share */
  export type Shares = Expect<
    Invoke<typeof rootSpec>,
    "matches",
    {
      role: "root";
      egress: "open";
      sockets: [];
      shares: [
        { guest: "/desolate/release"; writable: false },
        { guest: "/desolate/mirrors"; writable: true },
        { guest: "/desolate/root"; writable: true },
        { guest: "/desolate/domains"; writable: true },
      ];
    }
  >;
}

const NODE = ["node", "--disable-warning=ExperimentalWarning"];

/** The CLI channel's service in the root (root/rootctl.ts serve): one request a connection. */
const ROOTCTL_SOCKET = "/run/desolate/rootctl/rootctl.sock";
type Reply<T> = { ok: boolean; result?: T; error?: string; fix?: string; code?: number };

// How long a call to the root may take is not decided here (docs/v3/limits.md, R4): a fetch
// of a large repository takes what it takes, and whoever asked for it is the one waiting,
// and can stop it. What is decided here is when the root has stopped answering: the root is
// a VM, which can freeze, lose its service or be stopped under a call, and then nothing
// would ever end the call. So the one timer on a call is a silence: nothing from the root,
// neither a line of progress nor the answer, for this long. A call that says what it is
// doing is never ended for how long it takes.

/** How long the root may say nothing to a call before the call is given up. The default is
 *  what every call was once allowed in all (fifteen minutes, by a timer that also ended a
 *  fetch still printing its progress): as a silence it ends no call the old timer let
 *  finish. It is a setting because the operations that say nothing while they work (a
 *  review of a large push, an import) take as long as this Mac and its disk make them. */
export const ROOT_SILENT_SECONDS = define({
  name: "root.silentSeconds",
  env: "DESOLATE_ROOT_SILENT_SECONDS",
  side: "host",
  default: 900,
  parse: whole(1, 24 * 60 * 60),
  why: "How long a call to the root VM may hear nothing from it (no progress, no answer) before it is given up: more on a Mac where the root's silent work (reviewing a large push) is slow.",
});

/** The calls that are not waited on in that way, by operation: each is answered by the root
 *  at once from what it already holds (no forge, no repository walked), and is made where
 *  nobody is watching it (the daemon's own looks at the root, every few seconds) or to learn
 *  whether the root answers at all (bootstrap's and doctor's probes). For these, no answer
 *  within this long is the answer "the root is not answering": the daemon looks again, a
 *  probe reports it. It is a total, not a silence: the other end of the call is the root's
 *  ordinary user, which is not trusted, and a byte now and then would keep a silence timer
 *  from ever firing, on a call no person is there to stop. Milliseconds. Thirty seconds is a
 *  root that is up and busy many times over (measured on the M1: 100 ms a call to the
 *  service, 240 ms the old way); the three at sixty do more than read: */
export const BRIEF = {
  /** is the root there, and its keyring up */
  ping: 30_000,
  /** the root's own checks: a dozen probes of its sockets, files and users, each bounded */
  doctor: 60_000,
  "approvals.pending": 30_000,
  "approvals.refuse": 30_000,
  /** hands a signed approval to the keyring's gate, which checks it before it answers */
  "approvals.answer": 60_000,
  "issue.list": 30_000,
  "issue.done": 30_000,
  "domain.list": 30_000,
  /** starts a domain's two proxies and waits for their sockets */
  "proxy.start": 60_000,
} as const;

/** A time, as a person says it: "30 seconds", "15 minutes". */
const span = (ms: number) =>
  ms < 120_000 || ms % 60_000 !== 0 ? `${Math.round(ms / 1000)} seconds` : `${ms / 60_000} minutes`;

type Asked = {
  quiet?: boolean;
  /** Ended after this long with nothing heard: a whole line of the root's. */
  silenceMs: number;
  /** Ended after this long in all, for a call nobody watches. */
  totalMs?: number;
  signal?: AbortSignal;
};
/** Why a call was ended from this side. */
type Stopped = "silent" | "late" | "cancelled" | "flood";

/** Ends `child` when no whole line has been heard from it for `silenceMs`, when `totalMs` is
 *  over, when `signal` fires (whoever asked went away), or when a line of it grows past what
 *  `run` would keep; and says so to `stopped` at once, so the call ends then, whatever the
 *  ended program leaves behind. (On Lima the program is limactl, which runs ssh: killed
 *  alone, it leaves that ssh holding the pipes, and a call that waited for them to close
 *  would wait for as long as a frozen root does. So what it started is killed with it, as
 *  its children: a process group of its own would also keep the terminal's Ctrl-C from it.) */
const patience = (child: ChildProcess, asked: Asked, stopped: (why: Stopped) => void) => {
  let why: Stopped | null = null;
  const stop = (reason: Stopped) => {
    if (why) return;
    why = reason;
    over();
    if (child.pid) spawnSync("pkill", ["-KILL", "-P", String(child.pid)], { stdio: "ignore" });
    child.kill("SIGKILL");
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
    stopped(reason);
  };
  const silence = setTimeout(() => stop("silent"), asked.silenceMs);
  const total =
    asked.totalMs === undefined ? undefined : setTimeout(() => stop("late"), asked.totalMs);
  const cancel = () => stop("cancelled");
  const over = () => {
    clearTimeout(silence);
    clearTimeout(total);
    asked.signal?.removeEventListener("abort", cancel);
  };
  asked.signal?.addEventListener("abort", cancel, { once: true });
  if (asked.signal?.aborted) cancel();
  return {
    heard: () => void silence.refresh(),
    flood: () => stop("flood"),
    why: () => why,
    over,
  };
};

/** The refusal of a call this side ended. It may have run: what was asked for is the root's
 *  to finish or not, and nothing here can say which. */
const gaveUp = (op: string, why: Stopped, asked: Asked): Refusal =>
  why === "cancelled"
    ? new Refusal(
        `'${op}' was stopped: whoever asked the root for it went away. It may have run`,
        "look before asking again",
      )
    : why === "flood"
      ? new Refusal(
          `the root's answer to '${op}' was stopped: it is over the ${formatBytes(RUN_MAX)} this side keeps of one answer`,
          "desolate doctor",
        )
      : why === "late"
        ? new Refusal(
            `the root did not answer '${op}' within ${span(asked.totalMs!)}: the call was given up. It may have run`,
            "desolate doctor; then look before asking again",
          )
        : new Refusal(
            `the root said nothing for ${span(asked.silenceMs)} while asked '${op}': the call was given up. '${op}' may have run, or be running still`,
            `desolate doctor; then look before asking again. (How long the root may be silent is the setting ${ROOT_SILENT_SECONDS.name}: ${ROOT_SILENT_SECONDS.env}=<seconds>)`,
          );

/** Progress from the root, shown to the person as it comes: text another wrote, made safe. */
const show = (line: string) => process.stderr.write(`${forTerminal(line)}\n`);

/** The request, over the service: its progress shown as it comes, its answer; null when the
 *  service is not there or its code is stale (the caller then asks the old way); or why
 *  this side ended the call.
 *
 *  A request is one line, and the service answers when it has read it: the request is not
 *  ended with an end of input. (It was, and socat then needed `-t 86400`, a day standing for
 *  "no limit" on how long it would still wait for the answer.) socat stays for as long as
 *  both sides do, and its input is closed once the answer has come. */
const viaService = <T>(
  op: string,
  args: Record<string, unknown>,
  asked: Asked,
): Promise<Reply<T> | Stopped | null> =>
  new Promise((resolve) => {
    const child = backend().spawn(ROOT_VM, ["socat", "-", `UNIX-CONNECT:${ROOTCTL_SOCKET}`]);
    let buffer = "";
    let accepted = false;
    let settled = false;
    // (Defined before `waiting`: a signal that has already fired settles while it is made.)
    let waiting: ReturnType<typeof patience> | undefined;
    const settle = (answer: Reply<T> | Stopped | null) => {
      if (settled) return;
      settled = true;
      waiting?.over();
      if (!child.stdin!.destroyed) child.stdin!.end();
      resolve(answer);
    };
    waiting = patience(child, asked, settle);
    // Taken and not answered: the operation may have run. Said, never asked again.
    const ended = () =>
      settle(
        waiting!.why() ??
          (accepted
            ? {
                ok: false,
                error: `the root took '${op}' and its answer was lost: it may have run`,
                fix: "desolate doctor; then look before asking again",
                code: 1,
              }
            : null),
      );
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const message = JSON.parse(line) as {
            accepted?: boolean;
            progress?: unknown;
            reply?: Reply<T>;
            stale?: boolean;
          };
          waiting!.heard();
          if (message.accepted) accepted = true;
          if (typeof message.progress === "string" && !asked.quiet) show(message.progress);
          if (message.reply) settle(message.reply);
          else if (message.stale && !accepted) settle(null);
        } catch {
          /* not a line of the service's */
        }
      }
      // (In UTF-16 units: at least that many bytes.)
      if (buffer.length > RUN_MAX) waiting!.flood();
    });
    child.stderr!.on("data", () => {});
    child.stdin!.on("error", () => {});
    child.on("error", ended);
    child.on("close", ended);
    child.stdin!.write(JSON.stringify({ op, args }) + "\n");
  });

/** The request, the old way: rootctl.ts run once in the root, the request its input, its
 *  progress on its stderr and its answer the last line it prints. */
const viaExec = <T>(op: string, args: Record<string, unknown>, asked: Asked): Promise<Reply<T>> =>
  new Promise((resolve, reject) => {
    const child = backend().spawn(ROOT_VM, [...NODE, `${guest.release}/root/rootctl.ts`]);
    let stdout = "";
    let stderr = "";
    let shown = 0;
    let settled = false;
    const waiting = patience(child, asked, (why) => {
      if (settled) return;
      settled = true;
      reject(gaveUp(op, why, asked));
    });
    const hear = (chunk: string) => {
      if (chunk.includes("\n")) waiting.heard();
      if (stdout.length + stderr.length + chunk.length > RUN_MAX) waiting.flood();
    };
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      hear(chunk);
      stdout += chunk;
    });
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      hear(chunk);
      stderr += chunk;
      if (asked.quiet) return;
      for (let end = stderr.indexOf("\n", shown); end >= 0; end = stderr.indexOf("\n", shown)) {
        show(stderr.slice(shown, end));
        shown = end + 1;
      }
    });
    child.stdin!.on("error", () => {});
    const ended = (code: number, said: string) => {
      if (settled) return;
      settled = true;
      waiting.over();
      if (!asked.quiet && shown < stderr.length) show(stderr.slice(shown));
      shown = stderr.length;
      try {
        resolve(JSON.parse(stdout.trim().split("\n").pop() ?? "") as Reply<T>);
      } catch {
        reject(
          new Refusal(
            because(`the root did not answer '${op}' (exit ${code})`, "rootctl", said),
            "desolate doctor",
          ),
        );
      }
    };
    child.on("error", (error) => ended(127, error.message));
    child.on("close", (code, killed) => ended(code ?? (killed ? 128 : 1), stderr || stdout));
    child.stdin!.end(JSON.stringify({ op, args }));
  });

const ask = async <T>(op: string, args: Record<string, unknown>, asked: Asked): Promise<T> => {
  const served =
    process.env.DESOLATE_ROOTCTL === "exec" ? null : await viaService<T>(op, args, asked);
  if (typeof served === "string") throw gaveUp(op, served, asked);
  const reply = served ?? (await viaExec<T>(op, args, asked));
  if (!reply.ok)
    throw new Refusal(reply.error ?? "the root refused", reply.fix ?? "", reply.code ?? 1);
  return reply.result as T;
};

/** One request over the CLI channel. The root's refusals arrive as Refusals, with their fix.
 *  Asked of the root's CLI service when it is up (a fraction of the time), else by running
 *  rootctl.ts once (a fresh stack, a service restarting on new code).
 *
 *  It is waited on for as long as the root keeps saying something, and for
 *  ROOT_SILENT_SECONDS of nothing; `signal` ends it when whoever asked goes away.
 *  `timeoutMs` is for callers not yet moved (host/daemon.ts, host/git-vm.ts): a total, as it
 *  always was. A brief call names no number: `rootctlBrief`. */
export const rootctl = <T = unknown>(
  op: string,
  args: Record<string, unknown> = {},
  options: { quiet?: boolean; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> =>
  ask<T>(op, args, {
    quiet: options.quiet,
    signal: options.signal,
    silenceMs: valueOf(ROOT_SILENT_SECONDS) * 1000,
    totalMs: options.timeoutMs,
  });

/** A brief call (BRIEF, above, says which operations and why): nothing of its progress is
 *  shown, and the root not answering it for its time is an answer. */
export const rootctlBrief = <T = unknown>(
  op: keyof typeof BRIEF,
  args: Record<string, unknown> = {},
  options: { signal?: AbortSignal } = {},
): Promise<T> =>
  ask<T>(op, args, {
    quiet: true,
    signal: options.signal,
    silenceMs: BRIEF[op],
    totalMs: BRIEF[op],
  });

export const ensureHome = () => {
  for (const dir of [
    paths.home,
    paths.mirrors,
    paths.rootClones,
    paths.domains,
    paths.state,
    paths.run,
    paths.logs,
  ])
    fs.mkdirSync(dir, { recursive: true });
  // The home holds every repository's history and every domain's work: the user's alone.
  fs.chmodSync(paths.home, 0o700);
};

const proxyUsers = new Set<string>();
/** Have root make a domain's proxies' user and its two directories, if it has not (root/
 *  proxy-user.sh). Before anything starts the domain's proxies or writes its secrets. Root
 *  is asked through the host's own way in (never the root's ordinary user, which may run
 *  programs as these users and must not make them). */
export const ensureProxyUser = async (domain: string) => {
  if (proxyUsers.has(domain)) return;
  const result = await backend().exec(
    ROOT_VM,
    ["bash", `${guest.release}/root/proxy-user.sh`, String(process.getuid!()), domain],
    { root: true, timeoutMs: 60_000 },
  );
  if (result.code !== 0)
    refuse(
      because(
        `the domain ${domain}'s proxies' user could not be made`,
        "proxy-user",
        result.stderr || result.stdout,
      ),
      "desolate doctor",
    );
  proxyUsers.add(domain);
};

/** The forge's address and host key, for the pusher: written by root in root's own
 *  directory (root/forge-pin.ts), through the host's own way in, never through the root's
 *  ordinary user (which could rewrite its own copy, and so aim a push elsewhere). */
export const pinForge = async (forge: unknown) => {
  const result = await backend().exec(ROOT_VM, [...NODE, `${guest.release}/root/forge-pin.ts`], {
    root: true,
    input: JSON.stringify(forge),
    timeoutMs: 60_000,
  });
  if (result.code !== 0)
    refuse(
      because(
        "the root could not pin the forge's address",
        "forge-pin",
        result.stdout || result.stderr,
      ),
      "desolate doctor",
    );
};

/** Change a domain's secrets: as root in the root VM, through the host's own way in, with
 *  the request (a value among it) on stdin (root/proxy/secret-store.ts). Then the root's
 *  user, which never sees a value, starts or stops the domain's secrets proxy and tells its
 *  workspaces the names. Returns the names, hosts and switches. */
/** One secret's value, from the root's store, for the person on the Mac (secret show). */
export const revealSecret = async (domain: string, name: string): Promise<string> => {
  const result = await backend().exec(
    ROOT_VM,
    [...NODE, `${guest.release}/root/proxy/secret-store.ts`, domain, "reveal"],
    { root: true, input: JSON.stringify({ name }), timeoutMs: 60_000 },
  );
  let reply: { ok: boolean; value?: string; error?: string; fix?: string };
  try {
    reply = JSON.parse(result.stdout.trim().split("\n").pop() ?? "");
  } catch {
    // Its stderr alone: what it printed on stdout may be the value, or part of it. And not
    // kept in a file (failures.ts): a secret is held by the root, and by no file on the Mac.
    throw new Refusal(
      because(
        `the root did not read ${domain}'s secret (exit ${result.code})`,
        null,
        result.stderr,
      ),
      "desolate doctor",
    );
  }
  if (!reply.ok || typeof reply.value !== "string")
    throw new Refusal(reply.error ?? "the root refused", reply.fix ?? "");
  return reply.value;
};

export const changeSecrets = async <T>(
  domain: string,
  op: "set" | "switch" | "remove" | "copy",
  input: Record<string, unknown>,
): Promise<T> => {
  await ensureProxyUser(domain);
  const result = await backend().exec(
    ROOT_VM,
    [...NODE, `${guest.release}/root/proxy/secret-store.ts`, domain, op],
    { root: true, input: JSON.stringify(input), timeoutMs: 60_000 },
  );
  let reply: { ok: boolean; error?: string; fix?: string };
  try {
    reply = JSON.parse(result.stdout.trim().split("\n").pop() ?? "");
  } catch {
    throw new Refusal(
      because(
        `the root did not change ${domain}'s secrets (exit ${result.code})`,
        null,
        result.stderr,
      ),
      "desolate doctor",
    );
  }
  if (!reply.ok) throw new Refusal(reply.error ?? "the root refused", reply.fix ?? "");
  return rootctl<T>("secret.apply", { domain }, { quiet: true });
};
