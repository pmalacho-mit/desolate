// Harness for in-source tests of the pages the host daemon serves itself: the approval page
// (host/approve-web.ts) and the git terminal (host/git-web.ts). It stands in for a browser
// and for what is behind each page:
//
//   - `ask` sends one request to a page's handler, as a browser would with these headers,
//     and gives back what it answered: no socket, no server.
//   - `waiting` is the approval page's backend: the root's list of pushes waiting (the texts
//     given), a reviewer with nothing to say yet, and a keyring that is only written down
//     (`approved`, `refused`). Nothing is signed.
//   - `noShell` is the git terminal's way into the git VM, for a test that never opens one.
//   - `vmRunning` is the VM layer for the host's questions to the reviewer (host/daemon.ts,
//     reviewerSummary): each program it is asked to run as root in a VM is a local shell
//     running `script`; `stillRunning` says how many of those are, and ends them; `firstOf`
//     reads one line of an answer and leaves the rest unread, its asker still there.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { Backend } from "../host/approve-web.ts";
import type { backend } from "../host/stack.ts";
import type { AccountLine, AccountRequest } from "../shared/review-account.ts";
import { parseEnv, planEnv, rewriteEnv } from "../host/envfile.ts";

/** `body`: text as it is sent, or an object sent as its JSON. */
type Request = {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string | Record<string, unknown>;
};
export type Answer = {
  status: number;
  headers: Record<string, string>;
  text: string;
  json: unknown;
};

/** One request to a handler, and its whole answer (`json`: the body read as JSON, if it is). */
export const ask = (
  handler: (req: IncomingMessage, res: ServerResponse) => unknown,
  request: Request,
): Promise<Answer> =>
  new Promise((resolve, reject) => {
    const body = typeof request.body === "object" ? JSON.stringify(request.body) : request.body;
    const req = Readable.from(
      body === undefined ? [] : [Buffer.from(body)],
    ) as unknown as IncomingMessage;
    Object.assign(req, {
      method: request.method,
      url: request.url,
      headers: request.headers ?? {},
    });
    let status = 0;
    let headers: Record<string, string> = {};
    let text = "";
    const res = {
      writeHead(code: number, fields: Record<string, string | number> = {}) {
        status = code;
        headers = Object.fromEntries(
          Object.entries(fields).map(([k, v]) => [k.toLowerCase(), String(v)]),
        );
        return res;
      },
      // (A connection that never closes: what waits on one waits for its answer.)
      once() {
        return this;
      },
      write(chunk: string | Buffer) {
        text += chunk.toString();
        return true;
      },
      end(chunk?: string | Buffer) {
        if (chunk !== undefined) text += chunk.toString();
        let json: unknown = undefined;
        if (/json/.test(headers["content-type"] ?? "")) json = JSON.parse(text);
        resolve({ status, headers, text, json });
      },
    } as unknown as ServerResponse;
    Promise.resolve(handler(req, res)).catch(reject);
  });

let decided: { approved: string[]; refused: string[] } = { approved: [], refused: [] };
let questions: AccountRequest[] = [];
/** A reviewer that says `lines`, whatever it is asked. */
async function* saying(lines: AccountLine[]): AsyncGenerator<AccountLine> {
  for (const line of lines) yield line;
}
/** A reviewer still working when it is dropped: it says nothing, and ends then. */
async function* working(signal: AbortSignal): AsyncGenerator<AccountLine> {
  await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
}
/** The approval page's backend, with these pushes waiting (each as the root lists it).
 *  `says`: what the reviewer answers each question, as its stream (left out: it never does). */
export const waiting = (messages: string[], says?: AccountLine[]): Backend => {
  decided = { approved: [], refused: [] };
  questions = [];
  return {
    pending: async () => ({
      tag: "listed",
      pending: messages.map((message) => ({ message, at: "2026-11-16T10:00:00Z" })),
    }),
    summary: (request, signal) => {
      questions.push(request);
      return says ? saying(says) : working(signal);
    },
    approve: async (message) => void decided.approved.push(message),
    refuse: async (message) => void decided.refused.push(message),
    issues: async () => [],
    publishIssue: async () => "",
    refuseIssue: async () => {},
    pushes: () => () => {},
    github: () => false,
  };
};
/** The texts the keyring was handed to sign, and those taken off the list. */
export const approved = () => decided.approved;
/** How many questions the reviewer was asked. */
export const askedCount = () => questions.length;
export const refused = () => decided.refused;

/** No shell: the git terminal's tests never get as far as opening one. */
export const noShell = (_argv: string[]): ChildProcess => {
  throw new Error("no git VM in an in-source test");
};
export const quiet = (_line: string) => {};
/** The git VM, failing to come up when a shell is asked for. */
export const gitVmDown = async (_repo: string | null) => {
  throw new Error("it did not start");
};

/** The approval page's backend with a domain's secrets: `acme` holds NPM-TOKEN; a set keeps
 *  what it was given in `secretsSet` (the value included, to show it reached the host). */
let given: Record<string, unknown>[] = [];
let defaults: Record<string, unknown> = { "files.autoSave": "off" };
export const withSecrets = (): Backend => {
  given = [];
  defaults = { "files.autoSave": "off" };
  const held = [{ name: "NPM-TOKEN", hosts: ["registry.npmjs.org"], headers: null, on: true }];
  return {
    ...waiting([]),
    secrets: {
      domains: async () => ["acme"],
      list: async () => held,
      set: async (domain, secret) => {
        given.push({ domain, ...secret });
        return [...held, { name: secret.name, hosts: secret.hosts, headers: null, on: true }];
      },
      switch: async () => held,
      remove: async () => [],
    },
    // Every editor's defaults, held here for the test.
    editorDefaults: {
      get: async () => defaults,
      set: async (settings) => {
        if (typeof settings !== "object" || settings === null || Array.isArray(settings))
          throw new Error("editor defaults are a settings object");
        defaults = settings;
        return { settings, running: 0, applied: 0 };
      },
    },
    // The real planner (host/envfile.ts), and an import that keeps nothing.
    envImport: {
      plan: async (_domain, text) => planEnv(parseEnv(text)),
      apply: async (_domain, text) => {
        const lines = parseEnv(text);
        const rows = planEnv(lines);
        const secrets = rows.filter((r) => r.kind === "secret");
        return {
          rows,
          env: rewriteEnv(lines, Object.fromEntries(secrets.map((r) => [r.key, r.name!]))),
          secrets: held,
        };
      },
    },
  };
};
export const secretsSet = () => given;

// ------------------------------------------------------------------ the reviewer's program
let started: ChildProcess[] = [];
let asked: { vm: string; argv: string[]; options: unknown }[] = [];
/** The VM layer, where every program asked for (`spawn`, with pipes) is `sh -c script` on
 *  this machine: it writes what a reviewer would, on stdout and stderr, and lives as long. */
export const vmRunning = (script: string) => {
  started = [];
  asked = [];
  return {
    spawn: (vm: string, argv: string[], options: unknown) => {
      asked.push({ vm, argv, options });
      const child = spawn("sh", ["-c", script], { stdio: ["pipe", "pipe", "pipe"] });
      started.push(child);
      return child;
    },
    exec: async () => {
      throw new Error("this VM layer runs programs with spawn only");
    },
  } as unknown as ReturnType<typeof backend>;
};
/** What `vmRunning` was asked to run: in which VM, the program, and how. */
export const spawnedAs = () => asked;
const ended = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;
/** How many of the programs `vmRunning` started are still running, a second after the last
 *  was asked to end (a kill takes a moment to arrive); then every one is ended. */
export const stillRunning = async (): Promise<number> => {
  await Promise.all(
    started.map((child) =>
      ended(child)
        ? null
        : new Promise((resolve) => {
            child.once("exit", resolve);
            setTimeout(resolve, 1000).unref();
          }),
    ),
  );
  const running = started.filter((child) => !ended(child)).length;
  for (const child of started) if (!ended(child)) child.kill("SIGKILL");
  return running;
};
/** The first line an answer gives; the rest is left unread, and its asker does not go away
 *  (the generator is not returned). */
export const firstOf = async <T>(lines: AsyncGenerator<T>): Promise<T | undefined> =>
  (await lines.next()).value as T | undefined;
