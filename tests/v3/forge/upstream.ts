// A stand-in for "a host on the internet", in the forge's container: HTTP on 80 and HTTPS on
// 443 (its own CA, written to the state directory for a test's client to trust). It says
// which name it was asked for and logs every request, so a test can tell what reached it.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as path from "node:path";
import { append, STATE } from "./common.ts";

const key = path.join(STATE, "upstream.key");
const cert = path.join(STATE, "upstream.crt");
if (!fs.existsSync(cert))
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "2",
      "-subj",
      "/CN=desolate test upstream",
      "-addext",
      "subjectAltName=DNS:api.example.test,DNS:*.example.test,DNS:other.example.test",
    ],
    { stdio: "ignore" },
  );
fs.chmodSync(cert, 0o644);
const handler =
  (scheme: string) => (request: http.IncomingMessage, response: http.ServerResponse) => {
    // A body is counted and hashed, not kept: a test sends some of hundreds of MiB. Its first
    // 500 characters are kept to be read.
    let body = "";
    let bytes = 0;
    const hash = createHash("sha256");
    request.on("data", (chunk: Buffer) => {
      if (body.length < 500) body += chunk.subarray(0, 500).toString("latin1");
      bytes += chunk.length;
      hash.update(chunk);
    });
    request.on("end", () => {
      append("upstream.log", {
        scheme,
        host: request.headers.host,
        path: request.url,
        authorization: request.headers.authorization ?? null,
        apiKey: request.headers["x-api-key"] ?? null,
        body: body.slice(0, 500),
        bytes,
        sha256: hash.digest("hex"),
      });
      // /download?n=<bytes>&at=<offset>: n bytes, with the Authorization it was sent written in
      // at the offset, as a server that reflects its input in a large answer would.
      if (request.url?.startsWith("/download")) {
        const query = new URL(request.url, "http://x").searchParams;
        const n = Number(query.get("n") ?? 0);
        const at = Number(query.get("at") ?? -1);
        const echo = Buffer.from(String(request.headers.authorization ?? ""), "latin1");
        response.setHeader("content-length", String(n));
        let sent = 0;
        const more = () => {
          while (sent < n) {
            const chunk = Buffer.alloc(Math.min(65536, n - sent), "d");
            if (at >= sent && at < sent + chunk.length) echo.copy(chunk, at - sent);
            sent += chunk.length;
            if (!response.write(chunk)) return void response.once("drain", more);
          }
          response.end();
        };
        return more();
      }
      // /echo says back what it was sent, as an API that reflects its input would.
      const echo = request.url?.startsWith("/echo")
        ? ` authorization=${request.headers.authorization ?? ""}`
        : "";
      if (echo) response.setHeader("x-echo", String(request.headers.authorization ?? ""));
      response.end(`upstream ${scheme} host=${request.headers.host} path=${request.url}${echo}\n`);
    });
  };
http.createServer(handler("http")).listen(80, "0.0.0.0");
https
  .createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, handler("https"))
  .listen(443, "0.0.0.0");
