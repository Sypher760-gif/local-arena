"""Fake model engine for testing Local Arena without loading a real model.

Speaks the parts of Strata / llama.cpp that Local Arena uses: /metrics, /v1/models, /props, /health, /slots,
and streamed POST /v1/chat/completions. Stdlib only.

  python tools/fake_engine.py [--port 8766] [--wps 25] [--think-words 6] [--model fake-model-q4] [--echo-system]

Point the gateway at it with:  ARENA_ENGINE=127.0.0.1:8766 python server.py
Replies are deterministic: the answer repeats the last user message's first words, then a fixed sentence.
With --echo-system the answer begins with [system: <the system prompt it was sent>] so a test can tell two
system prompts apart (Arena's per-side instructions).
Test-only paths: GET /debug/requests (last 50 chat request bodies, oldest first), POST /debug/reset (clears them).
"""
import argparse
import json
import socketserver
import time
from http.server import BaseHTTPRequestHandler

MODEL = "fake-model-q4"
MAX_CONTEXT = 32768
ANSWER = ("This is a fake reply from the test engine. It streams one word at a time so the speed meter, the "
          "stop button and the saved chat can all be tried without loading a real model. ") * 4

# Test-only: when a user message contains [[markdown]], reply with this markdown (newlines kept in the
# stream) so the UI markdown renderer can be checked. Default replies are unchanged.
MARKDOWN = (
    "Here is a **bold** word and a *slanted* one.\n\n"
    "- first item\n- second item\n\n"
    "1. numbered one\n2. numbered two\n\n"
    "| Name | Speed |\n| --- | --- |\n| Alpha | 40 |\n| Beta | 25 |\n\n"
    "The **end**."
)


class State:
    live = {"state": "idle", "queued": 0, "phase": None, "prompt_tokens": None, "prompt_read": None,
            "prompt_total": None, "generated": None, "max_tokens": None, "elapsed_s": None, "tok_s": None,
            "tok_s_mean": None, "prefill_tok_s_mean": None, "tok_s_window_s": None}
    requests = []
    bodies = []  # parsed chat request bodies for /debug/requests, last 50 kept
    completions = []  # usage records for /debug/completions, last 50 kept


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    wps = 25.0
    think_words = 6
    echo_system = False

    def log_message(self, *a):
        pass

    def _json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/metrics":
            self._json({"engine": {"model": MODEL, "max_context": MAX_CONTEXT, "context": MAX_CONTEXT,
                                   "version": "fake-0.0", "engine": "fake-0.0", "images": False},
                        "live": State.live, "requests": State.requests[:20]})
        elif path in ("/v1/models", "/models"):
            self._json({"object": "list", "data": [{"id": MODEL, "object": "model", "status": {"value": "loaded"},
                                                    "meta": {"n_ctx": MAX_CONTEXT}}]})
        elif path == "/props":
            self._json({"default_generation_settings": {"n_ctx": MAX_CONTEXT, "params": {"n_predict": -1}},
                        "total_slots": 1, "model_alias": MODEL})
        elif path == "/health":
            self._json({"status": "ok"})
        elif path == "/slots":
            self._json([{"id": 0, "n_ctx": MAX_CONTEXT, "is_processing": State.live["state"] != "idle",
                         "n_prompt_tokens": State.live["prompt_total"] or 0}])
        elif path == "/debug/requests":
            self._json({"requests": State.bodies})
        elif path == "/debug/completions":
            self._json({"completions": State.completions})
        else:
            self._json({"error": "not found"}, 404)

    def do_POST(self):
        path = self.path.split("?")[0]
        n = int(self.headers.get("Content-Length") or 0)
        if path == "/debug/reset":
            self.rfile.read(n)
            State.bodies = []
            return self._json({"ok": True})
        if path != "/v1/chat/completions":
            self.rfile.read(n)
            return self._json({"error": "not found"}, 404)
        req = json.loads(self.rfile.read(n) or b"{}")
        State.bodies = (State.bodies + [req])[-50:]
        msgs = req.get("messages") or []
        last = next((m.get("content") for m in reversed(msgs) if m.get("role") == "user"), "") or ""
        if isinstance(last, list):
            last = " ".join(p.get("text", "") for p in last if isinstance(p, dict))
        system = next((m.get("content") for m in msgs if m.get("role") == "system"), "") or ""
        if isinstance(system, list):
            system = " ".join(p.get("text", "") for p in system if isinstance(p, dict))
        want_md = "[[markdown]]" in last
        # Test-only: when a user message contains [[reply:...]], answer with the words after "reply:"
        # up to "]]" so a check can grade an answer it knows. Default replies are unchanged.
        reply_mark = ""
        if "[[reply:" in last:
            mark_at = last.index("[[reply:") + len("[[reply:")
            mark_end = last.find("]]", mark_at)
            if mark_end != -1:
                reply_mark = last[mark_at:mark_end]
        max_tokens = int(req.get("max_tokens") or 400)
        thinking = req.get("reasoning_effort", "none") not in ("none", None)
        echo = "[system: %s] " % (str(system).strip() or "none") if self.echo_system else ""
        words = (reply_mark if reply_mark else echo + "Echo: " + " ".join(last.split()[:6]) + ". " + ANSWER).split()[:max_tokens]
        if "[[empty]]" in last:  # Test-only: a thinking model that used its whole limit and wrote no answer
            words = []
        stream = bool(req.get("stream"))
        prompt_total = sum(len(str(m.get("content", "")).split()) for m in msgs) * 4 // 3 + 8
        State.live.update(state="generating", phase="decode", prompt_tokens=prompt_total, prompt_read=prompt_total,
                          prompt_total=prompt_total, generated=0, max_tokens=max_tokens)
        t0 = time.time()
        sent = 0
        reasoning = 0
        completion_tokens = 0
        finish = "stop"
        try:
            if not stream:
                content = MARKDOWN if want_md else " ".join(words)
                time.sleep(len(content.split()) / self.wps)
                sent = len(content.split())
                completion_tokens = sent
                return self._json({"id": "fake", "object": "chat.completion", "model": MODEL, "choices": [
                    {"index": 0, "message": {"role": "assistant", "content": content},
                     "finish_reason": "stop"}],
                    "usage": {"prompt_tokens": prompt_total, "completion_tokens": completion_tokens,
                              "total_tokens": prompt_total + completion_tokens}})
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()

            def emit(payload):
                data = ("data: " + payload + "\n\n").encode()
                self.wfile.write(("%x\r\n" % len(data)).encode() + data + b"\r\n")
                self.wfile.flush()

            def chunk(delta, fin=None, usage=None):
                obj = {"id": "fake", "object": "chat.completion.chunk", "model": MODEL,
                       "choices": [{"index": 0, "delta": delta, "finish_reason": fin}]}
                if usage is not None:
                    obj["usage"] = usage
                return json.dumps(obj)

            emit(chunk({"role": "assistant"}))
            if thinking:
                for i in range(self.think_words):
                    emit(chunk({"reasoning_content": "thinking%d " % i}))
                    reasoning += 1
                    time.sleep(1 / self.wps)
            pieces = MARKDOWN.split("\n") if want_md else words
            for piece in pieces:
                emit(chunk({"content": (piece + "\n") if want_md else (piece + " ")}))
                sent += len(piece.split()) if want_md else 1
                el = time.time() - t0
                State.live.update(generated=sent + reasoning, elapsed_s=round(el, 2), tok_s=self.wps,
                                  tok_s_mean=round((sent + reasoning) / el, 1) if el else None)
                time.sleep(1 / self.wps)
            if sent >= max_tokens:
                finish = "length"
            completion_tokens = sent + reasoning
            usage = {"prompt_tokens": prompt_total, "completion_tokens": completion_tokens,
                     "total_tokens": prompt_total + completion_tokens}
            emit(chunk({}, finish, usage))
            emit("[DONE]")
            self.wfile.write(b"0\r\n\r\n")
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            finish = "cancel"
        finally:
            completion_tokens = sent + reasoning
            State.live.update(state="idle", phase=None, generated=None, tok_s=None)
            State.requests.insert(0, {"time": t0, "duration_s": round(time.time() - t0, 2), "finish": finish,
                                      "prompt_tokens": prompt_total, "output_tokens": sent,
                                      "completion_tokens": completion_tokens})
            State.completions = (State.completions + [{"prompt_tokens": prompt_total,
                                                        "completion_tokens": completion_tokens,
                                                        "output_tokens": sent, "finish": finish}])[-50:]
            self.close_connection = True


class Server(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8766)
    ap.add_argument("--wps", type=float, default=25.0)
    ap.add_argument("--think-words", type=int, default=6)
    ap.add_argument("--model", default=MODEL)
    ap.add_argument("--echo-system", action="store_true",
                    help="begin each answer with [system: <the system prompt received>]")
    a = ap.parse_args()
    MODEL = a.model
    Handler.wps, Handler.think_words, Handler.echo_system = a.wps, a.think_words, a.echo_system
    print("Fake engine on http://127.0.0.1:%d (model %s)" % (a.port, MODEL), flush=True)
    try:
        Server(("127.0.0.1", a.port), Handler).serve_forever()
    except KeyboardInterrupt:
        pass
