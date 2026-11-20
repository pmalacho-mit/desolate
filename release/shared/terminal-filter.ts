// What an agent prints, on its way to the person's own terminal (desolate agent attach,
// desolate exec to a terminal): the terminal emulator on the Mac is not inside any boundary,
// and some of its escape sequences act beyond the screen (OSC 52 writes the clipboard;
// iTerm2's OSC 1337 offers files and runs triggers; DCS strings feed tmux integration and
// sixel parsers, where emulators have had their worst bugs). An agent's output is kept to
// what a full-screen program needs: text, C0 controls, and CSI and single-character escapes
// (colour, cursor movement, scrolling regions, the alternate screen). Every OSC, DCS, APC, PM
// and SOS string is dropped whole, wherever a read happens to split it.
//
// tmux used to stand between the two, interpreting all of it itself; with the agent's terminal
// streamed straight through, this does that part of tmux's job.
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Invoke, Table } from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { byteByByte, inChunks, repeat } from "../.harness/shared-terminal.ts";

const ESC = 0x1b;
const BEL = 0x07;
/** ESC followed by these opens a string that runs to ST (ESC \) or, for OSC, BEL. */
const STRING_OPENERS = new Set([
  0x5d /* ] OSC */, 0x50 /* P DCS */, 0x5f /* _ APC */, 0x5e /* ^ PM */, 0x58 /* X SOS */,
]);
// (Raw 8-bit C1 bytes are not touched: in UTF-8 they are parts of ordinary characters, ✓ is
// E2 9C 93. A C1 control written AS UTF-8, C2 80 to C2 9F, is dropped below.)

export type TerminalFilter = ((chunk: Buffer) => Buffer) & { reset: () => string };

export const terminalFilter = (): TerminalFilter => {
  // "text": passing bytes; "esc": just saw ESC; "csi": inside ESC [ ... (held, to look at);
  // "string": inside a string to drop; "stringEsc": inside one, just saw ESC (ST may follow);
  // "c2": just saw 0xC2, which with 0x80-0x9F is a C1 control written as UTF-8 (U+0080 to
  // U+009F: some emulators act on those as on ESC-forms: OSC, DCS, CSI); "csiIgnore": inside
  // a CSI the filter will not pass, dropped up to and with its final byte.
  let state: "text" | "esc" | "csi" | "csiIgnore" | "string" | "stringEsc" | "c2" = "text";
  let dropped = 0;
  let csi: number[] = [];
  // On the alternate screen, as far as what passed says (a full-screen program's own).
  let alternate = false;
  const filter = (chunk: Buffer): Buffer => {
    const out: number[] = [];
    const emitCsi = (final: number) => {
      const params = Buffer.from(csi).toString("latin1");
      csi = [];
      // xterm's window operations (move, resize, report the title): not an agent's.
      if (final === 0x74 /* t */) return;
      // SGR 8 (concealed): text that is copied but not seen. Taken out of an SGR.
      if (final === 0x6d /* m */ && /(^|;)(8|28)(;|$)/.test(params)) {
        const kept = params
          .split(";")
          .filter((p) => p !== "8" && p !== "28")
          .join(";");
        out.push(ESC, 0x5b, ...Buffer.from(kept, "latin1"), final);
        return;
      }
      if (
        (final === 0x68 /* h */ || final === 0x6c) /* l */ &&
        /^\?(\d+;)*(1049|1047|47)(;\d+)*$/.test(params)
      )
        alternate = final === 0x68;
      out.push(ESC, 0x5b, ...Buffer.from(params, "latin1"), final);
    };
    for (const byte of chunk) {
      if (state === "text") {
        if (byte === ESC) state = "esc";
        else if (byte === 0xc2) state = "c2";
        else out.push(byte);
      } else if (state === "c2") {
        if (byte >= 0x80 && byte <= 0x9f)
          state = "text"; // a C1 control: dropped
        else {
          out.push(0xc2);
          state = "text";
          if (byte === ESC) state = "esc";
          else if (byte === 0xc2) state = "c2";
          else out.push(byte);
        }
      } else if (state === "esc") {
        if (STRING_OPENERS.has(byte)) {
          state = "string";
          dropped = 0;
        } else if (byte === 0x5b /* [ */) {
          state = "csi";
          csi = [];
        } else {
          out.push(ESC);
          if (byte === ESC) continue;
          // A C1 control after ESC is still one (C2 9D is OSC, C2 9B CSI, C2 90 DCS): it goes
          // to the state that reads it, as in text. Passed raw, everything the filter drops
          // came through behind it (audit, 2026-11-20).
          if (byte === 0xc2) {
            state = "c2";
            continue;
          }
          out.push(byte);
          state = "text";
        }
      } else if (state === "csi" || state === "csiIgnore") {
        // As a terminal's own parser reads a CSI (the DEC/VT500 state machine xterm and the
        // others follow): a C0 control inside one is carried out and the CSI goes on, DEL is
        // ignored, CAN and SUB cancel it, ESC cancels it and starts another. So the filter must
        // go on reading it too: letting what it held go as text, at a control, once passed a
        // window operation or SGR 8 straight through (in-source tests, 2026-11-16).
        if (byte >= 0x40 && byte <= 0x7e) {
          if (state === "csi") emitCsi(byte);
          csi = [];
          state = "text";
        } else if (byte >= 0x20 && byte <= 0x3f) {
          if (state === "csi" && csi.length < 256) csi.push(byte);
          // Longer than any program writes: not held further, and not passed.
          else {
            csi = [];
            state = "csiIgnore";
          }
        } else if (byte === 0x18 /* CAN */ || byte === 0x1a /* SUB */) {
          csi = [];
          state = "text";
        } else if (byte === ESC) {
          csi = [];
          state = "esc";
        } else if (byte < 0x20) out.push(byte);
        else if (byte === 0x7f) continue;
        else {
          // A byte past ASCII has no place in a CSI: what a terminal makes of it differs, so the
          // whole CSI is dropped, to its final byte.
          csi = [];
          state = "csiIgnore";
        }
      } else if (state === "string") {
        dropped++;
        if (byte === BEL) state = "text";
        else if (byte === ESC) state = "stringEsc";
        // A string that never ends is not allowed to swallow the session: after 64 KiB the
        // filter gives up on it and passes text again.
        else if (dropped > 65536) state = "text";
      } else {
        state = byte === 0x5c /* \ : ST */ ? "text" : byte === ESC ? "stringEsc" : "string";
      }
    }
    return Buffer.from(out);
  };
  return Object.assign(filter, { reset: () => resetAfter(alternate) });
};

declare namespace terminalFilter {
  /** a string split across reads is still dropped whole, its ST split too, and what follows
   *  it passes */
  export type AcrossReads = Table<
    typeof inChunks,
    [
      [
        args: [make: typeof terminalFilter, chunks: ["a\u001b", "]52;c;", "cm0gLXJmIH4=\u0007b"]],
        expected: "ab",
      ],
      [
        args: [make: typeof terminalFilter, chunks: ["a\u001b]0;title\u001b", "\\b"]],
        expected: "ab",
      ],
    ]
  >;
  /** one byte a read: the same as one read, for what passes and for what is dropped. A
   *  character of UTF-8 split between reads arrives whole */
  export type ByteByByte = Table<
    typeof byteByByte,
    [
      [
        args: [make: typeof terminalFilter, text: "\u001b[1;32mok ✓\u001b[0m"],
        expected: "\u001b[1;32mok ✓\u001b[0m",
      ],
      [
        args: [make: typeof terminalFilter, text: "a\u001b]52;c;eA==\u0007b\u009dc"],
        expected: "abc",
      ],
      // A C1 control right after ESC is still dropped (it once passed: audit, 2026-11-20).
      [
        args: [make: typeof terminalFilter, text: "a\u001b\u009d52;c;eA==\u0007b\u001b\u009b8mc"],
        expected: "a\u001b52;c;eA==\u0007b\u001b8mc",
      ],
    ]
  >;
  /** 0xC2 starts ordinary characters too (a no-break space is C2 A0): only C2 80 to C2 9F,
   *  the C1 controls, are dropped */
  export type NotC1 = Expect<
    Invoke<
      typeof byteByByte,
      [make: typeof terminalFilter, text: "no-break\u00a0space, \u00a9 2026"]
    >,
    "=",
    "no-break\u00a0space, \u00a9 2026"
  >;
  /** a string that never ends does not swallow the session: after 64 KiB of it, text passes
   *  again (here the last 4466 of 70,000 bytes, then "after") */
  export type NeverEnds = Expect<
    Invoke<
      typeof inChunks,
      [
        make: typeof terminalFilter,
        chunks: ["\u001b]52;", Invoke<typeof repeat, [text: "x", count: 70000]>, "after"],
      ]
    >["length"],
    "=",
    4471
  >;
  /** inside a CSI, a terminal carries out a C0 control and goes on reading the CSI, and
   *  ignores DEL: so the filter does too, and the window operation (t) or concealed text
   *  (SGR 8) the control was hiding is still dropped; the control itself passes, in order */
  export type ControlInsideCsi = Table<
    typeof filtered,
    [
      [args: [text: "a\u001b[\u00018;100;200tb"], expected: "a\u0001b"],
      [args: [text: "\u001b[1;\r8m"], expected: "\r\u001b[1m"],
      [args: [text: "a\u001b[8\u007f;100;200tb"], expected: "ab"],
      [args: [text: "\u001b[3\b1mred"], expected: "\b\u001b[31mred"],
    ]
  >;
  /** CAN and SUB cancel a CSI, and ESC cancels it and starts another: nothing of the
   *  cancelled one is passed, and what follows is read afresh */
  export type Cancelled = Table<
    typeof filtered,
    [
      [args: [text: "a\u001b[8;100\u0018;200tb"], expected: "a;200tb"],
      [args: [text: "a\u001b[8;100\u001a;200tb"], expected: "a;200tb"],
      [args: [text: "a\u001b[8\u001b[32mb"], expected: "a\u001b[32mb"],
    ]
  >;
  /** a CSI the filter will not hold (longer than 256 bytes) or that has a byte past ASCII in
   *  it is dropped whole, to its final byte: none of it reaches the terminal as text that
   *  the terminal would still read as the CSI */
  export type DroppedWhole = Table<
    typeof filtered,
    [[args: [text: "a\u001b[8\u00ff;100;200tb"], expected: "ab"]]
  >;
  export type TooLong = Expect<
    Invoke<
      typeof inChunks,
      [
        make: typeof terminalFilter,
        chunks: ["a\u001b[", Invoke<typeof repeat, [text: "1;", count: 200]>, "8mb"],
      ]
    >,
    "=",
    "ab"
  >;
}

/** What undoes the modes a full-screen program may leave on: after a detach, your shell's
 *  terminal is yours again (mouse reporting, focus events, a hidden cursor, keypad mode,
 *  bracketed paste, colours), and the alternate screen left if the program was on it. Only
 *  then: leaving it (CSI ?1049l) also restores the cursor saved on the way in, and with
 *  nothing saved the cursor jumped to the top of the screen, where your prompt then wrote
 *  over what the agent had printed. */
export const resetAfter = (alternate: boolean) =>
  `${alternate ? "\u001b[?1049l" : ""}\u001b[?1000l\u001b[?1002l\u001b[?1003l\u001b[?1006l\u001b[?1004l\u001b[?2004h\u001b[?25h\u001b>\u001b[0m`;

declare namespace resetAfter {
  /** mouse, focus events, bracketed paste, the cursor, keypad, colours; and the alternate
   *  screen left only when the program was on it */
  export type Sequences = Table<
    typeof resetAfter,
    [
      [
        args: [alternate: false],
        expected: "\u001b[?1000l\u001b[?1002l\u001b[?1003l\u001b[?1006l\u001b[?1004l\u001b[?2004h\u001b[?25h\u001b>\u001b[0m",
      ],
      [
        args: [alternate: true],
        expected: "\u001b[?1049l\u001b[?1000l\u001b[?1002l\u001b[?1003l\u001b[?1006l\u001b[?1004l\u001b[?2004h\u001b[?25h\u001b>\u001b[0m",
      ],
    ]
  >;
}

/** The reset owed after this output: for the tests below. */
export const resetOwed = (text: string): boolean => {
  const filter = terminalFilter();
  filter(Buffer.from(text, "utf8"));
  return filter.reset().startsWith("\u001b[?1049l");
};

declare namespace resetOwed {
  /** the alternate screen is left only by what entered it, and is not left twice */
  export type Cases = Table<
    typeof resetOwed,
    [
      [args: [text: "plain output\r\n"], expected: false],
      [args: [text: "\u001b[?1049h\u001b[2Jtui"], expected: true],
      [args: [text: "\u001b[?1049hdrawn\u001b[?1049l"], expected: false],
      [args: [text: "\u001b[?1000;1049h"], expected: true],
      [args: [text: "\u001b[?25l\u001b[?1004h"], expected: false],
    ]
  >;
}

/** One chunk, filtered alone: for the tests below. */
export const filtered = (text: string): string =>
  terminalFilter()(Buffer.from(text, "utf8")).toString("utf8");

declare namespace filtered {
  /** colour, cursor movement and the alternate screen pass: a TUI still draws; so does UTF-8 */
  export type Text = Expect<
    Invoke<typeof filtered, [text: "ready ✓ café ❝quoted❞"]>,
    "=",
    "ready ✓ café ❝quoted❞"
  >;
  export type Kept = Expect<
    Invoke<typeof filtered, [text: "\u001b[1;32mok\u001b[0m \u001b[?1049h\u001b[2J\u001b[H"]>,
    "=",
    "\u001b[1;32mok\u001b[0m \u001b[?1049h\u001b[2J\u001b[H"
  >;
  /** C1 controls written as UTF-8 (U+009D is OSC), window operations, concealed text */
  export type Others = [
    Expect<Invoke<typeof filtered, [text: "a\u009d52;c;eA==\u0007b"]>, "=", "a52;c;eA==\u0007b">,
    Expect<Invoke<typeof filtered, [text: "a\u001b[8;100;200tb"]>, "=", "ab">,
    Expect<
      Invoke<typeof filtered, [text: "\u001b[1;8mhidden\u001b[0m"]>,
      "=",
      "\u001b[1mhidden\u001b[0m"
    >,
    Expect<Invoke<typeof filtered, [text: "\u001b[8m"]>, "=", "\u001b[m">,
  ];
  /** the clipboard, a title, a hyperlink, iTerm2's own: dropped, ended by BEL or by ST */
  export type Dropped = [
    Expect<Invoke<typeof filtered, [text: "a\u001b]52;c;cm0gLXJmIH4=\u0007b"]>, "=", "ab">,
    Expect<Invoke<typeof filtered, [text: "a\u001b]0;You have been pwned\u001b\\b"]>, "=", "ab">,
    Expect<Invoke<typeof filtered, [text: "a\u001b]1337;File=name=eA==:eA==\u0007b"]>, "=", "ab">,
    Expect<Invoke<typeof filtered, [text: "a\u001bP1000p%session-changed\u001b\\b"]>, "=", "ab">,
    Expect<Invoke<typeof filtered, [text: "a\u001b_payload\u001b\\b"]>, "=", "ab">,
  ];
}
