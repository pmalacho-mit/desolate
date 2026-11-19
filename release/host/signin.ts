// Sign-in codes: how one command (`desolate ui --open`) signs a browser in to all three pages,
// the approval page, the git terminal and the dashboard, each on a name of its own.
//
// The command asks the daemon for a chain of codes and opens its first link. Each page trades
// its code for its own cookie and sends the browser on to the next page's link:
//
//   desolate-approve.localhost/?signin=A  ->  desolate-git.localhost/?signin=G
//                                         ->  desolate.localhost/?signin=D  ->  the dashboard
//
// Why codes, and not each page's token in the next link:
//   - a page's token is its credential for as long as the stack lives, and a link the browser
//     follows is kept in its history. A code is good once, for a minute.
//   - the dashboard is served by the root's user, which may never hold the approval page's
//     credential: whoever holds it can approve a push. So the chain starts on the host's own
//     pages, and the root sees only D, its own page's code, after A and G were spent.
// The cookies are still the browser's session's: quitting the browser signs it out of all three.
import { createHash, randomBytes } from "node:crypto";
import type { Expect, Invoke } from "../../suede.nests/dsl.import.meta.vitest.ts";

export const SIGNIN = {
  /** how long a code waits for its browser: the command opens it at once */
  ttlMs: 60_000,
  /** codes held at once; the oldest goes first (a loop asking for codes holds no more) */
  most: 32,
};

/** The pages served by the host: each takes only its own codes. */
export type Page = "approve" | "git";

const digest = (code: string) => createHash("sha256").update(code).digest("hex");

/** A set of codes. Each is held by its digest, so the lookup leaks nothing of a code. */
export const codes = () => {
  const held = new Map<string, { page: Page; next: string; until: number }>();
  return {
    /** A code that page will take once, before `ttlMs`, for the browser to be sent to `next`.
     *  (`code` only for a test: otherwise 24 random bytes, as each page's token.) */
    mint(page: Page, next: string, code = randomBytes(24).toString("hex"), now = Date.now()) {
      held.set(digest(code), { page, next, until: now + SIGNIN.ttlMs });
      while (held.size > SIGNIN.most) held.delete(held.keys().next().value!);
      return code;
    },
    /** Where to send the browser next, if `given` is a code of this page's, still good; it is
     *  then spent. Undefined for anything else. */
    take(page: Page, given: string, now = Date.now()): string | undefined {
      for (const [key, entry] of held) if (entry.until <= now) held.delete(key);
      if (!/^[0-9a-f]{48}$/.test(given)) return undefined;
      const key = digest(given);
      const entry = held.get(key);
      if (!entry || entry.page !== page) return undefined;
      held.delete(key);
      return entry.next;
    },
  };
};

/** The daemon's: its pages (approve-web.ts, git-web.ts) take what `desolate ui --open` asked for. */
export const signins = codes();
/** A code of the daemon's, for that page (`code` only for a test). */
export const mint = (page: Page, next: string, code?: string) => signins.mint(page, next, code);

/** One code, minted then given back, to the page it is for (or another, or later). */
export const tryCode = (
  mintedFor: Page,
  givenTo: Page,
  given: "the same" | "another" | "the same, twice",
  laterMs = 0,
) => {
  const set = codes();
  const code = set.mint(mintedFor, "http://next.localhost/", undefined, 0);
  const other = "cd".repeat(24);
  if (given === "the same, twice") set.take(givenTo, code, laterMs);
  return set.take(givenTo, given === "another" ? other : code, laterMs) ?? null;
};

declare namespace tryCode {
  /** a code sends the browser on, once */
  export type Once = [
    Expect<
      Invoke<typeof tryCode, ["approve", "approve", "the same"]>,
      "=",
      "http://next.localhost/"
    >,
    Expect<Invoke<typeof tryCode, ["approve", "approve", "the same, twice"]>, "=", null>,
  ];
  /** only on its own page, only before its minute is up, and only that code */
  export type Refused = [
    Expect<Invoke<typeof tryCode, ["approve", "git", "the same"]>, "=", null>,
    Expect<
      Invoke<typeof tryCode, ["git", "git", "the same", 59_999]>,
      "=",
      "http://next.localhost/"
    >,
    Expect<Invoke<typeof tryCode, ["git", "git", "the same", 60_000]>, "=", null>,
    Expect<Invoke<typeof tryCode, ["git", "git", "another"]>, "=", null>,
  ];
}

/** How many of `count` codes, minted in a row, a page still takes: the newest `most`. */
export const heldOf = (count: number) => {
  const set = codes();
  const made = Array.from({ length: count }, () => set.mint("git", "/", undefined, 0));
  return made.filter((code) => set.take("git", code, 0) !== undefined).length;
};

declare namespace heldOf {
  export type Bounded = [
    Expect<Invoke<typeof heldOf, [count: 3]>, "=", 3>,
    Expect<Invoke<typeof heldOf, [count: 40]>, "=", 32>,
  ];
}
