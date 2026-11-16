// Reading the name a connection asks for, from its first bytes: the TLS SNI or the HTTP Host.
// Used on both sides of a workspace: the forwarder routes an inbound connection to the
// workspace its name belongs to (section 4.4: v2's ingress host check, turned from a filter
// into a router), and the egress relay learns which host an outbound connection wants.
// Pure functions over a Buffer, so they are unit-tested without a socket.

export type Sniffed =
  | { kind: "tls"; name: string | null }
  | { kind: "http"; name: string | null }
  | { kind: "raw" }
  /** Not decidable yet: read more (up to `LIMIT`) and ask again. */
  | { kind: "more" };

export const LIMIT = 16 * 1024;

const HTTP_START = /^[A-Z]{1,16} \S+ HTTP\/1\.[01]\r?\n/;

const hostHeader = (head: string): string | null => {
  for (const line of head.split(/\r?\n/).slice(1)) {
    const match = /^host:\s*(.*?)\s*$/i.exec(line);
    if (match) return normalizeName(match[1]!);
  }
  return null;
};

/** A hostname, lowercased, without a port or a trailing dot; null if it is not one. */
export const normalizeName = (raw: string): string | null => {
  let name = raw.trim().toLowerCase();
  if (name.startsWith("[")) return null;
  const colon = name.lastIndexOf(":");
  if (colon >= 0) {
    if (!/^\d{1,5}$/.test(name.slice(colon + 1))) return null;
    name = name.slice(0, colon);
  }
  if (name.endsWith(".")) name = name.slice(0, -1);
  return /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)*$/.test(name) && name.length <= 253 ? name : null;
};

/** The server_name of a TLS ClientHello, or null if it carries none. `undefined` if the
 *  record is not complete yet. */
const sni = (data: Buffer): string | null | undefined => {
  if (data.length < 5) return undefined;
  const recordLength = data.readUInt16BE(3);
  if (data.length < 5 + recordLength) return undefined;
  let at = 5;
  if (data[at] !== 0x01) return null;
  at += 4 + 2 + 32;
  if (at >= data.length) return null;
  at += 1 + data[at]!;
  if (at + 2 > data.length) return null;
  at += 2 + data.readUInt16BE(at);
  if (at >= data.length) return null;
  at += 1 + data[at]!;
  if (at + 2 > data.length) return null;
  const end = at + 2 + data.readUInt16BE(at);
  at += 2;
  while (at + 4 <= end && at + 4 <= data.length) {
    const type = data.readUInt16BE(at);
    const length = data.readUInt16BE(at + 2);
    at += 4;
    if (type === 0 && at + 5 <= data.length) {
      const nameLength = data.readUInt16BE(at + 3);
      if (data[at + 2] !== 0 || at + 5 + nameLength > data.length) return null;
      return normalizeName(data.subarray(at + 5, at + 5 + nameLength).toString("latin1"));
    }
    at += length;
  }
  return null;
};

/** What could be the start of an HTTP request: a method, then a space. Such bytes are HTTP:
 *  if the request line never parses, or the head runs past LIMIT, they are HTTP that names
 *  no one (refused), never a protocol with no name. They once were taken for one, and routed
 *  to whichever workspace had the port first, with no name checked: a page could send the
 *  person's browser there with a 20 KB path and another site's cookies (audit, 2026-11-16). */
const HTTP_SHAPED = /^[A-Z]{1,16}( |$)/;

export const sniff = (data: Buffer): Sniffed => {
  if (data.length === 0) return { kind: "more" };
  if (data[0] === 0x16) {
    if (data.length >= 2 && data[1] !== 0x03) return { kind: "raw" };
    const name = sni(data);
    if (name === undefined) return data.length >= LIMIT ? { kind: "tls", name: null } : { kind: "more" };
    return { kind: "tls", name };
  }
  const text = data.subarray(0, Math.min(data.length, LIMIT)).toString("latin1");
  if (HTTP_START.test(text)) {
    const end = text.search(/\r?\n\r?\n/);
    if (end < 0) return data.length >= LIMIT ? { kind: "http", name: hostHeader(text) } : { kind: "more" };
    return { kind: "http", name: hostHeader(text.slice(0, end)) };
  }
  if (HTTP_SHAPED.test(text)) return text.includes("\n") || data.length >= LIMIT ? { kind: "http", name: null } : { kind: "more" };
  return { kind: "raw" };
};

/** Read from a socket until its first bytes are classified, or the wait or the size runs
 *  out. A client that says nothing within `quietMs` is a raw one (a protocol where the
 *  server speaks first). */
/** `undecided`: it ended (the wait, or the client) before its bytes said what they were. */
export const sniffSocket = (socket: import("node:net").Socket, quietMs: number): Promise<{ sniffed: Sniffed; head: Buffer; undecided?: boolean }> =>
  new Promise((resolve) => {
    let head = Buffer.alloc(0);
    const finish = (sniffed: Sniffed, undecided = false) => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("close", onClose);
      socket.pause();
      resolve({ sniffed, head, ...(undecided ? { undecided } : {}) });
    };
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const sniffed = sniff(head);
      if (sniffed.kind !== "more") finish(sniffed);
      else if (head.length >= LIMIT) finish({ kind: "raw" });
    };
    const onClose = () => finish({ kind: "raw" }, true);
    const timer = setTimeout(() => finish({ kind: "raw" }, true), quietMs);
    socket.on("data", onData);
    socket.on("close", onClose);
  });
