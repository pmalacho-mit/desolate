import type { Expect, Invoke } from "../../../dsl.import.meta.vitest.ts";

export const add = (a: number, b: number) => a + b;

declare namespace add {
  /** four and five */
  export type Sum = Expect<Invoke<typeof add, [a: 4, b: 5]>, "=", 9>;
}
