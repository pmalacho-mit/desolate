#!/usr/bin/env bash
# Recipe: a workspace for one task, and a program kept running on it.
#
#   release/recipes/agent.sh <domain> "<what to do>" [--name <w>] [--branch <b>] [--checkout <owner/repo>] -- <command...>
#
# The command is any program that works on its own: a coding agent, a long test run, a
# script. It gets the task as its last argument. For example, the stand-in agent that comes
# with desolate (it writes the task down, commits it and offers the branch):
#
#   release/recipes/agent.sh acme "Add a shout() greeting" -- bash /desolate/release/recipes/echo-agent.sh
#
# A recipe is ordinary desolate commands, in order, with why. Read it, run it, copy it and
# change it: nothing in desolate depends on it, and it adds no protection of its own (the
# workspace is the protection, whatever runs in it).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
desolate() { "$here/../cli.sh" "$@"; }   # the same as typing `desolate`, from this checkout
usage() { echo "usage: $0 <domain> \"<what to do>\" [--name <w>] [--branch <b>] [--checkout <owner/repo>] -- <command...>" >&2; exit 64; }

[ $# -ge 2 ] || usage
domain=$1 task=$2
shift 2
name='' branch='' checkout=()
while [ $# -gt 0 ] && [ "$1" != -- ]; do
  case $1 in
    --name) name=$2; shift 2 ;;
    --branch) branch=$2; shift 2 ;;
    --checkout) checkout=(--checkout "$2"); shift 2 ;;
    *) usage ;;
  esac
done
[ "${1:-}" = -- ] && shift
[ $# -gt 0 ] || usage

# 1. A name for the workspace: the task's first words (`add-a-shout-greeting`), with a
#    number after them if the domain already has a workspace of that name (name.sh).
[ -n "$name" ] || name=$("$here/name.sh" "$domain" "$task")
branch=${branch:-task/$name}

# 2. The workspace: a VM with the repository checked out on the branch (with --checkout: that
#    one, whose devcontainer is then the environment; else every repository of the domain),
#    the project's devcontainer and an editor. The same as for working in it yourself.
if [ ${#checkout[@]} -gt 0 ]; then
  desolate up "$domain" --name "$name" --checkout "${checkout[1]}=worktree:$branch"
else
  desolate up "$domain" --name "$name" --branch "$branch"
fi

# 3. The program, in the workspace's devcontainer, kept running whether or not anyone is
#    watching (`desolate agent`). It is told where it is and how to finish: the workspace's
#    AGENTS.md says what it can and cannot do there (no keys; it offers, a person pushes).
orders="Your branch, $branch, is checked out here. First read /desolate/release/AGENTS.md: this is a desolate workspace.
Work until it is done and seen to work. Commit as you go. When it is ready: \`desolate offer\`, then \`desolate status set green \"ready: <one line>\"\`.
If you need a person (a decision, access, a secret): \`desolate status set orange \"<the question>\"\`, and wait."
desolate agent start "$domain/$name" --name agent ${checkout[@]+"${checkout[@]}"} -- "$@" "$task

$orders"

echo "$domain/$name: working on it, on $branch."
echo "  watch it:   desolate agent attach $domain/$name     (Ctrl-] lets go; it keeps running)"
echo "  or open it: desolate editor $domain/$name --open"
echo "  its work:   desolate ui --open     (its branch is there as it commits; it offers it when done)"
