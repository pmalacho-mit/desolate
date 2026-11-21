// What another layer said when it failed, on its way into a refusal (docs/v3/limits.md, R1):
// the root, limactl, a provisioning script, a VM's own program. A refusal shows the end of
// it, where a program says why it failed, and says how much came before; the whole text is
// kept here, under the host's logs, and the refusal names the file. Nothing of it is cut
// without that being said, and nothing is cut twice.
//
//   ~/.desolate/logs/failures/2026-11-20T10-00-00-000Z-root-start.txt
//
// The newest are kept (KEPT, below); `desolate doctor` names the last one.
import * as fs from "node:fs";
import * as path from "node:path";
import { failure } from "../shared/text.ts";
import { paths } from "./paths.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Given, Invoke } from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { emptyHome } from "../.harness/home.ts";
import type { keptFailures, lines } from "../.harness/host-failures.ts";

const DIR = () => path.join(paths.logs, "failures");

/** How many of its last lines a refusal shows of what another layer said. Ten: a program
 *  says why it failed at its end, in a line or a few (git's `fatal:`, apt's `E:`, a stack
 *  trace's last frames), and ten lines leave the command that was typed on the screen above
 *  them. The rest is not lost: the refusal says how many lines came before, and where. */
export const LAST = 10;

/** How many failures' whole texts are kept, the newest. They are for reading just after a
 *  refusal named one, so what bounds them is the folder, not the reader: a hundred outlive
 *  a burst from a loop that fails every few seconds (the daemon asking a root that is down)
 *  long enough for the path a person was shown a minute ago to still lead somewhere. */
const KEPT = 100;

/** The keeper `failure` (shared/text.ts) is handed: writes the whole text to a file of its
 *  own under the host's logs, the person's alone, and answers its path. `what` names what
 *  failed, in the file's name ("root-start", "limactl-start"). */
export const keep =
  (what: string) =>
  (whole: string): string => {
    const dir = DIR();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const name = what.replace(/[^a-z0-9-]/g, "-");
    // Two in one millisecond are two files: the name is taken only if it is free.
    let file = path.join(dir, `${stamp}-${name}.txt`);
    for (let again = 2; ; again++)
      try {
        fs.writeFileSync(file, whole.endsWith("\n") ? whole : `${whole}\n`, {
          mode: 0o600,
          flag: "wx",
        });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        file = path.join(dir, `${stamp}-${name}-${again}.txt`);
      }
    // Their names begin with the time, so sorted is oldest first.
    const all = fs.readdirSync(dir).sort();
    for (const old of all.slice(0, Math.max(0, all.length - KEPT)))
      fs.rmSync(path.join(dir, old), { force: true });
    return file;
  };

/** `summary`, and why: what the other layer said (`output`), as `failure` shows it. A reason
 *  of one line follows the summary on its line, as it always has; a longer one starts on the
 *  next, under the line that says how much was left out and where all of it is. `what` null:
 *  the whole is not written anywhere (what a secret's store said may hold the secret), and
 *  the refusal says only how much was left out. */
export const because = (summary: string, what: string | null, output: string): string => {
  const said = failure(output.trim(), LAST, what === null ? () => null : keep(what));
  if (said === "") return `${summary}: no output`;
  return said.includes("\n") ? `${summary}:\n${said}` : `${summary}: ${said}`;
};

declare namespace because {
  /** a reason of one line is on the summary's line, and nothing is kept: all of it is shown */
  export type OneLine = Given<
    Invoke<typeof emptyHome>,
    [
      Expect<
        Invoke<
          typeof because,
          [
            summary: "the root's services did not start",
            what: "root-start",
            output: "start.sh: nft is not installed\n",
          ]
        >,
        "=",
        "the root's services did not start: start.sh: nft is not installed"
      >,
      Expect<Invoke<typeof keptFailures>, "=", []>,
    ]
  >;
  /** a long one: its last ten lines, how many came before, and the file that holds it all */
  export type Long = Given<
    Invoke<typeof emptyHome>,
    [
      Expect<
        Invoke<
          typeof because,
          [
            summary: "provisioning the base VM failed",
            what: "provision",
            output: Invoke<typeof lines, [count: 14]>,
          ]
        >,
        "matches",
        "^provisioning the base VM failed:\n\\(4 earlier lines not shown; all of it: .*/logs/failures/[0-9TZ-]+-provision\\.txt\\)\nline 5\nline 6\nline 7\nline 8\nline 9\nline 10\nline 11\nline 12\nline 13\nline 14$"
      >,
      Expect<Invoke<typeof keptFailures>, "=", [{ what: "provision"; lines: 14; mode: "600" }]>,
    ]
  >;
  /** not to be kept: how much was left out is said, and nothing is written */
  export type Unkept = Given<
    Invoke<typeof emptyHome>,
    [
      Expect<
        Invoke<
          typeof because,
          [
            summary: "the root did not change acme's secrets (exit 1)",
            what: null,
            output: Invoke<typeof lines, [count: 11]>,
          ]
        >,
        "matches",
        "^the root did not change acme's secrets \\(exit 1\\):\n\\(1 earlier line not shown\\)\nline 2\n"
      >,
      Expect<Invoke<typeof keptFailures>, "=", []>,
    ]
  >;
  /** what it said is text, not commands for the terminal it is shown on */
  export type Safe = Expect<
    Invoke<
      typeof because,
      [summary: "limactl start failed (exit 1)", what: "limactl", output: "fatal\u001b[2J\rdone"]
    >,
    "=",
    "limactl start failed (exit 1): fatal?[2J?done"
  >;
  /** it said nothing: that is said */
  export type Nothing = Expect<
    Invoke<
      typeof because,
      [summary: "the root did not answer 'ping' (exit 255)", what: "x", output: " \n"]
    >,
    "=",
    "the root did not answer 'ping' (exit 255): no output"
  >;
}

/** The newest failure kept, and how many there are: for `desolate doctor`, which says where
 *  the last one is. Null when none is kept. */
export const lastFailure = (): { file: string; of: number } | null => {
  try {
    const all = fs.readdirSync(DIR()).sort();
    return all.length === 0 ? null : { file: path.join(DIR(), all.at(-1)!), of: all.length };
  } catch {
    return null;
  }
};

declare namespace lastFailure {
  /** none kept: none named */
  export type None = Given<Invoke<typeof emptyHome>, Expect<Invoke<typeof lastFailure>, "=", null>>;
  /** the newest of those kept, and how many there are */
  export type Newest = Given<
    [
      Invoke<typeof emptyHome>,
      Invoke<
        typeof because,
        [summary: "a", what: "first", output: Invoke<typeof lines, [count: 11]>]
      >,
      Invoke<
        typeof because,
        [summary: "b", what: "second", output: Invoke<typeof lines, [count: 12]>]
      >,
    ],
    Expect<Invoke<typeof lastFailure>, "matches", { of: 2 }>
  >;
}
