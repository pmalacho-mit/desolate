// Harness for the in-source tests of release/host/carry.ts: a root VM that answers, the kept
// archive as `destroy` leaves it in the home, and what a step said. All in the test file's own
// home (setup.ts).
import * as fs from "node:fs";
import * as path from "node:path";
import type { backend } from "../host/stack.ts";
import type { ExecOptions } from "../host/vm/types.ts";

const home = () => process.env.DESOLATE_HOME!;
const kept = () => path.join(home(), "root-kept", "root-state.tgz");

/** Stands in for the VM layer: the root VM is in `status`, and every command run in it ends
 *  with `code` and prints `stdout` (and `stderr`). Its stdout goes to the file a command
 *  asks it to (`stdoutTo`), one byte for each character (latin1), as a VM's tar writes bytes. */
export const rootVm = (status: string, code: number, stdout: string, stderr = "") =>
  ({
    info: async () => ({ status }),
    start: async () => {},
    exec: async (_name: string, _argv: string[], options: ExecOptions = {}) => {
      if (!options.stdoutTo) return { code, stdout, stderr };
      fs.writeFileSync(options.stdoutTo, stdout, "latin1");
      return { code, stdout: "", stderr };
    },
  }) as unknown as ReturnType<typeof backend>;

/** An archive a `destroy` kept, holding `text`. */
export const keptBefore = (text: string) => {
  fs.mkdirSync(path.dirname(kept()), { recursive: true });
  fs.writeFileSync(kept(), text);
};

/** Runs a step with `args` after its output, and says what it returned (or threw), the lines
 *  it said, and what the kept archive holds after it (null: none). The home's path is written
 *  `$DESOLATE_HOME`, since each test file's home is another. */
export const carried = async (
  command: (out: (line: string) => void, ...args: any[]) => Promise<unknown>,
  args: unknown[],
) => {
  const lines: string[] = [];
  const homeless = (text: string) => text.replaceAll(home(), "$DESOLATE_HOME");
  let outcome: { returned: unknown } | { threw: string };
  try {
    outcome = { returned: await command((line) => void lines.push(homeless(line)), ...args) };
  } catch (error) {
    outcome = { threw: homeless((error as Error).message) };
  }
  let archive: string | null = null;
  try {
    archive = fs.readFileSync(kept(), "latin1");
  } catch {
    /* none */
  }
  return { ...outcome, lines, kept: archive };
};
