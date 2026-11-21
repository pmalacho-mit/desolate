# Limits 10: the egress proxy's reports show every host, and its log has one rule for every writer

Ticket 10 of the limits effort (issue #182). What each limit in `release/root/proxy/` and
`release/host/domains.ts` was, which of the four questions answered it (limits.md), and what
it is now.

## The limits

| where (before) | what it was | answer | what it is now |
|---|---|---|---|
| host/domains.ts:275-286 | `reached.slice(0, 60)`, `refused.slice(0, 60)`: the report and its `net allow` command cut at 60 hosts, silently; following it then `net enforce` cut off the rest | removed (R1, R2) | The root answers every host with its count (`Listed`). The host shows a page (`PAGE`, 100), says "and N more hosts", and before the command, when the page is not all, "(only the 100 above, of 121: every one, `... net recommend --all`; for a program, `--json`)". The command allows exactly what is shown. `--all` lists and allows every one. |
| root/proxy/manage.ts:256 | `last: 100_000`: recommend read the last 100,000 entries of audit.log into memory; audit.log.1 never read | removed (stream) | `recommend` reads every file the log keeps as a stream (`audit.ts` `auditLines`); what it holds is one line and the counts. |
| root/proxy/manage.ts:301, root/ops.ts:234 | 100 entries for `net log`, and nothing said of the rest | removed / kept as a page | `net log --last <n>`, a hundred by default (`PAGE`); the answer is `Listed`, and the text says "the last 100 of 4231 entries (more: ... --last <n>)". (`ops.ts`'s own `|| 100` is another ticket's file; it passes `last` through.) |
| root/proxy/proxy.ts:75-77; secrets_addon.py:250-251 | `64 * 1024 * 1024`: each of several processes rotated one audit.log by its own count; one rotation could overwrite the .1 another had just made | removed (one rule), retention a setting (R6) | `audit.ts`: the log is a series, `audit-1.log`, `audit-2.log`, ... Every writer appends to the newest; the first to find it over its share begins the next by an exclusive create; nobody renames. Past `AUDIT.files` (4) the oldest is unlinked. The budget is `proxy.auditMiB` (`DESOLATE_PROXY_AUDIT_MIB`), default 1/256 of the disk under `/var/lib/desolate-proxies` (120 MiB on the root's 30 GiB), between 16 MiB and 4 GiB, passed by the root to every writer. The add-on repeats the rule; T1 checks the constants agree. |
| root/proxy/secrets.ts:331 | `body_size_limit=256m`: any body through a secret's host, download included, refused past 256 MiB | removed for what names no secret; a setting per domain for what is held (R6) | mitmproxy's option is gone. A body is held whole up to `secrets.heldMiB` (`DESOLATE_SECRETS_HELD_MIB`, 256, at most 1024) or the domain's own (`net hold <size>`, policy.json `heldMiB`). Past it, or of no fixed length, it streams: responses through `Scrub` (values taken out as they pass, content-encoding undone, length from the head, chunked for HTTP/1.1), requests through `Watch` (names watched; one that would be put in past the bound refused, masked, its response withheld). A request of no fixed length under the bound is held inside the stream and gets its values as before. |
| root/proxy/proxy.ts:595, :599 | `10_000` ms, `8192` bytes: a workspace's CONNECT | hard (R7) | `ASKED.headMs`, `ASKED.headBytes`, each saying whose input and why that number. |
| root/proxy/proxy.ts:484 | `sniffSocket(client, 10_000)` | hard (R7) | `ASKED.firstBytesMs`. |
| root/proxy/proxy.ts:168, :406, :443; secrets_addon.py:242 | `300`, `100`, `100`, `[:200]`, cut silently | hard, and said (R1, R7) | `ASKED.reasonChars` (512: the longest reason of ours is under 400 with a 253-character name in it), `ASKED.nameChars` (100), cut by `printable`, so a cut ends in `…`. The add-on cuts its host, method and reason the same way (`NAME_CHARS`, `REASON_CHARS`, T1-checked against `ASKED`) and its route at `ROUTE_CHARS` (200). |
| root/proxy/secret-store.ts:45, :78-81; secrets_addon.py:71 | `[A-Z][A-Z0-9_-]{7,63}` | hard (R3, R7) | `PLACEHOLDER` in secret-store.ts, with its reason; the add-on's `SECRET_NAME` is T1-checked to be the same rule. |
| root/proxy/secrets_addon.py:285-286 | `[a-z0-9-]{1,80}` for the workspace on a tunnel | hard, one rule (R3) | `WORKSPACE_NAME`, T1-checked to be names.ts's `SLUG` (40). |
| root/proxy/secrets.ts:249 | `64 * 1024`, the CA certificate | hard | unchanged (a certificate is under 2 KiB; the file is the proxies' user's). |
| host/domains.ts:180-184 | `max > 1000` for `spawn --max` | removed | Any whole number is a limit a person may mean. The root keeps its own (root/domains.ts:260, another ticket's) and says so. |
| host/domains.ts:356-365 | ".env is over 64 KiB" | hard, said with `over()` | "`<file>` is 70 KiB, over the 64 KiB a .env may be: not a .env". `ENV_MAX` and its "bytes" are env-import.ts's (not this ticket's). |
| root/proxy/proxy.ts:45, secret-store.ts:47, manage.ts:278 | three copies of the slug rule | one rule (R3) | `isSlug` from shared/names.ts. |
| root/proxy/proxy.ts:47, manage.ts:49 | two copies of the VM-name rule (60) | one rule (R3) | `VM_NAME` in as-proxy.ts. |
| root/proxy/proxy.ts:185-186 | ports 80 and 443 | not this ticket | The owner's decision (#188). Unchanged. |

The "keep" rows, looked at once: `host/domains.ts:68` (installing a CA, 120 s: an operation
another ticket's timeout work owns), `proxy.ts:476` (30 s to connect to a destination: an
idle timer against a remote peer, R4), `proxy.ts:517` (8192, the secrets proxy's reply: a
protocol fact), `secrets.ts:306-308` (the port range), `secrets.ts:353-357` (the start wait),
`secret-store.ts:124` (a year's TTL), `manage.ts:74` (the proxy's start wait),
`as-proxy.ts:87` (`pkill`'s 10 s): none made dead by this change; left.

## What was measured

The add-on against real mitmproxy 11.0.2 (`desolate/base:latest`), a stand-in upstream on
443 (HTTP/1.1, and node's HTTP/2), a hold bound of 1 MiB:
- a 3 MB upload naming nothing: arrived whole (sha256 equal), by Content-Length, chunked,
  and HTTP/2 without a length;
- the same naming a secret: refused (the client sees an empty reply), the name masked;
  under the bound, chunked or HTTP/2 without a length, the value was put in;
- a 5 MB download with the value in it, by length, chunked (the value cut between two
  chunks), gzip, HTTP/2 with and without a length, HTTP/1.0: the value taken out every time,
  the length 8 bytes shorter (the name is 8 shorter than the value); the control, the same
  download without the proxy, has the value;
- an HTTP/2 GET naming a switched-off secret: 403, with why.

## What a review found, and what is left

A fresh-context security review of the change (2026-11-21) found, and this ticket fixed: a
decompression bomb (a body is now never undone past the hold bound, held or streamed;
the held path used mitmproxy's own unbounded decode before this change too); an empty
HTTP/2 DATA frame taken for the end of a body of fixed length; a quadratic copy of what is
held; 204/304 bodies held without a bound; the add-on's audit fields not cut; a writer that
could stay on a full file when the next could not be made; HTTP/2 GETs refused by their head
losing the 403's reason.

Left, each said where it is:
- **The bound is per request.** Several held bodies at once each hold their own, as
  `body_size_limit` did. A cap across a domain's flows would need a count shared by
  mitmproxy's flows; not built.
- **An empty HTTP/2 DATA frame in the middle of a body of no fixed length** is taken for
  its end: a value an upstream cuts exactly there is passed in two pieces. Only an upstream
  that sends one does it; the upstream is the secret's own host.
- **A streamed request is decided by its head before its body is seen.** A value in its head
  goes to its secret's host before a later name in its body refuses it; the refusal then
  withholds the response (a reset, not a 403). Values go only where their secrets allow.
- **A streamed compressed response reaches the client decompressed**, with no
  content-encoding and no content-length.
- **The log's rotation in T2** is not exercised (the smallest budget is 4 MiB of lines);
  T1 runs four writer processes at once across files.
