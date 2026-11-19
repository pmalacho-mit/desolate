# Getting started with desolate

From nothing to working on one of your repositories in a VM of its own: its code, its
dependencies and its dev servers run there, in the project's devcontainer, with an editor in
your browser, and none of your credentials. What you commit is reviewed by you and pushed with
one click. Under half an hour, most of it waiting for the first VM images to download.
Handing a task to a coding agent is the same workspace, with a program working in it instead
of you (step 6). One of desolate's first users? Read [dogfooding.md](dogfooding.md) first.

![The dashboard: what needs you on top, then each domain's workspaces and their live branches](assets/dashboard.png)

## What you need

- **A Mac with Apple silicon** (M1 or later). desolate runs its VMs with Apple's
  Virtualization.framework, through Lima; an Intel Mac is not supported.
- **Homebrew**, and from it: `brew install lima node gh jq` (`jq` is for the recipes in step 6)
  - Lima **2.3 or newer** (`limactl --version`): older versions let a confined VM's pings out.
  - node **22.18 or newer**: desolate is TypeScript that node runs directly.
  - GitHub's CLI, signed in (`gh auth login`) as someone who can add deploy keys to the
    repositories you want to work on: that is admin on the repository. Without it, see step
    3 (`--keys-by-hand`, or `--no-push`).
- **Chrome or Firefox.** desolate's pages live at names under `localhost`
  (`desolate.localhost`, `desolate-git.localhost`, ...). Those browsers resolve them; Safari
  does not.
- About 15 GB of disk for the VM images and your repositories' mirrors.

You do **not** need Docker on your Mac: the projects' devcontainers run inside the VMs.

## 1. Install

```bash
git clone --branch release https://github.com/pmalacho-mit/desolate ~/desolate
mkdir -p ~/.local/bin && ln -sf ~/desolate/cli.sh ~/.local/bin/desolate
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc
desolate help
```

Leave the clone where it is: every VM reads desolate's code from it. Tab completion (TAB
completes commands, and your domains and workspaces by name):

```bash
echo 'source <(desolate completion)' >> ~/.zshrc && source ~/.zshrc
```

(In bash, `~/.bashrc` instead.)

## 2. Bootstrap the stack

```bash
desolate bootstrap
```

This makes the **root VM**, which holds every deploy key and your repositories' mirrors and
never runs any repository's code, then starts the host daemon, then runs `desolate doctor`. The
first time it downloads a base image and takes 5 to 10 minutes; after that, seconds. It ends
with every check passed:

```
  ok   root: the Mac's loopback is walled off: the root's own user cannot reach a port that answers on the Mac's 127.0.0.1, ...
doctor: all checks passed.
```

If macOS asks whether `limactl` may accept incoming network connections, **click Deny**:
desolate listens only on your Mac's loopback ([why](reference.md#on-a-mac-if-macos-asks-about-limactl-and-incoming-connections)).

## 3. Clone a repository: it is a domain

```bash
desolate clone you/app                        # makes a read and a write deploy key, registers them with gh
```

```
  read key: registered
  write key: registered (it asks you before every push)
cloned you/app: 2 branch(es), default main, 2 LFS object(s); pushable.
domain you--app: made for you/app.
next: desolate up you--app   (a workspace: a VM with its checkout, its devcontainer and an editor)
```

- `clone` keeps the keys in the root VM, where nothing a workspace runs can reach them, and
  mirrors the repository (with its LFS files). The keys are deploy keys on GitHub, titled
  `desolate read (host ...)` and `desolate write (host ...)`.
- Not an admin of the repository? `--keys-by-hand` prints the two keys for an admin to add
  (then run the same command again). `--no-push` registers a read key only: you work on it
  and review its branches, but desolate cannot push it. `--anonymous` registers no key at
  all, for a public repository.
- A **domain** is a trust boundary: its repositories, its network rules, its secrets.
  Workspaces in one domain can see each other's branches; workspaces in different domains
  share nothing. `clone` makes one per repository, named `owner--repo` (`you--app`): the
  repository's **home domain**, for it alone (the dashboard marks it). Repositories that work
  together go in a domain of their own: **New domain** on the dashboard, ticking them, or
  `desolate domain create you--work --repo you/app --repo you/lib`. `--no-domain` makes none.

## 4. Start a workspace

On the dashboard (`desolate ui --open`), a domain with no workspaces offers **Workspace on
main**: one on the default branch, the domain's own checkout of each repository. Or, for a
branch of its own:

```bash
desolate up you--app --name greet --branch feature/greet-by-name
```

```
workspace you--app/greet is up
  you/app  worktree feature/greet-by-name from main  /workspaces/you/app/.worktrees/feature-greet-by-name
  devcontainer up (mcr.microsoft.com/devcontainers/javascript-node:1-22-bookworm, user node)
  ...
the start took 81.9 s: template 63.7 s, asked the root 0.2 s, VM booted 9.6 s, services, checkouts, devcontainer and editor 8.2 s
next: desolate editor you--app/greet --open      its editor, in your browser
      desolate exec you--app/greet -- <command>     a command in its devcontainer (bash, for a shell)
```

A workspace is a VM with a worktree of each repository, on the branch you named. Each
repository can have its own branch: `--checkout you/lib=worktree:fix/token` for that one
(repeat it per repository), `--branch` for the rest, `--checkout you/lib=main` for a
repository's main checkout. A repository you name in neither gets its main checkout if no
other workspace holds it, else none. The first repository you name with `--checkout`
chooses the environment: its `devcontainer.json`, if it has one.

**Its size.** By default a workspace gets half your Mac's cores (2 to 4), a quarter of its
memory (3 to 8 GiB) and 30 GiB of disk; `desolate bootstrap` says what that comes to on your
Mac. A project can say what it needs in its `devcontainer.json`, and its workspaces get it:

```jsonc
"customizations": { "desolate": { "cpus": 4, "memory": "16g", "disk": "60g" } }
```

The spec's own `hostRequirements` (`"cpus"`, `"memory": "16gb"`, `"storage": "64gb"`, what
Codespaces reads) works too; `customizations.desolate` wins where both say. Your own choices
come first: for a domain, or for one workspace, they override the project's, and `up` says
which decided:

```bash
desolate domain you--app size --cpus 4 --memory 12g --disk 60g    # its new workspaces
desolate up you--app --name big --memory 16g                       # this one
```

A project's size is its repository's word, so it is kept within your Mac: no more CPUs than
it has cores, and no more than three quarters of its memory. `up` says what it lowered, and
what it could not read.

**Resizing one.** Stop it, then:

```bash
desolate resize you--app/greet --memory 16g    # or --cpus 6, or --disk 80g (a disk only grows)
desolate start you--app/greet
```

Or use **Resize...** on its row on the dashboard. It is off while the workspace runs, and the
row shows when the project asks for more than the workspace has. Its files, containers and
volumes stay. `desolate resize you--app/greet` with no flags says what it has, and what its
project asks for.

What it costs: CPUs are shares of your Mac's time (an idle VM uses almost none); memory is a
ceiling the VM fills as it uses it (and macOS is slow to take back); disk grows as it is
written. `desolate list` shows each workspace's size. If the
first repository (or the first you name with `--checkout`) has a `devcontainer.json`, it
runs inside the VM, as written. The first
workspace of a domain builds the domain's environment once (the "template" above); the
next ones start from it in about 20 seconds.

The workspace has **no credentials and no network** but its own proxy (HTTP and HTTPS to
named hosts; `desolate domain you--app net enforce` limits even that to a list).

## 5. Work in it

```bash
desolate editor you--app/greet --open        # VSCodium, running in the workspace's VM, in a browser tab
desolate exec you--app/greet -- bash         # or a shell in its devcontainer, in your own terminal
```

![The workspace's editor: both repositories in one window, and a terminal inside the devcontainer](assets/editor.png)

It is a development environment as you know it: the project's devcontainer, its tools, a
terminal, extensions. What is different is what it cannot reach: no key, no token, your Mac's
files only as its own checkouts, and the network only through its own proxy, on ports 80
and 443 ([what that means for registries and builds](reference.md)).

- **Your editor settings, everywhere.** Every workspace's editor starts from your defaults:
  `desolate editor defaults set workbench.colorTheme Dark+`, or **Editor defaults...** at
  the top of the dashboard (a page of your Mac's, with a theme and an auto-save choice and
  any setting as JSON). desolate's own default turns the web editor's auto-save off. They
  are the editor's lowest layer: what you set in an editor, the project's devcontainer
  (`customizations.vscode.settings`) and the repository's `.vscode/settings.json` all
  override them. A change reaches running editors at once; reload an open tab to see it.
- **Run it.** Start a dev server in the editor's terminal (`npm run dev`, or anything that
  listens) and open the address `desolate ports` prints:
  `http://you--app-greet-<id>.localhost:<the same port>`. Nothing to declare: a port is
  forwarded as soon as something listens on it, and each workspace's has a name of its own,
  so two workspaces can both use 3000. The `http://localhost:5173` a dev server prints works
  too: clicked, it is sent on to that address. Inside the devcontainer the name is
  `$DESOLATE_DEV_HOSTNAME`, for what needs its own address (an OAuth callback, a public URL).
- **Commit** as usual, from the terminal or the editor's Source Control. Your commits carry
  your own name and email (your Mac's `git config --global user.name` and `user.email`).
- **`git pull` and `git fetch`** get what GitHub has now: the workspace asks the root to
  refresh its copy first (a second or two), and fetches from it.
- **`git push`** (or the editor's Sync) hands your branch to the root, which is as far as
  anything in a workspace can push. It says so:

  ```
  offered you/app feature/greet-by-name at 3f2a91c0d4e1.
  It is under "Needs you" on the dashboard now (desolate ui, on the Mac): review it there and push it. ...
   ! [remote rejected] feature/greet-by-name -> feature/greet-by-name (offered to the root, not pushed: ...)
  ```

  Nothing reached GitHub yet: that is step 7, from the root, and only once you approve it.
  (`desolate offer` in the workspace does the same.)

Every commit on every branch reaches the root within seconds, offered or not; offering says
"this one is ready".

## 6. Or hand it to an agent

A coding agent works in a workspace the way you do, and runs with the same limits: what it
can break is its own VM. desolate has no agent built in. It keeps a program running in a
workspace with its own terminal, whether or not you are watching:

```bash
desolate agent start you--app/greet -- <command>    # any program: an agent, a watcher, a long test run
desolate agent attach you--app/greet                # your terminal on it; Ctrl-] lets go, it keeps running
```

and its **recipes** ([`recipes/`](../recipes/README.md)) put the steps for a whole task in
one script you can read: a workspace on its own branch, the agent, and what to tell it. For
Claude Code, once (a subscription token, held in the root VM and never in a workspace):

```bash
claude setup-token        # on your Mac
desolate domain you--app secret set CLAUDE-OAUTH --hosts api.anthropic.com --headers authorization   # paste it
```

(Or **Add a secret...** on the domain's card on the dashboard: the secrets page, which is your
Mac's, like the approval page. The value goes from it to the root and is never shown on a page
again; `desolate domain you--app secret show CLAUDE-OAUTH` shows it in your terminal.)

A project with a `.env` full of keys: `desolate domain you--app secret import path/to/.env
--print-env > workspace.env` makes its API keys secrets and writes the `.env` the workspace
uses, with their names (or **Import a .env** on the secrets page). The reference says what
can be a secret and what cannot.

then, for each task:

```bash
~/desolate/recipes/claude.sh you--app "Greet the user by name, with a test"
```

The workspace holds the name `CLAUDE-OAUTH`, which its proxy replaces on the way to
api.anthropic.com. Another agent is the same recipe with its own credential and install
steps: [`recipes/README.md`](../recipes/README.md). The agent reads
[`AGENTS.md`](../AGENTS.md) (in every workspace at `/desolate/release/AGENTS.md`): it commits,
says how it is going with `desolate status set <colour> "<message>"`, and offers its branch
when it is done. Running agents, watching them and several at once: [agents.md](agents.md).

## 7. Review

```bash
desolate ui --open                           # the dashboard
```

Everything committed in a workspace reaches the root within seconds. The dashboard shows
what needs you on top (offers, a workspace asking for help), then each domain as a card:

- **each workspace's state** as a pill (running, stopped, or what the dashboard is doing to
  it: being made, starting, stopping, deleting, with the step it is at);
- **each checkout's branch** as it changes, and whether its commits are on the remote;
- **every branch of the domain** under **Branches**:

![Every branch a domain has, offered or not, with Review and Open in git](assets/dashboard-branches.png)

Cards fold to a line, and the domains filter by name or repository; hover a pill for what it
means.

**Review** (or a checkout's **Diff**) opens a panel on the right, the window's height, as wide
as you drag it. It shows what a push would send: the commits, the files changed (each with
its lines added and removed; filter them, and click one to go to it in the diff), and the
diff, made by git in the root VM, from the objects alone (nothing in the branch runs), against
the remote's default branch as last fetched (**Fetch now** fetches it). Names are labelled
with what they are: a **domain**, a **workspace**, a **repo**, a **branch**.

![Reviewing an offer: commits, files, and the diff as text](assets/review.png)

## 8. Push it

Two ways, and both end with you approving the exact commit:

- From the dashboard: **Push exactly <commit>**, then approve it on the approval page
  (`desolate approve --web --open`; keep that tab) or with `desolate approve` in a terminal.
  The default branch is pushed the same way: the review says so in red at its top, since a
  push there changes it on the remote with no pull request first.
- **Open in git**, in the review: the git terminal, on that branch as the workspace has it
  (`git status` says how far ahead of the remote it is), where `git push` sends it.
- From the **git terminal**, which is git as you use it anywhere, in a VM of its own with no
  network and no keys:

```bash
desolate git you/app --open
```

```bash
desolate fetch                                  # in the git terminal: refresh from GitHub, fetch every remote
git log --oneline you--app/feature/greet-by-name    # each domain is a remote
git push origin you--app/feature/greet-by-name:refs/heads/feature/greet-by-name
```

The push waits for you, and the approval opens beside the terminal: what the push names, and
what it would send, worked out in the root. **Approve** arms only when the pointer moves onto
it; one click, and the root pushes exactly that commit.

![A push from the git terminal, waiting for approval beside it](assets/git-approve.png)

## 9. Hear about it

```bash
desolate notify            # macOS notifications: a push waiting, an offer, a workspace asking for you
desolate events            # the same, as JSON lines, for your own scripts
```

The [reference](reference.md#approving-pushing-and-the-pages-desolate-serves) ("Your own scripts") has a script that opens a pull request for
every branch desolate pushes.

## Day to day

| | |
|---|---|
| `desolate list` | every domain and workspace, with the branch each checkout is on now |
| `desolate branches [<domain>]` | every branch the domains have, offered or not |
| `desolate review <domain> <repo> <branch> [--diff]` | what a push would send |
| `desolate stop / start / rm <domain>/<workspace>` | a workspace's VM; `rm` removes the VM (its branches stay in the domain's clones). The dashboard's **Delete** does it only when nothing in it would be lost and its commits are on the remote; hover it to see why it is off |
| `desolate fetch <repo>` | refresh a mirror from its remote |
| `desolate doctor` | every check, with what to do about each that fails |
| `desolate down` | stop every VM and the daemon; remove nothing |
| `desolate bootstrap`, then `desolate start <domain>/<workspace>` | bring it back after `down` or a restart of the Mac |
| `git pull`, then `desolate bootstrap` | upgrade desolate (see [Upgrading desolate](#upgrading-desolate)) |

## Upgrading desolate

```bash
git -C <your desolate checkout> pull
desolate bootstrap
```

That is the whole of it; nothing of yours is touched. `bootstrap` restarts the host daemon
and the root's services on the new code. When the new desolate changes the VMs' image
(`pins.env`, a lock, `image/provision.sh`), it also provisions the base and the root VM
again, in place: a few minutes, once, and the root's keys and secrets stay where they are.
The git VM is made again (your clones in it are on your Mac), and a domain's template on its
next `up`.

- **Running workspaces keep going** on the code and tools they started with. `desolate stop`
  then `desolate start` gives one the new code. (A devcontainer made before 2026-11-16 can
  read `desolate` and `/desolate/status` half-replaced after an upgrade, until that stop and
  start makes it again.) One made before an image change keeps its
  older tools until it is made again: `desolate rm <d>/<w>`, then `desolate up <d> --name <w>
  --branch <its branch>` (its checkouts, committed or not, are on your Mac and are kept).
- **One checkout per stack.** The VMs run desolate from the folder they were made from. Run
  desolate from that folder; `desolate doctor` fails if the stack's VMs run another
  checkout's code. To move a stack to another checkout: `desolate destroy`, then
  `desolate bootstrap` from the new one.
- **`desolate destroy` keeps everything but the VMs**, keys included: the root's keys,
  repository list, secrets and network rules are taken out of the root VM first
  (`~/.desolate/root-kept`), and the next `bootstrap` puts them into the new root and
  deletes that copy. `desolate start <d>/<w>` then makes a workspace's VM again, on its
  checkouts.

## Removing it

```bash
desolate rm you--app/greet            # a workspace's VM (its branches stay); or Delete on the dashboard
desolate rm you--app                   # a domain and its clones
desolate destroy                  # every VM; your clones, keys and secrets stay (the next bootstrap puts them back)
desolate destroy --all            # and ~/.desolate: mirrors, clones, the root's keys
```

What each of these removes from `~/.desolate` is in [home.md](home.md#what-removes-what).

Then, on GitHub, delete the deploy keys titled `desolate read (host ...)` and
`desolate write (host ...)` from each repository you cloned.

## When something is wrong

- **`desolate doctor`** says what is wrong and what to run. Every refusal desolate prints
  ends with a `fix:` line.
- **A page "cannot be found"**: open it in Chrome or Firefox, not Safari.
- **Something in a workspace cannot reach a host**: that is usually the point. Its requests,
  and why each was refused, are in `desolate net log you--app`; `desolate domain you--app net
  allow <host>` lets one through.
- **A push was refused at approval**, or timed out: it waits two minutes; run it again.
- What desolate has got wrong before, and how it was found: [`incidents.md`](incidents.md).
