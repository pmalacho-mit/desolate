// One request to one of the keyring's sockets.
import { connect } from "node:net";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Call, Expect, Given, Invoke, Throws } from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { aSocketAnswering } from "../.harness/root-socket.ts";

export const ask = (socketPath: string, request: Record<string, unknown>, timeoutMs = 10_000): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const connection = connect(socketPath);
    let buffer = "";
    const timer = setTimeout(() => {
      connection.destroy();
      reject(new Error(`the keyring did not answer at ${socketPath} within ${timeoutMs} ms`));
    }, timeoutMs);
    connection.on("connect", () => connection.write(JSON.stringify(request) + "\n"));
    connection.on("data", (chunk) => {
      buffer += chunk.toString();
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      clearTimeout(timer);
      connection.end();
      try {
        resolve(JSON.parse(buffer.slice(0, index)) as Record<string, unknown>);
      } catch (error) {
        reject(error as Error);
      }
    });
    connection.on("error", (error) => {
      clearTimeout(timer);
      reject(Object.assign(new Error(`cannot reach ${socketPath}: ${error.message}`), { code: (error as NodeJS.ErrnoException).code }));
    });
  });

declare namespace ask {
  type Keyring = Invoke<typeof aSocketAnswering, [line: '{"ok":true,"keys":[]}']>;
  /** one request, as one line of JSON; the first line of the answer, parsed */
  export type Asks = Given<
    Keyring,
    [
      Expect<Invoke<typeof ask, [socketPath: Keyring["socket"], request: { op: "list" }]>, "=", { ok: true; keys: [] }>,
      Expect<Call<Keyring, "asked">, "=", ['{"op":"list"}']>,
    ]
  >;
  type Garbled = Invoke<typeof aSocketAnswering, [line: "not json"]>;
  /** an answer that is not JSON is a failure, not an empty answer */
  export type NotJson = Given<Garbled, Throws<Invoke<typeof ask, [socketPath: Garbled["socket"], request: { op: "list" }]>, SyntaxError>>;
  /** no socket: a failure that says where it looked, with the errno code (what a caller
   *  waiting for a process to start reads: review-client.ts, send.ts) */
  export type Unreachable = Throws<Invoke<typeof ask, [socketPath: "/nonexistent/keyring/control.sock", request: { op: "list" }]>, { message: "cannot reach /nonexistent/keyring/control.sock: connect ENOENT /nonexistent/keyring/control.sock" }>;
}
