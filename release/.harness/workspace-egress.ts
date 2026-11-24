// Harness for egress.ts's tests: a program's connection to port 80 or 443, the relay, and the
// workspace's proxy at the link's other end. The proxy is a stand-in on a unix socket in the
// test file's home: it reads the CONNECT, gives the answer the test says, and once that is a
// 200, it is the destination too, which answers "the destination's answer" to what it is sent.
// The relay listens on a loopback port of the test's own. `serve` is handed in, so the
// module under test is the test's own copy. Nothing leaves the machine.
import * as fs from "node:fs";
import * as net from "node:net";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { clientHello } from "./shared-bytes.ts";

type Serve = (
  link: { unix: string },
  port: number,
  scheme: "http" | "https",
  host?: string,
) => net.Server;
export type Seen = { proxyAsked: string | null; destinationGot: string | null; client: string };

let made = 0;

/** `sent`: an HTTP request as text, or a TLS ClientHello naming that server (null: none).
 *  `proxy`: its answer to the CONNECT, or null for no proxy at all.
 *  @standsIn release/root/proxy/proxy.ts (the workspace's proxy, at the link's other end)
 *  @realIn T2 05-egress, "the relay inside the workspace is not the boundary: without it, the proxy still decides" */
export const throughEgress = async (
  serve: Serve,
  scheme: "http" | "https",
  sent: string | { tls: string | null },
  proxy: string | null,
): Promise<Seen> => {
  const file = path.join(process.env.DESOLATE_HOME!, `egress-${process.pid}-${made++}.sock`);
  let proxyAsked: string | null = null;
  let destinationGot: string | null = null;
  const stand =
    proxy === null
      ? null
      : net.createServer((conn) => {
          let head = Buffer.alloc(0);
          conn.on("error", () => {});
          const onData = (chunk: Buffer) => {
            head = Buffer.concat([head, chunk]);
            const end = head.indexOf("\r\n\r\n");
            if (end < 0) return;
            conn.off("data", onData);
            proxyAsked = head.subarray(0, end + 4).toString("latin1");
            conn.write(proxy);
            if (!/^HTTP\/1\.1 200 /.test(proxy)) return conn.end();
            conn.on("data", (bytes: Buffer) => {
              destinationGot = (destinationGot ?? "") + bytes.toString("latin1");
              conn.end("the destination's answer");
            });
          };
          conn.on("data", onData);
        });
  if (stand) await new Promise<void>((resolve) => stand.listen(file, resolve));
  const relay = serve({ unix: file }, 0, scheme, "127.0.0.1");
  await new Promise<void>((resolve) =>
    relay.listening ? resolve() : relay.once("listening", () => resolve()),
  );
  try {
    const client = await new Promise<string>((resolve, reject) => {
      const socket = net.connect((relay.address() as AddressInfo).port, "127.0.0.1");
      let got = "";
      socket.on("data", (chunk) => (got += chunk.toString("latin1")));
      socket.on("close", () => resolve(got));
      socket.on("error", (error: NodeJS.ErrnoException) =>
        error.code === "ECONNRESET" ? undefined : reject(error),
      );
      socket.write(typeof sent === "string" ? Buffer.from(sent, "latin1") : clientHello(sent.tls));
    });
    return { proxyAsked, destinationGot: destinationGot === null ? null : destinationGot, client };
  } finally {
    relay.close();
    stand?.close();
    fs.rmSync(file, { force: true });
  }
};

/** `text` as the UTF-8 bytes the proxy writes (a string goes out of node as UTF-8). */
export const utf8 = (text: string) => Buffer.from(text, "utf8");
/** A refusal whose reason is `length` x's. */
export const repeatedReason = (length: number) =>
  Buffer.from(
    `HTTP/1.1 403 Forbidden\r\nX-Desolate-Reason: ${"x".repeat(length)}\r\n\r\n`,
    "latin1",
  );
