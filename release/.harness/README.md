# In-source tests (suede.nests)

Beside most functions in `release/` is a `declare namespace` of the same name: tests written
as types, which [suede.nests](../../suede.nests/README.md) prints as Vitest tests. They are
there to be read. A reviewer who meets a function should find, right under it, what it is
given, what it answers, and what it refuses: how it is meant to be used.

```ts
import type { Expect, Invoke, Table } from "../../suede.nests/dsl.import.meta.vitest.ts";

/** "8g", "8gb", "8GiB", "512m", "8192" (MiB): memory in MiB, or null. */
export const parseMemory = (value: unknown): number | null => { ... };

declare namespace parseMemory {
  export type Spellings = Table<typeof parseMemory, [
    [args: [value: "8g"], expected: 8192],
    [args: [value: "512m"], expected: 512],
    [args: [value: "lots"], expected: null],
  ]>;
}
```

```bash
make test                                        # T1, these included
node_modules/.bin/vitest run release/shared/size.ts   # one file's
```

## What ships, and what does not

The tests and this folder ship with the code; suede.nests does not. It is a development
dependency at the root of the development checkout (`suede.nests/`, installed with suede's
installer and `--dev`), which the `release` branch, being `release/` alone, never has. Two
things make that work, and T1's [`release-alone.test.ts`](../../tests/v3/t1/release-alone.test.ts) checks both on a copy of `release/`
taken out of the checkout, each beside a control:

- **At runtime nothing loads.** Every import of the DSL or of a harness is `import type`, and
  a `declare namespace` is a type: node strips them all before it runs a file. So the code
  never loads this folder, and never looks for suede.nests. A value import would survive the
  stripping, so the T1 check refuses one.
- **It still type-checks.** [`release/nests.d.ts`](../nests.d.ts) is suede.nests'
  optional-dependency stub (`bash suede.nests/scripts/install-optional-dependency-stub.sh release`
  writes it; never edit it by hand). Where the real DSL is found, as in the development
  checkout, it is never consulted. The harnesses need Vitest, which the release does not have
  either, so they take it from [`vitest.ts`](vitest.ts), which names it in a way the type
  checker does not follow.

## How to write them

- **One namespace under each function or class it covers, named after it.** The test's name is
  its namespace path (`parseMemory > Spellings`). A function need not be exported: the test is
  in the same module, so `typeof` a private helper works.
- **Each test says what it shows.** A `/** */` line above it, a plain sentence: the claim, in
  the terms of the code's purpose ("a branch an agent may name and the root may carry"), not a
  restatement of the assertion. Name the test by the case (`Refuses`, `ClockWentBack`).
- **Name every argument:** `[value: "8g"]`, as the function names its parameters.
- **The usual case first, then the edges, then the refusals.** A function that guards a
  boundary (a name that becomes a path, a branch that becomes an argv word, text from a
  domain) gets the inputs that try to break it, beside one that passes, so a reader can see
  the test would notice.
- **`Table` for many inputs to one function**, `Expect` with `"="` for one whole value,
  `"matches"` when only some fields matter, `Throws` for what refuses by throwing.
- **Effects first with `Given`.** For code that keeps state under the desolate home:

  ```ts
  export type RemovesTheTokens = Given<
    [Invoke<typeof emptyHome>, Invoke<typeof writeState, [name: "ui-token", text: "u"]>, Invoke<typeof retire>],
    Expect<Invoke<typeof stateFiles>, "=", ["tokens-retired"]>
  >;
  ```

  Each test file has a home of its own ([`setup.ts`](setup.ts) sets `DESOLATE_HOME` before
  anything is imported); its tests run one after another and share it, so a test that needs
  it empty starts with `emptyHome`.
- **Anything a type cannot say goes in a harness:** an ordinary function in
  `release/.harness/<area>-<module>.ts`, imported `import type` (`env.ts`, `home.ts` and
  `refusal.ts` are for any area). Vitest's functions come from `./vitest.ts`, never from
  `"vitest"`. A harness says in a comment what it stands in for. Keep them small; one that
  grows a second purpose is two harnesses.
- **Leave out what needs a VM, Docker, the network or a real git remote.** That is T1's and
  T2's (`tests/v3`), whose node:test files stay where they are. An in-source test runs in
  milliseconds, on any machine, and touches nothing outside the test file's home.
- **Make code testable without changing what it does.** The printer serves a test the whole
  module's top-level code, so a script that runs as soon as it is imported (a loop, stdin,
  `process.exit`) cannot be tested until its running is guarded:

  ```ts
  if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
  ```

  (`realpathSync`: several are run through a link or a wrapper.) A decision buried in a
  closure (a request's route, a token check) is lifted to a top-level function of what it
  decides on, and the closure calls it. Neither changes behaviour, and the tiers that run the
  real thing (T2, and T4 for a boundary) say so. A refactor that changes behaviour is a
  change of its own, never a test's.
