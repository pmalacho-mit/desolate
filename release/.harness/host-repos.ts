// Harness for in-source tests of clone and keys (host/repos.ts). Besides the root (host-stack.ts)
// it stands in for two things:
//
//   - the root VM's keyring, read as root: `standInStack`'s backend runs only `cat -- <file>`,
//     as root, in the root VM, and prints what `keyringHolds` left for that file. Anything
//     else (another command, another VM, not as root, another file) fails as cat would.
//   - the stand-in forge's admin command (DESOLATE_FORGE_ADMIN): `forgeAdmin` puts a script
//     under the test file's home that writes down each call, and `forgeGot` reads them.
import * as fs from "node:fs";
import * as path from "node:path";
import { fakeStack } from "./host-stack.ts";
import { onTestFinished } from "./vitest.ts";

const file = (name: string) => path.join(process.env.DESOLATE_HOME!, `nests-repos-${name}`);

/** What the keyring's files hold, by their path in the root VM, from now on in this test. */
export const keyringHolds = (files: Record<string, string>) =>
  fs.writeFileSync(file("keyring.json"), JSON.stringify(files));

/** host/stack.ts for a stack on the stand-in forge, whose root VM has only the keyring above. */
export const standInStack = {
  ...fakeStack,
  config: () => ({ backend: "fake", forge: { kind: "stand-in" } }),
  backend: () => ({
    exec: async (vm: string, argv: string[], options: { root?: boolean } = {}) => {
      let files: Record<string, string> = {};
      try {
        files = JSON.parse(fs.readFileSync(file("keyring.json"), "utf8"));
      } catch {}
      const [command, dashes, at, ...more] = argv;
      if (
        vm !== fakeStack.ROOT_VM ||
        !options.root ||
        command !== "cat" ||
        dashes !== "--" ||
        more.length > 0 ||
        !(at! in files)
      )
        return { code: 1, stdout: "", stderr: `cat: ${at}: No such file or directory` };
      return { code: 0, stdout: files[at!], stderr: "" };
    },
  }),
};

/** The stand-in forge's admin, for this test: it takes every call and writes it down. */
export const forgeAdmin = () => {
  fs.writeFileSync(file("forge-calls"), "");
  fs.writeFileSync(file("forge"), `#!/bin/sh\nprintf '%s\\n' "$*" >>'${file("forge-calls")}'\n`, {
    mode: 0o755,
  });
  const before = process.env.DESOLATE_FORGE_ADMIN;
  process.env.DESOLATE_FORGE_ADMIN = file("forge");
  onTestFinished(() => {
    if (before === undefined) delete process.env.DESOLATE_FORGE_ADMIN;
    else process.env.DESOLATE_FORGE_ADMIN = before;
  });
};

/** Each call the forge's admin was given, its arguments joined by spaces. */
export const forgeGot = (): string[] =>
  fs.readFileSync(file("forge-calls"), "utf8").split("\n").filter(Boolean);
