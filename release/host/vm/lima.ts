// The Lima backends: `qemu` (Linux; KVM where there is /dev/kvm, TCG where there is not) and
// `vz` (macOS Virtualization.framework, the product backend). One implementation: Lima is the
// same tool on both. What differs is how each enforces, OUTSIDE the VM, the two things the
// interface demands (P5), and docs/v3/decisions.md has the measurements behind each:
//
//                     read-only shares                   a workspace's egress
//   qemu  (Linux)     9p with QEMU's `readonly`.         QEMU's user network with restrict=on,
//                     NOT virtiofs: virtiofsd has no     and guestfwd to the link's socket
//                     read-only mode, and root in the    (qemu-wrapper.sh).
//                     guest remounts it rw (measured).
//   vz    (macOS)     virtiofs; the host refuses the     Lima's host process under sandbox-exec,
//                     write (measured on an M1). The     allowed one loopback port: the link.
//                     same profile lets it hand the VM
//                     only its own shares (`profile`).
//
// desolate keeps its own Lima home under ~/.desolate, so it never touches a VM it did not
// make, and refuses Lima's user-wide _config overrides, which could add a network.
import { attachFiltered } from "./attach.ts";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../../shared/run.ts";
import type { RunResult } from "../../shared/run.ts";
import { readJson, writeJson } from "../../shared/json.ts";
import { printable } from "../../shared/text.ts";
import { define, valueOf, whole } from "../../shared/settings.ts";
import { because } from "../failures.ts";
import { imageFingerprint } from "../image.ts";
import { INSTANCE, paths, RELEASE_DIR } from "../paths.ts";
import { duplexOf, parseSs } from "./fake.ts";
import { runStreamed } from "./stream.ts";
import { socatAddress } from "./types.ts";
import { shareRefused } from "./shares.ts";
import type { Backend, Check, ExecOptions, Listener, VmInfo, VmSpec, VmStatus } from "./types.ts";
import type {
  Call,
  Expect,
  Given,
  Invoke,
  Throws,
} from "../../../suede.nests/dsl.import.meta.vitest.ts";
import type {
  baseYaml,
  cloneCall,
  confinement,
  madeWithoutLinkToken,
  stepsSaid,
} from "../../.harness/host-lima.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIMA_HOME = path.join(paths.home, "lima");
/** The base VM's disk, which every desolate VM is cloned from: the smallest any of them has. */
export const BASE_DISK_GIB = 30;
const LIMACTL = process.env.DESOLATE_LIMACTL ?? "limactl";
const PREFIX = `dsl-${INSTANCE}-`;
const BASE = `${PREFIX}base`;
/** The image the base was provisioned from (host/image.ts), beside Lima's files for it:
 *  read without booting it. */
const STAMP = "desolate-image";
const baseStamp = () => {
  try {
    return (
      /^[0-9a-f]{16}$/.exec(
        fs.readFileSync(path.join(LIMA_HOME, BASE, STAMP), "utf8").trim(),
      )?.[0] ?? null
    );
  } catch {
    return null;
  }
};
/** How long Lima waits for a VM it started to be up (its ssh answering, its own checks
 *  passed). Lima must be given a number, and the right one is this Mac's: seconds on Apple's
 *  hypervisor, minutes where QEMU emulates every instruction (a Linux host with no KVM). One
 *  setting where there were three numbers (10, 20 and 30 minutes, for the base started
 *  again, the base's first start and any other VM, none with a reason): thirty, the most
 *  patient of them. */
export const BOOT_MINUTES = define({
  name: "vm.bootMinutes",
  env: "DESOLATE_VM_BOOT_MINUTES",
  side: "host",
  default: 30,
  parse: whole(1, 24 * 60),
  why: "How long Lima waits for a VM it started to come up before it gives up: more on a machine where VMs boot slowly (QEMU without KVM).",
});
/** `limactl start`'s own `--timeout`, and the time after which a limactl that did not keep
 *  to it is ended: one number, the setting, and the second derived from it. Lima's is the
 *  bound that is meant to end a start (it says what it was waiting for, and leaves the VM
 *  in a state it knows); ten minutes past it, limactl itself is taken to be stuck. Ten,
 *  because Lima's clock starts when the VM does, and before that a first start downloads
 *  Lima's Ubuntu image: the old pairs left five to ten minutes between the two. */
const boot = () => {
  const minutes = valueOf(BOOT_MINUTES);
  return { flag: `${minutes}m`, timeoutMs: (minutes + 10) * 60_000 };
};
/** What the guest connects to for its link, per backend. */
const QEMU_LINK = "tcp:192.168.5.100:15000";

type Meta = { spec: VmSpec; sshPort: number; linkPort: number; linkToken: string };
/** Every share a real directory, reached through no symlink (shares.ts): else nothing starts. */
const sharesPlain = (shares: { host: string }[]) => {
  for (const share of shares) {
    const why = shareRefused(share.host, paths.home);
    if (why)
      throw new Error(
        `refused to share ${share.host} with a VM: ${why}. Something replaced a folder desolate shares; look at it before anything starts (desolate doctor)`,
      );
  }
};

const metaFile = (name: string) => path.join(LIMA_HOME, name, "desolate.json");
const meta = (name: string) => readJson<Meta | null>(metaFile(name), null);

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });

/** Which of a VM's shares are not mounted yet, and which are mounted the wrong way, from
 *  the guest's /proc/mounts. `flags`: also hold each mount's ro/rw to the spec (vz, where
 *  the guest's flag and the host's refusal agree; measured).
 *
 *  Why it exists: on vz, ssh answers before every virtiofs share is mounted, so the first
 *  command after `limactl start` can see a share's bare mount point: an empty directory
 *  owned by root (release/docs/incidents.md). And a VM that came up without a share, or
 *  with a read-only one writable, must not be used at all (P6). */
export const unmounted = (
  procMounts: string,
  shares: { guest: string; writable: boolean }[],
  fsType: string,
  flags: boolean,
): { missing: string[]; wrong: string[] } => {
  // /proc/mounts escapes space, tab, newline and backslash as octal.
  const decode = (field: string) =>
    field.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
  const mounted = new Map<string, { type: string; ro: boolean }>();
  for (const line of procMounts.split("\n")) {
    const [, where, type, options] = line.split(" ");
    // The last mount at a path is the one that is seen.
    if (where && type && options)
      mounted.set(decode(where), { type, ro: options.split(",").includes("ro") });
  }
  const missing: string[] = [];
  const wrong: string[] = [];
  for (const share of shares) {
    const found = mounted.get(share.guest);
    if (!found || found.type !== fsType) missing.push(share.guest);
    else if (flags && found.ro === share.writable)
      wrong.push(`${share.guest} is mounted ${found.ro ? "read-only" : "read-write"}`);
  }
  return { missing, wrong };
};

declare namespace unmounted {
  /** every share mounted, by its file system, the right way round: nothing to wait for */
  export type Ready = Expect<
    Invoke<
      typeof unmounted,
      [
        procMounts: "mount0 /desolate/release virtiofs ro,relatime 0 0\nmount1 /workspaces virtiofs rw,relatime 0 0\n",
        shares: [
          { guest: "/desolate/release"; writable: false },
          { guest: "/workspaces"; writable: true },
        ],
        fsType: "virtiofs",
        flags: true,
      ]
    >,
    "=",
    { missing: []; wrong: [] }
  >;
  /** a bare mount point (the root disk's, before virtiofs got there) is not the share yet */
  export type NotYet = Expect<
    Invoke<
      typeof unmounted,
      [
        procMounts: "/dev/vda1 / ext4 rw 0 0\n",
        shares: [{ guest: "/workspaces"; writable: true }],
        fsType: "virtiofs",
        flags: true,
      ]
    >,
    "=",
    { missing: ["/workspaces"]; wrong: [] }
  >;
  /** a read-only share that came up writable is wrong, and so is the reverse; the last mount at
   *  a path is the one that counts */
  export type WrongWay = Expect<
    Invoke<
      typeof unmounted,
      [
        procMounts: "m /desolate/release virtiofs ro 0 0\nm /desolate/release virtiofs rw 0 0\nm /workspaces virtiofs ro 0 0\n",
        shares: [
          { guest: "/desolate/release"; writable: false },
          { guest: "/workspaces"; writable: true },
        ],
        fsType: "virtiofs",
        flags: true,
      ]
    >,
    "=",
    {
      missing: [];
      wrong: ["/desolate/release is mounted read-write", "/workspaces is mounted read-only"];
    }
  >;
  /** qemu holds read-only itself (9p's `readonly`), so the guest's flag is not compared */
  export type FlagsNotHeld = Expect<
    Invoke<
      typeof unmounted,
      [
        procMounts: "m /desolate/release 9p rw 0 0\n",
        shares: [{ guest: "/desolate/release"; writable: false }],
        fsType: "9p",
        flags: false,
      ]
    >,
    "=",
    { missing: []; wrong: [] }
  >;
  /** /proc/mounts writes a space in a path as \\040 */
  export type Escaped = Expect<
    Invoke<
      typeof unmounted,
      [
        procMounts: "m /git/acme/my\\040app virtiofs rw 0 0\n",
        shares: [{ guest: "/git/acme/my app"; writable: true }],
        fsType: "virtiofs",
        flags: true,
      ]
    >,
    "=",
    { missing: []; wrong: [] }
  >;
}

/** A line provision.sh printed, for the person waiting on it: its steps (`==> packages`) are
 *  said, as what is being done now; anything else it prints is kept for a failure's text
 *  and not shown (apt's and npm's own lines differ from run to run). */
export const provisionStep = (line: string, log: (line: string) => void) => {
  const step = /^==> (.+)$/.exec(line);
  if (step) log(`  ${printable(step[1])}`);
};

declare namespace provisionStep {
  /** a step is said; the tools' own chatter is not */
  export type Steps = Expect<
    Invoke<
      typeof stepsSaid,
      [
        lines: [
          "==> packages",
          "Get:1 http://archive.ubuntu.com noble InRelease",
          "==> node 22.11.0",
        ],
      ]
    >,
    "=",
    ["  packages", "  node 22.11.0"]
  >;
  /** what a VM printed is text, not commands for the terminal */
  export type Safe = Expect<
    Invoke<typeof stepsSaid, [lines: ["==> docker\u001b[2J"]]>,
    "=",
    ["  docker?[2J"]
  >;
}

export const limaBackend = (kind: "qemu" | "vz"): Backend => {
  const arch = os.arch() === "arm64" ? "aarch64" : "x86_64";
  const imageDir = process.env.DESOLATE_IMAGE_DIR ?? path.join(paths.images, arch);
  const realQemu = () => {
    for (const dir of (process.env.PATH ?? "").split(":")) {
      const candidate = path.join(dir, `qemu-system-${arch}`);
      if (fs.existsSync(candidate)) return candidate;
    }
    return "";
  };
  const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
    const out: NodeJS.ProcessEnv = { ...process.env, LIMA_HOME, ...extra };
    // Lima copies proxy variables into the guest; a desolate VM gets none of the host's.
    for (const key of [
      "http_proxy",
      "https_proxy",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "no_proxy",
      "NO_PROXY",
      "ftp_proxy",
      "FTP_PROXY",
      "all_proxy",
      "ALL_PROXY",
    ])
      delete out[key];
    if (kind === "qemu") {
      out[`QEMU_SYSTEM_${arch.toUpperCase()}`] = path.join(HERE, "qemu-wrapper.sh");
      out.DESOLATE_QEMU_REAL = realQemu();
    }
    return out;
  };
  const lima = (
    args: string[],
    options: {
      timeoutMs?: number;
      signal?: AbortSignal;
      idleMs?: number;
      input?: string | Buffer;
      extraEnv?: Record<string, string>;
      inheritStderr?: boolean;
    } = {},
  ) =>
    run(LIMACTL, ["--tty=false", ...args], {
      env: env(options.extraEnv),
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      idleMs: options.idleMs,
      input: options.input,
      inheritStderr: options.inheritStderr,
    });
  const limaOk = async (args: string[], options: Parameters<typeof lima>[1] = {}) => {
    const result = await lima(args, options);
    if (result.code !== 0)
      throw new Error(
        because(
          `limactl ${args.slice(0, 3).join(" ")} failed (exit ${result.code})`,
          `limactl-${args[0]}`,
          result.stderr || result.stdout,
        ),
      );
    return result.stdout;
  };

  const yq = (value: unknown) => JSON.stringify(value);
  /** Lima forwards a guest's listeners onto the Mac by itself. Every one is refused, for TCP
   *  and UDP: on 0.0.0.0 (Lima published a guest's port 80 on *:80, measured in Phase 0) and
   *  on loopback, which the first rule did not cover: a workspace's 127.0.0.1 and ::1
   *  listeners appeared on the Mac's 127.0.0.1, around desolate's forwarder, the per-
   *  workspace hostnames and the editor's gate (measured on the M1, 2026-11-12: the editor
   *  server's own port, 31580, among them). desolate's forwarder is the only way in. */
  const NO_FORWARDS = ["0.0.0.0", "127.0.0.1"].flatMap((guestIP) =>
    ["tcp", "udp"].map((proto) => ({ guestIP, guestPortRange: [1, 65535], proto, ignore: true })),
  );
  /** The settings every desolate VM has, as yq assignments for `limactl clone --set`. */
  const settings = (spec: VmSpec, sshPort: number): string[] => [
    `.mounts = ${yq(spec.shares.map((share) => ({ location: share.host, mountPoint: share.guest, writable: share.writable })))}`,
    `.cpus = ${spec.cpus ?? 2}`,
    `.memory = ${yq(`${spec.memoryMiB ?? 2048}MiB`)}`,
    // A clone's disk can grow and never shrink (Lima refuses): every VM is cloned from the
    // base's BASE_DISK_GIB, so a size above it grows the disk and anything else is the base's.
    ...(spec.diskGiB && spec.diskGiB > BASE_DISK_GIB
      ? [`.disk = ${yq(`${spec.diskGiB}GiB`)}`]
      : []),
    `.ssh.localPort = ${sshPort}`,
    // No automatic forwards of guest ports onto the host: Lima publishes a guest's port 80
    // on every interface (measured). desolate's forwarder is the only way in.
    `.portForwards = ${yq(NO_FORWARDS)}`,
    // A second network would be a way around the proxy.
    `.networks = []`,
  ];

  const baseYaml = (): string => {
    const common = [
      `vmType: ${kind}`,
      `arch: ${arch}`,
      // qemu: 9p, whose read-only is QEMU's. vz: virtiofs, whose read-only is the host's.
      `mountType: ${kind === "qemu" ? "9p" : "virtiofs"}`,
      "cpus: 2",
      "memory: 2GiB",
      `disk: ${BASE_DISK_GIB}GiB`,
      "mounts: []",
      "containerd:\n  system: false\n  user: false",
      `portForwards: ${yq(NO_FORWARDS)}`,
      "networks: []",
    ];
    if (kind === "qemu")
      return (
        [
          ...common,
          "images:",
          `- location: ${yq(path.join(imageDir, "disk.raw"))}`,
          `  arch: ${arch}`,
          "  kernel:",
          `    location: ${yq(path.join(imageDir, "vmlinuz"))}`,
          '    cmdline: "root=LABEL=desolate-root rw console=ttyS0"',
          "  initrd:",
          `    location: ${yq(path.join(imageDir, "initrd"))}`,
        ].join("\n") + "\n"
      );
    // vz: Lima's own digest-pinned Ubuntu image, provisioned once by image/provision.sh.
    return (
      [
        "minimumLimaVersion: 2.0.0",
        "base:",
        "- template:_images/ubuntu-24.04",
        ...common,
        `mounts:\n- location: ${yq(RELEASE_DIR)}\n  mountPoint: /desolate/release\n  writable: false`,
      ]
        .filter((line) => line !== "mounts: []")
        .join("\n") + "\n"
    );
  };

  const status = async (name: string): Promise<VmStatus> => {
    if (!fs.existsSync(path.join(LIMA_HOME, name, "lima.yaml"))) return "missing";
    const listed = await lima(["list", "--format", "{{.Status}}", name], { timeoutMs: 30_000 });
    const text = listed.stdout.trim();
    return text === "Running" ? "running" : text === "" ? "missing" : "stopped";
  };

  /** Where each share of a VM must be, read-only or read-write, as Apple's VM process will be
   *  allowed to open it: a share under desolate's home named from the home and its path,
   *  never by following the share itself (the root's user can swap it for a link at any
   *  moment, even between desolate's check and this line). The release, outside the home, is
   *  the Mac's own checkout. */
  const sharesAt = (m: Meta): { at: string; writable: boolean }[] => {
    const home = path.resolve(paths.home);
    return m.spec.shares.map((share) => {
      const relative = path.relative(home, path.resolve(share.host));
      const inHome = relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
      return {
        at: inHome
          ? path.join(fs.realpathSync.native(home), relative)
          : fs.realpathSync.native(share.host),
        writable: share.writable,
      };
    });
  };
  /** A path in a sandbox profile's string. */
  const sbString = (p: string) => `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  /** The sandbox profile a vz VM's host process starts under, and keeps for its whole life
   *  (decisions.md: measured on an M1).
   *
   *  SHARES. Apple's VM process opens a VM's shared folders by a sandbox extension that the
   *  configuring process (Lima's host process) issues for each: what that process may hand
   *  out, a VM gets, with everything under it. The root's user owns the folders workspaces
   *  and the git VM share, and could swap one for a link between desolate's check
   *  (shares.ts) and that moment. Measured on the M1 (2026-11-20, Lima 2.3.0): a loop
   *  flipping a share won 3 of 4 starts, and one swap just after Lima's own checks won every
   *  time; the VM then read and wrote a folder of the Mac's, or read Lima's private key
   *  (`_config/user`, which opens root in every VM). So the process may issue an extension for
   *  nothing but this VM's shares, each at exactly its path and with exactly its access (a
   *  read-only share's is for reading). A swapped share is refused ("Failed to issue sandbox
   *  extension for file system device with directory ...") and the VM does not start; with no
   *  swap it starts as before. Measured beside two broader profiles that denied files by place
   *  (each had a hole a reviewer found: what Lima's process could read, a VM could be handed).
   *
   *  NETWORK, for a VM with no egress: outbound, unix sockets except the Mac's resolver; this
   *  VM's ssh forward; its link. */
  const profile = (m: Meta) => {
    const shares = sharesAt(m);
    const allowed = (writable: boolean) =>
      shares
        .filter((share) => share.writable === writable)
        .map((share) => `(literal ${sbString(share.at)})`);
    return (
      [
        "(version 1)",
        "(allow default)",
        ...(m.spec.egress === "none"
          ? [
              "(deny network-outbound)",
              "(allow network-outbound (remote unix-socket))",
              '(deny network-outbound (literal "/private/var/run/mDNSResponder"))',
              '(deny network-outbound (literal "/var/run/mDNSResponder"))',
              `(allow network-outbound (remote ip "localhost:${m.sshPort}"))`,
              `(allow network-outbound (remote ip "localhost:${m.linkPort}"))`,
            ]
          : []),
        "(deny file-issue-extension)",
        ...(allowed(false).length
          ? [
              `(allow file-issue-extension (require-all (extension-class "com.apple.app-sandbox.read") (require-any ${allowed(false).join(" ")})))`,
            ]
          : []),
        ...(allowed(true).length
          ? [
              `(allow file-issue-extension (require-all (extension-class "com.apple.app-sandbox.read-write") (require-any ${allowed(true).join(" ")})))`,
            ]
          : []),
      ].join("\n") + "\n"
    );
  };

  /** One argument for a remote shell, quoted so that it stays one argument. */
  const quote = (arg: string) => `'${arg.replace(/'/g, "'\\''")}'`;
  /** Root in the ROOT VM is reached by ssh as root, with Lima's key for this home (on the
   *  host only), on its own control socket: never through the VM's login user, which runs
   *  everything there that reads a domain's data and has no sudo (root/start.sh). */
  const rootSshArgs = (name: string, argv: string[], options: ExecOptions) => {
    const vars = Object.entries(options.env ?? {}).map(([key, value]) => `${key}=${value}`);
    const command = `cd ${quote(options.cwd ?? "/")} && exec ${["env", ...vars, ...argv].map(quote).join(" ")}`;
    return [
      "-F",
      path.join(LIMA_HOME, name, "ssh.config"),
      "-o",
      `ControlPath=${path.join(LIMA_HOME, name, "ssh-root.sock")}`,
      "-o",
      "ControlMaster=auto",
      "-o",
      "ControlPersist=60",
      "-l",
      "root",
      `lima-${name}`,
      "--",
      command,
    ];
  };
  const rootReady = new Set<string>();
  /** Make sure root in a root VM takes this home's key. The first time (and after a boot
   *  that reset root's keys), the key is put there through the login user's sudo, which
   *  Lima's cloud-init gives it at boot and root/start.sh then takes away. */
  const ensureRootSsh = async (name: string) => {
    if (rootReady.has(name)) return;
    const probe = () =>
      run("ssh", rootSshArgs(name, ["true"], {}), { env: env(), timeoutMs: 60_000 });
    if ((await probe()).code !== 0) {
      const pub = fs.readFileSync(path.join(LIMA_HOME, "_config", "user.pub"), "utf8").trim();
      if (!/^ssh-ed25519 [A-Za-z0-9+/=]+( \S+)?$/.test(pub))
        throw new Error(`${LIMA_HOME}/_config/user.pub is not the ed25519 key Lima makes`);
      const put = await lima(
        [
          "shell",
          "--workdir",
          "/",
          name,
          "sudo",
          "-n",
          "bash",
          "-c",
          "install -d -m 0700 -o root -g root /root/.ssh && cat >/root/.ssh/authorized_keys.new && chmod 0600 /root/.ssh/authorized_keys.new && mv /root/.ssh/authorized_keys.new /root/.ssh/authorized_keys",
        ],
        { input: pub + "\n", timeoutMs: 60_000 },
      );
      const again = put.code === 0 ? await probe() : put;
      if (again.code !== 0)
        throw new Error(
          because(
            `cannot reach root in ${name}: ssh as root was refused and its login user could not install the key. Only the first bootstrap can install that key (root/start.sh then takes the login user's sudo away for good), so ${LIMA_HOME}/_config/user.pub or root's authorized_keys in ${name} has changed since. Its keys are on its own disk: make it again (desolate destroy, then bootstrap) only after adding new deploy keys is acceptable. What was said`,
            "root-ssh",
            again.stderr || again.stdout,
          ),
        );
    }
    rootReady.add(name);
  };
  const isRootVm = (name: string) => meta(name)?.spec.role === "root";

  const shellArgs = (name: string, argv: string[], options: ExecOptions) => {
    const vars = Object.entries(options.env ?? {}).map(([key, value]) => `${key}=${value}`);
    const command = options.root
      ? ["sudo", "env", ...vars, ...argv]
      : vars.length > 0
        ? ["env", ...vars, ...argv]
        : argv;
    return ["shell", "--workdir", options.cwd ?? "/", name, ...command];
  };

  /** Whether a VM's Lima configuration refuses every forward NO_FORWARDS refuses. */
  const forwardsClosed = (name: string) => {
    try {
      const text = fs.readFileSync(path.join(LIMA_HOME, name, "lima.yaml"), "utf8");
      return (
        /guestIP: ?"?127\.0\.0\.1"?[\s\S]{0,120}?ignore: true/.test(text) &&
        /proto: ?"?udp"?/.test(text)
      );
    } catch {
      return false;
    }
  };

  /** Whether a running vz VM's Lima host process is under today's profile (`profile`, written
   *  by `start` just before it starts the process, which keeps the profile for its whole life).
   *  A VM started otherwise (by an older desolate: found on the M1 after the upgrade of
   *  2026-11-20, when the root VM had run since midnight and bootstrap did not restart it; or
   *  by Lima itself) may be handed any folder its host process can open, until it starts
   *  again. macOS says whether the process is sandboxed at all (sandbox_check, asked through
   *  the system's python, which Homebrew's command line tools provide: a file's age alone was
   *  fooled by a profile an earlier start had left, T4); and the profile is today's if it
   *  carries today's rule and was written before the process started. Undecided is not ok. */
  const startedConfined = async (name: string): Promise<boolean | null> => {
    try {
      const file = path.join(LIMA_HOME, name, "confine.sb");
      if (!fs.readFileSync(file, "utf8").includes("(deny file-issue-extension)")) return false;
      const pid = fs.readFileSync(path.join(LIMA_HOME, name, "ha.pid"), "utf8").trim();
      if (!/^[0-9]+$/.test(pid)) return false;
      const asked = await run("/usr/bin/python3", [
        "-c",
        "import ctypes, sys\nf = ctypes.CDLL('/usr/lib/libSystem.dylib').sandbox_check\nf.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int]\nprint(f(int(sys.argv[1]), None, 0))",
        pid,
      ]);
      if (asked.code !== 0 || !/^[01]$/.test(asked.stdout.trim())) return null;
      if (asked.stdout.trim() !== "1") return false;
      const ps = await run("ps", ["-o", "lstart=", "-p", pid], {
        env: { ...process.env, LC_ALL: "C" },
      });
      const began = Date.parse(ps.stdout.trim());
      // (ps says the start to the second.)
      return Number.isFinite(began) && began + 1000 >= fs.statSync(file).mtimeMs;
    } catch {
      return false;
    }
  };

  /** Wait for every share to be mounted as the spec says; stop the VM and refuse if one
   *  is mounted the wrong way, or is still missing after a minute. A minute of the clock
   *  that runs while this process does (so a Mac that slept through the wait did not use it
   *  up), looks included: counted in sleeps alone, with each look allowed thirty seconds,
   *  "a minute" could be far more. Mounting is the guest's own first step after ssh answers
   *  (measured on the M1: under a second), so a share missing after a minute is not late. */
  const sharesReady = async (name: string, m: Meta) => {
    const fsType = kind === "qemu" ? "9p" : "virtiofs";
    let last = { missing: m.spec.shares.map((share) => share.guest), wrong: [] as string[] };
    for (const began = performance.now(); performance.now() - began <= 60_000;) {
      const mounts = await lima(["shell", "--workdir", "/", name, "cat", "/proc/mounts"], {
        timeoutMs: 30_000,
      });
      if (mounts.code === 0) {
        last = unmounted(mounts.stdout, m.spec.shares, fsType, kind === "vz");
        if (last.wrong.length > 0) break;
        if (last.missing.length === 0) return;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await lima(["stop", "-f", name], { timeoutMs: 120_000 });
    throw new Error(
      last.wrong.length > 0
        ? `${name} came up with a share mounted against its spec (${last.wrong.join("; ")}); it was stopped. This is a bug in desolate's ${kind} backend.`
        : `${name} came up without its shares after a minute (${last.missing.join(", ")}); it was stopped. ${path.join(LIMA_HOME, name, "ha.stderr.log")} may say why.`,
    );
  };

  const backend: Backend = {
    kind,
    isolated: true,

    async check(): Promise<Check[]> {
      const checks: Check[] = [];
      const version = await run(LIMACTL, ["--version"], { env: env() });
      const number = /(\d+)\.(\d+)\.(\d+)/.exec(version.stdout);
      // vz needs 2.3: on 2.1.2 a confined guest's pings were answered and it was never
      // shown that nothing left the Mac; on 2.3.0 they are not (decisions.md, section 4.3).
      const [major, minor] = number ? [Number(number[1]), Number(number[2])] : [0, 0];
      const least = kind === "vz" ? [2, 3] : [2, 0];
      checks.push({
        name: "lima",
        ok:
          version.code === 0 &&
          number !== null &&
          (major > least[0]! || (major === least[0] && minor >= least[1]!)),
        detail: version.code === 0 ? version.stdout.trim() : "limactl was not found",
        fix:
          process.platform === "darwin"
            ? `brew ${version.code === 0 ? "upgrade" : "install"} lima (${least.join(".")} or newer)`
            : `install Lima ${least.join(".")} or newer (https://lima-vm.io) and put limactl on PATH, or set DESOLATE_LIMACTL`,
      });
      for (const override of ["default.yaml", "override.yaml"])
        if (fs.existsSync(path.join(LIMA_HOME, "_config", override)))
          checks.push({
            name: "lima overrides",
            ok: false,
            detail: `${LIMA_HOME}/_config/${override} would change every VM (it could add a network)`,
            fix: `remove ${LIMA_HOME}/_config/${override}`,
          });
      if (kind === "qemu") {
        checks.push({
          name: "qemu",
          ok: realQemu() !== "",
          detail: realQemu() || `qemu-system-${arch} was not found`,
          fix: "apt-get install qemu-system-x86 qemu-utils (or your distribution's package)",
        });
        const socat = await run("socat", ["-V"]);
        checks.push({
          name: "socat (carries a workspace's link)",
          ok: socat.code === 0,
          detail: socat.code === 0 ? "present" : "not found",
          fix: "apt-get install socat",
        });
        checks.push({
          name: "acceleration",
          ok: true,
          detail: fs.existsSync("/dev/kvm")
            ? "KVM"
            : "none: software emulation (TCG). A real VM boundary, and slow: minutes to boot",
        });
      } else {
        const sandbox = await run("sandbox-exec", ["-n", "no-network", "true"]);
        checks.push({
          name: "sandbox-exec (cuts a workspace's egress from outside it)",
          ok: sandbox.code === 0,
          detail: sandbox.code === 0 ? "present" : "not usable on this macOS",
          fix: "desolate's vz backend needs macOS's sandbox-exec",
        });
        // Measured, by tests/probes/v3/phase0-mac-egress3.sh and on every T4 run
        // (tests/v3/t3/01-boundaries): docs/v3/decisions.md, section 4.3.
        checks.push({
          name: "vz: ICMP from a workspace",
          ok: true,
          detail:
            "closed by the same confinement as TCP, UDP and DNS (measured on Lima 2.3.0: a confined guest's echo gets no reply; the unconfined control's does)",
        });
      }
      // macOS keeps a unix socket's path under 104 bytes, and Lima's ssh control socket (and
      // desolate's own, for root in the root VM) is under each VM's directory. The longest
      // is a workspace VM's (found on the M1, where a long home made Lima refuse to start).
      const longest = path.join(LIMA_HOME, `${PREFIX}0123456789`, "ssh-root.sock.0123456789012345");
      const limit = process.platform === "darwin" ? 103 : 107;
      checks.push({
        name: "socket paths fit",
        ok: Buffer.byteLength(longest) <= limit,
        detail:
          Buffer.byteLength(longest) <= limit
            ? `the longest fits in ${limit} bytes`
            : `the longest is ${Buffer.byteLength(longest)} bytes, over ${limit}: ${LIMA_HOME}`,
        fix: "set DESOLATE_HOME to a shorter path (the default, ~/.desolate, fits unless your home's path is very long)",
      });
      // Every running VM refuses Lima's own forwarding (NO_FORWARDS): one made before the
      // loopback rules forwarded its 127.0.0.1 listeners onto this Mac.
      const open: string[] = [];
      for (const vm of await backend.list())
        if (vm.status === "running" && !forwardsClosed(vm.name))
          open.push(vm.labels.title ?? vm.name);
      checks.push({
        name: "VMs forward nothing by themselves",
        ok: open.length === 0,
        detail:
          open.length === 0
            ? "every running VM refuses Lima's own forwarding"
            : `${open.join(", ")} still forward their loopback listeners onto this Mac`,
        fix: "restart each: desolate stop <domain>/<workspace> && desolate start <domain>/<workspace> (the root VM: desolate down, then desolate bootstrap)",
      });
      // Every running vz VM may be handed only its own shares (`profile`): one whose host
      // process started before its profile was written keeps no such limit.
      if (kind === "vz") {
        const loose: string[] = [];
        let undecided = false;
        for (const vm of await backend.list())
          if (vm.status === "running") {
            const confined = await startedConfined(vm.name);
            if (confined === null) undecided = true;
            else if (!confined) loose.push(vm.labels.title ?? vm.name);
          }
        checks.push({
          name: "VMs started confined",
          ok: loose.length === 0 && !undecided,
          detail: undecided
            ? "macOS could not be asked whether a VM's host process is sandboxed (/usr/bin/python3 did not answer)"
            : loose.length === 0
              ? "every running VM's host process may hand it only its own shares"
              : `${loose.join(", ")} started without the profile that lets it be handed only its own shares: until it starts again, a share swapped for a link could hand it any folder of this Mac's user`,
          fix: undecided
            ? "xcode-select --install (the command line tools, which give /usr/bin/python3), then desolate doctor"
            : "restart each: desolate stop <domain>/<workspace> && desolate start <domain>/<workspace> (the root VM: desolate down, then desolate bootstrap)",
        });
      }
      const haveBase = fs.existsSync(path.join(LIMA_HOME, BASE, "lima.yaml"));
      const stamp = baseStamp();
      const current = haveBase && stamp === imageFingerprint();
      checks.push({
        name: "base image",
        ok: current,
        detail: !haveBase
          ? "no base VM yet"
          : current
            ? `the base VM ${BASE}, provisioned from this desolate's image (${stamp})`
            : `the base VM ${BASE} was provisioned from ${stamp ? `another image (${stamp})` : "an image older than image stamps"}; this desolate's is ${imageFingerprint()}`,
        fix: `desolate bootstrap${haveBase ? " (it provisions the base again, in place: minutes, once)" : ` --backend ${kind}`}`,
      });
      return checks;
    },

    baseStale() {
      if (!fs.existsSync(path.join(LIMA_HOME, BASE, "lima.yaml"))) return null;
      const stamp = baseStamp();
      return stamp === imageFingerprint()
        ? null
        : `the base VM was provisioned from ${stamp ? `image ${stamp}` : "an unstamped image"}, and this desolate's is ${imageFingerprint()}`;
    },

    async ensureImage(log) {
      fs.mkdirSync(LIMA_HOME, { recursive: true });
      const fingerprint = imageFingerprint();
      const provision = async (what: string) => {
        log(`provisioning it${what} (packages, node, docker, the editor server): several minutes`);
        // No timer (R4): it downloads packages over this Mac's link, however slow, and the
        // person at the terminal is the one waiting. It says each step as it starts it
        // (provision.sh's `==>` lines), so a wait is a wait on something named, and Ctrl-C
        // stops it: provision.sh is idempotent, and bootstrap runs it again.
        return runStreamed(
          LIMACTL,
          [
            "--tty=false",
            "shell",
            "--workdir",
            "/",
            BASE,
            "sudo",
            "env",
            "DESOLATE_IMAGE_KIND=vm",
            `DESOLATE_IMAGE_FINGERPRINT=${fingerprint}`,
            "bash",
            "/desolate/release/image/provision.sh",
          ],
          { env: env(), lines: (line) => provisionStep(line, log) },
        );
      };
      // What provision.sh said when it failed: its errors are on stderr, its steps on stdout.
      const provisionSaid = (result: RunResult) => `${result.stdout}\n${result.stderr}`;
      if (fs.existsSync(path.join(LIMA_HOME, BASE, "lima.yaml"))) {
        const stamp = baseStamp();
        if (stamp === fingerprint) return log(`base VM ${BASE} present, image ${fingerprint}`);
        // Older than this desolate (pins.env, a lock or provision.sh changed since it was
        // made): provisioned again in place. provision.sh is idempotent; what it installs
        // changes, nothing of the stack's lives in the base.
        log(
          `base VM ${BASE} was provisioned from ${stamp ? `image ${stamp}` : "an unstamped image"}; this desolate's is ${fingerprint}`,
        );
        await limaOk(["start", BASE, "--timeout", boot().flag], { timeoutMs: boot().timeoutMs });
        const again = await provision(" again");
        await limaOk(["stop", BASE], { timeoutMs: 300_000 });
        if (again.code !== 0)
          throw new Error(
            because(
              "provisioning the base VM again failed (it is left as it was, still older)",
              "provision-base",
              provisionSaid(again),
            ),
          );
        fs.writeFileSync(path.join(LIMA_HOME, BASE, STAMP), `${fingerprint}\n`);
        return;
      }
      const file = path.join(LIMA_HOME, "base.yaml");
      if (kind === "qemu") {
        for (const need of ["disk.raw", "vmlinuz", "initrd"])
          if (!fs.existsSync(path.join(imageDir, need)))
            throw new Error(
              `the base image is missing (${path.join(imageDir, need)}). Build it: sudo release/image/build.sh --out ${imageDir}  (or set DESOLATE_IMAGE_DIR to where it was built)`,
            );
        fs.writeFileSync(file, baseYaml());
        log(`creating the base VM from ${imageDir}`);
        // No timer (R4): Lima copies the image's disk on this machine, and reaches nothing.
        await limaOk(["create", `--name=${BASE}`, file]);
        return;
      }
      // vz: boot Lima's pinned Ubuntu image once, provision it with the same script the
      // Linux image is built from, and stop it. Every VM is then a copy-on-write clone.
      fs.writeFileSync(file, baseYaml());
      log("creating the base VM from Lima's pinned Ubuntu image (downloads it the first time)");
      await limaOk(["start", `--name=${BASE}`, "--timeout", boot().flag, file], {
        timeoutMs: boot().timeoutMs,
      });
      const provisioned = await provision("");
      if (provisioned.code !== 0) {
        await lima(["delete", "-f", BASE]);
        throw new Error(
          because("provisioning the base VM failed", "provision-base", provisionSaid(provisioned)),
        );
      }
      await limaOk(["stop", BASE], { timeoutMs: 300_000 });
      fs.writeFileSync(path.join(LIMA_HOME, BASE, STAMP), `${fingerprint}\n`);
    },

    async create(spec) {
      return backend.clone(BASE, spec);
    },

    async clone(from, spec) {
      sharesPlain(spec.shares);
      for (const share of spec.shares) fs.mkdirSync(share.host, { recursive: true });
      sharesPlain(spec.shares);
      for (const socket of spec.sockets)
        fs.mkdirSync(path.dirname(socket.host), { recursive: true });
      const m: Meta = {
        spec,
        sshPort: await freePort(),
        linkPort: await freePort(),
        linkToken: randomBytes(16).toString("hex"),
      };
      const args = [
        "clone",
        ...settings(spec, m.sshPort).flatMap((assignment) => ["--set", assignment]),
        from,
        spec.name,
      ];
      await limaOk(args, { timeoutMs: 600_000 });
      writeJson(metaFile(spec.name), m);
    },

    async start(name) {
      const m = meta(name);
      if (!m) throw new Error(`${name} is not a VM desolate made`);
      sharesPlain(m.spec.shares);
      const cut = m.spec.egress === "none";
      // A VM made by an older desolate gets today's forwarding rules before it boots.
      if (!forwardsClosed(name))
        await limaOk(["edit", "--set", `.portForwards = ${yq(NO_FORWARDS)}`, name], {
          timeoutMs: 120_000,
        });
      const args = ["start", "--timeout", boot().flag, name];
      if (kind === "vz") {
        const file = path.join(LIMA_HOME, name, "confine.sb");
        // After sharesPlain: the profile names each share where it must be.
        fs.writeFileSync(file, profile(m));
        // The host process starts under the profile and keeps it for its whole life.
        const result = await run("sandbox-exec", ["-f", file, LIMACTL, "--tty=false", ...args], {
          env: env(),
          timeoutMs: boot().timeoutMs,
        });
        if (result.code !== 0)
          throw new Error(
            because(
              `could not start ${name} confined. If what follows says "Failed to issue sandbox extension", a share of it changed after desolate checked it: see desolate doctor, and ${path.join(LIMA_HOME, name, "ha.stderr.log")}. limactl said`,
              "limactl-start",
              result.stderr || result.stdout,
            ),
          );
        return sharesReady(name, m);
      }
      const extraEnv: Record<string, string> =
        kind === "qemu" && cut
          ? { DESOLATE_QEMU_EGRESS: "none", DESOLATE_QEMU_LINK: m.spec.sockets[0]?.host ?? "" }
          : {};
      await limaOk(args, { timeoutMs: boot().timeoutMs, extraEnv });
      if (cut && kind === "qemu") {
        // Not taken on trust: the QEMU that is running must be the restricted one.
        const pid = fs.readFileSync(path.join(LIMA_HOME, name, "qemu.pid"), "utf8").trim();
        const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
        if (!cmdline.includes("restrict=on")) {
          await lima(["stop", "-f", name]);
          throw new Error(
            `${name} came up with an unrestricted network; it was stopped. This is a bug in desolate's qemu backend.`,
          );
        }
      }
      await sharesReady(name, m);
    },

    async stop(name) {
      await limaOk(["stop", name], { timeoutMs: 600_000 });
    },
    async resize(name, size) {
      const m = meta(name);
      if (!m) throw new Error(`${name} is not a VM desolate made`);
      // Lima's own edit of a stopped VM (measured on the M1, 2026-11-18: the guest has the new
      // memory at its next boot, and its root filesystem grows to a larger disk). A disk
      // never shrinks: Lima refuses, and the caller refuses first.
      const disk = Math.max(m.spec.diskGiB ?? BASE_DISK_GIB, BASE_DISK_GIB);
      await limaOk(
        [
          "edit",
          "--cpus",
          String(size.cpus),
          "--memory",
          String(size.memoryMiB / 1024),
          ...(size.diskGiB > disk ? ["--disk", String(size.diskGiB)] : []),
          name,
        ],
        { timeoutMs: 120_000 },
      );
      writeJson(metaFile(name), {
        ...m,
        spec: {
          ...m.spec,
          cpus: size.cpus,
          memoryMiB: size.memoryMiB,
          diskGiB: Math.max(size.diskGiB, disk),
        },
      });
    },
    async suspend() {
      throw new Error(
        `the ${kind} backend cannot suspend a VM (Lima has no suspend to disk for it); stop it instead`,
      );
    },
    async resume(name) {
      return backend.start(name);
    },
    async destroy(name) {
      await lima(["delete", "-f", name], { timeoutMs: 300_000 });
      fs.rmSync(path.join(LIMA_HOME, name), { recursive: true, force: true });
    },

    async info(name): Promise<VmInfo> {
      const m = meta(name);
      return {
        name,
        status: await status(name),
        labels: m ? { ...m.spec.labels, role: m.spec.role } : {},
      };
    },

    async list() {
      let names: string[] = [];
      try {
        names = fs
          .readdirSync(LIMA_HOME)
          .filter(
            (entry) =>
              entry.startsWith(PREFIX) && fs.existsSync(path.join(LIMA_HOME, entry, "lima.yaml")),
          );
      } catch {
        return [];
      }
      return Promise.all(names.sort().map((name) => backend.info(name)));
    },

    async exec(name, argv, options = {}): Promise<RunResult> {
      const asRoot = options.root === true && isRootVm(name);
      if (asRoot) await ensureRootSsh(name);
      const [command, args] = asRoot
        ? ["ssh", rootSshArgs(name, argv, options)]
        : [LIMACTL, ["--tty=false", ...shellArgs(name, argv, options)]];
      // A long step a person waits on, or an archive: streamed, and under no timer (stream.ts).
      if (options.lines || options.stdoutTo || options.stdinFrom)
        return runStreamed(command, args, {
          env: env(),
          input: options.input,
          lines: options.lines,
          stdoutTo: options.stdoutTo,
          stdinFrom: options.stdinFrom,
        });
      return run(command, args, {
        env: env(),
        input: options.input,
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        idleMs: options.idleMs,
        maxBytes: options.maxBytes,
        inheritStderr: options.inheritStderr,
      });
    },

    spawn(name, argv, options = {}) {
      // Root in the root VM is asked for by exec() only; nothing streams as root there.
      if (options.root && isRootVm(name))
        throw new Error("spawn as root in the root VM is not offered; use exec");
      return spawn(LIMACTL, ["--tty=false", ...shellArgs(name, argv, options)], {
        stdio: ["pipe", "pipe", "pipe"],
        env: env(),
      });
    },

    attach(name, argv, options = {}) {
      // A terminal for the VM's program when this has one (--tty: its output is piped, to be
      // filtered, so Lima cannot tell from that), and what it prints filtered (attach.ts).
      return attachFiltered(
        LIMACTL,
        [
          `--tty=${process.stdin.isTTY ? "true" : "false"}`,
          ...shellArgs(name, argv, { cwd: options.cwd }),
        ],
        env(),
      );
    },

    dial(name, target) {
      // A session, not ssh's stdio forwarding, which Lima's control master refuses (measured).
      return duplexOf(
        spawn(
          LIMACTL,
          ["--tty=false", "shell", "--workdir", "/", name, "socat", "STDIO", socatAddress(target)],
          { stdio: ["pipe", "pipe", "ignore"], env: env() },
        ),
      );
    },

    link(name) {
      // qemu: QEMU carries connections to this address to the link's socket (qemu-wrapper.sh).
      // vz: the Mac's loopback, where the sandbox allows this VM one port.
      if (kind === "qemu") return { guest: QEMU_LINK };
      // A loopback port is open to every process on the Mac, so the link opens with a token
      // that only this host and this VM are given (shared/link.ts). No token, no link.
      const m = meta(name);
      if (!m || !/^[0-9a-f]{32}$/.test(m.linkToken ?? ""))
        throw new Error(
          `${name} has no link token: it was made by an older desolate. Remove the workspace and make it again.`,
        );
      return {
        guest: `tcp:192.168.5.2:${m.linkPort}#${m.linkToken}`,
        hostPort: m.linkPort,
        token: m.linkToken,
      };
    },

    async listeners(name): Promise<Listener[]> {
      const result = await lima(["shell", "--workdir", "/", name, "ss", "-H", "-ltn"], {
        timeoutMs: 60_000,
      });
      if (result.code !== 0)
        throw new Error(`cannot list listeners in ${name}: ${result.stderr.trim()}`);
      return parseSs(result.stdout);
    },

    hostPorts() {
      const ports = new Set<number>();
      let names: string[] = [];
      try {
        names = fs.readdirSync(LIMA_HOME);
      } catch {
        return ports;
      }
      for (const name of names) {
        const m = meta(name);
        if (m)
          for (const port of [m.sshPort, m.linkPort]) if (Number.isInteger(port)) ports.add(port);
        // A VM desolate did not clone (the base) has its ssh port in Lima's own file.
        try {
          const port = /^\s*localPort:\s*(\d+)\s*$/m.exec(
            fs.readFileSync(path.join(LIMA_HOME, name, "lima.yaml"), "utf8"),
          )?.[1];
          if (port) ports.add(Number(port));
        } catch {
          /* not a VM */
        }
      }
      return ports;
    },

    async refreshSessions(name, force = false) {
      const same = force
        ? { code: 1 }
        : await lima(
            [
              "shell",
              "--workdir",
              "/",
              name,
              "bash",
              "-c",
              'test "$(id -G)" = "$(id -G "$(id -un)")"',
            ],
            { timeoutMs: 60_000 },
          );
      if (same.code === 0) return;
      await run(
        "ssh",
        ["-F", path.join(LIMA_HOME, name, "ssh.config"), "-O", "exit", `lima-${name}`],
        { env: env(), timeoutMs: 30_000 },
      );
    },
  };
  return backend;
};

declare namespace limaBackend {
  type Vz = Invoke<typeof limaBackend, [kind: "vz"]>;
  type Qemu = Invoke<typeof limaBackend, [kind: "qemu"]>;
  type Workspace = {
    name: "dsl-main-0123456789";
    role: "workspace";
    egress: "none";
    shares: [
      { host: "<home>/domains/acme/repos"; guest: "/workspaces"; writable: true },
      {
        host: "<home>/mirrors/acme/web.git";
        guest: "/desolate/mirrors/acme/web.git";
        writable: false;
      },
    ];
    sockets: [
      { host: "<home>/run/dsl-main-0123456789/proxy.sock"; guest: "/desolate/link/proxy.sock" },
    ];
    cpus: 4;
    memoryMiB: 8192;
    diskGiB: 60;
    labels: { title: "acme/w1" };
  };

  /** a VM is a clone of the base with its shares (read-only where the spec says), its size, its
   *  own ssh port, Lima's own forwarding refused on every address and protocol, and no network
   *  of Lima's that could go around the proxy */
  export type Clones = Expect<
    Invoke<typeof cloneCall, [backend: Vz, spec: Workspace]>,
    "=",
    [
      "--tty=false",
      "clone",
      "--set",
      '.mounts = [{"location":"<home>/domains/acme/repos","mountPoint":"/workspaces","writable":true},{"location":"<home>/mirrors/acme/web.git","mountPoint":"/desolate/mirrors/acme/web.git","writable":false}]',
      "--set",
      ".cpus = 4",
      "--set",
      '.memory = "8192MiB"',
      "--set",
      '.disk = "60GiB"',
      "--set",
      ".ssh.localPort = <ssh port>",
      "--set",
      '.portForwards = [{"guestIP":"0.0.0.0","guestPortRange":[1,65535],"proto":"tcp","ignore":true},{"guestIP":"0.0.0.0","guestPortRange":[1,65535],"proto":"udp","ignore":true},{"guestIP":"127.0.0.1","guestPortRange":[1,65535],"proto":"tcp","ignore":true},{"guestIP":"127.0.0.1","guestPortRange":[1,65535],"proto":"udp","ignore":true}]',
      "--set",
      ".networks = []",
      "dsl-main-base",
      "dsl-main-0123456789",
    ]
  >;
  /** a disk no larger than the base's is the base's (a clone can grow and never shrink), and
   *  what the spec leaves out is 2 CPUs and 2 GiB */
  export type KeepsTheBaseDisk = Expect<
    Invoke<
      typeof cloneCall,
      [
        backend: Vz,
        spec: {
          name: "dsl-main-small";
          role: "workspace";
          egress: "none";
          shares: [];
          sockets: [];
          diskGiB: 20;
          labels: {};
        },
      ]
    >,
    "=",
    [
      "--tty=false",
      "clone",
      "--set",
      ".mounts = []",
      "--set",
      ".cpus = 2",
      "--set",
      '.memory = "2048MiB"',
      "--set",
      ".ssh.localPort = <ssh port>",
      "--set",
      '.portForwards = [{"guestIP":"0.0.0.0","guestPortRange":[1,65535],"proto":"tcp","ignore":true},{"guestIP":"0.0.0.0","guestPortRange":[1,65535],"proto":"udp","ignore":true},{"guestIP":"127.0.0.1","guestPortRange":[1,65535],"proto":"tcp","ignore":true},{"guestIP":"127.0.0.1","guestPortRange":[1,65535],"proto":"udp","ignore":true}]',
      "--set",
      ".networks = []",
      "dsl-main-base",
      "dsl-main-small",
    ]
  >;

  /** vz: Lima's pinned Ubuntu, virtiofs, the release read-only, no containerd, nothing forwarded */
  export type VzBase = Expect<
    Invoke<typeof baseYaml, [backend: Vz]>,
    "=",
    'minimumLimaVersion: 2.0.0\nbase:\n- template:_images/ubuntu-24.04\nvmType: vz\narch: <arch>\nmountType: virtiofs\ncpus: 2\nmemory: 2GiB\ndisk: 30GiB\ncontainerd:\n  system: false\n  user: false\nportForwards: [{"guestIP":"0.0.0.0","guestPortRange":[1,65535],"proto":"tcp","ignore":true},{"guestIP":"0.0.0.0","guestPortRange":[1,65535],"proto":"udp","ignore":true},{"guestIP":"127.0.0.1","guestPortRange":[1,65535],"proto":"tcp","ignore":true},{"guestIP":"127.0.0.1","guestPortRange":[1,65535],"proto":"udp","ignore":true}]\nnetworks: []\nmounts:\n- location: "<release>"\n  mountPoint: /desolate/release\n  writable: false\n'
  >;
  /** qemu: desolate's own image, booted by its kernel, shares over 9p (QEMU keeps them read-only) */
  export type QemuBase = Expect<
    Invoke<typeof baseYaml, [backend: Qemu]>,
    "=",
    'vmType: qemu\narch: <arch>\nmountType: 9p\ncpus: 2\nmemory: 2GiB\ndisk: 30GiB\nmounts: []\ncontainerd:\n  system: false\n  user: false\nportForwards: [{"guestIP":"0.0.0.0","guestPortRange":[1,65535],"proto":"tcp","ignore":true},{"guestIP":"0.0.0.0","guestPortRange":[1,65535],"proto":"udp","ignore":true},{"guestIP":"127.0.0.1","guestPortRange":[1,65535],"proto":"tcp","ignore":true},{"guestIP":"127.0.0.1","guestPortRange":[1,65535],"proto":"udp","ignore":true}]\nnetworks: []\nimages:\n- location: "<home>/images/<arch>/disk.raw"\n  arch: <arch>\n  kernel:\n    location: "<home>/images/<arch>/vmlinuz"\n    cmdline: "root=LABEL=desolate-root rw console=ttyS0"\n  initrd:\n    location: "<home>/images/<arch>/initrd"\n'
  >;

  /** a VM with no egress starts under a profile that lets its host process reach two loopback
   *  ports, its ssh and its link, and unix sockets other than the Mac's resolver; and hand
   *  Apple's VM process no folder but its own shares, each at exactly its path and with exactly
   *  its access (the read-only one for reading): nothing else */
  export type Confined = Expect<
    Invoke<
      typeof confinement,
      [
        backend: Vz,
        spec: {
          name: "dsl-main-cut";
          role: "workspace";
          egress: "none";
          shares: [
            { host: "<home>/domains/acme/repos"; guest: "/workspaces"; writable: true },
            {
              host: "<home>/mirrors/acme/web.git";
              guest: "/desolate/mirrors/acme/web.git";
              writable: false;
            },
          ];
          sockets: [];
          labels: {};
        },
      ]
    >,
    "=",
    '(version 1)\n(allow default)\n(deny network-outbound)\n(allow network-outbound (remote unix-socket))\n(deny network-outbound (literal "/private/var/run/mDNSResponder"))\n(deny network-outbound (literal "/var/run/mDNSResponder"))\n(allow network-outbound (remote ip "localhost:<ssh port>"))\n(allow network-outbound (remote ip "localhost:<link port>"))\n(deny file-issue-extension)\n(allow file-issue-extension (require-all (extension-class "com.apple.app-sandbox.read") (require-any (literal "<home>/mirrors/acme/web.git"))))\n(allow file-issue-extension (require-all (extension-class "com.apple.app-sandbox.read-write") (require-any (literal "<home>/domains/acme/repos"))))\n'
  >;
  /** a VM with open egress (the root) is confined in what it is handed just the same, and
   *  nothing more: its network is its own */
  export type ConfinedFilesOnly = Expect<
    Invoke<
      typeof confinement,
      [
        backend: Vz,
        spec: {
          name: "dsl-main-root";
          role: "root";
          egress: "open";
          shares: [{ host: "<home>/domains"; guest: "/desolate/domains"; writable: true }];
          sockets: [];
          labels: {};
        },
      ]
    >,
    "=",
    '(version 1)\n(allow default)\n(deny file-issue-extension)\n(allow file-issue-extension (require-all (extension-class "com.apple.app-sandbox.read-write") (require-any (literal "<home>/domains"))))\n'
  >;

  /** a VM is started only if desolate made it (its record is beside Lima's) */
  export type StartsOnlyItsOwn = Throws<
    Call<Vz, "start", [name: "dsl-main-someone-else"]>,
    "dsl-main-someone-else is not a VM desolate made"
  >;
  /** a link on the Mac's loopback opens only with a token: a VM made before tokens gets none */
  export type NoTokenNoLink = Given<
    Invoke<typeof madeWithoutLinkToken, [name: "dsl-main-old"]>,
    Throws<
      Call<Vz, "link", [name: "dsl-main-old"]>,
      "dsl-main-old has no link token: it was made by an older desolate. Remove the workspace and make it again."
    >
  >;
  /** there is no suspend: a stop is asked for instead of a pause that is not there */
  export type NoSuspend = Throws<
    Call<Vz, "suspend", [name: "dsl-main-0123456789"]>,
    "the vz backend cannot suspend a VM (Lima has no suspend to disk for it); stop it instead"
  >;
}
