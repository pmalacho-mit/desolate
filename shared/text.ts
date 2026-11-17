// Text someone else wrote (an agent, a repository, a VM), on its way to a person: to a
// terminal, where some characters are commands, and to a page or a prompt, where others
// change what is seen (bidirectional overrides reorder a line; zero-width characters hide in
// one). One rule for every place desolate shows such text.
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Table } from "../../suede.nests/dsl.import.meta.vitest.ts";

/** Controls, format characters (bidirectional overrides, zero-width), private-use and
 *  unassigned code points, and the line and paragraph separators. */
const UNSAFE = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/gu;

/** Text another wrote, safe to print in a terminal: no control characters, no
 *  bidirectional overrides or invisible formatting, and not too long. */
export const printable = (value: unknown, max = 300, instead = "?"): string =>
  [
    ...String(value ?? "")
      .slice(0, max * 4)
      .normalize("NFC")
      .replace(UNSAFE, instead),
  ]
    .slice(0, max)
    .join("");
declare namespace printable {
  /** text kept; what a terminal would act on (controls, bidirectional overrides, invisible
   *  formatting) replaced; cut to length */
  export type Cases = Table<
    typeof printable,
    [
      [args: [value: "issue/12 ✓ café"], expected: "issue/12 ✓ café"],
      [args: [value: "a\u0000b\u001bc"], expected: "a?b?c"],
      [args: [value: "ready \u202edlrow"], expected: "ready ?dlrow"],
      [args: [value: "zero\u200bwidth"], expected: "zero?width"],
      [args: [value: "xxxxxxxxxx", max: 4], expected: "xxxx"],
      [args: [value: undefined], expected: ""],
      [args: [value: "a\tb\nc", max: 10, instead: " "], expected: "a b c"],
      /** a carriage return cannot send the cursor back to write over what was printed */
      [args: [value: "tests: ok\rFAIL"], expected: "tests: ok?FAIL"],
      /** one spelling of each character (NFC), and its length counted in characters, an emoji
       *  one, not in UTF-16 units */
      [args: [value: "cafe\u0301"], expected: "caf\u00e9"],
      [args: [value: "\u{1f44d}\u{1f44d}\u{1f44d}", max: 2], expected: "\u{1f44d}\u{1f44d}"],
      [args: [value: 42], expected: "42"],
    ]
  >;
}

/** As printable, for text of many lines: newlines and tabs are kept, and nothing is cut. */
export const printableLines = (value: unknown, instead = "?"): string =>
  String(value ?? "")
    .split("\n")
    .map((line) =>
      line
        .split("\t")
        .map((part) => printable(part, Infinity, instead))
        .join("\t"),
    )
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
      return line.replace(UNSAFE, (c) =>
        c === "\n" || c === "\t" ? c : `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
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
    ]
  >;
}
