// desolate's daemon in a workspace VM (sections 4.4, 6.5). It runs as the workspace's user,
// with the domain's trust: if an agent that is root here tampers with it, it can only lie
// about its own VM, and the host (the authority) still forwards nothing it should not.
//
//   branches  when a branch of the domain's moves, an incremental bundle and the list of refs
//             go to the outbox, so the root always sees every domain's branches (6.5); and
//             what the root delivered to the inbox is imported as root/<branch>.
//   ports     which TCP ports are listening here (for the host's forwarder to publish), and
//             which the host asks this VM to keep taken, so a dev server moves to the next
//             number instead of colliding with one that cannot be shared by name.
//   compose   a compose devcontainer's listeners, and its `service:port` forwards, mirrored
//             onto this VM's loopback (bridge.ts), so they are listeners here like any other.
//
// The host speaks to it over a dial to its socket (the VM layer's socat): port numbers in,
// taken ports out, nothing else.
import * as fs from "node:fs";
import * as os from "node:os";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { PORTS } from "../shared/limits.ts";
import { run, sleep } from "../shared/run.ts";
import { MIRRORS, tick as bridgeTick, unmirrored } from "./bridge.ts";
import { branches, domainRepos, importDeliveries, syncRepo } from "./sync.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Invoke, Table } from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { repeated } from "../.harness/shared-bytes.ts";
import type { watching } from "../.harness/workspace-wsd.ts";

const SOCKET = "/run/desolate/wsd.sock";
/** desolate's own listeners in the VM: never offered for forwarding. */
const INTERNAL = new Set([15080, 15443]);

/** The VM's own listeners below PORTS.min, which are nobody's dev server: its way in (Lima's
 *  ssh, 22) and the resolver every name here is answered by (dnsmasq, net/up.sh: 53). */
const OWN_LOW = new Set([22, 53]);

/** The ports the host may ask this VM to hold: unprivileged ones (PORTS), each once. */
export const reservable = (wanted: number[]): number[] => [
  ...new Set(
    wanted.filter((port) => Number.isInteger(port) && port >= PORTS.min && port <= PORTS.max),
  ),
];

declare namespace reservable {
  /** the host's numbers arrive as JSON: anything that is not a port a program could take is
   *  passed over */
  export type Ports = Table<
    typeof reservable,
    [
      [args: [wanted: [5173, 3000, 5173]], expected: [5173, 3000]],
      [args: [wanted: [80, 1023, 1024, 65535, 65536, -1, 3000.5]], expected: [1024, 65535]],
    ]
  >;
}

const reserved = new Map<number, Server>();
const reserve = (wanted: number[]) => {
  const want = new Set(reservable(wanted));
  for (const [port, server] of reserved)
    if (!want.has(port)) {
      server.close();
      reserved.delete(port);
    }
  for (const port of want) {
    if (reserved.has(port)) continue;
    // Hold the port and refuse whoever connects: a program that tries the next number when
    // one is taken (Vite without --strictPort) then moves on.
    const server = createServer((socket) => socket.destroy());
    server.on("error", () => reserved.delete(port));
    server.listen({ port, host: "0.0.0.0", exclusive: true });
    reserved.set(port, server);
  }
};

/** Each listener in `ss -H -ltn` output that a dev server could be: on loopback or every
 *  address (not the docker bridge's, not a network interface's). */
const heardIn = (ss: string): number[] => {
  const ports = new Set<number>();
  for (const line of ss.split("\n")) {
    const local = line.trim().split(/\s+/)[3];
    if (!local) continue;
    const at = local.lastIndexOf(":");
    const port = Number(local.slice(at + 1));
    const address = local
      .slice(0, at)
      .replace(/^\[|\]$/g, "")
      .replace(/%.*$/, "");
    if (!Number.isInteger(port) || port < 1 || port > PORTS.max) continue;
    // Loopback and wildcard listeners: what a dev server binds. Not the docker bridge's.
    if (!["0.0.0.0", "127.0.0.1", "*", "::", "::1"].includes(address)) continue;
    ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
};

/** The ports in `ss -H -ltn` output a dev server holds: on loopback or every address, from
 *  PORTS.min up, not desolate's own and not one this VM holds for the host. */
export const listenersOf = (ss: string, held: readonly number[]): number[] =>
  heardIn(ss).filter((port) => port >= PORTS.min && !INTERNAL.has(port) && !held.includes(port));

/** The listeners there that are below PORTS.min, which the host never forwards (a port
 *  below 1024 on the Mac is the system's): named, so that it can be said. Not the VM's own. */
export const lowOf = (ss: string): number[] =>
  heardIn(ss).filter((port) => port < PORTS.min && !OWN_LOW.has(port));

declare namespace listenersOf {
  /** what a dev server binds, in each spelling ss gives; each port once, in order */
  export type DevServers = Expect<
    Invoke<
      typeof listenersOf,
      [
        ss: "LISTEN 0 511 127.0.0.1:5173 0.0.0.0:*\nLISTEN 0 511 0.0.0.0:3000 0.0.0.0:*\nLISTEN 0 511 [::]:3000 [::]:*\nLISTEN 0 511 *:8080 *:*\nLISTEN 0 511 [::1]:9229 [::]:*\nLISTEN 0 4096 [fe80::1%eth0]:7000 [::]:*\n",
        held: [],
      ]
    >,
    "=",
    [3000, 5173, 8080, 9229]
  >;
  /** left out: a privileged port, desolate's own relay (15080, 15443), a port held for the
   *  host, and one on another address (docker's bridge, a network interface) */
  export type LeftOut = Expect<
    Invoke<
      typeof listenersOf,
      [
        ss: "LISTEN 0 4096 127.0.0.53%lo:53 0.0.0.0:*\nLISTEN 0 511 0.0.0.0:15080 0.0.0.0:*\nLISTEN 0 511 0.0.0.0:15443 0.0.0.0:*\nLISTEN 0 511 0.0.0.0:5174 0.0.0.0:*\nLISTEN 0 511 172.17.0.1:4000 0.0.0.0:*\nLISTEN 0 511 192.168.5.15:4001 0.0.0.0:*\nLISTEN 0 511 0.0.0.0:5173 0.0.0.0:*\n\n",
        held: [5174],
      ]
    >,
    "=",
    [5173]
  >;
}

declare namespace lowOf {
  /** a server on a privileged port, in each spelling: named, once, in order; the VM's ssh
   *  and its resolver (on every address, and on systemd's own) and everything from 1024 up
   *  are not */
  export type Low = Expect<
    Invoke<
      typeof lowOf,
      [
        ss: "LISTEN 0 511 0.0.0.0:80 0.0.0.0:*\nLISTEN 0 511 [::]:80 [::]:*\nLISTEN 0 511 127.0.0.1:443 0.0.0.0:*\nLISTEN 0 128 0.0.0.0:22 0.0.0.0:*\nLISTEN 0 4096 127.0.0.53%lo:53 0.0.0.0:*\nLISTEN 0 32 0.0.0.0:53 0.0.0.0:*\nLISTEN 0 511 0.0.0.0:3000 0.0.0.0:*\n",
      ]
    >,
    "=",
    [80, 443]
  >;
}

/** What is listening here now: what the host may forward, and what it will not. (Five
 *  seconds for `ss`, which reads the kernel's table in milliseconds: past it the answer is
 *  an empty list, and the next one, seconds later, is asked again.) */
const heard = async () => {
  const ss = (await run("ss", ["-H", "-ltn"], { timeoutMs: 5000 })).stdout;
  return { listeners: listenersOf(ss, [...reserved.keys()]), low: lowOf(ss) };
};

/** What the host shows about this workspace without asking again: the editor's token (the
 *  host builds the address) and one line about the devcontainer. */
const epochOf = (file: string) => {
  try {
    const value = Number(fs.readFileSync(file, "utf8").trim());
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
};
type Unforwarded = { low: number[]; more: number };
const surfaces = (
  unforwarded: Unforwarded,
): {
  editorToken?: string;
  editorTokenEpoch?: number;
  devcontainer?: string;
  folder?: string;
} => {
  const out: {
    editorToken?: string;
    editorTokenEpoch?: number;
    devcontainer?: string;
    folder?: string;
  } = {};
  try {
    const file = `${os.homedir()}/.desolate-editor/token`;
    const token = fs.readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{48}$/.test(token)) out.editorToken = token;
    // The host's last retiring of the tokens that it was made after (editor.sh): the host
    // serves no editor whose token was not made since (host/retired.ts).
    out.editorTokenEpoch = epochOf(`${file}.epoch`);
  } catch {
    /* no editor yet */
  }
  try {
    Object.assign(
      out,
      devcontainerSummary(
        JSON.parse(fs.readFileSync("/run/desolate/devcontainer.json", "utf8")),
        unforwardedNote(unforwarded),
      ),
    );
  } catch {
    /* not decided yet */
  }
  return out;
};

/** What to say of listeners that are not forwarded for a bound's sake, or null: the
 *  privileged ports (in the VM, or in a compose devcontainer's service), and how many of a
 *  service's listeners came after its last mirror. Each bound by its name and number. */
export const unforwardedNote = ({ low, more }: Unforwarded): string | null => {
  const parts = [
    ...(low.length
      ? [
          `${low.length === 1 ? `port ${low[0]} is` : `ports ${low.join(", ")} are`} listening and not forwarded (below ${PORTS.min}: listen on a port from ${PORTS.min} up)`,
        ]
      : []),
    ...(more > 0
      ? [
          `${more} of its service's listeners ${more === 1 ? "is" : "are"} not forwarded (past the first ${MIRRORS})`,
        ]
      : []),
  ];
  return parts.length ? parts.join("; ") : null;
};

declare namespace unforwardedNote {
  export type Says = Table<
    typeof unforwardedNote,
    [
      [args: [unforwarded: { low: []; more: 0 }], expected: null],
      [
        args: [unforwarded: { low: [80]; more: 0 }],
        expected: "port 80 is listening and not forwarded (below 1024: listen on a port from 1024 up)",
      ],
      [
        args: [unforwarded: { low: [80, 443]; more: 44 }],
        expected: "ports 80, 443 are listening and not forwarded (below 1024: listen on a port from 1024 up); 44 of its service's listeners are not forwarded (past the first 256)",
      ],
    ]
  >;
}

/** The one line about the devcontainer the host shows (devcontainer.ts's state, with its
 *  note, and `ports`: what is said of listeners that are not forwarded), and the checkout it
 *  is in. Whole: nothing is cut here (docs/v3/limits.md, R1). The host bounds what a VM says
 *  and marks its cut, and what shows the line fits it. Throws for a state that is not an
 *  object's (not decided yet). */
export const devcontainerSummary = (
  d: {
    state?: string;
    why?: string;
    image?: string;
    remoteUser?: string;
    checkout?: string;
    note?: string;
  },
  ports: string | null = null,
): { devcontainer: string; folder?: string } => {
  const notes = [...(d.state === "up" && typeof d.note === "string" ? [d.note] : [])];
  if (ports) notes.push(ports);
  const out: { devcontainer: string; folder?: string } = {
    devcontainer:
      (d.state === "up"
        ? `up (${String(d.image)}, user ${String(d.remoteUser)})`
        : d.state === "failed"
          ? `FAILED: ${String(d.why)}`
          : "none") + (notes.length ? `; note: ${notes.join("; ")}` : ""),
  };
  if (typeof d.checkout === "string") out.folder = d.checkout;
  return out;
};

declare namespace devcontainerSummary {
  export type States = Table<
    typeof devcontainerSummary,
    [
      [
        args: [
          d: {
            state: "up";
            image: "node:22";
            remoteUser: "node";
            checkout: "/workspaces/acme/app";
          },
        ],
        expected: { devcontainer: "up (node:22, user node)"; folder: "/workspaces/acme/app" },
      ],
      [
        args: [d: { state: "failed"; why: "the VM's docker daemon is not answering" }],
        expected: { devcontainer: "FAILED: the VM's docker daemon is not answering" },
      ],
      [
        args: [d: { state: "none"; why: "no checkout has a devcontainer.json" }],
        expected: { devcontainer: "none" },
      ],
      /** a state the VM wrote by hand is still one line, of a length the host shows */
      [args: [d: { state: "booting" }], expected: { devcontainer: "none" }],
    ]
  >;
  /** what the devcontainer's own start noted (devcontainer.ts), and what is said of ports
   *  that are not forwarded: after the state, in the same line */
  export type Notes = Table<
    typeof devcontainerSummary,
    [
      [
        args: [
          d: {
            state: "up";
            image: "service app";
            remoteUser: "node";
            note: 'forwardPorts entries that are not forwarded: "web:80" (below 1024: use a port from 1024 up)';
          },
          ports: "port 80 is listening and not forwarded (below 1024: listen on a port from 1024 up)",
        ],
        expected: {
          devcontainer: 'up (service app, user node); note: forwardPorts entries that are not forwarded: "web:80" (below 1024: use a port from 1024 up); port 80 is listening and not forwarded (below 1024: listen on a port from 1024 up)';
        },
      ],
      /** with no devcontainer the VM's own listeners are still its: said the same way */
      [
        args: [
          d: { state: "none"; why: "no checkout has a devcontainer.json" },
          ports: "port 80 is listening and not forwarded (below 1024: listen on a port from 1024 up)",
        ],
        expected: {
          devcontainer: "none; note: port 80 is listening and not forwarded (below 1024: listen on a port from 1024 up)";
        },
      ],
    ]
  >;
  /** nothing is cut here: a long image name, and a reason that ends by saying where the
   *  whole log is, arrive whole, and the folder is the path it is */
  export type Whole = Table<
    typeof devcontainerSummary,
    [
      [
        args: [
          d: {
            state: "up";
            image: "registry.example/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:1";
            remoteUser: "node";
          },
        ],
        expected: {
          devcontainer: "up (registry.example/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:1, user node)";
        },
      ],
    ]
  >;
}

/** What `ports` and `watch` answer: what listens here, what is held for the host, what is not
 *  forwarded for a bound's sake, and what the host shows without asking again. */
const portsReply = async (): Promise<unknown> => {
  try {
    const { listeners, low } = await heard();
    // What is listening and will not be forwarded, for a bound's sake: in this VM, and in a
    // compose devcontainer's service (bridge.ts). In the devcontainer's line, which the host
    // shows already, and by itself (`unforwarded`) for `desolate ports`.
    const service = unmirrored();
    const unforwarded = {
      low: [...new Set([...low, ...service.low])].sort((a, b) => a - b),
      more: service.more,
    };
    return {
      ok: true,
      listeners,
      reserved: [...reserved.keys()].sort((a, b) => a - b),
      unforwarded,
      ...surfaces(unforwarded),
    };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
};

/** The line a watcher is sent for `reply`, or null when it is the line it was sent last. */
export const nextLine = (last: string | null, reply: unknown): string | null => {
  const line = `${JSON.stringify(reply)}\n`;
  return line === last ? null : line;
};

declare namespace nextLine {
  /** a watch's first answer is sent; then only an answer that differs, in anything it says */
  export type Changed = Table<
    typeof nextLine,
    [
      [
        args: [last: null, reply: { ok: true; listeners: [] }],
        expected: '{"ok":true,"listeners":[]}\n',
      ],
      [
        args: [last: '{"ok":true,"listeners":[3000]}\n', reply: { ok: true; listeners: [3000] }],
        expected: null,
      ],
      [
        args: [
          last: '{"ok":true,"listeners":[3000]}\n',
          reply: { ok: true; listeners: [3000, 5173] },
        ],
        expected: '{"ok":true,"listeners":[3000,5173]}\n',
      ],
      [
        args: [
          last: '{"ok":true,"listeners":[3000]}\n',
          reply: { ok: true; listeners: [3000]; editorToken: "ab" },
        ],
        expected: '{"ok":true,"listeners":[3000],"editorToken":"ab"}\n',
      ],
    ]
  >;
}

/** The most watchers at once. The host's daemon is the only real one, and keeps one open; a
 *  few more cover one whose end this daemon has not seen yet. Past it the oldest is let go. */
const WATCHERS_MOST = 4;
/** The longest request line: the ports the host asks this VM to hold, a few of them (a JSON
 *  list of 10,000 ports is under 64 KiB). A longer one is not a request, and is not kept
 *  growing in this daemon's memory. */
const REQUEST_MOST = 65536;

/** The socket's requests, each a line. `ports`: one answer, then the connection ends (what
 *  the host asks now and then, to check). `watch`: one answer at once, and another whenever
 *  `look` finds it would differ, for as long as the connection lasts; a `reserve` line on it
 *  changes what this VM holds, and is looked at the same way. `hold` takes the ports a
 *  request asks to hold, `answer` makes the answer. A watcher that has not taken its last line
 *  by the time another is due is let go (it is asked to reconnect, not waited for). */
export const portsService = (
  hold: (wanted: number[]) => void,
  answer: () => Promise<unknown>,
  most = WATCHERS_MOST,
) => {
  const watchers = new Map<Socket, string | null>();
  let looked: Promise<void> = Promise.resolve();
  // One look at a time, every watcher told what it found: a look started before a reserve
  // never lands after the reserve's own.
  const look = () =>
    (looked = looked.then(async () => {
      if (watchers.size === 0) return;
      const reply = await answer();
      for (const [watcher, last] of watchers) {
        const line = nextLine(last, reply);
        if (line === null) continue;
        if (watcher.writableLength > 0) {
          watcher.destroy();
          continue;
        }
        watchers.set(watcher, line);
        watcher.write(line);
      }
    }));
  const request = async (connection: Socket, line: string) => {
    if (connection.writableEnded || connection.destroyed) return;
    let asked: { op?: unknown; reserve?: unknown };
    try {
      asked = JSON.parse(line) as { op?: unknown; reserve?: unknown };
    } catch (error) {
      return void connection.end(`${JSON.stringify({ ok: false, error: String(error) })}\n`);
    }
    const watching = watchers.has(connection);
    const op = asked?.op;
    if (op !== "ports" && op !== "watch" && !(op === "reserve" && watching))
      return void connection.end(`${JSON.stringify({ ok: false, error: "unknown op" })}\n`);
    if (Array.isArray(asked.reserve)) hold(asked.reserve.map(Number));
    if (op === "ports") return void connection.end(`${JSON.stringify(await answer())}\n`);
    if (!watching) {
      if (watchers.size >= most) watchers.keys().next().value?.destroy();
      watchers.set(connection, null);
    }
    await look();
  };
  const connection = (socket: Socket) => {
    let buffer = "";
    let queue: Promise<void> = Promise.resolve();
    socket.on("error", () => socket.destroy());
    socket.on("close", () => watchers.delete(socket));
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        queue = queue.then(() => request(socket, line));
      }
      if (buffer.length > REQUEST_MOST) socket.destroy();
    });
  };
  return { connection, look, watching: () => watchers.size > 0 };
};

declare namespace portsService {
  /** a watch is answered at once, then again only when the answer differs: a look that
   *  finds the same says nothing (the control); `ports` is answered once, and ended */
  export type Watch = [
    Expect<
      Invoke<
        typeof watching,
        [
          service: typeof portsService,
          requests: ['{"op":"watch","reserve":[]}'],
          replies: [{ listeners: [3000] }, { listeners: [3000] }, { listeners: [3000, 5173] }],
        ]
      >,
      "=",
      {
        clients: [{ got: ['{"listeners":[3000]}', '{"listeners":[3000,5173]}']; closed: false }];
        held: [[]];
      }
    >,
    Expect<
      Invoke<
        typeof watching,
        [
          service: typeof portsService,
          requests: ['{"op":"ports","reserve":[5173]}'],
          replies: [{ listeners: [3000] }, { listeners: [3000, 5173] }],
        ]
      >,
      "=",
      { clients: [{ got: ['{"listeners":[3000]}']; closed: true }]; held: [[5173]] }
    >,
  ];
  /** a reserve on a watch holds what it says, and is answered when that changes the answer;
   *  on a connection that is not a watch it is no request */
  export type Reserve = [
    Expect<
      Invoke<
        typeof watching,
        [
          service: typeof portsService,
          requests: ['{"op":"watch","reserve":[5173]}\n{"op":"reserve","reserve":[3000]}'],
          replies: [{ listeners: [] }],
        ]
      >,
      "=",
      { clients: [{ got: ['{"listeners":[]}']; closed: false }]; held: [[5173], [3000]] }
    >,
    Expect<
      Invoke<
        typeof watching,
        [
          service: typeof portsService,
          requests: ['{"op":"reserve","reserve":[3000]}'],
          replies: [{ listeners: [] }],
        ]
      >,
      "=",
      { clients: [{ got: ['{"ok":false,"error":"unknown op"}']; closed: true }]; held: [] }
    >,
  ];
  /** what a watcher may cost: past `most` watchers the oldest is let go, the others kept;
   *  a request line past 64 KiB is not kept growing, and its connection is closed */
  export type Bounds = [
    Expect<
      Invoke<
        typeof watching,
        [
          service: typeof portsService,
          requests: ['{"op":"watch"}', '{"op":"watch"}', '{"op":"watch"}'],
          replies: [{ listeners: [] }],
          most: 2,
        ]
      >,
      "=",
      {
        clients: [
          { got: ['{"listeners":[]}']; closed: true },
          { got: ['{"listeners":[]}']; closed: false },
          { got: ['{"listeners":[]}']; closed: false },
        ];
        held: [];
      }
    >,
    Expect<
      Invoke<
        typeof watching,
        [
          service: typeof portsService,
          requests: [Invoke<typeof repeated, [text: "[", count: 65537]>],
          replies: [{ listeners: [] }],
        ]
      >,
      "=",
      { clients: [{ got: []; closed: true }]; held: [] }
    >,
  ];
}

/** How often a watch looks, while there is one: one `ss`, which reads the kernel's table in
 *  milliseconds. Linux says nothing when a socket starts listening (no file to watch, and its
 *  netlink events are for sockets that close), so it is looked at. */
const LOOK_MS = 1000;

const serve = () => {
  fs.mkdirSync("/run/desolate", { recursive: true });
  fs.rmSync(SOCKET, { force: true });
  const ports = portsService(reserve, portsReply);
  createServer(ports.connection).listen(SOCKET, () => fs.chmodSync(SOCKET, 0o600));
  void (async () => {
    for (;;) {
      if (ports.watching()) await ports.look();
      await sleep(LOOK_MS);
    }
  })();
};

// The domain's refs, watched by comparing them every few seconds (a shared .git on virtiofs
// delivers no file events across VMs). Every workspace of a domain does this; the bundles
// are idempotent, so two writing the same refs is harmless.
const seen = new Map<string, string>();
const watch = async () => {
  for (;;) {
    for (const repo of domainRepos()) {
      try {
        const now = JSON.stringify(await branches(repo));
        if (seen.get(repo) !== now) {
          // Debounce: a rebase moves a branch many times in a second.
          await sleep(500);
          await syncRepo(repo);
          // Before the sync, not after: a commit made during it was counted seen, unwritten.
          seen.set(repo, now);
        }
        await importDeliveries(repo);
      } catch (error) {
        console.error(`wsd: ${repo}: ${String(error)}`);
      }
    }
    await sleep(3000);
  }
};

const bridge = async () => {
  for (;;) {
    await bridgeTick().catch((error: unknown) =>
      console.error(`wsd: compose ports: ${String(error)}`),
    );
    await sleep(1000);
  }
};

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  serve();
  void watch();
  void bridge();
}
