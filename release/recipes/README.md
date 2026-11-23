# Recipes

Scripts of ordinary desolate commands, in order, each step saying why. They show how to put
desolate's pieces together for something you do often. Read one before you run it, then copy
it and change it: nothing in desolate depends on these, and they add no protection of their
own. The workspace is the protection, whatever runs in it.

| Recipe | What it does |
|---|---|
| [`agent.sh`](agent.sh) | a workspace for one task, on its own branch, and any program kept running on it, given the task: a coding agent, a long test run, a script |
| [`claude.sh`](claude.sh) | the same, with Claude Code: the subscription token as a domain secret, Claude installed if the project has none, its first-run questions answered |
| [`issues.sh`](issues.sh) | GitHub issues with a label, each in a workspace of its own with an agent, in parallel; stopped when the issue is closed |
| [`suede.sh`](suede.sh) | after a push to a project's default branch, an agent asked whether its changes to a vendored suede dependency belong upstream |
| [`echo-agent.sh`](echo-agent.sh) | a stand-in agent, with no AI: it writes its task down, commits, and offers the branch. For trying the others |

Each runs on your Mac, and calls the `desolate` of the checkout it is in. They need `jq`
(`brew install jq`); `issues.sh` needs your own `gh`.

```bash
release/recipes/agent.sh you--app "Add a shout() greeting" -- bash /desolate/release/recipes/echo-agent.sh
release/recipes/claude.sh you--app "Greet the user by name, with a test"
```

**Another agent** is `claude.sh` with its own three steps (its credential, installing it, its
first run): copy the file, change those, and keep the rest. Its credential goes in the same
way, as a domain secret whose name the workspace holds and whose value the proxy puts in on
the way to the agent's API (`desolate domain <d> secret set NAME --hosts <api host>
--headers <header>`). That gives every workspace of the domain the use of the credential at
that API, as you, though never its value. Nothing in desolate is specific to any agent; the recipes are where
the specifics live.

What every recipe is built from:

| | |
|---|---|
| `desolate up <domain> --name <w> --branch <b>` | the workspace: a VM, its checkouts on the branch, the project's devcontainer, an editor |
| `desolate exec <domain>/<w> -- <command>` | a command in its devcontainer (installing a tool, writing a config file) |
| `desolate agent start <domain>/<w> --name <n> -- <command...>` | a program kept running there with its own terminal: `attach`, `log`, `stop` |
| `desolate domain <d> secret set\|copy` | a credential held in the root, never in the workspace |
| `desolate list\|offers\|events --json` | what there is, for a script to read |

What happens to the work is the same as for yours: it commits in the workspace, offers its
branch (`desolate offer`, or `git push` there), and you review and push it from the dashboard.
