// Small JSON file helpers. Writes are atomic (temp file + rename) because other VMs and the
// host read these files as data, possibly while they are being replaced.
import * as fs from "node:fs";
import * as path from "node:path";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Given, Invoke, Table } from "../../.suede/nests/dsl.import.meta.vitest.ts";
import type { emptyScratch, readScratch, scratch, scratchFiles, writeScratch } from "../../tests/nests/shared-files.harness.ts";

export const readJson = <T>(file: string, fallback: T): T => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
};

declare namespace readJson {
  /** what another side wrote, parsed */
  export type Reads = Given<
    [Invoke<typeof emptyScratch>, Invoke<typeof writeScratch, [name: "state.json", text: '{"offers":[1]}']>],
    Expect<Invoke<typeof readJson, [file: Invoke<typeof scratch, [name: "state.json"]>, fallback: null]>, "=", { offers: [1] }>
  >;
  /** a file that is not there yet, or one caught half written: the fallback, never a throw */
  export type Fallback = Given<
    [Invoke<typeof emptyScratch>, Invoke<typeof writeScratch, [name: "torn.json", text: '{"offers":[']>],
    [
      Expect<Invoke<typeof readJson, [file: Invoke<typeof scratch, [name: "missing.json"]>, fallback: { offers: [] }]>, "=", { offers: [] }>,
      Expect<Invoke<typeof readJson, [file: Invoke<typeof scratch, [name: "torn.json"]>, fallback: { offers: [] }]>, "=", { offers: [] }>,
    ]
  >;
}

export const writeJson = (file: string, value: unknown, mode = 0o644) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode });
  fs.renameSync(temp, file);
};

declare namespace writeJson {
  /** indented, a newline at the end, its directory made, and no temporary file left beside it */
  export type Writes = Given<
    [Invoke<typeof emptyScratch>, Invoke<typeof writeJson, [file: Invoke<typeof scratch, [name: "inbox/state.json"]>, value: { a: [1, "x"] }]>],
    [
      Expect<Invoke<typeof readScratch, [name: "inbox/state.json"]>, "=", '{\n  "a": [\n    1,\n    "x"\n  ]\n}\n'>,
      Expect<Invoke<typeof scratchFiles, [dir: "inbox"]>, "=", ["state.json"]>,
    ]
  >;
  /** a longer file before it is replaced whole: nothing of it is left after the new one's end */
  export type Replaces = Given<
    [
      Invoke<typeof emptyScratch>,
      Invoke<typeof writeScratch, [name: "state.json", text: '{"old":true,"longer":"than the new one"}']>,
      Invoke<typeof writeJson, [file: Invoke<typeof scratch, [name: "state.json"]>, value: { new: true }]>,
    ],
    Expect<Invoke<typeof readJson, [file: Invoke<typeof scratch, [name: "state.json"]>, fallback: null]>, "=", { new: true }>
  >;
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

declare namespace isRecord {
  /** an object with fields: not null, and not a list, which typeof also calls an object */
  export type Cases = Table<typeof isRecord, [
    [args: [value: { a: 1 }], expected: true],
    [args: [value: {}], expected: true],
    [args: [value: null], expected: false],
    [args: [value: [1, 2]], expected: false],
    [args: [value: "{}"], expected: false],
  ]>;
}
