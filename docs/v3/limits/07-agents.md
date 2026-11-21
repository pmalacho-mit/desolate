# Limits 07: `desolate agent`'s log keeps the newest, and is read from the start

Ticket 7 of the limits effort (#179). Files: `release/workspace/agent-holder.py` (the holder,
in the VM), `release/host/agent.ts` (the CLI, on the Mac), `release/docs/agents.md`; and,
outside them, the agent verb's block of `release/host/cli.ts` (its flags; see the pull
request). `desolate agent` holds any long-running command, not only an AI agent.

## What changed, by rule

- **R1, a cut is said.** The log was one file that stopped being written at 64 MiB, keeping
  the oldest, and `agent log` showed its last 2 MiB of that forever. Now the log is segments
  (`~/.desolate-agents/<name>.log.<offset>`, each named by how many bytes the agent had
  printed before it, so none is ever renamed), and the oldest is dropped past a most. A read
  from the start begins with `[desolate: <size> of older output was dropped here: the log
  keeps the newest <size> (the setting agent.logMiB)]`; a read that does not begin at the
  start says on stderr how much is kept before it, and how to read it all. An attach's replay
  says when earlier output is not replayed. The holder's errors are `failure()`: the last ten
  lines, and the whole kept under `~/.desolate/logs/` when that is not all of it. The list's
  command is fitted to the terminal with the mark, and whole to a pipe.
- **R2.** `agent list` shows a page (`PAGE`) of each workspace's agents and `and N more
  agents`; `--json` is every well-formed row, as `recipes/issues.sh` reads it.
- **R3.** The name rule is names.ts's `SLUG` (NAMES.slug), and its refusal says "at most 40".
  The holder repeats `NAMES.slug` and `TERMINAL` as `NAME_MOST`, `COLS_MOST`, `ROWS_MOST`,
  named in comments; `tests/v3/t1/agent-holder.test.ts` checks they agree.
- **R4 and question 2.** `stop` no longer SIGKILLs the process group 3 s after Ctrl-C. At a
  terminal it says it is waiting and asks "Kill it now? [y/N]", with no timer; from a script
  it asks the program to stop and says whether it has ended; `--kill` kills at once.
- **R6.** `agent.logMiB` (`DESOLATE_AGENT_LOG_MIB`), defined in host/agent.ts, passed to the
  holder as `--log-most`. Unset, the holder takes a twentieth of the disk its log is on
  (statvfs): the host does not know the VM's disk, so its default is `null`, meaning that.
- **R9.** Gone: the 2 MiB replay buffer in the holder's memory (a new attach is replayed from
  the log), the 10-minute "still attachable" loop after the agent ended (the holder ends with
  it; an ended agent is read from its log), the `tail -c 2097152`, the two cuts of an error
  (600 then 300), the two cuts of a command (120 then 60), the 50-row cap, a second copy of
  the name regex.

## Each limit

| where (before) | what it was | answer | what it is now |
|---|---|---|---|
| host/agent.ts:139, 199, 338 | holder error cut to 600 then 300 chars | 1, removed | `failure()`: last 10 lines, whole text kept under the host's logs, made safe |
| host/agent.ts:77, 237 | name regex, 40 chars | 4, hard | `SLUG` (NAMES.slug); the fix says "at most 40" |
| host/agent.ts:234 | 50 agents per workspace | 4, hard, said | a page of `PAGE` (100) in text, with "and N more agents"; `--json` all. The VM's answer is already bounded by exec's own stream bound |
| host/agent.ts:248, 271 | command cut to 120 then 60 | 1, removed | `printable` (its safety bound), then `fitted` to the terminal's width with `…`; whole to a pipe |
| host/agent.ts:349 | `tail -c 2097152` | 1, removed | the holder's `log` streamed (spawn, not exec: a log may be gigabytes); `--all`, `--lines`, `--since`; to a terminal the last 100 lines by default, to a pipe all |
| agent-holder.py:37 | KEEP 2 MiB in memory, replayed | 1 and 4 | no buffer; `REPLAY` 2 MiB read from the log, from a line's start, marked: more than a terminal keeps to scroll back (Terminal.app and iTerm2 keep 10,000 lines and fewer; 2 MiB is about 25,000 lines of 80) |
| agent-holder.py:38, 174 | LOG_MOST 64 MiB, then nothing written | 1 and 3 | eight segments, the oldest dropped past `agent.logMiB` (default a twentieth of the disk), the drop said by every read from the start |
| agent-holder.py:44 | name over 40 | 4, hard | `NAME_MOST`, = NAMES.slug (T1 checks); "at most 40" said |
| agent-holder.py:94-95 | 100 × 0.05 s for the socket | 4, hard | 5 s on a pipe the holder writes once it listens (an agent that ends at once no longer reads as "did not start": its socket goes with it now) |
| agent-holder.py:199 | 200,000 chars of an unended client line | 4, hard | kept; commented: the client is the host's attach, as this user |
| agent-holder.py:209 | resize within 1000 × 500 | 4, hard | `COLS_MOST`/`ROWS_MOST`, = TERMINAL (T1 checks) |
| agent-holder.py:220, 224 | 0.3 s sleep; SIGKILL 3 s after | 2, asked | the second Ctrl-C is scheduled (`AGAIN`, 0.3 s: as a person presses again), not a blocking sleep; no kill unless asked ("K", `--kill`, or "y") |
| agent-holder.py:246-248 | ended agent attachable 600 s | 1, removed | the holder ends with its agent; attach to an ended one replays from the log |
| host/agent.ts:134, 195 (60 s), list/stop/log (30 s) | timeouts | keep | start, list and a kill's wait keep theirs; `log` is streamed (spawn, no timer); a stop at a terminal waits as long as the person |
| host/agent.ts:378 | 120 × 40 when unknown | keep | unchanged |
| agent-holder.py:130, 138, 185 | 120 × 40 first size; listen(8); 5 s state tick | keep | the tick is named (`TICK`) and also notes times for `--since` |
| agent-holder.py:327-329 | stop waits 1 s for the holder to read "k" | keep | and says whether the agent ended in that second ("asked … to stop", not "stopped") |

## Agents started before this change

Only the holding process can be old: every other use of the holder (`log`, `list`, `attach`,
`stop`, `start`) runs `agent-holder.py` anew from the release share. The socket's protocol is
the same; "K" (kill) is new, and an old holder ignores it, so `--kill` sends "K" and then "k",
on which an old holder kills 3 s later. An old holder's log is one file, `<name>.log`: it is
read as one segment at offset 0 (and has no times: `--since` says so), and starting that name
again under a new holder makes it the first segment and carries on.

## Measured, and not

- T1 (`tests/v3/t1/agent-holder.test.ts`, the holder run on the Mac with a stand-in
  enter.sh): `seq 1 400000` (2.7 MB) under a 1 MiB most keeps eight segments of 128 KiB, about
  1 MiB, starting at a whole line near 276,000, the drop said; a control under its most keeps
  all from line 1. A program that traps SIGINT is still running 4 s after `stop`, and `--kill`
  ends it (exit -9); a control that ends on Ctrl-C ends on a plain stop.
- Not measured: a real TUI agent (Claude Code) redrawing for a day; how big a twentieth of a
  workspace's disk is in use (60 GiB disks: 3 GiB a log). `--kill` against a program in a
  devcontainer (it reaches `docker exec`'s client only, as the 3 s kill did before).
