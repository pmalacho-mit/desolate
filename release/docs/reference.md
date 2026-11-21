# desolate: reference

The details behind [the README](../README.md) and [getting started](getting-started.md).

## Approving, pushing, and the pages desolate serves

**Approving a push happens on the host, outside every VM.** The root's keyring lets a write
key sign only for a push whose description (repository, branch, commit) was signed by the
host's approver key, and that key signs only after you type the branch name on your
terminal. Nothing in any VM can approve, and a script or agent harness driving `desolate`
on your Mac stops there too, because the prompt is on the terminal and not on its input.
It is a gate against work being pushed without you having looked, not a defence against
hostile code on your Mac (see [the one rule](../README.md#the-one-rule-you-keep)). If you want that as well, on a Mac
`DESOLATE_APPROVER=touchid desolate bootstrap` keeps the approver key in the Secure Enclave
behind Touch ID; that path is written and has never been run. `desolate approve --selftest`
checks whichever you have without pushing anything.

**What you approve is everything the push sends.** The text you sign names the repository,
the branch, the commit and what the remote's branch is now, and also what desolate's
reviewer says the push sends: the sha256 of the pack it made of the commits (the objects the
commit has that the remote's branches do not), and the LFS objects those commits point to.
The pusher sends that pack and those objects, and no other: it takes the whole pack and
every object first, and one that does not hash to what was approved is refused before a byte
reaches the forge. A push the reviewer cannot describe cannot be approved.

What the page and the terminal show of it, all from the reviewer: the commits, the net
change, files a commit changed and a later one changed back (which the net change does not
show), each commit whole (who wrote it, when, its whole message, its diff), a page at a
time and none of it cut: every warning, every file that changes what runs on the forge, the
squash's whole message; on the page, the rest of a list or a diff on asking. While the
reviewer works, both say what it is doing, and wait for as long as you do (Ctrl-C, or
Refuse),
and a warning for anything a commit carries that is not shown (a header other than git's
four, a signature, an encoding). The two choices:
- **Squashed into one commit** (`desolate push ... --squash`, `desolate approve --squash`,
  or the page's second button): the reviewer's commit with the last commit's files, on what
  the branch builds on, so nothing a commit in between held reaches the remote's history.
  Its message, who it names and its dates are shown, and the text you sign names it and
  the commit it squashes. The workspace's branch still has the commits that were squashed;
  the host prints the command that moves it onto the squash, keeping what was committed
  since (a merge as a merge) and what was not committed:
  `git fetch && git rebase --rebase-merges --autostash --onto origin/<branch> <the commit squashed> <branch>`.
  A later push that would replace the squash says so, and names that command again.
- **Replacing the remote's branch**, when the commit does not build on it: `desolate push`
  refuses it without `--replace`, the terminal asks you to type `replace <branch>`, and the
  page approves it only after you type the branch's name. (This is the host's own gate, not
  a line of the signed text: what the remote's branch is now, `onto`, is in the text, and
  the forge moves the branch only from exactly that.)

**Use Chrome or Firefox for desolate's pages** (the dashboard, the approval page, the git
terminal, the editors): they are at names under `localhost`, which those browsers resolve
themselves. Safari asks macOS, which resolves `localhost` alone, and says it cannot find
the server.

**Or approve with one click.** `desolate ui --open` signs your browser in to the approval
page, the git terminal and the dashboard, with one link: each page in turn trades a code that
works once, for a minute, for its own session cookie, and sends the browser on to the next,
the host's two pages first (the root, which serves the dashboard, sees only the dashboard's
code, after the others are spent). Quitting the browser signs it out of all three. Or sign in
to the approval page alone: `desolate approve --web` (and `desolate ui`) prints its address,
`http://desolate-approve.localhost:<port>/?tkn=...`, to open once in your browser (`--open`). The dashboard's **Push** opens the page in a new tab, at its bare
address, the one way into it from another site: a token's address from another site is
refused, and so is the page in a frame. Every push waiting for you shows there, with what it would
send, as desolate's reviewer in the root worked it out (its commits and files, and whether
it builds on the remote's branch or replaces it). The page is the host's, not a VM's, and it
signs only for a request from its own tab: a cookie only that address gives, and beside it a
key the page keeps in its own storage (a browser sends a name's cookies to every port of it,
so a program listening on another port is sent the cookie, but never the key), its own origin
(a page an agent wrote, on a workspace's name, is another), a token per push, a JSON body.
It cannot be framed, and its Approve button arms only after the tab has had your attention
for a second and the pointer then moves onto it, so a click aimed at something else when a
window opened under it lands on nothing. Treat the address like a password: anyone with it,
on your Mac, can approve. The pages are served on both `127.0.0.1` and `::1` (where browsers
look first for these names), or not at all: while another program holds the port on `::1`,
desolate prints no address with a token in it, and retires the tokens (a tab already open
would send that program its cookie); a retired token is refused until it is made again
(`desolate bootstrap` makes them all again). In the git terminal (`desolate git`) the same page opens beside the
shell when a push waits: `git push`, then Approve, in one tab. Only the git terminal's own
origin may frame it; there the pointer over the frame counts as your attention, and in Chrome
Approve arms only while the browser reports the button visible and uncovered.

**After a push: its pull request, and noticing the merge.** A branch offered with
`desolate offer --base <branch>` is for that branch; otherwise for the repository's default.
When its push lands, desolate gives GitHub's page for opening the pull request, filled in:
"Open pull request" in the dashboard's activity, a line after `desolate push`, and one in a
raw `git push origin`'s output. It opens in your browser, where you are signed in as
yourself, and you create the pull request there: desolate holds no forge token, and this
needs none. The root keeps a record of what it pushed (`/var/lib/desolate/pushed.json`, kept
across `destroy`). When the mirror shows a pushed commit's changes in the branch it was for,
`desolate branches` and the dashboard say "merged into <base>" for as long as the domain's
branch is still at that commit. The root fetches a repository with a push waiting to land
every 15 minutes, for 30 days. The test is conservative: every file the branch changed is, in
the base, exactly as the branch left it (so a merge commit, a squash and a rebase all count).
A base that has since changed one of those files again is not recognised, and the branch is
then just not marked.

**Git in your browser.** `desolate git <owner/repo>` prints the address of a terminal the host
serves in a browser tab: bash, in the git VM, in a clone of your own at `/git/<owner>/<repo>`.
It is git as you use it anywhere: `git fetch` (from the mirror), `git fetch <domain>` (every
branch that domain's workspaces made, as `<domain>/<branch>`; `git fetch root` has all
domains', as `root/<domain>/<branch>`), diff, log, rebase, commit, and `git push origin
<branch>`, which waits for you on the approval page and then goes out through the root.
`git push <domain> <branch>` delivers a branch to a domain instead (its workspaces see
`root/<branch>`; nothing leaves the machine, so nothing is asked), and `desolate fetch` has
the root refresh the mirror from the remote first, then fetches every remote. Your commits
there carry the Mac's own `git config --global user.name`/`user.email`, if it has
them and the git VM has none yet. The
git VM has no network, no key, and nothing of a project's that runs: no devcontainer, no
direnv, no clone's hooks; `less` shows colour and nothing else raw, and vim reads no
modelines. The root's clones and the mirrors are read-only to it. What it pushes, the root
takes in like a domain's work: every object checked first. The terminal's address carries
this stack's token, like the approval page's: treat it like a password. Once you have opened
it, **Open in git** in the dashboard's review opens a shell at that repository's clone (made
on the way if it is not there yet), on the branch reviewed, as its domain has it: it fetches
the domain, makes your branch of that name at the domain's commit or fast-forwards it (never
past work of your own, and never switching away from uncommitted changes), sets its upstream
to the remote's branch of that name, and shows `git status`. So it says what the workspace
said: "ahead of 'origin/main' by 2 commits", and `git push` sends exactly that, for your
approval. (`desolate root
shell` is still there, a shell in the root VM itself, for what only the root can do.)

**Your own scripts: `desolate events`.** A JSON object per line, as things happen, until you
stop it (`--replay <n>` first repeats the last ones the host holds). Each says where it comes
from, which is how far to believe it:

| `source` | types | believe it as |
|---|---|---|
| `pusher` | `pushed`, `push-failed`, `push-uncertain` | the remote's own answer: `pushed` means the branch is at that commit |
| `host` | `approved`, `refused`, `workspace-up`, `workspace-down`, `git-push-handed`, `git-delivery-handed` | the host's own doing |
| `root` | `offered`, `offer-gone`, `bundle-refused`, `status`, `head` (a checkout switched branch or its branch moved), `approval-waiting`, `workspace-made`, `workspace-state`, `workspace-removed`, `issue-offered`, `issue-published`, `issue-rejected` | an agent's word, relayed: safe to print, not to trust |

For example, a pull request for every branch pushed (the `gh` here is yours, on the Mac; no
VM has it):

```bash
desolate events | while read -r line; do
  [ "$(jq -r '.source + " " + .type' <<<"$line")" = "pusher pushed" ] || continue
  repo=$(jq -r .repo <<<"$line"); branch=$(jq -r .branch <<<"$line"); commit=$(jq -r .commit <<<"$line")
  title=$(gh api "repos/$repo/commits/$commit" --jq '.commit.message' | head -1)
  gh pr create --repo "$repo" --head "$branch" --title "$title" --body "Pushed through desolate at $commit." || true
done
```

Act only on `pusher` and `host` events when what you do matters: a `root` event's fields
(a status message, an offered branch's name) are what an agent wrote, with control
characters taken out (and a name desolate would not make is `null`). Pass a field to a
program as an argument, never into the text of a script: `osascript -e 'on run argv' -e
'display notification (item 1 of argv)' -e 'end run' -- "$message"`, not
`osascript -e "display notification \"$message\""`, which runs what the message says.
An approval given at the terminal (`desolate push`, `desolate approve`) is an `approved`
event too, with `"via": "terminal"`; a refusal there is not an event.

**What a push is, exactly.** The push goes out through the root's pusher, the one program
that can use a write key, and it asks the remote for one change: the branch moves from the
commit it was at when you approved (`onto`) to the commit you approved, or nothing happens.

**The dashboard** (`desolate ui`) is served by the root VM: every domain as a card, each
workspace with its status colour, "Needs you" on top, one click to open a workspace's
editor, start, stop, review an offer or push it (a push still waits for your approval on
the host). Reviewing an offer shows its commits, its files, warnings, and the diff, as text
git made in the root: nothing in it is run or rendered. It shows the command behind every
button.

- **A workspace's state** is a pill: running, stopped, or what the dashboard is doing to it
  (being made, starting, stopping, deleting) with the step it is at, and no buttons until
  that is done. Each checkout says whether its commits are on the remote.
- **Delete** removes a workspace only when nothing in it would be lost: no uncommitted
  changes, untracked files or stashes (looked at in its own VM while it runs, and again as it
  stops), and every commit on the remote (counted in the root). Otherwise the button is off,
  and hovering it says why. It runs `desolate rm <d>/<w> --if-clean --if-pushed`, which checks
  again. A workspace stopped before this existed was not looked at as it stopped: start and
  stop it once.
- **A domain with no workspaces** offers one on its default branch, named after it (`main`;
  `main-master` when its repositories' default branches differ, which the card says).
- **New domain** makes a domain with the repositories you tick. A repository's **home
  domain** (the `owner--repo` one `desolate clone` made) holds that repository alone: the
  card offers a new domain with it instead of adding others to it.
- Domains and the activity fold and filter; the review opens as a panel on the right, as wide
  as you drag it, and compares with the remote's default branch as last fetched (Fetch now
  fetches it).
- **A review's commits** can be read one at a time, or as a run (click, then shift-click):
  the root diffs from the first one's parent to the last (`/diff?...&from=&to=`), and takes
  only commits the review itself lists, in order. Push sends the whole branch all the same.
- **A domain's card** is headed by its name (what commands and workspaces use), then its
  title, when it says more than the name or the domain's one repository.

![Reviewing an offer with one of its three commits picked: the files that commit changes, and its diff as text](assets/review.png)

**What the root takes from a workspace** is data, and it is checked before it is the
root's: a bundle is copied out of the domain's reach and every object in it passes git's
strict checks before any enters your clone (a tree that hides a `.git`, a `.gitmodules`
that names a command, a malformed object: the whole bundle is refused, and you and the
workspace are told why); LFS objects must hash to their names; the small JSON files are
size-limited and validated; nothing in the outbox is followed if it is a link. The root's
git is configured so that a checked-out tree cannot make it run anything.
[`docs/v3/decisions.md`](https://github.com/pmalacho-mit/desolate/blob/main/docs/v3/decisions.md) has the audit, and what is left by
nature.

**What reaches your terminal.** Text a VM, a repository or GitHub wrote (a branch name, a
path in a commit, a status, an error) never reaches your terminal as something it would act
on. Every line desolate's CLI prints passes one function (`shared/text.ts`, `forTerminal`):
in text, control characters, bidirectional overrides and invisible formatting become `?`; in
a JSON line (`--json`, `desolate events`) they are kept as `\u` escapes, exact and still JSON,
so a script's `jq -r` decides what to print. A terminal session in a VM (`desolate exec`,
`root shell`, `agent attach`, a push's run, `upstream`) is passed through
`shared/terminal-filter.ts`, which keeps what a screen needs (colour, cursor movement, the
alternate screen) and drops every OSC, DCS and other string sequence (the clipboard, files,
the title, window operations); the root's shell and the git VM's page through `less`, which
shows any other control as text. The recipes print text from a repository or GitHub through
the same rule (their `say`), and pass every value to a command as one argument, never into a
shell or jq program.

**Dev servers.** A server that listens in a workspace is forwarded under the same port
number, at the workspace's own name: `http://<domain>-<workspace>-<id>.localhost:<port>`
(`desolate ports` prints each). The name is what keeps workspaces apart in your browser: each
workspace's apps have an origin of their own, so their cookies and storage never mix with
another workspace's, or with the editor's. Two workspaces can both serve 3000.
- **A protocol with no hostname in it** (a database: 3306, 5432, 6379, 27017, 11211, 5672,
  9092, 1433, 26257) reaches the one workspace that listened on that port first; the others
  keep the number taken. Another port's protocol is routed by the name in its first bytes, or
  not at all: a server that speaks first, on a port not in that list, needs it added on your
  Mac (`DESOLATE_RAW_PORTS=7000,7001 desolate bootstrap`). Nothing learns a port is raw from
  traffic.
- **A port a program on your Mac holds** (yours, or, on a Mac shared with others, another
  user's: desolate cannot take it from them) is not forwarded. The workspace's server still
  has the port inside the workspace (a backend behind its dev server's proxy works), but its
  address on that port reaches the Mac's program instead, cookies and all. `desolate ports`
  and the dashboard say so, naming the program when it is yours; serve what you open on
  another port. `desolate doctor` notes which common dev ports this Mac holds (on macOS, 5000
  is often the AirPlay Receiver: System Settings, General, AirDrop & Handoff). (Until
  2026-11-16 desolate kept such a port taken inside every workspace,
  which made a server there move on, and stopped a backend that needed it.)
- **A bare `localhost:<port>`** (the "Local: http://localhost:5173" a dev server prints,
  clicked) is sent on to the workspace serving that port, at its own name, the path kept;
  with several serving it, the page lists them. Nothing is ever served at bare `localhost`.
  (Plain HTTP only: `https://localhost` cannot be redirected without a certificate for it.)
- **Inside the devcontainer, `DESOLATE_DEV_HOSTNAME`** is the workspace's own name, so the
  address of a server on port 5173 is `http://$DESOLATE_DEV_HOSTNAME:5173`. Give it to what
  builds absolute URLs: a framework's public origin, an OAuth callback, a CORS allowlist.
- **Vite, webpack and other dev servers that check the Host header** accept these names
  unchanged: they end in `.localhost`, which those servers allow. Bind to `0.0.0.0` (Vite:
  `server.host: "0.0.0.0"`; its default `localhost` can mean `::1` only). HMR's websocket
  goes through the same address; nothing to configure for it. A front end that calls an API
  in the same workspace: proxy it from the dev server (Vite's `server.proxy`), so the page
  needs one address. (Tried with Vite 8 and Express, on the M1.)
- **A file watcher sees only changes made in its own VM.** `/workspaces` is a share: a file
  written from the Mac (under `~/.desolate/domains/...`) or by another workspace of the
  domain wakes no watcher, so a dev server keeps serving the old file. Edit in the
  workspace (its editor, its terminal, an agent there), `touch` the file there, or have the
  watcher poll (Vite: `server.watch.usePolling: true`).

**Containers a dev stack starts** (compose, `docker run`, from a devcontainer with the
`docker-outside-of-docker` feature: the VM's own Docker). Tried on the M1, 2026-11-18, with
a backend container behind Vite and Postgres:
- **From the devcontainer, reach a container at `localhost:<its published port>`.** A
  single-container devcontainer runs on the VM's network (`--network=host`), so Docker
  cannot join it to a compose network (`container sharing network namespace ... cannot be
  connected`), and a container's name does not resolve there: give a dev server's proxy
  `http://localhost:8000`, not `http://backend:80`. `host.docker.internal` does not resolve
  either: use `localhost`. Containers reach each other by name on their own network, as
  anywhere. A published port is also forwarded to your Mac, like any server's.
- **Keep a database's data on the VM's disk, in a named volume, not on `/workspaces`.** The
  share is the Mac's own folder, and macOS's virtiofs does not keep the owner a VM sets: a
  `chown` holds only until something reads the folder again (an editor, a file watcher, `git
  status`), and the owner reverts. Postgres's `initdb` then fails, at random, on
  "could not change permissions" or "Permission denied". A named volume (`volumes: [db:/var/lib/postgresql/data]`
  and `volumes: {db: {}}` in compose) is on the VM's disk: it survives a `stop` and `start`,
  and goes with the workspace's VM (`desolate rm`, Delete). The VM's own `/desolate/scratch`
  works for a bind mount too.
- **A container calling a host one of the domain's secrets is for must trust the domain's
  CA.** The workspace's VM and its devcontainer do (`SSL_CERT_FILE` and the rest are set for
  you), but a container has its own store: Python's `httpx` and `requests` use certifi's,
  which fails with `CERTIFICATE_VERIFY_FAILED`. Give the container the VM's store, which has
  the CA once the domain has a secret, and point it there. In compose:
  ```yaml
  volumes: ["/etc/ssl/certs:/desolate-certs:ro"]
  environment:
    SSL_CERT_FILE: /desolate-certs/ca-certificates.crt        # httpx, and so the Anthropic and OpenAI SDKs
    REQUESTS_CA_BUNDLE: /desolate-certs/ca-certificates.crt   # requests
    NODE_EXTRA_CA_CERTS: /desolate-certs/ca-certificates.crt  # Node
  ```
  (The folder, not the file: a bind of one file keeps the file as it was, and the store is
  written again when the domain's first secret is set.) Hosts without a secret are never
  intercepted, so a container reaches them with its own store as it is.
- **The editor's own origin never serves a dev server**: no port is forwarded under its name
  (T2 `06` asks it at the paths web editors forward ports at). Open dev servers by their own
  address, not through the editor's Ports view.

**A domain's repositories by their GitHub addresses.** Inside a workspace, git sends
`git@github.com:o/r.git`, `ssh://git@github.com/o/r.git` and `https://github.com/o/r.git` of
every repository the domain holds to the domain's mirror (refreshed first, as `origin` is),
and a push to them becomes an offer (`url.<helper>.insteadOf` in git's global config, in the
VM and the devcontainer: `workspace/git-urls.ts`). So suede's install and sync of a
dependency the domain holds, a git dependency in a lockfile, and `git clone` of a sibling
work with no credential, private repositories included. Only the `.git` spellings:
`insteadOf` matches a prefix. T2 `04`.

**What a workspace can reach.** A workspace's only way out is its own proxy, in the root.
- **Ports 80 and 443 only.** Every connection to those, from the VM, its devcontainer, or a
  container building an image, is taken to the proxy without any proxy settings. Nothing
  else leaves at all: a registry on another port (`:5000`), ssh to a forge, a database
  outside: none of it can be reached from a workspace. Fetch what needs those on the Mac or
  in the root, or serve it on 443.
- **TLS stays end to end,** with the real certificates, for every host but the hosts of the
  domain's own secrets: image pulls and `apt`, `npm` or `pip` in a build need nothing of
  desolate's. Only a secret's host is answered by the domain's secrets proxy, with a
  certificate of the domain's own CA, so that it can put the secret's value in.
- **That CA is trusted in the VM and in the devcontainer** (the VM's bundle, and
  `SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE` and
  `GIT_SSL_CAINFO` pointed at it), **not in a container building an image.** So a build step
  that talks to a secret's host (a private registry whose token is a desolate secret, used by
  `npm install` in a Dockerfile or by a devcontainer feature) fails TLS. Do that install in
  the devcontainer's `postCreateCommand` instead, which runs in the container that trusts it.
  Trusting the CA in image builds too is v2 code ([`release/proxy/container/`](https://github.com/pmalacho-mit/desolate/tree/4f32c77/release/proxy/container)
  at `4f32c77`), worth porting when
  someone needs a private registry during a build, and not before.

**Git in a workspace.** Ordinary git, with what a workspace cannot do handled for it. Each
clone's `origin` is two small git remote helpers (`workspace/git-remote-desolate-mirror` and
`-offer`):
- `git fetch` and `git pull` first ask the root to refresh the mirror from the remote (the
  request `desolate fetch` makes; the root fetches with its read key), then read from the
  read-only mirror. If the root cannot (offline, or the domain's 30 requests a minute are
  used up), the fetch still happens, from the mirror as it is, and says so.
- `git push origin <branch>` offers the branch (`desolate offer`), then reports the push as
  refused, saying it was offered and that nothing went to the remote, so that no
  `origin/<branch>` appears for a branch the remote does not have.
- Commits carry the person's git identity from the Mac (`git config --global user.name` and
  `user.email`, read when the workspace is made), in the VM and in its devcontainer, unless the
  container's user has one of its own. Without one on the Mac, the workspace's own name.

**The editor's settings, layer by layer** (lowest first; each overrides the ones before it):
- **VSCodium's own defaults.** In the browser its default theme is a light one, and it saves
  as you type.
- **Your defaults, for every workspace** (`desolate editor defaults ...`, or the
  editor-defaults page, linked from the dashboard's header). They're kept on the Mac
  (`~/.desolate/state/editor-defaults.json`; until you set any, `files.autoSave: off`) and
  installed in each editor as a small extension that contributes them as defaults
  (`configurationDefaults`). Its start installs them, and so does every change, in every
  running workspace. The page is the Mac's own, like the secrets page, not the dashboard's:
  a default reaches every domain's editor, and the dashboard is served by the root's
  ordinary user, which reads what domains send.
- **What you set in the editor** (its Settings, User). This editor keeps those in the
  browser.
- **The project's devcontainer**, `customizations.vscode.settings`: the editor's Machine
  settings, as VS Code's Dev Containers does. A key the spec drops is taken out again,
  unless you changed it since.
- **desolate's own few**, in the same Machine settings, over the project's: no
  workspace-trust prompts, no self-updates, no telemetry, and the terminal into the
  devcontainer.
- **The repository's `.vscode/settings.json`**, as in any VS Code, for the settings a
  workspace may set. (desolate's own few are not among those.)

(Measured on the M1, 2026-11-18. User settings written to the server are not read, so a
file there cannot be the defaults' layer, and Machine settings override what you set in the
editor, so they cannot be either.)

**A workspace's size, from its project.** desolate reads one thing in a `devcontainer.json`
itself: the size its VM is made with. `customizations.desolate` (`cpus`, `memory`, `disk`:
`"16g"`, or a bare number of GiB) for each part it sets, then the spec's `hostRequirements`
(`cpus`, `memory`, `storage`). The root reads it in the mirror, from the environment
repository's default branch as the remote published it, never from a domain's clone (P4).
It comes after `up`'s flags and the domain's size, and before the Mac's defaults. A
repository's word, it is checked as a size, and kept to this Mac's cores and to three
quarters of its memory; `up` says what it lowered or did not use. It sizes the domain's
environment build too. A workspace made before its project asked is not changed: `desolate
resize` (stopped), or Resize... on the dashboard, which shows what the project asks for.

**Devcontainers.** A workspace runs its project's own `devcontainer.json`, unchanged, with
the devcontainer CLI and a docker daemon inside the workspace's VM. Nothing in a spec is
refused: the VM is the boundary. A spec that does not come up leaves the workspace as the
VM itself, and `up` says why. A compose spec runs as written; its primary service (`service`)
is where `desolate exec`, the editor and desolate's mounts are, on the VM's paths, and what
listens in it, and each `forwardPorts` entry written `service:port`, is forwarded at the
workspace's hostname like a single container's. For Docker inside the devcontainer, prefer
the `docker-outside-of-docker` feature: the VM is the boundary, so sharing its daemon costs
nothing, and it shares the VM's images. `docker-in-docker` works in a compose service
(privileged, with a store of its own); avoid it in a single-container spec, where it shares
the VM's network and its `docker0` with the VM's own daemon, and both hand out the same
addresses.

**Secrets.** A workspace never holds a secret's value. It holds the name
(`export OPENAI_API_KEY=MYAPP-OPENAI-KEY`), and the root puts the value in its place on the
way out, only over TLS, only toward the hosts the secret names, only in the headers it names.
Connections to those hosts are the only ones whose TLS the root terminates (the workspace
trusts its domain's CA for that); everything else stays end to end.

Set one with `desolate domain <d> secret set <NAME> --hosts ...` (the value on stdin), or on
the **secrets page**: "Add a secret..." on a domain's card opens it. It is the Mac's own page,
on the approval page's origin and cookie (open `desolate approve --web --open` once), not the
dashboard's: the dashboard is served by the root's ordinary user, which never sees a value.
There you add a secret, replace its value, switch it off or on, or remove it; a value is sent
there once and never to a page again. To see a value, in a terminal on the Mac:
`desolate domain <d> secret show <NAME>` (only the value goes to stdout). It is read by the
host's own way into the root VM, as root, as a set is: nothing in a VM, and not the dashboard,
can ask for it.

![The secrets page: a domain's secrets by name and host, and the form to add one](assets/secrets.png)

**A project's `.env`, imported.** `desolate domain <d> secret import <.env>` (or **Import a
.env** on the secrets page: paste it or choose the file) makes its API keys the domain's
secrets, and gives back the same `.env` with each secret's name in place of its value, for
the workspace: `--print-env` writes it to stdout (everything else goes to stderr, so it can
be piped), `--in-place` rewrites the file. (Not `--print-env > .env` on the same file: the
shell empties it before desolate reads it.) `--dry-run` shows the plan and sets nothing. Each
entry is judged on the Mac, and no value is printed or sent to a page:
- **What becomes a secret:** what is sent to a host, so the proxy can put the value in place
  of the name: an API key (`sk-ant-`, `xoxb-`, `llx-` and other values say whose they are;
  a table knows keys by name), or an OAuth client secret, which goes to the host of the
  `*_TOKEN_URL` beside it in the file, or to a known provider's token endpoint.
- **What stays a value:** what the app uses itself, so it needs the real value: a key it
  signs with (`JWT_SECRET_KEY`, Zoom's SDK secret), AWS's secret access key (each request
  is signed with it, and it is never sent), a database password. These stay readable in
  the workspace, and the plan says so: a dev-only value is the way to keep a real one out.
  And what a browser on your Mac uses (`NEXT_PUBLIC_*`, a publishable key), which never
  passes the proxy.
- **What it cannot tell** is asked about on a terminal, or marked on the page, and left a
  value until you name its hosts: `--choose KEY=secret:<host>[,<host>][@<header>]`, or
  `--choose KEY=value`. What you choose is remembered for the domain, on the Mac (keys and
  hosts, never a value), so the next import asks nothing.
- **An OAuth client secret** is put in place only where the app posts it in the request body
  (`client_secret_post`): in HTTP Basic auth it is base64-encoded, and the proxy cannot find
  its name. A value the proxy puts in a body or a URL goes in as it is, unencoded: the plan
  warns about one with `+ / = &` or a space.

If the `.env` was in a workspace's checkout (`~/.desolate/domains/...`), its values have
been readable in that domain's workspaces: the import says so. Rotate the keys that became
secrets.

## On a Mac: if macOS asks about `limactl` and incoming connections

With the macOS firewall on, you may see this dialog (the wording on macOS 14.5, from the
Application Firewall's own strings):

> **Do you want the application “limactl” to accept incoming network connections?**
>
> Clicking Deny may limit the application’s behavior. This setting can be changed in the
> Firewall pane of Network Settings.
>
> [ Deny ] [ Allow ]

**Click Deny.** desolate never needs another machine to connect to it:

- Everything desolate listens on is your Mac's loopback (`127.0.0.1` and `::1`): the dashboard, the
  editors, dev servers, each workspace's link. The macOS firewall does not apply to loopback,
  so Deny changes nothing for desolate.
- desolate's VMs forward nothing onto your Mac by themselves: every desolate VM refuses
  Lima's own port forwarding, on every address, TCP and UDP, and `desolate doctor` checks
  it ("VMs forward nothing by themselves").
- What raises this dialog is a `limactl` binding a port on *all* interfaces, which
  desolate's VMs were shown not to do (on the M1, every kind of listener in a workspace
  was tried). Another Lima instance does: Colima, which the tests use for Docker,
  forwards a container port published without an address (`docker run -p 8080:80`) to
  every interface of the Mac, and that is the likely source of the dialog seen on the M1
  (which process it was could not be read back without an administrator). Allowing it
  would let other machines on your network reach that container; if you need a published
  port, publish it on loopback (`-p 127.0.0.1:8080:80`).

`limactl` is one binary for every Lima instance, so the answer covers all of them, and macOS
asks again after Homebrew updates Lima (the path changes). To change it later: **System
Settings → Network → Firewall → Options…**, find `limactl` and set it to "Block incoming
connections" (or remove it). From a terminal, as an administrator:

```bash
/usr/libexec/ApplicationFirewall/socketfilterfw --listapps        # what is allowed
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --blockapp "$(realpath "$(command -v limactl)")"
```

## Workspaces that start workspaces

A workspace can start another in its own domain, with a command as its agent, and close the
ones it started. It is on, with no limit, unless the person sets one on the Mac:
`desolate domain <d> spawn --max <n>` (0: off; `none`: no limit again). [agents.md](agents.md#workspaces-that-start-workspaces) has the
person's side; the shipped [AGENTS.md](../AGENTS.md), the agent's.

```
inside w1:  desolate spawn --name helper --branch task/helper -- <command...>
              signed with w1's key -> the domain's outbox
root:       rootd checks what it can (the limit, the names) and queues it; the state service
            hands it to the host as an action
host:       the daemon checks the signature against w1's key, its age, that it was not
            run before, and the limit it holds itself; then runs
              desolate up <d> --name helper --started-by w1 --branch task/helper -- <command...>
```

- **The key.** Each workspace VM has one, made by the host (`~/.desolate/state/workspace-keys`)
  and written onto that VM's own disk at every start (`/run/desolate/identity`, which its
  devcontainer binds). The root does not have it, and no other workspace does.
- **Why the host checks, not the root.** The root's ordinary user parses what every domain
  sends. If the host ran what it queued, a flaw there found by one domain would be a way to
  run commands in another domain's workspaces. It cannot sign: a request it makes is
  refused (T2 `16-spawn` tries it, beside a signed one that is run). And the host checks that
  every answer of the root's about a workspace (its plan, its record) names that workspace's
  own VM name, which the host computes itself; and it never takes over, or destroys, a VM
  that already exists under a new workspace's name. What this does not claim: that user is
  trusted with much else (it writes every domain's checkouts, and passes on the dashboard's
  clicks, starting and stopping workspaces among them). The audit of 2026-11-16 is in
  `docs/v3/decisions.md`.
- **The command** is an argument list all the way: JSON in the request, an argv element
  after `--` on the host, passed to `limactl shell` (which quotes each argument for the VM),
  then to the agent holder in the VM. No shell on the Mac reads it.
- **What the host holds itself:** the limit (`~/.desolate/state/spawn.json`; the root has a
  copy, to answer early and show it), and which workspace started which, as it ran them.
  `close` is run only for a workspace the host recorded as started by the one asking, and
  only after the workspace itself reports nothing uncommitted, untracked or stashed in any
  checkout (git runs there, never on the Mac). A request is good for 15 minutes, once.
- **What a workspace reads:** `/desolate/inbox/domain.json` (`desolate domain stats`) and
  `/desolate/inbox/events.jsonl` (`desolate events`), written by the root: its own domain's
  workspaces, who started each, the limit, this Mac's CPUs and memory and what its running
  workspaces take of it; and its events, among them how each request ended (`request`, `ok`,
  and why not). Nothing of another domain, and no editor address (those carry a token).
- **Outliving.** A workspace whose starter has been removed is flagged (`desolate list`,
  the dashboard's "Needs you"). It is not removed for it.

## Issues a workspace offers

```
inside a workspace:  desolate issue offer --title ... --body-file ... --label ...
root:                rootd checks every field (shared/issues.ts) and keeps it as offered
dashboard:           you edit it; Publish freezes it ("approving")
Mac:                 the approval page, or `desolate issue publish <id>`, shows it; you confirm;
                       gh issue create --repo <r> --title=<t> --body-file <f> --label=<l>...
```

- **Checked before kept:** a title of at most 256 characters and a body of at most 64 KiB,
  with no control, bidirectional or invisible characters (newlines and tabs in the body
  are fine); at most 20 labels, each at most 50 characters with no comma (gh would read
  it as two). At most 50 waiting per domain.
- **Why the Mac approves it:** publishing acts as you on GitHub. The root's ordinary user,
  which parses every domain's data, keeps the drafts and could change one; so the host shows
  you the text and creates the issue from that text alone. The approval page's token is over
  the issue's id and every word: a draft that changed after the page showed it is refused
  (T1 `approve-web`).
- **On the Mac:** `gh` is run with each field one argument, `--title=` and `--label=` in
  their joined form (so a value that starts with a dash is still a value), and the body in
  a file under `~/.desolate/state`, removed after. `DESOLATE_GH` names another `gh`. The page
  it answers with is kept only if it is `https://github.com/<repo>/issues/<n>`.
- **The preview** (`shared/ui/markdown.js`): headings, emphasis, code, lists and task
  lists, tables, quotes, rules and links, built as elements with text nodes. HTML in the
  Markdown is shown as text. A link keeps its address only if it is http, https or mailto, and
  opens with no opener and no referrer. An image is drawn as a link to itself, never loaded.
  Its work is bounded: 64 KiB of unclosed emphasis is parsed in milliseconds (T1 `issues`).

## What works today, and what does not

"T1" is static and unit: the type check, node's tests, and the in-source tests beside the
code. "T2" is the fake backend: containers standing in for VMs, **not isolated**, good for
everything but the hypervisor boundary. "T3" is real VMs on Linux (QEMU through Lima); it
last ran in the first pass's cloud sandbox.
"Mac" means Lima with Virtualization.framework, the product backend.

| | Implemented | Tested | Not yet |
|---|---|---|---|
| bootstrap, doctor, destroy | yes | T2, T3 | installing the host's own tools (it checks for them and says what to install) |
| Root VM: keyring, read and write keys, mirrors with LFS, root clones | yes | T2, T3; `clone --keys-by-hand` against github.com | |
| P2: pushes only by a person (`--expect`, exit codes, LFS first, audit) | yes | T2 | |
| P2: the approval is given on the host, outside every VM (a signed challenge; `desolate approve` for a raw `git push origin`) | yes | T2, with the `terminal` approver, which is the default | the opt-in Touch ID approver (`host/approver/touchid.swift`) has never been compiled or run |
| P3: keys never leave the keyring; a secret's value never leaves the root | yes | T2 | |
| P4: the root never runs git in a domain's clone | yes | T2 (a booby-trapped clone, a lying outbox) | |
| What the root takes from a domain is checked data: bundles strictly checked in quarantine, a held and checked outbox directory, verified LFS, git settings that ignore what a tree asks for | yes | T1, T2 (`10-hostile-content`: dangerous objects, a planted repository, links in the outbox, hostile names; each beside a control), T3 (an offer, a dangerous tree and a linked outbox over a real VM's share) | a size quota for a domain's outbox; on the Mac, status files are checked by a second look, not by the kernel |
| Domains, workspaces, checkouts, worktrees, locks, `--base`, `--fetch`, `--branch`; a domain's environment built once (templates) and its package caches | yes | T2, T3, T4 | |
| Offers, the root's view (`git fetch --all`), deliveries between domains | yes | T2 | |
| `desolate upstream`: a consumer's change to a vendored suede dependency, split by suede's own upstream (pinned) in the git VM, pushed as `downstream/...` after your approval ([suede.md](suede.md)) | yes | T1, T2; against github.com | LFS files in the dependency |
| Ports: same number, routed by name, reservations; a port a program on the Mac holds reported as not forwarded; a bare `localhost` sent to the workspace serving the port; none forwarded under the editor's name | yes | T2 (`03`, `06`); on the M1 by hand (a dev server in a vz workspace, opened by its name) | in a test suite on real VMs |
| P5: read-only shares against root in the VM | yes | **T3** (and measured on an M1 for the Mac) | |
| P5: forced egress against root in the VM | yes | **T3**; Mac: measured for TCP, UDP, DNS and ICMP (Lima 2.3.0 or newer required) | |
| Egress through each workspace's own proxy, per-domain rules, audit by link | yes | T2, T3 | |
| Secrets: per domain, substituted for the hosts and headers they name, proven by the upstream's certificate, scrubbed from responses, switched off and on (`--ttl`) | yes | T2, T3 | v2's self-test fixture; "learn" as a timed mode |
| **P1: the editor**: VSCodium's server in every workspace VM (in the project's devcontainer when it can), its own hostname, v2's gate | yes | T2 (HTTP, WebSocket, a real browser), T3 | v2's workspace extension's panel ([`release/vscode-image/extension`](https://github.com/pmalacho-mit/desolate/tree/4f32c77/release/vscode-image/extension) at `4f32c77`) is not ported; a bare `localhost` link reaches the workspace through the forwarder |
| The project's devcontainer, from its own `devcontainer.json` (features included), inside the workspace VM; `exec` and the editor enter it | yes | T2 (an image, a Dockerfile, a failing spec, no spec, a changed spec, a compose spec and its ports); on the M1, a public image with a feature, compose with Docker outside and inside | a compose service that is not glibc gets no port relay and no editor |
| The root UI: a state service in the root that pushes changes, a dashboard at `desolate.localhost` with the diff of an offer as text, unified or side by side; no editor in the root | yes | T2 (the spec's three budgets, a real browser), T3 (the state reaches the dashboard) | the side-by-side diff in Playwright's Chromium 131 inside a workspace (it renders in Chrome on the Mac) |
| The Mac backend (`vz`) | yes | **T4 on an M1** (15 of 15, 2026-11-16): read-only shares and forced egress against root in the VM (TCP, UDP, DNS, ICMP), no path between domains, an offer over a real share, the editor, a secret | |
| Pushes by the pusher alone (it speaks receive-pack; compare-and-swap from the commit you saw) | yes | T1, T2; against github.com | |
| One-click approval in the browser, beside the git terminal | yes | T1, T2, and in Chrome | Firefox and Safari cannot say whether Approve is covered (Chrome can) |
| The git VM: your git in a browser tab, no network or keys; a remote per domain; LFS | yes | T2 | |
| `desolate events` and `desolate notify` | yes | T1, T2 | |
| Upgrades: `git pull` then `bootstrap` (root and base re-provisioned in place when the image changed); `destroy` keeps the root's keys, secrets and rules for the next `bootstrap` | yes | T1, T2 (`13-rebuild`); by hand on the M1 | |
| Developing desolate in a desolate workspace: T1 and T2 there, an inner stack whose pages open on the Mac | yes | on the M1 ([developing-desolate.md](developing-desolate.md)) | T3 inside a workspace |
| Git in a workspace: `git fetch` refreshes the mirror first, `git push` offers, commits as the person | yes | T2; by hand on the M1 (a commit made on GitHub fetched; a push offered) | the editor's Source Control and Sync clicked through (they run the same git) |
| Recipes (`recipes/`): an agent on a task, Claude Code, issues, suede | yes | T2 (`12-agent`: `agent.sh`); on the M1, `agent.sh` to an offer, `claude.sh` with a stand-in token, and `issues.sh` and `suede.sh` with the stand-in agent | `issues.sh` and `suede.sh` not run on real work |
| Workspaces that start workspaces in their own domain (`desolate spawn`, `close`, `domain stats`, `events` inside one): signed by the workspace, checked by the host | yes | T1; T2 (`16-spawn`: the limit, the labels, stats and events, a forged request refused beside a signed one run, close refused with uncommitted work) | on real VMs (vz) |
| Issues offered by a workspace (`desolate issue offer`): edited on the dashboard with a Markdown preview, published by the host's `gh` after you approve the exact text on the Mac | yes | T1 (fields, the preview, the approval page's token); T2 (`17-issues`: every field to a stand-in gh byte for byte, not without confirming) | against github.com |
| After a push: the pull request's page on GitHub; "merged into <base>" once the mirror shows it | yes | T1 (the link; a merge, a squash, a rebase), T2 (a squash on the stand-in forge) | the link has not been opened on github.com; the 15-minute fetch not watched in real use |

## Layout

```
cli.sh             the launcher: finds node >= 22.18, runs host/cli.ts
pins.env           every tool desolate downloads, by version and sha256
host/              runs on the host: the CLI, the daemon (forwarder, links), the VM layer
  vm/              one interface, three backends: fake, qemu, vz
  approver.ts      the key that approves pushes (approver/touchid.swift: opt-in, the Mac's Secure Enclave)
root/              runs in the root VM: keyring, mirrors, clones, offers, push, proxies
  proxy/           each workspace's proxy; each domain's secrets and its secrets proxy
  stated.ts, ui/   the state service and the dashboard it serves
  outbox.ts        the only code that touches what a domain wrote: how, and why, is at its top
workspace/         runs in each workspace VM: its init, its daemon, its network, its
                   devcontainer (devcontainer.ts, enter.sh, entry), its editor, and git's helpers
                   there (git-remote-desolate-mirror, -offer)
git/               runs in the git VM: your git in a browser tab, and suede's upstream (pinned)
recipes/           scripts of ordinary desolate commands, for tasks you do often (README.md)
completion.bash    tab completion, zsh and bash: echo 'source <(desolate completion)' >> ~/.zshrc
shared/            names, exit codes, the name sniffer: used on more than one side
image/             what a VM image contains (provision.sh) and how it is built
.harness/          the in-source tests' harness, imported by type only: nothing of it runs (README.md)
docs/              getting started, the reference, agents, suede, developing desolate, dogfooding;
                   incidents.md: ways desolate has been wrong, and what each taught
```

The code runs straight from this tree: every VM mounts it read-only at `/desolate/release`.
What desolate keeps on the Mac, in `~/.desolate`, and which VM sees each folder of it, is in
[home.md](home.md).
