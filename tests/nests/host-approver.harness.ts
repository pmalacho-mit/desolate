// Harness for in-source tests of the approver (host/approver.ts). It stands in for the root's
// keyring, which checks a signature against the public key the host gave it (here, read from
// the test file's own home), and for a look at the approver's files there.
//
// Imported by the tests as types only, so nothing here reaches the release.
import { createPublicKey, verify } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const inHome = (name: string) => path.join(process.env.DESOLATE_HOME!, name);

/** Whether the keyring would take `signature` as the approver's, over exactly `message`. */
export const keyringTakes = (message: string, signature: string): boolean =>
  verify("sha256", Buffer.from(message), createPublicKey(fs.readFileSync(inHome("approver/approver.pub"), "utf8")), Buffer.from(signature, "base64"));

/** A file's permission bits, under the home (0o600 is 384). */
export const modeOf = (name: string): number => fs.statSync(inHome(name)).mode & 0o777;

/** A file under the home, as something before the test left it. */
export const writeInHome = (name: string, text: string) => {
  fs.mkdirSync(path.dirname(inHome(name)), { recursive: true });
  fs.writeFileSync(inHome(name), text);
};
