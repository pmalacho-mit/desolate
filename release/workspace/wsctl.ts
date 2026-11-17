// One request to the workspace daemon: stdin is the JSON request, stdout the JSON reply.
import * as fs from "node:fs";
import { connect } from "node:net";
import type { Socket } from "node:net";
import { fileURLToPath } from "node:url";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Invoke } from "../../.suede/nests/dsl.import.meta.vitest.ts";
import type { wsctlAsking } from "../../tests/nests/workspace-socket.harness.ts";

/** Send `input` to the daemon at `socket` as one line, and hand its reply to `write`; a
 *  daemon that is not there is a reply too, a JSON refusal, so the host always reads JSON. */
export const ask = (input: string, socket: string, write: (text: string) => void): Socket => {
  const connection = connect(socket);
  let output = "";
  connection.on("connect", () => connection.write(input.trim() + "\n"));
  connection.on("data", (chunk) => (output += chunk));
  connection.on("end", () => write(output));
  connection.on("error", (error) => {
    write(JSON.stringify({ ok: false, error: `the workspace daemon is not answering: ${error.message}` }) + "\n");
  });
  return connection;
};

declare namespace ask {
  /** the request goes as one line, whatever whitespace stdin had around it; the reply comes
   *  back as the daemon wrote it */
  export type Relays = Expect<
    Invoke<typeof wsctlAsking, [ask: typeof ask, input: '\n{"op":"ports","reserve":[5173]}\n\n', reply: '{"ok":true,"listeners":[3000]}\n']>,
    "=",
    { daemonGot: '{"op":"ports","reserve":[5173]}\n'; written: ['{"ok":true,"listeners":[3000]}\n'] }
  >;
  /** no daemon: still one JSON line, which says so */
  export type NoDaemon = [
    Expect<Invoke<typeof wsctlAsking, [ask: typeof ask, input: '{"op":"ports"}', reply: null]>["written"]["length"], "=", 1>,
    Expect<Invoke<typeof wsctlAsking, [ask: typeof ask, input: '{"op":"ports"}', reply: null]>["written"][0], "matches", '^\\{"ok":false,"error":"the workspace daemon is not answering: connect ENOENT .*"\\}\\n$'>,
  ];
}

const main = async () => {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  ask(input, "/run/desolate/wsd.sock", (text) => process.stdout.write(text));
};

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
