// Harness for the in-source tests of workspace/wsd.ts's ports service: its socket, stood in
// for by a unix socket in the test file's home, with clients that each send their request and
// keep what comes back. What it answers is the test's (`replies`, one per look), and what it
// is asked to hold is kept, so nothing runs `ss` or holds a port.
import { once } from "node:events";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";

let made = 0;
const settled = () => new Promise((resolve) => setTimeout(resolve, 30));

type Service = (
  hold: (wanted: number[]) => void,
  answer: () => Promise<unknown>,
  most?: number,
  ask?: (look: unknown) => void,
) => { connection: (socket: net.Socket) => void; look: () => Promise<void> };

/** Each of `requests` sent by a client of its own, in turn (a string as a line, bytes as they
 *  are), answered with `replies[0]`; then a look for each further reply. What each client was
 *  sent, line by line, and whether its connection was closed; what the service was asked
 *  to hold; and the checkouts it was asked to look at, if any were named. */
export const watching = async (
  service: Service,
  requests: (string | Buffer)[],
  replies: unknown[],
  most?: number,
) => {
  const held: number[][] = [];
  const asked: unknown[] = [];
  let at = 0;
  const ports = service(
    (wanted) => void held.push(wanted),
    async () => replies[at],
    most,
    (look) => void (look !== undefined && asked.push(look)),
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
    return { clients, held, ...(asked.length ? { asked } : {}) };
  } finally {
    for (const socket of sockets) socket.destroy();
    server.close();
    fs.rmSync(file, { force: true });
  }
};
