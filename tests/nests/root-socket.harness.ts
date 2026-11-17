// Harness for in-source tests of the root's clients of its own sockets (root/keyring-client.ts):
// a socket in the test file's home that answers each line it is sent with one line, as the
// keyring's do. Closed when the test ends. Imported by the tests as types only, so nothing here
// reaches the release (release/nests-harness.d.ts).
import * as fs from "node:fs";
import { createServer } from "node:net";
import * as path from "node:path";
import { onTestFinished } from "vitest";

/** A socket that answers every request with `line` (and a newline), and what was asked of it.
 *  Its path is short: a socket's path is at most 104 bytes on macOS. */
export const aSocketAnswering = async (line: string) => {
  const dir = fs.mkdtempSync(path.join(process.env.DESOLATE_HOME!, "s-"));
  const socket = path.join(dir, "k.sock");
  const asked: string[] = [];
  const server = createServer((connection) => {
    let text = "";
    connection.on("data", (chunk) => {
      text += chunk;
      if (!text.includes("\n")) return;
      asked.push(text.slice(0, text.indexOf("\n")));
      connection.end(`${line}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { socket, asked: () => asked };
};
