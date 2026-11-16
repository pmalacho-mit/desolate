// Ports a dev server commonly uses that a program on this Mac already holds, for
// `desolate doctor` to say. A workspace's server on such a port is not forwarded, and its
// address on that port reaches the Mac's program: on a Mac shared with other people, another
// user's (dogfooding, 2026-11-16: another user's Colima held 3000, and a workspace's address
// on 3000 answered with that user's own desolate's error page).
//
// Held is what the forwarder itself would meet: a bind of 127.0.0.1:<port> refused. desolate's
// own daemon (which holds the ports it forwards) is not counted.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createServer } from "node:net";
import type { Table } from "../.suede/nests/dsl.import.meta.vitest.ts";
import { printable } from "../shared/text.ts";

export const DEV_PORTS = [3000, 3001, 4200, 5000, 5173, 5174, 8000, 8080, 8888];

/** DESOLATE_DOCTOR_PORTS: a comma list of ports, or `none` (the tests: what a Mac holds is
 *  not the same on every Mac, and doctor's output is in their transcripts). */
export const portsToCheck = (value: string | undefined): number[] =>
  value === undefined ? DEV_PORTS : value.trim() === "none" ? [] : value.split(",").map((p) => Number(p.trim())).filter((p) => Number.isInteger(p) && p >= 1024 && p <= 65535);

declare namespace portsToCheck {
  /** the common ones by default; none, or a list, when asked */
  export type Choice = Table<typeof portsToCheck, [
    [args: [value: undefined], expected: [3000, 3001, 4200, 5000, 5173, 5174, 8000, 8080, 8888]],
    [args: [value: "none"], expected: []],
    [args: [value: "3000, 80, x, 9000"], expected: [3000, 9000]],
  ]>;
}

const refusedOn = (port: number, host: string) =>
  new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once("error", (error: NodeJS.ErrnoException) => resolve(error.code === "EADDRINUSE"));
    server.listen({ port, host, exclusive: true, ...(host === "::1" ? { ipv6Only: true } : {}) }, () => server.close(() => resolve(false)));
  });
/** As the forwarder meets it: on 127.0.0.1, or on ::1 (where browsers also look). */
const refused = async (port: number) => (await refusedOn(port, "127.0.0.1")) || (await refusedOn(port, "::1"));

/** Each port of `ports` that a program other than desolate's daemon holds, and what holds it. */
export const heldPorts = async (ports: number[], daemonPidFile: string): Promise<{ port: number; by: string }[]> => {
  let ours: string | null = null;
  try {
    ours = fs.readFileSync(daemonPidFile, "utf8").trim();
  } catch {
    /* no daemon */
  }
  const held: { port: number; by: string }[] = [];
  for (const port of ports) {
    if (!(await refused(port))) continue;
    const found = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fcp"], { encoding: "utf8", timeout: 3000 }).stdout ?? "";
    const pid = /^p(\d+)/m.exec(found)?.[1];
    if (pid && pid === ours) continue;
    const command = /^c(.+)/m.exec(found)?.[1];
    held.push({ port, by: pid && command ? `${printable(command, 40)}, pid ${pid}` : "not a program of yours: another user's, or the system's" });
  }
  return held;
};
