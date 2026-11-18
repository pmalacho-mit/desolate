#!/bin/bash
# A workspace VM's network, as seen from inside. Run as root by workspace/start.sh.
#   up.sh <link>        link: unix:/path  or  tcp:host:port   (the workspace's link to its proxy)
#
# Convenience, not a boundary (P5): every name resolves to a placeholder address, ports 80 and
# 443 are redirected to the egress relay, and the relay asks the proxy over the link. A
# program needs no proxy settings. Remove all of it and the VM still reaches nothing but its
# link: the backend sees to that from outside.
set -euo pipefail
LINK=${1:?usage: up.sh <link>}
HERE=$(cd "$(dirname "$0")" && pwd)
PLACEHOLDER=198.18.0.1   # RFC 2544's benchmarking range: never a real destination

# With no interface but loopback (the fake backend) there is no route for a connection to
# take to the redirect. Declaring every address local to loopback gives it one, with no
# kernel module and nothing leaving. (A plain default route through lo is not enough: the
# redirected connection never completes. Measured.)
ip route show default | grep -q . || ip route replace local default dev lo

# Names: one answer for every question. The proxy resolves the real name, outside. It
# listens on every address of this VM, not only loopback: a container on one of the VM's
# docker bridges asks whatever resolver it was given, the redirect below brings the
# question to the bridge's own address, and the answer must come from there.
systemctl disable --now systemd-resolved >/dev/null 2>&1 || true
alive() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }
if ! alive /run/desolate/dnsmasq.pid; then
  dnsmasq --conf-file=/dev/null --pid-file=/run/desolate/dnsmasq.pid --no-resolv --no-hosts \
    --address="/#/$PLACEHOLDER" --local-ttl=60 --user=root
fi
# A symlink (systemd's stub) is replaced; a file that cannot be replaced (a container's bind
# mount) is written in place.
[ -L /etc/resolv.conf ] && rm -f /etc/resolv.conf
printf 'nameserver 127.0.0.1\n' >/etc/resolv.conf

# Ports 80 and 443 go to the relay unless they are for this VM itself: its loopback, and the
# private ranges its docker networks take their addresses from. A container's published port
# is docker-proxy connecting to the container's address, port 80 often; a compose service
# reaches another by its address. Sent to the relay, those were refused as "an address alone"
# (2026-11-18, docs/incidents.md). Nothing the relay could carry is lost: every name resolves
# to the placeholder, which is not private, and the proxy carries by name only.
nft -f - <<N
table ip desolate
delete table ip desolate
table ip desolate {
  set here {
    type ipv4_addr; flags interval;
    elements = { 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16 }
  }
  chain output {
    type nat hook output priority -100;
    ip daddr @here return
    tcp dport 443 redirect to :15443
    tcp dport 80 redirect to :15080
  }
  chain prerouting {
    type nat hook prerouting priority -100;
    udp dport 53 redirect to :53
    tcp dport 53 redirect to :53
    ip daddr @here return
    tcp dport 443 redirect to :15443
    tcp dport 80 redirect to :15080
  }
}
N

# Started again when its link, or its code (the link's handshake lives in shared/link.ts),
# has changed.
RELAY="$LINK $(cat "$HERE/egress.ts" "$HERE/../../shared/link.ts" "$HERE/../../shared/sniff.ts" | sha256sum | cut -c1-16)"
if ! alive /run/desolate/egress.pid || [ "$(cat /run/desolate/link 2>/dev/null)" != "$RELAY" ]; then
  alive /run/desolate/egress.pid && kill "$(cat /run/desolate/egress.pid)" 2>/dev/null || true
  setsid node --disable-warning=ExperimentalWarning "$HERE/egress.ts" "$LINK" >>/var/lib/desolate/egress.log 2>&1 </dev/null &
  echo $! >/run/desolate/egress.pid
  echo "$RELAY" >/run/desolate/link
fi
