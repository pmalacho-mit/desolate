// Harness for in-source tests of the Lima backend (host/vm/lima.ts): what it hands Lima, read
// without a hypervisor. It stands in for `limactl`: a script of its own, first on PATH for the
// one test, that writes down every call and does nothing else, so what the backend generates
// (a clone's settings, the base VM's configuration, a confined VM's sandbox profile) can be
// read back. No VM is made, and Lima's own home is never touched.
//
// Paths in a spec may start with `<home>`, the test file's own desolate home (a clone makes
// each share's directory on the host); in what comes back, the home, the release folder,
// the architecture and the ports the backend picked are written as `<home>`, `<release>`,
// `<arch>`, `<ssh port>` and `<link port>`, which differ from machine to machine.
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { onTestFinished } from "./vitest.ts";
import type { Backend, VmSpec } from "../host/vm/types.ts";

const home = () => process.env.DESOLATE_HOME!;
const limaHome = () => path.join(home(), "lima");
const bin = () => path.join(home(), "nests-bin");
const log = () => path.join(bin(), "calls");
const release = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "release");
const arch = os.arch() === "arm64" ? "aarch64" : "x86_64";

/** limactl, for this test: every call written down, each argument a line, and done. And a
 *  VM's ssh, which answers what `start` waits on, the guest's /proc/mounts, with what
 *  `confinement` wrote (if anything), and says nothing to anything else. */
const fakeLimactl = () => {
  if (process.env.DESOLATE_LIMACTL)
    throw new Error("DESOLATE_LIMACTL is set: the backend would run it, not the stand-in");
  fs.mkdirSync(bin(), { recursive: true });
  fs.writeFileSync(
    path.join(bin(), "limactl"),
    `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done >>'${log()}'\nprintf '%s\\n' '--end--' >>'${log()}'\nexit 0\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin(), "ssh"),
    `#!/bin/sh\ncase "$*" in *cat*/proc/mounts*) cat '${path.join(bin(), "mounts")}' 2>/dev/null ;; esac\nexit 0\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(log(), "");
  const before = process.env.PATH;
  process.env.PATH = `${bin()}:${before}`;
  onTestFinished(() => {
    process.env.PATH = before;
  });
};
const calls = (): string[][] =>
  fs
    .readFileSync(log(), "utf8")
    .split("--end--\n")
    .filter(Boolean)
    .map((call) => call.replace(/\n$/, "").split("\n"));

const inHome = (spec: VmSpec): VmSpec => {
  const at = (p: string) => p.replace(/^<home>/, home());
  return {
    ...spec,
    shares: spec.shares.map((s) => ({ ...s, host: at(s.host) })),
    sockets: spec.sockets.map((s) => ({ ...s, host: at(s.host) })),
  };
};
const meta = (name: string) =>
  JSON.parse(fs.readFileSync(path.join(limaHome(), name, "desolate.json"), "utf8")) as {
    sshPort: number;
    linkPort: number;
  };
const shown = (text: string, ports?: { sshPort: number; linkPort: number }) => {
  let out = text
    // (A temporary home is often reached through a link, /var to /private/var: a sandbox
    // profile names it as it really is.)
    .split(fs.realpathSync.native(home()))
    .join("<home>")
    .split(home())
    .join("<home>")
    .split(release)
    .join("<release>")
    .split(arch)
    .join("<arch>");
  if (ports)
    out = out
      .split(String(ports.sshPort))
      .join("<ssh port>")
      .split(String(ports.linkPort))
      .join("<link port>");
  return out;
};

/** What `create` asks of Lima: its one call (`limactl clone`), argument by argument. */
export const cloneCall = async (backend: Backend, spec: VmSpec): Promise<string[]> => {
  fakeLimactl();
  await backend.create(inHome(spec));
  const m = meta(spec.name);
  return (
    calls()
      .map((call) => call.map((arg) => shown(arg, m)))
      .find((call) => call.includes("clone")) ?? []
  );
};

/** The base VM's configuration, as `ensureImage` writes it for Lima. */
export const baseYaml = async (backend: Backend): Promise<string> => {
  fakeLimactl();
  // (The stand-in makes no VM, so a vz base's stamp has no directory to go in: that is where
  // it stops, after the configuration is written.)
  await backend.ensureImage(() => {}).catch(() => {});
  return shown(fs.readFileSync(path.join(limaHome(), "base.yaml"), "utf8"));
};

/** The sandbox profile a vz VM is started under (its host process keeps it for
 *  life). On a machine without sandbox-exec the start fails after the profile is written. */
export const confinement = async (backend: Backend, spec: VmSpec): Promise<string> => {
  fakeLimactl();
  // The guest, once "started", has its shares mounted as the spec says.
  fs.writeFileSync(
    path.join(bin(), "mounts"),
    spec.shares.map((s) => `m ${s.guest} virtiofs ${s.writable ? "rw" : "ro"} 0 0\n`).join(""),
  );
  await backend.create(inHome(spec));
  await backend.start(spec.name).catch(() => {});
  return shown(
    fs.readFileSync(path.join(limaHome(), spec.name, "confine.sb"), "utf8"),
    meta(spec.name),
  );
};

/** A VM an older desolate made: its record has no link token. */
export const madeWithoutLinkToken = (name: string) => {
  fs.mkdirSync(path.join(limaHome(), name), { recursive: true });
  fs.writeFileSync(
    path.join(limaHome(), name, "desolate.json"),
    JSON.stringify({
      spec: { name, role: "workspace", egress: "none", shares: [], sockets: [], labels: {} },
      sshPort: 60022,
      linkPort: 60023,
    }),
  );
};

/** A pid that names no process: a child's, once it has exited (checked, in case another
 *  process took the number at once). */
const gonePid = (): number => {
  for (let tries = 0; tries < 5; tries++) {
    const { pid } = spawnSync(process.execPath, ["-e", ""]);
    try {
      process.kill(pid!, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return pid!;
    }
  }
  throw new Error("no pid could be found that names no process");
};

/** What `info` says of a VM whose folder in Lima's home holds exactly `files` (`<self>` in
 *  one stands for this process's pid, `<gone>` for an exited child's), with each file dated
 *  2000 if `written` says so. An `ha.sock` so written is a unix socket: `<listening>` one this
 *  process accepts on, `<unread>` one that accepts and never reads, `<closed>` one whose
 *  listener has gone, its file left behind (as a host agent killed outright leaves it).
 *  limactl is the stand-in throughout, and if anything started it (`first: "stop"` does, as a
 *  control) this throws, naming the call. */
export const statusOf = async (
  backend: Backend,
  files: Record<string, string>,
  written?: "before this boot",
  first?: "stop",
): Promise<string> => {
  const name = `dsl-main-status`;
  const dir = path.join(limaHome(), name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const gone = String(gonePid());
  const servers: net.Server[] = [];
  const accepted: net.Socket[] = [];
  for (const [file, text] of Object.entries(files)) {
    const at = path.join(dir, file);
    if (file === "ha.sock" && ["<listening>", "<unread>", "<closed>"].includes(text)) {
      const server = net.createServer(
        { pauseOnConnect: text === "<unread>" },
        (connection) => void accepted.push(connection),
      );
      await new Promise<void>((resolve) => server.listen(at, resolve));
      if (text !== "<closed>") servers.push(server);
      else {
        // (node removes a socket's file when its server closes: kept aside meanwhile.)
        fs.renameSync(at, `${at}.kept`);
        await new Promise((resolve) => server.close(resolve));
        fs.renameSync(`${at}.kept`, at);
      }
      continue;
    }
    fs.writeFileSync(at, text.split("<self>").join(String(process.pid)).split("<gone>").join(gone));
    if (written) fs.utimesSync(at, new Date(2000, 0, 1), new Date(2000, 0, 1));
  }
  try {
    fakeLimactl();
    if (first) await backend[first](name);
    const { status } = await backend.info(name);
    const started = calls();
    if (started.length > 0) throw new Error(`limactl was started: ${started[0]!.join(" ")}`);
    return status;
  } finally {
    for (const connection of accepted) connection.destroy();
    for (const server of servers) server.close();
  }
};

/** One session through the backend (`call`) into a VM of the test's Lima home, with `ssh` a
 *  stand-in that writes down its arguments and, as a VM's sshd would, hands the command line
 *  it was given (its last argument) to a shell: here, this machine's /bin/sh, so the test sees
 *  what the line runs. The login shell it names is a stand-in too, which insists on `-l` and
 *  is /bin/sh, and so is `sudo`, which runs what it is given: nothing of this machine's own is
 *  asked, and nothing runs as anyone else. `dial`'s line (socat) is written down, not run.
 *
 *  The VM (`vm`) is `running` (its processes this one, its host agent's socket listening,
 *  Lima's ssh.config there), `no ssh.config`, or `stopped` (made, never started); desolate's
 *  record says what it is: a name ending `-root` the root VM, any other acme/w1. In `argv`
 *  and `options`, `<home>` is the test's home (a cwd under it is made) and `<100k>` an
 *  argument of 100 KiB; both are written so in what comes back. `terminal`: a person at a
 *  terminal both ways, for `attach`; `apart`: the line is written down and not run (`alone`
 *  runs it). Throws if limactl was started. */
export const sessionOf = async (
  backend: Backend,
  call: "exec" | "spawn" | "attach" | "dial",
  name: string,
  argv: string[],
  options: Record<string, unknown> = {},
  vm: "running" | "stopped" | "no ssh.config" = "running",
): Promise<{ ssh: string[][]; said: string[]; code: number; stderr: string }> => {
  const big = "x".repeat(100 * 1024);
  const at = (text: string) => text.split("<home>").join(home()).split("<100k>").join(big);
  const back = (text: string) => shown(text).split(big).join("<100k>");
  const dir = path.join(limaHome(), name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "lima.yaml"), "");
  const root = name.endsWith("-root");
  fs.writeFileSync(
    path.join(dir, "desolate.json"),
    JSON.stringify({
      spec: {
        name,
        role: root ? "root" : "workspace",
        labels: root ? {} : { title: "acme/w1", domain: "acme", workspace: "w1" },
        shares: [],
        sockets: [],
      },
    }),
  );
  const servers: net.Server[] = [];
  if (vm !== "stopped") {
    for (const file of ["ha.pid", "vz.pid"])
      fs.writeFileSync(path.join(dir, file), `${process.pid}\n`);
    const server = net.createServer((connection) => void connection.destroy());
    await new Promise<void>((resolve) => server.listen(path.join(dir, "ha.sock"), resolve));
    servers.push(server);
    if (vm === "running") fs.writeFileSync(path.join(dir, "ssh.config"), `Host lima-${name}\n`);
  }
  const { terminal, apart, ...rest } = options;
  const given = JSON.parse(at(JSON.stringify(rest))) as Record<string, unknown>;
  if (typeof given.cwd === "string" && given.cwd.startsWith(home()))
    fs.mkdirSync(given.cwd, { recursive: true });

  fakeLimactl();
  const record = path.join(bin(), "ssh-calls");
  fs.rmSync(record, { recursive: true, force: true });
  fs.mkdirSync(record);
  const script = (file: string, text: string) =>
    fs.writeFileSync(path.join(bin(), file), `#!/bin/sh\n${text}`, { mode: 0o755 });
  script(
    "ssh",
    `n=$(ls '${record}' | wc -l | tr -d ' ')\nfor a in "$@"; do printf '%s\\0' "$a"; done >'${record}'/$n\nfor last in "$@"; do :; done\n${call === "dial" || apart ? "exit 0" : `SHELL='${bin()}/login-shell' exec /bin/sh -c "$last"`}\n`,
  );
  script(
    "login-shell",
    '[ "$1" = -l ] || { echo "not a login shell" >&2; exit 99; }\nshift\nexec /bin/sh "$@"\n',
  );
  script("sudo", 'exec "$@"\n');

  const tty = [process.stdin.isTTY, process.stdout.isTTY];
  const written = process.stderr.write;
  let stderr = "";
  let stdout = "";
  let code = 0;
  try {
    if (call === "exec") {
      const result = await backend.exec(name, argv.map(at), given);
      ({ code, stdout, stderr } = result);
    } else if (call === "spawn") {
      const child = backend.spawn(name, argv.map(at), given);
      child.stdin!.end();
      child.stdout!.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
      child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
      code = await new Promise<number>((resolve) => child.on("close", (c) => resolve(c ?? 1)));
    } else if (call === "attach") {
      if (terminal)
        (Object.assign(process.stdin, { isTTY: true }),
          Object.assign(process.stdout, { isTTY: true }));
      process.stderr.write = ((chunk: string | Buffer) => (
        (stderr += String(chunk)),
        true
      )) as typeof written;
      code = await backend.attach(name, argv.map(at), given);
    } else {
      const stream = backend.dial(name, Number(argv[0]));
      await new Promise((resolve) => stream.once("close", resolve).resume().end());
    }
  } finally {
    process.stderr.write = written;
    Object.assign(process.stdin, { isTTY: tty[0] });
    Object.assign(process.stdout, { isTTY: tty[1] });
    for (const server of servers) server.close();
  }
  if (calls().length > 0) throw new Error(`limactl was started: ${calls()[0]!.join(" ")}`);
  const ssh = fs
    .readdirSync(record)
    .sort((x, y) => Number(x) - Number(y))
    .map((file) =>
      fs.readFileSync(path.join(record, file), "utf8").split("\0").slice(0, -1).map(back),
    );
  const said = stdout === "" ? [] : stdout.split("\0").map(back);
  if (said.at(-1) === "") said.pop();
  return { ssh, said, code, stderr: back(stderr) };
};

/** What exec's line does in a VM on its own, once this side has let go of it (as when the Mac
 *  gives up on a call and ends its ssh: the program in the VM runs on): the line exec built
 *  for a running workspace VM, run in this machine's /bin/sh with exec's `input` and nothing
 *  to end it from outside, under the same stand-ins as `sessionOf`'s, and this machine's own
 *  `timeout`. `<pid>` in `argv` is a file the command may write its pid to: `left` is whether
 *  that process still runs once the line has ended (and it is ended then). */
export const alone = async (
  backend: Backend,
  argv: string[],
  options: Record<string, unknown> = {},
): Promise<{ code: number; said: string[]; left: boolean }> => {
  const pid = path.join(home(), "alone.pid");
  fs.rmSync(pid, { force: true });
  const given = argv.map((arg) => arg.split("<pid>").join(pid));
  await sessionOf(backend, "exec", "dsl-main-w1", given, { ...options, apart: true });
  const record = path.join(bin(), "ssh-calls");
  const line = fs.readFileSync(path.join(record, "0"), "utf8").split("\0").slice(0, -1).at(-1)!;
  const ran = spawnSync("/bin/sh", ["-c", line], {
    input: typeof options.input === "string" ? options.input : "",
    env: { ...process.env, SHELL: path.join(bin(), "login-shell") },
    encoding: "utf8",
    timeout: 30_000,
  });
  let left = false;
  if (fs.existsSync(pid)) {
    const number = Number(fs.readFileSync(pid, "utf8").trim());
    try {
      process.kill(number, 0);
      left = true;
      process.kill(number, "SIGKILL");
    } catch {
      /* gone */
    }
  }
  const said = ran.stdout === "" ? [] : ran.stdout.split("\0");
  if (said.at(-1) === "") said.pop();
  return { code: ran.status ?? 128, said, left };
};

/** What a person waiting on a provisioning is told, of the lines provision.sh printed. */
export const stepsSaid = async (lines: string[]): Promise<string[]> => {
  const { provisionStep } = await import("../host/vm/lima.ts");
  const said: string[] = [];
  for (const line of lines) provisionStep(line, (text) => void said.push(text));
  return said;
};

/** What lima.ts's sharesWait (`wait`) printed, run by bash here on a file in place of /proc/mounts
 *  (`now` in it, `later` added 300 ms on) with a bound of 2 s, and when it answered: at once
 *  (under 200 ms), when mounted (under 900 ms), or at its bound (bash counts its 2 s in whole seconds of the clock: from 1 s on). */
export const sharesWaited = async (
  wait: (guests: string[], fsType: string, seconds: number, mounts?: string) => string[],
  guests: string[],
  now: string,
  later: string,
) => {
  const file = path.join(home(), `mounts-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(file, now);
  const [command, ...args] = wait(guests, "virtiofs", 2, file);
  const began = performance.now();
  const added = later ? setTimeout(() => fs.appendFileSync(file, later), 300) : undefined;
  const printed = await new Promise<string>((resolve) => {
    let out = "";
    const child = spawn(command!, args);
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("close", () => resolve(out));
  });
  const took = performance.now() - began;
  clearTimeout(added);
  fs.rmSync(file, { force: true });
  return {
    printed,
    answered: took < 200 ? "at once" : took < 900 ? "when mounted" : "at its bound",
  };
};
