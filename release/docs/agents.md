# Programs that keep running, agents among them

## A program kept running: `desolate agent`

A dev server you want to outlive your terminal, a watcher, a long test run, or a coding
agent: desolate runs any of them in a workspace with a terminal of its own, which you attach to
when you want and leave when you are done. ("agent" is the command's name; nothing in it is
specific to AI.)

```bash
desolate agent start acme/w1 --name claude -- claude         # any command: it runs in the devcontainer
desolate agent start acme/w1 --name web -- npm run dev       # a dev server, kept running
desolate agent list                                               # the running ones, in every workspace
desolate agent attach acme/w1 --name claude                  # your terminal on it; Ctrl-] detaches
desolate agent log acme/w1 --name claude                     # what it printed: to a terminal, its last 100 lines
desolate agent stop acme/w1 --name claude                    # Ctrl-C, as you would; then asks before it kills
```

It runs inside its workspace (in the project's devcontainer, in the checkout you name
with `--checkout`, else the first), under a small holder that keeps its terminal
(`workspace/agent-holder.py`). It runs whether or not anyone is attached, and survives your
terminal closing.

**Its log keeps the newest.** Everything it prints goes to its log in the workspace VM, up to
a most: past it, the oldest output is dropped, and reading the log from the start says so
(`[desolate: 1.2 GiB of older output was dropped here: ...]`). The most is a twentieth of the
workspace's disk, unless you set `DESOLATE_AGENT_LOG_MIB` (the setting `agent.logMiB`, in
MiB) when you start it. The log stays after the program has ended, for as long as the
workspace does; starting the same name again carries on the same log.

```bash
desolate agent log acme/w1 --name web --all          # all that is kept, from the start
desolate agent log acme/w1 --name web --lines 500    # the last 500 lines
desolate agent log acme/w1 --name web --since 10m    # since 10 minutes ago (s, m, h, d; or a date and time)
desolate agent log acme/w1 --name web | grep error   # to a pipe or a file: all of it, as text
desolate agent log acme/w1 --name web --raw > web.log # its terminal's bytes, colour and cursor moves too
```

To a pipe or a file the log is text: colour, cursor moves and the other escapes a terminal
acts on are taken out, and its line ends are newlines. `--raw` keeps them, as the program
printed them. What is left out is said on stderr, never in the log's own lines, so a pipe
gets the log alone. Times are noted every 5 seconds of output, so `--since` may start up to 5 seconds
early.

**Lost: when its workspace stopped.** An agent runs in its workspace's VM and ends with it.
After a workspace is stopped and started again (the dashboard's Stop and Start, `desolate
stop` and `start`, the Mac restarting), the agents that were running are `lost`: nothing
starts them again on its own, since a command that was running yesterday may not be one to
run again unasked. Their logs are kept. `desolate agent list <domain>/<workspace>` says which
are lost and gives the command that starts each again (with `--checkout` too, if you started
it with one), and `desolate agent log` of a lost one says the same, on stderr. Started again
under the same name, it carries on the same log.

**Stopping.** `desolate agent stop` sends Ctrl-C twice through its terminal, as you would
(most programs, Claude Code among them, end on that). At a terminal it then says it is
waiting, and asks whether to kill it; it waits for as long as you do, and nothing kills it on
a clock. Answer no, and it is left to end on its own. From a script, `stop` asks it to stop
and says whether it has ended; `--kill` ends its whole process group at once and returns when
it has ended. (In a devcontainer that group is `docker exec`'s client, and the program in the
container may outlive it: Ctrl-C reaches the program through its terminal, a kill reaches
only the client. That has not been tested.)

**No tmux, on purpose.** tmux draws the screen itself, so scrolling and copying are tmux's:
its mouse mode gives you one and takes the other. `desolate agent attach` streams the
program's terminal straight to yours, after replaying the end of its log (its last 2 MiB,
more than a terminal keeps to scroll back; the rest is in `desolate agent log`), so your
terminal's own scrollback, selection and copy work as for anything else. Attaching to one
that has ended replays the same, and says it is not running. Ctrl-] lets go
(and puts back what the program changed of your terminal's modes); Ctrl-C goes to the program.
Many people can attach at once. What it prints reaches your terminal filtered: what
a full-screen program needs passes, and the escape sequences that act beyond the screen
(the clipboard, files, window operations, concealed text) do not.

**In parallel.** One workspace is one VM, and agents in different workspaces run truly side
by side (a workspace can hold more than one, by `--name`). A workspace from its domain's
template starts in about 20 s. `desolate agent list` shows each running agent and when it
last printed anything, and counts those that ended; `desolate agent list acme/w1` shows every
one of a workspace's, ended too (up to 100, then how many more: `--json` lists them all); the dashboard shows each workspace's status as the agent sets it
(`desolate status set ...` inside), and `desolate notify` turns orange and red into
notifications.

## Workspaces that start workspaces

An agent working on one thing often finds another: an issue to split off, a check to run
in parallel. A workspace can start another workspace **in its own domain only**, with a
command in it as its agent, and close the ones it started. It is on for every domain, with
no limit; the shipped AGENTS.md tells agents to do it only when the work needs it.

```bash
desolate domain acme spawn                # on the Mac: whether acme's workspaces may, and any limit
desolate domain acme spawn --max 2        # up to 2 started by its workspaces at once
desolate domain acme spawn --max 0        # none: turned off for acme
desolate domain acme spawn --max none     # no limit again (the default)
desolate domain acme stats                # its workspaces, who started each, the limit, this Mac
```

Inside a workspace, `desolate spawn --name <w> [--checkout <owner/repo>=worktree:<b>]... -- <command...>`, `desolate
close <w>`, `desolate domain stats` and `desolate events --follow` (the workspace's own
[AGENTS.md](../AGENTS.md) tells an agent how). What you see:

- **Who started each one.** `desolate list` and the dashboard say "started by you" or
  "started by <workspace>", and `desolate events` carries `startedBy`.
- **A workspace that outlived the one that started it** is flagged on the dashboard (under
  "Needs you") and in `desolate list`. Nothing is removed for it: look at its branches,
  then `desolate rm` it.
- **A limit, if you set one, is a number of workspaces at once.** Each counts until it is
  removed; it is memory on your Mac (`desolate domain <d> size`).
- **Closing:** a workspace closes only one it started, and only when nothing in it would be
  lost (no uncommitted, untracked or stashed work in any checkout). Its branches stay.
  Anything else is yours: `desolate rm`.

What keeps this to the domain: the request carries a signature made with a key that only
the asking workspace's VM and your Mac have. The root, which passes the request on and
parses every domain's data, cannot make one: if a domain's data ever took over the root's
ordinary user, it could not forge a workspace's request, and so could not have your Mac run
a command, as an agent, in a workspace of another domain. Your Mac also checks that what the
root says about a workspace names that workspace's own VM, so an answer of its cannot point
your Mac at another domain's. (That user is still trusted with much else: it writes every
domain's checkouts, and passes on what you click on the dashboard, including starting and
stopping workspaces. [`docs/v3/decisions.md`](https://github.com/pmalacho-mit/desolate/blob/main/docs/v3/decisions.md) has the
audit.) On your Mac, the command is an argument list from start to finish, never a line a
shell reads ([reference](reference.md#workspaces-that-start-workspaces)).

## Issues offered by a workspace

A workspace can offer a GitHub issue (`desolate issue offer --title ... --body-file ...
--label ...`, inside it): work it found that should be tracked where everyone sees it. It
never creates one. You:

1. **Read and edit it on the dashboard.** It is under "Needs you": title, labels and body,
   with a Preview of the body as GitHub's Markdown. Save, Reject, or Publish.
2. **Publish it on the Mac.** Publish freezes it and waits for you there, as a push does: on
   the approval page (`desolate approve --web`), or in a terminal,
   `desolate issues` then `desolate issue publish <id>`, which shows every word of it and asks
   you to type `publish`. Then **your own `gh`** creates it, as you.
3. The workspace hears how it ended (`desolate events`): published, with its page, or not.

What keeps it yours: the text you approve on the Mac is the text sent, each field one
argument of `gh` (the body in a file of the host's), never a line a shell reads. The approval
is over its exact words: if anything changed it after the page showed it, nothing is
published. The preview builds the Markdown as elements, never as HTML, and loads no image an
agent named. With a `desolate:run` label, `recipes/issues.sh` starts an agent on the issue
once it is published: the observable way to hand a workspace's idea to another agent.

## Recipes: a whole task in one script

desolate has no agent built in. The steps for handing a task to one (a workspace on its own
branch, the agent's credential and install, what to tell it) are in **recipes**: scripts of
ordinary desolate commands in [`recipes/`](../recipes/README.md), each step saying why. Run
one, or read it and do its steps yourself, or copy it for another agent.

```bash
recipes/agent.sh you--app "Add a shout() greeting" -- <command...>   # any program, given the task
recipes/claude.sh you--app "Fix the login redirect loop, with a test"   # Claude Code
```

(In a desolate checkout made for use, `recipes/` is beside `cli.sh`: `~/desolate/recipes/`.)
To try them with no AI at all, the stand-in agent writes its task down, commits and offers:
`-- bash /desolate/release/recipes/echo-agent.sh`.

What happens to an agent's work is what happens to yours: it commits in the workspace, offers
its branch, and you review it in the dashboard and push it. Nothing it does is pushed
without your approval, unless its domain holds a forge token as a secret (the
[reference](reference.md)'s Secrets).

- **Watch or talk to it:** `desolate agent attach <domain>/<workspace>` (Ctrl-] lets go; it
  keeps working). Your terminal's own scrollback and copy work.
- **Hear from it:** `desolate notify` tells you when it asks you something (orange), when it
  fails (red), and when it has offered its branch.
- **Several at once:** each task is its own VM; run as many as your Mac holds
  (`desolate bootstrap` says what one costs).
- **Done with it:** `desolate rm <domain>/<workspace>` (its branch stays).

## Claude Code, start to finish

Once, for the stack (a Pro, Max, Team or Enterprise subscription):

```bash
claude setup-token        # Claude Code on your Mac prints a long-lived token
desolate domain you--app secret set CLAUDE-OAUTH --hosts api.anthropic.com --headers authorization
                          # paste the token; it is held in the root VM, never in a workspace
```

Each task: `recipes/claude.sh you--app "<what to do>"`. What the recipe does, and why:

- **The token stays out of the workspace.** The agent's environment holds
  `CLAUDE_CODE_OAUTH_TOKEN=CLAUDE-OAUTH`, a name; the workspace's proxy writes the token into
  the `Authorization` header of requests to api.anthropic.com, and nowhere else. A workspace
  that leaks its environment leaks a name. A domain without the token gets a copy from one
  that has it, without asking, made inside the root (`desolate domain <d> secret copy`): the
  recipe gives that domain the use of your subscription. `secret rm` undoes it.
- **Installed once per domain.** When the project's devcontainer has no Claude Code, it goes
  into the domain's cache (`/desolate/cache/claude-code`), which every workspace of the domain
  mounts and a container rebuild keeps. To carry it in the image instead, add the devcontainer
  feature `ghcr.io/anthropics/devcontainer-features/claude-code:1`.
- **Its first-run questions are answered** (the theme picker, trusting the folder), so a
  Claude started with nobody attached gets to its task instead of waiting at the first prompt.
- **Auto mode** (`--permission-mode auto`): the workspace VM is the boundary, so nothing in it
  needs to ask: no keys, a proxied network, and pushes only through you.
- **What it is told:** where it is (`/desolate/release/AGENTS.md`), to commit as it goes, to
  `desolate offer` and go green when done, and to go orange and wait when it needs you.

With an API key instead of a subscription: a secret on the header `x-api-key`, and
`ANTHROPIC_API_KEY=<its name>` in the recipe instead.

**What has not been tried:** a real subscription token. The recipe has been run on the M1 with
a stand-in token: Claude installed into the domain's cache, its first run answered, started in
auto mode on its task, the token substituted on the way to api.anthropic.com, and Anthropic
answering that the token is invalid, as it should for a stand-in. If yours says `Please run
/login`, the token is wrong or expired: run `claude setup-token` again and `secret set` it again.

## Issues to agents: `recipes/issues.sh`

```bash
recipes/issues.sh --repo you/app --domain you--app --max 3            # one pass
while :; do recipes/issues.sh --repo you/app --domain you--app; sleep 60; done   # or kept going
```

On your Mac, with your `gh`: every open issue labelled `desolate:run` (`--label`) gets a
workspace `issue-<n>` on `issue/<n>`, with Claude (or `-- <command...>`) on it, the issue as
its task; at most `--max` at once (the rest are named, and wait for a later pass). Every
labelled issue is read, however many there are. When GitHub says an issue is closed, its
agent is stopped; its workspace and branch stay for you (`desolate rm` when you are done). An
issue whose label you took off, still open, keeps its agent, and each pass says how to stop
it. A pass that cannot read the list from GitHub does nothing, and says so. After you push its
branch, desolate gives you GitHub's page for opening the pull request. An issue's text
becomes an agent's instructions: label only issues whose text you would hand an agent
yourself. All of a run's workspaces share one domain, so an agent misled by one issue can
change the other issues' branches too: review each before you push it.

## Suede dependencies: `recipes/suede.sh`

```bash
recipes/suede.sh you/app@<commit>                 # one push, after the fact
desolate events | jq --unbuffered -r 'select(.source == "pusher" and .type == "pushed") | "\(.repo)@\(.commit) \(.branch) \(.onto // "")"' |
  while read -r pushed branch onto; do recipes/suede.sh "$pushed" --branch "$branch" ${onto:+--from "$onto"}; done   # every push
```

After a push to a project's default branch, the root works out which vendored suede
dependencies it changed (`desolate suede changed`: every directory with a `.gitrepo`, suede's
record of where a dependency came from, and the files under it the push touched). No agent
is involved in that. Which repositories share a domain is yours to decide, never a commit's:
set the domain up once, with each project and the dependencies you upstream to,

```bash
desolate domain create suede --repo you/app --repo you/some-dependency
```

and the recipe works only on dependencies the domain already holds (it says what to run for
any other: a `.gitrepo` in a pushed commit could name any repository desolate holds). For each
changed one, a workspace with the dependency on `upstream/<project>-<commit>` and the project
beside it, and an agent whose task names the directory, the commits and the dependency's
layout. It decides: if the change belongs upstream it makes it, runs the dependency's tests
and offers it; if not, it goes gray and says why. The push upstream is yours.

When you already know a change to a dependency should go upstream, no agent is needed:
`desolate upstream` splits it out with suede's own upstream and proposes it as suede's
`downstream/...` branch. [suede.md](suede.md) has both, side by side.
