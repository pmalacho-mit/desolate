// The person's default settings for every workspace's editor, kept on the Mac
// (~/.desolate/state/editor-defaults.json) and given to each editor as its lowest layer
// (workspace/editor-defaults.sh): the editor's own settings, the project's devcontainer and
// the repository's .vscode/settings.json all override them.
//
// Edited with `desolate editor defaults ...`, or on the editor-defaults page, which is the
// Mac's own (approve-web.ts, like the secrets page), not the dashboard's: the dashboard is
// served by the root's ordinary user, which reads what domains send, and a default reaches
// every domain's editor (a terminal profile is a setting).
import * as fs from "node:fs";
import * as path from "node:path";
import { EXIT, refuse } from "../shared/exit.ts";
import { guest, paths } from "./paths.ts";
import { backend, rootctl } from "./stack.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Given, Invoke, Throws } from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { emptyHome, readState, writeState } from "../.harness/home.ts";

const FILE = () => path.join(paths.state, "editor-defaults.json");
/** Before the person sets any: the web editor saves as you type, which v2's editors did not. */
export const BUILT_IN: Record<string, unknown> = { "files.autoSave": "off" };
const MAX = 64 * 1024;
/** A setting's name (`files.autoSave`), or a language's block (`[python]`). */
const KEY = /^(\[[A-Za-z0-9_+.#-]{1,64}\]|[A-Za-z][A-Za-z0-9_.-]{0,127})$/;

/** Settings, checked: an object of at most 64 KiB, each key a setting's name or a language's
 *  block. */
export const checkDefaults = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    refuse("editor defaults are a settings object", '{"files.autoSave": "off"}', EXIT.usage);
  if (JSON.stringify(value).length > MAX)
    refuse("editor defaults of at most 64 KiB", "fewer settings", EXIT.usage);
  for (const key of Object.keys(value))
    if (!KEY.test(key))
      refuse(
        `'${key.slice(0, 80)}' is not a setting's name`,
        '"files.autoSave", or "[python]"',
        EXIT.usage,
      );
  return value as Record<string, unknown>;
};

declare namespace checkDefaults {
  export type Fine = Expect<
    Invoke<
      typeof checkDefaults,
      [value: { "files.autoSave": "off"; "[python]": { "editor.tabSize": 4 } }]
    >,
    "=",
    { "files.autoSave": "off"; "[python]": { "editor.tabSize": 4 } }
  >;
  export type NotObject = Throws<
    Invoke<typeof checkDefaults, [value: ["files.autoSave"]]>,
    "editor defaults are a settings object"
  >;
  export type BadKey = Throws<
    Invoke<typeof checkDefaults, [value: { "files autoSave": "off" }]>,
    "'files autoSave' is not a setting's name"
  >;
}

/** The defaults: the person's, or the built-in ones when they have set none. */
export const editorDefaults = (): Record<string, unknown> => {
  try {
    return checkDefaults(JSON.parse(fs.readFileSync(FILE(), "utf8")));
  } catch {
    return { ...BUILT_IN };
  }
};

declare namespace editorDefaults {
  type Fresh = Invoke<typeof emptyHome>;
  /** none set: autosave off */
  export type BuiltIn = Given<
    [Fresh],
    [Expect<Invoke<typeof editorDefaults>, "=", { "files.autoSave": "off" }>]
  >;
  /** set: the person's, all of them, and nothing else */
  export type Theirs = Given<
    [
      Fresh,
      Invoke<
        typeof writeState,
        [name: "editor-defaults.json", text: '{"workbench.colorTheme": "Dark+"}']
      >,
    ],
    [Expect<Invoke<typeof editorDefaults>, "=", { "workbench.colorTheme": "Dark+" }>]
  >;
}

/** Kept, for the next editor that starts. */
export const saveDefaults = (settings: Record<string, unknown>) => {
  const checked = checkDefaults(settings);
  fs.mkdirSync(path.dirname(FILE()), { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${FILE()}.tmp`, `${JSON.stringify(checked, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(`${FILE()}.tmp`, FILE());
  return checked;
};

declare namespace saveDefaults {
  type Fresh = Invoke<typeof emptyHome>;
  export type Saved = Given<
    [
      Fresh,
      Invoke<
        typeof saveDefaults,
        [settings: { "workbench.colorTheme": "Dark+"; "files.autoSave": "off" }]
      >,
    ],
    [
      Expect<
        Invoke<typeof readState, [name: "editor-defaults.json"]>,
        "=",
        '{\n  "workbench.colorTheme": "Dark+",\n  "files.autoSave": "off"\n}\n'
      >,
    ]
  >;
}

/** One workspace's editor gets the defaults. Never fails its caller: an editor without its
 *  defaults is still an editor. What happened, in a word. */
export const applyTo = async (vm: string): Promise<string> => {
  try {
    const done = await backend().exec(
      vm,
      ["bash", `${guest.release}/workspace/editor-defaults.sh`],
      {
        input: JSON.stringify(editorDefaults()),
        timeoutMs: 120_000,
      },
    );
    return done.code === 0
      ? "applied"
      : `not applied: ${(done.stderr || done.stdout).trim().slice(-200)}`;
  } catch (error) {
    return `not applied: ${(error as Error).message.slice(0, 200)}`;
  }
};

/** Every running workspace's editor, now (after the defaults change). How many took them. */
export const applyAll = async (): Promise<{ running: number; applied: number }> => {
  const b = backend();
  const running = new Set(
    (await b.list()).filter((vm) => vm.status === "running").map((vm) => vm.name),
  );
  const { isOwnVm } = await import("./workspaces.ts");
  let count = 0;
  let applied = 0;
  for (const d of await rootctl<
    { slug: string; workspaces: { vm: string; workspace: string; domain?: string }[] }[]
  >("domain.list", {}, { quiet: true }))
    for (const w of d.workspaces)
      if (running.has(w.vm) && isOwnVm(d.slug, w)) {
        count++;
        if ((await applyTo(w.vm)) === "applied") applied++;
      }
  return { running: count, applied };
};

/** Saved, and given to every running editor. */
export const setDefaults = async (settings: Record<string, unknown>) => {
  const saved = saveDefaults(settings);
  return { settings: saved, ...(await applyAll()) };
};

/** `set <key> <value>`: a value that reads as JSON is that (`14`, `true`, `["a"]`), anything
 *  else is a string (`Dark+`, `off`). */
export const valueOf = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

declare namespace valueOf {
  export type Number = Expect<Invoke<typeof valueOf, [text: "14"]>, "=", 14>;
  export type Word = Expect<Invoke<typeof valueOf, [text: "Dark+"]>, "=", "Dark+">;
  export type Quoted = Expect<Invoke<typeof valueOf, [text: '"off"']>, "=", "off">;
}
