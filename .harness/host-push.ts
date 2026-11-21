// Harness for the in-source tests of host/push.ts's account of a push in the terminal: it
// stands in for desolate's reviewer and what it says (shared/review-account.ts), in numbers
// no test would type out.
import type { Account, AccountLine, AccountRequest } from "../shared/review-account.ts";

/** An account with `warnings` warnings ("warning 1" ...), whose first page of files is
 *  `forge` files that change what runs on the forge and then `plain` that do not, of `total`
 *  files in all; and its squash, whose message has `lines` lines ("line 1" ...). */
export const accountOf = (
  warnings: number,
  forge: number,
  plain: number,
  total: number,
  lines: number,
): Account => {
  const sends = { pack: "e".repeat(64), size: 100, lfs: [] };
  return {
    key: "k",
    warnings: Array.from({ length: warnings }, (_, i) => `warning ${i + 1}`),
    commits: { items: [], total: 2, from: 0 },
    files: {
      items: [
        ...Array.from({ length: forge }, (_, i) => ({
          path: `.github/workflows/${i + 1}.yml`,
          added: 1,
          removed: 0,
          sensitive: true,
        })),
        ...Array.from({ length: plain }, (_, i) => ({
          path: `src/${i + 1}.ts`,
          added: 1,
          removed: 0,
        })),
      ],
      total,
      from: 0,
    },
    between: { items: [], total: 0, from: 0 },
    sends,
    squash: {
      commit: "5".repeat(40),
      parent: null,
      count: 2,
      message: Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join("\n") + "\n",
      author: "A",
      committer: "A",
      dates: "",
      sends,
    },
    fastForward: null,
    base: null,
    remote: null,
  };
};

/** Which of `wanted` some line of `lines` holds. */
export const shownOf = (lines: string[], wanted: string[]): string[] =>
  wanted.filter((w) => lines.some((line) => line.includes(w)));

/** A reviewer that answers every question for a page of the files with `files`, from where
 *  it was asked; or, given a string, with that error. */
export const pagesOf = (files: Account["files"]["items"] | string) =>
  async function* (request: AccountRequest): AsyncGenerator<AccountLine> {
    yield { progress: { phase: "listing" } };
    if (typeof files === "string") return void (yield { error: files });
    const from = request.op === "page" ? request.from : 0;
    yield { page: { files: { items: files, total: from + files.length, from } } };
  };
