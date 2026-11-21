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
// Today a setting's value is its environment variable, or its default. When `desolate
// settings` stores values and the host passes them into each VM, `valueOf` is where that is
// read: no caller changes.
//
// A setting is listed once its file has been imported: what lists them imports the files.
import { PORTS } from "./limits.ts";
import { parseMemory } from "./size.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type {
  Expect,
  Given,
  Invoke,
  Table,
  Throws,
} from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { setEnv } from "../.harness/env.ts";
import type { namesOf } from "../.harness/shared-settings.ts";

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

/** A setting's value now: what its variable says, read by its parser, or its default when
 *  the variable is unset or empty. A variable that is set to something its parser does not
 *  take is refused (throws), naming the variable, what it takes and what it holds: a typo
 *  must not silently become the default. */
export const valueOf = <T>(setting: Setting<T>): T => {
  const text = process.env[setting.env];
  if (text === undefined || text.trim() === "") {
    const or = setting.default;
    return typeof or === "function" ? (or as () => T)() : or;
  }
  const value = setting.parse(text);
  if (value === null)
    throw new Error(
      `${setting.env} must be ${setting.parse.takes ?? `a value for ${setting.name}`}, not '${text.slice(0, 80)}'`,
    );
  return value;
};

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
    Throws<
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
      "DESOLATE_GIT_SHELLS must be a whole number from 1 to 64, not 'lots'"
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

/** A size of memory or disk, answered in MiB, from `min` to `max` MiB. Written as size.ts's
 *  parseMemory reads it: "8g", "8GiB", "512m", or a bare number of MiB. */
export const mebibytes = (min: number, max: number): Parse<number> =>
  taking(`a size from ${min} to ${max} MiB (as 4096, 4096m or 4g)`, (text) => {
    const value = parseMemory(text);
    return value !== null && value >= min && value <= max ? value : null;
  });

declare namespace mebibytes {
  /** with a unit or without, in the range */
  export type Reads = [
    Expect<Invoke<Invoke<typeof mebibytes, [min: 1024, max: 65536]>, [text: "4g"]>, "=", 4096>,
    Expect<Invoke<Invoke<typeof mebibytes, [min: 1024, max: 65536]>, [text: "2048"]>, "=", 2048>,
    Expect<Invoke<Invoke<typeof mebibytes, [min: 1024, max: 65536]>, [text: "1536m"]>, "=", 1536>,
    Expect<Invoke<Invoke<typeof mebibytes, [min: 1024, max: 65536]>, [text: "512m"]>, "=", null>,
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
