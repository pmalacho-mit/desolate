// `desolate domain stats`: where a domain's workspaces stand, for a person on the Mac and for
// an agent in one of them. The root writes it into the domain's inbox (root/stated.ts), which
// the domain reads and cannot write; both CLIs print it with statsLines.
//
// Only the domain's own things: its workspaces, who started each, its limit, and this Mac's
// size and what its running workspaces take of it. Nothing of another domain, and no address
// that carries a token (an editor's).
import { printable } from "./text.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Invoke, Table } from "../../suede.nests/dsl.import.meta.vitest.ts";

export type Stats = {
  v: 1;
  domain: string;
  title: string;
  repos: string[];
  at: string;
  spawn: { max: number | null; used: number };
  mac: { cpus: number; memoryMiB: number } | null;
  running: { workspaces: number; memoryMiB: number };
  workspaces: {
    workspace: string;
    state: string;
    vm: string | null;
    startedBy: string | null;
    outlived: boolean;
    size: { cpus: number; memoryMiB: number; diskGiB: number } | null;
    checkouts: { repo: string; branch: string; head: string | null }[];
    status: { color: string; message: string } | null;
  }[];
};

const gib = (mib: number) => `${(mib / 1024).toFixed(mib % 1024 === 0 ? 0 : 1)} GiB`;

/** The stats as lines of text. What is in them was written by the root, and the status
 *  messages and branch names by the domain's agents: each made printable. Nothing is cut
 *  for width (R1): each name is bounded where it is made (a slug, a branch, a repository, a
 *  status: shared/limits.ts NAMES), and a terminal wraps a long line. printable's own
 *  bound, against a flood, is the only one. */
export const statsLines = (value: unknown): string[] => {
  const s = (typeof value === "object" && value !== null ? value : {}) as Partial<Stats>;
  const p = (text: unknown) => printable(text);
  const lines = [
    `domain ${p(s.domain)}  "${p(s.title)}"  ${(s.repos ?? []).map((r) => p(r)).join(", ")}`,
  ];
  const mac =
    s.mac && Number.isFinite(s.mac.memoryMiB)
      ? `this Mac: ${Number(s.mac.cpus)} CPUs, ${gib(Number(s.mac.memoryMiB))}; `
      : "";
  lines.push(
    `  ${mac}running here: ${Number(s.running?.workspaces ?? 0)} workspace(s), ${gib(Number(s.running?.memoryMiB ?? 0))} given to them`,
  );
  const max = s.spawn?.max === null || s.spawn?.max === undefined ? null : Number(s.spawn.max);
  const used = Number(s.spawn?.used ?? 0);
  lines.push(
    max === 0
      ? "  its workspaces cannot start workspaces: the person turned it off"
      : max === null
        ? `  started by workspaces: ${used}, no limit (desolate spawn; start one only when the work needs it)`
        : `  started by workspaces: ${used} of at most ${max} (desolate spawn; each counts until removed)`,
  );
  for (const w of s.workspaces ?? []) {
    const size = w.size ? `  ${Number(w.size.cpus)} CPU, ${gib(Number(w.size.memoryMiB))}` : "";
    const by = w.startedBy
      ? `started by ${p(w.startedBy)}${w.outlived ? " (since removed: this one outlived it)" : ""}`
      : "started by the person";
    lines.push(`  ${p(w.workspace)}  ${p(w.vm ?? w.state)}${size}  ${by}`);
    for (const c of w.checkouts ?? []) lines.push(`      ${p(c.repo)}  ${p(c.head ?? c.branch)}`);
    if (w.status) lines.push(`      status ${p(w.status.color)}: ${p(w.status.message)}`);
  }
  return lines;
};

declare namespace statsLines {
  /** what is not there is said as such, and a status an agent wrote is printable text */
  export type Empty = Table<
    typeof statsLines,
    [
      [
        args: [value: null],
        expected: [
          'domain   ""  ',
          "  running here: 0 workspace(s), 0 GiB given to them",
          "  started by workspaces: 0, no limit (desolate spawn; start one only when the work needs it)",
        ],
      ],
    ]
  >;
  /** a domain at work: the Mac and what its workspaces take of it, the limit, and each
   *  workspace with who started it, what each checkout has checked out (its branch when HEAD
   *  is not known), and its status, made printable */
  export type AtWork = Expect<
    Invoke<
      typeof statsLines,
      [
        value: {
          v: 1;
          domain: "acme";
          title: "Acme work";
          repos: ["acme/app", "acme/lib"];
          at: "2026-11-16T10:00:00Z";
          spawn: { max: 4; used: 1 };
          mac: { cpus: 10; memoryMiB: 65536 };
          running: { workspaces: 2; memoryMiB: 12288 };
          workspaces: [
            {
              workspace: "w1";
              state: "up";
              vm: "running";
              startedBy: null;
              outlived: false;
              size: { cpus: 4; memoryMiB: 8192; diskGiB: 30 };
              checkouts: [{ repo: "acme/app"; branch: "main"; head: "issue/12" }];
              status: { color: "green"; message: "tests pass\u001b[2J" };
            },
            {
              workspace: "helper";
              state: "stopped";
              vm: null;
              startedBy: "w0";
              outlived: true;
              size: { cpus: 2; memoryMiB: 4608; diskGiB: 30 };
              checkouts: [{ repo: "acme/lib"; branch: "task/x"; head: null }];
              status: null;
            },
          ];
        },
      ]
    >,
    "=",
    [
      'domain acme  "Acme work"  acme/app, acme/lib',
      "  this Mac: 10 CPUs, 64 GiB; running here: 2 workspace(s), 12 GiB given to them",
      "  started by workspaces: 1 of at most 4 (desolate spawn; each counts until removed)",
      "  w1  running  4 CPU, 8 GiB  started by the person",
      "      acme/app  issue/12",
      "      status green: tests pass?[2J",
      "  helper  stopped  2 CPU, 4.5 GiB  started by w0 (since removed: this one outlived it)",
      "      acme/lib  task/x",
    ]
  >;
  /** a limit of 0 is the person's no, said as such */
  export type TurnedOff = Expect<
    Invoke<
      typeof statsLines,
      [value: { domain: "acme"; title: "t"; repos: []; spawn: { max: 0; used: 0 } }]
    >,
    "includes",
    "  its workspaces cannot start workspaces: the person turned it off"
  >; /** a branch of 160 characters (desolate carries 200) is shown whole: it was bounded where
   *  it was made, and the terminal wraps it (until 2026-11-21 it was cut at 120, unsaid) */
  export type WholeBranch = Expect<
    Invoke<
      typeof statsLines,
      [
        value: {
          domain: "acme";
          workspaces: [
            {
              workspace: "w1";
              state: "up";
              checkouts: [
                {
                  repo: "acme/app";
                  branch: "feature/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
                  head: null;
                },
              ];
            },
          ];
        },
      ]
    >,
    "includes",
    "      acme/app  feature/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
  >;
}
