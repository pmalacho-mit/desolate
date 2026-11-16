# In-source tests (suede.nests)

Beside most functions in `release/` is a `declare namespace` of the same name: tests written
as types, which [suede.nests](../../.suede/nests/README.md) prints as Vitest tests. They are
there to be read. A reviewer who meets a function should find, right under it, what it is
given, what it answers, and what it refuses: how it is meant to be used.

```ts
import type { Expect, Invoke, Table } from "../../.suede/nests/dsl.import.meta.vitest.ts";

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

## Nothing of this ships

`.suede/nests` and this folder are in the development checkout only. The `release` branch is
`release/`, which has neither. Two things make that work, and T1's `release-alone.test.ts`
checks both on a copy of `release/` taken out of the checkout, each beside a control:

- **At runtime there is nothing to find.** Every import of the DSL or of a harness is
  `import type`, and a `declare namespace` is a type: node strips them all before it runs a
  file. A value import would survive the stripping and fail in the release, so the T1 check
  refuses one.
- **It still type-checks.** [`release/nests.d.ts`](../../release/nests.d.ts) is suede.nests'
  optional-dependency stub (`bash .suede/nests/scripts/install-optional-dependency-stub.sh release`
  writes it; never edit it by hand), and [`release/nests-harness.d.ts`](../../release/nests-harness.d.ts)
  does the same for `*.harness.ts`. Where the real file is found, as here, they are never
  consulted.

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
  `tests/nests/<area>.harness.ts`, imported `import type`. A harness says in a comment what it
  stands in for. Keep them small; one that grows a second purpose is two harnesses.
- **Leave out what needs a VM, Docker, the network or a real git remote.** That is T1's and
  T2's (`tests/v3`), whose node:test files stay where they are. An in-source test runs in
  milliseconds, on any machine, and touches nothing outside the test file's home.
- **Do not change what the code does to make it testable.** Testing a private helper is fine;
  moving code around only for a test is not.
