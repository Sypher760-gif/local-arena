"""Adding models in the app: GGUF headers, folder scan, the llama-server command, and the gateway API.
Run: python tools/test_add_models.py   (standard library; starts one gateway on a test port)"""
import json
import os
import struct
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import launcher  # noqa: E402
import model_files  # noqa: E402

OFFSET = int(os.environ.get("ARENA_PORT_OFFSET", "0") or 0)
PORT = 8783 + OFFSET            # gateway; the fake engine uses 8784 (both test ports, unused elsewhere)
FAILS = []


def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + (" (%s)" % detail if detail else ""), flush=True)
    if not ok:
        FAILS.append(name)


def gguf_bytes(arch="llama", name="Tiny Test", ctx=4096, layers=12, projector=False, pad=0):
    """A minimal GGUF v3 header: a few metadata keys, a token list (array of strings), no tensors."""
    def s(text):
        b = text.encode()
        return struct.pack("<Q", len(b)) + b
    kv = []
    kv.append(s("general.architecture") + struct.pack("<I", 8) + s("clip" if projector else arch))
    kv.append(s("general.name") + struct.pack("<I", 8) + s(name))
    kv.append(s("%s.context_length" % arch) + struct.pack("<I", 4) + struct.pack("<I", ctx))
    kv.append(s("%s.block_count" % arch) + struct.pack("<I", 4) + struct.pack("<I", layers))
    kv.append(s("%s.embedding_length" % arch) + struct.pack("<I", 4) + struct.pack("<I", 2048))
    kv.append(s("%s.attention.head_count" % arch) + struct.pack("<I", 4) + struct.pack("<I", 16))
    tokens = [s("tok%d" % i) for i in range(50)]
    kv.append(s("tokenizer.ggml.tokens") + struct.pack("<I", 9) + struct.pack("<IQ", 8, len(tokens)) + b"".join(tokens))
    kv.append(s("tokenizer.ggml.scores") + struct.pack("<I", 9) + struct.pack("<IQ", 6, 50) + b"\0" * 200)
    head = b"GGUF" + struct.pack("<I", 3) + struct.pack("<Q", 0) + struct.pack("<Q", len(kv)) + b"".join(kv)
    return head + b"\0" * pad


def request(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request("http://127.0.0.1:%d%s" % (PORT, path), data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, json.load(e)


def main():
    tmp = tempfile.mkdtemp(prefix="arena-add-")
    folder = os.path.join(tmp, "models", "Tiny-Test-GGUF")
    os.makedirs(folder)
    model = os.path.join(folder, "Tiny-Test-7B-Q4_K_M.gguf")
    with open(model, "wb") as f:
        f.write(gguf_bytes(pad=4096))
    with open(os.path.join(folder, "mmproj-Tiny-f16.gguf"), "wb") as f:
        f.write(gguf_bytes(projector=True))
    with open(os.path.join(folder, "notes.txt"), "w") as f:
        f.write("not a model")
    fake_runtime = os.path.join(tmp, "llama-server.exe")
    with open(fake_runtime, "wb") as f:
        f.write(b"")

    # 1. Header reading
    meta = model_files.read_gguf(model)
    check("reads architecture, context and layers from the header",
          meta["architecture"] == "llama" and meta["contextLength"] == 4096 and meta["layers"] == 12, str(meta))
    check("reads the cache cost per token", meta["kvBytesPerToken"] == 2 * 12 * 128 * 16 * 2, str(meta["kvBytesPerToken"]))
    try:
        model_files.read_gguf(os.path.join(folder, "notes.txt"))
        check("a text file is not a model", False)
    except model_files.GGUFError:
        check("a text file is not a model", True)
    check("compression comes from the file name",
          model_files.quant_from_name("Example-8B-IQ3_XXS-00001-of-00002.gguf") == "IQ3_XXS"
          and model_files.quant_from_name("Example-PTQ1_0.gguf") == "PTQ1_0"
          and model_files.quant_from_name("model.gguf") is None)
    check("the name is the file name without its compression",
          model_files.display_name(model, meta) == "Tiny-Test-7B")
    check("a generic file name takes its folder's name",
          model_files.display_name(os.path.join(folder, "model-Q4_K_M.gguf")) == "Tiny-Test")

    # 2. Scan
    os.environ["ARENA_MIN_MODEL_BYTES"] = "1"
    model_files.MIN_MODEL_BYTES = 1
    found = model_files.scan([os.path.join(tmp, "models")])["models"]
    check("a scan lists the model once, not its vision file", len(found) == 1 and found[0]["file"].startswith("Tiny"),
          str([m["file"] for m in found]))
    check("the vision file is attached to the model next to it",
          found and found[0].get("projector", "").endswith("mmproj-Tiny-f16.gguf"))

    # 3. The llama-server command
    entry = {"id": "user-x", "matchId": "user-x", "port": 8086, "engine": "gguf",
             "settings": {"modelPath": model, "runtime": fake_runtime, "contextTokens": 8192, "gpuLayers": "all",
                          "flashAttn": "on", "kvCache": "q8_0", "projector": found[0]["projector"],
                          "extraArgs": '--temp 0.7 --override-kv "a=b c"'}}
    cmd = launcher.gguf_command(entry)
    joined = " ".join(cmd)
    check("command: model, local host, own port, alias", cmd[0] == fake_runtime and "-m" in cmd
          and "--host 127.0.0.1" in joined and "--port 8086" in joined and "--alias user-x" in joined, joined)
    check("command: context, all layers, flash on, q8 cache, vision file",
          "-c 8192" in joined and "-ngl 999" in joined and "-fa on" in joined and "-ctk q8_0 -ctv q8_0" in joined
          and "--mmproj" in joined, joined)
    check("command: extra flags kept as arguments, quotes grouped", cmd[-2:] == ["--override-kv", "a=b c"], str(cmd[-3:]))
    entry["settings"].update(gpuLayers="auto", flashAttn="auto", kvCache="f16", extraArgs="")
    plain = " ".join(launcher.gguf_command(entry))
    check("command: auto settings leave llama-server's own defaults", "-ngl" not in plain and "-fa" not in plain
          and "-ctk" not in plain, plain)

    # 4. Gateway API
    models_path = os.path.join(tmp, "models.json")
    with open(models_path, "w") as f:
        json.dump([{"id": "fake-model", "name": "Fake", "version": "Q4", "engine": "llama.cpp",
                    "contextTokens": 4096, "matchId": "fake-model", "folder": tmp}], f)
    env = dict(os.environ, ARENA_PORT=str(PORT), ARENA_ENGINE="127.0.0.1:%d" % (8784 + OFFSET),
               ARENA_STORE=os.path.join(tmp, "store"), ARENA_LIVE=os.path.join(tmp, "live"),
               ARENA_MODELS=models_path, ARENA_SWITCH_FAKE="1", ARENA_MIN_MODEL_BYTES="1",
               USERPROFILE=tmp, HOME=tmp)
    proc = subprocess.Popen([sys.executable, os.path.join(ROOT, "server.py")], env=env, cwd=ROOT,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    try:
        for _ in range(60):
            try:
                urllib.request.urlopen("http://127.0.0.1:%d/api/models" % PORT, timeout=1)
                break
            except OSError:
                time.sleep(0.25)
        code, data = request("POST", "/api/models/folders", {"path": os.path.join(tmp, "models")})
        check("adding a folder scans it", code == 200 and any(m["file"].startswith("Tiny") for m in data["models"]),
              str(code))
        code, data = request("POST", "/api/models/inspect", {"path": model})
        check("inspect reads one file", code == 200 and data["contextLength"] == 4096 and data["quant"] == "Q4_K_M",
              str(data)[:120])
        code, data = request("POST", "/api/models/inspect", {"path": os.path.join(folder, "mmproj-Tiny-f16.gguf")})
        check("inspect refuses a vision file with a plain reason", code == 400 and "vision" in data["error"], str(data))
        code, data = request("POST", "/api/models", {"kind": "gguf", "name": "Tiny Test", "version": "Q4_K_M",
                                                     "settings": {"modelPath": model, "runtime": fake_runtime}})
        check("add a model file", code == 201 and data["model"]["port"] == 8085 and data["model"]["contextTokens"] == 4096,
              str(data)[:160])
        added = data.get("model", {}).get("id")
        code, data = request("POST", "/api/models", {"kind": "gguf", "name": "Tiny Test", "version": "Q4_K_M",
                                                     "settings": {"modelPath": model, "runtime": fake_runtime}})
        check("adding the same file twice is refused", code == 400, str(data))
        code, data = request("POST", "/api/models", {"kind": "gguf", "name": "Bad", "settings": {
            "modelPath": model, "runtime": fake_runtime, "extraArgs": "--port 9999"}})
        check("extra flags cannot take over the port", code == 400 and "port" in data["error"], str(data))
        code, data = request("GET", "/api/models")
        row = next((m for m in data["models"] if m["id"] == added), None)
        check("the added model is listed, on disk, marked as added",
              row is not None and row["onDisk"] and row.get("custom") and len(data["models"]) == 2, str(row)[:160])
        check("the hand-kept list was not written", json.load(open(models_path))[0]["id"] == "fake-model"
              and len(json.load(open(models_path))) == 1)
        code, data = request("PUT", "/api/models/" + added, {"name": "Tiny Renamed", "settings": {"contextTokens": 2048, "kvCache": "q4_0"}})
        check("edit keeps the file and changes the settings", code == 200 and data["model"]["name"] == "Tiny Renamed"
              and data["model"]["settings"]["kvCache"] == "q4_0" and data["model"]["contextTokens"] == 2048
              and data["model"]["settings"]["modelPath"] == model, str(data)[:200])
        code, data = request("POST", "/api/models", {"kind": "external", "name": "LM Studio model", "port": 1234,
                                                     "serverModel": "qwen3-8b"})
        check("add a running server", code == 201 and data["model"]["engine"] == "external", str(data)[:160])
        ext = data.get("model", {}).get("id")
        code, data = request("POST", "/api/switch", {"model": added})
        check("an added model loads through the normal switch", code == 202, str(data))
        for _ in range(80):
            code, st = request("GET", "/api/switch/status")
            if st.get("state") in ("ready", "failed"):
                break
            time.sleep(0.25)
        check("the switch reaches ready", st.get("state") == "ready", st.get("message", ""))
        code, data = request("DELETE", "/api/models/fake-model")
        check("a hand-kept model cannot be removed from the app", code == 404, str(data))
        code, _ = request("DELETE", "/api/models/" + ext)
        code2, data = request("GET", "/api/models")
        check("remove an added model", code == 200 and all(m["id"] != ext for m in data["models"]))
        code, data = request("GET", "/api/models/discover")
        check("discover answers with folders, models, runtimes and servers",
              code == 200 and all(k in data for k in ("folders", "models", "runtimes", "servers"))
              and any(m.get("added") for m in data["models"]), str(list(data))[:120])
    finally:
        proc.kill()
        proc.wait(10)
        try:
            launcher.stop_fake(8784 + OFFSET)
        except Exception:
            pass
    print("ALL PASS" if not FAILS else "FAIL %d" % len(FAILS))
    sys.exit(1 if FAILS else 0)


if __name__ == "__main__":
    main()
