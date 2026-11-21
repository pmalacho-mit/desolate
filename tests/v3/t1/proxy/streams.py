# T1 (run by tests/v3/t1/proxy.test.ts): the add-on's streams, without mitmproxy. A value or a
# placeholder cut at any place between two chunks is still seen whole; a request body that
# names a secret past the bound is refused, and one held whole gets its value.
import os, sys, types

stub = types.ModuleType("mitmproxy")
stub.http = types.ModuleType("mitmproxy.http")
stub.http.HTTPFlow = object
sys.modules["mitmproxy"], sys.modules["mitmproxy.http"] = stub, stub.http
sys.path.insert(0, sys.argv[1])
import secrets_addon as a  # noqa: E402

VALUE, NAME = "s3cr3t-value-0f9e8d7c", "MYAPP-API-KEY"
body = b"x" * 50 + VALUE.encode() + b"y" * 50
want = body.replace(VALUE.encode(), NAME.encode())
for cut in range(len(body) + 1):
    for parts in ([body[:cut], body[cut:]], [body[:cut], b"", body[cut:]]):
        s = a.Scrub([(VALUE, NAME)])
        out = b"".join(b"".join(s(p)) for p in parts if p) + b"".join(s(b""))
        assert out == want, (cut, out)
# control: the value is there to be taken out
assert VALUE.encode() in body

import gzip, zlib
packed = gzip.compress(body * 100)
s = a.Scrub([(VALUE, NAME)], "gzip")
out = b"".join(b"".join(s(packed[i:i + 7])) for i in range(0, len(packed), 7)) + b"".join(s(b""))
assert out == want * 100, "a gzip body is undone and scrubbed"

def watch(chunks, bound, holding, rule):
    refused, put = [], []
    w = a.Watch([NAME], rule, lambda data, names: (put.append(names), data.replace(NAME.encode(), VALUE.encode()))[1],
                lambda reason, names: refused.append(reason), bound, holding, "acme")
    out = b"".join(b"".join(w(c)) for c in chunks if c) + b"".join(w(b""))
    return out, refused, put

named = b"a" * 30 + NAME.encode() + b"b" * 30
for cut in range(len(named) + 1):
    # streamed (fixed length, over the bound): a name that would be put in is refused, masked
    out, refused, _ = watch([named[:cut], named[cut:]], 10, False, lambda n: "hold")
    assert refused and NAME.encode() not in out and len(out) == len(named), (cut, out)
    # held whole (no fixed length, under the bound): the value is put in
    out, refused, put = watch([named[:cut], named[cut:]], 1000, True, lambda n: "hold")
    assert not refused and out == named.replace(NAME.encode(), VALUE.encode()), (cut, out)
    # a placeholder toward a host its secret does not name: passed as it is
    out, refused, _ = watch([named[:cut], named[cut:]], 10, False, lambda n: None)
    assert not refused and out == named, cut
# held, then over the bound: streams from the start, the held part first, and refuses a name
out, refused, _ = watch([b"z" * 8, b"z" * 8, named], 12, True, lambda n: "hold")
assert refused and out.startswith(b"z" * 16) and NAME.encode() not in out
# control: under the bound the same body is held and gets its value
out, refused, _ = watch([b"z" * 8, b"z" * 8, named], 1000, True, lambda n: "hold")
assert not refused and VALUE.encode() in out
# a body that names nothing streams whole, at any bound
out, refused, _ = watch([b"q" * 100, b"r" * 100], 10, True, lambda n: "hold")
assert not refused and out == b"q" * 100 + b"r" * 100
# An empty chunk in the middle of a body of fixed length (an empty HTTP/2 DATA frame) is not
# its end: a value cut there is still taken out whole.
s = a.Scrub([(VALUE, NAME)], "", len(body))
out = b"".join(b"".join(s(p)) for p in (body[:60], b"", body[60:], b""))
assert out == want, out
# control: without a fixed length the empty chunk is taken for the end, and the cut value goes
s = a.Scrub([(VALUE, NAME)], "", None)
out = b"".join(b"".join(s(p)) for p in (body[:60], b"", body[60:], b""))
assert out != want
# the same for a request body: an empty chunk does not end what is held
out, refused, put = [], [], []
w = a.Watch([NAME], lambda n: "hold", lambda d, n: d.replace(NAME.encode(), VALUE.encode()),
            lambda r, n: refused.append(r), 1000, True, "acme", size=len(named))
out = b"".join(b"".join(w(c)) for c in (named[:40], b"", named[40:], b""))
assert not refused and out == named.replace(NAME.encode(), VALUE.encode()), out

# A body that undoes to more than the bound is refused, not undone: a few KiB of gzip of zeros
# stand for many MiB.
bomb = gzip.compress(b"\0" * (64 * 1024 * 1024))
assert len(bomb) < 128 * 1024
try:
    a.decoded(bomb, "gzip", 8 * 1024 * 1024)
    raise AssertionError("a body undone past the bound was undone")
except ValueError as error:
    assert "over the 8 MiB" in str(error), error
assert len(a.decoded(bomb, "gzip", 64 * 1024 * 1024)) == 64 * 1024 * 1024, "control: under it, whole"
s = a.Scrub([(VALUE, NAME)], "gzip", None, 8 * 1024 * 1024)
assert s(bomb) == [] and s.failed, "streamed, it is withheld"
# deflate without its zlib header (what some servers send) is undone too
raw = zlib.compressobj(wbits=-15)
assert a.decoded(raw.compress(body) + raw.flush(), "deflate", 1 << 20) == body
print("ok")
