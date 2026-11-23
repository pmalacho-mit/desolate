// Harness for the in-source tests of workspace/wsd.ts's ports service: its socket, stood in
// for by a unix socket in the test file's home, with clients that each send their request and
// keep what comes back. What it answers is the test's (`replies`, one per look), and what it
// is asked to hold is kept, so nothing runs `ss` or holds a port.
import { once } from "node:events";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { paced } from "../workspace/wsd.ts";

let made = 0;
const settled = () => new Promise((resolve) => setTimeout(resolve, 30));

type Service = (
  hold: (wanted: number[]) => void,
  answer: () => Promise<unknown>,
  most?: number,
) => { connection: (socket: net.Socket) => void; look: () => Promise<void> };

/** Each of `requests` sent by a client of its own, in turn (a string as a line, bytes as they
 *  are), answered with `replies[0]`; then a look for each further reply. What each client was
 *  sent, line by line, and whether its connection was closed; and what the service was asked
 *  to hold. */
export const watching = async (
  service: Service,
  requests: (string | Buffer)[],
  replies: unknown[],
  most?: number,
) => {
  const held: number[][] = [];
  let at = 0;
  const ports = service(
    (wanted) => void held.push(wanted),
    async () => replies[at],
    most,
  );
  const file = path.join(process.env.DESOLATE_HOME!, `wsd-${process.pid}-${made++}.sock`);
  const server = net.createServer(ports.connection);
  server.listen(file);
  await once(server, "listening");
  const clients: { got: string[]; closed: boolean }[] = [];
  const sockets: net.Socket[] = [];
  try {
    for (const request of requests) {
      const client = { got: [] as string[], closed: false };
      let buffer = "";
      const socket = net.connect(file);
      sockets.push(socket);
      socket.on("data", (chunk) => {
        buffer += chunk;
        for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
          client.got.push(buffer.slice(0, end));
          buffer = buffer.slice(end + 1);
        }
      });
      socket.on("close", () => (client.closed = true));
      socket.on("error", () => {});
      await once(socket, "connect");
      socket.write(typeof request === "string" ? `${request}\n` : request);
      clients.push(client);
      await settled();
    }
    for (at = 1; at < replies.length; at++) {
      await ports.look();
      await settled();
    }
    return { clients, held };
  } finally {
    for (const socket of sockets) socket.destroy();
    server.close();
    fs.rmSync(file, { force: true });
  }
};

/** When `paced` starts its looks, on a clock of the test's own: events poked in `bursts`
 *  (each from, to, every ms), each look taking `lookMs`, closed at `closeAt`. Timers due by
 *  an event's time run before it. */
export const pacedLooks = async (
  bursts: [from: number, to: number, every: number][],
  lookMs = 0,
  closeAt = Infinity,
): Promise<number[]> => {
  let now = 0;
  let made = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const later = (fn: () => void, ms: number) => {
    const id = ++made;
    timers.set(id, { at: now + ms, fn });
    return () => void timers.delete(id);
  };
  const looks: number[] = [];
  const pacer = paced(
    async () => {
      looks.push(now);
      if (lookMs > 0) await new Promise<void>((resolve) => later(resolve, lookMs));
    },
    () => now,
    later,
  );
  const events: [at: number, act: () => void][] = [[closeAt, pacer.close]];
  for (const [from, to, every] of bursts)
    for (let at = from; at <= to; at += every) events.push([at, pacer.poke]);
  events.sort((a, b) => a[0] - b[0]);
  const settle = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  for (;;) {
    const [id, due] = [...timers].sort((a, b) => a[1].at - b[1].at)[0] ?? [];
    const event = events[0];
    if (due && id !== undefined && (!event || due.at <= event[0])) {
      timers.delete(id);
      now = Math.max(now, due.at);
      due.fn();
    } else if (event && event[0] !== Infinity) {
      events.shift();
      now = event[0];
      event[1]();
    } else break;
    await settle();
  }
  return looks;
};
