// Harness for root/approvals.ts: a raw push's request as root/raw-push.ts writes it, naming
// the process that waits for its answer.
import { spawnSync } from "node:child_process";
import { startOf } from "../shared/lock.ts";
import { writeJsonIn } from "./root-state.ts";

/** A request in the root's approvals directory, `value` and its writer: this test's own
 *  process, which is alive ("waiting"); one that has ended ("ended"); or a live pid that is
 *  not the process that wrote it, as when a pid is used again ("another"). */
export const aRequestIn = (
  name: string,
  writer: "waiting" | "ended" | "another",
  value: Record<string, unknown>,
) => {
  const pid = writer === "ended" ? spawnSync("true").pid : process.pid;
  const start = writer === "waiting" ? startOf(pid) : "not when it started";
  writeJsonIn("state", `approvals/${name}`, { ...value, pid, start });
};
