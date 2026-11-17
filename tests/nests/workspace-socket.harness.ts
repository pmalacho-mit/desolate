// Harness for wsctl.ts's tests: the workspace daemon, stood in for by a unix socket server in
// the test file's home that reads one line and answers what the test says (or no server at
// all). `ask` is handed in, so the module under test is the test's own copy.
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";

let made = 0;

/** What the daemon received, and everything `ask` wrote, once its connection has closed. */
export const wsctlAsking = async (
  ask: (input: string, socket: string, write: (text: string) => void) => net.Socket,
  input: string,
  reply: string | null,
): Promise<{ daemonGot: string | null; written: string[] }> => {
  const file = path.join(process.env.DESOLATE_HOME!, `wsd-${process.pid}-${made++}.sock`);
  let daemonGot: string | null = null;
  const server = reply === null ? null : net.createServer((connection) => {
    let got = "";
    connection.on("data", (chunk) => {
      got += chunk;
      if (got.includes("\n")) {
        daemonGot = got;
        connection.end(reply);
      }
    });
  });
  if (server) await new Promise<void>((resolve) => server.listen(file, resolve));
  const written: string[] = [];
  try {
    await new Promise<void>((resolve) => ask(input, file, (text) => written.push(text)).on("close", () => resolve()));
    return { daemonGot, written };
  } finally {
    server?.close();
    fs.rmSync(file, { force: true });
  }
};
