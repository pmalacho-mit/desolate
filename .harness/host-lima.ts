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
 *  asked, and nothing runs as anyone else. `dial` is for its refusals, which come before any
 *  connection: one that is not refused is destroyed at once.
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
    `n=$(ls '${record}' | wc -l | tr -d ' ')\nfor a in "$@"; do printf '%s\\0' "$a"; done >'${record}'/$n\nfor last in "$@"; do :; done\n${apart ? "exit 0" : `SHELL='${bin()}/login-shell' exec /bin/sh -c "$last"`}\n`,
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
    } else if (call === "dial") {
      backend.dial(name, Number(argv[0])).destroy();
    } else {
      if (terminal)
        (Object.assign(process.stdin, { isTTY: true }),
          Object.assign(process.stdout, { isTTY: true }));
      process.stderr.write = ((chunk: string | Buffer) => (
        (stderr += String(chunk)),
        true
      )) as typeof written;
      code = await backend.attach(name, argv.map(at), given);
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

/** What ssh makes (`ssh -G`, which reads the configuration and connects nowhere) of one of the
 *  invocations of desolate's connection for channels (lima.ts masterArgs, and channelArgs with
 *  the forward and cancel of 5173), for a VM whose Lima ssh.config asks for an agent, X11, a
 *  local command, a tunnel and a forward of each kind: with the configuration channelConfig
 *  writes from it (`ours`), or with that Lima file itself. The options that let a server open
 *  a channel to this side, and every forward; the channel folder is written `<dir>`. */
export const channelsConfigured = async (call: "master" | "forward" | "cancel", ours: boolean) => {
  const { masterArgs, channelArgs, channelConfig, forwardSpec } =
    await import("../host/vm/lima.ts");
  const name = "dsl-main-cfg";
  const vm = path.join(limaHome(), name);
  const dir = path.join(vm, "ch");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lima = path.join(vm, "ssh.config");
  fs.writeFileSync(
    lima,
    `Host lima-${name}\n  IdentityFile "${vm}/user"\n  PreferredAuthentications publickey\n  BatchMode yes\n  IdentitiesOnly yes\n  StrictHostKeyChecking yes\n  UserKnownHostsFile "${vm}/ssh.known_hosts"\n  HostKeyAlias lima-${name}\n  User desolate\n  ControlMaster auto\n  ControlPath "${vm}/ssh.sock"\n  ControlPersist yes\n  Hostname 127.0.0.1\n  Port 52436\n  ForwardAgent yes\n  ForwardX11 yes\n  RemoteForward 9999 127.0.0.1:22\n  LocalForward 8888 127.0.0.1:22\n  DynamicForward 7777\n  PermitLocalCommand yes\n  LocalCommand true\n  Tunnel yes\n`,
  );
  const shown = (args: string[]) =>
    spawnSync("ssh", ["-G", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
      .stdout;
  fs.writeFileSync(
    path.join(dir, "ssh.config"),
    channelConfig(name, shown(["-F", lima, `lima-${name}`])),
  );
  const local = path.join(dir, "5173.sock");
  let args =
    call === "master"
      ? masterArgs(name, dir)
      : channelArgs(name, dir, "-O", call, "-L", forwardSpec(local, 5173));
  if (!ours) args = ["-F", lima, ...args.slice(2)];
  const lines = shown(args).split("\n");
  const value = (key: string) =>
    lines.find((line) => line.startsWith(`${key} `))?.slice(key.length + 1) ?? null;
  return {
    forwardagent: value("forwardagent"),
    forwardx11: value("forwardx11"),
    permitlocalcommand: value("permitlocalcommand"),
    globalknownhostsfile: value("globalknownhostsfile"),
    serveraliveinterval: value("serveraliveinterval"),
    serveralivecountmax: value("serveralivecountmax"),
    tunnel: value("tunnel"),
    forwards: lines
      .filter((line) => /^(local|remote|dynamic)forward /.test(line))
      .map((line) => line.split(dir).join("<dir>"))
      .sort(),
  };
};

/** ssh, for channelsAfter: a stand-in for desolate's connections for channels, with no VM.
 *  `-G` prints the few values channelConfig takes; `-f -N` starts a "master" (this file again,
 *  detached), which listens on the control socket and answers `check` (with its own pid, or
 *  the one in `report-pid` in its folder), `forward` (an echo server on the local socket: what it
 *  is sent comes back, then `EOF-SEEN` once it is ended), `cancel` and `exit`; `-O <op>` asks
 *  it, as ssh's own client would. Each master notes its pid in `masters/`. */
const STAND_IN_SSH = String.raw`
import net from "node:net"; import fs from "node:fs"; import path from "node:path"; import { spawn } from "node:child_process";
const args = process.argv.slice(2);
// Nothing of a test outlives it: each stand-in ends once the test's process has (a run killed
// midway never reaches its own clean-up), and a client never waits more than a minute.
const parent = Number(process.env.STAND_IN_PARENT);
setInterval(() => { try { process.kill(parent, 0); } catch { process.exit(1); } }, 1000).unref();
if (args[0] !== "--serve") setTimeout(() => process.exit(124), 60_000).unref();
const opt = (name) => args.map((a, i) => (args[i - 1] === "-o" && a.startsWith(name + "=") ? a.slice(name.length + 1) : null)).find(Boolean);
if (args[0] === "--serve") {
  const ctl = args[1]; const servers = new Map();
  fs.mkdirSync(path.join(args[2], "masters"), { recursive: true }); fs.writeFileSync(path.join(args[2], "masters", String(process.pid)), "");
  const server = net.createServer((c) => c.once("data", (d) => {
    const q = JSON.parse(String(d));
    if (q.op === "check") { let pid = process.pid; try { pid = Number(fs.readFileSync(path.join(args[2], "report-pid"), "utf8")); } catch {} return c.end(JSON.stringify({ ok: true, pid })); }
    if (q.op === "forward") {
      if (servers.has(q.local)) return c.end(JSON.stringify({ ok: true }));
      const s = net.createServer({ allowHalfOpen: true }, (x) => { x.on("data", (b) => x.write(b)); x.on("end", () => x.end("EOF-SEEN\n")); x.on("error", () => {}); });
      s.on("error", () => c.end(JSON.stringify({ ok: false })));
      return s.listen(q.local, () => (servers.set(q.local, s), c.end(JSON.stringify({ ok: true }))));
    }
    if (q.op === "cancel") { servers.get(q.local)?.close(); servers.delete(q.local); return c.end(JSON.stringify({ ok: true })); }
    if (q.op === "exit") { c.end(JSON.stringify({ ok: true })); for (const s of servers.values()) s.close(); server.close(); setTimeout(() => process.exit(0), 20); }
  }));
  server.listen(ctl);
} else if (args.includes("-G")) {
  const host = args.at(-1);
  console.log(["hostname 127.0.0.1", "port 2222", "user desolate", "identityfile /stand-in/user", "userknownhostsfile /stand-in/known_hosts", "hostkeyalias " + host, "stricthostkeychecking true"].join("\n"));
} else {
  const ctl = opt("ControlPath"); const at = args.indexOf("-O");
  const config = args[args.indexOf("-F") + 1];
  try { fs.readFileSync(config); } catch (e) { process.stderr.write("Can't open user config file " + config + ": " + ({ ENOENT: "No such file or directory", EACCES: "Permission denied" }[e.code] ?? e.message) + "\n"); process.exit(255); }
  if (at < 0 && args.includes("-f")) {
    const master = spawn(process.execPath, [process.argv[1], "--serve", ctl, process.env.STAND_IN_HOME, "-o", "ControlPath=" + ctl], { detached: true, stdio: "ignore" }); master.unref();
    const wait = () => (fs.existsSync(ctl) ? process.exit(0) : setTimeout(wait, 5)); wait();
  } else {
    const op = args[at + 1]; const spec = args[args.indexOf("-L") + 1] ?? ""; const local = spec.slice(0, spec.indexOf(":"));
    const once = (file) => { const at = path.join(process.env.STAND_IN_HOME, file); try { const said = fs.readFileSync(at, "utf8"); fs.rmSync(at); return said; } catch { return null; } };
    if (op === "forward" && once("fail-forward") !== null) { process.stderr.write("mux_client_forward: forwarding request failed\n"); process.exit(255); }
    const mode = op === "check" ? once("check-mode") : null;
    if (mode === "hang") setInterval(() => {}, 1000);
    else if (mode === "cannot spawn") { process.stderr.write("spawn ssh EMFILE"); process.exit(127); }
    else if (mode === "another pid") { process.stderr.write("Master running (pid=1)\n"); process.exit(0); }
    else if (mode === "no socket") { process.stderr.write("Control socket connect(" + ctl + "): No such file or directory\n"); process.exit(255); }
    else {
    const c = net.connect(ctl); let got = "";
    c.on("error", (e) => { process.stderr.write("Control socket connect(" + ctl + "): " + ({ ENOENT: "No such file or directory", ECONNREFUSED: "Connection refused", ENOTSOCK: "Socket operation on non-socket", EACCES: "Permission denied" }[e.code] ?? e.message) + "\n"); process.exit(255); });
    c.on("connect", () => c.write(JSON.stringify({ op, local })));
    c.on("data", (d) => (got += d));
    c.on("end", () => { const r = JSON.parse(got || "{}"); if (op === "check" && r.ok) process.stderr.write("Master running (pid=" + r.pid + ")\n"); process.exit(r.ok ? 0 : 255); });
    }
  }
}
`;

/** What the channel rows run in: a Lima home of its own under /tmp (short enough for the
 *  sockets; the test's own home under the system's temporary folder on a Mac is not:
 *  channelsDontFit), with one VM's folder and Lima's file beside it (base.yaml, which
 *  release() goes past), the stand-in ssh first on PATH, and channelsIn over it with
 *  `controlMs` for each ssh it runs. `masters()` is every stand-in master still running;
 *  `dial(target)` what a connection that says `hi` and ends got back; `until(fact)` waits
 *  for a fact, for at most 30 s (far past what a step takes on a Mac whose every core is
 *  busy: STAND_IN_MS), and says whether it came; `done()` ends all of it. */
const standIn = async (controlMs: number) => {
  const { channelsIn } = await import("../host/vm/lima.ts");
  const lima = fs.mkdtempSync("/tmp/dsl-ch-");
  const name = "dsl-main-chan";
  const vm = path.join(lima, name);
  fs.mkdirSync(vm, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(vm, "ssh.config"), `Host lima-${name}\n`);
  fs.writeFileSync(path.join(lima, "base.yaml"), "");
  const stands = path.join(home(), "stand-in-ssh");
  fs.rmSync(stands, { recursive: true, force: true });
  fs.mkdirSync(path.join(stands, "bin"), { recursive: true });
  fs.writeFileSync(path.join(stands, "ssh.mjs"), STAND_IN_SSH);
  fs.writeFileSync(
    path.join(stands, "bin", "ssh"),
    `#!/bin/sh\nexec '${process.execPath}' '${stands}/ssh.mjs' "$@"\n`,
    { mode: 0o755 },
  );
  const before = { PATH: process.env.PATH, STAND_IN_HOME: process.env.STAND_IN_HOME };
  process.env.PATH = `${path.join(stands, "bin")}:${before.PATH}`;
  process.env.STAND_IN_HOME = stands;
  process.env.STAND_IN_PARENT = String(process.pid);
  const backend = channelsIn(lima, () => process.env, controlMs);
  /** Whether `pid` runs: a pid with no process is not an error here. */
  const running = (pid: string) => {
    try {
      process.kill(Number(pid), 0);
      return true;
    } catch {
      return false;
    }
  };
  /** `pid` ended, if it has not ended already. */
  const end = (pid: string, signal: NodeJS.Signals = "SIGKILL") => {
    try {
      process.kill(Number(pid), signal);
    } catch {
      // gone already
    }
  };
  const masters = () =>
    fs.existsSync(path.join(stands, "masters"))
      ? fs.readdirSync(path.join(stands, "masters")).filter(running)
      : [];
  const dial = (target: number) =>
    new Promise<string>((resolve) => {
      const stream = backend.dial(name, target);
      let got = "";
      stream.on("data", (chunk) => (got += chunk));
      stream.on("error", () => {});
      stream.on("close", () => resolve(got));
      stream.end("hi\n");
    });
  const until = async (fact: () => boolean) => {
    for (const began = Date.now(); Date.now() - began < 30_000;) {
      if (fact()) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return fact();
  };
  /** The masters now are exactly `first` (none ended, none made). */
  const same = (first: string[]) => {
    const now = masters();
    return now.length === first.length && now.every((pid) => first.includes(pid));
  };
  const done = () => {
    const ch = path.join(vm, "ch");
    try {
      if (fs.existsSync(ch)) fs.chmodSync(ch, 0o700);
      backend.release();
    } finally {
      for (const pid of masters()) end(pid);
      fs.rmSync(lima, { recursive: true, force: true });
    }
    process.env.PATH = before.PATH;
    if (before.STAND_IN_HOME === undefined) delete process.env.STAND_IN_HOME;
    else process.env.STAND_IN_HOME = before.STAND_IN_HOME;
    delete process.env.STAND_IN_PARENT;
  };
  return { backend, name, vm, stands, masters, running, end, dial, until, same, done };
};

/** One VM's connections for channels (lima.ts channelsIn, as the backend's dial makes them),
 *  with the stand-in ssh above, after `what` happened to its master once a first connection
 *  (to 8080) was carried: nothing (the control); its control socket removed while it lives;
 *  it killed, with the pid it gave when it came up another live process's (this one's: a pid
 *  used again); or the VM let go while a first dial is on its way. What the first connection
 *  and the next (to 8081, a forward of its own) got, and how many masters are left running
 *  once the one let go has ended (waited for: it ends by itself). */
export const channelsAfter = async (
  what:
    | "nothing"
    | "control socket removed"
    | "master killed, its pid another's"
    | "let go while dialling",
): Promise<{ first: string; next: string; left: number }> => {
  const t = await standIn(10_000);
  try {
    if (what === "let go while dialling") {
      const first = t.dial(8080);
      t.backend.release(t.name);
      const got = await first;
      await t.until(() => t.masters().length === 0);
      return { first: got, next: "", left: t.masters().length };
    }
    if (what === "master killed, its pid another's")
      fs.writeFileSync(path.join(t.stands, "report-pid"), String(process.pid));
    const first = await t.dial(8080);
    const [pid] = t.masters();
    if (what === "control socket removed") fs.rmSync(path.join(t.vm, "ch", "ctl"));
    if (what === "master killed, its pid another's") {
      t.end(pid!);
      await t.until(() => !t.running(pid!));
    }
    const next = await t.dial(8081);
    // The one ended (a master that no longer answered) ends by itself, as the new one carries.
    await t.until(() => t.masters().length <= 1);
    return { first, next, left: t.masters().length };
  } finally {
    t.done();
  }
};

/** A forward that fails while a master is up (to 8081, after one to 8080 was carried), and the
 *  check that follows it answered as `check` says (nothing set: as the master is; or it hangs
 *  past its time, cannot be started, answers another pid, or finds no master on the socket).
 *  What that connection got, whether the masters are still just the one that carried the
 *  first, and what a third connection (to 8082) got. */
export const checkThatFails = async (
  check: "as it is" | "hang" | "cannot spawn" | "another pid" | "no socket",
): Promise<{ next: string; sameMaster: boolean; carriesOn: string }> => {
  const t = await standIn(STAND_IN_MS);
  try {
    await t.dial(8080);
    const first = t.masters();
    fs.writeFileSync(path.join(t.stands, "fail-forward"), "");
    if (check !== "as it is") fs.writeFileSync(path.join(t.stands, "check-mode"), check);
    const next = await t.dial(8081);
    const sameMaster = t.same(first);
    const carriesOn = await t.dial(8082);
    return { next, sameMaster, carriesOn };
  } finally {
    t.done();
  }
};

/** Each ssh's time in the rows whose stand-in hangs (it is waited out each time): 2 s, where a
 *  stand-in's own step (a node that starts and answers) took 0.06 s at most of 30 with every
 *  core of the M1 busy (`yes` on each of its 10, load 53; 2026-11-24). The other rows give each
 *  ssh the backend's own 10 s, and every row of these tables two minutes in all (Configure,
 *  lima.ts): what they wait on is facts (a master gone, a connection answered), not a time. */
const STAND_IN_MS = 2000;

/** What dials to one VM got after its channel folder was left in `state` once a first
 *  connection (to 8080) was carried: its control socket replaced by a folder, the folder
 *  made one this user cannot enter, the connection's configuration removed, the whole folder
 *  removed, or its master stopped (SIGSTOP: it holds its sockets and answers nothing). Each
 *  next dial is to a target of its own (a forward to add), up to three until one is carried;
 *  then whether the masters are still just the first, and what one more connection got. */
export const afterState = async (
  state:
    | "as it is"
    | "control socket a folder"
    | "folder unenterable"
    | "config gone"
    | "folder gone"
    | "master stopped",
): Promise<{ tries: string[]; sameMaster: boolean; carriesOn: string }> => {
  const t = await standIn(state === "master stopped" ? STAND_IN_MS : 10_000);
  const ch = path.join(t.vm, "ch");
  try {
    await t.dial(8080);
    const first = t.masters();
    if (state === "control socket a folder")
      (fs.rmSync(path.join(ch, "ctl")), fs.mkdirSync(path.join(ch, "ctl")));
    if (state === "folder unenterable") fs.chmodSync(ch, 0o000);
    if (state === "config gone") fs.rmSync(path.join(ch, "ssh.config"));
    if (state === "folder gone") fs.rmSync(ch, { recursive: true });
    if (state === "master stopped") t.end(first[0]!, "SIGSTOP");
    const tries: string[] = [];
    for (let target = 8081; target <= 8083; target++) {
      tries.push(await t.dial(target));
      if (tries.at(-1)) break;
    }
    const sameMaster = t.same(first);
    const carriesOn = await t.dial(8090);
    return { tries, sameMaster, carriesOn };
  } finally {
    t.done();
  }
};

/** A session's line (lima.ts sessionLine) for `argv` and `options`, run as sshd runs a
 *  command: `/bin/sh -c <line>`, with SHELL a stand-in login shell, which refuses anything but
 *  `-l`, writes down that it was started, and is /bin/sh. `<home>` in a `cwd` is the test's
 *  home (the folder is made), and is written so in what comes back. What the line printed,
 *  split at NULs, its code, and whether it started SHELL. */
export const lineRan = async (
  argv: string[],
  options: { env?: Record<string, string>; cwd?: string } = {},
): Promise<{ said: string[]; code: number; shell: boolean }> => {
  const { sessionLine } = await import("../host/vm/lima.ts");
  fs.mkdirSync(bin(), { recursive: true });
  const login = path.join(bin(), "login-shell-noted");
  const noted = path.join(bin(), "login-shell-started");
  fs.rmSync(noted, { force: true });
  fs.writeFileSync(
    login,
    `#!/bin/sh\n: >'${noted}'\n[ "$1" = -l ] || { echo "not a login shell" >&2; exit 99; }\nshift\nexec /bin/sh "$@"\n`,
    { mode: 0o755 },
  );
  const cwd = options.cwd?.split("<home>").join(fs.realpathSync(home()));
  if (cwd) fs.mkdirSync(cwd, { recursive: true });
  const line = sessionLine(argv, { ...options, ...(cwd ? { cwd } : {}) });
  const ran = spawnSync("/bin/sh", ["-c", line], {
    env: { ...process.env, SHELL: login },
    encoding: "utf8",
    timeout: 30_000,
  });
  const said =
    ran.stdout === ""
      ? []
      : ran.stdout.split("\0").map((word) => word.split(fs.realpathSync(home())).join("<home>"));
  if (said.at(-1) === "") said.pop();
  return { said, code: ran.status ?? 128, shell: fs.existsSync(noted) };
};
