#!/bin/bash
# Keep one service running: start it, and when it ends, start it again. root/start.sh runs one
# of these for each service it keeps (rootd, the state service and the CLI channel, as the
# root's user; the pusher and the reviewer, as root), with its output in the service's log.
#
#   kept.sh <name> <always|once> <count file, or ""> <command...>
#
#   always  the service is meant never to end: every end is a failure.
#   once    the service answers one request and ends with 0 (pusher.ts, reviewer.ts): then it
#           is started again at once, and any other end is a failure.
#
# A failure is said in the log, with when and how, and counted in <count file> (start.sh reads
# it: a service that failed while start.sh waited for its socket did not start). The next
# start then waits: 1 s, and while the service keeps failing within a minute of its start, 2,
# 4, doubling up to once a minute. One that stayed up longer waits 1 s again.
#
# Before, a service was started again every 2 s (or twice a second) for ever: one that could
# not start wrote 43,200 lines a day or more in its log, and whatever the crash itself
# prints each time, until the disk was full. A minute, both times: a service that was up that
# long did not fail to start; and what kept one from starting (a full disk, a share not there
# yet) is found mended within a minute.
set -u
name=$1 ends=$2 count=$3
shift 3
pause=0 failures=0
while :; do
  started=$SECONDS
  "$@"
  code=$?
  if [ "$ends" = once ] && [ "$code" = 0 ]; then pause=0; continue; fi
  if [ "$pause" = 0 ] || [ $((SECONDS - started)) -ge 60 ]; then pause=1; else pause=$((pause * 2)); fi
  [ "$pause" -le 60 ] || pause=60
  failures=$((failures + 1))
  [ -z "$count" ] || echo "$failures" >"$count"
  echo "$name: ended with $code at $(date -u +%FT%TZ), $((SECONDS - started)) s after its start; starting it again in $pause s" >&2
  sleep "$pause"
done
