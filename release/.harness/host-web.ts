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
import type { ChildProcess } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { Backend, Summary } from "../host/approve-web.ts";
import { parseEnv, planEnv, rewriteEnv } from "../shared/envfile.ts";

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
/** The approval page's backend, with these pushes waiting (each as the root lists it). */
export const waiting = (messages: string[]): Backend => {
  decided = { approved: [], refused: [] };
  return {
    pending: async () => messages.map((message) => ({ message, at: "2026-11-16T10:00:00Z" })),
    summary: () => new Promise<Summary>(() => {}),
    approve: async (message) => void decided.approved.push(message),
    refuse: async (message) => void decided.refused.push(message),
    issues: async () => [],
    publishIssue: async () => "",
    refuseIssue: async () => {},
  };
};
/** The texts the keyring was handed to sign, and those taken off the list. */
export const approved = () => decided.approved;
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
export const withSecrets = (): Backend => {
  given = [];
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
    // The real planner (shared/envfile.ts), and an import that keeps nothing.
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
