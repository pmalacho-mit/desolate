// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Invoke, Table, Throws } from "../../suede.nests/dsl.import.meta.vitest.ts";

/**
 * Strip JSONC comments and trailing commas.
 */
export function strip(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;

  while (i < n) {
    const c = text[i];

    // Inside a string: copy verbatim through the closing quote, honouring
    // backslash escapes. Comment starts are just characters in here.
    if (c === '"') {
      out += c;
      i++;
      while (i < n) {
        if (text[i] === "\\" && i + 1 < n) {
          out += text[i]! + text[i + 1]!;
          i += 2;
          continue;
        }
        out += text[i];
        if (text[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++; // drop to end of line
      continue;
    }

    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2; // skip the closing */
      continue;
    }

    out += c;
    i++;
  }

  // Trailing commas: JSONC allows them, JSON.parse does not. Only reached
  // outside strings because the loop above already consumed string bodies --
  // but we re-scan defensively rather than regexing over raw text.
  return removeTrailingCommas(out);
}

declare namespace strip {
  /** comments go, line and block; so does a comma before a closing bracket */
  export type Comments = Table<typeof strip, [
    [args: [text: '{\n  // the image\n  "image": "x", /* pinned */\n  "a": [1, 2,],\n}'], expected: '{\n  \n  "image": "x", \n  "a": [1, 2]\n}'],
    [args: [text: '{"a": 1 , }'], expected: '{"a": 1  }'],
  ]>;
  /** inside a string, comment marks and commas are text, and an escaped quote does not end it */
  export type Strings = Table<typeof strip, [
    [args: [text: '{"url": "https://example.com/x", "glob": "src/**/*.ts"}'], expected: '{"url": "https://example.com/x", "glob": "src/**/*.ts"}'],
    [args: [text: '{"s": "a,]", "t": "say \\"// hi\\""}'], expected: '{"s": "a,]", "t": "say \\"// hi\\""}'],
  ]>;
}

function removeTrailingCommas(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      out += c;
      i++;
      while (i < n) {
        if (text[i] === "\\" && i + 1 < n) {
          out += text[i]! + text[i + 1]!;
          i += 2;
          continue;
        }
        out += text[i];
        if (text[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === ",") {
      let j = i + 1;
      while (j < n && /\s/.test(text[j]!)) j++;
      if (text[j] === "}" || text[j] === "]") {
        i++;
        continue;
      } // drop the comma
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Parse a devcontainer.json (JSONC).
 * @throws on anything unparseable.
 */
export const parse = (text: string) => JSON.parse(strip(text));

declare namespace parse {
  /** a devcontainer.json as people write them */
  export type Spec = Expect<Invoke<typeof parse, [text: '{\n  // comments, and a trailing comma\n  "image": "example/dev:1",\n  "runArgs": ["--cap-add=SYS_PTRACE",],\n}']>, "=", { image: "example/dev:1"; runArgs: ["--cap-add=SYS_PTRACE"] }>;
  /** what is not JSON once the comments are gone throws: no guess at what was meant */
  export type Refuses = [
    Throws<Invoke<typeof parse, [text: "{ image: 'x' }"]>, SyntaxError>,
    Throws<Invoke<typeof parse, [text: '{"a": 1 /* never closed']>, SyntaxError>,
  ];
}
