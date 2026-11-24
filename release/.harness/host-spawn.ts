// Harness for in-source tests of the host's check of a workspace's spawn and close requests
// (host/spawn.ts). It stands in for the two things a request needs that a type cannot write:
// the workspace VM's key, as the host keeps it (state/workspace-keys/<vm>, under the test
// file's own home), and the request's signature, made with a key as the workspace would make
// it (shared/spawn.ts). And for the backend's word on which VMs exist.
import * as fs from "node:fs";
import * as path from "node:path";
import { INSTANCE } from "../host/paths.ts";
import { workspaceVmName } from "../shared/names.ts";
import { sign } from "../shared/spawn.ts";
import type { Signed } from "../shared/spawn.ts";

/** The host made this workspace's VM, with this key.
 *  @standsIn the host's record of a workspace's key (made with its VM)
 *  @realIn T2 16-spawn, "the root's ordinary user cannot make one: a request without the workspace's key is refused by the host" */
export const giveKey = (domain: string, workspace: string, key: string) => {
  const dir = path.join(process.env.DESOLATE_HOME!, "state", "workspace-keys");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, workspaceVmName(INSTANCE, domain, workspace)), `${key}\n`);
};

/** The request, as a workspace holding `key` signs it. */
export const signed = (key: string, request: Signed): Signed & { mac: string } => ({
  ...request,
  mac: sign(key, request),
});

/** The backend's answer to "does this VM exist?": every one does, or none does. */
export const everyVmExists = (_vm: string) => true;
export const noVmExists = (_vm: string) => false;

/** The backend's list of VMs, for a check that asks for it: none; or one that must not be
 *  asked for, and fails the test that asks. */
export const noVms = async (): Promise<string[]> => [];
export const neverListed = async (): Promise<string[]> => {
  throw new Error("the VMs were listed");
};
