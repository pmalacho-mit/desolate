// Harness for in-source tests of the host's commands that ask the root (host/stack.ts's
// rootctl) and print lines. It stands in for two things:
//
//   - the root: `fakeStack` replaces host/stack.ts (with the DSL's Mock). Its rootctl answers
//     each op with what `rootAnswers` left for it, as the root's CLI service would, taken as
//     the real one takes it (host/replies.ts), and keeps a list of what it was asked. Both are files under the test file's home, so the copy of
//     this module the mock is made from and the copy the test reads agree. An op with no
//     answer is refused as the real channel refuses a root that does not answer. Its backend
//     has no VM: it lists and runs only what `vmAnswers` left (after `rootAnswers`).
//   - the terminal: `collect` is the `out` a command is given; `said` is what it printed.
//     (What it shows of a refusal: refusal.ts.)
import * as fs from "node:fs";
import * as path from "node:path";
import { Readable } from "node:stream";
import { Refusal } from "../shared/exit.ts";
import { replyOf } from "../host/replies.ts";
import type { Op } from "../host/replies.ts";

const file = (name: string) => path.join(process.env.DESOLATE_HOME!, `nests-${name}.json`);
const read = <T>(name: string, fallback: T): T => {
  try {
    return JSON.parse(fs.readFileSync(file(name), "utf8")) as T;
  } catch {
    return fallback;
  }
};

/** What the root answers, by op, from now on in this test (and nothing asked yet).
 *  @standsIn release/root/rootctl.ts (the root's CLI service, as host/replies.ts reads its answers)
 *  @realIn T2 01-root, "bootstrap: one command from an empty home to a working stack" */
export const rootAnswers = (answers: Record<string, unknown>) => {
  fs.writeFileSync(file("answers"), JSON.stringify(answers));
  fs.writeFileSync(file("asked"), "[]");
  fs.rmSync(file("vm"), { force: true });
};

/** The ops the root was asked, in order, with their arguments. */
export const rootAsked = (): { op: string; args: Record<string, unknown> }[] => read("asked", []);

/** What the root answers `op` (asked as `as`, which is the op a stand-in's answer is left
 *  under), as the Mac takes an answer to `op`. */
const answer = (op: Op, args: Record<string, unknown>, as: string = op) => {
  fs.writeFileSync(file("asked"), JSON.stringify([...rootAsked(), { op: as, args }]));
  const answers = read<Record<string, unknown>>("answers", {});
  if (!(as in answers)) throw new Refusal(`the root did not answer '${as}'`, "desolate doctor");
  return replyOf(op, answers[as], args);
};
const rootctl = async (op: Op, args: Record<string, unknown> = {}) => answer(op, args);

type VmAnswers = {
  list?: { name: string; status: string; labels: Record<string, string> }[];
  exec?: { code: number; stdout: string; stderr?: string };
};
/** What the backend answers from now on in this test: the VMs it lists, and what every command
 *  run in one prints (its argv is kept with the root's asks, as `exec`). */
export const vmAnswers = (answers: VmAnswers) =>
  fs.writeFileSync(file("vm"), JSON.stringify(answers));

/** A backend with no VM behind it: it lists and runs what `vmAnswers` left, and anything else
 *  it is asked is an error that says what was asked. */
const noVm = () => {
  const answers = read<VmAnswers>("vm", {});
  const fake: Record<string, unknown> = {
    ...(answers.list ? { list: async () => answers.list } : {}),
    ...(answers.exec
      ? {
          exec: async (vm: string, argv: string[]) => {
            fs.writeFileSync(
              file("asked"),
              JSON.stringify([...rootAsked(), { op: "exec", args: { vm, argv } }]),
            );
            return { stderr: "", ...answers.exec };
          },
        }
      : {}),
  };
  return new Proxy(fake, {
    get: (target, name) =>
      name in target
        ? target[name as string]
        : name === "then"
          ? undefined
          : () => {
              throw new Error(`no VM in an in-source test (${String(name)})`);
            },
  });
};

/** host/stack.ts, with no VM behind it.
 *  @standsIn release/host/stack.ts
 *  @realIn T2: every suite runs the real stack.ts against the fake backend, and T4 on real VMs (tests/v3/t3/01-boundaries.test.ts, "T3 bootstrap on real VMs: isolated, and doctor passes") */
export const fakeStack = {
  rootctl,
  // A brief call is a call: here, nothing is waited on.
  rootctlBrief: rootctl,
  backend: noVm,
  ROOT_VM: "dsl-main-root",
  config: () => null,
  ensureProxyUser: async () => {},
  // A change to the secrets is asked of the root as `secret.<action>`, with the domain, and
  // answered as the real one is, by secret.apply's list.
  changeSecrets: async (domain: string, action: string, args: Record<string, unknown>) =>
    answer("secret.apply", { domain, ...args }, `secret.${action}`),
};

/** What stdin gives from now on in this test: `text`, then its end (not a terminal). */
export const stdinGives = (text: string) =>
  Object.defineProperty(process, "stdin", { value: Readable.from([text]), configurable: true });

/** What builds a workspace (host/workspaces.ts's specOf and startServices), for a test that
 *  never gets as far as building one. */
const notBuilt = (): never => {
  throw new Error("no workspace is built in an in-source test");
};
export const noBuilder = { specOf: notBuilt, startServices: async () => notBuilt() };

let lines: string[] = [];
/** The `out` a command prints with. */
export const collect = (line: string) => {
  lines.push(line);
};
/** What it printed, line by line (a line with newlines in it is split), and forgotten. */
export const said = (): string[] => {
  const all = lines.flatMap((line) => line.split("\n"));
  lines = [];
  return all;
};

let replies: string[] = [];
/** What a person answers from now on, one question at a time (`reply` asks). */
export const repliesAre = (answers: string[]) => {
  replies = [...answers];
};
/** A question put to the person: the next of `repliesAre`'s answers. With none left the test
 *  fails, rather than asking for ever. */
export const reply = async (question: string): Promise<string> => {
  if (!replies.length) throw new Error(`no answer left for: ${question}`);
  return replies.shift()!;
};
