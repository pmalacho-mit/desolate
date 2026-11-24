// Exit codes a harness can rely on (section 9.1). v2's, kept.
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type {
  Construct,
  Expect,
  Invoke,
  Throws,
} from "../../suede.nests/dsl.import.meta.vitest.ts";

export const EXIT = {
  ok: 0,
  failed: 1,
  usage: 64,
  /** Something else holds what this needs; trying again later can succeed. */
  busy: 75,
  /** A push to the default branch without --allow-default. */
  defaultBranch: 77,
  /** A push with no person's confirmation (P2). Not retryable by a script. */
  unconfirmed: 78,
  /** --expect did not match what would be pushed. */
  expectMismatch: 79,
} as const;

/** An error whose message is for the person, and whose `fix` names the command or flag that
 *  resolves it (P6: every refusal names what to do). */
export class Refusal extends Error {
  code: number;
  fix: string;
  constructor(message: string, fix: string, code: number = EXIT.failed) {
    super(message);
    this.code = code;
    this.fix = fix;
  }
}

declare namespace Refusal {
  type Busy = Construct<
    typeof Refusal,
    [message: "another push holds acme/app", fix: "wait, then run `desolate push` again", code: 75]
  >;
  type Plain = Construct<
    typeof Refusal,
    [message: "no such domain: dev", fix: "desolate domain create dev"]
  >;
  /** what went wrong, for the person; what to run; the exit code a script reads
   *  @principle P6 */
  export type Says = [
    Expect<Busy["message"], "=", "another push holds acme/app">,
    Expect<Busy["fix"], "=", "wait, then run `desolate push` again">,
    Expect<Busy["code"], "=", 75>,
  ];
  /** without a code, an ordinary failure */
  export type Failed = Expect<Plain["code"], "=", 1>;
}
// A function declaration, so that TypeScript narrows after `if (!ok) refuse(...)`.
export function refuse(message: string, fix: string, code?: number): never {
  throw new Refusal(message, fix, code);
}

declare namespace refuse {
  /** it never returns: it throws a Refusal, which the CLI prints with its fix */
  export type ThrowsARefusal = Throws<
    Invoke<
      typeof refuse,
      [message: "no such domain: dev", fix: "desolate domain create dev", code: 64]
    >,
    { instanceOf: Refusal; message: "no such domain: dev" }
  >;
}
