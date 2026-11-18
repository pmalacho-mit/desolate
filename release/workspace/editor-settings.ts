// The editor's machine settings that desolate holds: put back at every start, whatever was
// written since (v2's editor-settings.ts, for the workspace's own editor). Everything else
// in the file is the person's.
//
//   node editor-settings.ts <Machine/settings.json> [enter|plain]
//
// "enter": the editor's server runs in the VM, so its terminal goes through enter.sh, which
// enters the project's devcontainer when there is one. "plain": the server runs in the
// devcontainer itself, and its terminal is the container's own shell.
import * as fs from "node:fs";
import * as path from "node:path";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Invoke } from "../../suede.nests/dsl.import.meta.vitest.ts";

export const HELD: Record<string, unknown> = {
  // The workspace VM is the boundary (P1): everything in it is as trusted as anything else
  // in it, so the editor does not ask. The server runs with --disable-workspace-trust too.
  "security.workspace.trust.enabled": false,
  // Nothing updates itself behind the person's back; extensions come from Open VSX through
  // the domain's proxy, when asked for.
  "extensions.autoCheckUpdates": false,
  "extensions.autoUpdate": false,
  "update.mode": "none",
  "telemetry.telemetryLevel": "off",
  "terminal.integrated.macOptionClickForcesSelection": true,
};

const TERMINAL = {
  "terminal.integrated.profiles.linux": {
    desolate: {
      path: "/desolate/release/workspace/enter.sh",
      args: ["--here", "--", "bash", "-l"],
    },
  },
  "terminal.integrated.defaultProfile.linux": "desolate",
};

/** The Machine settings file again: what was in it, the project's own settings over that
 *  (`project`: its devcontainer's customizations.vscode.settings, as VS Code's Dev Containers
 *  puts them here), the terminal, and desolate's held settings over everything. A key the
 *  project set last time (`before`) and no longer sets is taken away, unless it was changed
 *  since: then it is the person's. (The person's defaults for every editor are a layer below
 *  all of this: editor-defaults.sh.) */
export const hold = (
  text: string | undefined,
  terminal: "enter" | "plain" | undefined = undefined,
  project: Record<string, unknown> = {},
  before: Record<string, unknown> = {},
): string => {
  let settings: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text ?? "{}");
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
      settings = parsed as Record<string, unknown>;
  } catch {
    // Unreadable (hand-edited into something that is not JSON): start again from what is held.
  }
  for (const [key, value] of Object.entries(before))
    if (!(key in project) && JSON.stringify(settings[key]) === JSON.stringify(value))
      delete settings[key];
  Object.assign(settings, project);
  if (terminal === "enter") Object.assign(settings, TERMINAL);
  // Only what desolate put there is taken away: a profile of the person's own stays.
  if (terminal === "plain" && settings["terminal.integrated.defaultProfile.linux"] === "desolate")
    for (const key of Object.keys(TERMINAL)) delete settings[key];
  return JSON.stringify({ ...settings, ...HELD }, null, 2) + "\n";
};

// Read back with JSON.parse: the file is JSON, and what matters is what it says.
declare namespace hold {
  /** a new editor: what desolate holds, and nothing else */
  export type Fresh = Expect<
    Invoke<typeof JSON.parse, [text: Invoke<typeof hold, [text: undefined]>]>,
    "=",
    {
      "security.workspace.trust.enabled": false;
      "extensions.autoCheckUpdates": false;
      "extensions.autoUpdate": false;
      "update.mode": "none";
      "telemetry.telemetryLevel": "off";
      "terminal.integrated.macOptionClickForcesSelection": true;
    }
  >;
  /** the person's settings stay; one of desolate's they changed is put back */
  export type PutBack = Expect<
    Invoke<
      typeof JSON.parse,
      [
        text: Invoke<
          typeof hold,
          [
            text: '{"editor.fontSize": 15, "telemetry.telemetryLevel": "all", "update.mode": "default"}',
          ]
        >,
      ]
    >,
    "=",
    {
      "editor.fontSize": 15;
      "security.workspace.trust.enabled": false;
      "extensions.autoCheckUpdates": false;
      "extensions.autoUpdate": false;
      "update.mode": "none";
      "telemetry.telemetryLevel": "off";
      "terminal.integrated.macOptionClickForcesSelection": true;
    }
  >;
  /** a file hand-edited into something that is not a settings object starts again from what
   *  is held, rather than failing the editor's start */
  export type Unreadable = [
    Expect<
      Invoke<typeof JSON.parse, [text: Invoke<typeof hold, [text: '{"editor.fontSize": 15,']>]>,
      "=",
      {
        "security.workspace.trust.enabled": false;
        "extensions.autoCheckUpdates": false;
        "extensions.autoUpdate": false;
        "update.mode": "none";
        "telemetry.telemetryLevel": "off";
        "terminal.integrated.macOptionClickForcesSelection": true;
      }
    >,
    Expect<
      Invoke<typeof JSON.parse, [text: Invoke<typeof hold, [text: "[15]"]>]>,
      "=",
      {
        "security.workspace.trust.enabled": false;
        "extensions.autoCheckUpdates": false;
        "extensions.autoUpdate": false;
        "update.mode": "none";
        "telemetry.telemetryLevel": "off";
        "terminal.integrated.macOptionClickForcesSelection": true;
      }
    >,
  ];
  /** the project's own settings (its devcontainer's) over the person's; desolate's held ones
   *  over the project's */
  export type Project = Expect<
    Invoke<
      typeof JSON.parse,
      [
        text: Invoke<
          typeof hold,
          [
            text: '{"files.autoSave": "off", "editor.fontSize": 15}',
            terminal: undefined,
            project: { "files.autoSave": "afterDelay"; "update.mode": "default" },
          ]
        >,
      ]
    >,
    "matches",
    { "files.autoSave": "afterDelay"; "editor.fontSize": 15; "update.mode": "none" }
  >;
  /** a key the project no longer sets goes; one the person changed since stays theirs */
  export type ProjectDropped = Expect<
    Invoke<
      typeof JSON.parse,
      [
        text: Invoke<
          typeof hold,
          [
            text: '{"files.autoSave": "afterDelay", "editor.tabSize": 8}',
            terminal: undefined,
            project: {},
            before: { "files.autoSave": "afterDelay"; "editor.tabSize": 2 },
          ]
        >,
      ]
    >,
    "=",
    {
      "editor.tabSize": 8;
      "security.workspace.trust.enabled": false;
      "extensions.autoCheckUpdates": false;
      "extensions.autoUpdate": false;
      "update.mode": "none";
      "telemetry.telemetryLevel": "off";
      "terminal.integrated.macOptionClickForcesSelection": true;
    }
  >;
  /** "enter": the editor's server is in the VM, so its terminals enter the devcontainer */
  export type Enter = Expect<
    Invoke<typeof JSON.parse, [text: Invoke<typeof hold, [text: "{}", terminal: "enter"]>]>,
    "matches",
    {
      "terminal.integrated.profiles.linux": {
        desolate: {
          path: "/desolate/release/workspace/enter.sh";
          args: ["--here", "--", "bash", "-l"];
        };
      };
      "terminal.integrated.defaultProfile.linux": "desolate";
    }
  >;
  /** "plain": the server is in the container, and desolate's terminal profile goes, but only
   *  when it is desolate's: a default profile of the person's own is theirs */
  export type Plain = [
    Expect<
      Invoke<
        typeof JSON.parse,
        [
          text: Invoke<
            typeof hold,
            [
              text: '{"terminal.integrated.profiles.linux": {"desolate": {}}, "terminal.integrated.defaultProfile.linux": "desolate"}',
              terminal: "plain",
            ]
          >,
        ]
      >,
      "=",
      {
        "security.workspace.trust.enabled": false;
        "extensions.autoCheckUpdates": false;
        "extensions.autoUpdate": false;
        "update.mode": "none";
        "telemetry.telemetryLevel": "off";
        "terminal.integrated.macOptionClickForcesSelection": true;
      }
    >,
    Expect<
      Invoke<
        typeof JSON.parse,
        [
          text: Invoke<
            typeof hold,
            [text: '{"terminal.integrated.defaultProfile.linux": "zsh"}', terminal: "plain"]
          >,
        ]
      >,
      "=",
      {
        "terminal.integrated.defaultProfile.linux": "zsh";
        "security.workspace.trust.enabled": false;
        "extensions.autoCheckUpdates": false;
        "extensions.autoUpdate": false;
        "update.mode": "none";
        "telemetry.telemetryLevel": "off";
        "terminal.integrated.macOptionClickForcesSelection": true;
      }
    >,
  ];
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: editor-settings.ts <settings.json>");
    process.exit(2);
  }
  let text: string | undefined;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    text = undefined;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const terminal =
    process.argv[3] === "enter" || process.argv[3] === "plain" ? process.argv[3] : undefined;
  // The project's settings: from the devcontainer's state (devcontainer.ts settingsOf), when
  // it is up; and what it set last time, kept beside the settings file.
  const read = (where: string | undefined): Record<string, unknown> => {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(where ?? "", "utf8"));
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  };
  const state = read(process.argv[4]);
  const project =
    state.state === "up" && typeof state.settings === "object" && state.settings !== null
      ? (state.settings as Record<string, unknown>)
      : {};
  const kept = path.join(path.dirname(file), "project-settings.json");
  fs.writeFileSync(`${file}.desolate-tmp`, hold(text, terminal, project, read(kept)), {
    mode: 0o600,
  });
  fs.renameSync(`${file}.desolate-tmp`, file);
  fs.writeFileSync(kept, `${JSON.stringify(project)}\n`, { mode: 0o600 });
}
