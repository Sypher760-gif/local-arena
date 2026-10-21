# Gateway API (contract)

Served by `server.py` on `http://127.0.0.1:8790`. All JSON is UTF-8. Errors are `{"error": "<plain sentence>"}` with a non-2xx status. Version: `0.1.0`.

Engine address: `127.0.0.1:8080` by default; override with env `ARENA_ENGINE` (for example `127.0.0.1:8766` for a fake engine). Gateway port: `8790` by default; override with env `ARENA_PORT`. Both are read once at start. Tests must never use 8790 or 8080: they run on spare ports (see `docs/TESTING.md`).

## Proxy (pass-through)

`GET`/`POST` to `/v1/*`, `/metrics`, `/props`, `/health`, `/slots`, `/models` are forwarded unchanged to the engine, response streamed through as it arrives (needed for `text/event-stream`). Status code, `Content-Type` and body pass through. If the engine is unreachable: `502 {"error": "No model engine is answering on 127.0.0.1:8080."}`. No duration limit on a streamed response; 10 s connect timeout. Browser disconnects close the upstream even before headers or tokens arrive.

## `GET /api/status`

One cheap call the browser polls (every 1 s while streaming, every 3 s idle). Never errors for an unreachable engine; it reports it.

```json
{
  "gatewayVersion": "0.1.0",
  "engine": {
    "reachable": true,
    "kind": "strata",
    "model": "qwen3.8-flash-next-iq3_xxs",
    "maxContext": 153600,
    "version": "0.1.41"
  },
  "live": {
    "state": "idle",
    "phase": null,
    "promptRead": null,
    "promptTotal": null,
    "generated": null,
    "tokS": null,
    "tokSMean": null
  },
  "gpu": { "name": "NVIDIA GeForce RTX 5070", "usedMiB": 11634, "totalMiB": 12227 },
  "warmup": { "tokensPerSecond": 3.6, "usual": 45.0, "slow": true },
  "time": 1791609079.9
}
```

- `engine.kind`: `"strata"` when `/metrics` has an `engine` object with `version`; `"llama.cpp"` when `/metrics` is missing but `/v1/models` answers; `null` when unreachable (then `model`, `maxContext`, `version` are `null`). Test seam: env `ARENA_ENGINE_KIND` forces the value the gateway reports (used to check the UI wording per kind).
- `engine.model`: the first id from `/v1/models` whose `status.value` is `"loaded"` (or the only id). `null` if none loaded.
- `engine.maxContext`: Strata `engine.max_context`; llama.cpp `/props` `default_generation_settings.n_ctx` or `/v1/models` `meta.n_ctx`.
- `engine.slots`: how many replies the engine writes at once, from `/props` `total_slots` (llama.cpp `-np`, NInfer `--max-concurrency`, Strata `"parallel"`); `null` when the engine does not say. Chat offers side chats when it is 2 or more.
- `live`: copied from Strata `/metrics` `live` (`state`, `phase`, `prompt_read`, `prompt_total`, `generated`, `tok_s`, `tok_s_mean`), renamed to camelCase. For llama.cpp: `state` from `/slots` (`"generating"` if any slot `is_processing`, else `"idle"`), the rest `null`.
- `gpu`: from `/api/gpu` (below); `null` if `nvidia-smi` is unavailable.
- `warmup`: the loaded model's last warm-up probe (`null` before any probe). `usual` is the model's best on record; `slow` per the switch-status warm-up rule above. The Models screen and the top bar show, when `slow` is true: "This model started slowly (3.6 tokens per second; it usually does 45). Reloading it usually fixes this." with a **Reload model** button (same as Load on the current model; no automatic reload).
- The whole call must return in under 3 s even if the engine hangs (per-call timeouts of 1.5 s).

## `GET /api/gpu`

```json
{ "name": "NVIDIA GeForce RTX 5070", "usedMiB": 11634, "totalMiB": 12227,
  "processes": [ { "pid": 41032, "name": "strata.exe", "usedMiB": null } ] }
```

From `nvidia-smi --query-gpu=name,memory.used,memory.total --format=csv,noheader,nounits` and `--query-compute-apps=pid,process_name,used_memory --format=csv,noheader,nounits`. On Windows WDDM the per-process figure is often `[N/A]`: report `null`, never guess. `nvidia-smi` missing: `503 {"error": "nvidia-smi is not available."}`. Cache for 0.5 s so polling cannot pile up processes.

## `GET /api/record`

Returns the live record as `text/plain; charset=utf-8` (the file `data/live/record.md`), or `404` with `No live record yet.` before the first status call. The gateway writes the file atomically (temp file then replace): at most every 5 s while someone polls `/api/status`, and every 15 s from a background thread otherwise, reusing the last status result. Contents are plain lines only: time and gateway uptime; engine reachable, kind, model, context size, version; engine state; last known speed; GPU name and used/total memory; counts of saved chats, votes and runs; and the last model switch result. It never contains chat text or prompts.

## `GET /api/models`

The model catalogue Local Arena knows how to start, read from ignored `config/models.json`, falling back to `config/models.example.json` (override with `ARENA_MODELS`). Returns `{"models": [ ... ]}`, one object per entry:

```json
{ "models": [ {
  "id": "qwen3.8-flash-next-iq3_xxs", "name": "qwen3.8-flash-next", "version": "IQ3_XXS",
  "engine": "strata", "contextTokens": 153600, "matchId": "iq3_xxs", "port": 8080,
  "configPath": "models/strata-example.json", "onDisk": true, "loaded": true
} ] }
```

- `engine`: `"strata"`, `"llama.cpp"`, `"ninfer"` or `"minicpm"`. A Strata entry names `configPath` (its
  `strata-*.json`); every other entry names a `start` script — the configured launcher, called
  not changed. `onDisk` is true when that config file, folder or script is really there.
- `port`: where that model answers (Strata 8080, Bonsai 8081, MiniCPM 8082/8083, NInfer 8084). While a
  model runs, its launcher's own state file (`portFile`) wins over the listed port.
- `note`: one plain sentence about the model, when the entry has one.
- `matchId`: a substring of the model id the engine reports in `/v1/models`. `loaded` is `true` for the
  entry whose `matchId` matches the engine's current model id, and `false` for the rest (and for all
  when the engine is unreachable or none is loaded). When several entries share one `matchId` (Bonsai
  Fast 64K next to Bonsai 128K; NInfer's 64K and 128K profiles), each of them also states
  `matchContext`, and that must equal the context the engine itself reports — `n_ctx` from `/props`
  for llama.cpp, `context_length` from `/v1/models` for NInfer. An unknown context marks neither of
  them loaded, so a row never claims to be the loaded one on a guess.
- `onDisk`: `true` when the entry's `configPath` file, its `folder`, or its `start` script actually exists on this PC; otherwise `false`.
- A missing or unreadable catalogue file returns `{"models": []}`. This endpoint only reads; it never starts, stops or loads a model.
- `loadKind`: how Local Arena can change the model's load settings: `ninfer` (its start options), `gguf` (an added
  model's own entry), `external` (the server owns them), `strata` or `script` (read-only: their launcher
  decides). `launch` is `{by, detail}`: the launcher and the command it runs, for the read-only view.
- `tuning`: the model's saved settings, `{reply?, load?}` (empty when none). `ninferLoad` (NInfer only) is
  what it starts with now, saved settings included; `ninferBase` is the same without them.

## `PUT /api/models/<id>/settings`

Saves one model's settings in `data/model-settings.json` (next to `user-models.json`); the catalogue is
never written. Body `{"reply": {...}, "load": {...}}`; an empty body resets the model. Returns `{"tuning": {...}}`.

- `reply` (any model; sent with every request to it by Chat, Arena and Tests, winning over the screen's own
  values; `system` is used only when the screen has none): `temperature` 0–2, `topP` 0–1, `topK` 0–200
  whole, `minP` 0–1, `presencePenalty` 0–2, `frequencyPenalty` 0–2, `seed` whole ≥ 0, `stop` up to 4 texts
  of at most 64 characters, `system` up to 8,000 characters.
- `load` (NInfer only): `contextTokens` 16384/32768/65536/98304/131072, `spec` dflash2/mtp/none,
  `draftTokens` 1–15, `kvDtype` rk4v4-e8/rk2v4-e8/rk4v4/rk8v4, `prefixCache` small/large/off,
  `thinkingBudget` 0–8192. Only values that differ from the entry's own are stored; they become
  `start-ninfer.ps1` arguments (a 64K entry started by `ninfer-launch.ps1` switches to `start-ninfer.ps1`
  in the same folder), and a new context also becomes the entry's `matchContext`. Applied on the next load.
- `400` with a plain sentence for any value out of range, or `load` for a model whose launcher owns it;
  `404` for an unknown id.

## `/api/store` (saved records)

A folder of JSON files under `data/store/<collection>/<id>.json` (the repo's `data/` folder is already gitignored for `*.json`). Collections: `chats`, `votes`, `runs`, `settings`. Any other collection name: 404.

- `GET /api/store/<collection>` -> `{"items": [{"id": "...", "updated": 1791609079.9, "title": "<value of the item's 'title' field or null>"}]}`, newest first.
- `GET /api/store/<collection>/<id>` -> the stored JSON object, or 404.
- `PUT /api/store/<collection>/<id>` with a JSON object body -> `{"ok": true, "id": "...", "updated": ...}`. Writes atomically (temp file in the same folder, then replace). Body limit 5 MB.
- `DELETE /api/store/<collection>/<id>` -> `{"ok": true}` (also when it did not exist).
- `id` must match `^[a-z0-9][a-z0-9_-]{0,63}$`. Anything else: 400. Never build a path from unchecked input.

### Record shapes (what each collection stores)

The gateway stores whatever JSON the browser puts; these are the shapes the app writes. `updated`
in a list is the file's modification time in seconds; a `created`/`updated`/`timestamp` inside a
record is the browser's own value (milliseconds or an ISO string).

- `chats` (id = the chat id): `{ id, title, model (string or null), system (string), created (ms), updated (ms), messages: [...] }`. Each message is `{ role ("user" or "model"), text }` plus, on a model message, `model` (its name); plus `thinking` (reasoning text) and `stats` (`{ words, seconds, wordsPerSecond, tokens, tokensPerSecond, thinkingSeconds, thinkingTokens }`) when present. A message saved by an older version has no `tokens` / `tokensPerSecond`; the screen then shows the word-based estimate marked `~`.
- `votes` (id = a new vote id): `{ id, title ("<nameA> vs <nameB>: <choice>"), round, type, question, modelA, modelB, answerA, answerB, wpsA, wpsB, tpsA, tpsB, systemFirst, systemSecond, choice ("A" | "B" | "tie" | "bad"), timestamp (ISO string) }`. `systemFirst` and `systemSecond` are the system prompts of the first and second setup (an empty string when the user left them blank); a side is A or B at random each round, so the instructions are recorded against the setup, not the letter.
- `runs` (id = the numeric run id as a string): `{ id (number), when (string), model, version, totalMinutes, peakGB, averageWordsPerSecond, averageTokensPerSecond, byType: [{ type, right, total, wordsPerSecond, tokensPerSecond }], missedCount, missed: [{ id, type, question, expected, answer }], readYourself: [{ id, type, question, answer }] }`. `byType` has one row per question type that ran and was scored (only the ticked types, plus `"Your questions"` when a custom question had an expected answer). A custom question without an expected answer is not scored: it is listed in `readYourself` with its full saved answer. Run records saved by an older version have no `tokensPerSecond` or `readYourself` and are still read (the screen falls back to the word-based estimate). No `title`, so its list title is `null`.
- `settings` (single id `chat`): `{ temperature, topP, maxTokens, thinking ("none" | "low" | "medium" | "high") }`.

## Static files

Everything else is served from `app/` `Cache-Control: no-store`. The server is threaded so that idle browser connections never block it.

## `POST /api/switch` and `GET /api/switch/status`

Load or unload a model from the catalogue. The gateway does the work in a background thread and answers at once.

- `POST /api/switch` body `{"model": "<catalogue id>"}` -> `202 {"ok": true}`. `{"model": null}` unloads (stops everything). A body without a `model` key: 400. An id that is not in the catalogue: 404 `{"error": "No model in the list has that id."}`. A second `POST` while a switch is running: 409 `{"error": "A switch is already running. Wait for it to finish."}`.
- Mode: the gateway only switches when env `ARENA_SWITCH_FAKE=1` (fake mode) or `ARENA_SWITCH_REAL=1` (real mode) is set. Without either: `403 {"error": "Real model switching is switched off."}`. Fake mode starts and stops `tools/fake_engine.py` on the gateway's engine port (test ports only — the launcher refuses any other port). Real mode uses the Strata / llama.cpp launchers (`tools/launcher.py`). Fake wins if both variables are set.
- `GET /api/switch/status` -> `{"state": "idle|stopping|starting|ready|failed", "model": "<id or null>", "message": "<plain sentence>", "startedAt": <epoch seconds or null>, "elapsedS": <seconds or null>, "stage": "idle|stopping|loading|warming|ready|failed", "stageLabel": "<plain words>", "progress": <0..1 or null>}`. `idle` means no switch has run yet (`startedAt`/`elapsedS` null). `elapsedS` keeps growing while a switch runs and freezes when it ends. A switch that has not finished within 10 minutes ends `failed` with a plain message. The last result also appears as the `Last switch:` line of the live record.
- `stageLabel` is a plain sentence for the stage: "Stopping the current model", "Loading the model into memory", "Warming up the model", "The model is ready.", "The switch failed.", "No switch has run yet." (or "No model is loaded." after an unload). `stage` and `stageLabel` say where the switch is: `stopping` is "Stopping the current model" (0 to 0.15 of the way, against the last measured stop time, default 12 s, kept in `data/live/switch-times.json`); `loading` is "Loading the model into memory" (the highest milestone reached in `data/live/switch.log` — engine started 0.2, model files 0.3, weights loaded, experts loaded 0.7, expert cache 0.85, almost ready 0.95 — or, when the engine prints none of them (Bonsai, fake mode), elapsed against that model's last measured start time from `switch-times.json`, default 60 s, capped at 0.95); `warming` is "Warming up the model" (the post-load probe, below); `ready` is 1.0 done; an unload that has finished reports `stage` `"idle"` with `progress` `null`. `progress` never goes down between two calls. When a switch ends, the time it took goes into `switch-times.json` (`stopS`, and `startS.<model id>`), so the next bar against the same model starts from the measured number.
- Warm-up probe: after the new model answers, the gateway sends it one small question (count from 1 to 30; `max_tokens` 64, thinking off). The speed is the engine's own decode figure (`timings.predicted_per_second`, sent by llama.cpp and NInfer) when the reply has at least 8 tokens; otherwise it is the reply's `usage` tokens over the elapsed time. The best result per model is kept in `data/live/model-speed.json`; the attempt and its verdict go into the switch log. The loaded model's last result appears in `GET /api/status` as `"warmup": {"tokensPerSecond": <n>, "usual": <best on record>, "slow": <bool>}`. `slow` is true when the number is under 40 percent of the model's best on record, or, with no record, under 10 tok/s. In fake mode the probe runs against the fake engine so the logic is tested; tests can force the measured number with a `warmupSeed` on the switch request body (a test seam; real requests never send it, and `ARENA_SWITCH_REAL` mode always measures for real).
- Switching stops whatever model is running first. Nothing else about the switch is safe to assume: while `stopping`/`starting`, `/api/status` reports the engine unreachable, and `/v1/...` proxy calls fail with 502.

## Chat call (browser -> engine through the proxy)

`POST /v1/chat/completions`, body `{"model": "<engine.model>", "messages": [...], "stream": true, "temperature": ..., "top_p": ..., "max_tokens": ...}`. The reply is server-sent events: lines `data: {json}` ending with `data: [DONE]`. Each chunk has `choices[0].delta.content` (answer text) and, for thinking models, `choices[0].delta.reasoning_content` (thinking text, not shown as the answer). Final chunk has `finish_reason`. To cancel, the browser aborts the fetch (`AbortController`); the gateway must then close the upstream connection so the engine stops.

## Browser engine interface (`app/js/engine.js`)

Screens import `engine` from `./engine.js`, the live client. The demo simulation is `engine-sim.js` (same calls and events, with the additions marked "both"); `engine.js` uses it only when the page URL contains `?sim=1` (demo mode). In live mode the engine loads and unloads models through the gateway switch service (`POST /api/switch`); it starts nothing by itself.

State (read by screens): `mode` ("live" or "sim"), `reachable` (bool), `loadedModelId` (string or null; live: the engine's model id), `loadedModel` (`{id, name, version}` or null; live: split the id at the last `-iq`, `-q`, `-f16` or `-bf16` part, so `qwen3.8-flash-next-iq3_xxs` becomes name `qwen3.8-flash-next`, version `IQ3_XXS`; no match: name is the whole id, version empty), `loading` (null, or `{modelId, direction ("load" or "unload"), progress 0-1, stageLabel}` while a switch runs; live: `progress` and `stageLabel` come from the gateway's `/api/switch/status` (`progress` never goes backwards; 1 when the gateway reports ready; fallback when an older gateway sends neither: an estimate against 60 s, capped at 0.95), `streaming`, `maxContext` (tokens or null), `contextTokens` (prompt + reply tokens of the latest request, else 0), `gpuUsedGB`, `gpuTotalGB`, `memory` (`{modelGB, conversationGB, otherAppsGB, sysGB}`: live estimate = otherAppsGB 1.2 constant, conversationGB = contextTokens / 1000 x 0.1 (an estimate), modelGB = used - other - conversation, sysGB 0), `fit` ("fits" under 85% of the card, "tight" up to 100%, else "spills"; null with no model), `speed` (`{wordsPerSecond, tokensPerSecond, firstWordSeconds, averageWordsPerSecond}`, measured in the browser from the stream), `lastReplySpeed`, `expectedWps` (live: last measured or 0).

Methods:
- `sendPrompt(input, opts = {})` -> boolean. `input` is a string (one user message) or an array of `{role, content}` messages. `opts`: `system` (string, prepended as a system message), `temperature`, `topP`, `maxTokens` (default 1024), `thinking` ("none" default, or "low", "medium", "high"). Returns false when no model is loaded or a stream is already running. Streams via `fetch('/v1/chat/completions', {stream: true})` with an `AbortController`.
- `stop()` aborts the stream and ends the reply with `done`.
- `loadModel(id)` and `unloadModel()` (live): post `{"model": id}` or `{"model": null}` to `/api/switch`, then poll `/api/switch/status` every second, setting `loading` and emitting `progress` and `change`. The promise resolves when the switch ends; a `failed` switch emits `error` with the gateway's plain message. It rejects only when the switch cannot start: another switch is running (`Error("A model is already loading. Wait for it to finish.")`) or the gateway refuses (403, 404, 409 message). `swapToSlot` rejects with `Error("Quick slots work only in the demo.")`. `estimateMemory` keeps working from `data.js` (sample estimates are used only for demo models).
- `refresh()` -> promise: polls `/api/status` now. The engine polls by itself: every 1 s while streaming, every 3 s otherwise, and stops polling nothing: it runs for the life of the page.

Events (all on the engine EventTarget): `change` (any state change), `speed` `{wordsPerSecond, tokensPerSecond, firstWordSeconds, averageWordsPerSecond, averageTokensPerSecond, phase}` (`phase` is `"reading"`, `"thinking"` or `"writing"`), `progress` (sim, and live during a switch) `{modelId, progress, direction}`, `word` `{word, index}` (one per complete word; flush the last partial word at the end), `text` `{delta}` (raw answer text as it arrives; both engines), `thinking` `{delta}` (reasoning text; live only), `error` `{message}` (plain sentence; follows with `done`), `done` `{words, seconds, wordsPerSecond, tokens, tokensPerSecond, firstWordSeconds, text, finishReason, promptTokens, completionTokens, thinkingSeconds, thinkingTokens, failed}` (live: `tokens` is an estimate from streamed text, replaced by `usage.completion_tokens` when it arrives, and `thinkingSeconds` / `thinkingTokens` describe the reasoning part of the reply; 0 when there was none).

Failure behaviour: engine unreachable -> `reachable` false, `loadedModelId` null, `change` emitted; recovers by itself when it answers again. A stream that dies mid-reply ends with `error` then `done {failed: true}` and keeps the text received so far. Never throw into the page.

## Storage details

- Engine unreachable: `live.state` is `null` (browser code treats `null` as "no engine"). llama.cpp: `engine.version` is `null`.
- The 502 message names the address the app just tried: `No model engine is answering on <host>:<port>.` The port is the loaded model's own port, or `ARENA_ENGINE` when nothing has been loaded in this run.
- Pass-through replies carry the engine's own `Content-Type` only; no `Cache-Control` is added.
- Store `updated` is the file's modification time; `GET` returns the stored object unchanged.
- `processes[].name` in `/api/gpu` is the file name without its folder.
- Fast listing: each collection keeps a `_index.json` (id -> `{updated, title}`). `PUT` and `DELETE` update it; `GET /api/store/<collection>` reads only the index. The index is rebuilt from the folder when it is missing or its record IDs disagree with the files. `_index` is not a valid record id (the id pattern forbids a leading underscore), so it is never listed or fetched as a record.
- Known limits: a save can fail with 500 if Windows has the target open at that instant.

## Added models

GET /api/models/discover lists scanned GGUF files, available llama-server programs and answering local servers. POST /api/models/inspect accepts {path}; POST /api/models/folders accepts {path} to add a scan folder; POST /api/models/probe accepts {port} to inspect a local OpenAI-compatible server. Fake mode probes only its fake engine port.

POST /api/models adds a model. A GGUF body uses {kind:"gguf",name,version?,settings:{modelPath,runtime,contextTokens?,gpuLayers?,flashAttn?,kvCache?,projector?,extraArgs?}}. An external body uses {kind:"external",name,port,serverModel,contextTokens?}. PUT /api/models/<id> edits an added model; DELETE removes its entry. File paths must exist and protected host/model/port/alias flags cannot be overridden. Failed persistence returns a non-2xx JSON error.

A switch remains starting with stage warming until its probe finishes. Only then is ready published. Test warm-up seeds are ignored in real mode. External unload disconnects without stopping the server. A valid selected endpoint survives background adoption. Explicit ARENA_ENGINE without real switching disables adoption.

Store record replacement and index mutation share one lock. Browser writes for the same record are serialized and capture their body when queued. Tests waits for saved history before choosing a new numeric run ID. New runs use If-None-Match: * for create-only writes. A collision returns 412 without replacing the old record; the browser selects another ID and retries. Ordinary PUT keeps overwrite behavior.
