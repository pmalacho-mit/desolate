# Limits 13: `desolate settings`, one registry for what depends on this Mac or this person

Ticket 13 of the limits effort (#185). The rules are [`../limits.md`](../limits.md)'s; this is
R6 made real: the foundation's `define` / `valueOf` (`release/shared/settings.ts`) with a
store behind them, a command to read and change them, and the sizes of the root and git VMs
as settings.

## What changed, by rule

- **R6, one registry.** `valueOf(setting)` (signature and callers unchanged) now reads, in
  order: the setting's variable in the process that reads it; what `desolate settings set`
  stored; its default. Where it came from is `lookup(setting).from`.
  - **The store is the person's, on the Mac:** `~/.desolate/settings.json` (the host's home,
    `DESOLATE_HOME`), `{ "<name>": { "value": "<text as typed>", "side": "<where read>" } }`,
    written atomically. No VM's share reaches the home's top level (checked against every
    spec: root, git, workspace).
  - **A setting read in a VM** (side `root`, `git`, `workspace`) is passed in by the host
    when it starts that VM (`passInward`, `release/host/settings.ts`): only that side's
    entries, written as root to `/etc/desolate/settings.json` on the VM's own disk (not a
    share), 0644 in a root-owned 0755 directory. In the root VM, its ordinary user (which
    runs what reads a domain's data) can read it and cannot change it. In the git VM and a
    workspace, what runs there may be root there: what is passed in is that VM's own.
  - **Each side reads only its own store.** A setting of the Mac's read by code running in
    a VM (desolate's code is at `/desolate/release` or root's copy under `/opt/desolate`
    there) has no store: its variable and its default only. (Found by the fresh review: it
    would otherwise have read a store in that VM user's home, which that user writes.) The
    Mac's environment is never passed inward: a variable in the person's shell is for what
    runs on the Mac.
  - **A value a setting does not take is refused, never the default:** a variable, with
    `unset <VAR>`; a stored one, in the setting's own words ("root.memoryMiB is stored as
    'x', and must be ..."), with `desolate settings set/unset`; a store that is not one
    desolate wrote, with `mv` it aside. These are `Refusal`s (an `Error`, as the contract
    says), so the CLI prints the fix instead of a stack.
  - **The listing needs no list.** `desolate settings` imports every file under `release/`
    that imports `define` from `shared/settings.ts` (found by reading them), so a setting a
    ticket declares in its own file is listed when it lands. Checked against every limits
    branch pushed tonight merged together: 20 settings listed, `root/rootd.ts`,
    `root/reviewer-packs.ts`, `host/daemon.ts` and the rest imported cleanly.
  - **`set` says which restart it needs** (`applies`): a VM's size when that VM starts
    again; a workspace's default size for workspaces made from then on; a root-side setting
    when the root's services start again (`desolate down`, then `desolate bootstrap`).
- **Sizes are settings, defaults from the machine.** `shared/size.ts`:
  - `root.cpus`, `root.memoryMiB`: a quarter of the Mac's cores (2 to 4) and an eighth of
    its memory (2 to 4 GiB), never above the Mac. Before: 2 CPUs and 2 GiB on any Mac.
  - `git.cpus`, `git.memoryMiB`: 2 CPUs and 1.5 GiB, as before, never above the Mac.
  - The person cannot set the root or git VM above this Mac (its cores; three quarters of
    its memory): a root that cannot start is a stack that cannot start, so it is refused at
    `set`, in the Mac's own numbers.
  - Their disk is the base image's (30 GiB), a fact, not a setting.
  - `workspace.cpus`, `.memoryMiB`, `.diskGiB` (the existing `DESOLATE_WORKSPACE_*`): the
    stack's default workspace size, defaults as before (`defaultsFor`), ranges as before.
- **R1.** `projectSize`'s `shown` (size.ts:229) cut repository text to 40 characters with no
  mark: now `printable(..., 40)`, which ends a cut in `…`.
- **R7.** The three-quarters rule for a project's size stays a hard bound (it bounds a
  repository's word), now one named function, `mostMemoryFor`, shared with the VM settings.
- **R9.** `shared/size.ts`'s `parseMemory` moved into `shared/settings.ts` (size.ts
  re-exports it): settings.ts read it from size.ts, and size.ts now declares settings, which
  would have been an import cycle that breaks by load order.

## The rows

| where | what it was | answer | what it is now |
|---|---|---|---|
| host/stack.ts:141-143 | root VM `cpus: 2, memoryMiB: 2048, diskGiB: 30` | setting (CPUs, memory); disk a fact | `...vmSize("root")`: `root.cpus`, `root.memoryMiB`, defaults from the Mac; disk 30 as before |
| host/git-vm.ts:64-66 | git VM `cpus: 2, memoryMiB: 1536, diskGiB: 30` | setting (CPUs, memory); disk a fact | `...vmSize("git")`: `git.cpus`, `git.memoryMiB` |
| shared/size.ts:100-104 | default workspace size from the Mac | setting (already one, by variable) | `workspace.cpus/.memoryMiB/.diskGiB` in the registry; `workspaceDefaults()` |
| shared/size.ts:326-336 | a project's CPUs at most the Mac's cores, memory at most 3/4 | keep hard (R7: a repository's word) | unchanged, `mostMemoryFor` named and shared |
| shared/size.ts:16 | `LIMITS` (1-64 CPUs, 1-256 GiB, 30-2048 GiB disk) | keep (facts: what a VM may be; 30 is the base) | unchanged |
| shared/size.ts:229 | `shown`: `.slice(0, 40)`, no mark | R1 | `printable(value, 40)`, with the mark |

## Environment variables (R6)

A T1 check (`tests/v3/t1/settings.test.ts`) fails on any `process.env.DESOLATE_*` read in
`release/` that is not a setting's, unless it is named there as not a tunable (a place, an
identity, a test's hook, a protocol between desolate's own processes) or as a tunable whose
own ticket moves it (02 `DESOLATE_APPROVER`, 03 `DESOLATE_APPROVAL_WAIT_MS`, 06
`DESOLATE_LANDED_CHECK_MS`, 08 `DESOLATE_TEMPLATES`, 09 `DESOLATE_RAW_PORTS`, 11
`DESOLATE_DOCTOR_PORTS`, 15 `DESOLATE_EDITOR_PORT`; and `DESOLATE_BROWSER` in host/cli.ts,
outside every ticket's lines). A read by a computed name is allowed only in the registry,
its listing, the proxy's pass-through and host/workspaces.ts (ticket 8's to remove). It is
tested beside a control that shows it finds both kinds. No variable that nothing reads was found in
the TypeScript; the triage's "read but unused" one was not identified.

## What needs other tickets' files

The registry stores and lists on its own; what makes a stored value reach a VM, or a VM's
size, is a line in files other tickets own. Branch `mac/limits-13-settings-hooks` is this
branch plus exactly those lines (and a T2 test in `18-size` that proves them):
- **limits 11, host/bootstrap.ts:** before `b.start(ROOT_VM)` of a stopped root,
  `sizeBeforeStart(ROOT_VM, "root")`; first thing in `startRootServices`,
  `passInward(ROOT_VM, "root")`.
- **limits 12, host/git-vm.ts `ensureGitVm`:** `sizeBeforeStart(GIT_VM, "git")` before
  starting a stopped git VM; `passInward(GIT_VM, "git")` after it is provisioned.
- **limits 8, host/workspaces.ts:** `stackDefaults` is `workspaceDefaults()` (`sized`
  deleted; its test now expects the registry's refusal); `passInward(plan.vm, "workspace")`
  before `workspace/start.sh`.
Until they land, `desolate settings set` stores and lists, a new root or git VM is made at
its settings' size, and a stored workspace size or a VM-side setting has no effect.
