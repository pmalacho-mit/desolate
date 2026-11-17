// Harness for editor-gate.ts's tests: one request, as a browser would send it, to the gate in
// front of a stand-in for the editor's server. Both listen on loopback ports of the test's own
// and are closed after it; nothing else is reached. The gate is handed in (`typeof gate`) and
// not imported here, so the module under test is the test's own copy.
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";

type Gate = (editorHost: string, serverPort: number, tokenFile?: string) => http.Server;
export type Sent = { method?: string; path: string; headers: Record<string, string> };
/** What came back, and whether the editor's server ever saw the request. */
export type Answer = { status: number; reached: boolean; csp: string | null };

const listening = (server: http.Server) =>
  new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)),
  );
const closed = (server: http.Server) =>
  new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });

/** `token`: what the editor's token file holds, or null for no file. A WebSocket upgrade is a
 *  request whose headers carry `upgrade`. */
export const throughGate = async (
  open: Gate,
  editorHost: string,
  token: string | null,
  sent: Sent,
): Promise<Answer> => {
  let reached = false;
  const editor = http.createServer((_, res) => {
    reached = true;
    res.writeHead(200, { "content-type": "text/html" });
    res.end("the editor\n");
  });
  editor.on("upgrade", (_, socket) => {
    reached = true;
    socket.end(
      "HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n",
    );
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desolate-gate-"));
  const tokenFile = path.join(dir, "token");
  if (token !== null) fs.writeFileSync(tokenFile, `${token}\n`);
  const gate = open(editorHost, await listening(editor), tokenFile);
  const port = await listening(gate);
  try {
    return await new Promise<Answer>((resolve, reject) => {
      // setHost false: the headers are exactly the test's, Host included.
      const req = http.request({
        host: "127.0.0.1",
        port,
        method: sent.method ?? "GET",
        path: sent.path,
        headers: sent.headers,
        setHost: false,
        agent: false,
      });
      req.on("response", (res) => {
        res.resume();
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            reached,
            csp: (res.headers["content-security-policy"] as string | undefined) ?? null,
          }),
        );
      });
      req.on("upgrade", (res, socket) => {
        socket.destroy();
        resolve({ status: res.statusCode ?? 0, reached, csp: null });
      });
      req.on("error", reject);
      req.end();
    });
  } finally {
    await closed(gate);
    await closed(editor);
    fs.rmSync(dir, { recursive: true, force: true });
  }
};
