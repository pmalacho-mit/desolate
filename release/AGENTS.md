# Your environment

You are in a **workspace** managed by `desolate` v3: a virtual machine of your own, in a
**domain**. Read this before diagnosing any network or git failure: most of what you cannot
reach is unreachable on purpose, and is not a bug in the project.

- Your checkouts are under `/workspaces/<owner>/<repo>`: the domain's clone of each of its
  repositories. You are in its main checkout, or in a worktree of your own at
  `/workspaces/<owner>/<repo>/.worktrees/<name>`. `cat ~/.desolate/workspace.json` says which.
- Other workspaces of your domain may be working in the same repositories at the same time,
  each in its own worktree. You share one `.git` with them: you can see their branches, and
  they can see yours. Workspaces of other domains see nothing of yours.
- `/desolate/` is desolate's: `/desolate/mirrors/` (read-only: what each remote has
  published), `desolate status` (say how your work is going; also `/desolate/status`), `/desolate/release/AGENTS.md`
  (this file).

## Git: commit freely; you cannot push, and need not try

**No credential exists in this VM, and there is no route to use one.**

- **Do:** commit, branch, rebase, stash, diff, log. `git fetch` and `git pull` get what the
  remote has now: the root refreshes its read-only mirror first, and `origin` is that mirror,
  so they need no key and no network here. (`desolate fetch` does the same for every
  repository at once.)
- **When your work is ready:** commit it, then `desolate offer` (in the checkout, on the
  branch). That hands the branch to the person, who reviews it and pushes it.
  `git push origin <branch>` offers it too, but then **exits with an error on purpose**
  (`! [remote rejected] ... (offered to the root, not pushed ...)`), so that git does not
  record a remote branch that does not exist. That error means the offer worked; the line
  `offered <repo> <branch> at <commit>` above it says so. Do not retry it or look for another
  way to push. Prefer `desolate offer`, which exits 0 when the offer is taken. **Offering is
  not pushing, and nothing you do here pushes.** Do not look for a token, install `gh`, or
  add a remote: there is nothing to find. If the pull request should go into a branch other
  than the default one, say which: `desolate offer --base <branch>`.
- **If an offer is refused** with "the root refused this domain's bundle", some branch in
  this clone (not necessarily yours) holds an object git considers dangerous: a `.git`
  directory inside a tree, a `.gitmodules` that is a link or names a command, a malformed
  object. Nothing new from this domain is taken until that branch is deleted. If you did
  not make it, set `orange` and say which branch; do not try other ways to send it.
- Do not add or remove worktrees of your own in a loop: other workspaces share this `.git`.
- LFS works: files check out from the mirror, and new large files travel with your offer.
- **A repository of this domain by its GitHub address** (`git@github.com:o/r.git`,
  `https://github.com/o/r.git`: what suede's install and sync, or a git dependency, name) is
  read from the domain's mirror, private or not; a push to that address is an offer. Any
  other repository is read over the network like any site, public ones only.

## Saying how it's going: `desolate status`

```bash
desolate status set blue   "working: issue #42"
desolate status set orange "needs a human: which API version?"
desolate status set red    "the tests cannot run: no database"
desolate status set green  "ready: offered issue/42"
desolate status note "what I changed, for the other agents here"
desolate status board      # every checkout in this repository: its status and its note
```

One line, at most 200 characters. Colours: `gray`, `blue`, `green`, `yellow`, `orange`,
`red`. Unless your task says otherwise: blue working, orange needs a human, red failed, green
done, gray withdrawn (say why). It is shown to the person and read by scripts. It is never
acted on: `green` pushes nothing.

## Other workspaces: starting, following and closing them

You can start another workspace beside you, in your domain only, labelled as started by
you, and the person sees it. **Do it only when the work needs it:** a separate piece of work
that should run apart from yours (an issue you found that needs its own branch, a long check
you want run in parallel). Each one is a VM on the person's Mac, with its own memory, and one
more thing for them to look at and clean up. For a question you can answer yourself, a
script, or a second look at your own branch, stay where you are. If a separate piece of work
can wait for the person, offering it as an issue (`desolate issue offer`, below) is often
better: they decide when it runs.

```bash
desolate domain stats                  # this domain's workspaces, who started each, its limit, the Mac
desolate spawn --name fix-docs --checkout <owner/repo>=worktree:task/fix-docs -- <command> <args...>
desolate events --follow               # what happens in this domain, one JSON object per line
desolate close fix-docs                # remove one you started, once nothing in it would be lost
```

- `desolate domain stats` first: it shows how many are already started, and any limit the
  person set (none, unless they set one; they can also turn it off). Close each one you
  started once its work is committed and offered: `desolate close <name>`.
- `--checkout <owner/repo>=worktree:<branch>` (repeat it per repository) is what it works on:
  a branch of its own, one no workspace has checked out. The first one's devcontainer is its
  environment (a node front end gets node, though the domain's first repository is python).
  Repositories you do not name get their main checkout if it is free, else none.
  `--branch <b>` instead puts one branch in each of the domain's repositories.
- The command after `--` runs in the new workspace as its agent, in its first checkout, as
  the words you give (nothing reads them as a shell line). Without one, the workspace is
  only made. It has the domain's secrets by name, like you, and not your shell's state.
- Its work reaches you as any workspace's does: its branch, once committed, is in your clone
  (`git branch -a`), and `desolate status board` shows what it says.
- `desolate events` says when it is made (`workspace-made`, with `startedBy`, as soon as it
  is planned; `workspace-state` with `state: up` once it runs), stopped or removed, what it
  offered, its status, and how each request the host ran ended (`request`, with `ok` and
  why not; one the root refuses at once is refused on the spot instead). `--follow` starts
  now: a spawn is answered in seconds, so use `--all` to see what already happened.
- `desolate close <name>` works only on one you started, and only if every checkout in it
  has nothing uncommitted, untracked or stashed: commit there first. Its branches stay. If
  you are removed first, the ones you started stay, flagged for the person.

## GitHub issues: offer them, the person publishes them

When you find work that should be tracked where everyone can see it (a bug beside your task,
a follow-up), offer it as a GitHub issue. You cannot create one, and need not try: the person
reads it on their dashboard, may edit it, and publishes it as themselves.

```bash
desolate issue offer --title "Login loops after a password reset" --body-file notes.md --label bug
```

- In a checkout, it is for that repository; else name it: `--repo <owner>/<repo>`.
- The body is GitHub's Markdown. Keep it to what the person needs: what you saw, how to see
  it again, what you think it needs. At most 65,536 characters (GitHub's own limit); no control or invisible characters.
- Labels must already exist in the repository. A label like `desolate:run` may make a
  recipe start an agent on the issue once it is published: offer it only when the task says.
- `desolate events --follow` says when it is published (`issue-published`, with its page) or
  rejected (`issue-rejected`).

## Network: named HTTP and HTTPS, through a proxy; nothing else

This VM has no route to anything. Its one way out is a proxy that belongs to this workspace.

- **What works:** `http://` and `https://` to a **hostname**, on ports 80 and 443. You need
  no proxy settings: connections are redirected for you. TLS is end to end with the real
  server.
- **What does not, by design:** any other port; SSH (no `git+ssh`, no `scp`); an address
  without a name (`curl https://1.2.3.4` is refused); the host machine, the LAN, the root,
  other workspaces; ICMP. Do not retry these or work around them: say what you needed.
- Names resolve to a placeholder address (`198.18.0.1`) here. That is expected: the proxy
  resolves the real name. Do not "fix" `/etc/resolv.conf`.
- **A refusal over HTTPS is a dropped connection**, not an answer: TLS is end to end, so the
  proxy cannot say anything inside it. curl reports `SSL_ERROR_SYSCALL`, node "socket
  disconnected before secure TLS connection was established". To learn why, ask the same
  host over plain HTTP (`curl -s http://<host>/`): the rule is per host, and over HTTP a
  refusal is a `403` with a line starting `desolate:` that says why. "Not on the domain's
  allowlist" means the person has limited this domain to listed hosts: ask them.
- Every request is logged with this workspace's name.

## Dev servers

Bind to `0.0.0.0` or `127.0.0.1` on any port from 1024 up, and that is all: desolate notices
the listener and publishes it. **The person opens it at this workspace's own hostname, on the
same port number**, not at `localhost`:

```bash
echo "http://$DESOLATE_DEV_HOSTNAME:5173"     # in a devcontainer: the whole address, for port 5173
jq -r '"http://\(.domain)-\(.workspace)-"' ~/.desolate/workspace.json   # no devcontainer: the name's start
```

The exact URL is what the person's `desolate ports` shows; tell them the port. Dev servers
that check the Host header (Vite, webpack) accept these names as they are: they end in
`.localhost`. Vite's `server.host` must be `0.0.0.0` (its default, `localhost`, can mean
`::1` only), and its HMR websocket works through the same address. If a port you
wanted is already taken here, another workspace of the person's speaks a protocol with no
hostname on it (a database): let your server move to the next one. If the person says your
port does not open, a program on their Mac holds that number (their `desolate ports` and
dashboard say so): it still works inside this workspace, but give what they open another port.

## Secrets: you hold names, not values

If your task needs an API key, the person has stored it for this domain under a NAME such as
`MYAPP-OPENAI-KEY`. `/desolate/inbox/secrets.json` lists the names, the hosts each may be
sent to, and the headers it is substituted in. Use the name wherever the key would go
(`export OPENAI_API_KEY=MYAPP-OPENAI-KEY`): on the way out, over HTTPS, toward those hosts
only, the name is replaced by the value. You never see the value, responses that echo it
are scrubbed back to the name, and looking for it is wasted effort. A name sent anywhere
else arrives as a name. If the name you need is not in the list, set `orange` and ask.

## Where you are running

If the project has a `devcontainer.json`, you are in its devcontainer, which runs inside
this workspace's VM: the project's own image, features and lifecycle commands, as written.
`/workspaces/<owner>/<repo>` is the same path in the container and in the VM. `docker` in
the VM (and in the container, if the spec gives it one) is the VM's own daemon; containers
you start reach the network the same way you do, through the workspace's proxy. A dev
server you start is reachable by the person at the workspace's own hostname, on the port
it listens on: tell them the port, not `localhost`. With a compose spec you are in its
primary service: the other services are reached by their names, as the spec intends;
what listens in your service, what a service publishes (`ports:`), and each
`forwardPorts` entry written `service:port` reach the person the same way.

If the project has no `devcontainer.json`, or it did not come up, you are in the VM itself,
with what its base image has (git, git-lfs, node, python3, curl, jq, docker). The person
may be watching in the workspace's editor (VSCodium in a browser tab); it is the same
place and the same files.

## When to stop and ask

Anything needing a push, a secret, a host the proxy refuses, SSH, or another domain's work.
These are the person's, from outside this VM, by design. Set `orange` with what you need.
