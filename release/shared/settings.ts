// The registry of settings (docs/v3/limits.md, R6): what depends on this Mac or this person
// is declared once, with its default and why, in the file that uses it, and read with
// `valueOf`. No `process.env.DESOLATE_*` is read anywhere else for a tunable, so one place
// knows every setting there is: `defined()` is what `desolate settings` lists.
//
//   export const SHELLS = define({
//     name: "git.shells",
//     env: "DESOLATE_GIT_SHELLS",
//     side: "host",
//     default: 6,
//     parse: whole(1, 64),
//     why: "How many git terminals may be open at once: each is a shell in the git VM.",
//   });
//   ... valueOf(SHELLS)
//
// A setting's value is, in order: its environment variable (in the process that reads it),
// what the person stored with `desolate settings set`, its default. What is stored is the
// person's, on the Mac (`storeFile`): a file under the host's home, which no VM's share
// reaches. A setting read in a VM (side root, workspace or git) is passed in by the host
// when it starts that VM (host/settings.ts `passInward`): a file of root's on the VM's own
// disk, not on a share, so nothing in one VM changes what another VM, or the host, reads. In
// the root VM that also keeps its ordinary user from changing what the root's services read.
// (In the git VM and a workspace, whatever runs there may be root there: what is passed in
// is that VM's own business, never protected from it.) Each side reads only its own store:
// a setting of the Mac's, read by code that runs in a VM, has no store there (its home is
// that VM's user's), so only its variable and its default. A process inside a VM can still
// be started with a variable of its own: that changes only what that process does.
//
// A setting is listed once its file has been imported: what lists them imports the files
// (host/settings.ts finds them by their `define(` calls; there is no list to keep).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Refusal } from "./exit.ts";
import { PORTS } from "./limits.ts";
import { printable } from "./text.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type {
  Caught,
  Expect,
  Given,
  Invoke,
  Table,
  Throws,
} from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { setEnv } from "../.harness/env.ts";
import type { namesOf, storeText } from "../.harness/shared-settings.ts";
import type { refusalOf } from "../.harness/refusal.ts";

/** A value as a person typed it, read: the value, or null when it is not one. `takes` says
 *  what one is ("a whole number from 1 to 64"), for the refusal of a value that is not. The
 *  parsers below say it; a parser written as a plain function need not. */
export type Parse<T> = { (text: string): T | null; takes?: string };

export type Setting<T> = {
  /** Its name, as a person says it: "root.memoryMiB". The part before the first dot is
   *  what it is a setting of; a unit is part of the name. */
  name: string;
  /** The environment variable that sets it: "DESOLATE_ROOT_MEMORY_MIB". */
  env: string;
  /** Where the code that reads it runs. */
  side: "host" | "root" | "workspace" | "git";
  /** What it is when nobody set it: a value, or a function when it is worked out from the
   *  machine (its cores, its memory), each time it is asked for. */
  default: T | (() => T);
  parse: Parse<T>;
  /** One sentence a person reads in `desolate settings`: what it changes, and what it costs. */
  why: string;
};

const NAME = /^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)+$/;
const ENV = /^DESOLATE_[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/;
const SIDES = ["host", "root", "workspace", "git"];

const registry: Setting<unknown>[] = [];

/** Declares a setting, and answers it for `valueOf`. Refuses (throws) a name or a variable
 *  that is not spelled as one, and one already declared: a setting has one definition. */
export const define = <T>(setting: Setting<T>): Setting<T> => {
  if (!NAME.test(setting.name))
    throw new Error(`'${setting.name}' is not a setting's name (as 'root.memoryMiB')`);
  if (!ENV.test(setting.env))
    throw new Error(`'${setting.env}' is not a setting's variable (as 'DESOLATE_ROOT_MEMORY_MIB')`);
  if (!SIDES.includes(setting.side))
    throw new Error(`'${setting.side}' is not where a setting is read: ${SIDES.join(", ")}`);
  const twice = registry.find((s) => s.name === setting.name || s.env === setting.env);
  if (twice)
    throw new Error(
      `the setting ${setting.name} (${setting.env}) is already defined, as ${twice.name} (${twice.env})`,
    );
  registry.push(setting as Setting<unknown>);
  return setting;
};

declare namespace define {
  /** the setting itself comes back, to be read with valueOf and listed by defined. (The DSL
   *  writes a generic function's arguments as literals, so `parse` is not shown here: the
   *  parsers below have their own tests.) */
  export type Declares = Expect<
    Invoke<
      typeof define,
      [
        setting: {
          name: "git.shells";
          env: "DESOLATE_GIT_SHELLS";
          side: "host";
          default: 6;
          parse: Invoke<typeof whole, [min: 1, max: 64]>;
          why: "How many git terminals may be open at once: each is a shell in the git VM.";
        },
      ]
    >,
    "matches",
    { name: "git.shells"; env: "DESOLATE_GIT_SHELLS"; side: "host"; default: 6 }
  >;
  /** a name is `area.thing`, a variable is DESOLATE_ and capitals: anything else is a
   *  mistake in the code, said when the file loads */
  export type Misspelled = [
    Throws<
      Invoke<
        typeof define,
        [
          setting: {
            name: "shells";
            env: "DESOLATE_GIT_SHELLS";
            side: "host";
            default: 6;
            parse: Invoke<typeof whole, [min: 1, max: 64]>;
            why: "";
          },
        ]
      >,
      "'shells' is not a setting's name"
    >,
    Throws<
      Invoke<
        typeof define,
        [
          setting: {
            name: "git.shells";
            env: "GIT_SHELLS";
            side: "host";
            default: 6;
            parse: Invoke<typeof whole, [min: 1, max: 64]>;
            why: "";
          },
        ]
      >,
      "'GIT_SHELLS' is not a setting's variable"
    >,
  ];
  /** one definition each: a second with the same name, or the same variable, is refused */
  export type Twice = Given<
    Invoke<
      typeof define,
      [
        setting: {
          name: "git.shells";
          env: "DESOLATE_GIT_SHELLS";
          side: "host";
          default: 6;
          parse: Invoke<typeof whole, [min: 1, max: 64]>;
          why: "";
        },
      ]
    >,
    Throws<
      Invoke<
        typeof define,
        [
          setting: {
            name: "git.terminals";
            env: "DESOLATE_GIT_SHELLS";
            side: "host";
            default: 6;
            parse: Invoke<typeof whole, [min: 1, max: 64]>;
            why: "";
          },
        ]
      >,
      "the setting git.terminals (DESOLATE_GIT_SHELLS) is already defined, as git.shells (DESOLATE_GIT_SHELLS)"
    >
  >;
}

/** Every setting defined so far, in the order they were: what `desolate settings` lists. */
export const defined = (): readonly Setting<unknown>[] => registry;

declare namespace defined {
  /** each setting a loaded file declared, once */
  export type Lists = Given<
    [
      Invoke<
        typeof define,
        [
          setting: {
            name: "git.shells";
            env: "DESOLATE_GIT_SHELLS";
            side: "host";
            default: 6;
            parse: Invoke<typeof whole, [min: 1, max: 64]>;
            why: "";
          },
        ]
      >,
      Invoke<
        typeof define,
        [
          setting: {
            name: "root.memoryMiB";
            env: "DESOLATE_ROOT_MEMORY_MIB";
            side: "host";
            default: 2048;
            parse: Invoke<typeof mebibytes, [min: 1024, max: 65536]>;
            why: "";
          },
        ]
      >,
    ],
    Expect<
      Invoke<typeof namesOf, [settings: Invoke<typeof defined>]>,
      "=",
      ["git.shells", "root.memoryMiB"]
    >
  >;
}

/** Where a value was found: the reading process's environment, what the person stored (on
 *  the Mac, or passed into the VM by the host), or nowhere (the default). */
export type From = "environment" | "stored" | "default";

/** What `desolate settings set` keeps: each setting's text as the person wrote it, and the
 *  side it is read on (so the host can pass a VM's into it without loading every file). */
export type Stored = Record<string, { value: string; side: Setting<unknown>["side"] }>;

/** The file a setting of `side` is stored in, as the process reading it sees it. On the Mac
 *  (side host): `settings.json` in the host's home (DESOLATE_HOME, else ~/.desolate, as
 *  host/paths.ts has it; read here, not imported, since this file runs in every VM too).
 *  In a VM: what the host wrote there as root, on the VM's own disk. */
export const storeFile = (side: Setting<unknown>["side"]): string =>
  side === "host"
    ? path.join(
        path.resolve(process.env.DESOLATE_HOME ?? path.join(os.homedir(), ".desolate")),
        "settings.json",
      )
    : INWARD;

/** In a VM, where the host leaves the settings passed in: root's, mode 0644, not a share. */
export const INWARD = "/etc/desolate/settings.json";

/** Whether the code at `here` (this file, by default) runs in a VM: desolate's code is there
 *  at /desolate/release (a read-only share) or in root's copy under /opt/desolate. */
export const inVm = (here: string = fileURLToPath(import.meta.url)): boolean =>
  here.startsWith("/desolate/") || here.startsWith("/opt/desolate/");

declare namespace inVm {
  export type Where = Table<
    typeof inVm,
    [
      [args: [here: "/desolate/release/shared/settings.ts"], expected: true],
      [args: [here: "/opt/desolate/proxy-code/shared/settings.ts"], expected: true],
      [args: [here: "/Users/ada/desolate/release/shared/settings.ts"], expected: false],
      [
        args: [here: "/workspaces/pmalacho-mit/desolate/release/shared/settings.ts"],
        expected: false,
      ],
    ]
  >;
}

const read = new Map<string, { at: string; stored: Stored }>();

/** What is stored in `file` (nothing, when there is no file). Read again only when the file
 *  changed, so a value set while a program runs is what its next `valueOf` gives. A file
 *  that is not what `desolate settings` writes is refused, never taken as nothing: a value
 *  the person set must not silently become the default. */
export const storedIn = (file: string): Stored => {
  let at: string;
  try {
    const stat = fs.statSync(file);
    at = `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const known = read.get(file);
  if (known?.at === at) return known.stored;
  // A file that cannot be read is said as that (its mode, a directory), not as bad content.
  const text = fs.readFileSync(file, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  // No prototype: a name is looked up as itself ("toString" is no setting).
  const stored: Stored = Object.create(null);
  const object = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  const ours =
    object &&
    Object.entries(parsed as Record<string, unknown>).every(([name, entry]) => {
      const { value, side } = (entry ?? {}) as { value?: unknown; side?: unknown };
      if (typeof value !== "string" || typeof side !== "string" || !SIDES.includes(side))
        return false;
      stored[name] = { value, side: side as Setting<unknown>["side"] };
      return true;
    });
  if (!ours)
    throw new Refusal(
      `${file} is not the settings desolate stores (an object of { "value": text, "side": where } by name)`,
      `move it aside (desolate settings set writes a new one): mv ${file} ${file}.bad`,
    );
  read.set(file, { at, stored });
  return stored;
};

/** A setting's value now, and where it came from: its variable, read by its parser, else
 *  what was stored, else its default. A variable that is unset or empty is not set. A value
 *  that is set to something its parser does not take is refused (throws), naming where it
 *  is, what it takes and what it holds: a typo must not silently become the default. */
export const lookup = <T>(setting: Setting<T>): { value: T; from: From } => {
  const text = process.env[setting.env];
  if (text !== undefined && text.trim() !== "") {
    const value = setting.parse(text);
    if (value === null)
      throw new Refusal(
        `${setting.env} must be ${setting.parse.takes ?? `a value for ${setting.name}`}, not '${printable(text, 80)}'`,
        `unset ${setting.env} (or set it to what it takes)`,
      );
    return { value, from: "environment" };
  }
  const here = (setting.side === "host") !== inVm();
  const stored = here ? storedIn(storeFile(setting.side))[setting.name] : undefined;
  if (stored !== undefined) {
    const value = setting.parse(stored.value);
    if (value === null)
      throw new Refusal(
        `${setting.name} is stored as '${printable(stored.value, 80)}', and must be ${setting.parse.takes ?? "a value it takes"}`,
        `on the Mac: desolate settings set ${setting.name} <value> (or unset ${setting.name})`,
      );
    return { value, from: "stored" };
  }
  const or = setting.default;
  return { value: typeof or === "function" ? (or as () => T)() : or, from: "default" };
};

declare namespace lookup {
  /** the variable comes first, then what was stored, then the default */
  export type Order = [
    Given<
      [
        Invoke<typeof storeText, [text: '{"git.shells":{"value":"9","side":"host"}}']>,
        Invoke<typeof setEnv, [name: "DESOLATE_GIT_SHELLS", value: "12"]>,
      ],
      Expect<
        Invoke<
          typeof lookup,
          [
            setting: {
              name: "git.shells";
              env: "DESOLATE_GIT_SHELLS";
              side: "host";
              default: 6;
              parse: Invoke<typeof whole, [min: 1, max: 64]>;
              why: "";
            },
          ]
        >,
        "=",
        { value: 12; from: "environment" }
      >
    >,
    Given<
      [
        Invoke<typeof storeText, [text: '{"git.shells":{"value":"9","side":"host"}}']>,
        Invoke<typeof setEnv, [name: "DESOLATE_GIT_SHELLS", value: null]>,
      ],
      Expect<
        Invoke<
          typeof lookup,
          [
            setting: {
              name: "git.shells";
              env: "DESOLATE_GIT_SHELLS";
              side: "host";
              default: 6;
              parse: Invoke<typeof whole, [min: 1, max: 64]>;
              why: "";
            },
          ]
        >,
        "=",
        { value: 9; from: "stored" }
      >
    >,
    Given<
      [
        Invoke<typeof storeText, [text: '{"other.thing":{"value":"9","side":"host"}}']>,
        Invoke<typeof setEnv, [name: "DESOLATE_GIT_SHELLS", value: null]>,
      ],
      Expect<
        Invoke<
          typeof lookup,
          [
            setting: {
              name: "git.shells";
              env: "DESOLATE_GIT_SHELLS";
              side: "host";
              default: 6;
              parse: Invoke<typeof whole, [min: 1, max: 64]>;
              why: "";
            },
          ]
        >,
        "=",
        { value: 6; from: "default" }
      >
    >,
  ];
  /** a stored value the setting does not take (the file edited by hand, or a range that
   *  changed since) is refused in the setting's own words, with how to put it right */
  export type StoredWrong = Given<
    [
      Invoke<typeof storeText, [text: '{"git.shells":{"value":"lots","side":"host"}}']>,
      Invoke<typeof setEnv, [name: "DESOLATE_GIT_SHELLS", value: null]>,
    ],
    Expect<
      Invoke<
        typeof refusalOf,
        [
          run: typeof lookup,
          args: [
            setting: {
              name: "git.shells";
              env: "DESOLATE_GIT_SHELLS";
              side: "host";
              default: 6;
              parse: Invoke<typeof whole, [min: 1, max: 64]>;
              why: "";
            },
          ],
        ]
      >,
      "=",
      {
        message: "git.shells is stored as 'lots', and must be a whole number from 1 to 64";
        fix: "on the Mac: desolate settings set git.shells <value> (or unset git.shells)";
        code: 1;
      }
    >
  >;
  /** a setting read in a VM is not read from the Mac's store: the host passes those in */
  export type NotTheMacs = Given<
    [
      Invoke<typeof storeText, [text: '{"root.landedMinutes":{"value":"5","side":"root"}}']>,
      Invoke<typeof setEnv, [name: "DESOLATE_ROOT_LANDED_MINUTES", value: null]>,
    ],
    Expect<
      Invoke<
        typeof lookup,
        [
          setting: {
            name: "root.landedMinutes";
            env: "DESOLATE_ROOT_LANDED_MINUTES";
            side: "root";
            default: 15;
            parse: Invoke<typeof whole, [min: 1, max: 1440]>;
            why: "";
          },
        ]
      >,
      "=",
      { value: 15; from: "default" }
    >
  >;
}

declare namespace storedIn {
  /** what `desolate settings` writes is read, by name: the control for the refusal below */
  export type Ours = Given<
    Invoke<typeof storeText, [text: '{"git.shells":{"value":"9","side":"host"}}']>,
    Expect<
      Invoke<typeof storedIn, [file: Invoke<typeof storeFile, [side: "host"]>]>,
      "matches",
      { "git.shells": { value: "9"; side: "host" } }
    >
  >;
  /** a file that is not one desolate wrote is refused, not read as nothing */
  export type NotOurs = Given<
    Invoke<typeof storeText, [text: '{"git.shells":9}']>,
    Throws<
      Invoke<typeof storedIn, [file: Invoke<typeof storeFile, [side: "host"]>]>,
      "is not the settings desolate stores"
    >
  >;
}

/** A setting's value now (`lookup`'s, without where it came from): what every caller reads. */
export const valueOf = <T>(setting: Setting<T>): T => lookup(setting).value;

declare namespace valueOf {
  /** nobody set it: the default */
  export type Default = Given<
    Invoke<typeof setEnv, [name: "DESOLATE_GIT_SHELLS", value: null]>,
    Expect<
      Invoke<
        typeof valueOf,
        [
          setting: {
            name: "git.shells";
            env: "DESOLATE_GIT_SHELLS";
            side: "host";
            default: 6;
            parse: Invoke<typeof whole, [min: 1, max: 64]>;
            why: "";
          },
        ]
      >,
      "=",
      6
    >
  >;
  /** the person's shell set it: that, read by the setting's parser */
  export type Set = Given<
    Invoke<typeof setEnv, [name: "DESOLATE_ROOT_MEMORY_MIB", value: "4g"]>,
    Expect<
      Invoke<
        typeof valueOf,
        [
          setting: {
            name: "root.memoryMiB";
            env: "DESOLATE_ROOT_MEMORY_MIB";
            side: "host";
            default: 2048;
            parse: Invoke<typeof mebibytes, [min: 1024, max: 65536]>;
            why: "";
          },
        ]
      >,
      "=",
      4096
    >
  >;
  /** set to nothing is not set */
  export type Empty = Given<
    Invoke<typeof setEnv, [name: "DESOLATE_GIT_SHELLS", value: ""]>,
    Expect<
      Invoke<
        typeof valueOf,
        [
          setting: {
            name: "git.shells";
            env: "DESOLATE_GIT_SHELLS";
            side: "host";
            default: 6;
            parse: Invoke<typeof whole, [min: 1, max: 64]>;
            why: "";
          },
        ]
      >,
      "=",
      6
    >
  >;
  /** a value that is not one is refused, never taken as the default: the variable, what it
   *  takes, and what it holds */
  export type Refuses = Given<
    Invoke<typeof setEnv, [name: "DESOLATE_GIT_SHELLS", value: "lots"]>,
    Expect<
      Caught<
        Invoke<
          typeof valueOf,
          [
            setting: {
              name: "git.shells";
              env: "DESOLATE_GIT_SHELLS";
              side: "host";
              default: 6;
              parse: Invoke<typeof whole, [min: 1, max: 64]>;
              why: "";
            },
          ]
        >,
        Refusal
      >,
      "matches",
      {
        message: "DESOLATE_GIT_SHELLS must be a whole number from 1 to 64, not 'lots'";
        fix: "unset DESOLATE_GIT_SHELLS (or set it to what it takes)";
        code: 1;
      }
    >
  >;
}

const taking = <T>(takes: string, parse: (text: string) => T | null): Parse<T> =>
  Object.assign(parse, { takes });

/** A whole number from `min` to `max`: a count of something. */
export const whole = (min: number, max: number): Parse<number> =>
  taking(`a whole number from ${min} to ${max}`, (text) => {
    if (!/^\s*\d{1,15}\s*$/.test(text)) return null;
    const value = Number(text);
    return value >= min && value <= max ? value : null;
  });

declare namespace whole {
  /** digits, within the range; no sign, no fraction, no unit */
  export type Reads = [
    Expect<Invoke<Invoke<typeof whole, [min: 1, max: 64]>, [text: "6"]>, "=", 6>,
    Expect<Invoke<Invoke<typeof whole, [min: 1, max: 64]>, [text: " 64 "]>, "=", 64>,
    Expect<Invoke<Invoke<typeof whole, [min: 1, max: 64]>, [text: "65"]>, "=", null>,
    Expect<Invoke<Invoke<typeof whole, [min: 1, max: 64]>, [text: "0"]>, "=", null>,
    Expect<Invoke<Invoke<typeof whole, [min: 1, max: 64]>, [text: "6.5"]>, "=", null>,
    Expect<Invoke<Invoke<typeof whole, [min: 1, max: 64]>, [text: "-6"]>, "=", null>,
    Expect<Invoke<Invoke<typeof whole, [min: 1, max: 64]>, [text: "0x10"]>, "=", null>,
    Expect<Invoke<Invoke<typeof whole, [min: 1, max: 64]>, [text: "six"]>, "=", null>,
  ];
}

/** "8g", "8gb", "8GiB", "512m", "8192" (MiB): memory in MiB, or null. */
export const parseMemory = (value: unknown): number | null => {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(g|gb|gib|m|mb|mib)?\s*$/i.exec(String(value ?? ""));
  if (!match) return null;
  const amount = Number(match[1]);
  const mib = /^g/i.test(match[2] ?? "") ? amount * 1024 : amount;
  return Number.isFinite(mib) && Number.isInteger(Math.round(mib)) ? Math.round(mib) : null;
};

declare namespace parseMemory {
  /** what a person types after --memory: GiB with a g, MiB with an m or nothing; a fraction of
   *  a GiB is whole MiB; anything else is not a size */
  export type Spellings = Table<
    typeof parseMemory,
    [
      [args: [value: "8g"], expected: 8192],
      [args: [value: "8GiB"], expected: 8192],
      [args: [value: " 8 GB "], expected: 8192],
      [args: [value: "1.5g"], expected: 1536],
      [args: [value: "512m"], expected: 512],
      [args: [value: "4096"], expected: 4096],
      [args: [value: "lots"], expected: null],
      [args: [value: "-4g"], expected: null],
      [args: [value: "8t"], expected: null],
      [args: [value: null], expected: null],
    ]
  >;
}

/** A size of memory or disk, answered in MiB, from `min` to `max` MiB. Written as
 *  parseMemory reads it: "8g", "8GiB", "512m", or a bare number of MiB. */
export const mebibytes = (min: number, max: number): Parse<number> =>
  taking(`a size from ${min} to ${max} MiB (as 4096, 4096m or 4g)`, (text) => {
    const value = parseMemory(text);
    // parseMemory rounds to whole MiB, and a bound must not: "1023.6m" is not 1024. (Ten
    // places hold any whole MiB in GiB, k/1024, and keep the product exact.)
    const exact = parseFloat(text) * (/g/i.test(text) ? 1024 : 1);
    const ok = value === exact && !/\.\d{11}/.test(text);
    return ok && value >= min && value <= max ? value : null;
  });

declare namespace mebibytes {
  /** with a unit or without, in the range */
  export type Reads = [
    Expect<Invoke<Invoke<typeof mebibytes, [min: 1024, max: 65536]>, [text: "4g"]>, "=", 4096>,
    Expect<Invoke<Invoke<typeof mebibytes, [min: 1024, max: 65536]>, [text: "2048"]>, "=", 2048>,
    Expect<Invoke<Invoke<typeof mebibytes, [min: 1024, max: 65536]>, [text: "1536m"]>, "=", 1536>,
    Expect<Invoke<Invoke<typeof mebibytes, [min: 1024, max: 65536]>, [text: "1.5g"]>, "=", 1536>,
    Expect<Invoke<Invoke<typeof mebibytes, [min: 1024, max: 65536]>, [text: "512m"]>, "=", null>,
    Expect<Invoke<Invoke<typeof mebibytes, [min: 1024, max: 65536]>, [text: "1023.6m"]>, "=", null>,
    Expect<Invoke<Invoke<typeof mebibytes, [min: 1024, max: 65536]>, [text: "1.0001g"]>, "=", null>,
    Expect<
      Invoke<Invoke<typeof mebibytes, [min: 1024, max: 65536]>, [text: "0.99999999999999999g"]>,
      "=",
      null
    >,
    Expect<Invoke<Invoke<typeof mebibytes, [min: 1024, max: 65536]>, [text: "1t"]>, "=", null>,
    Expect<Invoke<Invoke<typeof mebibytes, [min: 1024, max: 65536]>, [text: "lots"]>, "=", null>,
  ];
}

/** A list of ports, each one a program without root may listen on (limits.ts's PORTS),
 *  separated by commas or spaces. Each once, in the order given. One entry that is not such
 *  a port and the whole list is not one: a port left out silently is a port that does not
 *  work, with nothing to say why. */
export const ports: Parse<number[]> = taking(
  `ports from ${PORTS.min} to ${PORTS.max}, separated by commas`,
  (text) => {
    const words = text.split(/[\s,]+/).filter((word) => word !== "");
    const list: number[] = [];
    for (const word of words) {
      const port = /^\d{1,5}$/.test(word) ? Number(word) : NaN;
      if (!(port >= PORTS.min && port <= PORTS.max)) return null;
      if (!list.includes(port)) list.push(port);
    }
    return list.length > 0 ? list : null;
  },
);

declare namespace ports {
  /** what a person writes after DESOLATE_..._PORTS= */
  export type Reads = Table<
    typeof ports,
    [
      [args: [text: "3000,5173"], expected: [3000, 5173]],
      [args: [text: "3000, 5173 8080"], expected: [3000, 5173, 8080]],
      [args: [text: "5173,3000,5173"], expected: [5173, 3000]],
      /** one that needs root, or is no port: the whole list refused, not that entry dropped */
      [args: [text: "3000,80"], expected: null],
      [args: [text: "3000,65536"], expected: null],
      [args: [text: "3000,http"], expected: null],
      [args: [text: " , "], expected: null],
    ]
  >;
}
