import { fileURLToPath } from "node:url";

import { DISPLAY } from "../codec.mts";
import { importPath } from "../paths.mts";
import {
  awaits,
  children,
  DSL_KINDS,
  exprsOf,
  exprsOfTest,
  namesIn,
  placed,
  some,
  started,
} from "./ir.mts";

import type { Assertion as VitestAssertion } from "vitest";
import type { Line } from "./context.mts";
import type {
  Assertion,
  Binding,
  ConditionName,
  Expr,
  ModuleMock,
  Param,
  Replacement,
  Setup,
  Statement,
  TestCase,
} from "./ir.mts";

import type {
  AdvanceTimers,
  Call,
  Caught,
  FakeTimers,
  Given,
  Table,
  Expect,
  Invoke,
  Throws,
} from "../../dsl.import.meta.vitest.ts";
import type {
  aStore,
  aThenable,
  failsLater,
  later,
  moduleWarnings,
  printAlias,
  printMatcher,
  printStatements,
  syntaxErrorsIn,
} from "../../_internal/harness.mts";

const quote = (s: string) => JSON.stringify(s);

const isIdentifier = (name: string) => /^[A-Za-z_$][\w$]*$/.test(name);

const propKey = (name: string) => (isIdentifier(name) ? name : quote(name));

// with `await` or `new` in front, a member access needs parentheses
const needsParens = (e: Expr) =>
  e.kind === "construct" || ("awaited" in e && e.awaited);

const receiver = (e: Expr) =>
  needsParens(e) ? `(${printExpr(e)})` : printExpr(e);

const list = (args: Expr[]) => args.map(printExpr).join(", ");

export function printExpr(e: Expr): string {
  switch (e.kind) {
    case "string":
      return quote(e.value);
    case "literal":
      return e.source;
    case "array":
      return `[${list(e.elements)}]`;
    case "object":
      return e.entries.length
        ? `{ ${e.entries.map(([k, v]) => `${propKey(k)}: ${printExpr(v)}`).join(", ")} }`
        : "{}";
    case "name":
      return e.pending ? `await ${e.pending}` : e.name;
    case "call":
      return `${e.awaited ? "await " : ""}${receiver(e.callee)}(${list(e.args)})`;
    case "construct":
      return `new ${receiver(e.callee)}(${list(e.args)})`;
    case "method":
      return `${e.awaited ? "await " : ""}${receiver(e.receiver)}${member(e.method)}(${list(e.args)})`;
    case "index":
      // `!`: type-level X[0] is never undefined; value-level x[0] may be under noUncheckedIndexedAccess
      return typeof e.key === "number"
        ? `${receiver(e.object)}[${e.key}]!`
        : `${receiver(e.object)}${member(e.key)}`;
    case "file": {
      const url = fileUrl(printExpr(e.path));
      return e.format === "bytes"
        ? `new Uint8Array(readFileSync(${url}))`
        : e.format === "json"
          ? `JSON.parse(readFileSync(${url}, "utf8"))`
          : `readFileSync(${url}, "utf8")`;
    }
    case "env":
      return e.fallback
        ? `(process.env[${quote(e.name)}] ?? ${printExpr(e.fallback)})`
        : `nt_env(${quote(e.name)})`;
    case "snapshot":
      return "undefined"; // only `"="` gives a snapshot a meaning; see `matchers`
    case "paren":
      return `(${printExpr(e.inner)})`;
    case "mocked":
      return `vi.mocked(${printExpr(e.inner)})`;
    case "caught":
      // a rejection is caught by awaiting it, so an awaited expression is caught in an async thunk
      // started and not yet awaited, the thunk is still async
      return `${e.awaited ? "await " : ""}nt.caught(${awaits(e.inner) ? "async " : ""}() => (${printExpr(e.inner)}), ${quote(e.source)})`;
    case "spy":
      return `vi.fn(${e.impl ? printExpr(e.impl) : ""})`;
    case "calls":
      return `${receiver(e.spy)}.mock.calls`;
    case "tempDir":
      return `nt.tempDir(${printExpr(e.files)})`;
    case "exists":
      return `nt.exists(${printExpr(e.path)})`;
    case "listDir":
      return `nt.listDir(${printExpr(e.path)})`;
    case "repeat":
      return `${receiver(e.text)}.repeat(${printExpr(e.count)})`;
    case "template":
      return `\`${templateText(e.head)}${e.spans.map(([value, text]) => `\${${printExpr(value)}}${templateText(text)}`).join("")}\``;
    case "advanceTimers":
      return `await vi.advanceTimersByTimeAsync(${printExpr(e.ms)})`;
    case "writeFile":
      return `nt.writeFile(${printExpr(e.path)}, ${printExpr(e.text)})`;
    case "unsupported":
      return `nt_unsupported(${quote(e.source)})`;
  }
}

// the text between a template's holes, as it is written inside backticks
const templateText = (text: string) =>
  text.replace(/[\\`]|\$\{/g, (m) => `\\${m}`);

// a path relative to the test file, wherever the test runs from
const fileUrl = (path: string) => `new URL(${path}, import.meta.url)`;

const member = (key: string) =>
  isIdentifier(key) ? `.${key}` : `[${quote(key)}]`;

declare namespace printExpr {
  type Call = {
    kind: "call";
    callee: { kind: "name"; name: "f" };
    args: [];
    awaited: true;
  };

  type SyncCall = {
    kind: "call";
    callee: { kind: "name"; name: "f" };
    args: [];
    awaited: false;
  };

  /** a member of an awaited call is read from the awaited value, not the promise */
  export type Members = Table<
    typeof printExpr,
    [
      [
        args: [{ kind: "index"; object: Call; key: "x" }],
        expected: "(await f()).x",
      ],
      [
        args: [{ kind: "index"; object: Call; key: 0 }],
        expected: "(await f())[0]!",
      ],
      [
        args: [{ kind: "index"; object: Call; key: "not-a-name" }],
        expected: '(await f())["not-a-name"]',
      ],
      [
        args: [
          {
            kind: "method";
            receiver: Call;
            method: "m";
            args: [];
            awaited: true;
          },
        ],
        expected: "await (await f()).m()",
      ],
    ]
  >;

  /** a call that returns no promise reads as the call it is: no await, no parentheses */
  export type Synchronous = Table<
    typeof printExpr,
    [
      [args: [SyncCall], expected: "f()"],
      [
        args: [{ kind: "index"; object: SyncCall; key: "x" }],
        expected: "f().x",
      ],
      [
        args: [
          {
            kind: "method";
            receiver: SyncCall;
            method: "m";
            args: [];
            awaited: false;
          },
        ],
        expected: "f().m()",
      ],
      /** one awaited step is enough to parenthesise what follows it */
      [
        args: [
          {
            kind: "method";
            receiver: Call;
            method: "m";
            args: [];
            awaited: false;
          },
        ],
        expected: "(await f()).m()",
      ],
    ]
  >;

  /** a string is quoted as JSON would: the printer never sees escapes */
  export type Strings = Table<
    typeof printExpr,
    [
      [args: [{ kind: "string"; value: "a\\d" }], expected: '"a\\\\d"'],
      [
        args: [
          {
            kind: "object";
            entries: [["b-c", { kind: "literal"; source: "1" }]];
          },
        ],
        expected: '{ "b-c": 1 }',
      ],
      [args: [{ kind: "object"; entries: [] }], expected: "{}"],
    ]
  >;
}

type Callable = (...args: never[]) => unknown;

// a typo cannot get past this
type MatcherName = {
  [K in keyof VitestAssertion & string]-?: VitestAssertion[K] extends Callable
    ? K
    : never;
}[keyof VitestAssertion & string];

// homomorphic, so a tuple of parameters stays a tuple
type Printed<P extends readonly unknown[]> = { [I in keyof P]: string };

type PrintedArgs<K extends MatcherName> = Printed<
  Parameters<Extract<VitestAssertion[K], Callable>>
>;

export type Chain = {
  matcher: string;
  args: string[];
  negated?: boolean;
  // the subject is a thunk that must reject
  rejects?: boolean;
  // asserted on instead of the actual: `"~="`, ordering on non-numbers
  subject?: string;
};

// typed so the printer cannot emit `.toEqul(…)` or forget an expected value
const chain = <K extends MatcherName>(
  matcher: K,
  args: PrintedArgs<K>,
  rest: Omit<Chain, "matcher" | "args"> = {},
): Chain => ({ matcher, args: args as string[], ...rest });

type Operands = { actual: string; expected: string; param: string };

// a matcher on numbers, a plain comparison otherwise
const ordering =
  (
    matcher:
      | "toBeGreaterThan"
      | "toBeGreaterThanOrEqual"
      | "toBeLessThan"
      | "toBeLessThanOrEqual",
    operator: string,
  ) =>
  (a: Assertion, { actual, expected }: Operands): Chain =>
    a.shape === "number"
      ? chain(matcher, [expected])
      : chain("toBe", ["true"], {
          subject: `${actual} ${operator} ${expected}`,
        });

// spelled out because `toSatisfy<E>` does not infer `E`
const collection = (method: "some" | "every") => (_: Assertion, p: Operands) =>
  chain("toSatisfy", [
    `(xs: ArrayLike<any>) => Array.from(xs).${method}(${p.expected})`,
  ]);

const matchers: Record<ConditionName, (a: Assertion, p: Operands) => Chain> = {
  "=": (a, p) =>
    a.expected?.kind === "snapshot"
      ? chain(
          "toMatchSnapshot",
          a.expected.name ? [printExpr(a.expected.name)] : [],
        )
      : chain("toEqual", [p.expected]),
  "!=": (_, p) => chain("toEqual", [p.expected], { negated: true }),
  is: (_, p) => chain("toBe", [p.expected]),
  isNot: (_, p) => chain("toBe", [p.expected], { negated: true }),
  satisfies: (_, p) => chain("toSatisfy", [p.expected]),
  instanceOf: (_, p) => chain("toBeInstanceOf", [p.expected]),
  truthy: () => chain("toBeTruthy", []),
  falsy: () => chain("toBeFalsy", []),
  defined: () => chain("toBeDefined", []),
  undefined: () => chain("toBeUndefined", []),
  throws: (a) => ({ ...throwsChain(a.expected), rejects: rejectsFor(a) }),
  ">": ordering("toBeGreaterThan", ">"),
  ">=": ordering("toBeGreaterThanOrEqual", ">="),
  "<": ordering("toBeLessThan", "<"),
  "<=": ordering("toBeLessThanOrEqual", "<="),
  "~=": (_, p) =>
    chain("toBeLessThanOrEqual", [p.param], {
      subject: `Math.abs(${p.actual} - ${p.expected})`,
    }),
  includes: (_, p) => chain("toContain", [p.expected]),
  excludes: (_, p) => chain("toContain", [p.expected], { negated: true }),
  startsWith: (_, p) =>
    chain("toSatisfy", [`(s: string) => s.startsWith(${p.expected})`]),
  endsWith: (_, p) =>
    chain("toSatisfy", [`(s: string) => s.endsWith(${p.expected})`]),
  matches: (a, p) =>
    a.shape === "string" && a.expected
      ? chain("toMatch", [regex(a.expected)])
      : chain("toMatchObject", [p.expected]),
  some: collection("some"),
  every: collection("every"),
  isEmpty: () => chain("toHaveLength", ["0"]),
  isNotEmpty: () => chain("toHaveLength", ["0"], { negated: true }),
  hasKey: (_, p) => chain("toHaveProperty", [p.expected]),
  lacksKey: (_, p) => chain("toHaveProperty", [p.expected], { negated: true }),
  isNaN: () => chain("toBeNaN", []),
  isInteger: () => chain("toSatisfy", ["Number.isInteger"]),
  isFinite: () => chain("toSatisfy", ["Number.isFinite"]),
};

export const isCondition = (op: string): op is ConditionName =>
  Object.hasOwn(matchers, op);

declare namespace printAssertion {
  type Add = "const add = (a: number, b: number) => a + b;";

  /** what is asserted on, and what it is compared against, each get a name */
  export type Locals = Expect<
    Invoke<
      typeof printStatements,
      [`${Add}type Subject = Expect<Invoke<typeof add, [1, 2]>, "=", 3>;`]
    >,
    "=",
    [
      "const actual = add(1, 2);",
      "const expected = 3;",
      "expect(actual).toEqual(expected);",
    ]
  >;

  /** a value that already has a name keeps it: `const actual = add` says nothing */
  export type Named = Expect<
    Invoke<
      typeof printStatements,
      [`${Add}type Subject = Expect<typeof add, "defined">;`]
    >,
    "=",
    ["expect(add).toBeDefined();"]
  >;

  /** several in one body say which goes with which */
  export type Paired = Expect<
    Invoke<
      typeof printAlias,
      [
        `${Add}declare namespace add {
           export type Both = [Expect<Invoke<typeof add, [1, 1]>, "=", 2>, Expect<Invoke<typeof add, [2, 2]>, "=", 4>];
         }`,
        "Both",
      ]
    >,
    "includes",
    "const actual2 = add(2, 2);\n  const expected2 = 4;\n  expect.soft(actual2).toEqual(expected2);"
  >;

  /** a thunk is not a value to name: `throws` reads as it always has */
  export type Thrown = Expect<
    Invoke<
      typeof printStatements,
      [`${Add}type Subject = Throws<Invoke<typeof add, [1, 1]>>;`]
    >,
    "=",
    ["expect(() => (add(1, 1))).toThrow();"]
  >;
}

const printChain = (c: Chain): string =>
  `${c.rejects ? ".rejects" : ""}${c.negated ? ".not" : ""}.${c.matcher}(${c.args.join(", ")})`;

declare namespace matchers {
  /** every condition, as the matcher it prints */
  export type Conditions = Table<
    typeof printMatcher,
    [
      [
        args: ['type Subject = Expect<"a", "=", "b">;'],
        expected: "expect(actual).toEqual(expected);",
      ],
      [
        args: ['type Subject = Expect<"a", "!=", "b">;'],
        expected: "expect(actual).not.toEqual(expected);",
      ],
      [
        args: ['type Subject = Expect<1, "is", 1>;'],
        expected: "expect(actual).toBe(expected);",
      ],
      [
        args: ['type Subject = Expect<"ab", "includes", "b">;'],
        expected: "expect(actual).toContain(expected);",
      ],
      [
        args: ['type Subject = Expect<[], "isEmpty">;'],
        expected: "expect(actual).toHaveLength(0);",
      ],
      [
        args: ['type Subject = Expect<1, "isInteger">;'],
        expected: "expect(actual).toSatisfy(Number.isInteger);",
      ],
      [
        args: ['type Subject = Expect<2, ">", 1>;'],
        expected: "expect(actual).toBeGreaterThan(expected);",
      ],
      [
        args: ['type Subject = Expect<1, ["~=", 0.5], 1.2>;'],
        expected: "expect(Math.abs(actual - expected)).toBeLessThanOrEqual(0.5);",
      ],
      [
        args: ['type Subject = Expect<"x", "matches", "/x+/i">;'],
        expected: "expect(actual).toMatch(/x+/i);",
      ],
      [
        args: ['type Subject = Expect<{ a: 1 }, "matches", { a: 1 }>;'],
        expected: "expect(actual).toMatchObject(expected);",
      ],
      [
        args: ['type Subject = Expect<1, "=", Snapshot<"named">>;'],
        expected: 'expect(actual).toMatchSnapshot("named");',
      ],
      [
        args: ['type Subject = Expect<1, "=", Snapshot>;'],
        expected: "expect(actual).toMatchSnapshot();",
      ],
      /** an ordering condition on something that is not a number compares directly */
      [
        args: ['type Subject = Expect<"b", ">", "a">;'],
        expected: "expect(actual > expected).toBe(true);",
      ],
    ]
  >;
}

// `"/x/i"` is written as a regex; anything else is its source
export const regex = (e: Expr) => {
  const m = e.kind === "string" && /^\/(.*)\/([a-z]*)$/.exec(e.value);
  return m ? `/${m[1]}/${m[2]}` : `new RegExp(${printExpr(e)})`;
};

declare namespace regex {
  /** a "/…/" string is a regex literal; anything else is a source string, escaped once */
  export type Cases = Table<
    typeof regex,
    [
      [
        args: [pattern: { kind: "string"; value: "/a+/gi" }],
        expected: "/a+/gi",
      ],
      [
        args: [pattern: { kind: "string"; value: "^\\d+$" }],
        expected: 'new RegExp("^\\\\d+$")',
      ],
      [
        args: [pattern: { kind: "name"; name: "Pattern" }],
        expected: "new RegExp(Pattern)",
      ],
    ]
  >;
}

/** The fields a `Throws` matcher reads off the error itself; any other is one of the error's own. */
export const MATCHER_FIELDS = [
  "instanceOf",
  "name",
  "message",
  "matches",
] as const;

// an awaited subject throws by rejecting, and only `.rejects` hands an error to a predicate
const rejectsFor = (a: Assertion) =>
  awaits(a.actual) || throwsChain(a.expected).matcher !== "toThrow";

const throwsChain = (expected: Expr | null): Chain => {
  if (!expected || printExpr(expected) === "undefined")
    return chain("toThrow", []);
  if (expected.kind !== "object")
    return chain("toThrow", [printExpr(expected)]);
  const known: readonly string[] = MATCHER_FIELDS;
  const checks = expected.entries
    .filter(([key]) => known.includes(key))
    .map(([key, value]) => {
      const v = printExpr(value);
      switch (key) {
        case "instanceOf":
          return `err instanceof ${v}`;
        case "name":
          return `err.name === ${v}`;
        case "message":
          return `String(err.message).includes(${v})`;
        default:
          return `${regex(value)}.test(String(err.message))`;
      }
    });
  // the error's own fields, compared as `"matches"` compares, with its diff when they differ
  const fields = expected.entries.filter(([key]) => !known.includes(key));
  if (fields.length)
    checks.push(
      `(expect(err).toMatchObject(${printExpr({ kind: "object", entries: fields })}), true)`,
    );
  return chain("toSatisfy", [`(err) => ${checks.join(" && ")}`]);
};

// seeded with every name the test refers to, so a local never shadows one
export type Names = { take: (base: string) => string };

export const names = (taken: Iterable<string>): Names => {
  const used = new Set(taken);
  return {
    take(base) {
      let name = base;
      for (let n = 2; used.has(name); n++) name = `${base}${n}`;
      used.add(name);
      return name;
    },
  };
};

export { namesIn };

// first in the test, so nothing the test does runs without them, and each undone when it ends
export const printSetup = (setup: Setup[]): Line[] => {
  const lines: Line[] = [];
  for (const { line, ...s } of setup)
    if (s.kind === "fakeTimers")
      lines.push(
        {
          code: `vi.useFakeTimers(${s.now ? `{ now: new Date(${printExpr(s.now)}) }` : ""});`,
          line,
        },
        { code: "onTestFinished(() => { vi.useRealTimers(); });", line },
      );
    else
      lines.push({
        code: `vi.stubEnv(${quote(s.name)}, ${s.value ? printExpr(s.value) : "undefined"});`,
        line,
      });
  const stubbed = setup.filter((s) => s.kind === "stubEnv").at(-1);
  if (stubbed)
    lines.push({
      code: "onTestFinished(() => { vi.unstubAllEnvs(); });",
      line: stubbed.line,
    });
  return lines;
};

// `const actual = Counter$;` says nothing `Counter$` did not
const worthBinding = (code: string) =>
  !isIdentifier(code) && code !== "undefined";

const printActual = (a: Assertion) => {
  const printed = printExpr(a.actual);
  if (a.condition === "throws")
    return `${rejectsFor(a) ? "async " : ""}() => (${printed})`;
  return comparesAsArrays(a) ? `Array.from(${printed})` : printed;
};

const comparesAsArrays = (a: Assertion) =>
  (a.condition === "=" || a.condition === "!=") &&
  a.shape === "typedArray" &&
  a.expected?.kind === "array";

type Bound = { pre: string[]; subject: string; expected: string | null };

const bindOperands = (a: Assertion, scope: Names, nth: string): Bound => {
  const actual = printActual(a);
  const expected = a.expected ? printExpr(a.expected) : null;
  if (a.condition === "throws") return { pre: [], subject: actual, expected };
  const pre: string[] = [];
  const bind = (base: string, value: string) => {
    const name = scope.take(`${base}${nth}`);
    pre.push(`const ${name} = ${value};`);
    return name;
  };
  const subject = worthBinding(actual) ? bind("actual", actual) : actual;
  const bindsExpected =
    expected !== null &&
    a.expected?.kind !== "snapshot" &&
    worthBinding(expected);
  return {
    pre,
    subject,
    expected: bindsExpected ? bind("expected", expected) : expected,
  };
};

const encoded = (key: string, value: string) => `${key}: encode(${value})`;

// encoded in the test: Vitest copies an artifact out of it, and a function or a class would not survive that
const displayStatements = (a: Assertion, { subject, expected }: Bound) => {
  if (!a.display) return [];
  const values = [
    `type: ${quote(DISPLAY)}`,
    `page: ${quote(a.display.page)}`,
    encoded("actual", subject),
    ...(expected !== null && a.expected?.kind !== "snapshot"
      ? [encoded("expected", expected)]
      : []),
    ...(a.display.meta ? [encoded("meta", printExpr(a.display.meta))] : []),
  ];
  return [`await recordArtifact(task, { ${values.join(", ")} });`];
};

const expectation = (a: Assertion, c: Chain, subject: string) => {
  const statement = `${a.soft ? "expect.soft" : "expect"}(${c.subject ?? subject})${printChain(c)};`;
  return c.rejects ? `await ${statement}` : statement;
};

// `actual2` pairs with `expected2`
export function printAssertion(
  a: Assertion,
  scope = names([]),
  nth = "",
): string[] {
  const operands = bindOperands(a, scope, nth);
  const chain = matchers[a.condition](a, {
    actual: operands.subject,
    expected: operands.expected ?? "undefined",
    param: a.param ? printExpr(a.param) : "undefined",
  });
  return [
    ...operands.pre,
    ...displayStatements(a, operands),
    expectation(a, chain, operands.subject),
  ];
}

export const printStatement = (
  s: Statement,
  scope = names([]),
  nth = "",
): string[] =>
  s.kind === "effect"
    ? [`${printExpr(s.expr)};`]
    : printAssertion(s, scope, nth);

const isAdvance = (s: Statement | undefined) =>
  s?.kind === "effect" && s.expr.kind === "advanceTimers";

// where the alias of a started call is declared, or a Throws or a Caught checks the call
const reaches = (s: Statement, bindings: Binding[], pending: string) =>
  bindings.some((b) => b.pending === pending) ||
  exprsOf(s).some((e) => some(e, (n) => n.kind === "name" && n.pending === pending));

/**
 * One scope across the body; ordinals only when there are several to tell apart.
 * `before[i]` are the aliases declared just before the `i`th statement.
 *
 * An effect `settled` started, just before an AdvanceTimers, is started under
 * its name and guarded, and once the time has moved it is owed, before the next
 * statement: an inline call is awaited; a started alias is awaited by the
 * statement that declares or checks it, waited for without throwing when a
 * later one does (so that one sees a rejection), and awaited when none does.
 */
export function printBody(
  body: Statement[],
  scope = names([]),
  before: Binding[][] = [],
): Line[][] {
  const assertions = body.filter((s) => s.kind === "assert").length;
  let asserted = 0;
  let waiting: { name: string; alias: boolean }[] = [];
  const reached = (j: number, name: string) =>
    reaches(body[j]!, before[j] ?? [], name);
  const out = body.map((s, i): Line[] => {
    const at = (code: string): Line => ({ code, line: s.line });
    const owed = isAdvance(s)
      ? []
      : waiting.splice(0).flatMap(({ name, alias }) =>
          !alias
            ? [`await ${name};`]
            : reached(i, name)
              ? []
              : body.some((_, j) => j > i && reached(j, name))
                ? [`await ${name}.then(undefined, () => {});`]
                : [`await ${name};`],
        );
    const lines = [
      ...owed.map(at),
      ...(before[i] ?? []).map((b) => ({ code: printBinding(b), line: b.line })),
    ];
    if (s.kind === "effect" && s.start) {
      const { name, call } = s.start;
      waiting.push({ name, alias: s.expr.kind === "name" });
      // a rejection while the time moves is the test's to see; `then`, since a thenable may have no `catch`
      return [
        ...lines,
        at(`const ${name} = ${printExpr(started(call))};`),
        at(`${name}.then(undefined, () => {});`),
      ];
    }
    return [
      ...lines,
      ...printStatement(
        s,
        scope,
        // counted over assertions alone: the effects of a `Given` are not ones,
        // and `actual3` for the first thing asserted reads as a bug
        s.kind === "assert" && assertions > 1 ? `${++asserted}` : "",
      ).map(at),
    ];
  });
  out.at(-1)?.push(
    ...waiting.map(({ name }) => ({
      code: `await ${name};`,
      line: body.at(-1)!.line,
    })),
  );
  return out;
}

declare namespace printBody {
  type Later = `
    const later = (ms: number): Promise<string> => new Promise((r) => setTimeout(() => r("done"), ms));
    declare namespace later {
      type Waited = Invoke<typeof later, [ms: 1000]>;
      export type Named = Given<[FakeTimers, Waited, AdvanceTimers<1_000>], Expect<Waited, "=", "done">>;
      export type Inline = Given<[FakeTimers, Invoke<typeof later, [ms: 10]>, AdvanceTimers<10>], Expect<1, "=", 1>>;
      export type RealTime = Given<[Waited, Invoke<typeof later, [ms: 1]>], Expect<Waited, "=", "done">>;
    }
  `;

  /**
   * an alias of an async call written just before an AdvanceTimers is started
   * there under \`pending\`, the time moved, and the alias declared as the
   * awaited call where it is next used, a plain value: it was awaited where it
   * was declared, before the time that would finish it could move, and hung
   */
  export type StartedThenAwaited = Expect<
    Invoke<typeof printAlias, [Later, "Named"]>,
    "=",
    'test("later > Named", async () => {\n  vi.useFakeTimers();\n  onTestFinished(() => { vi.useRealTimers(); });\n  const pending = later(1000);\n  pending.then(undefined, () => {});\n  await vi.advanceTimersByTimeAsync(1_000);\n  const Waited = await pending;\n  const expected = "done";\n  expect(Waited).toEqual(expected);\n});'
  >;

  /** an inline one the same, awaited as soon as the time has moved */
  export type InlineToo = Expect<
    Invoke<typeof printAlias, [Later, "Inline"]>,
    "startsWith",
    'test("later > Inline", async () => {\n  vi.useFakeTimers();\n  onTestFinished(() => { vi.useRealTimers(); });\n  const pending = later(10);\n  pending.then(undefined, () => {});\n  await vi.advanceTimersByTimeAsync(10);\n  await pending;\n'
  >;

  /** @control without an AdvanceTimers after it, an async effect is awaited before the next one runs */
  export type AwaitedInTurn = Expect<
    Invoke<typeof printAlias, [Later, "RealTime"]>,
    "startsWith",
    'test("later > RealTime", async () => {\n  const Waited = await later(1000);\n  Waited;\n  await later(1);\n'
  >;

  type Waits = Invoke<typeof later, [ms: 1000, value: "done"]>;
  type Fails = Invoke<typeof failsLater, [ms: 1000, message: "late"]>;

  /** run under fake time: the call waits on a timer only the AdvanceTimers after it moves */
  export type UnderFakeTime = Given<
    [FakeTimers, Waits, AdvanceTimers<1_000>],
    Expect<Waits, "=", "done">
  >;

  /** and one that rejects meanwhile is the Throws' to see */
  export type RejectsUnderFakeTime = Given<
    [FakeTimers, Fails, AdvanceTimers<1_000>],
    Throws<Fails, "late">
  >;

  type Overlap = `
    const write = async (what: string): Promise<void> => {};
    const read = async (): Promise<string> => "x";
    const put = async (what: string): Promise<string> => what;
    const both = (a: void, b: string) => b;
    declare namespace read {
      type Wrote = Invoke<typeof write, [what: "x"]>;
      type Read = Invoke<typeof read>;
      type P = Invoke<typeof put, [what: "a"]>;
      export type Two = Expect<Invoke<typeof both, [Wrote, Read]>, "=", "x">;
      export type After = Expect<Invoke<typeof read>, "=", P>;
    }
  `;

  /**
   * outside that one shape, an async alias is awaited where it is declared, so
   * what comes after never overlaps it: the write, then the read (both were
   * started at once and awaited together)
   */
  export type AwaitedWhereDeclared = [
    Expect<
      Invoke<typeof printAlias, [Overlap, "Two"]>,
      "=",
      'test("read > Two", async () => {\n  const Wrote = await write("x");\n  const Read = await read();\n  const actual = both(Wrote, Read);\n  const expected = "x";\n  expect(actual).toEqual(expected);\n});'
    >,
    Expect<
      Invoke<typeof printAlias, [Overlap, "After"]>,
      "=",
      'test("read > After", async () => {\n  const P = await put("a");\n  const actual = await read();\n  expect(actual).toEqual(P);\n});'
    >,
  ];

  type Store = Invoke<typeof aStore>;
  type Put = Call<Store, "put", [value: "a"]>;

  /** run: the store is read after the put has finished, not while it waits on its tick */
  export type PutThenRead = Expect<Call<Store, "read">, "=", [Put]>;

  type Caught_ = `
    const failsLater = async (ms: number, message: string): Promise<never> => { throw new Error(message); };
    declare namespace failsLater {
      type E = Caught<Invoke<typeof failsLater, [ms: 1, message: "x"]>>;
      export type Alias = Expect<E, "matches", { message: "x" }>;
      export type Inline = Given<
        [FakeTimers, Caught<Invoke<typeof failsLater, [ms: 10, message: "x"]>>, AdvanceTimers<10>],
        Expect<1, "=", 1>
      >;
    }
  `;

  /**
   * a Caught of an async call catches it in an async thunk, awaited where it
   * stands or started before an AdvanceTimers (it printed `await` inside a
   * plain arrow, which does not parse)
   */
  export type CaughtAsync = [
    Expect<
      Invoke<typeof printAlias, [Caught_, "Alias"]>,
      "includes",
      'const E = await nt.caught(async () => (await failsLater(1, "x")), "Invoke<typeof failsLater, [ms: 1, message: \\"x\\"]>");'
    >,
    Expect<
      Invoke<typeof printAlias, [Caught_, "Inline"]>,
      "includes",
      'const pending = nt.caught(async () => (await failsLater(10, "x")), "Invoke<typeof failsLater, [ms: 10, message: \\"x\\"]>");\n  pending.then(undefined, () => {});'
    >,
  ];

  type Late = Caught<Invoke<typeof failsLater, [ms: 1_000, message: "late"]>>;

  /** run: and the error is the one the call rejected with */
  export type CaughtRuns = Expect<
    Caught<Invoke<typeof failsLater, [ms: 1, message: "soon"]>>,
    "matches",
    { message: "soon" }
  >;

  /** under fake time too, started before the time that rejects it moves */
  export type CaughtUnderFakeTime = Given<
    [FakeTimers, Late, AdvanceTimers<1_000>],
    Expect<Late, "matches", { message: "late" }>
  >;

  type AsMain = `
    const f = async (x: string): Promise<string> => x;
    const g = (x: string): string => x + "!";
    const sthrow = (x: string): string => { throw new Error("s"); };
    declare namespace f {
      type A = Invoke<typeof f, [x: "a"]>;
      type AA = A;
      type P<T extends string = "z"> = Invoke<typeof sthrow, [A]>;
      type R<T extends string = "z"> = Invoke<typeof g, [A]>;
      export type ThrowsP = Throws<P, "s">;
      export type ExpectR = Expect<R, "=", "a!">;
      export type CaughtP = Expect<Caught<P>, "matches", { message: "s" }>;
      export type OfAlias = Expect<AA, "=", "a">;
      export type AsArgument = Expect<Invoke<typeof g, [A]>, "=", "a!">;
    }
  `;

  /**
   * with nothing started, a test is lowered and printed exactly as it was
   * before async aliases could be started: a parameterised alias that uses an
   * async one is a plain arrow (it printed `await P()` and `.rejects`), an alias
   * of an alias and one handed as an argument are had where declared
   */
  export type AsBefore = Table<
    typeof printAlias,
    [
      [args: [source: AsMain, alias: "ThrowsP"], expected: "test(\"f > ThrowsP\", async () => {\n  const A = await f(\"a\");\n  const P = (T: string = \"z\") => sthrow(A);\n  expect(() => (P())).toThrow(\"s\");\n});"],
      [args: [source: AsMain, alias: "ExpectR"], expected: "test(\"f > ExpectR\", async () => {\n  const A = await f(\"a\");\n  const R = (T: string = \"z\") => g(A);\n  const actual = R();\n  const expected = \"a!\";\n  expect(actual).toEqual(expected);\n});"],
      [args: [source: AsMain, alias: "CaughtP"], expected: "test(\"f > CaughtP\", async () => {\n  const A = await f(\"a\");\n  const P = (T: string = \"z\") => sthrow(A);\n  const actual = nt.caught(() => (P()), \"P\");\n  const expected = { message: \"s\" };\n  expect(actual).toMatchObject(expected);\n});"],
      [args: [source: AsMain, alias: "OfAlias"], expected: "test(\"f > OfAlias\", async () => {\n  const A = await f(\"a\");\n  const AA = A;\n  const expected = \"a\";\n  expect(AA).toEqual(expected);\n});"],
      [args: [source: AsMain, alias: "AsArgument"], expected: "test(\"f > AsArgument\", async () => {\n  const A = await f(\"a\");\n  const actual = g(A);\n  const expected = \"a!\";\n  expect(actual).toEqual(expected);\n});"],
    ]
  >;

  type Timed = `
    const f = async (x: string): Promise<string> => x;
    declare namespace f {
      type A = Invoke<typeof f, [x: "a"]>;
      type AA = A;
      type E = Caught<A>;
      export type OfAlias = Given<[FakeTimers, AA, AdvanceTimers<1>], Expect<AA, "=", "a">>;
      export type OfCaught = Given<[FakeTimers, E, AdvanceTimers<1>], Expect<E, "matches", {}>>;
    }
  `;

  /**
   * an alias that only names the alias of an async call is started with it,
   * the call under `pending`, and both are declared once the time has moved,
   * plain values (A was awaited before the time moved). A Caught of an alias
   * is not a call that can be started: it is said where it is written
   */
  export type StartedWithIt = [
    Expect<Invoke<typeof printAlias, [Timed, "OfAlias"]>, "=", "test(\"f > OfAlias\", async () => {\n  vi.useFakeTimers();\n  onTestFinished(() => { vi.useRealTimers(); });\n  const pending = f(\"a\");\n  pending.then(undefined, () => {});\n  await vi.advanceTimersByTimeAsync(1);\n  const A = await pending;\n  const AA = A;\n  const expected = \"a\";\n  expect(AA).toEqual(expected);\n});">,
    Expect<Invoke<typeof moduleWarnings, [Timed]>, "=", ["`Caught<A>` names an alias of a call, which runs where the alias is declared: what it throws fails the test before it can be checked. Write the call inside the Throws or the Caught","`E` waits on the time the AdvanceTimers after it moves, but is awaited before it: only an alias of an async call (or of a Caught of one, written inline), named here first, is started there. Write the call inline in the alias, or inline here"]>,
  ];

  type Waits_ = Invoke<typeof later, [ms: 1000, value: "done"]>;
  type OfWaits = Waits_;
  type FailsCaught = Caught<Invoke<typeof failsLater, [ms: 1000, message: "late"]>>;

  /** run under fake time: an alias of an alias waits on the timer the AdvanceTimers moves */
  export type OfAliasUnderFakeTime = Given<
    [FakeTimers, OfWaits, AdvanceTimers<1_000>],
    Expect<OfWaits, "=", "done">
  >;

  /** and an alias of a Caught of the call catches the rejection the moved time brings */
  export type CaughtAliasUnderFakeTime = Given<
    [FakeTimers, FailsCaught, AdvanceTimers<1_000>],
    Expect<FailsCaught, "matches", { message: "late" }>
  >;

  type Owed = `
    const failsLater = async (ms: number, message: string): Promise<never> => { throw new Error(message); };
    const boom = async (): Promise<never> => { throw new Error("no"); };
    const g = (x: string): string => x + "!";
    declare namespace failsLater {
      type Fails = Invoke<typeof failsLater, [ms: 10, message: "late"]>;
      type Boom = Invoke<typeof boom>;
      type AA = Boom;
      export type Second = Given<[FakeTimers, Fails, AdvanceTimers<10>], [Expect<1, "=", 1>, Throws<Fails, "late">]>;
      export type Between = Given<[FakeTimers, Fails, AdvanceTimers<10>, Invoke<typeof g, ["y"]>], Throws<Fails, "late">>;
      export type Named = Given<[FakeTimers, AA, AdvanceTimers<1>], Throws<Boom, "no">>;
      export type CaughtOf = Given<[FakeTimers, AA, AdvanceTimers<1>], Expect<Caught<AA>, "matches", { message: "no" }>>;
      export type Unused = Given<[FakeTimers, Fails, AdvanceTimers<10>], Expect<1, "=", 1>>;
    }
  `;

  /**
   * once the time has moved, a started call a later statement checks is waited
   * for without throwing, so that Throws (or Caught) sees the rejection; a
   * Throws or a Caught of the alias, or of one that only names it, checks the
   * started call itself
   */
  export type WaitedForThrows = [
    Expect<Invoke<typeof printAlias, [Owed, "Second"]>, "=", "test(\"failsLater > Second\", async () => {\n  vi.useFakeTimers();\n  onTestFinished(() => { vi.useRealTimers(); });\n  const pending = failsLater(10, \"late\");\n  pending.then(undefined, () => {});\n  await vi.advanceTimersByTimeAsync(10);\n  await pending.then(undefined, () => {});\n  const actual1 = 1;\n  const expected1 = 1;\n  expect.soft(actual1).toEqual(expected1);\n  await expect.soft(async () => (await pending)).rejects.toThrow(\"late\");\n});">,
    Expect<Invoke<typeof printAlias, [Owed, "Between"]>, "=", "test(\"failsLater > Between\", async () => {\n  vi.useFakeTimers();\n  onTestFinished(() => { vi.useRealTimers(); });\n  const pending = failsLater(10, \"late\");\n  pending.then(undefined, () => {});\n  await vi.advanceTimersByTimeAsync(10);\n  await pending.then(undefined, () => {});\n  g(\"y\");\n  await expect(async () => (await pending)).rejects.toThrow(\"late\");\n});">,
    Expect<Invoke<typeof printAlias, [Owed, "Named"]>, "=", "test(\"failsLater > Named\", async () => {\n  vi.useFakeTimers();\n  onTestFinished(() => { vi.useRealTimers(); });\n  const pending = boom();\n  pending.then(undefined, () => {});\n  await vi.advanceTimersByTimeAsync(1);\n  await expect(async () => (await pending)).rejects.toThrow(\"no\");\n});">,
    Expect<Invoke<typeof printAlias, [Owed, "CaughtOf"]>, "=", "test(\"failsLater > CaughtOf\", async () => {\n  vi.useFakeTimers();\n  onTestFinished(() => { vi.useRealTimers(); });\n  const pending = boom();\n  pending.then(undefined, () => {});\n  await vi.advanceTimersByTimeAsync(1);\n  const actual = await nt.caught(async () => (await pending), \"AA\");\n  const expected = { message: \"no\" };\n  expect(actual).toMatchObject(expected);\n});">,
  ];

  /** @control one nothing uses again is awaited, so its rejection fails the test there */
  export type UnusedAwaited = Expect<
    Invoke<typeof printAlias, [Owed, "Unused"]>,
    "=",
    "test(\"failsLater > Unused\", async () => {\n  vi.useFakeTimers();\n  onTestFinished(() => { vi.useRealTimers(); });\n  const pending = failsLater(10, \"late\");\n  pending.then(undefined, () => {});\n  await vi.advanceTimersByTimeAsync(10);\n  await pending;\n  const actual = 1;\n  const expected = 1;\n  expect(actual).toEqual(expected);\n});"
  >;

  type Shapes = `
    const later = (ms: number): Promise<string> => new Promise((r) => setTimeout(() => r("done"), ms));
    const sthrow = (x: string): string => { throw Object.assign(new Error("s"), { code: x }); };
    const g = (x: string): string => x + "!";
    const thenable = (ms: number): PromiseLike<string> => ({ then: (ok: any) => (setTimeout(() => ok("done"), ms), undefined as any) });
    declare namespace later {
      type A = Invoke<typeof later, [ms: 10]>;
      type D<X extends string = A> = Invoke<typeof g, [X]>;
      type P<Y extends string = "y"> = Invoke<typeof g, [A]>;
      type DP<X extends string = P> = Invoke<typeof g, [X]>;
      type Sh<A extends string = "x"> = Invoke<typeof g, [A]>;
      type Fx = Fixture<string, A>;
      type T = Invoke<typeof thenable, [ms: 10]>;
      export type Message = Given<[FakeTimers, A, AdvanceTimers<10>], Throws<Invoke<typeof sthrow, ["z"]>, { message: A }>>;
      export type Matches = Given<[FakeTimers, A, AdvanceTimers<10>], Throws<Invoke<typeof sthrow, ["z"]>, { matches: A }>>;
      export type Field = Given<[FakeTimers, A, AdvanceTimers<10>], Throws<Invoke<typeof sthrow, ["z"]>, { code: A }>>;
      export type AsDefault = Given<[FakeTimers, A, AdvanceTimers<10>], Expect<D, "=", "done!">>;
      export type Chain = Given<[FakeTimers, A, AdvanceTimers<10>], Expect<DP, "=", "done!!">>;
      export type Shadowed = Given<[FakeTimers, A, AdvanceTimers<10>], Expect<Sh, "=", "x!">>;
      export type UnderFixture = Given<[FakeTimers, Fx, AdvanceTimers<10>], Expect<Fx, "=", "done">>;
      export type Thenable = Given<[FakeTimers, T, AdvanceTimers<10>], Expect<T, "=", "done">>;
      export type Credit = Given<[FakeTimers, A, AdvanceTimers<10>], Throws<Invoke<typeof sthrow, [A]>, "s">>;
    }
  `;

  /**
   * every other alias is printed as with nothing started, so it is legal where
   * any alias is: in a Throws' matcher (it printed `await` in the matcher's
   * callback, which does not parse), in a parameter's default, through a
   * default that calls another parameterised alias (it called an async arrow
   * and got a promise), a parameter that shadows the alias, a Fixture's
   * annotation; a thenable is guarded with `then` (it has no `catch`); and an
   * alias used inside another call's Throws is declared before it, so its own
   * rejection fails the test there rather than counting as that call's
   */
  export type Shaped = [
    Expect<Invoke<typeof printAlias, [Shapes, "Message"]>, "=", "test(\"later > Message\", async () => {\n  vi.useFakeTimers();\n  onTestFinished(() => { vi.useRealTimers(); });\n  const pending = later(10);\n  pending.then(undefined, () => {});\n  await vi.advanceTimersByTimeAsync(10);\n  const A = await pending;\n  await expect(async () => (sthrow(\"z\"))).rejects.toSatisfy((err) => String(err.message).includes(A));\n});">,
    Expect<Invoke<typeof printAlias, [Shapes, "Matches"]>, "=", "test(\"later > Matches\", async () => {\n  vi.useFakeTimers();\n  onTestFinished(() => { vi.useRealTimers(); });\n  const pending = later(10);\n  pending.then(undefined, () => {});\n  await vi.advanceTimersByTimeAsync(10);\n  const A = await pending;\n  await expect(async () => (sthrow(\"z\"))).rejects.toSatisfy((err) => new RegExp(A).test(String(err.message)));\n});">,
    Expect<Invoke<typeof printAlias, [Shapes, "Field"]>, "=", "test(\"later > Field\", async () => {\n  vi.useFakeTimers();\n  onTestFinished(() => { vi.useRealTimers(); });\n  const pending = later(10);\n  pending.then(undefined, () => {});\n  await vi.advanceTimersByTimeAsync(10);\n  const A = await pending;\n  await expect(async () => (sthrow(\"z\"))).rejects.toSatisfy((err) => (expect(err).toMatchObject({ code: A }), true));\n});">,
    Expect<Invoke<typeof printAlias, [Shapes, "AsDefault"]>, "=", "test(\"later > AsDefault\", async () => {\n  vi.useFakeTimers();\n  onTestFinished(() => { vi.useRealTimers(); });\n  const pending = later(10);\n  pending.then(undefined, () => {});\n  await vi.advanceTimersByTimeAsync(10);\n  const A = await pending;\n  const D = (X: string = A) => g(X);\n  const actual = D();\n  const expected = \"done!\";\n  expect(actual).toEqual(expected);\n});">,
    Expect<Invoke<typeof printAlias, [Shapes, "Chain"]>, "=", "test(\"later > Chain\", async () => {\n  vi.useFakeTimers();\n  onTestFinished(() => { vi.useRealTimers(); });\n  const pending = later(10);\n  pending.then(undefined, () => {});\n  await vi.advanceTimersByTimeAsync(10);\n  const A = await pending;\n  const P = (Y: string = \"y\") => g(A);\n  const DP = (X: string = P()) => g(X);\n  const actual = DP();\n  const expected = \"done!!\";\n  expect(actual).toEqual(expected);\n});">,
    Expect<Invoke<typeof printAlias, [Shapes, "Shadowed"]>, "=", "test(\"later > Shadowed\", async () => {\n  vi.useFakeTimers();\n  onTestFinished(() => { vi.useRealTimers(); });\n  const pending = later(10);\n  pending.then(undefined, () => {});\n  await vi.advanceTimersByTimeAsync(10);\n  const A = await pending;\n  const Sh = (A: string = \"x\") => g(A);\n  const actual = Sh();\n  const expected = \"x!\";\n  expect(actual).toEqual(expected);\n});">,
    Expect<Invoke<typeof printAlias, [Shapes, "UnderFixture"]>, "=", "test(\"later > UnderFixture\", async () => {\n  vi.useFakeTimers();\n  onTestFinished(() => { vi.useRealTimers(); });\n  const pending = later(10);\n  pending.then(undefined, () => {});\n  await vi.advanceTimersByTimeAsync(10);\n  const A = await pending;\n  const Fx: string = A;\n  const expected = \"done\";\n  expect(Fx).toEqual(expected);\n});">,
    Expect<Invoke<typeof printAlias, [Shapes, "Thenable"]>, "=", "test(\"later > Thenable\", async () => {\n  vi.useFakeTimers();\n  onTestFinished(() => { vi.useRealTimers(); });\n  const pending = thenable(10);\n  pending.then(undefined, () => {});\n  await vi.advanceTimersByTimeAsync(10);\n  const T = await pending;\n  const expected = \"done\";\n  expect(T).toEqual(expected);\n});">,
    Expect<Invoke<typeof printAlias, [Shapes, "Credit"]>, "=", "test(\"later > Credit\", async () => {\n  vi.useFakeTimers();\n  onTestFinished(() => { vi.useRealTimers(); });\n  const pending = later(10);\n  pending.then(undefined, () => {});\n  await vi.advanceTimersByTimeAsync(10);\n  const A = await pending;\n  expect(() => (sthrow(A))).toThrow(\"s\");\n});">,
    Expect<Invoke<typeof moduleWarnings, [Shapes]>, "=", []>,
  ];

  type FailsAgain = Invoke<typeof failsLater, [ms: 1_000, message: "late"]>;

  /** run under fake time: a Throws after another claim sees the rejection */
  export type ThrowsSecondUnderFakeTime = Given<
    [FakeTimers, FailsAgain, AdvanceTimers<1_000>],
    [Expect<1, "=", 1>, Throws<FailsAgain, "late">]
  >;

  type Thenable_ = Invoke<typeof aThenable, [ms: 1_000, value: "done"]>;

  /** run under fake time: a thenable with no `catch` is started and awaited */
  export type ThenableUnderFakeTime = Given<
    [FakeTimers, Thenable_, AdvanceTimers<1_000>],
    Expect<Thenable_, "=", "done">
  >;

  type Two = `
    const later = (ms: number, v: string): Promise<string> => new Promise((r) => setTimeout(() => r(v), ms));
    const fails = async (ms: number, m: string): Promise<never> => { throw new Error(m); };
    declare namespace later {
      type A = Invoke<typeof later, [ms: 5, v: "a"]>;
      type B = Invoke<typeof later, [ms: 10, v: "b"]>;
      type F = Invoke<typeof fails, [ms: 10, m: "late"]>;
      type C = Caught<F>;
      type P<Y extends string = "y"> = Caught<F>;
      export type Both = Given<[FakeTimers, A, AdvanceTimers<5>, B, AdvanceTimers<10>], [Expect<A, "=", "a">, Expect<B, "=", "b">]>;
      export type Tuple = [Given<[FakeTimers, A, AdvanceTimers<5>], Expect<A, "=", "a">>, Given<[B, AdvanceTimers<10>], Expect<B, "=", "b">>];
      export type CaughtBinding = Given<[FakeTimers, F, AdvanceTimers<10>], Expect<C, "matches", { message: "late" }>>;
      export type CaughtParam = Given<[FakeTimers, F, AdvanceTimers<10>], Expect<P, "matches", { message: "late" }>>;
    }
  `;

  /**
   * a second alias started in one test is started under a name of its own and
   * declared from it (it was called again after the time had moved, and hung),
   * in one Given or in a tuple of them
   */
  export type TwoStarted = [
    Expect<Invoke<typeof printAlias, [Two, "Both"]>, "=", "test(\"later > Both\", async () => {\n  vi.useFakeTimers();\n  onTestFinished(() => { vi.useRealTimers(); });\n  const pending = later(5, \"a\");\n  pending.then(undefined, () => {});\n  await vi.advanceTimersByTimeAsync(5);\n  await pending.then(undefined, () => {});\n  const pending2 = later(10, \"b\");\n  pending2.then(undefined, () => {});\n  await vi.advanceTimersByTimeAsync(10);\n  await pending2.then(undefined, () => {});\n  const A = await pending;\n  const expected1 = \"a\";\n  expect.soft(A).toEqual(expected1);\n  const B = await pending2;\n  const expected2 = \"b\";\n  expect.soft(B).toEqual(expected2);\n});">,
    Expect<Invoke<typeof printAlias, [Two, "Tuple"]>, "=", "test(\"later > Tuple\", async () => {\n  vi.useFakeTimers();\n  onTestFinished(() => { vi.useRealTimers(); });\n  const pending = later(5, \"a\");\n  pending.then(undefined, () => {});\n  await vi.advanceTimersByTimeAsync(5);\n  const A = await pending;\n  const expected1 = \"a\";\n  expect.soft(A).toEqual(expected1);\n  const pending2 = later(10, \"b\");\n  pending2.then(undefined, () => {});\n  await vi.advanceTimersByTimeAsync(10);\n  const B = await pending2;\n  const expected2 = \"b\";\n  expect.soft(B).toEqual(expected2);\n});">,
  ];

  type First = Invoke<typeof later, [ms: 500, value: "a"]>;
  type Second = Invoke<typeof later, [ms: 1_000, value: "b"]>;

  /** run under fake time: two calls, each started before the time it waits on */
  export type TwoUnderFakeTime = Given<
    [FakeTimers, First, AdvanceTimers<500>, Second, AdvanceTimers<1_000>],
    [Expect<First, "=", "a">, Expect<Second, "=", "b">]
  >;

  type Matrix = `    const later = (ms: number): Promise<string> => new Promise((r) => setTimeout(() => r("done"), ms));
    const fails = async (ms: number): Promise<string> => { throw new Error("late"); };
    const g = (x: string): string => x + "!";
    const ga = async (x: string): Promise<string> => x + "?";
    const box = async () => ({ get: async (k: string) => k });
    const thenable = (ms: number): PromiseLike<string> => ({ then: (ok: any) => (setTimeout(() => ok("done"), ms), undefined as any) });
    declare namespace later {
      type A = Invoke<typeof later, [ms: 10]>;
      type AA = A;
      type E = Caught<Invoke<typeof fails, [ms: 10]>>;
      type F = Invoke<typeof fails, [ms: 10]>;
      type B = Invoke<typeof box>;
      type Fx = Fixture<string, A>;
      type P<X extends string = "x"> = Invoke<typeof g, [A]>;
      type DP<X extends string = P> = Invoke<typeof g, [X]>;
      type Th = Invoke<typeof thenable, [ms: 10]>;
      type D<X extends string = A> = Invoke<typeof g, [X]>;
      type Sh<A extends string = "x"> = Invoke<typeof g, [A]>;
      export type Value = Given<[FakeTimers, A, AdvanceTimers<10>], Expect<A, "=", "done">>;
      export type Argument = Given<[FakeTimers, A, AdvanceTimers<10>], Expect<Invoke<typeof g, [A]>, "=", "done!">>;
      export type Receiver = Given<[FakeTimers, A, AdvanceTimers<10>], Expect<Call<A, "toUpperCase">, "=", "DONE">>;
      export type Method = Given<[FakeTimers, B, AdvanceTimers<10>], Expect<Call<B, "get", [k: "k"]>, "=", "k">>;
      export type Shapes = Given<[FakeTimers, A, AdvanceTimers<10>], Expect<{ k: A; l: [A, AA] }, "=", { k: "done"; l: ["done", "done"] }>>;
      export type UnderCaught = Given<[FakeTimers, E, AdvanceTimers<10>], Expect<E, "matches", { message: "late" }>>;
      export type UnderThrows = Given<[FakeTimers, F, AdvanceTimers<10>], [Expect<1, "=", 1>, Throws<F, "late">]>;
      export type OfAlias = Given<[FakeTimers, AA, AdvanceTimers<10>], Expect<A, "=", "done">>;
      export type InBody = Given<[FakeTimers, A, AdvanceTimers<10>], Expect<P, "=", "done!">>;
      export type AsDefault = Given<[FakeTimers, A, AdvanceTimers<10>], Expect<D, "=", "done!">>;
      export type Shadowed = Given<[FakeTimers, A, AdvanceTimers<10>], Expect<Sh, "=", "x!">>;
      export type UnderFixture = Given<[FakeTimers, Fx, AdvanceTimers<10>], Expect<Fx, "=", "done">>;
      export type Row = Table<typeof g, [[args: [A], expected: "done!"]]>;
      export type Twice = Given<[FakeTimers, A, AdvanceTimers<5>, AdvanceTimers<5>], Expect<A, "=", "done">>;
      export type Last = Given<[FakeTimers, A, AdvanceTimers<10>], Expect<1, "=", 1>>;
      export type Inline = Given<[FakeTimers, Invoke<typeof later, [ms: 10]>, AdvanceTimers<10>], Expect<1, "=", 1>>;
      export type InlineArgument = Given<[FakeTimers, Invoke<typeof ga, [A]>, AdvanceTimers<10>], Expect<1, "=", 1>>;
      export type InlineMethod = Given<[FakeTimers, Call<B, "get", [k: "k"]>, AdvanceTimers<10>], Expect<1, "=", 1>>;
      export type InlineCaught = Given<[FakeTimers, Caught<Invoke<typeof fails, [ms: 10]>>, AdvanceTimers<10>], Expect<1, "=", 1>>;
      export type InlineTwice = Given<[FakeTimers, Invoke<typeof later, [ms: 10]>, AdvanceTimers<5>, AdvanceTimers<5>], Expect<1, "=", 1>>;
      export type Matcher = Given<[FakeTimers, A, AdvanceTimers<10>], Throws<Invoke<typeof g, ["z"]>, { message: A; matches: A; code: A }>>;
      export type DefaultChain = Given<[FakeTimers, A, AdvanceTimers<10>], Expect<DP, "=", "done!!">>;
      export type SpyOf = Given<[FakeTimers, A, AdvanceTimers<10>], Expect<Calls<Spy<(x: string) => string, typeof g>>, "isEmpty">>;
      export type MockedOf = Given<[FakeTimers, A, AdvanceTimers<10>, Call<Mocked<typeof g>, "mockReturnValue", [value: A]>], Expect<1, "=", 1>>;
      export type OfThenable = Given<[FakeTimers, Th, AdvanceTimers<10>], Expect<Th, "=", "done">>;
      export type Read = Given<[FakeTimers, A, AdvanceTimers<10>], Expect<FromFile<"./data.txt">, "=", A>>;
    }
`;

  /**
   * every shape with a started alias or a started inline call prints a test
   * that parses: rounds of review found `await` in a plain arrow and in a
   * parameter's default. A parse check only, as syntaxErrorsIn says
   */
  export type Parses = Expect<Invoke<typeof syntaxErrorsIn, [Matrix]>, "=", []>;

}

const printParam = (p: Param) =>
  `${p.name}: ${p.type}${p.fallback ? ` = ${printExpr(p.fallback)}` : ""}`;

// an alias whose call was started before an AdvanceTimers is that call, awaited
const printBinding = (b: Binding) =>
  b.params
    ? // an object literal as an arrow's body reads as a block: parenthesise it
      `const ${b.name} = ${awaits(b.value) ? "async " : ""}(${b.params.map(printParam).join(", ")}) => ${b.value.kind === "object" ? `(${printExpr(b.value)})` : printExpr(b.value)};`
    : `const ${b.name}${b.annotation ? `: ${b.annotation}` : ""} = ${b.pending ? `await ${b.pending}` : printExpr(b.value)};`;

export type Needs = {
  /** `readFileSync`, for `FromFile`. */
  fs: boolean;
  /** `existsSync`, for `SkipIfNotFound`. */
  exists: boolean;
  /** `nt_env`, for an `Env` with no default. */
  env: boolean;
  /** `recordArtifact`, `encode` and the `{ task }` parameter, for a display page. */
  task: boolean;
  /** `nt_unsupported`, for what could not be materialised. */
  unsupported: boolean;
  /** `vi`, for a `Mock`, a `Mocked`, a `Spy`, fake timers or a stubbed variable. */
  vi: boolean;
  /** `onTestFinished`, to undo a setup when the test ends. */
  finished: boolean;
  /** `nt`, the runtime, for `Caught` and the files a test makes and reads. */
  runtime: boolean;
  /** Value re-imports of type-only bindings: specifier → `a as a$`… */
  imports: Map<string, Set<string>>;
};

// a skipped or planned test never runs, so it has nothing to check
const checksFiles = ({ mode, requires }: TestCase) =>
  requires.length > 0 && (mode === "test" || mode === "test.only");

// recording what a page shows is asynchronous, so the test is too
const showsOnPage = (s: Statement) => s.kind === "assert" && !!s.display;

export function needsOf(t: TestCase): Needs {
  const needs: Needs = {
    fs: false,
    exists: checksFiles(t),
    env: false,
    task: t.body.some(showsOnPage),
    unsupported: false,
    vi: t.mocks.length > 0 || t.setup.length > 0,
    finished: t.setup.length > 0,
    runtime: false,
    imports: t.imports,
  };
  const visit = (e: Expr): void => {
    const needed = DSL_KINDS[e.kind]?.needs;
    if (needed) needs[needed] = true;
    if (e.kind === "env" && !e.fallback) needs.env = true;
    else if (e.kind === "unsupported") needs.unsupported = true;
    children(e).forEach(visit);
  };
  exprsOfTest(t).forEach(visit);
  return needs;
}

export function allNeeds(needs: Needs[]): Needs {
  const imports = new Map<string, Set<string>>();
  for (const n of needs)
    for (const [spec, names] of n.imports)
      imports.set(spec, new Set([...(imports.get(spec) ?? []), ...names]));
  return {
    fs: needs.some((n) => n.fs),
    exists: needs.some((n) => n.exists),
    env: needs.some((n) => n.env),
    task: needs.some((n) => n.task),
    unsupported: needs.some((n) => n.unsupported),
    vi: needs.some((n) => n.vi),
    finished: needs.some((n) => n.finished),
    runtime: needs.some((n) => n.runtime),
    imports,
  };
}

export type EmittedTest = TestCase & {
  lines: Line[];
  code: string;
  needs: Needs;
};

// `.rejects` is awaited however its subject was written
const statementAwaits = (s: Statement) =>
  exprsOf(s).some(awaits) ||
  showsOnPage(s) ||
  (s.kind === "assert" && s.condition === "throws" && rejectsFor(s));

// a generic alias that awaits is an async arrow of its own, so it does not count
const isAsync = (t: TestCase) =>
  t.bindings.some((b) => !b.params && awaits(b.value)) ||
  t.body.some(statementAwaits);

// a factory is handed importOriginal; a module object is the replacement itself
const replacementFactory = ({ from, name, factory }: Replacement) => {
  const replacement = `(await import(${quote(from)}))${member(name)}`;
  return factory
    ? `async (importOriginal) => ${replacement}(importOriginal)`
    : `async () => ${replacement}`;
};

// `import()` rather than a string, so the plugin gives it the test's own copy of the module
export const printMock = ({ path, replacement }: ModuleMock) =>
  `vi.mock(import(${quote(path)})${replacement ? `, ${replacementFactory(replacement)}` : ""});`;

declare namespace printMock {
  /** a mock with no replacement, one with a module object, and one with a factory */
  export type Shapes = Table<
    typeof printMock,
    [
      [
        args: [{ path: "./rates.ts"; replacement: null; line: 0 }],
        expected: 'vi.mock(import("./rates.ts"));',
      ],
      [
        args: [
          {
            path: "./rates.ts";
            replacement: {
              from: "./fakes.ts";
              name: "fakeRates";
              factory: false;
            };
            line: 0;
          },
        ],
        expected: 'vi.mock(import("./rates.ts"), async () => (await import("./fakes.ts")).fakeRates);',
      ],
      [
        args: [
          {
            path: "./rates.ts";
            replacement: { from: "./fakes.ts"; name: "default"; factory: true };
            line: 0;
          },
        ],
        expected: 'vi.mock(import("./rates.ts"), async (importOriginal) => (await import("./fakes.ts")).default(importOriginal));',
      ],
    ]
  >;
}

const anyMissing = (paths: string[]) =>
  paths.map((path) => `!existsSync(${fileUrl(quote(path))})`).join(" || ");

// a test that needs a missing file is skipped, whatever it would otherwise have been
const testFunction = (t: TestCase) => {
  if (!checksFiles(t)) return t.mode;
  return t.mode === "test"
    ? `test.skipIf(${anyMissing(t.requires)})`
    : `(${anyMissing(t.requires)} ? test.skip : ${t.mode})`;
};

export function printTest(t: TestCase): EmittedTest {
  const needs = needsOf(t);
  const scope = names(namesIn(t));
  const before = placed(t);
  // a row says what it shows; one that says nothing is described by its table
  const shown = t.rowDoc ?? t.doc;
  const doc: Line[] = shown
    ? [{ code: `/** ${shown.text.replace(/\n/g, " ")} */`, line: shown.line }]
    : [];
  const mocks: Line[] = t.mocks.map((mock) => ({
    code: printMock(mock),
    line: mock.line,
  }));
  const lines: Line[] =
    t.mode === "test.todo"
      ? [...doc, { code: `test.todo(${quote(t.name)});`, line: t.line }]
      : [
          ...mocks,
          ...doc,
          {
            code: `${testFunction(t)}(${quote(t.name)}${Object.keys(t.options).length ? `, ${JSON.stringify(t.options)}` : ""}, ${isAsync(t) ? "async " : ""}(${needs.task ? "{ task }" : ""}) => {`,
            line: t.line,
          },
          ...printSetup(t.setup).map(({ code, line }) => ({
            code: `  ${code}`,
            line,
          })),
          // each alias declared where the test first reaches it, so the effects run as written
          ...printBody(t.body, scope, before)
            .flat()
            .map(({ code, line }) => ({ code: `  ${code}`, line })),
          // a test with no statements still declares what it names
          ...(t.body.length ? [] : before[0]!).map((b) => ({
            code: `  ${printBinding(b)}`,
            line: b.line,
          })),
          { code: `});`, line: t.line },
        ];
  return { ...t, lines, code: lines.map((l) => l.code).join("\n"), needs };
}

const CODEC = fileURLToPath(new URL("../codec.mts", import.meta.url));
const RUNTIME = fileURLToPath(new URL("../runtime.mts", import.meta.url));

const vitestImports = (needs: Needs) =>
  [
    "test",
    "expect",
    needs.vi && "vi",
    needs.finished && "onTestFinished",
    needs.task && "recordArtifact",
  ]
    .filter(Boolean)
    .join(", ");

// `file` is the module the tests are printed from; they are served, and extracted, beside it
export function headerLines(needs: Needs, file: string): string[] {
  const valueImport = (n: string, spec: string) =>
    `import ${n} from ${quote(spec)}; // value import: the original import is type-only`;
  const lines = [
    `// ───────── generated by namespace-tests; not part of your build ─────────`,
    `import { ${vitestImports(needs)} } from "vitest";`,
    needs.task && `import { encode } from ${quote(importPath(file, CODEC))};`,
    needs.runtime && `import * as nt from ${quote(importPath(file, RUNTIME))};`,
    (needs.exists || needs.fs) &&
      `import { ${[needs.exists && "existsSync", needs.fs && "readFileSync"].filter(Boolean).join(", ")} } from "node:fs";`,
    ...[...needs.imports].flatMap(([spec, names]) => {
      const namespace = [...names].filter((n) => n.startsWith("* as "));
      const named = [...names].filter((n) => !n.startsWith("* as "));
      return [
        ...namespace.map((n) => valueImport(n, spec)),
        named.length > 0 && valueImport(`{ ${named.join(", ")} }`, spec),
      ];
    }),
    needs.unsupported &&
      "const nt_unsupported = (t: string) => { throw new Error(`namespace-tests: cannot materialize \\`${t}\\``); };",
    needs.env &&
      "const nt_env = (n: string) => { if (process.env[n] === undefined) throw new Error(`namespace-tests: env var ${n} is not set`); return process.env[n]!; };",
  ];
  return lines.filter((l): l is string => typeof l === "string");
}

declare namespace testFunction {
  type Suite = `
    const one = () => 1;
    declare namespace one {
      export type Focused = Only<SkipIfNotFound<"./absent.json", Expect<Invoke<typeof one>, "=", 1>>>;
      export type Rows = SkipIfNotFound<"./absent.json", Table<typeof one, [[args: [], expected: 1]]>>;
      export type Skipped = Skip<SkipIfNotFound<"./absent.json", Expect<Invoke<typeof one>, "=", 1>>>;
    }
  `;

  /** a test that needs a missing file is skipped, and otherwise keeps its mode */
  export type OnlyStaysOnly = Expect<
    Invoke<typeof printAlias, [Suite, "Focused"]>,
    "includes",
    '(!existsSync(new URL("./absent.json", import.meta.url)) ? test.skip : test.only)("one > Focused"'
  >;

  /** every row of a table checks for the file */
  export type EveryRow = Expect<
    Invoke<typeof printAlias, [Suite, "Rows"]>,
    "startsWith",
    'test.skipIf(!existsSync(new URL("./absent.json", import.meta.url)))("one > Rows[0]"'
  >;

  /** a test already skipped checks for nothing */
  export type SkippedChecksNothing = Expect<
    Invoke<typeof printAlias, [Suite, "Skipped"]>,
    "startsWith",
    'test.skip("one > Skipped"'
  >;
}
