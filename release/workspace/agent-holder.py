"""A program kept running in its workspace, attachable from your own terminal: what
`desolate agent` holds. Any long-running command (a coding agent, a dev server, a watcher, a
long test run); "agent" is only the command's name.

  python3 -I agent-holder.py start <name> <dir> [--log-most <bytes>] -- <command...>   (detaches; prints its state)
  python3 -I agent-holder.py attach <name>                          (the host's `desolate agent attach`)
  python3 -I agent-holder.py log <name> [--all | --lines <n> | --since <unix time>]
  python3 -I agent-holder.py list
  python3 -I agent-holder.py stop <name> [--kill] [--wait]

Why not tmux: tmux owns the screen, so scrolling and copying are its own (mouse modes
that take one away to give the other). Here the agent's terminal is a pty this holder keeps;
attaching streams it to YOUR terminal, after replaying the end of its log, so your
terminal's own scrollback, selection and copy work as they do for anything else.

The command runs where `desolate exec` runs it (enter.sh: the project's devcontainer, else
the VM). What it prints is kept in its log, ~/.desolate-agents/<name>.log.<offset>: segments,
each named by how many bytes the agent had printed before it, so a segment is never renamed,
only made and dropped. The log keeps the newest: past its most (`--log-most`, which the host
sets from its setting agent.logMiB; else a twentieth of the disk it is on) the oldest segment
is dropped, and `log` says where older output was dropped and how much. <name>.times says when
output came (one line per 5 s of it, at most), for `log --since`. When the agent ends, so does
its holder; its log is read for as long as it is there (`attach` replays it, `log` reads it).

The socket is this user's alone (0600, in a 0700 directory): an agent can attach to nothing
but what already runs as it.

Attach protocol, one line each way per message from the client: "i <base64>" input,
"r <cols> <rows>" a size, "k" Ctrl-C (twice, as a person ends most programs), "K" kill (the
agent's process group, at once). The holder sends the terminal's bytes, raw, and closes the
connection when the agent ends. A holder started before this one (one log file,
<name>.log, cut at 64 MiB, and a replay of its own) speaks the same protocol but for "K",
which it ignores (it kills 3 s after "k"); everything here but the holding itself is this
file, run anew, so it still lists, reads, attaches to and stops such an agent.
"""
import base64
import fcntl
import json
import os
import pty
import re
import select
import signal
import socket
import struct
import sys
import termios
import time

HOME = os.path.expanduser("~")
STATE = os.path.join(HOME, ".desolate-agents")
RUN = os.path.join(os.environ.get("XDG_RUNTIME_DIR") or os.path.join(HOME, ".desolate-agents"), "sockets")
ENTER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "enter.sh")
NAME_OK = set("abcdefghijklmnopqrstuvwxyz0123456789-")
# A name, in characters: shared/limits.ts NAMES.slug, the host's rule for the same name
# (host/agent.ts checks it with names.ts's SLUG). This file cannot import TypeScript;
# tests/v3/t1/agent-holder.test.ts checks that the two agree.
NAME_MOST = 40
# A size an attached terminal may ask for: shared/limits.ts TERMINAL (checked as NAME_MOST is).
COLS_MOST = 1000
ROWS_MOST = 500
# What a new attach is sent of the log before the live stream: its last 2 MiB, about 25,000
# lines of 80 characters, more than a terminal keeps to scroll back through (Terminal.app's
# and iTerm2's defaults are 10,000 lines and fewer). The rest is in `desolate agent log`, and
# the replay says so when it does not start at the log's start.
REPLAY = 2 * 1024 * 1024
# A log is this many segments: dropping the oldest leaves at least seven eighths of the most.
SEGMENTS = 8
# How often lastOutput is written to the state file, and a line to <name>.times: while it
# prints, every 5 s. `log --since` is as exact as this.
TICK = 5
# The second Ctrl-C of a stop: as a person presses it again. Claude Code, among others, ends
# on a second Ctrl-C within a moment of the first, and takes one alone as "interrupt".
AGAIN = 0.3
SEGMENT = re.compile(r"^(.+)\.log\.([0-9]+)$")


def checked(name):
    if not name or len(name) > NAME_MOST or not set(name) <= NAME_OK or name[0] == "-":
        sys.exit(f"agent-holder: a name is lower-case letters, digits and dashes, at most {NAME_MOST}")
    return name


def paths(name):
    return os.path.join(RUN, name + ".sock"), os.path.join(STATE, name + ".json"), os.path.join(STATE, name + ".times")


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def read_state(name):
    try:
        with open(paths(name)[1]) as f:
            return json.load(f)
    except Exception:
        return {}


def write_state(agent, **fields):
    _, state, _ = paths(agent)
    current = read_state(agent)
    current.update(fields)
    tmp = state + ".tmp"
    with open(tmp, "w") as f:
        json.dump(current, f)
    os.replace(tmp, state)


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def segments(name):
    """The log's segments, oldest first, as (offset, path). An agent whose holder is from
    before segments has one file, <name>.log: one segment, at 0."""
    found = []
    try:
        entries = os.listdir(STATE)
    except OSError:
        entries = []
    for entry in entries:
        m = SEGMENT.match(entry)
        if m and m.group(1) == name:
            found.append((int(m.group(2)), os.path.join(STATE, entry)))
    found.sort()
    legacy = os.path.join(STATE, name + ".log")
    if not found and os.path.exists(legacy):
        found = [(0, legacy)]
    return found


class Log:
    """The writing end: the holder's alone. Appends to the newest segment, starts another
    when it is full, and drops the oldest while the whole is over `most`."""

    def __init__(self, name, most):
        self.name = name
        self.most = most
        self.part = max(1, most // SEGMENTS)
        legacy = os.path.join(STATE, name + ".log")
        if os.path.exists(legacy) and not any(p != legacy for _, p in segments(name)):
            # An earlier run's log, from a holder before segments: the start of this one.
            os.replace(legacy, os.path.join(STATE, name + ".log.0"))
        self.parts = [(offset, os.path.getsize(path)) for offset, path in segments(name)]
        if not self.parts:
            self.parts = [(0, 0)]
        offset, size = self.parts[-1]
        self.file = open(self.path(offset), "ab", buffering=0)
        self.times = open(paths(name)[2], "a", buffering=1)
        self.drop()

    def path(self, offset):
        return os.path.join(STATE, f"{self.name}.log.{offset}")

    def end(self):
        offset, size = self.parts[-1]
        return offset + size

    def write(self, data):
        offset, size = self.parts[-1]
        if size >= self.part:
            self.file.close()
            offset, size = offset + size, 0
            self.parts.append((offset, 0))
            self.file = open(self.path(offset), "ab", buffering=0)
            self.drop()
        self.file.write(data)
        self.parts[-1] = (offset, size + len(data))

    def when(self, at):
        """Output that follows came at `at` (unix time)."""
        self.times.write(f"{int(at)} {self.end()}\n")

    def drop(self):
        dropped = False
        while len(self.parts) > 1 and sum(size for _, size in self.parts) > self.most:
            offset, _ = self.parts.pop(0)
            try:
                os.unlink(self.path(offset))
            except OSError:
                pass
            dropped = True
        if dropped:
            # Times of output no longer kept go too: the file stays as small as the log.
            first = self.parts[0][0]
            self.times.close()
            times = paths(self.name)[2]
            kept = [(at, offset) for at, offset in read_times(self.name) or [] if offset >= first]
            with open(times + ".tmp", "w") as f:
                f.writelines(f"{at} {offset}\n" for at, offset in kept)
            os.replace(times + ".tmp", times)
            self.times = open(times, "a", buffering=1)


def read_times(name):
    """<name>.times, as (unix time, offset); None when there is none (a holder from before)."""
    try:
        with open(paths(name)[2]) as f:
            out = []
            for line in f:
                parts = line.split()
                if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
                    out.append((int(parts[0]), int(parts[1])))
            return out
    except OSError:
        return None


def opened(name):
    """The log's segments, open, as (offset, file, size): once open, a segment the holder
    drops meanwhile is still read whole. One dropped between the listing and its opening is
    listed again."""
    for _ in range(SEGMENTS + 1):
        parts = []
        try:
            for offset, path in segments(name):
                f = open(path, "rb")
                parts.append((offset, f, os.fstat(f.fileno()).st_size))
            return parts
        except OSError:
            for _, f, _ in parts:
                f.close()
    return []


def lines_from(parts, lines):
    """Where the last `lines` lines begin. A line ends in LF; the one that ends the output is
    not a line. All of it when it has no more."""
    end = parts[-1][0] + parts[-1][2]
    want = lines
    for offset, f, size in reversed(parts):
        hi = size
        while hi > 0 and want > 0:
            lo = max(0, hi - 65536)
            f.seek(lo)
            block = f.read(hi - lo)
            at = len(block)
            while True:
                at = block.rfind(b"\n", 0, at)
                if at < 0:
                    break
                if offset + lo + at != end - 1:
                    want -= 1
                    if want == 0:
                        return offset + lo + at + 1
            hi = lo
    return parts[0][0]


def since_from(name, parts, at):
    """Where the output since `at` (unix time) begins, about: from the last time noted at or
    before it, so up to TICK seconds earlier. None when the log has no times."""
    times = read_times(name)
    if times is None:
        return None
    start = parts[0][0]
    for t, offset in times:
        if t <= at:
            start = max(start, offset)
        else:
            break
    return start


def read_from(parts, start, out):
    """The log from `start` on, to `out`."""
    for offset, f, size in parts:
        if offset + size <= start:
            continue
        f.seek(max(0, start - offset))
        while True:
            chunk = f.read(65536)
            if not chunk:
                break
            out(chunk)


def line_start(parts, start):
    """`start`, moved to the start of the line it is in when that begins within 64 KiB: a
    read that starts mid-line starts mid-escape too. The very first byte starts a line."""
    if start == 0:
        return start
    for offset, f, size in parts:
        if offset + size <= start:
            continue
        f.seek(start - offset)
        at = f.read(min(65536, offset + size - start)).find(b"\n")
        return start + at + 1 if at >= 0 else start
    return start


def tail_start(parts, most):
    """Where the last `most` bytes begin, at a line's start (line_start)."""
    return line_start(parts, max(parts[0][0], parts[-1][0] + parts[-1][2] - most))


def replay(name, send):
    """What a new attach is sent before the live stream: the end of the log, and a line before
    it when that is not all of it."""
    parts = opened(name)
    if not parts:
        return
    try:
        start = tail_start(parts, REPLAY)
        if start > 0:
            send(b"[desolate: earlier output is not replayed here; all that is kept of it: desolate agent log --all]\r\n")
        read_from(parts, start, send)
    finally:
        for _, f, _ in parts:
            f.close()


def disk_share(where):
    """The log's most, unless the host said: a twentieth of the disk it is on (so twenty
    agents' logs, each at its most, leave the disk free). At least a segment of 64 KiB each."""
    st = os.statvfs(where)
    return max(SEGMENTS * 65536, st.f_blocks * st.f_frsize // 20)


def start(name, directory, command, most):
    for d in (STATE, RUN):
        os.makedirs(d, mode=0o700, exist_ok=True)
        os.chmod(d, 0o700)
    sock_path, state, _ = paths(name)
    old = read_state(name)
    if old.get("state") == "running" and alive(old.get("holder", 0)):
        sys.exit(f"agent-holder: '{name}' is running already: attach to it, or stop it first")
    error = os.path.join(STATE, name + ".err")
    try:
        os.unlink(error)
    except OSError:
        pass
    # Detach: the holder outlives the session that started it. It says it is listening on a
    # pipe: an agent may end (and its socket go) before anyone could look for the socket.
    ready_r, ready_w = os.pipe()
    if os.fork():
        os.close(ready_w)
        # Binding a socket takes milliseconds: 5 s is a holder that will not.
        heard = select.select([ready_r], [], [], 5.0)[0] and os.read(ready_r, 1)
        if not heard:
            try:
                with open(error) as f:
                    sys.exit("agent-holder: it did not start:\n" + f.read())
            except OSError:
                sys.exit("agent-holder: it did not start, and said nothing")
        with open(state) as f:
            print(f.read())
        return
    os.close(ready_r)
    os.setsid()
    if os.fork():
        os._exit(0)
    devnull = os.open(os.devnull, os.O_RDWR)
    for fd in (0, 1, 2):
        os.dup2(devnull, fd)
    try:
        hold(name, directory, command, most or disk_share(STATE), ready_w)
    except BaseException:
        import traceback
        with open(error, "w") as f:
            f.write(traceback.format_exc())
    os._exit(0)


def hold(name, directory, command, most, ready):
    sock_path, _, _ = paths(name)
    log = Log(name, most)
    pid, master = pty.fork()
    if pid == 0:
        os.environ["TERM"] = os.environ.get("TERM") or "xterm-256color"
        os.execvp("bash", ["bash", ENTER, directory, "--", *command])
    write_state(name, name=name, state="running", holder=os.getpid(), pid=pid, command=command, directory=directory,
                started=now_iso(), lastOutput=None, exit=None, ended=None, logMost=most)
    resize(master, 120, 40)
    try:
        os.unlink(sock_path)
    except OSError:
        pass
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(sock_path)
    os.chmod(sock_path, 0o600)
    server.listen(8)
    server.setblocking(False)
    os.write(ready, b"1")
    os.close(ready)
    clients = {}  # socket -> pending input text
    last_tick = 0.0
    child_done = False
    again_at = 0.0  # when the second Ctrl-C of a stop is due

    def to_all(data):
        for client in list(clients):
            try:
                client.setblocking(True)
                client.sendall(data)
                client.setblocking(False)
            except OSError:
                client.close()
                clients.pop(client, None)

    while not child_done:
        readable = [server, master, *clients.keys()]
        wait = max(0.0, again_at - time.time()) if again_at else 1.0
        ready, _, _ = select.select(readable, [], [], wait)
        if again_at and time.time() >= again_at:
            again_at = 0.0
            try:
                os.write(master, b"\x03")
            except OSError:
                pass
        for r in ready:
            if r is server:
                try:
                    client, _ = server.accept()
                except OSError:
                    continue
                client.setblocking(True)
                try:
                    replay(name, client.sendall)
                except OSError:
                    client.close()
                    continue
                client.setblocking(False)
                clients[client] = ""
            elif r is master:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    data = b""
                if not data:
                    child_done = True
                    continue
                now = time.time()
                if now - last_tick > TICK:
                    last_tick = now
                    log.when(now)
                    write_state(name, lastOutput=now_iso())
                log.write(data)
                to_all(data)
            else:
                try:
                    chunk = r.recv(65536)
                except OSError:
                    chunk = b""
                if not chunk:
                    r.close()
                    clients.pop(r, None)
                    continue
                text = clients.get(r, "") + chunk.decode("ascii", "replace")
                *lines, rest = text.split("\n")
                # An unended line from a client (the host's attach, as this user) is held only
                # this far: a line of the protocol is a base64 chunk of what was typed.
                clients[r] = rest[-200000:]
                for line in lines:
                    if line.startswith("i "):
                        try:
                            os.write(master, base64.b64decode(line[2:]))
                        except Exception:
                            pass
                    elif line.startswith("r "):
                        try:
                            cols, rows = (int(x) for x in line[2:].split())
                            if 0 < cols <= COLS_MOST and 0 < rows <= ROWS_MOST:
                                resize(master, cols, rows)
                                os.kill(pid, signal.SIGWINCH)
                        except Exception:
                            pass
                    elif line == "k" and not again_at:
                        # As a person would: interrupt it, twice, through its own terminal (a
                        # signal to `docker exec`'s client would not reach into the container).
                        # Whether to kill it when it does not end is asked of whoever stops it.
                        try:
                            os.write(master, b"\x03")
                        except OSError:
                            pass
                        again_at = time.time() + AGAIN
                    elif line == "K":
                        try:
                            os.killpg(os.getpgid(pid), signal.SIGKILL)
                        except OSError:
                            pass
    _, status = os.waitpid(pid, 0)
    code = os.waitstatus_to_exitcode(status)
    note = f"\r\n[desolate: the agent ended, exit {code}]\r\n".encode()
    log.write(note)
    write_state(name, state="exited", exit=code, ended=now_iso())
    # Its socket goes with it: what it printed is read from its log from now on.
    try:
        os.unlink(sock_path)
    except OSError:
        pass
    server.close()
    to_all(note)
    for client in list(clients):
        client.close()


def resize(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def attach(name):
    """stdin: the protocol's lines (from the host); stdout: the terminal's bytes."""
    sock_path, _, _ = paths(name)
    out = sys.stdout.buffer
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        client.connect(sock_path)
    except OSError:
        # It has ended: what it printed last, from its log.
        if not segments(name):
            sys.exit(f"agent-holder: no agent '{name}' here")
        replay(name, out.write)
        out.write(b"\r\n[desolate: this agent is not running]\r\n")
        out.flush()
        return
    reading = True
    while True:
        ready, _, _ = select.select([client] + ([sys.stdin] if reading else []), [], [])
        if client in ready:
            data = client.recv(65536)
            if not data:
                break
            out.write(data)
            out.flush()
        if reading and sys.stdin in ready:
            line = sys.stdin.buffer.readline()
            if not line:
                reading = False  # nothing more to send; what it prints still comes
                continue
            client.sendall(line)


def show_log(name, how, value):
    """The log, to stdout: first a line of JSON, {"first", "from", "before", "end", "most"}
    (byte offsets: what is kept starts at `first`, so `first` bytes were dropped; what follows
    starts at `from`; `before` is how much is kept before it, 0 when it starts at the oldest
    line kept; `most`, the log's most), then the bytes. `how`: "all", "lines" (the last `value`) or "since"
    (unix time `value`)."""
    parts = opened(name)
    if not parts:
        sys.exit(f"agent-holder: no agent '{name}' here")
    try:
        if how == "lines":
            start = lines_from(parts, value)
        elif how == "since":
            start = since_from(name, parts, value)
            if start is None:
                sys.exit(f"agent-holder: '{name}' was started before its log noted times: --all or --lines")
        else:
            start = parts[0][0]
        oldest = start == parts[0][0]
        # What was dropped ended mid-line, most likely: what is kept is read from a line's start.
        if oldest:
            start = line_start(parts, start)
        out = sys.stdout.buffer
        meta = {"first": parts[0][0], "from": start, "before": 0 if oldest else start - parts[0][0],
                "end": parts[-1][0] + parts[-1][2], "most": read_state(name).get("logMost")}
        out.write((json.dumps(meta) + "\n").encode())
        read_from(parts, start, out.write)
        out.flush()
    finally:
        for _, f, _ in parts:
            f.close()


def listing():
    out = []
    try:
        names = sorted(n[:-5] for n in os.listdir(STATE) if n.endswith(".json"))
    except OSError:
        names = []
    for name in names:
        try:
            with open(os.path.join(STATE, name + ".json")) as f:
                s = json.load(f)
        except Exception:
            continue
        if s.get("state") == "running" and not alive(s.get("holder", 0)):
            s["state"] = "lost"
        out.append({k: s.get(k) for k in ("name", "state", "command", "started", "lastOutput", "exit", "ended")})
    print(json.dumps(out))


def stop(name, kill, wait):
    """Asks it to stop ("k": Ctrl-C), or kills it ("K"; and "k", for a holder from before,
    which kills 3 s after it). With `wait`, returns when it has ended, for as long as that
    takes: whoever waits decides how long (the host asks the person whether to kill it).
    Prints {"name", "ended", "exit"}."""
    sock_path, _, _ = paths(name)
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        client.connect(sock_path)
        client.sendall(b"K\nk\n" if kill else b"k\n")
    except OSError:
        sys.exit(f"agent-holder: '{name}' is not running")
    ended = False
    if wait:
        # The holder closes every connection when the agent ends.
        while True:
            try:
                if not client.recv(65536):
                    break
            except OSError:
                break
        ended = True
    else:
        # Connected until the holder has read it (it sends the replay first): a second.
        client.settimeout(0.2)
        deadline = time.time() + 1.0
        while time.time() < deadline:
            try:
                if not client.recv(65536):
                    ended = True
                    break
            except socket.timeout:
                continue
            except OSError:
                break
    client.close()
    print(json.dumps({"name": name, "ended": ended, "exit": read_state(name).get("exit") if ended else None}))


def whole(text, what):
    if not text.isascii() or not text.isdigit():
        sys.exit(f"agent-holder: {what} is a whole number, not '{text}'")
    return int(text)


def main(args):
    if len(args) >= 4 and args[0] == "start" and "--" in args[3:]:
        dash = args.index("--", 3)
        own = args[3:dash]
        if own and not (len(own) == 2 and own[0] == "--log-most"):
            sys.exit(__doc__)
        start(checked(args[1]), args[2], args[dash + 1:], whole(own[1], "--log-most") if own else None)
    elif len(args) == 2 and args[0] == "attach":
        attach(checked(args[1]))
    elif len(args) in (2, 3, 4) and args[0] == "log":
        rest = args[2:]
        if rest in ([], ["--all"]):
            show_log(checked(args[1]), "all", None)
        elif len(rest) == 2 and rest[0] in ("--lines", "--since"):
            show_log(checked(args[1]), rest[0][2:], whole(rest[1], rest[0]))
        else:
            sys.exit(__doc__)
    elif args == ["list"]:
        listing()
    elif len(args) >= 2 and args[0] == "stop" and set(args[2:]) <= {"--kill", "--wait"}:
        stop(checked(args[1]), "--kill" in args[2:], "--wait" in args[2:])
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except BrokenPipeError:
        # Whoever read it stopped reading (`desolate agent log | head`, a detach): not an error.
        os._exit(0)
