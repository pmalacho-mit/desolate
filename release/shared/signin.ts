// The sign-in codes of `desolate ui --open` (host/signin.ts): the two numbers every page
// that takes one agrees on. The host's pages and the root's dashboard each hold their own
// codes; these were written in both (docs/v3/limits.md, R3: one bound, one name, one reason).
export const SIGNIN = {
  /** How long a code waits for its browser, in milliseconds: the command opens the browser
   *  at once, so a minute is a slow machine's worth of it and no more. A bound on how long
   *  a code read from a process list or a history is of any use (R7). */
  ttlMs: 60_000,
  /** Codes held at once; the oldest goes first. One `--open` makes three, so 32 is ten of
   *  them at once, and a loop asking for codes holds no more than that. */
  most: 32,
} as const;
