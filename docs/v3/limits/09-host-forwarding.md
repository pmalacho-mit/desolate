# Limits 09: the host's forwarding and its link

Ticket 9 of the limits effort (#181). The rules (R1 to R9) are [limits.md](../limits.md); the
rows are [limits-triage.md](../limits-triage.md)'s. Line numbers are the triage's (before this
change); `host/daemon.ts` was 3,700 lines, and is 2,400 now.

## What changed, by rule

- **Clean-up: the forwarder's decisions are a module of their own.** What the forwarder and
  the pages' port decide about a connection (sniffing what it said, routing it by name,
  redirects, raw ports, what a workspace's VM says it listens on, what `desolate ports`
  shows) moved, unchanged, from `host/daemon.ts` into `host/forward.ts` (1,990 lines, its
  in-source tests with it): `daemon.ts` keeps the reading, the writing and the dialling. The
  port holder's parser (`holderIn`) moved into `host/held-ports.ts`. Each move is a commit
  with nothing else in it. `reviewerSummary` (ticket 2's) stays where it was.
- **Q3, the link's connections are a setting, and a refusal is said (R1).** A workspace's
  link carried 64 connections out at once, and destroyed the 65th with nothing said anywhere;
  a parallel install saw resets. The connections cannot be one multiplexed session tonight:
  that needs a demultiplexer in the root, at the proxy's end (ticket 10's), and what crosses
  the link would change. So: `link.connections` (`DESOLATE_LINK_CONNECTIONS`), default from
  the Mac (below), from 1 to 1000. Past it, as many more **wait their turn**, first come
  first carried, for as long as their program waits (R4: no timer here). Past those, one is
  refused: answered as the proxy refuses (`503`, `X-Desolate-Reason`), so a plain-HTTP
  program reads why, naming the setting; the daemon's log says so at most once a minute (the
  workspace is not trusted with the Mac's disk); `desolate ports --json` has a note per
  workspace with the count and the last time, and the host's facts carry the same note
  (`notes`) for the dashboard, whose showing it is ticket 4's.
  The same gate is on the link's unix socket (qemu, the fake backend), which had none. On vz,
  connections still proving the link's token are nobody's yet: at most as many are in their
  handshake at once, and past that one is closed, since it is not known to be the
  workspace's to tell.
- **R4, the pages' port waits as any HTTP server does.** A client silent for 400 ms there was
  closed: a browser's preconnected socket, used a moment later, failed the page it was opened
  for. No protocol there is one whose server speaks first, so it is held as on every
  forwarded port, `SILENT_MS` (60 s, node's own `headersTimeout`), among the same
  `SILENT_MOST` (512) silent sockets, of which the longest-waiting goes when full. The pages'
  port had no such bound, and needs one now that a silent socket lives a minute.
- **Q1, the pusher's log reader cannot stall.** A line longer than one look (1 MiB) never
  ended inside a look, so the offset never moved and every later push's event stopped for
  good. Such a line is skipped to its end (`pusherLogRead`, `skipping`), and the daemon's log
  says so once. The look's size is named (`PUSHER_LOOK_BYTES`) and passed to the command.
  (Reading the log as a stream with no fixed size would need a process held in the root for
  it: a look every 2 s of what is new is the same, with less to go wrong.)
- **R1, R3, dropped listeners are said.** Below `PORTS.min` (shared/limits.ts), the VM's own
  (`unforwarded.low` from wsd, ticket 8) or one the host met, a listener is in
  `desolate ports` as reserved, with why ("below 1024 a port is this Mac's system's"). The
  host's cut of a workspace's listeners is named (`FORWARDS_MOST`, 256) and what it cut is a
  note ("N more listeners are not forwarded: past the first 256 of a workspace"); so is wsd's
  count of a compose service's listeners past its mirrors (`unforwarded.more`). An older wsd
  says nothing of either, and nothing is shown.
- **R6, raw and doctor ports are settings.** `DESOLATE_RAW_PORTS` is `forward.rawPorts`,
  `DESOLATE_DOCTOR_PORTS` is `doctor.ports` (which keeps `none`), both read with
  `settings.ts`'s `ports`: a list with a port below 1024 is refused, saying what it takes,
  where it was shortened in silence.
- **One lookup of a port's holder.** lsof was asked in two places, once blocking the daemon;
  now once (`held-ports.ts`, `portHolder`), in the background, for doctor and the daemon.
- **Errors whole (R1, R8).** The relay (`workspace/net/egress.ts`) cut the proxy's
  `X-Desolate-Reason` at 300 characters and read it as latin1, though the proxy writes UTF-8.
  It takes the whole line, as UTF-8, made safe (`printable`), bounded by the head it is in
  (`HEAD_MOST`, 16 KiB, as node's HTTP server bounds a head), now applied to an ended head
  too (one that ended past 16 KiB was read whole).
- **R7, the state answer's 16 MiB stays hard, and is said.** One answer from the root's state
  service (the whole state, for `/host/state`) is bounded against the root's user, named
  `STATE_ANSWER_BYTES`; hitting it says the bound and the sizes (`over`, shared/limits.ts),
  not "said too much". The daemon keeps the largest answer it has had and says it with the
  bound to its `editor` question; `stateRoom()` is what doctor asks (the check is in
  `bootstrap.ts`: ticket 11's, below).
- **R6, the spawn room is a setting.** `spawn.memoryPercent` (`DESOLATE_SPAWN_MEMORY_PERCENT`),
  85 unless set, up to 400: a person may knowingly give more than the Mac has.
- **Two comments that said what the code does not do** are fixed: the raw ports are not
  "learned from bytes that were not HTTP or TLS" (nothing learns them, decisions.md), and a
  silent client is waited for a minute, not "up to two minutes".
- **For ticket 8:** the devcontainer's line comes whole from the VM and is only made safe
  here (the second cut, at 400, went); a dashboard action's lines are posted as the root
  keeps them, its last 60 (`ACTION_LINES`), the first saying how many came before.

## Measured

- One connection a link carries, on Lima, is a `limactl shell` of its own: 83 MB, and 2 MB
  for its ssh (`footprint`, on the M1, 2026-11-21). Hence `LINK_CONNECTION_MIB` = 85 and the
  default: an eighth of the Mac's memory's worth, from 16 to 256 (a 16 GiB Mac: 24; 64 GiB:
  96). Waiting connections cost only a socket of the daemon's.
- Each is also a session on the root VM's one ssh connection, which allows 1000 (`MaxSessions`,
  root/start.sh): that is the setting's top. It is shared with every other workspace's link
  and the daemon's own sessions into the root, so many workspaces each at a large setting can
  still meet sshd's refusal; on the default, ten workspaces all at their bound on a 64 GiB Mac
  are 960.

## The rows

| where (triage) | what it was | answer | what it is now |
|---|---|---|---|
| host/daemon.ts:99 | `RAW_PORTS`, server-first ports, env read by hand | Q3 setting | known list `RAW_PORTS` (forward.ts) plus the setting `forward.rawPorts` |
| host/daemon.ts:484, 1894-1895; held-ports.ts:27 | `p >= 1024 && p <= 65535` | Q4 hard (the Mac's system's ports) | `PORTS` (shared/limits.ts); a listener below it is said in `desolate ports`; a listed port below it refuses the setting, saying so |
| host/daemon.ts:1901 | `.slice(0, 256)` listeners per workspace | Q4 hard (VM-written) | `FORWARDS_MOST`, and how many it cut is a note |
| host/daemon.ts:195, 2852 | `LINK_CONNECTIONS = 64`, the 65th destroyed silently | Q3 setting (Q1 not tonight) | `link.connections`, default from the Mac; then a wait; then a refusal said to the program, the log, `desolate ports`, the facts |
| host/daemon.ts:418, 442, 454, 3184, 3502; 429, 3515 | rootctl `timeoutMs` literals | not done here | ticket 11's `rootctlBrief(op)` (host/stack.ts, PR #194) is the per-op table: "Needs" below |
| host/daemon.ts:634 | `\S{1,2048}` redirect path | Q4 hard | kept (forward.ts) |
| host/daemon.ts:673 | `head.length < LIMIT` (16 KiB) | Q4 hard | kept (forward.ts, `LIMIT` from shared/sniff.ts) |
| host/daemon.ts:2261 | `mac * 0.85` spawn room | Q3 setting | `spawn.memoryPercent`, 85, 10 to 400 |
| host/daemon.ts:2565 | `waiting.size >= 512` | Q4 hard (another user's silent sockets) | `SILENT_MOST`, now over the pages' port too |
| host/daemon.ts:2572 | `raw ? 400 : 60_000` | Q4 hard | named: `SERVER_FIRST_MS` (a decision: a server-first client says nothing at all) and `SILENT_MS`; comment fixed |
| host/daemon.ts:2672 | pages' port `sniffSocket(client, 400)` | Q1 removed | `SILENT_MS`, as every port |
| host/daemon.ts:3053 | `16 * 1024 * 1024` state answer | Q4 hard (the root's user) | `STATE_ANSWER_BYTES`; hit says the sizes; the largest kept, `stateRoom()` for doctor |
| host/daemon.ts:3362 | `head -c 1048576`, stall on a long line | Q1 removed (the stall) | `PUSHER_LOOK_BYTES`; a longer line is skipped and said |
| host/daemon.ts:2811 | `printable(reply.devcontainer, 400, " ")` | R9 (the double cut) | `printable(reply.devcontainer)`: the VM's line whole, made safe, `SAFE_MOST` against a flood |
| held-ports.ts:15 | `DEV_PORTS` | Q3 setting | the default of `doctor.ports` |
| egress.ts:119 | `answer.length > 16384` | Q4 hard | `HEAD_MOST`, applied to an ended head too |
| egress.ts:124 | `X-Desolate-Reason` cut at 300, latin1 | Q1 removed | the whole line, UTF-8, `printable` |
| egress.ts:207 | `sniffSocket(client, 5000)` | Q4 hard | kept |
| daemon.ts:508; held-ports.ts:91 | `printable(command, 40)` | R9 | `printable(command)`: macOS names a command in 16 characters, the cut never happened |
| daemon.ts:2509; held-ports.ts:82 | lsof `timeout: 3000`, written twice | keep, once | one `portHolder` (held-ports.ts), in the background |
| daemon.ts:2619 | raw port `sniffSocket(client, 600_000)` | keep | kept (forward/daemon: what the client says first is read before any goes on) |
| daemon.ts:2675, 2683 | git terminal 30 min idle, approval page 120 s idle | keep | kept (idle bounds against a browser, R4) |
| daemon.ts:2753, 2869, 2791, 3535 | held-port retry 10 s, link listen retry 2 s, wsctl ports 15 s, round pause | keep | kept |
| daemon.ts:2986, 3012, 3017 | the state service's ready connections, rootHttp 15 s | keep | kept |
| daemon.ts:3296, 3325; 3138 | 70 s long polls (root holds 50 s); facts every 45 s (root: gone after 150 s) | keep | kept; one constant for each pair would be in shared/limits.ts (the foundation's), with root/stated.ts (ticket 4's): not done |
| daemon.ts:3071-3077, 3148/3173, 3276-3279, 3312/3336/3347, 3367 | nudge rate, unsaved-work look, progress batching, retries, pusher read 20 s | keep | kept |
| daemon.ts:3446 | `writableLength > 1 MiB` events listener | keep | kept (says "lagged") |
| daemon.ts:3542 .. 3774, 3796/3820 | CLI-to-daemon ask timeouts, events reconnect polling | keep | kept |
| workspace/net/up.sh:28 | `--local-ttl=60` | keep | kept (the answer never changes) |

## Not done, and why

- **Multiplexing a workspace's link** (Q1 for the 64): one session per workspace into the
  root would remove the per-connection `limactl shell` and the setting with it, but needs a
  demultiplexer at the root's end, beside the proxy (ticket 10's `root/proxy/`), and a new
  framing on the link (`shared/link.ts`, ticket 15's). Worth doing; the gate here stays
  correct with it (a carried connection would cost a stream, not a process).
- **`desolate status`** does not show refused connections or dropped listeners: it is not a
  file of this ticket's. `desolate ports` and the host's facts do.
</content>
</invoke>
