# Limits 01: the reviewer's account of a push (#173)

The reviewer's end of `shared/review-account.ts`. Before, `review-ask` ran one summary under
`timeout 95`, inside the approval page's 90 s and the host's 120 s, with git timeouts of 2 to
30 minutes inside it that could never fire; a large first push could never be approved. The
lists were cut (the newest 50 commits beside the oldest 50 of each-commit text, 200 files,
2000 sensitive files, 256 KiB of diff counted in characters, no diff at all past 20,000
lines).

Now `review-ask` answers with a stream (`AccountLine`s): progress while the reviewer works,
then one answer. There is no deadline: it runs for as long as its asker holds the
connection, and when the asker goes (its stdout closes, or it is told to stop) the
reviewer's whole process group is ended. The lists are `Listed` (the first page, first
commit first, and the true total), and `page` and `diff` read the kept account.

## How it is built
`root/reviewer.ts` was 1,446 lines doing five jobs. It is now four modules of one job each:

| module | job |
|---|---|
| `root/reviewer.ts` | the socket server for the root's user (tips, submit, pack), and the entry for the host (`account`; `summary` is the fallback) |
| `root/reviewer-git.ts` | how git runs in the reviewer's repositories (hardened, no deadline), and how what they hold is shown (`shown`, `SENSITIVE`, `BUNDLE_REF`) |
| `root/reviewer-packs.ts` | the pack store: making a push's pack (with git's own progress), keeping and evicting packs, the LFS ids, and the pack settings |
| `root/reviewer-account.ts` | the account, its pages and diffs, the squash, the kept accounts, and the fallback answer |

- **The stream.** `node reviewer.ts account` reads one `AccountRequest` line and writes
  `AccountLine`s. It says what it is doing ("reading the remote's branches", "waiting for
  another push's account", "packing: compressing objects 1200 of 3000", ...), and says it
  again every 5 s when nothing new has happened: that is how its reader is known to be there
  (a write to an asker that has gone fails, and the work ends) and how the person sees it
  has not stopped.
- **The asker goes away.** `review-ask.ts` starts `runuser` in a process group of its own and
  re-frames the reviewer's lines through `accountLines` (so the host always gets the
  stream's lines, ending in one answer). When its stdout fails, or it gets SIGINT, SIGTERM
  or SIGHUP, it sends SIGTERM to the group (the reviewer ends the groups `run()` made for
  ls-remote), and exits 2 s later, killing the group with SIGKILL as it exits, whatever way
  it exits. If `review-ask` itself is killed, the reviewer's next write fails and it exits;
  its git children end at their next write to it.
- **One at a time, as a queue.** The account lock is `shared/lock.ts` (held by a live
  process); a request that waits says "waiting for another push's account" and waits for as
  long as its asker does. An account already made for the same push and remote is given at
  once, without the lock.
- **Kept accounts.** Each account is kept (`<home>/accounts/<key>.json`, the reviewer's own
  0700 home) with the whole of each list, for an hour since it was last asked for, the
  newest 64. `page` and `diff` name it by its key (64 hex, checked).
- **Diffs.** `diff` of the net change, of one file (by the path the account shows; git is
  given every raw path that shows so, as `:(literal)` pathspecs), or of one commit whole (one
  of the push's own commits, and no other). Pages are at most 1 MiB, cut after a line, or
  between characters when one line is longer than a page. git is run again for each page and
  ended once the page is read; the first time, it runs to the end to count the total, which
  is kept with the account.
- **The old answer.** FALLBACK, until ticket 2 lands: a request with no `op` (the host before
  the stream) is run as `reviewer.ts summary`, which writes the same progress lines and then
  the old one-JSON summary as its last line (made from the account: its lists' first pages,
  the net diff's first page, the first page of the first 100 commits' own diffs). The host
  before the stream reads only the last line.

## Each limit

| file | what it was | answer | what it is now |
|---|---|---|---|
| review-ask.ts:80-82 | `timeout --signal=KILL 95` around the summary | removed (R4) | no deadline; ended when the asker goes |
| review-ask.ts:94 | `spawnSync` `timeout: 100_000` | removed (R9) | gone with the 95 s |
| review-ask.ts:83-85 | `nice -n 10` | kept | the root VM's keyring and pushers come first; there is no deadline left for it to make more likely |
| review-ask.ts:96 | `maxBuffer: 8 MiB` | removed | the stream's own bound, `ACCOUNT_LINE_BYTES` (8 MiB a line), read by `accountLines`, which says it as that bound |
| review-ask.ts:27 | stderr `.slice(-200)` in "ended without an answer" | kept, fallback only | the stream passes the reviewer's stderr through to the host whole |
| reviewer.ts:186 etc. | git timeouts of 300 s, 600 s, 120 s, 1,800 s | removed (R4, R9) | none; git ends when the asker goes |
| reviewer.ts:386, 397 | ls-remote `timeoutMs: 60_000`; `ConnectTimeout=20` | idle bound (R4) | `idleMs: 60_000`: the forge, remote, said nothing for a minute; ConnectTimeout kept |
| reviewer.ts:53, 304-307 | `submitMs: 600_000` (process exit) | removed | the receive's idle minute stays (the root's user is not trusted to send) |
| reviewer.ts:339 | the submit's fetch, `1_800_000` | removed | |
| review-client.ts:117-127 | bundle create `timeoutMs: 1_800_000` | removed | the push waits for its bundle |
| reviewer.ts:48, 300-301 | bundle at most 2 GiB | bound by what holds it (R7) | refused when twice its size is more than the reviewer's disk has free (received, then stored): a repository over 2 GiB can be reviewed; the forge's push size bounds the pack, not the history |
| reviewer.ts:49, 316 | `refs: 2000` in a bundle | removed | the bundle's size bounds it; the refspecs go to `git fetch --stdin` |
| reviewer.ts:280 | `{1,200}` in `BUNDLE_REF` | hard, named (R3) | `NAMES.branch`; review-client.ts sends only the refs that fit, and the account says some branches were not sent, instead of the whole submit refused; a refused bundle names the ref |
| reviewer.ts:47, 1329 | `header: 64 * 1024` | kept hard | a request line from the root's user |
| reviewer.ts:52, 263 | receive idle 60 s | kept (idle, untrusted peer) | |
| reviewer.ts:50, 918, 927 | `commits: 50` (newest) | removed (R2) | `Listed`, first to last, `rev-list` counts by listing; `page` gives the rest |
| reviewer.ts:1172-1205 | each commit whole, the first 50 | removed | `diff` `{commit}`, any of the push's commits |
| reviewer.ts:51, 1036, 1219 | `files: 200` | removed (R2) | `Listed`; sensitive files first, so on the first page |
| reviewer.ts:1032-1036 | 2,000 sensitive files | removed | all of them first in the list; past the first page a warning says how many there are |
| reviewer.ts:1230 | `between` 200 | removed (R2) | `Listed` |
| reviewer.ts:833 etc. | 256 KiB of diff, in characters | removed (R1, R8) | pages of 1 MiB, counted in bytes; the page size is the line bound's (8 MiB at up to 6 bytes of JSON a byte) |
| reviewer.ts:833, 1007 | no diff past 20,000 lines | removed | any diff, in pages |
| reviewer.ts:929-930 | `shown(author, 80)`, `shown(subject, 200)` | removed (R1) | `shown` is printable's (its flood bound, 4,000 characters, cut with the mark) and the variation selectors it hid before |
| reviewer.ts:962, 1146 | paths `shown(raw, 300)` | removed | as above |
| reviewer.ts:192 | git's error, last 2 lines, `.slice(0, 300)` | kept, marked (R1) | cut with the mark; git's whole stderr goes to the reviewer's log |
| reviewer.ts:906 | `known.slice(0, 200)` | removed | the commits at git's boundary of what is new (`rev-list --boundary`), however many branches the remote has |
| reviewer.ts:435 | gitBytes 64 MiB | kept hard | why the batches exist |
| reviewer.ts:470-475 | 20,000 blobs a batch | kept, named (`BLOBS_AT_ONCE`) | 21 MiB at the new cutoff |
| reviewer.ts:1064-1068 | 2,000 commits a batch | kept, named (`COMMITS_AT_ONCE`) | |
| reviewer.ts:463, 998 | `< 400` for an LFS pointer | shared (R3) | `LFS_POINTER_BYTES` (1024); the net change's separate count of pointers (one `git cat-file` a blob) is gone: the old answer's `lfs` is the length of the list the push sends |
| reviewer.ts:494-497 | LFS object 5 GiB | shared (R3) | `FORGE.lfsObjectBytes`, said with `over` |
| reviewer.ts:514, 585 | pack 2 GiB | shared (R3) | `FORGE.packBytes`, said with `over` |
| reviewer.ts:560-565 | `pack.threads=2`, `windowMemory=256m`, `bigFileThreshold=64m` | settings (R6) | `reviewer.packThreads` (a quarter of the root VM's memory at one window a thread, at most its cores: 2 on the 2 GiB root), `reviewer.packWindowMiB` (256), `reviewer.bigFileMiB` (64); review-ask passes their variables through `env -i` |
| reviewer.ts:513, 664 | 8 GiB of kept packs | setting (R6) | `reviewer.keptPacksMiB`: a quarter of the reviewer's disk, at least one 2 GiB pack; a pack a kept account names is never the one evicted for size, and an account given again renews its packs' hour |
| reviewer.ts:588 | pack-objects stderr, last 2000 | kept (4,000 now, its progress taken out) | |
| reviewer.ts:511, 543 | pack fresh 10 min | kept | |
| reviewer.ts:512, 658 | packs kept an hour | kept; now an hour since last named | |
| reviewer.ts:1237-1259 | summaries fresh 10 min, 64 | changed | accounts kept an hour since last asked (as their packs), the newest 64 |
| reviewer.ts:1272, 1310 | lock wait 60 s, 250 ms poll | removed (R4, R5) | `shared/lock.ts`, no wait limit, "waiting for another push's account" |
| reviewer.ts:1288 | young lock < 5 s | removed (R9) | `shared/lock.ts` |
| reviewer.ts:688, 712 | 100 subjects in the squash; subject 200 | kept, the cut marked (R1) | the squash's message is written to the forge's history, where nobody pages it |
| reviewer.ts:731-745 | names cut at 80, emails at 120, committed | refused, not cut | names up to 80, emails up to 254 (RFC 5321); over, no squash is offered, and a warning says which and why |
| reviewer.ts:793-795 | squash identity 210, dates 40 | removed | `shown`'s flood bound |
| reviewer.ts:1088-1110 | header names 40, 20 commits named | kept | one sentence of a warning; the rest counted |
| reviewer.ts:1358 | pack-streaming process, 30 min | kept | as the pusher's |
| review-client.ts:28, 35, 107, 187 | the start window, a 30 s tips ask, the 1 MiB header | kept | |
