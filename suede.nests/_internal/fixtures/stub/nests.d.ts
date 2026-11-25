// A consumer's stub, written before the DSL grew: it declares only the first exports.
declare module "*/dsl.import.meta.vitest" {
  export namespace Internal {}
  export type Invoke<F = any, Args = any> = any;
  export type Expect<A = any, Condition = any, Expected = any> = any;
}
declare module "*/dsl.import.meta.vitest.ts" {
  export namespace Internal {}
  export type Invoke<F = any, Args = any> = any;
  export type Expect<A = any, Condition = any, Expected = any> = any;
}
