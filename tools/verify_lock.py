"""Turn-taking for full verifies across checkouts (used by tools/verify.py).

Running two or three full verifies at once loads the machine until timing-sensitive checks
(10, 51, 60, 61) fail for no code reason. The first verify takes the lock (an atomic mkdir);
others wait their turn. A lock whose owner process is gone, or older than LOCK_STALE_S, is taken over.
If the wait runs past LOCK_WAIT_S the verify runs anyway (never blocks forever). Standard library only.
"""
import os
import subprocess
import time
import tempfile

LOCK_DIR = os.environ.get("ARENA_LOCK_DIR") or os.path.join(tempfile.gettempdir(), "arena-verify.lock")
LOCK_WAIT_S = 600
LOCK_STALE_S = 900
QUIET_WAIT_S = 400


def _pid_alive(pid):
    if pid <= 0:
        return False
    out = subprocess.run(["tasklist", "/FI", "PID eq %d" % pid, "/NH"], capture_output=True, text=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    return str(pid) in out.stdout


def _browser_checks_running():
    """Number of node processes running tools/ui_check.mjs right now. When we call this our own verify has
    started none, so any found belong to someone else"""
    script = (r"(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and "
              r"$_.CommandLine -match 'ui_check\.mjs' } | Measure-Object).Count")
    try:
        out = subprocess.run(["powershell", "-NoProfile", "-Command", script], capture_output=True, text=True, timeout=60, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        text = out.stdout.strip()
        return int(text) if text.isdigit() else 0
    except (OSError, subprocess.SubprocessError):
        return 0


def _wait_for_quiet():
    started = time.time()
    announced = False
    while _browser_checks_running() > 0:
        if not announced:
            print("another browser-check run is active; waiting for it to finish ...", flush=True)
            announced = True
        if time.time() - started > QUIET_WAIT_S:
            print("still busy after %d s; running anyway" % QUIET_WAIT_S, flush=True)
            return
        time.sleep(5)


def release():
    try:
        for name in os.listdir(LOCK_DIR):
            os.remove(os.path.join(LOCK_DIR, name))
        os.rmdir(LOCK_DIR)
    except OSError:
        pass


def acquire(root):
    """Block until it is our turn. Returns True when we hold the lock, False if we gave up waiting."""
    parent = os.path.dirname(LOCK_DIR)
    if parent:
        os.makedirs(parent, exist_ok=True)
    if os.environ.get("ARENA_LOCK_HELD"):  # a wrapper (python tools/verify_lock.py) already holds it for us
        return False
    started = time.time()
    announced = False
    while True:
        try:
            os.mkdir(LOCK_DIR)
            with open(os.path.join(LOCK_DIR, "owner"), "w") as f:
                f.write(str(os.getpid()) + os.linesep + root + os.linesep)
            _wait_for_quiet()
            return True
        except FileExistsError:
            try:
                age = time.time() - os.path.getmtime(LOCK_DIR)
                with open(os.path.join(LOCK_DIR, "owner")) as f:
                    lines = f.read().split()
                who = lines[1] if len(lines) > 1 else "?"
                alive = _pid_alive(int(lines[0]))
            except (OSError, ValueError, IndexError):
                age, alive, who = 0, True, "?"
            if not alive or age > LOCK_STALE_S:
                release()
                continue
            if not announced:
                print("waiting for the verify running in %s to finish ..." % who, flush=True)
                announced = True
            if time.time() - started > LOCK_WAIT_S:
                print("gave up waiting for the verify lock after %d s; running anyway" % LOCK_WAIT_S, flush=True)
                return False
            time.sleep(5)


if __name__ == "__main__":
    # Can also be run directly:  python tools/verify_lock.py [--quick]
    import sys
    here = os.path.dirname(os.path.abspath(__file__))
    held = acquire(os.path.dirname(here))
    try:
        env = dict(os.environ, ARENA_LOCK_HELD="1")
        code = subprocess.call([sys.executable, os.path.join(here, "verify.py")] + sys.argv[1:], env=env, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    finally:
        if held:
            release()
    sys.exit(code)
