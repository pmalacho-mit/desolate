// Harness for the in-source tests of release/host/daemon.ts. Imported by the tests as types
// only, so nothing here reaches the release (release/nests-harness.d.ts).
import * as fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:net";
import * as path from "node:path";
import { onTestFinished } from "vitest";
import type { backend } from "../../release/host/stack.ts";

// ------------------------------------------------------------------ a stand-in daemon
/** Stands in for a running host daemon: a socket where the real one keeps its own
 *  (state/daemon.sock, in the test file's home), answering every request with `reply`.
 *  Nothing outside that home is touched; it is closed when the test ends. */
export const daemonAnswering = (reply: Record<string, unknown>) =>
  new Promise<void>((resolve, reject) => {
    const socket = path.join(process.env.DESOLATE_HOME!, "state", "daemon.sock");
    fs.mkdirSync(path.dirname(socket), { recursive: true });
    fs.rmSync(socket, { force: true });
    const server = createServer((connection) => {
      let buffer = "";
      connection.on("error", () => connection.destroy());
      connection.on("data", (chunk) => {
        buffer += chunk.toString();
        if (buffer.includes("\n")) connection.end(`${JSON.stringify(reply)}\n`);
      });
    });
    server.once("error", reject);
    server.listen(socket, () => resolve());
    onTestFinished(() => new Promise<void>((done) => server.close(() => (fs.rmSync(socket, { force: true }), done()))));
  });

// ------------------------------------------------------------------ a VM that answers
/** Stands in for the VM layer (host/vm): every exec, into whichever VM, ends with this. */
export const vmAnswering = (code: number, stdout: string, stderr: string) =>
  ({ exec: async () => ({ code, stdout, stderr }) }) as unknown as ReturnType<typeof backend>;

// ------------------------------------------------------------------ a page's request
const logged: string[] = [];
/** A log line kept, as the daemon's own log would keep it. */
export const keepLog = (line: string) => void logged.push(line);

/** A page that fails before it answers (the root did not answer it, say). */
export const failsAtOnce = async () => {
  throw new Error("the root's state service is not there");
};
/** A page that sent its head and part of a body, then failed. */
export const failsHalfway = async (_req: IncomingMessage, res: ServerResponse) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.write("<p>half");
  throw new Error("the reviewer went away");
};
/** A page that answers. */
export const answers = async (_req: IncomingMessage, res: ServerResponse) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("ok");
};

/** What a request handler sent, as a browser would see it, and what was logged meanwhile.
 *  The request and the response are stand-ins with the few members a page uses. */
export const answerOf = async (handler: (req: IncomingMessage, res: ServerResponse) => void) => {
  const answer = { status: 0, heads: 0, body: "", ended: false, logged };
  let ended!: () => void;
  const done = new Promise<void>((resolve) => (ended = resolve));
  const res = {
    headersSent: false,
    writeHead(status: number) {
      answer.status = status;
      answer.heads += 1;
      res.headersSent = true;
      return res;
    },
    write(text: string) {
      answer.body += text;
      return true;
    },
    end(text = "") {
      answer.body += text;
      answer.ended = true;
      ended();
      return res;
    },
  };
  handler({} as IncomingMessage, res as unknown as ServerResponse);
  await done;
  return answer;
};
