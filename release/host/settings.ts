// `desolate settings`: every setting there is (shared/settings.ts), its value, where that came
// from, its default and why; `set` and `unset`, which keep the person's choices in the host's
// home; and what the host passes into each VM when it starts it.
//
// There is no list of settings to keep: each is declared by `define` in the file that uses
// it, and registers itself when that file is imported. So this imports every file under
// release/ that imports `define` from shared/settings.ts, found by reading them. Those files
// are imported, not run: every one already is by its in-source tests, so none does anything
// at import (the harness README, "Make code testable").
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { EXIT, Refusal, refuse } from "../shared/exit.ts";
import { writeJson } from "../shared/json.ts";
import { defined, lookup, storedIn, storeFile } from "../shared/settings.ts";
import type { From, Setting, Stored } from "../shared/settings.ts";
import {
  GIT_CPUS,
  GIT_MEMORY,
  ROOT_CPUS,
  ROOT_MEMORY,
  vmSize,
  WORKSPACE_CPUS,
  WORKSPACE_DISK,
  WORKSPACE_MEMORY,
} from "../shared/size.ts";
import { printable } from "../shared/text.ts";
import { APPROVER_KIND } from "./approver.ts";
import { HOME, RELEASE_DIR } from "./paths.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Given, Invoke } from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { refusalOf } from "../.harness/refusal.ts";
import type { setEnv } from "../.harness/env.ts";
import type { said, storeText } from "../.harness/shared-settings.ts";

/** A file that declares settings: it imports `define` from shared/settings.ts. */
const DECLARES =
  /import\s*\{[^}]*\bdefine\b[^}]*\}\s*from\s*["'][./]*(?:shared\/)?settings\.ts["']/;

/** The files under `dir` that declare settings, relative to it, sorted. The registry itself,
 *  the tests' harness and what is not desolate's code (node_modules) are not looked in. */
export const declaring = (dir: string = RELEASE_DIR): string[] => {
  const found: string[] = [];
  const walk = (at: string) => {
    for (const entry of fs.readdirSync(path.join(dir, at), { withFileTypes: true })) {
      const rel = path.join(at, entry.name);
      if (entry.isDirectory()) {
        if (!["node_modules", ".harness"].includes(entry.name)) walk(rel);
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        rel !== path.join("shared", "settings.ts") &&
        DECLARES.test(fs.readFileSync(path.join(dir, rel), "utf8"))
      )
        found.push(rel);
    }
  };
  walk("");
  return found.sort();
};

declare namespace declaring {
  /** in this release: at least the sizes (shared/size.ts), found by reading the files */
  export type Here = Expect<Invoke<typeof declaring>, "includes", "shared/size.ts">;
}

/** Every setting there is: each file that declares one, imported, then the registry. */
export const all = async (dir: string = RELEASE_DIR): Promise<readonly Setting<unknown>[]> => {
  for (const file of declaring(dir)) await import(pathToFileURL(path.join(dir, file)).href);
  return defined();
};

/** Where each side reads a setting, for a person. */
const WHERE: Record<Setting<unknown>["side"], string> = {
  host: "on the Mac",
  root: "in the root VM",
  workspace: "in each workspace",
  git: "in the git VM",
};

/** When a setting changed now is what the code that reads it uses: which restart it needs. */
export const applies = (setting: Setting<unknown>): string => {
  if (setting === ROOT_CPUS || setting === ROOT_MEMORY)
    return "the root VM has it when it starts again: desolate down, then desolate bootstrap";
  if (setting === GIT_CPUS || setting === GIT_MEMORY)
    return "the git VM has it when it starts again: desolate down, then desolate git";
  if (setting === APPROVER_KIND)
    return `the next bootstrap makes an approver of this kind if there is none; to replace the one there is, move ${path.join(HOME, "approver")} aside first`;
  if (setting === WORKSPACE_CPUS || setting === WORKSPACE_MEMORY || setting === WORKSPACE_DISK)
    return "a workspace made from now on has it (one already made keeps its size: desolate resize)";
  switch (setting.side) {
    case "host":
      return "each desolate command has it from now on; the daemon when it starts again: desolate down, then desolate bootstrap";
    case "root":
      return "the root VM's services have it when they start again: desolate down, then desolate bootstrap";
    case "git":
      return "the git VM has it when it starts again: desolate down, then desolate git";
    case "workspace":
      return "a workspace has it when it starts: desolate stop <domain>/<workspace>, then desolate start <domain>/<workspace>";
  }
};

declare namespace applies {
  /** a VM's size: when that VM starts; a workspace's: when one is made */
  export type Sizes = [
    Expect<
      Invoke<typeof applies, [setting: typeof ROOT_MEMORY]>,
      "includes",
      "desolate down, then desolate bootstrap"
    >,
    Expect<
      Invoke<typeof applies, [setting: typeof WORKSPACE_CPUS]>,
      "startsWith",
      "a workspace made from now on"
    >,
  ];
}

/** A default worked out from what it is used on (a VM's size, a disk), which only that has. */
const WORKED_OUT = "worked out when it is used";

const shown = (value: unknown): string =>
  Array.isArray(value)
    ? value.join(",")
    : typeof value === "string"
      ? value
      : JSON.stringify(value);

/** A setting as `desolate settings` shows it. A setting read in a VM is shown as the host
 *  will pass it in (stored, or not), never with this Mac's environment: a variable in the
 *  person's shell reaches only what runs on the Mac. A default worked out from the machine,
 *  for a setting read in a VM, is that VM's to work out. */
export type Listing = {
  name: string;
  env: string;
  side: Setting<unknown>["side"];
  value: unknown;
  from: From | null;
  default: unknown;
  why: string;
  /** Why its value could not be read (a variable or a stored value it does not take). */
  error?: string;
};

export const listing = (setting: Setting<unknown>): Listing => {
  const here = setting.side === "host";
  const computed = typeof setting.default === "function";
  const fallback =
    !here && computed ? null : computed ? (setting.default as () => unknown)() : setting.default;
  const base = {
    name: setting.name,
    env: setting.env,
    side: setting.side,
    default: fallback,
    why: setting.why,
  };
  try {
    if (here) {
      const { value, from } = lookup(setting);
      return { ...base, value, from };
    }
    const stored = storedIn(storeFile("host"))[setting.name];
    if (stored === undefined) return { ...base, value: fallback, from: "default" };
    const value = setting.parse(stored.value);
    if (value === null)
      return {
        ...base,
        value: null,
        from: "stored",
        error: `stored as '${printable(stored.value, 80)}', which it does not take: ${setting.parse.takes ?? "see its why"}`,
      };
    return { ...base, value, from: "stored" };
  } catch (error) {
    return { ...base, value: null, from: null, error: (error as Error).message };
  }
};

/** `desolate settings [--json]`. */
export const list = async (out: (line: string) => void, json: boolean) => {
  const settings = await all();
  const rows = settings.map(listing);
  if (json) return out(JSON.stringify(rows));
  out(
    "Settings: what depends on this Mac or on you, for every domain and workspace on it (a domain may set its own secrets.heldMiB). Each is read where it says; a variable in your shell comes first, on the Mac.",
  );
  out(
    "Change one: desolate settings set <name> <value>. Back to its default: desolate settings unset <name>.",
  );
  for (const [i, row] of rows.entries()) {
    const setting = settings[i]!;
    const value = row.error
      ? `(refused: ${row.error})`
      : row.value === null
        ? `the default, ${WORKED_OUT} (how: below)`
        : shown(row.value);
    const from =
      row.from === "environment"
        ? `from ${row.env} in this shell`
        : row.from === "stored"
          ? "set by you"
          : row.from === "default" && row.value !== null
            ? "the default"
            : null;
    const fallback =
      row.from === "default" || row.default === undefined
        ? ""
        : `; default ${row.default === null ? WORKED_OUT : shown(row.default)}`;
    out(`  ${row.name} = ${value}${from ? ` (${from}${fallback})` : ""}`);
    out(`      ${row.why}`);
    out(`      read ${WHERE[row.side]}, ${row.env}; a change: ${applies(setting)}`);
  }
};

declare namespace list {
  /** each setting says when a change to it applies (every setting there is, and a default
   *  worked out in a VM: tests/v3/t1/settings.test.ts) */
  export type Applies = Expect<
    Invoke<typeof said, [run: typeof settings, args: [argv: [], json: false]]>,
    "includes",
    "      read on the Mac, DESOLATE_ROOT_MEMORY_MIB; a change: the root VM has it when it starts again: desolate down, then desolate bootstrap"
  >;
}

const named = async (
  name: string | undefined,
  verb: "set" | "unset",
): Promise<Setting<unknown>> => {
  if (!name)
    refuse(`${verb} which setting?`, "desolate settings (each setting, and its name)", EXIT.usage);
  const setting = (await all()).find((s) => s.name === name);
  if (!setting)
    refuse(
      `there is no setting '${printable(name, 80)}'`,
      "desolate settings (each setting, and its name)",
      EXIT.usage,
    );
  return setting;
};

const save = (stored: Stored) => writeJson(storeFile("host"), stored, 0o644);

/** `desolate settings set <name> <value>`: stored on the Mac, after its parser takes it. */
export const set = async (
  name: string | undefined,
  text: string | undefined,
  out: (line: string) => void,
) => {
  const setting = await named(name, "set");
  if (text === undefined || text.trim() === "")
    refuse(
      `set ${setting.name} to what?`,
      `desolate settings set ${setting.name} <value> (${setting.parse.takes ?? "see desolate settings"})`,
      EXIT.usage,
    );
  const value = setting.parse(text);
  if (value === null)
    refuse(
      `${setting.name} must be ${setting.parse.takes ?? "a value it takes"}, not '${printable(text, 80)}'`,
      `desolate settings set ${setting.name} <value>`,
      EXIT.usage,
    );
  save({
    ...storedIn(storeFile("host")),
    [setting.name]: { value: text.trim(), side: setting.side },
  });
  out(`${setting.name} = ${shown(value)}: ${applies(setting)}.`);
  shadowed(setting, out);
};

/** `desolate settings unset <name>`: back to its default. A name stored by a desolate that
 *  had a setting this one has not is unset too. */
export const unset = async (name: string | undefined, out: (line: string) => void) => {
  const stored = { ...storedIn(storeFile("host")) };
  if (name && !(await all()).some((s) => s.name === name) && Object.hasOwn(stored, name)) {
    delete stored[name];
    save(stored);
    return out(`${name}: no longer stored (no setting has that name now).`);
  }
  const setting = await named(name, "unset");
  const was = Object.hasOwn(stored, setting.name);
  delete stored[setting.name];
  if (was) save(stored);
  const fallback = listing(setting).default;
  out(
    `${setting.name}: ${was ? "back to" : "was not set, and is"} its default${fallback === null ? ` (${WORKED_OUT})` : ` (${shown(fallback)})`}${was ? `: ${applies(setting)}` : ""}.`,
  );
  shadowed(setting, out);
};

/** A variable in the person's shell comes before what is stored: said, or a set looks lost. */
const shadowed = (setting: Setting<unknown>, out: (line: string) => void) => {
  if (setting.side === "host" && (process.env[setting.env] ?? "").trim() !== "")
    out(
      `(${setting.env} is set in this shell, and comes first here: unset ${setting.env} to use the stored value)`,
    );
};

declare namespace set {
  /** stored, and when it applies */
  export type Stores = Given<
    Invoke<typeof setEnv, [name: "DESOLATE_ROOT_MEMORY_MIB", value: null]>,
    Expect<
      Invoke<typeof said, [run: typeof set, args: [name: "workspace.diskGiB", text: "60g"]]>,
      "=",
      [
        "workspace.diskGiB = 60: a workspace made from now on has it (one already made keeps its size: desolate resize).",
      ]
    >
  >;
  /** what its parser does not take is refused, in its own words; so is a name no setting has */
  export type Refuses = [
    Expect<
      Invoke<
        typeof refusalOf,
        [run: typeof set, args: [name: "workspace.diskGiB", text: "10g", out: null]]
      >,
      "=",
      {
        message: "workspace.diskGiB must be a size from 30 to 2048 GiB (as 60 or 60g), not '10g'";
        fix: "desolate settings set workspace.diskGiB <value>";
        code: 64;
      }
    >,
    Expect<
      Invoke<
        typeof refusalOf,
        [run: typeof set, args: [name: "workspace.disk", text: "60", out: null]]
      >,
      "=",
      {
        message: "there is no setting 'workspace.disk'";
        fix: "desolate settings (each setting, and its name)";
        code: 64;
      }
    >,
  ];
}

declare namespace listing {
  /** what the person stored, said as theirs, beside the default */
  export type Stored = Given<
    [
      Invoke<typeof storeText, [text: '{"workspace.diskGiB":{"value":"60","side":"host"}}']>,
      Invoke<typeof setEnv, [name: "DESOLATE_WORKSPACE_DISK_GIB", value: null]>,
    ],
    Expect<
      Invoke<typeof listing, [setting: typeof WORKSPACE_DISK]>,
      "matches",
      { name: "workspace.diskGiB"; side: "host"; value: 60; from: "stored"; default: 30 }
    >
  >;
}

/** What the host passes into a VM of `side`: what the person stored for that side. (Not the
 *  Mac's environment: a variable in the person's shell is for what runs on the Mac.) */
export const inward = (side: Exclude<Setting<unknown>["side"], "host">): Stored =>
  Object.fromEntries(
    Object.entries(storedIn(storeFile("host"))).filter(([, entry]) => entry.side === side),
  );

declare namespace inward {
  /** only that side's */
  export type Sides = Given<
    Invoke<
      typeof storeText,
      [
        text: '{"root.packs":{"value":"4","side":"root"},"workspace.diskGiB":{"value":"60","side":"host"},"git.shells":{"value":"3","side":"git"}}',
      ]
    >,
    Expect<
      Invoke<typeof inward, [side: "root"]>,
      "=",
      { "root.packs": { value: "4"; side: "root" } }
    >
  >;
}

/** A VM's settings, written into it as root (shared/settings.ts INWARD): on its own disk, not
 *  on a share, root's and read by everyone, so neither a workspace nor the root's ordinary
 *  user can change what another VM, or the host, reads. Every time the host starts that VM's
 *  services: what was unset is gone from it then too. */
export const passInward = async (vm: string, side: Exclude<Setting<unknown>["side"], "host">) => {
  const { backend } = await import("./stack.ts");
  const { INWARD } = await import("../shared/settings.ts");
  const dir = path.posix.dirname(INWARD);
  const result = await backend().exec(
    vm,
    [
      "sh",
      "-c",
      `umask 022 && install -d -m 0755 -o root -g root ${dir} && rm -f ${INWARD}.new && cat >${INWARD}.new && chown root:root ${INWARD}.new && chmod 0644 ${INWARD}.new && mv -f ${INWARD}.new ${INWARD}`,
    ],
    { root: true, input: `${JSON.stringify(inward(side), null, 2)}\n`, timeoutMs: 60_000 },
  );
  if (result.code !== 0)
    throw new Refusal(
      `the settings for ${vm} could not be passed into it: ${printable((result.stderr || result.stdout).trim(), 300)}`,
      "desolate doctor",
    );
};

/** A stopped root or git VM given the size its settings say, before it starts: so a size
 *  set with `desolate settings set` is what it has from that start on. */
export const sizeBeforeStart = async (vm: string, role: "root" | "git") => {
  const { backend } = await import("./stack.ts");
  // (Its disk is the base image's, 30 GiB: never grown here, and a disk never shrinks.)
  await backend().resize(vm, { ...vmSize(role), diskGiB: 30 });
};

/** `desolate settings [--json] | set <name> <value> | unset <name>`. */
export const settings = async (argv: string[], json: boolean, out: (line: string) => void) => {
  const [action, name, ...value] = argv;
  if (action === undefined) return list(out, json);
  if (action === "set") return set(name, value.length ? value.join(" ") : undefined, out);
  if (action === "unset") return unset(name, out);
  refuse(
    `'settings ${printable(action, 80)}' is not understood`,
    "desolate settings [--json] | set <name> <value> | unset <name>",
    EXIT.usage,
  );
};
