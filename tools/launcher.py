r"""Start and stop the model engine for Local Arena. Standard library only.

Two modes, chosen by the gateway:

  fake  (env ARENA_SWITCH_FAKE=1)  "loading" a model starts tools/fake_engine.py on a test port
                                    under that model's name. Nothing real is touched.
  real  (env ARENA_SWITCH_REAL=1)  the Strata / llama.cpp / NInfer launchers and engines on this PC.

Real mode is refused without ARENA_SWITCH_REAL. Fake mode is refused on any port outside the
test ranges (8771-8774, 8781-8784), so it can never touch 8080 (the real model) or 8790 (the live app).
Process output always goes to a log file, never a pipe: a child that holds a pipe open makes the call hang.
"""
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.dirname(HERE)
FAKE_ENGINE = os.path.join(HERE, "fake_engine.py")
OFFSET = int(os.environ.get("ARENA_PORT_OFFSET", "0") or 0)  # 100, 200 ... moves every test port
assert 0 <= OFFSET <= 900 and OFFSET % 100 == 0, "ARENA_PORT_OFFSET must be 0, 100 ... 900"
TEST_PORTS = tuple(range(8771 + OFFSET, 8775 + OFFSET)) + tuple(range(8781 + OFFSET, 8785 + OFFSET))
def local_setting(key, fallback):
    try:
        with open(os.path.join(PROJECT, "config", "launcher.local.json"), encoding="utf-8") as handle:
            data = json.load(handle)
        return data.get(key) or fallback if isinstance(data, dict) else fallback
    except (OSError, ValueError):
        return fallback


STRATA = os.environ.get("ARENA_STRATA_HOME") or local_setting("strataHome", "")
STRATA_PY = os.path.join(STRATA, ".venv", "Scripts", "python.exe")
BONSAI = os.environ.get("ARENA_BONSAI_HOME") or local_setting("bonsaiHome", "")
REAL_PORT = 8080
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def real_mode_allowed():
    return os.environ.get("ARENA_SWITCH_REAL") == "1"


def ps(script, timeout=600):
    return subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
                          capture_output=True, text=True, timeout=timeout, creationflags=NO_WINDOW)


def check_fake_port(engine_port):
    if engine_port not in TEST_PORTS:
        raise ValueError("Fake switching only works on the test ports (8771-8774, 8781-8784).")


# --- fake mode -------------------------------------------------------------------

def stop_fake(engine_port, log_path=None):
    """Kill whatever fake engine listens on the test port, and wait until the port is free."""
    check_fake_port(engine_port)
    if log_path:
        write_fake_unload_milestone(log_path)
    script = (
        "$pids = @((Get-NetTCPConnection -LocalPort %d -State Listen -EA SilentlyContinue).OwningProcess | "
        "Select-Object -Unique)\n"
        "foreach ($p in $pids) { $c = (Get-CimInstance Win32_Process -Filter ('ProcessId=' + $p) "
        "-EA SilentlyContinue).CommandLine\n"
        "  if ($c -match 'fake_engine\\.py') { Stop-Process -Id $p -Force -EA SilentlyContinue } }\n"
        "for ($i = 0; $i -lt 60; $i++) { if (-not (Get-NetTCPConnection -LocalPort %d -State Listen "
        "-EA SilentlyContinue)) { break }; Start-Sleep -Milliseconds 250 }" % (engine_port, engine_port)
    )
    ps(script, timeout=120)


# Milestone lines written in fake mode so tests can read the switch stages the real engine
# prints ("[strata] ... engine started", "native pack", weights, expert cache, VRAM free).
# Short delays between them, so a fast poll can see the progress move.
FAKE_MILESTONES = (
    ("[fake] fake-engine.exe started: python fake_engine.py --port %d --serve", 0.15),
    ("[fake] fake generate: native pack: reading the model files", 0.15),
    ("[fake] fake generate: 512 MiB of weights loaded from fake.gguf in 0.1 s", 0.15),
    ("[fake] fake generate: loaded 4.0 GiB at 3.0 GiB/s", 0.15),
    ("[fake] fake generate: expert cache auto: filling the GPU's expert cache", 0.15),
    ("[fake] fake generate: expert cache 64 slots, 0.5 GiB of VRAM", 0.15),
    ("[fake] fake serve: 100 MiB of VRAM free with everything loaded", 0.15),
)


def write_fake_milestones(log_path, engine_port):
    """Print the fake milestone lines to the switch log with short delays between them."""
    os.makedirs(os.path.dirname(log_path), exist_ok=True)
    with open(log_path, "w", encoding="utf-8") as fh:
        for line, pause in FAKE_MILESTONES:
            fh.write((line % engine_port if "%d" in line else line) + "\n")
            fh.flush()
            time.sleep(pause)


def write_fake_unload_milestone(log_path):
    """One line when a fake model is stopped, so a poll during the stop has something to read."""
    try:
        os.makedirs(os.path.dirname(log_path), exist_ok=True)
        with open(log_path, "a", encoding="utf-8") as fh:
            fh.write("[fake] fake engine stopped\n")
    except OSError:
        pass


def start_fake(entry, engine_port, log_path):
    """Start the fake engine hidden on the test port, answering as this entry's model."""
    check_fake_port(engine_port)
    model = entry.get("matchId") or entry.get("id")
    if not isinstance(model, str) or not model:
        raise ValueError("The model entry has no name for the fake engine.")
    write_fake_milestones(log_path, engine_port)
    with open(log_path, "a", encoding="utf-8") as fh:
        subprocess.Popen([sys.executable, FAKE_ENGINE, "--port", str(engine_port), "--model", model],
                         cwd=PROJECT, stdin=subprocess.DEVNULL, stdout=fh, stderr=subprocess.STDOUT,
                         creationflags=NO_WINDOW)


# --- real mode (only with ARENA_SWITCH_REAL=1; never used by the automated tests) ---

FAMILY_STOP = os.environ.get("ARENA_FAMILY_STOP") or local_setting("familyStop", "")   # -Stop: Strata and the Bonsai family
NINFER_LAUNCH = os.environ.get("ARENA_NINFER_LAUNCH") or local_setting("ninferLaunch", "")                          # -Stop: NInfer in WSL2 Docker
MINICPM = os.environ.get("ARENA_MINICPM_HOME") or local_setting("minicpmHome", "")
_owned_processes = []  # only processes this gateway started, never an external server
_last_start = None   # the process the switch that is running now launched: its launcher, or the engine
_last_start_is_engine = False


def start_finished():
    """(True, exit code) once the process this switch launched has exited, (False, None) while it runs.
    The launchers give up long before the app's ten-minute wait, so the app can report a failed load
    as soon as the launcher is gone instead of showing a progress bar that never finishes."""
    proc = _last_start
    if proc is None:
        return False, None
    code = proc.poll()
    if code is None:
        return False, None
    return True, code


def direct_engine_started():
    return _last_start_is_engine


def read_port_file(path):
    """The port a running launcher wrote to its state file, or None when there is no usable file.
    The launchers keep JSON state (Pid, Port, Build) while a model runs and delete it on stop."""
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    for key in ("port", "Port"):
        value = data.get(key)
        if isinstance(value, bool):
            continue
        if isinstance(value, int) and 1 <= value <= 65535:
            return value
        if isinstance(value, str) and value.strip().isdigit():
            port = int(value.strip())
            if 1 <= port <= 65535:
                return port
    return None


def resolve_port(entry, default_port):
    """Where this model really answers. The launcher's own port file first
    (it can move when another program holds the usual port), then the port in the list, then the app's default. Nothing is assumed:
    a missing file falls back, and the gateway then checks that something answers there."""
    if not isinstance(entry, dict):
        return default_port
    path = entry.get("portFile")
    if isinstance(path, str) and path:
        port = read_port_file(path)
        if port:
            return port
    port = entry.get("port")
    if isinstance(port, int) and not isinstance(port, bool) and 1 <= port <= 65535:
        return port
    return default_port


def _run_hidden(command, timeout, cwd=None, log_path=None):
    """Run a launcher command hidden. Output goes to the log file, never a pipe."""
    if log_path:
        os.makedirs(os.path.dirname(log_path), exist_ok=True)
        with open(log_path, "a", encoding="utf-8") as fh:
            return subprocess.run(command, cwd=cwd, stdin=subprocess.DEVNULL, stdout=fh,
                                  stderr=subprocess.STDOUT, timeout=timeout, creationflags=NO_WINDOW)
    return subprocess.run(command, cwd=cwd, capture_output=True, text=True, timeout=timeout,
                          creationflags=NO_WINDOW)


NINFER_DISTRO = os.environ.get("ARENA_NINFER_DISTRO", "Ubuntu-24.04")  # NInfer runs in Docker inside this WSL distro


def distro_in_list(text, name=NINFER_DISTRO):
    """True when `wsl --list --running --quiet` output names the distro."""
    return any(line.strip().strip("\x00") == name for line in str(text).splitlines())


def wsl_distro_running(name=NINFER_DISTRO):
    """Is NInfer's WSL distro running? Listing does not start it. NInfer's own -Stop calls wsl.exe, which
    BOOTS WSL when it is off: every load and unload of any model used to start WSL.
    If the check itself fails, say True so NInfer is still stopped rather than left holding the card."""
    try:
        r = subprocess.run(["wsl.exe", "--list", "--running", "--quiet"], capture_output=True, timeout=20,
                           creationflags=NO_WINDOW)
    except FileNotFoundError:
        return False            # no WSL on this PC, so no NInfer either
    except (OSError, subprocess.TimeoutExpired):
        return True
    raw = r.stdout or b""
    text = raw.decode("utf-16-le", "replace") if b"\x00" in raw else raw.decode("utf-8", "replace")
    return distro_in_list(text, name)


def stop_scripts(ninfer_may_run):
    """The launchers' own stop commands to run. NInfer's only when its WSL distro is already up."""
    scripts = [(FAMILY_STOP, ["-Stop"])]
    if ninfer_may_run:
        scripts.append((NINFER_LAUNCH, ["-Stop"]))
    return scripts


OWNED_PATH = os.environ.get("ARENA_OWNED_ENGINES") or os.path.join(PROJECT, "data", "live", "owned-engines.json")


def process_identity(pid):
    """Stable process start identity, so a reused PID never authorizes stopping another process."""
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        handle = kernel.OpenProcess(0x1000, False, pid)
        if not handle:
            return None
        try:
            exit_code = wintypes.DWORD()
            kernel.GetExitCodeProcess.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
            if not kernel.GetExitCodeProcess(handle, ctypes.byref(exit_code)) or exit_code.value != 259:
                return None
            values = [wintypes.FILETIME() for _ in range(4)]
            kernel.GetProcessTimes.argtypes = (wintypes.HANDLE,) + (ctypes.POINTER(wintypes.FILETIME),) * 4
            if not kernel.GetProcessTimes(handle, *(ctypes.byref(value) for value in values)):
                return None
            return str((values[0].dwHighDateTime << 32) | values[0].dwLowDateTime)
        finally:
            kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
            kernel.CloseHandle(handle)
    try:
        with open("/proc/%d/stat" % pid) as handle:
            return handle.read().rsplit(")", 1)[1].split()[19]
    except (OSError, IndexError):
        return None


def owned_records():
    try:
        with open(OWNED_PATH, encoding="utf-8") as handle:
            records = json.load(handle)
        if not isinstance(records, list) or any(not isinstance(record, dict)
                or not isinstance(record.get("pid"), int) or isinstance(record.get("pid"), bool)
                or record["pid"] <= 0 or not isinstance(record.get("identity"), str) or not record["identity"]
                for record in records):
            raise ValueError("invalid ownership record")
        return records
    except FileNotFoundError:
        return []
    except (OSError, ValueError) as error:
        raise RuntimeError("The saved engine ownership record could not be read. Check data/live/owned-engines.json.") from error


def save_owned(records):
    import tempfile
    folder = os.path.dirname(OWNED_PATH)
    os.makedirs(folder, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=folder, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(records, handle)
        os.replace(temporary, OWNED_PATH)
    finally:
        if os.path.exists(temporary):
            os.remove(temporary)


def track_owned(proc):
    identity = process_identity(proc.pid)
    if identity is None:
        return  # a process that already exited is handled by start_finished()
    try:
        records = owned_records()
        records.append({"pid": proc.pid, "identity": identity})
        save_owned(records)
        _owned_processes.append(proc)
    except Exception:
        proc.terminate()
        proc.wait(10)
        raise


def remember_script_engine(entry):
    """Keep the process a successfully started legacy launcher records in its own state file."""
    path = entry.get("portFile")
    if not isinstance(path, str) or not path:
        return
    try:
        with open(path, encoding="utf-8-sig") as handle:
            state = json.load(handle)
    except (OSError, ValueError):
        return
    pid = state.get("Pid", state.get("pid")) if isinstance(state, dict) else None
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return
    port = resolve_port(entry, None)
    script = (entry.get("start") or {}).get("script")
    if not port or not isinstance(script, str) or not verified_engine_pid(pid, port, os.path.dirname(script)):
        return
    identity = process_identity(pid)
    if identity is None:
        return
    records = [record for record in owned_records() if record.get("pid") != pid]
    records.append({"pid": pid, "identity": identity})
    save_owned(records)


def verified_engine_pid(pid, port, folder):
    """A state-file PID is owned only if it listens on that engine's port from its install folder."""
    if os.name != "nt":
        return False  # legacy PowerShell launchers are Windows-only
    script = ("$listener = Get-NetTCPConnection -State Listen -LocalPort %d -EA SilentlyContinue | "
              "Where-Object { $_.OwningProcess -eq %d }; if ($listener) { "
              "(Get-CimInstance Win32_Process -Filter 'ProcessId=%d' -EA SilentlyContinue).ExecutablePath }"
              % (port, pid, pid))
    result = ps(script, timeout=20)
    exe = result.stdout.strip()
    if result.returncode or not exe or os.path.basename(exe).lower() not in ("llama-server.exe", "strata.exe", "python.exe"):
        return False
    try:
        return os.path.commonpath((os.path.normcase(os.path.abspath(exe)), os.path.normcase(os.path.abspath(folder)))) == os.path.normcase(os.path.abspath(folder))
    except ValueError:
        return False


def stop_owned():
    """Stop only engines Local Arena started, including engines surviving a gateway restart."""
    records = owned_records()
    for record in records:
        pid = record.get("pid") if isinstance(record, dict) else None
        if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
            continue
        if process_identity(pid) != record.get("identity"):
            continue
        if os.name == "nt":
            result = subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True, creationflags=NO_WINDOW)
            if result.returncode and process_identity(pid) == record.get("identity"):
                raise RuntimeError("A model Local Arena started could not be stopped (PID %d)." % pid)
        else:
            import signal
            os.kill(pid, signal.SIGTERM)
        for _ in range(100):
            if process_identity(pid) != record.get("identity"):
                break
            time.sleep(0.1)
        else:
            raise RuntimeError("A model Local Arena started did not stop (PID %d)." % pid)
    save_owned([])
    for proc in _owned_processes:
        proc.poll()
    _owned_processes.clear()


def stop_real(log_path=None):
    """Stop every local model on this PC, whichever family it belongs to, and wait for the card to
    clear. Only one big model fits the card, so loading one stops the others. The launchers do the
    real work; MiniCPM is stopped by its own process because its -Stop can open a dialog and hang
    a hidden caller."""
    stop_owned()
    for script, args in stop_scripts(wsl_distro_running()):
        if script and os.path.isfile(script):
            try:
                _run_hidden(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script] + args,
                            timeout=240, log_path=log_path)
            except subprocess.TimeoutExpired:
                pass
    stop_script = os.path.join(BONSAI, "stop-bonsai.ps1")
    if BONSAI and os.path.isfile(stop_script) and os.path.isfile(os.path.join(BONSAI, "bonsai-server.json")):
        try:
            _run_hidden(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", stop_script],
                        timeout=120, log_path=log_path)
        except subprocess.TimeoutExpired:
            pass
    time.sleep(5)  # let Windows hand back the pinned RAM


def start_script(entry, log_path):
    """Start a model through the launcher script you already use by hand (Bonsai, NInfer,
    MiniCPM). The script is called, never changed, and its output goes to the switch log."""
    spec = entry.get("start") if isinstance(entry.get("start"), dict) else {}
    script = spec.get("script")
    if not isinstance(script, str) or not script:
        raise ValueError("That model has no start script in the list.")
    if not os.path.isfile(script):
        raise ValueError("That model's start script is missing: %s" % script)
    args_raw = spec.get("args")
    args = args_raw if isinstance(args_raw, list) else []
    cwd_raw = spec.get("cwd")
    cwd = cwd_raw if isinstance(cwd_raw, str) and cwd_raw else os.path.dirname(script)
    command = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script] + [str(a) for a in args]
    with open(log_path, "a", encoding="utf-8") as fh:
        proc = subprocess.Popen(command, cwd=cwd, stdin=subprocess.DEVNULL, stdout=fh,
                                stderr=subprocess.STDOUT, creationflags=NO_WINDOW)
    global _last_start, _last_start_is_engine
    _last_start = proc          # the app watches this to report a failed load the moment it gives up
    _last_start_is_engine = False
    time.sleep(3)
    if proc.poll() not in (None, 0):
        raise RuntimeError("That model's start script stopped right away (exit %s). See the switch log." % proc.returncode)


LLAMA_KV_TYPES = ("f16", "q8_0", "q4_0")
LLAMA_FLASH = ("auto", "on", "off")


def split_extra_args(text):
    """Extra llama-server flags typed by the user, as a list. Quotes group words; nothing is run
    through a shell, so the text can only ever become arguments to llama-server itself."""
    if not isinstance(text, str) or not text.strip():
        return []
    import shlex
    parts = shlex.split(text, posix=False)
    return [p[1:-1] if len(p) >= 2 and p[0] == p[-1] and p[0] in "\"'" else p for p in parts]


def gguf_command(entry):
    """The llama-server command for a model file added in the app (engine "gguf"). Defaults are left
    to llama-server itself (no -ngl, no -fa) so older builds that lack 'auto' still start."""
    s = entry.get("settings") if isinstance(entry.get("settings"), dict) else {}
    runtime = s.get("runtime")
    model = s.get("modelPath")
    if not (isinstance(runtime, str) and os.path.isfile(runtime)):
        raise ValueError("The llama-server program for this model is missing: %s" % runtime)
    if not (isinstance(model, str) and os.path.isfile(model)):
        raise ValueError("The model file is missing: %s" % model)
    port = resolve_port(entry, None)
    if not port:
        raise ValueError("That model has no port.")
    cmd = [runtime, "-m", model, "--host", "127.0.0.1", "--port", str(port), "--alias", str(entry.get("matchId")),
           "--jinja", "-np", "1"]
    ctx = s.get("contextTokens")
    if isinstance(ctx, int) and ctx > 0:
        cmd += ["-c", str(ctx)]
    gpu = s.get("gpuLayers", "auto")
    if gpu == "all":
        cmd += ["-ngl", "999"]
    elif isinstance(gpu, int) and not isinstance(gpu, bool) and gpu >= 0:
        cmd += ["-ngl", str(gpu)]
    flash = s.get("flashAttn", "auto")
    if flash in ("on", "off"):
        cmd += ["-fa", flash]
    kv = s.get("kvCache", "f16")
    if kv in LLAMA_KV_TYPES and kv != "f16":
        cmd += ["-ctk", kv]
        if flash != "off":          # a compressed V cache needs flash attention
            cmd += ["-ctv", kv]
    projector = s.get("projector")
    if isinstance(projector, str) and projector and os.path.isfile(projector):
        cmd += ["--mmproj", projector]
    extra = split_extra_args(s.get("extraArgs"))
    if any(arg.split("=", 1)[0] in {"-m", "--model", "--port", "--host", "-a", "--alias"} for arg in extra):
        raise ValueError("Extra flags cannot set the model, port, host or alias; Local Arena sets those.")
    return cmd + extra


def start_gguf(entry, log_path):
    """Start llama-server on a model file, hidden and detached, output to the switch log."""
    cmd = gguf_command(entry)
    flags = 0x08000000 | 0x00000200  # CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP
    with open(log_path, "a", encoding="utf-8") as fh:
        fh.write("[bench] starting: %s\n" % subprocess.list2cmdline(cmd))
        fh.flush()
        proc = subprocess.Popen(cmd, cwd=os.path.dirname(cmd[0]), stdin=subprocess.DEVNULL, stdout=fh,
                                stderr=subprocess.STDOUT, creationflags=flags if os.name == "nt" else 0,
                                close_fds=True)
    global _last_start, _last_start_is_engine
    _last_start = proc
    _last_start_is_engine = True
    track_owned(proc)
    time.sleep(2)
    if proc.poll() is not None:
        raise RuntimeError("llama-server stopped right after starting (exit %s). Its message is in the switch log."
                           % proc.returncode)


def start_real(entry, log_path):
    """Start the model the entry describes, hidden, output to a log file (never a pipe)."""
    if entry.get("engine") == "gguf":
        start_gguf(entry, log_path)
        return
    if entry.get("engine") == "external":
        return                  # a server Local Arena does not own: the switch only waits for it to answer
    if entry.get("engine") == "strata":
        config = entry.get("configPath")
        if not isinstance(config, str) or not config:
            raise ValueError("That Strata model has no config file in the list.")
        if not os.path.isfile(config):
            raise ValueError("That Strata model's config file is missing: %s" % config)
        if not STRATA:
            raise ValueError("Set ARENA_STRATA_HOME (or strataHome in config/launcher.local.json) to start Strata models.")
        args = strata_command(config)
        # Launch the engine directly (no PowerShell string to mis-quote): detached, hidden, output to a log file.
        flags = 0x08000000 | 0x00000200  # CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP
        with open(log_path, "w", encoding="utf-8") as fh:
            proc = subprocess.Popen(args, cwd=STRATA, stdin=subprocess.DEVNULL, stdout=fh, stderr=subprocess.STDOUT,
                                    creationflags=flags, close_fds=True)
        global _last_start, _last_start_is_engine
        track_owned(proc)
        _last_start = proc      # the engine itself: if it dies during the switch, the app says so now
        _last_start_is_engine = True
        time.sleep(3)
        if proc.poll() is not None:
            raise RuntimeError("The engine stopped right after starting (exit %s). See the switch log." % proc.returncode)
    else:
        start_script(entry, log_path)


def strata_command(config):
    """The exact command that starts one Strata model on the real port (same as the run-*.bat files)."""
    return [STRATA_PY, os.path.join(STRATA, "serve", "server.py"), "--engine", "strata", "--config", config,
            "--port", str(REAL_PORT)]


# --- the two calls the gateway uses -------------------------------------------------

def stop_all(mode, engine_port, log_path=None):
    global _last_start
    _last_start = None          # a new switch: forget the process the last one launched
    if mode == "fake":
        stop_fake(engine_port, log_path)
    elif mode == "real":
        if not real_mode_allowed():
            raise PermissionError("Real model switching is switched off.")
        stop_real(log_path)
    else:
        raise ValueError("Unknown switch mode.")


def start(entry, mode, engine_port, log_path):
    global _last_start, _last_start_is_engine
    _last_start = None
    _last_start_is_engine = False
    if mode == "fake":
        start_fake(entry, engine_port, log_path)
    elif mode == "real":
        if not real_mode_allowed():
            raise PermissionError("Real model switching is switched off.")
        start_real(entry, log_path)
    else:
        raise ValueError("Unknown switch mode.")
