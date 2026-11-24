// Harness for in-source tests of host/replies.ts: what the Mac takes of an answer of the root's,
// or what it says when it takes none of it, as one value a table can hold.
import { replyOf } from "../host/replies.ts";
import type { Op } from "../host/replies.ts";

/** The answer to `op`, asked with `asked`, as the Mac takes it; or the refusal's message. */
export const answered = (op: Op, value: unknown, asked: Record<string, unknown>): unknown => {
  try {
    return replyOf(op, value, asked);
  } catch (error) {
    return (error as Error).message;
  }
};

/** `value` with some fields given other values: an answer that differs from an honest one in
 *  those alone. */
export const changed = (value: object, changes: object): object => ({ ...value, ...changes });
