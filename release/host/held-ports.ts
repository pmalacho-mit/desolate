// Ports a dev server commonly uses that a program on this Mac already holds, for
// `desolate doctor` to say. A workspace's server on such a port is not forwarded, and its
// address on that port reaches the Mac's program: on a Mac shared with other people, another
// user's (dogfooding, 2026-11-16: another user's Colima held 3000, and a workspace's address
// on 3000 answered with that user's own desolate's error page).
//
// Held is what the forwarder itself would meet: a bind of 127.0.0.1:<port> refused. desolate's
// own daemon (which holds the ports it forwards) is not counted.
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { createServer } from "node:net";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type {
  Expect,
  Given,
  Invoke,
  Table,
  Throws,
} from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { setEnv } from "../.harness/env.ts";
import { define, ports, valueOf } from "../shared/settings.ts";
import type { Parse } from "../shared/settings.ts";
import { printable } from "../shared/text.ts";

/** Ports a dev server commonly uses: what doctor looks at unless the person names others. */
export const DEV_PORTS = [3000, 3001, 4200, 5000, 5173, 5174, 8000, 8080, 8888];

/** `none`, or a list of ports as settings.ts's `ports` reads it (each from PORTS.min to
 *  PORTS.max, the whole list refused for one that is not). */
const portsOrNone: Parse<number[]> = Object.assign(
  (text: string) => (text.trim() === "none" ? [] : ports(text)),
  { takes: `none, or ${ports.takes}` },
);

declare namespace portsOrNone {
  /** a list, or none at all; one port that the forwarder would never forward and the whole
   *  list is refused (it once dropped it, and doctor looked at less than it was asked to) */
  export type Reads = Table<
    typeof portsOrNone,
    [
      [args: [text: "3000, 9000"], expected: [3000, 9000]],
      [args: [text: " none "], expected: []],
      [args: [text: "3000, 80, 9000"], expected: null],
      [args: [text: "1023"], expected: null],
      [args: [text: "1024,65535"], expected: [1024, 65535]],
    ]
  >;
}

export const DOCTOR_PORTS = define({
  name: "doctor.ports",
  env: "DESOLATE_DOCTOR_PORTS",
  side: "host",
  default: DEV_PORTS,
  parse: portsOrNone,
  why: "The ports `desolate doctor` checks for a program of this Mac's holding them (a workspace's dev server there would not be forwarded); none checks none, as the tests do, since what a Mac holds differs from Mac to Mac.",
});

/** The ports doctor looks at: the setting's (DOCTOR_PORTS). The argument is not read: the
 *  registry reads the variable (bootstrap.ts still passes it; it can stop). */
export const portsToCheck = (_variable?: string): number[] => valueOf(DOCTOR_PORTS);

declare namespace portsToCheck {
  /** the common ones by default; none, or a list, when asked */
  export type Choice = [
    Given<
      Invoke<typeof setEnv, [name: "DESOLATE_DOCTOR_PORTS", value: null]>,
      Expect<
        Invoke<typeof portsToCheck>,
        "=",
        [3000, 3001, 4200, 5000, 5173, 5174, 8000, 8080, 8888]
      >
    >,
    Given<
      Invoke<typeof setEnv, [name: "DESOLATE_DOCTOR_PORTS", value: "none"]>,
      Expect<Invoke<typeof portsToCheck>, "=", []>
    >,
    Given<
      Invoke<typeof setEnv, [name: "DESOLATE_DOCTOR_PORTS", value: "5173,3000"]>,
      Expect<Invoke<typeof portsToCheck>, "=", [5173, 3000]>
    >,
  ];
  /** a list with a port the forwarder never forwards is refused, saying what it takes */
  export type Refused = Given<
    Invoke<typeof setEnv, [name: "DESOLATE_DOCTOR_PORTS", value: "3000,80"]>,
    Throws<
      Invoke<typeof portsToCheck>,
      "DESOLATE_DOCTOR_PORTS must be none, or ports from 1024 to 65535, separated by commas, not '3000,80'"
    >
  >;
}

/** What holds a port, from lsof's `-Fcp` lines: its pid when lsof names it, and what the
 *  person is told. (macOS gives a command at most 16 characters: only made safe to show.) */
export const holderIn = (found: string): { pid: string | null; by: string } => {
  const pid = /^p(\d+)/m.exec(found)?.[1] ?? null;
  const command = /^c(.+)/m.exec(found)?.[1];
  return {
    pid,
    by:
      pid && command
        ? `${printable(command)}, pid ${pid}`
        : "not a program of yours: another user's, or the system's",
  };
};

declare namespace holderIn {
  /** lsof sees only this user's programs: one it cannot name is another user's, or the
   *  system's. A program's name is shown as text */
  export type Holders = Table<
    typeof holderIn,
    [
      [args: [found: "p4242\ncnode\n"], expected: { pid: "4242"; by: "node, pid 4242" }],
      [
        args: [found: ""],
        expected: { pid: null; by: "not a program of yours: another user's, or the system's" },
      ],
      [args: [found: "p1\nc\u001b[31mevil\n"], expected: { pid: "1"; by: "?[31mevil, pid 1" }],
    ]
  >;
}

/** What holds a port on this Mac, as this user's lsof sees it: the one lookup, for doctor
 *  and the daemon alike. In the background, never blocking: run while the forwarder waited,
 *  it held up every timer, and a 400 ms sniff ended before bytes already sent were read (T2
 *  03, 2026-11-16). Three seconds, past which lsof is stopped and the holder is not named. */
export const portHolder = (port: number): Promise<{ pid: string | null; by: string }> =>
  new Promise((resolve) =>
    execFile(
      "lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fcp"],
      { encoding: "utf8", timeout: 3000 },
      (_error, found) => resolve(holderIn(found ?? "")),
    ),
  );

const refusedOn = (port: number, host: string) =>
  new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once("error", (error: NodeJS.ErrnoException) => resolve(error.code === "EADDRINUSE"));
    server.listen(
      { port, host, exclusive: true, ...(host === "::1" ? { ipv6Only: true } : {}) },
      () => server.close(() => resolve(false)),
    );
  });
/** As the forwarder meets it: on 127.0.0.1, or on ::1 (where browsers also look). */
const refused = async (port: number) =>
  (await refusedOn(port, "127.0.0.1")) || (await refusedOn(port, "::1"));

/** Each port of `ports` that a program other than desolate's daemon holds, and what holds it. */
export const heldPorts = async (
  ports: number[],
  daemonPidFile: string,
): Promise<{ port: number; by: string }[]> => {
  let ours: string | null = null;
  try {
    ours = fs.readFileSync(daemonPidFile, "utf8").trim();
  } catch {
    /* no daemon */
  }
  const held: { port: number; by: string }[] = [];
  for (const port of ports) {
    if (!(await refused(port))) continue;
    const { pid, by } = await portHolder(port);
    if (pid && pid === ours) continue;
    held.push({ port, by });
  }
  return held;
};
