# `desolate`

**desolate** (dev + isolate) is a browser-based, VM-isolated development
environment for macOS[^1].

Its goal is to enable human developers to work alongside coding agents
without sacrificing developer experience nor sandbox isolation.

Whether or not you trust LLMs, supply chain attacks are on the rise.
Paired with the inherit [vulnerabilities](https://blog.theredguild.org/leveraging-vscode-internals-to-escape-containers/) of running VS Code natively[^2],
executing code has never been more dangerous.

In essence, `desolate` allows the developer to sandbox themselves along with their agent(s),
all without giving up the ergonomics key to their workflow.

[^1]: The `desolate` architecture should be applicable to both Windows (with WSL2) + Linux, and could be even simpler without the need for a Linux VM (i.e., [colima](https://colima.run/)). [@pmalacho-mit](https://github.com/pmalacho-mit) is on a mac, so contributions to support other operating systems are welcome.

[^2]: As the Red Guild's ["Leveraging VSCode internals to escape containers."](https://blog.theredguild.org/leveraging-vscode-internals-to-escape-containers/) explains, VS Code is a ripe <ins>local</ins> attack surface even when connecting to remote development environments.

This repo is a [suede dependency](https://github.com/pmalacho-mit/suede).

To see the installable source code along with the full documentation, please checkout the [release branch](https://github.com/pmalacho-mit/desolate/tree/release).

## Status: v3, being tried by its first users

`main` is **v3: a VM per workspace**, as specified in [`move-to-vms.md`](move-to-vms.md). It
replaced v2 (containers on a sysbox daemon in one Colima VM), and its `release/` is what the
`release` branch publishes and people install.

- What desolate is, its principles, and what works today: [`release/README.md`](release/README.md)
  and its [reference](release/docs/reference.md).
- For its first users, what to expect and what to report: [`release/docs/dogfooding.md`](release/docs/dogfooding.md).
- For developing it (from inside a desolate workspace), and what has and has not been tested:
  [`AGENTS.md`](AGENTS.md) and [`release/docs/developing-desolate.md`](release/docs/developing-desolate.md).
- What was decided along the way, with the measurements: [`docs/v3/decisions.md`](docs/v3/decisions.md).
- v2 is in history at `4f32c77`. The v2 code v3 has not ported yet is in [`carryover/`](carryover/README.md).

## At a glance

One VM per workspace, workspaces collected into domains that share repositories and network
rules, and one root VM that holds every key and is the only place a push can start. A
compromised workspace cannot reach your Mac, your credentials, another domain, or a remote:
its shares and its one network link are decided outside it, and a push needs you, on a
terminal, naming the commit you reviewed.

How desolate has been wrong before, and what each time taught:
[incidents](release/docs/incidents.md).

## System requirements

- A Mac with Apple silicon, with [Lima](https://lima-vm.io) 2.3 or newer (`brew install lima`)
  and node 22.18 or newer. (Linux with QEMU is a backend for testing and CI, not a supported
  host.) [getting-started](release/docs/getting-started.md) has the rest.
- GitHub CLI (`gh`), to register deploy keys when you clone a repository.

## Working on this repo

`release/` is the **shipped tree**: everything in it installs onto a user's machine.
Everything else is dev and test harness and does not ship. That split is prescribed by the
suede dependency workflow, and must be respected when adding files.

```
release/           THE SHIPPED TREE (see release/README.md for its layout)
tests/v3/          the tiers: t1 (unit), t2 (end to end, containers), t3 (real VMs, QEMU), t4 (the Mac's own VMs)
tests/probes/v3/   Phase 0 probes to run on a Mac
docs/v3/           the decisions, the Mac's measurements, and the first pass's handoff (a record)
carryover/         v2 code that v3 keeps and has not ported yet; not shipped, not run
samples/           example devcontainers; fixtures
.devcontainer/     this repository's devcontainer, for developing desolate in a desolate workspace
```

```bash
npm install              # TypeScript, for the type check
make test                # T1: seconds, anywhere
make e2e-fast            # T2: minutes; needs Docker and the base image (tests/v3/README.md)
make e2e-slow            # T3: real VMs; run whenever something structural changes
tests/v3/run.sh t4       # T4: the boundary tests on the Mac's own VMs (vz); about 3 minutes
```

Three conventions the code holds to, all load-bearing:

- **Fail closed, and say so.** A step that cannot be checked refuses, and every refusal
  names the command or flag that fixes it. A step that reports success while having done
  nothing is the failure this project is most prone to.
- **A negative test sits beside a control.** "Root cannot write the mirror" proves nothing
  unless the same write demonstrably lands somewhere root may write.
- **A boundary is tested on the tier that has it.** The fake backend (T2) is for speed; a
  claim about what a VM stops is tested on real VMs (T3), and on a Mac for the Mac.
