"""Open or stop Local Arena from a Start menu shortcut. Runs with pythonw, so it never opens a console window.

  arena_app.pyw          start the Local Arena server if it is not running (or restart it when its code is
                         older than the files on disk), then open the app window
  arena_app.pyw stop     stop the Local Arena server (a loaded model keeps running)
  arena_app.pyw --no-browser   start the server only (used for testing)

Real model switching is on. Output goes to data/live/arena-app.log.
"""
import ctypes
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(os.environ.get("ARENA_PORT", "8790"))
URL = "http://127.0.0.1:%d/" % PORT
NO_WINDOW = 0x08000000
NEW_GROUP = 0x00000200


def say(text, title="Local Arena"):
    ctypes.windll.user32.MessageBoxW(0, text, title, 0x40)


def up():
    try:
        with urllib.request.urlopen(URL + "api/status", timeout=2) as response:
            info = json.load(response)
        return isinstance(info, dict) and isinstance(info.get("gatewayVersion"), str) and isinstance(info.get("engine"), dict)
    except Exception:
        return False


def code_stamp(root):
    """When the server's own Python code last changed: the newest change time of server.py and
    tools/*.py. The Local Arena shortcut compares it with the running server's, to restart an old server."""
    import glob
    files = [os.path.join(root, "server.py")] + glob.glob(os.path.join(root, "tools", "*.py"))
    return int(max((os.path.getmtime(f) for f in files if os.path.isfile(f)), default=0))


def running_stamp():
    """The code stamp the running server reports, or None (an older server reports none)."""
    try:
        import json
        return json.loads(urllib.request.urlopen(URL + "api/status", timeout=5).read()).get("codeStamp")
    except Exception:
        return None


def pid_on_port():
    out = subprocess.run(["netstat", "-ano", "-p", "TCP"], capture_output=True, text=True, creationflags=NO_WINDOW).stdout
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 5 and parts[1].endswith(":%d" % PORT) and parts[3] == "LISTENING":
            return int(parts[4])
    return None


def start_server():
    env = dict(os.environ, ARENA_SWITCH_REAL="1")
    env.pop("ARENA_SWITCH_FAKE", None)
    os.makedirs(os.path.join(ROOT, "data", "live"), exist_ok=True)
    log = open(os.path.join(ROOT, "data", "live", "arena-app.log"), "ab")
    # CREATE_NO_WINDOW only. DETACHED_PROCESS would make every child program open its own console window.
    subprocess.Popen([sys.executable.replace("pythonw.exe", "python.exe"), os.path.join(ROOT, "server.py")],
                     cwd=ROOT, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                     creationflags=NO_WINDOW | NEW_GROUP)
    for _ in range(40):
        if up():
            return True
        time.sleep(0.5)
    return False


def open_window():
    for exe in (shutil.which("msedge"), r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
                r"C:\Program Files\Microsoft\Edge\Application\msedge.exe", shutil.which("chrome")):
        if exe and os.path.isfile(exe):
            profile = os.path.join(ROOT, "data", "live", "edge-profile")  # own profile: own taskbar button and icon
            subprocess.Popen([exe, "--app=" + URL, "--user-data-dir=" + profile, "--no-first-run",
                              "--no-default-browser-check"], creationflags=NO_WINDOW)
            return
    os.startfile(URL)


def stop_server():
    """Stop the server on the port. True when the port is free afterwards."""
    pid = pid_on_port()
    if pid is None:
        return True
    if not up():
        return False
    subprocess.run(["taskkill", "/PID", str(pid), "/F"], capture_output=True, creationflags=NO_WINDOW)
    for _ in range(20):
        time.sleep(0.5)
        if pid_on_port() is None:
            return True
    return False


def main():
    arg = sys.argv[1] if len(sys.argv) > 1 else ""
    if arg == "stop":
        if pid_on_port() is None:
            say("Local Arena was not running.", "Stop Local Arena")
            return
        say("Local Arena is stopped." if stop_server() else "Local Arena did not stop. Try again.", "Stop Local Arena")
        return
    # A server started before Local Arena's code was updated keeps serving the old code even after the
    # window closes. Restart it, so opening Local Arena always runs the newest code. A loaded model is
    # not touched: it runs on its own and the new server finds it again.
    if up() and running_stamp() != code_stamp(ROOT):
        if not stop_server():
            say("Local Arena is out of date but did not stop. Use Stop Local Arena, then open Local Arena again.")
            return
    if not up():
        if pid_on_port() is not None:
            say("Something else is using port %d, so Local Arena cannot start." % PORT)
            return
        if not start_server():
            say("Local Arena did not start. See data\\live\\arena-app.log in the project folder.")
            return
    if arg != "--no-browser":
        open_window()


main()
