"""The few things the collector does differently on Windows: file locks,
checking that a process is alive, and starting the detached collector."""
from __future__ import annotations

import os
import signal
import subprocess
import sys
import time

WINDOWS = sys.platform == "win32"
# SIGKILL doesn't exist on Windows; os.kill() there terminates the process for any signal
SIGKILL = getattr(signal, "SIGKILL", signal.SIGTERM)

if WINDOWS:
    import ctypes
    import msvcrt

    # msvcrt locks a byte range, and a locked range can't be read by other
    # processes; lock one byte far past the pid the lock file holds so it stays readable
    _LOCK_AT = 1 << 30
    _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _kernel32.OpenProcess.argtypes = (ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong)
    _kernel32.OpenProcess.restype = ctypes.c_void_p
    _kernel32.GetExitCodeProcess.argtypes = (ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong))
    _kernel32.CloseHandle.argtypes = (ctypes.c_void_p,)
else:
    import fcntl


def lock(f, blocking: bool = True) -> None:
    """An exclusive lock on f; raises OSError when blocking is False and another process holds it."""
    if not WINDOWS:
        fcntl.flock(f, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
        return
    f.seek(_LOCK_AT)
    try:
        while True:
            try:
                msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
                return
            except OSError:
                if not blocking:
                    raise
                time.sleep(0.1)
    finally:
        f.seek(0)  # callers read and rewrite the pid at the start


def unlock(f) -> None:
    if not WINDOWS:
        fcntl.flock(f, fcntl.LOCK_UN)
        return
    f.seek(_LOCK_AT)
    msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)


def alive(pid: int) -> bool:
    if not WINDOWS:
        try:
            os.kill(pid, 0)
            return True
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
    # os.kill(pid, 0) on Windows terminates the process instead of probing it
    handle = _kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not handle:
        return ctypes.get_last_error() == 5  # ERROR_ACCESS_DENIED: it exists
    try:
        code = ctypes.c_ulong()
        return bool(_kernel32.GetExitCodeProcess(handle, ctypes.byref(code))) and code.value == 259  # STILL_ACTIVE
    finally:
        _kernel32.CloseHandle(handle)


def spawn_detached(argv: list[str], log) -> None:
    """Starts argv with no console window, outliving the session that started it."""
    if not WINDOWS:
        subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True, close_fds=True)
        return
    flags = subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP
    try:
        # leave the job Claude Code may kill with the session; a job that forbids it refuses the start
        subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=log, stderr=log, close_fds=True,
                         creationflags=flags | subprocess.CREATE_BREAKAWAY_FROM_JOB)
    except OSError as e:
        log.write(f"can't leave the session's job ({e}); the collector stops with that session and the next one restarts it\n")
        log.flush()
        subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=log, stderr=log, close_fds=True, creationflags=flags)
