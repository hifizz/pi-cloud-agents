"""Local real controlling PTY bridge; one JSON launch record, then raw stdin/stdout."""
import json
import os
import pty
import select
import signal
import sys
import time

record = bytearray()
while not record.endswith(b"\n"):
    record.extend(os.read(0, 1))
spec = json.loads(record)
pid, master = pty.fork()
if pid == 0:
    os.chdir(spec["cwd"])
    os.execve(spec["cmd"], [spec["cmd"], *spec["args"]], spec["env"])

def stop(*_):
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass

signal.signal(signal.SIGTERM, stop)
deadline = time.monotonic() + 20
status = None
try:
    while time.monotonic() < deadline:
        ready, _, _ = select.select([0, master], [], [], 0.1)
        for fd in ready:
            try:
                data = os.read(fd, 65536)
            except OSError:
                data = b""
            if not data:
                raise EOFError()
            target = master if fd == 0 else 1
            while data:
                data = data[os.write(target, data):]
except EOFError:
    pass
finally:
    # Preserve a normal exit status when available, otherwise terminate the test shell.
    ended, status = os.waitpid(pid, os.WNOHANG)
    if not ended:
        stop()
        _, status = os.waitpid(pid, 0)
    os.close(master)
sys.exit(os.waitstatus_to_exitcode(status) if os.WIFEXITED(status) else 137)
