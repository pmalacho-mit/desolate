// Harness for the in-source tests of shared/link.ts: the two ends of a workspace's link on one
// connection, over a unix socket in the test file's home (a socket the test makes, so nothing
// else on the machine can be on the other end). It stands in for the guest in the VM and the
// host daemon; each end is a function the test names (link.ts's own `open` and `accept`, or
// an impostor below). Imported by the tests as types only, so nothing here reaches the release.
import { once } from "node:events";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { onTestFinished } from "vitest";

type GuestEnd = (socket: net.Socket, token: string) => Promise<boolean>;
type HostEnd = (socket: net.Socket, token: string) => Promise<Buffer | string | null>;

let made = 0;

/** Runs `guestEnd` on the connecting side and `hostEnd` on the listening side, each with its
 *  token. A guest that is let in then sends "hello" and ends. `host` is what the host end
 *  answered: with link.ts's accept, what came after the guest's proof (null: refused). */
export const handshake = async (guestEnd: GuestEnd, hostEnd: HostEnd, guestToken: string, hostToken: string): Promise<{ guest: boolean; host: string | null }> => {
  const file = path.join(process.env.DESOLATE_HOME!, `link-${process.pid}-${made++}.sock`);
  const server = net.createServer();
  onTestFinished(() => {
    server.close();
    fs.rmSync(file, { force: true });
  });
  const hostSide = new Promise<string | null>((resolve) =>
    server.once("connection", async (socket) => {
      const got = await hostEnd(socket, hostToken);
      if (got === null || typeof got === "string") return resolve(got);
      const chunks = [got];
      socket.on("data", (chunk: Buffer) => chunks.push(chunk));
      socket.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
      socket.resume();
    }),
  );
  server.listen(file);
  await once(server, "listening");
  const client = net.connect(file);
  client.on("error", () => {});
  await once(client, "connect");
  const guest = await guestEnd(client, guestToken);
  if (guest) client.end("hello");
  return { guest, host: await hostSide };
};

/** What the host end answered, as text ("" for nothing): for a host end that says what it heard. */
export const heard = async (guestEnd: GuestEnd, hostEnd: HostEnd, guestToken: string, hostToken: string): Promise<string> =>
  (await handshake(guestEnd, hostEnd, guestToken, hostToken)).host ?? "";

/** Whatever holds the port when the host daemon does not: it answers the guest's first line
 *  with a proof it made up, and says what the guest sent it. */
export const impostor: HostEnd = (socket) =>
  new Promise((resolve) => {
    let got = "";
    socket.on("data", (chunk: Buffer) => {
      if (got === "") socket.write(`${"1".repeat(32)} ${"2".repeat(64)}\n`);
      got += chunk.toString("latin1");
    });
    socket.on("error", () => {});
    socket.on("close", () => resolve(got));
  });

/** A guest that sends more than its first line before the host has proved itself (what a
 *  client that is not a desolate guest, an HTTP one say, would do). */
export const saysTooMuch: GuestEnd = (socket) =>
  new Promise((resolve) => {
    socket.write(`DESOLATE-LINK2 ${"3".repeat(32)}\nGET / HTTP/1.1\r\n\r\n`);
    socket.on("close", () => resolve(false));
  });

/** A socket that is connected to nothing. */
export const unconnected = () => new net.Socket();
