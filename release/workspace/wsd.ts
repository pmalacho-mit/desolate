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
// The host speaks to it through `wsctl.ts`, over the VM layer's exec: port numbers in, taken
// ports out, nothing else.
import * as fs from "node:fs";
import * as os from "node:os";
import { createServer } from "node:net";
import type { Server } from "node:net";
import { fileURLToPath } from "node:url";
import { run, sleep } from "../shared/run.ts";
import { tick as bridgeTick } from "./bridge.ts";
import { branches, domainRepos, importDeliveries, syncRepo } from "./sync.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Invoke, Table } from "../../suede.nests/dsl.import.meta.vitest.ts";

const SOCKET = "/run/desolate/wsd.sock";
/** desolate's own listeners in the VM: never offered for forwarding. */
const INTERNAL = new Set([15080, 15443]);

/** The ports the host may ask this VM to hold: unprivileged ones, each once. */
export const reservable = (wanted: number[]): number[] => [
  ...new Set(wanted.filter((port) => Number.isInteger(port) && port >= 1024 && port <= 65535)),
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

/** The ports in `ss -H -ltn` output a dev server holds: on loopback or every address, 1024
 *  and up, not desolate's own and not one this VM holds for the host. */
export const listenersOf = (ss: string, held: readonly number[]): number[] => {
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
    if (!Number.isInteger(port) || port < 1024 || INTERNAL.has(port) || held.includes(port))
      continue;
    // Loopback and wildcard listeners: what a dev server binds. Not the docker bridge's.
    if (!["0.0.0.0", "127.0.0.1", "*", "::", "::1"].includes(address)) continue;
    ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
};

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

const listeners = async () =>
  listenersOf((await run("ss", ["-H", "-ltn"], { timeoutMs: 5000 })).stdout, [...reserved.keys()]);

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
const surfaces = (): {
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
      devcontainerSummary(JSON.parse(fs.readFileSync("/run/desolate/devcontainer.json", "utf8"))),
    );
  } catch {
    /* not decided yet */
  }
  return out;
};

/** The one line about the devcontainer the host shows (devcontainer.ts's state), and the
 *  checkout it is in. Throws for a state that is not an object's (not decided yet). */
export const devcontainerSummary = (d: {
  state?: string;
  why?: string;
  image?: string;
  remoteUser?: string;
  checkout?: string;
}): { devcontainer: string; folder?: string } => {
  const out: { devcontainer: string; folder?: string } = {
    devcontainer:
      d.state === "up"
        ? `up (${String(d.image).slice(0, 80)}, user ${String(d.remoteUser).slice(0, 40)})`
        : d.state === "failed"
          ? `FAILED: ${String(d.why).slice(0, 300)}`
          : "none",
  };
  if (typeof d.checkout === "string") out.folder = d.checkout.slice(0, 300);
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
  /** written in the VM, so cut to length: an image name, a reason */
  export type Cut = Expect<
    Invoke<
      typeof devcontainerSummary,
      [
        d: {
          state: "up";
          image: "registry.example/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:1";
          remoteUser: "node";
        },
      ]
    >,
    "=",
    {
      devcontainer: "up (registry.example/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa, user node)";
    }
  >;
}

const serve = () => {
  fs.mkdirSync("/run/desolate", { recursive: true });
  fs.rmSync(SOCKET, { force: true });
  createServer((connection) => {
    let buffer = "";
    connection.on("error", () => connection.destroy());
    connection.on("data", async (chunk) => {
      buffer += chunk.toString();
      const end = buffer.indexOf("\n");
      if (end < 0) return buffer.length > 65536 ? connection.destroy() : undefined;
      let reply: unknown;
      try {
        const request = JSON.parse(buffer.slice(0, end)) as { op?: string; reserve?: unknown };
        if (request.op === "ports") {
          if (Array.isArray(request.reserve)) reserve(request.reserve.map(Number));
          reply = {
            ok: true,
            listeners: await listeners(),
            reserved: [...reserved.keys()].sort((a, b) => a - b),
            ...surfaces(),
          };
        } else reply = { ok: false, error: "unknown op" };
      } catch (error) {
        reply = { ok: false, error: String(error) };
      }
      connection.end(JSON.stringify(reply) + "\n");
    });
  }).listen(SOCKET, () => fs.chmodSync(SOCKET, 0o600));
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
          seen.set(repo, JSON.stringify(await branches(repo)));
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
