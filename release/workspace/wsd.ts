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
// The host holds a watch on its socket (a dial, the VM layer's socat): port numbers in,
// taken ports out, nothing else.
import * as fs from "node:fs";
import * as os from "node:os";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { PORTS } from "../shared/limits.ts";
import { paced, sleep } from "../shared/run.ts";
import { MIRRORS, tick as bridgeTick, unmirrored } from "./bridge.ts";
import { branches, clone, domainRepos, importDeliveries, syncRepo, watchRefs } from "./sync.ts";
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

/** What a dev server binds, as the kernel writes a local address in /proc/net/tcp and tcp6
 *  (each 32-bit word in the machine's order, which is little-endian on every VM desolate
 *  makes): every address, IPv4 and IPv6, and loopback, IPv4 and IPv6. Not the docker
 *  bridge's, not a network interface's. */
const DEV_BINDS = new Set([
  "00000000",
  "0100007F",
  "00000000000000000000000000000000",
  "00000000000000000000000001000000",
]);

/** Each port in /proc/net/tcp and tcp6 text listening (state 0A) on an address a dev server
 *  binds. A line that is not such an entry, whole, is passed over. */
const heardIn = (proc: string): number[] => {
  const ports = new Set<number>();
  for (const line of proc.split("\n")) {
    const [, local, , state] = line.trim().split(/\s+/);
    const at = /^([0-9A-F]{8}|[0-9A-F]{32}):([0-9A-F]{4})$/.exec(local ?? "");
    const port = at ? parseInt(at[2]!, 16) : 0;
    if (state === "0A" && at && DEV_BINDS.has(at[1]!) && port > 0) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
};

/** The ports in /proc/net/tcp and tcp6 a dev server holds: on loopback or every address, from
 *  PORTS.min up, not desolate's own and not one this VM holds for the host. */
export const listenersOf = (proc: string, held: readonly number[]): number[] =>
  heardIn(proc).filter((port) => port >= PORTS.min && !INTERNAL.has(port) && !held.includes(port));

/** The listeners there that are below PORTS.min, which the host never forwards (a port
 *  below 1024 on the Mac is the system's): named, so that it can be said. Not the VM's own. */
export const lowOf = (proc: string): number[] =>
  heardIn(proc).filter((port) => port < PORTS.min && !OWN_LOW.has(port));

declare namespace listenersOf {
  /** what a dev server binds, on each address it may (127.0.0.1, 0.0.0.0, [::], [::1]); each
   *  port once, in order; not one on another address (fe80::1, the last line) */
  export type DevServers = Expect<
    Invoke<
      typeof listenersOf,
      [
        proc: "  sl  local_address rem_address   st tx_queue\n0: 0100007F:1435 00000000:0000 0A 00000000:00000000\n0: 00000000:0BB8 00000000:0000 0A 00000000:00000000\n0: 00000000000000000000000000000000:0BB8 00000000:0000 0A 00000000:00000000\n0: 00000000000000000000000000000000:1F90 00000000:0000 0A 00000000:00000000\n0: 00000000000000000000000001000000:240D 00000000:0000 0A 00000000:00000000\n0: 000080FE000000000000000001000000:1B58 00000000:0000 0A 00000000:00000000\n",
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
        proc: "0: 3500007F:0035 00000000:0000 0A 00000000:00000000\n0: 00000000:3AE8 00000000:0000 0A 00000000:00000000\n0: 00000000:3C53 00000000:0000 0A 00000000:00000000\n0: 00000000:1436 00000000:0000 0A 00000000:00000000\n0: 010011AC:0FA0 00000000:0000 0A 00000000:00000000\n0: 0F05A8C0:0FA1 00000000:0000 0A 00000000:00000000\n0: 00000000:1435 00000000:0000 0A 00000000:00000000\n\n",
        held: [5174],
      ]
    >,
    "=",
    [5173]
  >;
  /** what is not a listening entry, whole, is passed over: the header, a connection (state
   *  01), an address or port that is not hex of its length, a line cut short, port 0; the
   *  last line is the control */
  export type Malformed = Expect<
    Invoke<
      typeof listenersOf,
      [
        proc: "  sl  local_address rem_address   st tx_queue\n0: 0100007F:0FA0 00000000:0000 01 00000000:00000000\n0: zz00007F:0FA2 00000000:0000 0A\n0: 0100007F:FA3 00000000:0000 0A\n0: 0100007F 0A\ngarbage\n0: 0100007F:0000 00000000:0000 0A 00000000:00000000\n0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000\n",
        held: [],
      ]
    >,
    "=",
    [3000]
  >;
}

declare namespace lowOf {
  /** a server on a privileged port, on each address: named, once, in order; the VM's ssh
   *  and its resolver (on every address, and on systemd's own) and everything from 1024 up
   *  are not */
  export type Low = Expect<
    Invoke<
      typeof lowOf,
      [
        proc: "0: 00000000:0050 00000000:0000 0A 00000000:00000000\n0: 00000000000000000000000000000000:0050 00000000:0000 0A 00000000:00000000\n0: 0100007F:01BB 00000000:0000 0A 00000000:00000000\n0: 00000000:0016 00000000:0000 0A 00000000:00000000\n0: 3500007F:0035 00000000:0000 0A 00000000:00000000\n0: 00000000:0035 00000000:0000 0A 00000000:00000000\n0: 00000000:0BB8 00000000:0000 0A 00000000:00000000\n",
      ]
    >,
    "=",
    [80, 443]
  >;
}

/** What is listening here now: what the host may forward, and what it will not. Read from
 *  the kernel's tables, with no program started (`ss` was one a second while watched). */
const heard = () => {
  const proc = ["/proc/net/tcp", "/proc/net/tcp6"]
    .map((file) => {
      try {
        return fs.readFileSync(file, "utf8");
      } catch {
        return ""; // no IPv6 in this kernel
      }
    })
    .join("\n");
  return { listeners: listenersOf(proc, [...reserved.keys()]), low: lowOf(proc) };
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

/** What a watch is answered: what listens here, what is held for the host, what is not
 *  forwarded for a bound's sake, and what the host shows without asking again. */
const portsReply = async (): Promise<unknown> => {
  const { listeners, low } = heard();
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

/** The socket's requests, each a line. `watch`: one answer at once, and another whenever
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
    if (op !== "watch" && !(op === "reserve" && watching))
      return void connection.end(`${JSON.stringify({ ok: false, error: "unknown op" })}\n`);
    if (Array.isArray(asked.reserve)) hold(asked.reserve.map(Number));
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
  return { connection, look };
};

declare namespace portsService {
  /** a watch is answered at once, then again only when the answer differs: a look that
   *  finds the same says nothing (the control); a request that is not one (`ports`, which
   *  the host no longer asks) is refused, and ended */
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
          replies: [{ listeners: [3000] }],
        ]
      >,
      "=",
      { clients: [{ got: ['{"ok":false,"error":"unknown op"}']; closed: true }]; held: [] }
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

/** How often a watch looks, while there is one: a read of the kernel's two tables, no program
 *  started. Linux says nothing when a socket starts listening (no file to watch, and its
 *  netlink events are for sockets that close), so it is looked at. */
const LOOK_MS = 1000;

const serve = () => {
  fs.mkdirSync("/run/desolate", { recursive: true });
  fs.rmSync(SOCKET, { force: true });
  const ports = portsService(reserve, portsReply);
  createServer(ports.connection).listen(SOCKET, () => fs.chmodSync(SOCKET, 0o600));
  void (async () => {
    for (;;) {
      await ports.look();
      await sleep(LOOK_MS);
    }
  })();
};

// A domain's branches, written out when they move: looked at on an event in a repository's
// refs (watchRefs: git run in this VM, here or in its devcontainer), and once a minute
// besides. /workspaces is a share (the Mac's folder, and every VM of the domain's), and a
// commit made on the Mac or in another VM is no event here: that VM's wsd writes it out,
// and this minute is the check that nothing was missed. Until 2026-11-23 each repository
// was looked at every 3 s: 20 `git for-each-ref` a minute, in every running workspace. The
// bundles are idempotent, so two VMs writing the same refs is harmless. The inbox (the root
// delivers through the share, so no event either) and the set of repositories are read
// every 3 s, which starts no program.
const watch = async () => {
  const seen = new Map<string, string>();
  const repos = new Map<string, { look: ReturnType<typeof paced>; stop?: () => void }>();
  const said =
    (repo: string, what = "") =>
    (error: unknown) =>
      console.error(`wsd: ${repo}: ${what}${String(error)}`);
  setInterval(() => repos.forEach(({ look }) => look.poke()), 60_000);
  for (; ; await sleep(3000)) {
    const present = domainRepos();
    for (const [repo, { look, stop }] of repos)
      if (!present.includes(repo)) {
        stop?.();
        look.close();
        repos.delete(repo);
        seen.delete(repo);
      }
    for (const repo of present.filter((repo) => !repos.has(repo))) {
      const watched: { look: ReturnType<typeof paced>; stop?: () => void } = {
        look: paced(async () => {
          // `now` before the sync: a commit made during it is not counted seen, unwritten.
          const now = JSON.stringify(await branches(repo));
          if (seen.get(repo) !== now)
            await syncRepo(repo).then(() => seen.set(repo, now), said(repo));
        }),
      };
      repos.set(repo, watched);
      watched.look.poke();
      // A watch that cannot start or fails (ENOSPC: inotify's limit) is said once; the
      // minute's look remains.
      const unwatched = said(repo, "not watched, looked at once a minute: ");
      watchRefs(clone(repo), watched.look.poke, unwatched).then(
        (stop) => (repos.get(repo) === watched ? (watched.stop = stop) : stop()),
        unwatched,
      );
    }
    for (const repo of present) await importDeliveries(repo).catch(said(repo));
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
