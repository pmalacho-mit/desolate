// Harness for the in-source tests of shared/sniff.ts: the first bytes of a connection, as a
// client would send them. A ClientHello is built here field by field, as TLS lays it out (an
// extension before the server name, so the reader has to walk them), instead of being
// captured from a real client over a socket.

const u16 = (n: number) => Buffer.from([n >> 8, n & 0xff]);

/** Text as the bytes on the wire, one byte a character. */
export const bytes = (text: string) => Buffer.from(text, "latin1");

/** `count` copies of `text`, as bytes: what a client sends that does not stop. */
export const repeated = (text: string, count: number) => Buffer.from(text.repeat(count), "latin1");

/** A TLS 1.2 record holding a ClientHello, with `name` as its server name (none for null),
 *  cut to its first `keep` bytes if asked (a record still arriving). */
export const clientHello = (name: string | null, keep?: number) => {
  const sni =
    name === null
      ? Buffer.alloc(0)
      : (() => {
          const host = Buffer.from(name, "latin1");
          const list = Buffer.concat([Buffer.from([0]), u16(host.length), host]);
          return Buffer.concat([u16(0), u16(list.length + 2), u16(list.length), list]);
        })();
  const versions = Buffer.concat([u16(0x2b), u16(3), Buffer.from([2, 3, 4])]);
  const extensions = Buffer.concat([versions, sni]);
  const body = Buffer.concat([
    Buffer.from([3, 3]),
    Buffer.alloc(32),
    Buffer.from([0]),
    u16(2),
    Buffer.from([0x13, 0x01]),
    Buffer.from([1, 0]),
    u16(extensions.length),
    extensions,
  ]);
  const handshake = Buffer.concat([
    Buffer.from([1, 0, body.length >> 8, body.length & 0xff]),
    body,
  ]);
  const record = Buffer.concat([Buffer.from([0x16, 3, 1]), u16(handshake.length), handshake]);
  return keep === undefined ? record : record.subarray(0, keep);
};
