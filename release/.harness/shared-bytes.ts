// Harness for the in-source tests of shared/sniff.ts: the first bytes of a connection, as a
// client would send them. A ClientHello is built here field by field, as TLS lays it out (an
// extension before the server name, so the reader has to walk them), instead of being
// captured from a real client over a socket.

const u16 = (n: number) => Buffer.from([n >> 8, n & 0xff]);

/** Text as the bytes on the wire, one byte a character. */
export const bytes = (text: string) => Buffer.from(text, "latin1");

/** `count` copies of `text`, as bytes: what a client sends that does not stop. */
export const repeated = (text: string, count: number) => Buffer.from(text.repeat(count), "latin1");

const extension = (type: number, body: Buffer) =>
  Buffer.concat([u16(type), u16(body.length), body]);
const serverName = (name: string) => {
  const host = Buffer.from(name, "latin1");
  const list = Buffer.concat([Buffer.from([0]), u16(host.length), host]);
  return extension(0, Buffer.concat([u16(list.length), list]));
};
const versions = extension(0x2b, Buffer.from([2, 3, 4]));
/** Where the extensions' length is in a hello `message` builds: after its type and length
 *  (4), version (2), random (32), session id (1), cipher suites (4), compression (2). */
const EXTENSIONS_AT = 45;

/** A ClientHello handshake message (its type, its 3-byte length, its body) with these
 *  extensions, in order. */
const message = (extensions: Buffer[]) => {
  const all = Buffer.concat(extensions);
  const body = Buffer.concat([
    Buffer.from([3, 3]),
    Buffer.alloc(32),
    Buffer.from([0]),
    u16(2),
    Buffer.from([0x13, 0x01]),
    Buffer.from([1, 0]),
    u16(all.length),
    all,
  ]);
  return Buffer.concat([Buffer.from([1, 0]), u16(body.length), body]);
};

/** `hello` in TLS records, a new one starting at each offset of `splits`: how a client may
 *  send a hello, and how a server reassembles it. */
const records = (hello: Buffer, splits: number[] = []) => {
  const cuts = [0, ...splits, hello.length];
  return Buffer.concat(
    cuts.slice(1).map((end, i) => {
      const part = hello.subarray(cuts[i], end);
      return Buffer.concat([Buffer.from([0x16, 3, 1]), u16(part.length), part]);
    }),
  );
};

/** A TLS 1.2 record holding a ClientHello, with `name` as its server name (none for null),
 *  cut to its first `keep` bytes if asked (a record still arriving). */
export const clientHello = (name: string | null, keep?: number) => {
  const record = records(message(name === null ? [versions] : [versions, serverName(name)]));
  return keep === undefined ? record : record.subarray(0, keep);
};

/** clientHello(name) in two records, the second starting `at` bytes into the hello (47: just
 *  after the extensions' length; 50: inside the first extension; 61: inside the server name). */
export const splitHello = (name: string, at: number) =>
  records(message([versions, serverName(name)]), [at]);

/** A hello whose server name is `real`, in two records, laid out so that its bytes read as one
 *  flat buffer, the second record's header among them, walk to a well-formed server name
 *  `seen` hidden in a padding extension. `split: false` sends it in one record. */
export const crossedHello = (seen: string, real: string, split: boolean) => {
  const named = serverName(real);
  const hidden = Buffer.concat([serverName(seen), Buffer.alloc(8)]);
  // The last 5 bytes of the first padding: read 5 bytes early (the header inserted), they are
  // an extension header whose length skips to `hidden`.
  const skip = 1 + named.length + 4;
  const first = Buffer.concat([Buffer.alloc(8), u16(0x15), u16(skip), Buffer.from([0])]);
  const hello = message([extension(0x15, first), named, extension(0x15, hidden)]);
  return records(hello, split ? [EXTENSIONS_AT + 2 + 4 + 4] : []);
};

/** A hello in one record, its server name `a.example` first (`none`), or not well formed in
 *  one way:
 *  `longer`: its handshake length is longer than its record;
 *  `extensions`: its extensions' length runs past the hello;
 *  `name`: its server name's length runs past its extension;
 *  `twice`: two server_name extensions (`a.example`, then `b.example`);
 *  and `ech`, well formed: an outer name (`public.example`) and an Encrypted Client Hello extension (0xfe0d). */
export const faultyHello = (fault: "none" | "longer" | "extensions" | "name" | "twice" | "ech") => {
  if (fault === "twice")
    return records(message([serverName("a.example"), serverName("b.example")]));
  if (fault === "ech")
    return records(message([serverName("public.example"), extension(0xfe0d, Buffer.alloc(16))]));
  const hello = message([serverName("a.example"), versions]);
  if (fault === "longer") hello.writeUInt16BE(hello.readUInt16BE(2) + 1, 2);
  if (fault === "extensions")
    hello.writeUInt16BE(hello.readUInt16BE(EXTENSIONS_AT) + 1, EXTENSIONS_AT);
  // The name's length: after the extensions' length (2), the extension's type and length (4),
  // the list's length (2) and the name's type (1).
  if (fault === "name")
    hello.writeUInt16BE(hello.readUInt16BE(EXTENSIONS_AT + 9) + 1, EXTENSIONS_AT + 9);
  return records(hello);
};
