# Limits 14: scripts and recipes

Ticket 14 of the limits effort (#186): the shell around the stack. Each row of
[`limits-triage.md`](../limits-triage.md) this ticket owns, put to the four questions of
[`limits.md`](../limits.md), and what it is now.

## The rows

| where | what it was | answer | what it is now |
|---|---|---|---|
| recipes/issues.sh:42 | `gh issue list --limit 100`; an issue past the 100th with a workspace was taken as closed, and its agent stopped | **removed** (R2) | `gh api --paginate repos/<r>/issues?labels=&state=open&per_page=100`: every page, pull requests left out. A list that could not be read to its end stops the pass ("could not be listed: nothing was done this pass", exit 1). Closed is what GitHub says of that one issue (`gh issue view <n> --json state`), asked only when there is a running agent to stop. Open without the label: the agent is left running, and the pass says how to stop it. |
| recipes/issues.sh:25, :63 | `--max 3` | **setting** (already a flag) | kept. Those that wait are said once per pass, with their numbers, however many (before: a line each). |
| recipes/agent.sh:45; claude.sh:64 | numbering `for n in 2 … 9`: the tenth workspace of a name was refused by `up` | **removed** | `recipes/name.sh`, called by both: the next free number, however many are taken; the number is inside the 30. |
| recipes/agent.sh:39-41; claude.sh:58-60 | the name cut to 30, in whole words | **keep** (a choice: a name read in a list and typed) | written once, in `name.sh`, which says the real bound is the slug's 40 (`shared/names.ts`). |
| root/start.sh:328-329 (and :309-310, the keyring) | `seq 1 100` × `sleep 0.1`: 10 s for a socket, then "did not start" | **removed** (R4) | `listening`: waits until the socket is there, or until the service has ended without one (its pid gone, or `kept.sh`'s count of failures moved). Every 5 s, on stderr, "the <name> is still starting (<n> s)". The only patience is the host's, which waits for start.sh (host/bootstrap.ts, 120 s, with the last of start.sh's output in its refusal). |
| root/start.sh:341 | `sleep 2` for ever, rootd/stated/rootctl | **keep a loop, with backoff** | `root/kept.sh`: 1 s, then doubling while the service keeps failing within a minute of its start, up to 60 s; back to 1 s after a minute up. Each end is said in the log ("ended with <code> at <time>, <n> s after it started (the next start waits <p> s); starting it again"). A service that cannot start now writes about 60 lines an hour, not 1,800. Not a setting: nothing in it depends on the machine or the person. |
| root/start.sh:321, :325 | `sleep 0.2` before, `sleep 0.5` after each run of the pusher/reviewer | **keep** (triage: by design) | unchanged, inside the command `kept.sh` keeps, now in its `once` mode: a request answered (exit 0) is started again at once; any other end is a failure, counted and backed off, which before spun twice a second for ever and silently. Not replaced with a wait for the user's processes: in the fake backend nothing reaps an orphan, and a wait on `pgrep -u` would wait on zombies. |
| root/start.sh:135 | `sleep 1` after killing old-code services | **removed** (R4) | waits for every process of what it ended (the services' process groups, the keyring's, pusher's and reviewer's users, the proxies) to be gone, a zombie counting as gone; every 5 s it says which are left. No count. |
| root/start.sh:26-27 | `MaxSessions 1000` | keep | unchanged (ticket 8 has the other copy in workspace/start.sh). |
| image/provision.sh:118, :124-127 | `curl -m 600` for the editor server; past it, an image with no editor and no word until the first `desolate editor` | **fail out loud; leaving it out is asked for** | every download (`fetch`) has no total, only idle bounds against the remote server: no connection in 30 s, under 1 byte/s for 60 s. Four tries, each failure said on stderr. An editor that cannot be had fails the provisioning, with what to do. An image without one is made only when asked: `DESOLATE_IMAGE_EDITOR=none` (Dockerfile `--build-arg`, `build.sh --no-editor`), and it says so in `/opt/desolate/EDITOR-MISSING`. A value other than `none` is refused. |
| image/build.sh:24, :31, :117 | `DISK_GB=8` | **keep** (a flag already) | it is the image file's size, room for what is provisioned (the container image is 2.0 GB), not a VM's: Lima grows it to the base's `BASE_DISK_GIB` (30) when it makes the base, for qemu as for vz (host/vm/lima.ts `baseYaml`). So shared/size.ts:15's "every VM is cloned from a 30 GiB base" is right, and ticket 13 has nothing to change there. `--disk-gb` is now checked to be a whole number. |
| image/build.sh:59, :91 | `tail -20`, `tail -15` | keep | unchanged; the build now also shows provision's own `provision: ...` lines as they come (a retry, a refusal). |
| git/suede-upstream.sh:168, :204, :215 | 72 unauthenticated calls in a full wait, errors swallowed | **not changed here** | it is suede's script, vendored and pinned by its sha256 (`pins.env` `SUEDE_UPSTREAM_SHA256`, checked at run time by git/upstream.ts:576): an edit here is refused when it runs. And desolate never runs its wait: it always passes `--no-wait` (git/upstream.ts:710); the wait is host/upstream.ts's, which authenticates with gh's token. The fix belongs in pmalacho-mit/suede's `scripts/upstream.sh`, then `tools/pin-suede.sh <commit>`. |
| git/suede-upstream.sh:167, :200-233 | `SUEDE_UPSTREAM_WAIT` 180 | keep | as above: suede's. |
| root/proxy-user.sh:19; root/start.sh:78, :205 | the slug rule in shell, in a stricter form (and start.sh:205 a weaker one) | **keep hard** (R7), **one rule** (R3) | each copy is `isSlug`, clause for clause, one line, named after it; `tests/v3/t1/scripts.test.ts` reads each line and runs it in bash beside `isSlug` on 3,000+ names in three locales. start.sh:205 was weaker (no `--`, `xn--`, `---` checks): now the same rule. start.sh:78 skipped a directory that is not a slug silently: now it says so. |
| completion.bash:14 | `^[a-z0-9][a-z0-9-]{0,39}$` | **keep hard**, one rule | as above: it took a trailing dash and any number of `--`, which isSlug refuses. |
| root/proxy-user.sh:22 | `dsp-` + 10 hex | keep | unchanged (Linux user names are at most 32). |
| recipes/suede.sh:67-68 | `cut -c1-20`, `${commit:0:8}` | keep | unchanged. |
| recipes/echo-agent.sh:9, :22 | its pace, `while sleep 3600` | keep (the stand-in agent) | unchanged. |

## Found on the way

- **macOS's bash takes `[a-z]` to match `é` in a UTF-8 locale** (bash 3.2.57, measured with
  the new T1 check: `é` and `aé` passed the old copies under `en_US.UTF-8`). completion.bash
  runs in the person's own shell on the Mac. The shell copies now spell the letters out.
- **A killed service is a zombie for ever in the fake backend**: the root's container's first
  process is `sleep infinity`, which reaps nothing. A wait for "the old services are gone"
  that counted zombies would never end there; the wait counts them as gone. (`alive()` in
  start.sh, `kill -0`, still takes a zombie for alive. That is older than this change and only
  bites the fake backend, after a service died under an earlier start.sh: not changed.)

## Measured

- The old issues recipe, against the stand-in gh (`tests/v3/forge/gh.sh`, 120 labelled issues)
  with workspaces `issue-20` (the 101st), `issue-130` (open, label taken off) and
  `issue-150` (closed), each with a running agent: it stopped all three, and started #120.
  The new one stops only #150's, says #130's is left running and how to stop it, and names
  the 119 that wait. (By hand, on the Mac, with a stand-in `cli.sh`; T2 12-agent runs the new
  one against the real stack.)
- `kept.sh`'s pauses for a service that keeps failing: 1, 2, 4, 8, 16, 32, 60, 60 s (T1).

## Tests

- T1 `tests/v3/t1/scripts.test.ts`: the three slug copies against `isSlug` (with the control:
  the old copy takes `a--b--c` and `acme-`); `name.sh` past 9 and past 99, within 30, a slug;
  `kept.sh`'s backoff and its two modes, and the log line the T2 tests read; shellcheck on
  the recipes and completion.bash where shellcheck is installed (it is not on the Mac).
- T2 12-agent: the issues recipe against 120 issues (control: the first 100, as read before,
  do not have #20); GitHub down: nothing done.
- T2 13-rebuild: an update of the root's code: every old service has ended (no live old pid)
  before the bootstrap ends, each is a new process, and a fetch works.
- T4: the real root VM starts from start.sh and kept.sh.
