"""Local Arena gateway: serves the app folder, proxies the engine, reads the GPU, saves records.
Standard library only. The contract is docs/API.md.

  python server.py   (env: ARENA_PORT 8790, ARENA_ENGINE 127.0.0.1:8080, ARENA_STORE data/store)
"""
import concurrent.futures
import http.client
import json
import os
import re
import select
import socket
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, SimpleHTTPRequestHandler

VERSION = "0.2.0"
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "tools"))
import launcher  # noqa: E402
import model_files  # noqa: E402
ROOT = os.path.join(HERE, "app")
PORT = int(os.environ.get("ARENA_PORT", "8790"))
ENGINE = os.environ.get("ARENA_ENGINE", "127.0.0.1:8080")
ENGINE_HOST, _, ENGINE_PORT = ENGINE.rpartition(":")
ENGINE_PORT = int(ENGINE_PORT)
# The engine address follows the loaded model: each model can answer on its own port. A switch resolves
# the port when it starts a model (from the model's own port file when it has one), and the app adopts
# a model that was already running when it opened. In test mode the port stays the test port, never a
# model's real port.
_active_port = None
_engine_disconnected = False
_active_external = False


def engine_port():
    """The port the loaded model answers on right now."""
    return _active_port if isinstance(_active_port, int) and not isinstance(_active_port, bool) else ENGINE_PORT


def set_engine_port(port):
    """Point the app at a model's port. False when the value is not a usable port number."""
    global _active_port
    if isinstance(port, int) and not isinstance(port, bool) and 1 <= port <= 65535:
        _active_port = port
        return True
    return False


def engine_addr():
    return str(ENGINE_HOST), int(engine_port())


ADOPT_INTERVAL_S = 30.0  # how often to look for a model that was started outside the app
_adopt_checked_at = 0.0
STORE = os.environ.get("ARENA_STORE") or os.path.join(HERE, "data", "store")
def no_engine_message():
    """The 502 text: name the address the app just tried, which is the loaded model's own port."""
    host, port = engine_addr()
    return "No model engine is answering on %s:%d." % (host, port)
NVIDIA_SMI = "nvidia-smi"
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)  # Windows: a child program must never open a console window
ENGINE_CALL_S = 1.5  # per status call, so the status reply comes back under 3 s
GPU_CMD_S = 1.2  # per nvidia-smi query
GPU_CACHE_S = 0.5
MAX_BODY = 5 * 1024 * 1024
STORE_COLLECTIONS = ("chats", "votes", "runs", "settings")
ID_RE = re.compile(r"[a-z0-9][a-z0-9_-]{0,63}")
PROXY_PATHS = ("/metrics", "/props", "/health", "/slots", "/models")
LIVE_EMPTY = {"state": None, "phase": None, "promptRead": None, "promptTotal": None,
              "generated": None, "tokS": None, "tokSMean": None}
LIVE = os.environ.get("ARENA_LIVE") or os.path.join(HERE, "data", "live")
RECORD_PATH = os.path.join(LIVE, "record.md")
RECORD_POLL_S = 5.0   # while someone polls /api/status, write at most this often
RECORD_IDLE_S = 15.0  # background thread writes this often when nobody polls
_LOCAL_MODELS = os.path.join(HERE, "config", "models.json")
MODELS_PATH = os.environ.get("ARENA_MODELS") or (_LOCAL_MODELS if os.path.isfile(_LOCAL_MODELS)
                                              else os.path.join(HERE, "config", "models.example.json"))
# Models added in the app live in their own file, never in the hand-kept catalogue above. Tests that
# point ARENA_MODELS at a temp file get a temp user file next to it, so they never touch a real one.
USER_MODELS_PATH = (os.environ.get("ARENA_USER_MODELS")
                    or (os.path.join(os.path.dirname(os.environ["ARENA_MODELS"]), "user-models.json")
                        if os.environ.get("ARENA_MODELS") else os.path.join(HERE, "data", "user-models.json")))
USER_PORTS = range(8085, 8100)   # llama-server ports for models added in the app (8080-8084 are taken)
# Test seam for the UI checks: override the engine kind the gateway reports (wording per engine kind).
ENGINE_KIND_OVERRIDE = os.environ.get("ARENA_ENGINE_KIND") or None
SWITCH_FAKE = os.environ.get("ARENA_SWITCH_FAKE") == "1"
SWITCH_REAL = os.environ.get("ARENA_SWITCH_REAL") == "1"
SWITCH_OFF = "Real model switching is switched off."
SWITCH_TIMEOUT_S = 600.0
LAUNCHER_GRACE_S = 90.0   # a launch script that exited 0 gets this long for its server to answer
SWITCH_LOG = os.path.join(LIVE, "switch.log")
SWITCH_STOP_DEFAULT_S = 12.0   # stop estimate until the first stop is measured
SWITCH_START_DEFAULT_S = 60.0  # start estimate until that model's first start is measured
SWITCH_TIMES_PATH = os.path.join(LIVE, "switch-times.json")
MODEL_SPEED_PATH = os.path.join(LIVE, "model-speed.json")
WARMUP_MAX_TOKENS = 64         # the small test question after a load
WARMUP_PROMPT = "Count from 1 to 30, separated by spaces. Reply with the numbers only."
WARMUP_MIN_ENGINE_TOKENS = 8   # the engine's own speed is trusted from this many tokens
WARMUP_TIMEOUT_S = 120.0       # give the warm-up reply this long, then record the failure
WARMUP_SLOW_SHARE = 0.40       # slow: under this share of the model's best on record
WARMUP_SLOW_FLOOR = 10.0       # slow with no record: under this many tokens per second (Strata)
WARMUP_SEED_ENV = "ARENA_WARMUP_SEED"  # test-only: force this tok/s instead of the real measurement.
                                        # A test seam, documented in docs/SWITCHING.md; never set it in real mode.

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".woff2": "font/woff2",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
}


class GpuUnavailable(Exception):
    pass


# --- engine status -----------------------------------------------------------

def engine_json(path, port=None):
    """GET a JSON path on the engine. None when it is unreachable, errors, or is not JSON."""
    if _engine_disconnected and port is None:
        return None
    host, live_port = engine_addr()
    conn = http.client.HTTPConnection(host, port if port else live_port, timeout=ENGINE_CALL_S)
    try:
        conn.request("GET", path)
        resp = conn.getresponse()
        if resp.status != 200:
            return None
        return json.loads(resp.read())
    except (OSError, http.client.HTTPException, ValueError):
        return None
    finally:
        conn.close()


def context_from_entry(entry):
    """The context size an engine's /v1/models entry states, or None. llama.cpp does not state one,
    so it is read from /props there; the NInfer server states context_length here."""
    if not isinstance(entry, dict):
        return None
    for key in ("context_length", "max_model_len", "n_ctx"):
        value = entry.get(key)
        if isinstance(value, int) and not isinstance(value, bool) and value > 0:
            return value
    return None


def engine_context_tokens(port=None, models=None):
    """The engine's own context size, or None when it does not say. Used to tell two profiles of the
    same build apart (they share one model id and differ only in context)."""
    props = engine_json("/props", port)
    if isinstance(props, dict):
        value = props.get("n_ctx")
        if isinstance(value, int) and not isinstance(value, bool) and value > 0:
            return value
        settings = props.get("default_generation_settings")
        if isinstance(settings, dict):
            value = settings.get("n_ctx")
            if isinstance(value, int) and not isinstance(value, bool) and value > 0:
                return value
    models = engine_json("/v1/models", port) if models is None else models
    return context_from_entry(model_entry(models)) if isinstance(models, dict) else None


_active_match = None   # the matchId of the model the app chose; picks it on a server that lists several


def set_active_match(match):
    global _active_match
    _active_match = match if isinstance(match, str) and match else None


def model_entry(models):
    """The loaded model's entry in /v1/models, or the only entry when there is just one. A server that
    lists several models (Ollama, LM Studio) gives the one the app chose, when it is listed."""
    data = models.get("data") if isinstance(models, dict) else None
    if not isinstance(data, list):
        return None
    data = [entry for entry in data if isinstance(entry, dict) and isinstance(entry.get("id"), str) and entry["id"]]
    if _active_match and len(data) > 1:
        chosen = [m for m in data if isinstance(m, dict) and m.get("id") == _active_match]
        if chosen:
            return chosen[0]
    loaded = [m for m in data if isinstance(m, dict) and isinstance(m.get("status"), dict)
              and m["status"].get("value") == "loaded"]
    if loaded:
        return loaded[0]
    if len(data) == 1 and isinstance(data[0], dict):
        return data[0]
    return None


def code_stamp(root=HERE):
    """When the server's own Python code last changed: the newest change time of server.py and
    tools/*.py. The Local Arena shortcut compares it with the running server's, to restart an old server."""
    import glob
    files = [os.path.join(root, "server.py")] + glob.glob(os.path.join(root, "tools", "*.py"))
    return int(max((os.path.getmtime(f) for f in files if os.path.isfile(f)), default=0))


CODE_STAMP = code_stamp()


def status():
    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
        futures = [pool.submit(engine_json, "/metrics"), pool.submit(engine_json, "/v1/models"),
                   pool.submit(engine_json, "/props"), pool.submit(engine_json, "/slots"),
                   pool.submit(cached_gpu)]
        metrics, models, props, slots, gpu = (f.result() for f in futures)

    eng = metrics.get("engine") if isinstance(metrics, dict) else None
    entry = model_entry(models)
    if isinstance(eng, dict) and "version" in eng:
        kind = "strata"
        engine = {"model": entry["id"] if entry else None, "maxContext": eng.get("max_context"),
                  "version": eng.get("version")}
        lv = metrics.get("live")
        lv = lv if isinstance(lv, dict) else {}
        live = dict(LIVE_EMPTY, state=lv.get("state"), phase=lv.get("phase"),
                    promptRead=lv.get("prompt_read"), promptTotal=lv.get("prompt_total"),
                    generated=lv.get("generated"), tokS=lv.get("tok_s"), tokSMean=lv.get("tok_s_mean"))
    elif isinstance(models, dict) and isinstance(models.get("data"), list):
        kind = "llama.cpp"
        defaults = props.get("default_generation_settings") if isinstance(props, dict) else None
        n_ctx = defaults.get("n_ctx") if isinstance(defaults, dict) else None
        if n_ctx is None:
            n_ctx = context_from_entry(entry)
        if n_ctx is None and entry and isinstance(entry.get("meta"), dict):
            n_ctx = entry["meta"].get("n_ctx")
        engine = {"model": entry["id"] if entry else None, "maxContext": n_ctx, "version": None}
        busy = slots is not None and any(isinstance(s, dict) and s.get("is_processing") for s in slots)
        live = dict(LIVE_EMPTY, state=None if slots is None else ("generating" if busy else "idle"))
    else:
        kind = None
        engine = {"model": None, "maxContext": None, "version": None}
        live = dict(LIVE_EMPTY)

    kind = ENGINE_KIND_OVERRIDE if ENGINE_KIND_OVERRIDE else kind
    # Replies the engine writes at once: llama.cpp, NInfer and Strata all state it as /props total_slots.
    slots_n = props.get("total_slots") if isinstance(props, dict) else None
    slots_n = slots_n if kind is not None and isinstance(slots_n, int) and not isinstance(slots_n, bool) and slots_n > 0 else None
    engine = dict(reachable=kind is not None, kind=kind, slots=slots_n, **engine)
    st = {
        "gatewayVersion": VERSION,
        "codeStamp": CODE_STAMP,
        "engine": engine,
        "live": live,
        "gpu": {"name": gpu["name"], "usedMiB": gpu["usedMiB"], "totalMiB": gpu["totalMiB"]} if gpu else None,
        "warmup": _warmup_for_engine_status(engine["model"]) if engine["model"] else None,
        "time": time.time(),
    }
    note_status_for_record(st)
    return st


# --- Model catalogue -----------------------------------------------------------

def _read_list(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return []
    return [e for e in data if isinstance(e, dict)] if isinstance(data, list) else []


def load_user_models():
    """Models added in the app (data/user-models.json). [] when there are none."""
    return [dict(e, custom=True) for e in _read_list(USER_MODELS_PATH)]


def load_models():
    """The catalogue in config/models.json (or ARENA_MODELS), then the models added in the app, each with
    its saved load settings applied (see effective_entry). [] when both are missing or unreadable."""
    tuning = load_tuning()
    return [effective_entry(e, tuning.get(e.get("id"))) for e in _read_list(MODELS_PATH) + load_user_models()]


def current_engine_model():
    """The model id the engine reports as loaded, or None when it is unreachable or none is loaded."""
    entry = model_entry(engine_json("/v1/models"))
    return entry["id"] if entry else None


def model_on_disk(entry):
    """True when a Strata config file, a llama.cpp model folder, or a launcher script exists. A model
    added in the app needs its file and its llama-server; a running server is always "here"."""
    if entry.get("engine") == "external":
        return True
    if entry.get("engine") == "gguf":
        s = entry.get("settings") if isinstance(entry.get("settings"), dict) else {}
        return all(isinstance(s.get(k), str) and os.path.isfile(s[k]) for k in ("modelPath", "runtime"))
    path = entry.get("configPath")
    if isinstance(path, str) and path:
        return os.path.isfile(path)
    folder = entry.get("folder")
    if isinstance(folder, str) and folder:
        return os.path.isdir(folder)
    spec = entry.get("start")
    script = spec.get("script") if isinstance(spec, dict) else None
    if isinstance(script, str) and script:
        return os.path.isfile(script)
    return False


def entry_is_loaded(entry, engine_model, engine_ctx):
    """Is the engine running this entry? The id must match, and when the entry states its context
    size (two Bonsai profiles share one model id) the engine's own context size must match too."""
    match = entry.get("matchId")
    if not (engine_model and isinstance(match, str) and match and match in engine_model):
        return False
    if entry.get("engine") in ("external", "gguf") and match != engine_model:
        return False
    want = entry.get("matchContext")
    if isinstance(want, int) and not isinstance(want, bool) and engine_ctx != want:
        return False
    # Two Bonsai profiles can share the id and the context too (one chat, or two at once): the
    # engine's slot count tells them apart. An engine that does not say is not held against it.
    slots = entry.get("matchSlots")
    if isinstance(slots, int) and not isinstance(slots, bool):
        props = engine_json("/props")
        have = props.get("total_slots") if isinstance(props, dict) else None
        if isinstance(have, int) and not isinstance(have, bool) and have != slots:
            return False
    return True


def models_response():
    """Each catalogue entry plus onDisk (is it here) and loaded (is the engine running it)."""
    model_data = engine_json("/v1/models")
    active = model_entry(model_data)
    engine_model = active["id"] if active else None
    engine_ctx = context_from_entry(active)
    if engine_model and engine_ctx is None:
        engine_ctx = engine_context_tokens(models=model_data)
    tuning = load_tuning()
    entries = _read_list(MODELS_PATH) + load_user_models()
    raw = {e.get("id"): e for e in entries}
    out = []
    for base in entries:
        entry = effective_entry(base, tuning.get(base.get("id")))
        if not isinstance(entry, dict):
            continue
        match = entry.get("matchId")
        item = {
            "id": entry.get("id"),
            "name": entry.get("name"),
            "version": entry.get("version"),
            "engine": entry.get("engine"),
            "contextTokens": entry.get("contextTokens"),
            "matchId": match,
            "onDisk": model_on_disk(entry),
            "loaded": entry_is_loaded(entry, engine_model, engine_ctx),
        }
        port = launcher.resolve_port(entry, None)
        if not SWITCH_FAKE and port is not None and port != engine_port():
            item["loaded"] = False
        if port:
            item["port"] = port
        if isinstance(entry.get("matchContext"), int):
            item["matchContext"] = entry["matchContext"]
        if entry.get("note"):
            item["note"] = entry["note"]
        if entry.get("configPath"):
            item["configPath"] = entry["configPath"]
        if entry.get("folder"):
            item["folder"] = entry["folder"]
        item["loadKind"] = load_kind(entry)
        item["launch"] = launch_summary(entry)
        rec = tuning.get(entry.get("id")) or {}
        item["tuning"] = {k: rec[k] for k in ("reply", "load") if isinstance(rec.get(k), dict)}
        if item["loadKind"] == "ninfer":
            item["ninferLoad"] = ninfer_current(entry)                       # what it starts with now
            item["ninferBase"] = ninfer_current(raw.get(entry.get("id"), entry))  # without saved settings
        if entry.get("custom"):
            item["custom"] = True
            settings = entry.get("settings")
            item["settings"] = settings if isinstance(settings, dict) else {}
            if entry.get("addedAt"):
                item["addedAt"] = entry["addedAt"]
        out.append(item)
    return {"models": out}


# --- Adding models in the app ------------------------------------------------------
# Two kinds. "gguf": a model file Local Arena starts with llama-server on its own port (8085-8099).
# "external": a server already running on this PC (LM Studio, Ollama, llama-server you started), which
# Local Arena only connects to. Saved in USER_MODELS_PATH; the hand-kept catalogue is never written.

FOLDERS_PATH = os.path.join(os.path.dirname(USER_MODELS_PATH), "model-folders.json")
KNOWN_SERVERS = ((1234, "LM Studio"), (11434, "Ollama"), (8000, "vLLM"), (5000, "Text Generation WebUI"),
                 (8080, "llama-server"), (8081, "llama-server"), (8082, "llama-server"),
                 (8083, "llama-server"), (8084, "NInfer"))
_user_lock = threading.Lock()
SLUG_RE = re.compile(r"[^a-z0-9]+")


def _slug(text):
    return SLUG_RE.sub("-", str(text).lower()).strip("-")[:40] or "model"


def user_folders():
    data = _read_json(FOLDERS_PATH, [])
    return [p for p in data if isinstance(p, str)] if isinstance(data, list) else []


def scan_folders():
    out = []
    for p in model_files.default_folders() + user_folders():
        if p not in out:
            out.append(p)
    return out


def _known_paths():
    paths = set()
    for e in load_models():
        s = e.get("settings") if isinstance(e.get("settings"), dict) else {}
        if isinstance(s.get("modelPath"), str):
            paths.add(os.path.normcase(os.path.abspath(s["modelPath"])))
    return paths


def probe_server(port):
    """The model ids a local OpenAI-style server lists on a port, or None when nothing answers."""
    models = engine_json("/v1/models", port)
    data = models.get("data") if isinstance(models, dict) else None
    if not isinstance(data, list):
        return None
    return [m.get("id") for m in data if isinstance(m, dict) and isinstance(m.get("id"), str)]


def discover_response():
    """Model files in the scanned folders, llama-server programs, and running local servers."""
    folders = scan_folders()
    found = model_files.scan(folders)
    known = _known_paths()
    for m in found["models"]:
        m["added"] = os.path.normcase(os.path.abspath(m["path"])) in known
    # A fake run must never probe the real engines installed on this PC.
    ports = [ENGINE_PORT] if SWITCH_FAKE else sorted({p for p, _ in KNOWN_SERVERS} - set(USER_PORTS))
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(ports)) as pool:
        listed = dict(zip(ports, pool.map(probe_server, ports)))
    labels = dict(KNOWN_SERVERS)
    # The hand-kept catalogue's own ports (Strata, Bonsai, NInfer, MiniCPM) are already in the list.
    catalogue_ports = {launcher.resolve_port(e, None) for e in _read_list(MODELS_PATH)}
    added = {(e.get("port"), e.get("matchId")) for e in load_user_models() if e.get("engine") == "external"}
    servers = [{"port": p, "label": labels.get(p, "Server"), "models": ids,
                "added": [i for i in ids if (p, i) in added]}
               for p, ids in listed.items() if ids and p not in catalogue_ports]
    runtimes = model_files.find_runtimes([e.get("settings", {}).get("runtime") for e in load_user_models()])
    gpu = cached_gpu()
    return {"folders": folders, "userFolders": user_folders(), "models": found["models"],
            "truncated": found["truncated"], "runtimes": runtimes, "servers": servers,
            "gpuTotalMiB": gpu["totalMiB"] if gpu else None}


def _free_user_port(entries, skip_id=None):
    used = {e.get("port") for e in entries if e.get("id") != skip_id}
    for port in USER_PORTS:
        if port not in used:
            return port
    raise ValueError("Every port for added models (8085-8099) is in use. Remove a model first.")


def _clean_settings(raw, kind):
    """Only the settings Local Arena understands, each checked. Raises ValueError with a plain reason."""
    raw = raw if isinstance(raw, dict) else {}
    s = {}
    if kind == "gguf":
        for key in ("modelPath", "runtime"):
            value = raw.get(key)
            if not (isinstance(value, str) and os.path.isfile(value)):
                raise ValueError({"modelPath": "The model file was not found.",
                                  "runtime": "Pick a llama-server program that exists."}[key])
            s[key] = os.path.abspath(value)
        if not s["modelPath"].lower().endswith(".gguf"):
            raise ValueError("The model file must be a .gguf file.")
        projector = raw.get("projector")
        if isinstance(projector, str) and projector:
            if not os.path.isfile(projector):
                raise ValueError("The vision file was not found.")
            s["projector"] = os.path.abspath(projector)
        ctx = raw.get("contextTokens")
        if ctx not in (None, "", 0):
            if not (isinstance(ctx, int) and not isinstance(ctx, bool) and 512 <= ctx <= 2 ** 21):
                raise ValueError("Context must be a whole number of tokens from 512 up.")
            s["contextTokens"] = ctx
        gpu = raw.get("gpuLayers", "auto")
        if gpu not in ("auto", "all") and not (isinstance(gpu, int) and not isinstance(gpu, bool) and 0 <= gpu <= 999):
            raise ValueError("Layers on the graphics card must be auto, all, or a number.")
        s["gpuLayers"] = gpu
        flash = raw.get("flashAttn", "auto")
        if flash not in launcher.LLAMA_FLASH:
            raise ValueError("Flash attention must be auto, on or off.")
        s["flashAttn"] = flash
        kv = raw.get("kvCache", "f16")
        if kv not in launcher.LLAMA_KV_TYPES:
            raise ValueError("Cache type must be f16, q8_0 or q4_0.")
        s["kvCache"] = kv
        extra = raw.get("extraArgs", "")
        if not isinstance(extra, str) or len(extra) > 1000:
            raise ValueError("Extra flags must be text, at most 1000 characters.")
        try:
            launcher.split_extra_args(extra)
        except ValueError:
            raise ValueError("The extra flags have an unclosed quote.")
        reserved = {"-m", "--model", "--port", "--host", "-a", "--alias"}
        if any(arg.split("=", 1)[0] in reserved for arg in launcher.split_extra_args(extra)):
            raise ValueError("Extra flags cannot set the model, port, host or alias; Local Arena sets those.")
        s["extraArgs"] = extra.strip()
    return s


def user_model_save(body, model_id=None):
    """Add (model_id None) or edit a model added in the app. Returns the saved entry."""
    if not isinstance(body, dict):
        raise ValueError("The body must be a JSON object.")
    if body.get("settings") is not None and not isinstance(body["settings"], dict):
        raise ValueError("Model settings must be a JSON object.")
    with _user_lock:
        entries = _read_list(USER_MODELS_PATH)
        old = next((e for e in entries if e.get("id") == model_id), None) if model_id else None
        if model_id and old is None:
            raise LookupError("No added model has that id.")
        kind = old.get("engine") if old else body.get("kind")
        if kind not in ("gguf", "external"):
            raise ValueError("Say what to add: a model file (gguf) or a running server (external).")
        name = str(body.get("name") or (old or {}).get("name") or "").strip()[:80]
        version = str(body.get("version") if body.get("version") is not None else (old or {}).get("version") or "").strip()[:80]
        if not name:
            raise ValueError("Give the model a name.")
        note = str(body.get("note") if body.get("note") is not None else (old or {}).get("note") or "").strip()[:500]
        entry = {"name": name, "version": version, "engine": kind}
        if kind == "gguf":
            settings = _clean_settings(dict((old or {}).get("settings") or {}, **(body.get("settings") or {})), kind)
            meta = model_files.header(settings["modelPath"]) or {}
            entry["settings"] = settings
            entry["contextTokens"] = settings.get("contextTokens") or meta.get("contextLength") or None
            entry["port"] = old["port"] if old else _free_user_port(entries)
            entry["id"] = old["id"] if old else "user-%s-%s" % (_slug(name + " " + version), _short_hash(settings["modelPath"]))
            entry["matchId"] = entry["id"]
        else:
            port = body.get("port", (old or {}).get("port"))
            server_model = body.get("serverModel", (old or {}).get("matchId"))
            if not (isinstance(port, int) and not isinstance(port, bool) and 1 <= port <= 65535):
                raise ValueError("Give the server's port, a number such as 1234.")
            if port in (PORT,):
                raise ValueError("That is Local Arena's own port.")
            if not (isinstance(server_model, str) and server_model.strip()):
                raise ValueError("Pick which model on that server to use.")
            entry.update(port=port, matchId=server_model.strip(), settings={})
            ctx = body.get("contextTokens", (old or {}).get("contextTokens"))
            entry["contextTokens"] = ctx if isinstance(ctx, int) and not isinstance(ctx, bool) and ctx > 0 else None
            entry["id"] = old["id"] if old else "user-%s-%d-%s" % (_slug(server_model), port, _short_hash(server_model + str(port)))
        if note:
            entry["note"] = note
        entry["addedAt"] = (old or {}).get("addedAt") or time.time()
        if not old and any(e.get("id") == entry["id"] for e in load_models()):
            raise ValueError("That model is already in the list.")
        entries = [entry if e.get("id") == entry["id"] else e for e in entries] if old else entries + [entry]
        _write_json_atomic(USER_MODELS_PATH, entries)
        return dict(entry, custom=True)


def _short_hash(text):
    import hashlib
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:6]


def user_model_delete(model_id):
    with _user_lock:
        entries = _read_list(USER_MODELS_PATH)
        keep = [e for e in entries if e.get("id") != model_id]
        if len(keep) == len(entries):
            raise LookupError("Only models added in the app can be removed here.")
        _write_json_atomic(USER_MODELS_PATH, keep)
    with _user_lock:
        tuning = load_tuning()
        if tuning.pop(model_id, None) is not None:
            _write_json_atomic(TUNING_PATH, tuning)


# --- Per-model settings (the Models screen's Settings panel) ---------------------------------
# Saved in TUNING_PATH as {model id: {"reply": {...}, "load": {...}}}; the hand-kept catalogue is never
# written. Reply settings travel with every request (Chat, Arena, Tests). Load settings change how the
# model starts: for NInfer they become start-ninfer.ps1 options; a model added in the app keeps its load
# settings in its own entry (user-models.json); other launchers are shown read-only.

TUNING_PATH = os.path.join(os.path.dirname(USER_MODELS_PATH), "model-settings.json")
REPLY_NUMBERS = {   # key: (min, max, whole number)
    "temperature": (0, 2, False), "topP": (0, 1, False), "topK": (0, 200, True), "minP": (0, 1, False),
    "presencePenalty": (0, 2, False), "frequencyPenalty": (0, 2, False),
}
NINFER_CONTEXTS = (16384, 32768, 65536, 98304, 131072)
NINFER_LOAD = {
    "contextTokens": ("-Context", NINFER_CONTEXTS),
    "spec": ("-Spec", ("dflash2", "mtp", "none")),
    "draftTokens": ("-DraftTokens", tuple(range(1, 16))),
    "kvDtype": ("-KvDtype", ("rk4v4-e8", "rk2v4-e8", "rk4v4", "rk8v4")),
    "prefixCache": ("-PrefixCache", ("small", "large", "off")),
    "thinkingBudget": ("-ThinkingBudget", tuple(range(0, 8193))),
}


def load_tuning():
    data = _read_json(TUNING_PATH, {})
    return {k: v for k, v in data.items() if isinstance(v, dict)} if isinstance(data, dict) else {}


def _is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def clean_reply(raw):
    """Only the reply settings Local Arena understands, each checked. Absent or null keys are left out."""
    raw = raw if isinstance(raw, dict) else {}
    out = {}
    for key, (lo, hi, whole) in REPLY_NUMBERS.items():
        v = raw.get(key)
        if v is None or v == "":
            continue
        if isinstance(v, bool) or not isinstance(v, (int, float)) or (whole and not _is_int(v)) or not lo <= v <= hi:
            raise ValueError("%s must be %s from %s to %s." % (key, "a whole number" if whole else "a number", lo, hi))
        out[key] = v
    seed = raw.get("seed")
    if seed not in (None, ""):
        if not (_is_int(seed) and 0 <= seed <= 2 ** 31 - 1):
            raise ValueError("Seed must be a whole number from 0, or empty for a random seed.")
        out["seed"] = seed
    stop = raw.get("stop")
    if stop not in (None, "", []):
        if not (isinstance(stop, list) and len(stop) <= 4 and all(isinstance(s, str) and 0 < len(s) <= 64 for s in stop)):
            raise ValueError("Stop text is up to 4 pieces of text, each up to 64 characters.")
        out["stop"] = stop
    system = raw.get("system")
    if system not in (None, ""):
        if not isinstance(system, str) or len(system) > 8000:
            raise ValueError("The system prompt is text, at most 8,000 characters.")
        out["system"] = system
    return out


def load_kind(entry):
    """How Local Arena can change this model's load settings: gguf (all of them), ninfer (its start options),
    external (the server owns them), strata or script (read-only: their own launchers decide)."""
    engine = entry.get("engine")
    if engine in ("gguf", "external", "ninfer", "strata"):
        return engine
    return "script"


def clean_ninfer_load(raw):
    raw = raw if isinstance(raw, dict) else {}
    out = {}
    for key, (_, allowed) in NINFER_LOAD.items():
        v = raw.get(key)
        if v is None or v == "":
            continue
        if isinstance(v, bool) or v not in allowed:
            raise ValueError({"contextTokens": "Context must be 16K, 32K, 64K, 96K or 128K.",
                              "spec": "The drafter must be dflash2, mtp or none.",
                              "draftTokens": "Drafts must be a whole number from 1 to 15.",
                              "kvDtype": "Cache precision must be rk4v4-e8, rk2v4-e8, rk4v4 or rk8v4.",
                              "prefixCache": "Prefix cache must be small, large or off.",
                              "thinkingBudget": "The server thinking cap must be 0 (off) to 8192 tokens."}[key])
        out[key] = v
    if out.get("spec") == "none":
        out.pop("draftTokens", None)
    return out


def _script_args(args):
    """start-ninfer.ps1 arguments as an ordered {"-Name": "value"} map."""
    out, i = {}, 0
    args = [str(a) for a in args] if isinstance(args, list) else []
    while i < len(args):
        if args[i].startswith("-") and i + 1 < len(args) and not args[i + 1].startswith("-"):
            out[args[i]] = args[i + 1]
            i += 2
        else:
            out[args[i]] = None
            i += 1
    return out


def effective_entry(entry, tuning):
    """The entry as Local Arena will start it. For NInfer, saved load settings become start-ninfer.ps1 options
    (the Start-menu launcher takes none, so a changed setup calls start-ninfer.ps1 next to it, the way the
    128K entry already does). Everything else is returned unchanged."""
    load = (tuning or {}).get("load")
    if entry.get("engine") != "ninfer" or not isinstance(load, dict) or not load:
        return entry
    start = entry.get("start") if isinstance(entry.get("start"), dict) else {}
    script = start.get("script")
    if not isinstance(script, str) or not script:
        return entry
    folder = os.path.dirname(script)
    args = _script_args(start.get("args"))
    if load.get("spec") == "none":
        args.pop("-DraftTokens", None)
    for key, (flag, _) in NINFER_LOAD.items():
        if key in load:
            args[flag] = str(load[key])
    if load.get("spec") == "mtp" and "-GraphAllowanceMiB" not in args:
        args["-GraphAllowanceMiB"] = "0"     # MTP does not fit the 320 MiB graph allowance
    flat = []
    for k, v in args.items():
        flat += [k] if v is None else [k, v]
    out = dict(entry, start=dict(start, script=os.path.join(folder, "start-ninfer.ps1"), args=flat))
    if "contextTokens" in load:
        out["contextTokens"] = load["contextTokens"]
        out["matchContext"] = load["contextTokens"]
    return out


NINFER_DEFAULTS = {"contextTokens": 65536, "spec": "dflash2", "draftTokens": 6, "kvDtype": "rk4v4-e8",
                   "prefixCache": "small", "thinkingBudget": 0}   # start-ninfer.ps1's own defaults


def ninfer_current(entry):
    """The NInfer start options this entry runs with: its script arguments over the script's defaults."""
    start = entry.get("start") if isinstance(entry.get("start"), dict) else {}
    args = _script_args(start.get("args"))
    out = dict(NINFER_DEFAULTS)
    for key, (flag, _) in NINFER_LOAD.items():
        v = args.get(flag)
        if v is not None:
            out[key] = int(v) if isinstance(NINFER_DEFAULTS[key], int) and str(v).isdigit() else v
    if out["spec"] == "none":
        out["draftTokens"] = 0
    return out


def launch_summary(entry):
    """A plain description of how a model starts, for the read-only Load tab."""
    kind = load_kind(entry)
    if kind == "strata":
        return {"by": "Strata", "detail": entry.get("configPath") or ""}
    start = entry.get("start") if isinstance(entry.get("start"), dict) else {}
    script = start.get("script") if isinstance(start.get("script"), str) else ""
    args = " ".join(str(a) for a in start.get("args") or [])
    return {"by": os.path.basename(script) if script else "", "detail": (script + (" " + args if args else "")).strip()}


def tuning_save(model_id, body):
    """Save one model's reply and load settings. Returns the saved record ({} after a reset)."""
    if not isinstance(body, dict):
        raise ValueError("The body must be a JSON object.")
    raw_entry = next((e for e in _read_list(MODELS_PATH) + load_user_models() if e.get("id") == model_id), None)
    if raw_entry is None:
        raise LookupError("No model in the list has that id.")
    record = {}
    reply = clean_reply(body.get("reply"))
    if reply:
        record["reply"] = reply
    load = body.get("load")
    if isinstance(load, dict) and load:
        kind = load_kind(raw_entry)
        if kind != "ninfer":
            raise ValueError("This model's load settings are set by its own launcher, not here."
                             if kind != "gguf" else "Save an added model's load settings through its own entry.")
        cleaned = clean_ninfer_load(load)
        if cleaned:
            record["load"] = cleaned
    with _user_lock:
        tuning = load_tuning()
        if record:
            tuning[model_id] = record
        else:
            tuning.pop(model_id, None)
        _write_json_atomic(TUNING_PATH, tuning)
    return record


def add_folder(path):
    if not (isinstance(path, str) and os.path.isdir(path)):
        raise ValueError("That folder does not exist.")
    path = os.path.abspath(path)
    with _user_lock:
        folders = user_folders()
        if path not in folders:
            _write_json_atomic(FOLDERS_PATH, folders + [path])


# --- Switch service --------------------------------------------------------------

_switch_lock = threading.Lock()
_switch = {"state": "idle", "model": None, "message": "No switch has run yet.",
           "startedAt": None, "finishedAt": None, "warmupPending": False, "warmup": None}


def switch_mode():
    """Which launcher to use. Fake wins when both variables are set (the safer one)."""
    return "fake" if SWITCH_FAKE else "real"


def set_switch(**updates):
    with _switch_lock:
        _switch.update(updates)


# Milestone phrases the real engine writes to the switch log while it loads, with the progress
# each one stands for (see docs/SWITCHING.md). Matched as case-insensitive substrings in order.
_START_MILESTONES = (
    ("engine started", 0.2),   # the engine process is up
    ("native pack", 0.3),      # reading the model files
    ("of weights loaded", 0.5),
    ("GiB at", 0.7),           # experts loaded into memory
    ("expert cache", 0.85),    # filling the GPU's expert cache
    ("VRAM free", 0.95),       # almost ready
    ("captured the", 0.97),    # warming up
)


def _read_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def _replace_file(tmp, path):
    """Rename a finished temporary file over its target. On Windows the rename fails while another
    program or thread has the target open, so wait a moment and try again before giving up."""
    for attempt in range(6):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            if attempt == 5:
                raise
            time.sleep(0.02 * (attempt + 1))


def _write_json_atomic(path, data):
    folder = os.path.dirname(path)
    os.makedirs(folder, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=folder, suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(json.dumps(data, ensure_ascii=False).encode("utf-8"))
        _replace_file(tmp, path)
    except OSError:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def _read_switch_times():
    data = _read_json(SWITCH_TIMES_PATH, {})
    return data if isinstance(data, dict) else {}

def _record_switch_stop(seconds):
    """Save how long stopping took, so the next stopping bar is honest."""
    try:
        value = round(max(0.1, float(seconds)), 1)
    except (TypeError, ValueError):
        return
    with _switch_lock:
        times = _switch.get("times")
        if not isinstance(times, dict):
            times = _read_switch_times()
            if not isinstance(times, dict):
                times = {}
            _switch["times"] = times
        times["stopS"] = value
    _write_telemetry(SWITCH_TIMES_PATH, times)


def _record_switch_start(model_id, seconds):
    """Save how long this model took to start, so its next start bar is honest."""
    try:
        value = round(max(0.1, float(seconds)), 1)
    except (TypeError, ValueError):
        return
    if not isinstance(model_id, str) or not model_id:
        return
    with _switch_lock:
        times = _switch.get("times")
        if not isinstance(times, dict):
            times = _read_switch_times()
            if not isinstance(times, dict):
                times = {}
            _switch["times"] = times
        starts = times.setdefault("startS", {})
        starts[model_id] = value
    _write_telemetry(SWITCH_TIMES_PATH, times)


def _write_telemetry(path, data):
    try:
        _write_json_atomic(path, data)
    except OSError as error:
        _switch_log_note("Could not save %s: %s" % (os.path.basename(path), error))


def _as_secs(value, default):
    if isinstance(value, (int, float)) and value > 0:
        return float(value)
    return default


def _log_milestone_progress():
    """The highest milestone the engine log has reached, or 0.0 when it has none yet."""
    try:
        with open(SWITCH_LOG, "r", encoding="utf-8", errors="replace") as f:
            text = f.read().lower()
    except OSError:
        return 0.0
    best = 0.0
    for phrase, progress in _START_MILESTONES:
        if phrase in text and progress > best:
            best = progress
    return best


def switch_presentation(st):
    """(stage, stageLabel, progress) from facts, not a straight line.

    stopping: 0 to 0.15 against the last measured stop time (default 12 s).
    loading:  the highest milestone the engine log reached, or elapsed time against that model's
              last measured start time (default 60 s), capped at 0.95 — whichever is further.
    ready:    1.0 done. idle: nothing running. failed: the switch failed.
    """
    state = st["state"]
    times = st.get("times") if isinstance(st.get("times"), dict) else _read_switch_times()
    if state == "stopping":
        stop_s = _as_secs(times.get("stopS"), SWITCH_STOP_DEFAULT_S)
        base = st["startedAt"] or time.time()
        elapsed = max(0.0, time.time() - base)
        return "stopping", "Stopping the current model", min(0.15, elapsed / stop_s * 0.15)
    if state == "starting":
        if st.get("warmupPending"):
            return "warming", "Warming up the model", 0.97
        start_s = _as_secs((times.get("startS") or {}).get(st["model"]), SWITCH_START_DEFAULT_S)
        base = st.get("startStartedAt") or st["startedAt"] or time.time()
        elapsed = max(0.0, time.time() - base)
        by_time = min(0.95, 0.15 + elapsed / start_s * 0.8)
        return "loading", "Loading the model into memory", min(0.95, max(_log_milestone_progress(), by_time))
    if state == "ready":
        if st["model"] is None:
            return "idle", "No model is loaded.", None
        return "ready", "The model is ready.", 1.0
    if state == "failed":
        return "failed", "The switch failed.", None
    return "idle", "No switch has run yet.", None


def switch_status_response():
    with _switch_lock:
        st = dict(_switch)
    elapsed = None
    if st["startedAt"] is not None:
        end = st["finishedAt"] if st["finishedAt"] is not None else time.time()
        elapsed = round(end - st["startedAt"], 1)
    stage, stage_label, progress = switch_presentation(st)
    return {"state": st["state"], "model": st["model"], "message": st["message"],
            "startedAt": st["startedAt"], "elapsedS": elapsed,
            "stage": stage, "stageLabel": stage_label, "progress": progress}


def last_switch_note():
    """One plain line for the live record, or None when no switch has run."""
    with _switch_lock:
        st = dict(_switch)
    if st["state"] == "idle":
        return None
    end = st["finishedAt"] if st["finishedAt"] is not None else time.time()
    secs = round(end - st["startedAt"], 1) if st["startedAt"] is not None else 0
    return "%s: %s (%ss)" % (st["state"], st["model"] or "unload", secs)


def run_switch(entry, warmup_seed=None):
    """One switch in its own thread: stop what runs, start the chosen model, warm it up, wait done.
    entry None means unload (stop everything). The route already set state to stopping."""
    global _active_external, _engine_disconnected
    name = (entry.get("name") or entry.get("id")) if entry else None
    match = entry.get("matchId") if entry else None
    model_id = entry.get("id") if entry else None
    try:
        started = _switch_started_at()
        was_external = _active_external
        _active_external = bool(entry and entry.get("engine") == "external")
        _engine_disconnected = False
        set_active_match(match)
        if entry is not None and entry.get("engine") == "external" and switch_mode() == "real":
            # A server Local Arena does not run (LM Studio, Ollama, your own llama-server): stopping
            # "every model" could kill it, and it is already loaded. Point at it and wait.
            pass
        elif was_external and switch_mode() == "real":
            if entry is not None:
                launcher.stop_owned()
        else:
            launcher.stop_all(switch_mode(), ENGINE_PORT, SWITCH_LOG)
            _record_switch_stop(time.time() - started)  # every switch stops something first
        if entry is None:
            _engine_disconnected = bool(was_external and switch_mode() == "real")
            set_engine_port(ENGINE_PORT)  # nothing loaded: go back to the app's own port
            set_switch(state="ready", message="Model unloaded. Nothing is running now.", finishedAt=time.time())
            return
        start_started = time.time()
        set_switch(state="starting", message="Loading %s." % name, startStartedAt=start_started)
        launcher.start(entry, switch_mode(), ENGINE_PORT, SWITCH_LOG)
        end = time.monotonic() + SWITCH_TIMEOUT_S
        exited_at = None
        while time.monotonic() < end:
            if switch_mode() == "real":
                # The model's own launcher knows its port, and writes it when it is up.
                # Each model can answer on its own port.
                set_engine_port(launcher.resolve_port(entry, ENGINE_PORT))
            current = current_engine_model()
            context = engine_context_tokens() if current and entry.get("matchContext") and switch_mode() != "fake" else entry.get("matchContext")
            if entry_is_loaded(entry, current, context):
                if switch_mode() == "real":
                    launcher.remember_script_engine(entry)
                _record_switch_start(model_id, time.time() - start_started)
                set_switch(warmupPending=True)
                _switch_log_note("warm-up: starting for %s" % (name,))
                # Key the warm-up by the model id the engine itself reports (what /api/status shows).
                _warmup(current, name, warmup_seed)
                set_switch(state="ready", message="%s is loaded and answering." % name, finishedAt=time.time())
                return
            # The launcher gives up long before the app does (NInfer does it in about 40 seconds and
            # says why in its log). When it has exited and nothing is answering, the load has failed:
            # say so now instead of leaving the progress bar close to done for ten minutes.
            finished, code = launcher.start_finished()
            # Some launch scripts catch their own error and still exit 0 (NInfer's does, after it shows
            # its message). A script that has exited with nothing answering after a short grace (room
            # for a server it started detached to finish loading) has failed too.
            if finished and exited_at is None:
                exited_at = time.monotonic()
            gave_up = finished and (code != 0 or launcher.direct_engine_started()
                                    or time.monotonic() - exited_at > LAUNCHER_GRACE_S)
            if gave_up and not current_engine_model():
                set_switch(state="failed", finishedAt=time.time(), message=
                           "%s did not start: its launcher stopped (exit %s) without the model answering. A game or another "
                           "program using the graphics card's memory is the usual cause. "
                           "The launcher's own message is in the switch log." % (name, code))
                _switch_log_note("%s: launcher exited %s before the engine answered" % (name, code))
                return
            time.sleep(1)
        set_switch(state="failed", message="%s did not get ready within 10 minutes." % name,
                   finishedAt=time.time())
    except Exception as e:  # a launcher problem becomes a plain failure, never a crash
        set_switch(state="failed", message="The switch failed. %s" % e, finishedAt=time.time())


def _switch_started_at():
    with _switch_lock:
        return _switch.get("startedAt") or time.time()


# --- slow-start warm-up -----------------------------------------------------------


def _switch_log_note(text):
    """A dated line in the switch log, so a slow start can be reviewed later."""
    try:
        os.makedirs(LIVE, exist_ok=True)
        with open(SWITCH_LOG, "a", encoding="utf-8") as f:
            f.write("[%s] %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), text))
    except OSError:
        pass


def _read_model_speed():
    data = _read_json(MODEL_SPEED_PATH, {})
    return data if isinstance(data, dict) else {}


def _record_warmup(model_id, tokens_per_second):
    """Keep the best result per model in data/live/model-speed.json."""
    try:
        value = round(float(tokens_per_second), 2)
    except (TypeError, ValueError):
        return None
    with _switch_lock:
        speeds = _read_model_speed()
        previous = speeds.get(model_id)
        best = value
        if isinstance(previous, (int, float)) and previous > value:
            best = float(previous)
        speeds[model_id] = best
    _write_telemetry(MODEL_SPEED_PATH, speeds)
    _switch_log_note("warm-up: %s read %s tokens per second (best on record %s)" % (model_id, value, best))
    return best


def _warmup_tps_from_usage(reply, seconds):
    """Tokens per second for the warm-up reply.

    The engine's own decode speed wins when it reports one (`timings.predicted_per_second`, sent by
    llama.cpp and NInfer): it counts from the first token to the last, as the Chat speed does. Only
    without it is the speed the reply's token count over the whole round trip. That fallback includes
    the prompt read and the request itself, so on a short reply it reads far below the real speed:
    NInfer's three-token "Ready." read 2.7 tok/s that way while the engine measured 127."""
    timings = reply.get("timings") if isinstance(reply, dict) else None
    if isinstance(timings, dict):
        engine_tps = timings.get("predicted_per_second")
        engine_n = timings.get("predicted_n")
        if (isinstance(engine_tps, (int, float)) and engine_tps > 0
                and isinstance(engine_n, (int, float)) and engine_n >= WARMUP_MIN_ENGINE_TOKENS):
            return float(engine_tps)
    usage = reply.get("usage") if isinstance(reply, dict) else None
    completed = usage.get("completion_tokens") if isinstance(usage, dict) else None
    if not isinstance(completed, (int, float)) or completed <= 0:
        return None
    if seconds <= 0:
        return None
    return completed / seconds


def _warmup(model_id, name, seed=None):
    """After a switch reaches ready: one tiny question, tok/s from usage + elapsed, keep the best.

    The result lands on the switch state and on every /api/status as `warmup` for the loaded model.
    Never throws: a failed probe is a note in the switch log, and the app works as before.
    """
    if seed is None and SWITCH_FAKE:
        seed = os.environ.get(WARMUP_SEED_ENV)  # test-only override, see the constant's comment
    t0 = time.time()
    tokens_per_second = None
    set_switch(warmupPending=True)  # the status shows stage "warming" while the probe runs
    if seed is None:
        try:
            body = json.dumps({
                "model": current_engine_model() or name,
                # Long enough to time: a three-token "Ready." is mostly request overhead.
                "messages": [{"role": "user", "content": WARMUP_PROMPT}],
                "stream": False,
                "max_tokens": WARMUP_MAX_TOKENS,
                "reasoning_effort": "none",
            }).encode("utf-8")
            host, live_port = engine_addr()
            conn = http.client.HTTPConnection(host, live_port, timeout=WARMUP_TIMEOUT_S)
            try:
                conn.request("POST", "/v1/chat/completions", body=body, headers={"Content-Type": "application/json"})
                resp = conn.getresponse()
                reply = json.loads(resp.read()) if resp.status == 200 else None
            finally:
                conn.close()
            if isinstance(reply, dict) and reply.get("choices"):
                tokens_per_second = _warmup_tps_from_usage(reply, time.time() - t0)
        except (OSError, http.client.HTTPException, ValueError) as e:
            _switch_log_note("warm-up: the engine did not answer the test question (%s)" % e)
    else:
        tokens_per_second = _seed_to_tps(seed)
    result = None
    if tokens_per_second is None:
        _switch_log_note("warm-up: no usable answer, nothing recorded for %s" % model_id)
    else:
        # Judge against the best on record BEFORE this attempt lands, so a slow first start is
        # still called slow (the floor applies when there is no record at all).
        slow = _is_slow_start(model_id, tokens_per_second)
        best = _record_warmup(model_id, tokens_per_second)
        result = {"tokensPerSecond": round(tokens_per_second, 2),
                  "usual": best if best is not None else round(tokens_per_second, 2),
                  "slow": slow}
    with _switch_lock:
        _switch["warmup"] = result
        _switch["warmupPending"] = False
    _warmup_status_warmup(model_id, result)


def _seed_to_tps(seed):
    """A test-seeded tok/s: a number is used as measured; 'Nslow'/'Nok' pick slow/fast without luck."""
    try:
        value = float(seed)
    except (TypeError, ValueError):
        return None
    return value if value > 0 else None


def _is_slow_start(model_id, tokens_per_second):
    """Slow: under 40 percent of this model's best on record, or under 10 tok/s with no record."""
    best = _read_model_speed().get(model_id)
    threshold = (best * WARMUP_SLOW_SHARE) if isinstance(best, (int, float)) and best > 0 else WARMUP_SLOW_FLOOR
    return tokens_per_second < threshold


# Every /api/status carries the loaded model's warm-up, so the page can show the slow-start
# sentence while the switch thread may already be gone.


def _warmup_status_warmup(model_id, result):
    with _warmup_state_lock:
        _attempt_warmups[model_id] = result


_warmup_state_lock = threading.Lock()
_attempt_warmups = {}  # model id -> last warm-up result ("best" numbers come from model-speed.json)


def _warmup_for_engine_status(engine_model):
    with _warmup_state_lock:
        result = _attempt_warmups.get(engine_model)
    if result is None:
        return None
    out = {"tokensPerSecond": result["tokensPerSecond"], "slow": result["slow"], "usual": result["usual"]}
    return out


# --- Live record ---------------------------------------------------------------

START_MONO = time.monotonic()
_record_lock = threading.Lock()
_record_last = 0.0   # monotonic time of the last record write (0 = never)
_last_status = None  # last status() result, reused by the background thread


def _fmt_uptime(seconds):
    h, rem = divmod(int(seconds), 3600)
    m, s = divmod(rem, 60)
    return "%dh %02dm %02ds" % (h, m, s)


def render_record(st):
    eng = st.get("engine") or {}
    live = st.get("live") or {}
    gpu = st.get("gpu")
    speed = live.get("tokSMean")
    if speed is None:
        speed = live.get("tokS")
    speed_text = ("%.1f tok/s" % speed) if isinstance(speed, (int, float)) else "unknown"
    lines = [
        "# Local Arena live record",
        "Updated: %s" % time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(st.get("time") or time.time())),
        "Gateway uptime: %s" % _fmt_uptime(time.monotonic() - START_MONO),
        "",
        "Engine reachable: %s" % ("yes" if eng.get("reachable") else "no"),
        "Kind: %s" % (eng.get("kind") or "none"),
        "Model: %s" % (eng.get("model") or "none"),
        "Context: %s" % (eng.get("maxContext") if eng.get("maxContext") is not None else "unknown"),
        "Version: %s" % (eng.get("version") or "unknown"),
        "State: %s" % (live.get("state") or "unknown"),
        "Last speed: %s" % speed_text,
        "",
    ]
    if gpu:
        lines += ["GPU: %s" % gpu["name"], "GPU memory: %d / %d MiB" % (gpu["usedMiB"], gpu["totalMiB"])]
    else:
        lines += ["GPU: not available"]
    lines += [
        "",
        "Saved: %d chats, %d votes, %d runs" % (len(list_records("chats")), len(list_records("votes")),
                                                len(list_records("runs"))),
        "Last switch: %s" % (last_switch_note() or "none"),
        "",
    ]
    return "\n".join(lines)


def write_record(st):
    text = render_record(st)
    os.makedirs(LIVE, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=LIVE, suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(text.encode("utf-8"))
        _replace_file(tmp, RECORD_PATH)
    except OSError:
        try:
            os.remove(tmp)
        except OSError:
            pass


def note_status_for_record(st):
    global _record_last, _last_status
    with _record_lock:
        _last_status = st
        now = time.monotonic()
        due = now - _record_last >= RECORD_POLL_S
        if due:
            _record_last = now
    if due:
        try:
            write_record(st)
        except OSError as error:
            _switch_log_note("Could not write live record: %s" % error)


def record_beat():
    global _record_last
    while True:
        time.sleep(RECORD_IDLE_S)
        with _record_lock:
            st = _last_status
            if st is None or time.monotonic() - _record_last < RECORD_IDLE_S:
                continue
            _record_last = time.monotonic()
        try:
            write_record(st)
        except OSError as error:
            _switch_log_note("Could not write live record: %s" % error)


def adopt_beat():
    """Follow a model that someone started outside the app, so the panel never says "not answering"
    while a model is on the card. Local calls only, and it does nothing in test mode."""
    while True:
        time.sleep(ADOPT_INTERVAL_S)
        try:
            adopt_running_model()
        except Exception:
            pass  # never let a probe kill the thread


# --- GPU -----------------------------------------------------------------------

def to_int(text):
    text = text.strip()
    return int(text) if text.isdigit() else None  # "[N/A]" becomes None


def run_smi(args):
    try:
        out = subprocess.run([NVIDIA_SMI] + args, capture_output=True, timeout=GPU_CMD_S, check=True,
                             encoding="utf-8", errors="replace", creationflags=NO_WINDOW)
    except (OSError, subprocess.SubprocessError) as e:  # missing, failed or hung
        raise GpuUnavailable("nvidia-smi is not available.") from e
    return out.stdout


def parse_gpu(gpu_text, apps_text):
    """Parse nvidia-smi CSV (noheader, nounits). Figures it reports as [N/A] become None."""
    lines = [line for line in gpu_text.splitlines() if line.strip()]
    if not lines:
        raise GpuUnavailable("nvidia-smi is not available.")
    try:
        name, used, total = (part.strip() for part in lines[0].rsplit(",", 2))
        processes = []
        for line in apps_text.splitlines():
            if not line.strip():
                continue
            pid, proc, mem = (part.strip() for part in line.rsplit(",", 2))
            if pid.isdigit():
                processes.append({"pid": int(pid), "name": re.split(r"[\\/]", proc)[-1], "usedMiB": to_int(mem)})
    except ValueError as e:
        raise GpuUnavailable("nvidia-smi output was not understood.") from e
    return {"name": name, "usedMiB": to_int(used), "totalMiB": to_int(total), "processes": processes}


def read_gpu(run=run_smi):
    gpu_text = run(["--query-gpu=name,memory.used,memory.total", "--format=csv,noheader,nounits"])
    apps_text = run(["--query-compute-apps=pid,process_name,used_memory", "--format=csv,noheader,nounits"])
    return parse_gpu(gpu_text, apps_text)


_gpu_cache = {"at": None, "value": None}
_gpu_lock = threading.Lock()


def cached_gpu(run=run_smi):
    """read_gpu, reused for GPU_CACHE_S so polling cannot pile up processes. None when unavailable."""
    with _gpu_lock:
        if _gpu_cache["at"] is None or time.monotonic() - _gpu_cache["at"] >= GPU_CACHE_S:
            try:
                value = read_gpu(run)
            except GpuUnavailable:
                value = None
            _gpu_cache.update(at=time.monotonic(), value=value)
        return _gpu_cache["value"]


# --- saved records -------------------------------------------------------------

_store_lock = threading.Lock()  # serializes index read-modify-write across request threads


def _index_path(collection):
    return os.path.join(STORE, collection, "_index.json")


def _record_id(name):
    """The record id for a file name, or None when it is not a record file."""
    if not name.endswith(".json"):
        return None
    record_id = name[:-len(".json")]
    return record_id if ID_RE.fullmatch(record_id) else None


def _read_index(collection):
    try:
        with open(_index_path(collection), encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _write_index(collection, index):
    _write_json_atomic(_index_path(collection), index)


def _rebuild_index(collection):
    """Read every record once and write the index. Used when the index is missing or stale."""
    folder = os.path.join(STORE, collection)
    index = {}
    for name in os.listdir(folder):
        record_id = _record_id(name)
        if record_id is None:
            continue
        path = os.path.join(folder, name)
        try:
            updated = os.path.getmtime(path)
            with open(path, encoding="utf-8") as f:
                record = json.load(f)
        except OSError:  # removed or locked while rebuilding
            continue
        except ValueError:  # unreadable JSON: indexed without a title
            record = None
        index[record_id] = {"updated": updated,
                            "title": record.get("title") if isinstance(record, dict) else None}
    _write_index(collection, index)
    return index


def _index_is_current(collection, index):
    """True when the index has one entry per record file, checked by name only (no record reads)."""
    folder = os.path.join(STORE, collection)
    ids = {record_id for name in os.listdir(folder) if (record_id := _record_id(name)) is not None}
    return ids == index.keys()


def list_records(collection):
    folder = os.path.join(STORE, collection)
    if not os.path.isdir(folder):
        return []
    with _store_lock:
        index = _read_index(collection)
        if index is None or not _index_is_current(collection, index):
            index = _rebuild_index(collection)
        items = [{"id": record_id, "updated": meta.get("updated"), "title": meta.get("title")}
                 for record_id, meta in index.items()]
    items.sort(key=lambda item: item["updated"], reverse=True)
    return items


def is_proxied(path):
    return path == "/v1" or path.startswith("/v1/") or path in PROXY_PATHS


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def guess_type(self, path):
        ext = os.path.splitext(path)[1].lower()
        return MIME.get(ext, super().guess_type(path))

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/api/status":
            return self.send_json(status())
        if path == "/api/record":
            try:
                with open(RECORD_PATH, "rb") as f:
                    return self.reply_text(f.read())
            except FileNotFoundError:
                return self.reply_text(b"No live record yet.", 404)
        if path == "/api/gpu":
            gpu = cached_gpu()
            if gpu is None:
                return self.send_json({"error": "nvidia-smi is not available."}, 503)
            return self.send_json(gpu)
        if path == "/api/models":
            return self.send_json(models_response())
        if path == "/api/models/discover":
            return self.send_json(discover_response())
        if path == "/api/switch/status":
            return self.send_json(switch_status_response())
        if path == "/api/store" or path.startswith("/api/store/"):
            return self.store("GET")
        if is_proxied(path):
            return self.proxy()
        super().do_GET()

    def do_POST(self):
        path = self.path.split("?")[0]
        if path == "/api/switch":
            return self.switch_start()
        if path in ("/api/models", "/api/models/inspect", "/api/models/folders", "/api/models/probe"):
            return self.models_post(path)
        if path == "/api/store" or path.startswith("/api/store/"):
            return self.store("POST")
        if is_proxied(path):
            return self.proxy()
        self.send_json({"error": "Not found."}, 404)

    def do_PUT(self):
        path = self.path.split("?")[0]
        if path.startswith("/api/models/") and path.endswith("/settings"):
            model_id = path[len("/api/models/"):-len("/settings")]
            try:
                return self.send_json({"tuning": tuning_save(model_id, self.read_body())})
            except LookupError as e:
                return self.send_json({"error": str(e)}, 404)
            except ValueError as e:
                return self.send_json({"error": str(e)}, 400)
            except OSError:
                return self.send_json({"error": "The model settings could not be saved."}, 500)
        if path.startswith("/api/models/"):
            return self.models_post(path, method="PUT")
        if path == "/api/store" or path.startswith("/api/store/"):
            return self.store("PUT")
        self.send_json({"error": "Not found."}, 404)

    def do_DELETE(self):
        path = self.path.split("?")[0]
        if path.startswith("/api/models/"):
            model_id = path[len("/api/models/"):]
            with _switch_lock:
                busy = _switch["state"] in ("stopping", "starting") and _switch.get("model") == model_id
            if busy:
                return self.send_json({"error": "That model is loading. Wait for it to finish."}, 409)
            try:
                user_model_delete(model_id)
            except LookupError as e:
                return self.send_json({"error": str(e)}, 404)
            except OSError:
                return self.send_json({"error": "The list of added models could not be saved."}, 500)
            return self.send_json({"ok": True})
        if path == "/api/store" or path.startswith("/api/store/"):
            return self.store("DELETE")
        self.send_json({"error": "Not found."}, 404)

    def do_OPTIONS(self):
        if is_proxied(self.path.split("?")[0]):
            return self.proxy()
        self.send_json({"error": "Not found."}, 404)

    def body_length(self):
        try:
            return max(0, int(self.headers.get("Content-Length") or 0))
        except ValueError:
            return 0

    def discard(self, n):
        while n > 0:
            part = self.rfile.read(min(n, 65536))
            if not part:
                break
            n -= len(part)

    def proxy(self):
        """Forward this request to the engine and stream its reply back as it arrives."""
        if _engine_disconnected:
            return self.send_json({"error": no_engine_message()}, 502)
        length = self.body_length()
        if length < 0 or length > MAX_BODY:
            return self.send_json({"error": "The body is too large or has an invalid length."}, 413)
        body = self.rfile.read(length) if length else None
        headers = {"Content-Type": self.headers["Content-Type"]} if self.headers.get("Content-Type") else {}
        host, live_port = engine_addr()
        conn = http.client.HTTPConnection(host, live_port, timeout=10)
        finished = threading.Event()
        disconnected = threading.Event()
        watcher = None
        try:
            conn.connect()
            conn.sock.settimeout(None)  # a streamed reply has no timeout
            upstream_socket = conn.sock

            def watch_disconnect():
                # Cancellation must also close a model still reading the prompt, before it sends
                # headers or a token. Peeking leaves any client bytes untouched.
                while not finished.is_set():
                    try:
                        ready, _, _ = select.select([self.connection], [], [], 0.1)
                        if ready and not self.connection.recv(1, socket.MSG_PEEK):
                            disconnected.set()
                            try:
                                upstream_socket.shutdown(socket.SHUT_RDWR)
                            except OSError:
                                pass
                            return
                        if ready:
                            finished.wait(0.1)
                    except (OSError, ValueError):
                        return

            watcher = threading.Thread(target=watch_disconnect, daemon=True)
            watcher.start()
            conn.request(self.command, self.path, body=body, headers=headers)
            resp = conn.getresponse()
        except (OSError, http.client.HTTPException):
            finished.set()
            conn.close()
            if disconnected.is_set():
                return
            return self.send_json({"error": no_engine_message()}, 502)
        try:
            self.send_response(resp.status, resp.reason)
            if resp.getheader("Content-Type"):
                self.send_header("Content-Type", resp.getheader("Content-Type"))
            BaseHTTPRequestHandler.end_headers(self)  # a pass-through reply gets no extra headers
            while True:
                chunk = resp.read1(4096)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
        except (OSError, http.client.HTTPException):
            pass  # the browser went away, or the engine cut the reply short
        finally:
            finished.set()
            conn.close()  # closing the engine socket makes the engine stop generating
            if watcher:
                watcher.join(0.3)

    def switch_start(self):
        """POST /api/switch {"model": "<id>"} or {"model": null} (unload). 202 now, work in a thread."""
        if not (SWITCH_FAKE or SWITCH_REAL):
            return self.send_json({"error": SWITCH_OFF}, 403)
        length = self.body_length()
        if length > MAX_BODY:
            self.discard(length)
            return self.send_json({"error": "The body is too large."}, 413)
        try:
            body = json.loads(self.rfile.read(length))
        except ValueError:
            return self.send_json({"error": "The body must be JSON."}, 400)
        if not isinstance(body, dict) or "model" not in body:
            return self.send_json({"error": "Say which model to load, or use null to unload."}, 400)
        model_id = body["model"]
        entry = None
        if model_id is not None:
            if not isinstance(model_id, str):
                return self.send_json({"error": "A model id is a word, or null to unload."}, 400)
            entry = next((e for e in load_models() if isinstance(e, dict) and e.get("id") == model_id), None)
            if entry is None:
                return self.send_json({"error": "No model in the list has that id."}, 404)
        # Test seam: ARENA_WARMUP_SEED (or an env seed) forces the warm-up's tok/s so the
        # slow/fast logic in tools/test_gateway.py can be tested without timing luck.
        warmup_seed = os.environ.get(WARMUP_SEED_ENV) if SWITCH_FAKE else None
        if SWITCH_FAKE and body.get("warmupSeed") is not None:
            warmup_seed = str(body["warmupSeed"])
        with _switch_lock:
            if _switch["state"] in ("stopping", "starting"):
                return self.send_json({"error": "A switch is already running. Wait for it to finish."}, 409)
            _switch.update(state="stopping", model=model_id, message="Stopping the model that is running.",
                           startedAt=time.time(), finishedAt=None, warmupPending=False, warmup=None,
                           startStartedAt=None)
        threading.Thread(target=run_switch, args=(entry, warmup_seed), daemon=True).start()
        return self.send_json({"ok": True}, 202)

    def read_body(self):
        length = self.body_length()
        if length > MAX_BODY:
            self.discard(length)
            raise ValueError("The body is too large.")
        try:
            return json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            raise ValueError("The body must be JSON.")

    def models_post(self, path, method="POST"):
        """Add, edit, inspect: the models added in the app. Plain-language errors, never a crash."""
        try:
            body = self.read_body()
            if path == "/api/models/inspect":
                return self.send_json(model_files.describe(body.get("path") if isinstance(body, dict) else None))
            if path == "/api/models/folders":
                add_folder(body.get("path") if isinstance(body, dict) else None)
                return self.send_json(discover_response())
            if path == "/api/models/probe":
                port = body.get("port") if isinstance(body, dict) else None
                if not (isinstance(port, int) and not isinstance(port, bool) and 1 <= port <= 65535):
                    raise ValueError("Give a port number such as 1234.")
                ids = probe_server(port)
                if ids is None:
                    return self.send_json({"error": "Nothing is answering on port %d." % port}, 404)
                return self.send_json({"port": port, "models": ids})
            if method == "PUT":
                return self.send_json({"model": user_model_save(body, path[len("/api/models/"):])})
            return self.send_json({"model": user_model_save(body)}, 201)
        except model_files.GGUFError as e:
            return self.send_json({"error": str(e)}, 400)
        except LookupError as e:
            return self.send_json({"error": str(e)}, 404)
        except ValueError as e:
            return self.send_json({"error": str(e)}, 400)
        except OSError:
            return self.send_json({"error": "The list of added models could not be saved."}, 500)

    def store(self, method):
        try:
            return self._store(method)
        except OSError:
            return self.send_json({"error": "The saved records could not be read or written."}, 500)

    def _store(self, method):
        parts = self.path.split("?")[0].split("/")[3:]  # /api/store/<collection>/<id>
        if not parts or parts[0] not in STORE_COLLECTIONS or len(parts) > 2:
            return self.send_json({"error": "Not found."}, 404)
        collection = parts[0]
        if len(parts) == 1:
            if method != "GET":
                return self.send_json({"error": "Use GET on a collection."}, 405)
            return self.send_json({"items": list_records(collection)})
        record_id = parts[1]
        if not ID_RE.fullmatch(record_id):
            return self.send_json({"error": "An id is 1 to 64 lowercase letters, digits, _ or -, "
                                            "starting with a letter or digit."}, 400)
        path = os.path.join(STORE, collection, record_id + ".json")
        if method == "GET":
            # Read under the store lock: on Windows a read that overlaps the rename of a save fails.
            try:
                with _store_lock, open(path, "rb") as f:
                    body = f.read()
            except FileNotFoundError:
                return self.send_json({"error": "No saved record has that id."}, 404)
            except OSError:
                return self.send_json({"error": "The record could not be read."}, 500)
            return self.reply(body)
        if method == "PUT":
            return self.save(collection, record_id, path)
        if method == "DELETE":
            with _store_lock:
                try:
                    os.remove(path)
                except FileNotFoundError:
                    pass
                index = _read_index(collection)
                if index is not None and record_id in index:
                    del index[record_id]
                    _write_index(collection, index)
            return self.send_json({"ok": True})
        self.send_json({"error": "Method not allowed."}, 405)

    def save(self, collection, record_id, path):
        length = self.body_length()
        if length > MAX_BODY:
            self.discard(length)
            return self.send_json({"error": "A saved record can be at most 5 MB."}, 413)
        try:
            record = json.loads(self.rfile.read(length))
        except ValueError:
            return self.send_json({"error": "The body must be JSON."}, 400)
        if not isinstance(record, dict):
            return self.send_json({"error": "The body must be a JSON object."}, 400)
        with _store_lock:
            if self.headers.get("If-None-Match") == "*" and os.path.exists(path):
                return self.send_json({"error": "A saved record already uses that id."}, 412)
            folder = os.path.dirname(path)
            os.makedirs(folder, exist_ok=True)
            fd, tmp = tempfile.mkstemp(dir=folder, suffix=".tmp")
            try:
                with os.fdopen(fd, "wb") as f:
                    f.write(json.dumps(record, ensure_ascii=False).encode("utf-8"))
                _replace_file(tmp, path)
            except OSError:
                try:
                    os.remove(tmp)
                except OSError:
                    pass
                return self.send_json({"error": "The record could not be saved."}, 500)
            updated = os.path.getmtime(path)
            title = record.get("title") if isinstance(record, dict) else None
            index = _read_index(collection)
            if index is None:
                _rebuild_index(collection)  # reads every record once, including this one
            else:
                index[record_id] = {"updated": updated, "title": title}
                _write_index(collection, index)
        self.send_json({"ok": True, "id": record_id, "updated": updated})

    def send_json(self, obj, status=200):
        self.reply(json.dumps(obj).encode("utf-8"), status)

    def reply(self, body, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def reply_text(self, body, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class BindHTTPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    # Threaded: Chrome opens idle spare connections, and a one-at-a-time server hangs on them.
    daemon_threads = True
    # One server per port. On Windows SO_REUSEADDR lets a second server bind a port that is already
    # listening, and requests then go to whichever one Windows picks: that is how a restart left a
    # fresh window talking to an old server stuck on a dead switch. So on Windows the
    # port is held exclusively and a second server fails to start; elsewhere SO_REUSEADDR only covers
    # TIME_WAIT and is kept.
    allow_reuse_address = os.name != "nt"

    def server_bind(self):
        if os.name == "nt" and hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def report_for_port(port):
    """What is answering on a port: (model id, context size), or (None, None) when nothing is."""
    models = engine_json("/v1/models", port)
    reported = model_entry(models) if isinstance(models, dict) else None
    if not reported:
        return None, None
    return reported.get("id"), engine_context_tokens(port)


def adopted_entry(entries, report):
    """The first catalogue entry whose model is really answering, and its port. `report(port)` says
    what answers there. Each port is asked once, but every entry that uses it is checked: two entries
    can share a port and differ only in context (NInfer's 64K and 128K profiles both answer on 8084)."""
    cache = {}
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        port = launcher.resolve_port(entry, None)
        if not port:
            continue
        if port not in cache:
            cache[port] = report(port)
        reported, context = cache[port]
        if reported and entry_is_loaded(entry, reported, context):
            return entry, port
    return None, None


def adopt_running_model(force=False):
    """If a model is already answering, point the app at its port, so the panel shows what is really
    loaded whoever started it. Only the catalogue's own ports are tried, and never in test mode: the
    test engine keeps its test port. Returns the adopted entry, or None."""
    global _adopt_checked_at, _active_external
    if SWITCH_FAKE or (os.environ.get("ARENA_ENGINE") and not SWITCH_REAL):
        return None
    with _switch_lock:
        if _switch.get("state") in ("stopping", "starting"):
            return None
        switch_started = _switch.get("startedAt")
    now = time.monotonic()
    if not force and now - _adopt_checked_at < ADOPT_INTERVAL_S:
        return None
    _adopt_checked_at = now
    if _engine_disconnected:
        return None
    selected = engine_addr()
    selected_match = _active_match
    entries = load_models()
    # Prefer the selected endpoint while its selected model still answers.
    if _active_port is not None:
        reported, context = report_for_port(selected[1])
        for entry in entries:
            if launcher.resolve_port(entry, None) == selected[1] and entry_is_loaded(entry, reported, context):
                with _switch_lock:
                    if (_switch.get("state") in ("stopping", "starting") or _switch.get("startedAt") != switch_started
                            or engine_addr() != selected or _active_match != selected_match):
                        return None
                    _active_external = entry.get("engine") == "external"
                if SWITCH_REAL and entry.get("engine") != "external":
                    launcher.remember_script_engine(entry)
                return entry
    entry, port = adopted_entry(entries, report_for_port)
    if entry is None:
        return None
    with _switch_lock:
        if (_switch.get("state") in ("stopping", "starting") or _switch.get("startedAt") != switch_started
                or engine_addr() != selected or _active_match != selected_match):
            return None
        set_engine_port(port)
        set_active_match(entry.get("matchId"))
        _active_external = entry.get("engine") == "external"
    if SWITCH_REAL and entry.get("engine") != "external":
        launcher.remember_script_engine(entry)
    return entry


if __name__ == "__main__":
    try:
        httpd = BindHTTPServer(("127.0.0.1", PORT), Handler)
    except OSError as e:
        print("Local Arena cannot start: port %d is already in use (%s). Another copy may be running; "
              "stop it first." % (PORT, e), file=sys.stderr)
        sys.exit(1)
    threading.Thread(target=record_beat, daemon=True).start()
    threading.Thread(target=adopt_beat, daemon=True).start()
    threading.Thread(target=adopt_running_model, kwargs={"force": True}, daemon=True).start()
    print("Local Arena is running at http://127.0.0.1:%d/ (engine %s)" % (PORT, ENGINE))
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
