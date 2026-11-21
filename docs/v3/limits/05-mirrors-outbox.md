# Limits 05: the root's mirrors and out-boxes

Ticket 5 of the limits effort (#177). The root's own git work (its mirrors of the forge, its
clones) and what it reads from a domain's out-box. A domain is not trusted: every bound on what
the root reads from an out-box stays a hard bound (R7). Each is now named once, says why that
number, and is refused out loud with the bound and the size (R3). The rules R1 to R9 are in
[`../limits.md`](../limits.md).

## Each limit, and its answer

The four answers: **removed** (better code), **asked** (the person decides), **setting**, **hard**
(a bound kept, saying whose input it bounds and why that number).

| where (before) | what it was | answer | what it is now |
|---|---|---|---|
| root/repos.ts:286, :310 | `git fetch` and `git lfs fetch` of a mirror killed at 10 minutes | removed | No total. An idle bound against the forge, `FORGE_IDLE_MS` (5 min, git.ts): `--progress` (and `GIT_LFS_FORCE_PROGRESS`) make git speak every second while bytes come. The fetch also ends when whoever asked goes away (`signal`, from rootctl's connection). ssh also ends a dead link within a minute (`ServerAliveInterval=15`, `ServerAliveCountMax=4`). |
| root/repos.ts:298-302 | `ls-remote` 60 s, then silently no default branch | removed | Idle bound and signal as the fetch. If it fails, the default branch known before is kept and the log says so. A name that is not a branch is not taken. |
| root/repos.ts:428 | `FETCH_LOCK_STALE_MS`: a fetch lock taken to be dead after 10 minutes | removed | `shared/lock.ts` `withLock` (machine scope), held by the fetching process. A dead holder is taken over at once; a live one is waited for as long as it takes, and the wait names the holder. The in-process queue (`fetching` Map) went too, since the lock serves both. |
| root/domains.ts:260 | `spawn --max` over 1000 | hard | `SPAWN_MOST`, a check on a typo, not a resource. The message gives the range: "a whole number from 0 to 1000". |
| root/issues.ts:67 | `LIMIT.waiting = 50` issues waiting | hard | The message names the bound. The number is shared/issues.ts's, not this ticket's. |
| root/intake.ts:74 | `index-pack --strict` killed at 8 minutes, whatever the size | hard, scaled | `checkMs(bytes)`: a minute, plus a second for each MiB. The largest bundle the forge takes (2 GiB) gets 35 minutes. The message says the time given and the bundle's size. |
| root/intake.ts:23 | a 4 MiB header read; past it, "not a v2 bundle" | hard, message fixed | `REFS_BYTES` (outbox.ts), the same bound as refs.json, since the header is the same list. Past it: "its list of refs (the bundle's header) is N bytes, over the 4194304 allowed". `headerEnd` looks for the header's end a MiB at a time, so it can say the size. |
| root/git-remote-desolate.ts:111 | `round < 1000` | hard | `ROUNDS_MOST`, named and said: "took 1000 bundles … the rest wait for the next". The helper now also ends when the git that ran it goes away (below). |
| root/outbox.ts:28 | `LIMIT = { json, bundle, lfs }`, refused as "not a plain file" | hard, named | `JSON_BYTES` (1 MiB) for requests and notes. Bundles use `FORGE.packBytes` and LFS objects use `FORGE.lfsObjectBytes` (shared/limits.ts, the bounds the git VM's out-box and the pusher use). Every refusal goes through `over()`: the file's name, the bound, its size. `takeBundles` returns each drop's reason, not a count. `drain` returns `why` for each request it could not take. |
| root/outbox.ts:217-223 | refs.json read for git with a 1 MiB cap and a silent `.slice(0, 5000)`. git then pruned every branch past the cut | removed (the cut); hard (the size) | `refsOf`, the one reader of refs.json, with one bound: `REFS_BYTES`, 4 MiB, which holds over 16,000 branches at the longest name and about 50,000 at a usual one. It returns `{ refs }` whole or `{ refused }`, never a part. The helper's `list` refuses out loud and exits 1, so git fetches nothing and prunes nothing. A refs.json directory that is a link, including one that leads nowhere, is refused, not taken for "nothing synced". |
| root/outbox.ts:458-473 | `BRANCHES_PER_REPO = 200` and a 256 KiB read for the dashboard: other numbers for the same file | removed | `branchesOf` is `refsOf` for each repository. Paging what the dashboard draws is ticket 4's (see "Needs" below). |
| root/ops.ts:61, :442 | `LFS_MOST = 5 GiB` | hard, shared | `limits.FORGE.lfsObjectBytes`, refused with `over()` before it is read. |
| root/ops.ts:322, :344 | `suede changed`: first 200 dependencies, 2,000 files each | removed | Every dependency and every file: the host shows counts, and a count of a cut list is not one. Each changed file's owner is found once, by walking up its own path. The old way checked every file against every dependency, which a commit with many of each made hours long. |
| root/ops.ts:328-331 | first 4096 bytes of a .gitrepo | hard | `GITREPO_READ`: the two lines taken are at its top. |
| root/ops.ts:234 | `net log` shows 100; `Number(args.last) \|\| 100` | kept, named | `NET_LOG_LAST`. A `last` that is not a positive whole number gets the default. The host never sends `last`: a `--last` flag is ticket 10's. |
| root/rootctl.ts:160 | 1 MiB request line, counted in characters | hard | `REQUEST_MOST`, counted in bytes. |
| root/domains.ts:1216, :1239 | `SPEC_MAX = 256 KiB` devcontainer.json | hard | unchanged |
| root/domains.ts:120 | a title silently cut to 200 | hard, refused | `TITLE_MOST`, 200 code points. A longer title is refused (usage) with its length, and no domain is made. |
| root/domains.ts:432 | git name/email cut to 200 | hard | unchanged (as the host read them) |
| root/git.ts:119 | `ConnectTimeout=20` | hard | Kept, with ServerAlive (above). Each says why. |
| git's stderr tails across these files | `-1500`, `-400`, last 3, last 2, `0, 200`, `-500` | removed | `gitSaid(result, lines)`: `failure()` from shared/text.ts with a stated tail. Progress git wrote over itself is collapsed. When more came before, the whole is kept in the root's state (`failures/`, made safe to print, newest 64 MiB / 1,000 files) and the message names the file. |
| why a bundle or issue was refused, 300 characters | `.slice(0, 300)` | hard, named | `WHY_MOST` (outbox.ts), through `printable()`. Intake keeps git's words about a pack up to `SAID_MOST` (64 KiB), since its first error is the one worth reading. |

### Also looked at (the triage's "keep" rows)
- `root/outbox.ts:320` (20 refusals per domain) and `:245` (6 h for the root's own leftover copies): kept, unchanged.
- `root/ops.ts:327` (`printable(dir, 400)`), `:389-390` (the share's 20 × 250 ms), `:65, :521` (keyring ping 3 s), `:741, :767` (pusher and reviewer pings 5 s): kept, unchanged.
- `root/ops.ts:563-649`, doctor's `sudo -n` checks: **fixed**. A timed-out `sudo -n true` has no status, and it read as "sudo refuses it", a pass. A timed-out `test -r/-x` read as "cannot reach". Each is now said as not answered, and fails. The wait is `ASKED_MS`.
- `root/domains.ts:58, :72` and `root/rootctl.ts:83` ("at most 40" in the slug message): left. It matches `SLUG` in shared/names.ts, which exports no length to build it from.
- `root/pushed.ts` rows: not this ticket's file.

## Found by a fresh review, and fixed
An independent review of this branch, given the code and not these conclusions, found:
- **A helper could outlive its fetch.** rootd kills `git fetch <domain>` at 10 minutes, and the remote helper, git's child, went on taking bundles. A domain writing slow bundles as fast as they were taken stacked up one helper per fetch. Now, when git closes the helper's input, a signal ends its git runs and its `index-pack` check (`bundleRefusal`'s new `signal`), and it takes nothing more.
- **`suede changed` was quadratic** in a commit's files and dependencies. Fixed as above.
- **A refs.json directory that was a link leading nowhere** read as "nothing synced", and git would prune the domain's branches on it. Now refused.
- **What `failures/` keeps** was raw: in part a domain's text, and a person is asked to read it in a terminal. It is now made safe to print, and bounded in files as well as bytes.
- **rootctl's service on old code** left 100 ms after the first request that found it stale. Leaving killed every grouped program it ran (shared/run.ts, on exit), a mirror fetch mid-write among them. It now stops accepting (the host then asks one process per request) and leaves once what it is answering is answered.

## Measured
- `git index-pack --strict --stdin` on a 201 MB bundle's pack, on the M1 (a root-sized VM): 10.5 s, about 19 MiB/s. `checkMs` gives a MiB a second, so an ordinary pack is never near its bound, and only one made to be slow is refused.
