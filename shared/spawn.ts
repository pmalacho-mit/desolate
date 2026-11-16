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
import { isBranch, isSlug } from "./names.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Table } from "../.suede/nests/dsl.import.meta.vitest.ts";

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
  export type Cases = Table<typeof commandOf, [
    [args: [value: ["claude", "-p", "fix the docs; $(rm -rf ~)"]], expected: ["claude", "-p", "fix the docs; $(rm -rf ~)"]],
    [args: [value: []], expected: []],
    [args: [value: ["a\u0000b"]], expected: null],
    [args: [value: "claude -p hi"], expected: null],
    [args: [value: [1]], expected: null],
  ]>;
}

export type Spawn = { op: "spawn"; domain: string; parent: string; name: string; branch: string; command: string[]; at: string; nonce: string };
export type Close = { op: "close"; domain: string; parent: string; name: string; at: string; nonce: string };
export type Signed = Spawn | Close;

/** The exact bytes a signature covers: every field, in a fixed order, with its op. */
export const canonical = (r: Signed): string =>
  JSON.stringify(r.op === "spawn" ? ["desolate-spawn-v1", r.domain, r.parent, r.name, r.branch, r.command, r.at, r.nonce] : ["desolate-close-v1", r.domain, r.parent, r.name, r.at, r.nonce]);

export const sign = (key: string, r: Signed): string => createHmac("sha256", Buffer.from(key, "hex")).update(canonical(r)).digest("hex");

/** The request's fields, checked; null if any is not one desolate makes. */
export const parseSigned = (value: unknown): (Signed & { mac: string }) | null => {
  const v = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  if (!isSlug(v.domain) || !isSlug(v.parent) || !isSlug(v.name) || typeof v.at !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$/.test(v.at) || typeof v.nonce !== "string" || !NONCE.test(v.nonce) || typeof v.mac !== "string" || !MAC.test(v.mac)) return null;
  if (v.name === v.parent) return null;
  if (v.op === "close") return { op: "close", domain: v.domain, parent: v.parent, name: v.name, at: v.at, nonce: v.nonce, mac: v.mac };
  if (v.op !== "spawn") return null;
  const branch = v.branch === undefined || v.branch === "" ? "" : isBranch(v.branch) ? v.branch : null;
  const command = commandOf(v.command ?? []);
  if (branch === null || command === null) return null;
  return { op: "spawn", domain: v.domain, parent: v.parent, name: v.name, branch, command, at: v.at, nonce: v.nonce, mac: v.mac };
};

/** The host's check: the signature is the parent workspace's, and the request is fresh.
 *  Returns why not, or null. */
export const verify = (key: string | null, r: Signed & { mac: string }, now = Date.now()): string | null => {
  if (!key || !KEY.test(key)) return `the host has no key for ${r.domain}/${r.parent}: it was not started by this host, or was removed`;
  const expected = Buffer.from(sign(key, r), "hex");
  const given = Buffer.from(r.mac, "hex");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return `the request is not signed by ${r.domain}/${r.parent}`;
  const at = Date.parse(r.at);
  if (!Number.isFinite(at) || now - at > FRESH_MS || at - now > 120_000) return "the request is too old (or from the future): ask again";
  return null;
};
