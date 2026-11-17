// Harness for in-source tests of the host's check of a workspace's spawn and close requests
// (host/spawn.ts). It stands in for the two things a request needs that a type cannot write:
// the workspace VM's key, as the host keeps it (state/workspace-keys/<vm>, under the test
// file's own home), and the request's signature, made with a key as the workspace would make
// it (shared/spawn.ts). And for the backend's word on which VMs exist.
//
// Imported by the tests as types only, so nothing here reaches the release.
import * as fs from "node:fs";
import * as path from "node:path";
import { INSTANCE } from "../../release/host/paths.ts";
import { workspaceVmName } from "../../release/shared/names.ts";
import { sign } from "../../release/shared/spawn.ts";
import type { Signed } from "../../release/shared/spawn.ts";

/** The host made this workspace's VM, with this key. */
export const giveKey = (domain: string, workspace: string, key: string) => {
  const dir = path.join(process.env.DESOLATE_HOME!, "state", "workspace-keys");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, workspaceVmName(INSTANCE, domain, workspace)), `${key}\n`);
};

/** The request, as a workspace holding `key` signs it. */
export const signed = (key: string, request: Signed): Signed & { mac: string } => ({ ...request, mac: sign(key, request) });

/** The backend's answer to "does this VM exist?": every one does, or none does. */
export const everyVmExists = (_vm: string) => true;
export const noVmExists = (_vm: string) => false;
