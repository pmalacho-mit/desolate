// T1. The dashboard's diff reads at 4.5:1 (WCAG AA) or more in every colour its syntax
// highlighter gives, light and dark: on the card, on a line added or removed, and on the
// words that changed in such a line (#281: a changed comment read at 1.3:1 in the dark). The
// numbers are the shipped ones: the tints and lightness bounds are read from dashboard.css,
// the colours from the themes in the vendored Shiki bundle, and what the browser draws is
// worked out as CSS Color 4 says (OKLCH, then into sRGB). Where a colour leaves sRGB, the
// browser may clip it or lower its chroma: both are checked. (In Chrome 158 on the Mac, each
// colour's ratio as drawn, read back from a canvas, was within 0.1 of this model.)
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vm from "node:vm";

const RELEASE = path.resolve(import.meta.dirname, "../../../release");
const css = fs.readFileSync(path.join(RELEASE, "root/ui/dashboard.css"), "utf8");
const worker = fs.readFileSync(path.join(RELEASE, "shared/ui/highlight-worker.js"), "utf8");

type Rgb = [number, number, number];
const hex = (value: string): Rgb => {
  const h = value.replace("#", "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255) as Rgb;
};
const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const encoded = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const luminance = (rgb: Rgb) =>
  0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2]);
/** WCAG 2's contrast ratio. */
const ratio = (a: Rgb, b: Rgb) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
};
/** sRGB to OKLab and back (Björn Ottosson's matrices, as CSS Color 4 gives them). */
const toLab = (rgb: Rgb): Rgb => {
  const [r, g, b] = rgb.map(linear) as Rgb;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
};
const fromLab = ([L, a, b]: Rgb): Rgb => {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map(encoded) as Rgb;
};
const clip = (rgb: Rgb) => rgb.map((v) => Math.min(1, Math.max(0, v))) as Rgb;
/** `oklch(from <colour> min(l, bound) c h)` (light) or `max(l, bound)` (dark), as drawn:
 *  each way the browser may bring it into sRGB. */
const bounded = (colour: Rgb, bound: number, dark: boolean): Rgb[] => {
  const [l, a, b] = toLab(colour);
  const to = dark ? Math.max(l, bound) : Math.min(l, bound);
  if (to === l) return [colour];
  let lo = 0;
  let hi = 1;
  for (let k = 0; k < 30; k++) {
    const mid = (lo + hi) / 2;
    if (fromLab([to, a * mid, b * mid]).every((v) => v >= -1e-6 && v <= 1 + 1e-6)) lo = mid;
    else hi = mid;
  }
  return [clip(fromLab([to, a, b])), clip(fromLab([to, a * lo, b * lo]))];
};

/** A block of custom properties (`--name: value;`) as a map. */
const properties = (block: string) =>
  new Map([...block.matchAll(/--([a-z-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
const light = properties(/^:root \{([\s\S]*?)\n\}/m.exec(css)![1]!);
const dark = new Map([
  ...light,
  ...properties(/@media \(prefers-color-scheme: dark\) \{\s*:root \{([\s\S]*?)\}/.exec(css)![1]!),
]);
/** A theme of the bundle, as Shiki was given it. */
const theme = (name: "light" | "dark") =>
  vm.runInNewContext(
    new RegExp(
      `var github_${name}_default=Object\\.freeze\\((JSON\\.parse\\('.*?'\\))\\);var `,
    ).exec(worker)![1]!,
  ) as {
    colors: Record<string, string>;
    tokenColors: { scope?: string | string[]; settings: { foreground?: string } }[];
  };
// A rule's colour meant for its own background, which no grammar desolate loads ever gives:
// highlight.js draws a token's colour only, on the diff's own background.
const UNUSED = ["carriage-return", "markup.ignored", "markup.untracked"];
/** Every colour a token can be drawn in: each rule's, the theme's own text colour, and the
 *  page's ink (a token without one). */
const colours = (name: "light" | "dark", ink: string) => {
  const t = theme(name);
  const out = new Set([t.colors["editor.foreground"]!.toLowerCase(), ink]);
  for (const rule of t.tokenColors)
    if (rule.settings.foreground && ![rule.scope].flat().some((s) => UNUSED.includes(s!)))
      out.add(rule.settings.foreground.toLowerCase());
  return [...out];
};

const THEMES = [
  { name: "light", vars: light, dark: false },
  { name: "dark", vars: dark, dark: true },
] as const;
/** What is behind a token, with the bound that holds there. */
const contexts = (v: Map<string, string>): Record<string, [string, string]> => ({
  "the card": [v.get("card")!, v.get("hl-plain")!],
  "a line added": [v.get("add-line")!, v.get("hl-line")!],
  "a line removed": [v.get("del-line")!, v.get("hl-line")!],
  "a changed word, added": [v.get("add-mark")!, v.get("hl-mark")!],
  "a changed word, removed": [v.get("del-mark")!, v.get("hl-mark")!],
});

describe("T1 the review's diff reads at 4.5:1 in every token colour, light and dark", () => {
  it("each tint and bound is the stylesheet's, and each place uses its own", () => {
    for (const { vars } of THEMES)
      for (const key of ["add-line", "add-mark", "del-line", "del-mark"])
        assert.match(vars.get(key) ?? "", /^#[0-9a-f]{6}$/, key);
    assert.match(
      css,
      /\.hl \{ color: oklch\(from var\(--hl-light, var\(--ink\)\) min\(l, var\(--hl-l\)\) c h\); \}/,
    );
    assert.match(
      css,
      /\.hl \{ color: oklch\(from var\(--hl-dark, var\(--ink\)\) max\(l, var\(--hl-l\)\) c h\); \}/,
    );
    assert.match(
      css,
      /\.sbs-row \.code\.add mark \{ background: var\(--add-mark\); --hl-l: var\(--hl-mark\);/,
    );
    assert.match(
      css,
      /\.sbs-row \.code\.del mark \{ background: var\(--del-mark\); --hl-l: var\(--hl-mark\);/,
    );
    assert.match(
      css,
      /\.sbs-row \.code\.add, \.sbs-row \.no\.add \{ background: var\(--add-line\); --hl-l: var\(--hl-line\); \}/,
    );
    assert.match(
      css,
      /pre\.diff \.add \{ background: var\(--add-line\); --hl-l: var\(--hl-line\); \}/,
    );
    assert.match(
      css,
      /pre\.diff \.del \{ background: var\(--del-line\); --hl-l: var\(--hl-line\); \}/,
    );
  });
  it("the colours left out are only the themes' own: no grammar gives them", () => {
    for (const scope of UNUSED) assert.equal(worker.split(scope).length - 1, 2, scope);
  });
  for (const { name, vars, dark: isDark } of THEMES)
    for (const [where, [background, bound]] of Object.entries(contexts(vars)))
      it(`${name}: on ${where}, every colour at 4.5:1 or more`, () => {
        const bg = hex(background);
        const low = colours(name, vars.get("ink")!).flatMap((colour) =>
          bounded(hex(colour), Number(bound), isDark)
            .map((drawn) => ratio(drawn, bg))
            .filter((r) => r < 4.5)
            .map((r) => `${colour} at ${r.toFixed(2)}`),
        );
        assert.deepEqual(low, []);
      });
  it("control: unbounded, the colours fail where #281 saw it (a comment on a changed word)", () => {
    // Before #281: the tints were the state colours over the card (12%, a word 36% more).
    const over = (fg: Rgb, alpha: number, bg: Rgb) =>
      bg.map((v, i) => v * (1 - alpha) + fg[i]! * alpha) as Rgb;
    const card = hex(dark.get("card")!);
    const green = hex(dark.get("green")!);
    const word = over(green, 0.36, over(green, 0.12, card));
    assert.equal(ratio(hex("#6a737d"), word).toFixed(2), "1.29");
    assert.equal(ratio(hex("#6a737d"), over(green, 0.12, card)).toFixed(2), "3.00");
    // ...and the new tints alone, without the bound, would still fail it.
    assert.ok(ratio(hex("#6a737d"), hex(dark.get("add-mark")!)) < 4.5);
    assert.ok(ratio(hex("#e36209"), hex(light.get("card")!)) < 4.5);
    // Bounded, the same comment reads.
    const drawn = bounded(hex("#6a737d"), Number(dark.get("hl-mark")), true);
    for (const each of drawn) assert.ok(ratio(each, hex(dark.get("add-mark")!)) >= 4.5);
  });
});
