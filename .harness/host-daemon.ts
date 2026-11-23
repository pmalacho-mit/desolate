// Harness for the in-source tests of release/host/daemon.ts.
import * as fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { connect, createServer } from "node:net";
import type { Socket } from "node:net";
import * as path from "node:path";
import { Duplex, PassThrough } from "node:stream";
import { onTestFinished } from "./vitest.ts";
import type { backend } from "../host/stack.ts";
import { INSTANCE } from "../host/paths.ts";
import { devHostname, editorHostname, HOSTNAME_SUFFIX, workspaceVmName } from "../shared/names.ts";
import { sniff } from "../shared/sniff.ts";
import type { Sniffed } from "../shared/sniff.ts";
import { clientHello } from "./shared-bytes.ts";
import { clientSending } from "./shared-socket.ts";

// ------------------------------------------------------------------ a stand-in daemon
/** Stands in for a running host daemon: a socket where the real one keeps its own
 *  (state/daemon.sock, in the test file's home), answering every request with `reply`.
 *  Nothing outside that home is touched; it is closed when the test ends. */
export const daemonAnswering = (reply: Record<string, unknown>) =>
  new Promise<void>((resolve, reject) => {
    const socket = path.join(process.env.DESOLATE_HOME!, "state", "daemon.sock");
    fs.mkdirSync(path.dirname(socket), { recursive: true });
    fs.rmSync(socket, { force: true });
    const server = createServer((connection) => {
      let buffer = "";
      connection.on("error", () => connection.destroy());
      connection.on("data", (chunk) => {
        buffer += chunk.toString();
        if (buffer.includes("\n")) connection.end(`${JSON.stringify(reply)}\n`);
      });
    });
    server.once("error", reject);
    server.listen(socket, () => resolve());
    onTestFinished(
      () =>
        new Promise<void>((done) =>
          server.close(() => (fs.rmSync(socket, { force: true }), done())),
        ),
    );
  });

// ------------------------------------------------------------------ a VM that answers
/** Stands in for the VM layer (host/vm): every exec, into whichever VM, ends with this. */
export const vmAnswering = (code: number, stdout: string, stderr: string) =>
  ({ exec: async () => ({ code, stdout, stderr }) }) as unknown as ReturnType<typeof backend>;

// ------------------------------------------------------------------ a page's request
const logged: string[] = [];
/** A log line kept, as the daemon's own log would keep it. */
export const keepLog = (line: string) => void logged.push(line);

/** A page that fails before it answers (the root did not answer it, say). */
export const failsAtOnce = async () => {
  throw new Error("the root's state service is not there");
};
/** A page that sent its head and part of a body, then failed. */
export const failsHalfway = async (_req: IncomingMessage, res: ServerResponse) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.write("<p>half");
  throw new Error("the reviewer went away");
};
/** A page that answers. */
export const answers = async (_req: IncomingMessage, res: ServerResponse) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("ok");
};

/** What a request handler sent, as a browser would see it, and what was logged meanwhile.
 *  The request and the response are stand-ins with the few members a page uses. */
export const answerOf = async (handler: (req: IncomingMessage, res: ServerResponse) => void) => {
  const answer = { status: 0, heads: 0, body: "", ended: false, logged };
  let ended!: () => void;
  const done = new Promise<void>((resolve) => (ended = resolve));
  const res = {
    headersSent: false,
    writeHead(status: number) {
      answer.status = status;
      answer.heads += 1;
      res.headersSent = true;
      return res;
    },
    write(text: string) {
      answer.body += text;
      return true;
    },
    end(text = "") {
      answer.body += text;
      answer.ended = true;
      ended();
      return res;
    },
  };
  handler({} as IncomingMessage, res as unknown as ServerResponse);
  await done;
  return answer;
};

// ------------------------------------------------------------------ the forwarder's inputs
// Workspaces' names carry a hex of the stack's instance and end in its suffix (shared/names.ts),
// which another environment may set otherwise. So a test writes `dev-w1-HEX.localhost` for
// workspace w1 of domain dev (`dev-w1-editor-HEX.localhost` for its editor), and these turn
// that into this stack's name, and this stack's names back into that. (A domain and a
// workspace written so have no dash of their own.)
const SUFFIX = HOSTNAME_SUFFIX.replace(/\./g, "\\.");
const named = (text: string) =>
  text.replace(
    /([a-z0-9]+)-([a-z0-9]+)-(editor-)?HEX\.localhost|\.localhost\b/g,
    (whole, domain?: string, workspace?: string, editor?: string) =>
      domain === undefined
        ? `.${HOSTNAME_SUFFIX}`
        : (editor ? editorHostname : devHostname)(INSTANCE, domain, workspace!),
  );
const unnamed = (text: string) =>
  text.replace(new RegExp(`-[0-9a-f]{6}\\.${SUFFIX}|\\.${SUFFIX}`, "g"), (whole) =>
    whole.startsWith("-") ? "-HEX.localhost" : ".localhost",
  );

/** A workspace as the daemon keeps it (`at`: "domain/workspace"), listening on `listening`. */
export const ws = (
  at: string,
  listening: number[],
  more: {
    reserved?: number[];
    editorTokenEpoch?: number;
    low?: number[];
    notes?: string[];
    answeredAt?: number;
  } = {},
) => {
  const [domain = "", workspace = ""] = at.split("/");
  return {
    vm: workspaceVmName(INSTANCE, domain, workspace),
    domain,
    workspace,
    listeners: new Set(listening),
    reserved: new Set(more.reserved ?? []),
    editorTokenEpoch: more.editorTokenEpoch ?? 0,
    answeredAt: more.answeredAt ?? 0,
    ...(more.low ? { low: more.low } : {}),
    ...(more.notes ? { notes: more.notes } : {}),
  };
};

/** What a connection said first, as sniffSocket hands it over: `text` (names written as above)
 *  as bytes, and what they are. `undecided`: the wait ran out, or the client left, first. */
export const said = (text: string, undecided = false) => {
  const head = Buffer.from(named(text), "latin1");
  if (undecided) return { sniffed: { kind: "raw" } as Sniffed, head, undecided: true };
  const sniffed = sniff(head);
  if (sniffed.kind === "more")
    throw new Error(`the harness: ${JSON.stringify(text)} is not all of a first message`);
  return { sniffed, head };
};
/** A TLS ClientHello with `name` (written as above) as its server name, or none. */
export const helloTo = (name: string | null) => {
  const head = clientHello(name === null ? null : named(name));
  return { sniffed: sniff(head), head };
};
/** Only what the bytes are (shared/sniff.ts), as the pages server reads them. */
export const asked = (text: string) => said(text).sniffed;
/** `text`, its names written as above, as bytes. */
export const wire = (text: string) => Buffer.from(named(text), "latin1");
/** What a reader of the root's state answer (daemon.ts, stateReader) gives first when it is
 *  handed `text`'s bytes `piece` at a time, as `shown` has it; null when it gives nothing. */
export const readInPieces = (
  reader: (most?: number) => { take: (chunk: Buffer) => unknown },
  text: string,
  piece: number,
  most?: number,
) => {
  const read = reader(most);
  const bytes = wire(text);
  for (let at = 0; at < bytes.length; at += piece) {
    const got = read.take(bytes.subarray(at, at + piece));
    if (got !== null) return shown(got);
  }
  return null;
};

/** What a line reader (daemon.ts, lineReader) gave of `chunks`, handed it one at a time: the
 *  lines, and the error it stopped at, if it did. */
export const linesInPieces = (
  reader: (most?: number) => (chunk: Buffer) => string[] | Error,
  chunks: string[],
  most?: number,
) => {
  const take = reader(most);
  const lines: string[] = [];
  for (const chunk of chunks) {
    const got = take(Buffer.from(chunk));
    if (got instanceof Error) return { lines, error: got.message };
    lines.push(...got);
  }
  return { lines };
};

/** A watch (daemon.ts, holdWatch) over stand-ins for dials to a workspace's daemon, one per
 *  open, in turn: each sends its `chunks` once it has been written to, then ends if `end`.
 *  Reopened at once. Once the last has been opened and has answered, the watch is closed.
 *  What each was sent, the lines handed on (one with ok other than true refused, as the
 *  daemon refuses one that does not say what listens), the misses, and how many streams were
 *  opened after the close. */
export const heldWatch = async (
  hold: (watch: {
    open: () => Duplex;
    first: () => string;
    line: (reply: Record<string, unknown>) => Promise<void>;
    missed: (error: unknown) => void;
    delay: (previous: number, livedMs: number) => number;
  }) => { close: () => void },
  streams: { chunks: (string | Buffer)[]; end: boolean }[],
) => {
  const sent: string[] = [];
  const lines: string[] = [];
  const missed: string[] = [];
  let opened = 0;
  const watch = hold({
    open: () => {
      const script = streams[opened++] ?? { chunks: [], end: false };
      let written = false;
      const stream: Duplex = new Duplex({
        read() {},
        write(chunk, _encoding, done) {
          sent.push(String(chunk));
          if (!written) {
            written = true;
            for (const piece of script.chunks)
              stream.push(typeof piece === "string" ? Buffer.from(piece) : piece);
            if (script.end) stream.push(null);
          }
          done();
        },
      });
      return stream;
    },
    first: () => '{"op":"watch"}\n',
    line: async (reply) => {
      if (reply.ok !== true) throw new Error(String(reply.error));
      lines.push(JSON.stringify(reply));
    },
    missed: (error) => void missed.push((error as Error).message),
    delay: () => 1,
  });
  for (let waited = 0; opened < streams.length && waited < 2000; waited += 10)
    await new Promise((resolve) => setTimeout(resolve, 10));
  await new Promise((resolve) => setTimeout(resolve, 30));
  const before = opened;
  watch.close();
  await new Promise((resolve) => setTimeout(resolve, 30));
  return { sent, lines, missed, openAfterClose: opened - before };
};

/** `count` ports from `from` on, which a type would take a long time to write. */
export const portRange = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => from + i);
/** Lines "1" to `count`, the first of them `first` when given. */
export const numbered = (count: number, first?: string) =>
  Array.from({ length: count }, (_, i) => (i === 0 && first !== undefined ? first : String(i + 1)));
/** How many lines, and the first two and the last: what a reader checks of a long list. */
export const endsOf = (lines: string[]) => ({
  count: lines.length,
  first: lines[0],
  second: lines[1],
  last: lines[lines.length - 1],
});
/** A set, which a type cannot write. */
export const setOf = (items: any[]): Set<any> => new Set(items);
/** Which workspace (`at`) had each raw port first, as the daemon keeps it: by VM. */
export const rawOwners = (owners: Record<string, string>) =>
  new Map(Object.entries(owners).map(([port, at]) => [Number(port), ws(at, []).vm]));
/** Which workspace ("domain/workspace") a port with no name reaches once `owner` had it and
 *  the workspaces are now `entries`: rawOwnerFor over those that listen there, in order, as
 *  the daemon's reconcile asks it. */
export const rawOwnerAmong = (
  rawOwnerFor: (current: string | undefined, holders: { vm: string }[]) => string,
  port: number,
  owner: string,
  entries: { listeners: ReadonlySet<number> }[],
): string => {
  const kept = entries as { vm: string; listeners: ReadonlySet<number> }[];
  const vm = rawOwnerFor(
    ws(owner, []).vm,
    kept.filter((entry) => entry.listeners.has(port)),
  );
  return shown(kept.find((entry) => entry.vm === vm));
};
/** What lsof would say holds a port. */
export const heldByColima = () => "colima, pid 812";
/** The stack's default memory for a workspace, in MiB. */
export const sixGiB = () => 6144;

/** A decision as a reader would check it: a workspace kept by the daemon as "domain/workspace",
 *  a set as its items, an error as its message, and this stack's names as written above. */
export const shown = (value: unknown): any => {
  if (typeof value === "string") return unnamed(value);
  if (value instanceof Error) return { error: value.message };
  if (value instanceof Set) return [...value].map(shown);
  if (Array.isArray(value)) return value.map(shown);
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (
      typeof o.vm === "string" &&
      typeof o.domain === "string" &&
      typeof o.workspace === "string" &&
      o.listeners instanceof Set
    )
      return `${o.domain}/${o.workspace}`;
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, shown(v)]));
  }
  return value;
};
/** A name, written as above, as this stack spells it. */
export const nameOf = (text: string) => named(text);
/** Only what a TLS ClientHello to `name` is, as the pages server reads it. */
export const askedTls = (name: string | null) => helloTo(name).sniffed;

// ------------------------------------------------------------------ clients that say nothing
/** `count` clients that connect and say nothing, each handed in turn to `hear` (daemon.ts's
 *  heard) with one set of the silent, `most` at most: which of them were closed for it. */
export const silentClients = async (
  hear: (silent: Set<Socket>, client: Socket, quietMs: number, most: number) => Promise<unknown>,
  count: number,
  most: number,
): Promise<boolean[]> => {
  const silent = new Set<Socket>();
  const clients: Socket[] = [];
  for (let i = 0; i < count; i++) {
    const client = await clientSending([]);
    clients.push(client);
    void hear(silent, client, 60_000, most);
  }
  await new Promise((resolve) => setImmediate(resolve));
  return clients.map((client) => client.destroyed);
};

// ------------------------------------------------------------------ connections carried
type Carrying = (
  most: number,
  log: (line: string) => void,
) => {
  carry: (
    entry: {
      vm: string;
      carried: Record<"in" | "out", number>;
      refused: Record<"in" | "out", Refused>;
    },
    way: "in" | "out",
    client: Duplex,
    open: () => Duplex,
    head: Buffer,
    http: boolean,
  ) => void;
  all: () => number;
};
type Refused = { count: number; at: string; why: string; logged: number };
const counted = (vm: string) => ({
  vm,
  carried: { in: 0, out: 0 },
  refused: {
    in: { count: 0, at: "", why: "", logged: 0 },
    out: { count: 0, at: "", why: "", logged: 0 },
  },
});
const settled = () => new Promise((resolve) => setImmediate(resolve));

/** Connections carried (daemon.ts, carrying) at `most` a workspace a way, a step at a time:
 *  `count` more of `vm`'s `way`, each a stand-in client piped to a stand-in dial and held; or,
 *  a negative `count`, that many of those held ended by their client. Per step: how many were
 *  carried and the reasons the rest were refused, or how many ended and how many this Mac
 *  then carries in all. */
export const opened = async (
  carrying: Carrying,
  most: number,
  steps: [vm: string, way: "in" | "out", count: number][],
) => {
  const { carry, all } = carrying(most, () => {});
  const entries = new Map<string, ReturnType<typeof counted>>();
  const held = new Map<string, Duplex[]>();
  const results: ({ carried: number; refused: string[] } | { ended: number; all: number })[] = [];
  for (const [vm, way, count] of steps) {
    if (!entries.has(vm)) entries.set(vm, counted(vm));
    const key = `${vm} ${way}`;
    const mine = held.get(key) ?? [];
    held.set(key, mine);
    if (count < 0) {
      for (const client of mine.splice(0, -count)) client.destroy();
      await settled();
      results.push({ ended: -count, all: all() });
      continue;
    }
    let carried = 0;
    const refused = new Set<string>();
    for (let i = 0; i < count; i++) {
      const client = new PassThrough();
      let piped = false;
      const entry = entries.get(vm)!;
      const before = entry.refused[way].count;
      carry(entry, way, client, () => ((piped = true), new PassThrough()), Buffer.alloc(0), false);
      if (piped) (carried++, mine.push(client));
      if (entry.refused[way].count > before) refused.add(entry.refused[way].why);
    }
    await settled();
    results.push({ carried, refused: [...refused] });
  }
  for (const clients of held.values()) for (const client of clients) client.destroy();
  return results;
};

let connections = 0;
/** A connection over a unix socket in the test file's home: the daemon's end (`client`), and
 *  the far end, a stand-in browser. */
const connection = async () => {
  const file = path.join(
    process.env.DESOLATE_HOME!,
    `carried-${process.pid}-${connections++}.sock`,
  );
  const server = createServer();
  const accepted = new Promise<Socket>((resolve) => server.once("connection", resolve));
  await new Promise<void>((resolve) => server.listen(file, resolve));
  const browser = connect(file);
  browser.on("error", () => {});
  const client = await accepted;
  onTestFinished(() => {
    browser.destroy();
    client.destroy();
    server.close();
    fs.rmSync(file, { force: true });
  });
  return { browser, client };
};

/** What the far end of a connection refused (daemon.ts, carrying: its workspace already
 *  carries the one it may) reads before it is closed, `http` or not. */
export const refusedAs = async (carrying: Carrying, http: boolean) => {
  const { carry } = carrying(1, () => {});
  const entry = counted("w1");
  carry(entry, "in", new PassThrough(), () => new PassThrough(), Buffer.alloc(0), false);
  const { browser, client } = await connection();
  let read = "";
  browser.on("data", (chunk: Buffer) => (read += chunk.toString()));
  const closed = new Promise((resolve) => browser.once("close", resolve));
  carry(entry, "in", client, () => new PassThrough(), Buffer.alloc(0), http);
  browser.end();
  await closed;
  return read;
};

/** One connection carried (daemon.ts, carrying) over a real socket, its client's far end a
 *  stand-in browser and its dial a stand-in for one into a VM, then ended so: `client` (the
 *  browser hangs up), `upstream` (the dial's end closes), `error` (the dial fails),
 *  `unstarted` (a dial that could not start: daemon.ts's dial() gives one already destroyed
 *  when the VM layer throws), `gone` (the client went before it was carried), `none`. How
 *  many this Mac carried just after it was carried, and once its ends had settled. */
export const pipeEnds = async (
  carrying: Carrying,
  end: "client" | "upstream" | "error" | "unstarted" | "gone" | "none",
) => {
  const { carry, all } = carrying(2, () => {});
  const { browser, client } = await connection();
  if (end === "gone") {
    client.destroy();
    await settled();
  }
  const upstream = new PassThrough();
  if (end === "unstarted") upstream.destroy();
  carry(counted("w1"), "in", client, () => upstream, Buffer.alloc(0), false);
  const held = all();
  if (end === "client") browser.end();
  if (end === "upstream") upstream.destroy();
  if (end === "error") upstream.destroy(new Error("the dial's ssh went away"));
  for (let i = 0; i < 20 && all() > 0 && end !== "none"; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  await settled();
  return { held, after: all() };
};
