# Limits: the rules, and the contracts between the layers

The triage of 2026-11-20 found 483 hard-coded limits in `release/` (what was done about them
is in [decisions.md](decisions.md), "The limits effort"). Most were not decisions. They were
a layer bounding something it had not designed: a list cut where it should page, a timer
where the person should be asked, a number copied into five files. This file is what
replaces them: the questions each limit is put to, the rules that follow, and the small
shared modules every layer keeps its end of.

## The four questions, in order

For each limit:

1. **Can better code remove it?** A list that pages has no cap. A stream has no buffer limit.
   A lock held by a live process has no age.
2. **If not, is it a moment to ask the person?** "The reviewer has been packing for three
   minutes: keep waiting?" instead of a kill at 95 seconds.
3. **If not, is it a setting?** What depends on this Mac or this person (a VM's size, how many
   shells) is a setting with a default, worked out from the machine where it can be.
4. **Only then is it a hard bound**, and then it says whose input it bounds and why that
   number: the forge's own limit, a protocol's field, the memory of the process that holds it.

## The rules

- **R1. A cut is said.** Making text safe to show (no control characters) is one job; making
  it short is another, and belongs to the display. Anything cut carries a mark and, for a
  list, how much is left. An error's whole text is kept somewhere a person can read it.
- **R2. A list never states a count it did not count.** A list that crosses a layer travels
  as `Listed<T>`: some items, and the true total. A number shown to a person is the total.
- **R3. One bound, one name, one reason.** A bound two layers must agree on is defined once,
  in `shared/limits.ts`, with its reason. Hitting it gives a message about *that* bound, with
  the limit and the actual value, never "not JSON".
- **R4. Patience belongs to whoever is waiting.** One layer owns how long an operation may
  take: the outermost one, where a person (or a program a person started) is waiting. Inner
  layers run until they finish or are cancelled (the requester went away). No layer adds a
  timer of its own inside another's. The only timers left are *idle* timers against a peer
  that is remote or not trusted (the forge, a VM, a browser): "nothing arrived for N", not
  "it took longer than N". A long step says what it is doing while it does it.
- **R5. A lock is held by something alive, not by its age.** `shared/lock.ts`. The holder is
  named in the lock, and a lock is stale only when its holder is gone.
- **R6. What depends on the machine or the person is a setting.** Declared once, in the
  registry (`shared/settings.ts`), with its default and why. No `process.env.DESOLATE_*` read
  outside it for a tunable.
- **R7. A security bound stays hard.** It bounds input from a side that is not trusted (a
  workspace, the root's ordinary user, a repository, the forge). Its comment says which side,
  and where the number comes from. An arbitrary round number is replaced by a principled one
  or by the size of what holds it.
- **R8. Units are what they say.** Bytes are bytes (`Buffer.byteLength`), characters are
  code points, and a message names the unit that was counted.
- **R9. What the change makes dead goes.** An inner timeout that can no longer fire, a second
  cut after a first, a copy of a constant, a branch for a case that cannot happen: deleted in
  the same change, not left for later.

## The contracts

Each is a small module in `release/shared/`, with in-source tests as its usage notes. A layer
that produces something keeps the producing end; the layer that shows or consumes it keeps the
other. Two tickets that meet at a contract change only their own side of it.

### `shared/text.ts`: safe is not short (R1)
```ts
export const SAFE_MOST = 4000; // the bound against a flood, in characters
export const CUT = "…"; // ends text that was cut; counts toward the bound
export const printable: (value: unknown, max?: number, instead?: string) => string;
export const tail: (text: string, lines: number) => { text: string; before: number };
export const failure: (
  output: string,
  lines: number,
  keep: (whole: string) => string | null,
) => string;
```
- `printable(value, max?, instead?)` makes foreign text safe for a terminal, as before. Its
  default bound is a safety bound (`SAFE_MOST`, against a flood), not a display width, and
  text cut by it, or by a caller's own `max`, ends in `…`. Unsafe, besides controls and
  format characters: half of a surrogate pair, the invisible fillers (U+034F, U+115F,
  U+1160, U+180B-U+180F, U+3164, U+FFA0), the blank Braille pattern (U+2800) and every
  variation selector (U+FE00-U+FE0F and U+E0100 on: each can carry hidden bits, one after a
  character as well as a run), but for the one presentation selector (U+FE0E, U+FE0F)
  directly after a pictograph, which hides nothing ("⚠️" is shown as it is). It is the one rule (`UNSAFE`): the approval page and the
  dashboard name the same characters (`shared/ui/shown-text.js`, which T1 compares). A
  value whose `String()` throws is `?`.
- `tail(text, lines)` gives the last lines of a program's output (`text`) and how many lines
  came before them (`before`). A line ends in LF or CR LF; the line ends that end the
  output are not lines. It does not make them safe, and its time is linear in the text.
- `failure(output, lines, keep)` is how an error from another layer is shown: its last
  lines, made safe; and, when that is not all of it, a first line that says how much was
  left out and where the whole text is: `(412 earlier lines not shown; all of it: <path>)`.
  `keep` is called only then, with the whole text: it writes it and answers the path, or
  null when it could not (the host keeps them under its logs, the root under its state).
- Fitting text to a line is the display's: CSS `text-overflow` with the whole value in
  `title`, or a terminal's own wrapping.

### `shared/listed.ts`: lists and counts (R2)
```ts
export type Listed<T> = { items: T[]; total: number; from: number };
export const PAGE = 100; // a page, not a cap: the next one is asked for
export const listed: <T>(all: readonly T[], from?: number, count?: number) => Listed<T>;
// "and 37 more commits"; null when the page ends the list. `noun` is one of them ("commit");
// `nouns` is several, when adding an s is not it ("branches").
export const andMore: (list: Listed<unknown>, noun: string, nouns?: string) => string | null;
```
`listed` takes a `from` or `count` that is not a place in the list (negative, past the end,
not whole) as the nearest that is: they come from whoever asks for the page.
A producer counts with the cheap exact tool (`git rev-list --count`), and lists a page. A
consumer shows `total`, shows the page, and asks for the next when the person wants it.

### `shared/limits.ts`: bounds two layers share (R3, R7, R8)
One object per subject, each number with its reason:
- `FORGE`: what the forge itself takes. `packBytes` (2 GiB: GitHub's push limit),
  `lfsObjectBytes` (5 GiB: GitHub's largest LFS object).
- `LFS_POINTER_BYTES` (1024: git-lfs reads no pointer larger), replacing four copies of 400.
- `NAMES`: `slug` 40, `branch` 200, `status` 200 (characters: code points), `noteBytes`
  16,384.
- `TERMINAL` (`cols` 1000, `rows` 500), `PORTS` (`min` 1024, `max` 65535).
- `over(what, limit, actual, unit, allows?)`: the one sentence for a bound that was hit.
  `unit` is `"bytes"` (written as sizes) or what was counted (`"characters"`); `allows`
  ends the sentence with who sets the limit, and is "allowed" when not given:
  `over("the pack", FORGE.packBytes, n, "bytes", "a push to the forge may carry")` is "the
  pack is 2.3 GiB, over the 2 GiB a push to the forge may carry";
  `over("the status", NAMES.status, 312, "characters")` is "the status is 312 characters,
  over the 200 allowed". No capital and no full stop: the refusal puts it in place.
- `formatBytes(n)`: the one way a size is written for a person ("4 KiB", "5.5 MiB",
  "2.3 GiB"). Under a GiB it is the text `host/approver.ts` and `host/push.ts` print now.

There is **no count of LFS objects per push**: three files had 2000, meaning three things.
What bounds the list is the size of the request that carries it, which has a name.

### `shared/lock.ts`: locks by liveness (R5)
```ts
// `since`: an ISO time. Pid 0, the rest empty: a lock whose holder file could not be read.
export type Holder = { pid: number; host: string; since: string };
export const BEAT = { pollMs: 250, beatMs: 2_000, missed: 5 };
export const withLock: <T>(
  dir: string, // the lock's own name ("<state>/fetch.lock"): there while it is held
  work: () => Promise<T>,
  options?: {
    scope?: "machine" | "share"; // "machine" unless said
    wait?: boolean; // true unless said
    busy?: (holder: Holder) => string; // words the refusal of `wait: false`
    waiting?: (holder: Holder) => void; // told who it waits for, once for each holder
    signal?: AbortSignal; // ends a wait: whoever asked went away
  },
  pace?: typeof BEAT, // for tests only
) => Promise<T>;
```
- `machine` (every process that takes it runs in one VM or on the Mac): the lock names its
  holder's pid and start time; it is stale only when that process is gone (no such pid, a
  pid that is now another process, or a zombie). Where the system will not say (a /proc
  read that failed, a holder file that is there and could not be read just now), the
  holder is taken for alive.
- `dir` is there while the lock is held. Beside it are others named after it, usually for moments, though a killed heir's `.heir-<id>` and a `.beat-<id>` stay until a later take sweeps them
  (`<dir>.new-<id>`, `.heir-<id>` and a right's own `.heir-<id>.heir-<id>`, `.heir-<id>.new-<id>`, `.heir-<id>.gone-<x>`, `.gone-<x>`,
  `.beat-<id>`): whatever sweeps the lock's
  folder leaves them (as `root/reviewer.ts` sweeps its home at start, by a list of names).
  Something in the lock's place that is no lock of ours (a directory holding other files,
  a file, a link) is nobody's: it is moved aside, and a directory is left there as
  `<dir>.gone-<x>`, never reached into (on a share another side could swap a link into
  it). One this process may not move is refused at once, as in the
  way. A taking whose lock, while being made, another side writes into fails, saying so.
- `share` (a folder several VMs see, where one cannot see another's processes): the holder
  writes a heartbeat while it lives, from a thread of its own, so work that keeps the
  process busy does not stop it; the lock is stale only when the beat has stopped. The
  beat is the one number, `BEAT`: every 2 s, and stopped when a waiter has watched 10 s go
  by with no new one (by its own running clock, so a Mac that slept wakes to no stale lock).
  Silence counts only while the waiter watched: one that did not look for half the window
  (its own VM paused) watches again from then. A holder whose whole VM is frozen that long
  while others run loses its lock: what is done under a share lock must be safe to do
  again. A share lock keeps its takers apart; it is not proof against a side that may write
  the folder and means harm. Such a side can always remove the lock; and since node has no
  calls relative to an open directory (`openat`, `unlinkat`), one that swaps a link in for
  `<dir>.new-<id>` or `<dir>.gone-<x>` in the moment after it appears can still make a
  taker create its holder file in, or unlink files named `holder` or `beat` from, the
  folder the link leads to. What is in the lock's place itself is never followed: a link
  or a file there is unlinked itself, and nothing inside a directory that is no lock of
  ours is touched. **So a share lock belongs in a folder only desolate's own processes
  write**, and a ticket that puts one where an agent can write says why that is safe.
- Waiting (the default) has no timer in it (R4): it waits for as long as its caller does,
  tells `waiting` who holds the lock so the caller can say so, and stops when `signal` fires.
  A signal that fired while the lock was being taken stops the work from beginning; once
  begun, the work is its own to end (give it the same signal), and the lock is held until
  it returns.
- Not waiting (`wait: false`) refuses with who holds it and since when: an `Error` with
  `holder` on it, its message `busy`'s. On a share that takes up to one beat, since a holder
  is known to be alive only by its next one.
- A lock whose holder is gone is taken, waiting or not, by exactly one of those who find it.
  The right to move a dead holder's lock away is itself taken exclusively, by the dead
  holder's id. A lock is the directory it is (device and inode) naming the holder it names:
  the one with the right moves what is in the lock's place and then looks at what it
  moved, and puts it straight back if it is not the lock it found dead. So a waiter who
  read the dead holder a moment late, or stopped (its VM paused) before moving it, does not
  remove the lock a new holder made. A holder always leaves its lock, with the right or,
  when the right cannot be made, without it. It is not re-entrant.

### `shared/settings.ts`: the registry (R6)
```ts
export type Setting<T> = {
  name: string; // "root.memoryMiB"
  env: string; // "DESOLATE_ROOT_MEMORY_MIB"
  side: "host" | "root" | "workspace" | "git";
  default: T | (() => T);
  parse: Parse<T>;
  why: string; // one sentence a person reads in `desolate settings`
};
// A function from text to a value, or null. `takes` says what a value is ("a whole number
// from 1 to 64"), for the refusal of one that is not; a plain function need not have it.
export type Parse<T> = { (text: string): T | null; takes?: string };
export const define: <T>(setting: Setting<T>) => Setting<T>;
export const valueOf: <T>(setting: Setting<T>) => T;
export const defined: () => readonly Setting<unknown>[]; // for `desolate settings`
// Parsers for the common shapes:
export const whole: (min: number, max: number) => Parse<number>;
export const mebibytes: (min: number, max: number) => Parse<number>; // "4g", "512m", "4096"
export const ports: Parse<number[]>; // "3000,5173": each within limits.ts's PORTS
```
A tunable is declared with `define` in the file that uses it, and read with `valueOf`, which
reads, in order: the variable, in the process that reads it; what `desolate settings set`
stored (on the Mac, `~/.desolate/settings.json`; in a VM, what the host passed in when it
started it, `/etc/desolate/settings.json`, and only that VM's side's); the default.
- `define` refuses (throws, when the file loads) a name that is not `area.thing`, a variable
  that is not `DESOLATE_...`, and a name or variable defined before: one definition each.
- `valueOf` gives the default when the variable is unset or empty, and refuses (throws) a
  value its parser does not take: "DESOLATE_GIT_SHELLS must be a whole number from 1 to 64,
  not 'lots'". A typo never silently becomes the default.
- `defined()` lists the settings of the files loaded so far: what lists them imports them.

### `shared/run.ts`: cancel, and idle (R4)
`run()` takes `signal` (an `AbortSignal`: the requester went away) and `idleMs` (nothing on
stdout or stderr for this long). `timeoutMs`, a total, stays only for callers not yet moved.
- Each ends the program, and the answer says so as the timeout's does: code 128, whatever
  the program's own exit, and stderr ending in `(cancelled)` or `(nothing from it for <n>
  ms: stopped)`. A signal that has already fired runs nothing.
- With `signal` or `idleMs` the program runs in a process group of its own, and the group is
  ended whole: told to end (SIGTERM), and killed `ENDING_MS` (2 s) later, so that a program
  that runs groups of its own ends those too. What left the group (a daemon's own session)
  is not reached, and does not hold the answer: its pipes are let go then too. Such a
  program has no terminal (it cannot ask the person anything there, and Ctrl-C does not
  reach it), so `run` itself ends the groups it made when its own process is sent SIGINT,
  SIGTERM or SIGHUP (the same way, and their answers end in `(stopped: the program that ran
  it is ending)`) or exits (killed at once).
- With `timeoutMs` alone: no group, and only the program itself is killed, as before; a run
  ended so answers 128 even if the program had exited 0.

### `shared/review-account.ts`: the reviewer's account of a push (R1, R2, R4)
The one type for what desolate's reviewer says a push would send, used by the reviewer, the
host's approval page and terminal.
```ts
/** One line of the reviewer's answer stream (`review-ask`): progress, then the one answer. */
export type AccountLine =
  | { progress: { phase: string; done?: number; of?: number } }
  | { account: Account } // answers `account`
  | { page: Pick<Account, "commits"> | Pick<Account, "files"> | Pick<Account, "between"> } // answers `page`
  | { diff: DiffPage } // answers `diff`
  | { error: string };
export type AccountCommit = { commit: string; subject: string; author: string };
export type AccountFile = { path: string; added: number; removed: number; binary?: boolean; sensitive?: boolean };
export type AccountBetween = { path: string; sensitive?: boolean };
export type Sends = { pack: string; size: number; lfs: string[] }; // as root/reviewer.ts has it
export type Squash = { commit: string; parent: string | null; count: number; message: string; author: string; committer: string; dates: string };
export type Account = {
  key: string; // names this account, for `page` and `diff`
  warnings: string[]; // every one
  commits: Listed<AccountCommit>; // first to last
  files: Listed<AccountFile>;
  between: Listed<AccountBetween>;
  sends: Sends;
  squash?: Squash & { sends: Sends };
  fastForward: boolean | null;
  squashedFrom?: string;
  base: string | null;
  remote: string | null;
};
export type AccountRequest =
  | { op: "account"; repo: string; branch: string; commit: string; onto: string | null }
  | { op: "page"; key: string; list: "commits" | "files" | "between"; from: number }
  | { op: "diff"; key: string; of: { file: string } | { commit: string } | "net"; from?: number };
/** A page of a diff: the bytes from `from` up to `next`, cut between lines. `next` is where
 *  the following page starts (null: this one ends the diff); `total` is the whole diff's
 *  size. The asker takes `next` from the producer, never from the length of `text`. */
export type DiffPage = { text: string; from: number; next: number | null; total: number };
export const ACCOUNT_LINE_BYTES = 8 * 1024 * 1024; // the most one line may be
export const accountLine: (line: AccountLine) => string; // one JSON object and a newline
export const accountLines: (stream: AsyncIterable<Uint8Array | string>) => AsyncGenerator<AccountLine>;
```
The stream is any number of `progress` lines and then exactly one answer (`account`, `page`,
`diff` or `error`), which ends it. `accountLines` reads it from bytes cut into chunks
anywhere, holding at most `ACCOUNT_LINE_BYTES` of a line (in one buffer), and always ends
with one answer: a line that is not one of these (not JSON, another kind, or a kind's name
without its shape: the counts, positions and kinds a reader relies on), a line over
`ACCOUNT_LINE_BYTES`, a stream that ends before its answer (the reviewer stopped, or was
stopped), or one that fails under it (a connection reset) is given as an `error` line that
says which. What the entries of a list hold is their reader's to check and to show as text.
`accountLine` does not write a line over the bound: it writes an `error` saying so. So the reviewer writes nothing but
these lines on that stream: what it logs goes to stderr. A `page` holds the list asked for
under its own name (`{ page: { files: Listed<AccountFile> } }`), and a page of a diff is the
producer's to keep under the line's bound.
`account` runs for as long as its requester holds the connection, saying what it is doing;
there is no deadline inside it. A diff is asked for by file or by commit, and comes in pages
of bytes, counted as bytes.
