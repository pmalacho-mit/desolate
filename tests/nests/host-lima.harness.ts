// Harness for in-source tests of the Lima backend (host/vm/lima.ts): what it hands Lima, read
// without a hypervisor. It stands in for `limactl`: a script of its own, first on PATH for the
// one test, that writes down every call and does nothing else, so what the backend generates
// (a clone's settings, the base VM's configuration, a confined VM's sandbox profile) can be
// read back. No VM is made, and Lima's own home is never touched.
//
// Paths in a spec may start with `<home>`, the test file's own desolate home (a clone makes
// each share's directory on the host); in what comes back, the home, the release folder,
// the architecture and the ports the backend picked are written as `<home>`, `<release>`,
// `<arch>`, `<ssh port>` and `<link port>`, which differ from machine to machine.
//
// Imported by the tests as types only, so nothing here reaches the release.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { onTestFinished } from "vitest";
import type { Backend, VmSpec } from "../../release/host/vm/types.ts";

const home = () => process.env.DESOLATE_HOME!;
const limaHome = () => path.join(home(), "lima");
const bin = () => path.join(home(), "nests-bin");
const log = () => path.join(bin(), "calls");
const release = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "release");
const arch = os.arch() === "arm64" ? "aarch64" : "x86_64";

/** limactl, for this test: every call written down, each argument a line, and done. */
const fakeLimactl = () => {
  if (process.env.DESOLATE_LIMACTL) throw new Error("DESOLATE_LIMACTL is set: the backend would run it, not the stand-in");
  fs.mkdirSync(bin(), { recursive: true });
  fs.writeFileSync(path.join(bin(), "limactl"), `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done >>'${log()}'\nprintf '%s\\n' '--end--' >>'${log()}'\nexit 0\n`, { mode: 0o755 });
  fs.writeFileSync(log(), "");
  const before = process.env.PATH;
  process.env.PATH = `${bin()}:${before}`;
  onTestFinished(() => {
    process.env.PATH = before;
  });
};
const calls = (): string[][] =>
  fs.readFileSync(log(), "utf8").split("--end--\n").filter(Boolean).map((call) => call.replace(/\n$/, "").split("\n"));

const inHome = (spec: VmSpec): VmSpec => {
  const at = (p: string) => p.replace(/^<home>/, home());
  return { ...spec, shares: spec.shares.map((s) => ({ ...s, host: at(s.host) })), sockets: spec.sockets.map((s) => ({ ...s, host: at(s.host) })) };
};
const meta = (name: string) => JSON.parse(fs.readFileSync(path.join(limaHome(), name, "desolate.json"), "utf8")) as { sshPort: number; linkPort: number };
const shown = (text: string, ports?: { sshPort: number; linkPort: number }) => {
  let out = text.split(home()).join("<home>").split(release).join("<release>").split(arch).join("<arch>");
  if (ports) out = out.split(String(ports.sshPort)).join("<ssh port>").split(String(ports.linkPort)).join("<link port>");
  return out;
};

/** What `create` asks of Lima: its one call (`limactl clone`), argument by argument. */
export const cloneCall = async (backend: Backend, spec: VmSpec): Promise<string[]> => {
  fakeLimactl();
  await backend.create(inHome(spec));
  const m = meta(spec.name);
  return calls().map((call) => call.map((arg) => shown(arg, m))).find((call) => call.includes("clone")) ?? [];
};

/** The base VM's configuration, as `ensureImage` writes it for Lima. (The qemu kind needs a
 *  built image: three empty files stand in for it, where the backend looks by default.) */
export const baseYaml = async (backend: Backend): Promise<string> => {
  fakeLimactl();
  const images = path.join(home(), "images", arch);
  fs.mkdirSync(images, { recursive: true });
  for (const file of ["disk.raw", "vmlinuz", "initrd"]) fs.writeFileSync(path.join(images, file), "");
  // (The stand-in makes no VM, so a vz base's stamp has no directory to go in: that is where
  // it stops, after the configuration is written.)
  await backend.ensureImage(() => {}).catch(() => {});
  return shown(fs.readFileSync(path.join(limaHome(), "base.yaml"), "utf8"));
};

/** The sandbox profile a vz VM with no egress is started under (its host process keeps it for
 *  life). On a machine without sandbox-exec the start fails after the profile is written. */
export const confinement = async (backend: Backend, spec: VmSpec): Promise<string> => {
  fakeLimactl();
  await backend.create(inHome(spec));
  await backend.start(spec.name).catch(() => {});
  return shown(fs.readFileSync(path.join(limaHome(), spec.name, "confine.sb"), "utf8"), meta(spec.name));
};

/** A VM an older desolate made: its record has no link token. */
export const madeWithoutLinkToken = (name: string) => {
  fs.mkdirSync(path.join(limaHome(), name), { recursive: true });
  fs.writeFileSync(path.join(limaHome(), name, "desolate.json"), JSON.stringify({ spec: { name, role: "workspace", egress: "none", shares: [], sockets: [], labels: {} }, sshPort: 60022, linkPort: 60023 }));
};
