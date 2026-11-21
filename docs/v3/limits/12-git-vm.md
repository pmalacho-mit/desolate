# Limits 12: the git VM, its out-box and its terminal (#184)

What the git terminal's pushes, fetches, `desolate upstream` and shells were bounded by, and
what each bound is now. The four answers are limits.md's: **removed** (better code), **asked**
(the person decides, by waiting or by Ctrl-C), **setting** (`shared/settings.ts`), **hard**
(a bound that says whose input it bounds and why that number).

## The out-box: one exchange, written once

`release/shared/git-out-box.ts` (new) is the exchange between the git VM's programs
(`git/git-remote-desolate-out.ts`, `git/desolate.ts`) and the host (`host/git-vm.ts`): the
names of its files, its one bound (`REQUEST_BYTES`), the ref rule (`isRef`), and `requester`,
the client both programs use. It is under `shared/` because the daemon may import only from
`host/` and `shared/` (T1 `daemon-code.test.ts`). It is not one of the foundation's contracts.

What the git VM leaves there is input from a VM to the host (R7): every bound on it is hard,
checked before any work, and **every refusal is answered at once**, naming the bound and the
size that met it. Before, a request over 64 KiB was removed unanswered and its push waited 20
minutes for nothing.

| where (before) | what it was | answer | what it is now |
|---|---|---|---|
| host/git-vm.ts `LIMIT.request` 64 KiB | a request file in the out-box | hard, answered | `REQUEST_BYTES` = 1 MiB − 4 KiB: the root's CLI channel takes 1 MiB a request (root/rootctl.ts), less what the host adds. The helper checks it before it bundles; the host checks it again and answers a refusal. |
| host/git-vm.ts `LIMIT.objects` 2000 | LFS objects in one push | removed | No count: the request's size bounds it (about 15,000 objects). It was unreachable: 2,000 oids are about 134 KB, over the 64 KiB request bound, so a push of more than about 970 hung for 20 minutes. |
| host/git-vm.ts `LIMIT.bundle` 2 GiB | a push's bundle | hard, shared | `FORGE.packBytes` (shared/limits.ts), the same name the root's out-box and the pusher use. The helper checks it after bundling and before writing the request; the host checks it again. |
| host/git-vm.ts `LIMIT.lfs` 5 GiB | one LFS object | hard, shared | `FORGE.lfsObjectBytes`, checked by the helper before it copies anything and by the host. The message names the object, its size and the bound (before: "not a plain file"). |
| (none) | no client-side check of the host's bounds | removed | `pushRefusal` in the helper: the same names, before the work. |
| host/git-vm.ts:461 20 min, git/git-remote-desolate-out.ts `WAIT_MS` 20 min, poll 500 ms | a push waiting for the host's answer, including the person's approval | asked | No timer on either side. The helper waits for as long as it runs and prints what the host says as it happens (`<id>.notes`). Ctrl-C, SIGTERM or SIGHUP withdraws it: the helper writes `<id>.gone` and removes its files, and the host stops before it copies or hands anything on. Once a push has been handed to the root, Ctrl-C no longer withdraws it, and the helper says so: decline it on the approval page. The host's call to the root has `ROOT_HOLDS_MS` (24 h, socat's own `-t`) until rootctl takes a `signal` (ticket 11). |
| host/git-vm.ts:380 10 min, git/desolate.ts:133 10 min | the root refreshing a mirror for `desolate fetch` | asked | No timer on either side. The root's fetch from the forge is the root's to bound. |
| git/git-remote-desolate-out.ts `maxBuffer` 256 MiB | `rev-list --objects` of a whole history | removed | Read as a stream (`rev-list | cat-file --batch-check | awk | cat-file --batch`). Pointer-sized blobs are found with `LFS_POINTER_BYTES`, not 400. |
| git/git-remote-desolate-out.ts:46,148 | helper-internal values | keep | Unchanged where still used. |
| host/git-vm.ts:127,215 `.slice(-300)` | stderr of a failed provision or clone | removed | `failure()`: the last 5 lines, with the whole text in `logs/git-vm-<step>.txt`. |
| host/git-vm.ts:136 `.slice(0, 200)` | the Mac's git user.name and user.email copied into the git VM | removed | The person's own Mac config: R7 does not apply, and git takes what it takes. Control characters are still removed. |
| host/git-vm.ts:211 30 min | cloning into the git VM | removed | No timer: a clone from a mirror on this Mac's own disk; the person is waiting, and a clone killed partway left a directory that was later taken for a whole clone. An idle bound needs `exec`'s `idleMs` (ticket 11). |
| host/git-vm.ts:236,238 `tail -2` | `git fetch` output when the terminal opens on an offered branch | removed | Shown whole. |
| host/git-vm.ts:257 5 min | readying an offered branch | removed | No timer, as for the clone. |
| host/git-vm.ts:259 `.slice(-20_000)` | what readying said, written into the terminal first | removed | It goes into the terminal's replay, which keeps its last `KEPT_BYTES`; a single chunk larger than that keeps its end. |
| host/git-vm.ts:105,121-127,149,337,376-377,677,712 | keep rows | keep | Looked at. `FETCH_GAP_MS` and the hourly sweep of unread answers are unchanged. |

### Made robust in this change (security review, 2026-11-21)

A fresh reviewer found that two out-box names could stop the host daemon, and with it every
page the daemon serves. A directory named `<id>.gone` made the scan throw, uncaught, on every
start. A directory named `<id>.json` was answered again and again in one turn of the event loop,
forever. Both are fixed: out-box names are removed with `unlink`, which removes a file or a
link and never a directory; the scan cannot throw; a request whose file cannot be removed is
answered once and not taken again; the next scan runs on the next turn of the loop. Every name
of an answered request is removed, refused requests included. Names that belong to no request
are dropped, so the scan stays linear. `tests/v3/t1/git-out.test.ts` covers this, with a
control; on the old code it fails with EISDIR.

## `desolate upstream`

| where (before) | what it was | answer | what it is now |
|---|---|---|---|
| git/upstream.ts `--max-count=50` | the split's commits the remote lacks | removed | `rev-list --count`, then a page (`PAGE`, 100) and "and N more" (`andMore`). A split of 60 commits says 60 (T2 13-upstream). |
| git/upstream.ts:714 10 min | suede's own upstream script | asked | No timer: it runs for as long as the person lets it (Ctrl-C). |
| git/upstream.ts:715 `maxBuffer` 64 MiB | what the script prints | removed | Streamed to the terminal line by line (`lineByLine`), each line through `printable`, and a line longer than `SAFE_MOST` shown in parts. |
| git/upstream.ts:723-724 `.slice(-12)`, `printable(line, 300)` | the script's output when it fails | removed | It was already shown as it came; the refusal says so. |
| git/upstream.ts:859-860 `printable(line, 200)` | each commit and `diff --stat` line | removed | `printable(line)`, the shared bound. |
| host/upstream.ts:297, git/upstream.ts:88 `[A-Za-z0-9._/-]{0,199}` (twice) | a ref the person names | hard, once | `isRef` in shared/git-out-box.ts, bound by `NAMES.branch`. |
| host/upstream.ts 10 min | resolving `--from` in the git VM (a fetch from this Mac and a rev-parse) | removed | No timer. The refusal includes what git said, whole. |
| host/upstream.ts:41,42,52,62,338; git/upstream.ts:73,768-772,865-867,82,... | keep rows | keep | Looked at; unchanged. |

## The terminal

| where (before) | what it was | answer | what it is now |
|---|---|---|---|
| host/git-web.ts `LIMIT.idleMs` 30 s, reap every 5 s | a shell no tab reads | removed | A shell whose tab closed (by mistake, a laptop lid, a reload) is not ended. It stays until it ends (`exit`, or the git VM going down). `GET /sessions` lists the shells no tab reads, and the page offers them back ("Back to the shell in …", "New shell") before it opens another. The page's own credential is needed, as for a shell's input. A shell that has ended is forgotten once no tab reads it. |
| host/git-web.ts `LIMIT.sessions` 6 | shells open at once | setting | `git.shells` (`DESOLATE_GIT_SHELLS`, 1 to 64, default 6). The refusal names the setting, says how many shells no tab is reading, and says to reload the page to go back to one. |
| host/git-ui/git.js `scrollback: 5000` | lines the browser tab keeps | setting | `git.scrollbackLines` (`DESOLATE_GIT_SCROLLBACK_LINES`, 100 to 1,000,000, default 5000). The host sends it to the page with the shell. |
| host/git-web.ts `LIMIT.kept` 256 KiB | output kept for a tab that comes back | hard | `KEPT_BYTES` = 2 MiB, the same as an agent's terminal keeps for its replay (workspace/agent-holder.py). A reattach replays it. |
| host/git-web.ts `LIMIT.input` 64 KiB | base64 input per request | hard | `INPUT_CHARS`, exported. The page is told it and sends a paste in parts of that size (before: a paste over it was refused, and lost). |
| host/git-web.ts `LIMIT.input * 2` | a request's raw body | hard | `INPUT_CHARS * 2`, said where `INPUT_CHARS` is defined. |
| host/git-web.ts:366-372, git/terminal.py:65 1000×500 (twice) | terminal size | hard, once | `TERMINAL` (shared/limits.ts). terminal.py names it, and T1 (`git-web.test.ts`) checks the two agree. The refusal says the bound. |
| git/terminal.py:61 4 MiB | typed input held for a shell that is not reading | hard | `TYPED_MOST`. The terminal now says how many bytes were dropped, where the person is looking (before: dropped silently). |
| git/terminal.py:56-58 (no bound) | an unterminated protocol line | hard | `LINE_MOST` = `INPUT_CHARS` + 3, the longest line the host sends. A longer line is dropped up to the next newline instead of held. |
| host/git-web.ts:305 15 s; git/terminal.py:23; host/git-ui/git.js:33 1.5 s | keep rows | keep | Unchanged. |

## Not done, and why

- **No bound on the total bytes of one push.** Each LFS object is held to
  `FORGE.lfsObjectBytes`, and the request bounds how many objects there are (about 15,000).
  Nothing bounds their sum, and `copyOut` copies synchronously on the daemon's thread. A git
  VM can leave sparse 5 GiB files, which the host writes out dense. The old count, 2,000 × 5 GiB,
  did not bound this either. The right bound is probably the Mac's free disk, checked before
  copying, with an asynchronous copy. Left for a follow-up.
- **No idle bound on the host's exec calls into the git VM** (clone, readying a branch,
  resolving `--from`): `host/vm` `exec` has no `idleMs` yet (ticket 11).
- **The host's call to the root for a push cannot be cancelled** when its asker goes:
  rootctl has no `signal` yet (ticket 11). Until it has one, it is held for `ROOT_HOLDS_MS`,
  and the host takes one request at a time, so a git VM that asks and withdraws over and over
  holds one call, not many.
