"""Per-model settings (Models > Settings): validation, NInfer load options becoming start-ninfer.ps1
arguments, and the catalogue left untouched. Run: python tools/test_model_settings.py (no server, no GPU)."""
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
TMP = tempfile.mkdtemp(prefix="arena-tuning-")
CATALOGUE = [
    {"id": "n64", "name": "NInfer", "engine": "ninfer", "contextTokens": 65536, "matchId": "example-27b", "matchContext": 65536,
     "start": {"script": os.path.join(TMP, "ninfer-launch.ps1"), "args": []}},
    {"id": "n128", "name": "NInfer 128K", "engine": "ninfer", "contextTokens": 131072, "matchId": "example-27b", "matchContext": 131072,
     "start": {"script": os.path.join(TMP, "start-ninfer.ps1"), "args": ["-Spec", "mtp", "-DraftTokens", "4", "-Context", "131072", "-GraphAllowanceMiB", "0", "-KvDtype", "rk2v4-e8"]}},
    {"id": "mini", "name": "Example Vision", "engine": "llama.cpp", "matchId": "example-vision", "start": {"script": os.path.join(TMP, "vision-launch.ps1"), "args": ["-Size", "1B"]}},
]
with open(os.path.join(TMP, "models.json"), "w", encoding="utf-8") as f:
    json.dump(CATALOGUE, f)
os.environ["ARENA_MODELS"] = os.path.join(TMP, "models.json")
os.environ["ARENA_STORE"] = os.path.join(TMP, "store")
sys.path.insert(0, ROOT)
sys.argv = [sys.argv[0]]
import server  # noqa: E402

FAILS = []


def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + (" (%s)" % detail if detail else ""), flush=True)
    if not ok:
        FAILS.append(name)


def entry(model_id):
    return next(e for e in server.load_models() if e["id"] == model_id)


def rejected(model_id, body):
    try:
        server.tuning_save(model_id, body)
    except ValueError:
        return True
    return False


check("defaults read from the launcher", server.ninfer_current(entry("n64")) == server.NINFER_DEFAULTS)
check("128K reads its own arguments", server.ninfer_current(entry("n128"))["spec"] == "mtp"
      and server.ninfer_current(entry("n128"))["kvDtype"] == "rk2v4-e8")

saved = server.tuning_save("n64", {"reply": {"temperature": 0.6, "topK": 20, "stop": ["END"], "system": "Be brief."},
                                   "load": {"contextTokens": 32768, "draftTokens": 4}})
check("reply and load saved", saved["reply"]["topK"] == 20 and saved["load"] == {"contextTokens": 32768, "draftTokens": 4})
e = entry("n64")
check("a changed setup calls start-ninfer.ps1", e["start"]["script"].endswith("start-ninfer.ps1"), e["start"]["script"])
check("its options become arguments", e["start"]["args"] == ["-Context", "32768", "-DraftTokens", "4"], e["start"]["args"])
check("the context check follows", e["matchContext"] == 32768 and e["contextTokens"] == 32768)
check("the other NInfer entry is untouched", entry("n128")["start"]["args"][:2] == ["-Spec", "mtp"])

server.tuning_save("n128", {"load": {"spec": "dflash2", "draftTokens": 6}})
args = entry("n128")["start"]["args"]
check("an existing argument is replaced, the rest kept", args[args.index("-Spec") + 1] == "dflash2"
      and args[args.index("-KvDtype") + 1] == "rk2v4-e8" and args.count("-DraftTokens") == 1, args)
server.tuning_save("n128", {"load": {"spec": "none"}})
check("no drafter drops the draft count", "-DraftTokens" not in entry("n128")["start"]["args"], entry("n128")["start"]["args"])
server.tuning_save("n128", {"load": {"spec": "mtp", "contextTokens": 131072}})
check("MTP keeps the graph allowance off", "-GraphAllowanceMiB" in entry("n128")["start"]["args"])

check("temperature above 2 refused", rejected("n64", {"reply": {"temperature": 3}}))
check("top-k must be whole", rejected("n64", {"reply": {"topK": 2.5}}))
check("five stop texts refused", rejected("n64", {"reply": {"stop": ["a", "b", "c", "d", "e"]}}))
check("16 drafts refused", rejected("n64", {"load": {"draftTokens": 16}}))
check("an unknown context refused", rejected("n64", {"load": {"contextTokens": 50000}}))
check("an unknown cache refused", rejected("n64", {"load": {"kvDtype": "q4"}}))
check("load settings refused for a model with its own launcher", rejected("mini", {"load": {"contextTokens": 32768}}))
check("reply settings allowed for it", server.tuning_save("mini", {"reply": {"minP": 0.05}}) == {"reply": {"minP": 0.05}})
try:
    server.tuning_save("nope", {})
    check("an unknown model refused", False)
except LookupError:
    check("an unknown model refused", True)

server.tuning_save("n64", {})
check("an empty save resets", "n64" not in server.load_tuning()
      and entry("n64")["start"]["script"].endswith("ninfer-launch.ps1"))
with open(os.path.join(TMP, "models.json"), encoding="utf-8") as f:
    check("the catalogue file is never written", json.load(f) == CATALOGUE)
server.engine_json = lambda *args, **kwargs: None  # no real engine is part of this catalogue test
listed = {m["id"]: m for m in server.models_response()["models"]}
check("the list says how each model loads", listed["n128"]["loadKind"] == "ninfer" and listed["mini"]["loadKind"] == "script")
check("the list carries saved settings", listed["mini"]["tuning"] == {"reply": {"minP": 0.05}})

print("%d checks: %s" % (len(FAILS), "ALL PASS" if not FAILS else "FAILED: " + ", ".join(FAILS)) if FAILS else "ALL PASS")
sys.exit(1 if FAILS else 0)
