#!/bin/bash
# Build desolate's base image from the Ubuntu archive alone (debootstrap), on a Linux host.
#
#   sudo image/build.sh --out <dir> [--node-from <dir>] [--subrepo-from <dir>] [--editor-from <dir>]
#                       [--no-editor] [--build-ca <bundle.pem>]
#
# --no-editor: an image without the editor server (P1's editor), for a builder that cannot
# reach GitHub's releases and has none to give with --editor-from. The image says so
# (/opt/desolate/EDITOR-MISSING, which `desolate editor` shows). Without it, a build that
# cannot fetch the editor fails: an image never lacks it by accident.
# --build-ca: a CA bundle the BUILD trusts, for a builder behind a proxy that re-signs TLS.
# It is used while provisioning and is not left in the image.
#
# Writes into <dir>:
#   rootfs.tar        the provisioned root filesystem
#   manifest.json     its sha256, and the versions inside
# and, with docker on PATH, imports rootfs.tar as the image desolate/base:<sha12> for the
# fake backend.
#
# This is the route for hosts with no hypervisor to provision in: CI, and an agent's sandbox,
# which can reach the Ubuntu archive and npm but not nodejs.org or GitHub releases (hence
# --*-from: tools already on the builder are staged instead of downloaded). On a Mac the Lima
# backend provisions a pinned Ubuntu cloud image with the same image/provision.sh instead.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
OUT="" NODE_FROM="" SUBREPO_FROM="" EDITOR_FROM="" EDITOR_SERVER="" BUILD_CA=""
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT=$2; shift ;;
    --node-from) NODE_FROM=$2; shift ;;
    --subrepo-from) SUBREPO_FROM=$2; shift ;;
    --editor-from) EDITOR_FROM=$2; shift ;;
    --no-editor) EDITOR_SERVER=none ;;
    --build-ca) BUILD_CA=$2; shift ;;
    *) echo "build.sh: unknown flag $1" >&2; exit 64 ;;
  esac
  shift
done
[ -n "$OUT" ] || { echo "build.sh: --out <dir> is required" >&2; exit 64; }
[ -z "$EDITOR_SERVER" ] || [ -z "$EDITOR_FROM" ] || { echo "build.sh: --no-editor or --editor-from, not both" >&2; exit 64; }
[ "$(id -u)" = 0 ] || { echo "build.sh: needs root (debootstrap, chroot). Run it with sudo." >&2; exit 1; }
for t in debootstrap chroot; do
  command -v "$t" >/dev/null || { echo "build.sh: '$t' is missing. Install it: apt-get install debootstrap" >&2; exit 1; }
done
# shellcheck disable=SC1091
. "$HERE/../pins.env"
case "$(uname -m)" in
  x86_64) DEB_ARCH=amd64; MIRROR=http://archive.ubuntu.com/ubuntu ;;
  aarch64) DEB_ARCH=arm64; MIRROR=http://ports.ubuntu.com/ubuntu-ports ;;
  *) echo "build.sh: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
R=$OUT/rootfs
umount_all() { for m in dev/pts dev proc sys; do umount -l "$R/$m" 2>/dev/null || true; done; }
trap umount_all EXIT
umount_all; rm -rf "$R"

echo "==> debootstrap $UBUNTU_SUITE ($DEB_ARCH)"
debootstrap --arch="$DEB_ARCH" --variant=minbase --components=main,universe \
  --include=ca-certificates "$UBUNTU_SUITE" "$R" "$MIRROR" >"$OUT/debootstrap.log" 2>&1 \
  || { tail -20 "$OUT/debootstrap.log" >&2; exit 1; }
cat >"$R/etc/apt/sources.list" <<S
deb $MIRROR $UBUNTU_SUITE main universe
deb $MIRROR $UBUNTU_SUITE-updates main universe
deb $MIRROR $UBUNTU_SUITE-security main universe
S
mount -t proc proc "$R/proc"; mount -t sysfs sys "$R/sys"
mount --bind /dev "$R/dev"; mount --bind /dev/pts "$R/dev/pts"
cp /etc/resolv.conf "$R/etc/resolv.conf"
# Nothing the packages install may start during the build.
printf '#!/bin/sh\nexit 101\n' >"$R/usr/sbin/policy-rc.d"; chmod +x "$R/usr/sbin/policy-rc.d"

mkdir -p "$R/opt/desolate-build/image" "$R/opt/desolate-stage"
cp "$HERE/../pins.env" "$R/opt/desolate-build/pins.env"
cp "$HERE/provision.sh" "$R/opt/desolate-build/image/provision.sh"
cp -a "$HERE/locks" "$R/opt/desolate-build/image/locks"
[ -z "$NODE_FROM" ] || { mkdir -p "$R/opt/desolate-stage/node/bin" "$R/opt/desolate-stage/node/lib/node_modules"
  cp -aL "$NODE_FROM/bin/node" "$R/opt/desolate-stage/node/bin/node"
  cp -a "$NODE_FROM/lib/node_modules/npm" "$R/opt/desolate-stage/node/lib/node_modules/npm"; }
[ -z "$SUBREPO_FROM" ] || cp -a "$SUBREPO_FROM" "$R/opt/desolate-stage/git-subrepo"
[ -z "$EDITOR_FROM" ] || cp -a "$EDITOR_FROM" "$R/opt/desolate-stage/editor"

CA_ENV=()
if [ -n "$BUILD_CA" ]; then
  cp "$BUILD_CA" "$R/opt/desolate-build/build-ca.pem"
  for v in NODE_EXTRA_CA_CERTS SSL_CERT_FILE PIP_CERT REQUESTS_CA_BUNDLE CURL_CA_BUNDLE GIT_SSL_CAINFO; do
    CA_ENV+=("$v=/opt/desolate-build/build-ca.pem")
  done
fi
echo "==> provision"
chroot "$R" env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root \
  "${CA_ENV[@]}" DESOLATE_IMAGE_KIND=vm DESOLATE_IMAGE_EDITOR="$EDITOR_SERVER" bash /opt/desolate-build/image/provision.sh 2>&1 | tee "$OUT/provision.log" | grep -E '^(==>|    |provision: )' || true
grep -q '^==> done' "$OUT/provision.log" || { echo "build.sh: provisioning did not finish; see $OUT/provision.log" >&2; tail -15 "$OUT/provision.log" >&2; exit 1; }

rm -f "$R/usr/sbin/policy-rc.d" "$R/etc/resolv.conf"
rm -rf "$R/opt/desolate-build" "$R/var/lib/apt/lists"/* "$R/var/cache/apt"/*.bin "$R/root/.npm" "$R/root/.cache"
ln -sf ../run/systemd/resolve/stub-resolv.conf "$R/etc/resolv.conf"
umount_all; trap - EXIT

echo "==> rootfs.tar"
tar -C "$R" --numeric-owner --xattrs -cf "$OUT/rootfs.tar" .
rm -rf "$R"

sha() { sha256sum "$1" | cut -d' ' -f1; }
ROOTFS_SHA=$(sha "$OUT/rootfs.tar")
cat >"$OUT/manifest.json" <<M
{
  "arch": "$DEB_ARCH",
  "suite": "$UBUNTU_SUITE",
  "built": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "sha256": {
    "rootfs.tar": "$ROOTFS_SHA"
  }
}
M
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  TAG=desolate/base:${ROOTFS_SHA:0:12}
  # The kernel and its modules are dead weight in a container.
  tar --delete -f "$OUT/rootfs.tar" ./boot ./lib/modules 2>/dev/null || true
  docker import -c 'CMD ["sleep","infinity"]' "$OUT/rootfs.tar" "$TAG" >/dev/null
  docker tag "$TAG" desolate/base:latest
  echo "==> docker image $TAG (also desolate/base:latest)"
fi
echo "==> $OUT/manifest.json"
