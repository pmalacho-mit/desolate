#!/usr/bin/env bash
# A stand-in for the person's own gh, for recipes/issues.sh (T2 12-agent): the issues of
# acme/widgets as GitHub would list them, and only the calls the recipe makes, now and before.
#   1..120   open, labelled desolate:run (more than a page: GitHub gives 100 at most at once)
#   121      a pull request, labelled (GitHub lists pull requests among the issues)
#   130      open, without the label
#   150      closed
# GH_FAILS=1: every call fails, as GitHub does when it is down.
set -euo pipefail
[ -z "${GH_FAILS:-}" ] || { echo "gh: HTTP 502: Bad Gateway" >&2; exit 1; }
all() { # every issue, the newest first; 1..120 open and labelled, #121 a pull request, #130 open without the label, #150 closed
  jq -n '[150, 130, range(121; 0; -1)] | map({number: ., state: (if . == 150 then "closed" else "open" end),
    labels: (if . == 130 then [] else [{name: "desolate:run"}] end), title: "issue \(.)", body: "the body of \(.)",
    html_url: "https://github.com/acme/widgets/issues/\(.)"} + (if . == 121 then {pull_request: {}} else {} end))'
}
labelled() { all | jq --arg label "$1" '[.[] | select(.state == "open" and any(.labels[]; .name == $label))]'; }
verb=$1; shift
paginate='' jqp='.' per=30 label='' limit=30 n='' route='' sub=''
while [ $# -gt 0 ]; do
  case $1 in
    --paginate) paginate=1 ;;
    --jq) jqp=$2; shift ;;
    -X|--repo|--state) shift ;;
    -f|-F) case $2 in labels=*) label=${2#labels=} ;; per_page=*) per=${2#per_page=} ;; esac; shift ;;
    --label) label=$2; shift ;;
    --limit) limit=$2; shift ;;
    --json) shift ;;
    list|view) sub=$1 ;;
    *) if [ "$verb" = api ]; then route=$1; else n=$1; fi ;;
  esac
  shift
done
case $verb in
  api)
    [ "$route" = repos/acme/widgets/issues ] || { echo "gh: not found: $route" >&2; exit 1; }
    # A page at a time, at most 100 (GitHub's own most); each page through --jq, as gh does.
    [ "$per" -le 100 ] || per=100
    pages=$(labelled "$label" | jq -c --argjson per "$per" '[range(0; length; $per) as $i | .[$i:$i + $per]] | if length == 0 then [[]] else . end | .[]')
    [ -n "$paginate" ] || pages=$(head -n 1 <<<"$pages")
    while IFS= read -r page; do jq -r "$jqp" <<<"$page"; done <<<"$pages" ;;
  issue)
    if [ "$sub" = list ]; then
      labelled "$label" | jq --argjson limit "$limit" '[.[] | select(has("pull_request") | not)][:$limit] | map({number})' | jq -r "$jqp"
    else
      all | jq --argjson n "$n" '.[] | select(.number == $n) | {state: (.state | ascii_upcase), title, body, url: .html_url}' | jq -r "$jqp"
    fi ;;
  *) echo "gh: the stand-in does not know '$verb'" >&2; exit 1 ;;
esac
