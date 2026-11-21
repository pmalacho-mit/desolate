# Limits 08: bringing a workspace up

Ticket 8 of the limits effort (#180). The rules (R1 to R9) are [limits.md](../limits.md); the
rows are [limits-triage.md](../limits-triage.md)'s. Line numbers are the triage's (before this
change).

## What changed, by rule

- **R4, one owner of patience.** The host owns how long a start may take, and it sets no
  total. It runs the VM's two long steps (`workspace/init.ts`, `workspace/devcontainer.ts`)
  with `b.spawn` and reads their stderr a line at a time (`stepInVm`, `host/workspaces.ts`).
  Each step says what it is doing when it begins it, and every `BEAT_MS` (10 s) that it still
  is, with how long so far (`shared/step.ts`). The host stops a step only when it has said
  nothing for `QUIET_BEATS` (12 beats, two minutes): the VM froze, its ssh went, or the
  program hung where it could not say so. A step that is running is never stopped for being
  slow. Inside the VM the paired totals are gone. Against the share (git over the mirror and
  the domain's `.git`) and the network (`devcontainer up`'s pulls and builds) there is an
  idle bound, not a total, and `signal`: the step stops when the host goes away (its stderr
  closes, which the next beat finds).
  The lines reach whoever is watching: the dashboard (`DESOLATE_PROGRESS`, a `progress:` line
  each), a person at a terminal (each step on a line, its "still ..." rewritten in place), or
  nobody (a script, which sees the answer as before; T2's transcripts do not move).
- **R5, the init lock by liveness.** `withLock(..., { scope: "share" })` from
  `shared/lock.ts`. It is in `/workspaces/.desolate/locks`, which an agent in any workspace of
  the domain can write; `init.ts` says why that is safe (what such a side can do with it, it
  can already do to the domain's `.git`, and nothing reaches past the domain). A first checkout that takes twenty minutes holds it for twenty minutes,
  and a workspace that died in its init leaves it to the next in a few beats. The wait says
  whom it waits for, every beat, and has no timer.
- **R1, cut once, at the display, with a mark.** The devcontainer's status, image name, user
  and reason travel whole from the VM (`devcontainer.ts`'s state, `wsd.ts`'s summary), bounded
  on the host only against a flood (`printable`, `SAFE_MOST`, marked). Errors from the VM go
  through `failure()`: their last lines, and, when that is not all, how much was left out and
  where the whole of it is (a file under the host's logs, `fromVm`).
- **R3, named bounds, said where the person looks.** Ports below `PORTS.min` and listeners past
  `MIRRORS` (256) are not forwarded: `wsd.ts` says so in the devcontainer's line (which `up`,
  `desolate status` and the dashboard show) and in its `ports` reply (`unforwarded`, for
  `desolate ports`: ticket 9's to show). `forwardPorts` entries that are skipped are listed in
  the devcontainer's note, each with why. Settings over 64 KiB are said in the note too.
- **R8.** The status script counts characters as code points (it said characters and counted
  bytes), and cuts a note between characters, ending in the mark.
- **R9.** The init's old lock (mkdir, a two-minute age, a three-minute wait), the double cut
  of the devcontainer line (500 on the host after 300 and 160/240 in the VM), the image cut at
  120 then 80, the user at 40, and the `-600`/`-800`/`-300`/`-200` tails are deleted.

## Bounds against the VM, which stay hard

What a VM sends the host is written by a side that is not trusted. Taking away its totals
did not take away these (a fresh-context review of this change found the first three as
holes, and they are fixed here):
- **Bytes:** every byte a step sends counts toward `RUN_MAX`, its "still ..." lines and a line
  that never ends too; past it the step is stopped, said.
- **Silence:** two minutes with no line, and the step is stopped: SIGTERM, then after five
  seconds SIGKILL and the answer without it (a child holding the pipes is not waited for).
- **What is kept of an error:** `vmText`, the last `KEPT_CHARS` (1 Mi characters), runs of
  empty lines made one, in one file for each workspace and step, overwritten: the daemon looks
  at each running workspace every 30 s, and a file each time would fill the Mac's disk.
  Each step of it is linear in the text, which the VM chooses (the review also found
  `tail()`'s quadratic regex; the foundation has since fixed it).
- **What is shown:** at most `SHOWN.lines` (20) lines of a step each beat, each cut at 500
  characters with the mark; the rest counted and said. The dashboard's progress is the
  daemon's, which every domain shares.
- **Text:** every line through `printable` before a terminal or a page.
- **No total.** A start the project keeps saying something in (a `postCreateCommand` that
  prints a byte a minute for ever) runs until the person stops it: that is R4. It holds that
  start only: its domain's room and its own VM, which it could hold by running anyway.

## Each row

| where (triage) | what it was | answer | what it is now |
|---|---|---|---|
| host/workspaces.ts:317, 331, 357, 378, 1155 | `.slice(-N)` of the VM's error output | removed | `failure()` through `fromVm`: the last 10 lines (services, checkouts), 2 (devcontainer, editor) or 3 (the would-be-lost look), how many came before, and the text (`vmText`) kept in `~/.desolate/logs/<domain>--<workspace>-<step>.txt` |
| host/workspaces.ts:184-196 | `DESOLATE_WORKSPACE_*` size overrides | kept hard | unchanged: the bounds are `shared/size.ts`'s facts. Moving them into the settings registry is the settings ticket's (a second `define` of one name throws at load) |
| host/workspaces.ts:326 | init: `timeoutMs: 900_000` | removed (R4) | no total: `stepInVm`, stopped only after two minutes with no line |
| host/workspaces.ts:352 | devcontainer: `timeoutMs: 3_700_000` | removed (R4) | as above |
| host/workspaces.ts:356 | `.slice(0, 500)` of the devcontainer line | removed | `printable(line)`: whole, bounded only against a flood, marked if cut |
| host/workspaces.ts:1165 | `\S{1,300}` checkout path in the "would be lost" answer | removed by better code | `lostIn`: a line names one of the checkouts the host asked about, or it is counted as unreadable ("N lines of its answer could not be read, so something may be lost that is not named here"). Before, an unmatched line was dropped, and a remove could read as safe |
| workspace/bridge.ts:44 | svcnet's answer to `L` in 3 s | kept hard, better | a slow answer keeps every mirror as last known (before, one slow answer closed every mirror for a second) |
| workspace/bridge.ts:48 | 64 KiB answer | kept hard | against the project's container; holds a list of 10,000 ports |
| workspace/bridge.ts:137-138, 162-163 | `>= 1024`, `.slice(0, 256)` | kept hard, said | `PORTS`, `MIRRORS` (named: the host takes no more listeners from one workspace); what gets no mirror is said (`unmirrored`, then wsd.ts) |
| workspace/desolate.ts:634 | default spawn name cut at 40 after the suffix | removed | `spawnedName`: the parent's part is cut to leave room for `-xxxx` within `NAMES.slug`, and never ends in a dash |
| workspace/devcontainer.ts:135 | settings `<= 65_536` (UTF-16 units) | kept hard, said | `SETTINGS_BYTES` (bytes, R8); over it, the note says so with both sizes |
| workspace/devcontainer.ts:572, 577-578 | `forwardPorts` host `{0,62}`, port range | kept hard, said | `forwardsLeftOut`: every entry not carried, with why, in the note (compose) |
| workspace/devcontainer.ts:643, 662-664 | waiting for svcnet (1 s, 50 x 100 ms) | kept hard | unchanged: a program of ours starting in the container |
| workspace/devcontainer.ts:707-716 | docker daemon: 90 s counted in sleeps of a 20 s probe | kept hard, by the clock | `DOCKER_WAIT_MS`, measured by `Date.now()`; said while it waits |
| workspace/devcontainer.ts:759 | `devcontainer up` `timeoutMs: 3_600_000` | removed (R4) | `idleMs` 1 h (`UP_QUIET_MS`: silence, not total) and `signal` |
| workspace/devcontainer.ts:929 | image `.slice(0, 120)` | removed | whole in the state |
| workspace/init.ts:23 | every git step `timeoutMs: 600_000` | removed (R4) | `idleMs` 10 min (`GIT_QUIET_MS`) and `signal`; the long ones (`checkout`, `fetch`, `worktree add`) run with `--progress`, so a large LFS checkout is never silent, and say what they do |
| workspace/init.ts:45 | lock stale after 2 min | removed (R5) | `shared/lock.ts`, scope `share` |
| workspace/init.ts:50 | lock wait 3 min | removed (R4) | waits while the caller does, saying for whom |
| workspace/svcnet.ts:133 | request line 512 | kept hard | unchanged (against what runs in the container) |
| workspace/wsd.ts:33, 80 | `>= 1024` | kept hard, said | `PORTS`; listeners below it are named (`lowOf`, not the VM's own ssh and resolver) and said in the devcontainer's line and in `unforwarded` |
| workspace/wsd.ts:175-180 | image 80, user 40, why 300, folder 300 | removed | whole; with the devcontainer's note and what is not forwarded |
| workspace/wsd.ts:239 | request line 64 KiB | kept hard | comment corrected: it bounds this daemon's memory against a line that never ends |
| workspace/status:41, 82-84 | `NOTE_MAX=16384`, `head -c` | kept, better | `NOTE_MAX` names `NAMES.noteBytes` (T1 checks they agree); cut between characters, ends in `…` |
| workspace/status:109 | owner `{1,40}` | kept hard | names `NAMES.slug` (T1 checks) |
| workspace/status (message) | `${#message}` under `LC_ALL=C` | fixed (R8) | `chars()` counts code points; `STATUS_MAX` names `NAMES.status`; the message is `over()`'s sentence |
| workspace/editor.sh:109-113 | 60 s, then "did not start" (a failure) | asked of nobody: said | after 60 s with the server and gate alive, `editor: still starting`, and `up` goes on, showing the editor's address "(still starting: it opens once it listens)". A server or gate that died fails as before, with its log |
| workspace/start.sh:64-65 | 10 s for wsd's socket | removed | waited for while wsd lives (the host bounds start.sh) |

The "keep" rows looked at once: `host/workspaces.ts:312, 344` (start.sh's 300 s, now said in a
comment: the bound on a VM that is not answering), `:1152` (the look's 120 s), `:1306`;
`bridge.ts:28`, `desolate.ts:728`, `devcontainer.ts:794, 883`, `init.ts:27, 236`, `wsd.ts:29,
118` (`ss` 5 s, now said), `271, 280, 289`, `status:66, 99`, `editor.sh:66, 104, 114`,
`git-remote-desolate-mirror:22`: internal, unchanged.

## Tests

- In-source: `shared/step.ts` (`elapsed`, `saying`), `init.ts` (`settled`), `devcontainer.ts`
  (`settingsLeftOut`, `forwardsLeftOut`), `wsd.ts` (`lowOf`, `unforwardedNote`,
  `devcontainerSummary`), `bridge.ts` (`portsOf`), `desolate.ts` (`spawnedName`),
  `host/workspaces.ts` (`lostIn`).
- T1 `tests/v3/t1/workspace-scripts.test.ts`: the status script's bounds are `NAMES`'; it counts
  code points; a note is cut between characters, within the bound, with the mark; a control
  for each.
- T2 `02-domains`: a live holder of the init lock for 150 s (longer than the host lets a step
  go silent) is waited for, said; a step stopped with SIGSTOP is ended after two minutes of
  silence, said; the same holder killed (the control) has its lock taken within a few beats.
