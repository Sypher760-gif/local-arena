"""Failure, ownership and cancellation regressions. Only fake sockets and harmless child processes."""
import concurrent.futures
import contextlib
import http.client
import json
import os
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import server
import launcher
import model_files

OFFSET = int(os.environ.get("ARENA_PORT_OFFSET", "0"))
GATEWAY, ENGINE = 8771 + OFFSET, 8772 + OFFSET


@contextlib.contextmanager
def gateway():
    httpd = server.BindHTTPServer(("127.0.0.1", GATEWAY), server.Handler)
    worker = threading.Thread(target=httpd.serve_forever, daemon=True)
    worker.start()
    try:
        yield
    finally:
        httpd.shutdown()
        httpd.server_close()
        worker.join(3)


def request(method, path, body=None, extra_headers=None):
    conn = http.client.HTTPConnection("127.0.0.1", GATEWAY, timeout=5)
    try:
        data = json.dumps(body).encode() if body is not None else None
        conn.request(method, path, data, {"Content-Type": "application/json", **(extra_headers or {})})
        response = conn.getresponse()
        return response.status, json.loads(response.read())
    finally:
        conn.close()


class Reliability(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="arena-reliability-")
        self.addCleanup(self.temp.cleanup)
        root = self.temp.name
        values = {
            "STORE": os.path.join(root, "store"), "LIVE": root,
            "MODELS_PATH": os.path.join(root, "models.json"),
            "USER_MODELS_PATH": os.path.join(root, "user-models.json"),
            "TUNING_PATH": os.path.join(root, "model-settings.json"),
            "SWITCH_LOG": os.path.join(root, "switch.log"),
            "SWITCH_TIMES_PATH": os.path.join(root, "times.json"),
            "MODEL_SPEED_PATH": os.path.join(root, "speeds.json"),
            "SWITCH_FAKE": True, "SWITCH_REAL": False,
            "_active_port": None, "_active_match": None,
            "_engine_disconnected": False, "_active_external": False,
            "ENGINE_HOST": "127.0.0.1", "ENGINE_PORT": ENGINE,
            "_switch": {"state": "idle", "model": None, "message": "idle", "startedAt": None,
                        "finishedAt": None, "warmupPending": False, "warmup": None},
        }
        for name, value in values.items():
            mock = patch.object(server, name, value)
            mock.start()
            self.addCleanup(mock.stop)
        server._write_json_atomic(server.MODELS_PATH, [])

    def test_failed_settings_save_is_an_http_error(self):
        server._write_json_atomic(server.MODELS_PATH, [{"id": "fixture", "engine": "external"}])
        server._write_json_atomic(server.TUNING_PATH, {"fixture": {"reply": {"temperature": 0.3}}})
        with gateway(), patch.object(server.os, "replace", side_effect=PermissionError("locked")):
            code, result = request("PUT", "/api/models/fixture/settings", {"reply": {"temperature": 0.8}})
        self.assertEqual(code, 500)
        self.assertIn("could not be saved", result["error"])
        self.assertEqual(server.load_tuning()["fixture"]["reply"]["temperature"], 0.3)
        self.assertFalse(any(name.endswith(".tmp") for name in os.listdir(self.temp.name)))

    def test_optional_telemetry_does_not_fail_a_load(self):
        with patch.object(server, "_write_json_atomic", side_effect=PermissionError("locked")):
            server._record_switch_stop(1)
            server._record_switch_start("fixture", 1)
            server._record_warmup("fixture", 50)
        self.assertIn("Could not save", open(server.SWITCH_LOG, encoding="utf-8").read())

    def test_warmup_keeps_switch_locked(self):
        entered, release = threading.Event(), threading.Event()
        def warmup(*args):
            entered.set()
            release.wait(4)
        entry = {"id": "fixture", "name": "Fixture", "matchId": "fixture"}
        server._switch.update(state="stopping", model="fixture", startedAt=1)
        with gateway(), patch.object(launcher, "stop_all"), patch.object(launcher, "start"), \
                patch.object(server, "current_engine_model", return_value="fixture"), \
                patch.object(server, "_warmup", side_effect=warmup):
            worker = threading.Thread(target=server.run_switch, args=(entry,), daemon=True)
            worker.start()
            try:
                self.assertTrue(entered.wait(3))
                self.assertEqual(server.switch_status_response()["stage"], "warming")
                self.assertEqual(request("POST", "/api/switch", {"model": None})[0], 409)
            finally:
                release.set()
                worker.join(3)
        self.assertEqual(server._switch["state"], "ready")

    def test_status_preserves_ninfer_context(self):
        replies = {"/v1/models": {"data": [{"id": "fixture", "context_length": 131072}]}, "/slots": []}
        with patch.object(server, "engine_json", side_effect=lambda path: replies.get(path)), \
                patch.object(server, "cached_gpu", return_value=None), patch.object(server, "note_status_for_record"):
            self.assertEqual(server.status()["engine"]["maxContext"], 131072)

    def test_reserved_equals_flags_and_invalid_settings_are_rejected(self):
        model = os.path.join(self.temp.name, "fixture.gguf")
        runtime = os.path.join(self.temp.name, "llama-server.exe")
        for path in (model, runtime):
            open(path, "wb").close()
        for flag in ("--port=9999", "--host=0.0.0.0", "--alias=other", "--model=other.gguf"):
            settings = {"modelPath": model, "runtime": runtime, "extraArgs": flag}
            with self.assertRaises(ValueError):
                server._clean_settings(settings, "gguf")
            with self.assertRaises(ValueError):
                launcher.gguf_command({"settings": settings, "port": 8085, "matchId": "fixture"})
        with self.assertRaises(ValueError):
            server.user_model_save({"kind": "gguf", "name": "Fixture", "settings": [1]})

    def test_malformed_gguf_array_is_rejected(self):
        path = os.path.join(self.temp.name, "broken.gguf")
        key = b"general.test"
        with open(path, "wb") as handle:
            handle.write(b"GGUF" + struct.pack("<IQQQ", 3, 0, 1, len(key)) + key)
            handle.write(struct.pack("<IIQ", 9, 10, 2 ** 63))
        self.assertIsNone(model_files.header(path))

    def test_cancellation_before_upstream_headers(self):
        listening = socket.socket()
        listening.bind(("127.0.0.1", ENGINE))
        listening.listen()
        listening.settimeout(4)
        received, disconnected = threading.Event(), threading.Event()
        def upstream():
            try:
                conn, _ = listening.accept()
                with conn:
                    conn.settimeout(4)
                    data = b""
                    while b"\r\n\r\n" not in data:
                        data += conn.recv(4096)
                    headers, body = data.split(b"\r\n\r\n", 1)
                    length = int(next(line.split(b":", 1)[1] for line in headers.split(b"\r\n") if line.lower().startswith(b"content-length:")))
                    while len(body) < length:
                        body += conn.recv(4096)
                    received.set()
                    if conn.recv(1) == b"":
                        disconnected.set()
            finally:
                listening.close()
        worker = threading.Thread(target=upstream, daemon=True)
        worker.start()
        with gateway():
            browser = socket.create_connection(("127.0.0.1", GATEWAY), timeout=4)
            browser.sendall(b"POST /v1/chat/completions HTTP/1.0\r\nContent-Length: 2\r\n\r\n{}")
            self.assertTrue(received.wait(3))
            browser.close()
            self.assertTrue(disconnected.wait(2), "cancelling during prompt read left the upstream open")
        worker.join(3)

    def test_concurrent_store_list_matches_record(self):
        with gateway():
            with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
                results = list(pool.map(lambda i: request("PUT", "/api/store/chats/shared", {"title": str(i)}), range(18)))
            self.assertTrue(all(code == 200 for code, _ in results))
            record = request("GET", "/api/store/chats/shared")[1]
            items = request("GET", "/api/store/chats")[1]["items"]
        self.assertEqual(items[0]["title"], record["title"])

    def test_reading_a_record_while_it_is_saved_never_fails(self):
        # On Windows a read that overlaps the rename of a save fails, so a reader waits for the save.
        with gateway():
            request("PUT", "/api/store/chats/busy", {"title": "start"})
            def one(i):
                return request("PUT", "/api/store/chats/busy", {"title": str(i)}) if i % 2 else request("GET", "/api/store/chats/busy")
            with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
                results = list(pool.map(one, range(200)))
        self.assertEqual([code for code, _ in results if code != 200], [])

    def test_create_only_prevents_run_id_overwrite(self):
        with gateway(), concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda title: request("PUT", "/api/store/runs/42", {"title": title}, {"If-None-Match": "*"}), ["first", "second"]))
            self.assertEqual(sorted(code for code, _ in results), [200, 412])
            winner = "first" if results[0][0] == 200 else "second"
            self.assertEqual(request("GET", "/api/store/runs/42")[1]["title"], winner)

    def test_owned_process_survives_gateway_restart_but_not_unload(self):
        args = [sys.executable, "-c", "import time; time.sleep(30)"]
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        owned = subprocess.Popen(args, creationflags=flags)
        external = subprocess.Popen(args, creationflags=flags)
        try:
            with patch.object(launcher, "OWNED_PATH", os.path.join(self.temp.name, "owned.json")), \
                    patch.object(launcher, "_owned_processes", []):
                launcher.track_owned(owned)
                launcher._owned_processes.clear()  # a fresh gateway has no Popen instances
                launcher.stop_owned()
                self.assertIsNotNone(owned.poll())
                self.assertIsNone(external.poll())
                launcher.save_owned([{"pid": external.pid, "identity": "a different creation identity"}])
                launcher.stop_owned()
                self.assertIsNone(external.poll(), "a reused PID was stopped")
        finally:
            for proc in (owned, external):
                if proc.poll() is None:
                    proc.terminate()
                proc.wait(5)

    def test_external_unload_disconnects_without_stopping(self):
        server.SWITCH_FAKE = False
        server.SWITCH_REAL = True
        server._active_external = True
        with patch.object(launcher, "stop_all") as stop:
            server.run_switch(None)
        stop.assert_not_called()
        self.assertTrue(server._engine_disconnected)
        self.assertIsNone(server.engine_json("/v1/models"))
        self.assertIsNone(server.adopt_running_model(force=True))

    def test_stale_legacy_pid_is_not_imported_as_owned(self):
        path = os.path.join(self.temp.name, "legacy.json")
        with open(path, "w") as handle:
            json.dump({"Pid": os.getpid(), "Port": ENGINE}, handle)
        entry = {"portFile": path, "start": {"script": os.path.join(self.temp.name, "launch.ps1")}}
        with patch.object(launcher, "verified_engine_pid", return_value=False), \
                patch.object(launcher, "save_owned") as save:
            launcher.remember_script_engine(entry)
        save.assert_not_called()

    def test_adoption_cannot_overwrite_a_new_switch_ownership(self):
        external = {"id": "external", "engine": "external", "matchId": "external", "port": ENGINE}
        server.SWITCH_FAKE = False
        server.SWITCH_REAL = True
        server._active_port = ENGINE
        server._active_match = "external"
        def delayed_report(port):
            server._switch.update(state="ready", startedAt=2)
            server._active_external = False
            server._active_match = "owned"
            return "external", 4096
        with patch.object(server, "load_models", return_value=[external]), \
                patch.object(server, "report_for_port", side_effect=delayed_report):
            self.assertIsNone(server.adopt_running_model(force=True))
        self.assertFalse(server._active_external)


if __name__ == "__main__":
    unittest.main(verbosity=2)
