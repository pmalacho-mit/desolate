# desolate: what's in ~/.desolate

Everything desolate keeps on your Mac is in one folder, `~/.desolate` (set `DESOLATE_HOME` to
put it elsewhere). This page says what each folder in it is for, what it holds, and whether a
VM sees it: some folders are **shares**, the same files seen from inside a VM at another path,
and the rest only the Mac sees.

What is *not* here matters as much: the root's keys, the repository list and every domain's
secrets live on the root VM's own disk, on purpose, so no share leads to them (see
[Not on the Mac](#not-on-the-mac)).

## At a glance

```
~/.desolate/
  domains/<domain>/        one per domain
    repos/                 the domain's clones and its workspaces' checkouts   ->  /workspaces in each of its workspaces
    outbox/                what the domain's workspaces hand the root          ->  /desolate/outbox in each of its workspaces
    inbox/                 what the root hands them (read-only to them)        ->  /desolate/inbox in each of its workspaces
    cache/                 the domain's package caches (npm, pip, ...)         ->  /desolate/cache in each of its workspaces
    domain.json            the domain: its name, title, repositories
    workspaces/<w>.json    each workspace's plan: its VM, checkouts, size
  mirrors/<owner>/<repo>.git   what each GitHub repository published           ->  /desolate/mirrors (root: read-write; git VM and workspaces: read-only)
  root/<owner>/<repo>      the root's clone of each repository                 ->  /desolate/root (root: read-write; git VM: read-only)
  git/<owner>/<repo>       your own clones, for Open in git                    ->  /git in the git VM
  git-out/                 pushes the git VM hands the Mac                     ->  /desolate/out in the git VM
  git-answers/             the Mac's answers to those (read-only there)        ->  /desolate/answers in the git VM
  run/<vm>/                each workspace's link to its proxy (a socket)       ->  /desolate/link in that workspace
  lima/                    the VMs themselves: their disks and settings        (no VM sees it)
  state/                   the Mac side's own facts and tokens                 (no VM sees it)
  approver/                the key that approves pushes                        (no VM sees it)
  logs/                    the daemon's log                                    (no VM sees it)
  root-kept/               only between `destroy` and the next `bootstrap`     (no VM sees it)
```

Every VM also mounts the desolate checkout you run (the folder `cli.sh` is in, not part of
`~/.desolate`) read-only at `/desolate/release`. The root VM sees all of `domains/` at
`/desolate/domains`, so a new domain needs no restart of it.

## domains/

One folder per domain, named by its slug (`owner--repo` for a repository's home domain).
Each workspace VM sees only its own domain's folders, never another domain's.

- **`repos/`** is **`/workspaces`** in every workspace of the domain, read-write. It holds
  the domain's clone of each repository, `repos/<owner>/<repo>`. The domain's first workspace
  works in that clone itself, and each later one in a worktree of it,
  `repos/<owner>/<repo>/.worktrees/<workspace>`. `desolate status --json` gives each
  workspace's checkout paths (`/workspaces/...`). `repos/.desolate/locks` keeps two
  workspaces starting at once from changing the shared `.git` together.

  This is your work, and it stays when a VM is removed: `desolate rm <d>/<w>` and
  `desolate destroy` keep it, and `desolate rm <domain>` and `destroy --all` remove it.
  It's also the quickest way to move a large file in or out: copy it here, on the Mac. A file
  watcher in the workspace (a dev server's) won't notice a file written from the Mac: `touch`
  it in the workspace, or have the watcher poll.

  Every workspace of a domain sees every checkout of it, so the domain is the boundary, not
  the workspace. The root reads `repos/` only as data, and never runs git there.

- **`outbox/`** is **`/desolate/outbox`** in the domain's workspaces, read-write: what they
  hand the root. `outbox/sync/<owner>/<repo>` holds a branch written out as data (a git
  bundle, its list of refs, LFS objects), which the root checks before taking anything.
- **`inbox/`** is **`/desolate/inbox`** in the domain's workspaces, **read-only** to them: the
  root writes it, so a domain cannot forge what it is told.
  - `domain.json`: the domain's own state, as the root sees it: its workspaces and their
    statuses, for `desolate` commands in a workspace.
  - `workspaces/<w>.json`: each workspace's plan, which the VM reads as it starts.
  - `secrets.json`: the domain's secrets by **name**, with their hosts and on/off switch.
    Never their values.
  - `ca.pem`: the certificate of the domain's secrets proxy, which the workspace trusts.
  - `events.jsonl`: the domain's events, for `desolate events` in a workspace.
- **`cache/`** is **`/desolate/cache`** in the domain's workspaces, read-write: npm's, pip's
  and other package managers' caches, shared by the domain's workspaces and no one else's.
- **`domain.json`** and **`workspaces/<w>.json`** are the root's record of the domain and of
  each workspace (its VM's name, repositories, checkouts, size, branch). The root VM writes
  them, through its view of `domains/`; no workspace sees this copy.

## mirrors/ and root/

- **`mirrors/<owner>/<repo>.git`**: one bare mirror per repository, what GitHub published as
  last fetched. The root fetches into it (read-write at `/desolate/mirrors`). The git VM
  sees all of them read-only. A workspace sees only its domain's repositories' mirrors,
  each read-only at `/desolate/mirrors/<owner>/<repo>.git`. The path is the same in every VM
  because a clone borrows the mirror's objects by that path. A domain's clones never hold a
  key: `git fetch` in a workspace reads the mirror.
- **`root/<owner>/<repo>`**: the root's own clone of each repository. A branch a domain offers
  lands here, as `root/<domain>/<branch>`, after the root has checked it, and pushes to
  GitHub go from here once you approve. It is `/desolate/root` in the root (read-write) and
  in the git VM (read-only: `git fetch root` there brings what domains offered).

## git/, git-out/, git-answers/

The git VM, behind Open in git and `desolate git --open`: a VM with no network, for your own
git.

- **`git/<owner>/<repo>`** is **`/git`** in the git VM, read-write: your own clones there.
- **`git-out/`** is **`/desolate/out`** there, read-write: a `git push origin` in the git VM
  writes a bundle and a request here, and the Mac carries it to the root, which checks it
  and asks you to approve.
- **`git-answers/`** is **`/desolate/answers`** there, **read-only**: the Mac's replies.

## run/

**`run/<vm>/`** holds the socket that links one workspace VM to its proxy in the root (its
only way out). It is `/desolate/link` in that VM. Folders named after a VM that is gone are
left over and harmless.

## lima/

The VMs, as Lima keeps them (`LIMA_HOME`): one folder per VM, with its disk, its settings
(`lima.yaml`, and `desolate.json`, what desolate made it with), its logs (`ha.stderr.log`),
and for a VM with no network the macOS sandbox profile that keeps it so (`confine.sb`).
This is most of the space desolate takes. No VM sees this folder.

- `dsl-main-root`: the root VM. `dsl-main-git`: the git VM.
- `dsl-main-base`: the base every VM is copied from; it doesn't run.
- `dsl-main-<10 hex>`: a workspace (the name is a hash of `<domain>/<workspace>`;
  `desolate status --json` names each one's VM).
- `dsl-main-t<9 hex>`: a domain's environment, built once, which its workspaces start from.
- `_config/`: Lima's own (its SSH key to the VMs), and `base.yaml`, the base's settings.

(`main` is the stack's instance. The test stacks use other names, and other homes.)

Don't edit these by hand or with `limactl`: `desolate rm`, `destroy` and `bootstrap` keep
them and the records in `domains/` in step.

## state/, approver/, logs/

Only the Mac sees these.

- **`state/`**, the host's own facts:
  - `config.json`: which VM backend the stack uses.
  - `daemon.pid`, `daemon.sock`: the host daemon, and the socket the CLI talks to it on.
  - `ui-token`, `approve-token`, `git-token`: the credentials in the addresses `desolate ui`,
    `desolate approve --web` and `desolate git` print. Anyone with one can open that page.
  - `host-token`: what the daemon presents to the root's state service.
  - `workspace-keys/<vm>`: each workspace's key, made here and written onto that VM's own
    disk, so the Mac can tell a request from a workspace that starts workspaces is really
    its own. `spawn.json`: each domain's limit on that, and which workspace started which.
  - `unsaved/<vm>.json`: what the last look at a workspace found uncommitted, untracked or
    stashed, so Delete can tell whether it's safe while the VM is stopped.
- **`approver/`**: the key that approves pushes (`key`; `approver.pub` is its public half,
  which the root holds), and `kind`, how you approve (`terminal`, or `touchid` with the
  Mac's Secure Enclave). A push needs a signature with this key.
- **`logs/daemon.log`**: the host daemon's log. A VM's own logs are in `lima/<vm>/`.
- **`root-kept/`** exists only between `desolate destroy` and the next `bootstrap`: the root's
  keys, repository list, secrets and network rules, taken out of the root VM so a rebuild of
  it keeps them. `bootstrap` puts them back and deletes it.

## Not on the Mac

On the **root VM's own disk**, under `/var/lib/desolate`, `/var/lib/desolate-root` and
`/var/lib/desolate-proxies`, never on a share:
- the GitHub deploy keys (read and write) for each repository;
- the repository list;
- every domain's secrets, values included, and its network rules;
- the push approvals and the proxies' state.

No folder of `~/.desolate` leads there, so nothing on the Mac's share and nothing in a
workspace has a path to a key or a secret's value. `desolate secret show` reads a value
through the Mac's root access to the VM, not through a file.

On each **workspace VM's own disk**: its devcontainer's images and containers, its docker
volumes, the editor's server and extensions, and its workspace key. These go when the VM
is removed. Your checkouts don't: they're in `domains/<domain>/repos/`.

## What removes what

| | VMs (`lima/`) | `domains/<d>/repos/` (your work) | keys and secrets | `mirrors/`, `root/` |
|---|---|---|---|---|
| `desolate rm <d>/<w>` | that workspace's | kept (its branch and checkout stay) | kept | kept |
| `desolate rm <domain>` (once its workspaces are removed) | its environment's | that domain's removed | the keys are kept | kept (the root's clones keep its branches) |
| `desolate destroy` | all | kept | kept, through `root-kept/` | kept |
| `desolate destroy --all` | all | all removed | removed (delete the deploy keys on GitHub too) | removed |
