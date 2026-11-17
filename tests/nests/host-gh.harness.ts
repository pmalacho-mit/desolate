// Harness for in-source tests of publishing an issue (host/issues.ts). It stands in for the
// person's `gh`, which host/issues.ts runs by the name in DESOLATE_GH: a script under the test
// file's own home that writes down how it was called (each argument a line) and answers as
// told. Nothing reaches GitHub.
//
// In what comes back, the home is written `<home>` and the temporary directory the body is
// written in `issue-<tmp>`.
//
// Imported by the tests as types only, so nothing here reaches the release.
import * as fs from "node:fs";
import * as path from "node:path";
import { onTestFinished } from "vitest";

const dir = () => path.join(process.env.DESOLATE_HOME!, "nests-gh");
const log = () => path.join(dir(), "calls");

/** gh, for this test: it prints `stdout` (and `stderr`) and exits with `status`. */
export const fakeGh = (stdout: string, status: number, stderr = "") => {
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(path.join(dir(), "out"), stdout);
  fs.writeFileSync(path.join(dir(), "err"), stderr);
  fs.writeFileSync(log(), "");
  fs.writeFileSync(path.join(dir(), "gh"), `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done >>'${log()}'\nprintf '%s\\n' '--end--' >>'${log()}'\ncat '${dir()}/out'\ncat '${dir()}/err' >&2\nexit ${status}\n`, { mode: 0o755 });
  const before = process.env.DESOLATE_GH;
  process.env.DESOLATE_GH = path.join(dir(), "gh");
  onTestFinished(() => {
    if (before === undefined) delete process.env.DESOLATE_GH;
    else process.env.DESOLATE_GH = before;
  });
};

/** Each time gh was run, its arguments. */
export const ghCalls = (): string[][] =>
  fs.readFileSync(log(), "utf8").split("--end--\n").filter(Boolean).map((call) =>
    call.replace(/\n$/, "").split("\n").map((arg) => arg.split(process.env.DESOLATE_HOME!).join("<home>").replace(/issue-[^/]+\//, "issue-<tmp>/")));

/** What `run` rejected with (its message), or null if it did not. */
export const errorOf = async (run: (...args: never[]) => unknown, args: unknown[]): Promise<string | null> => {
  try {
    await (run as (...a: unknown[]) => unknown)(...args);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
};
