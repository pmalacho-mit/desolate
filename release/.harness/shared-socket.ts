// Harness for the in-source tests of shared/sniff.ts's sniffSocket: a client on the other end
// of a connection, over a unix socket in the test file's home. It stands in for a browser, or
// for a client of a protocol where the server speaks first, which says nothing.
import { once } from "node:events";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { onTestFinished } from "./vitest.ts";

let made = 0;

/** The server's end of a connection whose client writes `chunks`, one write each, and then
 *  stays open, or ends if `end`. */
export const clientSending = async (chunks: string[], end = false): Promise<net.Socket> => {
  const file = path.join(process.env.DESOLATE_HOME!, `client-${process.pid}-${made++}.sock`);
  const server = net.createServer();
  const accepted = once(server, "connection");
  server.listen(file);
  await once(server, "listening");
  const client = net.connect(file);
  client.on("error", () => {});
  onTestFinished(() => {
    client.destroy();
    server.close();
    fs.rmSync(file, { force: true });
  });
  await once(client, "connect");
  for (const chunk of chunks) client.write(Buffer.from(chunk, "latin1"));
  if (end) client.end();
  const [socket] = (await accepted) as [net.Socket];
  onTestFinished(() => {
    socket.destroy();
  });
  return socket;
};
