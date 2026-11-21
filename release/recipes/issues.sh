#!/usr/bin/env bash
# Recipe: GitHub issues with a label, each worked on in a workspace of its own, in parallel.
#
#   release/recipes/issues.sh --repo <owner/repo> --domain <domain> [--label desolate:run] [--max 3] [-- <command...>]
#
# One pass, with your own `gh`, on this Mac:
#   - each open issue with the label that has no workspace yet gets one, `issue-<n>` on the
#     branch `issue/<n>`, with Claude on it (claude.sh), or the command after `--` (agent.sh),
#     until --max of them are open at once;
#   - each `issue-<n>` whose issue has been closed has its agent stopped. The workspace and
#     its branch stay, for you to look at: `desolate rm <domain>/issue-<n>` when you are done.
#     Closed is what GitHub says of that issue, asked by its number. An issue that is merely
#     not among the labelled open ones (its label was taken off) keeps its agent, and the pass
#     says so.
#
# Run it again to catch up, or leave it going:
#   while :; do release/recipes/issues.sh --repo acme/app --domain acme--app; sleep 60; done
#
# An issue's text becomes an agent's instructions. Label only issues whose text you would hand
# to an agent yourself: anyone who can edit the issue is writing to the agent. And every
# issue's workspace is in the one domain, which is one trust boundary: an agent misled by one
# issue can change the other issues' branches too. Your review before each push is the check
# (or give issues you trust less a domain of their own: --domain).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
desolate() { "$here/../cli.sh" "$@"; }   # the same as typing `desolate`, from this checkout
usage() { echo "usage: $0 --repo <owner/repo> --domain <domain> [--label <label>] [--max <n>] [-- <command...>]" >&2; exit 64; }
repo='' domain='' label=desolate:run max=3
while [ $# -gt 0 ] && [ "$1" != -- ]; do
  case $1 in
    --repo) repo=$2; shift 2 ;;
    --domain) domain=$2; shift 2 ;;
    --label) label=$2; shift 2 ;;
    --max) max=$2; shift 2 ;;
    *) usage ;;
  esac
done
[ "${1:-}" = -- ] && shift
[ -n "$repo" ] && [ -n "$domain" ] || usage
[[ $repo =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "--repo is <owner>/<repo>" >&2; exit 64; }
[[ $max =~ ^[0-9]+$ ]] || { echo "--max is a number" >&2; exit 64; }
number() { [[ $1 =~ ^[0-9]+$ ]]; }   # issue numbers, as GitHub and the workspaces' names give them

# What there is: every labelled open issue, and the domain's workspaces for issues.
# Every one: GitHub gives a list a page at a time (100 is the most it gives in one), and gh
# asks for each page until there are no more. A list that could not be read to its end is
# not acted on. (GitHub lists pull requests among a repository's issues: left out.)
open=$(gh api --paginate -X GET "repos/$repo/issues" -f labels="$label" -f state=open -F per_page=100 \
  --jq '.[] | select(has("pull_request") | not) | .number') \
  || { echo "the issues of $repo labelled $label could not be listed: nothing was done this pass" >&2; exit 1; }
have=$(desolate list "$domain" --json | jq -r '.[].workspaces[].workspace | select(startswith("issue-")) | ltrimstr("issue-")')
# Said, not silent: a pass that finds nothing printed nothing at all, which looked like a failure.
# (GitHub lists a just-labelled issue a few seconds later.)
[ -n "$open" ] || echo "no open issue of $repo is labelled $label (yet: GitHub lists a new one a few seconds later)"

# Closed since: stop the agent, keep the workspace. An issue that is not in the list above is
# not thereby closed: GitHub is asked about that one issue, and only when there is an agent to
# stop. (Before, the list was its first 100, and "not in it" was taken as closed: the agent of
# every older issue was stopped.)
for n in $have; do
  number "$n" || continue
  grep -qxF "$n" <<<"$open" && continue
  running=$(desolate agent list "$domain/issue-$n" --json 2>/dev/null | jq -r '.[] | select(.state == "running") | .name' || true)
  [ -n "$running" ] || continue
  state=$(gh issue view "$n" --repo "$repo" --json state --jq .state) \
    || { echo "#$n: GitHub did not say whether it is closed: its agent is left running" >&2; continue; }
  if [ "$state" != CLOSED ]; then
    echo "#$n is open, without the label $label: its agent is left running (to stop it: desolate agent stop $domain/issue-$n --name $(head -n 1 <<<"$running"))"
    continue
  fi
  echo "#$n is closed: stopping its agent (the workspace stays: desolate rm $domain/issue-$n)"
  for a in $running; do
    desolate agent stop "$domain/issue-$n" --name "$a" || true
  done
done

# New: a workspace and an agent for each, up to --max open at once.
working=$(grep -c . <<<"$(comm -12 <(sort <<<"$have") <(sort <<<"$open"))" || true)
for n in $open; do
  number "$n" || continue
  grep -qxF "$n" <<<"$have" && continue
  [ "$working" -lt "$max" ] || { echo "--max $max are working: #$n waits for the next pass"; continue; }
  # (Values go to jq as --arg, never into its program: a program can read the environment.)
  task=$(gh issue view "$n" --repo "$repo" --json title,body,url | jq -r --arg n "$n" --arg repo "$repo" '"GitHub issue #\($n) of \($repo): \(.title)\n\n\(.body)\n\n(\(.url))"')
  echo "#$n: starting $domain/issue-$n"
  if [ $# -gt 0 ]; then
    "$here/agent.sh" "$domain" "$task" --name "issue-$n" --branch "issue/$n" --checkout "$repo" -- "$@"
  else
    "$here/claude.sh" "$domain" "$task" --name "issue-$n" --branch "issue/$n" --checkout "$repo"
  fi
  working=$((working + 1))
done
