# Limits 04: the dashboard's review counts what it shows and pages the rest

Ticket #176. The root's own review of an offered branch (`root/offers.ts`), the dashboard that
shows it (`root/ui/dashboard.js`, `.css`, `.html`, and its service `root/stated.ts`), and the
`desolate review` printing in `host/push.ts`. The rules are [`../limits.md`](../limits.md).

## What a review is now

- `review()` answers `commits: Listed<Commit>` and `changes: Listed<Change>`
  (`shared/listed.ts`): the first page of each (`PAGE`, 100) and the true total, counted by
  git (`rev-list --count`; the whole `--name-status` list). `pushCommits` is still what a push
  would send, counted against origin.
- `more()` (`GET /review/more`) gives the next page of either list: `list=commits&from=N`,
  or the files, `from=N`, of the commits picked (`pickFrom`, `pickTo`) when some are. It reads
  the root clone as it is and says which commit it read (`commit`). A page whose commit is not
  the reviewed one tells the dashboard that the branch moved.
- `diff()` (`GET /diff`) is a page of bytes (`DiffPage` of `shared/review-account.ts`: `text`,
  `from`, `next`, `total`), at most `DIFF_PAGE` (256 KiB or 3,000 lines, which is what draws
  quickly), cut after a line. `at=N` asks for the page that starts there. `file` (and `was`,
  for a renamed file) asks for that file's diff alone, taken as a literal path.
- Nothing in a review has a timer (R4). git runs until it is done or until the page's request
  closes: `stated.ts` aborts on the response's `close`, and `gitBytes`/`git` kill the git that
  only reads. The fetch a review starts with runs to its end (it writes the shared clone).
- A commit picked is checked by git against the review's range (`merge-base --is-ancestor`),
  whichever page it was listed on. Before, it had to be one of the 200 listed.
- Renames are found (`--find-renames`) the same way for the list, the counts and the text. A
  moved file is one entry with `was`. The `.github/` warning checks both paths.

## Each limit

| where (before) | what it was | answer | what it is now |
|---|---|---|---|
| root/offers.ts:639 | `--max-count=200` on the review's commits; every count said 200 | eliminated (R2) | `commitsIn`: `rev-list --count`, then a page with `--skip`; `/review/more` for the rest |
| root/offers.ts:524, :539 | `CHANGES_MAX = 1000` files | eliminated (R2) | the whole list is made, and sent `listed()` a page at a time |
| root/offers.ts:770, :954-957 | `DIFF_LIMIT = 1 MiB`, then "longer than is shown" | eliminated (R1) | `diffPage`: pages of 256 KiB / 3,000 lines with `next` and `total`; a file at a time on asking |
| root/offers.ts:949-952 | 60 s kill on making a diff, reported as "longer than is shown" | eliminated (R4) | no timer. The page says "making the diff... (git is at it in the root: a large one takes a while, and Close stops it)" and closing stops git |
| root/offers.ts:245 | `request.lfs.slice(0, 2000)`: an offer past 2,000 could never pass | eliminated | every object named is verified and taken. The request's own bound (the out-box's 1 MiB JSON file, `root/outbox.ts`) bounds the list: about 11,000 objects |
| root/offers.ts:482 | `Number(size) >= 400` for a possible pointer | named (R3) | `LFS_POINTER_BYTES` (1024). Pointers are read by `git cat-file --batch`, a thousand blobs a git and not one git a blob |
| root/offers.ts:215-216 | 5 attempts, 700 ms apart, for a branch to show through the share | kept hard | unchanged (the share has no handshake to wait on) |
| root/offers.ts:117-120 | 5 retries of `git fetch <domain>` on a ref lock | kept | unchanged; a cancelled request stops retrying |
| root/offers.ts:113, :122 | `timeoutMs: 600_000` on `git fetch <domain>` | eliminated (R4) | no timer: it reads a bundle from a share (work, not a wait on a peer). It is not cancelled either: killed mid-write, git leaves ref locks in the clone every domain shares. Its error is `failure()`'s last lines, not `.slice(-400)`. The other rows of this line (repos.ts, the remote helpers) are ticket 5's |
| root/stated.ts:1505 | each action argument `value.length <= 200`, else silently dropped | bound kept, refused in words | over `NAMES.branch` (the longest honest argument): `over("the argument 'x'", ...)`; not text: refused by name |
| root/stated.ts:1099-1105 | body `limit = 262_144` characters, "too large" | kept hard (R7, R8) | `BODY_BYTES` counted in bytes, with its reason and its own message |
| root/stated.ts:1155, :1187 | `SIGNIN = { ttlMs: 60_000, most: 32 }`, a copy of host/signin.ts | one place (R3) | `shared/signin.ts`. host/signin.ts still holds its own copy: ticket 11 imports it |
| root/stated.ts:972-975, :1205-1206 | an action's lines cut to 300 characters, the oldest dropped past 60 | eliminated (R1) | each line made safe, not shortened, and appended to `<state>/actions/<id>.log`; the page is sent the last 60 (`SHOWN`), `earlier` (how many came before) and `log` (where all of them are). The files go with the actions this process remembers |
| root/stated.ts:280 | making line `printable(...)` then `.slice(0, 200)` | eliminated (R1) | whole (safe); the page fits it with CSS and puts it in `title` |
| root/stated.ts:687 | `printable(message, 200)` | named (R3) | `NAMES.status` |
| root/stated.ts:874 | 600 characters of a command shown | kept | cut with `CUT`, said |
| root/stated.ts:1244, :1260, :585, :506, :654, :729-735, :862-866, :607, :601, :760-764, :644, :1399, :1554-1556 | long polls, silence, caches, events.jsonl, actions remembered, sent and heartbeats | kept | looked at once each; none is a copy of a shared bound, none is dead |
| (new) `domain.create` | a title shared/actions.ts would leave out made the domain without it, silently | refused in words | the root refuses it, and says how to give any title from a terminal |
| root/ui/dashboard.js:525, :533, :541 | `review.commits.slice(0, 40)` | eliminated (R2) | every commit sent is a button in the scroll box; "and N more commits" with Show more, the counts the root's |
| root/ui/dashboard.js:261-278 | `DIFF_LINES = 3000` drawn, "Show the rest" | removed (R9) | the root's page is the unit (it is the same 3,000 lines); "N% of the diff is shown" with Show more |
| root/ui/dashboard.js:590 | `reviewing.diff.truncated` warning | eliminated | there is no cut: `next` says there is more |
| (new) files past the diff shown | a file's name scrolled to its place only if it had been drawn | per file | a click on a file the pages shown do not reach asks for that file's diff alone ("Every file's diff" goes back) |
| root/ui/dashboard.js:117 | an action's error gone after 8 s | eliminated | stays until Dismiss or the next action |
| root/ui/dashboard.js:113 | 1.5 s a button stays disabled after its action | kept | unchanged |
| root/ui/dashboard.js:978 | reconnect every 1.5 s, saying nothing | shown | 1.5 s, doubling to 30 s; after 3 failures in a row the header says "lost the root's dashboard service: trying again (N tries so far). What is shown is as it last was." |
| root/ui/dashboard.js:211 | `n * m > 40_000` side-by-side pairing | kept | unchanged |
| root/ui/dashboard.js:676 | Resize starts at `{ cpus: 2, memoryMiB: 4096, diskGiB: 30 }` | eliminated (R3) | `state.bounds.size.defaults`: `defaultsFor` for this Mac, worked out by the root from the host's facts |
| root/ui/dashboard.js:680-682 | inputs 1-64 CPUs, 1-256 GiB, disk-2048 | read from one place, and this Mac | `state.bounds.size.limits` (shared/size.ts `LIMITS`) and `most` (`capToMac`: this Mac's cores, three quarters of its memory); the labels say "at most N here" |
| root/ui/dashboard.js:862 | domain title `maxlength: "80"` | agrees | 80 is what the dashboard may ask the host for (shared/actions.ts); a longer one is refused by the root in words. The CLI's `.slice(0, 200)` is root/domains.ts, ticket 5's |
| root/ui/dashboard.js:362 | issue title `maxlength: "256"` | named (R3) | `state.bounds.issueTitle` (shared/issues.ts `LIMIT.title`) |
| root/ui/dashboard.js:848, :861 | slug pattern `{0,39}` | named (R3) | built from `state.bounds.slug` (shared/limits.ts `NAMES.slug`) |
| root/ui/dashboard.js:791 | default workspace name `.slice(0, 40)` | named (R3) | `.slice(0, state.bounds.slug)` |
| root/ui/dashboard.js:507 | filter box past 6 files | kept | unchanged (it counts the total now) |
| root/ui/dashboard.css:233 | ellipsis on a commit's subject | eliminated (R1) | the subject is in the button's `title` |
| root/ui/dashboard.css:147 | ellipsis on a named pill's value | eliminated (R1) | the value is in its own `title` |
| host/push.ts:257-262 | `r.commits.slice(0, 30)`, "a push would send 200 commit(s)", "and 170 more" | eliminated (R2) | `pushCommits` and `commits.total`; the first 30 and `andMore` of the true total |
| host/push.ts:261 | subject `.slice(0, 100)` | eliminated (R1) | whole: the terminal wraps it |
| host/push.ts:263-264 | `r.files.slice(0, 40)` | kept as a screenful | the first 40 of `changes`, renames as `old -> new`, `andMore` of the total |
| host/push.ts:276-278 | `d.truncated` | eliminated | the diff is asked for and printed a page at a time; nothing is held |
| (new) root/push.ts | the push's checks read `r.commits.length` | follows the contract | `r.commits.total` (ticket 3's file: three lines and the fixtures of its in-source tests) |

## What is not done, and why

- **`desolate review --diff` past its first page.** `root/ops.ts` (ticket 5) passes only
  `domain, repo, branch, against` to `offers.diff`. The host asks for each page with `at`; a
  root that answers with the first page again is detected and the rest is said ("N% of the
  diff is shown here. The rest: ..."). Once ops.ts passes `{ at: args.at }` as `ask` (and the
  host's whole asks fetch, `ask === null`, turns into a fetch on the first page only), the
  terminal prints the whole diff.
- **A diff page is made by running the whole diff each time** and keeping one page of it. A
  very large diff read to its end costs one git diff per page. A file at a time (the dashboard's
  jump) bounds each to that file. Keeping a diff made once (a file in the root's state, named
  by the commit pair) is the next step if it is measured to matter.
- **The two reviews are still two.** The approval page shows desolate's reviewer's account
  (`shared/review-account.ts`, ticket 1); the dashboard shows this, the root's own. To make
  them one: `review()` would answer an `Account` (its `commits`, `files` and `between` are
  already `Listed` of the same shapes, give or take `author`), `more()` would be the account's
  `page` op and `diff()` its `diff` op (`{ file }` | `{ commit }` | `"net"`, with `from`), and the
  dashboard would read the same lines the approval page reads. The difference that stays is
  where it runs: the reviewer runs on its own account with no domain write access, and this
  runs in `stated`.
- `docs/v3/decisions.md:261` still says the diff is "capped at 1 MiB"; that file is not this
  ticket's to edit.
