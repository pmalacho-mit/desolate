// A workspace's link, where the backend has to carry it over a TCP port on the host's
// loopback (vz: the guest reaches the host through one port its confinement allows).
//
// A loopback port is open to every process on the machine, and what is behind it is one
// workspace's proxy, which will substitute that domain's secrets. And a port is only the
// host daemon's while it holds it: another user of the Mac can take it when it is free (a
// workspace stopping, the daemon restarting) and wait for the guest. So each side proves
// to the other that it knows the token the host made for this workspace, and the token
// itself never crosses (found by an audit on the M1; the first version sent it first, to
// whatever held the port):
//
//   guest -> host   DESOLATE-LINK2 <guest nonce>\n
//   host  -> guest  <host nonce> HMAC(token, "host" gn hn)\n
//   guest -> host   HMAC(token, "guest" gn hn)\n             then the guest's own bytes
//
// The host proves itself first, so a program holding the port learns nothing from the guest
// (not even the names it asks for); a program connecting to the host's port gets a proof it
// cannot turn into the token or into the guest's answer.
//
// (Backends whose link is a unix socket in a directory only the VM is shown need none.)
import { createHmac, randomBytes } from "node:crypto";
import type { Socket } from "node:net";
import { sameSecret } from "./gate.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Invoke, Table, Throws } from "../../suede.nests/dsl.import.meta.vitest.ts";
import type {
  handshake,
  heard,
  impostor,
  saysTooMuch,
  unconnected,
} from "../.harness/shared-link.ts";

const PREFIX = "DESOLATE-LINK2 ";
const TOKEN = /^[0-9a-f]{32}$/;
const NONCE = /^[0-9a-f]{32}$/;
const proof = (token: string, side: "host" | "guest", guestNonce: string, hostNonce: string) =>
  createHmac("sha256", Buffer.from(token, "hex"))
    .update(`${side} ${guestNonce} ${hostNonce}`)
    .digest("hex");

/** Read one line (without its newline) of at most `max` bytes; what follows it is `rest`. */
const line = (
  socket: Socket,
  max: number,
  timeoutMs: number,
): Promise<{ text: string; rest: Buffer } | null> =>
  new Promise((resolve) => {
    let got = Buffer.alloc(0);
    const finish = (value: { text: string; rest: Buffer } | null) => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("close", onClose);
      socket.pause();
      resolve(value);
    };
    const onClose = () => finish(null);
    const onData = (chunk: Buffer) => {
      got = Buffer.concat([got, chunk]);
      const end = got.indexOf(10);
      if (end >= 0)
        return finish({
          text: got.subarray(0, end).toString("latin1"),
          rest: got.subarray(end + 1),
        });
      if (got.length > max) finish(null);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.on("data", onData);
    socket.on("close", onClose);
    socket.on("error", () => {});
    socket.resume();
  });

/** `tcp:<address>:<port>#<token>`, or the same without a token, or `unix:<path>`. */
export const parseLink = (
  link: string,
): { unix: string } | { host: string; port: number; token: string | null } | null => {
  if (link.startsWith("unix:") && link.length > 5) return { unix: link.slice(5) };
  const match = /^tcp:([0-9.]+):(\d+)(?:#([0-9a-f]{32}))?$/.exec(link);
  return match ? { host: match[1]!, port: Number(match[2]), token: match[3] ?? null } : null;
};

declare namespace parseLink {
  /** a loopback port and the link's token, the same without one, or a unix socket's path */
  export type Links = Table<
    typeof parseLink,
    [
      [
        args: [link: "tcp:127.0.0.1:31600#0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a"],
        expected: { host: "127.0.0.1"; port: 31600; token: "0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a" },
      ],
      [
        args: [link: "tcp:127.0.0.1:31600"],
        expected: { host: "127.0.0.1"; port: 31600; token: null },
      ],
      [args: [link: "unix:/run/desolate/link.sock"], expected: { unix: "/run/desolate/link.sock" }],
    ]
  >;
  /** a name, not an address; a token of another length or case; nothing after `unix:` */
  export type Refuses = Table<
    typeof parseLink,
    [
      [args: [link: "tcp:localhost:31600"], expected: null],
      [args: [link: "tcp:127.0.0.1:31600#0A0A"], expected: null],
      [args: [link: "tcp:127.0.0.1:31600#0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0aff"], expected: null],
      [args: [link: "unix:"], expected: null],
    ]
  >;
}

/** The guest's end, on a connected socket: true once the host has proved itself and the
 *  guest has answered; the socket is then the link. false (and the socket destroyed) for
 *  anything else: the token is never sent. */
export const open = async (socket: Socket, token: string, timeoutMs = 10_000): Promise<boolean> => {
  if (!TOKEN.test(token)) throw new Error("a link token is 32 hex characters");
  const guestNonce = randomBytes(16).toString("hex");
  socket.write(`${PREFIX}${guestNonce}\n`);
  const answer = await line(socket, 200, timeoutMs);
  const match = answer && /^([0-9a-f]{32}) ([0-9a-f]{64})$/.exec(answer.text);
  if (
    !answer ||
    !match ||
    answer.rest.length > 0 ||
    !sameSecret(match[2]!, proof(token, "host", guestNonce, match[1]!))
  ) {
    socket.destroy();
    return false;
  }
  socket.write(`${proof(token, "guest", guestNonce, match[1]!)}\n`);
  socket.resume();
  return true;
};

declare namespace open {
  /** the program holding the port does not know the token: the guest refuses it, and all it
   *  was ever sent is the guest's first line, a nonce and no token */
  export type Impostor = [
    Expect<
      Invoke<
        typeof handshake,
        [
          guestEnd: typeof open,
          hostEnd: typeof impostor,
          guestToken: "0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a",
          hostToken: "0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a",
        ]
      >,
      "matches",
      { guest: false }
    >,
    Expect<
      Invoke<
        typeof heard,
        [
          guestEnd: typeof open,
          hostEnd: typeof impostor,
          guestToken: "0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a",
          hostToken: "0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a",
        ]
      >,
      "matches",
      "^DESOLATE-LINK2 [0-9a-f]{32}\n$"
    >,
  ];
  /** a token that is not one is a mistake in the caller, said at once */
  export type BadToken = Throws<
    Invoke<typeof open, [socket: Invoke<typeof unconnected>, token: "secret"]>,
    "a link token is 32 hex characters"
  >;
}

/** The host's end: resolves with whatever followed the guest's answer if this was this
 *  link's guest, or null (and the socket destroyed) if it was not, said too much, or did
 *  not finish in time. */
export const accept = async (
  socket: Socket,
  token: string,
  timeoutMs = 10_000,
): Promise<Buffer | null> => {
  const fail = () => {
    socket.destroy();
    return null;
  };
  if (!TOKEN.test(token)) return fail();
  const deadline = Date.now() + timeoutMs;
  const first = await line(socket, PREFIX.length + 40, timeoutMs);
  if (!first || !first.text.startsWith(PREFIX) || first.rest.length > 0) return fail();
  const guestNonce = first.text.slice(PREFIX.length);
  if (!NONCE.test(guestNonce)) return fail();
  const hostNonce = randomBytes(16).toString("hex");
  socket.write(`${hostNonce} ${proof(token, "host", guestNonce, hostNonce)}\n`);
  const second = await line(socket, 100, Math.max(1, deadline - Date.now()));
  if (!second || !sameSecret(second.text, proof(token, "guest", guestNonce, hostNonce)))
    return fail();
  return second.rest;
};

declare namespace accept {
  /** the control: both ends know the token; the host is handed what the guest sent after */
  export type Linked = Expect<
    Invoke<
      typeof handshake,
      [
        guestEnd: typeof open,
        hostEnd: typeof accept,
        guestToken: "0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a",
        hostToken: "0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a",
      ]
    >,
    "=",
    { guest: true; host: "hello" }
  >;
  /** another token: neither end lets the other in */
  export type OtherToken = Expect<
    Invoke<
      typeof handshake,
      [
        guestEnd: typeof open,
        hostEnd: typeof accept,
        guestToken: "0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a",
        hostToken: "0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b",
      ]
    >,
    "=",
    { guest: false; host: null }
  >;
  /** a client that says more than its first line before the host has proved itself */
  export type SaysTooMuch = Expect<
    Invoke<
      typeof handshake,
      [
        guestEnd: typeof saysTooMuch,
        hostEnd: typeof accept,
        guestToken: "0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a",
        hostToken: "0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a",
      ]
    >,
    "=",
    { guest: false; host: null }
  >;
  /** a host with no good token lets nothing in */
  export type BadToken = Expect<
    Invoke<typeof accept, [socket: Invoke<typeof unconnected>, token: "secret"]>,
    "=",
    null
  >;
}
