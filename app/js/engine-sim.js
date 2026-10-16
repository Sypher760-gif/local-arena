// Simulated model engine. No UI in here: screens listen for events.
// Used by engine.js only in demo mode (?sim=1). Same calls and events as the live client.
import {
  models, slots, cannedReply, DEFAULT_CONTEXT_TOKENS, GPU_TOTAL_GB,
  OTHER_APPS_GB, OVERHEAD_GB, KV_GB_PER_1000_TOKENS, FIT_TIGHT_LIMIT,
  FIT_SPILL_LIMIT, FULL_WPS, HALF_SPILLED_WPS,
} from "./data.js";

const LOAD_MS = 2000;       // a full load or unload takes about this long
const FAIL_AT = 0.6;        // a model that fails to load stops at this progress
const SAMPLE_MS = 100;      // speed sampler interval
const WINDOW_S = 1;         // speed sampler window, seconds
const SMOOTHING = 0.3;      // 0 to 1: higher reacts faster, less steady
const TOKENS_PER_WORD = 1.33;

function findModel(id) {
  const model = models.find((m) => m.id === id);
  if (!model) throw new Error(`Unknown model: ${id}`);
  return model;
}

// Words in a prompt: a string, or an array of { role, content } messages.
function countWords(input) {
  const texts = typeof input === "string" ? [input] : input.map((m) => m.content);
  return texts.reduce((sum, text) => sum + String(text).split(/\s+/).filter(Boolean).length, 0);
}

// Memory and expected speed for one model at given load settings. No state.
export function memoryFor(model, { layersOnCard = model.layers, contextTokens = DEFAULT_CONTEXT_TOKENS } = {}) {
  const onCard = Math.min(Math.max(layersOnCard, 0), model.layers);
  const cardShare = onCard / model.layers;
  const modelGB = model.sizeGB * cardShare + OVERHEAD_GB;
  const conversationGB = (contextTokens / 1000) * KV_GB_PER_1000_TOKENS;
  const gpuGB = modelGB + conversationGB;
  const share = gpuGB / GPU_TOTAL_GB;
  const fit = share < FIT_TIGHT_LIMIT ? "fits" : share <= FIT_SPILL_LIMIT ? "tight" : "spills";
  // Part of the model that runs from system memory: layers off the card, plus any overflow.
  const overflowShare = Math.max(0, gpuGB - GPU_TOTAL_GB) / model.sizeGB;
  const spilled = Math.min(1, 1 - cardShare + overflowShare);
  const expectedWps = spilled === 0
    ? FULL_WPS
    : FULL_WPS * Math.pow(HALF_SPILLED_WPS / FULL_WPS, spilled / 0.5);
  return { gpuGB, sysGB: model.sizeGB * (1 - cardShare), fit, expectedWps, modelGB, conversationGB };
}

// Most layers that fit on the card with a small margin left for other programs.
export function defaultLayers(model, contextTokens = DEFAULT_CONTEXT_TOKENS) {
  const room = GPU_TOTAL_GB - OTHER_APPS_GB - 0.4 - OVERHEAD_GB - (contextTokens / 1000) * KV_GB_PER_1000_TOKENS;
  return Math.max(0, Math.min(model.layers, Math.floor((room / model.sizeGB) * model.layers)));
}

class Engine extends EventTarget {
  constructor() {
    super();
    this.mode = "sim";
    this.reachable = true;
    this.kind = "llama.cpp"; // the simulated engine behaves like one on the card
    this.loadedModelId = null;
    this.loadSettings = null;
    this.contextTokens = 0;       // prompt + reply tokens of the latest reply
    this.gpuTotalGB = GPU_TOTAL_GB;
    this.gpuUsedGB = OTHER_APPS_GB;
    this.memory = { modelGB: 0, conversationGB: 0, otherAppsGB: OTHER_APPS_GB, sysGB: 0 };
    this.fit = null;
    this.expectedWps = 0;
    this.loading = null;          // null or { modelId, progress 0-1, direction: 'load' | 'unload' }
    this.streaming = false;
    this.lastReplySpeed = null;
    this.lastReplyTokensPerSecond = null;
    this.speed = { wordsPerSecond: 0, tokensPerSecond: 0, firstWordSeconds: null, averageWordsPerSecond: null, averageTokensPerSecond: null };
    // Running totals across replies this session, for the average speed.
    this._conversation = { words: 0, tokens: 0, seconds: 0 };
    this._timer = null;
    this._sampler = null;
  }

  emit(type, detail = null) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  get loadedModel() {
    if (!this.loadedModelId) return null;
    const { id, name, version } = findModel(this.loadedModelId);
    return { id, name, version };
  }

  get maxContext() {
    return this.loadedModelId ? findModel(this.loadedModelId).maxContext : null;
  }

  estimateMemory({ modelId, layersOnCard, contextTokens } = {}) {
    return memoryFor(findModel(modelId), { layersOnCard, contextTokens });
  }

  // Loads a model, replacing the loaded one. `instant` skips the animation (used at start).
  async loadModel(id, { layersOnCard, contextTokens, instant = false } = {}) {
    const model = findModel(id);
    if (this.loading) throw new Error("Another model is still loading");
    this.stop();
    const ctx = contextTokens ?? DEFAULT_CONTEXT_TOKENS;
    const settings = {
      layersOnCard: layersOnCard ?? defaultLayers(model, ctx),
      contextTokens: ctx,
    };
    // The old model is released first, so a failed load leaves nothing loaded.
    this.loadedModelId = null;
    this.loadSettings = null;
    this.loading = { modelId: id, progress: 0, direction: "load" };
    this.emit("change");
    try {
      if (!instant) {
        await this._progress(id, "load", model.failsToLoad ? FAIL_AT : 1);
        if (model.failsToLoad) {
          throw new Error(`${model.name} ${model.version} did not load: not enough graphics memory.`);
        }
      }
      this.loadedModelId = id;
      this.loadSettings = settings;
    } finally {
      this.loading = null;
      this._recalc();
      this.emit("change");
    }
  }

  async unloadModel() {
    if (this.loading || !this.loadedModelId) return;
    this.stop();
    const id = this.loadedModelId;
    this.loading = { modelId: id, progress: 0, direction: "unload" };
    this.emit("change");
    try {
      await this._progress(id, "unload", 1);
    } finally {
      this.loadedModelId = null;
      this.loadSettings = null;
      this.loading = null;
      this._recalc();
      this.emit("change");
    }
  }

  // Loads the model in quick-switch slot n (1 to 4). An empty slot, or the model already loaded, does nothing.
  async swapToSlot(n) {
    const slot = slots.find((s) => s.slot === n);
    if (!slot || !slot.modelId || slot.modelId === this.loadedModelId) return;
    await this.loadModel(slot.modelId);
  }

  // Streams the canned reply word by word at the loaded model's expected speed.
  // The prompt and options are accepted for the live client's shape and otherwise ignored;
  // the prompt is only counted, for the token figures in 'done'.
  sendPrompt(input, opts = {}) {
    if (!this.loadedModelId || this.loading || this.streaming) return false;
    this._words = cannedReply.split(/\s+/).filter(Boolean);
    this._promptTokens = Math.round(countWords(input) * TOKENS_PER_WORD);
    this._index = 0;
    this._wps = this.expectedWps;
    this._start = performance.now();
    this._firstAt = null;
    this._stamps = [];
    this._smoothed = null;
    this._tokens = 0;
    this._tokenStamps = [];
    this._smoothedTokens = null;
    this.streaming = true;
    this._sampler = setInterval(() => this._sample(), SAMPLE_MS);
    this.emit("change");
    this._scheduleWord();
    return true;
  }

  // Ends the reply early. Emits 'done' with the counts so far.
  stop() {
    if (!this.streaming) return;
    this._finish("cancel");
  }

  _progress(modelId, direction, end) {
    const start = performance.now();
    return new Promise((resolve) => {
      const tick = () => {
        const progress = Math.min(end, (performance.now() - start) / LOAD_MS);
        this.loading.progress = progress;
        this.emit("progress", { modelId, progress, direction });
        if (progress >= end) resolve();
        else setTimeout(tick, SAMPLE_MS);
      };
      tick();
    });
  }

  _recalc() {
    if (!this.loadedModelId) {
      this.memory = { modelGB: 0, conversationGB: 0, otherAppsGB: OTHER_APPS_GB, sysGB: 0 };
      this.gpuUsedGB = OTHER_APPS_GB;
      this.fit = null;
      this.expectedWps = 0;
      return;
    }
    const est = memoryFor(findModel(this.loadedModelId), this.loadSettings);
    this.memory = { modelGB: est.modelGB, conversationGB: est.conversationGB, otherAppsGB: OTHER_APPS_GB, sysGB: est.sysGB };
    this.gpuUsedGB = est.gpuGB + OTHER_APPS_GB;
    this.fit = est.fit;
    this.expectedWps = est.expectedWps;
  }

  _scheduleWord() {
    const gapMs = (1000 / this._wps) * (0.85 + Math.random() * 0.3);
    this._timer = setTimeout(() => this._emitWord(), gapMs);
  }

  _emitWord() {
    const now = performance.now();
    const index = this._index;
    const word = this._words[index];
    this._index += 1;
    if (this._firstAt === null) this._firstAt = now;
    this._stamps.push(now);
    this._tokens += 1;
    this._tokenStamps.push(now);
    this.emit("text", { delta: `${word} ` });
    this.emit("word", { word, index });
    // A listener may have called stop() during emit.
    if (!this.streaming) return;
    if (this._index >= this._words.length) this._finish("stop");
    else this._scheduleWord();
  }

  _sample() {
    const now = performance.now();
    const windowS = Math.max(0.1, Math.min(WINDOW_S, (now - this._start) / 1000));
    const recentWords = this._stamps.filter((t) => t > now - WINDOW_S * 1000).length;
    const recentTokens = this._tokenStamps.filter((t) => t > now - WINDOW_S * 1000).length;
    const rawWords = recentWords / windowS;
    const rawTokens = recentTokens / windowS;
    this._smoothed = this._smoothed === null ? rawWords : this._smoothed + (rawWords - this._smoothed) * SMOOTHING;
    this._smoothedTokens = this._smoothedTokens === null ? rawTokens : this._smoothedTokens + (rawTokens - this._smoothedTokens) * SMOOTHING;
    const elapsed = (now - this._start) / 1000;
    const averageWords = (this._conversation.words + this._index) / (this._conversation.seconds + elapsed);
    const averageTokens = (this._conversation.tokens + this._tokens) / (this._conversation.seconds + elapsed);
    this.speed = {
      wordsPerSecond: this._smoothed,
      tokensPerSecond: this._smoothedTokens ?? 0,
      firstWordSeconds: this._firstAt === null ? null : (this._firstAt - this._start) / 1000,
      averageWordsPerSecond: averageWords,
      averageTokensPerSecond: averageTokens,
    };
    this.emit("speed", this.speed);
    this.emit("change");
  }

  _finish(finishReason) {
    clearTimeout(this._timer);
    clearInterval(this._sampler);
    const seconds = (performance.now() - this._start) / 1000;
    const words = this._index;
    const wordsPerSecond = seconds > 0 ? words / seconds : 0;
    const firstWordSeconds = this._firstAt === null ? null : (this._firstAt - this._start) / 1000;
    const text = this._words.slice(0, words).join(" ");
    const tokens = this._tokens;
    const completionTokens = tokens;
    const tokensPerSecond = seconds > 0 ? tokens / seconds : 0;
    this.contextTokens = this._promptTokens + completionTokens;
    this._conversation.words += words;
    this._conversation.tokens += tokens;
    this._conversation.seconds += seconds;
    const averageWordsPerSecond = this._conversation.seconds > 0
      ? this._conversation.words / this._conversation.seconds
      : null;
    const averageTokensPerSecond = this._conversation.seconds > 0
      ? this._conversation.tokens / this._conversation.seconds
      : null;
    this.streaming = false;
    this.lastReplySpeed = wordsPerSecond;
    this.lastReplyTokensPerSecond = tokensPerSecond;
    this.speed = {
      ...this.speed,
      wordsPerSecond,
      tokensPerSecond,
      firstWordSeconds,
      averageWordsPerSecond,
      averageTokensPerSecond,
    };
    this.emit("done", {
      words, seconds, wordsPerSecond, tokens, tokensPerSecond, firstWordSeconds, text, finishReason,
      promptTokens: this._promptTokens, completionTokens, failed: false,
    });
    this.emit("change");
  }
}

export const engine = new Engine();
