# Hard-coded limits in desolate: triage inventory

Made 2026-11-20 from `/Users/desolate/isolated-devcontainers-suede` (branch `main`), read only. Paths are relative to `release/` unless they start with `docs/`. The pass skipped `tests/`, `suede.nests/`, `.suede/`, `.harness/` (the test harness), `node_modules`, `host/git-ui/vendor/` and the in-source test blocks (`declare namespace … Table<`/`Expect<`). The only exception is where a test pins a value; those rows say so.

## Summary

**483 rows**, in 8 tables, plus about 100 fixed facts in a separate list at the end. When several sites share one value and one purpose, they are grouped into a single row, so the number of literals in the code is higher than 483. One example is the 63 call sites of `printable()`, which are grouped by purpose.

| Area | Rows |
|---|---|
| host | 151 |
| git VM programs | 17 |
| root | 89 |
| reviewer, pusher, keyring | 78 |
| workspace | 48 |
| shared | 38 |
| scripts | 32 |
| UI pages | 30 |

**Kinds:**

| Kind | Rows |
|---|---|
| Timeout | about 110 |
| UX truncation | about 105 |
| Security bound | about 85 |
| Resource protection | about 80 |
| Polling interval | 22 |
| Cache lifetime | 17 |
| Retry policy | 11 |
| Other | the rest |

**First-guess dispositions:**

| Disposition | Rows |
|---|---|
| Eliminate | about 90 |
| Ask the person | about 35 |
| Setting | about 30 |
| Keep hard | about 130 |
| Keep | about 200 (a harmless internal choice or a fact; leave as is) |

### Main patterns

1. **Silent cuts.** Most truncations say nothing.
   - `shared/text.ts:14` `printable(value, max = 300)` cuts with no mark. It has 63 call sites, and about 22 of them rely on the default.
   - Lists are cut with `.slice(0, N)` and no "and M more".
   - Error output is cut to its tail with `.slice(-200)` or `.slice(-300)`, often twice in a row: first by the root, then by the host.
2. **A capped list feeds a count or a label, so the stack states a wrong number.**
   - `root/offers.ts:639` caps a review at `--max-count=200`, and the result is used three ways:
     - The dashboard says "All 200 commits" and "Push still sends all 200".
     - `desolate review` says "a push would send 200 commit(s)" (`host/push.ts:257`).
     - The dashboard lets the person pick from only 40 of them (`root/ui/dashboard.js:525`).
   - `git/upstream.ts:782` caps at `--max-count=50`, and line 858 then prints "50 commit(s) the remote does not have".
   - `host/domains.ts:275` lists 60 hosts, then prints a `net allow` command for those 60 only.
   - `recipes/issues.sh:42` reads `--limit 100`, so issues past the 100th count as closed.
   - The reviewer's commit list is the newest 50, while its each-commit text is the oldest 50 ("the first 50 of N"). This is the bug class found earlier.
3. **One limit written as separate literals in several files**, with nothing tying them together:
   - The 2 GiB pack/bundle cap: 4 places.
   - The 5 GiB LFS object cap: 5 places.
   - The 2000 LFS objects cap: 3 places, and it means something different in each.
   - The 40-character slug: about 10 places.
   - The 200-character status: 5 places.
   - The LFS pointer cutoff `< 400`: 4 places.
4. **Nested timeouts that disagree.** The push summary has four, each written by hand:
   - The page gives up at 90 s (`host/approve-web.ts:217`).
   - The root kills at 95 s (`root/review-ask.ts:82`).
   - The spawnSync backstop is 100 s.
   - The host waits 120 s (`host/daemon.ts:219`).

   Inside these, git timeouts of 120 s to 30 min can never fire. The same shape shows up elsewhere: the reviewer's 10-minute submit around a 30-minute fetch, and host/guest timeout pairs.
5. **Locks judged stale by age, where the age is shorter than the work they guard:**
   - The init lock: 2 min (`workspace/init.ts:45`) against git steps of 10 min each.
   - The fetch lock: 10 min (`root/repos.ts:428`).
   - The push lock: 5 min (`root/push.ts:478`).
6. **Hitting a cap produces a message about something else:**
   - A body over the cap is answered as "not JSON".
   - A bundle header over 4 MiB is answered as "not a v2 bundle".
   - More than 2000 LFS objects, after approval, gets "LFS objects are named by sha256, with a size of at most 5 GiB".
   - A clone with more than 2000 branches is told its bundle "carries … nothing else".
   - `keyring-client` says "the keyring did not answer" for the reviewer's or pusher's timeouts.
7. **Units that are not what they say.** "KiB" caps count UTF-16 characters, not bytes: the 256 KiB diff and the issue body's "64 KiB". The status check in `workspace/status` counts bytes under `LC_ALL=C`, but its message says "characters".
8. **Fixed resources with no setting.** The root VM is 2 CPUs, 2 GiB of memory and 30 GiB of disk (`host/stack.ts:141-143`), and it serves every domain's reviews, pushes and fetches. Only ports 80 and 443 leave a workspace (`root/proxy/proxy.ts:185`).
9. **Real security bounds on input an attacker controls are common and mostly right to keep.** A few of their numbers are principled:
   - git's pkt-line 65516.
   - OpenSSH's 256 KiB agent frame.
   - DNS 63/253.
   - sun_path 104.

   Most are round numbers picked once. Examples are 64 KiB header lines, 2000 refs and 256 listening ports.

### The 10 that matter most to a person using the stack

1. `root/review-ask.ts:82` (95 s kill, inside the page's 90 s at `host/approve-web.ts:217`): a large first push never gets a summary, nothing is cached, and the page cannot approve it. The error does not mention time. **Ask the person.**
2. `root/offers.ts:639` `--max-count=200`: the dashboard and `desolate review` state "200 commits" for any longer branch, and the dashboard lets you pick from only 40 (`root/ui/dashboard.js:525`). **Eliminate** (page the list, count separately).
3. `git/upstream.ts:782,858` `--max-count=50`: `desolate upstream` says "50 commit(s) the remote does not have" for any larger split. **Eliminate.**
4. The 2000 LFS objects cap:
   - `root/offers.ts:245` cuts silently, so such an offer can never pass, and "offer again" cannot fix it.
   - `root/pusher.ts:73` is checked only after the person approved, with an unrelated message.
   - `host/git-vm.ts:270` caps the request at 64 KiB, so in practice more than about 970 objects hangs a git-terminal push for 20 minutes.

   **Eliminate** (one cap, checked before review, with its own message).
5. `workspace/agent-holder.py:38` `LOG_MOST = 64 MiB`: the agent's log silently stops, keeping the oldest output, so `desolate agent log` shows stale output forever. A long Claude run will hit it. **Eliminate** (rotate, or keep the newest).
6. Warnings cut before the person signs:
   - `host/push.ts:647` shows at most 20 warnings, without saying so.
   - `host/approver.ts:161,209` cuts each reviewer line to 300 characters and the list to 60 lines.

   This is the same class as the warning cut off at the end of a line. **Eliminate.**
7. `host/domains.ts:275-286`: `desolate domain <d> net` shows 60 hosts and prints a `net allow` that leaves out the rest. Following it and then running `net enforce` cuts those hosts off. **Eliminate.**
8. `recipes/issues.sh:42` `--limit 100`: labelled issues past the 100th look closed, and their agents are stopped. **Eliminate** (page).
9. `root/keyring.ts:166` (the 2-minute challenge) and `root/raw-push.ts:26` (the 110 s wait): a person who reads a long diff before clicking Approve is refused and must start again. **Ask the person** (or extend while the page is open).
10. Root-side lists capped by size and judged stale by age:
    - The 2 GiB review bundle (`root/reviewer.ts:48`) is the whole history on first use, so a repository over 2 GiB can never be pushed.
    - The refs.json caps of 5000 refs and 1 MiB (`root/outbox.ts:217-223`) feed `git fetch --prune` (`root/offers.ts:112`), so branches past the cap can be pruned from the root clone.
    - `workspace/sync.ts:348` gives up on every request to the root after 2 min, saying "Is it running?".

Close behind these:
- `host/daemon.ts:195`: 64 link connections, the rest dropped silently.
- `host/daemon.ts:2672`: a 400 ms silent-client cutoff on the pages port.
- `root/rootd.ts:39`: 30 requests a minute per domain.
- `root/repos.ts:286`: the first fetch of a big repository is killed at 10 min.
- `shared/status.ts:364`: packed-refs over 256 KiB are not read at all.
- `image/provision.sh:118`: a 600 s download timeout builds an image with no editor.

## How to read the tables

- **when hit** is one of:
  - cut silently
  - cut and says so
  - refuses with a message
  - kills
  - waits
  - retries

  The message is quoted when there is one.
- **kind** is one of:
  - security bound
  - resource protection
  - UX truncation
  - timeout
  - polling interval
  - retry policy
  - cache lifetime
  - protocol fact
  - other
- **disposition** is one of:
  - **eliminate:** better code removes the need for it.
  - **ask the person:** make it a moment where the person is asked, not a hard stop.
  - **setting:** a setting with a sensible default.
  - **keep hard:** a deliberate bound, often against input an attacker controls. The row says whether the number itself is arbitrary.
  - **keep:** leave as is: an internal choice nobody will notice, or a fact.

  Pure facts are in the list at the end, not in the tables.

## Host (`host/`: the Mac's CLI, daemon, VMs, approval and git pages) (151 rows)

Covers `daemon.ts`, `vm/*`, `bootstrap`, `stack`, `workspaces`, `spawn`, `image`, `held-ports`, `agent`, `approver`, `notify`, `signin`, `approve-web`, `git-web`, `git-vm`, `push`, `domains`, `upstream`, `issues`, `repos`, `carry`, `env-import`, `templates`, `retired`, `cli`, `status`, `events` and `editor-defaults`. `host/vm/fake.ts` is the test-only backend and has one row.

| file:line | value | what it limits | when hit | person sees it? | stated reason | kind | disposition |
|---|---|---|---|---|---|---|---|
| host/daemon.ts:99 | `RAW_PORTS = [3306, 5432, 6379, 27017, 11211, 5672, 9092, 1433, 26257]` | which forwarded ports are treated as server-speaks-first protocols (MySQL, Postgres, Redis, Mongo, memcached, AMQP, Kafka, MSSQL, Cockroach) | a server-first protocol on any other port: the silent client waits 60 s (row below), then is closed | yes: a DB client on a non-listed port hangs, then drops; fix is `DESOLATE_RAW_PORTS` | "Protocols with no name in them, known by their port before any connection is seen." | other (default list) | setting (already `DESOLATE_RAW_PORTS`); could also be read from the devcontainer's `forwardPorts`/`portsAttributes` |
| host/daemon.ts:484, 1894-1895; host/held-ports.ts:27 | `p >= 1024 && p <= 65535` | ports a workspace's listener may be forwarded on; ports a person may list in `DESOLATE_RAW_PORTS` / `DESOLATE_DOCTOR_PORTS` | cut silently: a listener on 80 or 443 is never forwarded, a listed port below 1024 is dropped | no: the port simply is not in the list | "Fail closed on what the VM says: integers, 1024 and up" | security bound | keep hard (no privileged ports on the Mac); say "not forwarded: below 1024" |
| host/daemon.ts:1901 | `.slice(0, 256)` | listening ports per workspace taken from the VM | cut silently: ports after the 256th are not forwarded | no | "a sane number of them" | security bound (VM-written input) | keep hard (number arbitrary); say when ports were dropped |
| host/daemon.ts:195, 2852 | `LINK_CONNECTIONS = 64` | connections open at once on one workspace's link (its egress/secrets proxy traffic to the root) | refuses: the 65th connection is destroyed, no message, nothing logged | yes, indirectly: a build or install that opens many parallel connections sees resets | "Each connection costs a session into the root VM and processes here: a workspace gets this many at once" (also docs/incidents.md:220) | resource protection | setting, or eliminate by multiplexing link connections; at least log the refusal |
| host/daemon.ts:219 | `timeoutMs: 120_000` (review-ask in the root) | the reviewer's summary of a push, for the approval page and terminal prompt | kills. In practice it is never reached: the root kills at 95 s first (root/review-ask.ts:82), and the page gives up at 90 s (host/approve-web.ts:217). If it were reached, the summary would say "the reviewer's answer could not be read (it ended with 128: … (timed out after 120000 ms)); what a push carries can cause this" | yes, on the approval page / `desolate push` | none (the three values are not tied together) | timeout | ask the person ("the reviewer is still working on a large push: keep waiting?") |
| host/daemon.ts:234 | `printable(result.stderr.trim().slice(-200), 200)` | reviewer's own stderr in that error | cut silently to the last 200 chars | yes | "Its own words only (stderr), never what it was printing" | UX truncation | eliminate: link the full text (log) and show the tail marked as cut |
| host/daemon.ts:418, 442, 454, 3184, 3502 (30_000); 429, 3515 (60_000) | `timeoutMs: 30_000` / `60_000` | rootctl calls from the daemon: approvals.pending, approvals.refuse, issue.list, domain.list; approvals.answer, proxy.start | kills socat; if the root had accepted the op: "the root took '<op>' and its answer was lost: it may have run"; if not, the same op is run again by exec with the same timeout (host/stack.ts:248-251) | yes, on the approval page or in the daemon log | none | timeout | eliminate the scattered literals: one per-op table; keep values |
| host/stack.ts:192, 250 | `options.timeoutMs ?? 900_000` | every rootctl op that names no timeout (fetch, offer import, issue ops, domain ops, …) | kills; "the root took '<op>' and its answer was lost: it may have run" (fix "desolate doctor; then look before asking again"), or "the root did not answer '<op>' (exit 128): … (timed out after 900000 ms)" | yes, CLI | none | timeout | ask the person (progress already streams; a first fetch of a big repo can pass 15 min) |
| host/stack.ts:185 | `socat -t 86400` | how long socat waits for the root's answer after sending | never in practice; the 900 s timer above kills first | no | "(socat's -t: how long it waits for the answer after sending the request.)" | timeout | keep (means "no limit"); say so in the comment |
| host/stack.ts:258 (-400); 296, 313, 334, 359 (-300); host/spawn.ts:82 (-300); host/bootstrap.ts:144 (-600), 186, 294 (-300), 323 (last 5 lines) | `.trim().slice(-N)` / `.split("\n").slice(-5)` | the root's error output inside a refusal | cut silently to the last N chars or lines | yes, CLI error | none | UX truncation | eliminate: full text to a log file, tail shown with "…" |
| host/workspaces.ts:317 (-600), 331 (-800), 357 (-300), 378 (last 2 lines, then first 300), 1155 (-200) | `.slice(-N)` | VM's error output when a workspace's services, checkouts, devcontainer, editor or unsaved-look fail | cut silently | yes, `desolate up`, dashboard | none | UX truncation | eliminate (as above) |
| host/agent.ts:139, 199 | `printable(… .slice(-600), 300)`; 338 `printable(…, 300)` | agent-holder's error when an agent does not start / stop | cut silently (600 then 300) | yes, CLI | "(What the VM says is the VM's: made printable before it reaches a terminal.)" | UX truncation | eliminate the cut, keep printable() |
| host/vm/lima.ts:267 | `.split("\n").slice(-6).join(" \| ").slice(-900)`; 476 (2 lines), 746, 772 (5 lines), 827 (4 lines); host/approver.ts:106 (3 lines) | limactl's / provision's / swiftc's error text | cut silently | yes, CLI / bootstrap | none | UX truncation | eliminate: point at the log (Lima's ha.stderr.log is already named in some) |
| host/daemon.ts:508; host/held-ports.ts:91 | `printable(command, 40)` | name of the program holding a port (lsof `c` field) | cut silently | yes, doctor / dashboard | none | UX truncation | keep (macOS command names are at most 16 chars, so it is never hit) |
| host/daemon.ts:2509; host/held-ports.ts:82 | `timeout: 3000` (lsof) | how long lsof may take to name a port's holder | kills lsof; holder shown as "a program on this Mac" (daemon) / "not a program of yours: another user's, or the system's" (doctor) | yes, vaguely | daemon.ts:2507: run in background because a blocking lsof "held up every timer" | timeout | keep |
| host/daemon.ts:634 | `\S{1,2048}` | request path kept for a redirect | longer path is redirected to "/" silently | rarely | "printable ASCII and starting with \"/\", or \"/\"" | security bound | keep hard |
| host/daemon.ts:673 (uses `LIMIT` = 16 KiB, shared/sniff.ts:18) | `head.length < LIMIT` | bytes read before a connection's protocol/name must be decided | stops reading; treated as raw / not a request | no | "a head that ran to LIMIT" | security bound | keep hard (16 KiB = one TLS record, principled) |
| host/daemon.ts:2261 | `mac * 0.85` | memory given to running + starting workspaces vs. the Mac's, for a spawn requested by a workspace | refuses: "this Mac has no room for another workspace: X GiB of its Y GiB are given to running workspaces, and one more needs Z GiB (close one first, or ask the person)" | the agent sees it; the person only if told | "within 85% of this Mac's (no fixed number of workspaces, but not past what the Mac has)"; pinned by in-source Table daemon.ts:2291; decisions.md:1291 | resource protection | setting (a person may knowingly overcommit); keep as default |
| host/daemon.ts:2565 | `waiting.size >= 512` | silent client sockets waiting to be sniffed on forwarded ports | the oldest waiting socket is destroyed, silently | no | "At most 512 waiting at once, and when full the longest-waiting goes … a program of another user's opening silent sockets could otherwise lock the person out" (decisions.md:1305) | security bound | keep hard (number arbitrary) |
| host/daemon.ts:2572 | `sniffSocket(client, raw ? 400 : 60_000)` | on a known raw port: 400 ms of client silence means the server speaks first; on others, how long a silent client is held before it is closed | raw: piped to the owner; other: closed silently after 60 s | rarely (a server-first protocol on an unlisted port hangs 60 s) | comment at 2556-2557 says "up to two minutes" (stale, see mismatches) | timeout | keep hard; fix the comment |
| host/daemon.ts:2619 | `sniffSocket(client, 600_000)` | on a raw port, how long the client's first bytes are awaited to check they are not HTTP/TLS | waits; after 10 min, proceeds as raw | no | "what the client says first is read before any of it goes on" | security bound | keep |
| host/daemon.ts:2672 | `sniffSocket(client, 400)` | on the pages port (editors, dashboard, git terminal, approval page): how long a client may stay silent | closed silently (`{ to: "close" }`) if it sends nothing within 400 ms | possibly: a browser's preconnected socket that sends after 400 ms is dropped; the browser usually retries, can show as a failed load | none | timeout | eliminate the short window: no raw protocol is served on this port, so a long wait (as at 2572) is safe |
| host/daemon.ts:2675 | `client.setTimeout(30 * 60_000, …)` | idle git-terminal connections | kills the socket | no (the terminal's event stream beats every 15 s, host/git-web.ts:305) | none | timeout | keep |
| host/daemon.ts:2683 | `client.setTimeout(120_000, …)` | idle approval-page connections | kills the socket | no | "node's own slow-client timeouts are not set up, so this is" | resource protection | keep |
| host/daemon.ts:2753 | `< 10_000` | how often a port held by a Mac program is retried for forwarding | waits; retried after 10 s | no | "Tried again now and then, in case the program has gone" | polling interval | keep |
| host/daemon.ts:2869 | `2000` | retry of a workspace link's listen after EADDRINUSE | retries every 2 s while the link lives | no (logged) | "a port the daemon cannot bind is retried" (docs/incidents.md:215) | retry policy | keep |
| host/daemon.ts:2791 | `timeoutMs: 15_000` | per-VM ports/state query (wsctl ports) each round | kills; logged; asked again next round | no; forwards may lag | none | timeout | keep (maybe longer under qemu) |
| host/daemon.ts:3535 | `Math.max(1000, 3 * (Date.now() - started))` | pause between rounds of asking every VM for its ports | waits | no | "never shorter than a second, and never so short that asking is all the VMs do" | polling interval | keep (adaptive, principled) |
| host/daemon.ts:2986, 3012 | `READY = { count: 5, lifeMs: 40_000, afterUseMs: 180_000 }`; `setInterval(stock, 5000)` | pre-opened connections to the root's state service, only for 3 min after the dashboard was used | each replaced after 40 s; none kept after 3 min idle | no (dashboard speed) | "the dashboard's budget for showing state is 300 ms … An idle one is replaced before the service would close it" (relies on node's default server timeout in the root, written nowhere in desolate) | cache lifetime | keep; name the root-side timeout it depends on |
| host/daemon.ts:3017 | `timeoutMs = 15_000` (rootHttp default) | one request to the root's state service (facts, progress, nudge, signin digest) | "the root's state service did not answer" | rarely (signin: "the dashboard did not take its sign-in code (…)") | none | timeout | keep |
| host/daemon.ts:3296, 3325 | `70_000` | long polls of /host/requests and /host/state | error, then retry after 3 s | no | must exceed the root's hold of 50_000 (root/stated.ts:1244, 1260): coupling, written in two files | timeout | keep; derive from one constant |
| host/daemon.ts:3053 | `16 * 1024 * 1024` | size of one answer from the root's state service (includes the whole state for `/host/state`) | "the root's state service said too much"; the loops retry every 3 s forever, so `desolate events` and dashboard actions stop with only a log line | no (only daemon.log) | "What the root's user's service says is bounded: it parses what domains send." (decisions.md:680) | security bound | keep hard, but surface it (doctor / dashboard) since state grows with domains, offers and issues |
| host/daemon.ts:3071-3077 | `Math.max(60, 500 - (Date.now() - nudgedAt))` | nudges to the root when a share changed | coalesced; at most two a second | no | "At most two a second: a workspace touching its refs in a loop costs the state service two looks a second" | polling interval (rate limit) | keep |
| host/daemon.ts:3138 | `45_000` | facts re-sent to the root even when unchanged | waits | no | "now and then regardless, so the service knows the host is there"; root counts the host gone after 150_000 (root/stated.ts:585) | polling interval | keep; derive both from one constant |
| host/daemon.ts:3148, 3173 | `30_000` | how often each running workspace is looked at for unsaved work (the dashboard's Delete) | the "would lose" list can be up to ~30 s old | indirectly (Delete's warning) | "looked at in its own VM every 30 s, for the dashboard's Delete" | polling interval | keep (Delete with `--if-clean` looks again) |
| host/daemon.ts:3276-3279 | `150` ms | batching of a dashboard action's progress lines | waits | no | none | other | keep |
| host/daemon.ts:3312, 3338 (`sleep(3000)`); 3336 (`sleep(250)`); 3347 (`sleep(2000)`) | 3 s / 250 ms / 2 s | retry after a failed long poll; at most four state looks a second; pusher-log poll | waits / retries | no | 3336: "At most four looks a second, whatever the root's user's service answers" | retry policy / polling interval | keep |
| host/daemon.ts:3362 (with 2428-2429) | `head -c 1048576` | new bytes of the root's pusher.log read per 2 s poll | partial last line kept for the next poll; but a single line longer than 1 MiB has no newline in the chunk and the offset never advances: pusher events stop for good, silently | no | "up to a MiB of what is new, as base64" | resource protection | eliminate the stall: skip past an over-long line (bug waiting to happen) |
| host/daemon.ts:3367 | `timeoutMs: 20_000` | that pusher-log read | skipped; next poll | no | none | timeout | keep |
| host/daemon.ts:3446 | `connection.writableLength > 1024 * 1024` | backlog of a `desolate events` listener that does not read | sends `{"type":"lagged"}` and disconnects | yes (a "lagged" line) | "A listener that does not read is told it fell behind and let go" | resource protection | keep (says so) |
| host/daemon.ts:2811 | `printable(reply.devcontainer, 400, " ")` | the devcontainer status line a VM reports, shown on the dashboard | cut silently to 400 (already cut to 500 in the VM's line, workspaces.ts:356) | yes | none | UX truncation | keep hard (VM-written) but mark the cut; drop the double cut |
| host/daemon.ts:3542 (60_000 default), 3568, 3575 (3000), 3593 (10_000), 3603 (20_000), 3696 (10_000), 3774 (30_000) | ask timeouts | CLI to daemon socket: register/ports (60 s), ping (3 s), wait for an old daemon to stop (10 s), start (20 s), editor (10 s), signin (30 s) | "the host daemon did not answer"; start: "the host daemon did not start; see <daemon.log>" | yes, CLI | none | timeout | keep |
| host/daemon.ts:3796, 3820 | `sleep(2000)`, `sleep(1000)` | `desolate events` reconnect polling after a daemon went away | waits; events missed meanwhile are not replayed | yes (gap in events) | "A daemon that went away later … is waited for, never started again" | polling interval | keep |
| host/workspaces.ts:184-196 (bounds from shared/size.ts:16 `LIMITS = { cpus: [1, 64], memoryMiB: [1024, 262_144], diskGiB: [30, 2048] }`) | env overrides `DESOLATE_WORKSPACE_CPUS/_MEMORY_MIB/_DISK_GIB` | the stack's default workspace size | refuses: "<NAME> is '<value>'", fix "a whole number from <min> to <max>" | yes | none here | other | keep hard (bounds sane; disk min 30 is the base's, a fact) |
| host/workspaces.ts:312, 344 (300_000); 367, 810 (300_000); 797 (120_000); 388, 765 (60_000) | start.sh, editor.sh, net/up.sh, token reads | starting a workspace's services, editor, link relay | kills; "the workspace's services did not start: … (timed out after 300000 ms)"; editor: "editor NOT AVAILABLE: …" | yes, `desolate up` | none | timeout | keep |
| host/workspaces.ts:326 | `timeoutMs: 900_000` | init.ts: making the workspace's checkouts (its own git step: 600_000, workspace/init.ts:23) | kills; "the workspace could not make its checkouts: …" | yes | none | timeout | ask the person (a large first clone or LFS checkout) |
| host/workspaces.ts:352 | `timeoutMs: 3_700_000` | building/starting the project's devcontainer (guest docker build: 3_600_000, workspace/devcontainer.ts:759) | kills; workspace comes up without it: devcontainer "FAILED: …" | yes | none | timeout | ask the person (a first image build can be long); derive host value from the guest's |
| host/workspaces.ts:356 | `.slice(0, 500)` | the devcontainer's one-line status | cut silently (then 400 again in the daemon) | yes | none | UX truncation | eliminate the double cut |
| host/workspaces.ts:1152 | `timeoutMs: 120_000` | looking at a workspace's uncommitted/untracked/stashed work before remove/stop | "it could not be looked at: …" (counts as something lost, so `--if-clean` refuses) | yes | none | timeout | keep |
| host/workspaces.ts:1165 | `\S{1,300}` | a checkout path in the VM's "would be lost" report | a line whose path is longer than 300 chars (or has a space) does not match and is dropped silently: that loss is not reported | no | "What the VM says is its word about itself" | security bound | keep hard, but count an unmatched line as "unreadable" instead of dropping it |
| host/workspaces.ts:1306 | `lima.length < 2000` | stderr kept from `desolate shell/exec` to recognise "is not running" | cut silently (detection only) | no | none | other | keep |
| host/bootstrap.ts:136 | `timeoutMs: 120_000` | root/start.sh at bootstrap | kills; "the root's services did not start: <last 600 chars>" | yes | none | timeout | keep |
| host/bootstrap.ts:171, 176, 181, 290 (60_000); 258, 303, 328 (30_000); 465, 514 (60_000); 565-567 (`timeout 4` per probe, 30_000) | timeouts | installing keys in the root, the loopback wall, pings, doctor, release checksum, wall probe | kills; e.g. "the host's keys were not installed in the root: …"; doctor checks show "could not be asked" | yes | none | timeout | keep |
| host/bootstrap.ts:319 | `timeoutMs: 3_600_000` | re-provisioning the root VM when its image is older | kills; "provisioning the root VM again failed: <last 5 lines>" | yes | none | timeout | ask the person (apt downloads on a slow link) |
| host/bootstrap.ts:336-341 | `waitFor(…, 30_000, 500)` | wait for the root's keyring after start | refuses: "the root's keyring did not come up", fix "desolate doctor" | yes | none | timeout | keep |
| host/bootstrap.ts:526 | `off.slice(0, 3)` + `", ..."` | files listed when the root's release differs from this checkout | cut and says so (count and "...") | yes, doctor | none | UX truncation | keep |
| host/stack.ts:141-143 | `cpus: 2, memoryMiB: 2048, diskGiB: 30` | the root VM's size (it runs the reviewer, pusher, mirrors, imports for every domain) | resource exhaustion in the root (pack building, big fetches) with no setting | indirectly: slow or failing reviews/pushes of big repos | "(the base's: a clone's disk cannot be smaller; 20 was never applied)" | resource protection | setting (root VM size), default as now |
| host/vm/lima.ts:285-286, 306-308 | `spec.cpus ?? 2`, `spec.memoryMiB ?? 2048`; base yaml `"cpus: 2"`, `"memory: 2GiB"`, `disk: ${BASE_DISK_GIB}GiB` | fallback VM size; base VM size | n/a (defaults) | no | lima.ts:51 "The base VM's disk, which every desolate VM is cloned from: the smallest any of them has." | other | keep; one source with stack.ts / shared/size.ts |
| host/vm/lima.ts:52 | `BASE_DISK_GIB = 30` | the smallest disk any VM can have | a smaller ask is not applied (Lima cannot shrink a clone) | via sizes shown | see above; decisions.md:1010 | protocol fact (Lima) / choice of base | keep (the 30 itself is a choice; growing needs no rebuild) |
| host/spawn.ts:164, 209-210 | `MOST_AT_ONCE = 3` | spawns requested by one domain's workspaces under way at once | refuses: "<d> already has 3 workspaces being started by its workspaces: ask again once one is up" | the agent; the person if told | "at most three at once, whatever the limit (a flood of signed requests started thirty VMs a minute: audit)"; pinned by tests/v3/t1/spawn.test.ts:235; decisions.md:1291 | security bound (rate limit on VM-originated requests) | keep hard (3 is arbitrary; could be a setting beside `spawn --max`) |
| host/spawn.ts:207 | `30 * 60_000` | how long run spawn/close request MACs are remembered (replay protection) | older entries forgotten | no | must exceed `FRESH_MS = 15 * 60_000` + 120 s skew (shared/spawn.ts:30, 467) | security bound | keep; derive from FRESH_MS |
| host/agent.ts:77, 237 | `/^[a-z0-9][a-z0-9-]{0,39}$/` | agent names (40 chars) | refuses: "'<name>' is not an agent name", fix "lower-case letters, digits and dashes" (the length is not said); in `list`, rows with other names dropped silently | yes | none | security bound / format | keep hard; say the 40-char limit in the fix |
| host/agent.ts:134, 195 (60_000); 228, 335, 350 (30_000) | timeouts | agent-holder start / list / stop / log | kills; "the agent did not start: …" | yes | none | timeout | keep |
| host/agent.ts:234 | `.slice(0, 50)` | agents listed per workspace | cut silently | yes, if >50 agents | "only rows of the expected shape, every string made printable, the command cut short" | security bound (VM-written) | keep hard; say "and N more" |
| host/agent.ts:248, 271 | `printable(command, 120)` then `.slice(0, 60)` | an agent's command in `desolate agent list` | cut silently (120 then 60) | yes | "the command cut short" | UX truncation | eliminate (fit to terminal width, mark the cut) |
| host/agent.ts:349 | `tail -c 2097152` | `desolate agent log`: what is shown of an agent's log | cut silently to the last 2 MiB (the first line may start mid-line) | yes (documented: docs/agents.md:15 "its last 2 MiB") | none in code | UX truncation | eliminate (page or stream; `--all`/`--since`) |
| host/agent.ts:378 | `columns \|\| 120`, `rows \|\| 40` | terminal size sent on attach when unknown | default only | no | none | other | keep |
| host/approver.ts:161 | `.slice(0, 300)` in `clean()` | each line of the reviewer's account in the terminal approval prompt (also non-ASCII → "?") | cut silently at 300 chars | yes, at the moment of approving | none (host/push.ts:629-630 notes #169: a 300-char line hid a warning) | UX truncation | eliminate (wrap); the same class as the #169 bug |
| host/approver.ts:209 | `summary.slice(0, 60)` | lines of the reviewer's account shown in the terminal prompt | cut silently; dormant today (host/push.ts:631 makes at most ~46 lines) | would be: at approval | none | UX truncation | eliminate, or say "(and N more)" |
| host/approver.ts:231, 343 | `timeout: 120_000` | the Touch ID prompt (terminal approve, and the approval page's click) | kills the helper; "the Touch ID prompt was not confirmed" | yes | none here; matches the root's two-minute approval life (decisions.md:196, 241) | timeout | keep; derive from the root's approval lifetime |
| host/notify.ts:19-20, 38 | `printable(value, 160)`; domain/workspace `40` | text in macOS notifications | cut silently | yes | none | UX truncation | keep (notifications show little more) |
| host/notify.ts:289 | `60_000` | an orange/red status notification per workspace | later ones within a minute dropped silently (no terminal line either) | yes (missing notifications) | "at most once a minute each: an agent flipping its colour must not teach anyone to ignore desolate's notifications" | other (rate limit) | keep, or setting |
| host/signin.ts:22, 24 | `ttlMs: 60_000`, `most: 32` | a one-time sign-in code's life; codes held at once | expired code refused; the 33rd code evicts the oldest | yes, if the browser opens the link after a minute | "how long a code waits for its browser: the command opens it at once"; "a loop asking for codes holds no more"; docs say "for a minute" (getting-started.md:93) | security bound | keep hard (duplicated in root, see below) |
| host/paths.ts:16-17 | `/^[a-z0-9]{1,12}$/` | `DESOLATE_INSTANCE` length | refuses: "DESOLATE_INSTANCE must be 1-12 of [a-z0-9], not '<v>'" | yes | ties to VM names and the 103-byte socket path (lima.ts:637) | other | keep hard |
| host/vm/lima.ts:544-553 | `waited <= 60_000; waited += 250` (each look `timeoutMs: 30_000`) | wait for every share to be mounted after boot | kills (stops the VM); "<name> came up without its shares after a minute (…); it was stopped. <ha.stderr.log> may say why." (can take ~90 s: the 60 s counts sleeps only) | yes | "is still missing after a minute" (lima.ts:542) | timeout | keep; count real time |
| host/vm/lima.ts:741 (`"10m"` / 900_000), 767 (`"20m"` / 1_500_000), 815/823/835 (`"30m"` / 2_400_000), 760 (1_200_000), 728 (3_600_000) | Lima `--timeout` plus node's kill above it | booting the base VM, a VM; creating; provisioning the base | kills; "limactl start failed (exit 128): …"; "could not start <name> confined: …"; "provisioning the base VM failed: <last 5 lines>" | yes, at bootstrap/up | none | timeout | ask the person for provisioning and first boot (qemu emulation is slow); keep the pair, but derive one from the other |
| host/vm/lima.ts:344, 1041 (30_000); 454, 471, 990, 1035 (60_000); 555, 813, 870 (120_000); 743, 775, 891 (300_000); 801, 851 (600_000) | timeouts | limactl list, ssh, ss, stop, edit, resize, delete, clone | kills; "limactl <args> failed (exit 128): …" | yes | none | timeout | keep |
| host/vm/lima.ts:439 | `ControlPersist=60` | ssh master to root in the root VM kept after last use | closed after 60 s idle; next call opens it again | no | none | cache lifetime | keep |
| host/vm/lima.ts:1051 | `.slice(-60)` | VM logs shown (ha.stderr.log and serial.log) | cut silently to the last 60 lines each | yes, `desolate logs`/doctor | none | UX truncation | setting/flag (`--lines`), and say "last 60 lines" |
| host/vm/types.ts:116 | `target.length > 200` | socket path a VM dial may name | throws "bad socket path" | no | "a socket path made only of plain names" | security bound | keep hard |
| host/held-ports.ts:15 | `DEV_PORTS = [3000, 3001, 4200, 5000, 5173, 5174, 8000, 8080, 8888]` | ports doctor checks for Mac programs holding them | ports not in the list are not checked | yes, doctor | "Ports a dev server commonly uses"; override `DESOLATE_DOCTOR_PORTS` | other (default list) | setting (exists); the daemon already reports real held ports (heldOnMac) |
| host/vm/fake.ts:189 (15_000), 253 (`stop -t 3`), 265 (`memory-swap` 2x memory), 342 (10_000), 350 (`--tail 200`) | test backend (T2, docker) only | docker checks, stop grace, swap, logs | kills / cut silently | no (refused unless `DESOLATE_BACKEND=fake`) | "IT GIVES NO HYPERVISOR ISOLATION. It exists so that everything except the VM boundary can be exercised" | other | keep (test only) |
| host/approve-web.ts:217,285-291 | `SUMMARY.deadlineMs: 90_000` | how long the approval page waits for the reviewer's account of a push | waits, then gives up: "the reviewer did not answer in time" (shown on the page; the push cannot be approved) | yes, on the page | "Asked once per text, in the background, with a deadline: a slow reviewer never holds up the list" | timeout | ask the person: a push waits only 120 s for approval (root/approvals.ts:21), so a 90 s summary leaves 30 s to read and click; a late answer is thrown away (the race already resolved) |
| host/approve-web.ts:217,279 | `SUMMARY.keepMs: 120_000` | how long a finished summary is kept in the daemon's memory before it is asked again | dropped silently; re-asked on the next list | no | none (decisions.md:1473 says the reviewer's own summaries are "kept ten minutes": that is root/reviewer.ts:1237, a different cache) | cache lifetime | eliminate: tie it to the push's life (the nonce) instead of a clock |
| host/approve-web.ts:257,571,632 | `readBody(req, limit = 4096)` | body of /approve, /refuse and the issue publish POSTs | cut and the request is destroyed; the handler then answers "not JSON" (400) | only as a misleading "not JSON" | none | security bound | keep hard (attacker-shaped input), but answer "too large" instead of "not JSON" |
| host/approve-web.ts:425,463 | `70_000` (editor defaults, secrets), `200_000` (/secrets/import/) | POST body size for /editor-defaults and /secrets | request destroyed; handler answers "not JSON" (400) | yes, as "not JSON" | none | security bound | keep hard, but derive from the 64 KiB caps it wraps: a 64 KiB secret value that JSON-escapes (quotes, backslashes, non-ASCII) passes 70 000 and is refused as "not JSON"; counts UTF-16 units, not bytes |
| host/approve-web.ts:477-478 | `value.length > 65_536` | a secret value set on /secrets | refuses: "a value is one line, of at most 64 KiB" | yes | "One line, as the terminal takes it (readSecretLine)" | resource protection | keep hard; pinned by the in-source test at :873. Counts characters, so "64 KiB" is not bytes |
| host/approve-web.ts:683 | `.slice(0, 300)` | the reviewer's error inside "desolate's reviewer could not say what this push would send (...)" | cut silently | yes | none | UX truncation | eliminate: show it whole (it is the reason the push cannot be approved); use printable for safety |
| host/approve-web.ts:656 | "each waits two minutes" | message text restating root/approvals.ts:21 `APPROVAL_TTL_MS = 120_000` | refuses: "that push is no longer waiting (each waits two minutes)" | yes | none | other | eliminate the copy: say the root's value, or no number |
| host/git-web.ts:42,331-334 | `LIMIT.sessions: 6` | git terminal shells open at once | refuses (429): "6 shells are open already: close a tab (its shell ends half a minute later)" | yes | none | resource protection | setting: arbitrary number; each is one bash in the git VM (1.5 GiB) |
| host/git-web.ts:42,358-359 | `LIMIT.input: 64 * 1024` | base64 typed input per POST | refuses: "input is base64, at most 64 KiB at once" | rarely (a large paste) | none | security bound | keep hard (page should chunk a paste) |
| host/git-web.ts:351-353 | `LIMIT.input * 2` | raw POST body to the git terminal | refuses (413): "too much at once" | rarely | none | security bound | keep hard |
| host/git-web.ts:42,196 | `LIMIT.kept: 256 * 1024` | terminal output kept for a reload or a new tab to replay | oldest chunks dropped silently | yes: scrollback after a reload is shorter than what was printed | none | resource protection | setting (or keep): a replay buffer has to stop somewhere; decisions.md:964 gives the agent terminal 2 MiB |
| host/git-web.ts:42,165-171 | `LIMIT.idleMs: 30_000`, reap every `5_000` | a shell with no tab reading it | kills (SIGKILL) the shell and its session | yes ("its shell ends half a minute later"; a reload opens a new shell, losing a running command) | "a shell with no tab reading it ends after this (a reload opens a new one)" | timeout | ask the person / setting: a long `git rebase` or editor in a tab closed by mistake dies in 30 s |
| host/git-web.ts:305 | `15_000` | SSE heartbeat ": still here" | n/a (keeps the stream open) | no | none | polling interval | keep |
| host/git-web.ts:366-372; git/terminal.py:65 | `cols > 1000`, `rows > 500` (written twice) | terminal resize | refuses: "a size is whole columns and rows"; terminal.py ignores silently | no | none | security bound | keep hard (one place) |
| host/git-vm.ts:64-66 | `cpus: 2, memoryMiB: 1536, diskGiB: 30` | the git VM's size | n/a: a big clone, `git gc` or LFS checkout in it runs short | indirectly (slow or OOM git in the terminal) | disk: "the base's: a clone's disk cannot be smaller; 10 was never applied" | resource protection | setting (memory, CPUs); disk is a fact of the base image |
| host/git-vm.ts:105 | `timeoutMs: 30_000` | reading the git VM's image stamp | kills; error from exec | rarely | none | timeout | keep |
| host/git-vm.ts:121-127 | `timeoutMs: 120_000` | git/provision.sh in the git VM | kills; refuses "the git VM could not be set up: <last 300 chars>" | yes | none | timeout | keep, say elapsed time |
| host/git-vm.ts:127,215; host/carry.ts:58,211,227 | `.slice(-300)` | stderr shown when a step fails | cut silently (keeps the tail) | yes | none | UX truncation | eliminate: point to a full log, or show whole through printableLines |
| host/git-vm.ts:136 | `.slice(0, 200)` | your Mac git user.name / user.email copied into the git VM | cut silently | only if 200+ chars | none | security bound | keep hard (attacker cannot reach it; harmless) |
| host/git-vm.ts:149 | `timeoutMs: 60_000` | setting the git identity in the git VM | kills | rarely | none | timeout | keep |
| host/git-vm.ts:211 | `timeoutMs: 1_800_000` (30 min) | cloning a repository into the git VM (incl. `git lfs pull`) | kills; refuses "the git VM could not clone <id>: ..." | yes, for a big repo/LFS | none | timeout | ask the person ("still cloning: keep waiting?") |
| host/git-vm.ts:236,238 | `tail -2` | output of `git fetch` shown when the terminal opens on an offered branch | cut silently (all but the last 2 lines) | yes | none | UX truncation | eliminate (show whole; fetch is quiet anyway) |
| host/git-vm.ts:257 | `timeoutMs: 300_000` | readying the git terminal on an offered branch (two fetches + switch) | kills; the page shows "the git VM could not be readied: ..." | yes | none | timeout | ask the person |
| host/git-vm.ts:259 | `.slice(-20_000)` | what readying said, written into the terminal first | cut silently (keeps the tail) | rarely | none | UX truncation | eliminate (it is in a scrollback that already has a cap) |
| host/git-vm.ts:269-270,345-346 | `LIMIT.request: 64 * 1024` | a request file the git VM leaves in its out-box | **dropped silently**: the file is removed and no answer is written, so `git push` in the git VM waits its full 20 minutes and says "the host did not answer in 20 minutes" | yes, as a 20-minute hang | "checks it is a plain file of a bounded size" | security bound | keep hard but answer the refusal; and see next row: it is reached before LIMIT.objects |
| host/git-vm.ts:273,398 | `LIMIT.objects: 2000` | LFS objects in one push from the git VM | refuses: "the git VM's request is not one desolate makes" | yes, with a message that does not say why | none | resource protection | keep hard with a real message. Unreachable as written: 2000 oids of 64 hex in JSON is ~134 KB, over LIMIT.request (64 KiB), so a push of more than ~970 LFS objects hangs 20 min instead (previous row) |
| host/git-vm.ts:271,409-413 | `LIMIT.bundle: 2 * 1024 ** 3` | a push's bundle from the git VM | refuses: "the push's bundle is not a plain file of at most 2 GiB" | yes, for a huge push | none here; decisions.md:284 "a bundle 2 GiB" | resource protection | setting, or keep hard (the root's outbox and pusher hold the same cap) |
| host/git-vm.ts:272,424-428 | `LIMIT.lfs: 5 * 1024 ** 3` | one LFS object from the git VM | refuses: "the LFS object <oid12> is not a plain file" (wrong reason for too big) | yes | decisions.md:284 "an LFS object 5 GiB" | resource protection | keep hard (GitHub's own LFS max is 5 GB), fix the message |
| host/git-vm.ts:337,376-377 | `FETCH_GAP_MS = 5000` | `desolate fetch` from the git VM, per repository | answers without fetching: "<repo>: refreshed a moment ago" | yes | "At most once every few seconds a repository" | resource protection | keep (small debounce) |
| host/git-vm.ts:380 | `timeoutMs: 10 * 60_000` | the root refreshing a mirror for the git VM | kills; error passed back | yes | none | timeout | ask the person (same 10 min as git/desolate.ts:133) |
| host/git-vm.ts:461 | `timeoutMs: 20 * 60_000` | a push from the git VM, handed to the root (includes waiting for the person to approve) | kills; error passed back | yes | none | timeout | eliminate the duplication with git/git-remote-desolate-out.ts:26 (same 20 min; the client gives up at the same moment the host does) |
| host/git-vm.ts:677 | `3_600_000` (1 h) | answers in the git VM's answer box nobody read | removed silently | no | "Answers nobody read within the hour: gone." | cache lifetime | keep |
| host/git-vm.ts:712 | `setInterval(scan, 5000)` | out-box sweep in case a file event is missed | n/a | no | "for an event missed (or a watch that failed), not the way requests arrive" | polling interval | keep |
| host/push.ts:257-262 | `r.commits.slice(0, 30)`; label `a push would send ${r.commits.length} commit(s)` | commits listed by `desolate review` | cut and says so ("... and N more") | yes | none | UX truncation | eliminate the label bug: `r.commits` comes from root/offers.ts:639 `--max-count=200`, so a branch of 250 commits says "a push would send 200 commit(s)" and "... and 170 more"; use the exact `pushCommits` / a `rev-list --count` |
| host/push.ts:261 | `plain(c.subject).slice(0, 100)` | a commit subject in `desolate review` | cut silently | yes | none | UX truncation | eliminate (one subject per line already) or mark the cut with an ellipsis |
| host/push.ts:263-264 | `r.files.slice(0, 40)` | files listed by `desolate review` | cut and says so ("... and N more files") | yes | none | UX truncation | keep or setting (`--all`); counts are exact here |
| host/push.ts:276-278 | `d.truncated` (cap set in the root) | `desolate review --diff` | cut and says so: "... the diff is longer than is shown here. The whole of it: desolate root shell, then git diff." | yes | none | UX truncation | eliminate: page or stream the diff |
| host/push.ts:516 | `timeoutMs: 300_000` | `desolate push`'s prepare step in the root | kills | yes, for a big push | none | timeout | ask the person |
| host/push.ts:643-644 | `forge.slice(0, 5)` | files that change what runs on the forge, in the terminal's account of a push | cut and says so: "(N files; the first 5)" | yes | "(One a line: a long name cannot push the others, or the count, off the end.)" | UX truncation | ask the person / eliminate: these are the files that most need reading before Approve |
| host/push.ts:647 | `(s.warnings ?? []).slice(0, 20)` | warnings shown before a push is approved in the terminal | **cut silently** (no "and N more") | yes, not knowingly | none | UX truncation | eliminate: a 21st warning is never seen before signing |
| host/push.ts:664-669 | `.slice(0, 12)` lines; note when `split("\n").length > 13` | a squash commit's message in the terminal | cut and says so: "(and more lines)"; off by one when the message has no trailing newline (13th line dropped with no note) | yes | none | UX truncation | eliminate (show whole; it is what is signed) |
| host/domains.ts:68 | `timeoutMs: 120_000` | installing a domain's CA in each running workspace | kills | rarely | none | timeout | keep |
| host/domains.ts:180-184 | `max > 1000` | `desolate domain <d> spawn --max <n>` | refuses: "--max '<n>' is not a number of workspaces" | only for absurd input | none | other | keep hard (sanity bound on input; number arbitrary) |
| host/domains.ts:275-286 | `r.reached.slice(0, 60)`, `r.refused.slice(0, 60)` | hosts listed by `desolate domain <d> net` (learn mode report), and the `net allow ...` command it prints | **cut silently**; the printed `net allow` command omits hosts 61+, so following it then `net enforce` breaks them | yes | none | UX truncation | eliminate: print all (or say "and N more" and give `--json`) |
| host/domains.ts:356-365; host/env-import.ts:21,153-154 | `ENV_MAX = 64 * 1024` | a .env imported into a domain's secrets | refuses: "<name> is over 64 KiB: not a .env"; "a .env of at most 64 KiB, not N bytes" (N is characters, not bytes) | yes | none | resource protection | keep hard (a .env is small); fix "bytes" |
| host/editor-defaults.ts:22,31-32 | `MAX = 64 * 1024` | every editor's default settings, as JSON | refuses: "editor defaults of at most 64 KiB" | rarely | "an object of at most 64 KiB" | resource protection | keep hard |
| host/editor-defaults.ts:24 | `{1,64}` (language block), `{0,127}` (setting name) | a setting's name | refuses: "'<key>' is not a setting's name" | rarely | none | security bound | keep hard |
| host/editor-defaults.ts:36; host/env-import.ts:53,63,113 | `.slice(0, 80)` | the bad input echoed in a refusal | cut silently | yes | none | UX truncation | keep (echo of bad input; use printable) |
| host/editor-defaults.ts:129 | `timeoutMs: 120_000` | applying defaults to one workspace's editor | kills; "not applied: ..." | yes | "Never fails its caller" | timeout | keep |
| host/editor-defaults.ts:134,136; host/templates.ts:266 | `.slice(-200)`, `.slice(0, 200)` | error text after "not applied:" / "could not be emptied" | cut silently | yes | none | UX truncation | eliminate (show whole, printable) |
| host/env-import.ts:42 | `HEADER = /^[a-z0-9][a-z0-9-]{0,63}$/` | a header name a secret is put in | refuses: "'<h>' is not a list of header names" | rarely | none | security bound | keep hard |
| host/upstream.ts:41 | `SUEDE_UPSTREAM_WAIT` default `180` s | `desolate upstream` waiting for suede's Action to open the pull request | waits, then "no pull request after 180 s. Follow the Action at https://github.com/<slug>/actions (branch: <b>)." exit 2 | yes | none here; docs/suede.md:74 "up to three minutes" | timeout | keep (already a setting via env; `--no-wait` too); could ask "keep waiting?" |
| host/upstream.ts:42 | `SUEDE_UPSTREAM_INTERVAL` default `5` s | polling GitHub's API | n/a | no | none | polling interval | keep (setting already); 2 API calls per 5 s for 3 min = 72 unauthenticated calls of GitHub's 60/h |
| host/upstream.ts:52 | `timeout: 10_000` | `gh auth token` | kills; no token used (private PR then invisible) | no | none | timeout | keep |
| host/upstream.ts:62 | `AbortSignal.timeout(20_000)` | one GitHub API call | treated as no answer, poll continues | no | none | timeout | keep |
| host/upstream.ts:338 | `timeoutMs: 600_000` | resolving the consumer commit in the git VM (fetch + rev-parse) | kills; "has no <from> in your git VM clone" (misleading) | rarely | none | timeout | keep, fix message |
| host/upstream.ts:297; git/upstream.ts:88 | `[A-Za-z0-9._/-]{0,199}` (written twice) | a ref the person names | refuses: "'<from>' is not a branch or a commit" | rarely | "A ref the person names ... Never an option." | security bound | keep hard (one place) |
| host/issues.ts:46,62 | `10 * 60_000` | how old the issue-publish lock must be to count as left by a crash | refuses: "not published: another issue is being published right now, from another page or terminal: try again in a moment" | yes, for 10 min after a crash | "a lock a crash left is taken back after ten minutes" | other | eliminate: hold a pid in the lock, or an fcntl lock that dies with the process |
| host/issues.ts:113 | `timeout: 120_000` | `gh issue create` | kills; "gh did not finish (...): GitHub may have made it; look on GitHub (<repo>) before anything else" | yes | "Killed (its two minutes ran out): GitHub may have made it" | timeout | keep |
| host/issues.ts:85,147,314 | `timeoutMs: 30_000` | rootctl calls around publishing | kills; error shown | rarely | none | timeout | keep |
| host/issues.ts:90,132,150 | `printable(..., 120/400/200)` | errors from the record, gh, the root | cut silently | yes | none | UX truncation | eliminate (gh's own error, whole) |
| host/issues.ts:332,453-454 | `printable(i.title, 100)`, labels `50`, draft title `256` | issue titles and labels in `desolate issues` / the publish prompt | cut silently (100 in the list; 256 is the title's own cap) | yes | none | UX truncation | keep in the list (one line); the prompt before publishing shows the whole title (256 = the cap) |
| host/events.ts:159,166,174 | `hub(keep = 500)` | events the daemon keeps for `desolate events --replay <n>` | oldest dropped silently; `--replay 1000` gives 500 with no note | yes, for scripts | none (decisions.md:682: `--replay 0` was once unbounded) | resource protection | setting, or say how many were kept; pinned by the in-source test at events.ts:187-196 |
| host/events.ts:52,54 | `printable(raw.error)` (300), `printable(raw.at, 40)` | an event's error and time | cut silently | for scripts | none | UX truncation | keep for `at`; eliminate for `error` |
| host/carry.ts:55,223 | `timeoutMs: 600_000` | taking the root's state out (tar + base64) and putting it back | kills; "the root's keys and secrets could not be read out of it" / "could not be put into the new root (it is still at <KEPT>)" | yes | none | timeout | ask the person; also bounded by shared/run.ts:23 `RUN_MAX = 192 MiB` per stream, since the whole archive comes back as base64 on stdout: a root state over ~140 MiB compressed would be stopped and the rebuild refused |
| host/carry.ts:207 | `timeoutMs: 60_000` | making a domain's proxies' user | kills | rarely | none | timeout | keep |
| host/templates.ts:263 | `timeoutMs: 120_000` | scrubbing a template VM | kills; "no template: ..." (workspace made from the base instead) | yes | none | timeout | keep |
| host/templates.ts:140,271 | `printable(...)` default 300 | why there is no template | cut silently | yes | none | UX truncation | eliminate |
| host/push.ts:598; host/push.ts:458,464 | `printable(...)` default 300 | the reviewer's error; repo/commit names in refusals | cut silently | yes | none | UX truncation | eliminate for the reviewer's error (same as approve-web.ts:683) |

## Git VM programs (`git/`) (17 rows)

Covers `git/upstream.ts`, `git-remote-desolate-out.ts`, `lfs-file.ts`, `desolate.ts` and `terminal.py`: the git VM's programs, run for the host.

| file:line | value | what it limits | when hit | person sees it? | stated reason | kind | disposition |
|---|---|---|---|---|---|---|---|
| git/upstream.ts:782,858-859 | `"--max-count=50"` | commits of the split listed by `desolate upstream` | **cut silently, and mislabelled**: prints "${checked.commits.length} commit(s) the remote does not have:", i.e. "50 commit(s)" for a split of 80 | yes | none | UX truncation | eliminate: same bug class as the "newest 50" one; count with `rev-list --count`, list all or say "and N more" |
| git/upstream.ts:73 | `maxBuffer: 256 * 1024 * 1024` | output of every git command in `desolate upstream` (ls-tree, diff --stat, mktree input) | git is killed (ENOBUFS); "git <cmd> failed: ..." | rarely | none | resource protection | keep (or stream) |
| git/upstream.ts:714 | `timeout: 10 * 60_000` | suede's own upstream script (the split) | kills; "suede's upstream stopped (spawnSync bash ETIMEDOUT): ..." | yes, on a big history | none | timeout | ask the person |
| git/upstream.ts:715 | `maxBuffer: 64 * 1024 * 1024` | what suede's upstream script prints | kills; "suede's upstream stopped (... ENOBUFS)" | rarely | none | resource protection | eliminate (stream it to the terminal) |
| git/upstream.ts:723-724 | `.slice(-12)`, `printable(line, 300)` | the script's output when it fails | cut silently (last 12 lines) | yes | none | UX truncation | eliminate (show whole, or save a log) |
| git/upstream.ts:768-772 | `ci.slice(0, 3)` | .github/ files named in the refusal | cut and says so ("and N more") | yes | none | UX truncation | keep |
| git/upstream.ts:865-867 | `checked.core.slice(0, 5)` | suede-core files named in the red warning | cut and says so ("and N more") | yes | none | UX truncation | keep |
| git/upstream.ts:859-860 | `printable(line, 200)` | each commit line and each `diff --stat` line | cut silently | yes (long paths in --stat) | none | UX truncation | eliminate |
| git/upstream.ts:82,111,127,144,159,192,737,817,831,835 | `printable(..., 300/100/200/40)` | git errors and echoed bad input | cut silently | yes | none | UX truncation | keep for echoed input; eliminate for git's own error (:82 keeps only the last stderr line, too) |
| git/git-remote-desolate-out.ts:26,392-404 | `WAIT_MS = 20 * 60_000`, poll `500` ms | `git push` in the git VM waiting for the host's answer (includes the person's approval) | waits, then "the host did not answer in 20 minutes; nothing is known to be pushed (git fetch origin shows)" | yes | none | timeout | ask the person; duplicate of host/git-vm.ts:461 |
| git/git-remote-desolate-out.ts:84 | `maxBuffer: 256 * 1024 * 1024` | git output in the push helper (rev-list --objects of a whole history) | git killed; push fails | rarely (huge histories) | none | resource protection | eliminate (stream rev-list) |
| git/git-remote-desolate-out.ts:148 | `Number(size) >= 400` | blobs considered as LFS pointers | larger blobs skipped silently (not LFS) | no | none | protocol fact (approx.) | keep (git-lfs pointers are ~130 bytes; git-lfs itself reads up to 1024) |
| git/git-remote-desolate-out.ts:46 | `[a-z0-9-]{0,39}` | domain slug in the remote's address | refuses | no | none | security bound | keep; a copy of the slug rule (host/repos.ts:114 "at most 40") |
| git/git-remote-desolate-out.ts (whole) | no client-side check of host/git-vm.ts LIMIT.objects/LIMIT.bundle | a push the host will refuse is bundled and written anyway | see host/git-vm.ts rows | yes | none | other | eliminate: one shared constant, checked before bundling |
| git/desolate.ts:133,98-107 | `10 * 60_000`, poll `250` ms | `desolate fetch` in the git VM | waits, then "the host did not answer in 10 minutes" | yes | none | timeout | keep; duplicate of host/git-vm.ts:380 |
| git/terminal.py:61 | `len(typed) < 4 * 1024 * 1024` | typed input queued for the shell when it is not reading | **dropped silently** | rarely (huge paste into a busy shell) | none | resource protection | keep hard (say so in the terminal) |
| git/terminal.py:23 | `resize(120, 32)` | the shell's size before the page sends its own | n/a | no | none | other | keep |

## Root (`root/` and `root/proxy/`, without the reviewer, pusher and keyring) (89 rows)

Covers the state server, ops, offers, outbox, domains, rootd, repos, issues, the git helpers, the push path, the proxies and `secrets_addon.py`.

| file:line | value | what it limits | when hit | person sees it? | stated reason | kind | disposition |
|---|---|---|---|---|---|---|---|
| root/offers.ts:639 | `--max-count=200` | commits listed in a review (newest first) | cut silently; dashboard then says "All 200 commits, combined", "Push still sends all 200" and the pill "200 commits … what a push would send" (dashboard.js:530-531, 575); commits past 200 cannot be picked | yes, as a wrong count | none | UX truncation | eliminate: count with `rev-list --count` (pushCommits already does), page the list. Same class as the reviewer's "newest 50" bug |
| root/offers.ts:524, :539 | `CHANGES_MAX = 1000` | files in a review's "Files changed" list | cut silently; dashboard shows "Files changed (1000)" | yes, as a wrong count | none | UX truncation | eliminate (page or lazy list), or at least say "1000 of N" |
| root/offers.ts:770, :954-957 | `DIFF_LIMIT = 1024 * 1024` | bytes of a review's diff | cut and says so: "The diff is longer than is shown here. Read the rest with git, in `desolate root shell`, before you push." Cut falls mid-line and can split a UTF-8 character | yes | "Capped: a diff too long to read is cut, and says so." decisions.md:261 "capped at 1 MiB" | resource protection | eliminate: per-file diffs fetched on demand; keep a cap per file |
| root/offers.ts:949-952 | `60_000` ms | time git may take to make a review's diff | kills git, and sets `truncated`, so the page says the diff is "longer than is shown" when it was slow, not long | yes, with the wrong reason | none | timeout | ask the person ("still making the diff: keep waiting?"), at least a message of its own |
| root/offers.ts:245 | `request.lfs.slice(0, 2000)` | LFS objects taken from one offer | cut silently; an offer with more than 2000 new LFS objects then refuses "the offered commits reference N LFS object(s) the root does not have (…)" with fix "offer again from the workspace that made them", and offering again takes the same first 2000, so it can never pass | agent sees the refusal | none | resource protection | eliminate (take all, streamed, or in rounds); bug waiting |
| root/offers.ts:482 | `Number(size) >= 400` | blob size read as a possible LFS pointer | larger blobs are not read as pointers, so an LFS object they name is not checked as missing (silently) | no | none | protocol fact (approx.) | keep (fact), but use git-lfs's own cutoff (1024 bytes) |
| root/offers.ts:215-216 | 5 attempts, 700 ms apart | waiting for a workspace's just-written branch to show through the vz share | retries, then refuses "the root received <x> for <branch>, not <commit>", fix "run `desolate sync`, then offer again" | agent sees | "can look as it was to the root for about a second (measured)" | retry policy | keep hard (or eliminate with a handshake on the share) |
| root/offers.ts:117-120 | `tries < 5`, `300 + 300 * tries` ms | retries of `git fetch <domain>` on a ref lock | retries, then throws "could not bring <domain>'s branches … into the root clone: <stderr tail>" | rarely | "two at once in one clone can meet on a ref's lock" | retry policy | keep |
| root/repos.ts:286, :310 | `timeoutMs: 600_000` | `git fetch` of a mirror from the forge, and `git lfs fetch` of every head | kills git; refuses "cannot fetch <repo>: … (timed out after 600000 ms)" / "fetched <repo>, but its LFS objects did not come: …" | yes: first fetch of a big repo on a slow link | none | timeout | ask the person (show progress, offer to keep waiting) rather than kill |
| root/offers.ts:113, :122; root/repos.ts:337, :409; root/git-remote-desolate.ts:86; root/git-remote-desolate-push.ts:50 | `timeoutMs: 600_000` | every other git run by the root: importing a domain's branches, following the mirror, checking out, the two remote helpers | kills git; the caller reports the failure (stderr ends "(timed out after 600000 ms)") | sometimes (offer or push fails) | none | timeout | setting or eliminate; one shared constant at least |
| root/repos.ts:298-302 | `timeoutMs: 60_000` | `git ls-remote --symref origin HEAD` | on a timeout the default branch silently becomes null: the registry records none and reviews say "nothing (no default branch)" | yes, as a wrong state | none | timeout | eliminate the silent fallback: fail the fetch, or keep the old default branch |
| root/repos.ts:428 | `FETCH_LOCK_STALE_MS = 10 * 60_000` | when a fetch lock is taken to be left by a dead fetch | breaks the lock; but one fetch can run 600 + 60 + 600 + 600 s of git, so a live fetch's lock can be broken and the race it prevents comes back | no | "a lock directory, which a fetch that died leaves for at most ten minutes" | other (lock) | eliminate: a lock tied to the process (pid or flock), not to age |
| root/push.ts:478 | `300_000` ms | when a push lock is taken to be stale | under 5 min: refuses "another push to <repo> is in progress", "try again in a moment"; over: breaks the lock even if that push still runs (a large pack can take longer) | yes | none | other (lock) | eliminate: a lock tied to the process |
| root/raw-push.ts:26, :100 | `WAIT_MS = Number(process.env.DESOLATE_APPROVAL_WAIT_MS) \|\| 110_000` | how long a push waits for the person's approval on the host | waits, saying "waiting up to 110 s ..."; then refuses "no person approved the push on the host, so nothing was pushed" | yes | none here; docs say "it waits two minutes" | timeout | keep hard (bounded by the keyring's two-minute challenge), but derive both from one constant; the env override is undocumented |
| root/raw-push.ts:101 | `500` ms | polling for the approval | polls | no | none | polling interval | keep (or fs.watch) |
| root/approvals.ts:21, :58 | `APPROVAL_TTL_MS = 120_000`, skew `-5_000` | how long a waiting approval request is listed for the host's approval page | dropped silently (pruned) from the list | indirectly: it vanishes from the page | decisions.md:196 "within two minutes" | security bound | keep hard; one constant with raw-push.ts:26 and the keyring's lifetime |
| root/approvals.ts:22, :50 | `FILE_MOST = 16 * 1024` | size of a waiting approval file | ignored silently | no | none | resource protection | keep hard |
| root/approvals.ts:69 | `.slice(0, 200)` | an approval's summary on the host's page | cut silently | yes | none | UX truncation | eliminate (wrap or ellipsis in the page) |
| root/rootd.ts:39-45, :693-697 | `RATE = { perMinute: 30 }` | requests per minute from one domain (all its workspaces together): fetch, offer, issue, spawn, close | refuses "this domain has made 30 requests in a minute; wait and ask again"; a workspace `git fetch` then reads the stale mirror "and says so" (reference.md:319) | agent sees; person indirectly | decisions.md:714 "(30 requests a minute)" | security bound | keep hard against floods, but count per op (coalesce fetches) or make it a setting: several agents fetching in loops hit it |
| root/rootd.ts:829-831 | `drain(..., 50)` | requests taken from one domain per pass of the loop | the rest wait for the next pass | no | none | resource protection | keep |
| root/rootd.ts:842 | `600_000` ms | how long a reply waits in a domain's inbox | removed; a workspace reading later finds none | no | "Replies are read within moments; old ones are swept." | cache lifetime | keep |
| root/rootd.ts:848 | `sleep(250)` | rootd's loop | polls | no | none | polling interval | keep (or fs.watch) |
| root/rootd.ts:771 | `IMPORT_GAP_MS = 3000` | imports of a domain's branches per repository | waits | no | "At most one every few seconds per repository, whatever the domain writes." | resource protection | keep |
| root/rootd.ts:797 | `Number(process.env.DESOLATE_LANDED_CHECK_MS) \|\| 15 * 60_000` | how often repositories with an unmerged push are fetched to see the merge | polls | yes: "merged into <base>" shows up to 15 min late | reference.md:88 "every 15 minutes, for 30 days" | polling interval | setting (already an env var; undocumented) |
| root/pushed.ts:529 | `30 * 24 * 3600_000` | how long a push is watched for its merge | no longer fetched for it; the branch never shows "merged" | yes, rarely | reference.md:88 | other | keep |
| root/pushed.ts:36, :87 | `KEEP = 500` | pushes remembered in pushed.json | oldest dropped silently; their "merged into" goes | rarely | none | cache lifetime | keep |
| root/pushed.ts:42, :50-53 | `10_000` ms wait, `60_000` ms stale | the pushed.json lock | throws "pushed.json stayed locked for 10 s"; a lock older than 60 s is broken | rarely | "a process that died leaves for at most a minute" | retry policy | keep |
| root/rootd.ts:103; root/stated.ts:795 | `30 * 60_000` | how long a queued spawn counts against the domain's limit and holds its name | stops counting, file swept | agent: "already has a workspace '<name>'" or the limit message | stated.ts:745 "A spawn that failed held its name for half an hour" | cache lifetime | keep, but match it to the request's freshness (reference.md:502 says "good for 15 minutes") |
| root/domains.ts:260 | `max > 1000` | `desolate domain <d> spawn --max N` | refuses "'N' is not a number of workspaces", fix "desolate domain <d> spawn --max 2" | yes | none | other (input sanity) | keep hard; say the range in the message |
| root/issues.ts:67 (shared/issues.ts:15) | `LIMIT.waiting = 50` | issues a domain may have waiting for the person | refuses "<domain> already has N issues waiting for the person", fix "wait for them to be published or rejected" | agent sees | none | resource protection | keep hard (or setting) |
| root/intake.ts:74, :49-57 | `CHECK_MS = 8 * 60_000` | `git index-pack --strict` on a bundle before the root takes it | kills; refuses "checking its objects took longer than 8 minutes" (dashboard, `desolate offers`, the workspace) | yes | "A pack made to be slow is refused, not waited on." decisions.md:299 | security bound | keep hard (attacker input), but the number is arbitrary: scale with the bundle's size |
| root/intake.ts:23, :26-29 | `Buffer.alloc(4 * 1024 * 1024)` | a bundle's header (its list of refs) | a header longer than 4 MiB refuses with the wrong reason: "it is not a bundle a workspace's git writes (v2)" | yes, misleading | none | security bound | keep hard, fix the message |
| root/git-remote-desolate.ts:111 | `round < 1000` | bundles imported in one run of the helper | stops silently; the rest wait for the next fetch | no | none | resource protection | keep hard (guards against a domain writing for ever) |
| root/outbox.ts:28, :97, :156 | `LIMIT = { json: 1024 * 1024, bundle: 2 * 1024 ** 3, lfs: 5 * 1024 ** 3 }` | files read from a domain's outbox: JSON, bundles, LFS objects | JSON: read as nothing (silently); bundle: dropped, then "N file(s) in <slug>'s outbox were not plain bundle files and were dropped"; LFS: "the LFS object <id> is not in the outbox" (wrong reason) | partly | decisions.md:284 "(JSON 1 MiB, a bundle 2 GiB, an LFS object 5 GiB)" | security bound | keep hard (domain-controlled), but name the limit in each message |
| root/outbox.ts:217-223 | 1 MiB (LIMIT.json) and `.slice(0, 5000)` | a domain's refs.json, read by the root's remote helper (`list`) | over 1 MiB: no branches at all; past 5000: the rest left out; both silently, and fetchDomain's `--prune` then deletes those branches from the root clone | yes, as missing branches | none | security bound | eliminate the silent part: refuse and say so; one limit with branchesOf below |
| root/outbox.ts:458, :463, :473 | `BRANCHES_PER_REPO = 200`, `256 * 1024` | branches per repository on the dashboard and `desolate branches` (same refs.json) | first 200 shown, the rest silently not; over 256 KiB the repository shows no branches | yes | none | UX truncation | eliminate (page); different numbers from listedRefs for the same file |
| root/outbox.ts:320 | `.slice(-20)` | refusals remembered per domain | oldest dropped silently (one per repository is kept anyway) | rarely | none | cache lifetime | keep |
| root/outbox.ts:245 | `6 * 3_600_000` | root's own copies of bundles left by a dead process | removed | no | "removed here, long after anything could be using it" | cache lifetime | keep |
| root/ops.ts:61, :442 | `LFS_MOST = 5 * 1024 ** 3` | an LFS object a git-VM push carries | refuses "the LFS object <id>: not a plain file of a size desolate takes" | yes | "The largest LFS object a push may carry: what the host takes from the git VM." | resource protection | keep hard (GitHub's largest per-file LFS cap is 5 GB); one shared constant, and a message naming the size |
| root/ops.ts:322 | `records.slice(0, 200)` | vendored suede dependencies looked at by `desolate suede changed` | silently ignored past 200 | no | none | resource protection | eliminate, or say so |
| root/ops.ts:327 | `printable(dir, 400) !== dir` | a dependency's path length | a path over 400 characters is silently left out (treated as unsafe) | no | "one a terminal would act on, or that hides what it is, is not a dependency anyone vendored on purpose" | security bound | keep, but say what was left out |
| root/ops.ts:328-331 | `.slice(0, 4096)` | bytes of a .gitrepo read | cut silently | no | "a .gitrepo is a few lines of text" | resource protection | keep hard |
| root/ops.ts:344 | `.slice(0, 2000)` | files per dependency a push changed | cut silently; recipes/suede.sh then prints "($files file(s))" with the cut count | yes, as a wrong count | none | UX truncation | eliminate (count all, list some) |
| root/ops.ts:234 | `Number(args.last) \|\| 100` (also proxy/manage.ts:301) | entries `desolate net log` shows; host/cli.ts:390 never sends `last` | last 100 only, silently | yes | none | UX truncation | setting (a `--last` flag) or page |
| root/ops.ts:389-390 | 20 tries × 250 ms | waiting for the host's bundle to show on the share | then lstat fails: "ENOENT …" | rarely | "a share can be a moment behind on vz" | retry policy | keep |
| root/ops.ts:65, :521 | `3000` ms | keyring ping (ping, doctor) | doctor shows the error | yes (doctor) | none | timeout | keep |
| root/ops.ts:741, :767 | `5_000` ms | pusher and reviewer pings in doctor | doctor shows the error | yes (doctor) | none | timeout | keep |
| root/ops.ts:563, :620, :634, :644, :649 | `timeout: 10_000` | sudo checks in doctor | a timed-out `sudo -n true` has status null, which reads as "sudo refuses it" (a pass); timed-out `test -x/-r` read as "cannot reach" (a pass) | yes (doctor) | "Asked, not assumed (P6)" | timeout | keep, but treat a timeout as a failure |
| root/rootctl.ts:160 | `1 << 20` | one request line to the root's control socket | connection destroyed, no answer | no (host's tool) | decisions.md:520 "at most 1 MiB, node's parser" | security bound | keep hard |
| root/stated.ts:1505 | `value.length <= 200` | each argument of a dashboard action | argument dropped silently; the command then runs without it or fails oddly | yes, confusingly | none | security bound | keep a bound, but refuse with a message instead of dropping |
| root/stated.ts:1099-1105 | `limit = 262_144` (characters) | a request body to the dashboard service | rejects "too large" | rarely | none | security bound | keep hard |
| root/stated.ts:1155, :1187 | `SIGNIN = { ttlMs: 60_000, most: 32 }` | life of a dashboard sign-in code; codes held at once | expired / oldest dropped; sign-in fails | yes (sign-in fails after a minute) | "until it is spent or a minute is up" | security bound | keep hard |
| root/stated.ts:1244, :1260 | `50_000` ms | long polls the host daemon holds (`/host/state`, `/host/requests`) | answers with no change | no | none | polling interval | keep; pairs with host/daemon.ts:3296, :3325 (`70_000` client timeout) |
| root/stated.ts:585 | `150_000` ms | host daemon silence before the dashboard says the host is gone | page says what it shows of VMs is stale | yes | "If it has gone quiet, what is shown about VMs is stale, and the page says so." | timeout | keep; pairs with the daemon's push interval (host/daemon.ts:3138, :3173) |
| root/stated.ts:506 | `120_000` ms | cache of each workspace's unpushed-commit counts | recounted | yes, up to 2 min stale | none | cache lifetime | keep |
| root/stated.ts:654, :729-735 | `EVENTS_MAX = 512 * 1024` | a domain's events.jsonl | cut to its last half; a slow `desolate events --follow` reader can miss events silently | agent rarely | "Kept to its last half when it grows past half a MiB: a reader follows by `seq`." | resource protection | keep |
| root/stated.ts:972-975, :1205-1206 | 300 characters a line, last `60` lines | an action's output on the dashboard (a push, a dashboard click run on the host) | oldest lines dropped silently: the start of a long error is lost | yes | none | UX truncation | eliminate (keep the whole log, show the tail with a link) |
| root/stated.ts:874 | `600` | the command shown for an action | cut and says so ("…") | yes | "the dashboard teaches the CLI" | UX truncation | keep |
| root/stated.ts:862-866 | `50`, `1000` | actions remembered | over 50 the oldest finished goes; over 1000 the oldest goes even if waiting | rarely | "never one still waiting for the host (a flood … pushed others' … out before they ran: audit)" | resource protection | keep |
| root/stated.ts:607 | `actions.slice(-12)` | actions sent to the dashboard | older ones not shown | yes | none | UX truncation | keep (or page) |
| root/stated.ts:601 | `.slice(-10)` | finished issues on the dashboard | older ones not shown | yes | "the last few done with" | UX truncation | keep |
| root/stated.ts:280 | `printable(...)` (300), then `.slice(0, 200)` | a workspace's "making" progress line on the dashboard | cut silently | yes | none | UX truncation | eliminate (CSS ellipsis) |
| root/stated.ts:687 | `printable(message, 200)` | a workspace's status message on the dashboard | cut silently | yes | AGENTS.md: "One line, at most 200 characters" | UX truncation | keep (matches the documented limit) |
| root/stated.ts:760-764 | last `4` lines, 300 each | what a spawn/close event says to the workspace that asked | cut silently | agent | none | UX truncation | keep |
| root/stated.ts:644, :1399, :1554-1556 | `40` ms debounce; `15_000` SSE heartbeat; `1000` publish; `500` queue; `10_000` pushed check | the dashboard service's timers | none | no | none | polling interval | keep |
| root/domains.ts:1216, :1239 | `SPEC_MAX = 256 * 1024` | size of a devcontainer.json read to size a workspace | says so: "<file> is over 256 KiB: not read" (a sizing problem) | yes | none | resource protection | keep hard |
| root/domains.ts:120 | `.slice(0, 200)` | a domain's title | cut silently | yes | none | UX truncation | keep hard, but refuse with a message |
| root/domains.ts:432 | `.slice(0, 200)` | git name and email as the host read them | cut silently | rarely | "printable, short, or none" | security bound | keep hard |
| root/domains.ts:58, :72; root/rootctl.ts:72 | "at most 40" (text) | slug length, as the refusal says it | refuses "a … name is a slug: lowercase letters, digits and single dashes, at most 40, starting with a letter or digit" | yes | none | other | keep; write the message from shared/names.ts SLUG, not a literal |
| root/git.ts:119 | `ConnectTimeout=20` | ssh to the forge (fetch, push) | ssh fails; git's error is shown | yes, on a slow network | none | timeout | keep hard |
| root/git.ts:326; root/offers.ts:127; root/repos.ts:290, :313, :345, :412; root/rootd.ts:704, :789, :812; root/intake.ts:44 | tails `-1500`, `-400`, last 3 lines, last 2 lines, `0, 200`, `-500`, `0, 500`, `0, 300`, `-2000` | git's stderr and other errors in messages and logs | cut silently (beginning or end) | yes, in errors | none | UX truncation | eliminate (one helper: whole text in a log, a stated tail with "…") |
| root/git-remote-desolate.ts:103; root/outbox.ts:316; root/intake.ts:69; root/issues.ts:259 | `.slice(0, 300)` / `printable(why, 300)` | why a bundle or an issue was refused | cut silently | yes | "The reason is in part the bundle's author's text: printable ASCII only, and short." | security bound | keep hard |
| root/proxy/proxy.ts:185-186 | ports `80` and `443` | where a workspace may connect | refuses 403 with "only ports 80 and 443 leave a workspace" (X-Desolate-Reason) | yes | reference.md:295, dogfooding.md:84, AGENTS.md:121 | security bound | setting (a per-domain port allowlist): a real user hits it (a registry on :5000, ssh to a forge, a database) |
| root/proxy/proxy.ts:75-77; root/proxy/secrets_addon.py:250-251 | `64 * 1024 * 1024` | a domain's audit.log before it becomes audit.log.1 | rotated; older than .1 lost. The counter is per process: several proxies (one per workspace) and the add-on write one file, so it can grow past 64 MiB and one rotation can overwrite the .1 another just made | no | "At most 64 MiB, then the last 64 MiB as audit.log.1 … (audit, 2026-11-20)" | resource protection | keep hard (or setting for retention); stat the file before each rotation |
| root/proxy/proxy.ts:476 | `30_000` ms | connecting to the destination | destroyed "timed out" | yes (connection fails) | none | timeout | keep |
| root/proxy/proxy.ts:484 | `sniffSocket(client, 10_000)` | first bytes after CONNECT under an allowlist | refused: no name read, connection closed | yes, rarely | none | timeout | keep hard |
| root/proxy/proxy.ts:595, :599 | `10_000` ms, `8192` bytes | a workspace's CONNECT request | connection destroyed | no | "A client that does not finish asking in ten seconds holds nothing open." | security bound | keep hard |
| root/proxy/proxy.ts:517 | `8192` | the secrets proxy's reply to the tunnel | read as an answer; anything not 200 refuses | no | none | protocol fact | keep |
| root/proxy/proxy.ts:168, :406, :443; root/proxy/secrets_addon.py:242 | `300`, `100`, `100`, `[:200]` | reasons, names and routes in refusals and the audit log | cut silently | partly | none | UX truncation | keep hard (attacker text) |
| root/proxy/secrets.ts:331 | `body_size_limit=256m` | a request or response body through a secret's host | refused by mitmproxy (the download fails, closed) | yes | "past 256 MiB one is refused, not buffered until the root runs out of memory (audit, 2026-11-20)"; decisions.md:1368 | resource protection | setting (per domain), or eliminate by streaming bodies that name no secret |
| root/proxy/secrets.ts:306-308 | ports `22000`–`22999` | ports for secrets proxies in the root VM | throws "no free port for a secrets proxy in the root" | rarely | none | other | keep |
| root/proxy/secrets.ts:353-357 | `180_000` (counted as 100 ms sleeps, so real time is longer) | waiting for mitmdump to start | throws "the secrets proxy for <d> did not start; see …/logs/secrets-<d>.log" | yes | none | timeout | keep; count real time |
| root/proxy/secrets.ts:249 | `64 * 1024` | the mitmproxy CA certificate's size | not published to the workspaces (silently) | indirectly (TLS fails in the workspace) | "taken only if it is a plain, small file" | security bound | keep hard |
| root/proxy/secret-store.ts:45, :78-81; root/proxy/secrets_addon.py:71 | `[A-Z][A-Z0-9_-]{7,63}` (8 to 64) | a secret's placeholder name | refuses "'X' is not a placeholder name", fix "8 to 64 of A-Z, 0-9, _ and -, starting with a letter: for example MYAPP-OPENAI-KEY…" | yes | none (a short one would match ordinary text) | security bound | keep hard |
| root/proxy/secret-store.ts:124 | `ttl < 1 \|\| ttl > 366 * 86400` | a secret's time to live | refuses "a time to live is between a second and a year" | yes | none | other | keep |
| root/proxy/manage.ts:74 | `5000` ms (100 × 50 ms) | waiting for a workspace's proxy to answer | recorded as started anyway, silently; first connections may fail | no | none | timeout | keep, but report a proxy that did not answer |
| root/proxy/manage.ts:256 | `last: 100_000` | audit entries `net.recommend` ranks | older ignored; the whole audit.log (up to 64 MiB+) is read into memory; audit.log.1 never read | no | none | resource protection | eliminate (stream the file) |
| root/proxy/as-proxy.ts:87 | `timeout: 10_000` | `sudo pkill` stopping a proxy | gives up silently | no | none | timeout | keep |
| root/send.ts:86, :95 | `60_000` ms window, `500` ms | retrying a pusher that is starting (between pushes) | retries; then "the pusher: <error>; desolate doctor" | yes | "The pusher is one push per process: a moment between pushes, it is starting." | retry policy | keep |

## Reviewer, pusher, keyring (78 rows)

Covers `root/reviewer.ts`, `pusher.ts`, `keyring.ts`, `keyring-client.ts`, `keyring-askpass.ts`, `review-client.ts` and `review-ask.ts`.

| file:line | value | what it limits | when hit | person sees it? | stated reason | kind | disposition |
|---|---|---|---|---|---|---|---|
| root/review-ask.ts:80-82 | `timeout --signal=KILL 95` | the whole summary process (reviewer.ts `summary`: lock wait, ls-remote, log/diff, pack-objects run **twice**, once as is and once squashed) | kills; the host gets `the reviewer ended without an answer: <last 200 of stderr>` (usually empty after a KILL), and the approval page cannot sign a push it has no account of | yes: the push cannot be approved at all; nothing says it ran out of time | "A process group of its own, ended whole at 95 s: killed by spawnSync's timeout, runuser left node and its git running (the independent review of #169)" | timeout | ask the person ("this summary has run 95 s: keep waiting?"); a big first push (whole history, recompressed with 2 threads) will not finish in 95 s, and the killed run caches nothing, so asking again fails again |
| root/review-ask.ts:94 | `timeout: 100_000`, `killSignal: "SIGKILL"` | spawnSync backstop around the 95 s kill | kills runuser | as above | (same comment) | timeout | keep (derived: should be written as 95 s + 5, not a separate literal) |
| root/review-ask.ts:83-85 | `nice -n 10` | CPU priority of the summary | slower summary | no (makes the 95 s kill more likely under load) | "Low priority too." | resource protection | setting, or keep; tie to the 95 s decision |
| root/review-ask.ts:96 | `maxBuffer: 8 * 1024 * 1024` | summary JSON on stdout | spawnSync fails ENOBUFS, answer `{"ok":false,"error":"spawnSync runuser ENOBUFS"}` | yes, as a cryptic error; practically unreachable (reviewer.ts:1253 says a summary is "at most about 600 KB") | none | resource protection | keep hard; say what it means if it ever happens |
| root/review-ask.ts:27 | `.slice(-200)` | reviewer's stderr in the "ended without an answer" error | cut silently (keeps the end) | yes, then cut again by host/daemon.ts:234 `printable(…, 200)` | none | UX truncation | keep |
| root/reviewer.ts:186; 451, 458, 948, 980, 1052, 1134; 1023, 1175, 1200 | `300_000` default; `600_000`; `120_000` | each git run inside a summary | would kill that git; never reached in a summary, since the whole process dies at 95 s | no | none | timeout | eliminate: dead numbers under the 95 s kill; misleading to a reader (a 10-minute git inside a 95-second process) |
| root/reviewer.ts:53, 304-307 | `submitMs: 600_000` | one bundle submit (receive + `bundle list-heads` + fetch) | `process.exit(1)`, logs "a submit ran past its ten minutes: given up"; caller (review-client.ts:91) gets "the reviewer closed the connection without an answer" | indirectly: the push then has no account and cannot be approved | log line only | timeout | ask the person / setting; the inner fetch's `1_800_000` (reviewer.ts:339) can never run, so one of the two is wrong |
| root/reviewer.ts:48, 300-301 | `bundle: 2 * 1024 ** 3` | bundle the root's user submits for review; the first submit for a repository is the clone's **whole history** (review-client.ts:117-127 excludes only tips the reviewer already holds) | refuses: "a bundle is a whole number of bytes, at most 2 GiB" | yes, as the push's missing account: a repository over 2 GiB packed can never be reviewed, so never pushed | none at the line (decisions.md:284 lists "a bundle 2 GiB" for outboxes) | resource protection | eliminate: submit history in pieces or bound only the per-push part; the 2 GiB that matters is the forge's push size (row below) |
| root/reviewer.ts:49, 316 | `refs: 2000` | refs in a review bundle (review ref + every `origin/*`) | refuses with the generic "a review bundle carries the clone's review ref and its origin/* refs, and nothing else" | yes, and the message is wrong: a repository with 2000+ remote branches is told its bundle is malformed | none | resource protection | eliminate (send only the tips the summary needs) or at least say the count |
| root/reviewer.ts:280 | `[A-Za-z0-9._/-]{1,200}` in `BUNDLE_REF` | length (and charset) of an `origin/*` branch name in the bundle | the whole bundle refused with the same generic message | yes, wrongly worded; rare | none | security bound | keep hard, but name the offending ref; 200 is arbitrary (git allows longer) |
| root/reviewer.ts:47, 1329 | `header: 64 * 1024` | request line on the reviewer's socket | connection destroyed silently; caller sees "the reviewer closed the connection without an answer" | no (requests are desolate's own) | none | security bound | keep hard |
| root/reviewer.ts:52, 263 | `idleMs: 60_000` | idle gap while receiving a bundle | fails "nothing arrived for a minute" | indirectly | "with a minute's patience per chunk" (238) | timeout | keep (idle, not total) |
| root/reviewer.ts:50, 918, 927 | `commits: 50` (`--max-count=51`) | commits listed on the approval page / terminal | cut and says so: page "and N more" (approve.js:179); `git log` order is newest first, so the list is the **newest** 50 | yes, any push of 51+ commits | none | UX truncation | eliminate (page the list); note it is the newest 50 while each-commit text below is the oldest 50 (row below): the same "50" names two different sets |
| root/reviewer.ts:1172, 1179-1182, 1198, 1205 | `order.slice(0, LIMIT.commits)` | each commit whole (message + diff) on the page | cut and says so: "the first 50 of N commits" (oldest first, `rev-list --reverse`) | yes | decisions.md:1463: the earlier "newest 50 under 'cut at 256 KiB'" bug | UX truncation | eliminate (page/stream per commit) |
| root/reviewer.ts:51, 1036, 1219-1220 | `files: 200` | net-change file list | cut and says so: "and N more (every one that runs on the forge is listed above)" | yes, pushes of 200+ files | "What runs on the forge first: never past the cut." (974) | UX truncation | eliminate (page the list) |
| root/reviewer.ts:1032-1036 | `2000` (sensitive files) | files under `.github/`, `.gitmodules` etc. always listed, up to 2000 | cut and says so: "`${n}` files that change what runs on the forge (under .github/, or the like): the first 2000 are listed" | yes, rare | "a push of 80,000 of them made an answer too large to carry, and the page lost the warning (audit, 2026-11-16)" | resource protection | keep hard (answer size), or eliminate with paging |
| root/reviewer.ts:1230-1231 | `LIMIT.files` (200) | files changed and changed back (`between`) | cut and says so: "and N more" (approve.js:215) | yes | none | UX truncation | eliminate (paging); reuses `files` without saying why it is the same number |
| root/reviewer.ts:833, 1025-1026, 1178, 1203 | `DIFF_MOST.bytes: 256 * 1024` | the net diff and the each-commit text | cut and says so ("cut at 256 KiB"; page shows the cut reason); counted in JS string characters, not bytes, and may cut mid-line | yes, any diff over ~256 K characters | Summary type: "Cut at 256 KiB; not made at all past 20 000 lines" (815) | UX truncation | eliminate (fetch the diff by page, or stream it); the dashboard's offer diff is 1 MiB (root/offers.ts:770), so the same push shows a 4x longer diff on the dashboard than on the approval page |
| root/reviewer.ts:833, 1007, 1205-1206 | `DIFF_MOST.lines: 20_000` | whether a diff is made at all (sum of numstat added+removed) | refuses to make it: page "Too large to show here (over 20 000 lines): read it with git in the git terminal." (approve.js:130); each-commit text becomes messages only | yes, e.g. a lockfile change | "bounded by its size before it is made" (1004) | resource protection | ask the person ("20 000+ lines: make it anyway?") or eliminate with streaming |
| root/reviewer.ts:929-930 | `shown(author, 80)`, `shown(subject, 200)` | author and subject in the commit list | cut silently (no ellipsis) | yes, long subjects lose their end | `shown`: "and not too long" (59) | UX truncation | eliminate (let the page wrap/ellipsize; keep only a large safety bound) |
| root/reviewer.ts:962, 1146 | `shown(raw, 300)` | file paths in both file lists | cut silently; two long paths with the same first 300 characters read as one | yes, rare | none | UX truncation | keep a bound, but mark the cut |
| root/reviewer.ts:192 | `.slice(-2)` lines, `.slice(0, 300)` | "git <cmd> failed: …" errors | cut silently | yes, in summary/submit errors | none | UX truncation | keep, add an ellipsis |
| root/reviewer.ts:386, 397 | `ConnectTimeout=20`; ls-remote `timeoutMs: 60_000` | reading the forge's branches with the read key | fails "git ls-remote failed: …" and the summary fails | yes | none | timeout | keep |
| root/reviewer.ts:906 | `known.slice(0, 200)` | remote branches tried when looking for where a new branch leaves the remote's history | cut silently: past 200 branches the best base may be missed, so more commits/files are listed as new | yes, as an inflated list, in repos with 200+ branches | none | resource protection | eliminate (one `git merge-base --independent`/`rev-list` over all tips) |
| root/reviewer.ts:435 | `64 * 1024 * 1024` | output of one `git cat-file --batch` (gitBytes) | kills git; `pointersIn` throws "git cat-file failed on the push's own blobs"; header check warns "the commits' headers could not all be read (one over 64 MiB, or git failed)…" | yes, as a failed summary or a warning | 467-469: batches sized to fit it | resource protection | keep hard (it is why the batches exist) |
| root/reviewer.ts:470-475 | `20_000` blobs per batch | batching small-blob reads | nothing visible | no | "20,000 blobs under 400 bytes are under 9 MiB (the independent review of #169: 250,000 small blobs in one push went over…)" | resource protection | keep (derived from 64 MiB / 400 B; write it as such) |
| root/reviewer.ts:1064-1068 | `2000` commits per batch | batching commit-header reads | nothing visible (unless one batch passes 64 MiB: then the warning above) | no | none | resource protection | keep |
| root/reviewer.ts:463, 998 | `Number(size) < 400` | which blobs are examined as LFS pointers | blobs of 400+ bytes silently not counted as pointers | no; a pointer with extension lines over 400 bytes would be missed | none | other | keep, but use the LFS spec's own bound (a pointer is under 1024 bytes) |
| root/reviewer.ts:494-497 | `5 * 1024 ** 3` | size an LFS pointer may name | refuses: "an LFS pointer names an object of N bytes, over the 5 GiB a push sends" | yes | "Over 5 GiB, the pusher takes none (pusher.ts): said, not left out" (492) | resource protection | keep hard (forge-shaped); one shared constant, not three |
| root/reviewer.ts:514, 585, 595-597 | `packBytes: 2 * 1024 ** 3` | the pack a push sends | kills pack-objects; "the push's pack is over 2 GiB, more than a push may send" | yes | "As large as the pusher takes, and no larger (pusher.ts, LIMIT.pack)" (584) | resource protection | keep hard if it is the forge's push limit (GitHub's is 2 GB); then name it as the forge's and share it |
| root/reviewer.ts:560-565 | `pack.threads=2`, `pack.windowMemory=256m`, `core.bigFileThreshold=64m` | memory/CPU of pack-objects (run twice per summary) | slower packing; files over 64 MiB stored undeltified (bigger pack) | no, except that it pushes summaries toward the 95 s kill and the 2 GiB cap | "Bounded: the root VM's memory is every domain's keyring and pusher too." | resource protection | setting (scale with the root VM's size), decided together with the 95 s kill |
| root/reviewer.ts:588 | `.slice(-2000)`, then last line only (601) | pack-objects stderr in "cannot pack the push: …" | cut silently | yes, on failure | none | UX truncation | keep |
| root/reviewer.ts:511, 543 | `freshMs: 10 * 60_000` | reuse of a pack made for the same push and remote branches | after 10 min a new pack is made | no | "Asked again within ten minutes, the same pack; after, a new one (the remote may have moved on)." (527) | cache lifetime | keep |
| root/reviewer.ts:512, 658, 1351 | `keptMs: 60 * 60_000` | how long packs (and their records) are kept | deleted; a later push asks for it and gets "the reviewer keeps no such pack (each is kept an hour): look at the push on the approval page again" | rarely (an approval lasts 2 minutes) | "an approval lasts two minutes, a push half an hour" (637) | cache lifetime | keep |
| root/reviewer.ts:513, 664-668 | `mostBytes: 8 * 1024 ** 3` | total disk of kept packs, all repositories | oldest deleted first, silently; can delete the pack of a push just approved, which then fails as above | rarely | "a root's user that asks for summaries of many pushes fills no disk" (638) | resource protection | setting (root disk size); never evict a pack a live approval names |
| root/reviewer.ts:1237, 1241, 1259 | `freshMs: 10 * 60_000`, `most: 64` | cached summaries | re-made after 10 min, or past the newest 64 | no | "The newest 64, none older than ten minutes: each is at most about 600 KB." (1253); "A root's user that has the page ask again and again starts no new work" (865) | cache lifetime | keep |
| root/reviewer.ts:1272, 1310-1314 | `60_000` wait, `250` ms poll | waiting for the one-at-a-time summary lock | refuses: "desolate's reviewer is busy with another push's account: look at the push again in a moment" | yes, with two pushes reviewed at once | "One summary at a time … One that waits a minute is told so" (1267-1269) | timeout / polling interval | ask the person, or eliminate with a queue; the wait eats into the 95 s kill (a summary that waited 60 s has 35 s to work) |
| root/reviewer.ts:1288 | `< 5000` ms | a lock with no readable pid younger than 5 s is taken as alive | waits | no | "(No pid yet: its holder is still writing it.)" | other | keep |
| root/reviewer.ts:688, 712-714 | `SQUASH_LISTED = 100`; subject `shown(…, 200)` | the squash commit's message, **written to the forge's history** | cut and says so in the message: "- and N more"; each subject cut silently at 200 | yes, permanently in the pushed commit | none | UX truncation | ask the person / keep; the subject cut is silent and permanent, so at least mark it |
| root/reviewer.ts:731-745 | `named(…, 80)` names, `named(…, 120)` emails | author/committer of the squash commit, **written to the forge** | cut silently, then committed | yes, in the pushed commit; a valid email over 120 characters (RFC allows 254) is committed wrong | "copied as they were, an agent's 100 KB 'email' would ride along unseen in a commit the reviewer itself made" | security bound | keep hard, but 254 for email, and refuse rather than cut |
| root/reviewer.ts:793-795 | `shown(…, 210)`, dates `shown(…, 40)` | squash identity and dates as shown | cut silently (cannot be reached given the 80/120 above) | no | none | UX truncation | keep (derived) |
| root/reviewer.ts:1088, 1096-1097 | header name `40`; encoding shown if `< 60` bytes, value `40` | the "headers this page does not show" warning | cut silently | yes, rare | none | UX truncation | keep |
| root/reviewer.ts:1110 | `odd.slice(0, 20)` | commits named in the headers warning | cut and says so: "; and N more" | yes, rare | none | UX truncation | keep (a warning line), or list in full on the page |
| root/reviewer.ts:1358 | `30 * 60_000` | a pack-streaming reviewer process | process exits | no (matches the pusher's 30 min) | none | timeout | keep |
| root/reviewer.ts:1369; root/pusher.ts:1065 | `5000` | process exit after answering | exits | no | "One request per process" | timeout | keep |
| root/reviewer.ts:1388 | `600_000` | read-key identity files left by killed summaries | removed at start | no | "gone after ten minutes" (1384) | cache lifetime | keep |
| root/reviewer.ts:1364; root/pusher.ts:1049 | `.slice(0, 40)` | op name echoed in "unknown op '…'" | cut silently | no | none | UX truncation | keep |
| root/review-client.ts:28, 35 | `30_000` window, `300` ms | retrying a reviewer that is between processes (ENOENT/ECONNREFUSED/ECONNRESET/EPIPE) | retries, then throws | indirectly | "The reviewer is one request per process: between two, it is starting." | retry policy | keep |
| root/review-client.ts:107 | `30_000` | the `tips` question | fails with keyring-client's message "the keyring did not answer at <reviewer socket> within 30000 ms" | yes, and it names the wrong service | none | timeout | keep the value; fix the message (keyring-client.ts:23 says "keyring" for every socket) |
| root/review-client.ts:128 | `timeoutMs: 1_800_000` | `git bundle create` of the review bundle | kills git; "cannot bundle for the reviewer: …" | yes, as no account | none | timeout | keep; but the reviewer gives the whole submit only 10 min (reviewer.ts:53) |
| root/review-client.ts:187 | `1024 * 1024` | the reviewer's header line before a pack's bytes (it carries the LFS id list) | fails "no answer" | yes, as "the reviewer has no pack for this push (no answer), so nothing was pushed" (send.ts:181) | none | security bound | keep hard; at ~78 bytes per LFS id it allows ~13,000 ids, above the pusher's 2000, so harmless |
| root/pusher.ts:73, 835, 850 | `objects: 2000` | LFS objects in one push (`lfs` and `lfsListed`) | refuses with the **wrong** message: over 2000 sent gives "LFS objects are named by sha256, with a size of at most 5 GiB"; over 2000 listed gives "the LFS objects listed are not the ones approved: nothing was pushed" | yes, **after** the person approved: the reviewer does not cap LFS ids, and the approval text allows up to 999,999 (shared/approval.ts:163) | none | resource protection | eliminate (chunk the upload) or enforce at summary time with its own message; also in host/git-vm.ts:273 and root/offers.ts:245 (a silent `slice(0, 2000)`) |
| root/pusher.ts:71, 832-833 | `pack: 2 * 1024 ** 3` | the pack the root's user hands the pusher | refuses: "a pack is a whole number of bytes, at most 2 GiB" | only if the reviewer let a larger one through (it cannot) | "As large as the pusher takes" (reviewer.ts:584) | security bound | keep hard; share with reviewer.ts:514 |
| root/pusher.ts:72, 841-844 | `lfs: 5 * 1024 ** 3` | one LFS object | refuses: "LFS objects are named by sha256, with a size of at most 5 GiB" | rarely (the reviewer refuses first) | none | resource protection | keep hard; share |
| root/pusher.ts:70, 1036 | `header: 1024 * 1024` | the JSON line the root's user sends | connection destroyed silently | no | header: "(at most 1 MiB, read by node's own parser)" (15) | security bound | keep hard |
| root/pusher.ts:74, 265, 434 | `advertised: 64 * 1024 * 1024` | everything the forge says in one push (ref list and report, counted together) | fails "the forge said more than desolate reads" | yes, only for a forge advertising ~600,000+ refs | none | security bound | keep hard (forge input) |
| root/pusher.ts:75, 744 | `idleMs: 60_000` | idle gap while receiving LFS objects and the pack | fails "nothing arrived for a minute" … ": nothing was pushed" | yes | "The minute is the sender's: it runs while waiting for bytes, not while the forge (or the disk) takes the last chunk." | timeout | keep |
| root/pusher.ts:963 | `timeoutMs: 1_800_000` | `git lfs push` of all LFS objects | kills; "the LFS objects did not upload, so the commit was not pushed: <last 2 stderr lines>" | yes: up to 2000 x 5 GiB allowed, 30 minutes to send them | none | timeout | ask the person ("still uploading N of M: keep going?") or setting; tied to keyring CLAIMED_MS |
| root/pusher.ts:989 | `1_800_000` then `SIGKILL` | the receive-pack ssh (pack upload) | kills; reported as uncertain: "… the push may have reached the remote; `desolate fetch <repo>` shows whether <ref> is at <commit>" | yes: a 2 GiB pack needs ~1.2 MB/s to finish in 30 min | none | timeout | ask the person / setting (scale with pack size) |
| root/pusher.ts:212, 214 | `ConnectTimeout=20`, `ServerAliveInterval=15` | ssh to the forge (no ServerAliveCountMax: ssh's default 3, so ~45 s on a dead link) | fails | yes, as a push error | none | timeout | keep |
| root/pusher.ts:479 | `5000` | waiting for the forge's report after sending failed | then reports uncertain "sending the pack failed (…)" | yes | "a failure past this point says that the push may have landed" (464-466) | timeout | keep |
| root/pusher.ts:373, 379, 458 | `.slice(0, 200)`; `ng.slice(ref.length + 4, ref.length + 204)`; caps `.slice(0, 200)` | the forge's unpack status, refusal reason, capability list in errors | cut silently | yes, on a refused push (a long protected-branch reason loses its end) | none | UX truncation | keep a bound (forge input), mark the cut |
| root/pusher.ts:986, 1010 | stderr ring `.slice(-4000)`; last 2 lines `.slice(0, 300)` | ssh's words in a push error | cut silently | yes | none | UX truncation | keep |
| root/pusher.ts:969 | `.slice(-2)` lines | git-lfs's error | cut silently (earlier lines lost) | yes | none | UX truncation | keep |
| root/pusher.ts:100 | `.slice(0, 300)` | the error in `push-failed`/`push-uncertain` events (`desolate events`) | cut silently; the event can lose the `desolate fetch …` advice at its end | yes, to scripts and the person following events | none | UX truncation | eliminate (the text is the pusher's own, already bounded) |
| root/pusher.ts:808 | `id.slice(0, 40)` | approval id echoed | cut silently | yes, harmless | none | UX truncation | keep |
| root/pusher.ts:1051 | one push per process (`pushing`) | concurrent pushes | refuses `{busy: true, "another push is under way"}`; root/send.ts retries | no | "One push per process: the next waits for the next process (root/send.ts retries)." | other | keep (design) |
| root/keyring.ts:166, 409 | `CHALLENGE.lifeMs: 120_000` | time from the challenge being issued to the person's signed answer | refuses: "that challenge is not outstanding: each lasts two minutes and approves once" | yes; getting-started.md:461 "A push was refused at approval, or timed out: it waits two minutes; run it again." A person reading a long diff hits it | "Short-lived and few: a process that asks in a loop gets the oldest ones dropped, not memory." | security bound | keep the bound, but have the page take a fresh challenge when the person clicks (from the person's view: eliminate) |
| root/keyring.ts:166, 180-181 | `outstanding: 32` | unanswered challenges held | oldest dropped silently; its approval then refused as "not outstanding" | yes, only if something floods challenges | (same) | security bound | keep hard |
| root/keyring.ts:161, 445 | `APPROVAL.lifeMs: 120_000` | time from approval to the pusher claiming it; root/send.ts:177 copies the whole pack (up to 2 GiB) from the reviewer **before** the pusher claims | expired: pusher says "the keyring holds no live approval <id>: nothing was pushed" | yes, if the pack copy is slow | "An approval covers that one push: a short life and a small number of uses." (159-160) | security bound | keep hard; claim before copying so the copy is not on the clock |
| root/keyring.ts:161, 600 | `uses: 8` | write-key signatures per approval | refused: "no person has approved a push to <repo>" (askpass exits 1, ssh fails) | yes, as a failed push | "A push opens a few ssh connections (the push itself, LFS's authenticate calls), each one signature." | security bound | keep hard; check git-lfs's re-authentication on long uploads of many objects |
| root/keyring.ts:157, 822 | `CLAIMED_MS = 35 * 60_000` | signatures allowed after the pusher claims | refused as above | yes, only past 35 min | "the approval lasts as long as a push may (CLAIMED_MS)" (140); decisions.md:506 "so LFS objects first do not run the two minutes out" | security bound | keep hard, but derive it from the pusher's timeouts: it must exceed pusher.ts:963's 30 min (it does, by 5 min, unstated) |
| root/keyring.ts:653 | `Number(request.last) \|\| 50`, `500` | `keys.audit` entries returned (root/ops.ts:509) | clamped silently; the whole audit log, never rotated, is read every time | yes, to whoever runs the audit | none | UX truncation | setting/eliminate (page through it); rotate the log |
| root/keyring.ts:941, 962 | `bytes: 4096` | a request on any keyring socket | refuses "request too large", connection closed | no (desolate's own requests are ~1 KB) | none | security bound | keep hard |
| root/keyring.ts:941, 952 | `concurrent: 16` | open connections per keyring socket | refuses "too many connections" | no, unless flooded | none | resource protection | keep hard |
| root/keyring.ts:1159-1162 | `10_000` ms, `50` ms polls | waiting for ssh-agent's sockets at start | throws "ssh-agent never created its socket"; keyring exits and is restarted | no | none | timeout | keep |
| root/keyring-client.ts:16, 23 | `timeoutMs = 10_000` default | any request to a keyring, reviewer or pusher socket made with `ask` | fails "the keyring did not answer at <socket> within N ms" (says "keyring" for the reviewer and pusher too) | yes, in errors | none | timeout | keep the value; fix the wording |
| root/keyring-askpass.ts:52 | `5000` | askpass asking the keyring to allow one signature | refuses the signature ("keyring-askpass: …; refusing") | yes, as a failed push | none | timeout | keep |

## Workspace (`workspace/`) (48 rows)

Covers the TypeScript programs and `agent-holder.py`. The workspace shell scripts are under Scripts.

| file:line | value | what it limits | when hit | person sees it? | stated reason | kind | disposition |
|---|---|---|---|---|---|---|---|
| workspace/agent-holder.py:37 | `KEEP = 2 * 1024 * 1024` (2 MiB) | the agent's output replayed to a new `desolate agent attach` | cut silently (oldest bytes dropped) | yes: scrollback on attach starts mid-stream | "what is replayed to an attach"; decisions.md:964 "a 2 MiB replay buffer" | resource protection | setting, or eliminate: replay from the log with paging |
| workspace/agent-holder.py:38, :174 | `LOG_MOST = 64 * 1024 * 1024` (64 MiB) | the agent's log file `~/.desolate-agents/<name>.log` | cut silently: once the log reaches 64 MiB nothing more is written, and the exit note is still appended. `desolate agent log` (host/agent.ts:349 `tail -c 2097152`) then shows the last 2 MiB *before* the cap, forever, with no mark | yes, without knowing it: `agent log` goes stale | none given (line 245 says output stays "in its log for good") | resource protection | eliminate: rotate or keep a tail ring (keep the newest, drop the oldest) and write a "[log cut]" mark; a TUI agent redrawing all day reaches 64 MiB |
| workspace/agent-holder.py:44 | `len(name) > 40` | agent name | refuses: "agent-holder: a name is lower-case letters, digits and dashes" (does not mention the length) | yes | none (matches shared/names.ts SLUG 40) | other | keep hard; the message should say "at most 40" |
| workspace/agent-holder.py:94-95 | `range(100)` x `sleep(0.05)` (5 s) | wait for the detached holder to create its socket | refuses: "agent-holder: it did not start, and said nothing" (or the .err text) | yes | none | timeout | keep hard (binding a socket is fast) |
| workspace/agent-holder.py:130 | `resize(master, 120, 40)` | pty size before the first attach | other: the agent draws for 120x40 until someone attaches | indirectly | none | other | keep |
| workspace/agent-holder.py:138 | `server.listen(8)` | pending attach connections | waits/refused by kernel past 8 | no | none | resource protection | keep |
| workspace/agent-holder.py:185 | `now - last_state > 5` | how often `lastOutput` is written to the state file | other (lastOutput is up to 5 s stale) | yes, in `agent` listings | none | polling interval | keep |
| workspace/agent-holder.py:199 | `rest[-200000:]` | an attaching client's unterminated input line | cut silently (keeps the last 200000 chars) | no | none | resource protection | keep hard |
| workspace/agent-holder.py:209 | `0 < cols <= 1000 and 0 < rows <= 500` | a resize from an attached terminal | ignored silently | rarely (a huge terminal stays the old size) | none | resource protection | keep hard |
| workspace/agent-holder.py:220, :224 | `time.sleep(0.3)` between two Ctrl-C; `kill_at = time.time() + 3` | `desolate agent stop`: grace before SIGKILL of the process group | kills after 3 s | yes (agent ends; its last state may be unsaved) | "As a person would: interrupt it, twice (most agents, Claude Code among them, end on that)" | timeout | ask the person ("it has not stopped after Ctrl-C: kill it?") or setting; 3 s is arbitrary |
| workspace/agent-holder.py:246-248 | `deadline = time.time() + 600`; `select(..., 5.0)` | how long an ended agent stays attachable (replay of the last 2 MiB) | other: after 10 min the socket is removed; attach then says "agent-holder: '<name>' is not running" | yes | "What it said stays attachable for a while (and in its log for good)" | cache lifetime | eliminate: serve the replay from the log after exit |
| workspace/agent-holder.py:327-329 | `settimeout(0.2)`, `deadline = time.time() + 1.0` | `stop` waiting for the holder to read the `k` | waits up to 1 s, then prints `{"stopped": name}` whether or not the agent has stopped | yes ("stopped" can be premature) | "Connected until the holder has read it (it sends the replay first): a second." | timeout | keep; say "asked to stop" rather than "stopped" |
| workspace/bridge.ts:28 | `NEVER = new Set([15080, 15443, 31581])` | compose ports never mirrored (desolate's relay, the editor gate) | skipped silently | no | "desolate's own listeners in the VM, and the editor's gate: never mirrored" | other | keep; import from one place (written again in wsd.ts:29, egress.ts:387-388, names.ts:375) |
| workspace/bridge.ts:44 | `conn.setTimeout(3000, ...)` | svcnet's answer to `L` | error "svcnet did not answer", caught in `tick`, which then `closeAll()`s every mirror until the next second | yes: every compose port drops for a tick when the service is busy | none | timeout | keep hard, but don't close all mirrors on one slow answer (keep last known) |
| workspace/bridge.ts:48 | `data.length > 65536` | svcnet's answer size | kills the connection ("svcnet said too much"), then all mirrors closed | no | none | resource protection | keep hard |
| workspace/bridge.ts:137-138, :162-163 | `port >= 1024 && port <= 65535`, `.slice(0, 256)` | which compose-service listeners get a VM loopback mirror | cut silently: ports below 1024 (an nginx on 80 in the app service) and listeners past the 256th are never mirrored | yes: the port just doesn't forward | "up to 256 of them"; in-source test: "unprivileged ports only: a number below 1024 in the VM is root's" (pinned by portsOf Ports) | resource protection | keep hard for <1024 but say so in status; 256 is arbitrary: say so when cut |
| workspace/desolate.ts:634 | `` `${workspace.workspace}-${randomBytes(2).toString("hex")}`.slice(0, 40) `` | default name of a spawned workspace | cut silently. A parent named with 39 characters gives `name-` (ends in a dash, not a slug); with 40, the name is the parent's own. The root then refuses with "the root did not take it: that is not a request desolate makes (desolate spawn --help)" | yes, with a misleading reason | none | other | eliminate: cut the parent part to leave room for `-xxxx` (as domainNameFor does) |
| workspace/desolate.ts:728 | `sleep(500)` | `desolate events --follow` re-reading events.jsonl | polls every 500 ms (re-reads the whole file each time) | no | none | polling interval | keep (or tail by offset) |
| workspace/devcontainer.ts:135 | `JSON.stringify(settings).length <= 65_536` | a project's `customizations.vscode.settings` | cut silently: settings dropped entirely, no note | yes: the editor lacks the project's settings, unexplained | "An object of at most 64 KiB as JSON, or nothing." | resource protection | keep hard, add a note to the devcontainer state |
| workspace/devcontainer.ts:572, :577-578 | host `{0,62}` + port `\d{1,5}`, `port < 1024 \|\| port > 65535` | `forwardPorts` entries `service:port` | skipped silently (e.g. `"web:80"`) | yes: the port doesn't forward | none | other | keep hard, but list skipped entries in the note |
| workspace/devcontainer.ts:643, :662-664 | `setTimeout(1000)`; `50` x `sleep(100)` (5 s) | waiting for svcnet to answer after `docker exec -d` | gives up; note "its service's ports are not forwarded and the editor runs in the VM: desolate's port relay did not start in it" | yes (note) | none | timeout | keep hard |
| workspace/devcontainer.ts:707-716 | `docker info` with `timeoutMs: 20_000`, `waited += 500`, `waited > 90_000` | waiting for the VM's docker daemon | refuses: "the VM's docker daemon is not answering (see /var/lib/desolate/dockerd.log)". `waited` counts only the 500 ms sleeps, so the real wait can be far over 90 s (each probe may take 20 s) | yes | none | timeout | keep hard; count wall time |
| workspace/devcontainer.ts:759 | `timeoutMs: 3_600_000` (1 h) | `devcontainer up` (image build, features, postCreate) | kills; run() appends "(timed out after 3600000 ms)"; state FAILED with the summary | yes | none | timeout | ask the person ("still building after an hour: keep waiting?"); a big image on a slow link can exceed it |
| workspace/devcontainer.ts:794 | `summary.slice(0, 160)`, `cause...slice(0, 240)` | the FAILED reason | cut silently, then "(the whole log: <dir>/up.log in the workspace)" appended | yes | none | UX truncation | keep, but see wsd.ts:177, which cuts this again and loses the log path |
| workspace/devcontainer.ts:883 | `timeoutMs: 120_000` | probing the container's environment (`env -0`) | kills; exec-env.json is not written, silently | no (editor/agent sessions lack the container env) | none | timeout | keep |
| workspace/devcontainer.ts:929 | `.slice(0, 120)` | image name in the state | cut silently | yes (status) | none | UX truncation | eliminate (cut at display, if at all) |
| workspace/init.ts:23 | `timeoutMs: 600_000` (10 min) | every git command in workspace init (clone --shared, first checkout with LFS smudge, fetch, worktree add) | kills; "git <args> failed in <dir>: ...(timed out after 600000 ms)" and the workspace fails to start | yes | none | timeout | ask the person, or setting: a large LFS checkout over the share can take longer |
| workspace/init.ts:27 | `.slice(-800)` | git's error text in that failure | cut silently (keeps the tail) | yes | none | UX truncation | keep (or point at a log) |
| workspace/init.ts:45 | `Date.now() - fs.statSync(lock).mtimeMs > 120_000` | when another workspace's init lock is taken as stale | deletes the lock and proceeds. The holder's body (clone, checkout, worktree add, each allowed 10 min) can hold it longer than 2 min, and the lock's mtime is never refreshed, so two workspaces can init the same .git at once | no (corruption or a confusing git error) | "A lock older than two minutes belongs to a workspace that died mid-init." | other | eliminate: record the holder (VM, pid) and check it is alive, or refresh the mtime while held |
| workspace/init.ts:50 | `waited > 180_000` | waiting for the init lock | refuses: "another workspace has held the init lock on <key> for three minutes" | yes | none | timeout | ask the person (it rarely fires: the 2-min steal comes first) |
| workspace/init.ts:236 | `timeoutMs: 120_000` | `git fetch origin` from the mirror before making a worktree | result ignored: the branch silently starts from the clone's older origin/* | no | comment above explains why the fetch exists, not the 2 min | timeout | keep; say so when it failed |
| workspace/net/egress.ts:119 | `answer.length > 16384` | the proxy's CONNECT answer head | kills (connection closed, no message) | no | none | resource protection | keep hard |
| workspace/net/egress.ts:124 | `X-Desolate-Reason: ([^\r\n]{0,300})` | the proxy's refusal reason shown to a plain-HTTP client | cut silently at 300 characters | yes (the 403 page text) | none | UX truncation | eliminate (the proxy is desolate's own; take the whole line, bounded by the 16 KiB head) |
| workspace/net/egress.ts:207 | `sniffSocket(client, 5000)` | how long an outbound client may stay silent before sending its first bytes | refuses as unnamed: HTTP gets 403 "this connection names no host (no TLS server name, no Host header). Only named HTTP and TLS leave a workspace; an address alone does not."; TLS is closed silently | rarely (server-speaks-first protocols are refused anyway) | none | timeout | keep hard |
| workspace/svcnet.ts:133 | `head.length > 512` | svcnet request line | kills silently | no | none | resource protection | keep hard |
| workspace/sync.ts:29 | `timeoutMs: 300_000` (5 min) | every git command of the domain's sync (bundle create, rev-list, cat-file, delivery fetch) | kills; "could not bundle <repo>: <last 300 chars>" (to the agent on `desolate offer`/`sync`, else in wsd's log) | sometimes (offer fails) | none | timeout | setting or ask the person: a first bundle of a big repo can be slow |
| workspace/sync.ts:115 | `haves.slice(0, 500)` | root-held commits used as bundle exclusions | cut silently: bundle may be larger than needed (still correct) | no | none | resource protection | keep (or have the root send a bounded, recent set) |
| workspace/sync.ts:137 | `made.err.slice(-300)` | bundle error text | cut silently (tail) | yes | none | UX truncation | keep |
| workspace/sync.ts:174 | `Number(size) < 400` | which blobs are inspected as LFS pointers | cut silently: a pointer of 400+ bytes (LFS extensions) is not staged; the remote then refuses the push for a missing object | rarely | none | protocol fact (approximate) | keep, but one shared constant (written in 4 places), and the LFS spec's bound is 1024 bytes |
| workspace/sync.ts:340 | `done.slice(-500)` | the record of deliveries already imported | cut silently: past 500, an older delivery still in the inbox would be imported again (moving refs/remotes/root/<branch> back) | no | none | resource protection | keep; verify the root prunes deliveries below 500 |
| workspace/sync.ts:348, :358 | `timeoutMs = 120_000`; poll every 150 ms | the request channel to the root: every `desolate fetch`, `offer`, `spawn`/`close`, `issue offer` (all four callers in desolate.ts:525,574,647,677 use the default) | refuses: "the root did not answer. Is it running? On the host: desolate doctor"; the request file is removed, but the root may already have taken it (an offer made anyway). For `fetch`, the root refreshes the mirror from the remote, which for a big repo can exceed 2 min | yes, with a misleading reason | none | timeout | ask the person / eliminate: have the root acknowledge receipt, then wait on progress |
| workspace/wsd.ts:29 | `INTERNAL = new Set([15080, 15443])` | ports never offered for forwarding | skipped silently | no | "desolate's own listeners in the VM: never offered for forwarding." | other | keep; one shared constant |
| workspace/wsd.ts:33, :80 | `port >= 1024` | which VM listeners the host may forward / reserve | skipped silently: a dev server on a port below 1024 is never forwarded | yes (port doesn't forward) | "The ports ... a dev server holds: on loopback or every address, 1024 and up" | other | keep hard; say so somewhere the person looks |
| workspace/wsd.ts:118 | `timeoutMs: 5000` | `ss -H -ltn` | kills; empty listener list for that answer | no (ports blink) | none | timeout | keep |
| workspace/wsd.ts:175-180 | image `.slice(0, 80)`, user `.slice(0, 40)`, why `.slice(0, 300)`, folder `.slice(0, 300)` | the devcontainer summary the host shows (`desolate status`, dashboard) | cut silently. devcontainer.ts:794 builds `why` up to 160 + 240 + the log path, so the 300 cut drops "(the whole log: .../up.log in the workspace)" exactly when the reason is long. A folder of 300+ chars (owner 100 + repo 100 + branch 200 are allowed) is cut and the editor opens a path that does not exist | yes | none | UX truncation | eliminate: cut at display with a mark, never the log pointer or a path |
| workspace/wsd.ts:239 | `buffer.length > 65536` | a request line on wsd.sock | kills silently | no | none | resource protection | keep hard |
| workspace/wsd.ts:271, :280 | `sleep(500)` debounce; `sleep(3000)` | watching the domain's refs to write bundles for the root | polls every 3 s per repo | indirectly (an offer's branch reaches the root up to 3.5 s later) | "a shared .git on virtiofs delivers no file events across VMs"; "Debounce: a rebase moves a branch many times in a second."; decisions.md:702 "every 3 s" (matches) | polling interval | keep |
| workspace/wsd.ts:289 | `sleep(1000)` | the compose-port bridge tick (bridge.ts) | polls every second | indirectly (a new port forwards within 1 s) | bridge.ts header "Every second" | polling interval | keep |

## Shared (`shared/`) (38 rows)

A helper with a default has one row for its definition, which says how many callers rely on that default.

| file:line | value | what it limits | when hit | person sees it? | stated reason | kind | disposition |
|---|---|---|---|---|---|---|---|
| shared/text.ts:14-22 | `printable(value, max = 300, ...)`, pre-cut `.slice(0, max * 4)` | every piece of foreign text shown in a terminal or page: 63 call sites in release/, about 22 rely on the default 300; the rest pass 300 (12), 200 (11), 100 (10), 40 (5), 400 (3), 120 (3), 50 (2), 256 (2) | cut silently: no ellipsis, no "(cut)" | yes, constantly (reasons and warnings lose their ends) | file header: "not too long"; in-source test pins the cut ("xxxxxxxxxx", max 4 gives "xxxx") | UX truncation (+ security: the sanitising is the point, the length is not) | eliminate the silent cut: keep the sanitising, mark any cut ("…"), and let the display wrap or cut |
| shared/run.ts:23, :39-46 | `RUN_MAX = 192 * 1024 * 1024` (192 MiB per stream) | output kept from any program run() runs | kills (SIGKILL); stderr gets "(more than 201326592 bytes of output: stopped)"; the call fails | yes, as a failure | "one that wrote without end grew a string in this process until V8 refused it, and the throw ... stopped the host's daemon (audit, 2026-11-20)"; decisions.md:1365 matches | resource protection | keep hard (number arbitrary, about V8's string limit); no caller passes `maxBytes` (about 50 direct run()/must() calls). Note: compares a string's UTF-16 length with Buffer chunk bytes, and run() has no default timeout |
| shared/run.ts:122 | `.slice(-2000)` | the error text of must() | cut silently (tail) | yes | none | UX truncation | keep |
| shared/run.ts:144 | `everyMs = 100` | waitFor() poll interval default | polls | no | none | polling interval | keep |
| shared/sniff.ts:18 | `LIMIT = 16 * 1024` | bytes read to learn the name a connection asks for (TLS SNI or HTTP Host); used by the host forwarder (host/daemon.ts imports it) and the egress relay | a TLS hello without SNI by then is `tls` with no name, an HTTP head past it takes the Host from the first 16 KiB or is refused as naming no one, otherwise `raw` | rarely (refusal page) | "if the request line never parses, or the head runs past LIMIT, they are HTTP that names no one (refused)... a 20 KB path and another site's cookies (audit, 2026-11-16)" | security bound | keep hard; principled: the TLS record maximum is 2^14 bytes, and node's default HTTP header limit is also 16 KiB |
| shared/sniff.ts:263-278 | `quietMs` (no default) | how long sniffSocket waits for first bytes; callers pass 400, 60_000, 600_000 (host/daemon.ts) and 5000 (egress.ts) | treats a silent client as raw | depends on caller | "A client that says nothing within `quietMs` is a raw one" | timeout | keep (caller-chosen) |
| shared/link.ts:115, :179 | `timeoutMs = 10_000` | the host/guest link handshake (both callers, host/daemon.ts:2855 and workspace/net/egress.ts:35, use the default) | kills the socket; egress then says "this workspace's proxy is not answering, or what answered was not it. On the host: desolate doctor" | yes, on a slow or loaded host | none | timeout | keep hard |
| shared/names.ts:15 | `SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/` (40 chars) | domain and workspace names (also agent names, event ids: agent-holder.py:44, events.ts:211) | refuses (each caller words it) | yes | names.ts:290 "VM names are short and opaque: Lima's socket paths cap at 104 bytes, and two slugs of 40 would not fit" (so VM names are hashed; 40 itself is a choice under the 63-char DNS label) | other | keep hard |
| shared/names.ts:112-113 | `name.length > 40` gives `name.slice(0, 33)` + 6 hex | the domain name `clone` makes from owner/repo | cut and hashed; the person sees the cut name | yes | "Too long for a slug: cut, and a hash of the whole keeps it apart" | other | keep (derived from SLUG) |
| shared/names.ts:156 | `value.length <= 200` | branch names desolate carries (offer, push, spawn, approval) | refuses, e.g. "'<b>' is not a branch desolate will carry" (workspace/desolate.ts) | yes | none | security bound | keep hard (git allows longer; 200 is arbitrary but generous) |
| shared/names.ts:332 | `value.length <= 120` | DESOLATE_HOSTNAME_SUFFIX | refuses at start | yes | none | security bound | keep hard |
| shared/names.ts:375-381, :416 | `EDITOR = { server: 31580, gate: 31581 }`; `DESOLATE_EDITOR_PORT ?? 31581` within 1024-65535; `ROOT_UI = { port: 31590 }` | the editors' host port (a setting already), the in-VM editor ports, the root UI port | refuses: "DESOLATE_EDITOR_PORT must be a port from 1024 to 65535, not '<v>'" | yes | "for a second stack beside the first"; pinned by in-source editorHostPort tests | other | keep (already a setting where it matters); 31581 is written again as a literal in workspace/bridge.ts:28 |
| shared/spawn.ts:30, :467 | `FRESH_MS = 15 * 60_000`; future skew `120_000` | how old (or how far ahead) a signed spawn/close request may be | refuses: "the request is too old (or from the future): ask again" | yes | "How long a signed request stays good: the host refuses one older than this, and one it has already run."; reference.md:502 "good for 15 minutes, once" (matches) | security bound | keep hard |
| shared/spawn.ts:31 | `LIMIT = { words: 64, word: 16_384, total: 65_536 }` | the command a spawned workspace runs | refuses, without saying which limit: the root answers "that is not a request desolate makes (desolate spawn --help)" (root/rootd.ts:82); the workspace side never checks first | yes, with an opaque reason | "bounded" (commandOf doc) | security bound | keep hard; check in `desolate spawn` and say which limit |
| shared/spawn.ts:150, :154 | `value.length > 16`; repo parts `{1,100}` | `--checkout`s per spawn | refuses: "a --checkout is not one desolate takes: ..." (no mention of 16) | yes | "at most 16" (doc comment) | security bound | keep hard; say the number |
| shared/actions.ts:27-29 | `/^[1-9]\d?$/` cpus, `/^[1-9]\d{3,5}m$/` memory, `/^[1-9]\d{1,3}g$/` disk | the dashboard's Resize | refuses: "the host does not do that" (host/daemon.ts:3210) for 100+ CPUs, under 1000 MiB, 1 TB+ memory or 10 TB+ disk; within those, size.ts LIMITS decide | yes | "a stopped workspace's size, whole" | security bound | keep; derive from size.ts LIMITS (two shapes of the same bound) |
| shared/actions.ts:49, :54 | `repos.length <= 20`; title `/^[\x20-\x7e]{1,80}$/` | the dashboard's Create domain | 21+ repos: "the host does not do that"; a title over 80 chars or with any non-ASCII character is dropped silently and the domain is made untitled | yes (title missing) | none | security bound | keep hard for repos; titles: refuse with a message instead of dropping |
| shared/actions.ts:130 | `value.length <= (command ? 200_000 : checkouts ? 8_000 : 200)` | each argument of a dashboard host action | a longer argument is dropped silently, then the action fails as "the host does not do that" | yes, opaque | "(A spawn's command and checkouts are the long arguments: JSON, bounded by shared/spawn.ts.)" | security bound | keep hard |
| shared/approval.ts:163 | `(0\|[1-9][0-9]{0,5})` | LFS objects one signed push can carry (at most 999,999) | refuses (approval text not parsed) | no one will hit it | none | security bound | keep hard |
| shared/approval.ts:259 | `--max-count=10000` | commits searched when deciding whether the remote's branch is a squash of the workspace's work | cut silently: past 10,000 commits a squash isn't recognised and the push is treated as not building on the remote | rarely | none | resource protection | keep hard |
| shared/envfile.ts:318 | `named.length < 8` padded with `-SECRET`; `.slice(0, 64)` | the secret name made from an .env key | cut silently: two keys sharing their first 64 characters map to the same secret | rarely | "at least 8 characters, as the root takes names" | other | keep hard, add a hash on cut (as domainNameFor does) |
| shared/events.ts:65, :304-311 | `PER_CHANGE = 200` | events emitted for one domain from one change of the root's state | cut silently: the rest are never emitted; a `desolate events --follow` script misses them | indirectly | "At most PER_CHANGE per domain: one domain's busy change must not push the others' events out (audit, 2026-11-16...)" | resource protection | keep hard, but emit a "dropped N" event |
| shared/events.ts:198, :211-212 | status `printable(..., 200)`; id `{1,40}`; issue title `printable(..., 256)` | fields of events | cut silently (title 256 equals the issue limit, so no cut) | yes (scripts) | none | UX truncation | keep (match the source limits) |
| shared/gate.ts:87, :93 | `site.slice(0, 40)`, origin `.slice(0, 80)` | header text in the editor gate's 403 reason | cut silently | yes (rare) | none | UX truncation | keep |
| shared/issues.ts:15 | `LIMIT = { title: 256, body: 65_536, labels: 20, label: 50, waiting: 50 }` | issues an agent offers: title, body, labels, issues waiting per domain (root/issues.ts:67) | refuses: "an issue needs a title, of at most 256 characters"; "the body is text, of at most 65536 characters"; "labels are a list, of at most 20"; "'<l>' is not a label desolate carries (at most 50 characters, no comma)"; "<domain> already has N issues waiting for the person" | yes (the agent) | reference.md:521-523 documents them | security bound | keep hard: title 256, body 65,536 and label 50 are GitHub's own limits (principled); 20 labels and 50 waiting are choices |
| shared/size.ts:16 | `LIMITS = { cpus: [1, 64], memoryMiB: [1024, 262_144], diskGiB: [30, 2048] }` | a workspace's size from flags, domain size, env or project | refuses: "CPUs must be from 1 to 64", "memory must be from 1 GiB to 256 GiB", "disk must be from 30 GiB to 2048 GiB" | yes | "(Disk from 30 GiB: every VM is cloned from a 30 GiB base, and a clone's disk can only grow.)"; pinned by in-source checkSize tests | resource protection | keep: the 30 GiB floor is a fact; the 64 / 256 GiB / 2 TiB ceilings are sanity bounds |
| shared/size.ts:100-104 | cpus `min(4, max(2, cores/2))`; memory `min(8192, max(3072, quarter))`; disk `30` | default workspace size | other: chosen size, overridable | yes (bootstrap says it) | "half the cores (2 to 4...), a quarter of the memory (3 to 8 GiB...), and 30 GiB of disk"; overridable by DESOLATE_WORKSPACE_CPUS/_MEMORY_MIB/_DISK_GIB; pinned by in-source defaultsFor tests; getting-started.md:162-163 matches | other | setting (already one) |
| shared/size.ts:326-336 | CPUs at most `cores`; memory at most `floor(memory * 3/4)` | what a project's devcontainer.json may ask for | lowered and says so: "<n> GiB memory: a workspace gets at most <m> GiB here, three quarters of this Mac's <t> GiB" | yes | "one that could take all of it could stall the Mac"; getting-started.md:181 matches | security bound (repository content is data) | keep hard; the 3/4 fraction could be a setting |
| shared/size.ts:229 | `.slice(0, 40)` | a bad size value quoted in a problem | cut silently | yes | none | UX truncation | keep |
| shared/stats.ts:39-67 | `p(text, max = 120)`; domain 40, title 80, repo 100, workspace 40, vm/state 20, color 10, status 200 | `desolate domain stats` lines | cut silently; a branch over 120 chars (200 allowed) is cut | yes (the agent) | none | UX truncation | eliminate the cut for names already bounded at source |
| shared/status.ts:208, :214-215 | file `8192` bytes (refused if larger); message `printable(..., 200, " ")`; updated `.slice(0, 40)` | a checkout's status as read by the root/host | a file over 8 KiB is ignored (no status shown); the message is cut silently at 200 (workspace/status:66 warns the writer: "the message is over 200 characters; it is shown cut") | yes | "A status file is written by a workspace, which may be hostile: ... a bounded size."; AGENTS.md:54 "One line, at most 200 characters" (matches) | security bound | keep hard (written in 5 places, see below) |
| shared/status.ts:291 | `readPlain(..., 16384, false)` | a checkout's note | cut silently at 16 KiB, possibly mid-character (the writer, workspace/status:84, warns "the note is over 16384 bytes; it was cut") | yes | none here | resource protection | keep hard; one shared constant |
| shared/status.ts:364-370 | `PACKED_MOST = 256 * 1024` | the packed-refs file read to learn a branch's commit | cut silently: a packed-refs over 256 KiB is not read at all, so every packed branch shows no commit. A repository with a few thousand tags or branches (about 60 bytes a line) is over it | yes (board and dashboard show the branch without its commit), unexplained | "a domain's file: a larger one is not read ... an agent could make this file large" | resource protection | eliminate: stream the file and stop at the wanted ref, or keep the cap but say why the commit is missing |
| shared/status.ts:378 | `packedCache.size > 500` gives `clear()` | the packed-refs cache | cleared whole (re-read next time) | no | none | cache lifetime | keep |
| shared/suede.ts:92 | `url.length > 500` | a dependency's remote address | refuses (null: not a remote) | rarely | none | security bound | keep hard |
| shared/suede.ts:259 | `tips.slice(0, 200)` | remote branch tips searched for a merge base in the `downstream/...` rule | cut silently: root/repos.ts:242 passes every branch of the mirror in refname order, so on a dependency with 200+ branches the release may be past the cut, and the push is refused with "it builds on nothing the remote has: a suede proposal builds on the dependency's release" | yes, wrongly | none | resource protection | eliminate: put the release branch first, or one `merge-base` against all tips |
| shared/terminal-filter.ts:107 | `csi.length < 256` | parameter bytes of one CSI sequence | other: past 256 the sequence is dropped whole | no | "Longer than any program writes: not held further, and not passed." | security bound | keep hard |
| shared/terminal-filter.ts:133 | `dropped > 65536` | an OSC/DCS string with no end | other: after 64 KiB the filter passes text again | maybe (OSC 52 copies over 64 KiB print as garbage) | "A string that never ends is not allowed to swallow the session: after 64 KiB the filter gives up on it and passes text again." | security bound | keep hard |

## Scripts (shell, Python, Swift, Dockerfile, workflows) (32 rows)

`agent-holder.py` is under Workspace, `terminal.py` under Git VM programs, and `secrets_addon.py` under Root.

| file:line | value | what it limits | when hit | person sees it? | stated reason | kind | disposition |
|---|---|---|---|---|---|---|---|
| workspace/status:66 | `[ "${#message}" -le 200 ]` | status message length | cut and says so: "desolate-status: the message is over 200 characters; it is shown cut" (the full text is stored; the cut is made by shared/status.ts:214 `printable(..., 200)`) | yes | none here; AGENTS.md:54 "One line, at most 200 characters" | UX truncation | keep (a status is a line), but fix the count: with `LC_ALL=C` (line 31) `${#message}` counts bytes, so 70 characters of non-ASCII text warn falsely |
| workspace/status:41, :82-84 | `NOTE_MAX=16384` | the status note (`desolate-note.md`) | cut and says so: "desolate-status: the note is over $NOTE_MAX bytes; it was cut" | yes | none (pinned by tests/v3/t1/status.test.ts:79 "a long note is cut, not refused") | UX truncation | setting or keep: 16 KiB is generous; `head -c` can split a UTF-8 character |
| workspace/status:99 | `head -c "$NOTE_MAX"` | each note shown by `status board` | cut silently | yes | none | UX truncation | keep (notes are already ≤ NOTE_MAX) |
| workspace/status:109 | `[A-Za-z0-9_-]\{1,40\}` | a worktree lock's owner name | ignored: the "(its workspace ... was removed)" mark is not shown | no | none | security bound | keep hard |
| workspace/editor.sh:109-113 | `seq 1 300` × `sleep 0.2` (60 s) | how long the editor server and gate get to start listening | refuses with a message: "editor: it did not start listening; see $DATA/server.log and $DATA/gate.log" plus the log's last 5 lines | yes | none | timeout | ask the person: a first start in a devcontainer can be slow; "still starting: keep waiting?" |
| workspace/editor.sh:66 | `seq 1 50` × `sleep 0.2` (10 s) | waiting for the old editor server to let go of its port | waits, then goes on (a new server may fail to bind) | no | none | timeout | keep, but check the port really is free before starting |
| workspace/editor.sh:104 | `seq 1 20` × `sleep 0.1` (2 s) | waiting for the old gate to let go of its port | waits, then goes on | no | none | timeout | keep |
| workspace/editor.sh:114 | `tail -5` | log lines shown when the editor did not start | cut and says where the rest is | yes | none | UX truncation | keep |
| root/start.sh:309-310 | `seq 1 100` × `sleep 0.1` (10 s) | the keyring's socket appearing | refuses with a message: "start.sh: the keyring did not start; see $SYS/keyring.log" + `tail -5` | yes (bootstrap) | none | timeout | keep, or 30 s: a cold VM under load can be slower |
| root/start.sh:328-329 | `seq 1 100` × `sleep 0.1` (10 s) | the pusher's and reviewer's sockets appearing | refuses with a message: "start.sh: the $name did not start; see $SYS/$name.log" | yes | none | timeout | as above |
| workspace/start.sh:64-65 | `seq 1 100` × `sleep 0.1` (10 s) | the workspace daemon's socket appearing | refuses with a message: "start.sh: the workspace daemon did not start; see /var/lib/desolate/wsd.log" | yes | none | timeout | as above |
| root/start.sh:321, :325 | `sleep 0.2` before, `sleep 0.5` after each run | restart loop for pusher/reviewer (one request per process) | retries forever, no backoff | no (log only) | "one request per process ... before each start every process of that user is killed" | retry policy | keep (by design), but a crashing service spins twice a second and fills its log |
| root/start.sh:341 | `sleep 2` | restart loop for rootd, stated, rootctl | retries forever, no backoff; logs "$name: ended with $? at ...; starting it again" | in the log | "rootd and the state service are kept running: if one ends, it is started again and its log says so" | retry policy | setting or keep; add backoff so a crash loop does not fill the disk |
| root/start.sh:135 | `sleep 1` | after killing old-code services before starting new ones | waits (assumes they are gone) | no | "services started from other code ... a fix means nothing until what runs is the fixed code" | timeout | eliminate: wait for the pids/sockets to go |
| root/start.sh:26-27; workspace/start.sh:24-25 | `MaxSessions 1000` | sshd sessions per connection (Lima multiplexes over one) | refused by sshd past it | no | "sshd allows ten sessions on a connection by default ... the eleventh was refused (an audit on the M1)" | resource protection | keep (raised from a default that bit); written twice |
| image/provision.sh:118, :124-127 | `curl -fsSL -m 600` | download of the editor server (VSCodium REH) | other: a timeout is treated as "no route" and the image is built **without an editor**: "    NOT INSTALLED: could not download $url"; editor.sh later says "editor: this image has no editor: ..." | yes, but late (at the first `desolate editor`) | "No route to the release (the agent's sandbox). The image is still usable for everything but P1's editor, and says so" | timeout | ask the person (or fail on the Mac): on a slow Mac link, 10 minutes silently costs the editor; only the sandbox path should degrade |
| image/build.sh:24, :31, :117 | `DISK_GB=8` (`--disk-gb`) | size of `disk.raw` for the qemu backend | other: the disk is that size | no | none | other (VM size) | setting (already a flag); note shared/size.ts:15 says "every VM is cloned from a 30 GiB base", which is the Lima path, not this one |
| image/build.sh:59, :91 | `tail -20`, `tail -15` | log lines shown on a failed build | cut and says where the full log is | yes | none | UX truncation | keep |
| git/suede-upstream.sh:167, :200-233 | `WAIT_FOR="${SUEDE_UPSTREAM_WAIT:-180}"` | how long `upstream` waits for the dependency's PR | waits, then exits 2 with "No PR after ${WAIT_FOR}s. Follow the Action at https://github.com/$dep_slug/actions (branch: $BRANCH)." | yes ("Waiting for the PR (up to ${WAIT_FOR}s; --no-wait skips this) ...") | none | timeout | keep (already a setting via env and --no-wait; says what to do) |
| git/suede-upstream.sh:168, :204, :215 | `INTERVAL="${SUEDE_UPSTREAM_INTERVAL:-5}"`; two API calls per pass | GitHub API polling | retries | no | none | polling interval | setting already; but 180/5 × 2 = 72 calls, over GitHub's 60/hour for unauthenticated calls, and errors are swallowed (`2>/dev/null ... \|\| true`): without GH_TOKEN a full wait can run out of quota and only print "No PR after 180s" |
| recipes/issues.sh:42 | `gh issue list ... --limit 100` | labelled open issues read per pass | cut silently | no | none | other (page size) | eliminate (page, or `--limit` large): worse than a cut, an issue beyond the 100th that has a workspace is taken as **closed** (lines 49-55) and its agent is stopped |
| recipes/issues.sh:25, :63 | `max=3` (`--max`) | issue workspaces working at once | waits: "--max $max are working: #$n waits for the next pass" | yes | usage line, docs/agents.md:171 | resource protection | setting (already a flag) |
| recipes/agent.sh:39-41; recipes/claude.sh:58-60 | `${#base} -gt 30`, `${base:0:31}`, `${#whole} -ge 12` | workspace name made from the task's first words | cut silently (at a word boundary when the cut keeps ≥ 12 chars) | yes, in the name | "at most 30 characters, in whole words where it can" | UX truncation | keep; the real bound is 40 (shared/names.ts SLUG), so 30 is a choice; written twice |
| recipes/agent.sh:45; recipes/claude.sh:64 | `for n in 2 3 4 5 6 7 8 9`, `${base:0:27}-$n` | numbering when the name is taken | other: after `-9` the last candidate is never checked, so `desolate up` fails on a name in use | yes, as `up`'s error | none | other | eliminate: loop until free (or ask `up` for a free name) |
| recipes/suede.sh:67-68 | `cut -c1-20`, `${commit:0:8}` | the `up-<dep>-<sha8>` workspace name | cut silently | yes | none | UX truncation | keep (fits the 40-char slug) |
| recipes/echo-agent.sh:9, :22 | `ECHO_AGENT_PACE:-0.6`; `while sleep 3600` | the stand-in agent's pace; keeping it alive | other | demo only | none | other | keep (demo) |
| workspace/git-remote-desolate-mirror:22 | `tail -n 2` | the root's error when the mirror could not be refreshed | cut silently (last two lines, joined) | yes: "desolate: the root could not refresh %s from the remote (%s); fetching what the mirror has" | none | UX truncation | keep (a fetch still happens); maybe point at where the full error is |
| workspace/net/up.sh:28 | `--local-ttl=60` | TTL of the placeholder DNS answer (every name → 198.18.0.1) | other | no | none | cache lifetime | keep (the answer never changes) |
| root/proxy/secrets_addon.py:285-286 | `[a-z0-9-]{1,80}` | workspace name on a tunnel | refuses with 403: "desolate: this proxy is reached only through a workspace's own proxy" | no (a workspace's request fails) | none | security bound | keep hard; 80 is looser than the 40 everywhere else, harmless but arbitrary |
| root/proxy-user.sh:19; root/start.sh:78, :205 | `^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$` plus no `xn--`, `---`, two `--` | domain name: 1 to 40 characters | refuses with a message ("proxy-user.sh: '$DOMAIN' is not a domain name") or skips the domain silently (start.sh) | in start.sh, no | none | security bound | keep hard; written in three shell places beside shared/names.ts:15 |
| root/proxy-user.sh:22 | `dsp-` + `sha256 \| cut -c1-10` | the proxy's Linux user name per domain | other | no | none | protocol fact (Linux user names ≤ 32) | keep |
| completion.bash:14 | `^[a-z0-9][a-z0-9-]{0,39}$` | names offered by TAB completion | skipped silently | no | "a name is offered only if it is a slug" | security bound | keep hard; a copy of shared/names.ts:15 SLUG |

## UI pages (`host/approve-ui`, `host/git-ui`, `root/ui`, `shared/ui`) (30 rows)

CSS is included only where it hides content with no way to see the rest. A scrollable `max-height` is not a cut.

| file:line | value | what it limits | when hit | person sees it? | stated reason | kind | disposition |
|---|---|---|---|---|---|---|---|
| root/ui/dashboard.js:525, :533, :541 | `review.commits.slice(0, 40)` | commits listed (and pickable) in a review | cut and says so: "and ${n} more" | yes; the 41st and older commits cannot be picked or seen alone | none | UX truncation | eliminate (scroll; the list is already a scroll box, `ol.commit-list` max-height 14em). And the list it cuts is itself capped at 200 by root/offers.ts:639 `--max-count=200`, so on a branch of 300 commits the head reads "All 200 commits, combined" and the pill "200 commits": a wrong label, the bug class the owner named |
| root/ui/dashboard.js:261-278 | `DIFF_LINES = 3000` | lines of a diff drawn at first | cut and says so: "The first 3,000 of N lines." with a "Show the rest" button | yes | "a long diff drawn again each time cost up to half a second, and threw away where the person had scrolled to" | UX truncation | keep (the right pattern: it pages) |
| root/ui/dashboard.js:590 | `reviewing.diff.truncated` (server: root/offers.ts:770 `DIFF_LIMIT = 1024 * 1024`) | the review diff as sent | cut and says so: "The diff is longer than is shown here. Read the rest with git, in `desolate root shell`, before you push." | yes | (server side) decisions.md:261 "capped at 1 MiB" | UX truncation | eliminate (fetch more on demand, as DIFF_LINES does), or keep with the message |
| root/ui/dashboard.js:117 | `setTimeout(..., 8000)` | how long an action's error stays on screen | other: the error line disappears after 8 s | yes, if they are looking; a refusal read late is gone | none | other (UX lifetime) | eliminate: keep it until dismissed or the next action |
| root/ui/dashboard.js:113 | `setTimeout(..., 1500)` | a button stays disabled ("Label...") after its action ended | waits | yes | none | other (debounce) | keep |
| root/ui/dashboard.js:978 | `setTimeout(listen, 1500)` | reconnecting the event stream after an error | retries forever at 1.5 s, no backoff, nothing shown | no: a dead root looks like a quiet dashboard | none | retry policy | ask the person / show it: "lost the root; retrying" after a few tries, with backoff |
| root/ui/dashboard.js:211 | `n * m > 40_000` | pairing removed with added lines for side-by-side | other: degrades silently to pairing in order | yes, as a worse side-by-side view of a big hunk | "a small dynamic program; a long run is paired as it comes" | resource protection | keep |
| root/ui/dashboard.js:676 | `{ cpus: 2, memoryMiB: 4096, diskGiB: 30 }` | the Resize form's starting values when the workspace's size is unknown | other | yes | none | other | eliminate: use shared/size.ts `defaultsFor` (on an 8 GiB Mac it gives 3072 MiB, not 4096) |
| root/ui/dashboard.js:680-682 | CPUs 1–64; memory 1–256 GiB; disk current–2048 GiB | Resize form input bounds | refuses (browser form validation) | yes | (server) shared/size.ts:15 "Disk from 30 GiB: every VM is cloned from a 30 GiB base" | security bound (sanity) | keep, but read from one place: a copy of shared/size.ts:16 LIMITS |
| root/ui/dashboard.js:862 | `maxlength: "80"` | a new domain's title | refuses to take more characters | yes | none | UX truncation | eliminate the mismatch: the root keeps up to 200 (root/domains.ts:120 `.slice(0, 200)`, silently) |
| root/ui/dashboard.js:362 | `maxlength: "256"` | an issue draft's title | refuses to take more | yes | (server) shared/issues.ts:15 `LIMIT.title: 256`, "an issue needs a title, of at most 256 characters" | security bound | keep hard (GitHub-ish bound); a copy of the server's |
| root/ui/dashboard.js:791 | `.slice(0, 40)` | the default workspace name made from branch names | cut silently | yes, in the name | none | UX truncation | keep (the 40-char slug) |
| root/ui/dashboard.js:848, :861 | `pattern: "[a-z0-9][a-z0-9-]{0,39}"` | workspace and domain names typed | refuses (form validation) | yes | none | security bound | keep hard; a copy of shared/names.ts:15 SLUG |
| root/ui/dashboard.js:507 | `changes.length > 6` | when the "filter files" box appears | other | yes | none | other | keep |
| root/ui/dashboard.css:233 | `text-overflow: ellipsis` on `button.commit-pick .subject` | a commit's subject in the review's list | cut silently; the button's title is "Its changes alone ...", not the subject | yes, the subject ends in "…" | none | UX truncation | eliminate: put the subject in the title, or wrap |
| root/ui/dashboard.css:147 | `text-overflow: ellipsis` on `.named .value` | a named repo/branch/commit pill | cut silently; title is "the repo" etc., not the value (dashboard.js:37) | yes | none | UX truncation | eliminate: title = the full value |
| host/approve-ui/approve.js:130 | "Too large to show here (over 20 000 lines)"; "Cut at 256 KiB" | the push diff on the approval page | cut and says so (the page states the server's numbers) | yes | (server) root/reviewer.ts:833 `DIFF_MOST = { bytes: 256 * 1024, lines: 20_000 }` | UX truncation | keep the message, but take the numbers from the answer: they are written twice |
| host/approve-ui/approve.js:28, :74 | `READY_MS = 1000` | the page must have had attention, and the card been unchanged, this long before a button arms | waits ("arming in a moment...") | yes | "a page that just got it cannot arm for a second anyway" | security bound | keep hard (anti-clickjacking); principled in kind, the number is a choice |
| host/approve-ui/approve.js:29, :274 | `DWELL_MS = 300` | the pointer must rest on an armed button this long before a click counts | refuses silently (the click is ignored) | yes, as a click that did nothing | none in code | security bound | keep hard; say "hold still" on an ignored click |
| host/approve-ui/approve.js:83 | `setInterval(..., 250)` | re-checking that unarmed cards stay disarmed | polling interval | no | none | polling interval | keep |
| host/approve-ui/approve.js:377 | `setTimeout(poll, 1000)` | polling `/pending` and `/issues` | polling interval (two requests a second while open) | yes: "This page checks every second." | none | polling interval | eliminate: an event stream, as the dashboard has |
| host/approve-ui/secrets.js:147 | `file.size > 65536` | a .env file picked for import | refuses with a message: "that file is over 64 KiB: not a .env" | yes | none | security bound | keep hard; a copy of host/env-import.ts:21 `ENV_MAX = 64 * 1024` |
| host/approve-ui/secrets.html:24-25 | `pattern="[A-Z][A-Z0-9_\-]{7,63}"`, "8 to 64 of A-Z, 0-9, _ and -, a letter first" | secret name typed | refuses (form validation) | yes | none | security bound | keep hard; third copy (secret-store.ts:45, secrets_addon.py:71) |
| host/git-ui/git.js:14 | `scrollback: 5000` | lines kept in the browser's git terminal | cut silently (oldest lines) | yes, scrolling up stops | none | resource protection | setting |
| host/git-ui/git.js:33 | `1500` ms | when "Starting the git VM and your clone there: the first time takes a minute or two..." appears | other (a notice, not a stop) | yes | none | other | keep (the pattern the owner wants: says it is slow, does not stop) |
| shared/ui/highlight.js:12, :49 | `WAIT_MS = 2500` | the syntax-colour worker per request | kills the worker; the diff stays plain | no (colour just absent) | "a line crafted to make one backtrack must cost nothing but the colour" | security bound | keep hard (attacker-controlled text); the number is a choice and a slow Mac may lose colour on big diffs |
| shared/ui/highlight.js:13, :73 | `MOST = { bytes: 1024 * 1024, lines: 40_000 }` | diffs too big to colour | other: shown plain | no | none | resource protection | keep (note: `text.length` counts UTF-16 units, not bytes) |
| shared/ui/markdown.js:24, :36 | `DEEPEST = 8` | inline nesting (emphasis in links in ...) | other: deeper text shown as plain text | no | none | security bound | keep hard (agent-written Markdown) |
| shared/ui/markdown.js:252, :288 | `depth < 12` | block nesting (quotes, lists) | other: deeper blocks shown as one plain paragraph | no | none | security bound | keep hard |
| shared/ui/markdown.js:134, :143 | `source.slice(i, i + 2100)` | how much is scanned for an autolink | cut silently: a URL over ~2100 characters is linked **cut**, the rest left as text | yes (a link to the wrong address) | none (2100 ≈ a common browser URL limit) | resource protection | keep, but do not link a cut URL (leave it as text) |

## The same limit written in more than one place

- **2 GiB pack or bundle.** Four literals:
  - `root/reviewer.ts:48` (`LIMIT.bundle`) and `:514` (`packBytes`).
  - `root/pusher.ts:71` (`LIMIT.pack`).
  - `host/git-vm.ts:271`.
  - `root/outbox.ts:28` (`LIMIT.bundle`).

  Only `reviewer.ts:584` says that the reviewer's cap and the pusher's must agree ("As large as the pusher takes, and no larger"). `decisions.md:284` and `:341` say 2 GiB, which matches.
- **5 GiB LFS object.** Five literals: `root/ops.ts:61` (`LFS_MOST`), `root/outbox.ts:28`, `host/git-vm.ts:272`, `root/reviewer.ts:494`, `root/pusher.ts:72`. The pusher's message at `:844` repeats it.
- **2000 LFS objects per push.** `root/pusher.ts:73` and `host/git-vm.ts:273` refuse; `root/offers.ts:245` (`request.lfs.slice(0, 2000)`) cuts silently. The reviewer has no such cap, and `shared/approval.ts:163` lets an approval name up to 999,999.

  In `reviewer.ts`, 2000 is also used three more times, each meaning something else: the refs cap (49), the sensitive-files cap (1032-1036) and the header batch size (1064).
- **The JSON request cap differs between the two out-boxes.** `host/git-vm.ts:270` allows 64 KiB and `root/outbox.ts:28` allows 1 MiB. `decisions.md:284` quotes "JSON 1 MiB".
- **Header lines on sockets, each with its own cap:**
  - reviewer 64 KiB (`reviewer.ts:47`)
  - pusher 1 MiB (`pusher.ts:70`)
  - review-client 1 MiB (`review-client.ts:187`)
  - keyring 4096 bytes (`keyring.ts:941`)
  - host git-vm 64 KiB (`host/git-vm.ts:270`)
- **The push-summary timeouts, nested and written separately:**
  - page 90 s (`host/approve-web.ts:217`)
  - `timeout 95` (`root/review-ask.ts:82`)
  - spawnSync 100 s (`:94`)
  - host 120 s (`host/daemon.ts:219`)
  - inside it, git timeouts of 120 s, 300 s, 600 s and 1,800 s (`reviewer.ts`) that cannot fire

  The 60 s wait for the summary lock (`reviewer.ts:1272`) also runs inside the 95 s.
- **The push approval window:**
  - challenge 120 s (`keyring.ts:166`)
  - approval 120 s / 8 uses (`keyring.ts:161`)
  - claimed approval 35 min (`keyring.ts:157`)
  - root list 120 s (`root/approvals.ts:21`)
  - wait 110 s (`root/raw-push.ts:26`, can be set with `DESOLATE_APPROVAL_WAIT_MS`)
  - Touch ID 120 s (`host/approver.ts:231, 343`)
  - the text "two minutes" in `host/approve-web.ts:656`
- **30 minutes for a push**, written separately in five places: `pusher.ts:963` (LFS), `pusher.ts:989` (ssh), `reviewer.ts:1358`, `review-client.ts:128`, `reviewer.ts:339`. `keyring.ts:157` `CLAIMED_MS` of 35 min depends on them but does not say so.
- **The diff cap differs by page.** The approval page uses 256 KiB and 20,000 lines (`reviewer.ts:833`). The dashboard uses `DIFF_LIMIT = 1024 * 1024` (`root/offers.ts:770`). `host/approve-ui/approve.js:130` repeats "over 20 000 lines" and "Cut at 256 KiB" as literal text.
- **Commit caps across the review path, three numbers for one list:**
  - 200 (`root/offers.ts:639`)
  - 50 (`reviewer.ts:50`, `LIMIT.commits`)
  - 40 picks (`root/ui/dashboard.js:525`)

  `desolate review` also lists 30 (`host/push.ts:260`), and `desolate upstream` lists 50 (`git/upstream.ts:782`).
- **One domain's refs.json, read twice with different silent caps.** `root/outbox.ts:217-223` uses 1 MiB / 5000 refs and feeds git. `root/outbox.ts:458-473` uses 256 KiB / 200 branches and feeds the dashboard and `desolate branches`.
- **The LFS pointer cutoff `< 400` bytes**, in four places: `workspace/sync.ts:174`, `git/git-remote-desolate-out.ts:148`, `root/offers.ts:482`, `root/reviewer.ts:463`. git-lfs itself reads up to 1024.
- **The 40-character slug** has its own copy of the rule in:
  - `shared/names.ts:15` (`SLUG`)
  - `root/proxy/proxy.ts:45`, `root/proxy/secret-store.ts:47`, `root/proxy/manage.ts:278`
  - `root/ops.ts:611`
  - `root/proxy-user.sh:19`, `root/start.sh:78, :205` (a stricter form)
  - `completion.bash:14`
  - `root/ui/dashboard.js:848, :861`
  - `workspace/agent-holder.py:44`
  - `workspace/status:109`
  - `git/git-remote-desolate-out.ts:46`
  - `workspace/desolate.ts:634` (`.slice(0, 40)`)
  - `shared/events.ts:211`
  - as message text in `root/domains.ts:58, :72`, `root/rootctl.ts:72` and `host/repos.ts:114`

  The secrets add-on allows a workspace name of 80 characters (`secrets_addon.py:285`). VM names are 60 characters in two places (`proxy/manage.ts:49`, `proxy/proxy.ts:47`).
- **The 200-character status**, in five places: `AGENTS.md:54`, `workspace/status:66` (counts bytes), `shared/status.ts:214` (counts code points), `shared/events.ts:198`, `shared/stats.ts:67`. The 16384-byte note is in two: `workspace/status:41` and `shared/status.ts:291`.
- **Domain title.** The dashboard input allows 80 (`dashboard.js:862` `maxlength 80`); the root keeps 200 (`root/domains.ts:120`).
- **Issue title of 256**, in two places: `dashboard.js:362` and `shared/issues.ts:15`.
- **.env size of 64 KiB**, in two places: `host/env-import.ts:21` (`ENV_MAX`) and `host/approve-ui/secrets.js:147` (`65536`, "over 64 KiB"). The body cap around a 64 KiB secret is 70_000, which JSON escaping can exceed (`host/approve-web.ts:477`).
- **The secret name rule** (8 to 64 characters), in three places: `root/proxy/secret-store.ts:45`, `root/proxy/secrets_addon.py:71`, `host/approve-ui/secrets.html:24-25`.
- **Audit log rotation at 64 MiB.** `root/proxy/proxy.ts:75` and `root/proxy/secrets_addon.py:250` both write one `audit.log` and rotate it independently.
- **The default of 100 audit entries**, in two places: `root/ops.ts:234` and `root/proxy/manage.ts:301`.
- **The sign-in code.** `{ ttlMs: 60_000, most: 32 }` is in both `host/signin.ts:22-24` and `root/stated.ts:1155`.
- **VM size 2 CPU / 2048 MiB / 30 GiB:**
  - `host/stack.ts:141-143`
  - `host/vm/lima.ts:285-286`, `:306-307`, `:52` (`BASE_DISK_GIB`)
  - `shared/size.ts:16`, `:103`
  - `dashboard.js:676` (fallback `{2, 4096, 30}`, which differs from `shared/size.ts:99` `defaultsFor`)
  - `image/build.sh:24` `DISK_GB=8`, for qemu's disk.raw
- **Workspace size bounds, in two shapes.** `shared/size.ts:16` `LIMITS` and `shared/actions.ts:27-29` (cpus 1-99, memory 1000-999999 MiB, disk 10-9999 GiB). `dashboard.js:680-682` copies the first.
- **Spawn command bounds**, in two places: `shared/actions.ts:130` (200_000 / 8_000 characters of JSON) and `shared/spawn.ts:31, :150` (64 words, 16_384 per word, 65_536 total, 16 checkouts).
- **The spawn replay window of 30 min** (`host/spawn.ts:207`, `root/rootd.ts:103`, `root/stated.ts:795`) is derived by hand from `FRESH_MS` 15 min plus 120 s of skew (`shared/spawn.ts:30, 467`).
- **Port pairs and addresses that must match:**
  - Long poll: the root's 50 s (`root/stated.ts:1244, :1260`) must stay under the host's 70 s (`host/daemon.ts:3296, :3325`).
  - Host facts are sent every 45 s (`daemon.ts:3138`), against the root's `hostConnected` of 150 s (`stated.ts:585`).
  - Egress 15080/15443: `workspace/net/up.sh:52-61`, `workspace/net/egress.ts:387-388`, `workspace/wsd.ts:29`, `workspace/bridge.ts:28`.
  - Editor 31580/31581: `workspace/editor.sh:24-25`, `shared/names.ts:375`, `workspace/bridge.ts:28`.
  - Link address `192.168.5.100:15000`: `host/vm/lima.ts:71`, `host/vm/qemu-wrapper.sh:26`.
  - Lima resolvers: `root/wall.sh:27-28`, `host/bootstrap.ts:565`.
  - `MaxSessions 1000`: `root/start.sh:26-27`, `workspace/start.sh:24-25`.
- **Host/guest timeout pairs:**
  - devcontainer 3_700_000 around 3_600_000 (`host/workspaces.ts:352`, `workspace/devcontainer.ts:759`)
  - init 900_000 around 600_000 (`host/workspaces.ts:326`, `workspace/init.ts:23`)
  - Lima `--timeout 10m/20m/30m` with node's 900_000 / 1_500_000 / 2_400_000 (`host/vm/lima.ts:741, 767, 815-835`)
  - git VM push wait of 20 min (`host/git-vm.ts:461`, `git/git-remote-desolate-out.ts:26`)
  - git VM fetch of 10 min (`host/git-vm.ts:380`, `git/desolate.ts:133`)
- **Smaller copies:**
  - Terminal size 1000×500: `host/git-web.ts:369-371`, `git/terminal.py:65`, `workspace/agent-holder.py:209`.
  - A ref of at most 200: `host/upstream.ts:297`, `git/upstream.ts:88`.
  - The port holder lookup (lsof `timeout: 3000`, `printable(command, 40)`): `host/daemon.ts:2509` and `host/held-ports.ts:80-93`.
  - Port bounds `>= 1024 && <= 65535`: `host/daemon.ts:484, 1894`, `host/held-ports.ts:27`, `workspace/bridge.ts:137, :162`, `workspace/wsd.ts:33, :80`, `workspace/devcontainer.ts:577`, `shared/names.ts:378`.
  - `formatSize` (`host/approver.ts:156-159`) and `formatBytes` (`host/push.ts:672-675`) are the same function.
  - The workspace-name cut to 30: `recipes/agent.sh:39-45`, `recipes/claude.sh:58-64`.
  - The 10-second socket waits: `root/start.sh:309, :328`, `workspace/start.sh:64`.
  - The devcontainer status line, cut twice: 500 (`host/workspaces.ts:356`), then 400 (`host/daemon.ts:2811`).
  - The reviewer's stderr, cut twice: `root/review-ask.ts:27` `.slice(-200)`, then `host/daemon.ts:234` `printable(…slice(-200), 200)`.
  - The review ref's random part: `root/review-client.ts:112` `randomBytes(8)` and `root/reviewer.ts:280` `[0-9a-f]{16}`.

## Docs, comments and transcripts that differ from the code

- `docs/v3/decisions.md:261` says a diff is "capped at 1 MiB". That is true of the dashboard (`root/offers.ts:770`). The approval page cuts at 256 KiB, counted in characters (`root/reviewer.ts:833, 1025`).
- `docs/v3/decisions.md:241` and `:470` say an approval lasts "at most two minutes, eight signatures". Once the pusher claims it, it lasts 35 minutes (`root/keyring.ts:157, 822`). `decisions.md:506` mentions the claim, so `:241` and `:470` are stale.
- `release/docs/getting-started.md:461` says "it waits two minutes", but `root/raw-push.ts:26` waits 110 s by default.
- `release/docs/agents.md:15` says `desolate agent log` shows "its last 2 MiB". Once the log has reached `LOG_MOST` (64 MiB), it shows the last 2 MiB before the cap, which goes stale.
  - The holder's own docstring (`workspace/agent-holder.py:14`) says "Everything it prints is also kept…". Line 245 says it is kept "in its log for good". Both are false past 64 MiB.
- `docs/v3/decisions.md:969` says stop "kills the client 3 s later". The code SIGKILLs the agent's process group (`workspace/agent-holder.py:224`).
- `release/AGENTS.md:111` and `release/docs/reference.md:521` give the issue body as "64 KiB". `shared/issues.ts:15` counts 65,536 characters (UTF-16 units), and its message says "65536 characters".
- `docs/v3/decisions.md:680` says one change yields "at most 200 events". The code (`shared/events.ts:304`) allows 200 per domain per change.
- `docs/v3/decisions.md:284` gives the out-box JSON cap as "JSON 1 MiB". That matches `root/outbox.ts:28`, but the git VM's out-box on the host (`host/git-vm.ts:270`) uses 64 KiB.
- `release/docs/reference.md:28`, "each commit whole … the first 50", matches the each-commit text, which is the oldest 50. The commit list above it (`reviewer.ts:918`) is the newest 50. The number agrees, but the two lists show different commits.
- Comment against code in `host/daemon.ts`:
  - `:2556-2557` says a silent client "is waited for, up to two minutes", but the code waits `60_000` (`:2572`).
  - `:2520-2521` says the raw ports include "ones learned from bytes that were not HTTP or TLS", but nothing learns them (`:476`, `:725`, and `decisions.md:1305`).
- `root/intake.ts:23` refuses a bundle header over 4 MiB as "not a v2 bundle", which names the wrong cause.
- Docs that match the code: decisions.md 95 s (`:1475`), 30 requests a minute (`reference.md:319`, `decisions.md:714`), ports 80 and 443 (`reference.md:295`, `AGENTS.md:121`), 64 connections (`incidents.md:220`), 192 MiB (`decisions.md:1365`), "up to three minutes" for suede (`suede.md:74`).
- I found no transcript under `tests/v3/transcripts` quoting these limits' messages. The dogfood reports (`~/dogfood-runs/2026-11-20-ux/*/REPORT.md`) were not checked line by line against the code.

## Limits with no bound at all (for completeness)

- `shared/run.ts`: `run()` has no default timeout, and none of its roughly 50 direct callers passes `maxBytes`. The only bound is `RUN_MAX` (192 MiB, `shared/run.ts:23`). The root-state carry sends the whole state as base64 on stdout, so it is bound by that value (`host/carry.ts:54-60`).
- `git/terminal.py:56-58`: an unterminated protocol line grows without a cap (`pending += chunk`). `workspace/agent-holder.py:199` cuts the same thing at 200,000 characters.

## Facts, not choices

These are fixed by a format, a protocol or the platform. They are listed so they don't hide the decisions above.


### Host

- host/daemon.ts:190; host/image.ts:39, 107: `digest("hex").slice(0, 16)`: 64-bit fingerprint of code / image inputs.
- host/daemon.ts:663, 669: `[A-Z]{1,16}` HTTP method length in the request-line sniff; daemon.ts:634 `[A-Z]{3,10}`.
- host/daemon.ts:1872, 3757; host/workspaces.ts:390; host/signin.ts:47: `[0-9a-f]{48}`: the 24-byte tokens (made at bootstrap.ts:159, daemon.ts:3463, signin.ts:38 with `randomBytes(24)`).
- host/daemon.ts:2398: `[0-9a-f]{16}` state tag format.
- host/daemon.ts:2316, 2428: HTTP Content-Length framing, newline (10) framing of the pusher log.
- host/vm/lima.ts:793, 977: link token `randomBytes(16)` / `[0-9a-f]{32}`; host/spawn.ts:71 workspace key `randomBytes(32)`.
- host/vm/lima.ts:637: unix socket path limit `103` (darwin) / `107` bytes: sun_path 104/108 incl. NUL.
- host/vm/lima.ts:574: minimum Lima `2.3` (vz) / `2.0` (qemu): "vz needs 2.3: on 2.1.2 a confined guest's pings were answered".
- host/vm/lima.ts:280; host/vm/types.ts:112: port range `1..65535`.
- host/vm/lima.ts:71 `tcp:192.168.5.100:15000` (qemu guestfwd address for the link) and host/bootstrap.ts:271, 277, 565 `192.168.5.2`/`.3`: Lima's user-network addresses.
- host/vm/lima.ts:533: `began + 1000`: ps reports start time to the second.
- host/bootstrap.ts:32: `port: 22` (GitHub ssh).
- host/approver.ts:200, 227, 341; host/notify.ts:15; host/workspaces.ts:731: `slice(0, 12)` short commit/pack ids.
- host/approver.ts:157-159: KiB/MiB formatting (1024).
- host/image.ts:145: `[0-9a-f]{64}` sha256sum lines.
- host/agent.ts:233: ISO timestamp format.

### Host pages, push and domains; git VM programs

- host/approve-web.ts:69,73; host/git-web.ts:47,51,178: page credentials and shell tokens are `randomBytes(24)` (48 hex).
- host/approve-web.ts:93; host/git-web.ts:95: cookie names carry 12 hex of sha256 of the token.
- host/approve-web.ts:114: issue id format `[0-9a-z]{6,12}-[0-9a-f]{8}`.
- host/approve-web.ts:376,576,607,647: HMAC-SHA256 tokens are 64 hex; a push nonce is 32 hex.
- host/git-web.ts:177,268,291; host/git-vm.ts:682; git/desolate.ts:93; git/git-remote-desolate-out.ts:347: request/session ids are 8 random bytes (16 hex).
- git/git-remote-desolate-out.ts:28: git-lfs pointer format (spec v1, sha256 oid 64 hex).
- git/git-remote-desolate-out.ts:110,139,346: SHA-1 object ids, 40 hex.
- git/git-remote-desolate-out.ts:373; git/lfs-file.ts:62: LFS store layout `oid[0:2]/oid[2:4]/oid`.
- git/lfs-file.ts:68: 1 MiB copy buffer (chunk size, not a limit); git/terminal.py:43,53: 64 KiB read chunks (not limits).
- host/push.ts:462: `--expect` takes 7 to 40 hex (git's short-id minimum to a full SHA-1).
- `.slice(0, 12)` everywhere (host/push.ts:83,230,261; git/upstream.ts:169-253; host/git-vm.ts:428): 12-hex abbreviation for display.
- host/templates.ts:65,69: template key 16 hex; template VM name `t` + 9 hex "as long as a workspace's VM name (the socket-path check counts on it)" (vz socket path at most 103 bytes).
- host/repos.ts:44: 8 hex of sha256(hostname) in a deploy key's title.
- git/upstream.ts:576,849: pins.env SUEDE_UPSTREAM_SHA256 (64 hex) and SUEDE_COMMIT (12 hex).
- host/push.ts:675-677: KiB/MiB formatting; host/domains.ts:335-338,467: s/min/h/d units.
- host/cli.ts:112-113: exit codes 0, 1, 64, 75, 77, 78, 79; git/terminal.py:70 SIGKILL.

### Root

- root/stated.ts:83, :1158, :1168: `[0-9a-f]{48}` host token and sign-in code (24 random bytes, a choice made once).
- root/stated.ts:147: cookie name `desolate_ui_` + 12 hex of a sha256; :636 state tag 16 hex.
- root/stated.ts:1184: sign-in digest `[0-9a-f]{64}` (sha256).
- root/proxy/as-proxy.ts:28: proxy user `dsp-` + 10 hex (Linux user names have a 32-character cap).
- root/proxy/as-proxy.ts:101, :106 and secrets_addon.py:64: link token, `randomBytes(32)`, 64 hex.
- root/proxy/proxy.ts:91-103: internal IPv4 ranges (10/8, 127/8, 100.64/10, 169.254/16, 172.16/12, 192.168/16, 192.0/24, 198.18/15, 224+).
- root/forge-pin.ts:28: port ≤ 65535; :37: a known_hosts line has at least 3 fields.
- root/offers.ts:463: LFS pointer format (`oid sha256:` 64 hex); :472 object ids 40 to 64 hex; `4b825dc642cb6eb9a060e54bf8d69288fbee4904` (the empty tree), several places.
- root/offers.ts:106, ops.ts:440, send.ts:196-197: LFS store layout `oid[0:2]/oid[2:4]/oid`.
- root/intake.ts:28: `# v2 git bundle` header.
- root/ops.ts:381-382, :402, :408: git-VM bundle names 16 hex; ref `refs/desolate/out/<16 hex>`.
- root/offers.ts:924: `--unified=3` (git's default context).
- Name patterns (choices, enforced as shapes): outbox.ts:51 file names to 200 characters; outbox.ts:273 and rootd.ts:830 queue names `{1,60}`; manage.ts:49 and proxy.ts:47 VM names `{1,60}`; secrets_addon.py:285 workspace `{1,80}`; ops.ts:611, manage.ts:278, proxy.ts:45, secret-store.ts:47 domain slug 40.
- Internal chunk sizes, not limits: outbox.ts:153 1 MiB copy buffer.

### Reviewer, pusher, keyring

- root/reviewer.ts:56 `4b825dc642cb6eb9a060e54bf8d69288fbee4904`: git's empty tree id.
- root/reviewer.ts:138 LFS pointer form (`version https://git-lfs.github.com/spec/v1`, `oid sha256:` 64 hex, `size`): git-lfs spec.
- root/reviewer.ts:404, 453, 986, 1061; root/pusher.ts:311; root/keyring.ts:174, 176, 183 `[0-9a-f]{40}` / `0{40}`: SHA-1 object ids and the null id; root/pusher.ts:77 `ZERO = "0".repeat(40)` the same.
- root/pusher.ts:824-825, 852; root/reviewer.ts:524 `[0-9a-f]{64}`: sha256 (pack digests, LFS oids).
- root/pusher.ts:231 `65516`: git's largest pkt-line payload (65520 minus the 4 length digits). Pinned by its in-source test (pusher.ts:244-253).
- root/pusher.ts:288-296: pkt-line framing, 4 hex digits; lengths 1-4 are git's special packets (flush 0000, delim/response-end), "a pkt-line desolate does not use".
- root/pusher.ts:832 `packSize < 32`: the smallest pack (12-byte header + 20-byte trailer).
- root/keyring.ts:1002 `requestIdentities: 11, signRequest: 13, failure: 5`: ssh-agent protocol message numbers; `maxFrame: 256 * 1024` equals OpenSSH's own agent message cap (AGENT_MAX_LEN).
- root/keyring.ts:126 `ssh-keygen -t ed25519`: key type.
- root/keyring.ts:188 `randomBytes(16)`: 128-bit challenge nonce (shared/approval.ts parses it as 32 hex).
- root/review-client.ts:112 `randomBytes(8)` and root/reviewer.ts:280 `[0-9a-f]{16}`: the review ref's random part, written twice (must match).
- root/reviewer.ts:738 `DATE = /^[0-9]{1,12} [+-][0-9]{4}$/`: git's raw date form (epoch, zone).
- root/reviewer.ts:523 `.slice(0, 16)` of a sha256 in pack record names; root/keyring.ts:435 approval id `Date.now().toString(36)-<12 hex>`: internal names.
- root/reviewer.ts:850, 860; root/pusher.ts:450, 912, 932, 1005, 1016 `.slice(0, 12)`: abbreviated ids in messages (display convention).
- root/pusher.ts:852 `[0-9]{1,12}`: an LFS size field of up to 12 digits (well above LIMIT.lfs).

### Workspace and shared

- shared/approval.ts:27, :127, :93; shared/names.ts:192, :262; shared/status.ts:360; workspace/sync.ts:145, :164 `{40}`, `{64}`, `0{40}`: SHA-1 / SHA-256 object ids, git's all-zero "no such ref", the LFS pointer format (`oid sha256:` + 64 hex).
- shared/approval.ts:78, :80, :144, :146 `1024`, 7 and 10 lines: the signed approval text's fixed shape and its size bound (5 short fields + a branch of at most 200).
- shared/link.ts:35-36, :119, :187, :193 `{32}` token/nonce, line caps `200`, `PREFIX.length + 40`, `100`: the link handshake's fixed fields (16-byte nonces, 64-hex HMAC) and line bounds sized to them.
- shared/spawn.ts:25-27 KEY/MAC `{64}`, NONCE `{32}`; workspace/desolate.ts:613 `randomBytes(16)`: key, HMAC and nonce sizes.
- shared/page-key.ts:54 `{64}`: page key cookie = HMAC-SHA256 hex.
- workspace/editor-gate.ts:200 `{32,128}` hex: the editor token's format ("hex, 32 to 128 digits; the real one is 48"). daemon/wsd check `{48}`.
- workspace/editor-gate.ts:149 `Max-Age=604800` (7 days): copied from what VSCodium's own server sets ("measured, VSCodium 1.116").
- shared/sniff.ts:36-41; workspace/svcnet.ts:125 `{0,62}`, `253`, `{2,45}`: DNS label (63) and name (253) lengths; longest IPv6 text.
- shared/sniff.ts:20, :110 `{1,16}` method letters; :327-331 `{0,4}` / `{0,7}`: how Chrome ("HTTP" within 5 bytes) and Firefox ("ICY " after up to 7 spaces) read a greeting.
- shared/sniff.ts:76-98 TLS record offsets (`5`, `4 + 2 + 32`, extension type 0): the ClientHello layout.
- shared/names.ts:17 `{0,99}`: GitHub repository names are at most 100 characters.
- shared/names.ts:287-322 `hex(..., 10)` VM names, `hex(..., 6)` surface names: short because "Lima's socket paths cap at 104 bytes".
- shared/issues.ts:204 `\d{1,9}`: issue number in a GitHub issue URL.
- shared/exit.ts:13-21 64/75/77/78/79: sysexits-style exit codes.
- workspace/net/egress.ts:387-388 15080/15443; workspace/svcnet.ts:124 `127.0.0.11` (docker's embedded DNS); workspace/devcontainer.ts:577 / bridge.ts / wsd.ts `1024`, `65535`: port number facts and desolate's fixed internal ports.
- workspace/desolate.ts:589, workspace/sync.ts:188 `slice(0, 12)`: abbreviated commit/oid for display.
- shared/envfile.ts:181-219 `{20,}`, `{8,}`, `{16}`: shapes of providers' key formats (OpenAI, Resend, Firecrawl, AWS key IDs) used to recognise them.
- shared/copy.ts:101 `1024 * 1024`: copy buffer size (a chunk, not a limit).

### Scripts and UI pages

- workspace/editor.sh:24-25 `SERVER_PORT=31580`, `GATE_PORT=31581`: in-VM ports of the editor server and gate (also shared/names.ts:375 `EDITOR = { server: 31580, gate: 31581 }`).
- workspace/editor.sh:40 `head -c 24 /dev/urandom`: a 24-byte (48 hex) editor token (host/daemon.ts:1872 checks `[0-9a-f]{48}`).
- workspace/net/up.sh:12 `PLACEHOLDER=198.18.0.1`: RFC 2544 benchmarking range.
- workspace/net/up.sh:52-61 `redirect to :15443` / `:15080`: the egress relay's ports (workspace/net/egress.ts:387-388, workspace/wsd.ts:29).
- workspace/net/up.sh:47; root/wall.sh:102-103: the private and link-local ranges (RFC 1918, 169.254/16, 100.64/10).
- root/wall.sh:26-28 `192.168.5.0/24`, gateway `192.168.5.2`, resolvers `192.168.5.2, 192.168.5.3`: Lima's user-mode network.
- root/wall.sh:43 ports `1`–`65535`; root/wall.sh:75 `ip_unprivileged_port_start=1024`.
- host/vm/qemu-wrapper.sh:26 `guestfwd=tcp:192.168.5.100:15000`: the link's guest address (host/vm/lima.ts:71 `QEMU_LINK`).
- root/proxy/secrets_addon.py:64 `[0-9a-f]{64}`: a 32-byte link token.
- root/start.sh:109 `LAYOUT=2`; root/start.sh:113, workspace/editor.sh:101, workspace/editor-defaults.sh:23, workspace/net/up.sh:68 `sha256sum | cut -c1-16`: code fingerprints (64 bits).
- image/build.sh:138 `${ROOTFS_SHA:0:12}`; image/provision.sh:145 `[0-9a-f]{16}` image fingerprint.
- recipes/suede.sh:39-40 `[0-9a-f]{40}`: a SHA-1 commit; `${commit:0:12}` short form in messages; root/ui/dashboard.js:74 and host/approve-ui/approve.js:167,178,183,228 `.slice(0, 12)`: short commit ids.
- recipes/issues.sh, recipes/*.sh `exit 64`, touchid.swift `64`/`78`: sysexits codes.
- cli.sh:25 node `>= 22.18`: needed to run TypeScript directly.
- host/approve-ui/approve.js:63 `delay: 100`: IntersectionObserver v2 requires `delay` ≥ 100 with `trackVisibility`.
- git/terminal.py:43,53 and workspace/agent-holder.py:165,190,289,331 `65536`: read chunk sizes, not limits.
