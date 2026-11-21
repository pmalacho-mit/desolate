#!/usr/bin/env bash
# A name for a task's workspace, printed: the task's first words (`add-a-shout-greeting`), and
# a number after them when the domain already has a workspace of that name.
#
#   release/recipes/name.sh <domain> "<what to do>"
#
# agent.sh and claude.sh call it when they are given no --name.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
desolate() { "$here/../cli.sh" "$@"; }   # the same as typing `desolate`, from this checkout
[ $# -eq 2 ] || { echo "usage: $0 <domain> \"<what to do>\"" >&2; exit 64; }
domain=$1 task=$2

# The first line, as a slug: lower case, every run of anything else one dash.
base=$(printf '%s' "$task" | head -n 1 | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed 's/^-*//; s/-*$//')
# At most 30 characters, in whole words where it can. (30 is a choice, for a name that is
# read in a list and typed after `desolate editor`. What a name may be is a slug of up to 40:
# shared/names.ts.)
most=30
if [ ${#base} -gt $most ]; then
  cut=${base:0:$((most + 1))} whole=${cut%-*}
  if [ "$whole" != "$cut" ] && [ ${#whole} -ge 12 ]; then base=$whole; else base=${base:0:$most}; base=${base%-}; fi
fi
base=${base:-task}

# Taken: the next number that is free, however many there are. The number is part of the 30.
taken=$(desolate list "$domain" --json | jq -r '.[].workspaces[].workspace')
name=$base n=2
while grep -qxF "$name" <<<"$taken"; do
  stem=${base:0:$((most - 1 - ${#n}))}
  name=${stem%-}-$n n=$((n + 1))
done
printf '%s\n' "$name"
