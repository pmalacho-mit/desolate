#!/bin/bash
# desolate v3's tests, by tier (move-to-vms.md section 13.2). Test names carry their tier,
# and a T2 test is never taken as proof of a boundary.
#
#   tests/v3/run.sh t1      static and unit. Seconds, anywhere, no Docker.
#   tests/v3/run.sh t2 [<suite>...]
#                           end to end on the fake backend (containers standing in for VMs):
#                           all of it, or the suites named, three at a time. Minutes. Needs
#                           Docker, the base image, and a non-root user.
#   tests/v3/run.sh affected [<base>]
#                           T1, then the T2 suites a change since <base> (origin/main)
#                           touches (tests/v3/affected.ts). The whole of T2 before a merge.
#   tests/v3/run.sh t3      end to end on real VMs (the qemu backend: KVM if /dev/kvm exists,
#                           software emulation if not). Tens of minutes under emulation.
#   tests/v3/run.sh t4      the same end-to-end boundary tests on a Mac (the vz backend).
#                           About 3 minutes on an M1.
#   tests/v3/run.sh all     t1, t2, t3
#
# A tier whose needs are not met FAILS and says what to install: it does not skip, because a
# suite that did not run is not a suite that passed.
#
#   UPDATE_TRANSCRIPTS=1    accept changed command output (review the diff first)
#   DESOLATE_IMAGE_DIR      where release/image/build.sh wrote the base image (t2, t3)
#   DESOLATE_TIMINGS=<file> append each step's wall-clock time (t2 prints the slowest anyway)
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
cd "$ROOT" || exit 1
NODE=${DESOLATE_NODE:-node}
need() { echo "tests/v3: $1" >&2; echo "  fix: $2" >&2; exit 1; }
"$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=18)?0:1)' 2>/dev/null \
  || need "node >= 22.18 is required (found: $("$NODE" --version 2>/dev/null || echo none))" "install a newer node, or set DESOLATE_NODE"
# Inside a desolate workspace (developing desolate there): the tests' homes go on the VM's
# own disk, at the same path for the VM's docker as for this container (/desolate/scratch,
# workspace/start.sh). /workspaces is a share, where chmod on a socket fails, and a socket's
# path must stay short; /tmp here is the container's, which the VM's docker cannot bind.
if [ "${DESOLATE_WORKSPACE:-}" = 1 ] && [ -z "${TMPDIR:-}" ] && [ -w /desolate/scratch ]; then
  export TMPDIR=/desolate/scratch/tests
  mkdir -p "$TMPDIR"
fi
# Docker itself, not the devcontainer feature's relay in front of it. docker-outside-of-docker
# gives a container user who is not root a socat relay at /var/run/docker.sock (its
# docker-init.sh), and socat closes a connection half a second after one side ends: a
# `docker exec -i` whose input has ended then loses everything printed after that, which is
# every request the fake backend sends its root (stack.ts: "the root took 'repo.fetch' and its
# answer was lost"). Every T2 suite failed in its first seconds so (2026-11-17, inside
# desolate/t2). The socket behind the relay is the VM's own, open to the docker group.
if [ "${DESOLATE_WORKSPACE:-}" = 1 ] && [ -z "${DOCKER_HOST:-}" ] && [ -S /var/run/docker-host.sock ] && [ -w /var/run/docker-host.sock ]; then
  export DOCKER_HOST=unix:///var/run/docker-host.sock
fi
# A Chromium the setup script fetched where the distribution has none (arm64 Ubuntu's is a snap).
if [ -z "${DESOLATE_CHROME:-}" ]; then
  for c in /desolate/scratch/playwright/chromium-*/chrome-linux/chrome "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux/chrome; do
    [ -x "$c" ] && export DESOLATE_CHROME=$c && break
  done
fi
# The end-to-end tiers run with no terminal: they play the person themselves (lib/person.py,
# in a terminal of its own). A terminal of the runner's would be found by the terminal
# approver, which would wait at it for a person (04's "a push is impossible without a
# person", run under `desolate agent`, waited there for ten minutes).
detached() { python3 -c 'import os, sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' "$@" </dev/null; }
run_node_tests() { "$NODE" --disable-warning=ExperimentalWarning --test --test-concurrency=1 --test-reporter="${DESOLATE_TEST_REPORTER:-spec}" "$@"; }

# (LANES files at a time; each file is a process of its own.)
detached_node_tests() { detached "$NODE" --disable-warning=ExperimentalWarning --test --test-concurrency="${LANES:-1}" --test-reporter="${DESOLATE_TEST_REPORTER:-spec}" "$@"; }

t1() {
  echo "== T1: static and unit"
  local failed=0
  if [ -x node_modules/.bin/tsc ]; then
    node_modules/.bin/tsc -p . || failed=1
  else
    # node strips types without checking them: unchecked, the four sides of desolate can
    # silently disagree. Not installing typescript must not look like a pass.
    need "typescript is not installed, so nothing checks that the TypeScript agrees with itself" "npm install"
  fi
  # In-source tests (suede.nests): the `declare namespace` blocks beside the code in release/.
  if [ -x node_modules/.bin/vitest ]; then
    node_modules/.bin/vitest run --reporter=dot || failed=1
  else
    need "vitest is not installed, so the in-source tests (suede.nests) cannot run" "npm install"
  fi
  # Formatted as the editor formats it on save (.vscode/settings.json): `make format` fixes it.
  if [ -x node_modules/.bin/prettier ]; then
    git ls-files -z '*.ts' '*.mts' | xargs -0 node_modules/.bin/prettier --ignore-path .prettierignore --check --log-level warn \
      || { echo "   not formatted: make format" >&2; failed=1; }
  else
    need "prettier is not installed, so nothing checks the TypeScript is formatted" "npm install"
  fi
  for script in release/cli.sh release/image/*.sh release/root/*.sh release/root/hooks/* release/root/keyring-askpass release/root/git-remote-desolate release/workspace/*.sh release/workspace/desolate release/host/vm/*.sh tests/v3/*.sh tests/v3/forge/*.sh tests/probes/v3/*.sh; do
    bash -n "$script" || { echo "syntax: $script" >&2; failed=1; }
  done
  if command -v shellcheck >/dev/null 2>&1; then
    shellcheck -S warning release/cli.sh release/image/*.sh release/root/*.sh release/workspace/*.sh release/host/vm/*.sh tests/v3/*.sh tests/v3/forge/*.sh tests/probes/v3/*.sh || failed=1
  else
    echo "   (shellcheck not installed: shell scripts were syntax-checked only)"
  fi
  run_node_tests tests/v3/t1/*.test.ts || failed=1
  return $failed
}

docker_ready() {
  [ "$(id -u)" != 0 ] || need "the end-to-end tiers refuse to run as root: the stack's unprivileged user would be root, and nothing about users could be tested" "run as an ordinary user who can use Docker"
  docker info >/dev/null 2>&1 || need "no Docker daemon answers (the stand-in forge and the fake backend run in containers)" "start Docker, and make sure this user can reach it"
  docker image inspect desolate/base:latest >/dev/null 2>&1 || need "the base image desolate/base:latest is not in Docker's image store" "sudo release/image/build.sh --out <dir>   (on Linux; it imports the image)"
  # What the fake backend relies on in every request to its root: a command run with `-i`
  # still delivers what it prints after its input has ended. A relay that closes early (see
  # DOCKER_HOST above) loses it, and every suite then fails in its setup with a lost answer.
  [ "$(echo request | docker run --rm -i --network none desolate/base:latest sh -c 'cat >/dev/null; sleep 1; echo answered' 2>/dev/null)" = answered ] \
    || need "Docker here loses what a command prints after its input ends (docker run/exec -i): the fake backend's root answers would be lost" "talk to Docker directly, not through a relay that closes early: DOCKER_HOST=unix:///var/run/docker-host.sock (a devcontainer's docker-outside-of-docker)"
  command -v git-lfs >/dev/null 2>&1 || need "git-lfs is needed on this machine to make the test repositories" "apt-get install git-lfs  /  brew install git-lfs"
  command -v python3 >/dev/null 2>&1 || need "python3 is needed (tests/v3/lib/person.py plays the person at a terminal)" "install python3"
  command -v jq >/dev/null 2>&1 || need "jq is needed (the recipes in release/recipes/ use it, and T2 runs one)" "apt-get install jq  /  brew install jq"
}

# T2's suites run three at a time. Each makes a stack of its own (a random instance, its own
# temp folder, forge and pages port), and each suite's workspaces listen on ports no other
# suite uses: the host forwards a workspace's port at the same number on this machine.
# Longest first, so that no lane starts a long one last. 03-ports runs alone, after the
# others: it asserts what listens on the whole of this machine's loopback.
T2_FIRST="02-domains 19-journeys 24-requests 04-offers 09-ui 11-git-vm"
T2_ALONE="03-ports"
t2() {
  echo "== T2: end to end, fake backend (NOT a test of any VM boundary)"
  docker_ready
  local all=("$@") side=() alone=() f n
  [ ${#all[@]} -gt 0 ] || all=(tests/v3/t2/*.test.ts)
  for f in "${all[@]}"; do [ -f "$f" ] || need "no suite $f" "name suites as tests/v3/t2/<NN-name>.test.ts"; done
  for n in $T2_FIRST; do
    for f in "${all[@]}"; do [ "$(basename "$f" .test.ts)" = "$n" ] && side+=("$f"); done
  done
  for f in "${all[@]}"; do
    n=$(basename "$f" .test.ts)
    case " $T2_ALONE " in *" $n "*) alone+=("$f") ;; esac
    case " $T2_FIRST $T2_ALONE " in *" $n "*) ;; *) side+=("$f") ;; esac
  done
  if [ ${#side[@]} -gt 1 ]; then
    [ -z "${DESOLATE_TEST_EDITOR_PORT:-}" ] || need "DESOLATE_TEST_EDITOR_PORT gives every stack the same port, and T2's suites run side by side" "unset it, or name one suite"
    [ "${DESOLATE_KEEP:-}" != 1 ] || need "DESOLATE_KEEP=1 keeps one stack, in /tmp/desolate-kept.env, and T2's suites run side by side" "name the one suite: tests/v3/run.sh t2 tests/v3/t2/<suite>.test.ts"
    [ -z "${DESOLATE_SCREENSHOTS:-}" ] || need "DESOLATE_SCREENSHOTS is for one suite (its files have fixed names)" "name the one suite"
  fi
  local timings=${DESOLATE_TIMINGS:-$(mktemp "${TMPDIR:-/tmp}/t2-timings.XXXXXX")} failed=0
  if [ ${#side[@]} -gt 0 ]; then
    DESOLATE_TIMINGS=$timings LANES=3 DESOLATE_TIER=T2 detached_node_tests "${side[@]}" || failed=1
  fi
  if [ ${#alone[@]} -gt 0 ]; then
    DESOLATE_TIMINGS=$timings DESOLATE_TIER=T2 detached_node_tests "${alone[@]}" || failed=1
  fi
  echo "== T2: the slowest steps (suite, step, seconds)"
  sort -t "$(printf '\t')" -k3,3nr "$timings" | head -20 | awk -F '\t' '{ printf "  %6.1f  %s: %s\n", $3 / 1000, $1, $2 }'
  [ -n "${DESOLATE_TIMINGS:-}" ] || rm -f "$timings"
  return $failed
}

affected() {
  local base=${1:-origin/main} suites
  "$NODE" tests/v3/affected.ts "$base" || return 1
  t1 || return 1
  suites=$("$NODE" tests/v3/affected.ts --t2 "$base") || return 1
  if [ -z "$suites" ]; then echo "== T2: no suite is touched"; return 0; fi
  # shellcheck disable=SC2086 # one path a line, none with a space
  t2 $suites
}

t3() {
  echo "== T3: end to end, real VMs (qemu backend)"
  docker_ready
  command -v limactl >/dev/null 2>&1 || need "limactl is not on PATH (the qemu backend drives QEMU through Lima)" "install Lima 2.0 or newer: https://lima-vm.io"
  command -v "qemu-system-$(uname -m)" >/dev/null 2>&1 || need "qemu-system-$(uname -m) is not installed" "apt-get install qemu-system-x86 qemu-utils"
  local image=${DESOLATE_IMAGE_DIR:-$HOME/.desolate/images/$(uname -m)}
  [ -f "$image/disk.raw" ] || need "the base VM image is not at $image" "sudo release/image/build.sh --out <dir>, then DESOLATE_IMAGE_DIR=<dir> tests/v3/run.sh t3"
  [ -e /dev/kvm ] || echo "   no /dev/kvm: software emulation. Each VM takes minutes to boot; this tier takes tens of minutes."
  DESOLATE_TIER=T3 DESOLATE_IMAGE_DIR=$image detached_node_tests tests/v3/t3/*.test.ts
}

t4() {
  echo "== T4: end to end, the product backend (vz) on a Mac"
  [ "$(uname -s)" = Darwin ] || need "T4 is the Mac's tier" "run it on macOS; on Linux the real-VM tier is t3"
  docker_ready
  command -v limactl >/dev/null 2>&1 || need "limactl is not on PATH" "brew install lima"
  DESOLATE_TIER=T4 detached_node_tests tests/v3/t3/*.test.ts
}

case "${1:-t1}" in
  t1) t1 ;;
  t2) shift; t2 "$@" ;;
  affected) shift; affected "$@" ;;
  t3) t3 ;;
  t4) t4 ;;
  all) t1 && t2 && t3 ;;
  *) sed -n '2,25p' "$0"; exit 64 ;;
esac
