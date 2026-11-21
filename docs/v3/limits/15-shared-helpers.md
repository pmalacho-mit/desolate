# Limits 15: the shared helpers (#187)

What this ticket decided, limit by limit, for `release/shared/` (outside the foundation's
contracts), `release/shared/ui/` and the secrets page. The questions and rules are
[`../limits.md`](../limits.md)'s; the rows are [`../limits-triage.md`](../limits-triage.md)'s.

## The limits

| file | what it was | answer | what it is now |
|---|---|---|---|
| shared/status.ts:364 | `PACKED_MOST = 256 KiB`: a packed-refs file larger than that was not read at all, so a repository with about 4,000 branches or more showed no commit for any of them | 1, better code | git writes packed-refs sorted and says so in its first line. Such a file is searched by halving, 16 KiB a read, and is never read whole, so any size works. A file that does not say it is sorted is read through to `PACKED_UNSORTED_MOST` (256 KiB, R7: a workspace's file read by the root's shared state service), and past that the branch is shown without a commit. T1 tests 5,000 branches (about 350 KiB), with a control showing the old reader found none. The packed-refs cache (status.ts:378, cleared past 500) is gone, because nothing reads the whole file any more (R9). |
| shared/status.ts:208 | status file `8192` bytes, refused if larger | 4, hard | Named `STATUS_FILE_BYTES`, with its reason. An honest status is at most 2,400 bytes: 200 characters, each at JSON's longest escape. |
| shared/status.ts:214 | message `printable(..., 200)` | 4, hard | `NAMES.status`. The cut ends in `…`, from text.ts. |
| shared/status.ts:291 | note `readPlain(..., 16384, false)`, cut silently | 4, hard; the cut is said | `NAMES.noteBytes`. A longer note ends in `…` on a line of its own, never in half a character. |
| shared/suede.ts:259 | `tips.slice(0, 200)`: the `downstream/` rule searched only the first 200 remote tips for a merge base | 1, better code | One `merge-base --all` over every tip, 512 tips per call, which keeps argv bounded. T1 tests 1,200 unrelated tips with the release last, plus a control. It is stricter than before only for a proposal that reverts `.github/` to an older state of the remote: its bases are now the nearest shared commits. |
| shared/events.ts:65 | `PER_CHANGE = 200` events per domain from one change; the rest were dropped with no sign | 4, hard (R7), and the drop is said | After a domain's 200th event comes one `events-dropped` event, `{domain, dropped, sent}`. Documented in reference.md. In-source tests have a control. |
| shared/events.ts:198, :211 | status `printable(..., 200)`, issue title `printable(..., 256)` | keep | `NAMES.status` and issues.ts's `LIMIT.title`, the source bounds, named and not copied. |
| shared/stats.ts:39-67 | `p(text, max = 120)`, and domain 40, title 80, repo 100 and the rest, each cut for width | 1, removed | Names are bounded where they are made. Fitting a line to the screen is the terminal's job. |
| shared/issues.ts:15 | `LIMIT`: title 256, body 65,536, label 50, labels 20, waiting 50, counted in UTF-16 units while AGENTS.md said "64 KiB" | 4, hard (R7, R8) | Counted in characters (code points), as GitHub counts them. AGENTS.md and reference.md now say 65,536 characters. A title or body over its bound is refused with `over()`: "the title is 257 characters, over the 256 GitHub takes". Labels 20 and waiting 50 remain choices. |
| shared/envfile.ts:775 (`keepApart`) | numbering a name to keep it apart: no bound on the number or the length | better code | Shorter names are numbered first, and another row's identical name counts as a clash. At most 99 numbers are tried, and the number stays within 64 characters. Before, `MY_API_TOKEN`, `MY_API_TOKEN_2`, `API_TOKEN`, in that order, looped forever in the host's daemon, and a 63-character name grew to 65. |
| shared/envfile.ts:318 | secret name cut silently to 64 characters, so two long keys could become one name | 4, hard, plus a hash | A key too long for a name is cut, and the cut ends in `-<8 hex of sha256(key)>`, as `domainNameFor` does. `SECRET_NAME` (8 to 64) and `SECRET_NAME_RULE` are exported. |
| host/approve-ui/secrets.js:147 | `file.size > 65536`, a copy of host/env-import.ts's `ENV_MAX` | 4, hard; the copy is named | `const ENV_MAX = 65536`, and the message gives the size and the bound. T1 (`tests/v3/t1/secrets-page.test.ts`) checks it equals `ENV_MAX`. |
| host/approve-ui/secrets.html:24 | name `pattern`, a third copy of the root's rule | 4, hard; the copy is checked | T1 checks the pattern against `SECRET_NAME_RULE` on ten names, checks that the hint states the numbers, and checks that root/proxy/secret-store.ts and secrets_addon.py hold the same rule. |
| shared/spawn.ts:30, :467 | `FRESH_MS` 15 min; future skew `120_000` | 4, hard | The skew is named `SKEW_MS`, with its reason. |
| shared/spawn.ts:31 | `LIMIT` words 64, word 16,384, total 65,536 (UTF-16 units); refused as `null` | 4, hard (R7); the message says the bound | `commandRefusal()` says which bound was hit and by how much: "word 1 of the command is 16385 characters, over the 16384 allowed". Counted in code points. `commandOf` is the same rule. New `LIMIT.json` (200,000): the command as JSON, which is how it is carried. Before, a command of control characters (six JSON characters each) could be signed, dropped by `hostArgv` as too long, and the spawn run with no command. It is now refused before it is signed. |
| shared/spawn.ts:150, :154 | `--checkout`s at most 16, repo parts `{1,100}` | 4, hard | `LIMIT.checkouts`. `checkoutsRefusal()` says what is wrong and with which checkout, or "the spawn is 17 --checkouts, over the 16 allowed". |
| shared/actions.ts:49, :54 | Create domain: repos ≤ 20; a title failing `/^[\x20-\x7e]{1,80}$/` was **dropped**, and the domain made without it | 4, hard; the title is refused | `CREATE = {repos: 20, title: 80}`. A title that is too long, holds a control or non-ASCII character, or starts with `-` is refused: `hostArgv` gives null. `actionRefusal()` says why ("the title is 81 characters, over the 80 allowed"). An empty title is still no title. |
| shared/actions.ts:130 | each argument ≤ 200,000 / 8,000 / 200; a value that was not text or was too long was **left out**, and the action run without it | 4, hard (R7); refused, never left out | Named `ARGUMENT` (`command` = spawn.ts's `LIMIT.json`; `repos` 4,040, room for 20 names of 201 characters). Counted in code points. A value that is not text or is too long refuses the action (`undefined` counts as absent). `actionRefusal()` names the argument and its bound. root/stated.ts still filters at 200 before `hostArgv` sees the arguments, so on the dashboard path that filter decides until ticket 4 removes it (see the pull request). |
| shared/actions.ts:27-29 | Resize regexes: cpus, memory, disk | keep | Not changed: deriving them from size.ts's `LIMITS` is ticket 13's file. |
| shared/names.ts:15 | `SLUG` 40 | 4, hard | Built from `NAMES.slug`, with the same source text. `slugRefusal(value, what)` gives the rule and, past the bound, the number, for callers to refuse with in place of their own copies. |
| shared/names.ts:112 | `domainNameFor` cut at 40 (`slice(0, 33)` plus a hash) | keep | Derived from `NAMES.slug`. |
| shared/names.ts:156 | branch ≤ 200 | 4, hard | `NAMES.branch`. `branchRefusal(value)` keeps the callers' sentence ("'x' is not a branch desolate will carry") and adds the bound when that is what was missed. |
| shared/names.ts:332 | `DESOLATE_HOSTNAME_SUFFIX` ≤ 120 | keep hard | Unchanged. |
| shared/run.ts:23 | `RUN_MAX` 192 MiB per stream, the only bound (no caller passes `maxBytes`, and there is no default timeout). It compared a string's UTF-16 length with a chunk's bytes, and decoded each chunk alone | 4, hard; better code for the count; an option for the rest | The default stays 192 MiB: host/carry.ts reads the root's whole state as base64 on stdout, which can reach tens of MiB with the proxies' audit logs, and the root's git callers read large listings. `Backend.exec`, through which every VM-facing host call goes, cannot pass `maxBytes`. Output is now kept as bytes, counted in bytes and decoded once at the end, so a character split across two chunks is one character. Each stream is one buffer that doubles as it fills: held memory is at most about twice `maxBytes`, where a list of chunks held 141 bytes per byte for output written a byte at a time. A spawn node refuses synchronously (a NUL in an argument) answers 127 and does not throw. New option `stdoutTo`: stdout goes to a file, whole, and is not kept. `"/dev/null"` serves a caller that needs only the exit code. In-source tests have controls: the old code kept 12 bytes under a 10-byte bound and broke a split `€` into three U+FFFD. No default timeout, by R4: patience belongs to the caller. |
| shared/run.ts:122 | `must()` error `.slice(-2000)` | keep | Unchanged. |
| shared/run.ts:144 | `waitFor` every 100 ms | keep | Unchanged. |
| shared/sniff.ts:18 | `LIMIT` 16 KiB | 4, hard (R7) | Now says why: a TLS record's largest body is 2^14 bytes, which is also node's HTTP header limit. |
| shared/sniff.ts:263-278 | `quietMs`, chosen by the caller | keep | Unchanged. |
| shared/link.ts:115, :179 | handshake `timeoutMs = 10_000` | 4, hard | Named `HANDSHAKE_MS`, with its reason. Both ends default to it, so behaviour is unchanged. |
| shared/terminal-filter.ts:107, :133 | CSI 256, OSC/DCS 64 KiB | keep hard | Unchanged. Their comments already say why. |
| shared/gate.ts:87, :93 | header text cut to 40 / 80 in a 403 reason | keep | Unchanged. |
| shared/ui/highlight.js:12, :13 | `WAIT_MS` 2500; `MOST` 1 MiB / 40,000 lines | keep hard | `MOST.bytes` now says it counts UTF-16 units. |
| shared/ui/markdown.js:24, :252 | `DEEPEST` 8, block depth 12 | keep hard | Unchanged. |
| shared/ui/markdown.js:134, :143 | autolink scanned in 2100 characters: a longer bare URL was linked cut, to the wrong address | keep; a cut link is never made | Named `LINK_MOST`. A bare address that runs past it is left as text. T1 (`tests/v3/t1/issues.test.ts`) has a control: one that fits is still linked. |
| shared/text.ts:14-22 | `printable` default | (the foundation's) | Not touched. |
| shared/approval.ts | LFS count, `--max-count` | not in this effort | Not touched. |

## Behaviour that changed for a caller
- **The dashboard's Create domain refuses a title that is not one.** Before, such a title was
  left out and the domain made without it. `tests/v3/t2/09-ui.test.ts` and
  `tests/v3/t1/actions.test.ts` now expect the refusal (400 / null), with a control.
- **A spawn's command is counted in characters, not UTF-16 units.** No command taken before is
  refused now. One whose words are outside the basic plane may now be up to twice as long in
  UTF-16 units, which is still far under `ARGUMENT.command` and the system's argument limit.
- **run()'s stderr after an end.** The reason (`(cancelled)`, `(timed out ...)`) is always
  last, even when the program wrote more stderr after it was told to end.

## Measured
- 5,000 branches in packed-refs: about 350 KiB, past the old 256 KiB bound. The commit is
  found (T1, status.test.ts). With the old reader, none is.
- run(): `sh -c "printf '€€€'; sleep 0.2; printf '€'"` with `maxBytes: 10`. The old run kept
  all 12 bytes, exit 0. The new one stops it, exit 128.

## The independent reviews
Two fresh reviewers, each given the threat model and the code but not my conclusions, read
the change. The second read the fixes for the first's findings. Fixed, each with a test:
- `run()`'s chunk-list memory.
- The synchronous spawn throw, and the `stdoutTo` descriptor it leaked.
- `hostArgv` leaving out arguments it should refuse.
- A command signed and then not carried.
- `keepApart`'s endless loop, and its 65-character names.

Not fixed here, with the reasons:
- **Batched `merge-base` refuses a proposal that reverts `.github/` to an older remote state**
  (one that per-tip bases passed). This fails closed and is rare.
- **Different keys can still make the same secret name against secrets the domain already
  has** (`DB` and `DB_SECRET` are both `DB-SECRET`), and `keepApart` takes such a name as the
  same secret imported again. That is the behaviour before this change. Fixing it means
  hashing every lossy spelling, which renames existing secrets on re-import.
- **Outside this ticket's files** (listed under "Needs from another ticket" in the pull request):
  - stated.ts's 200-character pre-filter;
  - stated.ts's generic refusal, which should be `actionRefusal`;
  - the host's request queue handing over every queued spawn whole;
  - the daemon logging a spawn's command unsanitised;
  - a 65,536-character command passed to the VM as one shell string, which can exceed Linux's 128 KiB per-argument limit (`MAX_ARG_STRLEN`).
