# Limits 06: a workspace's requests to the root are taken, then waited on (#178)

Both ends of the request channel: `workspace/sync.ts` asks (`desolate fetch`, `offer`,
`spawn`, `close`, `issue offer`, and so `git fetch` and `git push` in a workspace), and
`root/rootd.ts` answers. Before, every request gave up after two minutes with "the root did
not answer. Is it running?", whether the root had never seen it or was half-way through a
large fetch; and one domain had 30 requests a minute in all, so a few agents fetching in a
loop had the domain's offer refused.

## The channel now
A request is still `requests/<id>.json` in the domain's outbox, and its answer still
`replies/<id>.json` in its inbox, which the domain cannot write. Between the two the root says
two things more, in the inbox:

| file | written by | what it says |
|---|---|---|
| `rootd.beat` | a thread of rootd's own, every `BEAT.beatMs` (2 s), whole (written beside and renamed) | `<boot> <count>`: rootd is running; `boot` is new each time it starts |
| `replies/<id>.taken` | rootd's loop, the moment it takes the request, and whenever what it is doing changes; removed with the answer | `{ boot, doing }` |

The workspace waits with no deadline (R4) for as long as the beat goes on, and says what the
root is doing once it has waited 10 s (then when that changes, and once a minute); a request
answered sooner prints nothing, so no transcript changed. What ends a wait, besides the
answer:

| what the workspace sees | what it says |
|---|---|
| the beat has not moved for 10 s, watched all the while (lock.ts's rule: by the watcher's own clock; a watcher that did not look for half that starts again), and the request is still in the outbox | "nothing has been heard from the root for 10 s: it is not running, or its VM is stopped (the request was withdrawn)"; it removes the request first (without `force`: if it is gone, the root took it at the last moment, and the wait goes on) |
| the same, and the request was taken | "the root took it, then nothing was heard from it for 10 s: it stopped, or its VM did, and whether it was done is not known" |
| a `.taken` of another boot than the beat's, or a request neither in the outbox nor taken for 10 s | "the root restarted while it was working on it, and whether it was done is not known" |

Ten seconds is `BEAT` (shared/lock.ts), the one number for "a holder that beats has
stopped": the root is on the same Mac, and a thread that does nothing but write a small file
is never that late.

**Both ends change apart.** A workspace VM runs the code it started with until it restarts,
and the root VM likewise:
- an old workspace and a new root: the old workspace reads only `replies/<id>.json`, which is
  where it always was; the `.taken` beside it is ignored. It waits its old 2 minutes.
- a new workspace and an old root: there is no `rootd.beat`, so the wait is the old one, 2
  minutes, ending in the old words. (Once a beat has been read, a beat file that cannot be
  read is taken for a beat that does not move.)

## How one domain is kept from slowing another (R7)
The loop never waits on a request's work. Each pass it takes at most `MOST_HELD` (50) of a
domain's requests, as the old loop did, and hands each on:
- **A lane per domain** for every request but a fetch (offer, spawn, close, issue), and the
  domain's imports (`importChanged`, which used to be awaited in the loop, so one domain's
  large bundle held up every other domain): one at a time, in order, beside every other
  domain's lane. While a domain's lane holds 50, the root takes no more from it: the rest wait
  in its outbox, on its own disk, and their askers wait on a beat that goes on ("the root has
  not taken it yet: it is answering this domain's earlier requests").
- **Fetches** go to `fetchOf`, one queue per repository: at most one fetch runs and one waits,
  and every asker while one runs is answered by the next one, which begins after it asked.
  The landed check (below) is in the same queue. A domain may hold 50 fetches waiting; a 51st
  is refused ("this domain has 50 fetches waiting already: ask again once one is answered").
  A domain's fetches run at most one per repository it has, a number the person chose.

Fifty is what the root held of one domain before (the drain's pass), each request up to
outbox.ts's 1 MiB of JSON: so no domain has more of the root's memory than it could before.
What a domain's requests ask is checked exactly as before (`answer`, `handle`, `signed`,
`offers.take`, `issues.offer`: unchanged), and read exactly as before (`drain`).

## The limits, one by one

| where (before) | what it was | answer | what it is now |
|---|---|---|---|
| `root/rootd.ts:39-45`, `:693-697` | `RATE = { perMinute: 30 }`, per domain, every op together | 1, then 4 | gone. A flood from one domain is kept from others by the lanes (above), not by refusing it; ten fetches of a repository in a minute are one or two fetches. Hard bound left: `MOST_HELD`, 50 a domain, its reason in its comment |
| `root/rootd.ts:797` | `Number(process.env.DESOLATE_LANDED_CHECK_MS) \|\| 15 * 60_000` | 3 | the setting `root.landedCheckMinutes` (`DESOLATE_ROOT_LANDED_CHECK_MINUTES`), a whole number of minutes from 1 to 1440, default 15; documented in reference.md |
| `workspace/sync.ts:29` | `timeoutMs: 300_000` on every git of the domain's sync | 1 | none (R4): git on the domain's own clone, in its own VM, with no remote peer (a bundle is a local file both ways). Whoever waits stops it |
| `workspace/sync.ts:348` | `timeoutMs = 120_000` on every request | 1 | none: taken, then waited on while the root beats (above). 120 s is left only as the wait on a root from before the beat |
| `workspace/sync.ts:358` | poll every 150 ms | keep | named, `POLL_MS`: three small reads |
| `root/rootd.ts:829-831` | `drain(..., 50)` | 4 | `MOST_HELD`, counted per domain over what is held, not per pass |
| `root/rootd.ts:842` | replies swept after `600_000` ms | keep | named, `REPLY_KEPT_MS`; never sweeps the `.taken` of a request still held, however long its work |
| `root/rootd.ts:848` | `sleep(250)` | keep | as it was (virtiofs gives no file events across VMs) |
| `root/rootd.ts:771` | `IMPORT_GAP_MS = 3000` | keep | as it was; the import now runs in the domain's lane |
| `root/rootd.ts:103` | `30 * 60_000`, how long a queued spawn holds its name | keep, named (R3) | `PENDING_MS = 2 * FRESH_MS`, with why: past any request the host could still run |
| `root/rootd.ts:704`, `:789`, `:812` | `slice(0, 500)`, `slice(0, 300)` of error messages | R1 | `printable()`: safe, bounded by `SAFE_MOST`, marked when cut |
| `workspace/sync.ts:115` | `haves.slice(0, 500)` | R9 | deleted, with the read of `inbox/haves/*.json` it cut: nothing in desolate writes that file |
| `workspace/sync.ts:137` | `made.err.slice(-300)` | R1 | `failure(made.err, 5, ...)`: the last lines, and how many came before |
| `workspace/sync.ts:174` | `Number(size) < 400` | R3 | `LFS_POINTER_BYTES` (1024, git-lfs's own cutoff) |
| `workspace/sync.ts:340` | `done.slice(-500)`, the record of deliveries imported | 1 | no cut: an id is remembered only while its delivery is still in the inbox, so the record is never longer than the inbox's list (at 500 an older delivery was imported again, moving `root/<branch>` back) |

## Tests
- In-source (`workspace/sync.ts`): `watchBeat` (a beat that moves, one that has stopped, a
  watcher that was paused, the first look) and `verdict` (answered; waits however long, saying
  what the root is doing; gone before and after taking it; restarted; a root from before the
  beat, at 119 s and 120 s).
- T1 `tests/v3/t1/request-channel.test.ts`: `coalesced`, the fetch queue: ten askers during a
  run share one run after it; another repository is not behind; a later asker gets a run that
  began after it asked; a run that fails answers its askers with the failure, and the queue
  goes on.
- T2 `tests/v3/t2/24-requests.test.ts`, two domains:
  - the forge's git-upload-pack made to wait four minutes once (a wrapper in the forge
    container): `desolate fetch` is answered after it, having said "fetching acme/widgets ...
    (N s so far)"; thirty more fetches asked meanwhile all succeed, and the forge serves at
    most 4 upload-packs for the 31 (the slow fetch and one more, each with its look at HEAD);
    an offer asked while they wait is answered at once;
  - beta's offer during a flood of 20 slow offers written straight into alpha's outbox takes
    no longer than the same offer with no flood (the control), while alpha's own offer, asked
    after its flood, is still waiting (the flood was real) and is then answered, having said
    why it waited;
  - rootd stopped (`kill -STOP`): an offer says "nothing has been heard from the root for
    10 s" within 30 s, and its request is gone from the outbox; the same offer once rootd runs
    again is answered (the control).
