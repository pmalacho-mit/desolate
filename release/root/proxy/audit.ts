// A domain's audit log: what its proxies decided, one JSON line each, in the domain's out/
// (root/proxy-user.sh: its proxies' own directory, which the root's user reads).
//
// Every one of the domain's proxies writes it: proxy.ts, one process per running workspace,
// and the add-on of its secrets proxy (secrets_addon.py). So no writer renames a file: one
// that did would move, or write over, the file another had just begun (two programs each
// rotated one audit.log at 64 MiB, each by its own count: limits-triage.md). The log is a
// series of files instead, audit-1.log, audit-2.log and on. Every writer appends to the
// newest. The first to find it over its share of the budget begins the next one, by an
// exclusive create: the others find that one there and move to it. Past the budget the
// oldest is unlinked, which any of them may do twice without harm.
//
// The add-on writes the same series by the same rule: it repeats AUDIT, and T1 checks that
// it does (tests/v3/t1/proxy.test.ts).
import * as fs from "node:fs";
import * as path from "node:path";
import { isSlug } from "../../shared/names.ts";
import { define, mebibytes, valueOf } from "../../shared/settings.ts";
import { ROOT } from "../layout.ts";
import { proxyOutDir } from "./as-proxy.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Given, Invoke, Table } from "../../../suede.nests/dsl.import.meta.vitest.ts";
import type { setEnv } from "../../.harness/env.ts";
import type { emptyRoot, namesIn, readIn, writeIn } from "../../.harness/root-state.ts";

const MiB = 1024 * 1024;

/** The series' names, and how many files of it are kept: the budget is cut into that many
 *  shares, so what is kept is never less than three of them (the newest is being written). */
export const AUDIT = { prefix: "audit-", suffix: ".log", files: 4 } as const;

/** The most one line is believed to be, in bytes, by what reads the log. The proxies' user
 *  writes it, and is the one reached from the domain's workspaces: a line past this is not
 *  one a proxy wrote (the longest a proxy writes is its reason, its host, its route and the
 *  names of the secrets in one request, each of them bounded where it is written), and is
 *  skipped, not held. */
export const AUDIT_LINE_BYTES = 64 * 1024;

/** A share of the VM's disk for each domain's log: 1/256 of it, between 16 MiB and 4 GiB. The
 *  root VM's 30 GiB disk gives 120 MiB, about the 128 MiB (64 MiB and its .1) kept before. */
const fromDisk = (): number => {
  try {
    const disk = fs.statfsSync(ROOT.proxies);
    return Math.min(4096, Math.max(16, Math.floor((disk.blocks * disk.bsize) / MiB / 256)));
  } catch {
    return 128;
  }
};

export const AUDIT_MIB = define({
  name: "proxy.auditMiB",
  env: "DESOLATE_PROXY_AUDIT_MIB",
  side: "root",
  default: fromDisk,
  parse: mebibytes(4, 65536),
  why: "How much of each domain's audit log (what its workspaces reached, and the verdict) the root VM keeps on its disk; `net log` and `net recommend` read what is kept.",
});

/** What a proxy is started with, so that every writer of a domain's log keeps the same
 *  budget: the setting's value now, as its variable. */
export const auditEnv = (): Record<string, string> => ({
  [AUDIT_MIB.env]: String(valueOf(AUDIT_MIB)),
});

/** The files of the series in `dir`, oldest first, by their number. Before the series, a
 *  domain had audit.log and audit.log.1: they are read as its oldest, and let go like them. */
export const auditFiles = (dir: string): string[] => {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const number = (name: string) => {
    if (name === "audit.log.1") return -1;
    if (name === "audit.log") return 0;
    const match = /^audit-([1-9][0-9]{0,15})\.log$/.exec(name);
    return match ? Number(match[1]) : null;
  };
  return names
    .map((name) => ({ name, n: number(name) }))
    .filter((file): file is { name: string; n: number } => file.n !== null)
    .sort((a, b) => a.n - b.n)
    .map((file) => file.name);
};

const numbered = (n: number) => `${AUDIT.prefix}${n}${AUDIT.suffix}`;
const numberOf = (name: string) => Number(name.slice(AUDIT.prefix.length, -AUDIT.suffix.length));

/** A writer of the domain's log in `dir`, keeping about `budget` bytes of it. A line that
 *  cannot be written (a full disk) is lost, and says nothing: it is never a throw in a
 *  connection's handler, which stopped the whole proxy, every workspace of the domain then
 *  without a network (audit, 2026-11-20). */
export const auditWriter = (dir: string, budget: number) => {
  const share = Math.max(1, Math.floor(budget / AUDIT.files));
  let current = 0;
  const newest = () => {
    const series = auditFiles(dir).filter((name) => name.startsWith(AUDIT.prefix));
    return series.length ? numberOf(series[series.length - 1]!) : 0;
  };
  /** Begins `n` if nobody has (an exclusive create), and lets go what is past the budget.
   *  False when it is not there to move to (it could not be made): the writer stays. */
  const begin = (n: number): boolean => {
    try {
      fs.closeSync(fs.openSync(path.join(dir, numbered(n)), "wx"));
    } catch (error) {
      // EEXIST: another writer began it first, and it is there.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
    }
    for (const name of auditFiles(dir)) {
      const older = name.startsWith(AUDIT.prefix) ? numberOf(name) : 0;
      if (older <= n - AUDIT.files) fs.rmSync(path.join(dir, name), { force: true });
    }
    return true;
  };
  return (entry: Record<string, unknown>) => {
    try {
      const line = JSON.stringify(entry) + "\n";
      for (let attempt = 0; attempt < 2; attempt++) {
        if (current === 0) {
          current = newest();
          if (current === 0 && begin(1)) current = 1;
          if (current === 0) return;
        }
        let fd: number;
        try {
          // Never made here: a file another writer let go is not begun again by one that
          // was still on it. That one looks for the newest instead.
          fd = fs.openSync(
            path.join(dir, numbered(current)),
            fs.constants.O_WRONLY | fs.constants.O_APPEND,
          );
        } catch {
          current = 0;
          continue;
        }
        try {
          fs.writeSync(fd, line);
          if (fs.fstatSync(fd).size > share && begin(current + 1)) current++;
        } finally {
          fs.closeSync(fd);
        }
        return;
      }
    } catch {
      /* the connection is still decided as it was; only its line is lost */
    }
  };
};

/** Each line of the log in `dir`, oldest first, read as a stream: as much of it is held as
 *  one line, never the whole log. A line that is not JSON, or is over AUDIT_LINE_BYTES, is
 *  not one a proxy wrote, and is skipped. */
export async function* auditLines(dir: string): AsyncGenerator<Record<string, unknown>> {
  for (const name of auditFiles(dir)) {
    let stream: fs.ReadStream;
    try {
      stream = fs.createReadStream(path.join(dir, name));
    } catch {
      continue;
    }
    let pending: Buffer[] = [];
    let held = 0;
    let skipping = false;
    const parse = (bytes: Buffer) => {
      try {
        const entry = JSON.parse(bytes.toString("utf8")) as unknown;
        return entry && typeof entry === "object" && !Array.isArray(entry)
          ? (entry as Record<string, unknown>)
          : null;
      } catch {
        return null;
      }
    };
    try {
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        let at = 0;
        for (let end = chunk.indexOf(10, at); end !== -1; end = chunk.indexOf(10, at)) {
          if (!skipping && held + end - at <= AUDIT_LINE_BYTES) {
            const entry = parse(Buffer.concat([...pending, chunk.subarray(at, end)]));
            if (entry) yield entry;
          }
          pending = [];
          held = 0;
          skipping = false;
          at = end + 1;
        }
        if (skipping) continue;
        held += chunk.length - at;
        if (held > AUDIT_LINE_BYTES) {
          pending = [];
          skipping = true;
        } else pending.push(chunk.subarray(at));
      }
      if (!skipping && held > 0) {
        const entry = parse(Buffer.concat(pending));
        if (entry) yield entry;
      }
    } catch {
      /* let go while it was read: what was read stands */
    }
  }
}

/** The domains that have a log: each a slug, as their directories are named. */
export const auditDomains = (): string[] => {
  try {
    return fs.readdirSync(`${ROOT.proxies}/out`).filter(isSlug).sort();
  } catch {
    return [];
  }
};

/** A domain's log's directory. */
export const auditDir = (domain: string) => proxyOutDir(domain);

declare namespace auditWriter {
  type Fresh = Invoke<typeof emptyRoot>;
  type Dir = "out/acme";
  type Log = Invoke<
    typeof auditWriter,
    [dir: Invoke<typeof auditDir, [domain: "acme"]>, budget: 400]
  >;
  /** the newest file takes every line; past its share (a quarter of the budget) the next is
   *  begun, and past four files the oldest is let go */
  export type Series = Given<
    [
      Fresh,
      Invoke<typeof writeIn, [where: "proxies", name: "out/acme/audit.log", text: "{}\n"]>,
      Invoke<
        Log,
        [
          entry: {
            n: 1;
            pad: "........................................................................................";
          },
        ]
      >,
      Invoke<Log, [entry: { n: 2 }]>,
    ],
    [
      Expect<
        Invoke<typeof namesIn, [where: "proxies", dir: Dir]>,
        "=",
        ["audit-1.log", "audit-2.log", "audit.log"]
      >,
      Expect<
        Invoke<typeof readIn, [where: "proxies", name: "out/acme/audit-2.log"]>,
        "=",
        '{"n":2}\n'
      >,
    ]
  >;
}

declare namespace auditFiles {
  type Fresh = Invoke<typeof emptyRoot>;
  /** oldest first: the two files of before the series, then the series by its numbers (10
   *  after 9), and nothing else in the directory */
  export type Order = Given<
    [
      Fresh,
      Invoke<typeof writeIn, [where: "proxies", name: "out/acme/audit-10.log", text: ""]>,
      Invoke<typeof writeIn, [where: "proxies", name: "out/acme/audit-9.log", text: ""]>,
      Invoke<typeof writeIn, [where: "proxies", name: "out/acme/audit.log", text: ""]>,
      Invoke<typeof writeIn, [where: "proxies", name: "out/acme/audit.log.1", text: ""]>,
      Invoke<typeof writeIn, [where: "proxies", name: "out/acme/audit-01.log", text: ""]>,
      Invoke<typeof writeIn, [where: "proxies", name: "out/acme/ca", text: ""]>,
    ],
    Expect<
      Invoke<typeof auditFiles, [dir: Invoke<typeof auditDir, [domain: "acme"]>]>,
      "=",
      ["audit.log.1", "audit.log", "audit-9.log", "audit-10.log"]
    >
  >;
}

declare namespace auditDomains {
  type Fresh = Invoke<typeof emptyRoot>;
  /** each directory named as a domain is */
  export type Slugs = Given<
    [
      Fresh,
      Invoke<typeof writeIn, [where: "proxies", name: "out/acme/audit-1.log", text: ""]>,
      Invoke<typeof writeIn, [where: "proxies", name: "out/Not_A_Slug/audit-1.log", text: ""]>,
    ],
    Expect<Invoke<typeof auditDomains>, "=", ["acme"]>
  >;
}

declare namespace auditEnv {
  /** what every writer is started with: the root's value, so all of them keep one budget */
  export type Passed = Given<
    Invoke<typeof setEnv, [name: "DESOLATE_PROXY_AUDIT_MIB", value: "1g"]>,
    Expect<Invoke<typeof auditEnv>, "=", { DESOLATE_PROXY_AUDIT_MIB: "1024" }>
  >;
}

declare namespace AUDIT_MIB {
  /** a setting of the root's, read as a size */
  export type Declared = Table<
    typeof AUDIT_MIB.parse,
    [
      [args: [text: "64"], expected: 64],
      [args: [text: "1g"], expected: 1024],
      [args: [text: "2"], expected: null],
    ]
  >;
}
