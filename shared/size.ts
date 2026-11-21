// A workspace VM's size: CPUs, memory and disk. Decided when the VM is made, from, in order:
// `desolate up --cpus/--memory/--disk`, then the domain's size (`desolate domain <d> size`),
// then the stack's defaults: the settings workspace.cpus, .memoryMiB and .diskGiB
// (`desolate settings`), whose own defaults come from this Mac itself (its cores and memory:
// worked out each time, stored nowhere, so they never go stale).
//
// The root VM's and the git VM's sizes are settings too (root.cpus, root.memoryMiB, git.cpus,
// git.memoryMiB), with defaults from this Mac, never above what it has. Their disk is the
// base image's, a fact, not a setting.
//
// What each costs: a CPU is a share of the Mac's time (nothing is reserved; an idle VM costs
// almost nothing). Memory is a ceiling, not a reservation: macOS gives a VM pages as it
// touches them, and is slow to take them back, so a VM that once used 8 GiB tends to hold
// them until it stops. Disk grows as it is written, up to the size.
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import * as os from "node:os";
import { define, mebibytes, parseMemory, valueOf, whole } from "./settings.ts";
import type { Parse } from "./settings.ts";
import { printable } from "./text.ts";
import type { Expect, Invoke, Table } from "../../suede.nests/dsl.import.meta.vitest.ts";

export type Size = { cpus: number; memoryMiB: number; diskGiB: number };
// (Disk from 30 GiB: every VM is cloned from a 30 GiB base, and a clone's disk can only grow.)
export const LIMITS = { cpus: [1, 64], memoryMiB: [1024, 262_144], diskGiB: [30, 2048] } as const;

// How a person writes memory ("8g", "512m", "8192") is read where every setting's sizes are
// (shared/settings.ts), and named here too, for the flags that take a size.
export { parseMemory };

/** "60g", "60GiB", "60": disk in GiB, or null. */
export const parseDisk = (value: unknown): number | null => {
  const match = /^\s*(\d+)\s*(g|gb|gib)?\s*$/i.exec(String(value ?? ""));
  return match ? Number(match[1]) : null;
};

declare namespace parseDisk {
  /** GiB, whole ones, with or without the unit; no other unit and no fraction */
  export type Spellings = Table<
    typeof parseDisk,
    [
      [args: [value: "60g"], expected: 60],
      [args: [value: "60GiB"], expected: 60],
      [args: [value: 60], expected: 60],
      [args: [value: "60.5g"], expected: null],
      [args: [value: "1t"], expected: null],
      [args: [value: "60m"], expected: null],
    ]
  >;
}

// ------------------------------------------------------------------ the settings of sizes

const MiB = 1024 * 1024;
/** This Mac (or, in a test, this machine): its cores and memory, asked each time. */
const mac = () => ({ cores: os.cpus().length, memoryMiB: Math.floor(os.totalmem() / MiB) });

/** The most memory one VM is given on a Mac with `memoryMiB`: three quarters of it, in whole
 *  GiB (memory is a ceiling a VM fills, and macOS is slow to take it back: a VM that could
 *  take all of it could stall the Mac). A hard bound: it keeps the Mac usable whatever a
 *  project or a setting asks. */
export const mostMemoryFor = (memoryMiB: number): number =>
  Math.max(LIMITS.memoryMiB[0], Math.floor((memoryMiB * 3) / 4 / 1024) * 1024);

declare namespace mostMemoryFor {
  /** an 8 GB Mac, a 32 GB one; never below the least a VM may have */
  export type Macs = Table<
    typeof mostMemoryFor,
    [
      [args: [memoryMiB: 8192], expected: 6144],
      [args: [memoryMiB: 32768], expected: 24576],
      [args: [memoryMiB: 1000], expected: 1024],
    ]
  >;
}

/** A disk size in whole GiB, from `min` to `max`, written as parseDisk reads it. */
const gibibytes = (min: number, max: number): Parse<number> =>
  Object.assign(
    (text: string) => {
      const value = parseDisk(text);
      return value !== null && value >= min && value <= max ? value : null;
    },
    { takes: `a size from ${min} to ${max} GiB (as 60 or 60g)` },
  );

export const WORKSPACE_CPUS = define({
  name: "workspace.cpus",
  env: "DESOLATE_WORKSPACE_CPUS",
  side: "host",
  default: () => defaultsFor(mac().cores, mac().memoryMiB).cpus,
  parse: whole(LIMITS.cpus[0], LIMITS.cpus[1]),
  why: "CPUs a new workspace gets when neither `up --cpus` nor its domain's size says: shares of the Mac's time, reserved for none (the default: half this Mac's cores, 2 to 4).",
});

export const WORKSPACE_MEMORY = define({
  name: "workspace.memoryMiB",
  env: "DESOLATE_WORKSPACE_MEMORY_MIB",
  side: "host",
  default: () => defaultsFor(mac().cores, mac().memoryMiB).memoryMiB,
  parse: mebibytes(LIMITS.memoryMiB[0], LIMITS.memoryMiB[1]),
  why: "Memory a new workspace gets when neither `up --memory` nor its domain's size says: a ceiling it fills and keeps until it stops (the default: a quarter of this Mac's, 3 to 8 GiB).",
});

export const WORKSPACE_DISK = define({
  name: "workspace.diskGiB",
  env: "DESOLATE_WORKSPACE_DISK_GIB",
  side: "host",
  default: () => defaultsFor(mac().cores, mac().memoryMiB).diskGiB,
  parse: gibibytes(LIMITS.diskGiB[0], LIMITS.diskGiB[1]),
  why: "Disk a new workspace gets when neither `up --disk` nor its domain's size says: it grows as it is written, up to this, and never shrinks.",
});

/** What a new workspace gets when neither `up`'s flags nor its domain's size say: the
 *  settings above, each from this Mac unless the person set it. */
export const workspaceDefaults = (): Size => ({
  cpus: valueOf(WORKSPACE_CPUS),
  memoryMiB: valueOf(WORKSPACE_MEMORY),
  diskGiB: valueOf(WORKSPACE_DISK),
});

/** The root VM's size by default on a Mac with these cores and this much memory. It runs
 *  every domain's reviews, pushes, fetches and imports at once: a quarter of the cores (2 to
 *  4) and an eighth of the memory (2 to 4 GiB), never more than the Mac has. (2 CPUs and
 *  2 GiB, on any Mac, before it was a setting.) */
export const rootSizeFor = (cores: number, memoryMiB: number) => ({
  cpus: Math.min(cores, Math.min(4, Math.max(2, Math.floor(cores / 4)))),
  memoryMiB: Math.min(
    mostMemoryFor(memoryMiB),
    Math.min(4096, Math.max(2048, Math.floor(memoryMiB / 8 / 1024) * 1024)),
  ),
});

declare namespace rootSizeFor {
  /** an 8 GB M1, a 16 GB M2, a 32 GB M3 Pro, a 64 GB M2 Max; and a machine smaller than
   *  the root would be (a test's): no more than it has */
  export type Macs = Table<
    typeof rootSizeFor,
    [
      [args: [cores: 8, memoryMiB: 8192], expected: { cpus: 2; memoryMiB: 2048 }],
      [args: [cores: 8, memoryMiB: 16384], expected: { cpus: 2; memoryMiB: 2048 }],
      [args: [cores: 12, memoryMiB: 32768], expected: { cpus: 3; memoryMiB: 4096 }],
      [args: [cores: 16, memoryMiB: 65536], expected: { cpus: 4; memoryMiB: 4096 }],
      [args: [cores: 1, memoryMiB: 2048], expected: { cpus: 1; memoryMiB: 1024 }],
    ]
  >;
}

/** The git VM's size by default: git and a shell for each terminal, nothing that builds. 2
 *  CPUs and 1.5 GiB, as before it was a setting, never more than the Mac has. */
export const gitSizeFor = (cores: number, memoryMiB: number) => ({
  cpus: Math.min(cores, 2),
  memoryMiB: Math.min(mostMemoryFor(memoryMiB), 1536),
});

declare namespace gitSizeFor {
  export type Macs = Table<
    typeof gitSizeFor,
    [
      [args: [cores: 8, memoryMiB: 8192], expected: { cpus: 2; memoryMiB: 1536 }],
      [args: [cores: 1, memoryMiB: 1024], expected: { cpus: 1; memoryMiB: 1024 }],
    ]
  >;
}

// A person's root or git VM is never set larger than this Mac: one that cannot start is a
// stack that cannot start, so it is refused when it is set, in the Mac's own numbers.
const cpusHere = () => whole(LIMITS.cpus[0], Math.min(LIMITS.cpus[1], mac().cores));
const memoryHere = () => mebibytes(LIMITS.memoryMiB[0], mostMemoryFor(mac().memoryMiB));

export const ROOT_CPUS = define({
  name: "root.cpus",
  env: "DESOLATE_ROOT_CPUS",
  side: "host",
  default: () => rootSizeFor(mac().cores, mac().memoryMiB).cpus,
  parse: cpusHere(),
  why: "CPUs of the root VM, which runs every domain's reviews, pushes and fetches: more lets several run at once (the default: a quarter of this Mac's cores, 2 to 4).",
});

export const ROOT_MEMORY = define({
  name: "root.memoryMiB",
  env: "DESOLATE_ROOT_MEMORY_MIB",
  side: "host",
  default: () => rootSizeFor(mac().cores, mac().memoryMiB).memoryMiB,
  parse: memoryHere(),
  why: "Memory of the root VM: what a review of a large push, and the mirrors' fetches, have to work in (the default: an eighth of this Mac's, 2 to 4 GiB).",
});

export const GIT_CPUS = define({
  name: "git.cpus",
  env: "DESOLATE_GIT_CPUS",
  side: "host",
  default: () => gitSizeFor(mac().cores, mac().memoryMiB).cpus,
  parse: cpusHere(),
  why: "CPUs of the git VM, where your own clones and git terminals are (the default: 2).",
});

export const GIT_MEMORY = define({
  name: "git.memoryMiB",
  env: "DESOLATE_GIT_MEMORY_MIB",
  side: "host",
  default: () => gitSizeFor(mac().cores, mac().memoryMiB).memoryMiB,
  parse: memoryHere(),
  why: "Memory of the git VM: git on your clones, and a shell for each terminal (the default: 1.5 GiB).",
});

/** The root VM's or the git VM's CPUs and memory now, from the settings: what it is made
 *  with, and given again when it starts (host/settings.ts `sizeAtStart`). */
export const vmSize = (role: "root" | "git") =>
  role === "root"
    ? { cpus: valueOf(ROOT_CPUS), memoryMiB: valueOf(ROOT_MEMORY) }
    : { cpus: valueOf(GIT_CPUS), memoryMiB: valueOf(GIT_MEMORY) };

/** A size, checked: each part within its limits, whole numbers. The reason when it is not. */
export const checkSize = (size: Partial<Size>): string | null => {
  for (const key of ["cpus", "memoryMiB", "diskGiB"] as const) {
    const value = size[key];
    if (value === undefined) continue;
    const [min, max] = LIMITS[key];
    if (!Number.isInteger(value) || value < min || value > max)
      return `${key === "cpus" ? "CPUs" : key === "memoryMiB" ? "memory" : "disk"} must be from ${key === "memoryMiB" ? `${min / 1024} GiB to ${max / 1024} GiB` : key === "diskGiB" ? `${min} GiB to ${max} GiB` : `${min} to ${max}`}`;
  }
  return null;
};

declare namespace checkSize {
  /** each part given within its limits, else the first that is not, in the person's words;
   *  a part not given is not checked */
  export type Cases = Table<
    typeof checkSize,
    [
      [args: [size: { cpus: 4; memoryMiB: 8192; diskGiB: 60 }], expected: null],
      [args: [size: { cpus: 0 }], expected: "CPUs must be from 1 to 64"],
      [args: [size: { memoryMiB: 512 }], expected: "memory must be from 1 GiB to 256 GiB"],
      [args: [size: { diskGiB: 20 }], expected: "disk must be from 30 GiB to 2048 GiB"],
      [args: [size: { cpus: 2.5 }], expected: "CPUs must be from 1 to 64"],
      [args: [size: { cpus: 0; memoryMiB: 512 }], expected: "CPUs must be from 1 to 64"],
      [args: [size: {}], expected: null],
    ]
  >;
}

/** What a workspace gets by default on a Mac with these cores and this much memory: half the
 *  cores (2 to 4: an agent and a build, without crowding the Mac), a quarter of the memory
 *  (3 to 8 GiB: a devcontainer, a language server, a test run), and 30 GiB of disk. */
export const defaultsFor = (cores: number, memoryMiB: number): Size => ({
  cpus: Math.min(4, Math.max(2, Math.floor(cores / 2))),
  memoryMiB: Math.min(8192, Math.max(3072, Math.floor(memoryMiB / 4 / 1024) * 1024)),
  diskGiB: 30,
});

declare namespace defaultsFor {
  /** an 8 GB M1, a 16 GB M2, a 32 GB M3 Pro, a 64 GB M2 Max */
  export type Macs = Table<
    typeof defaultsFor,
    [
      [args: [cores: 8, memoryMiB: 8192], expected: { cpus: 4; memoryMiB: 3072; diskGiB: 30 }],
      [args: [cores: 8, memoryMiB: 16384], expected: { cpus: 4; memoryMiB: 4096; diskGiB: 30 }],
      [args: [cores: 4, memoryMiB: 16384], expected: { cpus: 2; memoryMiB: 4096; diskGiB: 30 }],
      [args: [cores: 12, memoryMiB: 32768], expected: { cpus: 4; memoryMiB: 8192; diskGiB: 30 }],
      [args: [cores: 12, memoryMiB: 65536], expected: { cpus: 4; memoryMiB: 8192; diskGiB: 30 }],
    ]
  >;
}

/** The size, for a person: "4 CPUs, 8 GiB memory, 30 GiB disk". */
export const describe = (size: Size): string =>
  `${size.cpus} CPU${size.cpus === 1 ? "" : "s"}, ${size.memoryMiB % 1024 === 0 ? `${size.memoryMiB / 1024} GiB` : `${size.memoryMiB} MiB`} memory, ${size.diskGiB} GiB disk`;

declare namespace describe {
  /** what `desolate up` and `desolate domain <d> size` print */
  export type Said = Expect<
    Invoke<typeof describe, [size: { cpus: 4; memoryMiB: 8192; diskGiB: 30 }]>,
    "=",
    "4 CPUs, 8 GiB memory, 30 GiB disk"
  >;
  /** one CPU is one CPU; memory that is not whole GiB is said in MiB */
  export type Odd = Expect<
    Invoke<typeof describe, [size: { cpus: 1; memoryMiB: 1536; diskGiB: 60 }]>,
    "=",
    "1 CPU, 1536 MiB memory, 60 GiB disk"
  >;
}

/** Each part, the first that is set: the given ones, then the next. */
export const merge = (...sizes: (Partial<Size> | null | undefined)[]): Size => {
  const out: Partial<Size> = {};
  for (const size of sizes)
    for (const key of ["cpus", "memoryMiB", "diskGiB"] as const)
      if (out[key] === undefined && size?.[key] !== undefined) out[key] = size[key];
  return out as Size;
};

declare namespace merge {
  /** the flag, then the domain's size, then the defaults: each part from the first that sets it */
  export type Order = Expect<
    Invoke<
      typeof merge,
      [
        a: { cpus: 8 },
        b: { cpus: 2; memoryMiB: 4096 },
        c: { cpus: 1; memoryMiB: 1024; diskGiB: 30 },
      ]
    >,
    "=",
    { cpus: 8; memoryMiB: 4096; diskGiB: 30 }
  >;
  /** a domain with no size of its own is skipped; and what no one sets stays unset, so the
   *  defaults come last */
  export type Gaps = [
    Expect<Invoke<typeof merge, [a: null, b: undefined, c: { cpus: 2 }]>["cpus"], "=", 2>,
    Expect<Invoke<typeof merge, [a: null, b: undefined, c: { cpus: 2 }]>["memoryMiB"], "undefined">,
  ];
}

// ------------------------------------------------------------------ a project's own size
// What a project's devcontainer.json asks for, read by the root from the mirror (what the
// remote published, root/domains.ts projectSizeOf), for each part: desolate's own
// `customizations.desolate` ({ cpus, memory, disk }) first, then the devcontainer spec's
// `hostRequirements` ({ cpus, memory, storage }: what Codespaces reads). It comes after the
// person's own choices (`up`'s flags, the domain's size) and before the stack's defaults.
// It is a repository's content, so it is data: checked as a size, and kept within this Mac
// (capToMac).

/** An amount as a devcontainer.json writes it: "16gb", "16g", "16GiB", "512mb", "1tb"; a
 *  bare number is GiB. In MiB, or null. */
export const parseSpecAmount = (value: unknown): number | null => {
  if (typeof value === "number")
    return Number.isFinite(value) && value > 0 ? Math.round(value * 1024) : null;
  if (typeof value !== "string") return null;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(t|tb|tib|g|gb|gib|m|mb|mib|k|kb|kib)?\s*$/i.exec(value);
  if (!match) return null;
  const unit = (match[2] ?? "g")[0]!.toLowerCase();
  const factor = unit === "t" ? 1024 * 1024 : unit === "g" ? 1024 : unit === "m" ? 1 : 1 / 1024;
  const mib = Math.round(Number(match[1]) * factor);
  return Number.isFinite(mib) && mib > 0 ? mib : null;
};

declare namespace parseSpecAmount {
  /** the spec's own units (tb, gb, mb, kb, as hostRequirements writes them), desolate's
   *  spellings ("16g", "16GiB"), and a bare number as GiB; anything else is not an amount */
  export type Spellings = Table<
    typeof parseSpecAmount,
    [
      [args: [value: "16gb"], expected: 16384],
      [args: [value: "16g"], expected: 16384],
      [args: [value: "16GiB"], expected: 16384],
      [args: [value: "512mb"], expected: 512],
      [args: [value: "1tb"], expected: 1048576],
      [args: [value: 16], expected: 16384],
      [args: [value: "16"], expected: 16384],
      [args: [value: "1.5g"], expected: 1536],
      [args: [value: "lots"], expected: null],
      [args: [value: -4], expected: null],
      [args: [value: { gb: 16 }], expected: null],
    ]
  >;
}

export type ProjectSize = { size: Partial<Size>; problems: string[] };

/** What a parsed devcontainer.json asks for, each part from `customizations.desolate` if it
 *  sets it, else from `hostRequirements`; a part that is not a size desolate makes is left
 *  out, and said. */
export const projectSize = (spec: unknown): ProjectSize => {
  const object = (value: unknown): Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const top = object(spec);
  const ours = object(object(top.customizations).desolate);
  const host = object(top.hostRequirements);
  // It is the repository's text: made safe, and cut where it is long, with the mark (R1).
  const shown = (value: unknown) => printable(JSON.stringify(value) ?? String(value), 40);
  const size: Partial<Size> = {};
  const problems: string[] = [];
  const parts = [
    ["cpus", "cpus", "cpus", (v: unknown) => (typeof v === "number" ? v : null)],
    ["memoryMiB", "memory", "memory", parseSpecAmount],
    [
      "diskGiB",
      "disk",
      "storage",
      (v: unknown) => {
        const mib = parseSpecAmount(v);
        return mib === null ? null : Math.ceil(mib / 1024);
      },
    ],
  ] as const;
  for (const [key, mine, theirs, parse] of parts) {
    const where =
      ours[mine] !== undefined
        ? `customizations.desolate.${mine}`
        : host[theirs] !== undefined
          ? `hostRequirements.${theirs}`
          : null;
    if (!where) continue;
    const value = ours[mine] !== undefined ? ours[mine] : host[theirs];
    const parsed = parse(value);
    if (parsed === null) {
      problems.push(
        `${where}: ${shown(value)} is not ${key === "cpus" ? "a number of CPUs" : 'an amount (write it as "16g")'}`,
      );
      continue;
    }
    const why = checkSize({ [key]: parsed });
    if (why) problems.push(`${where}: ${why}`);
    else size[key] = parsed;
  }
  return { size, problems };
};

declare namespace projectSize {
  /** desolate's own customizations first, part by part, then the spec's hostRequirements */
  export type Both = Expect<
    Invoke<
      typeof projectSize,
      [
        spec: {
          customizations: { desolate: { memory: "16g" } };
          hostRequirements: { cpus: 4; memory: "8gb"; storage: "64gb" };
        },
      ]
    >,
    "=",
    { size: { cpus: 4; memoryMiB: 16384; diskGiB: 64 }; problems: [] }
  >;
  /** a project that says nothing asks for nothing */
  export type Silent = Expect<
    Invoke<typeof projectSize, [spec: { image: "node:22" }]>,
    "=",
    { size: {}; problems: [] }
  >;
  /** what is not a size desolate makes is left out, in the spec's own words */
  export type Wrong = Expect<
    Invoke<
      typeof projectSize,
      [spec: { customizations: { desolate: { cpus: "four"; memory: "512m"; disk: "lots" } } }]
    >,
    "=",
    {
      size: {};
      problems: [
        'customizations.desolate.cpus: "four" is not a number of CPUs',
        "customizations.desolate.memory: memory must be from 1 GiB to 256 GiB",
        'customizations.desolate.disk: "lots" is not an amount (write it as "16g")',
      ];
    }
  >;
  /** not an object at all: nothing */
  export type NotAnObject = Expect<
    Invoke<typeof projectSize, [spec: null]>,
    "=",
    { size: {}; problems: [] }
  >;
}

/** A project's size, kept within this Mac: no more CPUs than it has cores, and no more than
 *  three quarters of its memory (memory is a ceiling a VM fills, and macOS is slow to take it
 *  back: one that could take all of it could stall the Mac). Disk is not capped: it grows as
 *  it is written. What was lowered, said. */
export const capToMac = (
  size: Partial<Size>,
  cores: number,
  memoryMiB: number,
): { size: Partial<Size>; capped: string[] } => {
  const out = { ...size };
  const capped: string[] = [];
  if (out.cpus !== undefined && out.cpus > cores) {
    capped.push(`${out.cpus} CPUs: this Mac has ${cores}`);
    out.cpus = cores;
  }
  const most = mostMemoryFor(memoryMiB);
  if (out.memoryMiB !== undefined && out.memoryMiB > most) {
    capped.push(
      `${out.memoryMiB % 1024 === 0 ? `${out.memoryMiB / 1024} GiB` : `${out.memoryMiB} MiB`} memory: a workspace gets at most ${most / 1024} GiB here, three quarters of this Mac's ${Math.round(memoryMiB / 1024)} GiB`,
    );
    out.memoryMiB = most;
  }
  return { size: out, capped };
};

declare namespace capToMac {
  /** within the Mac: as asked */
  export type Within = Expect<
    Invoke<typeof capToMac, [size: { cpus: 4; memoryMiB: 16384 }, cores: 10, memoryMiB: 32768]>,
    "=",
    { size: { cpus: 4; memoryMiB: 16384 }; capped: [] }
  >;
  /** more than the Mac: lowered, and said */
  export type Over = Expect<
    Invoke<
      typeof capToMac,
      [size: { cpus: 64; memoryMiB: 262144; diskGiB: 500 }, cores: 10, memoryMiB: 32768]
    >,
    "=",
    {
      size: { cpus: 10; memoryMiB: 24576; diskGiB: 500 };
      capped: [
        "64 CPUs: this Mac has 10",
        "256 GiB memory: a workspace gets at most 24 GiB here, three quarters of this Mac's 32 GiB",
      ];
    }
  >;
}

/** The parts a partial size sets, for a person: "16 GiB memory, 4 CPUs". */
export const describeParts = (size: Partial<Size>): string =>
  [
    size.cpus !== undefined ? `${size.cpus} CPU${size.cpus === 1 ? "" : "s"}` : null,
    size.memoryMiB !== undefined
      ? `${size.memoryMiB % 1024 === 0 ? `${size.memoryMiB / 1024} GiB` : `${size.memoryMiB} MiB`} memory`
      : null,
    size.diskGiB !== undefined ? `${size.diskGiB} GiB disk` : null,
  ]
    .filter(Boolean)
    .join(", ");

declare namespace describeParts {
  export type Some = Expect<
    Invoke<typeof describeParts, [size: { memoryMiB: 16384; diskGiB: 60 }]>,
    "=",
    "16 GiB memory, 60 GiB disk"
  >;
  export type None = Expect<Invoke<typeof describeParts, [size: {}]>, "=", "">;
}
