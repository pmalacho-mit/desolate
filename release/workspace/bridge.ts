// A compose devcontainer's ports, on the workspace VM's loopback (section 4.4). Run by wsd.ts,
// as the workspace's user.
//
// A single-container spec is on the VM's network: its listeners are the VM's, and the host's
// forwarder publishes them. A compose service has a network of its own. svcnet.ts, inside the
// primary service, is the way into it (its header says why); this is the VM's side. Every
// second, while the devcontainer is a compose one that is up:
//   - each TCP port listening in the primary service (1024 and up) gets a listener of the
//     same number on the VM's 127.0.0.1, which carries each connection to it: a dev server
//     in the app service, on its loopback or not, is then a listener in the VM as it would
//     be in a single container, and is forwarded by the same rules;
//   - each `forwardPorts` entry written `service:port` (devcontainer.ts reads them) gets one
//     too, reaching that service by its name from inside the app's network;
//   - what the services publish (`ports:` in the compose file) needs nothing: docker's own
//     proxy listens in the VM.
// A number something in the VM already holds (a published port, a reservation the host asked
// for, a server of the VM's own) is left to it, and tried again a second later.
import * as fs from "node:fs";
import { connect, createServer } from "node:net";
import type { Server } from "node:net";
import { readJson } from "../shared/json.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Invoke, Table, Throws } from "../../suede.nests/dsl.import.meta.vitest.ts";

const STATE = "/run/desolate/devcontainer.json";
/** desolate's own listeners in the VM, and the editor's gate: never mirrored. The editor's
 *  server (31580) is: when it runs in the app service, the gate reaches it this way. */
const NEVER = new Set([15080, 15443, 31581]);

type State = {
  state?: string;
  compose?: boolean;
  bridge?: string;
  forwards?: { port: number; host: string }[];
};
type Mirror = { server: Server; host: string };
const mirrors = new Map<number, Mirror>();

/** One request to svcnet.ts. */
const ask = (socket: string, line: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const conn = connect(socket);
    let data = "";
    conn.setTimeout(3000, () => conn.destroy(new Error("svcnet did not answer")));
    conn.on("connect", () => conn.write(`${line}\n`));
    conn.on("data", (chunk) => {
      data += chunk;
      if (data.length > 65536) conn.destroy(new Error("svcnet said too much"));
    });
    conn.on("end", () => resolve(data));
    conn.on("error", reject);
  });

const open = (port: number, socket: string, host: string) => {
  const server = createServer((client) => {
    client.on("error", () => client.destroy());
    client.pause();
    const upstream = connect(socket);
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
    upstream.on("connect", () => {
      upstream.write(`C ${host} ${port}\n`);
      client.pipe(upstream);
      upstream.pipe(client);
      client.resume();
    });
  });
  // Taken already: the port is someone else's in the VM. Dropped, and tried at the next tick.
  server.on("error", () => {
    if (mirrors.get(port)?.server === server) mirrors.delete(port);
    server.close();
  });
  server.listen({ port, host: "127.0.0.1", exclusive: true });
  mirrors.set(port, { server, host });
};

const closeAll = () => {
  for (const { server } of mirrors.values()) server.close();
  mirrors.clear();
};

/** The socket of svcnet.ts in an up compose service, as devcontainer.ts recorded it: only a
 *  socket in /run/desolate, which the VM and the service share. Null when there is none. */
export const bridgeSocket = (state: State): string | null => {
  const socket = state.bridge;
  return state.state !== "up" ||
    !state.compose ||
    typeof socket !== "string" ||
    !/^\/run\/desolate\/[a-z0-9-]+\.sock$/.test(socket)
    ? null
    : socket;
};

declare namespace bridgeSocket {
  export type Up = Expect<
    Invoke<
      typeof bridgeSocket,
      [state: { state: "up"; compose: true; bridge: "/run/desolate/svcnet.sock" }]
    >,
    "=",
    "/run/desolate/svcnet.sock"
  >;
  /** a single container (on the VM's network already), a container that is not up, and a
   *  socket anywhere else: the state file is the VM's, written from inside it */
  export type None = Table<
    typeof bridgeSocket,
    [
      [
        args: [state: { state: "up"; compose: false; bridge: "/run/desolate/svcnet.sock" }],
        expected: null,
      ],
      [
        args: [state: { state: "failed"; compose: true; bridge: "/run/desolate/svcnet.sock" }],
        expected: null,
      ],
      [args: [state: { state: "up"; compose: true }], expected: null],
      [args: [state: { state: "up"; compose: true; bridge: "/tmp/svcnet.sock" }], expected: null],
      [
        args: [state: { state: "up"; compose: true; bridge: "/run/desolate/../docker.sock" }],
        expected: null,
      ],
      [
        args: [state: { state: "up"; compose: true; bridge: "/run/desolate/svcnet.sock/x.sock" }],
        expected: null,
      ],
    ]
  >;
}

/** svcnet's answer to `L`: the ports listening in the service, up to 256 of them. Throws for
 *  an answer that is not a list. */
export const portsOf = (answer: unknown): number[] => {
  if (!Array.isArray(answer)) throw new Error("not a list");
  return answer
    .map(Number)
    .filter((port) => Number.isInteger(port) && port >= 1024 && port <= 65535)
    .slice(0, 256);
};

declare namespace portsOf {
  /** unprivileged ports only: a number below 1024 in the VM is root's */
  export type Ports = Table<
    typeof portsOf,
    [
      [args: [answer: [5432, 3000, "8080"]], expected: [5432, 3000, 8080]],
      [args: [answer: [22, 80, 1024, 65535, 65536, 3000.5, "x", null]], expected: [1024, 65535]],
    ]
  >;
  export type NotAList = Throws<Invoke<typeof portsOf, [answer: { ports: [3000] }]>, "not a list">;
}

/** What gets a listener on the VM's loopback, and what it connects to there ("-": the
 *  listener of that port in the service). A service's own listener wins over a forward of the
 *  same number; desolate's ports are never taken. */
export const wantedOf = (ports: number[], forwards: unknown): [port: number, host: string][] => {
  const wanted = new Map<number, string>();
  for (const port of ports) if (!NEVER.has(port)) wanted.set(port, "-");
  for (const f of (Array.isArray(forwards) ? forwards : []) as { port: number; host: string }[])
    if (
      Number.isInteger(f?.port) &&
      f.port >= 1024 &&
      f.port <= 65535 &&
      !NEVER.has(f.port) &&
      typeof f.host === "string" &&
      !wanted.has(f.port)
    )
      wanted.set(f.port, f.host);
  return [...wanted];
};

declare namespace wantedOf {
  export type Mirrors = Table<
    typeof wantedOf,
    [
      [
        args: [ports: [3000, 31580], forwards: [{ port: 5432; host: "db" }]],
        expected: [[3000, "-"], [31580, "-"], [5432, "db"]],
      ],
      [args: [ports: [5432], forwards: [{ port: 5432; host: "db" }]], expected: [[5432, "-"]]],
    ]
  >;
  /** never desolate's relay or the editor's gate, from the service or from a forward; and a
   *  forward the VM's state file got wrong is passed over */
  export type LeftOut = Table<
    typeof wantedOf,
    [
      [
        args: [
          ports: [15080, 15443, 31581],
          forwards: [
            { port: 31581; host: "db" },
            { port: 80; host: "db" },
            { port: 6379 },
            "cache:6379",
          ],
        ],
        expected: [],
      ],
      [args: [ports: [], forwards: "db:5432"], expected: []],
    ]
  >;
}

/** Make the VM's mirrors match what the compose service has, once. */
export const tick = async (): Promise<void> => {
  const state = readJson<State>(STATE, {});
  const socket = bridgeSocket(state);
  if (socket === null || !fs.existsSync(socket)) return closeAll();
  let ports: number[];
  try {
    ports = portsOf(JSON.parse(await ask(socket, "L")));
  } catch {
    // The service is gone, restarting, or its svcnet is: nothing of it is reachable now.
    return closeAll();
  }
  const wanted = new Map(wantedOf(ports, state.forwards));
  for (const [port, mirror] of mirrors)
    if (wanted.get(port) !== mirror.host) {
      mirror.server.close();
      mirrors.delete(port);
    }
  for (const [port, host] of wanted) if (!mirrors.has(port)) open(port, socket, host);
};
