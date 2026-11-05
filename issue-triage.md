# Issue triage (#42) — which open issues can be dismissed

Read from the public issue list and checked against the code on `main` (75e309b). Issues labeled `desolate:run` (#37, #40, #42) are active and left alone. "Closing" is a human action (no write credentials here).

## Close: fixed in the code (the code cites the issue)

| # | Title | Evidence |
|---|---|---|
| 26 | policy reads a stale container's metadata | `release/vscode-image/devcontainer.ts:49` (resolveSpec no longer answers from an old container), `policy.ts:93`, `desolate.ts:2036,2095` cite #26 |
| 17 | `DESOLATE_EXTERNAL_<port>` env vars | `editor.ts:197-217` sets `DESOLATE_EXTERNAL_<port>` and `_URL`; documented in `release/AGENTS.md`. (The comment about clickable links in the editor is not obviously done — mention it if you want it kept as a new issue.) |
| 15 | cannot remove root-owned files from docker | `desolate.ts:1919` "Give the editor back what a container wrote as someone else (#15)"; `cli.sh:1626,1638` |
| 14 | dind-sysbox-data ballooning | `cli.sh:662` `dind df | gc` ("giving it back (#14)"); gc output says what each line freed |
| 13 | Getting files out of workspaces | `cli.sh:1706` "Getting files out (#13)" |
| 12 | secrets to author domains shouldn't fail | `proxy/vm/addon.py:29,298`, `cli.sh:1464`, `preflight.sh:412`: placeholder now passes through unsubstituted with a LEAK-SUSPECT audit line instead of a 403 |
| 11 | `--shadow` ignored by BuildKit | `dind.ts:44` MIRROR: a per-dind registry mirror makes BuildKit (Engine API) get the derivative (T5.3, S7) |
| 25 | project git config/hooks/links reach outside | The issue body itself says "Fixed on `m1/phase-0` (T0.3)", which is merged via v2 (#29); worktree add/remove run in sandboxes, `worktree list` hardened. Residual "git you type in the editor" is documented as out of scope in `release/README.md`. |

## Keep open

| # | Why |
|---|---|
| 18 | Remote/detachable sessions: a feature request, nothing in the code or docs implements it. |

## Caveats
- I verified by reading code references, not by re-running the repros. For #11 and #25 in particular, a quick run of the cited tests (`tests/static/14`, `tests/integration/worktrees` E17) before closing would confirm.
- Suggested close comment: link the commit/PR that fixed it, or "fixed in v2 (#29)".
