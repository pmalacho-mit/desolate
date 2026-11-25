import { save } from "./store.ts";
import type { Expect, Invoke } from "../../../dsl.import.meta.vitest.ts";
import type { fakeItems } from "./harness.ts";
import type { load } from "./store.ts";

export const keepAll = (xs: string[]) => xs.reduce(save, [] as string[]);

declare namespace keepAll {
  /** every item is kept, in order */
  export type Kept = Expect<
    Invoke<typeof keepAll, [xs: Invoke<typeof fakeItems, [count: 2]>]>,
    "=",
    ["a", "b"]
  >;
  /** none kept, none loaded */
  export type Loaded = Expect<Invoke<typeof load>, "=", []>;
}
