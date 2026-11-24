#!/usr/bin/env python3
"""
Full-duplex PTY bridge using Python stdlib only (no native Node addons required).
Stdin framing: [1-byte type][4-byte uint32BE length][payload]
  type = 1: raw bytes to write to PTY master
  type = 2: JSON resize payload {"cols": int, "rows": int}
Stdout: raw PTY master output stream.
"""

import argparse
import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios


def set_winsize(fd: int, cols: int, rows: int) -> None:
    cols = max(10, min(500, int(cols)))
    rows = max(4, min(200, int(rows)))
    winsize = struct.pack("HHHH", rows, cols, 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)


def read_exact(fd: int, n: int) -> bytes | None:
    buf = bytearray()
    while len(buf) < n:
        try:
            chunk = os.read(fd, n - len(buf))
        except OSError as e:
            if e.errno == errno.EINTR:
                continue
            return None
        if not chunk:
            return None
        buf.extend(chunk)
    return bytes(buf)


def write_all(fd: int, data: bytes) -> None:
    view = memoryview(data)
    offset = 0
    while offset < len(data):
        try:
            written = os.write(fd, view[offset:])
            offset += written
        except OSError as e:
            if e.errno in (errno.EINTR, errno.EAGAIN):
                continue
            raise


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cols", type=int, default=120)
    parser.add_argument("--rows", type=int, default=36)
    parser.add_argument("--cwd", type=str, default=None)
    parser.add_argument("cmd", nargs=argparse.REMAINDER)
    args = parser.parse_args()

    cmd = args.cmd
    if cmd and cmd[0] == "--":
        cmd = cmd[1:]
    if not cmd:
        sys.stderr.write("pty_bridge.py requires a command to execute\n")
        return 2

    pid, master_fd = pty.fork()
    if pid == 0:
        if args.cwd:
            try:
                os.chdir(args.cwd)
            except OSError:
                pass
        os.environ.setdefault("TERM", "xterm-256color")
        os.environ.setdefault("COLORTERM", "truecolor")
        os.execvp(cmd[0], cmd)
        os._exit(127)

    try:
        set_winsize(master_fd, args.cols, args.rows)
    except OSError:
        pass

    stdin_fd = sys.stdin.fileno()
    stdout_fd = sys.stdout.fileno()
    stopping = False

    def handle_term(_signum: int, _frame: object) -> None:
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, handle_term)
    signal.signal(signal.SIGINT, handle_term)

    stdin_open = True
    while not stopping:
        read_fds = [master_fd]
        if stdin_open:
            read_fds.append(stdin_fd)
        try:
            readable, _, _ = select.select(read_fds, [], [], 0.25)
        except OSError as e:
            if e.errno == errno.EINTR:
                continue
            break

        if master_fd in readable:
            try:
                out = os.read(master_fd, 16384)
            except OSError as e:
                if e.errno in (errno.EIO, errno.EBADF):
                    break
                if e.errno == errno.EINTR:
                    continue
                break
            if not out:
                break
            try:
                write_all(stdout_fd, out)
            except OSError:
                break

        if stdin_fd in readable:
            header = read_exact(stdin_fd, 5)
            if header is None:
                stdin_open = False
                stopping = True
                break
            msg_type = header[0]
            length = struct.unpack(">I", header[1:5])[0]
            payload = read_exact(stdin_fd, length) if length > 0 else b""
            if payload is None:
                stdin_open = False
                stopping = True
                break

            if msg_type == 1:
                try:
                    write_all(master_fd, payload)
                except OSError:
                    break
            elif msg_type == 2:
                try:
                    size = json.loads(payload.decode("utf-8"))
                    set_winsize(master_fd, size.get("cols", 120), size.get("rows", 36))
                    os.kill(pid, signal.SIGWINCH)
                except Exception:
                    pass

    try:
        os.close(master_fd)
    except OSError:
        pass

    exit_code = 0
    try:
        _, status = os.waitpid(pid, os.WNOHANG)
        if status == 0:
            _, status = os.waitpid(pid, 0)
        if os.WIFEXITED(status):
            exit_code = os.WEXITSTATUS(status)
        elif os.WIFSIGNALED(status):
            exit_code = 128 + os.WTERMSIG(status)
    except OSError:
        pass
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
