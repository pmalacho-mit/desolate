# Trying desolate: notes for its first users

You are one of the first people to use desolate for real work. This page says what to
expect: what is solid, what is new, what has never been tried, and what to send back when
something goes wrong. [getting-started.md](getting-started.md) is still the way in; read this
first.

## The one rule

**Your Mac and the root VM hold things worth stealing. Never run untrusted code in either.**
Code you have not read (a dependency, a branch someone sent, what an agent wrote) runs in a
workspace. On the Mac and in the root you look and decide; you do not `npm install` there.
The [README](../README.md#the-one-rule-you-keep) says why. Everything else on this page is
about convenience; this is about safety.

And two habits:
- **Approve only what you reviewed.** A push waits for you to type the branch name (or click
  Approve on the approval page), and it sends exactly the commit it names. Read what it says
  it sends.
- **The addresses `desolate ui` prints carry a token.** Anyone on your Mac with the approval
  page's address can approve a push. Keep them to your own browser.
- **Open a workspace's code in its own editor** (`desolate editor ... --open`), never in a
  desktop editor on the Mac: the clones under `~/.desolate/domains/` are on your disk, and
  VS Code or a JetBrains IDE opened on one runs the project's tasks, extensions and hooks
  outside every VM.

## Before you start

- **An Apple-silicon Mac** (M1 or later), with Homebrew, and `brew install lima node gh jq`.
  Lima must be 2.3 or newer, node 22.18 or newer. Leave 15 GB of disk free.
- **Chrome or Firefox.** Safari cannot open desolate's addresses (`*.localhost`).
- **Admin on the repositories you clone,** or someone who is: desolate adds two deploy keys to
  each (one read, one write). Without admin, `desolate clone <repo> --keys-by-hand` prints the
  keys for an admin to add. Some GitHub organisations switch deploy keys off altogether; if
  `clone` cannot register the keys, ask an organisation admin whether they are allowed.
- **Memory.** A workspace takes up to a quarter of your Mac's memory by default (3 to 8 GiB).
  On a 16 GB Mac, two at once is comfortable; `desolate domain <d> size --memory 4g` changes it.

## The first hour

Follow [getting-started.md](getting-started.md) from the top, and turn on tab completion:
domain names are `owner--repo`, and TAB completes them and their workspaces.

```bash
echo 'source <(desolate completion)' >> ~/.zshrc && source ~/.zshrc
```

Getting started takes under half an hour, most of it the first download. Then do a real
piece of your own work in a workspace, start to finish: open the editor, change something, run it (a dev server opens at the address
`desolate ports` prints), commit, `git push` (which hands the branch to the root), review it on
the dashboard, push it, and open the pull request from the page desolate gives you.

Agents are optional. To try one, see step 6 of getting-started and
[`recipes/`](../recipes/README.md). To see how agents and workspaces fit together without an
AI, the stand-in agent commits and offers on its own:

```bash
~/desolate/recipes/agent.sh <domain> "Write TASK.md" -- bash /desolate/release/recipes/echo-agent.sh
```

## What to expect

**Solid** (exercised by the test suites, and used on the M1 every day of development):
cloning, workspaces and their devcontainers, the editor, dev servers by name, git in a
workspace, the dashboard and its review, pushes through approval, secrets that never enter a
workspace, the network rules, upgrading with `git pull` and `desolate bootstrap`.

**Rough edges you will meet:**
- **The first workspace of a repository takes a minute or two**: it builds the project's
  environment once. The next ones start in about 20 seconds.
- **The editor is VSCodium.** Its extensions come from Open VSX, and some Microsoft-only ones
  (Pylance, the C# Dev Kit, Copilot) are not there.
- **A workspace's commits carry your git identity** from the Mac's `git config --global`.
  Without one there, they carry the workspace's name: set yours before your first `up`.
- **`git push` in a workspace reports the push as refused.** That is how it tells you nothing
  went to GitHub: it offered the branch to the root instead. The message says so.
- **macOS may ask whether `limactl` may accept incoming connections.** Click Deny.
- **`desolate rm <domain>/<workspace>` removes the workspace and anything uncommitted in it.**
  `desolate stop` keeps everything.
- **Only ports 80 and 443 reach the network from a workspace.** A registry on another port
  (`:5000`), ssh to a forge, or a database outside cannot be reached at all.
- **A private registry during an image build** (its token a desolate secret, used by a
  Dockerfile's `npm install` or a devcontainer feature) fails TLS: the build container does
  not trust the domain's certificate. Do that install in `postCreateCommand` instead. Public
  registries need nothing: their TLS is never opened.
- **A repository whose devcontainer uses Docker Compose with a service that is not glibc**
  (Alpine) gets no port forwarding and no editor inside that service.

**You will be the first** (none of these has been tried yet; tell us how it goes):
- installing on a Mac other than the one desolate was developed on;
- a real Claude subscription token with `recipes/claude.sh` (it was tried with a stand-in token
  only), and any agent other than Claude;
- `recipes/issues.sh` and `recipes/suede.sh`;
- the Touch ID approver (`DESOLATE_APPROVER=touchid`): leave it alone for now;
- more than a handful of workspaces on one Mac, and weeks of uptime.

## When something goes wrong

1. **Run `desolate doctor`.** It checks everything it can and says what to run for each
   failure. Every refusal desolate prints ends with a `fix:` line: try that first.
2. **A page will not open:** Chrome or Firefox, and the address `desolate ui` prints (it carries
   its token).
3. **Something in a workspace cannot reach a host:** that is usually the point.
   `desolate net log <domain>` says what was refused and why;
   `desolate domain <domain> net allow <host>` lets one through.

To report a problem, send:
- what you ran and what it printed (all of it);
- the output of `desolate doctor`;
- `git -C ~/desolate log -1 --format=%h` (which desolate you are on);
- for a workspace problem, `desolate list` and the workspace's name.

desolate's logs are in `~/.desolate/logs`. Do not send `~/.desolate` itself: it holds your
clones, and the root VM's disk holds your keys.

## Updating, and leaving

```bash
git -C ~/desolate pull && desolate bootstrap        # update: nothing of yours is touched
desolate destroy --all                              # leave: every VM, and ~/.desolate
```

After leaving, delete the deploy keys titled `desolate read (host ...)` and
`desolate write (host ...)` from each repository you cloned (GitHub: the repository's
Settings, then Deploy keys).
