"""Portable catalogue fixtures cover model families and shared-context profiles.

Checks the catalogue's shape and the port rule: a model answers on the port its own launcher wrote,
never on a guessed one.
"""
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import launcher  # noqa: E402

TMP = tempfile.TemporaryDirectory(prefix="arena-models-")
import atexit
atexit.register(TMP.cleanup)
with open(os.path.join(HERE, "fixtures", "models.json"), encoding="utf-8") as handle:
    fixture_text = handle.read().replace("$FIXTURE", TMP.name.replace("\\", "/"))
MODELS_PATH = os.path.join(TMP.name, "models.json")
with open(MODELS_PATH, "w", encoding="utf-8") as handle:
    handle.write(fixture_text)
os.environ["ARENA_MODELS"] = MODELS_PATH
os.environ["ARENA_ENGINE"] = "127.0.0.1:%d" % (8772 + int(os.environ.get("ARENA_PORT_OFFSET", "0")))
for model in json.loads(fixture_text):
    for file in [model.get("configPath"), (model.get("start") or {}).get("script")]:
        if file:
            open(file, "a").close()
failures = 0


def check(name, ok, detail=""):
    global failures
    if not ok:
        failures += 1
    print(("PASS" if ok else "FAIL") + " " + name + ((" (" + detail + ")") if detail else ""))


with open(MODELS_PATH, "r", encoding="utf-8") as f:
    models = json.load(f)

check("the list is a list", isinstance(models, list))
ids = [m.get("id") for m in models if isinstance(m, dict)]
check("nine models", len(models) == 9, str(len(models)))
check("ids are unique", len(set(ids)) == len(ids), ", ".join(sorted(str(i) for i in ids)))
check("every entry has the fields the app reads",
      all(isinstance(m.get("id"), str) and isinstance(m.get("name"), str) and isinstance(m.get("version"), str)
          and isinstance(m.get("engine"), str) and isinstance(m.get("contextTokens"), int)
          and isinstance(m.get("matchId"), str) for m in models))
check("every entry says where it answers", all(isinstance(m.get("port"), int) for m in models))

strata = [m for m in models if m.get("engine") == "strata"]
scripts = [m for m in models if m.get("engine") != "strata"]
check("the two Strata models keep their config files",
      len(strata) == 2 and all(os.path.isfile(m.get("configPath", "")) for m in strata))
check("every other model has a launcher script that exists",
      all(os.path.isfile((m.get("start") or {}).get("script", "")) for m in scripts),
      ", ".join(m["name"] for m in scripts if not os.path.isfile((m.get("start") or {}).get("script", ""))))

# Two pairs share one model id and differ only in context (Example Fast/128K, NInfer 64K/128K), so the
# app tells them apart by the context size the engine itself reports.
by_match = {}
for m in models:
    by_match.setdefault(m.get("matchId"), []).append(m)
shared = {k: v for k, v in by_match.items() if len(v) > 1}
check("two model ids are shared by two entries each",
      sorted(len(v) for v in shared.values()) == [2, 2],
      json.dumps({str(k)[:26]: len(v) for k, v in shared.items()}))
check("every shared id tells its entries apart by context",
      all(all(isinstance(m.get("matchContext"), int) for m in v)
          and len({m["matchContext"] for m in v}) == len(v) for v in shared.values()),
      ", ".join("%s: %s" % (str(k)[:26], [m.get("matchContext") for m in v]) for k, v in shared.items()))

ninfer = [m for m in models if m.get("matchId") == "example-27b"]
n64 = next(m for m in ninfer if m.get("matchContext") == 65536)
n128 = next(m for m in ninfer if m.get("matchContext") == 131072)
check("the 64K NInfer entry takes the launcher's own settings",
      n64.get("start", {}).get("args") == [] and str(n64.get("start", {}).get("script")).endswith("infer-launch.ps1"),
      "%s %s" % (n64.get("start", {}).get("script"), n64.get("start", {}).get("args")))
# 4 drafts is pinned: measured best under MTP at 128K, so the script's default (6, for 64K
# dflash2) does not leak into this profile.
check("the 128K NInfer entry passes its profile to the launcher",
      n128.get("start", {}).get("args") == ["-Spec", "mtp", "-DraftTokens", "4", "-Context", "131072", "-GraphAllowanceMiB", "0", "-KvDtype", "rk2v4-e8"],
      str(n128.get("start", {}).get("args")))
check("both NInfer entries stop the same way",
      n64.get("stop") == n128.get("stop") and isinstance(n128.get("stop"), dict))

ports = {m.get("port") for m in scripts} | {m.get("port") for m in strata}
check("the ports are the ones the launchers use",
      {8080, 8081, 8082, 8083, 8084} == ports, ", ".join(str(p) for p in sorted(ports)))

# --- the port rule -------------------------------------------------------------------------
entry = {"id": "x", "port": 8081, "portFile": os.path.join(PROJECT, "no-such-port-file.json")}
check("no port file: the listed port is used", launcher.resolve_port(entry, 9999) == 8081)

with tempfile.TemporaryDirectory() as tmp:
    path = os.path.join(tmp, "example-server.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"Pid": 4321, "Port": 8090, "Build": "v2-mtp"}, f)
    check("a port file wins over the listed port", launcher.resolve_port(dict(entry, portFile=path), 9999) == 8090)
    with open(path, "w", encoding="utf-8") as f:
        f.write("")
    check("an empty port file falls back", launcher.resolve_port(dict(entry, portFile=path), 9999) == 8081)
    with open(path, "w", encoding="utf-8") as f:
        f.write("{ not json")
    check("a broken port file falls back", launcher.resolve_port(dict(entry, portFile=path), 9999) == 8081)
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"Port": "not a number"}, f)
    check("a nonsense port falls back", launcher.resolve_port(dict(entry, portFile=path), 9999) == 8081)

check("an entry with no port at all uses the app's default", launcher.resolve_port({"id": "y"}, 9999) == 9999)
check("a missing entry never throws", launcher.resolve_port(None, 9999) == 9999)

# --- telling two profiles of one build apart -------------------------------------------------
# Example Fast 64K and Example 128K report the same model id, so the app also compares the context the
# engine gives in /props. Nothing is called loaded on a guess.
sys.path.insert(0, PROJECT)
import server  # noqa: E402

entries = server.load_models()
family = [m for m in entries if str(m.get("matchId")).startswith("example-27b-")]
fast = next(m for m in family if m["matchContext"] == 65536)
long = next(m for m in family if m["matchContext"] == 131072)
MID = "example-27b-mtp"
check("the fast profile is loaded at 64K", server.entry_is_loaded(fast, MID, 65536))
check("the fast profile is not loaded at 128K", not server.entry_is_loaded(fast, MID, 131072))
check("the long profile is loaded at 128K", server.entry_is_loaded(long, MID, 131072))
check("an unknown context claims neither profile", not server.entry_is_loaded(fast, MID, None))
check("a different model is not this one", not server.entry_is_loaded(fast, "example-vision-1b", 65536))
plain = next(m for m in entries if m["id"] == "example-vision-1b")
check("an entry with no stated context only needs the id",
      server.entry_is_loaded(plain, "example-vision-1b", None))

ninfer_entries = [m for m in entries if m.get("matchId") == "example-27b"]
n64 = next(m for m in ninfer_entries if m["matchContext"] == 65536)
n128 = next(m for m in ninfer_entries if m["matchContext"] == 131072)
check("the NInfer 64K entry is loaded at 64K", server.entry_is_loaded(n64, "example-27b", 65536))
check("the NInfer 64K entry is not loaded at 128K", not server.entry_is_loaded(n64, "example-27b", 131072))
check("the NInfer 128K entry is loaded at 128K", server.entry_is_loaded(n128, "example-27b", 131072))
check("with no context reported, neither NInfer entry claims to be loaded",
      not server.entry_is_loaded(n64, "example-27b", None) and not server.entry_is_loaded(n128, "example-27b", None))

check("the context is read from an engine that states context_length",
      server.context_from_entry({"id": "example-27b", "context_length": 131072}) == 131072)
check("max_model_len works too", server.context_from_entry({"max_model_len": 65536}) == 65536)
check("an engine that states nothing gives None", server.context_from_entry({"id": "x"}) is None)
check("a nonsense context is ignored", server.context_from_entry({"context_length": "big"}) is None)
check("a missing entry gives None", server.context_from_entry(None) is None)

# Adoption: which entry is the thing that is really answering. Two entries share one port (NInfer's
# 64K and 128K profiles both answer on 8084), so every entry that uses a port must be checked.
def report_nothing(port):
    return None, None


def report_128k(port):
    return ("example-27b", 131072) if port == 8084 else (None, None)


def report_64k(port):
    return ("example-27b", 65536) if port == 8084 else (None, None)


def report_example_fast(port):
    return (MID, 65536) if port == 8081 else (None, None)


entry, port = server.adopted_entry(entries, report_nothing)
check("nothing answering: nothing is adopted", entry is None and port is None)
entry, port = server.adopted_entry(entries, report_128k)
check("a 128K NInfer on 8084 is adopted as the 128K entry",
      bool(entry) and str(entry.get("version")).startswith("128K") and port == 8084,
      "%s at %s" % (entry and entry.get("version"), port))
entry, port = server.adopted_entry(entries, report_64k)
check("a 64K NInfer on 8084 is adopted as the 64K entry",
      bool(entry) and str(entry.get("version")).startswith("64K") and port == 8084,
      "%s at %s" % (entry and entry.get("version"), port))
entry, port = server.adopted_entry(entries, report_example_fast)
check("a Example Fast on 8081 is adopted as Example Fast",
      bool(entry) and entry.get("name") == "Example Fast" and port == 8081,
      "%s at %s" % (entry and entry.get("name"), port))

check("the app starts on its own port", server.engine_port() == server.ENGINE_PORT)
server.set_engine_port(8083)
check("the app follows a model's port", server.engine_addr() == (server.ENGINE_HOST, 8083))
server.set_engine_port("nonsense")
check("a nonsense port is ignored", server.engine_port() == 8083)

# What the browser gets: the port, the context a shared-id entry needs, and the plain note.
server.current_engine_model = lambda: None  # catalogue shape must never probe a real engine
server.engine_json = lambda *args, **kwargs: None
payload: dict = {str(m.get("id")): m for m in server.models_response()["models"]}
check("the models API says where each model answers",
      payload.get("example-27b", {}).get("port") == 8084
      and payload.get("example-vision-1b", {}).get("port") == 8083
      and payload.get("example-next-iq3_xxs", {}).get("port") == 8080)
check("the models API says which context a shared-id entry needs",
      payload.get("example-27b", {}).get("matchContext") == 65536
      and payload.get("example-27b-128k", {}).get("matchContext") == 131072
      and payload.get("example-27b-mtp", {}).get("matchContext") == 65536)
check("the models API carries the note the row shows on hover",
      "tok/s" in str(payload.get("example-27b", {}).get("note", "")))
check("every model in the payload has a name the list can show",
      all(m.get("name") and m.get("version") for m in payload.values()))

# A load must not sit at 95% for ten minutes when the launcher has already given up.
import subprocess as sp  # noqa: E402

launcher._last_start = None
check("nothing launched yet: not finished", launcher.start_finished() == (False, None))
proc = sp.Popen([sys.executable, "-c", "import time; time.sleep(30)"], creationflags=getattr(sp, "CREATE_NO_WINDOW", 0))
launcher._last_start = proc
check("a launcher that is still running is not finished", launcher.start_finished() == (False, None))
proc.terminate()
proc.wait()
check("a launcher that has exited is reported with its exit code", launcher.start_finished()[0] is True)
launcher._last_start = None

# NInfer's -Stop calls wsl.exe, which boots WSL. It must run only when NInfer's distro is already up,
# or every load and unload of a Strata or Example model starts WSL.
check("WSL off: NInfer's stop is skipped",
      [s for s, _ in launcher.stop_scripts(False)] == [launcher.FAMILY_STOP])
check("WSL up: NInfer's stop runs too",
      [s for s, _ in launcher.stop_scripts(True)] == [launcher.FAMILY_STOP, launcher.NINFER_LAUNCH])
check("the running list names the distro", launcher.distro_in_list("Ubuntu-24.04\r\n"))
check("another distro is not NInfer's", not launcher.distro_in_list("docker-desktop\r\n"))
check("an empty running list means WSL is off", not launcher.distro_in_list(""))


if failures:
    print("FAIL %s" % failures)
    sys.exit(1)
print("PASS")
