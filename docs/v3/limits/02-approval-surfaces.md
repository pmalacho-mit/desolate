# Limits 02: the approval page and the terminal (ticket #174)

The host's end of the reviewer's account of a push (`shared/review-account.ts`): the approval
page (`host/approve-web.ts`, `host/approve-ui/approve.js`), the terminal's prompt
(`host/push.ts`, `host/approver.ts`), and the question to the reviewer (`host/daemon.ts`,
`reviewerSummary`). Each limit the triage listed, put to the four questions.

| where (triage) | what it was | answer | what it is now |
|---|---|---|---|
| host/daemon.ts:219 | `timeoutMs: 120_000` on review-ask | removed (R4) | `reviewerSummary` is a stream of `AccountLine`s with no deadline; whoever asked ends it with `signal` (the page: the push left the list; the terminal: Ctrl-C). Until #183 offers `spawn` as root in the root VM, it falls back to `exec` (marked FALLBACK), which cannot be ended early |
| host/daemon.ts:234 | reviewer's stderr `slice(-200)`, printable 200 | removed (R1) | `failure(stderr, 5, keep)`: its last lines, made safe, and the whole in `<logs>/reviewer-failure.txt`. What is held of stderr is bounded (64 KiB tail, marked) against a program in a VM |
| host/approver.ts:161 | `clean()`: `.slice(0, 300)`, non-ASCII to `?` | removed | `printable(line, Infinity)`: safe for the terminal, whole, and a name in another script is itself; the terminal wraps |
| host/approver.ts:209 | `summary.slice(0, 60)` | removed | every line |
| host/approve-web.ts:217 | `SUMMARY.deadlineMs: 90_000` | removed (R4) | the page shows what the reviewer is doing (`review.working`: phase, done of, seconds) and waits as long as the person does; Approve arms when the account is there |
| host/approve-web.ts:217 | `SUMMARY.keepMs: 120_000` | removed | an account is kept while the root lists its text (by digest); when the text leaves the list the question is aborted and the account dropped |
| host/approve-web.ts:257,571,632 | `readBody(req, 4096)`, "not JSON" | keep hard (R7), named | `CLICK_BYTES = 4096`, counted in bytes; over it is 413 with `over()`: "the request is 5 KiB, over the 4 KiB this page takes" |
| host/approve-web.ts:425,463 | `70_000`, `200_000` | keep hard, derived | `SECRET_BODY_BYTES = 6 × 64 KiB + 16 KiB` (a value JSON-escaped at worst, `\u0000`, and room for the rest); `IMPORT_BODY_BYTES = 6 × ENV_MAX + 16 KiB` |
| host/approve-web.ts:477 | `value.length > 65_536` | keep hard, in bytes (R8) | `Buffer.byteLength(value) > SECRET_BYTES` (64 KiB, as the terminal takes one) |
| host/approve-web.ts:683 | reviewer's error `.slice(0, 300)` | removed | `printable(error)` whole (the safety bound only) |
| host/approve-web.ts:656 | "each waits two minutes" | removed (R3) | no number: "approved elsewhere, refused, or given up" (how long a push waits is ticket 3's) |
| host/push.ts:516 | prepare `timeoutMs: 300_000` | removed (R4) | the person is at the terminal, sees the root's stderr, and ends it with Ctrl-C |
| host/push.ts:643-644 | `forge.slice(0, 5)` | removed | every file that changes what runs on the forge; the reviewer lists those first, so the host pages on (`forgeFiles`) while a page ends with one, and says why if it cannot |
| host/push.ts:647 | `warnings.slice(0, 20)` | removed | every warning |
| host/push.ts:664-669 | squash message, 12 lines | removed | the whole message (it is signed) |
| host/push.ts:598, 458, 464 | `printable` default 300 | removed | the default is now the foundation's safety bound (`SAFE_MOST`) |
| approve.js:28,74 | `READY_MS = 1000` | keep hard | unchanged (anti-clickjacking) |
| approve.js:29,274 | `DWELL_MS = 300` | keep hard | unchanged; an early click now says "hold still on the button a moment, then click" |
| approve.js:377 | `setTimeout(poll, 1000)` | not done | see below |
| approve.js (old) | "over 20 000 lines", "Cut at 256 KiB" | removed | the diff (net, or one commit whole) is asked of the reviewer a page of bytes at a time (`/diff?…&from=`), with "Show more of it" |
| approve-web.ts `Summary` | its own copy of the account's type | removed | `shared/review-account.ts`'s `Account`; the page is given it without its `key` |
| approver.ts, push.ts, approve.js | `formatSize` / `formatBytes` copies | removed in TS | `shared/limits.ts`'s `formatBytes`; the page has its one copy (a browser cannot import it), with GiB |

The "keep" rows: `approver.ts:231, 343` (the Touch ID dialog's 120 s: a moment the person is
at, left as it is); `push.ts:263-264` (`desolate review`, ticket 4's); `approve.js:130, 83`
(the 250 ms arming tick and the 8-item scroll box: internal, left).

## New bounds, from the review of this change (all hard, against the root's ordinary user)
- `ASKING_MOST = 4`: questions to the reviewer answered at once; the rest wait their turn
  and say "waiting for another push's account". Each listed push was a process in the root
  and on the Mac, and the root's user lists as many as it likes.
- `LISTED_MOST = 32`: pushes the page keeps an account of; past it a push is listed with an
  error that says why, and is asked about once others are refused. At the stream's own bound
  (8 MiB a line) that is 256 MiB at most.

## Signed only as shown
`/pending` gives each account a token over it (`shownToken`: the text's digest and the
account's), and `/approve` signs only with the token of the account the host holds now. A
push that leaves the list and comes back is asked again; if the reviewer then gives another
account, the click for the one the page drew signs nothing. The page disarms while its poll
fails, and a card it cannot draw is not approvable.

## Not done
- `approve.js:377`, the page's poll every second: left. The host itself learns what waits by
  asking the root (`approvals.pending`); an event stream from the host would still be fed by
  a poll, so this is a change to the root's approvals (ticket 3's file) first.
- A per-file diff button on the page: the host serves it (`/diff?file=`), the page shows the
  net diff and each commit whole only.
