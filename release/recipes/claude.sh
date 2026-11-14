#!/usr/bin/env bash
# Recipe: Claude Code on a task, in a workspace of its own.
#
#   release/recipes/claude.sh <domain> "<what to do>" [--name <w>] [--branch <b>] [--checkout <owner/repo>]
#   release/recipes/claude.sh <domain> "<what to do>" --name <w> --existing [--checkout <owner/repo>]
#       (in a workspace you have already made: Claude only)
#
# Once, before: a subscription token (Pro, Max, Team or Enterprise), kept in the root VM as a
# domain secret. A workspace only ever holds its NAME; its proxy puts the value in on the way
# to api.anthropic.com.
#
#   claude setup-token                    # on the Mac: prints the token
#   desolate domain <domain> secret set CLAUDE-OAUTH --hosts api.anthropic.com --headers authorization
#
# This is agent.sh with three steps before the agent starts: the token, Claude itself, and
# Claude's first-run questions. Another agent is the same recipe with its own three: copy
# this file and change them.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
desolate() { "$here/../cli.sh" "$@"; }   # the same as typing `desolate`, from this checkout
usage() { echo "usage: $0 <domain> \"<what to do>\" [--name <w>] [--branch <b> | --existing] [--checkout <owner/repo>]" >&2; exit 64; }
[ $# -ge 2 ] || usage
domain=$1 task=$2
shift 2
SECRET=CLAUDE-OAUTH

# 1. The token. The domain holds it, or it is copied from a domain that does. The copy
#    happens inside the root VM: the value comes nowhere near this Mac's terminal.
holds() { desolate domain "$1" secret list --json | jq -e --arg s "$SECRET" 'any(.[]; .name == $s)' >/dev/null; }
if ! holds "$domain"; then
  from=''
  for d in $(desolate list --json | jq -r '.[].domain'); do
    if [ "$d" != "$domain" ] && holds "$d"; then from=$d; break; fi
  done
  if [ -z "$from" ]; then
    echo "no domain holds $SECRET. Once, on this Mac: claude setup-token, then" >&2
    echo "  desolate domain $domain secret set $SECRET --hosts api.anthropic.com --headers authorization" >&2
    exit 1
  fi
  desolate domain "$domain" secret copy "$SECRET" --from "$from"
fi

# 2. The workspace, as for any task (agent.sh's steps 1 and 2; its options are agent.sh's).
name='' branch='' at=() existing=''
while [ $# -gt 0 ]; do
  case $1 in
    --name) name=$2; shift 2 ;;
    --branch) branch=$2; shift 2 ;;
    --checkout) at=(--checkout "$2"); shift 2 ;;
    --existing) existing=1; shift ;;
    *) usage ;;
  esac
done
[ -z "$existing" ] || [ -n "$name" ] || usage
if [ -z "$name" ]; then
  base=$(printf '%s' "$task" | head -n 1 | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed 's/^-*//; s/-*$//')
  if [ ${#base} -gt 30 ]; then   # at most 30 characters, in whole words where it can
    cut=${base:0:31} whole=${cut%-*}
    if [ "$whole" != "$cut" ] && [ ${#whole} -ge 12 ]; then base=$whole; else base=${base:0:30}; base=${base%-}; fi
  fi
  base=${base:-task} name=$base
  taken=$(desolate list "$domain" --json | jq -r '.[].workspaces[].workspace')
  for n in 2 3 4 5 6 7 8 9; do grep -qx "$name" <<<"$taken" || break; name="${base:0:27}-$n"; done
fi
w=$domain/$name
if [ -z "$existing" ]; then
  branch=${branch:-task/$name}
  desolate up "$domain" --name "$name" --branch "$branch"
fi

# 3. Claude itself. The project's devcontainer may carry it (the feature
#    ghcr.io/anthropics/devcontainer-features/claude-code:1 is the tidy way). If it does not,
#    it goes into the domain's cache, /desolate/cache, which every workspace of the domain
#    shares and a rebuilt container keeps: installed once per domain.
CACHED=/desolate/cache/claude-code/bin/claude
if ! desolate exec "$w" ${at[@]+"${at[@]}"} -- sh -c "command -v claude || test -x $CACHED" >/dev/null; then
  echo "$w: installing Claude Code into the domain's cache"
  desolate exec "$w" ${at[@]+"${at[@]}"} -- sh -c "
    if command -v npm >/dev/null; then npm install -g --prefix ${CACHED%/bin/claude} @anthropic-ai/claude-code >/dev/null
    else curl -fsSL https://claude.ai/install.sh | bash >/dev/null && mkdir -p ${CACHED%/claude} && cp \"\$(readlink -f \"\$HOME/.local/bin/claude\")\" $CACHED; fi"
fi

# 4. Claude's first-run questions, answered: its onboarding (a theme picker) and whether to
#    trust the folder. Left unanswered, a Claude started with nobody attached waits at the
#    first one, forever. They live in the container's ~/.claude.json.
desolate exec "$w" ${at[@]+"${at[@]}"} -- /desolate/bin/node -e '
  const fs = require("fs"), file = require("os").homedir() + "/.claude.json";
  let c = {}; try { c = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  c.hasCompletedOnboarding = true; c.theme = c.theme || "dark"; c.projects = c.projects || {};
  const p = c.projects[process.cwd()] = c.projects[process.cwd()] || {};
  p.hasTrustDialogAccepted = true; p.hasCompletedProjectOnboarding = true;
  fs.writeFileSync(file, JSON.stringify(c, null, 2));'

# 5. Claude at work, kept running (`desolate agent`). Its environment holds the secret's NAME
#    as its token (the proxy substitutes it); variables that would outrank that are unset.
#    --permission-mode auto: the workspace is the boundary, so nothing in it needs to ask.
orders="${branch:+Your branch, $branch, is checked out here. }First read /desolate/release/AGENTS.md: this is a desolate workspace.
Work until it is done and seen to work. Commit as you go. When it is ready: \`desolate offer\`, then \`desolate status set green \"ready: <one line>\"\`.
If you need a person (a decision, access, a secret): \`desolate status set orange \"<the question>\"\`, and wait."
desolate agent start "$w" --name claude ${at[@]+"${at[@]}"} -- \
  env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN=$SECRET \
  sh -c "exec \"\$(command -v claude || echo $CACHED)\" \"\$@\"" claude --permission-mode auto "$task

$orders"

echo "$w: Claude is working on it${branch:+, on $branch}."
echo "  watch it:   desolate agent attach $w --name claude     (Ctrl-] lets go; it keeps running)"
echo "  or open it: desolate editor $w --open"
echo "  its work:   desolate ui --open"
