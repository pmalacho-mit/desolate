// The VM layer: one interface, two kinds of backend (section 13.2).
//
//   fake   each "VM" is a container. NO hypervisor isolation, and it says so everywhere.
//   vz     Lima's Virtualization.framework driver on a Mac: the product backend, the one there
//          is (desolate runs on macOS only, for now).
//
// Everything above this file is written against `Backend` only. What a backend must enforce
// OUTSIDE the VM (P5), so that root inside it cannot undo it:
//   - a share with writable:false cannot be written;
//   - a VM with egress "none" reaches nothing but the sockets in `sockets`;
//   - nothing in the VM is reachable from the host except through exec() and dial().
import type { ChildProcess } from "node:child_process";
import type { Duplex } from "node:stream";
import type { RunResult } from "../../shared/run.ts";
import type { Invoke, Table, Throws } from "../../../suede.nests/dsl.import.meta.vitest.ts";

export type Share = { host: string; guest: string; writable: boolean };

/** A unix socket the host listens on, shown inside the VM at `guest`. The VM connects; the
 *  host answers. This is a workspace's whole "network link". */
export type SocketLink = { host: string; guest: string };

export type VmSpec = {
  name: string;
  role: "root" | "workspace" | "git";
  /** "open": ordinary outbound network (the root, which reaches the remotes).
   *  "none": no route to anything; only `sockets` lead out. */
  egress: "open" | "none";
  shares: Share[];
  sockets: SocketLink[];
  cpus?: number;
  memoryMiB?: number;
  diskGiB?: number;
  labels: Record<string, string>;
};

export type VmStatus = "running" | "stopped" | "missing";
export type VmInfo = { name: string; status: VmStatus; labels: Record<string, string> };

export type ExecOptions = {
  /** Run as root in the VM. Default: the unprivileged user that owns the shares. */
  root?: boolean;
  input?: string | Buffer;
  env?: Record<string, string>;
  cwd?: string;
  /** A total, past which the command is killed: for callers not yet moved to `signal` and
   *  `idleMs` (shared/run.ts; docs/v3/limits.md, R4). */
  timeoutMs?: number;
  /** Whoever asked went away: the command is ended, and what it started on the host with it. */
  signal?: AbortSignal;
  /** The command is ended when it has said nothing for this long, however long it has run. */
  idleMs?: number;
  /** The most of each stream kept, in bytes (shared/run.ts: RUN_MAX unless said). What runs
   *  in a VM is not trusted: a caller that needs a line of it says so. */
  maxBytes?: number;
  /** Each whole line of its stderr as it comes (shared/run.ts). */
  stderrLines?: (line: string) => void;
  /** A long step a person is waiting on, streamed (host/vm/stream.ts). With any of these
   *  three no timer applies: the command runs until it ends or the person stops it.
   *  `lines`: each line of its stdout as it comes, so the step says what it is doing. */
  lines?: (line: string) => void;
  /** A file on the host the command's stdout is written to as it comes, byte for byte (the
   *  answer's `stdout` is then empty): an archive, whatever its size. */
  stdoutTo?: string;
  /** A file on the host that is the command's stdin. */
  stdinFrom?: string;
};

export type Check = { name: string; ok: boolean; detail: string; fix?: string };

export interface Backend {
  readonly kind: "fake" | "vz";
  /** false for `fake`. Shown on every workspace and checked by `doctor`. */
  readonly isolated: boolean;
  /** What this backend needs on the host, for `doctor` and `bootstrap`. */
  check(): Promise<Check[]>;
  /** Make the base image available (build, fetch or verify it). Idempotent. */
  ensureImage(log: (line: string) => void): Promise<void>;
  /** Why the base is older than this desolate's image (host/image.ts), or null when it is
   *  current or there is none yet. Cheap: no VM is asked. */
  baseStale?(): string | null;
  create(spec: VmSpec): Promise<void>;
  /** A new VM whose disk is a copy-on-write clone of `from`'s, with its own spec. */
  clone(from: string, spec: VmSpec): Promise<void>;
  start(name: string): Promise<void>;
  stop(name: string): Promise<void>;
  /** A stopped VM's size, changed (`desolate resize`): its CPUs and memory, and its disk,
   *  which only grows. */
  resize(name: string, size: { cpus: number; memoryMiB: number; diskGiB: number }): Promise<void>;
  destroy(name: string): Promise<void>;
  info(name: string): Promise<VmInfo>;
  /** Every VM of this instance. */
  list(): Promise<VmInfo[]>;
  exec(name: string, argv: string[], options?: ExecOptions): Promise<RunResult>;
  /** exec() as a live process: stdin, stdout and stderr are pipes. */
  spawn(name: string, argv: string[], options?: ExecOptions): ChildProcess;
  /** Run a command with this process's own stdin, stdout and stderr, and a terminal if this
   *  process has one: a person's shell, or a prompt only a person can answer. */
  attach(name: string, argv: string[], options?: { cwd?: string }): Promise<number>;
  /** Open a connection, from the host, to a port on the VM's loopback or to a unix socket in
   *  the VM (an absolute path: a workspace's proxy, which listens where only its domain's
   *  proxies and the root's user can reach it). */
  dial(name: string, target: number | string): Duplex;
  /** What dial keeps open to a VM, let go: the channel to `target`, or with none every one
   *  and the connection they ride (a workspace that goes, a port no longer listened on); with
   *  no name, every VM's, and any an earlier process left (a daemon that starts or stops). A
   *  backend that keeps nothing between dials has none. */
  release?(name?: string, target?: number | string): void;
  /** A workspace's link to its proxy: the address the guest connects to, and, where the
   *  backend carries it over a loopback port on the host, that port (the host daemon then
   *  listens there as well as on the socket). */
  link(name: string): { guest: string; hostPort?: number; token?: string };
  /** After root in the VM changed the ordinary user's groups (docker in a workspace, the
   *  proxies' group in the root): make the next commands run with them. Lima's sessions
   *  share one ssh connection, and a session keeps the groups that connection logged in
   *  with (found on the M1: `docker` refused every command the host ran). */
  refreshSessions?(name: string, force?: boolean): Promise<void>;
  /** The host's loopback ports this backend's VMs use (ssh, links). Never published for a
   *  workspace: a workspace listening on one must not get the host to bind it, in front of
   *  another VM's ssh or link (found by an audit on the M1). */
  hostPorts?(): Set<number>;
  /** Give every running VM that is known by an ssh host key another VM has one of its own,
   *  made in it; one that cannot be given one is stopped (bootstrap). */
  ownHostKeys?(log: (line: string) => void): Promise<void>;
  /** For a VM that holds no ssh host key desolate recorded for it: forget its record, take
   *  the key it shows once, and give it a new one at once (`desolate host-key`). */
  takeHostKey?(name: string, log: (line: string) => void): Promise<void>;
}

export const GUEST_USER = "desolate";

/** socat's address for a dial target; a port, or a socket path made only of plain names. */
export const socatAddress = (target: number | string): string => {
  if (typeof target === "number") {
    if (!Number.isInteger(target) || target < 1 || target > 65535)
      throw new Error(`bad port ${target}`);
    return `TCP:127.0.0.1:${target}`;
  }
  if (!/^(\/[A-Za-z0-9._-]+)+$/.test(target) || target.includes("/../") || target.length > 200)
    throw new Error("bad socket path");
  return `UNIX-CONNECT:${target}`;
};

declare namespace socatAddress {
  /** a port on the VM's own loopback, or a socket by an absolute path of plain names */
  export type Targets = Table<
    typeof socatAddress,
    [
      [args: [target: 8080], expected: "TCP:127.0.0.1:8080"],
      [
        args: [target: "/desolate/link/proxy.sock"],
        expected: "UNIX-CONNECT:/desolate/link/proxy.sock",
      ],
    ]
  >;
  /** the address is one socat word: nothing in it may reach another host, climb out of its
   *  directory, or add an option */
  export type Refuses = [
    Throws<Invoke<typeof socatAddress, [target: 0]>, "bad port 0">,
    Throws<Invoke<typeof socatAddress, [target: 65536]>, "bad port 65536">,
    Throws<Invoke<typeof socatAddress, [target: 22.5]>, "bad port 22.5">,
    Throws<Invoke<typeof socatAddress, [target: "/desolate/../etc/shadow"]>, "bad socket path">,
    Throws<Invoke<typeof socatAddress, [target: "relative.sock"]>, "bad socket path">,
    Throws<Invoke<typeof socatAddress, [target: "/tmp/x,fork"]>, "bad socket path">,
    Throws<Invoke<typeof socatAddress, [target: "/tmp/a:b"]>, "bad socket path">,
    Throws<Invoke<typeof socatAddress, [target: "/tmp/a b"]>, "bad socket path">,
  ];
}
