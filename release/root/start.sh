#!/bin/bash
# Start (or confirm) the root VM's services. Run as root in the root VM, by the host, on
# bootstrap and on every start. Idempotent: a service already running is left alone.
#   start.sh <uid of the root's unprivileged user>
set -euo pipefail
USER_UID=${1:?usage: start.sh <uid>}
HERE=$(cd "$(dirname "$0")" && pwd)
STATE=/var/lib/desolate        # the ordinary user's (rootd, the state service, the proxies)
SYS=/var/lib/desolate-root     # root's: what root and the keyring rely on
RUN=/run/desolate
USER_NAME=$(getent passwd "$USER_UID" | cut -d: -f1)
USER_GROUP=$(id -gn "$USER_NAME")
USER_HOME=$(getent passwd "$USER_UID" | cut -d: -f6)
NODE="node --disable-warning=ExperimentalWarning"
# Everything in $STATE is made by the user, as the user: the user owns that directory and
# could have made any name in it a link, so root never opens, creates or changes a path
# there. (Before: `install -d -o <user> $STATE/secrets` as root followed a planted link,
# and gave the user any directory it named, /usr/local/bin included.)
as_user() { runuser -u "$USER_NAME" -- "$@"; }
# A domain's name is a slug: shared/names.ts's isSlug, clause for clause. Shell cannot import
# it, so T1 (tests/v3/t1/scripts.test.ts) reads this line and compares the two, name by name.
# The letters are spelled out: in a UTF-8 locale, [a-z] matches é too (macOS's bash, measured).
is_slug() { [[ $1 =~ ^[0123456789abcdefghijklmnopqrstuvwxyz][-0123456789abcdefghijklmnopqrstuvwxyz]{0,39}$ && $1 != *- && $1 != *--*--* && $1 != xn--* && $1 != *---* ]]; }

# Lima runs every command from the host over one ssh connection per VM, and sshd allows ten
# sessions on a connection by default: a workspace's link, the dashboard and desolate's own
# commands are each one, and the eleventh was refused (an audit on the M1). Raised; a
# connection made before keeps the old number, so the host makes a new one when this says so.
mkdir -p /etc/ssh/sshd_config.d
if [ "$(cat /etc/ssh/sshd_config.d/50-desolate.conf 2>/dev/null)" != "MaxSessions 1000" ]; then
  echo "MaxSessions 1000" >/etc/ssh/sshd_config.d/50-desolate.conf
  systemctl reload ssh >/dev/null 2>&1 || systemctl reload sshd >/dev/null 2>&1 || true
  echo "desolate: sessions raised"
fi

# THE ORDINARY USER IS NOT ROOT. Lima gives its login user `NOPASSWD: ALL` (cloud-init, at
# boot). That user runs every program here that reads what a domain wrote: git on its
# packs, the proxies on its traffic, the state service. With sudo, a bug in any of them was
# a bug with the write keys and every secret behind it. Undone here, before any of them
# starts; the host reaches root by ssh as root, with a key only the host holds
# (host/vm/lima.ts), never through this user.
# cloud-init writes its rule again at every boot, so the rule that takes it away is a file
# of desolate's that sorts after it: in sudoers the last match wins. Checked by trying.
for rule in /etc/sudoers.d/*; do
  case $rule in */99-desolate) continue ;; esac
  [ -f "$rule" ] && grep -qE "^[[:space:]]*\"?$USER_NAME\"?[[:space:]]" "$rule" && rm -f "$rule"
done
# The one thing it may do: run programs as a domain's proxies' user (proxy/as-proxy.ts),
# each of which reaches less than it does. That line comes last, so it is what matches for
# those users alone. (The group is made here, so the rule never names a group that is not.)
getent group desolate-proxies >/dev/null || groupadd --system desolate-proxies
printf '# desolate (root/start.sh): this user runs what reads a domain'"'"'s data. It is never root.\n%s ALL=(ALL) !ALL\n%s ALL=(%%desolate-proxies) NOPASSWD: ALL\n' "$USER_NAME" "$USER_NAME" >/etc/sudoers.d/99-desolate.new
chmod 0440 /etc/sudoers.d/99-desolate.new
visudo -qcf /etc/sudoers.d/99-desolate.new && mv /etc/sudoers.d/99-desolate.new /etc/sudoers.d/99-desolate
for group in sudo admin wheel docker lxd; do
  id -nG "$USER_NAME" | tr ' ' '\n' | grep -qx "$group" && gpasswd -d "$USER_NAME" "$group" >/dev/null
done
if runuser -u "$USER_NAME" -- sudo -n true 2>/dev/null; then
  echo "start.sh: $USER_NAME can still sudo; refusing to start anything that reads a domain's data" >&2
  exit 1
fi

id desolate-keyring >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin desolate-keyring
# The pusher (pusher.ts): the one user that reaches the write agent, and only to push what a
# person approved. Not in the root's user's group, and that user is not in its group.
PUSHER_HOME=/var/lib/desolate-pusher
id desolate-pusher >/dev/null 2>&1 || useradd --system --user-group --no-create-home --home-dir "$PUSHER_HOME" --shell /usr/sbin/nologin desolate-pusher
id -nG "$USER_NAME" | tr ' ' '\n' | grep -qx desolate-pusher && gpasswd -d "$USER_NAME" desolate-pusher >/dev/null
# The reviewer (reviewer.ts): says what a push would send, for the approval page. No write
# key, no shares; the read agent through a relay of its own.
REVIEWER_HOME=/var/lib/desolate-reviewer
id desolate-reviewer >/dev/null 2>&1 || useradd --system --user-group --no-create-home --home-dir "$REVIEWER_HOME" --shell /usr/sbin/nologin desolate-reviewer
id -nG "$USER_NAME" | tr ' ' '\n' | grep -qx desolate-reviewer && gpasswd -d "$USER_NAME" desolate-reviewer >/dev/null
# Each domain's proxies' user (proxy/as-proxy.ts) is made by proxy-user.sh: for every domain
# there is, here, and for a new one when the host first wants its proxies. None of them is
# in a group of the root's user (the keyring's sockets are not theirs), and the root's user
# is in none of theirs.
for domain_dir in /desolate/domains/*/; do
  [ -d "$domain_dir" ] || continue   # no domains: the pattern itself
  domain=$(basename "$domain_dir")
  is_slug "$domain" || { printf 'start.sh: %q in /desolate/domains is not a domain (its name is not one): no proxies made for it\n' "$domain" >&2; continue; }
  bash "$HERE/proxy-user.sh" "$USER_UID" "$domain" >/dev/null
done
# THE SHARES ARE CLOSED TO EVERY OTHER USER HERE. On vz, a file in a share reports as owned
# by whichever user last asked about it, so the guest's permission bits keep no user of this
# VM from another's files there (measured: the proxies' user wrote into a root clone). What
# keeps a user out is a directory that is NOT a share: /desolate, which holds every mount
# point, is root's and the root's user's group's (the keyring is in that group, the proxies'
# user is not). The proxies' and the pusher's code comes from a root-owned copy instead.
chown root:"$USER_GROUP" /desolate
chmod 0750 /desolate
PROXY_CODE=/opt/desolate/proxy-code
rm -rf "$PROXY_CODE.new"
install -d -m 0755 -o root -g root "$PROXY_CODE.new/root"
cp -R "$HERE/." "$PROXY_CODE.new/root/"
cp -R "$HERE/../shared" "$PROXY_CODE.new/shared"
chown -R root:root "$PROXY_CODE.new" && chmod -R u=rwX,go=rX "$PROXY_CODE.new"
rm -rf "$PROXY_CODE" && mv "$PROXY_CODE.new" "$PROXY_CODE"
# The keyring runs with the root user's GROUP, so the sockets it creates are connectable by
# the root's user (which must be able to ask for signatures) at mode 0660. Its keys (0600 in
# a 0700 directory) and its approvals socket (0600) are the keyring user's alone.

install -d -m 0755 -o root -g root "$SYS" "$RUN"
# What root runs here is root's. Images provisioned before tar was told --no-same-owner have
# node, npm and /usr/local/bin owned by the archive's uid (1001): given back to root.
for dir in /usr/local/bin /usr/local/lib /usr/local/include /usr/local/share; do
  [ -d "$dir" ] && find "$dir" -xdev \( ! -uid 0 -o ! -gid 0 \) -exec chown -h 0:0 {} +
done
# Services started from other code: desolate was updated under them, and a fix (to the
# state service's checks, say) means nothing until what runs is the fixed code. The code is
# the release's, which only the host can change (a read-only share).
CODE=$(cd "$HERE/.." && find root shared -type f \( -name '*.ts' -o -name '*.py' -o -name '*.sh' \) -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-16)
if [ "$(cat "$SYS/code" 2>/dev/null)" != "$CODE" ]; then
  groups=()
  for svc in rootd stated rootctl pusher reviewer; do
    [ -f "$RUN/$svc.pid" ] && { groups+=("$(cat "$RUN/$svc.pid")"); kill -- "-$(cat "$RUN/$svc.pid")" 2>/dev/null || true; }
    rm -f "$RUN/$svc.pid"
  done
  pkill -u desolate-keyring 2>/dev/null || true
  rm -rf "$RUN/keyring" "$RUN/keyring.pid" "$RUN/keyring-write"
  pkill -KILL -u desolate-pusher 2>/dev/null || true
  rm -rf "$RUN/pusher" "$RUN/pusher.pid" "$RUN/pusher.ended"
  pkill -KILL -u desolate-reviewer 2>/dev/null || true
  rm -rf "$RUN/reviewer" "$RUN/reviewer.pid" "$RUN/reviewer.ended" "$RUN/keyring-review"
  # The proxies too (rootd started them; bootstrap gives each running workspace a new one),
  # by where they run from: root's copy.
  proxies=("/opt/desolate/proxy-code/root/proxy/proxy.ts" /opt/desolate/proxy-venv/bin/mitmdump)
  for proxy in "${proxies[@]}"; do pkill -f "$proxy" 2>/dev/null || true; done
  [ -d "$STATE" ] && as_user bash -c 'rm -f "$1"/proxy/running/*.json' _ "$STATE" 2>/dev/null || true
  rm -f /var/lib/desolate-proxies/domains/*/secrets-proxy.json
  # Nothing new starts until every one of them is gone: what was told to end is waited for,
  # by its processes. (Before: one second, and then on, whether or
  # not the old code had stopped.) No count here: how long a start may take is the host's to
  # say, which waits for this script; this says what it is waiting for, for the host to show.
  # A zombie is gone: it holds nothing, and runs nothing. (Where nothing reaps orphans, as in
  # the fake backend's containers, whose first process is `sleep`, a killed service stays one.)
  old_left() {
    local pids
    pids=$({ for group in ${groups[@]+"${groups[@]}"}; do pgrep -g "$group"; done
      for user in desolate-keyring desolate-pusher desolate-reviewer; do pgrep -u "$user"; done
      for proxy in "${proxies[@]}"; do pgrep -f "$proxy"; done; true; } 2>/dev/null | sort -u | paste -sd, -)
    [ -z "$pids" ] || ps -o pid=,stat= -p "$pids" 2>/dev/null | awk '$2 !~ /^Z/ { print $1 }' | paste -sd, -
  }
  # What has not ended five seconds after it was asked to is ended: a process that ignores
  # SIGTERM (one any local user can start, under a proxy's name) must not keep the new code
  # from starting. Past that, only what cannot be killed is left (stuck in the kernel), and
  # the wait for it is the host's to bound.
  said=$SECONDS asked=$SECONDS killed=''
  while left=$(old_left) && [ -n "$left" ]; do
    if [ $((SECONDS - asked)) -ge 5 ]; then
      [ -n "$killed" ] || echo "start.sh: the services of the code before this update did not end when asked; killing them: $(ps -o pid=,user=,comm= -p "$left" 2>/dev/null | tr -s ' \n' ' ;')" >&2
      killed=1
      # shellcheck disable=SC2086  # one pid a word
      kill -KILL ${left//,/ } 2>/dev/null || true
    fi
    if [ $((SECONDS - said)) -ge 5 ]; then
      said=$SECONDS
      echo "start.sh: waiting for the services of the code before this update to end: $(ps -o pid=,user=,comm= -p "$left" 2>/dev/null | tr -s ' \n' ' ;')" >&2
    fi
    sleep 0.1
  done
fi
install -d -m 0755 -o "$USER_NAME" -g "$USER_GROUP" "$STATE"
# A root from before the layouts of 2026-11-11 and 2026-11-12 kept the keys, each domain's
# policy and its secret values where the root's user writes. They are not moved across any
# more: refused, rather than read as none (a domain with no policy file is open, and one
# with no store has no secrets). Nothing writes these places now.
for old in "$STATE/keyring" "$STATE/proxy/policy" "$STATE/secrets" /var/lib/desolate-proxies/domains/*/secrets.json; do
  [ -e "$old" ] || [ -L "$old" ] || continue
  echo "start.sh: $old is from a desolate before 2026-11-13, whose root state this one no longer converts" >&2
  echo "  fix: convert it once with the last desolate that did: git -C <your desolate> checkout d54984e && desolate bootstrap, then check out main again and run desolate bootstrap; or desolate destroy --all and begin again (its keys and secrets are lost)" >&2
  exit 1
done
install -d -m 0700 -o desolate-keyring -g "$USER_GROUP" "$SYS/keyring"
install -d -m 0750 -o desolate-keyring -g "$USER_GROUP" "$RUN/keyring"
# The write agent's relay and the pusher's questions to the keyring: a directory the root's
# user cannot enter. The directory is the gate (the sockets in it are open within it).
install -d -m 0750 -o desolate-keyring -g desolate-pusher "$RUN/keyring-write"
# The pusher's own: its repositories, and its socket, which only the root's user may use.
install -d -m 0700 -o desolate-pusher -g desolate-pusher "$PUSHER_HOME"
install -d -m 0750 -o desolate-pusher -g "$USER_GROUP" "$RUN/pusher"
# The reviewer's: the read agent's relay and its question to the keyring, and its socket.
install -d -m 0750 -o desolate-keyring -g desolate-reviewer "$RUN/keyring-review"
install -d -m 0700 -o desolate-reviewer -g desolate-reviewer "$REVIEWER_HOME"
install -d -m 0750 -o desolate-reviewer -g "$USER_GROUP" "$RUN/reviewer"
# Hooks: a directory only root writes, holding desolate's own. Every root clone's
# core.hooksPath points here, so no hook from a repository's content can run.
install -d -m 0755 -o root -g root "$SYS/hooks"
install -m 0755 -o root -g root "$HERE/hooks/pre-push" "$SYS/hooks/pre-push"
install -d -m 0755 -o root -g root "$SYS/mirror-hooks"
printf '#!/bin/sh\necho "desolate: the mirror holds only what the remote published; nothing is pushed into it." >&2\nexit 1\n' >"$SYS/mirror-hooks/pre-receive"
chmod 0755 "$SYS/mirror-hooks/pre-receive"
as_user bash -c '
  set -eu; cd "$1"
  for f in registry.json forge.json known_hosts; do [ -e "$f" ] || : >"$f"; done
  [ -s registry.json ] || echo "{\"repos\":{}}" >registry.json
  mkdir -p -m 0700 approvals proxy/running
  mkdir -p -m 0755 push-locks
  chmod 0700 approvals proxy/running
  chmod 0700 proxy' _ "$STATE"
# Secret values are root's (proxy/secret-store.ts).
install -d -m 0755 -o root -g root /var/lib/desolate-proxies/secrets
# The root's git settings, for desolate's own commands and for the person's shell alike.
# The root's clones hold commits that agents wrote. Nothing here trusts what a commit
# contains:
cat >"$SYS/gitconfig.new" <<G
[user]
	name = desolate root
	email = root@desolate.invalid
[advice]
	detachedHead = false
# Every object that arrives is checked: a tree with ".git" in it, a .gitmodules that is a
# symlink or names an option, a malformed object, are refused before any ref points at them.
[fetch]
	fsckObjects = true
	recurseSubmodules = false
[transfer]
	fsckObjects = true
[receive]
	fsckObjects = true
# The root's clones are on the Mac's disk, which folds case and normalises Unicode: paths
# that only LOOK different from ".git" must not be checked out there.
[core]
	protectHFS = true
	protectNTFS = true
	fsmonitor = false
# Two domains import into one root clone at once (offers.ts, fetchDomain), and git there
# also packs its refs (auto gc, in the fetch that set it off): each holds a ref's lock, or
# packed-refs', while it writes, and git gives up on one held after 100 ms (a ref) or 1 s
# (packed-refs), by default. A minute waits out any honest holder, on a loaded VM too:
# another domain's import is not a reason for a domain's to fail. (A lock left by a git that
# was killed is waited on for that minute, then said.)
	filesRefLockTimeout = 60000
	packedRefsTimeout = 60000
# What git shows in the person's terminal (a commit message, a file name, a diff an agent
# wrote) goes through less, which passes colour and shows any other control as text.
	pager = less
# A directory inside a checked-out tree that is shaped like a bare repository (with a
# config of its own) is not a repository: git run from inside it does not read that config.
[safe]
	bareRepository = explicit
# Not a protection here, and so not pretended: every file on a share is the root's user's on
# every backend (all VMs share the Mac user's uid), and on vz a file reports as owned by
# whoever last asked. Git's ownership check never kept the root out of a domain's
# repositories; root/git.ts does, for desolate's own git, and the shell's guard below does
# for the person's. What the check did do was refuse the root's own clones on vz.
	directory = *
# A submodule or a remote can name a transport. Only the ones desolate uses exist here;
# "ext::" (which runs a command) and the rest do not.
[protocol]
	allow = never
[protocol "file"]
	allow = always
[protocol "ssh"]
	allow = always
[protocol "https"]
	allow = always
[protocol "desolate"]
	allow = always
[protocol "desolate-push"]
	allow = always
[submodule]
	recurse = false
G
chmod 0644 "$SYS/gitconfig.new" && mv "$SYS/gitconfig.new" "$SYS/gitconfig"
# The person's shell in the root uses the same git settings as desolate does. (Rewritten
# every time: the file's place moved.)
cat >/etc/profile.d/desolate-root.sh <<'P'
export GIT_CONFIG_GLOBAL=/var/lib/desolate-root/gitconfig
# A terminal shows bytes another wrote: less passes colour and nothing else raw (-R), and
# runs nothing (LESSSECURE). As the git VM's (git/provision.sh). The host filters what this
# shell prints too (host/vm/attach.ts); this is for the shell's own pagers.
export LESS=-FRX LESSSECURE=1 PAGER=less GIT_PAGER=less
export PS1='[desolate root: review and push here; never run a repository'"'"'s own code] \w \$ '
# A domain's repositories are its own, and their config is the domain's to write: git run in
# one would act on it (P4). Where a person's shell is in one, git says so instead.
git() {
  case "$(pwd -P)/" in
    /desolate/domains/*) echo "desolate: this is a domain's own repository, not the root's: git is not run here (P4). The root's clone of it is under /desolate/root." >&2; return 1 ;;
  esac
  command git "$@"
}
P

# No sudo rule: nothing in this VM can approve a push. An approval is a signature by the
# approver on the HOST, checked against the public key the host installs here (a directory
# and file only root writes; keyring.ts refuses a key anyone else could have replaced).
install -d -m 0755 -o root -g root /etc/desolate
# The host's token for the state service is retired (stated.ts: the host's own socket).
rm -f /etc/desolate/host-token
# ($STATE/approvals, where a raw `git push` in the root's terminal leaves its request for
# `desolate approve`, was made above, by the user.)

alive() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }
# The Mac's loopback, walled off before anything that reads a domain's data starts (wall.sh).
# Best effort here (a container standing in for a VM may not be allowed to set it); the host
# sets it at bootstrap and refuses to go on without it on a real VM, and doctor asks.
if ! bash "$HERE/wall.sh" apply; then
  # On a real VM the host asked for it (wall.sh set --required): nothing starts without it.
  [ -f "$SYS/wall-required" ] && { echo "start.sh: the Mac's loopback could not be walled off; nothing that reads a domain's data is started" >&2; exit 1; }
  echo "start.sh: the Mac's loopback could not be walled off here (not a real VM)" >&2
fi
if ! alive "$RUN/keyring.pid"; then
  setsid runuser -u desolate-keyring -g "$USER_GROUP" -- \
    $NODE "$HERE/keyring.ts" >>"$SYS/keyring.log" 2>&1 </dev/null &
  echo $! >"$RUN/keyring.pid"
fi
# A service is waited for until it listens, for as long as it is still trying to: the wait
# ends when its socket is there, or when the service itself has ended without one. There is no
# count in it. (Before: ten seconds, which a cold VM under load can take, and the start was
# then refused with the service a moment from listening.) How long a start may take is the
# host's to say, which waits for this script; every five seconds this says what it waits for.
# (A service just started by this script has failed when its <ended> file is there at all.)
listening() { # listening <name> <socket> <pid file> [<file whose change says the service ended> [fresh]]
  local name=$1 socket=$2 pid=$3 ended=${4:-/dev/null} before='' since=$SECONDS said=$SECONDS
  [ "${5:-}" = fresh ] || before=$(cat "$ended" 2>/dev/null || true)
  until [ -S "$socket" ]; do
    if ! alive "$pid" || [ "$(cat "$ended" 2>/dev/null)" != "$before" ]; then
      echo "start.sh: the $name ended before it was listening; see $SYS/$name.log" >&2; tail -5 "$SYS/$name.log" >&2; exit 1
    fi
    if [ $((SECONDS - said)) -ge 5 ]; then said=$SECONDS; echo "start.sh: the $name is still starting ($((SECONDS - since)) s)" >&2; fi
    sleep 0.1
  done
}
listening keyring "$RUN/keyring/control.sock" "$RUN/keyring.pid"
# The pusher and the reviewer, kept running by root (kept.sh): one request per process
# (pusher.ts, reviewer.ts), and before each start every process of that user is killed, so
# nothing a request's git started outlives it. Their logs are root's files.
kept_alone() { # kept_alone <user> <home> <script> <socket> <user|session>
  # user: every process of the user is killed before each start (the pusher: nothing a push
  # started outlives it). session: only the service's own session (the reviewer, whose
  # one-shot summaries for the host run as the same user, beside it).
  # After each run too: what a push started never waits out a pause before a restart. And its
  # socket goes with it, so a service that ended is never taken for one that listens (root
  # removes a name in the service's directory: rm follows no link).
  local user=$1 home=$2 script=$3 socket=$4 kill=$5 name fresh=''
  name=$(basename "$script" .ts)
  if ! alive "$RUN/$name.pid"; then
    rm -f "$RUN/$name.ended"
    fresh=fresh
    setsid bash "$HERE/kept.sh" "$name" once "$RUN/$name.ended" \
      bash -c '[ "$4" = user ] && pkill -KILL -u "$1" 2>/dev/null; sleep 0.2
        setsid runuser -u "$1" -- env -i PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 HOME="$2" \
          node --disable-warning=ExperimentalWarning "$3" </dev/null & child=$!
        wait "$child"; code=$?; [ "$4" = session ] && pkill -KILL -s "$child" 2>/dev/null
        [ "$4" = user ] && pkill -KILL -u "$1" 2>/dev/null; rm -f "$5"
        sleep 0.5; exit "$code"' _ "$user" "$home" "$PROXY_CODE/root/$script" "$kill" "$socket" </dev/null >>"$SYS/$name.log" 2>&1 &
    echo $! >"$RUN/$name.pid"
  fi
  listening "$name" "$socket" "$RUN/$name.pid" "$RUN/$name.ended" $fresh
}
kept_alone desolate-pusher "$PUSHER_HOME" pusher.ts "$RUN/pusher/control.sock" user
kept_alone desolate-reviewer "$REVIEWER_HOME" reviewer.ts "$RUN/reviewer/control.sock" session
ln -sf "$HERE/git-remote-desolate" /usr/local/bin/git-remote-desolate
ln -sf "$HERE/git-remote-desolate-push" /usr/local/bin/git-remote-desolate-push
# rootd and the state service are kept running (kept.sh): if one ends, it is started again
# and its log says so. (The keyring is not: a keyring that has stopped signs nothing, which
# is the safe way for it to be wrong, and `desolate doctor` says it is down.)
# Its log is opened by the user, in the user's directory: root opens nothing there.
kept() { # kept <name> <script>
  setsid runuser -u "$USER_NAME" -- env HOME="$USER_HOME" GIT_CONFIG_GLOBAL="$SYS/gitconfig" \
    bash -c 'exec >>"$1/$2.log" 2>&1 || exit 1; shift 2; exec bash "$@"' \
    _ "$STATE" "$1" "$HERE/kept.sh" "$1" always "" $NODE "$HERE/$2" "${@:3}" </dev/null >/dev/null 2>&1 &
  echo $! >"$RUN/$1.pid"
}
alive "$RUN/rootd.pid" || kept rootd rootd.ts
# The state service: what the dashboard draws from (stated.ts). The host's socket's directory
# is the user's alone, as the CLI channel's is: the host asks as that user.
install -d -m 0700 -o "$USER_NAME" "$RUN/stated"
alive "$RUN/stated.pid" || kept stated stated.ts
# The CLI channel, kept running (rootctl.ts serve): the host's calls skip loading the root's
# code each time. Its socket's directory is the user's alone; the host asks as that user.
install -d -m 0700 -o "$USER_NAME" "$RUN/rootctl"
alive "$RUN/rootctl.pid" || kept rootctl rootctl.ts serve
echo "$CODE" >"$SYS/code"
echo "root services: keyring, pusher, reviewer, rootd, the state service and the CLI channel up"
