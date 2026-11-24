#!/usr/bin/env bash
# Recipe: after a push to a project's default branch, ask an agent whether its changes to a
# vendored suede dependency belong upstream, in the dependency itself.
#
#   release/recipes/suede.sh <owner/repo>@<commit> [--from <commit>] [--domain suede] [-- <command...>]
#
# For each vendored suede dependency the commit changed (a directory with a .gitrepo, the
# record suede keeps), a workspace with both repositories: the dependency on
# `upstream/<project>-<commit>`, the project on `suede/<commit>`. In it, Claude (claude.sh),
# or the command after `--` (agent.sh), decides; if the change belongs upstream it prepares
# it there and offers the branch, which you review and push like any other.
#
# For every push as it happens, feed it `desolate events`:
#   desolate events | jq --unbuffered -r 'select(.source == "pusher" and .type == "pushed") | "\(.repo)@\(.commit) \(.branch) \(.onto // "")"' |
#     while read -r pushed branch onto; do release/recipes/suede.sh "$pushed" --branch "$branch" ${onto:+--from "$onto"}; done
#
# What changed is the root's to say, from its own clone, without an agent
# (`desolate suede changed`). To propose a change to a dependency by hand, without an agent at
# all: `desolate upstream` (release/docs/suede.md).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
desolate() { "$here/../cli.sh" "$@"; }   # the same as typing `desolate`, from this checkout
# Text from a repository, GitHub or a VM, printed: shared/text.ts's UNSAFE replaced (T1 compares).
say() { printf '%s\n' "$*" | jq -Rr 'gsub("[\\p{Cc}\\p{Cf}\\p{Co}\\p{Cn}\\p{Cs}\\p{Zl}\\p{Zp}\\x{034f}\\x{115f}\\x{1160}\\x{17b4}\\x{17b5}\\x{180b}-\\x{180f}\\x{2800}\\x{3164}\\x{fe00}-\\x{fe0d}\\x{ffa0}\\x{e0100}-\\x{e01ef}]|(?<!\\p{Extended_Pictographic})[\\x{fe0e}\\x{fe0f}]"; "?")'; }
usage() { echo "usage: $0 <owner/repo>@<commit> [--from <commit>] [--branch <pushed to>] [--domain <d>] [-- <command...>]" >&2; exit 64; }
[ $# -ge 1 ] || usage
project=${1%@*} commit=${1#*@}
shift
from='' domain=suede pushed_to=''
while [ $# -gt 0 ] && [ "$1" != -- ]; do
  case $1 in
    --from) from=$2; shift 2 ;;
    --domain) domain=$2; shift 2 ;;
    --branch) pushed_to=$2; shift 2 ;;   # (from `desolate events`: a push to another branch asks nothing)
    *) usage ;;
  esac
done
[ "${1:-}" = -- ] && shift
[[ $commit =~ ^[0-9a-f]{40}$ ]] || usage
[ -z "$from" ] || [[ $from =~ ^[0-9a-f]{40}$ ]] || usage
[[ $project =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || usage

# Only a push to the project's default branch asks the question.
if [ -n "$pushed_to" ]; then
  default=$(desolate repos --json | jq -r --arg r "$project" '.[] | select(.repo == $r) | .defaultBranch // ""')
  [ "$pushed_to" = "$default" ] || exit 0
fi

# 1. What the push changed, dependency by dependency (the root reads its own clone).
# A dependency's own nested subrepos (suede's machinery: <dep>/.suede/core, <dep>/.github/workflows)
# ship inside it, as part of it: a change there is the dependency's, not a dependency of its own.
changed=$(desolate suede changed "$project" "$commit" ${from:+--from "$from"} --json | jq -c '[.[] | select(.files | length > 0)] | . as $all | .[] | select(.dir as $d | $all | map(.dir) | any(. as $o | $o != $d and ($d | startswith($o + "/"))) | not)')
[ -n "$changed" ] || { say "$project ${commit:0:12}: no vendored suede dependency changed"; exit 0; }

# The domain must already hold both repositories: which repositories share a domain is yours
# to decide, never a .gitrepo's (a pushed commit's text could name any repository desolate
# holds, another domain's private one among them).
holds=$(desolate list "$domain" --json | jq -r '.[].repos[]')
desolate fetch "$project" >/dev/null   # the pushed commit is on the remote: the mirror catches up

while IFS= read -r dep; do
  dir=$(jq -r .dir <<<"$dep") remote=$(jq -r '.remote // ""' <<<"$dep") branch=$(jq -r .branch <<<"$dep") files=$(jq '.files | length' <<<"$dep")
  if [ -z "$remote" ] || ! grep -qxF "$remote" <<<"$holds" || ! grep -qxF "$project" <<<"$holds"; then
    say "$project: $dir/ changed ($remote), but the domain $domain does not hold both: desolate domain $domain add --repo $project --repo ${remote:-<owner/repo>}"
    continue
  fi
  short=${commit:0:8}
  name=$(printf 'up-%s-%s' "$(basename "$remote" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | cut -c1-20)" "$short" | tr -s '-')
  upstream=upstream/$(basename "$project")-$short

  # 2. The question, for the agent: what changed, where, and how a suede dependency is laid out.
  task="The project $project has just pushed ${commit:0:12} to its default branch${from:+, from ${from:0:12}}.
It changed the suede dependency vendored at $dir/ ($files file(s)), which is $remote's $branch branch.

Decide whether this change belongs upstream, in the dependency itself, or is the project's own (a local workaround, configuration only the project wants).
You are in the dependency's checkout, on the branch $upstream; the project's clone is /workspaces/$project. First read /desolate/release/AGENTS.md.
The change: git -C /workspaces/$project diff ${from:-$commit~1} $commit -- $dir
A suede dependency's $branch branch is its main branch's release/ directory: the same change, upstream, goes under release/ on main.

If it belongs upstream: make it on your branch in the dependency's checkout (adapting it if the vendored copy is behind), run the dependency's own tests, commit with a message that says why, \`desolate offer\`, then \`desolate status set green \"upstream: <one line>\"\`.
If it does not: change nothing and \`desolate status set gray \"stays in the project: <why>\"\`.
If you cannot tell: \`desolate status set orange \"<the question>\"\`."

  # 3. A workspace with both, and the agent in the dependency's checkout. (agent.sh and
  #    claude.sh check out every repository on one branch; here each gets its own, so `up`
  #    is called directly, then the agent recipe is given the workspace by name.)
  desolate up "$domain" --name "$name" --fetch --checkout "$remote=worktree:$upstream" --checkout "$project=worktree:suede/$short"
  say "$project: $dir/ changed: $domain/$name, an agent deciding whether it goes to $remote"
  if [ $# -gt 0 ]; then
    desolate agent start "$domain/$name" --name agent --checkout "$remote" -- "$@" "$task"
  else
    "$here/claude.sh" "$domain" "$task" --name "$name" --checkout "$remote" --existing
  fi
done <<<"$changed"
