"""Gateway tests. Starts tools/fake_engine.py and server.py on the test ports, then checks them.

  python tools/test_gateway.py     (exits 1 on any FAIL)

Ports: gateway 8771, engine 8772, a second gateway without switch mode 8774. Never 8790 (live app)
or 8080 (real engine). Nothing here touches a real model: switching runs only in fake mode
(ARENA_SWITCH_FAKE=1), which starts and stops tools/fake_engine.py on the test ports. ARENA_SWITCH_REAL
is never set here. The only real hardware call is a read-only nvidia-smi.
"""
import http.client
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.dirname(HERE)
sys.path.insert(0, PROJECT)
import server  # noqa: E402  (importing does not start the server)

OFFSET = int(os.environ.get("ARENA_PORT_OFFSET", "0") or 0)  # 100, 200 ... moves every test port
GATEWAY = 8771 + OFFSET
ENGINE = 8772 + OFFSET
NO_SWITCH = 8774 + OFFSET
MAX_BODY = 5 * 1024 * 1024
MODEL = "fake-model-q4"
results = []  # (passed, name, detail)


def expect(cond, msg):
    if not cond:
        raise AssertionError(msg)


def check(name, fn):
    try:
        detail = fn() or ""
        results.append((True, name, detail))
    except Exception as e:  # record the failure and keep going
        results.append((False, name, "%s: %s" % (type(e).__name__, e)))
    passed, _, detail = results[-1]
    print("%s  %s%s" % ("PASS" if passed else "FAIL", name, ("  (" + detail + ")") if detail else ""), flush=True)


# --- HTTP helpers ----------------------------------------------------------------

def http_call(port, method, path, body=None, timeout=5):
    """Returns (status, headers, raw bytes)."""
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    try:
        data = body if body is None or isinstance(body, bytes) else json.dumps(body).encode("utf-8")
        conn.request(method, path, body=data, headers={"Content-Type": "application/json"} if data else {})
        resp = conn.getresponse()
        return resp.status, {k.lower(): v for k, v in resp.getheaders()}, resp.read()
    finally:
        conn.close()


def jcall(port, method, path, body=None, timeout=5):
    status, headers, raw = http_call(port, method, path, body, timeout)
    return status, (json.loads(raw) if raw else None)


def timed_status():
    t0 = time.monotonic()
    status, body = jcall(GATEWAY, "GET", "/api/status", timeout=6)
    return status, body, time.monotonic() - t0


def raw_post(port, path, body):
    """Send a POST as an HTTP/1.0 request and return the open socket (to read or abort the reply)."""
    data = json.dumps(body).encode("utf-8")
    sock = socket.create_connection(("127.0.0.1", port), timeout=10)
    head = "POST %s HTTP/1.0\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n" % (path, len(data))
    sock.sendall(head.encode("ascii") + data)
    return sock


def chat_body(max_tokens, stream):
    return {"model": MODEL, "messages": [{"role": "user", "content": "hello there friend"}],
            "stream": stream, "max_tokens": max_tokens}


def wait_listening(port, seconds=10):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        try:
            socket.create_connection(("127.0.0.1", port), timeout=0.5).close()
            return True
        except OSError:
            time.sleep(0.1)
    return False


def wait_closed(port, seconds=5):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        try:
            socket.create_connection(("127.0.0.1", port), timeout=0.3).close()
            time.sleep(0.1)
        except OSError:
            return True
    return False


def stop(proc):
    if proc is not None and proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(5)
        except subprocess.TimeoutExpired:
            proc.kill()


def stop_fake_on_engine_port():
    """Kill any fake_engine left listening on the engine port"""
    try:
        import launcher  # noqa: F401  (sys.path already holds tools/)
        from launcher import stop_fake  # noqa: E402
        stop_fake(ENGINE, os.path.join(os.environ.get("ARENA_TEST_LIVE", PROJECT), "switch-final.log"))
    except Exception:
        pass

def start_fake_engine():
    return subprocess.Popen([sys.executable, os.path.join(HERE, "fake_engine.py"), "--port", str(ENGINE),
                             "--wps", "10"], cwd=PROJECT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))


def start_gateway(store, models_path, port=GATEWAY, switch_fake=False, seed=None):
    """Start server.py pointed at the fake engine. seed sets ARENA_WARMUP_SEED for warm-up tests."""
    env = dict(os.environ, ARENA_PORT=str(port), ARENA_ENGINE="127.0.0.1:%d" % ENGINE, ARENA_STORE=store,
               ARENA_LIVE=os.path.join(store, "live"), ARENA_MODELS=models_path)
    if switch_fake:
        env["ARENA_SWITCH_FAKE"] = "1"
    if seed:
        env["ARENA_WARMUP_SEED"] = seed
    return subprocess.Popen([sys.executable, os.path.join(PROJECT, "server.py")], cwd=PROJECT, env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))


# --- stubs for the engine port -------------------------------------------------------

class HangingStub:
    """Accepts connections on the engine port and never answers."""

    def __init__(self, port):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind(("127.0.0.1", port))
        self.sock.listen(16)
        self.sock.settimeout(0.2)
        self.running = True
        self.held = []
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.thread.start()

    def run(self):
        while self.running:
            try:
                conn, _ = self.sock.accept()
                self.held.append(conn)
            except OSError:
                pass

    def close(self):
        self.running = False
        self.thread.join(2)
        self.sock.close()
        for conn in self.held:
            conn.close()


def make_llama_stub(busy):
    """Serves only the llama.cpp paths the gateway reads. busy[0] sets slot state."""

    class Llama(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def send(self, obj, status=200):
            body = json.dumps(obj).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path == "/v1/models":
                self.send({"object": "list", "data": [{"id": "llama-test.gguf", "object": "model",
                                                       "meta": {"n_ctx": 4096}}]})
            elif self.path == "/props":
                self.send({"default_generation_settings": {"n_ctx": 8192}, "total_slots": 3})
            elif self.path == "/slots":
                self.send([{"id": 0, "is_processing": busy[0]}])
            else:
                self.send({"error": "not found"}, 404)

    server_obj = ThreadingHTTPServer(("127.0.0.1", ENGINE), Llama)
    threading.Thread(target=server_obj.serve_forever, daemon=True).start()
    return server_obj


# --- checks ----------------------------------------------------------------------------

def check_static():
    status, headers, raw = http_call(GATEWAY, "GET", "/")
    expect(status == 200, "index status %s" % status)
    expect("text/html" in headers.get("content-type", ""), "index content type %r" % headers.get("content-type"))
    expect(headers.get("cache-control") == "no-store", "Cache-Control %r" % headers.get("cache-control"))
    expect(b"<" in raw, "index body empty")
    return "index.html %d bytes" % len(raw)


def check_status_up():
    status, body, elapsed = timed_status()
    expect(status == 200, "status %s" % status)
    expect(set(body) == {"gatewayVersion", "codeStamp", "engine", "live", "gpu", "time", "warmup"}, "top keys %s" % sorted(body))
    expect(body["warmup"] is None, "warmup before any warm-up probe: %r" % body["warmup"])
    expect(body["gatewayVersion"] == "0.1.0", "gatewayVersion %r" % body["gatewayVersion"])
    eng = body["engine"]
    expect(set(eng) == {"reachable", "kind", "model", "maxContext", "version", "slots"}, "engine keys %s" % sorted(eng))
    expect(eng == {"reachable": True, "kind": "strata", "model": MODEL, "maxContext": 32768,
                   "version": "fake-0.0", "slots": 1}, "engine %r" % eng)
    expect(set(body["live"]) == set(server.LIVE_EMPTY), "live keys %s" % sorted(body["live"]))
    expect(body["live"]["state"] == "idle", "live state %r" % body["live"]["state"])
    gpu = body["gpu"]
    expect(gpu is None or set(gpu) == {"name", "usedMiB", "totalMiB"}, "gpu keys %r" % gpu)
    expect(isinstance(body["time"], float), "time %r" % body["time"])
    return "%.2fs" % elapsed


def check_status_down():
    status, body, elapsed = timed_status()
    expect(status == 200, "status %s when engine is down (must not be an error)" % status)
    expect(body["engine"] == {"reachable": False, "kind": None, "model": None, "maxContext": None,
                              "version": None, "slots": None}, "engine %r" % body["engine"])
    expect(body["live"]["state"] is None, "live state %r" % body["live"]["state"])
    expect(elapsed < 3.0, "took %.2fs" % elapsed)
    return "%.2fs" % elapsed


def check_proxy_models():
    status, headers, raw = http_call(GATEWAY, "GET", "/v1/models")
    expect(status == 200, "status %s" % status)
    expect(json.loads(raw)["data"][0]["id"] == MODEL, "model list %r" % raw[:120])
    return "via /v1/models"


def check_proxy_nonstream():
    t0 = time.monotonic()
    status, headers, raw = http_call(GATEWAY, "POST", "/v1/chat/completions", chat_body(20, False), timeout=20)
    expect(status == 200, "status %s" % status)
    expect(headers.get("content-type", "").startswith("application/json"), "content type %r" % headers.get("content-type"))
    content = json.loads(raw)["choices"][0]["message"]["content"]
    expect(content.startswith("Echo:"), "content %r" % content[:60])
    return "%.2fs" % (time.monotonic() - t0)


def check_stream_timing():
    t0 = time.monotonic()
    sock = raw_post(GATEWAY, "/v1/chat/completions", chat_body(20, True))
    arrivals, data = [], b""
    while True:
        part = sock.recv(4096)
        if not part:
            break
        arrivals.append(time.monotonic() - t0)
        data += part
    sock.close()
    expect(b"data: [DONE]" in data, "stream did not end with [DONE]")
    first, last = arrivals[0], arrivals[-1]
    expect(first < 1.0, "first bytes after %.2fs" % first)
    expect(last - first > 1.0, "first %.2fs, last %.2fs: the reply was not streamed" % (first, last))
    return "first bytes %.2fs, last %.2fs, %d reads" % (first, last, len(arrivals))


def check_abort():
    sock = raw_post(GATEWAY, "/v1/chat/completions", chat_body(200, True))
    got = b""
    while len(got) < 300:
        part = sock.recv(4096)
        if not part:
            break
        got += part
    _, live_before = jcall(ENGINE, "GET", "/metrics")
    expect(live_before["live"]["state"] == "generating", "engine not generating before abort: %r"
           % live_before["live"]["state"])
    sock.close()
    t0 = time.monotonic()
    while time.monotonic() - t0 < 3.0:
        _, metrics = jcall(ENGINE, "GET", "/metrics")
        if metrics["live"]["state"] == "idle":
            return "engine idle after %.2fs" % (time.monotonic() - t0)
        time.sleep(0.1)
    raise AssertionError("engine still generating 3 s after the client left")


def check_idle_sockets():
    idle = [socket.create_connection(("127.0.0.1", GATEWAY), timeout=5) for _ in range(6)]
    try:
        t0 = time.monotonic()
        status, _, _ = http_call(GATEWAY, "GET", "/", timeout=3)
        elapsed = time.monotonic() - t0
        expect(status == 200, "status %s" % status)
        expect(elapsed < 3.0, "request took %.2fs with 6 idle sockets open" % elapsed)
    finally:
        for s in idle:
            s.close()
    return "%.2fs" % elapsed


def check_store_basic():
    p = "/api/store/chats/first-chat"
    status, body = jcall(GATEWAY, "PUT", p, {"title": "First", "messages": []})
    expect(status == 200 and body["ok"] is True and body["id"] == "first-chat", "put %s %r" % (status, body))
    status, body = jcall(GATEWAY, "PUT", p, {"title": "First v2", "messages": [1]})
    expect(status == 200, "second put %s" % status)
    status, body = jcall(GATEWAY, "GET", p)
    expect(status == 200 and body == {"title": "First v2", "messages": [1]}, "get after overwrite %r" % body)
    status, body = jcall(GATEWAY, "GET", "/api/store/chats")
    expect(status == 200 and [i["id"] for i in body["items"]] == ["first-chat"], "list %r" % body)
    expect(body["items"][0]["title"] == "First v2", "list title %r" % body["items"][0]["title"])
    status, body = jcall(GATEWAY, "DELETE", p)
    expect(status == 200 and body == {"ok": True}, "delete %s %r" % (status, body))
    status, _ = jcall(GATEWAY, "GET", p)
    expect(status == 404, "get after delete %s" % status)
    status, body = jcall(GATEWAY, "DELETE", p)
    expect(status == 200 and body == {"ok": True}, "delete missing %s %r" % (status, body))
    return "put/get/list/delete"


def check_store_order():
    for rid in ("older-chat", "newer-chat"):
        jcall(GATEWAY, "PUT", "/api/store/runs/" + rid, {"title": rid})
        time.sleep(0.05)
    status, body = jcall(GATEWAY, "GET", "/api/store/runs")
    ids = [i["id"] for i in body["items"]]
    expect(ids[:2] == ["newer-chat", "older-chat"], "order %r" % ids)
    expect(all(isinstance(i["updated"], float) for i in body["items"]), "updated not a number")
    for rid in ("older-chat", "newer-chat"):
        jcall(GATEWAY, "DELETE", "/api/store/runs/" + rid)
    return "newest first"


def check_store_atomic(store):
    folder = os.path.join(store, "chats")
    for n in range(3):
        jcall(GATEWAY, "PUT", "/api/store/chats/atomic-one", {"n": n})
    leftovers = [f for f in os.listdir(folder) if not f.endswith(".json")]
    expect(not leftovers, "temp files left behind: %r" % leftovers)
    jcall(GATEWAY, "DELETE", "/api/store/chats/atomic-one")
    return "no temp files left"


def check_store_size(store):
    status, body = jcall(GATEWAY, "PUT", "/api/store/chats/too-big", b'{"t":"' + b"a" * MAX_BODY + b'"}', timeout=30)
    expect(status == 413, "over-limit status %s" % status)
    expect(not os.path.exists(os.path.join(store, "chats", "too-big.json")), "over-limit record was written")
    status, body = jcall(GATEWAY, "PUT", "/api/store/chats/just-fits", b'{"t":"' + b"a" * (MAX_BODY - 1024) + b'"}',
                         timeout=30)
    expect(status == 200, "under-limit status %s" % status)
    jcall(GATEWAY, "DELETE", "/api/store/chats/just-fits")
    return "413 over 5 MB, 200 under"


def check_store_bad_input():
    bad_ids = ["Bad", "-x", "_x", "a" * 65, "a.b", "x%20y", "a%2Fb", "chat!"]
    for rid in bad_ids:
        status, _ = jcall(GATEWAY, "PUT", "/api/store/chats/" + rid, {"a": 1})
        expect(status == 400, "id %r gave %s" % (rid, status))
    status, _ = jcall(GATEWAY, "PUT", "/api/store/chats/" + "a" * 64, {"a": 1})
    expect(status == 200, "64-character id gave %s" % status)
    jcall(GATEWAY, "DELETE", "/api/store/chats/" + "a" * 64)
    status, _, _ = http_call(GATEWAY, "PUT", "/api/store/chats/fine-id", b"{not json")
    expect(status == 400, "bad JSON gave %s" % status)
    status, _, _ = http_call(GATEWAY, "PUT", "/api/store/chats/fine-id", b"[1, 2]")
    expect(status == 400, "JSON list gave %s" % status)
    return "%d bad ids, bad JSON, non-object: all 400" % len(bad_ids)


def check_store_traversal(store):
    outside = os.path.join(os.path.dirname(store), "arena-evil-test.json")
    attempts = [
        ("PUT", "/api/store/chats/.."),
        ("PUT", "/api/store/chats/%2e%2e"),
        ("PUT", "/api/store/chats/..%2F..%2Farena-evil-test"),
        ("PUT", "/api/store/chats/..\\..\\arena-evil-test"),
        ("PUT", "/api/store/chats/C:arena-evil-test"),
        ("PUT", "/api/store/chats/%5Carena-evil-test"),
        ("PUT", "/api/store/chats/../../arena-evil-test"),
        ("PUT", "/api/store/chats//arena-evil-test"),
        ("PUT", "/api/store/nope/arena-evil-test"),
        ("GET", "/api/store/..%2F..%2Fsecret"),
    ]
    for method, path in attempts:
        status, _, _ = http_call(GATEWAY, method, path, {"x": 1} if method == "PUT" else None)
        expect(status in (400, 404), "%s %s gave %s" % (method, path, status))
    expect(not os.path.exists(outside), "a traversal wrote %s" % outside)
    return "%d traversal attempts refused, nothing written outside" % len(attempts)


def check_store_collections():
    status, _ = jcall(GATEWAY, "GET", "/api/store/secrets")
    expect(status == 404, "unknown collection gave %s" % status)
    status, _ = jcall(GATEWAY, "GET", "/api/store/chats/does-not-exist")
    expect(status == 404, "missing record gave %s" % status)
    return "unknown collection and missing record: 404"


def check_store_index_fast(store):
    for n in range(300):
        jcall(GATEWAY, "PUT", "/api/store/votes/fast-%03d" % n, {"title": "fast %d" % n}, timeout=10)
    t0 = time.monotonic()
    status, body = jcall(GATEWAY, "GET", "/api/store/votes", timeout=10)
    elapsed = time.monotonic() - t0
    expect(status == 200 and len(body["items"]) == 300, "list count %s" % (len(body["items"]) if body else status))
    expect(elapsed < 0.5, "list took %.2f s, want under 0.5" % elapsed)
    for n in range(300):
        jcall(GATEWAY, "DELETE", "/api/store/votes/fast-%03d" % n)
    return "300 records listed from the index in %.2f s" % elapsed


def check_store_index_rebuild(store):
    for rid in ("reb-a", "reb-b", "reb-c"):
        jcall(GATEWAY, "PUT", "/api/store/votes/" + rid, {"title": rid})
    idx = os.path.join(store, "votes", "_index.json")
    expect(os.path.exists(idx), "no _index.json after puts")
    os.remove(idx)
    status, body = jcall(GATEWAY, "GET", "/api/store/votes")
    ids = sorted(i["id"] for i in body["items"])
    expect(ids == ["reb-a", "reb-b", "reb-c"], "rebuild list %r" % ids)
    expect(os.path.exists(idx), "index not rebuilt after listing")
    for rid in ("reb-a", "reb-b", "reb-c"):
        jcall(GATEWAY, "DELETE", "/api/store/votes/" + rid)
    return "index rebuilt from the folder after a manual delete"


def check_store_index_live(store):
    status, body = jcall(GATEWAY, "GET", "/api/store/votes")
    base = len(body["items"])
    jcall(GATEWAY, "PUT", "/api/store/votes/live-one", {"title": "live"})
    status, body = jcall(GATEWAY, "GET", "/api/store/votes")
    expect(any(i["id"] == "live-one" for i in body["items"]), "put not reflected in the list")
    jcall(GATEWAY, "DELETE", "/api/store/votes/live-one")
    status, body = jcall(GATEWAY, "GET", "/api/store/votes")
    expect(not any(i["id"] == "live-one" for i in body["items"]), "delete not reflected in the list")
    expect(len(body["items"]) == base, "count changed: %d -> %d" % (base, len(body["items"])))
    return "put and delete reflected at once"


def read_record():
    status, headers, raw = http_call(GATEWAY, "GET", "/api/record", timeout=5)
    return status, headers, raw.decode("utf-8")


def check_live_record_exists():
    status, _ = jcall(GATEWAY, "GET", "/api/status")
    expect(status == 200, "status %s" % status)
    rstatus, headers, text = read_record()
    expect(rstatus == 200, "record status %s" % rstatus)
    expect("text/plain" in headers.get("content-type", ""), "content-type %r" % headers.get("content-type"))
    expect(MODEL in text, "model name %r not in record" % MODEL)
    return "record exists after a status call and names the model"


def check_live_record_counts(store):
    secret = "SECRET-CHAT-TEXT-9f3a"
    status, _ = jcall(GATEWAY, "PUT", "/api/store/chats/rec-test",
                      {"title": "Record test", "messages": [{"role": "user", "text": secret}]})
    expect(status == 200, "put chat %s" % status)
    time.sleep(server.RECORD_POLL_S + 0.3)  # let the next status call rewrite the record
    status, _ = jcall(GATEWAY, "GET", "/api/status")
    expect(status == 200, "status %s" % status)
    rstatus, _, text = read_record()
    expect(rstatus == 200, "record status %s" % rstatus)
    saved = next((ln for ln in text.splitlines() if ln.startswith("Saved: ")), None)
    expect(saved, "no Saved line in record: %r" % text)
    nums = [int(w) for w in saved.replace("Saved:", "").replace(",", "").
            replace("chats", "").replace("votes", "").replace("runs", "").split()]
    expect(len(nums) == 3, "counts parse %r" % saved)
    _, chats = jcall(GATEWAY, "GET", "/api/store/chats")
    _, votes = jcall(GATEWAY, "GET", "/api/store/votes")
    _, runs = jcall(GATEWAY, "GET", "/api/store/runs")
    expect(nums == [len(chats["items"]), len(votes["items"]), len(runs["items"])],
           "record counts %s vs store %s" % (nums, [len(chats["items"]), len(votes["items"]), len(runs["items"])]))
    expect(secret not in text, "chat message text leaked into the record")
    jcall(GATEWAY, "DELETE", "/api/store/chats/rec-test")
    return "counts match the store and chat text is absent"


def check_gpu_parse():
    g = server.parse_gpu("NVIDIA GeForce RTX 5070, 11491, 12227\n",
                         "1044, [Insufficient Permissions], [N/A]\n"
                         "3012, C:\\Windows\\SystemApps\\CrossDeviceResume.exe, [N/A]\n"
                         "41356, C:\\Engines\\strata.exe, 6100\n")
    expect(g == {"name": "NVIDIA GeForce RTX 5070", "usedMiB": 11491, "totalMiB": 12227, "processes": [
        {"pid": 1044, "name": "[Insufficient Permissions]", "usedMiB": None},
        {"pid": 3012, "name": "CrossDeviceResume.exe", "usedMiB": None},
        {"pid": 41356, "name": "strata.exe", "usedMiB": 6100}]}, "parse %r" % g)
    n = server.parse_gpu("NVIDIA GeForce RTX 5070, [N/A], [N/A]\n", "")
    expect(n == {"name": "NVIDIA GeForce RTX 5070", "usedMiB": None, "totalMiB": None, "processes": []},
           "N/A parse %r" % n)
    return "normal, [N/A] memory, [N/A] per process"


def check_gpu_missing():
    real = server.NVIDIA_SMI
    server.NVIDIA_SMI = "arena-no-such-nvidia-smi"
    try:
        try:
            server.run_smi(["--query-gpu=name"])
            raise AssertionError("missing binary did not raise")
        except server.GpuUnavailable:
            pass
    finally:
        server.NVIDIA_SMI = real
    empty = False
    try:
        server.parse_gpu("", "")
    except server.GpuUnavailable:
        empty = True
    expect(empty, "empty output did not raise GpuUnavailable")
    return "missing binary and empty output raise GpuUnavailable"


def check_gpu_cache():
    calls = []

    def counting(args):
        calls.append(args)
        return "NVIDIA GeForce RTX 5070, 1, 2\n" if "--query-gpu" in args[0] else ""

    server._gpu_cache.update(at=None, value=None)
    server.cached_gpu(counting)
    server.cached_gpu(counting)
    expect(len(calls) == 2, "two calls within 0.5 s ran nvidia-smi %d times" % len(calls))
    return "two reads inside 0.5 s run nvidia-smi once (2 queries)"


def check_gpu_http():
    status, body = jcall(GATEWAY, "GET", "/api/gpu")
    expect(status == 200, "status %s" % status)
    expect(set(body) == {"name", "usedMiB", "totalMiB", "processes"}, "keys %r" % sorted(body))
    return "%s, %d processes listed" % (body["name"], len(body["processes"]))


def check_hanging_engine():
    stub = HangingStub(ENGINE)
    try:
        status, body, elapsed = timed_status()
        expect(status == 200, "status %s" % status)
        expect(body["engine"]["reachable"] is False, "engine %r" % body["engine"])
        expect(elapsed < 3.0, "took %.2fs with a hanging engine" % elapsed)
    finally:
        stub.close()
    return "%.2fs" % elapsed


def check_llama_mapping():
    busy = [False]
    stub = make_llama_stub(busy)
    try:
        _, body, _ = timed_status()
        expect(body["engine"] == {"reachable": True, "kind": "llama.cpp", "model": "llama-test.gguf",
                                  "maxContext": 8192, "version": None, "slots": 3}, "engine %r" % body["engine"])
        expect(body["live"]["state"] == "idle", "idle state %r" % body["live"]["state"])
        busy[0] = True
        _, body, _ = timed_status()
        expect(body["live"]["state"] == "generating", "busy state %r" % body["live"]["state"])
    finally:
        stub.shutdown()
        stub.server_close()
    return "kind, model, maxContext and slots from /props, slot state"


def check_proxy_engine_down():
    status, body = jcall(GATEWAY, "GET", "/v1/models")
    expect(status == 502, "status %s" % status)
    expect(body == {"error": "No model engine is answering on 127.0.0.1:%d." % ENGINE}, "body %r" % body)
    return "502 with the engine address"


def check_models(store):
    """GET /api/models reports onDisk from the file/folder and loaded from the engine's model."""
    status, _, raw = http_call(GATEWAY, "GET", "/api/models")
    expect(status == 200, "GET /api/models status %d" % status)
    models = json.loads(raw.decode("utf-8")).get("models")
    expect(isinstance(models, list), "no models list")
    by_id = {m.get("id"): m for m in models}
    expect(set(by_id) == {"on-disk-folder", "off-disk-config", "on-disk-config"}, "ids: %s" % sorted(by_id))
    expect(by_id["on-disk-folder"]["onDisk"] is True, "folder entry onDisk should be true")
    expect(by_id["on-disk-config"]["onDisk"] is True, "present config onDisk should be true")
    expect(by_id["off-disk-config"]["onDisk"] is False, "missing config onDisk should be false")
    loaded = [m["id"] for m in models if m.get("loaded")]
    expect(loaded == ["on-disk-folder"], "loaded entries: %s, want only the fake-model match" % loaded)
    expect(by_id["on-disk-folder"]["matchId"] in MODEL, "matchId %r not in engine model %r"
           % (by_id["on-disk-folder"]["matchId"], MODEL))


def wait_switch_done(seconds=60, port=GATEWAY):
    """Poll /api/switch/status until the switch reaches ready or failed. Returns the last body."""
    end = time.monotonic() + seconds
    body = None
    while time.monotonic() < end:
        status, body = jcall(port, "GET", "/api/switch/status")
        if status == 200 and body.get("state") in ("ready", "failed"):
            return body
        time.sleep(0.25)
    raise AssertionError("switch never finished: last status %r" % (body,))


def check_switch_off(port):
    """Without ARENA_SWITCH_FAKE or ARENA_SWITCH_REAL, POST /api/switch is refused."""
    status, body = jcall(port, "POST", "/api/switch", {"model": "on-disk-config"})
    expect(status == 403, "status %s" % status)
    expect(body == {"error": "Real model switching is switched off."}, "body %r" % body)
    return "403 without a switch mode"


def check_switch_unknown_id():
    status, body = jcall(GATEWAY, "POST", "/api/switch", {"model": "no-such-model"})
    expect(status == 404, "status %s" % status)
    expect(isinstance(body, dict) and body.get("error"), "body %r" % body)
    status, st = jcall(GATEWAY, "GET", "/api/switch/status")
    expect(status == 200 and st["state"] == "idle", "state after a 404: %r" % st)
    return "404 and the service stayed idle"


def check_switch_load():
    """Switch to a model: 202 at once, 409 for a second switch while it runs, then ready and loaded."""
    # Clear any switch times from an earlier run, so the defaults and the first full switch are tested.
    times_path = os.path.join(store_env("live"), "switch-times.json")
    try:
        os.remove(times_path)
    except OSError:
        pass
    status, body = jcall(GATEWAY, "POST", "/api/switch", {"model": "on-disk-config"})
    expect(status == 202 and body == {"ok": True}, "start: status %s body %r" % (status, body))
    status2, body2 = jcall(GATEWAY, "POST", "/api/switch", {"model": "on-disk-folder"})
    expect(status2 == 409, "second switch while one runs: status %s body %r" % (status2, body2))
    stages, st = poll_switch_stages()
    expect(st["state"] == "ready", "state: %r" % st)
    expect(st["model"] == "on-disk-config", "model: %r" % st["model"])
    expect(isinstance(st["startedAt"], (int, float)) and isinstance(st["elapsedS"], (int, float)),
           "startedAt/elapsedS: %r" % st)
    expect(isinstance(st["message"], str) and st["message"].strip(), "message: %r" % st["message"])
    expect(st["stage"] == "ready" and st["progress"] == 1, "final stage/progress: %r" % st)
    seen = [s["stage"] for s in stages]
    # Collapse consecutive repeats (one stage spans many polls): the order must still move forward only.
    collapsed = [s for i, s in enumerate(seen) if i == 0 or s != seen[i - 1]]
    expect(all(s in ("stopping", "loading", "warming", "ready") for s in collapsed), "unexpected stage: %s" % collapsed)
    expect("stopping" in collapsed and "loading" in collapsed, "stopping and loading stages both appear: %s" % collapsed)
    expect(collapsed in (["stopping", "loading", "ready"], ["stopping", "loading", "warming", "ready"]), "stages out of order: %s" % collapsed)
    first_stopping = next(s for s in stages if s["stage"] == "stopping")
    expect(first_stopping["stageLabel"] == "Stopping the current model", "stopping label %r" % first_stopping)
    stopps = [s["progress"] for s in stages if s["stage"] == "stopping"]
    expect(stopps and all(p <= 0.15 for p in stopps), "stopping progress over 0.15: %s" % stopps)
    loadds = [s["progress"] for s in stages if s["stage"] == "loading"]
    expect(loadds and all(p >= 0.15 and p <= 0.95 for p in loadds), "loading progress out of range: %s" % loadds)
    expect(all(b >= a for a, b in zip([s["progress"] for s in stages if s["progress"] is not None],
                                      [s["progress"] for s in stages if s["progress"] is not None][1:])),
           "progress went backwards")
    times = json.load(open(times_path, encoding="utf-8"))
    expect(isinstance(times.get("startS"), dict) and "on-disk-config" in times["startS"],
           "switch-times.json missing the model start time: %r" % times)
    expect(isinstance(times.get("stopS"), (int, float)), "switch-times.json missing the stop time: %r" % times)
    status, eng = jcall(GATEWAY, "GET", "/api/status", timeout=8)
    expect(eng["engine"]["reachable"] is True, "engine not reachable after the switch")
    expect("present" in (eng["engine"]["model"] or ""), "engine model: %r" % eng["engine"]["model"])
    status, models = jcall(GATEWAY, "GET", "/api/models")
    loaded = [m["id"] for m in models["models"] if m.get("loaded")]
    expect(loaded == ["on-disk-config"], "loaded after the switch: %s" % loaded)
    return "loaded on-disk-config in %ss" % st["elapsedS"]


def store_env(kind):
    """The gateway's ARENA_LIVE folder, rebuilt from the env this test passed it."""
    live = os.environ.get("ARENA_TEST_LIVE")
    expect(isinstance(live, str) and live, "ARENA_TEST_LIVE not set")
    return live


def poll_switch_stages(seconds=60, port=GATEWAY):
    """Poll /api/switch/status until ready/failed; return ([snapshots], last body)."""
    snaps = []
    body = wait_switch_done_extra(snaps, seconds, port)
    return snaps, body


def wait_switch_done_extra(snaps, seconds=60, port=GATEWAY):
    """wait_switch_done, but records every status body seen into snaps."""
    end = time.monotonic() + seconds
    body = None
    while time.monotonic() < end:
        status, body = jcall(port, "GET", "/api/switch/status")
        if status == 200:
            snaps.append(body)
            if body.get("state") in ("ready", "failed"):
                return body
        time.sleep(0.15)
    raise AssertionError("switch never finished: last status %r" % (body,))


def check_switch_second():
    status, body = jcall(GATEWAY, "POST", "/api/switch", {"model": "on-disk-folder"})
    expect(status == 202, "status %s body %r" % (status, body))
    # The first switch of on-disk-folder was measured; a stage snapshot must reference it.
    time.sleep(0.4)
    _, mid = jcall(GATEWAY, "GET", "/api/switch/status")
    expect(mid["stage"] in ("stopping", "loading"), "stage during the second switch: %r" % mid)
    expect(isinstance(mid["stageLabel"], str) and mid["stageLabel"], "stageLabel missing: %r" % mid)
    expect(isinstance(mid["progress"], (int, float)) and 0 <= mid["progress"] <= 1,
           "progress during the second switch: %r" % mid)
    st = wait_switch_done()
    expect(st["state"] == "ready" and st["model"] == "on-disk-folder", "status %r" % st)
    times_path = os.path.join(store_env("live"), "switch-times.json")
    times = json.load(open(times_path, encoding="utf-8"))
    expect("on-disk-folder" in times.get("startS", {}), "on-disk-folder start time not recorded: %r" % times)
    status, eng = jcall(GATEWAY, "GET", "/api/status", timeout=8)
    expect("fake-model" in (eng["engine"]["model"] or ""), "engine model: %r" % eng["engine"]["model"])
    return "switched again to on-disk-folder"


def start_gateway(store, models_path, port=GATEWAY, switch_fake=False, seed=None):
    """Start server.py pointed at the fake engine. seed sets ARENA_WARMUP_SEED for warm-up tests."""
    env = dict(os.environ, ARENA_PORT=str(port), ARENA_ENGINE="127.0.0.1:%d" % ENGINE, ARENA_STORE=store,
               ARENA_LIVE=os.path.join(store, "live"), ARENA_MODELS=models_path)
    if switch_fake:
        env["ARENA_SWITCH_FAKE"] = "1"
    if seed:
        env["ARENA_WARMUP_SEED"] = seed
    return subprocess.Popen([sys.executable, os.path.join(PROJECT, "server.py")], cwd=PROJECT, env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))


def check_switch_unload():
    status, body = jcall(GATEWAY, "POST", "/api/switch", {"model": None})
    expect(status == 202, "status %s body %r" % (status, body))
    time.sleep(0.4)
    _, mid = jcall(GATEWAY, "GET", "/api/switch/status")
    expect(mid["stage"] == "stopping" and mid["stageLabel"] == "Stopping the current model",
           "unload stage before ready: %r" % mid)
    expect(isinstance(mid["progress"], (int, float)) and 0 <= mid["progress"] <= 0.15,
           "unload progress out of the stopping range: %r" % mid)
    st = wait_switch_done()
    expect(st["state"] == "ready" and st["model"] is None, "status %r" % st)
    expect(st["stage"] == "idle" and st["progress"] is None, "stage after unload: %r" % st)
    expect(wait_closed(ENGINE, 10), "engine port %d stayed open after unload" % ENGINE)
    status, eng = jcall(GATEWAY, "GET", "/api/status", timeout=8)
    expect(eng["engine"]["reachable"] is False, "engine still reachable after unload")
    return "unload left the engine unreachable"


def clear_warmup_state():
    """Remove model-speed.json from the gateway's live folder, so a warm-up check starts fresh."""
    path = os.path.join(store_env("live"), "model-speed.json")
    try:
        os.remove(path)
    except OSError:
        pass


def check_warmup_fast_then_slow():
    """A fast first switch records a good tok/s; a slow second switch reads slow: true.

    The tok/s the gateway "measures" is forced with the switch body's `warmupSeed` (a test seam:
    fake mode must be able to test the slow-start logic without timing luck).
    Real switches never send it and take the real measurement from usage + elapsed time.
    """
    def warmup_ready():
        _, eng = jcall(GATEWAY, "GET", "/api/status", timeout=8)
        return eng.get("warmup") is not None and eng["engine"].get("model") is not None

    # First switch: 80 tok/s, its first measured warm-up -> the model's best on record, not slow.
    clear_warmup_state()
    status, body = jcall(GATEWAY, "POST", "/api/switch", {"model": "on-disk-folder", "warmupSeed": 80})
    expect(status == 202, "start: %s %r" % (status, body))
    st = wait_switch_done()
    expect(st["state"] == "ready", "first switch for warm-up: %r" % st)
    # The switch's own last status already carries the warm-up when the probe is done.
    expect(wait_for(10, lambda: st.get("warmup") is not None) or wait_for(10, warmup_ready),
           "warmup never appeared (switch status %r)" % st)
    expect(wait_for(10, warmup_ready), "warmup never appeared in /api/status")
    _, eng = jcall(GATEWAY, "GET", "/api/status", timeout=8)
    warm = eng["warmup"]
    expect(set(warm) == {"tokensPerSecond", "usual", "slow"}, "warmup keys: %r" % warm)
    expect(warm["tokensPerSecond"] == 80.0, "seeded tok/s not recorded: %r" % warm)
    expect(warm["slow"] is False, "fast warm-up marked slow: %r" % warm)
    speed_path = os.path.join(store_env("live"), "model-speed.json")
    # The warm-up is keyed by the model id the ENGINE reports (here the fake engine's model id),
    # because /api/status looks up by that; use the actual key the file has.
    speeds = json.load(open(speed_path, encoding="utf-8"))
    expect(80.0 in speeds.values(), "best on record not saved: %r" % speeds)

    # Second switch of the same model: 3.6 tok/s, under 40 percent of 80 -> slow: true.
    status, body = jcall(GATEWAY, "POST", "/api/switch", {"model": "on-disk-folder", "warmupSeed": 3.6})
    expect(status == 202, "start 2: %s %r" % (status, body))
    st = wait_switch_done()
    expect(st["state"] == "ready", "second switch: %r" % st)
    expect(wait_for(10, warmup_ready), "warmup slow never appeared in /api/status")
    _, eng = jcall(GATEWAY, "GET", "/api/status", timeout=8)
    warm = eng["warmup"]
    expect(warm["tokensPerSecond"] == 3.6, "slow tok/s not recorded: %r" % warm)
    expect(warm["usual"] == 80.0, "usual is not the best on record: %r" % warm)
    expect(warm["slow"] is True, "slow warm-up not marked slow: %r" % warm)
    speeds = json.load(open(speed_path, encoding="utf-8"))
    # A slow result must not replace the best: still exactly one 80.0 entry, nothing lower.
    expect(all(v == 80.0 for v in speeds.values() if isinstance(v, (int, float))),
           "a slow result replaced the best: %r" % speeds)

    # No record at all: under 10 tok/s is slow for a strata model even on its first start.
    clear_warmup_state()
    status, body = jcall(GATEWAY, "POST", "/api/switch", {"model": "on-disk-folder", "warmupSeed": 3.6})
    expect(status == 202, "start 3: %s %r" % (status, body))
    st = wait_switch_done()
    expect(st["state"] == "ready", "third switch: %r" % st)
    expect(wait_for(10, warmup_ready), "warmup floor never appeared in /api/status")
    _, eng = jcall(GATEWAY, "GET", "/api/status", timeout=8)
    warm = eng["warmup"]
    expect(warm["slow"] is True, "3.6 tok/s with no record should be slow: %r" % warm)
    expect(warm["usual"] == 3.6, "usual with no record is the result itself: %r" % warm)
    # And a first start at 30 tok/s is not slow (over the 10 tok/s floor).
    clear_warmup_state()
    status, body = jcall(GATEWAY, "POST", "/api/switch", {"model": "on-disk-folder", "warmupSeed": 30})
    expect(status == 202, "start 4: %s %r" % (status, body))
    st = wait_switch_done()
    expect(st["state"] == "ready", "fourth switch: %r" % st)
    expect(wait_for(10, warmup_ready), "warmup fast-floor never appeared in /api/status")
    _, eng = jcall(GATEWAY, "GET", "/api/status", timeout=8)
    expect(eng["warmup"]["slow"] is False, "30 tok/s with no record should not be slow: %r" % eng["warmup"])
    return "fast 80, slow 3.6 -> slow: true; floors: 3.6 slow, 30 not slow (no record)"


def wait_for(seconds, fn):
    """Poll fn() until true or the seconds run out."""
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if fn():
            return True
        time.sleep(0.25)
    return False


def fake_engine_count():
    """Fake engine processes started by THIS project.

    Only python.exe processes running fake_engine.py count: stop-scripts whose command line
    merely quotes 'fake_engine.py' are not engines."""
    marker = PROJECT.lower().replace("\\", "\\\\")  # this folder's path, escaped for -match
    out = subprocess.run(["powershell", "-NoProfile", "-Command",
                          "(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'python.exe' "
                          "-and ($_.CommandLine + '').ToLower().Contains('fake_engine.py') "
                          "-and ($_.CommandLine + '').ToLower().Contains('%s') } | Measure-Object).Count" % marker],
                         capture_output=True, text=True, timeout=60, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    text = out.stdout.strip()
    return int(text) if text.isdigit() else -1


def check_warmup_uses_engine_speed():
    """The warm-up speed is the engine's own decode speed when it sends one, not tokens over the
    round trip. NInfer's real reply: 3 tokens, 127.6 tok/s by the engine, which the old sum read as
    2.7 tok/s over a 1.1 s round trip and called a slow start."""
    ninfer = {"timings": {"predicted_n": 40, "predicted_per_second": 251.3}, "usage": {"completion_tokens": 40}}
    got = server._warmup_tps_from_usage(ninfer, 1.1)
    expect(got == 251.3, "engine speed not used: %r" % got)
    # Too few tokens to trust the engine's own figure: fall back to the round trip.
    short = {"timings": {"predicted_n": 3, "predicted_per_second": 127.6}, "usage": {"completion_tokens": 3}}
    expect(abs(server._warmup_tps_from_usage(short, 1.5) - 2.0) < 1e-9, "short reply should fall back")
    # No timings (Strata, the fake engine): tokens over the round trip, as before.
    plain = {"usage": {"completion_tokens": 30}}
    expect(server._warmup_tps_from_usage(plain, 2.0) == 15.0, "fallback changed")
    expect(server._warmup_tps_from_usage({"timings": {"predicted_per_second": 0, "predicted_n": 40},
                                          "usage": {"completion_tokens": 30}}, 2.0) == 15.0, "zero speed not ignored")
    expect(server.WARMUP_MAX_TOKENS >= 48 and "30" in server.WARMUP_PROMPT, "warm-up prompt too short to time")
    return "engine's own speed wins; round trip only without one"


def check_port_held_exclusively():
    """A second server on a port already in use must fail to start, not share the port (Windows
    allowed both before, and a restart left the app talking to an old, stuck server)."""
    port = GATEWAY  # the test gateway is listening here now
    try:
        second = server.BindHTTPServer(("127.0.0.1", port), server.Handler)
    except OSError:
        return "second bind on %d refused" % port
    second.server_close()
    raise AssertionError("a second server bound port %d while the gateway was listening" % port)


def check_no_fake_engine_left():
    n = fake_engine_count()
    expect(n == 0, "%d fake engine processes still running" % n)
    return "no fake engine process remains"


def main():
    store = tempfile.mkdtemp(prefix="arena-store-test-")
    engine = gateway = no_switch = None
    try:
        check("gpu parse cases", check_gpu_parse)
        check("gpu missing binary and empty output", check_gpu_missing)
        check("gpu read cache", check_gpu_cache)
        check("warm-up uses the engine's own speed", check_warmup_uses_engine_speed)

        # A temp catalogue: one llama.cpp entry whose folder exists, one strata entry whose
        # config file exists, one whose config file is missing. Only the folder entry's matchId
        # matches the fake engine's model, so only it should come back loaded.
        present = os.path.join(store, "present.json")
        open(present, "w").close()
        models_path = os.path.join(store, "models.json")
        catalogue = [
            {"id": "on-disk-folder", "name": "Fake Model", "version": "Q4", "engine": "llama.cpp",
             "contextTokens": 4096, "folder": store, "matchId": "fake-model"},
            {"id": "off-disk-config", "name": "Missing", "version": "X", "engine": "strata",
             "contextTokens": 4096, "configPath": os.path.join(store, "missing.json"), "matchId": "missing"},
            {"id": "on-disk-config", "name": "Present", "version": "Y", "engine": "strata",
             "contextTokens": 4096, "configPath": present, "matchId": "present"},
        ]
        with open(models_path, "w", encoding="utf-8") as f:
            json.dump(catalogue, f)

        engine = start_fake_engine()
        expect(wait_listening(ENGINE), "fake engine did not start on %d" % ENGINE)
        os.environ["ARENA_TEST_LIVE"] = os.path.join(store, "live")  # check_switch_load reads the gateway's live folder
        gateway = start_gateway(store, models_path, switch_fake=True)
        expect(wait_listening(GATEWAY), "gateway did not start on %d" % GATEWAY)
        no_switch = start_gateway(store, models_path, port=NO_SWITCH)
        expect(wait_listening(NO_SWITCH), "gateway without switch mode did not start on %d" % NO_SWITCH)

        check("static index served", check_static)
        check("a second server cannot share the gateway's port", check_port_held_exclusively)
        check("status shape, fake engine up", check_status_up)
        check("gpu endpoint (real nvidia-smi, read-only)", check_gpu_http)
        check("proxy GET /v1/models", check_proxy_models)
        check("proxied non-stream chat", check_proxy_nonstream)
        check("proxied stream arrives in pieces", check_stream_timing)
        check("client abort stops the engine", check_abort)
        check("six idle sockets do not block", check_idle_sockets)
        check("store put/get/overwrite/list/delete", check_store_basic)
        check("store list newest first", check_store_order)
        check("store writes are atomic", lambda: check_store_atomic(store))
        check("store size limit 5 MB", lambda: check_store_size(store))
        check("store bad ids and bad bodies", check_store_bad_input)
        check("store path traversal refused", lambda: check_store_traversal(store))
        check("store unknown collection and missing record", check_store_collections)
        check("store list 300 records under 0.5 s (index)", lambda: check_store_index_fast(store))
        check("store index rebuilds after manual delete", lambda: check_store_index_rebuild(store))
        check("store index reflects put and delete at once", lambda: check_store_index_live(store))

        check("live record exists after status and names model", check_live_record_exists)
        check("live record counts match store, no chat text", lambda: check_live_record_counts(store))

        check("models catalogue onDisk and loaded", lambda: check_models(store))

        check("switch refused without a switch mode", lambda: check_switch_off(NO_SWITCH))
        check("switch unknown id 404", check_switch_unknown_id)
        check("switch loads a model and 409 while running", check_switch_load)
        check("switch to a second model", check_switch_second)
        check("switch unload stops the engine", check_switch_unload)
        check("warm-up: fast switch not slow, slow switch slow", check_warmup_fast_then_slow)

        stop(engine)
        engine = None
        # A switch run also restarts a fake engine on this port through the launcher; stop it too.
        stop_fake_on_engine_port()
        expect(wait_closed(ENGINE, 15), "engine port %d did not close" % ENGINE)
        check("status with engine killed", check_status_down)
        check("proxy 502 when engine is down", check_proxy_engine_down)

        check("status under 3 s with a hanging engine", check_hanging_engine)
        check("status maps llama.cpp", check_llama_mapping)
        stop_fake_on_engine_port()  # the launcher's fake engine from the last switch may still run
        check("no fake engine process remains", check_no_fake_engine_left)
    finally:
        os.environ.pop("ARENA_WARMUP_SEED", None)
        stop(engine)
        stop(no_switch)
        stop(gateway)
        shutil.rmtree(store, ignore_errors=True)

    failed = [r for r in results if not r[0]]
    print("\n%d checks: %d PASS, %d FAIL" % (len(results), len(results) - len(failed), len(failed)))
    for _, name, detail in failed:
        print("FAIL  %s  %s" % (name, detail))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
