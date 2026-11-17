// The forge's address and host key, in root's own directory, for the pusher.
//
//   node forge-pin.ts        (as root, by the host, at every bootstrap; the forge on stdin)
//
// The root's user keeps a copy of its own for fetching (ops.ts, `forge.set`), and could
// rewrite it: the pusher, which holds the write key's agent, reads this one instead, so the
// root's user cannot aim a push at a host of its choosing. Written by root, 0644, by rename.
import * as fs from "node:fs";
import { PINNED_FORGE } from "./layout.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Invoke, Throws } from "../../suede.nests/dsl.import.meta.vitest.ts";

/** What root pins, from the forge the host gave (JSON): the address, as three checked words,
 *  and its host keys, as known_hosts lines. Anything else is refused, said why. */
export const pinnedOf = (text: string): { config: string; knownHosts: string } => {
  const forge = JSON.parse(text) as {
    kind?: string;
    ssh?: { user?: string; host?: string; port?: number };
    knownHosts?: string;
  };
  const ssh = forge.ssh ?? {};
  if (
    (forge.kind !== "github" && forge.kind !== "stand-in") ||
    !/^[a-z_][a-z0-9_-]*$/.test(ssh.user ?? "") ||
    !/^[A-Za-z0-9.-]+$/.test(ssh.host ?? "") ||
    !Number.isInteger(ssh.port) ||
    ssh.port! < 1 ||
    ssh.port! > 65535
  )
    throw new Error("the forge is {kind, ssh:{user,host,port}, knownHosts}");
  const known = String(forge.knownHosts ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (
    known.length === 0 ||
    known.some((line) => /[^\x20-\x7e]/.test(line) || line.split(/\s+/).length < 3)
  )
    throw new Error("the forge's host keys are known_hosts lines");
  return {
    config:
      JSON.stringify(
        { kind: forge.kind, ssh: { user: ssh.user, host: ssh.host, port: ssh.port } },
        null,
        2,
      ) + "\n",
    knownHosts: known.join("\n") + "\n",
  };
};

declare namespace pinnedOf {
  /** the address alone (nothing else the host sent), and the host keys without comments or blanks */
  export type Pins = Expect<
    Invoke<
      typeof pinnedOf,
      [
        text: '{"kind":"github","ssh":{"user":"git","host":"github.com","port":22,"extra":"x"},"knownHosts":"# GitHub\\n\\ngithub.com ssh-ed25519 AAAA\\n","token":"t"}',
      ]
    >,
    "=",
    {
      config: '{\n  "kind": "github",\n  "ssh": {\n    "user": "git",\n    "host": "github.com",\n    "port": 22\n  }\n}\n';
      knownHosts: "github.com ssh-ed25519 AAAA\n";
    }
  >;
  /** an address ssh would read as more than one (an option for a user, a second word for a
   *  host), a port out of range, another kind of forge: not pinned */
  export type BadAddress = [
    Throws<
      Invoke<
        typeof pinnedOf,
        [
          text: '{"kind":"github","ssh":{"user":"-oProxyCommand=sh","host":"github.com","port":22},"knownHosts":"github.com ssh-ed25519 AAAA"}',
        ]
      >,
      "the forge is {kind, ssh:{user,host,port}, knownHosts}"
    >,
    Throws<
      Invoke<
        typeof pinnedOf,
        [
          text: '{"kind":"github","ssh":{"user":"git","host":"github.com evil","port":22},"knownHosts":"github.com ssh-ed25519 AAAA"}',
        ]
      >,
      "the forge is {kind, ssh:{user,host,port}, knownHosts}"
    >,
    Throws<
      Invoke<
        typeof pinnedOf,
        [
          text: '{"kind":"github","ssh":{"user":"git","host":"github.com","port":70000},"knownHosts":"github.com ssh-ed25519 AAAA"}',
        ]
      >,
      "the forge is {kind, ssh:{user,host,port}, knownHosts}"
    >,
    Throws<
      Invoke<
        typeof pinnedOf,
        [
          text: '{"kind":"gitlab","ssh":{"user":"git","host":"gitlab.com","port":22},"knownHosts":"gitlab.com ssh-ed25519 AAAA"}',
        ]
      >,
      "the forge is {kind, ssh:{user,host,port}, knownHosts}"
    >,
  ];
  /** no host key (nothing is learned on first use), or a line that is not one */
  export type BadKeys = [
    Throws<
      Invoke<
        typeof pinnedOf,
        [
          text: '{"kind":"github","ssh":{"user":"git","host":"github.com","port":22},"knownHosts":"# none\\n"}',
        ]
      >,
      "the forge's host keys are known_hosts lines"
    >,
    Throws<
      Invoke<
        typeof pinnedOf,
        [
          text: '{"kind":"github","ssh":{"user":"git","host":"github.com","port":22},"knownHosts":"github.com AAAA"}',
        ]
      >,
      "the forge's host keys are known_hosts lines"
    >,
    Throws<
      Invoke<
        typeof pinnedOf,
        [
          text: '{"kind":"github","ssh":{"user":"git","host":"github.com","port":22},"knownHosts":"github.com ssh-ed25519 AAAA\\u001b[2J"}',
        ]
      >,
      "the forge's host keys are known_hosts lines"
    >,
  ];
}

const main = async () => {
  if (process.getuid!() !== 0)
    throw new Error("forge-pin.ts runs as root, from the host's own way in");
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  const pinned = pinnedOf(text);
  const put = (file: string, content: string) => {
    const temp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(temp, content, { mode: 0o644 });
    fs.chownSync(temp, 0, 0);
    fs.chmodSync(temp, 0o644);
    fs.renameSync(temp, file);
  };
  put(PINNED_FORGE.config, pinned.config);
  put(PINNED_FORGE.knownHosts, pinned.knownHosts);
  process.stdout.write(JSON.stringify({ ok: true }) + "\n");
};

// Run by the host as root, at every bootstrap (host/stack.ts: node with this file's path, the
// forge on stdin); imported, it does nothing.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === new URL(import.meta.url).pathname)
  main().catch((error: Error) => {
    process.stdout.write(JSON.stringify({ ok: false, error: error.message }) + "\n");
    process.exit(1);
  });
