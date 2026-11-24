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
// make, and `doctor` fails while Lima's user-wide _config overrides, which could add a
// network, are there.
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
import { rootVmName } from "../../shared/names.ts";
import { printable } from "../../shared/text.ts";
import { define, valueOf, whole } from "../../shared/settings.ts";
import { because } from "../failures.ts";
import { imageFingerprint } from "../image.ts";
import { INSTANCE, paths, RELEASE_DIR } from "../paths.ts";
import { duplexOf, runStreamed } from "./stream.ts";
import { socatAddress } from "./types.ts";
import { shareRefused } from "./shares.ts";
import type { Backend, Check, ExecOptions, VmInfo, VmSpec, VmStatus } from "./types.ts";
import type {
  Call,
  Expect,
  Given,
  Invoke,
  SkipIfNotFound,
  Table,
  Throws,
} from "../../../suede.nests/dsl.import.meta.vitest.ts";
import type {
  alone,
  baseYaml,
  cloneCall,
  confinement,
  madeWithoutLinkToken,
  sessionOf,
  sharesWaited,
  statusOf,
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

/** The one command that waits in a VM for its shares: until each of `guests` is mounted by
 *  `fsType` (either way round: unmounted says whether it is the right one), or for
 *  `seconds` by the VM's clock, whichever comes first; then it prints the mounts (`mounts`:
 *  /proc/mounts, but in a test). A look is bash's own `read`, no program started, a quarter
 *  second apart. A path is compared as /proc/mounts writes it. */
export const sharesWait = (
  guests: string[],
  fsType: string,
  seconds: number,
  mounts = "/proc/mounts",
): string[] => [
  "bash",
  "-c",
  'm=$1 limit=$2 type=$3; shift 3\nuntil [ "$SECONDS" -ge "$limit" ]; do\n  seen=1\n  for want in "$@"; do\n    seen=\n    while read -r _ at fs _; do [ "$at" = "$want" ] && [ "$fs" = "$type" ] && seen=1; done <"$m"\n    [ -n "$seen" ] || break\n  done\n  [ -n "$seen" ] && break\n  sleep 0.25\ndone\ncat "$m"',
  "_",
  mounts,
  String(seconds),
  fsType,
  ...guests.map((guest) =>
    guest.replace(/[\\ \t\n]/g, (c) => `\\${c.charCodeAt(0).toString(8).padStart(3, "0")}`),
  ),
];

declare namespace sharesWait {
  /** the command: its script, then the file, the bound, the file system and each share as
   *  /proc/mounts writes it (a space as \040, a backslash as \134) */
  export type Command = Expect<
    Invoke<
      typeof sharesWait,
      [guests: ["/workspaces", "/git/acme/my app", "/a\\b"], fsType: "virtiofs", seconds: 60]
    >,
    "=",
    [
      "bash",
      "-c",
      'm=$1 limit=$2 type=$3; shift 3\nuntil [ "$SECONDS" -ge "$limit" ]; do\n  seen=1\n  for want in "$@"; do\n    seen=\n    while read -r _ at fs _; do [ "$at" = "$want" ] && [ "$fs" = "$type" ] && seen=1; done <"$m"\n    [ -n "$seen" ] || break\n  done\n  [ -n "$seen" ] && break\n  sleep 0.25\ndone\ncat "$m"',
      "_",
      "/proc/mounts",
      "60",
      "virtiofs",
      "/workspaces",
      "/git/acme/my\\040app",
      "/a\\134b",
    ]
  >;
  /** run by bash here, on a file in place of /proc/mounts, with a bound of 2 s: it answers at
   *  once when every share is there; when the last one comes (written 300 ms on); at its
   *  bound when one never comes, or comes as another file system's. Each answer is the
   *  mounts as they were then */
  export type Waits = Table<
    typeof sharesWaited,
    [
      [
        args: [
          wait: typeof sharesWait,
          guests: ["/workspaces", "/git/acme/my app"],
          now: "m /workspaces virtiofs rw 0 0\nm /git/acme/my\\040app virtiofs rw 0 0\n",
          later: "",
        ],
        expected: {
          printed: "m /workspaces virtiofs rw 0 0\nm /git/acme/my\\040app virtiofs rw 0 0\n";
          answered: "at once";
        },
      ],
      [
        args: [
          wait: typeof sharesWait,
          guests: ["/workspaces", "/git/acme/my app"],
          now: "m /workspaces virtiofs rw 0 0\n",
          later: "m /git/acme/my\\040app virtiofs rw 0 0\n",
        ],
        expected: {
          printed: "m /workspaces virtiofs rw 0 0\nm /git/acme/my\\040app virtiofs rw 0 0\n";
          answered: "when mounted";
        },
      ],
      [
        args: [
          wait: typeof sharesWait,
          guests: ["/workspaces", "/git/acme/my app"],
          now: "m /workspaces virtiofs rw 0 0\n",
          later: "",
        ],
        expected: { printed: "m /workspaces virtiofs rw 0 0\n"; answered: "at its bound" },
      ],
      [
        args: [
          wait: typeof sharesWait,
          guests: ["/workspaces"],
          now: "m /workspaces ext4 rw 0 0\n",
          later: "",
        ],
        expected: { printed: "m /workspaces ext4 rw 0 0\n"; answered: "at its bound" },
      ],
      [
        args: [wait: typeof sharesWait, guests: [], now: "", later: ""],
        expected: { printed: ""; answered: "at once" },
      ],
    ]
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

/** Whether a pid file of Lima's names a process that is alive now, read as Lima's own
 *  `ReadPIDFile` reads it (pkg/store/instance.go, v2.3.0): a file that is not there, or
 *  holds no number, names nothing; a number whose process is gone names nothing (Lima
 *  then removes the file; this only reads). A process that exists but is another user's
 *  answers EPERM, and is alive: Lima says so too ("if we get a permissions error, it means
 *  the process is still running"). A file written before this boot of the Mac names
 *  nothing either, whatever its number: its process died with that boot, and the number may
 *  be anyone's now. Lima tells by a marker holding the boot's id (pkg/store/pidfile.go),
 *  which macOS gives only to `sysctl`; the file's own time, against when this boot began,
 *  says the same without a process. Found on the M1, 2026-11-23: 4 of 28 VM folders still
 *  held pid files from earlier boots, their numbers then dead. Ten seconds of slack, for
 *  the boot's time in whole seconds and a clock set right just after boot. Bounded: Lima
 *  writes the number and a newline, so a longer file is not one of its pid files. */
const pidAlive = (file: string): boolean => {
  let text: string;
  try {
    const fd = fs.openSync(file, "r");
    try {
      const { mtimeMs, size } = fs.fstatSync(fd);
      if (size > 16 || mtimeMs < Date.now() - os.uptime() * 1000 - 10_000) return false;
      const buffer = Buffer.alloc(16);
      text = buffer.toString("latin1", 0, fs.readSync(fd, buffer, 0, buffer.length, 0)).trim();
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
  // Positive: kill(2) given 0 or -1 asks about a group, or every process. (Past what a pid can
  // be, node's kill refuses the number: not EPERM, so not alive.)
  if (!/^[1-9][0-9]{0,9}$/.test(text)) return false;
  try {
    process.kill(Number(text), 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** The longest path a unix socket may have here (sockaddr_un's sun_path, less its NUL). */
const SOCKET_PATH_MAX = process.platform === "darwin" ? 103 : 107;

/** Whether something accepts a connection on the unix socket at `socket`: connected, then
 *  closed at once, nothing sent. A refusal (a socket file left by a listener that is gone),
 *  no file, any other error, or no answer within a second is no. A second, against Lima's
 *  3 s for a whole Info round trip: the kernel completes a connect to a local listener with
 *  room in its backlog at once (to a running host agent's socket on the M1, 2026-11-23:
 *  0.05 ms in the middle of 20, 4 ms the slowest). The verdict waits a turn of the loop after
 *  the timer, so a connect that completed while this process was busy is counted first. A
 *  path longer than a socket's may be is no: nothing could have bound it (Lima binds the real
 *  one, and doctor's "socket paths fit" keeps every path under a home within the limit), and
 *  libuv cuts such a path short rather than refuse it (on the M1: a connect to a 108-byte
 *  path reached the socket named by its first 104). */
const accepts = (socket: string): Promise<boolean> =>
  new Promise((resolve) => {
    if (Buffer.byteLength(socket) > SOCKET_PATH_MAX) return resolve(false);
    const connection = net.connect(socket);
    const answer = (yes: boolean) => {
      clearTimeout(timer);
      connection.destroy();
      resolve(yes);
    };
    const timer = setTimeout(() => setImmediate(() => answer(false)), 1000);
    connection.once("connect", () => answer(true));
    connection.once("error", () => answer(false));
  });

/** A VM's state from the files Lima keeps in its folder (`dir`), with no process started:
 *  `missing` with no lima.yaml; `running` when the host agent's pid file (ha.pid) and the
 *  driver's (`<vmType>.pid`: vz.pid, qemu.pid) both name a live process and the host agent's
 *  socket (ha.sock) accepts a connection; `stopped` otherwise. The rule is Lima's own
 *  (pkg/store/instance.go, v2.3.0), which `limactl list` applies to both drivers (neither has
 *  an `InspectStatus` of its own): `Inspect` asks the host agent's socket for Info whenever
 *  ha.pid names a live process, and calls it Broken if that fails;
 *  `inspectStatusWithPIDFiles` then says Running for both pids alive, Stopped for neither,
 *  Broken for one alone. Broken is "stopped" here, as it was when `limactl list` was asked.
 *  It was asked once a VM folder each pass of the daemon's loop: about 20 a second with 28
 *  folders, each 50 ms of CPU and 87 MB at its peak (measured on the M1, 2026-11-23).
 *
 *  The socket is asked because pids alone can lie for as long as another process lives: under
 *  vz the driver runs in the host agent, so ha.pid and vz.pid hold one number (the root VM's,
 *  14904, in both on the M1), and a host agent killed without cleaning up leaves both files
 *  naming whatever later takes that number, while its socket file refuses (one such stopped
 *  VM's, on the M1). Callers start a VM that is not running, and would never start that one.
 *  Only a VM whose pids are alive is asked: a stopped one costs a few file reads.
 *
 *  A start in progress reads stopped until the VM runs: the host agent writes ha.pid, then
 *  binds ha.sock, then runs the driver, which writes its pid file once the VM runs
 *  (cmd/limactl/hostagent.go, pkg/driver/vz/vm_darwin.go). A stop reads running while the
 *  guest shuts down, as Lima's Running did, then stopped: the driver's pid file goes when the
 *  VM has stopped, then the socket, then ha.pid. Like Lima's Running, `running` means the VM's
 *  process is up, not that its ssh answers: `start` waits for that itself. */
export const vmStatus = async (dir: string, driver: "qemu" | "vz"): Promise<VmStatus> => {
  if (!fs.existsSync(path.join(dir, "lima.yaml"))) return "missing";
  return processesUp(dir, driver) && (await accepts(path.join(dir, "ha.sock")))
    ? "running"
    : "stopped";
};
/** `vmStatus`'s first half, for a caller that cannot wait for the socket: the host agent's
 *  and the driver's pid files both name a live process. */
const processesUp = (dir: string, driver: "qemu" | "vz") =>
  pidAlive(path.join(dir, "ha.pid")) && pidAlive(path.join(dir, `${driver}.pid`));

declare namespace vmStatus {
  type Vz = Invoke<typeof limaBackend, [kind: "vz"]>;
  type Qemu = Invoke<typeof limaBackend, [kind: "qemu"]>;

  /** What `info` says of a VM folder, from Lima's files and its host agent's socket alone.
   *  `<self>` is this test's own process, alive; `<gone>` a child that has exited;
   *  `<listening>` a socket this test accepts on. Every row fails if limactl was started to
   *  answer it. */
  export type FromLimasFiles = Table<
    typeof statusOf,
    [
      /** both processes alive: running */
      [
        args: [
          backend: Vz,
          files: {
            "lima.yaml": "";
            "ha.pid": "<self>\n";
            "vz.pid": "<self>\n";
            "ha.sock": "<listening>";
          },
        ],
        expected: "running",
      ],
      /** made, and never started: stopped */
      [args: [backend: Vz, files: { "lima.yaml": "" }], expected: "stopped"],
      /** no lima.yaml is no VM, whatever else the folder holds */
      [args: [backend: Vz, files: { "ha.pid": "<self>"; "vz.pid": "<self>" }], expected: "missing"],
      /** one alive and the other gone (Lima's Broken), either way round: stopped */
      [
        args: [
          backend: Vz,
          files: {
            "lima.yaml": "";
            "ha.pid": "<self>";
            "vz.pid": "<gone>";
            "ha.sock": "<listening>";
          },
        ],
        expected: "stopped",
      ],
      [
        args: [
          backend: Vz,
          files: {
            "lima.yaml": "";
            "ha.pid": "<gone>";
            "vz.pid": "<self>";
            "ha.sock": "<listening>";
          },
        ],
        expected: "stopped",
      ],
      [
        args: [
          backend: Vz,
          files: { "lima.yaml": ""; "ha.pid": "<self>"; "ha.sock": "<listening>" },
        ],
        expected: "stopped",
      ],
      /** the driver's file is the backend's own: qemu.pid on qemu, and vz.pid there is not it */
      [
        args: [
          backend: Qemu,
          files: {
            "lima.yaml": "";
            "ha.pid": "<self>";
            "qemu.pid": "<self>";
            "ha.sock": "<listening>";
          },
        ],
        expected: "running",
      ],
      [
        args: [
          backend: Qemu,
          files: {
            "lima.yaml": "";
            "ha.pid": "<self>";
            "vz.pid": "<self>";
            "ha.sock": "<listening>";
          },
        ],
        expected: "stopped",
      ],
      /** another user's process exists (pid 1, the system's first): kill says EPERM, and it is
       *  alive (run as root, kill succeeds: alive too) */
      [
        args: [
          backend: Vz,
          files: { "lima.yaml": ""; "ha.pid": "1"; "vz.pid": "1"; "ha.sock": "<listening>" },
        ],
        expected: "running",
      ],
    ]
  >;
  /** both pids alive is not enough: the host agent's socket must take a connection, which
   *  one left behind by a host agent that is gone does not (under vz both files hold the host
   *  agent's one pid, which another process may have now). The control is the first row
   *  above. */
  export type HostAgentSocket = Table<
    typeof statusOf,
    [
      /** no socket */
      [
        args: [backend: Vz, files: { "lima.yaml": ""; "ha.pid": "<self>"; "vz.pid": "<self>" }],
        expected: "stopped",
      ],
      /** its file, and nobody listening on it */
      [
        args: [
          backend: Vz,
          files: { "lima.yaml": ""; "ha.pid": "<self>"; "vz.pid": "<self>"; "ha.sock": "<closed>" },
        ],
        expected: "stopped",
      ],
      /** a listener that never reads is still there: a connect is all that is asked */
      [
        args: [
          backend: Vz,
          files: { "lima.yaml": ""; "ha.pid": "<self>"; "vz.pid": "<self>"; "ha.sock": "<unread>" },
        ],
        expected: "running",
      ],
      /** a plain file by its name is no socket */
      [
        args: [
          backend: Vz,
          files: { "lima.yaml": ""; "ha.pid": "<self>"; "vz.pid": "<self>"; "ha.sock": "" },
        ],
        expected: "stopped",
      ],
    ]
  >;
  /** a pid file that holds no pid names nothing, and never throws: beside the control above,
   *  each of these is the host agent's file, the driver's naming this live process */
  export type NotAPid = Table<
    typeof statusOf,
    [
      [
        args: [
          backend: Vz,
          files: { "lima.yaml": ""; "ha.pid": "abc"; "vz.pid": "<self>"; "ha.sock": "<listening>" },
        ],
        expected: "stopped",
      ],
      [
        args: [
          backend: Vz,
          files: { "lima.yaml": ""; "ha.pid": "-1"; "vz.pid": "<self>"; "ha.sock": "<listening>" },
        ],
        expected: "stopped",
      ],
      [
        args: [
          backend: Vz,
          files: { "lima.yaml": ""; "ha.pid": "0"; "vz.pid": "<self>"; "ha.sock": "<listening>" },
        ],
        expected: "stopped",
      ],
      [
        args: [
          backend: Vz,
          files: { "lima.yaml": ""; "ha.pid": ""; "vz.pid": "<self>"; "ha.sock": "<listening>" },
        ],
        expected: "stopped",
      ],
      [
        args: [
          backend: Vz,
          files: {
            "lima.yaml": "";
            "ha.pid": "<self>abc";
            "vz.pid": "<self>";
            "ha.sock": "<listening>";
          },
        ],
        expected: "stopped",
      ],
      [
        args: [
          backend: Vz,
          files: {
            "lima.yaml": "";
            "ha.pid": "<self> 1";
            "vz.pid": "<self>";
            "ha.sock": "<listening>";
          },
        ],
        expected: "stopped",
      ],
      [
        args: [
          backend: Vz,
          files: {
            "lima.yaml": "";
            "ha.pid": "2147483648";
            "vz.pid": "<self>";
            "ha.sock": "<listening>";
          },
        ],
        expected: "stopped",
      ],
      [
        args: [
          backend: Vz,
          files: {
            "lima.yaml": "";
            "ha.pid": "99999999999999999999";
            "vz.pid": "<self>";
            "ha.sock": "<listening>";
          },
        ],
        expected: "stopped",
      ],
      /** (a pid, and more past what a pid file holds) */
      [
        args: [
          backend: Vz,
          files: {
            "lima.yaml": "";
            "ha.pid": "<self>                        \n1";
            "vz.pid": "<self>";
          },
        ],
        expected: "stopped",
      ],
    ]
  >;
  /** pid files from before this boot of the Mac name nothing, though their number is alive
   *  now: the control is the first row above, the same files written now */
  export type BeforeThisBoot = Expect<
    Invoke<
      typeof statusOf,
      [
        backend: Vz,
        files: {
          "lima.yaml": "";
          "ha.pid": "<self>\n";
          "vz.pid": "<self>\n";
          "ha.sock": "<listening>";
        },
        written: "before this boot",
      ]
    >,
    "=",
    "stopped"
  >;
  /** the control for "starts nothing": the same watch sees a limactl the backend does start */
  export type WatchSeesLimactl = Throws<
    Invoke<
      typeof statusOf,
      [backend: Vz, files: { "lima.yaml": "" }, written: undefined, first: "stop"]
    >,
    "limactl was started: --tty=false stop dsl-main-status"
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
    // vz: Lima's own Ubuntu template (a dated image by digest, or the latest release with no
    // digest once that one is gone), provisioned once by image/provision.sh.
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
  /** The one line a session hands the shell sshd starts in the VM: in `cwd` (/ unless said),
   *  with `env` set, `argv` exactly as given (after `sudo`, for root), every word quoted so
   *  that it arrives as the one word it was, whatever it holds. ssh passes a command as one
   *  string, where `limactl shell` took words and quoted them itself. */
  const commandLine = (argv: string[], options: ExecOptions, sudo: boolean, totalMs?: number) => {
    const vars = Object.entries(options.env ?? {}).map(([key, value]) => `${key}=${value}`);
    const words = [...(sudo ? ["sudo"] : []), ...bounded(totalMs), "env", ...vars, ...argv];
    return `cd ${quote(options.cwd ?? "/")} && exec ${words.map(quote).join(" ")}`;
  };
  /** A command exec runs with a total (`timeoutMs`, `totalMs` here) is held to it in the VM too: ending the ssh on this
   *  side leaves the program in the VM running (measured on the M1, 2026-11-23, for ssh and
   *  `limactl shell` alike, with no terminal), so a call made on a timer into a VM that is
   *  stuck would pile its programs up there. coreutils' `timeout`, in every VM's image: the
   *  whole second past the Mac's bound, so the Mac's says why first (and a 124 or 137 of its
   *  own reaches no caller then, which none reads apart from any other failure); TERM, then
   *  KILL five seconds on, to the command's process group, which is what it started. As root
   *  it runs under sudo, so that it may end what it runs. Its command reads stdin as before:
   *  it is in a group of its own, which matters only to a terminal, and these have none. A
   *  call with no total (streamed, held, dial's socat, attach) is meant to last as long as it
   *  is wanted; socat ends when its stdin closes. */
  const bounded = (totalMs?: number) =>
    totalMs
      ? ["timeout", "--signal=TERM", "--kill-after=5", String(Math.ceil(totalMs / 1000) + 1)]
      : [];
  /** Root in the ROOT VM is reached by ssh as root, with Lima's key for this home (on the
   *  host only), on its own control socket: never through the VM's login user, which runs
   *  everything there that reads a domain's data and has no sudo (root/start.sh). */
  const rootSshArgs = (name: string, argv: string[], options: ExecOptions, totalMs?: number) => {
    const command = commandLine(argv, options, false, totalMs);
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
      const put = await run(
        "ssh",
        sessionArgs(name, [
          "sudo",
          "-n",
          "bash",
          "-c",
          "install -d -m 0700 -o root -g root /root/.ssh && cat >/root/.ssh/authorized_keys.new && chmod 0600 /root/.ssh/authorized_keys.new && mv /root/.ssh/authorized_keys.new /root/.ssh/authorized_keys",
        ]),
        { env: env(), input: pub + "\n", timeoutMs: 60_000 },
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
  // By its name too: a record that cannot be read just now must not send root's command
  // through the login user's sudo, where that user's own PATH would run it.
  const isRootVm = (name: string) =>
    name === rootVmName(INSTANCE) || meta(name)?.spec.role === "root";

  /** A session in a VM as its login user (root by `sudo`, `options.root`): ssh with the
   *  configuration Lima writes for the VM, on Lima's own control connection (its ssh.config
   *  names it), where `limactl shell` was a Go program of 87 MB that built the same ssh and
   *  waited on it (measured on the M1, 2026-11-23, Lima 2.3.0: `limactl shell <vm> true`
   *  77 ms and 87 MB at its peak; the same command over ssh 8 ms and 1.5 MB).
   *
   *  - The command runs in a login shell, `"$SHELL" -l -c`, as limactl ran it: the VMs'
   *    profiles hold what their commands rely on. The git VM's (git/provision.sh) sets
   *    GIT_NO_LAZY_FETCH, so that a fetch from a mirror or a root's clone, whose config is
   *    the root's user's, fetches nothing further; the root's (root/start.sh) gives its login
   *    user the root's git config. A person's `desolate exec` gets the shell a login gives.
   *  - `-T`: no terminal, unless `terminal` (a person's, for `attach`). limactl 2.3.0 asked for
   *    one only when its own stdout was a terminal, which attach never gave it (piped to the
   *    filter, or not a terminal at all), so a session had none.
   *  - LogLevel=ERROR, as limactl set it: ssh's own notices are not the command's output.
   *  - Nothing of this Mac's environment goes: ssh sends a variable only where SendEnv names
   *    it, which neither this nor Lima's ssh.config does, and with -F no other ssh
   *    configuration is read.
   *  - `name` comes checked: exec, spawn, attach and dial ask `named` first, and the rest pass
   *    names this backend made. */
  const sessionArgs = (
    name: string,
    argv: string[],
    options: ExecOptions = {},
    { terminal = false, totalMs }: { terminal?: boolean; totalMs?: number } = {},
  ): string[] => [
    "-F",
    path.join(LIMA_HOME, name, "ssh.config"),
    "-o",
    "LogLevel=ERROR",
    terminal ? "-t" : "-T",
    `lima-${name}`,
    "--",
    `exec "$SHELL" -l -c ${quote(commandLine(argv, options, options.root === true, totalMs))}`,
  ];
  /** `name`, if it is one of this stack's VMs' names (`PREFIX`, then a VM's own part, as
   *  shared/names.ts and templates.ts make them): else a refusal, before it is used. */
  const named = (name: string) => {
    if (!new RegExp(`^${PREFIX}[a-z0-9][a-z0-9-]{0,39}$`).test(name))
      throw new Error(`refused a session in '${printable(name, 80)}': not a VM of this stack`);
    return name;
  };
  /** Why no session can be had in a VM now, or null: it is not running (`up`), or it is and
   *  Lima's ssh configuration for it is not there. Said as desolate says it, with what to do,
   *  where limactl said "instance ... is stopped, run `limactl start`" and ssh would say
   *  only that it could not connect. */
  const unreachable = (name: string, up: boolean): string | null => {
    if (!up) {
      const m = meta(name);
      const labels = m?.spec.labels ?? {};
      const fix =
        m?.spec.role === "workspace" && labels.domain && labels.workspace
          ? `desolate start ${labels.domain}/${labels.workspace}`
          : m?.spec.role === "git"
            ? "desolate git"
            : "desolate bootstrap";
      return `${labels.title ?? name} is not running; start it: ${fix}`;
    }
    const config = path.join(LIMA_HOME, name, "ssh.config");
    if (!fs.existsSync(config))
      return `${name} is running, but Lima's ssh configuration for it (${config}) is not there: desolate doctor`;
    return null;
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
   *  is mounted the wrong way, or is still missing after a minute. One session, which waits
   *  in the VM (sharesWait: a minute of the VM's clock, which does not run while the Mac
   *  sleeps) and answers once they are there; it was a session every 250 ms. Mounting is the
   *  guest's own first step after ssh answers (measured on the M1: under a second), so a
   *  share missing after a minute is not late. A session that fails is tried again within
   *  the minute. */
  const sharesReady = async (name: string, m: Meta) => {
    const fsType = kind === "qemu" ? "9p" : "virtiofs";
    const guests = m.spec.shares.map((share) => share.guest);
    let last = { missing: guests, wrong: [] as string[] };
    for (const began = performance.now(); performance.now() - began <= 60_000;) {
      const left = Math.max(1, Math.ceil((60_000 - (performance.now() - began)) / 1000));
      const totalMs = (left + 10) * 1000;
      const mounts = await run(
        "ssh",
        sessionArgs(name, sharesWait(guests, fsType, left), {}, { totalMs }),
        { env: env(), timeoutMs: totalMs },
      );
      if (mounts.code === 0) {
        last = unmounted(mounts.stdout, m.spec.shares, fsType, kind === "vz");
        if (last.wrong.length + last.missing.length === 0) return;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
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
      checks.push({
        name: "socket paths fit",
        ok: Buffer.byteLength(longest) <= SOCKET_PATH_MAX,
        detail:
          Buffer.byteLength(longest) <= SOCKET_PATH_MAX
            ? `the longest fits in ${SOCKET_PATH_MAX} bytes`
            : `the longest is ${Buffer.byteLength(longest)} bytes, over ${SOCKET_PATH_MAX}: ${LIMA_HOME}`,
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
          "ssh",
          sessionArgs(BASE, ["bash", "/desolate/release/image/provision.sh"], {
            root: true,
            env: { DESOLATE_IMAGE_KIND: "vm", DESOLATE_IMAGE_FINGERPRINT: fingerprint },
          }),
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
      // vz: boot Lima's Ubuntu image once, provision it with the same script the
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
    async destroy(name) {
      await lima(["delete", "-f", name], { timeoutMs: 300_000 });
      fs.rmSync(path.join(LIMA_HOME, name), { recursive: true, force: true });
    },

    async info(name): Promise<VmInfo> {
      const m = meta(name);
      return {
        name,
        status: await vmStatus(path.join(LIMA_HOME, name), kind),
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
      const why = unreachable(
        named(name),
        (await vmStatus(path.join(LIMA_HOME, name), kind)) === "running",
      );
      if (why) return { code: 1, stdout: "", stderr: `${why}\n` };
      const asRoot = options.root === true && isRootVm(name);
      if (asRoot) await ensureRootSsh(name);
      // A long step a person waits on, or an archive: streamed, and under no timer (stream.ts),
      // here or in the VM.
      const streamed = Boolean(options.lines || options.stdoutTo || options.stdinFrom);
      const totalMs = streamed ? undefined : options.timeoutMs;
      const args = asRoot
        ? rootSshArgs(name, argv, options, totalMs)
        : sessionArgs(name, argv, options, { totalMs });
      if (streamed)
        return runStreamed("ssh", args, {
          env: env(),
          input: options.input,
          lines: options.lines,
          stdoutTo: options.stdoutTo,
          stdinFrom: options.stdinFrom,
        });
      return run("ssh", args, {
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
      // (Asked by the VM's processes alone: a spawn is answered at once, and the socket's
      // answer is not. A host agent gone while its pid lives on leaves ssh to say so.) Refused,
      // it is a session that ended saying why: a real one, so it ends as any child does.
      const why = unreachable(named(name), processesUp(path.join(LIMA_HOME, name), kind));
      if (why)
        return spawn("sh", ["-c", 'printf "%s\\n" "$1" >&2; exit 1', "sh", why], {
          stdio: ["pipe", "pipe", "pipe"],
        });
      // Root in the root VM: ssh as root with this home's key, as exec reaches it, never
      // through the login user. On exec's shared connection: a session held open (a review,
      // as long as a person reads a push) starves nothing there, where sshd allows a thousand
      // (root/start.sh), and this ssh is a client of it, so ending it ends its session alone.
      // Root's key is put there at bootstrap (ensureRootSsh); until then ssh is refused, and
      // the child fails saying so.
      if (options.root && isRootVm(name))
        return spawn("ssh", rootSshArgs(name, argv, options), {
          stdio: ["pipe", "pipe", "pipe"],
          env: env(),
        });
      return spawn("ssh", sessionArgs(name, argv, options), {
        stdio: ["pipe", "pipe", "pipe"],
        env: env(),
      });
    },

    async attach(name, argv, options = {}) {
      const why = unreachable(
        named(name),
        (await vmStatus(path.join(LIMA_HOME, name), kind)) === "running",
      );
      if (why) {
        process.stderr.write(`desolate: ${why}\n`);
        return 1;
      }
      // A terminal for the VM's program when a person is at one, both ways (its prompt, its
      // line editing, Ctrl-C to the program in the VM); what it prints filtered (attach.ts).
      const terminal = process.stdin.isTTY === true && process.stdout.isTTY === true;
      return attachFiltered(
        "ssh",
        sessionArgs(name, argv, { cwd: options.cwd }, { terminal }),
        env(),
      );
    },

    dial(name, target) {
      // A session running socat, as the fake backend's `docker exec` does. ssh's own stdio
      // forwarding (`ssh -W`) through Lima's control connection was refused when first tried
      // and worked on Lima 2.3.0 in a workspace VM (2026-11-23), but reaches TCP only, and a
      // target may be a unix socket in the VM (a workspace's proxy). Refused by the VM's
      // processes alone, as spawn is: a connection is answered at once.
      const why = unreachable(named(name), processesUp(path.join(LIMA_HOME, name), kind));
      if (why) throw new Error(why);
      return duplexOf(
        spawn("ssh", sessionArgs(name, ["socat", "STDIO", socatAddress(target)]), {
          stdio: ["pipe", "pipe", "ignore"],
          env: env(),
        }),
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
        : await run(
            "ssh",
            sessionArgs(name, ["bash", "-c", 'test "$(id -G)" = "$(id -G "$(id -un)")"']),
            { env: env(), timeoutMs: 60_000 },
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

  /** A session into a VM is ssh with Lima's configuration for it and one command line, in
   *  which every argument is quoted to arrive as the one word it was: \`ssh\` is the harness's
   *  stand-in, which writes down its arguments and runs the line in this machine's /bin/sh,
   *  so each row shows both the exact argv and what the line ran (printf prints each word it
   *  was given, ended by a NUL). Each row would fail if a word were split, joined, expanded
   *  or run; the first is the control. */
  export type Sessions = Table<
    typeof sessionOf,
    [
      /** the control: a plain word arrives as it was, and the line ssh is given names no SendEnv or SetEnv: nothing of this Mac's environment goes */
      [
        args: [
          backend: Vz,
          call: "exec",
          name: "dsl-main-w1",
          argv: ["printf", "%s\\0", "plain"],
          options: {},
        ],
        expected: {
          ssh: [
            [
              "-F",
              "<home>/lima/dsl-main-w1/ssh.config",
              "-o",
              "LogLevel=ERROR",
              "-T",
              "lima-dsl-main-w1",
              "--",
              "exec \"$SHELL\" -l -c 'cd '\\''/'\\'' && exec '\\''env'\\'' '\\''printf'\\'' '\\''%s\\0'\\'' '\\''plain'\\'''",
            ],
          ];
          said: ["plain"];
          code: 0;
          stderr: "";
        },
      ],
      /** a space */
      [
        args: [
          backend: Vz,
          call: "exec",
          name: "dsl-main-w1",
          argv: ["printf", "%s\\0", "two words"],
          options: {},
        ],
        expected: {
          ssh: [
            [
              "-F",
              "<home>/lima/dsl-main-w1/ssh.config",
              "-o",
              "LogLevel=ERROR",
              "-T",
              "lima-dsl-main-w1",
              "--",
              "exec \"$SHELL\" -l -c 'cd '\\''/'\\'' && exec '\\''env'\\'' '\\''printf'\\'' '\\''%s\\0'\\'' '\\''two words'\\'''",
            ],
          ];
          said: ["two words"];
          code: 0;
          stderr: "";
        },
      ],
      /** a single quote */
      [
        args: [
          backend: Vz,
          call: "exec",
          name: "dsl-main-w1",
          argv: ["printf", "%s\\0", "it's"],
          options: {},
        ],
        expected: {
          ssh: [
            [
              "-F",
              "<home>/lima/dsl-main-w1/ssh.config",
              "-o",
              "LogLevel=ERROR",
              "-T",
              "lima-dsl-main-w1",
              "--",
              "exec \"$SHELL\" -l -c 'cd '\\''/'\\'' && exec '\\''env'\\'' '\\''printf'\\'' '\\''%s\\0'\\'' '\\''it'\\''\\'\\'''\\''s'\\'''",
            ],
          ];
          said: ["it's"];
          code: 0;
          stderr: "";
        },
      ],
      /** double quotes */
      [
        args: [
          backend: Vz,
          call: "exec",
          name: "dsl-main-w1",
          argv: ["printf", "%s\\0", 'say "hi"'],
          options: {},
        ],
        expected: {
          ssh: [
            [
              "-F",
              "<home>/lima/dsl-main-w1/ssh.config",
              "-o",
              "LogLevel=ERROR",
              "-T",
              "lima-dsl-main-w1",
              "--",
              "exec \"$SHELL\" -l -c 'cd '\\''/'\\'' && exec '\\''env'\\'' '\\''printf'\\'' '\\''%s\\0'\\'' '\\''say \"hi\"'\\'''",
            ],
          ];
          said: ['say "hi"'];
          code: 0;
          stderr: "";
        },
      ],
      /** a command substitution */
      [
        args: [
          backend: Vz,
          call: "exec",
          name: "dsl-main-w1",
          argv: ["printf", "%s\\0", "$(echo injected)"],
          options: {},
        ],
        expected: {
          ssh: [
            [
              "-F",
              "<home>/lima/dsl-main-w1/ssh.config",
              "-o",
              "LogLevel=ERROR",
              "-T",
              "lima-dsl-main-w1",
              "--",
              "exec \"$SHELL\" -l -c 'cd '\\''/'\\'' && exec '\\''env'\\'' '\\''printf'\\'' '\\''%s\\0'\\'' '\\''$(echo injected)'\\'''",
            ],
          ];
          said: ["$(echo injected)"];
          code: 0;
          stderr: "";
        },
      ],
      /** backticks */
      [
        args: [
          backend: Vz,
          call: "exec",
          name: "dsl-main-w1",
          argv: ["printf", "%s\\0", "`echo injected`"],
          options: {},
        ],
        expected: {
          ssh: [
            [
              "-F",
              "<home>/lima/dsl-main-w1/ssh.config",
              "-o",
              "LogLevel=ERROR",
              "-T",
              "lima-dsl-main-w1",
              "--",
              "exec \"$SHELL\" -l -c 'cd '\\''/'\\'' && exec '\\''env'\\'' '\\''printf'\\'' '\\''%s\\0'\\'' '\\''`echo injected`'\\'''",
            ],
          ];
          said: ["`echo injected`"];
          code: 0;
          stderr: "";
        },
      ],
      /** a semicolon */
      [
        args: [
          backend: Vz,
          call: "exec",
          name: "dsl-main-w1",
          argv: ["printf", "%s\\0", "; echo injected"],
          options: {},
        ],
        expected: {
          ssh: [
            [
              "-F",
              "<home>/lima/dsl-main-w1/ssh.config",
              "-o",
              "LogLevel=ERROR",
              "-T",
              "lima-dsl-main-w1",
              "--",
              "exec \"$SHELL\" -l -c 'cd '\\''/'\\'' && exec '\\''env'\\'' '\\''printf'\\'' '\\''%s\\0'\\'' '\\''; echo injected'\\'''",
            ],
          ];
          said: ["; echo injected"];
          code: 0;
          stderr: "";
        },
      ],
      /** an and */
      [
        args: [
          backend: Vz,
          call: "exec",
          name: "dsl-main-w1",
          argv: ["printf", "%s\\0", "&& echo injected"],
          options: {},
        ],
        expected: {
          ssh: [
            [
              "-F",
              "<home>/lima/dsl-main-w1/ssh.config",
              "-o",
              "LogLevel=ERROR",
              "-T",
              "lima-dsl-main-w1",
              "--",
              "exec \"$SHELL\" -l -c 'cd '\\''/'\\'' && exec '\\''env'\\'' '\\''printf'\\'' '\\''%s\\0'\\'' '\\''&& echo injected'\\'''",
            ],
          ];
          said: ["&& echo injected"];
          code: 0;
          stderr: "";
        },
      ],
      /** a newline */
      [
        args: [
          backend: Vz,
          call: "exec",
          name: "dsl-main-w1",
          argv: ["printf", "%s\\0", "line\necho injected"],
          options: {},
        ],
        expected: {
          ssh: [
            [
              "-F",
              "<home>/lima/dsl-main-w1/ssh.config",
              "-o",
              "LogLevel=ERROR",
              "-T",
              "lima-dsl-main-w1",
              "--",
              "exec \"$SHELL\" -l -c 'cd '\\''/'\\'' && exec '\\''env'\\'' '\\''printf'\\'' '\\''%s\\0'\\'' '\\''line\necho injected'\\'''",
            ],
          ];
          said: ["line\necho injected"];
          code: 0;
          stderr: "";
        },
      ],
      /** a tab */
      [
        args: [
          backend: Vz,
          call: "exec",
          name: "dsl-main-w1",
          argv: ["printf", "%s\\0", "a\tb"],
          options: {},
        ],
        expected: {
          ssh: [
            [
              "-F",
              "<home>/lima/dsl-main-w1/ssh.config",
              "-o",
              "LogLevel=ERROR",
              "-T",
              "lima-dsl-main-w1",
              "--",
              "exec \"$SHELL\" -l -c 'cd '\\''/'\\'' && exec '\\''env'\\'' '\\''printf'\\'' '\\''%s\\0'\\'' '\\''a\tb'\\'''",
            ],
          ];
          said: ["a\tb"];
          code: 0;
          stderr: "";
        },
      ],
      /** a leading dash */
      [
        args: [
          backend: Vz,
          call: "exec",
          name: "dsl-main-w1",
          argv: ["printf", "%s\\0", "-n"],
          options: {},
        ],
        expected: {
          ssh: [
            [
              "-F",
              "<home>/lima/dsl-main-w1/ssh.config",
              "-o",
              "LogLevel=ERROR",
              "-T",
              "lima-dsl-main-w1",
              "--",
              "exec \"$SHELL\" -l -c 'cd '\\''/'\\'' && exec '\\''env'\\'' '\\''printf'\\'' '\\''%s\\0'\\'' '\\''-n'\\'''",
            ],
          ];
          said: ["-n"];
          code: 0;
          stderr: "";
        },
      ],
      /** an empty string */
      [
        args: [
          backend: Vz,
          call: "exec",
          name: "dsl-main-w1",
          argv: ["printf", "%s\\0", ""],
          options: {},
        ],
        expected: {
          ssh: [
            [
              "-F",
              "<home>/lima/dsl-main-w1/ssh.config",
              "-o",
              "LogLevel=ERROR",
              "-T",
              "lima-dsl-main-w1",
              "--",
              "exec \"$SHELL\" -l -c 'cd '\\''/'\\'' && exec '\\''env'\\'' '\\''printf'\\'' '\\''%s\\0'\\'' '\\'''\\'''",
            ],
          ];
          said: [""];
          code: 0;
          stderr: "";
        },
      ],
      /** a glob */
      [
        args: [
          backend: Vz,
          call: "exec",
          name: "dsl-main-w1",
          argv: ["printf", "%s\\0", "*"],
          options: {},
        ],
        expected: {
          ssh: [
            [
              "-F",
              "<home>/lima/dsl-main-w1/ssh.config",
              "-o",
              "LogLevel=ERROR",
              "-T",
              "lima-dsl-main-w1",
              "--",
              "exec \"$SHELL\" -l -c 'cd '\\''/'\\'' && exec '\\''env'\\'' '\\''printf'\\'' '\\''%s\\0'\\'' '\\''*'\\'''",
            ],
          ];
          said: ["*"];
          code: 0;
          stderr: "";
        },
      ],
      /** a tilde */
      [
        args: [
          backend: Vz,
          call: "exec",
          name: "dsl-main-w1",
          argv: ["printf", "%s\\0", "~"],
          options: {},
        ],
        expected: {
          ssh: [
            [
              "-F",
              "<home>/lima/dsl-main-w1/ssh.config",
              "-o",
              "LogLevel=ERROR",
              "-T",
              "lima-dsl-main-w1",
              "--",
              "exec \"$SHELL\" -l -c 'cd '\\''/'\\'' && exec '\\''env'\\'' '\\''printf'\\'' '\\''%s\\0'\\'' '\\''~'\\'''",
            ],
          ];
          said: ["~"];
          code: 0;
          stderr: "";
        },
      ],
      /** a name not in ASCII */
      [
        args: [
          backend: Vz,
          call: "exec",
          name: "dsl-main-w1",
          argv: ["printf", "%s\\0", "café-日本"],
          options: {},
        ],
        expected: {
          ssh: [
            [
              "-F",
              "<home>/lima/dsl-main-w1/ssh.config",
              "-o",
              "LogLevel=ERROR",
              "-T",
              "lima-dsl-main-w1",
              "--",
              "exec \"$SHELL\" -l -c 'cd '\\''/'\\'' && exec '\\''env'\\'' '\\''printf'\\'' '\\''%s\\0'\\'' '\\''café-日本'\\'''",
            ],
          ];
          said: ["café-日本"];
          code: 0;
          stderr: "";
        },
      ],
      /** 100 KiB in one argument */
      [
        args: [
          backend: Vz,
          call: "exec",
          name: "dsl-main-w1",
          argv: ["printf", "%s\\0", "<100k>"],
          options: {},
        ],
        expected: {
          ssh: [
            [
              "-F",
              "<home>/lima/dsl-main-w1/ssh.config",
              "-o",
              "LogLevel=ERROR",
              "-T",
              "lima-dsl-main-w1",
              "--",
              "exec \"$SHELL\" -l -c 'cd '\\''/'\\'' && exec '\\''env'\\'' '\\''printf'\\'' '\\''%s\\0'\\'' '\\''<100k>'\\'''",
            ],
          ];
          said: ["<100k>"];
          code: 0;
          stderr: "";
        },
      ],
      /** a working directory with a space and a quote: the command runs there */
      [
        args: [
          backend: Vz,
          call: "exec",
          name: "dsl-main-w1",
          argv: ["pwd"],
          options: { cwd: "<home>/a b'c" },
        ],
        expected: {
          ssh: [
            [
              "-F",
              "<home>/lima/dsl-main-w1/ssh.config",
              "-o",
              "LogLevel=ERROR",
              "-T",
              "lima-dsl-main-w1",
              "--",
              "exec \"$SHELL\" -l -c 'cd '\\''<home>/a b'\\''\\'\\'''\\''c'\\'' && exec '\\''env'\\'' '\\''pwd'\\'''",
            ],
          ];
          said: ["<home>/a b'c\n"];
          code: 0;
          stderr: "";
        },
      ],
      /** an environment value holding = and a quote arrives whole */
      [
        args: [
          backend: Vz,
          call: "exec",
          name: "dsl-main-w1",
          argv: ["printenv", "K"],
          options: { env: { K: "a=b'c" } },
        ],
        expected: {
          ssh: [
            [
              "-F",
              "<home>/lima/dsl-main-w1/ssh.config",
              "-o",
              "LogLevel=ERROR",
              "-T",
              "lima-dsl-main-w1",
              "--",
              "exec \"$SHELL\" -l -c 'cd '\\''/'\\'' && exec '\\''env'\\'' '\\''K=a=b'\\''\\'\\'''\\''c'\\'' '\\''printenv'\\'' '\\''K'\\'''",
            ],
          ];
          said: ["a=b'c\n"];
          code: 0;
          stderr: "";
        },
      ],
      /** root in a workspace VM: by sudo, the command quoted the same */
      [
        args: [
          backend: Vz,
          call: "exec",
          name: "dsl-main-w1",
          argv: ["printf", "%s\\0", "as root"],
          options: { root: true },
        ],
        expected: {
          ssh: [
            [
              "-F",
              "<home>/lima/dsl-main-w1/ssh.config",
              "-o",
              "LogLevel=ERROR",
              "-T",
              "lima-dsl-main-w1",
              "--",
              "exec \"$SHELL\" -l -c 'cd '\\''/'\\'' && exec '\\''sudo'\\'' '\\''env'\\'' '\\''printf'\\'' '\\''%s\\0'\\'' '\\''as root'\\'''",
            ],
          ];
          said: ["as root"];
          code: 0;
          stderr: "";
        },
      ],
      /** root in the root VM: ssh as root on its own control socket (rootSshArgs), its key looked at first */
      [
        args: [
          backend: Vz,
          call: "exec",
          name: "dsl-main-root",
          argv: ["printf", "%s\\0", "as root"],
          options: { root: true },
        ],
        expected: {
          ssh: [
            [
              "-F",
              "<home>/lima/dsl-main-root/ssh.config",
              "-o",
              "ControlPath=<home>/lima/dsl-main-root/ssh-root.sock",
              "-o",
              "ControlMaster=auto",
              "-o",
              "ControlPersist=60",
              "-l",
              "root",
              "lima-dsl-main-root",
              "--",
              "cd '/' && exec 'env' 'true'",
            ],
            [
              "-F",
              "<home>/lima/dsl-main-root/ssh.config",
              "-o",
              "ControlPath=<home>/lima/dsl-main-root/ssh-root.sock",
              "-o",
              "ControlMaster=auto",
              "-o",
              "ControlPersist=60",
              "-l",
              "root",
              "lima-dsl-main-root",
              "--",
              "cd '/' && exec 'env' 'printf' '%s\\0' 'as root'",
            ],
          ];
          said: ["as root"];
          code: 0;
          stderr: "";
        },
      ],
      /** spawn: the same session, live */
      [
        args: [
          backend: Vz,
          call: "spawn",
          name: "dsl-main-w1",
          argv: ["printf", "%s\\0", "spawned"],
          options: {},
        ],
        expected: {
          ssh: [
            [
              "-F",
              "<home>/lima/dsl-main-w1/ssh.config",
              "-o",
              "LogLevel=ERROR",
              "-T",
              "lima-dsl-main-w1",
              "--",
              "exec \"$SHELL\" -l -c 'cd '\\''/'\\'' && exec '\\''env'\\'' '\\''printf'\\'' '\\''%s\\0'\\'' '\\''spawned'\\'''",
            ],
          ];
          said: ["spawned"];
          code: 0;
          stderr: "";
        },
      ],
      /** attach with no person at a terminal: no terminal asked for */
      [
        args: [backend: Vz, call: "attach", name: "dsl-main-w1", argv: ["true"], options: {}],
        expected: {
          ssh: [
            [
              "-F",
              "<home>/lima/dsl-main-w1/ssh.config",
              "-o",
              "LogLevel=ERROR",
              "-T",
              "lima-dsl-main-w1",
              "--",
              "exec \"$SHELL\" -l -c 'cd '\\''/'\\'' && exec '\\''env'\\'' '\\''true'\\'''",
            ],
          ];
          said: [];
          code: 0;
          stderr: "";
        },
      ],
      /** attach with a person at a terminal: one asked for (-t) */
      [
        args: [
          backend: Vz,
          call: "attach",
          name: "dsl-main-w1",
          argv: ["true"],
          options: { terminal: true },
        ],
        expected: {
          ssh: [
            [
              "-F",
              "<home>/lima/dsl-main-w1/ssh.config",
              "-o",
              "LogLevel=ERROR",
              "-t",
              "lima-dsl-main-w1",
              "--",
              "exec \"$SHELL\" -l -c 'cd '\\''/'\\'' && exec '\\''env'\\'' '\\''true'\\'''",
            ],
          ];
          said: [];
          code: 0;
          stderr: "";
        },
      ],
      /** dial: socat in a session, to the VM's loopback port */
      [
        args: [backend: Vz, call: "dial", name: "dsl-main-w1", argv: ["8080"], options: {}],
        expected: {
          ssh: [
            [
              "-F",
              "<home>/lima/dsl-main-w1/ssh.config",
              "-o",
              "LogLevel=ERROR",
              "-T",
              "lima-dsl-main-w1",
              "--",
              "exec \"$SHELL\" -l -c 'cd '\\''/'\\'' && exec '\\''env'\\'' '\\''socat'\\'' '\\''STDIO'\\'' '\\''TCP:127.0.0.1:8080'\\'''",
            ],
          ];
          said: [];
          code: 0;
          stderr: "";
        },
      ],
    ]
  >;
  /** exec with a total runs its command under `timeout` in the VM, a second past the Mac's
   *  bound (15 s: 16); the rows above, with none, do not */
  export type Bounded = Expect<
    Invoke<
      typeof sessionOf,
      [
        backend: Vz,
        call: "exec",
        name: "dsl-main-w1",
        argv: ["cat"],
        options: { timeoutMs: 15000; apart: true },
      ]
    >,
    "=",
    {
      ssh: [
        [
          "-F",
          "<home>/lima/dsl-main-w1/ssh.config",
          "-o",
          "LogLevel=ERROR",
          "-T",
          "lima-dsl-main-w1",
          "--",
          "exec \"$SHELL\" -l -c 'cd '\\''/'\\'' && exec '\\''timeout'\\'' '\\''--signal=TERM'\\'' '\\''--kill-after=5'\\'' '\\''16'\\'' '\\''env'\\'' '\\''cat'\\'''",
        ],
      ];
      said: [];
      code: 0;
      stderr: "";
    }
  >;
  /** what that line does in the VM once the Mac has let go of it (its ssh ended, the program
   *  left running there): one that sleeps past its bound is gone, ended by `timeout` with its
   *  124; one that finishes in time keeps its own exit code and reads its stdin, as without
   *  it; and the control, a program that leaves one behind, shows that one left would be
   *  seen. Run with this machine's own GNU `timeout`, as every VM has it: skipped where there
   *  is none (macOS has none of its own). */
  export type BoundInTheVm = SkipIfNotFound<
    "/usr/bin/timeout",
    Table<
      typeof alone,
      [
        [
          args: [
            backend: Vz,
            argv: ["sh", "-c", "cat; exit 3"],
            options: { timeoutMs: 15000; input: "from stdin" },
          ],
          expected: { code: 3; said: ["from stdin"]; left: false },
        ],
        [
          args: [
            backend: Vz,
            argv: ["sh", "-c", 'echo $$ > "$1"; exec sleep 30', "sh", "<pid>"],
            options: { timeoutMs: 100 },
          ],
          expected: { code: 124; said: []; left: false },
        ],
        [
          args: [
            backend: Vz,
            argv: ["sh", "-c", 'sleep 30 >/dev/null 2>&1 & echo $! > "$1"', "sh", "<pid>"],
            options: { timeoutMs: 100 },
          ],
          expected: { code: 0; said: []; left: true },
        ],
      ]
    >
  >;
  /** a VM that is not running is refused before any session starts (no ssh is started), in
   *  desolate's words with its fix, not Lima's or ssh's; the rows above, of a running VM, are
   *  the control */
  export type NotRunning = Table<
    typeof sessionOf,
    [
      /** exec: a failed command, saying so */
      [
        args: [
          backend: Vz,
          call: "exec",
          name: "dsl-main-w1",
          argv: ["true"],
          options: {},
          vm: "stopped",
        ],
        expected: {
          ssh: [];
          said: [];
          code: 1;
          stderr: "acme/w1 is not running; start it: desolate start acme/w1\n";
        },
      ],
      /** spawn: a child that ends saying so */
      [
        args: [
          backend: Vz,
          call: "spawn",
          name: "dsl-main-w1",
          argv: ["true"],
          options: {},
          vm: "stopped",
        ],
        expected: {
          ssh: [];
          said: [];
          code: 1;
          stderr: "acme/w1 is not running; start it: desolate start acme/w1\n";
        },
      ],
      /** attach: said to the person, as desolate says a refusal */
      [
        args: [
          backend: Vz,
          call: "attach",
          name: "dsl-main-w1",
          argv: ["true"],
          options: {},
          vm: "stopped",
        ],
        expected: {
          ssh: [];
          said: [];
          code: 1;
          stderr: "desolate: acme/w1 is not running; start it: desolate start acme/w1\n";
        },
      ],
      /** the root VM's fix is bootstrap */
      [
        args: [
          backend: Vz,
          call: "exec",
          name: "dsl-main-root",
          argv: ["true"],
          options: {},
          vm: "stopped",
        ],
        expected: {
          ssh: [];
          said: [];
          code: 1;
          stderr: "dsl-main-root is not running; start it: desolate bootstrap\n";
        },
      ],
      /** a VM that runs without Lima's ssh configuration is its own refusal */
      [
        args: [
          backend: Vz,
          call: "exec",
          name: "dsl-main-w1",
          argv: ["true"],
          options: {},
          vm: "no ssh.config",
        ],
        expected: {
          ssh: [];
          said: [];
          code: 1;
          stderr: "dsl-main-w1 is running, but Lima's ssh configuration for it (<home>/lima/dsl-main-w1/ssh.config) is not there: desolate doctor\n";
        },
      ],
    ]
  >;
  /** dial refuses by throwing, which the forwarder takes as a connection that closes */
  export type DialNotRunning = Throws<
    Invoke<
      typeof sessionOf,
      [backend: Vz, call: "dial", name: "dsl-main-w1", argv: ["8080"], options: {}, vm: "stopped"]
    >,
    "acme/w1 is not running; start it: desolate start acme/w1"
  >;
  /** a name is one of this stack's VMs' before it becomes a path or ssh's host: none that
   *  climbs out of Lima's home, names a folder in it, is an option, or is another stack's */
  export type NotAVmName = [
    Throws<
      Invoke<typeof sessionOf, [backend: Vz, call: "exec", name: "dsl-main-../x", argv: ["true"]]>,
      "refused a session in 'dsl-main-../x': not a VM of this stack"
    >,
    Throws<
      Invoke<typeof sessionOf, [backend: Vz, call: "spawn", name: "dsl-main-a/b", argv: ["true"]]>,
      "refused a session in 'dsl-main-a/b': not a VM of this stack"
    >,
    Throws<
      Invoke<
        typeof sessionOf,
        [backend: Vz, call: "dial", name: "-oProxyCommand=x", argv: ["8080"]]
      >,
      "refused a session in '-oProxyCommand=x': not a VM of this stack"
    >,
    Throws<
      Invoke<typeof sessionOf, [backend: Vz, call: "attach", name: "dsl-other-w1", argv: ["true"]]>,
      "refused a session in 'dsl-other-w1': not a VM of this stack"
    >,
  ];

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
}
