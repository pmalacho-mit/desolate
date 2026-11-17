// Harness for in-source tests of the pusher's half of git's push protocol (root/pusher.ts): a
// forge's receive-pack, scripted. What it says is fixed before the conversation starts (its ref
// list, then its report), and what the pusher writes to it is kept, so a test can say what was
// asked for. A real receive-pack is T1's (tests/v3/t1/pusher.test.ts).
import { PassThrough } from "node:stream";
import type { Writable } from "node:stream";

const pkt = (text: string) =>
  `${(Buffer.byteLength(text) + 4).toString(16).padStart(4, "0")}${text}`;

/** A forge whose receive-pack lists `refs` (the first line carries its capabilities after a
 *  NUL, as git's does), and then, if it is asked for an update, reports `report`. Each line is
 *  sent as one pkt-line; a flush ends each list. `raw` is sent as it is instead, for a forge
 *  that does not speak the protocol. */
export const forgeSaying = (refs: string[], report: string[] = [], raw?: string) => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let asked = "";
  stdin.on("data", (chunk: Buffer) => (asked += chunk.toString("latin1")));
  stdout.end(
    raw ?? [...refs.map(pkt), "0000", ...report.map(pkt), report.length ? "0000" : ""].join(""),
  );
  return { stdin, stdout, asked: () => asked };
};

/** The pack the root's user sent, as the pusher forwards it: bytes it never reads. */
export const aPack = async (sink: Writable) => {
  sink.write("PACK");
};

/** A pack that fails on the way: the connection to the root's user broke. */
export const aBrokenPack = async (_sink: Writable) => {
  throw new Error("the connection ended before everything arrived");
};
