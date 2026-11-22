// Text someone else wrote (an agent, a repository, a VM), on its way to a person: to a
// terminal, where some characters are commands, and to a page or a prompt, where others
// change what is seen (bidirectional overrides reorder a line; zero-width characters hide in
// one). One rule for every place desolate shows such text.
//
// Safe is not short (docs/v3/limits.md, R1). What is here makes text safe, and bounds it
// only against a flood; what it cuts, it marks. Fitting text to a line is the display's.
// The last lines of a program's output (`tail`, `failure`) are a cut too, and say so: how
// much was left out, and where the whole of it is.
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Invoke, Table } from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { keptAt, newlinesThen, notKept, repeat } from "../.harness/shared-text.ts";

/** Controls, format characters (bidirectional overrides, zero-width), private-use and
 *  unassigned code points, half of a surrogate pair, and the line and paragraph separators.
 *  Then the marks and letters that show nothing and are not format characters: the
 *  combining grapheme joiner, the Hangul and Mongolian fillers, the two Khmer vowels Unicode
 *  says not to use (they draw nothing: the second fresh review of #227 U5), and the variation selectors
 *  past the sixteen (U+E0100 on), which no text needs and which carry hidden bytes. The first
 *  sixteen choose how a character looks (U+FE0F: as an emoji), so one is kept after a
 *  character; a run of them is the same smuggling, and from the second on they are unsafe. */
const UNSAFE =
  /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}\u034f\u115f\u1160\u17b4\u17b5\u180b-\u180f\u3164\uffa0\u{e0100}-\u{e01ef}]|(?<=[\ufe00-\ufe0f])[\ufe00-\ufe0f]/gu;

/** The most of a text printable passes when its caller names no bound: a bound against a
 *  flood (a megabyte of status would fill a terminal's scrollback and a page's memory), not
 *  a width. 4,000 characters is fifty full lines of a terminal: more than any one message a
 *  person reads in place, and little enough to print. Making text fit a line is the
 *  display's own job (CSS `text-overflow`, a terminal's wrapping): docs/v3/limits.md, R1. */
export const SAFE_MOST = 4000;

/** The mark that ends text which was cut. It counts toward the bound. */
export const CUT = "…";

/** `value` as text with nothing in it a terminal or a page would act on, at most `max`
 *  characters (code points, after NFC). Cut text ends in the mark, so a cut is never silent.
 *  `tabs`: a tab stays a tab (text of many lines, where a tab is layout). */
const safe = (
  value: unknown,
  max: number,
  instead: string,
  tabs: boolean,
): { text: string; cut: boolean } => {
  let text: string;
  try {
    text = String(value ?? "");
  } catch {
    // An object of another's whose toString is not a function (JSON can say so).
    text = "?";
  }
  const chars = [
    ...text
      .slice(0, max * 4)
      .normalize("NFC")
      .replace(UNSAFE, (c) => (tabs && c === "\t" ? c : instead)),
  ];
  if (chars.length <= max && text.length <= max * 4) return { text: chars.join(""), cut: false };
  return { text: max < 1 ? "" : chars.slice(0, max - 1).join("") + CUT, cut: true };
};

/** Text another wrote, safe to print in a terminal: no control characters, no
 *  bidirectional overrides or invisible formatting. Bounded against a flood (SAFE_MOST
 *  unless the caller names its own bound), and text that was cut ends in `…`. */
export const printable = (value: unknown, max = SAFE_MOST, instead = "?"): string =>
  safe(value, max, instead, false).text;
declare namespace printable {
  /** text kept; what a terminal would act on (controls, bidirectional overrides, invisible
   *  formatting) replaced */
  export type Cases = Table<
    typeof printable,
    [
      [args: [value: "issue/12 ✓ café"], expected: "issue/12 ✓ café"],
      [args: [value: "a\u0000b\u001bc"], expected: "a?b?c"],
      [args: [value: "ready \u202edlrow"], expected: "ready ?dlrow"],
      [args: [value: "zero\u200bwidth"], expected: "zero?width"],
      [args: [value: undefined], expected: ""],
      [args: [value: "a\tb\nc", max: 10, instead: " "], expected: "a b c"],
      /** a carriage return cannot send the cursor back to write over what was printed */
      [args: [value: "tests: ok\rFAIL"], expected: "tests: ok?FAIL"],
      /** one spelling of each character (NFC) */
      [args: [value: "cafe\u0301"], expected: "caf\u00e9"],
      [args: [value: 42], expected: "42"],
      /** what shows nothing and is no format character: half of a pair, a filler, a run of
       *  variation selectors (one, after a character, chooses how it looks, and stays) */
      [args: [value: "a\ud800b"], expected: "a?b"],
      [args: [value: "a\u3164b\u034fc"], expected: "a?b?c"],
      [args: [value: "README.md\u17b4"], expected: "README.md?"],
      [args: [value: "\u2764\ufe0f ok"], expected: "\u2764\ufe0f ok"],
      [args: [value: "x\ufe00\ufe01\ufe02"], expected: "x\ufe00??"],
      [args: [value: "x\u{e0100}\u{e0101}"], expected: "x??"],
    ]
  >;
  /** a cut is said: text over the bound ends in the mark, which counts toward the bound;
   *  text that fits exactly is whole, and carries no mark */
  export type Cut = Table<
    typeof printable,
    [
      [args: [value: "xxxxxxxxxx", max: 4], expected: "xxx…"],
      [args: [value: "xxxx", max: 4], expected: "xxxx"],
      /** its length counted in characters, an emoji one, not in UTF-16 units */
      [args: [value: "\u{1f44d}\u{1f44d}\u{1f44d}", max: 2], expected: "\u{1f44d}…"],
      [args: [value: "\u{1f44d}\u{1f44d}", max: 2], expected: "\u{1f44d}\u{1f44d}"],
      /** composed first, then counted: five letters and an accent are five characters */
      [args: [value: "cafe\u0301s", max: 5], expected: "caf\u00e9s"],
      /** no room for even the mark: nothing */
      [args: [value: "xxxx", max: 0], expected: ""],
    ]
  >;
  /** with no bound named, the bound is the one against a flood: a long reason arrives whole */
  export type Whole = Expect<
    Invoke<typeof printable, [value: Invoke<typeof repeat, [text: "x", count: 4000]>]>,
    "matches",
    "^x{4000}$"
  >;
  /** and a flood does not: 4,000 characters, the last of them the mark */
  export type Flood = Expect<
    Invoke<typeof printable, [value: Invoke<typeof repeat, [text: "x", count: 1000000]>]>,
    "matches",
    "^x{3999}…$"
  >;
}

/** As printable, for text of many lines: newlines and tabs are kept, and nothing is cut. */
export const printableLines = (value: unknown, instead = "?"): string =>
  String(value ?? "")
    .split("\n")
    .map((line) => safe(line, Infinity, instead, true).text)
    .join("\n");

declare namespace printableLines {
  /** a diff or a note, its lines and tabs kept, nothing cut; within a line, as printable */
  export type Cases = Table<
    typeof printableLines,
    [
      [args: [value: "+ ok\n-\tgone\n"], expected: "+ ok\n-\tgone\n"],
      [
        args: [value: "+ x = 1; \u202e// \u2066evil\u2069\n\u001b[2J"],
        expected: "+ x = 1; ?// ?evil?\n?[2J",
      ],
    ]
  >;
}

/** The last `lines` lines of a program's output, and how many lines came before them.
 *  A line ends in a newline or a carriage return and a newline (what a terminal's program
 *  writes); the line ends that end the output are not lines of it. Nothing is made safe
 *  here: that is printable's, and `failure` does both. */
export const tail = (text: string, lines: number): { text: string; before: number } => {
  // (By hand, not by a pattern anchored at the end: that is quadratic on a long run of
  // newlines that something follows, and the output is another's.)
  let end = text.length;
  while (end > 0 && (text[end - 1] === "\n" || text[end - 1] === "\r")) end--;
  const all = end === 0 ? [] : text.slice(0, end).split(/\r?\n/);
  const kept = lines < 1 ? [] : all.slice(-lines);
  return { text: kept.join("\n"), before: all.length - kept.length };
};

declare namespace tail {
  /** the end of it, where a program says why it failed, and a true count of the rest */
  export type Cases = Table<
    typeof tail,
    [
      [
        args: [text: "Cloning\nremote: denied\nfatal: could not read\n", lines: 2],
        expected: { text: "remote: denied\nfatal: could not read"; before: 1 },
      ],
      /** all of it, when it is that short: nothing came before */
      [
        args: [text: "fatal: bad object\n", lines: 5],
        expected: { text: "fatal: bad object"; before: 0 },
      ],
      /** a blank line inside the output is a line; the ones that end it are not */
      [args: [text: "a\n\nb\n\n\n", lines: 2], expected: { text: "\nb"; before: 1 }],
      [args: [text: "", lines: 3], expected: { text: ""; before: 0 }],
      [args: [text: "a\nb", lines: 0], expected: { text: ""; before: 2 }],
      [args: [text: "", lines: 0], expected: { text: ""; before: 0 }],
      /** a program on a terminal ends its lines in CR LF: one line end, not a line of "\r" */
      [
        args: [text: "x\r\nfatal: denied\r\n\r\n", lines: 1],
        expected: { text: "fatal: denied"; before: 1 },
      ],
    ]
  >;
  /** in time that grows with the output, not its square: a long run of blank lines that
   *  something follows (a quadratic trim took minutes on a megabyte of them) */
  export type Linear = Expect<
    Invoke<
      typeof tail,
      [text: Invoke<typeof newlinesThen, [count: 1000000, text: "fatal"]>, lines: 1]
    >,
    "=",
    { text: "fatal"; before: 1000000 }
  >;
}

/** How an error from another layer is shown (R1): the last `lines` lines of what it said,
 *  made safe, and, when that is not all of it, a first line that says how much was left out
 *  and where the whole text is. `keep` is given the whole text when something was left out
 *  (and only then), writes it somewhere a person can read, and answers the path, or null
 *  when it could not: the host keeps them under its logs, the root under its state. A line
 *  is cut, with the mark, only at the bound against a flood (SAFE_MOST). */
export const failure = (
  output: string,
  lines: number,
  keep: (whole: string) => string | null,
): string => {
  const last = tail(output, lines);
  const safeLines = last.text.split("\n").map((line) => safe(line, SAFE_MOST, "?", true));
  const shown = safeLines.map((line) => line.text).join("\n");
  const cut = safeLines.some((line) => line.cut);
  if (last.before === 0 && !cut) return shown;
  let where: string | null = null;
  try {
    where = keep(output);
  } catch {
    /* not kept: said below, by the path's absence */
  }
  const left =
    last.before === 0
      ? "a long line is cut"
      : `${last.before} earlier line${last.before === 1 ? "" : "s"} not shown`;
  return `(${left}${where === null ? "" : `; all of it: ${where}`})\n${shown}`;
};

declare namespace failure {
  /** what a person is shown of a failure: its end, how much came before, where all of it is */
  export type Shown = Expect<
    Invoke<
      typeof failure,
      [
        output: "Cloning into 'app'\nremote: Repository not found.\nfatal: could not read from remote repository\n",
        lines: 2,
        keep: Invoke<typeof keptAt, [path: "/Users/ada/.desolate/logs/clone-1.txt"]>,
      ]
    >,
    "=",
    "(1 earlier line not shown; all of it: /Users/ada/.desolate/logs/clone-1.txt)\nremote: Repository not found.\nfatal: could not read from remote repository"
  >;
  /** short enough to show whole: shown whole, with nothing kept and nothing to say */
  export type Whole = Expect<
    Invoke<typeof failure, [output: "fatal: bad object\n", lines: 5, keep: Invoke<typeof notKept>]>,
    "=",
    "fatal: bad object"
  >;
  /** what another layer said is text, not commands: made safe, its tabs kept */
  export type Safe = Expect<
    Invoke<
      typeof failure,
      [output: "one\n\u001b[2Jtwo\tthree\rFOUR", lines: 1, keep: Invoke<typeof notKept>]
    >,
    "=",
    "(1 earlier line not shown)\n?[2Jtwo\tthree?FOUR"
  >;
  /** a keeper that fails does not hide the failure: the count is still said */
  export type NotKept = Expect<
    Invoke<typeof failure, [output: "a\nb\nc\nd", lines: 1, keep: Invoke<typeof notKept>]>,
    "=",
    "(3 earlier lines not shown)\nd"
  >;
  /** one line that is a flood is cut at the bound against one, and says so */
  export type LongLine = Expect<
    Invoke<
      typeof failure,
      [
        output: Invoke<typeof repeat, [text: "x", count: 5000]>,
        lines: 3,
        keep: Invoke<typeof keptAt, [path: "/var/lib/desolate/failures/1.txt"]>,
      ]
    >,
    "matches",
    "^\\(a long line is cut; all of it: /var/lib/desolate/failures/1.txt\\)\nx{3999}…$"
  >;
}

/** A line on its way to the person's terminal from desolate's CLI, whatever it holds: the
 *  one place every line passes (host/cli.ts), so that text another wrote cannot act on the
 *  terminal however it got into the line. A JSON line (`--json`, `desolate events`) keeps
 *  every character, as an escape (\u009b), so it stays exact and stays JSON, and a script's
 *  `jq -r` is what decides to print it; any other line has them replaced, as printable does.
 *  Newlines and tabs pass. */
export const forTerminal = (line: string): string => {
  const first = line.trimStart()[0];
  if (first === "{" || first === "[" || first === '"') {
    try {
      JSON.parse(line);
      // Each UTF-16 unit of it, so that a character past U+FFFF is escaped whole.
      return line.replace(UNSAFE, (c) =>
        c === "\n" || c === "\t"
          ? c
          : [...Array(c.length).keys()]
              .map((i) => `\\u${c.charCodeAt(i).toString(16).padStart(4, "0")}`)
              .join(""),
      );
    } catch {
      /* not JSON: a line of text that starts with a bracket */
    }
  }
  return printableLines(line);
};

declare namespace forTerminal {
  /** text: replaced; JSON: escaped, exact and still JSON; desolate's own lines unchanged */
  export type Cases = Table<
    typeof forTerminal,
    [
      [
        args: [line: "  dev  acme/app  issue/12  0123456789ab  from w1"],
        expected: "  dev  acme/app  issue/12  0123456789ab  from w1",
      ],
      [
        args: [line: "  vendor/\u001b]52;c;aGk=\u0007lib  changed"],
        expected: "  vendor/?]52;c;aGk=?lib  changed",
      ],
      [args: [line: "a\tb\nc\u009bd"], expected: "a\tb\nc?d"],
      [args: [line: '[{"dir":"x\u009b31m"}]'], expected: '[{"dir":"x\\u009b31m"}]'],
      [args: [line: '{"m":"\u202eevil"}'], expected: '{"m":"\\u202eevil"}'],
      [args: [line: "[not json \u001b[2J"], expected: "[not json ?[2J"],
      /** a character past U+FFFF is escaped as its pair, so the JSON says the same */
      [args: [line: '{"m":"\u{e0041}"}'], expected: '{"m":"\\udb40\\udc41"}'],
    ]
  >;
}
