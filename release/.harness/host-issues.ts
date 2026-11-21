// Harness for the in-source tests of the issue-publish lock (host/issues.ts): another publish
// under way, in a process that is alive, and one that crashed holding the lock. The lock is
// written as shared/lock.ts writes it (the lock's own harness does the writing).
import * as path from "node:path";
import { heldBy, leftByADeadProcess } from "./shared-lock.ts";

const lock = () => path.join(process.env.DESOLATE_HOME!, "state", "issues-publish.lock");

/** Another publish is under way: the lock is held by a process that is alive (this one). */
export const publishUnderWay = () => heldBy(lock(), "this process", "2026-11-21T08:00:00.000Z");

/** A publish crashed holding the lock: its process is gone, however recently. */
export const publishLeftByACrash = () => leftByADeadProcess(lock());

/** Why `publish` refused, with the holder's pid written `<pid>` (it is this test's own). */
export const refusedAs = async (publish: (issue: never) => Promise<string>, issue: unknown) => {
  try {
    await publish(issue as never);
    return null;
  } catch (error) {
    return (error as Error).message.replace(/process [0-9]+/, "process <pid>");
  }
};
