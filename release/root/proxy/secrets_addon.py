"""desolate v3: the part of a domain's egress that holds its secrets (section 4.3, Phase 4).

One mitmproxy per domain that has secrets, in the root VM, on the root's loopback. It is
reached only by that domain's workspaces' own proxies (proxy.ts), and only for connections
to a host one of the domain's secrets names. Everything else a workspace sends stays
end-to-end TLS and never comes here.

A workspace never holds a secret's value. It holds the secret's NAME, a placeholder
(MYAPP-OPENAI-KEY), and sends that. This swaps the name for the value on the way out, when
and only when the request is provably going where the secret is allowed to go. The rules
are v2's (release/proxy/vm/addon.py at commit 4f32c77, which this is cut down from; its tests' cases are
tests/v3/t2/07-secrets.test.ts here):

  PROVEN DESTINATION  the TLS SNI, and only the SNI: it is the name mitmproxy validates the
                      upstream certificate against. proxy.ts hands over each connection
                      with the name it checked (x-desolate-host) and the address it
                      resolved and checked; the SNI must be that name, and the upstream is
                      that address. Nothing is resolved a second time here.
  NO PROOF, NO VALUE  plaintext, a Host header that is not the SNI, or two Host headers,
                      while carrying a placeholder: refused.
  ALLOWLIST           a placeholder sent toward a host its secret does not name is passed
                      through UNSUBSTITUTED (the destination learns a name, not a value),
                      and audited.
  HEADERS             a secret with `headers` is substituted in those request headers and
                      nowhere else; without, in the path, the headers and the body.
  SWITCHED OFF        a secret can be switched off, or on for a while (`off`, `until`). A
                      request that carries the name of a secret that is off is refused: the
                      name is not sent in the value's place. A switch that cannot be read
                      is off.
  SCRUB               a value echoed back in a response (headers, body, websocket frames
                      from the server) is replaced by its name before the workspace sees it.
  HELD OR STREAMED    a body is held whole (to look inside it) up to the domain's bound
                      (policy.json's heldMiB, else secrets.heldMiB): that is where a
                      placeholder is put in a body. Past it, or of a length its headers do not
                      fix, a body is streamed: a response with each value taken out as it
                      passes, a request watched for names. A request body over the bound that
                      names a secret is refused, its name masked and its response withheld:
                      to substitute, a body is held, and the bound is what may be.
  FAIL CLOSED         any error in here refuses the request or withholds the response.

Attribution: which workspace a request came from is what proxy.ts says (x-desolate-workspace
on the CONNECT it makes), never anything the workspace says: a workspace's own bytes start
inside the tunnel.
"""
import fnmatch
import hmac
import ipaddress
import json
import logging
import os
import re
import time

from mitmproxy import http

log = logging.getLogger("desolate-secrets")

SETTINGS_PATH = os.environ.get("DESOLATE_SECRETS", "/var/lib/desolate/secrets/unset.json")
POLICY_PATH = os.environ.get("DESOLATE_POLICY", "/var/lib/desolate/proxy/policy/unset.json")
# The domain's audit log: a directory of files every proxy of the domain writes, by the rule
# of root/proxy/audit.ts (its AUDIT, which T1 checks this repeats): append to the newest,
# begin the next by an exclusive create when the newest is over its share, unlink the oldest
# past AUDIT_FILES. No writer renames a file another is writing.
AUDIT_DIR = os.environ.get("DESOLATE_AUDIT", "/var/lib/desolate-proxies/out/unset")
AUDIT_PREFIX, AUDIT_SUFFIX, AUDIT_FILES = "audit-", ".log", 4
AUDIT_FILE = re.compile(r"audit-([1-9][0-9]{0,15})\.log")


def _audit_budget() -> int:
    """The domain's budget, in bytes (proxy.auditMiB, as the root started this proxy)."""
    try:
        return max(1, int(os.environ.get("DESOLATE_PROXY_AUDIT_MIB", ""))) * 1024 * 1024
    except ValueError:
        return 128 * 1024 * 1024


AUDIT_SHARE = max(1, _audit_budget() // AUDIT_FILES)
# The domain's handoff token: this proxy listens on the root VM's loopback, where any user of
# that VM can connect, so it takes a tunnel only from what can read this file (its domain's
# proxies: root/proxy/as-proxy.ts). Read once; unreadable or malformed, nothing is let in.
TOKEN_PATH = os.environ.get("DESOLATE_LINK_TOKEN", "")


def _read_token() -> str:
    try:
        with open(TOKEN_PATH) as handle:
            token = handle.read().strip()
        return token if re.fullmatch(r"[0-9a-f]{64}", token) else ""
    except OSError:
        return ""


LINK_TOKEN = _read_token()

# A secret's placeholder name: root/proxy/secret-store.ts's PLACEHOLDER, which T1 checks this
# repeats. A short one would match ordinary text.
SECRET_NAME = re.compile(r"[A-Z][A-Z0-9_-]{7,63}")
# A workspace's name, as proxy.ts says it: shared/names.ts's SLUG, which T1 checks this repeats.
WORKSPACE_NAME = re.compile(r"[a-z0-9][a-z0-9-]{0,39}")
# How much of a request's path goes in the audit log, in characters: the path is the
# workspace's, and the route is what a person reads in `net log`.
ROUTE_CHARS = 200
HEADER_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9-]*")
GLOB_META = re.compile(r"[*?\[\]]")
# The one wildcard shape that pins a destination: a leading "*." over at least two labels.
PINNED_WILDCARD = re.compile(r"\*\.(?:[^*?\[\]./]+\.)+[^*?\[\]./]+\Z")


def host_pattern_problem(pattern):
    """Why this `hosts` entry cannot pin a destination, or None if it can. (v2, unchanged.)"""
    if not isinstance(pattern, str) or not pattern.strip():
        return "is empty"
    if not GLOB_META.search(pattern):
        return None                      # a literal name pins itself
    if PINNED_WILDCARD.fullmatch(pattern):
        return None
    if not GLOB_META.sub("", pattern).strip("."):
        return "matches every host, so this secret would have no allowlist at all"
    return "puts a wildcard somewhere it cannot be trusted: only '*.<name>.<tld>' is accepted"


# The most of one request or response body held whole, in MiB, unless the domain's policy
# says (heldMiB): secrets.heldMiB, as the root started this proxy (root/proxy/secrets.ts).
def _held_default() -> int:
    try:
        return max(1, int(os.environ.get("DESOLATE_SECRETS_HELD_MIB", "")))
    except ValueError:
        return 256


HELD_DEFAULT_MIB = _held_default()


def fixed_length(message, request):
    """The body's length as the message's headers fix it, or None when they do not: chunked,
    HTTP/2 without a content-length, a response read to its close, or a length that is not
    one number. An HTTP/1 request that says neither has no body."""
    headers = message.headers
    if "chunked" in headers.get("transfer-encoding", "").lower():
        return None
    lengths = headers.get_all("content-length")
    if len(lengths) == 1 and lengths[0].strip().isdigit():
        return int(lengths[0].strip())
    if lengths:
        return None
    return 0 if request and not message.is_http2 else None


def kept_back(data, patterns):
    """Where the end of `data` could begin one of `patterns` (the start of the longest such
    tail), or len(data): what a stream keeps back until its next chunk, so that a pattern cut
    between two chunks is still seen whole."""
    longest = max((len(p) for p in patterns), default=1)
    start = max(0, len(data) - longest + 1)
    best = len(data)
    for first in {p[:1] for p in patterns}:
        at = data.find(first, start)
        while at != -1 and at < best:
            tail = data[at:]
            if any(p.startswith(tail) for p in patterns):
                best = at
                break
            at = data.find(first, at + 1)
    return best


def _chunks(data):
    """What a stream callable answers: a list of chunks to send. Never an empty one: HTTP/1.1
    frames each chunk it is given, and an empty chunk is the end of the body."""
    return [data] if data else []


class _Decoded:
    """A response body's content-encoding, undone as it streams, so that a value in it is
    seen. The client is then sent it decoded (identity): re-encoding needs the stream's end,
    which a stream is not told apart from an empty chunk."""
    def __init__(self, encoding):
        import zlib
        encoding = encoding.strip().lower()
        if encoding in ("", "identity"):
            self.step = lambda data: data
        elif encoding in ("gzip", "x-gzip", "deflate"):
            self.step = zlib.decompressobj(32 + zlib.MAX_WBITS).decompress
        elif encoding == "br":
            import brotli
            self.step = brotli.Decompressor().process
        elif encoding == "zstd":
            import zstandard
            self.step = zstandard.ZstdDecompressor().decompressobj().decompress
        else:
            raise ValueError(f"a content-encoding that cannot be undone here: {encoding!r}")


class Scrub:
    """A response body, streamed with each value taken out and its name put in, as the
    response hook does to a held one. The end of a chunk that could begin a value is kept back
    for the next. Anything that goes wrong withholds the rest (fail closed)."""
    def __init__(self, pairs, encoding=""):
        self.pairs = sorted(((v.encode(), n.encode()) for v, n in pairs), key=lambda p: -len(p[0]))
        self.values = [v for v, _ in self.pairs]
        self.decode = _Decoded(encoding).step
        self.carry = b""
        self.failed = False

    def __call__(self, chunk):
        if self.failed:
            return []
        try:
            data = self.carry + (self.decode(chunk) if chunk else b"")
            for value, name in self.pairs:
                if value in data:
                    data = data.replace(value, name)
            # An empty chunk is the end (or nothing): everything goes.
            cut = kept_back(data, self.values) if chunk else len(data)
            self.carry = data[cut:]
            return _chunks(data[:cut])
        except Exception:
            log.exception("response scrub failed; withholding the rest of it (fail-closed)")
            self.failed = True
            return []


class Watch:
    """A request body that streams, as it goes. `rule(name)` says what a name found in it may
    do: None, go on as it is (a placeholder toward a host its secret does not name), "hold"
    (it is put in: allowed only while the body is held, whole), or a reason it is refused.
    While `holding` (a body of unknown length, under `bound` bytes), the body is kept back and
    given at its end, its names put in by `put`. A refusal masks every name from then on and
    calls `refused(reason, names)`."""
    def __init__(self, names, rule, put, refused, bound, holding, domain):
        self.domain = domain
        self.names = [n.encode() for n in names]
        self.rule, self.put, self.refused = rule, put, refused
        self.bound, self.holding = bound, holding
        self.held, self.carry = b"", b""
        self.found, self.passed = set(), set()
        self.stopped = False

    def _refuse(self, reason, names):
        if not self.stopped:
            self.stopped = True
            self.refused(reason, names)

    def _look(self, data, holding):
        for name in self.names:
            if name not in data:
                continue
            text = name.decode()
            rule = self.rule(text)
            if rule is None:
                self.passed.add(text)
            elif rule == "hold" and holding:
                self.found.add(text)
            else:
                self._refuse(rule if rule != "hold" else
                             f"the request's body is over the {self.bound // (1024 * 1024)} MiB this "
                             f"domain's secrets proxy holds whole, and names {text}: a secret is put "
                             f"only in a body that is held. To hold more: desolate domain {self.domain} net "
                             f"hold <size>", [text])
        if self.stopped:
            for name in self.names:
                data = data.replace(name, b"*" * len(name))
        return data

    def __call__(self, chunk):
        try:
            if self.holding:
                if chunk and len(self.held) + len(chunk) <= self.bound:
                    self.held += chunk
                    return []
                data, self.held, self.holding = self.held + chunk, b"", False
                if not chunk:
                    # The end, held whole: its names are put in, or it is refused.
                    data = self._look(data, True)
                    return [] if self.stopped else _chunks(self.put(data, self.found))
                # Over the bound: from here on it streams, what was held first, and nothing
                # is put in.
                self.found = set()
            else:
                data = chunk
            data = self._look(self.carry + data, False)
            cut = kept_back(data, self.names) if chunk else len(data)
            self.carry = data[cut:]
            return _chunks(data[:cut])
        except Exception:
            log.exception("request body watch failed; refusing the request (fail-closed)")
            self._refuse("internal error; request refused", [])
            return []


class DesolateSecrets:
    def __init__(self):
        self.secrets = {}
        self.internal = set()
        self.held = HELD_DEFAULT_MIB * 1024 * 1024
        self.domain = ""
        self._mtime = None
        self._policy_mtime = None
        # client connection id -> what proxy.ts said when it opened the tunnel
        self.tunnels = {}
        # the audit file this writer appends to (0: look for the newest)
        self._audit_n = 0

    # ---------------------------------------------------------------- settings
    def _maybe_reload(self):
        try:
            mtime = os.stat(SETTINGS_PATH).st_mtime_ns
        except OSError:
            if self.secrets:
                log.error("the secrets file is gone; holding no secrets")
            self.secrets, self._mtime = {}, None
            return
        if mtime != self._mtime:
            try:
                with open(SETTINGS_PATH) as handle:
                    cfg = json.load(handle)
            except (OSError, ValueError) as error:
                # A file that cannot be read is not the last good file: no secrets.
                log.error(f"cannot read {SETTINGS_PATH}: {error}; holding no secrets")
                self.secrets, self._mtime = {}, mtime
                return
            self.domain = str(cfg.get("domain", ""))
            secrets = {}
            for name, entry in (cfg.get("secrets") or {}).items():
                value, hosts, headers = entry.get("value"), entry.get("hosts"), entry.get("headers")
                if not SECRET_NAME.fullmatch(name) or not isinstance(value, str) or not value:
                    log.error(f"secret {name!r}: no usable name or value; skipping")
                    continue
                if not isinstance(hosts, list) or not hosts or any(host_pattern_problem(h) for h in hosts):
                    log.error(f"secret {name!r}: its hosts do not pin a destination; skipping")
                    continue
                if headers is not None and (not isinstance(headers, list) or not headers
                                            or not all(isinstance(h, str) and HEADER_NAME.fullmatch(h) for h in headers)):
                    log.error(f"secret {name!r}: its headers cannot be read; skipping (a confinement that cannot be read is not widened)")
                    continue
                off, until = entry.get("off", False), entry.get("until")
                if not isinstance(off, bool) or (until is not None and (isinstance(until, bool) or not isinstance(until, (int, float)))):
                    log.error(f"secret {name!r}: off {off!r} / until {until!r} cannot be read; holding it OFF")
                    off, until = True, None
                secrets[name] = {"value": value, "hosts": [h.lower() for h in hosts],
                                 "headers": None if headers is None else frozenset(h.lower() for h in headers),
                                 "off": off, "until": until}
            for name in self._overlapping(secrets):
                del secrets[name]
            self.secrets, self._mtime = secrets, mtime
        try:
            policy_mtime = os.stat(POLICY_PATH).st_mtime_ns
        except OSError:
            self.internal, self._policy_mtime = set(), None
            self.held = HELD_DEFAULT_MIB * 1024 * 1024
            return
        if policy_mtime != self._policy_mtime:
            try:
                with open(POLICY_PATH) as handle:
                    policy = json.load(handle)
                self.internal = {str(a) for a in (policy.get("internal") or [])}
                held = policy.get("heldMiB")
                self.held = (held if isinstance(held, int) and not isinstance(held, bool) and held > 0
                             else HELD_DEFAULT_MIB) * 1024 * 1024
            except (OSError, ValueError, AttributeError):
                self.internal, self.held = set(), HELD_DEFAULT_MIB * 1024 * 1024
            self._policy_mtime = policy_mtime

    def is_on(self, name):
        entry = self.secrets[name]
        return not entry["off"] and (entry["until"] is None or time.time() < entry["until"])

    @staticmethod
    def _overlapping(secrets):
        """Names that contain, or are contained by, another. Both go: neither can be
        substituted unambiguously. (v2, unchanged.)"""
        names = sorted(secrets)
        overlapping = set()
        for index, name in enumerate(names):
            for other in names[index + 1:]:
                if name in other or other in name:
                    log.error(f"placeholders {name!r} and {other!r} overlap; dropping both")
                    overlapping.update((name, other))
        return overlapping

    # ---------------------------------------------------------------- what a request proves
    @staticmethod
    def _host_matches(host, patterns):
        host = (host or "").lower()
        return any(fnmatch.fnmatch(host, p) for p in patterns)

    @staticmethod
    def proven_host(flow):
        sni = getattr(flow.client_conn, "sni", None)
        return sni.lower() if sni else None

    @staticmethod
    def destination_address(flow):
        candidates = [getattr(flow.request, "host", None)]
        conn = getattr(flow, "server_conn", None)
        for attribute in ("peername", "address"):
            value = getattr(conn, attribute, None) if conn is not None else None
            if isinstance(value, (tuple, list)) and value:
                candidates.append(value[0])
        for candidate in candidates:
            if not isinstance(candidate, str) or not candidate:
                continue
            try:
                return ipaddress.ip_address(candidate.strip("[]"))
            except ValueError:
                continue
        return None

    @staticmethod
    def is_internal(address):
        if address is None:
            return True                  # an upstream that is not an address is not a checked one
        mapped = getattr(address, "ipv4_mapped", None)
        if mapped is not None:
            address = mapped
        return (not address.is_global or address.is_private or address.is_loopback
                or address.is_link_local or address.is_multicast
                or address.is_reserved or address.is_unspecified)

    @staticmethod
    def _without_port(raw):
        raw = raw.strip()
        if raw.startswith("["):
            return raw.split("]", 1)[0][1:].lower()
        if raw.count(":") == 1:
            raw = raw.rsplit(":", 1)[0]
        return raw.lower()

    @classmethod
    def claimed_names(cls, flow):
        """Every name the request itself gives as its destination: each Host header, and
        HTTP/2's :authority."""
        names = []
        authority = getattr(flow.request, "authority", "") or ""
        if authority.strip():
            names.append(cls._without_port(authority))
        for value in flow.request.headers.get_all("host"):
            if value and value.strip():
                names.append(cls._without_port(value))
        return names

    @staticmethod
    def _block(flow, code, msg):
        flow.response = http.Response.make(code, f"desolate: {msg}\n".encode(), {"content-type": "text/plain"})

    def audit(self, flow, verdict, host, secrets=(), reason=None):
        tunnel = self.tunnels.get(flow.client_conn.id, {})
        entry = {"time": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z", "domain": self.domain,
                 "workspace": tunnel.get("workspace", "?"), "host": host, "port": 443, "verdict": verdict,
                 "method": flow.request.method, "route": flow.request.path.split("?", 1)[0][:ROUTE_CHARS]}
        if secrets:
            entry["secrets"] = sorted(secrets)   # names, never values
        if reason:
            entry["reason"] = reason
        self._audit_write(json.dumps(entry) + "\n")

    def _audit_newest(self):
        try:
            numbers = [int(m.group(1)) for m in map(AUDIT_FILE.fullmatch, os.listdir(AUDIT_DIR)) if m]
        except OSError:
            return 0
        return max(numbers, default=0)

    def _audit_begin(self, n):
        """Begins file `n` if no writer has (an exclusive create), and lets go what is past the
        budget: the files numbered n - AUDIT_FILES and before, and the two from before the
        series (audit.log, audit.log.1), which count as 0."""
        try:
            os.close(os.open(os.path.join(AUDIT_DIR, f"{AUDIT_PREFIX}{n}{AUDIT_SUFFIX}"),
                             os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644))
        except OSError:
            pass                         # another writer began it first: it is there
        try:
            names = os.listdir(AUDIT_DIR)
        except OSError:
            return
        for name in names:
            match = AUDIT_FILE.fullmatch(name)
            older = int(match.group(1)) if match else 0 if name in ("audit.log", "audit.log.1") else None
            if older is not None and older <= n - AUDIT_FILES:
                try:
                    os.unlink(os.path.join(AUDIT_DIR, name))
                except OSError:
                    pass

    def _audit_write(self, line):
        """A line that cannot be written (a full disk) is lost, and logged: a workspace sending
        requests refused here, as fast as it can, must not fill the root's disk, and the
        request is decided as it was (audit, 2026-11-20)."""
        try:
            for _ in range(2):
                if self._audit_n == 0:
                    self._audit_n = self._audit_newest()
                    if self._audit_n == 0:
                        self._audit_n = 1
                        self._audit_begin(1)
                try:
                    # Never made here: a file another writer let go is not begun again.
                    fd = os.open(os.path.join(AUDIT_DIR, f"{AUDIT_PREFIX}{self._audit_n}{AUDIT_SUFFIX}"),
                                 os.O_WRONLY | os.O_APPEND)
                except FileNotFoundError:
                    self._audit_n = 0
                    continue
                try:
                    os.write(fd, line.encode())
                    if os.fstat(fd).st_size > AUDIT_SHARE:
                        self._audit_n += 1
                        self._audit_begin(self._audit_n)
                finally:
                    os.close(fd)
                return
        except OSError as error:
            log.error(f"cannot write the audit log: {error}")

    def _in_its_headers(self, flow, name):
        allowed = self.secrets[name]["headers"]
        return any(name in v for k, v in flow.request.headers.items(multi=True) if k.lower() in allowed)

    def _unconfined(self):
        return [n for n, e in self.secrets.items() if e["headers"] is None]

    def _placeholders(self, flow, body):
        if not self.secrets:
            return set()
        confined = {n for n, e in self.secrets.items() if e["headers"] is not None}
        found = {n for n in confined if self._in_its_headers(flow, n)}
        rest = [n for n in self.secrets if n not in confined]
        if rest:
            url = flow.request.url
            headers = "\n".join(f"{k}: {v}" for k, v in flow.request.headers.items(multi=True))
            found |= {n for n in rest if n in url or n in headers or n.encode() in body}
        return found

    # ---------------------------------------------------------------- hooks
    def http_connect(self, flow: http.HTTPFlow):
        """proxy.ts opening a tunnel for one workspace's connection."""
        try:
            given = flow.request.headers.get("x-desolate-token", "")
            if not LINK_TOKEN or not hmac.compare_digest(given.encode(), LINK_TOKEN.encode()):
                return self._block(flow, 403, "this proxy is reached only through its own domain's workspaces' proxies")
            # Not passed on: the upstream never sees desolate's own headers.
            del flow.request.headers["x-desolate-token"]
            workspace = flow.request.headers.get("x-desolate-workspace", "")
            host = flow.request.headers.get("x-desolate-host", "").lower()
            if not WORKSPACE_NAME.fullmatch(workspace) or not host or flow.request.port != 443:
                return self._block(flow, 403, "this proxy is reached only through a workspace's own proxy")
            self.tunnels[flow.client_conn.id] = {"workspace": workspace, "host": host}
        except Exception:
            log.exception("http_connect failed; refusing the tunnel (fail-closed)")
            self._block(flow, 502, "internal error; tunnel refused")

    def client_disconnected(self, client):
        self.tunnels.pop(client.id, None)

    def _route(self, flow):
        """The checks of where a request goes, before anything of it is looked at: the tunnel,
        the TLS name, the address. (proven, None), or (shown, why it is refused)."""
        tunnel = self.tunnels.get(flow.client_conn.id)
        proven = self.proven_host(flow)
        if tunnel is None:
            return None, "this proxy is reached only through a workspace's own proxy"
        shown = proven or tunnel["host"]
        # The tunnel was opened, checked and resolved for one name. It speaks TLS for that
        # name, or it carries nothing.
        if proven is None:
            return shown, "this connection is not TLS, so its destination cannot be proven"
        if proven != tunnel["host"]:
            return shown, f"this connection was opened for {tunnel['host']}, not for {proven}"
        destination = self.destination_address(flow)
        if self.is_internal(destination) and str(destination) not in self.internal:
            return shown, f"{destination} is an internal address, which a workspace is not carried to"
        return proven, None

    def _verdict(self, flow, proven, found):
        """What may be done with a request that carries the placeholders `found`: (reason,
        names) when it is refused, else (None, the names to put in, the names passed as they
        are toward a host their secret does not name)."""
        if found:
            claims = self.claimed_names(flow)
            if len(flow.request.headers.get_all("host")) > 1 or any(name != proven for name in claims):
                return (f"the request names {sorted(set(claims))} as its destination, not only the TLS destination "
                        f"'{proven}'; refusing to substitute a secret", found), set(), set()
        suspect = {name for name in found if not self._host_matches(proven, self.secrets[name]["hosts"])}
        found = found - suspect
        switched_off = sorted(name for name in found if not self.is_on(name))
        if switched_off:
            return (f"secret {switched_off} is switched off; on the host: "
                    f"desolate domain {self.domain} secret on {switched_off[0]} [--ttl 30m]", switched_off), set(), set()
        return None, found, suspect

    def _put_in_head(self, flow, found):
        """Each placeholder in `found` replaced by its value in the request's headers (only
        those its secret names, when it names some) and in its path."""
        for name in found:
            value, allowed = self.secrets[name]["value"], self.secrets[name]["headers"]
            if allowed is None and name in flow.request.path:
                flow.request.path = flow.request.path.replace(name, value)
            for k, v in list(flow.request.headers.items(multi=True)):
                if (allowed is None or k.lower() in allowed) and name in v:
                    flow.request.headers[k] = v.replace(name, value)

    def _put_in_body(self, body, found):
        for name in found:
            if self.secrets[name]["headers"] is None and name.encode() in body:
                body = body.replace(name.encode(), self.secrets[name]["value"].encode())
        return body

    def _audit_done(self, flow, proven, found, suspect):
        if suspect:
            self.audit(flow, "leak-suspect", proven, suspect, "a placeholder was sent toward a host its secret does not name; passed unsubstituted")
        if found:
            self.audit(flow, "substituted", proven, found)
        elif not suspect:
            self.audit(flow, "allowed", proven)

    def requestheaders(self, flow: http.HTTPFlow):
        """A request whose body is not held: over the bound, or of a length its headers do not
        fix. Its head is decided here, before it is sent, and its body watched as it goes
        (Watch). A refusal here kills the flow: a request that streams cannot be answered
        instead, and its body is not read."""
        try:
            self._maybe_reload()
            size = fixed_length(flow.request, True)
            if size is not None and size <= self.held:
                return  # held whole: the request hook decides it, as it always has
            state = {"refused": False, "found": set(), "suspect": set()}
            flow.metadata["desolate-stream"] = state

            def refuse(shown, reason, names=()):
                state["refused"] = True
                self.audit(flow, "refused", shown, names, reason)
                if flow.killable:
                    flow.kill()

            proven, why = self._route(flow)
            if why:
                return refuse(proven, why)
            encoding = flow.request.headers.get("content-encoding", "").strip().lower()
            if encoding not in ("", "identity"):
                return refuse(proven, f"the request's body is {encoding}-encoded and is not held whole "
                              f"(over the bound, or of no fixed length), so what it carries cannot be seen")
            head = self._placeholders(flow, b"")
            refusal, found, suspect = self._verdict(flow, proven, head)
            if refusal:
                return refuse(proven, *refusal)
            self._put_in_head(flow, found)
            state["found"], state["suspect"] = set(found), set(suspect)

            def rule(name):
                refusal, put, _ = self._verdict(flow, proven, head | {name})
                return refusal[0] if refusal else "hold" if name in put else None

            def put(body, names):
                state["found"] |= names
                return self._put_in_body(body, names)

            def refused(reason, names):
                refuse(proven, reason, names)

            flow.request.stream = Watch(self._unconfined(), rule, put, refused, self.held,
                                        holding=size is None, domain=self.domain)
            state["watch"] = flow.request.stream
        except Exception:
            log.exception("request handling failed; refusing the request (fail-closed)")
            flow.metadata["desolate-stream"] = {"refused": True}
            if flow.killable:
                flow.kill()

    def request(self, flow: http.HTTPFlow):
        try:
            state = flow.metadata.get("desolate-stream")
            if state is not None:
                # Streamed: decided as it went. What it carried is audited now that it is done.
                if not state["refused"]:
                    watch = state.get("watch")
                    passed = watch.passed if watch else set()
                    self._audit_done(flow, self.proven_host(flow), state["found"], state["suspect"] | passed)
                return
            self._request(flow)
        except Exception:
            log.exception("request handling failed; refusing the request (fail-closed)")
            if flow.metadata.get("desolate-stream") is None:
                self._block(flow, 502, "internal error; request refused")

    def _request(self, flow: http.HTTPFlow):
        """A request held whole: decided, its names put in, and audited, before it is sent."""
        self._maybe_reload()
        proven, why = self._route(flow)
        refuse = lambda reason, secrets=(): (self.audit(flow, "refused", proven, secrets, reason), self._block(flow, 403, reason))
        if why:
            if proven is None:
                return self._block(flow, 403, why)
            return refuse(why)
        body = flow.request.content or b""
        refusal, found, suspect = self._verdict(flow, proven, self._placeholders(flow, body))
        if refusal:
            return refuse(*refusal)
        self._put_in_head(flow, found)
        substituted = self._put_in_body(body, found)
        if substituted is not body:
            flow.request.content = substituted
        self._audit_done(flow, proven, found, suspect)

    def _scrub_fields(self, fields):
        for name, entry in self.secrets.items():
            value = entry["value"]
            for k, v in list(fields.items(multi=True)):
                if value in v:
                    fields[k] = v.replace(value, name)

    def responseheaders(self, flow: http.HTTPFlow):
        """A response's head, scrubbed before it is sent; and its body streamed through Scrub
        when it is not held (over the bound, or of a length its headers do not fix). A
        streamed body may change length as values are taken out, so its length goes from its
        head, and HTTP/1.1 carries it chunked."""
        try:
            if not flow.response:
                return
            self._scrub_fields(flow.response.headers)
            size = fixed_length(flow.response, False)
            if size is not None and size <= self.held:
                return  # held whole: the response hook scrubs it, as it always has
            code = flow.response.status_code
            if flow.request.method.upper() == "HEAD" or code < 200 or code in (204, 304):
                return  # no body follows, whatever its head says
            encoding = flow.response.headers.get("content-encoding", "")
            flow.response.stream = Scrub([(e["value"], n) for n, e in self.secrets.items()], encoding)
            flow.metadata["desolate-streamed-response"] = True
            if encoding.strip().lower() not in ("", "identity"):
                del flow.response.headers["content-encoding"]
            if "content-length" in flow.response.headers:
                del flow.response.headers["content-length"]
            # The client's HTTP/1.1 (what it asked with) frames it in chunks; HTTP/2 needs no
            # length, and an HTTP/1.0 client reads to the close.
            if flow.request.http_version == "HTTP/1.1":
                flow.response.headers["transfer-encoding"] = "chunked"
        except Exception:
            log.exception("response handling failed; withholding the response (fail-closed)")
            if flow.killable:
                flow.kill()

    def response(self, flow: http.HTTPFlow):
        try:
            if not flow.response or not self.secrets:
                return
            trailers = getattr(flow.response, "trailers", None)
            if trailers:
                self._scrub_fields(trailers)
            if flow.metadata.get("desolate-streamed-response"):
                return  # its head and body were scrubbed as they went
            self._scrub_fields(flow.response.headers)
            body = flow.response.content or b""
            scrubbed = body
            for name, entry in self.secrets.items():
                bvalue = entry["value"].encode()
                if bvalue in scrubbed:
                    scrubbed = scrubbed.replace(bvalue, name.encode())
            if scrubbed is not body:
                flow.response.content = scrubbed
        except Exception:
            log.exception("response scrub failed; withholding the response (fail-closed)")
            self._block(flow, 502, "internal error; response withheld")

    def websocket_message(self, flow: http.HTTPFlow):
        messages = getattr(getattr(flow, "websocket", None), "messages", None)
        try:
            self._maybe_reload()
            if not messages or not self.secrets:
                return
            message = messages[-1]
            if message.from_client:
                return  # outbound frames are never substituted into: a placeholder stays a placeholder
            content = message.content
            scrubbed = content
            for name, entry in self.secrets.items():
                bvalue = entry["value"].encode()
                if bvalue in scrubbed:
                    scrubbed = scrubbed.replace(bvalue, name.encode())
            if scrubbed is not content:
                message.content = scrubbed
        except Exception:
            log.exception("websocket scrub failed; dropping the message (fail-closed)")
            if messages:
                messages[-1].drop()


addons = [DesolateSecrets()]
