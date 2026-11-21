// One request to one of the keyring's sockets (or the reviewer's, or the pusher's: the same
// one line of JSON each way).
import { connect } from "node:net";
import type { Socket } from "node:net";
import { PUSHER, REVIEWER } from "./layout.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type {
  Call,
  Expect,
  Given,
  Invoke,
  Table,
  Throws,
} from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { aSocketAnswering } from "../.harness/root-socket.ts";

/** Who listens at a socket, as a refusal names it. */
export const whose = (socketPath: string): string =>
  socketPath.startsWith(`${REVIEWER.run}/`)
    ? "the reviewer"
    : socketPath.startsWith(`${PUSHER.run}/`)
      ? "the pusher"
      : "the keyring";

declare namespace whose {
  /** "the keyring did not answer" was said of the reviewer and the pusher too */
  export type Names = Table<
    typeof whose,
    [
      [args: [socketPath: "/run/desolate/reviewer/control.sock"], expected: "the reviewer"],
      [args: [socketPath: "/run/desolate/pusher/control.sock"], expected: "the pusher"],
      [args: [socketPath: "/run/desolate/keyring/control.sock"], expected: "the keyring"],
      [args: [socketPath: "/run/desolate/keyring-write/pusher.sock"], expected: "the keyring"],
    ]
  >;
}

/** The first answer to `request` on a new connection. `timeoutMs` is for that one answer:
 *  each of these processes answers at once, from memory, so a silence is one that hangs. */
const first = (
  socketPath: string,
  request: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ answer: Record<string, unknown>; connection: Socket; rest: string }> =>
  new Promise((resolve, reject) => {
    const connection = connect(socketPath);
    let buffer = "";
    const timer = setTimeout(() => {
      connection.destroy();
      reject(
        new Error(`${whose(socketPath)} did not answer at ${socketPath} within ${timeoutMs} ms`),
      );
    }, timeoutMs);
    connection.on("connect", () => connection.write(JSON.stringify(request) + "\n"));
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      clearTimeout(timer);
      connection.off("data", onData);
      connection.off("error", onError);
      connection.pause();
      try {
        resolve({
          answer: JSON.parse(buffer.slice(0, index)) as Record<string, unknown>,
          connection,
          rest: buffer.slice(index + 1),
        });
      } catch (error) {
        connection.destroy();
        reject(error as Error);
      }
    };
    const onError = (error: Error) => {
      clearTimeout(timer);
      reject(
        Object.assign(new Error(`cannot reach ${socketPath}: ${error.message}`), {
          code: (error as NodeJS.ErrnoException).code,
        }),
      );
    };
    connection.on("data", onData);
    connection.on("error", onError);
  });

export const ask = async (
  socketPath: string,
  request: Record<string, unknown>,
  timeoutMs = 10_000,
): Promise<Record<string, unknown>> => {
  const { answer, connection } = await first(socketPath, request, timeoutMs);
  connection.end();
  connection.resume();
  return answer;
};

/** A request whose answer is held for as long as this connection is open: a challenge a raw
 *  push waits on, an approval `desolate push` is about to hand the pusher, the pusher's claim
 *  (keyring.ts). `told` is each later line the keyring says on it (that the challenge was
 *  approved, or dropped); `ended` settles when the connection closes, from either side.
 *  `release` closes it, which gives back what it held. The process ending closes it too. */
export type Held = {
  answer: Record<string, unknown>;
  told: (line: Record<string, unknown>) => void;
  ended: Promise<void>;
  release: () => void;
};
export const hold = async (
  socketPath: string,
  request: Record<string, unknown>,
  told: (line: Record<string, unknown>) => void = () => {},
  timeoutMs = 10_000,
): Promise<Held> => {
  const { answer, connection, rest } = await first(socketPath, request, timeoutMs);
  const held: Held = {
    answer,
    told,
    ended: new Promise((resolve) => connection.once("close", () => resolve())),
    release: () => connection.destroy(),
  };
  if (answer.ok !== true) connection.destroy();
  let buffer = rest;
  const lines = () => {
    for (let index; (index = buffer.indexOf("\n")) >= 0;) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      try {
        held.told(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // Not a line of the keyring's: what it holds is no longer to be trusted as held.
        connection.destroy();
      }
    }
  };
  connection.on("error", () => connection.destroy());
  connection.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    lines();
  });
  lines();
  connection.resume();
  return held;
};

declare namespace ask {
  type Keyring = Invoke<typeof aSocketAnswering, [line: '{"ok":true,"keys":[]}']>;
  /** one request, as one line of JSON; the first line of the answer, parsed */
  export type Asks = Given<
    Keyring,
    [
      Expect<
        Invoke<typeof ask, [socketPath: Keyring["socket"], request: { op: "list" }]>,
        "=",
        { ok: true; keys: [] }
      >,
      Expect<Call<Keyring, "asked">, "=", ['{"op":"list"}']>,
    ]
  >;
  type Garbled = Invoke<typeof aSocketAnswering, [line: "not json"]>;
  /** an answer that is not JSON is a failure, not an empty answer */
  export type NotJson = Given<
    Garbled,
    Throws<
      Invoke<typeof ask, [socketPath: Garbled["socket"], request: { op: "list" }]>,
      SyntaxError
    >
  >;
  /** no socket: a failure that says where it looked, with the errno code (what a caller
   *  waiting for a process to start reads: review-client.ts, send.ts) */
  export type Unreachable = Throws<
    Invoke<typeof ask, [socketPath: "/nonexistent/keyring/control.sock", request: { op: "list" }]>,
    {
      message: "cannot reach /nonexistent/keyring/control.sock: connect ENOENT /nonexistent/keyring/control.sock";
    }
  >;
}
