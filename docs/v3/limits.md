# Limits: the rules, and the contracts between the layers

The triage of 2026-11-20 ([limits-triage.md](limits-triage.md)) found 483 hard-coded limits in
`release/`. Most were not decisions. They were a layer bounding something it had not designed:
a list cut where it should page, a timer where the person should be asked, a number copied
into five files. This file is what replaces them: the questions each limit is put to, the
rules that follow, and the small shared modules every layer keeps its end of.

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
- `printable(value, max?, instead?)` makes foreign text safe for a terminal, as now. Its
  default bound becomes a safety bound (4,000 characters, against a flood), not a display
  width, and text cut by it ends in `…`.
- `tail(text, lines)` gives the last lines of a program's output and how many it left out.
- `failure(output, lines, keep)` is how an error from another layer is shown: its last
  lines, a count of what was left out, and where the whole text was kept (`keep` writes it
  and answers the path; the host keeps them under its logs, the root under its state).
- Fitting text to a line is the display's: CSS `text-overflow` with the whole value in
  `title`, or a terminal's own wrapping.

### `shared/listed.ts`: lists and counts (R2)
```ts
export type Listed<T> = { items: T[]; total: number; from: number };
export const PAGE = 100; // a page, not a cap: the next one is asked for
export const listed: <T>(all: readonly T[], from?: number, count?: number) => Listed<T>;
export const andMore: (list: Listed<unknown>, noun: string) => string | null; // "and 37 more commits"
```
A producer counts with the cheap exact tool (`git rev-list --count`), and lists a page. A
consumer shows `total`, shows the page, and asks for the next when the person wants it.

### `shared/limits.ts`: bounds two layers share (R3, R7, R8)
One object per subject, each number with its reason:
- `FORGE`: what the forge itself takes. `packBytes` (2 GiB: GitHub's push limit),
  `lfsObjectBytes` (5 GiB: GitHub's largest LFS object).
- `LFS_POINTER_BYTES` (1024: git-lfs reads no pointer larger), replacing four copies of 400.
- `NAMES`: slug 40, branch 200, status 200 (code points), note 16,384 bytes.
- `TERMINAL` (1000 x 500), `PORTS` (1024 to 65535).
- `over(what, limit, actual, unit)`: the one sentence for a bound that was hit ("the pack is
  2.3 GiB, over the 2 GiB a push to the forge may carry").
- `formatBytes(n)`: the one way a size is written for a person.

There is **no count of LFS objects per push**: three files had 2000, meaning three things.
What bounds the list is the size of the request that carries it, which has a name.

### `shared/lock.ts`: locks by liveness (R5)
```ts
export const withLock: <T>(
  dir: string,
  work: () => Promise<T>,
  options?: { scope?: "machine" | "share"; wait?: boolean; busy?: (holder: Holder) => string },
) => Promise<T>;
```
- `machine` (every process that takes it runs in one VM or on the Mac): the lock names its
  holder's pid and start time; it is stale only when that process is gone.
- `share` (a folder several VMs see, where one cannot see another's processes): the holder
  writes a heartbeat while it lives; the lock is stale only when the beat has stopped. The
  beat's interval is the one number, defined there.
- Not waiting (`wait: false`) refuses with who holds it and since when.

### `shared/settings.ts`: the registry (R6)
```ts
export type Setting<T> = {
  name: string; // "root.memoryMiB"
  env: string; // "DESOLATE_ROOT_MEMORY_MIB"
  side: "host" | "root" | "workspace" | "git";
  default: T | (() => T);
  parse: (text: string) => T | null;
  why: string; // one sentence a person reads in `desolate settings`
};
export const define: <T>(setting: Setting<T>) => Setting<T>;
export const valueOf: <T>(setting: Setting<T>) => T;
```
A tunable is declared with `define` in the file that uses it, and read with `valueOf`. Until
the settings ticket lands, `valueOf` reads the environment variable; after it, the same call
reads what `desolate settings` stored and what the host passed into each VM.

### `shared/run.ts`: cancel, and idle (R4)
`run()` takes `signal` (an `AbortSignal`: the requester went away) and `idleMs` (nothing on
stdout or stderr for this long). `timeoutMs`, a total, stays only for callers not yet moved.

### `shared/review-account.ts`: the reviewer's account of a push (R1, R2, R4)
The one type for what desolate's reviewer says a push would send, used by the reviewer, the
host's approval page and terminal. Today it is written twice (`root/reviewer.ts`,
`host/approve-web.ts`) and cut in both.
```ts
/** One line of the reviewer's answer stream (`review-ask`): progress, then the account. */
export type AccountLine =
  | { progress: { phase: string; done?: number; of?: number } }
  | { account: Account }
  | { error: string };
export type Account = {
  key: string; // names this account, for `page` and `diff`
  warnings: string[]; // every one
  commits: Listed<{ commit: string; subject: string; author: string }>; // first to last
  files: Listed<{ path: string; added: number; removed: number; binary?: boolean; sensitive?: boolean }>;
  between: Listed<{ path: string; sensitive?: boolean }>;
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
```
`account` runs for as long as its requester holds the connection, saying what it is doing;
there is no deadline inside it. A diff is asked for by file or by commit, and comes in pages
of bytes, counted as bytes.

## Who owns what
The tickets (tracked in the issue this file is linked from) split `release/` so that no two
change the same lines. Where two meet (the reviewer and the approval page, the workspace and
the root, the pusher and the keyring), they meet at one of the contracts above, and each
ticket names the end it keeps.
