#!/usr/bin/env python3
# The git terminal's far end (host/git-vm.ts): a bash in a pseudo-terminal, in the git VM.
# The host has no terminal to give ssh, so this makes one here and speaks a small protocol
# on stdin: one line per message, "i <base64 bytes>" (what was typed) or "r <cols> <rows>"
# (a resize). What the terminal prints goes to stdout as it is.
#
#   python3 -I terminal.py <directory>     (-I: nothing beside this file is imported in place of a module)
import base64, fcntl, os, pty, select, struct, sys, termios

# Bounds the host holds too, each named as it is there (tests/v3/t1/git-web.test.ts checks
# that they agree): what the host takes is all that reaches here, and these say so again.
TERMINAL = {"cols": 1000, "rows": 500}  # shared/limits.ts TERMINAL
INPUT_CHARS = 64 * 1024  # host/git-web.ts INPUT_CHARS: the most of one "i" line
# A line of the protocol is at most its kind, a space, INPUT_CHARS and its newline: more is
# not one the host sent, and is dropped up to the next newline, not held.
LINE_MOST = INPUT_CHARS + 3
# What was typed and the shell has not read yet (it is busy, or stopped with Ctrl-S): held up
# to this, then said and dropped. A paste of more than this into a shell that is not reading
# is not one anybody can see the end of anyway.
TYPED_MOST = 4 * 1024 * 1024

where = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~")
pid, fd = pty.fork()
if pid == 0:
    try:
        os.chdir(where)
    except OSError:
        os.chdir(os.path.expanduser("~"))
    os.environ["TERM"] = "xterm-256color"
    os.execvp("bash", ["bash", "-l"])

def resize(cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

resize(120, 32)
os.set_blocking(fd, False)
pending = b""
skipping = False
typed = b""
dropped = 0
stdin = sys.stdin.fileno()
while True:
    try:
        ready, writable, _ = select.select([fd, stdin], [fd] if typed else [], [])
    except InterruptedError:
        continue
    if fd in writable and typed:
        # What was typed goes in as the shell takes it, without stopping its output.
        try:
            typed = typed[os.write(fd, typed):]
        except BlockingIOError:
            pass
        except OSError:
            break
    if fd in ready:
        try:
            data = os.read(fd, 65536)
        except BlockingIOError:
            data = None
        except OSError:
            break
        if data == b"":
            break
        if data:
            os.write(1, data)
    if stdin in ready:
        chunk = os.read(stdin, 65536)
        if not chunk:
            break
        pending += chunk
        while b"\n" in pending:
            line, pending = pending.split(b"\n", 1)
            if skipping:
                skipping = False
                continue
            try:
                kind, _, rest = line.decode("ascii").partition(" ")
                if kind == "i":
                    given = base64.b64decode(rest, validate=True)
                    if len(typed) + len(given) <= TYPED_MOST:
                        typed += given
                    else:
                        dropped += len(given)
                elif kind == "r":
                    cols, rows = (int(x) for x in rest.split())
                    if 1 <= cols <= TERMINAL["cols"] and 1 <= rows <= TERMINAL["rows"]:
                        resize(cols, rows)
            except (ValueError, UnicodeDecodeError):
                pass
        if len(pending) > LINE_MOST:
            pending = b""
            skipping = True
        if dropped:
            # Said where the person is looking, as it happens (through the host's terminal
            # filter, as all of this is).
            os.write(1, b"\r\n\x1b[2mdesolate: %d bytes you typed or pasted were not given to the shell: it was not reading, and %d MiB were waiting already.\x1b[0m\r\n" % (dropped, TYPED_MOST // (1024 * 1024)))
            dropped = 0
try:
    os.kill(pid, 9)
except OSError:
    pass
