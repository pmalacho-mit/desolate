// The project's devcontainer, inside this workspace's VM (section 4.2, shape A).
//
//   node devcontainer.ts <workspace>      as the workspace's user, after init.ts
//
// The devcontainer CLI runs HERE, against the checkout's own devcontainer.json, with the
// VM's own dockerd. Whatever the spec asks for (privileged, mounts, a Dockerfile, features,
// compose, lifecycle commands) happens inside this VM, so there is no spec policy as v2
// had: the VM is the boundary, and nothing in a spec reaches the VM's shares, link or
// forwarded ports, which are decided outside it (P5).
//
// What desolate adds to the spec, through --override-config (which changes the JSON the
// CLI parses and nothing else: relative paths still resolve beside the project's own file;
// measured in v2 on this CLI version):
//   - /workspaces mounted at /workspaces, and the checkout's own path as the folder: a
//     domain clone borrows the mirror's objects and its worktrees name each other by
//     absolute path, so git works in the container only if paths are the VM's;
//   - the VM's network (--network=host), for a single-container spec: the container's
//     traffic takes the VM's one way out with nothing more to arrange, and a dev server
//     in it is a listener in the VM, which is what the host's forwarder publishes;
//   - the mirrors (read-only), the inbox (read-only), the outbox, desolate's own CLI and
//     status script, the editor's server (read-only), and the trust store that holds the
//     domain's CA.
// A compose spec gets the same, in its primary service (`service`), with two differences:
//   - its network stays its own: the services find each other by name. Instead svcnet.ts
//     runs in the primary service, and the VM's wsd mirrors each of its listeners, and each
//     `forwardPorts` entry written `service:port`, onto the VM's loopback (bridge.ts). The
//     host then forwards them like a single container's; what a service publishes
//     (`ports:`) is docker's own listener in the VM and needs nothing;
//   - the VM's /workspaces is mounted over whatever the project's compose file mounts at
//     /workspaces (compose merges a service's volumes by target), and the folder is the
//     checkout's own path: the domain's worktrees name their .git by the VM's absolute
//     path, so git works in the service only on the VM's paths. A project mount elsewhere
//     (`..:/src`) is kept beside it. The other services get nothing of desolate's.
//
// The environment is the first checkout that has a spec (section 4.5, way 1). It is not
// frozen and its features are not pinned to digests yet.
//
// This never fails the workspace. With no spec, or a spec that does not come up, the
// workspace is the VM itself, and /run/desolate/devcontainer.json says which and why.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { readJson, writeJson } from "../shared/json.ts";
import { parse as parseJsonc } from "../shared/jsonc.ts";
import { over, PORTS } from "../shared/limits.ts";
import { devHostname } from "../shared/names.ts";
import type { WorkspacePlan } from "../shared/plan.ts";
import { run, sleep } from "../shared/run.ts";
import { printable } from "../shared/text.ts";
import { urlRules } from "./git-urls.ts";
import { requester, saying } from "../shared/step.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Invoke, Table } from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { projectWith, specWithSettingsOf } from "../.harness/workspace-files.ts";

export const STATE = "/run/desolate/devcontainer.json";
export type State =
  | { state: "none"; why: string }
  | { state: "failed"; why: string; config: string }
  | {
      state: "up";
      containerId: string;
      remoteUser: string;
      folder: string;
      config: string;
      override: string;
      checkout: string;
      hostNetwork: boolean;
      glibc: boolean;
      compose: boolean;
      extensions: string[];
      /** customizations.vscode.settings (settingsOf), for the editor's Machine settings */
      settings?: Record<string, unknown>;
      image: string;
      note?: string;
      /** compose: svcnet.ts's socket in the primary service, when it answers (bridge.ts) */
      bridge?: string;
      /** compose: `forwardPorts` entries naming another service, for bridge.ts */
      forwards?: { port: number; host: string }[];
    };

/** svcnet.ts's socket: in /run/desolate, which the primary service shares with the VM. */
export const SVCNET = "/run/desolate/svcnet.sock";

export const locate = (dir: string): string | undefined => {
  const nested = path.join(dir, ".devcontainer", "devcontainer.json");
  const flat = path.join(dir, ".devcontainer.json");
  return fs.existsSync(nested) ? nested : fs.existsSync(flat) ? flat : undefined;
};

declare namespace locate {
  /** the two places the spec may be, the folder's first; nowhere else */
  export type Nested = Expect<
    Invoke<
      typeof locate,
      [
        dir: Invoke<
          typeof projectWith,
          [files: [".devcontainer/devcontainer.json", ".devcontainer.json"]]
        >,
      ]
    >,
    "endsWith",
    "/.devcontainer/devcontainer.json"
  >;
  export type Flat = Expect<
    Invoke<typeof locate, [dir: Invoke<typeof projectWith, [files: [".devcontainer.json"]]>]>,
    "endsWith",
    "/.devcontainer.json"
  >;
  /** a spec in a subfolder of .devcontainer (one of several configurations) is not looked for:
   *  the workspace is then the VM itself */
  export type None = Expect<
    Invoke<
      typeof locate,
      [
        dir: Invoke<
          typeof projectWith,
          [files: [".devcontainer/python/devcontainer.json", "devcontainer.json"]]
        >,
      ]
    >,
    "=",
    undefined
  >;
}

/** The most of a project's editor settings the state holds, in bytes of JSON. They are
 *  repository content, kept in the devcontainer's state, and that file is read whole by
 *  everything that asks about the devcontainer: the workspace's daemon every few seconds, its
 *  port bridge every second, the editor's start. 64 KiB is many times a settings file a
 *  person wrote (VS Code's own defaults, all of them, are about that), and little to read
 *  that often. */
const SETTINGS_BYTES = 64 * 1024;

/** customizations.vscode.settings as the spec has them: an object, or nothing. */
const settingsIn = (spec: Record<string, unknown>): Record<string, unknown> | undefined => {
  const vscode = (spec.customizations as { vscode?: { settings?: unknown } } | undefined)?.vscode;
  const settings = vscode?.settings;
  return typeof settings !== "object" || settings === null || Array.isArray(settings)
    ? undefined
    : (settings as Record<string, unknown>);
};
const settingsBytes = (settings: Record<string, unknown>) =>
  Buffer.byteLength(JSON.stringify(settings));

/** customizations.vscode.settings: the project's own editor settings, which the editor's
 *  Machine settings take (editor-settings.ts), as VS Code's Dev Containers does. An object of
 *  at most SETTINGS_BYTES as JSON, or nothing (`settingsLeftOut` then says so). */
export const settingsOf = (spec: Record<string, unknown>): Record<string, unknown> | undefined => {
  const settings = settingsIn(spec);
  return settings && settingsBytes(settings) <= SETTINGS_BYTES ? settings : undefined;
};

/** What the devcontainer's note says of settings that were too large to take, or null. */
export const settingsLeftOut = (spec: Record<string, unknown>): string | null => {
  const settings = settingsIn(spec);
  return settings && settingsBytes(settings) > SETTINGS_BYTES
    ? `${over("its customizations.vscode.settings", SETTINGS_BYTES, settingsBytes(settings), "bytes", "desolate gives the editor")}, so the editor has none of them`
    : null;
};

declare namespace settingsOf {
  export type Given = Expect<
    Invoke<
      typeof settingsOf,
      [spec: { customizations: { vscode: { settings: { "files.autoSave": "afterDelay" } } } }]
    >,
    "=",
    { "files.autoSave": "afterDelay" }
  >;
  export type None = Expect<
    Invoke<typeof settingsOf, [spec: { customizations: { vscode: { settings: ["no"] } } }]>,
    "=",
    undefined
  >;
}

declare namespace settingsLeftOut {
  /** settings that are taken, and a spec with none: nothing to say */
  export type Taken = Table<
    typeof settingsLeftOut,
    [
      [
        args: [spec: { customizations: { vscode: { settings: { "files.autoSave": "off" } } } }],
        expected: null,
      ],
      [args: [spec: { image: "node:22" }], expected: null],
    ]
  >;
  /** settings over the bound are not taken, and the note says so, with both sizes */
  export type TooLarge = Expect<
    Invoke<typeof settingsLeftOut, [spec: Invoke<typeof specWithSettingsOf, [bytes: 200000]>]>,
    "=",
    "its customizations.vscode.settings is 195 KiB, over the 64 KiB desolate gives the editor, so the editor has none of them"
  >;
}

const EXTENSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*\.[A-Za-z0-9][A-Za-z0-9._-]*(@[A-Za-z0-9._-]+)?$/;
/** customizations.vscode.extensions (and any other editor's namespace), valid ids only. */
export const extensionsOf = (spec: Record<string, unknown>): string[] => {
  const ids = new Set<string>();
  const customizations = spec.customizations;
  if (typeof customizations === "object" && customizations !== null)
    for (const namespace of Object.values(customizations as Record<string, unknown>)) {
      const list = (namespace as { extensions?: unknown } | null)?.extensions;
      for (const id of Array.isArray(list) ? list : [])
        if (typeof id === "string" && EXTENSION_ID.test(id)) ids.add(id);
    }
  return [...ids];
};

declare namespace extensionsOf {
  /** the editor's extensions, from every editor's namespace, each once */
  export type Lists = Table<
    typeof extensionsOf,
    [
      [
        args: [
          spec: {
            customizations: {
              vscode: { extensions: ["dbaeumer.vscode-eslint", "esbenp.prettier-vscode@10.1.0"] };
            };
          },
        ],
        expected: ["dbaeumer.vscode-eslint", "esbenp.prettier-vscode@10.1.0"],
      ],
      [
        args: [
          spec: {
            customizations: {
              vscode: { extensions: ["ms-python.python"] };
              codespaces: { extensions: ["ms-python.python", "golang.go"] };
            };
          },
        ],
        expected: ["ms-python.python", "golang.go"],
      ],
      [args: [spec: { image: "node:22" }], expected: []],
      [
        args: [
          spec: { customizations: { vscode: { extensions: "ms-python.python" }; jetbrains: null } },
        ],
        expected: [],
      ],
    ]
  >;
  /** the spec is the project's, and the ids go to the editor's installer: only
   *  `publisher.name[@version]`, never a path, a flag or a second word */
  export type Refuses = Table<
    typeof extensionsOf,
    [
      [
        args: [
          spec: {
            customizations: {
              vscode: {
                extensions: [
                  "eslint",
                  "-x.y",
                  "../x.y",
                  "/tmp/x.vsix",
                  "a.b c",
                  "a.b@",
                  "a.b;id",
                  42,
                ];
              };
            };
          },
        ],
        expected: [],
      ],
    ]
  >;
}

const ENV_CA = "/desolate/ca/ca-certificates.crt";
/** Where package managers keep their downloads, in the domain's cache (section 4.7, C4):
 *  what one workspace of a domain fetched, the next finds. Only download caches, never where
 *  a tool installs itself (CARGO_HOME, GOPATH's bin): those belong to the image. */
export const CACHE_ENV: Record<string, string> = {
  npm_config_cache: "/desolate/cache/npm",
  npm_config_store_dir: "/desolate/cache/pnpm",
  YARN_CACHE_FOLDER: "/desolate/cache/yarn",
  PIP_CACHE_DIR: "/desolate/cache/pip",
  UV_CACHE_DIR: "/desolate/cache/uv",
  GOMODCACHE: "/desolate/cache/go-mod",
};
/** A spec's run arguments less the ones that choose a network, in each spelling docker reads:
 *  `--network=x` and `--net=x`, and `--network x` and `--net x`, whose value is the next
 *  word. Kept, that word was read by docker run as the image (`--network bridge` left
 *  `bridge`). */
const withoutNetwork = (args: unknown[]): unknown[] => {
  const kept: unknown[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (typeof arg === "string" && /^--net(work)?$/.test(arg)) i++;
    else if (typeof arg !== "string" || !/^--net(work)?=/.test(arg)) kept.push(arg);
  }
  return kept;
};

declare namespace withoutNetwork {
  /** both spellings of both names go, a two-word one with its value */
  export type Network = Table<
    typeof withoutNetwork,
    [
      [args: [args: ["--network", "bridge", "--privileged"]], expected: ["--privileged"]],
      [args: [args: ["--net", "none", "--cap-add=SYS_PTRACE"]], expected: ["--cap-add=SYS_PTRACE"]],
      [args: [args: ["--network=bridge", "--net=container:db"]], expected: []],
      /** at the end, with no value after it; and before a flag, which docker reads as its value */
      [args: [args: ["--privileged", "--network"]], expected: ["--privileged"]],
      [args: [args: ["--net", "--privileged", "--init"]], expected: ["--init"]],
    ]
  >;
  /** controls: flags that only start alike, and words that are not flags, are the project's */
  export type Keeps = Table<
    typeof withoutNetwork,
    [
      [
        args: [args: ["--network-alias", "api", "--netns-x", "-e", "NETWORK=bridge", 42]],
        expected: ["--network-alias", "api", "--netns-x", "-e", "NETWORK=bridge", 42],
      ],
      [args: [args: []], expected: []],
    ]
  >;
}

/** The spec desolate hands the CLI: the project's, plus what the header lists. */
export const overrideOf = (
  spec: Record<string, unknown>,
  checkout: string,
  home: string,
  who: { domain: string; workspace: string; devHostname?: string; cache?: boolean } = {
    domain: "",
    workspace: "",
  },
): Record<string, unknown> => {
  // The domain's cache is a share a VM gets when it is made: one made by an older desolate has
  // none, and a bind of a missing path failed the container on every start after an upgrade
  // ("bind source path does not exist: /desolate/cache", two workspaces on the M1).
  const cache = who.cache !== false;
  const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
  const env = (value: unknown): Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const compose = spec.dockerComposeFile !== undefined;
  // For compose, the CLI writes each mount into its override file as `source:target` and
  // drops every other option, `readonly` among them (read in CLI 0.88.0), so the mode rides
  // in the target, which it copies as it is: `source:target:ro` is compose's own syntax.
  const bind = (source: string, target: string, readonly = false) =>
    compose
      ? `source=${source},target=${target}${readonly ? ":ro" : ""},type=bind`
      : `source=${source},target=${target},type=bind${readonly ? ",readonly" : ""}`;
  const ours = [
    bind("/desolate/mirrors", "/desolate/mirrors", true),
    bind("/desolate/inbox", "/desolate/inbox", true),
    bind("/desolate/outbox", "/desolate/outbox"),
    bind("/desolate/release", "/desolate/release", true),
    bind("/run/desolate", "/run/desolate"),
    bind("/opt/desolate/editor", "/opt/desolate/editor", true),
    bind(`${home}/.desolate-editor`, "/desolate/editor-data"),
    bind("/etc/ssl/certs", "/desolate/ca", true),
    bind("/usr/local/bin/node", "/desolate/bin/node", true),
    // Each runs the release's script of its own name, through one file that never changes:
    // a bind of a single file from the release share goes stale when an upgrade replaces
    // that file (workspace/entry says how).
    ...[
      "/usr/local/bin/desolate",
      "/usr/local/bin/git-remote-desolate-offer",
      "/usr/local/bin/git-remote-desolate-mirror",
      "/desolate/status",
    ].map((target) => bind("/desolate/release/workspace/entry", target, true)),
    ...(cache ? [bind("/desolate/cache", "/desolate/cache")] : []),
    // The VM's own disk, at the same path (start.sh): binds for docker-outside-of-docker.
    bind("/desolate/scratch", "/desolate/scratch"),
  ];
  const containerEnv = {
    // git in the container: the mirror and the checkouts are owned by the VM's user, which
    // may not be the container's.
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "safe.directory",
    GIT_CONFIG_VALUE_0: "*",
    // The domain's CA (for its secrets' hosts) is in the VM's bundle; tools that take
    // their roots from the environment are pointed at it.
    SSL_CERT_FILE: ENV_CA,
    NODE_EXTRA_CA_CERTS: ENV_CA,
    REQUESTS_CA_BUNDLE: ENV_CA,
    CURL_CA_BUNDLE: ENV_CA,
    GIT_SSL_CAINFO: ENV_CA,
    DESOLATE_WORKSPACE: "1",
    // Which workspace this is, for `desolate offer` and the rest inside the container (the
    // VM's ~/.desolate/workspace.json is not in the container's home).
    DESOLATE_DOMAIN: who.domain,
    DESOLATE_WORKSPACE_NAME: who.workspace,
    // Its dev name, which the host routes here with every name under it: what a desolate
    // stack run in this workspace takes as its DESOLATE_HOSTNAME_SUFFIX (shared/names.ts).
    ...(who.devHostname ? { DESOLATE_DEV_HOSTNAME: who.devHostname } : {}),
    // The domain's package caches (C4), where the container can see them.
    ...(cache ? CACHE_ENV : {}),
    ...env(spec.containerEnv),
  };
  if (compose)
    return {
      ...spec,
      workspaceFolder: checkout,
      mounts: [...list(spec.mounts), ...ours, bind("/workspaces", "/workspaces")],
      containerEnv,
    };
  return {
    ...spec,
    workspaceMount: bind("/workspaces", "/workspaces"),
    workspaceFolder: checkout,
    mounts: [...list(spec.mounts), ...ours],
    runArgs: [...withoutNetwork(list(spec.runArgs)), "--network=host"],
    containerEnv,
  };
};

declare namespace overrideOf {
  /** a single-container spec: the project's, with the VM's paths, the VM's network, and
   *  desolate's shares, tools and environment added */
  export type SingleContainer = Expect<
    Invoke<
      typeof overrideOf,
      [
        spec: { image: "node:22" },
        checkout: "/workspaces/acme/app",
        home: "/home/acme",
        who: { domain: "acme"; workspace: "w1"; devHostname: "acme-w1-0a1b2c.localhost" },
      ]
    >,
    "=",
    {
      image: "node:22";
      workspaceMount: "source=/workspaces,target=/workspaces,type=bind";
      workspaceFolder: "/workspaces/acme/app";
      mounts: [
        "source=/desolate/mirrors,target=/desolate/mirrors,type=bind,readonly",
        "source=/desolate/inbox,target=/desolate/inbox,type=bind,readonly",
        "source=/desolate/outbox,target=/desolate/outbox,type=bind",
        "source=/desolate/release,target=/desolate/release,type=bind,readonly",
        "source=/run/desolate,target=/run/desolate,type=bind",
        "source=/opt/desolate/editor,target=/opt/desolate/editor,type=bind,readonly",
        "source=/home/acme/.desolate-editor,target=/desolate/editor-data,type=bind",
        "source=/etc/ssl/certs,target=/desolate/ca,type=bind,readonly",
        "source=/usr/local/bin/node,target=/desolate/bin/node,type=bind,readonly",
        "source=/desolate/release/workspace/entry,target=/usr/local/bin/desolate,type=bind,readonly",
        "source=/desolate/release/workspace/entry,target=/usr/local/bin/git-remote-desolate-offer,type=bind,readonly",
        "source=/desolate/release/workspace/entry,target=/usr/local/bin/git-remote-desolate-mirror,type=bind,readonly",
        "source=/desolate/release/workspace/entry,target=/desolate/status,type=bind,readonly",
        "source=/desolate/cache,target=/desolate/cache,type=bind",
        "source=/desolate/scratch,target=/desolate/scratch,type=bind",
      ];
      runArgs: ["--network=host"];
      containerEnv: {
        GIT_CONFIG_COUNT: "1";
        GIT_CONFIG_KEY_0: "safe.directory";
        GIT_CONFIG_VALUE_0: "*";
        SSL_CERT_FILE: "/desolate/ca/ca-certificates.crt";
        NODE_EXTRA_CA_CERTS: "/desolate/ca/ca-certificates.crt";
        REQUESTS_CA_BUNDLE: "/desolate/ca/ca-certificates.crt";
        CURL_CA_BUNDLE: "/desolate/ca/ca-certificates.crt";
        GIT_SSL_CAINFO: "/desolate/ca/ca-certificates.crt";
        DESOLATE_WORKSPACE: "1";
        DESOLATE_DOMAIN: "acme";
        DESOLATE_WORKSPACE_NAME: "w1";
        DESOLATE_DEV_HOSTNAME: "acme-w1-0a1b2c.localhost";
        npm_config_cache: "/desolate/cache/npm";
        npm_config_store_dir: "/desolate/cache/pnpm";
        YARN_CACHE_FOLDER: "/desolate/cache/yarn";
        PIP_CACHE_DIR: "/desolate/cache/pip";
        UV_CACHE_DIR: "/desolate/cache/uv";
        GOMODCACHE: "/desolate/cache/go-mod";
      };
    }
  >;

  /** the project's own run arguments are kept, except the ones that choose a network: the
   *  container is on the VM's, the only way out the VM has */
  export type NetworkIsTheVms = Expect<
    Invoke<
      typeof overrideOf,
      [
        spec: {
          image: "node:22";
          runArgs: [
            "--privileged",
            "--network=bridge",
            "--net=none",
            "--cap-add=SYS_PTRACE",
            "--network",
          ];
        },
        checkout: "/workspaces/acme/app",
        home: "/home/acme",
      ]
    >,
    "matches",
    { runArgs: ["--privileged", "--cap-add=SYS_PTRACE", "--network=host"] }
  >;
  /** a network named as two words goes with its value: docker run would read a value left
   *  behind as the image */
  export type NetworkAsTwoWords = Expect<
    Invoke<
      typeof overrideOf,
      [
        spec: { image: "node:22"; runArgs: ["--network", "bridge", "--privileged"] },
        checkout: "/workspaces/acme/app",
        home: "/home/acme",
      ]
    >,
    "matches",
    { runArgs: ["--privileged", "--network=host"] }
  >;

  /** where the project and desolate both say something: the workspace's folder and mount are
   *  the VM's (git works only on its paths), and the project's environment wins over
   *  desolate's defaults, which are only defaults */
  export type ProjectAndDesolate = Expect<
    Invoke<
      typeof overrideOf,
      [
        spec: {
          image: "node:22";
          workspaceMount: "source=${localWorkspaceFolder},target=/src,type=bind";
          workspaceFolder: "/src";
          containerEnv: { NODE_ENV: "development"; SSL_CERT_FILE: "/etc/ssl/project.pem" };
        },
        checkout: "/workspaces/acme/app",
        home: "/home/acme",
      ]
    >,
    "matches",
    {
      workspaceMount: "source=/workspaces,target=/workspaces,type=bind";
      workspaceFolder: "/workspaces/acme/app";
      containerEnv: {
        NODE_ENV: "development";
        SSL_CERT_FILE: "/etc/ssl/project.pem";
        NODE_EXTRA_CA_CERTS: "/desolate/ca/ca-certificates.crt";
        DESOLATE_WORKSPACE: "1";
      };
    }
  >;

  /** a compose spec: the same shares in its primary service, read-only written in the target
   *  (the CLI drops every other option), the project's own mounts first and /workspaces last,
   *  so it is mounted over whatever the compose file puts there. Its network stays its own.
   *  A VM made before the domain's cache existed gets no cache mount and no cache variables */
  export type Compose = Expect<
    Invoke<
      typeof overrideOf,
      [
        spec: {
          dockerComposeFile: "compose.yml";
          service: "app";
          mounts: ["source=..,target=/src,type=bind"];
        },
        checkout: "/workspaces/acme/app",
        home: "/home/acme",
        who: { domain: "acme"; workspace: "w1"; cache: false },
      ]
    >,
    "=",
    {
      dockerComposeFile: "compose.yml";
      service: "app";
      workspaceFolder: "/workspaces/acme/app";
      mounts: [
        "source=..,target=/src,type=bind",
        "source=/desolate/mirrors,target=/desolate/mirrors:ro,type=bind",
        "source=/desolate/inbox,target=/desolate/inbox:ro,type=bind",
        "source=/desolate/outbox,target=/desolate/outbox,type=bind",
        "source=/desolate/release,target=/desolate/release:ro,type=bind",
        "source=/run/desolate,target=/run/desolate,type=bind",
        "source=/opt/desolate/editor,target=/opt/desolate/editor:ro,type=bind",
        "source=/home/acme/.desolate-editor,target=/desolate/editor-data,type=bind",
        "source=/etc/ssl/certs,target=/desolate/ca:ro,type=bind",
        "source=/usr/local/bin/node,target=/desolate/bin/node:ro,type=bind",
        "source=/desolate/release/workspace/entry,target=/usr/local/bin/desolate:ro,type=bind",
        "source=/desolate/release/workspace/entry,target=/usr/local/bin/git-remote-desolate-offer:ro,type=bind",
        "source=/desolate/release/workspace/entry,target=/usr/local/bin/git-remote-desolate-mirror:ro,type=bind",
        "source=/desolate/release/workspace/entry,target=/desolate/status:ro,type=bind",
        "source=/desolate/scratch,target=/desolate/scratch,type=bind",
        "source=/workspaces,target=/workspaces,type=bind",
      ];
      containerEnv: {
        GIT_CONFIG_COUNT: "1";
        GIT_CONFIG_KEY_0: "safe.directory";
        GIT_CONFIG_VALUE_0: "*";
        SSL_CERT_FILE: "/desolate/ca/ca-certificates.crt";
        NODE_EXTRA_CA_CERTS: "/desolate/ca/ca-certificates.crt";
        REQUESTS_CA_BUNDLE: "/desolate/ca/ca-certificates.crt";
        CURL_CA_BUNDLE: "/desolate/ca/ca-certificates.crt";
        GIT_SSL_CAINFO: "/desolate/ca/ca-certificates.crt";
        DESOLATE_WORKSPACE: "1";
        DESOLATE_DOMAIN: "acme";
        DESOLATE_WORKSPACE_NAME: "w1";
      };
    }
  >;
}

/** One `forwardPorts` entry, read: another compose service's port to carry (`forward`), an
 *  entry that cannot be carried, with why (`leftOut`), or one that needs nothing (null: a
 *  bare number, or the primary service's own name, whose every listener is mirrored
 *  already). `taken`: the ports earlier entries have, by service. */
const forwardOf = (
  entry: unknown,
  service: unknown,
  taken: ReadonlyMap<number, string>,
): { forward: { port: number; host: string } } | { leftOut: string } | null => {
  if (typeof entry !== "string" || /^\d+$/.test(entry)) return null;
  // The name becomes a host to connect to inside the service's network: one DNS label's
  // worth of plain characters, and nothing else.
  const match = /^([A-Za-z0-9][A-Za-z0-9._-]{0,62}):(\d{1,5})$/.exec(entry);
  const shown = `"${printable(entry, 80)}"`;
  if (!match) return { leftOut: `${shown} (not a service's name and a port)` };
  const [host, port] = [match[1]!, Number(match[2])];
  if (host === service || host === "localhost" || host === "127.0.0.1") return null;
  if (port > PORTS.max) return { leftOut: `${shown} (${port} is not a port)` };
  // The number becomes a listener in the VM, which runs as the workspace's user.
  if (port < PORTS.min)
    return { leftOut: `${shown} (below ${PORTS.min}: use a port from ${PORTS.min} up)` };
  const first = taken.get(port);
  if (first !== undefined)
    return first === host ? null : { leftOut: `${shown} (${port} is ${first}'s here)` };
  return { forward: { port, host } };
};

const forwardsRead = (spec: Record<string, unknown>) => {
  const taken = new Map<number, string>();
  const leftOut: string[] = [];
  for (const entry of Array.isArray(spec.forwardPorts) ? spec.forwardPorts : []) {
    const read = forwardOf(entry, spec.service, taken);
    if (read && "forward" in read) taken.set(read.forward.port, read.forward.host);
    else if (read) leftOut.push(read.leftOut);
  }
  return { forwards: [...taken].map(([port, host]) => ({ port, host })), leftOut };
};

/** `forwardPorts` entries that name another compose service (`db:5432`): what bridge.ts
 *  carries there. A bare number, or the primary service's own name, needs nothing: every
 *  listener of the primary service is mirrored already. */
export const forwardsOf = (spec: Record<string, unknown>): { port: number; host: string }[] =>
  forwardsRead(spec).forwards;

/** The `forwardPorts` entries that are not carried, each with why, for the devcontainer's
 *  note: every one of them, since the person wrote each expecting a port. */
export const forwardsLeftOut = (spec: Record<string, unknown>): string[] =>
  forwardsRead(spec).leftOut;

declare namespace forwardsOf {
  /** `service:port` entries for the other services; a bare number, or the primary service's
   *  own name, is mirrored already */
  export type OtherServices = Table<
    typeof forwardsOf,
    [
      [
        args: [spec: { service: "app"; forwardPorts: [3000, "db:5432", "app:8080", "cache:6379"] }],
        expected: [{ port: 5432; host: "db" }, { port: 6379; host: "cache" }],
      ],
      [args: [spec: { service: "app" }], expected: []],
      /** one number, one listener in the VM: the first entry for a port has it */
      [
        args: [spec: { service: "app"; forwardPorts: ["db:5432", "replica:5432"] }],
        expected: [{ port: 5432; host: "db" }],
      ],
    ]
  >;
  /** the name becomes a host to connect to inside the service's network, and the number a
   *  listener in the VM: loopback names, privileged or impossible ports, and anything that is
   *  not one name and one number are left out */
  export type Refuses = Table<
    typeof forwardsOf,
    [
      [
        args: [
          spec: {
            service: "app";
            forwardPorts: [
              "localhost:9000",
              "127.0.0.1:9001",
              "db:80",
              "db:70000",
              "-db:5432",
              "db;id:5432",
              "db:5432:1",
              "db: 5432",
              "user@db:5432",
            ];
          },
        ],
        expected: [],
      ],
    ]
  >;
}

declare namespace forwardsLeftOut {
  /** nothing to say of entries that are carried, or that need nothing */
  export type None = Expect<
    Invoke<
      typeof forwardsLeftOut,
      [
        spec: {
          service: "app";
          forwardPorts: [3000, "3001", "db:5432", "app:80", "localhost:9000"];
        },
      ]
    >,
    "=",
    []
  >;
  /** each entry that gets no port is named, with why: a privileged port, a number that is no
   *  port, a second service on a number already given, and text that is not `service:port`
   *  (shown as text, and no longer than a name is) */
  export type Named = Expect<
    Invoke<
      typeof forwardsLeftOut,
      [
        spec: {
          service: "app";
          forwardPorts: ["db:5432", "web:80", "db:70000", "replica:5432", "db;id:5432", "db:5432"];
        },
      ]
    >,
    "=",
    [
      '"web:80" (below 1024: use a port from 1024 up)',
      '"db:70000" (70000 is not a port)',
      '"replica:5432" (5432 is db\'s here)',
      '"db;id:5432" (not a service\'s name and a port)',
    ]
  >;
}

/** svcnet.ts in the primary service, as the VM's user, with the editor's node (a glibc
 *  program, as the editor's server is). Kept if one already answers. */
const startSvcnet = async (id: string): Promise<boolean> => {
  const answers = () =>
    new Promise<boolean>((resolve) => {
      const conn = net.connect(SVCNET);
      conn.setTimeout(1000, () => conn.destroy());
      conn.on("connect", () => conn.write("L\n"));
      conn.on("data", () => resolve(true));
      conn.on("error", () => resolve(false));
      conn.on("close", () => resolve(false));
    });
  if (await answers()) return true;
  const started = await run("docker", [
    "exec",
    "-d",
    "-u",
    `${process.getuid!()}:${process.getgid!()}`,
    id,
    "/opt/desolate/editor/node",
    "--disable-warning=ExperimentalWarning",
    "/desolate/release/workspace/svcnet.ts",
    SVCNET,
  ]);
  if (started.code !== 0) return false;
  for (let i = 0; i < 50; i++) {
    if (await answers()) return true;
    await sleep(100);
  }
  return false;
};

/** How long the VM's docker daemon gets to answer, once asked: it starts in a second or two
 *  (measured on the M1), and 90 seconds is what it has always been given. Counted by the
 *  clock: it was once counted in sleeps between probes that may each take 20 seconds. */
const DOCKER_WAIT_MS = 90_000;

/** How long `devcontainer up` may say nothing before it is taken as stuck: not how long it
 *  may take (docs/v3/limits.md, R4). A first image on a slow link, or a long build, runs for
 *  as long as docker and the build keep reporting, and the host's person sees that it is
 *  running. An hour is what the whole of it was once given, so nothing that came up before
 *  is stopped now: a project command that is silent that long (postCreateCommand) is rare,
 *  and one stuck on a prompt is the usual reason for silence. */
const UP_QUIET_MS = 3_600_000;

const main = async () => {
  const gone = requester();
  const name = process.argv[2] ?? "";
  const plan = readJson<WorkspacePlan | null>(`/desolate/inbox/workspaces/${name}.json`, null);
  const done = (state: State) => {
    writeJson(STATE, state);
    process.stdout.write(
      state.state === "up"
        ? `devcontainer: up (${state.image}, user ${state.remoteUser}${state.compose ? ", compose" : ""})${state.note ? `; note: ${state.note}` : ""}\n`
        : `devcontainer: ${state.state === "none" ? "none" : "FAILED"}: ${state.why}\n`,
    );
  };
  if (!plan)
    return done({ state: "none", why: `the root sent no plan for the workspace '${name}'` });
  // The domain's environment: the repository it names, else the first checkout with a spec.
  const checkout =
    plan.checkouts.find((c) => c.repo === plan.env && locate(c.path) !== undefined) ??
    plan.checkouts.find((c) => locate(c.path) !== undefined);
  if (!checkout)
    return done({
      state: "none",
      why: "no checkout has a devcontainer.json; this workspace is the VM itself",
    });
  const config = locate(checkout.path)!;
  let spec: Record<string, unknown>;
  try {
    const parsed: unknown = parseJsonc(fs.readFileSync(config, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new Error("it is not an object");
    spec = parsed as Record<string, unknown>;
  } catch (error) {
    return done({
      state: "failed",
      why: `${config} cannot be read: ${(error as Error).message}`,
      config,
    });
  }
  // The VM's own docker daemon, started a moment ago (start.sh) or by this first command
  // (systemd's socket). It is in this VM, so how long it gets is a bound, by the clock: a
  // daemon that has not answered in DOCKER_WAIT_MS is not coming.
  const began = Date.now();
  const docker = await saying("waiting for the VM's docker daemon", async () => {
    while ((await run("docker", ["info"], { timeoutMs: 20_000, signal: gone })).code !== 0) {
      if (gone.aborted || Date.now() - began > DOCKER_WAIT_MS) return false;
      await sleep(500);
    }
    return true;
  });
  if (!docker)
    return done({
      state: "failed",
      why: "the VM's docker daemon is not answering (see /var/lib/desolate/dockerd.log)",
      config,
    });
  const home = os.homedir();
  fs.mkdirSync(`${home}/.desolate-editor`, { recursive: true, mode: 0o700 });
  const instance = /^dsl-([a-z0-9]{1,12})-/.exec(plan.vm)?.[1];
  const cache = (await run("mountpoint", ["-q", "/desolate/cache"])).code === 0;
  const merged = overrideOf(spec, checkout.path, home, {
    domain: plan.domain,
    workspace: plan.workspace,
    cache,
    ...(instance ? { devHostname: devHostname(instance, plan.domain, plan.workspace) } : {}),
  });
  const text = JSON.stringify(merged, null, 2);
  const dir = `${home}/.desolate-devcontainer`;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const override = path.join(dir, "devcontainer.json");
  // A spec that changed since the container was made gets a new container.
  const digest = createHash("sha256").update(text).digest("hex");
  const changed =
    fs.existsSync(override) && readJson<string>(path.join(dir, "digest.json"), "") !== digest;
  fs.writeFileSync(override, text);
  writeJson(path.join(dir, "digest.json"), digest);
  // A spec with features makes the CLI write a lockfile beside it, into the checkout, where
  // an agent's `git add -A` takes it (seen in the promo). Unless the project keeps a
  // lockfile of its own (then it is verified, as the project asked), none is written.
  const lockfile = path.join(
    path.dirname(config),
    path.basename(config).startsWith(".") ? ".devcontainer-lock.json" : "devcontainer-lock.json",
  );
  const noLockfile = fs.existsSync(lockfile) ? [] : ["--no-lockfile"];
  const up = await saying(
    `bringing up the devcontainer of ${checkout.repo} (its image, its features, its own commands)`,
    () =>
      run(
        "devcontainer",
        [
          "up",
          "--workspace-folder",
          checkout.path,
          "--config",
          config,
          "--override-config",
          override,
          ...noLockfile,
          ...(changed ? ["--remove-existing-container"] : []),
        ],
        { idleMs: UP_QUIET_MS, signal: gone, env: { ...process.env, DOCKER_BUILDKIT: "1" } },
      ),
  );
  fs.writeFileSync(path.join(dir, "up.log"), `${up.stderr}\n${up.stdout}`);
  let result: {
    outcome?: string;
    containerId?: string;
    remoteUser?: string;
    remoteWorkspaceFolder?: string;
    message?: string;
    description?: string;
  } = {};
  try {
    result = JSON.parse(up.stdout.trim().split("\n").pop() ?? "{}");
  } catch {
    /* no result line */
  }
  if (up.code !== 0 || result.outcome !== "success" || !result.containerId) {
    // The CLI's own summary is general ("An error occurred setting up the container"); the
    // line that says what happened is docker's or the build's, further up its log.
    const cause = up.stderr
      .split("\n")
      .map((line) => line.replace(/^\[[^\]]*\]\s*/, "").trim())
      .filter(
        (line) =>
          /error|denied|not found|no such|failed|refused/i.test(line) &&
          !/^at /.test(line) &&
          !/control manifest/.test(line),
      )
      .pop();
    const summary = (result.description ?? result.message ?? "devcontainer up failed").replace(
      /\s+/g,
      " ",
    );
    // Each part is bounded (and a cut is marked) so that the last one, where all of it is,
    // always fits in what the host will show of a VM's line (shared/text.ts, SAFE_MOST).
    return done({
      state: "failed",
      why: `${printable(summary, 1000)}${cause ? ` (${printable(cause.replace(/\s+/g, " "), 2000)})` : ""} (the whole log: ${dir}/up.log in the workspace)`,
      config,
    });
  }
  const id = result.containerId;
  const inspect = await run("docker", [
    "inspect",
    "-f",
    "{{.HostConfig.NetworkMode}} {{.Config.Image}}",
    id,
  ]);
  const [network, image] = inspect.stdout.trim().split(" ");
  // The editor's server is a glibc program: it can run in the container only on glibc.
  const glibc =
    (
      await run("docker", [
        "exec",
        id,
        "sh",
        "-c",
        "ls /lib/ld-linux-*.so.* /lib64/ld-linux-*.so.* 2>/dev/null | head -1",
      ])
    ).stdout.trim() !== "";
  // A repository that keeps files in Git LFS, in a container without git-lfs: committing such
  // a file fails there ("git-lfs: command not found"). Said, not changed: the environment is
  // the project's.
  let usesLfs = false;
  try {
    usesLfs = /filter=lfs/.test(
      fs.readFileSync(path.join(checkout.path, ".gitattributes"), "utf8"),
    );
  } catch {
    /* no .gitattributes */
  }
  const lfsMissing =
    usesLfs && (await run("docker", ["exec", id, "sh", "-c", "git lfs version"])).code !== 0;
  // Who commits from the editor and its terminals: the workspace's identity (init.ts: the
  // person's, from the Mac), unless the container's user has one of its own. Without it a
  // first `git commit` in the editor failed with "Please tell me who you are". A fallback of
  // desolate's own (`...desolate.invalid`) is replaced, as in the VM (init.ts).
  const identity = [
    plan.author?.name ?? `${plan.domain}/${plan.workspace}`,
    plan.author?.email ?? `${plan.workspace}@${plan.domain}.desolate.invalid`,
  ];
  await run("docker", [
    "exec",
    "-u",
    result.remoteUser ?? "root",
    id,
    "sh",
    "-c",
    'case "$(git config --global user.email 2>/dev/null)" in ""|*.desolate.invalid) git config --global user.name "$1" && git config --global user.email "$2" ;; esac',
    "_",
    ...identity,
  ]);
  // And the domain's repositories by their GitHub addresses, as in the VM (git-urls.ts).
  for (const args of urlRules(plan.repos ?? plan.checkouts.map((c) => c.repo)))
    await run("docker", [
      "exec",
      "-u",
      result.remoteUser ?? "root",
      id,
      "git",
      "config",
      "--global",
      ...args,
    ]);
  // A compose service's own network, reached from the VM (bridge.ts): its listeners, its
  // `service:port` forwards, and the editor's server when it runs there.
  const compose = spec.dockerComposeFile !== undefined;
  const bridged = compose && network !== "host" && glibc && (await startSvcnet(id));
  // The environment `devcontainer exec` gives a command (remoteEnv, and what its probe of the
  // user's login shell finds), worked out once, here: enter.sh then enters with `docker
  // exec` and this, in 20 ms rather than the CLI's 300 to 400 (measured on the M1), every
  // `desolate exec` and every editor terminal. Made again whenever the container is.
  const probed = await run(
    "devcontainer",
    [
      "exec",
      "--workspace-folder",
      checkout.path,
      "--config",
      config,
      "--override-config",
      override,
      "sh",
      "-c",
      "env -0 2>/dev/null || env",
    ],
    { timeoutMs: 120_000, signal: gone },
  );
  const execEnv = path.join(dir, "exec-env.json");
  fs.rmSync(execEnv, { force: true });
  if (probed.code === 0) {
    const entries = (
      probed.stdout.includes("\0") ? probed.stdout.split("\0") : probed.stdout.split("\n")
    ).filter(
      (entry) =>
        /^[A-Za-z_][A-Za-z0-9_]*=/.test(entry) &&
        !/^(PWD|OLDPWD|SHLVL|_|TERM|HOSTNAME)=/.test(entry),
    );
    fs.writeFileSync(
      execEnv,
      JSON.stringify({ containerId: id, user: result.remoteUser ?? "root", env: entries }),
      { mode: 0o600 },
    );
  }
  const settingsNote = settingsLeftOut(spec);
  const forwardsNote = forwardsLeftOut(spec);
  const notes = [
    ...(settingsNote ? [settingsNote] : []),
    ...(compose && forwardsNote.length
      ? [`forwardPorts entries that are not forwarded: ${forwardsNote.join(", ")}`]
      : []),
    ...(lfsMissing
      ? [
          "this repository keeps files in Git LFS and the container has no git-lfs, so committing them fails there; add the feature ghcr.io/devcontainers/features/git-lfs:1 to its devcontainer.json",
        ]
      : []),
    ...(compose && network !== "host" && !bridged
      ? [
          `its service's ports are not forwarded and the editor runs in the VM: ${glibc ? "desolate's port relay did not start in it" : "it is not a glibc container, which desolate's port relay and the editor need"}`,
        ]
      : []),
  ];
  done({
    state: "up",
    containerId: id,
    remoteUser: result.remoteUser ?? "root",
    folder: result.remoteWorkspaceFolder ?? checkout.path,
    config,
    override,
    checkout: checkout.path,
    hostNetwork: network === "host",
    glibc,
    compose,
    extensions: extensionsOf(spec),
    ...(settingsOf(spec) ? { settings: settingsOf(spec) } : {}),
    // Whole: what shows it fits it (the host bounds what a VM says, and marks a cut).
    image: compose ? `service ${String(spec.service)}` : String(spec.image ?? image ?? "built"),
    ...(bridged ? { bridge: SVCNET, forwards: forwardsOf(spec) } : {}),
    ...(notes.length ? { note: notes.join("; ") } : {}),
  });
};

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main();
