// Model client. Live by default: it talks to the local gateway on the same origin (server.py).
// Demo mode (?sim=1) uses the simulated engine in engine-sim.js instead. Screens import `engine`
// and `defaultLayers` from here; both modes export the same calls and events.
import { models } from "./data.js";
import { defaultLayers, memoryFor } from "./engine-sim.js";

const LIVE_OTHER_APPS_GB = 1.2;              // live estimate of graphics memory used by other programs
const CONVERSATION_GB_PER_1000_TOKENS = 0.1; // estimate of the conversation cache, per 1,000 tokens
const FIT_TIGHT_LIMIT = 0.85;                // share of the card: below this the model fits
const FIT_SPILL_LIMIT = 1.0;                 // share of the card: above this the model spills
const MIB_PER_GB = 1024;
const TOKENS_PER_WORD = 1.33;
const TOKEN_SCALE_KEY = "bench.tokenScale"; // each model's learned engine-tokens per estimated token
const CHARS_PER_TOKEN = 4;   // fallback for a piece of text with no spaces at all
const SAMPLE_MS = 100;       // speed sampler interval
const WINDOW_S = 1;          // speed sampler window, seconds
const SMOOTHING = 0.3;       // 0 to 1: higher reacts faster, less steady
const STREAM_POLL_MS = 1000; // status poll while a reply streams
const IDLE_POLL_MS = 3000;   // status poll otherwise
const STATUS_TIMEOUT_MS = 4000;

// Tokens in one streamed piece of text. The engine decides how much text arrives in a chunk, and some
// servers (NInfer among them) put several tokens in a chunk, so one chunk is not one token. Words
// first, characters when the piece has no spaces, never less than one token for real text. It is an
// estimate for the live meter only: the finished reply is corrected against the engine's own usage.
// Exported so the checks can hold this rule still: one streamed chunk is not one token.
function savedTokenScale(modelId) {
  try {
    const value = JSON.parse(localStorage.getItem(TOKEN_SCALE_KEY) || "{}")[modelId];
    return Number.isFinite(value) && value > 0.25 && value < 6 ? value : null;
  } catch {
    return null;
  }
}

function saveTokenScale(modelId, scale) {
  if (!modelId) return;
  try {
    const all = JSON.parse(localStorage.getItem(TOKEN_SCALE_KEY) || "{}");
    all[modelId] = Math.round(scale * 1000) / 1000;
    localStorage.setItem(TOKEN_SCALE_KEY, JSON.stringify(all));
  } catch {
    // Storage full or blocked: the scale is still learned for this session.
  }
}

export function estimateTokens(text) {
  const piece = String(text ?? "").trim();
  if (!piece) return 0;
  const words = piece.split(/\s+/).filter(Boolean).length;
  // Several words: the long-standing words-to-tokens ratio, never below the word count itself.
  if (words > 1) return Math.max(words, Math.round(words * TOKENS_PER_WORD));
  // One run with no spaces (a number, a long word, a code identifier): about four characters a token.
  return Math.max(1, Math.round(piece.length / CHARS_PER_TOKEN));
}
const ENGINE_LOST = "The model engine stopped answering during the reply.";
const REPLY_CUT_OFF = "The reply stopped before the model finished it.";
const SWITCH_LATER = "Quick slots work only in the demo.";
const SWITCH_POLL_MS = 1000;    // /api/switch/status poll while a switch runs
const SWITCH_ESTIMATE_S = 60;   // fallback load estimate when an older gateway sends no progress
const SWITCH_PROGRESS_CAP = 0.95;
const SWITCH_WAIT_MS = 660000;  // the gateway gives up at 10 minutes; wait a little past that

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class ReplyError extends Error {}

function findModel(id) {
  const model = models.find((m) => m.id === id);
  if (!model) throw new Error(`Unknown model: ${id}`);
  return model;
}

// "qwen3.8-flash-next-iq3_xxs" -> name "qwen3.8-flash-next", version "IQ3_XXS".
// No quantisation suffix: the whole id is the name and the version is empty.
function splitModelId(id) {
  const match = id.match(/^(.*)-((?:i?q\d|f16|bf16)[^-]*)$/i);
  if (!match) return { id, name: id, version: "" };
  return { id, name: match[1], version: match[2].toUpperCase() };
}

function wordCount(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

// A string is one user message; an array is used as given. The system prompt goes first.
function toMessages(input, system) {
  const messages = typeof input === "string" ? [{ role: "user", content: input }] : [...input];
  return system ? [{ role: "system", content: system }, ...messages] : messages;
}

// Text of a failed HTTP reply: the gateway's plain sentence when it sent one.
async function httpErrorMessage(res) {
  try {
    const body = await res.json();
    if (typeof body?.error === "string") return body.error;
  } catch {
    // Not JSON: fall through to the generic sentence.
  }
  return "The model engine returned an error. Try again.";
}

class LiveEngine extends EventTarget {
  constructor() {
    super();
    this.mode = "live";
    this.reachable = false;
    this.kind = null;             // engine kind from the gateway ("strata" or "llama.cpp"); null = unknown
    this.loadedModelId = null;
    this.loadedModel = null;
    this.warmup = null;           // null, or { tokensPerSecond, usual, slow } from the gateway
    this.loading = null;          // null, or { modelId, direction, progress } while a switch runs
    this.streaming = false;
    this.maxContext = null;
    this.contextTokens = 0;
    this.gpuUsedGB = 0;
    this.gpuTotalGB = 0;
    this.memory = { modelGB: 0, conversationGB: 0, otherAppsGB: LIVE_OTHER_APPS_GB, sysGB: 0 };
    this.fit = null;
    this.expectedWps = 0;         // last measured words per second
    this.lastReplySpeed = null;
    this.lastReplyTokensPerSecond = null;
    this.speed = { wordsPerSecond: 0, tokensPerSecond: 0, firstWordSeconds: null, averageWordsPerSecond: null, averageTokensPerSecond: null };
    // Running totals across replies this session, for the average speed.
    this._conversation = { words: 0, tokens: 0, seconds: 0 };
    // Engine tokens per estimated token, learned from finished replies (their usage count). Code and
    // markup hold far more tokens per word than prose, so the raw estimate ran low on them: the live
    // graph peaked under the reply's real speed. The live figure is scaled by this; 1 until learned.
    this._tokenScale = 1;
    this._scaleModel = null;      // the model _tokenScale was loaded for
    this.replyTuning = {};        // the loaded model's own reply settings (Models > Settings), applied to every request
    this._tuningKey = null;       // which model and context replyTuning belongs to
    this._run = null;             // the reply in progress, or null
    this._refreshing = null;
    this._pollTimer = null;
    this._poll();
  }

  emit(type, detail = null) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  estimateMemory({ modelId, layersOnCard, contextTokens } = {}) {
    return memoryFor(findModel(modelId), { layersOnCard, contextTokens });
  }

  // The gateway does not report layers on the card. Chat reads this field, so it gets "all on the
  // card" here, and the spill warning comes from `fit`.
  get loadSettings() {
    return this.loadedModelId ? { layersOnCard: Infinity, contextTokens: this.contextTokens } : null;
  }

  // Load or unload a model through the gateway. The promise resolves when the switch ends; a failed
  // switch is reported by the 'error' event. It rejects only when the switch cannot start.
  async loadModel(id) {
    return this._switch({ model: id }, "load", id);
  }

  async unloadModel() {
    return this._switch({ model: null }, "unload", null);
  }

  async swapToSlot() {
    throw new Error(SWITCH_LATER);
  }

  async _switch(body, direction, modelId) {
    if (this.loading) throw new Error("A model is already loading. Wait for it to finish.");
    this.stop();
    this.loading = { modelId, direction, progress: 0 };
    this.emit("progress", { ...this.loading });
    this.emit("change");
    try {
      const res = await fetch("/api/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await httpErrorMessage(res));
      await this._waitSwitch();
    } catch (error) {
      this.loading = null;
      this.emit("change");
      if (error instanceof TypeError) throw new Error("The gateway could not be reached. Try again.");
      throw error;
    }
  }

  // Poll /api/switch/status every second and follow the gateway's stage and progress. Without them,
  // fall back to an elapsed-time estimate against 60 s, capped at 0.95.
  async _waitSwitch() {
    const { modelId, direction } = this.loading;
    const started = Date.now();
    let bestProgress = 0;
    const move = (progress, stageLabel = null) => {
      bestProgress = Math.max(bestProgress, progress);  // the percentage never goes backwards
      this.loading = { modelId, direction, progress: bestProgress, stageLabel };
      this.emit("progress", { ...this.loading });
      this.emit("change");
    };
    for (;;) {
      await sleep(SWITCH_POLL_MS);
      let st = null;
      try {
        const res = await fetch("/api/switch/status", { cache: "no-store", signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) });
        if (res.ok) st = await res.json();
      } catch {
        st = null;
      }
      if (st && st.state === "ready") {
        this.loading = { modelId, direction, progress: 1 };
        this.emit("progress", { ...this.loading });
        // A poll started during unloading may still be returning the old engine.
        if (this._refreshing) await this._refreshing;
        await this.refresh();
        await this._tuningPromise;
        this.loading = null;
        this.emit("change");
        return true;
      }
      if (st && st.state === "failed") {
        this.loading = null;
        const message = typeof st.message === "string" && st.message ? st.message : "The model could not be loaded.";
        this.emit("error", { message });
        this.emit("change");
        return;
      }
      if (Date.now() - started > SWITCH_WAIT_MS) {
        this.loading = null;
        this.emit("error", { message: "The gateway stopped answering during the switch." });
        this.emit("change");
        return;
      }
      if (st && typeof st.progress === "number") {
        move(st.progress, typeof st.stageLabel === "string" && st.stageLabel ? st.stageLabel : null);
      } else {
        move(Math.min(SWITCH_PROGRESS_CAP, (Date.now() - started) / (SWITCH_ESTIMATE_S * 1000)));
      }
    }
  }

  // Starts a reply. `input` is a string or an array of { role, content }.
  // Returns false when no model is loaded or a reply is already streaming.
  sendPrompt(input, opts = {}) {
    if (!this.loadedModelId || this.loading || this.streaming) return false;
    // The model's own settings (Models > Settings) win over the screen's for every key they set. Its system
    // prompt is used when the screen has none of its own (Chat's per-chat prompt, an Arena side's).
    const makeBody = () => {
      const tune = this.replyTuning ?? {};
      const messages = toMessages(input, opts.system || tune.system);
      const body = {
        model: this.loadedModelId,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        temperature: tune.temperature ?? opts.temperature,
        top_p: tune.topP ?? opts.topP,
        // Never ask for more than the loaded model's whole context: some engines refuse that.
        max_tokens: this.maxContext ? Math.min(opts.maxTokens ?? 1024, this.maxContext) : (opts.maxTokens ?? 1024),
        reasoning_effort: opts.thinking ?? "none",
      };
      // A thinking cap ends a thinking loop: at the cap the engine closes the thinking and the model answers.
      // Only sent while thinking (NInfer reads it; engines that do not know it ignore an unknown field).
      if (opts.thinkingBudget > 0 && (opts.thinking ?? "none") !== "none") body.thinking_budget = opts.thinkingBudget;
      // The model's own value is sent even at 0; the screen's only when it asks for a penalty.
      if (Number.isFinite(tune.presencePenalty)) body.presence_penalty = tune.presencePenalty;
      else if (opts.presencePenalty > 0) body.presence_penalty = opts.presencePenalty;
      if (Number.isFinite(tune.frequencyPenalty)) body.frequency_penalty = tune.frequencyPenalty;
      if (Number.isInteger(tune.topK)) body.top_k = tune.topK;
      if (Number.isFinite(tune.minP)) body.min_p = tune.minP;
      if (Number.isInteger(tune.seed)) body.seed = tune.seed;
      if (Array.isArray(tune.stop) && tune.stop.length) body.stop = tune.stop;
      return body;
    };
    const run = {
      modelId: this.loadedModelId,
      tuningKey: this._tuningKey,
      controller: new AbortController(),
      promptWords: 0,
      words: [],          // complete words, in order
      partial: "",        // text after the last whitespace, held until the word is complete
      usage: null,        // token counts from the final chunk, when the engine sends them
      sawEnd: false,      // a finish_reason or [DONE] arrived
      start: performance.now(),
      firstAt: null,
      firstReasoningAt: null,   // first reasoning piece from the engine
      firstContentAt: null,     // first answer piece from the engine
      reasoningTokens: 0,       // tokens counted from reasoning pieces
      stamps: [],
      smoothed: null,
      tokens: 0,
      tokenStamps: [],
      lastTokenAt: null,        // the last token seen: first token to here is the speed window
      firstTokenAt: null,       // the first token of any kind, thinking or answer
      smoothedTokens: null,
      sampler: null,
    };
    this._run = run;
    this.streaming = true;
    run.sampler = setInterval(() => this._sample(run), SAMPLE_MS);
    // The reply starts in the reading phase: the model has the prompt and has said nothing yet.
    this.speed = { wordsPerSecond: 0, tokensPerSecond: 0, firstWordSeconds: null, averageWordsPerSecond: null, averageTokensPerSecond: null, phase: "reading" };
    this.emit("speed", this.speed);
    this._schedulePoll();
    this.emit("change");
    this._stream(run, makeBody);
    return true;
  }

  // Ends the reply now. Emits 'done' with finishReason "cancel" and the text so far.
  stop() {
    const run = this._run;
    if (!run) return;
    this._finish(run, "cancel", false);
    run.controller.abort();
  }

  // Polls /api/status now. Never rejects: an unreachable engine is reported in the state.
  refresh() {
    if (!this._refreshing) {
      this._refreshing = this._fetchStatus().finally(() => {
        this._refreshing = null;
      });
    }
    return this._refreshing;
  }

  _poll() {
    this.refresh().then(() => this._schedulePoll());
  }

  _schedulePoll() {
    clearTimeout(this._pollTimer);
    this._pollTimer = setTimeout(() => this._poll(), this.streaming ? STREAM_POLL_MS : IDLE_POLL_MS);
  }

  async _fetchStatus() {
    let status = null;
    try {
      const res = await fetch("/api/status", { cache: "no-store", signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) });
      if (res.ok) status = await res.json();
    } catch {
      status = null;
    }
    this._applyStatus(status);
    await this._tuningPromise;
  }

  _applyStatus(status) {
    const info = status?.engine ?? {};
    const gpu = status?.gpu ?? null;
    this.reachable = info.reachable === true;
    this.kind = info.kind ?? null; // "strata" or "llama.cpp"; screens use it for the memory wording
    this.loadedModelId = this.reachable && info.model ? info.model : null;
    // Each model keeps its learned token scale across sessions, so a new session's first reply reads right.
    if (this.loadedModelId && this.loadedModelId !== this._scaleModel) {
      this._scaleModel = this.loadedModelId;
      this._tokenScale = savedTokenScale(this.loadedModelId) ?? 1;
    }
    this.maxContext = this.reachable && info.maxContext ? info.maxContext : null;
    // Screens read maxContext from the model object, so carry the engine's figure on it.
    this.loadedModel = this.loadedModelId
      ? { ...splitModelId(this.loadedModelId), maxContext: this.maxContext }
      : null;
    this.gpuUsedGB = gpu ? gpu.usedMiB / MIB_PER_GB : 0;
    this.gpuTotalGB = gpu ? gpu.totalMiB / MIB_PER_GB : 0;
    this.gpuName = gpu?.name ?? null;
    const warmup = status?.warmup ?? null;
    this.warmup = (warmup && typeof warmup === "object" && typeof warmup.slow === "boolean") ? warmup : null;
    this._recalc();
    const tuningKey = this.loadedModelId ? `${this.loadedModelId}@${this.maxContext}` : null;
    if (tuningKey !== this._tuningKey) {
      this._tuningKey = tuningKey;
      this.replyTuning = {};
      this.loadedEntryId = null;
      this.loadedEntryName = null;
      this.refreshTuning();
    }
    this.emit("change");
  }

  // The loaded model's saved reply settings, from the catalogue entry the gateway marks as loaded.
  // Called when the loaded model changes and after Models > Settings saves.
  refreshTuning() {
    const key = this._tuningKey;
    const generation = this._tuningGeneration = (this._tuningGeneration ?? 0) + 1;
    this._tuningPromise = (async () => {
      let entry = null;
      if (this.loadedModelId) {
        try {
          const res = await fetch("/api/models", { cache: "no-store", signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) });
          const data = res.ok ? await res.json() : { models: [] };
          entry = (data.models ?? []).find((m) => m.loaded) ?? null;
        } catch { /* Unavailable catalogue: leave model settings empty. */ }
      }
      if (generation !== this._tuningGeneration || key !== this._tuningKey) return;
      this.replyTuning = entry?.tuning?.reply ?? {};
      this.loadedEntryId = entry?.id ?? null;
      this.loadedEntryName = entry?.name ?? null;
      this.emit("tuning");
    })();
    return this._tuningPromise;
  }

  // Test hook (80-slow-start): feed a warm-up result as if the gateway had sent it.
  applyWarmupForTest(modelId, warmup) {
    this.warmup = warmup;
    this.emit("change");
  }

  // Memory split and fit from the last status. The split is an estimate.
  _recalc() {
    const loaded = this.loadedModelId !== null;
    const conversationGB = loaded ? (this.contextTokens / 1000) * CONVERSATION_GB_PER_1000_TOKENS : 0;
    const modelGB = loaded ? Math.max(0, this.gpuUsedGB - LIVE_OTHER_APPS_GB - conversationGB) : 0;
    this.memory = { modelGB, conversationGB, otherAppsGB: LIVE_OTHER_APPS_GB, sysGB: 0 };
    const share = this.gpuTotalGB > 0 ? (modelGB + conversationGB) / this.gpuTotalGB : null;
    if (!loaded || share === null) this.fit = null;
    else if (share < FIT_TIGHT_LIMIT) this.fit = "fits";
    else if (share <= FIT_SPILL_LIMIT) this.fit = "tight";
    else this.fit = "spills";
  }

  async _stream(run, makeBody) {
    try {
      for (;;) {
        const tuning = this._tuningPromise;
        await tuning;
        if (run !== this._run) return;
        if (run.modelId !== this.loadedModelId || run.tuningKey !== this._tuningKey) {
          throw new ReplyError("The model changed before it could answer. Try again.");
        }
        if (tuning === this._tuningPromise) break;
      }
      if (run !== this._run) return;
      const body = makeBody();
      run.promptWords = body.messages.reduce((sum, m) => sum + wordCount(String(m.content)), 0);
      const res = await fetch("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: run.controller.signal,
      });
      if (!res.ok) throw new ReplyError(await httpErrorMessage(res));
      if (!res.body) throw new ReplyError(ENGINE_LOST);
      await this._read(run, res.body);
      if (run !== this._run) return;
      if (!run.sawEnd) throw new ReplyError(REPLY_CUT_OFF);
      this._finish(run, "stop", false);
    } catch (error) {
      // stop() ended this reply already, and its abort lands here: nothing more to say.
      if (run !== this._run) return;
      this.emit("error", { message: error instanceof ReplyError ? error.message : ENGINE_LOST });
      this._finish(run, "error", true);
    }
  }

  async _read(run, body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (run !== this._run) return;
      pending += decoder.decode(value, { stream: !done });
      const lines = pending.split("\n");
      pending = done ? "" : lines.pop();
      for (const line of lines) {
        this._handleLine(run, line);
        if (run !== this._run) return;
      }
      if (done) return;
    }
  }

  // One line of server-sent events: "data: {json}" or "data: [DONE]".
  _handleLine(run, line) {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (payload === "") return;
    if (payload === "[DONE]") {
      run.sawEnd = true;
      return;
    }
    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      throw new ReplyError(ENGINE_LOST);
    }
    if (chunk.usage) run.usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) return;
    const delta = choice.delta ?? {};
    if (delta.reasoning_content) {
      if (run.firstReasoningAt === null) run.firstReasoningAt = performance.now();
      run.reasoningTokens += this._token(run, delta.reasoning_content);
      if (run !== this._run) return;
      this.emit("thinking", { delta: delta.reasoning_content });
      if (run !== this._run) return;
    }
    if (delta.content) {
      if (run.firstContentAt === null) run.firstContentAt = performance.now();
      this._token(run, delta.content);
      if (run !== this._run) return;
      this._addText(run, delta.content);
    }
    if (choice.finish_reason) run.sawEnd = true;
  }

  // Splits answer text into words. The last piece after a space may be an unfinished word,
  // so it is held back until the next chunk or the end of the reply.
  _addText(run, delta) {
    this.emit("text", { delta });
    if (run !== this._run) return;
    const pieces = (run.partial + delta).split(/\s+/);
    run.partial = pieces.pop();
    for (const word of pieces) {
      if (!word) continue;
      this._word(run, word);
      if (run !== this._run) return;
    }
  }

  _word(run, word) {
    const now = performance.now();
    const index = run.words.length;
    run.words.push(word);
    if (run.firstAt === null) run.firstAt = now;
    run.stamps.push(now);
    this.emit("word", { word, index });
  }

  _token(run, piece) {
    // One chunk is not one token: NInfer sends about three tokens in every chunk, so counting chunks
    // reported about a third of the real speed. Estimate the tokens in this piece instead; the final
    // figure is corrected against the engine's own usage count at the end of the reply.
    const count = estimateTokens(piece);
    if (!count) return 0;
    const now = performance.now();
    run.firstTokenAt = run.firstTokenAt ?? now;
    run.tokens += count;
    for (let i = 0; i < count; i += 1) run.tokenStamps.push(now);
    run.lastTokenAt = now;
    return count;
  }

  // What the model is doing right now: reading the prompt, thinking, or writing the answer.
  _phase(run) {
    if (run.firstContentAt !== null) return "writing";
    if (run.firstReasoningAt !== null) return "thinking";
    return "reading";
  }

  _sample(run) {
    const now = performance.now();
    const windowS = Math.max(0.1, Math.min(WINDOW_S, (now - run.start) / 1000));
    const cutoff = now - WINDOW_S * 1000;
    run.stamps = run.stamps.filter((t) => t > cutoff);
    run.tokenStamps = run.tokenStamps.filter((t) => t > cutoff);
    const recentWords = run.stamps.length;
    const recentTokens = run.tokenStamps.length;
    const rawWords = recentWords / windowS;
    const rawTokens = (recentTokens / windowS) * this._tokenScale;
    run.smoothed = run.smoothed === null ? rawWords : run.smoothed + (rawWords - run.smoothed) * SMOOTHING;
    run.smoothedTokens = run.smoothedTokens === null ? rawTokens : run.smoothedTokens + (rawTokens - run.smoothedTokens) * SMOOTHING;
    const elapsed = (now - run.start) / 1000;
    const averageWords = (this._conversation.words + run.words.length) / (this._conversation.seconds + elapsed);
    const averageTokens = (this._conversation.tokens + run.tokens) / (this._conversation.seconds + elapsed);
    this.speed = {
      wordsPerSecond: run.smoothed,
      tokensPerSecond: run.smoothedTokens ?? 0,
      firstWordSeconds: run.firstAt === null ? null : (run.firstAt - run.start) / 1000,
      averageWordsPerSecond: averageWords,
      averageTokensPerSecond: averageTokens,
      phase: this._phase(run),
    };
    this.emit("speed", this.speed);
    this.emit("change");
  }

  _finish(run, finishReason, failed) {
    if (run !== this._run) return;
    // Emit the word still held back, if any.
    if (run.partial) {
      const word = run.partial;
      run.partial = "";
      this._word(run, word);
      if (run !== this._run) return;
    }
    this._run = null;
    clearInterval(run.sampler);
    const seconds = (performance.now() - run.start) / 1000;
    const words = run.words.length;
    const text = run.words.join(" ");
    const firstWordSeconds = run.firstAt === null ? null : (run.firstAt - run.start) / 1000;
    // Speed is measured from the first token to the last, so the prompt read and the wait for the first
    // token do not drag it down. Both are reported separately: firstTokenSeconds is that wait, and the
    // whole reply took `seconds`. The engine's own figure counts the same way.
    const firstTokenSeconds = run.firstTokenAt === null ? null : (run.firstTokenAt - run.start) / 1000;
    const speedSeconds = run.firstTokenAt === null ? 0
      : Math.max(0, ((run.lastTokenAt ?? run.firstTokenAt) - run.firstTokenAt) / 1000);
    const wordsPerSecond = speedSeconds > 0 ? words / speedSeconds : 0;
    const thinkingSeconds = run.firstReasoningAt === null ? 0
      : Math.max(0, ((run.firstContentAt ?? performance.now()) - run.firstReasoningAt) / 1000);
    const usage = run.usage;
    const promptTokens = usage?.prompt_tokens ?? Math.round(run.promptWords * TOKENS_PER_WORD);
    const completionTokens = usage?.completion_tokens ?? run.tokens;
    const tokens = completionTokens;
    // How far this reply's live estimate was off: the screens correct its graph by it, and the next
    // reply's live figure starts from it (blended, so one odd reply does not swing it).
    const scaleUsed = this._tokenScale;
    const ratio = usage?.completion_tokens && run.tokens > 0 ? usage.completion_tokens / run.tokens : null;
    const tokenCorrection = ratio === null ? 1 : ratio / scaleUsed;
    if (ratio !== null && ratio > 0.25 && ratio < 6) {
      this._tokenScale = run.tokens >= 200 ? ratio : scaleUsed + (ratio - scaleUsed) * (run.tokens / 200);
      saveTokenScale(this.loadedModelId, this._tokenScale);
    }
    this._conversation.words += words;
    this._conversation.tokens += tokens;
    this._conversation.seconds += seconds;
    this._conversation.writeSeconds = (this._conversation.writeSeconds ?? 0) + speedSeconds;
    const averageWordsPerSecond = this._conversation.writeSeconds > 0
      ? this._conversation.words / this._conversation.writeSeconds
      : null;
    const averageTokensPerSecond = this._conversation.writeSeconds > 0
      ? this._conversation.tokens / this._conversation.writeSeconds
      : null;
    const tokensPerSecond = speedSeconds > 0 ? tokens / speedSeconds : 0;
    this.streaming = false;
    this.lastReplySpeed = wordsPerSecond;
    this.lastReplyTokensPerSecond = tokensPerSecond;
    this.expectedWps = wordsPerSecond;
    this.speed = {
      wordsPerSecond,
      tokensPerSecond,
      firstWordSeconds,
      averageWordsPerSecond,
      averageTokensPerSecond,
      phase: this._phase(run),
    };
    this.contextTokens = promptTokens + completionTokens;
    this._recalc();
    // A reply that died may mean the engine died: ask it now rather than at the next idle poll.
    if (failed) this._poll();
    else this._schedulePoll();
    this.emit("done", {
      words, seconds, speedSeconds, wordsPerSecond, tokens, tokensPerSecond, firstTokenSeconds, firstWordSeconds,
      text, finishReason, promptTokens, completionTokens, failed, thinkingSeconds, thinkingTokens: run.reasoningTokens,
      tokenCorrection, startedAt: run.start,
    });
    this.emit("change");
  }
}

// Demo mode: the simulated engine. Live: the client above. Decided once, at import.
const sim = new URLSearchParams(location.search).has("sim") ? await import("./engine-sim.js") : null;
export const engine = sim ? sim.engine : new LiveEngine();
export { defaultLayers };

// Test hook: checks reach the engine the screens use (80-slow-start feeds it a warm-up status).
globalThis.benchEngine = engine;
