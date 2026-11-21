# Limits 03: an approval and a push live as long as what is waiting for them

Ticket 3 of the limits effort (#175). The keyring, the pusher and the wait for approval:
`release/root/keyring.ts`, `keyring-client.ts`, `pusher.ts`, `raw-push.ts`, `approvals.ts`,
`send.ts`, `push.ts`.

## What lives how long, now

| what | lives | ends |
|---|---|---|
| a raw push's request (challenge), `git push` in the root's terminal or the git VM | while the process that asked holds its connection to the keyring (`challenge` with `hold: true`) | that connection closes (Ctrl-C, a closed terminal, the process dying however it dies: the kernel closes its sockets), or the person answers it, or it is dropped for newer ones past 32 (its asker is told) |
| the line for it on the approval page and the dashboard | while the process named in its file (pid and start time, `shared/lock.ts` `startOf`) is alive | the same |
| `desolate push`'s challenge (`push.ts prepare`) | 120 s (`CHALLENGE.lifeMs`): nobody holds it, since `prepare` exits before the host asks the person | the person's answer at the host's prompt, or 120 s |
| an approval, before the pusher claims it | while whoever asked holds its connection (the raw push's, or `push.ts run`'s `approve` with `hold: true`), and at most 120 s (`APPROVAL.lifeMs`) | the claim; that connection closing; or 120 s |
| a claimed approval | while the pusher's connection to the keyring (the claim) is open | the push ends (the pusher closes it) or the pusher dies (the kernel does). No 35 minutes |
| its signatures | 8 (`APPROVAL.uses`) | a ninth is refused, and said so in the audit |
| an LFS upload, the pack going to the forge | as long as they move | nothing moved for 60 s (`IDLE_MS`, the one idle bound); after the pack, ssh's keepalive (45 s on a dead link) |
| a push's lock on its repository (`push.ts run`) | while the process holding it lives (`shared/lock.ts`, `wait: false`) | that process ends. No 5 minutes |

## Each limit (the ticket's rows)

| file | was | answer | now |
|---|---|---|---|
| root/push.ts:478 | push lock stale after `300_000` ms | 1, better code | `withLock` (machine scope, `wait: false`): stale only when its holder is gone; the refusal names the holder's pid and since when. An old lock (a bare directory) is nobody's and is taken |
| root/raw-push.ts:26, :100 | `WAIT_MS` 110 s, `DESOLATE_APPROVAL_WAIT_MS` | 1, better code | gone, with the variable. The wait ends when the person approves or refuses, when `signal` fires (new optional parameter: the requester went away), or when the process ends. The approval arrives on the held connection (no polling of the keyring); a refusal on the page is still seen as the request file going, every 500 ms |
| root/raw-push.ts:101 | 500 ms poll | keep | only for the refusal (the file is ops.ts's to remove), no longer for the approval |
| root/approvals.ts:21, :58 | `APPROVAL_TTL_MS` 120 s, skew `-5_000` | 1, better code | gone: listed while the asker's process lives. A file that names no process (written before this change) is not listed, and is pruned |
| root/approvals.ts:22, :50 | `FILE_MOST` 16 KiB | 4, hard | kept, said whose (the root's user writes these files) |
| root/approvals.ts:69 | summary `.slice(0, 200)` | 1, eliminate | gone: the page and the dashboard fit text to a line (R1) |
| root/pusher.ts:73 and its uses | `objects: 2000` | 1, eliminate | gone. What bounds the list is the header's size; over it, the pusher answers with a message of its own ("the push's request is over the 4 MiB the pusher reads: it names more LFS objects than one push can carry"), where it used to drop the connection |
| root/pusher.ts:70 | `header` 1 MiB | 4, hard, resized | 4 MiB: the reviewer hands the root's user the list in a line of at most 1 MiB (review-client.ts), ~78 bytes an object; the header carries it twice (~170 bytes an object), so 4 MiB takes any list the reviewer can give, and a push is never refused for this after the person approved it |
| root/pusher.ts:71 | `pack: 2 * 1024 ** 3` | 4, hard, named | `FORGE.packBytes`, refused with `over(...)` |
| root/pusher.ts:72 | `lfs: 5 * 1024 ** 3` | 4, hard, named | `FORGE.lfsObjectBytes`, refused with `over(...)` naming the object |
| root/pusher.ts:74 | `advertised` 64 MiB | 4, hard (forge input) | kept, with its reason |
| root/pusher.ts:75, 744 | `idleMs` 60 s (receiving from the root's user) | 4, the one idle timer | `IDLE_MS`, now also the bound on the forge taking LFS bytes and the pack |
| root/pusher.ts:963 | `git lfs push`, `timeoutMs: 1_800_000` | 1 + idle (R4) | no total. `uploadWatched` reads git-lfs's own progress file (`GIT_LFS_PROGRESS`), stops it when nothing moved for `IDLE_MS`, and says every 10 s "uploading: 3 of 40 LFS object(s) up, 1.2 GiB of 4.0 GiB" to whoever handed the push over |
| root/pusher.ts:989 | receive-pack ssh, `1_800_000` then SIGKILL | 1 + idle (R4) | no total. Each chunk of the pack must be taken by the forge within `IDLE_MS`; "sending the pack: X of Y" every 10 s; after the pack, ssh's keepalive (`ServerAliveCountMax=3` now written out: 45 s on a dead link) |
| root/pusher.ts:100 | event error `.slice(0, 300)` | 1, eliminate | gone: the text is the pusher's own, each part already bounded |
| root/pusher.ts:373, 379, 458 | forge texts `.slice(0, 200)` | keep a bound, mark the cut | `printable(…, 200)`: made safe and cut with `…` |
| root/pusher.ts:986, 1010; :969 | ssh's and git-lfs's last lines | keep | `tail` and `printable`: git-lfs's error says how many earlier lines it leaves out |
| root/pusher.ts:212, 214; :479; :808; :1051 | ssh connect/keepalive; 5 s for the report after a failure; id echo; one push per process | keep | unchanged (ServerAliveCountMax written out) |
| root/keyring.ts:166, 409 | `CHALLENGE.lifeMs` 120 s | 1 for raw pushes; 4 for the rest | a held challenge has no clock; one nobody holds (`desolate push`) keeps 120 s, exported, its reason said. See "A held challenge" |
| root/keyring.ts:166, 180 | `outstanding: 32` | 4, hard | kept; a held challenge dropped for a newer one now tells its asker, which says so ("more than 32 were waiting at once") instead of waiting on |
| root/keyring.ts:161, 445 | `APPROVAL.lifeMs` 120 s, approval to claim | 4, hard, kept | see "Why the unclaimed approval keeps a clock". `desolate push` now copies the pack before it files the approval, so that copy is off the clock; send.ts asks a busy or starting pusher again for exactly this long (was its own 60 s) |
| root/keyring.ts:161, 600 | `uses: 8` | 4, hard | kept, with where 8 comes from: one for receive-pack, one per `git-lfs-authenticate` (once, then once per token lifetime: 600 s on the T2 forge). A ninth is refused with its own message and audit reason |
| root/keyring.ts:157, 822 | `CLAIMED_MS` 35 min | 1, eliminate | gone: the claim is the pusher's connection |
| root/keyring.ts:653 | audit `last` 50/500 | not done | `ops.ts` (ticket 5) and the host read its shape; paging it is a change on both sides. Left |
| root/keyring.ts:941, 962 | `bytes: 4096` | 4, hard | kept |
| root/keyring.ts:941, 952 | `concurrent: 16` | 4, hard | kept, for connections that hold nothing. A connection that holds a challenge or an approval leaves the count: what bounds those is what they hold (32 challenges; approvals, each a person's signature), so 16 waiting pushes cannot fill the socket |
| root/keyring.ts:1159 | 10 s for ssh-agent's sockets | keep | unchanged |
| root/keyring-client.ts:16, 23 | `timeoutMs` 10 s; "the keyring did not answer" | keep; fix the words | `whose(socket)`: "the reviewer / the pusher / the keyring did not answer at <socket>". The timeout is for the first answer only: a held connection has none after it |
| root/send.ts:86, :95 | 60 s window, 500 ms | derive | the window is `APPROVAL.lifeMs` (after it the approval cannot be claimed); 500 ms kept |
| root/keyring-askpass.ts:52 | 5 s | keep | not this ticket's file; unchanged |

## A held challenge, and what holding one for a day gains

The ticket asked which: the challenge living as long as the asker's connection, or renewed
without the card changing. **The connection.** Renewing is a lease, which is a clock; the
connection is the asker itself, in the same VM as the keyring: when the process ends, for any
reason, the kernel closes it, and the keyring drops the challenge the same moment. Nothing
has to notice a silence. The card never changes, since the nonce never does.

What an attacker that holds one open for a day gains (the root's ordinary user, which can ask
for any challenge of a pushable repository): **a line on the approval page**. Answering it
still takes the host approver's signature over that challenge's exact text (repository,
branch, commit, onto, nonce), once, and the page signs only the account it listed (the token
over the text). It could already put the same line there by asking again every two minutes.
It cannot hold more than 32 (`outstanding`): a 33rd drops the oldest, and its asker is told.
T1 `keyring-hold`: a held challenge answered a day later is still refused only for its
signature (the control: an unheld one is not outstanding), and one whose asker's connection
closed, or that was dropped for newer ones, is not outstanding.

## Why the unclaimed approval keeps a clock

The time from the person's click to the pusher's claim stays 120 s, and is now also bounded
by the asker's connection. What the clock protects: the root's ordinary user is the asker,
so without it that user could keep an approved push it had told the person had failed, and
land it a day later. The compare-and-swap on `onto` stops that only if the remote's branch
moved in the meantime. The person approved that exact push, so what lands is what they read;
but they may by then have decided against it, and the host has no way to take an approval
back. Two minutes keeps that window to the moment the person is still looking.

What it costs: a raw push learns which pack (the commit's, or its squash's) only from the
approval, so it copies the pack from the reviewer (`send.ts`, `packFor`) on that clock. A
local copy from the reviewer's socket; on a slow disk, a pack near 2 GiB could run it out, and
the push is then refused as "no live approval", for the person to approve again.

**Proposed, not done** (the larger change): take the unclaimed approval off every clock, as the
claim is, by (1) giving the host a way to withdraw an approval it signed (the page's Refuse,
after the fact, reaching the keyring), and (2) having the pusher claim on a first line before
the root's user copies the pack, then take the pack under the idle bound. With (1), an
approval held by its asker for as long as it waits is the person's to end, and the clock
protects nothing.

## Measured

- **git-lfs's progress file is per 32 KiB.** git-lfs 3.3.0 (the Mac's; Debian bookworm's is the
  same version), `git lfs push --object-id` of one 8,000,000-byte object to a local LFS server
  that read 32 KiB every 200 ms: 245 lines in `GIT_LFS_PROGRESS` over 25 s, the first after
  32 KiB, each `upload 1/1 <sent>/<size> <path>`. So "nothing written to it for 60 s" is
  "nothing sent for 60 s", and a long upload that moves is never stopped.
- **git-lfs ends a stalled upload itself, eventually.** The same server reading nothing after
  its first chunk: with `lfs.activitytimeout=5`, git-lfs failed with "i/o timeout" after 84 s
  (it retries). The pusher's own idle bound is the one that says what happened, and when.

## Tests

- T1 `tests/v3/t1/keyring-hold.test.ts`: a held challenge outstanding a day later, beside an
  unheld one that is not (the control); the asker's connection closing drops it (control:
  outstanding while open); 32 more drop it, and its asker is told.
- T1 `tests/v3/t1/pusher.test.ts`: an upload that keeps moving runs past the idle bound and
  says how far it is (the control); one that stops moving is stopped, with where it stood; a
  forge that stops taking the pack is given up on, one that takes it slowly is not.
- T1 `approvals.test.ts` and `pendingIn`'s in-source tests: a request listed a day after it
  was asked while its asker lives (the control), not listed when its asker has ended, when its
  pid is now another process's, or when it names none.
- T2 `04-offers`: a raw push stopped with Ctrl-C (SIGINT to its process group) leaves the
  host's list, and the keyring refuses the answer to it even signed with the approver's key
  (the control: while it waited, an answer was refused only for its signature); an approval
  the pusher is done with allows nothing more (the control: the push it allowed just before),
  and the audit says the claim ended with the push.

## Needs from another ticket

- **Ticket 5 (`root/ops.ts`, `root/rootctl.ts`)**: `git.push` should pass `pushCommit` a
  `signal` that fires when the request's connection to rootctl closes (the git VM's push was
  given up). Until then a push from the git VM waits on in rootctl until the person approves or
  refuses it on the page (an approval then pushes exactly what it names), or rootctl restarts.
  Also `pendingIn`'s second parameter (`now`) is no longer read: `approvals.pending` may drop it.
- **The remote helper `root/git-remote-desolate-push.ts`** (no ticket owns it; ticket 4 has a row
  in it): pass `pushCommit` a signal that fires when git closes the helper's stdin
  (`input.once("close", () => gone.abort())`, `gone.signal` as the last argument), so a git
  that is killed alone (SIGKILL) does not leave its helper waiting. Ctrl-C and a closed
  terminal already end the helper with git (the signal goes to the whole process group).
- **Ticket 2 (`host/approver.ts`, `host/approve-web.ts`)**: the Touch ID dialog's 120 s
  (approver.ts:231, :343) must stay under the keyring's `CHALLENGE.lifeMs` for `desolate push`
  (it answers an unheld challenge); for a raw push it need not be bounded by the root at all.
  The page's "that push is no longer waiting (each waits two minutes)" (approve-web.ts:656) is
  no longer true: "that push is no longer waiting: whoever asked for it stopped". Host code
  cannot import root/keyring.ts; if one constant is wanted on both sides, it belongs in
  `shared/approval.ts` (not in this effort).
- **Ticket 1 (`root/review-client.ts`)**: the pusher's header bound (4 MiB) is derived from
  `packFor`'s 1 MiB header line; a shared name for that line would make the derivation code.
- **`docs/v3/decisions.md`** (nobody's tonight): ":241" and ":470" say an approval lasts "at most
  two minutes, eight signatures", and ":506" that "a claim lasts as long as a push may take";
  both are now this file's table.
