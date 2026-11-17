# For agents developing desolate

This file is for an agent changing desolate itself. (An agent using desolate to work on some
other project reads [`release/AGENTS.md`](release/AGENTS.md) instead; that one is shipped
into every workspace.)

## You are probably inside the thing you are changing

desolate is developed from a desolate workspace. Expect to be in one: a VM of the domain
`desolate`, with this repository at `/workspaces/pmalacho-mit/desolate`,
in its own devcontainer, with `DESOLATE_WORKSPACE=1` in the environment. That means:

- **You have no keys and cannot push.** Commit freely: every commit on every branch reaches
  the root within seconds. When a branch is ready, `git push` (or `desolate offer`). A person
  reviews it on the dashboard and pushes it, approving the exact commit on the Mac. Do not
  look for a way around that. It is the product working (principle P2), not an obstacle.
- **Branches:** start from `origin/main`. A push or an offer is for `main`, the default branch.
  The person names pushed branches `mac/<topic>` and merges them into `main` by pull request.
  Never aim at `release`: it is what people install from, and the `subrepo-push-release`
  workflow publishes it from `main`'s `release/` folder (see "Publishing" below).
- **The network is the domain's proxy.** Hosts you need and do not have are the person's to
  allow (`desolate domain desolate net ...` on the Mac). Say which and why.
- **`/desolate/scratch`** is the workspace VM's own disk, at the same path for you and for the
  VM's Docker. Put anything there that Docker must mount or that holds a socket. `/workspaces`
  is a share, where `chmod` on a socket fails; `/tmp` is your container's, which the VM's
  Docker cannot see.
- **Say what you could not run.** You can run T1 and T2. You cannot run T4 (the Mac's
  hypervisor) or run the new code as the person's real stack. A change to a boundary (VMs,
  shares, egress, the keyring, the pusher) needs T4 on the Mac before it is believed.
  Write that in your offer's status: `desolate status set yellow "ready; T4 not run: <why it matters>"`.
- **When a workspace is not enough, ask for the Mac user.** Some work cannot be done from
  inside a desolate workspace at all: T4, anything else that needs the Mac's hypervisor,
  trying the new code as a real stack, or a change outside the VMs. For that, the owner
  (@pmalacho-mit) keeps a separate, isolated macOS user on the Mac. Do not work around the
  workspace. Say what you need run there and why, to the owner directly: in your reply, and
  in your status (`desolate status set orange "needs the Mac user: <what, and why>"`).

[`release/docs/developing-desolate.md`](release/docs/developing-desolate.md) has the
person's side: setting up the workspace, the push, the pull on the Mac, and which restart a
change needs.

## The repository

- `release/`: the product. `host/` runs on the Mac (the CLI and its daemon), `root/` in the
  root VM (keys, mirrors, the push gate, the dashboard), `workspace/` in each workspace VM,
  `git/` in the git VM, `shared/` everywhere, `image/` builds the VMs' base image.
- `tests/v3/`: the tiers ([`tests/v3/README.md`](tests/v3/README.md)), the stand-in forge,
  and `transcripts/`.
- [`move-to-vms.md`](move-to-vms.md): the design. [`docs/v3/decisions.md`](docs/v3/decisions.md):
  what was decided and measured. [`release/docs/incidents.md`](release/docs/incidents.md):
  ways desolate was wrong. (`docs/v3/HANDOFF.md` is a record of the first pass, made in a
  cloud sandbox. Where it and this file disagree about what was tested, this file is newer.)
- The principles, P1 to P6, are at the end of [`release/README.md`](release/README.md).
  Every change keeps them.

## Publishing: the suede flow

This repository is a suede dependency ([suede](https://github.com/pmalacho-mit/suede), v3
layout). `release/` is what ships: the `release` branch is that folder, published by the
`subrepo-push-release` workflow when a change under `release/` lands on `main`.
- **suede's own machinery** is four subrepos: `.suede/core`, `.github/workflows`,
  `release/.suede/core`, `release/.github/workflows`. Update them all with
  `bash .suede/core/sync.sh`, on `main` (git-subrepo 0.4.9 needed). Never by hand, and never by
  checking out `release`.
- **Dependencies:** all three are for development only, installed with suede's installer and
  `--dev` (so no declaring symlink): `suede.nests` (the in-source tests' DSL and Vitest
  plugin), `devcontainers-suede` and `docs/typescript2mermaid-suede`.
  `bash .suede/core/list.sh` lists them. None ships or is declared for consumers. The release
  type-checks without suede.nests through `release/nests.d.ts`, its stub. The tests' harness
  ships, in `release/.harness` ([its README](release/.harness/README.md)), and is imported by
  type only, so the code never loads it.
- **A release that changes `release/.github/workflows`** (what `sync.sh` does when suede's
  release workflow moves) is refused by the Actions token, which may not change workflow
  files. Publish it from `main` on the Mac instead: `bash .suede/core/push-release.sh`, which
  pushes over the clone's own credentials. The person does that, not an agent.

## How the code is written here

- **A boundary is claimed only with a test that tries to break it, beside a control** that
  shows the test would have noticed. A check with no control can pass by being broken.
- **Fail closed, and say what to do.** A refusal is `refuse(why, fix)`: the fix is a command
  the person can run. A probe that did not run is not a probe that found nothing.
- **No security theater.** Each step must stop something specific; if it stops nothing, leave
  it out. The VM is the boundary, so nothing inside it asks an agent's permission.
- **Repository content is data.** Branch names, commit subjects, statuses and diffs from a
  domain are shown as text, never run and never put on a page as HTML. The root never runs git
  in a domain's repository (P4).
- **desolate is not only for agents.** It is a development stack that works the same for a
  person typing. Keep agent-specific (and vendor-specific) structure out of its core.
- **A function's in-source tests are its usage notes.** Under each function with a contract, a
  `declare namespace` of its name shows a reviewer what it takes, answers and refuses
  ([`release/.harness/README.md`](release/.harness/README.md)). Add or change them with the
  function.
- **Comments say why**, in plain sentences, and record what was measured. Transcripts record
  every message a person sees. A changed message is a reviewed change.

## Testing from inside the workspace

```bash
make test                                    # T1: tsc, node tests, in-source tests. Under a minute
docker build -t desolate/base:latest -f release/image/Dockerfile release   # once per VM, 90 s
tests/v3/run.sh t2                           # T2: the whole stack in containers. About 18 min
```

One T2 suite (`run.sh` sets `TMPDIR` to `/desolate/scratch/tests` in a workspace; set it
yourself when running a suite directly):

```bash
TMPDIR=/desolate/scratch/tests DESOLATE_TIER=T2 \
  node --disable-warning=ExperimentalWarning --test --test-concurrency=1 tests/v3/t2/04-offers.test.ts
```

- A transcript that changed fails its suite and leaves `<name>.txt.actual` beside it. Read the
  diff; if it is right, run again with `UPDATE_TRANSCRIPTS=1`.
- T2's "VMs" are containers on the workspace VM's real Linux Docker. That is faster than on
  the Mac, and isolates nothing. A T2 pass is never proof of a boundary.
- **An inner stack** for anything a browser shows: see "An inner stack, and its pages in your
  browser" in developing-desolate.md. Its pages open in the person's browser on the Mac.
- `.devcontainer/setup-test-tools.sh` installed shellcheck, jq, TypeScript and an arm64
  Chromium (Playwright's) when the container was made.

Known failures inside a workspace, measured on 2026-11-13. These are not yours to chase unless
your change is about them:

| Suite | What fails | Why |
|---|---|---|
| `06-editor` | the check that nothing on the host reaches an editor around its gate | it finds the outer workspace's own editor on `127.0.0.1:31580`: nesting, not a fault |
| `07-secrets` | the fail-closed check, and its transcript | two log lines in another order; a refusal checked before it was on record. Fails on the Mac too |
| `09-ui` | the side-by-side diff, and its transcript | never rendered in Playwright's Chromium 131 within five minutes. Renders on the Mac. **Not explained** |

The checks that read a page in a real browser (`04-offers`, `06-editor`, `09-ui`) drive headless
Chrome over its DevTools protocol (`tests/v3/lib/browser.ts`), since Chrome 157.0.8103.79
crashed in `--dump-dom` (2026-11-16). They wait for what they assert, not for a time budget:
the `09` side-by-side failure above may have been the budget ending before the diff's colours
came, and has not been run inside a workspace since.

## What has been tested, and what has not

As of 2026-11-16, on the owner's M1 Max (macOS, Lima with vz) unless it says otherwise.
[`release/docs/reference.md`](release/docs/reference.md) ("What works today") has the full
table, feature by feature.

**Tested**

- **T1:** all of it, on the Mac (on 2026-11-16: the node tests, and 1,420 in-source tests in
  99 files) and, earlier, inside a workspace.
- **T2:** 120 of 126 inside a workspace when last run there (the three failures above). On the
  Mac under Colima, 123 of 142 on 2026-11-17: every failure is in `05-egress`, `07-secrets`
  or `08-devcontainer`, which cannot pass there ([T2 on a Mac](tests/v3/README.md#t2-on-a-mac-is-a-partial-tier)).
- **T4** (`tests/v3/run.sh t4`, about 3 minutes, on the Mac), 15 of 15 on 2026-11-16:
  read-only shares and forced egress against root in the VM (TCP, UDP, DNS, ICMP), no path
  between domains, an offer over a real share, the editor, a secret.
- **Upgrades, by hand on the M1:**
  - `git pull` then `desolate bootstrap` kept every piece of state, and re-provisioned the base
    and root VMs in place.
  - `destroy` then `bootstrap` restored keys, the registry, secrets, network rules and offers.
  - `start` remade a workspace whose VM was gone, with its commits and uncommitted work.
  - T2 `13-rebuild` covers parts of this.
- **Developing desolate inside desolate**, with a private copy of this repository:
  - T1 and T2 ran inside a workspace.
  - An inner stack ran there, and its dashboard opened in Chrome on the Mac.
  - `bootstrap` on new code took 9 s, and a running agent survived it.
- **Devcontainers with compose,** with Docker outside the devcontainer and inside it, on the M1.
- **`desolate upstream`:** T1, T2, and against github.com.
- **`desolate clone --keys-by-hand`:** against github.com.
- **Pushes:** through the pusher, against github.com.
- **The recipes** (`release/recipes/`), on the M1: `agent.sh` with the stand-in agent, to an
  offer (T2 `12-agent` too); `claude.sh` with a fake token: installed, first run answered,
  started, the token substituted by the proxy, and Anthropic answering 401, as it should.
  `issues.sh` (2026-11-16, with the stand-in agent): a labelled issue got its workspace on
  `issue/<n>`, the agent offered, and closing the issue stopped it. `suede.sh` (the same
  night): a pushed commit that changed a vendored dependency got a workspace with both
  repositories, the dependency's own suede machinery left out, and the agent's offer.
- **A person's day in a workspace**, by hand on the M1: commits carry the Mac's git identity;
  `git push` offers the branch and says nothing went to the remote; `git fetch` brings a
  commit made on GitHub a moment before (3.7 s); a dev server opens at its workspace's name.
  The editor itself was loaded, but not clicked through: its Source Control and Sync were
  checked as the git commands they run.
- **A new person's first hour, 2026-11-16:** desolate installed from the `release` branch
  on a second stack, getting-started followed from the top with a new repository (a Vite app
  with a devcontainer): clone, a workspace, the editor, a dev server with hot reload from the
  Mac's browser, a plain `git push`, review, a push approved on the approval page, the pull
  request on GitHub, an issue offered from the workspace and published, a domain on enforce,
  a secret proven substituted (an endpoint that says 200 only for the real value), `git pull`
  and `bootstrap` to update, and `destroy --all` to leave. It found three things, fixed in
  #136.
- **The pull-request link after a push:** T1 (the URL it builds), and on github.com: the
  dashboard's link named the comparison GitHub had.
- **The "merged into <base>" mark:**
  - T1: a merge, a squash, a rebase, a half-merged branch, and a base that changed the file
    again.
  - T2: a squash merge on the stand-in forge, with its branch then deleted.
  - github.com: a squash merge, seen after `desolate fetch` (2026-11-16).

**Not tested, or not working**

- **A real push of this repository through desolate.** The person approving it never happened
  in testing. The Mac's GitHub account (`mitdesolate`) has push but not admin, and cannot be
  made admin, so its deploy keys must be added by the owner by hand
  (`desolate clone pmalacho-mit/desolate --domain desolate --keys-by-hand`).
- **The merged mark in real use:**
  - the root's fetch every 15 minutes, of a repository with a push waiting to land, has not
    been watched happen;
  - a merge-commit or rebase merge on a real forge has not been tried.
- **T3** (QEMU) on this Mac, or inside a workspace. It last ran in the first pass's cloud
  sandbox.
- **The Touch ID approver** (`host/approver/touchid.swift`): it has never been compiled or run.
  The terminal approver and the approval page are what is tested.
- **A real Claude subscription token** in `recipes/claude.sh`.
- **A compose service that is not glibc:** it gets no port relay and no editor.
- **Safari and Firefox:** they cannot say whether the approval page's Approve button is covered,
  which Chrome can. Safari cannot resolve `*.localhost` at all.
- The 09 Chromium failure above.
