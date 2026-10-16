"""One tiny real-model chat through the gateway: python tools/real_check.py [gateway=127.0.0.1:8790]

Proves the whole live path (gateway proxy -> engine -> streamed words) with the model that is loaded right now.
Sends one prompt, max 40 tokens, thinking off. Never loads or switches a model. Exit 0 = PASS.
"""
import json
import sys
import time
import urllib.request

GW = sys.argv[1] if len(sys.argv) > 1 else "127.0.0.1:8790"


def get(path):
    with urllib.request.urlopen(f"http://{GW}{path}", timeout=5) as r:
        return json.load(r)


def main():
    st = get("/api/status")
    model = st["engine"]["model"]
    if not st["engine"]["reachable"] or not model:
        print("FAIL no model loaded:", st["engine"])
        return 1
    print("model:", model, "| context:", st["engine"]["maxContext"], "| gpu:", st["gpu"])
    body = json.dumps({
        "model": model, "stream": True, "max_tokens": 40, "temperature": 0.2, "reasoning_effort": "none",
        "stream_options": {"include_usage": True},
        "messages": [{"role": "system", "content": "Answer in one short sentence."},
                     {"role": "user", "content": "What is a GPU used for?"}],
    }).encode()
    req = urllib.request.Request(f"http://{GW}/v1/chat/completions", body, {"Content-Type": "application/json"})
    t0 = time.time()
    first = None
    text = ""
    usage = None
    done = False
    with urllib.request.urlopen(req, timeout=120) as r:
        for raw in r:
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("data: "):
                continue
            payload = line[6:]
            if payload == "[DONE]":
                done = True
                break
            obj = json.loads(payload)
            if obj.get("usage"):
                usage = obj["usage"]
            for ch in obj.get("choices") or []:
                piece = (ch.get("delta") or {}).get("content")
                if piece:
                    first = first or time.time() - t0
                    text += piece
    secs = time.time() - t0
    print(f"reply ({len(text.split())} words, first word after {first and round(first, 2)} s, total {secs:.1f} s):", text.strip())
    print("usage:", usage)
    ok = done and len(text.split()) >= 3 and first is not None
    print("PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
