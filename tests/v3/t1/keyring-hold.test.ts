// T1. A raw push's request lives as long as whoever asked for it waits (root/keyring.ts): the
// keyring holds the challenge on the asker's connection, with no clock, and drops it the
// moment that connection closes. Driven here on real connections to the keyring's control
// operations; the signature that would file the approval is root's to install, so T2 and T4
// show the rest (approved, claimed, released). What T1 can show: whether a challenge is still
// outstanding, by the refusal a text answering it gets. One that is outstanding gets as far
// as the approver's key (none here); one that is not is refused before.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createServer, connect } from "node:net";
import type { Socket } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it, mock } from "node:test";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "desolate-keyring-hold-"));
for (const [name, dir] of [
  ["DESOLATE_ROOT_SYS", "sys"],
  ["DESOLATE_ROOT_RUN", "run"],
  ["DESOLATE_ROOT_STATE", "state"],
] as const) {
  process.env[name] = path.join(home, dir);
  fs.mkdirSync(path.join(home, dir), { recursive: true });
}
// acme/app is pushable: the keyring holds its write key.
fs.mkdirSync(path.join(home, "sys", "keyring", "acme", "app"), { recursive: true });
fs.writeFileSync(path.join(home, "sys", "keyring", "acme", "app", "write"), "a private key");

const { publicOps, serve, CHALLENGE } = await import("../../../release/root/keyring.ts");
const { parseApproval, signedFor } = await import("../../../release/shared/approval.ts");

const NOT_OUTSTANDING =
  "that challenge is not outstanding: each approves once, and only while whoever asked for it waits";
let server: ReturnType<typeof createServer>;
const accepted: Socket[] = [];
const socketPath = path.join(home, "run", "control.sock");
before(async () => {
  server = createServer((socket) => void accepted.push(socket));
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
});
after(() => {
  server.close();
  fs.rmSync(home, { recursive: true, force: true });
});

/** A connection to the keyring, as a raw push holds one: the keyring's end, and the asker's,
 *  with every line the keyring writes on it. */
const connection = async () => {
  const asker = connect(socketPath);
  await new Promise<void>((resolve) => asker.once("connect", () => resolve()));
  while (accepted.length === 0) await new Promise((resolve) => setImmediate(resolve));
  const keyringEnd = accepted.shift()!;
  const heard: Record<string, unknown>[] = [];
  let buffer = "";
  asker.on("data", (chunk) => {
    buffer += chunk.toString();
    for (let i; (i = buffer.indexOf("\n")) >= 0; buffer = buffer.slice(i + 1))
      heard.push(JSON.parse(buffer.slice(0, i)) as Record<string, unknown>);
  });
  const closed = new Promise<void>((resolve) => keyringEnd.once("close", () => resolve()));
  return { keyringEnd, asker, heard, closed };
};
const ask = (hold: boolean, socket?: Socket) =>
  publicOps(
    {
      op: "challenge",
      repo: "acme/app",
      ref: "main",
      commit: "0123456789abcdef0123456789abcdef01234567",
      onto: null,
      ...(hold ? { hold: true } : {}),
    },
    socket,
  );
/** The person's answer to a challenge: its text with what the push sends, and a signature
 *  (not the approver's: there is none here). */
const answer = (message: unknown) =>
  publicOps({
    op: "approve",
    message: signedFor(String(message), {
      commit: "0123456789abcdef0123456789abcdef01234567",
      squashes: null,
      pack: "e".repeat(64),
      lfs: { count: 0, digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" },
    }),
    signature: "AAAA",
  });
const ONE_DAY = 24 * 60 * 60_000;

describe("T1 a push's request lives as long as its asker waits", () => {
  it("held, it is outstanding a day later; control: one nobody holds is not, after its two minutes", async () => {
    const { keyringEnd, asker } = await connection();
    const held = ask(true, keyringEnd);
    const unheld = ask(false);
    assert.equal(held.ok, true);
    assert.equal(unheld.ok, true);
    mock.timers.enable({ apis: ["Date"], now: Date.now() + ONE_DAY });
    try {
      const late = answer(held.message);
      // Outstanding: refused only where the approver's signature is looked at.
      assert.notEqual(late.error, NOT_OUTSTANDING);
      assert.match(String(late.error), /approver/);
      // What holding it for a day gained: nothing a signature over its exact text does not.
      assert.equal(late.ok, false);
      assert.equal(
        answer(unheld.message).error,
        NOT_OUTSTANDING,
        "control: a clock for the unheld",
      );
    } finally {
      mock.timers.reset();
      asker.destroy();
    }
  });

  it("whoever asked goes away (its connection closes): the request goes, and cannot be approved", async () => {
    const { keyringEnd, asker, closed } = await connection();
    const held = ask(true, keyringEnd);
    assert.notEqual(
      answer(held.message).error,
      NOT_OUTSTANDING,
      "control: while it waits, it is outstanding",
    );
    const again = ask(true, keyringEnd);
    asker.destroy();
    await closed;
    assert.equal(answer(again.message).error, NOT_OUTSTANDING);
  });

  it("asked for in a loop, the oldest requests are dropped and their askers told; a held one is no exception", async () => {
    const { keyringEnd, asker, heard, closed } = await connection();
    const held = ask(true, keyringEnd);
    const nonce = parseApproval(held.message)!.nonce;
    for (let i = 0; i < CHALLENGE.outstanding; i++) ask(false);
    await closed;
    assert.deepEqual(heard, [
      {
        dropped: nonce,
        error: `the keyring dropped this push's request: more than ${CHALLENGE.outstanding} were waiting at once`,
      },
    ]);
    assert.equal(answer(held.message).error, NOT_OUTSTANDING);
    asker.destroy();
  });

  it("pushes waiting for a person never fill the socket; a connection that stops holding counts again", async () => {
    const at = path.join(home, "run", "served.sock");
    const served = await serve(at, 0o600, publicOps);
    after(() => served.close());
    /** A connection, its lines, and the first of them once one comes. */
    const open = async () => {
      // Its own side left open when the keyring ends its: as a process that means to keep a
      // connection would.
      const socket = connect({ path: at, allowHalfOpen: true });
      await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
      const lines: Record<string, unknown>[] = [];
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        for (let i; (i = buffer.indexOf("\n")) >= 0; buffer = buffer.slice(i + 1))
          lines.push(JSON.parse(buffer.slice(0, i)) as Record<string, unknown>);
      });
      socket.on("error", () => {});
      const said = async (request: Record<string, unknown>) => {
        const before = lines.length;
        socket.write(JSON.stringify(request) + "\n");
        for (let t = 0; lines.length === before; t++) {
          if (t === 400)
            throw new Error(
              `no answer to ${JSON.stringify(request)} (closed: ${socket.destroyed})`,
            );
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        return lines[before]!;
      };
      return { socket, said, lines };
    };
    const request = {
      op: "challenge",
      repo: "acme/app",
      ref: "main",
      commit: "0123456789abcdef0123456789abcdef01234567",
      hold: true,
    };
    // Sixteen pushes, each holding its request, as many as the socket takes connections.
    const waiting = [];
    for (let i = 0; i < 16; i++) {
      const one = await open();
      assert.equal((await one.said(request)).ok, true);
      waiting.push(one);
    }
    const another = await open();
    assert.equal((await another.said({ op: "list" })).ok, true, "a seventeenth is still answered");
    another.socket.destroy();
    // Each request dropped for newer ones: the connections, left open by their side, are
    // ordinary again, and fill the socket as sixteen idle ones would.
    for (let i = 0; i < CHALLENGE.outstanding; i++) ask(false);
    const refused = await open();
    assert.deepEqual(await refused.said({ op: "list" }), {
      ok: false,
      error: "too many connections",
    });
    for (const one of waiting) one.socket.destroy();
    refused.socket.destroy();
  });
});
