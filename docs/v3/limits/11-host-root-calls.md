# Limits 11: the host's calls to the root and its VMs

Ticket 11 of the limits effort (#183): how long the Mac's CLI waits on the root VM and on
Lima, and what it shows when they fail. The rules are [`../limits.md`](../limits.md)'s.

## What changed, by rule

- **R4, patience where the person is.** A call to the root (`rootctl`, `host/stack.ts`) is
  no longer killed at 15 minutes in all. It is waited on while the root says anything (a line
  of progress, the answer) and given up only after a *silence*: the setting
  `root.silentSeconds` (`DESOLATE_ROOT_SILENT_SECONDS`), 900 by default, so no call the old
  timer let finish is cut, and a fetch that prints its progress for an hour is never cut.
  `signal` ends a call whose asker went away. The calls nobody watches (the daemon's polls,
  bootstrap's and doctor's probes) are one table, `BRIEF`, by operation with why each, and
  are made with `rootctlBrief(op)`. Provisioning a VM (the base, or the root again in place)
  and carrying the root's state across a rebuild run under no timer: they say each step as
  it starts (`provision.sh`'s `==>` lines) or move bytes, and Ctrl-C stops them.
- **R1, errors whole.** Every `.slice(-N)` of another layer's output (the root's, limactl's,
  provision.sh's, gh's, a workspace's) goes through `because(summary, what, output)`
  (`host/failures.ts`), which is `failure()` (`shared/text.ts`) with a keeper: the last ten
  lines, made safe, and when that is not all of it, how many lines were left out and the
  path of the whole text, under `~/.desolate/logs/failures/` (0600, the newest 100 kept).
  `desolate doctor` names the last one (and `--json` gives it as `lastFailure`).
- **R5, locks by liveness.** The issue-publish lock is `shared/lock.ts`'s, held by the
  process publishing: a crash leaves it to the next at once, not after ten minutes.
- **R6, settings.** `root.silentSeconds`, `vm.bootMinutes`, `events.kept`.
- **R9.** `Backend.logs` (both backends) had no caller anywhere: deleted, with its
  `.slice(-60)` and `--tail 200`. socat's `-t 86400` is gone (the request is one line and
  the service answers when it has read it; socat's input is held open, then closed once the
  answer came). The base64 step of the root-state carry is gone (the archive streams to and
  from a file). The spawn replay window is derived from `FRESH_MS`.

## Each limit

| where (before) | what it was | answer | what it is now |
|---|---|---|---|
| host/stack.ts:192, 250 | `timeoutMs ?? 900_000`, a total on every rootctl call | removed / setting | an idle timer: silence for `root.silentSeconds` (900); progress resets it; `signal` cancels |
| host/stack.ts:185 | `socat -t 86400` | removed | socat's stdin is held open until the answer; no timer |
| host/daemon.ts:418 and the like (ticket 9's) | 30 s / 60 s per call | keep, one table | `BRIEF` in host/stack.ts, by op, with why; `rootctlBrief(op)` (see "Needs from another ticket") |
| host/stack.ts:258, 296, 313, 334, 359 | `.slice(-400)`, `.slice(-300)` | removed | `because()`; the secret operations show stderr only (stdout may hold the value) |
| host/spawn.ts:82; host/bootstrap.ts:144, 186, 294, 323 | `.slice(-300/-600)`, last 5 lines | removed | `because()` |
| host/vm/lima.ts:267, 476, 746, 772, 827 | last 2 to 6 lines joined by ` \| `, `.slice(-900)` | removed | `because()` (the confined start still names ha.stderr.log) |
| host/carry.ts:58, 211, 227 | `.slice(-300)` | removed | `because()` |
| host/templates.ts:266; host/editor-defaults.ts:134, 136 | `.slice(-200)`, `.slice(0, 200)` | removed | `because()`, `printable()` (its flood bound only) |
| host/templates.ts:140, 271 | `printable()` default 300 | removed | `printableLines()`: the message is ours, of `because()`'s lines |
| host/issues.ts:90, 132, 150 | `printable(…, 120/400/200)` | removed | `printable()` (flood bound) and gh's error by `because()` |
| host/issues.ts:46, 62 | the lock is stale after 10 minutes | removed | `withLock(…, { wait: false })`: refused while its holder lives, taken at once from a dead one |
| host/issues.ts:85, 147, 314 | `timeoutMs: 30_000` | keep, in the table | `rootctlBrief("issue.done")` |
| host/bootstrap.ts:258, 336 (ping), 465 (doctor) | 30 s, 60 s | keep, in the table | `rootctlBrief("ping")`, `rootctlBrief("doctor")` |
| host/bootstrap.ts:319 | re-provisioning the root, killed at an hour | removed | no timer; streamed, each step said; Ctrl-C stops it (provision.sh is idempotent) |
| host/vm/lima.ts:728 | provisioning the base, killed at an hour | removed | as above |
| host/vm/lima.ts:741, 767, 815-835 | `--timeout 10m/20m/30m` paired by hand with 900/1500/2400 s | setting, derived | `vm.bootMinutes` (30, the most patient of the three); node's kill is that plus 10 minutes |
| host/vm/lima.ts:760 | `limactl create` killed at 20 min | removed | no timer: it copies a disk on this machine and reaches nothing |
| host/vm/lima.ts:544-553 | "a minute" counted in sleeps | keep, measured | a minute of the running clock (each look's own time counts) |
| host/vm/lima.ts:1051; host/vm/fake.ts:350 | `.slice(-60)`, `--tail 200` in `logs()` | removed | `Backend.logs` deleted: nothing called it, and there is no `vm logs` command |
| host/carry.ts:55, 223 | 600 s each way, and the archive as one base64 string under `RUN_MAX` (192 MiB) | removed | streamed to/from the file (`stdoutTo`, `stdinFrom`), no timer, any size; a gzip header is checked |
| host/events.ts:159-174 | `hub(keep = 500)`, a replay of more gives 500 with no note | setting | `events.kept` (500); release/docs/reference.md says so. (An in-stream note would change the stream tests/v3/t1/events.test.ts pins.) |
| host/signin.ts:22, 24 | `ttlMs`, `most` | keep hard | already exported as `SIGNIN`: ticket 4 imports it in place of root/stated.ts's copy |
| host/spawn.ts:164, 209-210 | `MOST_AT_ONCE = 3` | keep hard (R7) | its comment says whose input it bounds (workspaces' signed requests) and why |
| host/spawn.ts:207 | `30 * 60_000` | keep, derived (R3) | `2 * FRESH_MS` |
| host/paths.ts:16-17; host/vm/types.ts:116; host/editor-defaults.ts:22-32, 24; host/env-import.ts:42 | name and size bounds | keep hard | unchanged |
| the "keep" rows (timeouts of local steps, ControlPersist, sizes) | | keep | unchanged |

## Measured

Nothing new was measured. The `BRIEF` numbers keep the values the daemon passed; the
comment carries the M1's measurement of a call (100 ms over the service, 240 ms the old way).
