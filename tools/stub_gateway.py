"""Test double for server.py: serves app/, proxies /v1/* to an engine, answers /api/status.

  python tools/stub_gateway.py --port 8773 --engine 127.0.0.1:8774

Stdlib only. Not the real gateway: do not copy this into server.py.
The GPU reading is a constant. The engine answers /metrics, /v1/models and /props like the fake engine.
"""
import argparse
import http.client
import json
import os
import time
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

APP = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app")
TYPES = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".woff2": "font/woff2", ".svg": "image/svg+xml",
}
GPU = {"name": "Test GPU", "usedMiB": 6000, "totalMiB": 12000}
OFFSET = int(os.environ.get("ARENA_PORT_OFFSET", "0") or 0)
ENGINE_HOST, ENGINE_PORT = "127.0.0.1", 8774 + OFFSET


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _engine_get(self, path):
        conn = http.client.HTTPConnection(ENGINE_HOST, ENGINE_PORT, timeout=1.5)
        try:
            conn.request("GET", path)
            res = conn.getresponse()
            if res.status != 200:
                return None
            return json.loads(res.read() or b"null")
        except (OSError, http.client.HTTPException, ValueError):
            return None
        finally:
            conn.close()

    def _status(self):
        # The two calls run at once, so a dead engine costs one timeout, not two.
        with ThreadPoolExecutor(2) as pool:
            metrics_future = pool.submit(self._engine_get, "/metrics")
            listed_future = pool.submit(self._engine_get, "/v1/models")
            metrics, listed = metrics_future.result(), listed_future.result()
        info = {"reachable": False, "kind": None, "model": None, "maxContext": None, "version": None}
        live = {"state": None, "phase": None, "promptRead": None, "promptTotal": None,
                "generated": None, "tokS": None, "tokSMean": None}
        if metrics is not None or listed is not None:
            info["reachable"] = True
            ids = [m.get("id") for m in (listed or {}).get("data", [])]
            loaded = [m["id"] for m in (listed or {}).get("data", [])
                      if (m.get("status") or {}).get("value") == "loaded"]
            info["model"] = loaded[0] if loaded else (ids[0] if len(ids) == 1 else None)
        if isinstance(metrics, dict) and isinstance((metrics.get("engine")), dict) and "version" in metrics["engine"]:
            eng = metrics["engine"]
            lv = metrics.get("live") or {}
            info.update(kind="strata", maxContext=eng.get("max_context"), version=eng.get("version"))
            live = {"state": lv.get("state"), "phase": lv.get("phase"), "promptRead": lv.get("prompt_read"),
                    "promptTotal": lv.get("prompt_total"), "generated": lv.get("generated"),
                    "tokS": lv.get("tok_s"), "tokSMean": lv.get("tok_s_mean")}
        elif listed is not None:
            props = self._engine_get("/props") or {}
            slots = self._engine_get("/slots") or []
            info.update(kind="llama.cpp", maxContext=(props.get("default_generation_settings") or {}).get("n_ctx"))
            live["state"] = "generating" if any(s.get("is_processing") for s in slots) else "idle"
        return {"gatewayVersion": "0.1.0", "engine": info, "live": live, "gpu": GPU, "time": time.time()}

    def _proxy(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        conn = http.client.HTTPConnection(ENGINE_HOST, ENGINE_PORT, timeout=10)
        try:
            conn.request(self.command, self.path, body=body,
                         headers={"Content-Type": self.headers.get("Content-Type", "application/json")})
            res = conn.getresponse()
        except OSError:
            conn.close()
            return self._json({"error": f"No model engine is answering on {ENGINE_HOST}:{ENGINE_PORT}."}, 502)
        try:
            # HTTP/1.0 reply without a length: the body ends when the connection closes.
            self.send_response(res.status)
            self.send_header("Content-Type", res.getheader("Content-Type", "application/json"))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            while True:
                chunk = res.read1(65536)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
        except (OSError, http.client.HTTPException):
            # The browser went away, or the engine died mid-reply. Closing below ends the upstream side.
            pass
        finally:
            conn.close()

    def _static(self, path):
        rel = "index.html" if path in ("", "/") else path.lstrip("/")
        full = os.path.realpath(os.path.join(APP, rel))
        if not full.startswith(os.path.realpath(APP) + os.sep) or not os.path.isfile(full):
            return self._json({"error": "not found"}, 404)
        with open(full, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", TYPES.get(os.path.splitext(full)[1], "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/api/status":
            return self._json(self._status())
        if path.startswith("/v1/"):
            return self._proxy()
        return self._static(path)

    def do_POST(self):
        if self.path.split("?")[0].startswith("/v1/"):
            return self._proxy()
        return self._json({"error": "not found"}, 404)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8773 + OFFSET)
    ap.add_argument("--engine", default="127.0.0.1:%d" % (8774 + OFFSET))
    a = ap.parse_args()
    ENGINE_HOST, ENGINE_PORT = a.engine.rsplit(":", 1)[0], int(a.engine.rsplit(":", 1)[1])
    print("Stub gateway on http://127.0.0.1:%d -> engine %s:%d" % (a.port, ENGINE_HOST, ENGINE_PORT), flush=True)
    try:
        ThreadingHTTPServer(("127.0.0.1", a.port), Handler).serve_forever()
    except KeyboardInterrupt:
        pass
