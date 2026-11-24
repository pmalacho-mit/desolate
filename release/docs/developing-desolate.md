# Developing desolate inside desolate

desolate can be developed from a desolate workspace: you, or an agent you hand a task to,
work on its code there, run its tests there, and push the branch from the Mac like any
other project. What still needs the Mac
is short: the vz tests (T4) and running the new code for real. Everything below was measured
on the M1 Max on 2026-11-13, with a private copy of this repository standing in for it.

## What runs where

| | In a workspace | On the Mac |
|---|---|---|
| **T1** (tsc, node tests, in-source tests) | yes: everything passes, in 24 s | yes |
| **T2** (the fake backend: the whole stack in containers) | yes: 142 of 142 in 13 min on 2026-11-17, on the workspace VM's own Docker | in a workspace, as here ([how](https://github.com/pmalacho-mit/desolate/blob/main/tests/v3/README.md#t2-from-a-mac-run-it-in-a-desolate-workspace)); under Colima, 123 of 142 (`05`, `07` and `08` cannot pass there) |
| **An inner stack** (`desolate bootstrap` on the fake backend) | yes, and its dashboard, approval page and editors open in your Mac's browser | n/a |
| **T3** (real VMs, QEMU) | in principle, under software emulation (the M1 has no nested virtualization): hours. Not tried | n/a |
| **T4** (real VMs, vz) | no: it needs the Mac's hypervisor | yes, from your checkout |
| **An agent on it** | yes, as for any repository (`recipes/claude.sh`, or any other) | |

T2 inside the workspace is faster than on the Mac and passes whole: 142 of 142 in 13 minutes
on 2026-11-17, where under Colima `05` (egress), `07` (secrets) and `08` (the devcontainer)
cannot pass, because there the "VMs" are containers on a real Linux Docker. It is how T2 is
run from a Mac. To run only the tests, a clone with no keys is enough (`--anonymous`: the
repository is public); [tests/v3/README.md](https://github.com/pmalacho-mit/desolate/blob/main/tests/v3/README.md#t2-from-a-mac-run-it-in-a-desolate-workspace)
has the commands.

## Once: a workspace for desolate

```bash
desolate clone pmalacho-mit/desolate --domain desolate
desolate domain desolate size --cpus 6 --memory 16g --disk 60g     # T2 runs a stack inside it
```

- **`--domain desolate`**: the name this guide and the repository's `AGENTS.md` use. The
  default would be `pmalacho-mit--desolate` (owner--repo).
- **Deploy keys need an admin of the repository.** If the `gh` on this Mac is not one (it is
  `mitdesolate`, with push but not admin), add `--keys-by-hand`. It prints the two public keys;
  the owner adds them under Settings, then Deploy keys (the write one with "Allow write
  access"); then run the same command again.
- Claude: `desolate domain desolate secret set CLAUDE-OAUTH ...` as in [agents.md](agents.md),
  or let `recipes/claude.sh` copy it from another domain.

The repository's own devcontainer gives the workspace what the tests need: Node, Python,
docker-outside-of-docker (the VM's Docker, which T2 drives), git-lfs, and
`.devcontainer/setup-test-tools.sh` run when the container is made (shellcheck, jq,
TypeScript, and an arm64 Chromium from Playwright, since Ubuntu's is a snap). Once per
workspace VM, the base image T2 needs (90 s, kept in the VM's Docker):

```bash
desolate exec desolate/<workspace> -- docker build -t desolate/base:latest -f release/image/Dockerfile release
```

`tests/v3/run.sh` puts the tests' homes on `/desolate/scratch` in a workspace: the VM's own
disk, at the same path for the VM's Docker as for the container. (`/workspaces` is a share,
where `chmod` on a socket fails; `/tmp` is the container's, which the VM's Docker cannot
bind; and a socket's path must stay under 108 bytes.)

## The loop

**1. Work in the workspace, and push from the Mac.** Yourself:

```bash
desolate up desolate --name push-label --branch mac/push-label
desolate editor desolate/push-label --open     # change it, `make test`, commit
```

then `git push` in the workspace (or `desolate offer`), which offers the branch for `main`.
Or hand it to an agent:

```bash
recipes/claude.sh desolate "Make the dashboard's Push button say which commit it pushes" --branch mac/push-label
```

It works on the branch, runs `make test` and `tests/v3/run.sh t2` inside, commits, and offers
it for `main` (the repository's [`AGENTS.md`](../../AGENTS.md), which agents working on desolate
read, says to). Then, on the Mac:

```bash
desolate ui --open      # Review the offer, then Push, and approve the exact commit
```

or `desolate push desolate pmalacho-mit/desolate mac/push-label --expect <commit>`
in a terminal. A push to the default branch (`main` here) works the same way, and the review
says loudly that it is the default branch: keep to pushing `mac/<topic>` branches yourself.
desolate does not know your rule about `release` either, so the approval, which names the
branch, is where that is kept.
Then the pull request. Once the push lands, desolate gives GitHub's page for opening it, filled
in with the branch and its base: "Open pull request" on the dashboard, or the line `open a pull
request into main, in your browser, as yourself: https://github.com/...` after `desolate push`.
You create it there, signed in as yourself: desolate holds no token that could. Or with your
own `gh`:

```bash
gh pr create --repo pmalacho-mit/desolate --head mac/push-label
```

Once the pull request is merged (by a merge, a squash or a rebase), the root notices within 15
minutes, or at the next `desolate fetch`: the dashboard marks the workspace's checkout "merged
into main", and the workspace "Its work is merged", with how to stop or remove it.

**2. Pull it on the Mac,** in the checkout desolate runs from (the one `which desolate` leads to),
on `main`:

```bash
git pull        # once the PR is merged into main
```

To try a branch before it is merged: `git fetch origin mac/push-label && git checkout mac/push-label`
there, and back with `git checkout main`.

**3. Run the new code.** Whether that means a quick restart or taking everything down depends
on what changed:

| What changed | Run | What happens |
|---|---|---|
| anything in `release/` (most changes) | `desolate bootstrap` | The daemon and the root's services restart on the new code: 9 s. Running workspaces and agents keep running, the one you developed in included. |
| `release/workspace/desolate`, `status`, or the git remote helpers (`git-remote-desolate-offer`, `-mirror`) | nothing more than the pull | A workspace reads `release/` from the Mac's checkout as it is now: the VM links to these, and a devcontainer runs them through `workspace/entry`, so the next command in it runs the new code. A devcontainer made before `entry` existed still holds them as binds of single files, which go stale on an upgrade: stop and start it once. |
| the rest of `release/workspace/` (what runs in a workspace) | then `desolate stop desolate/<w>` and `desolate start desolate/<w>` | 24 s. Its agents end, and its devcontainer starts again. It is made again if desolate's mounts or environment for it changed (`overrideOf` in `devcontainer.ts`): what was installed in it by hand goes (put it in the devcontainer's `postCreateCommand`). A change to `workspace/entry` itself reaches a devcontainer only this way. Checkouts and uncommitted work stay. |
| `pins.env`, `image/` | `desolate bootstrap` | The base and root VMs are provisioned again in place (35 s here, once); templates are rebuilt on the next `up`. Workspaces keep their older tools until remade. |
| `tests/` only | nothing | |

**Down and back up**, all of it:

```bash
desolate down                     # every VM and the daemon stop; nothing is removed
desolate bootstrap                # back, on whatever the checkout now holds
desolate start desolate/<w>       # each workspace you want
```

**If the new code is broken,** go back to the commit that worked and run it:

```bash
git checkout <the commit before>     # in that same checkout
desolate bootstrap
```

**Run T4** from the Mac checkout for anything that touches a boundary (the VMs, shares,
egress): `TMPDIR=~/t tests/v3/run.sh t4` (about 3 minutes; Colima must be running for its
stand-in forge).

## Trying new code beside the real stack

A second checkout runs a second stack, with its own home, VM names and port:

```bash
git clone https://github.com/pmalacho-mit/desolate ~/desolate-next
cd ~/desolate-next && git checkout mac/push-label
DESOLATE_HOME=~/.desolate-next release/cli.sh settings set editor.port 31681   # kept in that home
DESOLATE_INSTANCE=next DESOLATE_HOME=~/.desolate-next release/cli.sh bootstrap
```

It shares nothing with the real stack. `desolate doctor` fails if a stack's daemon could not
take its port, or if a stack's VMs run another checkout's code than the one you are running.
When it looks right, pull in the real checkout and `desolate bootstrap` there;
`DESOLATE_INSTANCE=next DESOLATE_HOME=~/.desolate-next release/cli.sh destroy --all` removes
the second one.

## An inner stack, and its pages in your browser

To work on the dashboard, the approval page or anything else a browser shows, run a stack
inside the workspace (on the tests' fake backend, which isolates nothing; it is for development,
and is loaded from this checkout's `tests/`, which an install does not have):

```bash
# in the workspace (desolate exec desolate/<w> -- bash, or its editor's terminal)
export NODE_OPTIONS=--import=$PWD/tests/v3/lib/fake-backend.ts DESOLATE_TEST_RUN=1 DESOLATE_INSTANCE=inner \
       DESOLATE_HOME=/desolate/scratch/inner DESOLATE_EDITOR_PORT=32581 \
       DESOLATE_HOSTNAME_SUFFIX=$DESOLATE_DEV_HOSTNAME
release/cli.sh bootstrap
release/cli.sh ui        # http://desolate.<this workspace's dev name>:32581/?tkn=...
```

Open what `ui` prints in Chrome or Firefox on the Mac. The outer stack forwards the port and
routes every name under the workspace's dev name to it, so the inner stack's dashboard,
approval page and editors each keep a name of their own. `DESOLATE_DEV_HOSTNAME` is set in
every devcontainer. After changing the code: `release/cli.sh bootstrap` again (inner) and
reload.

## Backups: what lives where

- `~/.desolate` on the Mac: the mirrors, each domain's clones (every workspace's checkout,
  uncommitted work included), the root clones, your git VM's clones, the approver's key.
  Time Machine covers it.
- The root VM's own disk (inside `~/.desolate/lima`): the deploy keys, the repository list,
  each domain's secrets and network rules. `desolate destroy` (without `--all`) takes these
  out first and the next `bootstrap` puts them back; a running VM's disk is not a reliable
  backup, so `desolate down` before Time Machine runs if you rely on it for these.
- GitHub: whatever you pushed.

## What this could not do, or did not try

- **Approve a real push of desolate's own repository.** The copy's push stopped where it
  should, at the approval, which is yours. Its pull and restart were done by applying the
  reviewed diff to the Mac checkout instead.
- **T3 inside a workspace.** Software emulation, and the base image built with debootstrap
  as root in the VM rather than the container.
- **The workspace's own editor on desolate's code** was not opened in a browser in this run;
  it is the same editor as any project's.
