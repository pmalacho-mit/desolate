// Lists that cross a layer, and their counts (docs/v3/limits.md, R2: a list never states a
// count it did not count). A list of commits, files or branches travels as some of its
// items and its true total: the layer that makes it counts with the cheap exact tool
// (`git rev-list --count`) and lists a page; the layer that shows it shows the total, shows
// the page, and asks for the next when the person wants it. So no list has a cap, and no
// number shown to a person is the size of a cut.
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Table } from "../../suede.nests/dsl.import.meta.vitest.ts";

/** `items`: the entries from `from` on (the first is entry 0), as many as were asked for.
 *  `total`: how many the whole list has, counted, whatever `items` holds. */
export type Listed<T> = { items: T[]; total: number; from: number };

/** A page, not a cap: the next one is asked for. A hundred lines is what a person reads of a
 *  list before they search it instead, and a hundred entries of a path's length are well
 *  inside one message between layers. */
export const PAGE = 100;

/** The page of `all` that starts at `from`, with the true total. For a producer that holds
 *  the whole list; one that does not (a long history) counts and lists with its own tool and
 *  writes the same shape. A `from` or `count` that is not a whole number from 0 up is taken
 *  as the nearest that is: they come from whoever asks for the page. */
export const listed = <T>(all: readonly T[], from = 0, count = PAGE): Listed<T> => {
  const whole = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0);
  const start = Math.min(whole(from), all.length);
  return { items: all.slice(start, start + whole(count)), total: all.length, from: start };
};

declare namespace listed {
  /** a page of the list, and the count of all of it. (The DSL writes a generic function's
   *  rows as literal lists.) */
  export type Pages = Table<
    typeof listed,
    [
      [
        args: [all: ["a", "b", "c", "d", "e"], from: 0, count: 2],
        expected: { items: ["a", "b"]; total: 5; from: 0 },
      ],
      [
        args: [all: ["a", "b", "c", "d", "e"], from: 4, count: 2],
        expected: { items: ["e"]; total: 5; from: 4 },
      ],
      /** with nothing said, the first page; a short list is whole */
      [args: [all: ["a", "b"]], expected: { items: ["a", "b"]; total: 2; from: 0 }],
      [args: [all: []], expected: { items: []; total: 0; from: 0 }],
    ]
  >;
  /** what the asker sends is not trusted to be a place in the list: past the end is the
   *  empty page at the end, and a negative or broken number is the start */
  export type Asked = Table<
    typeof listed,
    [
      [args: [all: ["a", "b", "c"], from: 9, count: 2], expected: { items: []; total: 3; from: 3 }],
      [
        args: [all: ["a", "b", "c"], from: -2, count: 2],
        expected: { items: ["a", "b"]; total: 3; from: 0 },
      ],
      [
        args: [all: ["a", "b", "c"], from: 1.5, count: -1],
        expected: { items: []; total: 3; from: 1 },
      ],
    ]
  >;
}

/** What a shown page leaves unsaid: "and 37 more commits", or null when the page ends the
 *  list. `noun` is one of them; `nouns` is several, when adding an s is not it ("branches"). */
export const andMore = (list: Listed<unknown>, noun: string, nouns = `${noun}s`): string | null => {
  const more = list.total - list.from - list.items.length;
  return more > 0 ? `and ${more} more ${more === 1 ? noun : nouns}` : null;
};

declare namespace andMore {
  /** the rest, counted from the total, never from what the page happens to hold */
  export type Says = Table<
    typeof andMore,
    [
      [
        args: [list: { items: ["a", "b", "c"]; total: 40; from: 0 }, noun: "commit"],
        expected: "and 37 more commits",
      ],
      [
        args: [list: { items: ["c", "d"]; total: 5; from: 2 }, noun: "file"],
        expected: "and 1 more file",
      ],
      [
        args: [list: { items: ["main"]; total: 3; from: 0 }, noun: "branch", nouns: "branches"],
        expected: "and 2 more branches",
      ],
      /** the page that ends the list has nothing to add */
      [args: [list: { items: ["d", "e"]; total: 5; from: 3 }, noun: "file"], expected: null],
      [args: [list: { items: []; total: 0; from: 0 }, noun: "commit"], expected: null],
    ]
  >;
}
