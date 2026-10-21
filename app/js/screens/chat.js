// Chat screen: conversation list, thread with composer, and the speed, memory and length meters.
// Live readings come from the engine.
import { engine } from "../engine.js";
import {
  conversations, chatMessages, models, GPU_NAME, GPU_TOTAL_GB, DEFAULT_CONTEXT_TOKENS,
} from "../data.js";
import { store, newId, debounced } from "../store.js";
import {
  el, module, sectionLabel, segMeter, ring, speedChart, speedScale, fmtSpeed, readout, chip, statusLight,
  button, listRow, notice, contextMenu, toast,
} from "../ui.js";
import { renderMarkdown } from "../markdown.js";
import { thinkingRoom } from "../pace.js";

const DASH = "—";
const GROUPS = engine.mode === "sim" ? ["Today", "Earlier this week"] : ["Today", "Earlier"];
const LAST_KEY = "bench.chat.last";
const SAVE_DEBOUNCE_MS = 400;
const TOKENS_PER_WORD = 1.33;   // same ratio the engine uses for tokens per second
const STICK_PX = 40;            // within this many pixels of the bottom, the thread follows the reply
const ARENA_KEY = "benchArenaQuestion";
const SETTINGS_KEY = "bench.chat.settings";
const SETTINGS_ID = "chat";
const SETTINGS_SAVE_MS = 400;
const THINKING_LEVELS = ["none", "low", "medium", "high"];
const SETTING_FIELDS = [
  { key: "temperature", label: "Temperature", min: 0, max: 2, step: 0.1 },
  { key: "topP", label: "Top-p", min: 0, max: 1, step: 0.05 },
  // Up to the largest context on this PC (262,144). The engine stops at the room left in the context anyway.
  { key: "maxTokens", label: "Max tokens to write", min: 64, max: 262144, step: 1 },
  // Above 0, words the reply already used are less likely again: a brake on repeating loops (Qwen suggests up to 1.5).
  { key: "presencePenalty", label: "Repeat penalty", min: 0, max: 2, step: 0.1 },
];
const DEFAULT_SETTINGS = { temperature: 0.7, topP: 0.9, maxTokens: 4096, thinking: "medium", presencePenalty: 0, thinkingLimit: true };
const DELETE_UNDO_MS = 6000;
// Sidebar sizes, collapsed state and pinned chats: kept in this browser.
const LAYOUT_KEY = "bench.chat.layout";
const SIDEBARS = {
  list: { min: 180, max: 420, normal: 248 },
  meters: { min: 280, max: 560, normal: 336 },
};
let chatGeneration = 0;

function loadLayout() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(LAYOUT_KEY)); } catch { saved = null; }
  const width = (side) => {
    const value = Number(saved?.[side]);
    const { min, max, normal } = SIDEBARS[side];
    return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : normal;
  };
  return {
    list: width("list"),
    meters: width("meters"),
    listCollapsed: saved?.listCollapsed === true,
    metersCollapsed: saved?.metersCollapsed === true,
    pinned: Array.isArray(saved?.pinned) ? saved.pinned.filter((id) => typeof id === "string") : [],
  };
}
const layout = loadLayout();
function saveLayout() {
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch { /* full or blocked: sizes reset next time */ }
}

// Keep the value inside the field's range, rounded to the field's step. null when unusable.
function clampSetting(value, { min, max, step }) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const decimals = String(step).split(".")[1]?.length ?? 0;
  return Number(Math.min(max, Math.max(min, number)).toFixed(decimals));
}

function applySettings(saved) {
  const settings = { ...DEFAULT_SETTINGS };
  for (const field of SETTING_FIELDS) {
    const value = clampSetting(saved?.[field.key], field);
    if (value !== null) settings[field.key] = value;
  }
  if (THINKING_LEVELS.includes(saved?.thinking)) settings.thinking = saved.thinking;
  if (typeof saved?.thinkingLimit === "boolean") settings.thinkingLimit = saved.thinkingLimit;
  return settings;
}

function loadSettings() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(SETTINGS_KEY));
  } catch {
    saved = null;
  }
  return applySettings(saved);
}

// Live mode keeps settings in the store (settings/chat); localStorage is the fallback.
function saveSettingsToStore() {
  if (engine.mode === "sim") return;
  return store.put("settings", SETTINGS_ID, { ...session.settings }).catch(() => {});
}
const scheduleSettingsSave = debounced(saveSettingsToStore, SETTINGS_SAVE_MS);

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(session.settings));
  if (engine.mode !== "sim") scheduleSettingsSave();
}

async function loadSettingsFromStore() {
  if (engine.mode === "sim") return;
  try {
    const rec = await store.get("settings", SETTINGS_ID);
    if (rec) {
      session.settings = applySettings(rec);
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(session.settings));
    }
  } catch {
    // Store unavailable: keep the settings already read from localStorage.
  }
}

// Kept outside render() so conversations survive a switch to another tab.
const session = {
  conversations: conversations.map((c) => ({
    ...c,
    messages: c.id === "c1" ? chatMessages.map((m) => ({ ...m })) : [],
  })),
  activeId: "c1",
  nextId: 1,
  draft: "",
  settings: loadSettings(),
  reply: null,   // { conv, msg } while a reply streams
  peak: null,    // highest tokens per second since the last Send
  speedHistory: [], // samples for the 60-second graph, kept across tab switches
  meterTop: 0,   // fastest speed seen with this model: the meter's scale grows to fit it
  meterModel: null,
  stick: true,   // follow the newest text in the thread
  loaded: false, // live mode: saved chats have been read from the store
  sideIds: [],   // chats open in side panels beside the main one
};

if (engine.mode !== "sim") {
  session.conversations = [];
  session.activeId = null;
}

// Saved chats group into Today / Earlier by their last update.
function groupFor(ms) {
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? "Today" : "Earlier";
}

function timeLabel(ms) {
  const d = new Date(ms);
  if (d.toDateString() === new Date().toDateString()) {
    return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// A stored message back into the shape the thread renders.
function toMessage(m) {
  return {
    role: m.role === "user" ? "user" : "model",
    text: m.text ?? "",
    model: m.model ?? "",
    thinking: m.thinking ?? "",
    stats: m.stats ?? null,
    pending: false,
  };
}

// The thread's conversation into the record the store keeps.
function chatRecord(conv) {
  const now = Date.now();
  return {
    id: conv.id,
    title: conv.title,
    model: conv.model ?? null,
    system: conv.system ?? "",
    avgResetAt: conv.avgResetAt ?? null,
    created: conv.created ?? now,
    updated: now,
    messages: (conv.messages ?? []).map((m) => {
      const out = { role: m.role, text: m.text };
      if (m.role === "model" && m.model) out.model = m.model;
      if (m.thinking) out.thinking = m.thinking;
      if (m.stats) out.stats = m.stats;
      return out;
    }),
  };
}

function makeConversation() {
  const now = Date.now();
  const id = engine.mode === "sim" ? `new-${session.nextId++}` : newId();
  return {
    id,
    title: "New conversation",
    model: null,
    time: "now",
    group: "Today",
    created: now,
    updated: now,
    system: "",
    messages: [],
  };
}

function modelById(id) {
  return models.find((m) => m.id === id) ?? null;
}

function loadedModel() {
  // A live engine may hold a model the demo catalogue has never heard of.
  return modelById(engine.loadedModelId) ?? engine.loadedModel;
}

function activeConv() {
  return session.conversations.find((c) => c.id === session.activeId);
}

function wordCount(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

function wordsLabel(n) {
  return `${n} ${n === 1 ? "word" : "words"}`;
}

function threadWords(conv) {
  return (conv.messages ?? []).reduce((sum, m) => sum + wordCount(m.text), 0);
}

function lastUserText(conv) {
  const messages = conv.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "user") return messages[i].text;
  }
  return "";
}

// A new conversation is named after the start of its first message: 40 characters, trimmed, no trailing punctuation.
function titleFromText(text) {
  return text.trim().slice(0, 40).replace(/[.,;:!?]+$/, "").trim();
}

// Finished messages, in order, as the engine wants them. Takes the message list.
function historyMessages(messages) {
  return messages
    .filter((m) => m.text.trim() !== "")
    .map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: m.text }));
}

// Numbers live in session.settings (saved in localStorage); these are the header chip labels.
function settingChips() {
  const s = session.settings;
  return [
    `temp ${s.temperature}`,
    `top-p ${s.topP}`,
    `max ${s.maxTokens}`,
    `thinking ${s.thinking}`,
    ...(s.presencePenalty > 0 ? [`repeat ${s.presencePenalty}`] : []),
  ];
}

function requestSettings() {
  const { temperature, topP, maxTokens, thinking, presencePenalty, thinkingLimit } = session.settings;
  // The thinking limit is the level's own thinking room (Medium 4,000 tokens), the same share Tests and Arena give it.
  const thinkingBudget = thinkingLimit ? thinkingRoom(thinking) : 0;
  return { system: activeConv()?.system ?? "", temperature, topP, maxTokens, thinking, thinkingBudget, presencePenalty };
}

// Static icon markup only. Never pass user text here.
function icon(markup) {
  const node = el("span", "chat-icon");
  node.setAttribute("aria-hidden", "true");
  node.innerHTML = markup;
  return node;
}

// This chat's average speed: its replies' tokens over their first-to-last-token time, counted from
// the last reset. Kept with the chat, so it is there again when you come back to it.
function chatAverage(conv) {
  let tokens = 0;
  let seconds = 0;
  for (const m of conv?.messages ?? []) {
    const st = m.role === "model" ? m.stats : null;
    // Older saved replies have no first-to-last time; their whole time stands in.
    const span = st?.speedSeconds > 0 ? st.speedSeconds : st?.seconds;
    if (!st || !(st.tokens > 0) || !(span > 0)) continue;
    if (conv.avgResetAt && !(st.at > conv.avgResetAt)) continue;
    tokens += st.tokens;
    seconds += span;
  }
  return seconds > 0 ? tokens / seconds : null;
}

// Label and value cell in the speed stats row.
function statCell(label, first) {
  const value = el("span", "stat-value", DASH);
  const cell = el("div", first ? "stat" : "stat stat-divided");
  cell.append(el("span", "stat-label", label), value);
  return { cell, value };
}

// Swatch, label and GB value for the graphics memory legend.
function legendRow(label, swatch) {
  const value = el("span", "mem-value", DASH);
  const node = el("div", "mem-row");
  node.append(el("span", `mem-swatch ${swatch}`), el("span", "mem-label", label), value);
  return { node, value };
}

// Header line with a section label on the left and a value on the right.
function meterHead(title, right) {
  const head = el("div", "meter-head");
  head.append(sectionLabel(title), right);
  return head;
}

function userBlock(msg, actions) {
  const block = el("div", "chat-msg-user", msg.text);
  if (actions) block.append(actions);
  return block;
}

function statsLine(stats) {
  const exact = stats.tokens !== undefined && stats.tokens !== null;
  const tokens = exact ? stats.tokens : Math.round(stats.words * TOKENS_PER_WORD);
  const tps = exact ? stats.tokensPerSecond : stats.wordsPerSecond * TOKENS_PER_WORD;
  const mark = exact ? "" : "~";
  // The speed is measured from the first token to the last (the same window the engine reports its own
  // decode speed over), so the prompt read and the wait for the first token are not mixed into it. Both
  // of those are their own figures. Thinking tokens count as generated tokens, as the engine counts them.
  const spanned = typeof stats.speedSeconds === "number" && stats.speedSeconds > 0
    ? ` · over ${stats.speedSeconds.toFixed(1)} s` : "";
  const first = typeof stats.firstTokenSeconds === "number"
    ? ` · first token ${stats.firstTokenSeconds.toFixed(1)} s` : "";
  return `${mark}${tokens} tokens · ${mark}${tps.toFixed(1)} tok/s${spanned}${first}`;
}

function modelBody(msg) {
  const body = el("div", "chat-body");
  body.append(renderMarkdown(msg.text));
  if (msg.pending) {
    const caret = el("span", "chat-caret");
    caret.setAttribute("aria-hidden", "true");
    body.append(caret);
  }
  return body;
}

const SPLIT_ICON = '<svg width="14" height="14" viewBox="0 0 14 14"><rect x="1.5" y="2.5" width="11" height="9" rx="2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M7 2.5v9" stroke="currentColor" stroke-width="1.3"/><path d="M9 7h2M10 6v2" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>';
const CLOSE_ICON = '<svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 2 L8 8 M8 2 L2 8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
const wordCountOf = (text) => String(text ?? "").split(/\s+/).filter(Boolean).length;
const BRAIN_ICON = '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M6 2.5c-.8-1.3-3-1.3-3.7.1-1.5.1-2.1 1.9-1.1 3-1 1.1-.4 2.8 1.2 2.9.5 1.4 2.4 1.5 3.6.7 1.2.8 3.1.7 3.6-.7 1.6-.1 2.2-1.8 1.2-2.9 1-1.1.4-2.9-1.1-3-.7-1.4-2.9-1.4-3.7-.1z" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/><path d="M6 2.7v6.4" fill="none" stroke="currentColor" stroke-width="1.1"/></svg>';
const CHEVRON_ICON = '<svg width="10" height="10" viewBox="0 0 10 10"><path d="M2.5 4 L5 6.5 L7.5 4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function secondsText(seconds) {
  if (seconds < 1) return "under a second";
  if (seconds < 60) return `${Math.round(seconds)} s`;
  return `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
}

// Thinking time so far: frozen when the answer started, running while the model still thinks.
function thinkingSeconds(msg) {
  if (msg.thinkSeconds !== undefined) return msg.thinkSeconds;
  if (msg.thinkStartMs !== undefined) return (performance.now() - msg.thinkStartMs) / 1000;
  return null;
}

function replyPhase(msg) {
  if (msg.text) return "writing";
  if (msg.thinking) return "thinking";
  return "reading";
}

// The live line beside the model name: what the model is doing now, or what the reply cost.
function workStatus(msg) {
  if (!msg.pending) {
    if (!msg.stats) return null;
    return el("span", "work-phase work-done", `Worked for ${secondsText(msg.stats.seconds)}`);
  }
  const phase = replyPhase(msg);
  const line = el("span", "work-phase chat-writing");
  if (phase === "thinking") {
    const brain = icon(BRAIN_ICON);
    brain.setAttribute("aria-hidden", "true");
    line.append(brain);
  }
  const seconds = phase === "thinking" ? thinkingSeconds(msg) : null;
  const words = phase === "reading" ? "Reading your message"
    : phase === "writing" ? "Writing"
      : seconds !== null && seconds >= 1 ? `Thinking ${secondsText(seconds)}` : "Thinking";
  line.append(el("span", "work-shimmer", words));
  const dots = el("span", "work-dots");
  dots.setAttribute("aria-hidden", "true");
  for (let i = 0; i < 3; i += 1) dots.append(el("span", "work-dot"));
  line.append(dots);
  return line;
}

// The reasoning text as a toggle row: open while the model thinks, shut when the answer starts.
function thoughtRow(msg) {
  if (!msg.thinking) return null;
  const row = el("details", "thought-row");
  const chevron = icon(CHEVRON_ICON);
  chevron.classList.add("thought-chevron");
  chevron.setAttribute("aria-hidden", "true");
  const label = msg.pending && !msg.text ? "Thinking"
    : `Thought for ${secondsText(msg.stats?.thinkingSeconds ?? thinkingSeconds(msg) ?? 0)}`;
  const summary = el("summary", "thought-summary");
  summary.append(chevron, el("span", "thought-label", label));
  row.append(summary, el("div", "thought-text", msg.thinking));
  row.open = msg.thinkingOpen ?? !msg.text;
  // The click lands before the browser opens or closes the row, so the choice survives a re-render.
  summary.addEventListener("click", () => { msg.thinkingOpen = !row.open; });
  return row;
}

function modelBlock(conv, msg, actions, regenerateReply) {
  const block = el("div", "chat-msg-model");
  const label = el("div", "chat-model-label");
  const mark = el("span", "chat-model-mark");
  mark.setAttribute("aria-hidden", "true");
  label.append(mark, el("span", "", msg.model));
  const status = workStatus(msg);
  if (status) label.append(status);
  block.append(label);
  const thought = thoughtRow(msg);
  if (thought) block.append(thought);
  if (msg.error) {
    if (msg.text) {
      block.append(modelBody(msg));
      block.append(el("div", "chat-stopped-early", "(stopped early)"));
    }
    const error = el("div", "chat-error");
    error.append(el("p", "chat-error-text", msg.error));
    const retry = button({ kind: "secondary", small: true, text: "Try again", onClick: () => regenerateReply(conv, msg) });
    retry.classList.add("chat-action-retry");
    error.append(retry);
    block.append(error);
  } else {
    block.append(modelBody(msg));
    if (msg.stats) block.append(el("div", "chat-stats", statsLine(msg.stats)));
  }
  if (actions) block.append(actions);
  return block;
}

function emptyState() {
  const node = el("div", "chat-empty");
  const note = loadedModel() ? "Ask the loaded model something below." : "Load a model in Models to start.";
  node.append(el("p", "chat-empty-title", "Nothing here yet."), el("p", "chat-empty-note", note));
  return node;
}

function fmtK(tokens) {
  return `${(tokens / 1000).toFixed(1)}K`;
}

export function render(root) {
  const generation = ++chatGeneration;
  let disposed = false;
  // Conversations (left) ----------------------------------------------------
  const rows = el("div", "chat-rows");
  const newButton = button({ kind: "secondary", small: true, text: "New", onClick: newConversation });
  newButton.prepend(icon('<svg width="10" height="10" viewBox="0 0 10 10"><path d="M5 1 V9 M1 5 H9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>'));
  newButton.title = "New chat (Ctrl+Shift+O)";
  const listHead = el("div", "chat-list-head");
  listHead.append(sectionLabel("Conversations"), newButton);
  const searchInput = el("input", "chat-search");
  searchInput.type = "search";
  searchInput.placeholder = "Search chats";
  searchInput.setAttribute("aria-label", "Search chats");
  const searchBox = el("div", "chat-search-box");
  searchBox.innerHTML = '<svg class="chat-search-icon" width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.8" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10.6 10.6 14 14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
  searchBox.append(searchInput);
  let searchLoaded = false;
  searchInput.addEventListener("input", async () => {
    // Searching reads every saved chat once, so message text matches too.
    if (!searchLoaded && engine.mode !== "sim" && searchInput.value.trim()) {
      searchLoaded = true;
      await Promise.all(session.conversations.filter((c) => c.messages === null).map(loadChatMessages));
    }
    renderList();
  });
  searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && searchInput.value) { event.preventDefault(); event.stopPropagation(); searchInput.value = ""; renderList(); }
  });
  const list = module({ tag: "aside", cls: "chat-list", children: [listHead, searchBox, rows] });
  list.setAttribute("aria-label", "Conversations");
  let renaming = false;

  // Composer (bottom of the thread) -------------------------------------------
  const systemToggle = button({ kind: "ghost", small: true, onClick: toggleSystem });
  systemToggle.classList.add("chat-system-toggle");
  systemToggle.setAttribute("aria-expanded", "false");
  const systemText = el("textarea", "chat-system-text");
  systemText.rows = 3;
  systemText.value = activeConv()?.system ?? "";
  systemText.setAttribute("aria-label", "System prompt");
  const systemPanel = el("div", "chat-system");
  systemPanel.hidden = true;
  systemPanel.append(el("span", "chat-system-note", `Saved for this session.${engine.mode === "sim" ? " The simulated engine does not read it yet." : ""}`), systemText);

  const settingsToggle = button({ kind: "ghost", small: true, text: "Settings", onClick: toggleSettings });
  settingsToggle.classList.add("chat-settings-toggle");
  settingsToggle.setAttribute("aria-expanded", "false");
  const settingsPanel = el("div", "chat-settings");
  settingsPanel.hidden = true;
  const settingInputs = {};
  for (const field of SETTING_FIELDS) {
    const fieldInput = el("input", "chat-setting-input");
    fieldInput.type = "number";
    fieldInput.inputMode = "decimal";
    // Up and down arrows (Shift for ten steps) and the mouse wheel, while the box is focused.
    fieldInput.addEventListener("wheel", (event) => {
      if (document.activeElement !== fieldInput) return;
      event.preventDefault();
      const next = clampSetting(Number(fieldInput.value) + (event.deltaY < 0 ? 1 : -1) * field.step * (event.shiftKey ? 10 : 1), field);
      if (next !== null) { fieldInput.value = next; setSetting(field, fieldInput); }
    }, { passive: false });
    fieldInput.min = field.min;
    fieldInput.max = field.max;
    fieldInput.step = field.step;
    fieldInput.value = session.settings[field.key];
    fieldInput.setAttribute("aria-label", field.label);
    fieldInput.addEventListener("change", () => setSetting(field, fieldInput));
    settingInputs[field.key] = fieldInput;
    const fieldRow = el("label", "chat-setting");
    fieldRow.append(el("span", "chat-setting-label", field.label), fieldInput);
    settingsPanel.append(fieldRow);
  }
  const thinkingSelect = el("select", "chat-setting-select");
  for (const level of THINKING_LEVELS) {
    const option = el("option", "", level);
    option.value = level;
    thinkingSelect.append(option);
  }
  thinkingSelect.value = session.settings.thinking;
  thinkingSelect.setAttribute("aria-label", "Thinking");
  thinkingSelect.addEventListener("change", () => {
    session.settings.thinking = THINKING_LEVELS.includes(thinkingSelect.value) ? thinkingSelect.value : "none";
    thinkingSelect.value = session.settings.thinking;
    saveSettings();
    renderChips();
  });
  const thinkingRow = el("label", "chat-setting");
  thinkingRow.append(el("span", "chat-setting-label", "Thinking"), thinkingSelect);
  const limitBox = el("input", "chat-setting-check");
  limitBox.type = "checkbox";
  limitBox.checked = session.settings.thinkingLimit;
  limitBox.setAttribute("aria-label", "Limit thinking");
  limitBox.addEventListener("change", () => { session.settings.thinkingLimit = limitBox.checked; saveSettings(); });
  const limitRow = el("label", "chat-setting");
  limitRow.append(el("span", "chat-setting-label", "Limit thinking"), limitBox);
  settingsPanel.append(thinkingRow, limitRow, el("p", "chat-setting-note",
    "Thinking costs speed. Pick none for the fastest answers. Limit thinking stops a thinking loop: the model has to answer after 2,000 (low), 4,000 (medium) or 8,000 (high) thinking tokens."));

  const hint = el("p", "chat-hint");
  const input = el("textarea", "chat-input");
  input.rows = 2;
  input.placeholder = "Ask the loaded model something";
  input.setAttribute("aria-label", "Message");
  input.value = session.draft;
  const count = el("span", "chat-count");
  const stop = button({ kind: "secondary", text: "Stop", onClick: () => engine.stop() });
  stop.classList.add("chat-stop");
  stop.prepend(icon('<svg width="8" height="8" viewBox="0 0 8 8"><rect width="8" height="8" rx="2" fill="currentColor"/></svg>'));
  const send = button({ kind: "primary", text: "Send", onClick: sendDraft });
  send.append(icon('<svg width="12" height="12" viewBox="0 0 12 12"><path d="M6 10 V2 M2.5 5.5 L6 2 L9.5 5.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'));
  const bar = el("div", "chat-composer-bar");
  bar.append(settingsToggle, systemToggle, count, stop, send);
  const composer = el("div", "chat-composer");
  composer.append(settingsPanel, systemPanel, hint, input, bar);
  const banner = el("div", "chat-engine-banner");
  banner.hidden = true;
  const bannerRetry = button({ kind: "secondary", small: true, text: "Retry", onClick: () => engine.refresh() });
  banner.append(el("p", "chat-engine-banner-text", "No model is answering. Check that the model is running, then press Retry."), bannerRetry);
  const composerWrap = el("div", "chat-composer-wrap");
  composerWrap.append(banner, composer);

  // Thread (centre) -----------------------------------------------------------
  const title = el("h1", "chat-title");
  const chips = el("div", "chat-chips");
  const splitButton = button({ kind: "ghost", small: true, onClick: openSideChat });
  splitButton.classList.add("chat-split");
  splitButton.setAttribute("aria-label", "Open a side chat");
  splitButton.append(icon(SPLIT_ICON));
  const head = el("div", "chat-thread-head");
  head.append(title, chips, splitButton);
  const scroller = el("div", "chat-scroll");
  const messages = el("div", "chat-messages");
  scroller.append(messages);
  scroller.addEventListener("scroll", () => {
    session.stick = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < STICK_PX;
  });
  const thread = module({ tag: "section", cls: "chat-thread", children: [head, scroller, composerWrap] });
  thread.setAttribute("aria-label", "Thread");

  // Speed (right, top) --------------------------------------------------------
  const liveLight = statusLight("idle");
  const liveTag = el("span", "live-tag");
  liveTag.append(liveLight, el("span", "", "Live"));
  const hero = readout({ size: "hero", unit: "tok/s", decimals: 1 });
  const peakValue = el("span", "peak-value", DASH);
  const peakBox = el("div", "peak");
  peakBox.append(el("span", "peak-label", "Peak"), peakValue);
  const heroRow = el("div", "hero-row");
  heroRow.append(hero, peakBox);
  const startScale = speedScale(0, 60);
  const speedMeter = segMeter({ min: 0, max: startScale.max, peakHold: true, ticks: startScale.ticks.map(fmtSpeed) });
  const trend = speedChart({ seconds: 60, unit: "tok/s", floor: 60, history: session.speedHistory });
  const trendBox = el("div", "trend");
  trendBox.append(el("div", "trend-head", ""), trend);
  trendBox.firstChild.append(el("span", "trend-label", "Last 60 s"), el("span", "trend-hint", "Hover to read"));
  const firstStat = statCell("First word", true);
  const avgStat = statCell("Chat avg", false);
  // A small circular-arrow button: start this chat's average again from the next reply.
  const avgReset = el("button", "stat-reset");
  avgReset.type = "button";
  avgReset.title = "Reset this chat's average";
  avgReset.setAttribute("aria-label", "Reset this chat's average");
  avgReset.innerHTML = '<svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M12.5 1.5v3.2H9.3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  avgReset.addEventListener("click", () => {
    const conv = activeConv();
    if (!conv) return;
    conv.avgResetAt = Date.now();
    if (engine.mode !== "sim") saveActiveChat();
    refresh();
  });
  avgStat.cell.querySelector(".stat-label").append(avgReset);
  const wordsStat = statCell("Words/s", false);
  const stats = el("div", "speed-stats");
  stats.append(firstStat.cell, avgStat.cell, wordsStat.cell);
  const speedModule = module({
    tag: "section", cls: "meter-module",
    children: [meterHead("Speed", liveTag), heroRow, speedMeter, trendBox, stats],
  });

  // Graphics memory (right, middle) -------------------------------------------
  const gauge = ring({ total: GPU_TOTAL_GB });
  const legend = {
    model: legendRow("Model", "model"),
    conversation: legendRow("Conversation", "conversation"),
    other: legendRow("Other apps", "other"),
    free: legendRow("Free", "free"),
  };
  const legendBox = el("div", "mem-legend");
  legendBox.append(legend.model.node, legend.conversation.node, legend.other.node, legend.free.node);
  const body = el("div", "mem-body");
  body.append(gauge, legendBox);
  const memStatus = el("div", "mem-status");
  const gpuName = el("span", "meter-note", engine.mode === "sim" ? GPU_NAME : (engine.gpuName ?? DASH));
  const memModule = module({
    tag: "section", cls: "meter-module",
    children: [meterHead("Graphics memory", gpuName), body, memStatus],
  });

  // Context limit (right, bottom) --------------------------------------
  const lengthValue = el("span", "meter-note", DASH);
  const lengthMeter = segMeter({ min: 0, max: 100, variant: "thin", color: "var(--color-compare)" });
  const lengthModule = module({
    tag: "section", cls: "meter-module length-module",
    children: [meterHead("Context limit", lengthValue), lengthMeter],
  });

  const meters = el("aside", "meters");
  meters.setAttribute("aria-label", "Live meters");
  meters.append(speedModule, memModule, lengthModule);

  const cols = el("div", "chat-cols chat-screen");
  const listHandle = sideHandle("list", "Conversations");
  const metersHandle = sideHandle("meters", "Live meters");
  // The main thread and any side chats share the middle column.
  const threadArea = el("div", "chat-thread-area");
  threadArea.append(thread);
  cols.append(list, listHandle, threadArea, metersHandle, meters);
  root.append(cols);
  applyLayout();

  // Sidebar edges: drag to resize, double-click for the normal size, click the small button
  // to fold the sidebar away. Arrow keys resize when the edge has keyboard focus.
  function sideHandle(side, name) {
    const handle = el("div", `side-handle side-handle-${side}`);
    handle.tabIndex = 0;
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-orientation", "vertical");
    handle.setAttribute("aria-label", `Resize ${name}`);
    handle.title = "Drag to resize. Double-click for the normal size.";
    const fold = el("button", "side-fold");
    fold.type = "button";
    handle.append(fold);
    fold.addEventListener("pointerdown", (event) => event.stopPropagation());
    fold.addEventListener("click", () => {
      layout[`${side}Collapsed`] = !layout[`${side}Collapsed`];
      saveLayout();
      applyLayout();
      trend.redraw();
    });
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || layout[`${side}Collapsed`]) return;
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      const startX = event.clientX;
      const startW = layout[side];
      cols.classList.add("is-resizing");
      const move = (e) => {
        const delta = side === "list" ? e.clientX - startX : startX - e.clientX;
        setWidth(side, startW + delta);
      };
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        cols.classList.remove("is-resizing");
        saveLayout();
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    });
    handle.addEventListener("dblclick", (event) => {
      if (event.target === fold) return;
      layout[`${side}Collapsed`] = false;
      setWidth(side, SIDEBARS[side].normal);
      saveLayout();
    });
    handle.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const grow = (event.key === "ArrowRight") === (side === "list");
      setWidth(side, layout[side] + (grow ? 16 : -16));
      saveLayout();
    });
    return handle;
  }

  function setWidth(side, width) {
    const { min, max } = SIDEBARS[side];
    layout[side] = Math.round(Math.min(max, Math.max(min, width)));
    applyLayout();
  }

  function applyLayout() {
    cols.style.setProperty("--chat-list-w", `${layout.list}px`);
    cols.style.setProperty("--chat-meters-w", `${layout.meters}px`);
    cols.classList.toggle("list-collapsed", layout.listCollapsed);
    cols.classList.toggle("meters-collapsed", layout.metersCollapsed);
    for (const [handle, side, name] of [[listHandle, "list", "conversations"], [metersHandle, "meters", "live meters"]]) {
      const collapsed = layout[`${side}Collapsed`];
      const fold = handle.querySelector(".side-fold");
      fold.setAttribute("aria-label", collapsed ? `Show ${name}` : `Hide ${name}`);
      fold.title = collapsed ? `Show ${name}` : `Hide ${name}`;
      fold.setAttribute("aria-expanded", String(!collapsed));
      handle.setAttribute("aria-valuenow", String(layout[side]));
      handle.setAttribute("aria-valuemin", String(SIDEBARS[side].min));
      handle.setAttribute("aria-valuemax", String(SIDEBARS[side].max));
    }
    list.inert = layout.listCollapsed;
    meters.inert = layout.metersCollapsed;
  }

  // Behaviour -------------------------------------------------------------------

  function canSend() {
    return (engine.mode === "sim" || session.loaded) && Boolean(loadedModel()) && activeConv()?.messages !== null && !engine.loading && !engine.streaming && input.value.trim() !== "";
  }

  function updateDraft() {
    count.textContent = wordsLabel(wordCount(input.value));
    send.disabled = !canSend();
  }

  function updateSystemLabel() {
    systemToggle.textContent = `System prompt: ${activeConv()?.system?.trim() ? "Custom" : "Default"}`;
  }

  function toggleSystem() {
    const open = systemPanel.hidden;
    systemPanel.hidden = !open;
    systemToggle.setAttribute("aria-expanded", String(open));
    if (open) systemText.focus();
  }

  function renderChips() {
    chips.replaceChildren(...settingChips().map((text) => chip({ text, small: true })));
  }

  function setSetting(field, fieldInput) {
    const value = clampSetting(fieldInput.value, field);
    session.settings[field.key] = value ?? DEFAULT_SETTINGS[field.key];
    fieldInput.value = session.settings[field.key];
    saveSettings();
    renderChips();
  }

  function toggleSettings() {
    const open = settingsPanel.hidden;
    settingsPanel.hidden = !open;
    settingsToggle.setAttribute("aria-expanded", String(open));
    if (open) settingInputs.temperature.focus();
  }

  function refresh() {
    const model = loadedModel();
    const streaming = engine.streaming;
    const loading = engine.loading;

    // Speed: live while streaming, the last reply's speed when idle, a dash with no model.
    const tps = model ? (streaming ? engine.speed.tokensPerSecond : engine.lastReplyTokensPerSecond) : null;
    const wps = model ? (streaming ? engine.speed.wordsPerSecond : engine.lastReplySpeed) : null;
    liveLight.set(streaming ? "ok" : "idle");
    liveTag.classList.toggle("is-live", streaming);
    liveTag.lastChild.textContent = streaming ? "Live" : "Idle";
    speedModule.classList.toggle("is-idle", !streaming);
    hero.title = streaming ? "Speed right now" : "Speed of the last reply";
    hero.classList.toggle("is-empty", tps === null || tps === undefined);
    hero.set(tps ?? DASH);
    if (streaming) {
      session.peak = Math.max(session.peak ?? 0, tps);
      // The graph takes the fastest moment since its last sample, so its peak matches this one.
      session.sampleTop = Math.max(session.sampleTop ?? 0, tps ?? 0);
    }
    // The meter's full scale grows to fit the fastest speed this model has shown, so a fast
    // model never pins it at the end. A new model starts again from the base scale.
    const modelId = model?.id ?? null;
    if (session.meterModel !== modelId) { session.meterModel = modelId; session.meterTop = 0; }
    session.meterTop = Math.max(session.meterTop, tps ?? 0, session.peak ?? 0);
    const meterScale = speedScale(session.meterTop, 60);
    speedMeter.setMax(meterScale.max, meterScale.ticks.map(fmtSpeed));
    speedMeter.set(tps ?? 0);
    peakValue.textContent = session.peak === null ? DASH : session.peak.toFixed(1);
    wordsStat.value.textContent = wps === null ? DASH : wps.toFixed(1);
    firstStat.value.textContent = tps === null || engine.speed.firstWordSeconds === null
      ? DASH
      : `${engine.speed.firstWordSeconds.toFixed(2)} s`;
    const chatAvg = chatAverage(activeConv());
    avgStat.value.textContent = chatAvg === null ? DASH : chatAvg.toFixed(1);

    // Graphics memory
    const mem = engine.memory;
    const total = engine.mode === "sim" ? GPU_TOTAL_GB : engine.gpuTotalGB;
    gpuName.textContent = engine.mode === "sim" ? GPU_NAME : (engine.gpuName ?? DASH);
    gauge.setTotal(total);
    const free = Math.max(0, total - engine.gpuUsedGB);
    gauge.set([
      { value: mem.modelGB, color: "var(--color-accent)" },
      { value: mem.conversationGB, color: "var(--color-compare)" },
      { value: mem.otherAppsGB, color: "var(--color-neutral-series)" },
      { value: free, color: "var(--color-meter-track)", free: true },
    ]);
    legend.model.value.textContent = mem.modelGB.toFixed(1);
    legend.conversation.value.textContent = mem.conversationGB.toFixed(1);
    legend.other.value.textContent = mem.otherAppsGB.toFixed(1);
    legend.free.value.textContent = free.toFixed(1);
    let status;
    if (!model) {
      status = el("p", "chat-plain", "No model on the card.");
    } else if (engine.kind === "strata") {
      // Strata swaps part of the model between card and system memory on purpose: no spill claim.
      status = notice({
        kind: "info",
        text: "Strata keeps part of the model in system memory on purpose and moves it to the card as needed. Speed depends on how much of it is on the card.",
      });
    } else if (engine.kind === "llama.cpp" && engine.fit === "spills") {
      status = notice({
        kind: "warn",
        text: `Part of ${model.name} runs from system memory, so it writes at about ${Math.round(engine.expectedWps * TOKENS_PER_WORD)} tok/s.`,
      });
    } else if (engine.kind === "llama.cpp" && engine.loadSettings.layersOnCard < model.layers) {
      status = notice({
        kind: "warn",
        text: `Part of ${model.name} runs from system memory, so it writes at about ${Math.round(engine.expectedWps * TOKENS_PER_WORD)} tok/s.`,
      });
    } else if (engine.kind === "llama.cpp") {
      status = notice({ kind: "ok", text: "Fully on the card. Nothing is spilling into system memory." });
    } else {
      status = el("p", "chat-plain", "Memory could not be measured. The engine is not answering.");
    }
    memStatus.replaceChildren(status);

    // Context limit: starting context plus every word in this thread
    if (!model) {
      lengthValue.textContent = DASH;
      lengthMeter.set(0);
    } else {
      const conv = activeConv();
      const tokens = DEFAULT_CONTEXT_TOKENS + (conv ? threadWords(conv) : 0) * TOKENS_PER_WORD;
      lengthValue.textContent = `${fmtK(tokens)} / ${Math.floor(model.maxContext / 1000)}K`;
      lengthMeter.set((tokens / model.maxContext) * 100);
    }

    // Composer: why it is disabled, if it is
    if (loading) {
      const stage = loading.stageLabel
        ? `: ${loading.stageLabel} ${Math.round(loading.progress * 100)}%`
        : "";
      hint.textContent = loading.direction === "load"
        ? `A model is loading${stage}`
        : `A model is unloading${stage}`;
    } else if (!model) {
      const link = el("a", "", "Load one in Models");
      link.href = "#/models";
      hint.replaceChildren("No model loaded. ", link);
    } else {
      hint.replaceChildren();
    }
    hint.hidden = !loading && Boolean(model);
    input.disabled = !model || Boolean(loading);
    stop.disabled = !streaming;
    banner.hidden = !(engine.mode !== "sim" && engine.reachable === false);
    updateDraft();
    updateSides();
  }

  // Sidebar: right-click a chat (or press the menu key on it) for Rename, Pin, Duplicate,
  // Send to Arena, Export and Delete. Delete waits a few seconds so it can be undone.
  let closeContext = null;
  const pendingDeletes = new Map();   // id -> { conv, index, timer }

  function closeMenu() {
    closeContext?.();
    closeContext = null;
  }

  function chatMarkdown(conv) {
    const lines = [`# ${conv.title || "Untitled chat"}`, ""];
    for (const m of conv.messages ?? []) {
      if (m.role === "user") lines.push(`**You:** ${m.text}`, "");
      else lines.push(`**${m.model || "Model"}:** ${m.text}`, "");
    }
    return lines.join("\n");
  }

  async function ensureMessages(conv) {
    if (engine.mode !== "sim" && conv.messages === null) await loadChatMessages(conv);
    return conv.messages !== null;
  }

  async function exportChat(conv) {
    closeMenu();
    if (!await ensureMessages(conv)) return;
    const url = URL.createObjectURL(new Blob([chatMarkdown(conv)], { type: "text/markdown" }));
    const link = el("a");
    link.href = url;
    link.download = `${(conv.title || "chat").replace(/[\\/:*?"<>|]/g, "_")}.md`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function startRename(conv) {
    closeMenu();
    const wrap = rows.querySelector(`.chat-row-wrap[data-id="${conv.id}"]`);
    if (!wrap) return;
    const row = wrap.querySelector(".list-row");
    const input = el("input", "chat-row-rename-input");
    input.type = "text";
    input.value = conv.title;
    input.setAttribute("aria-label", "Chat title");
    row.hidden = true;
    wrap.append(input);
    input.focus();
    input.select();
    renaming = true;
    const finish = async (commit) => {
      if (!input.isConnected) return;
      renaming = false;
      const value = input.value.trim();
      if (commit && value && value !== conv.title) {
        if (!await ensureMessages(conv)) { renderList(); return; }
        conv.title = value;
        saveChat(conv);
        if (conv.id === session.activeId) title.textContent = value;
      }
      renderList();
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); finish(true); }
      else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finish(false); }
    });
    input.addEventListener("blur", () => finish(true));
  }

  function togglePin(conv) {
    closeMenu();
    const pins = layout.pinned;
    const at = pins.indexOf(conv.id);
    if (at >= 0) pins.splice(at, 1); else pins.unshift(conv.id);
    saveLayout();
    renderList();
  }

  async function duplicateChat(conv) {
    closeMenu();
    if (!await ensureMessages(conv)) return;
    const copy = makeConversation();
    Object.assign(copy, {
      title: `${conv.title} (copy)`,
      model: conv.model,
      system: conv.system ?? "",
      messages: (conv.messages ?? []).map((m) => ({ ...m, pending: false })),
    });
    const index = session.conversations.indexOf(conv);
    session.conversations.splice(index + 1, 0, copy);
    await saveChat(copy);
    selectConversation(copy.id);
  }

  async function arenaFrom(conv) {
    closeMenu();
    if (!await ensureMessages(conv)) return;
    const question = lastUserText(conv);
    if (!question) { toast({ text: "This chat has no question to send yet." }); return; }
    sessionStorage.setItem(ARENA_KEY, question);
    location.hash = "#/arena";
  }

  function deleteChat(conv) {
    closeMenu();
    const index = session.conversations.findIndex((c) => c.id === conv.id);
    if (index < 0) return;
    const wasActive = session.activeId === conv.id;
    if (wasActive && session.reply?.conv === conv) engine.stop();
    if (sidePanes.has(conv.id)) dropSide(conv.id);
    session.conversations.splice(index, 1);
    const timer = setTimeout(() => commitDelete(conv.id), DELETE_UNDO_MS);
    pendingDeletes.set(conv.id, { conv, index, timer, wasActive });
    toast({
      text: `Deleted "${conv.title}"`,
      action: "Undo",
      ms: DELETE_UNDO_MS,
      onAction: () => undoDelete(conv.id),
    });
    if (!wasActive) { renderList(); return; }
    const next = session.conversations[index] ?? session.conversations[index - 1] ?? null;
    if (next) { selectConversation(next.id); return; }
    const fresh = makeConversation();
    session.conversations.push(fresh);
    selectConversation(fresh.id);
  }

  async function commitDelete(id) {
    const pending = pendingDeletes.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingDeletes.delete(id);
    pendingSaves.delete(pending.conv);
    const pinAt = layout.pinned.indexOf(id);
    if (pinAt >= 0) { layout.pinned.splice(pinAt, 1); saveLayout(); }
    if (engine.mode !== "sim") {
      try { await store.remove("chats", id); } catch { showSaveError(); }
    }
  }

  function undoDelete(id) {
    const pending = pendingDeletes.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingDeletes.delete(id);
    // Drop an untouched empty chat made to stand in for the deleted one.
    const blank = activeConv();
    if (blank && blank.title === "New conversation" && (blank.messages?.length ?? 0) === 0 && pending.wasActive) {
      session.conversations.splice(session.conversations.indexOf(blank), 1);
    }
    session.conversations.splice(Math.min(pending.index, session.conversations.length), 0, pending.conv);
    selectConversation(pending.conv.id);
  }

  function openRowMenu(conv, x, y) {
    const pinned = layout.pinned.includes(conv.id);
    closeContext = contextMenu({
      x, y,
      label: `Chat: ${conv.title}`,
      items: [
        { label: "Rename", hint: "F2", onSelect: () => startRename(conv) },
        { label: pinned ? "Unpin" : "Pin to top", onSelect: () => togglePin(conv) },
        { label: "Duplicate", onSelect: () => duplicateChat(conv) },
        "-",
        { label: "Send to Arena", onSelect: () => arenaFrom(conv), disabled: conv.messages !== null && lastUserText(conv) === "" },
        { label: "Export as Markdown", onSelect: () => exportChat(conv) },
        "-",
        { label: "Delete", hint: "Del", danger: true, onSelect: () => deleteChat(conv) },
      ],
      onClose: () => {
        rows.querySelector(".chat-row-wrap.menu-open")?.classList.remove("menu-open");
      },
    });
    rows.querySelector(`.chat-row-wrap[data-id="${conv.id}"]`)?.classList.add("menu-open");
  }

  function rowFor(conv) {
    const wrap = el("div", "chat-row-wrap");
    wrap.dataset.id = conv.id;
    const row = listRow({
      title: conv.title,
      sub: conv.model ?? DASH,
      meta: conv.time,
      selected: conv.id === session.activeId,
      onClick: () => (sidePanes.has(conv.id) ? sidePanes.get(conv.id).input.focus() : selectConversation(conv.id)),
    });
    row.setAttribute("aria-haspopup", "menu");
    row.title = "Right-click for more";
    if (layout.pinned.includes(conv.id)) {
      const pin = el("span", "chat-row-pin");
      pin.setAttribute("aria-label", "Pinned");
      pin.innerHTML = '<svg width="10" height="10" viewBox="0 0 16 16" aria-hidden="true"><path d="M10.5 1.5 14.5 5.5 11 7.5 8.5 11 5 7.5 8.5 5Z M6.6 9.4 2 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg>';
      row.querySelector(".list-row-top").append(pin);
    }
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      // A keyboard-opened menu (menu key, Shift+F10) has no pointer position: use the row's.
      const box = row.getBoundingClientRect();
      const fromKeys = event.clientX === 0 && event.clientY === 0;
      openRowMenu(conv, fromKeys ? box.left + 24 : event.clientX, fromKeys ? box.bottom - 4 : event.clientY);
    });
    row.addEventListener("keydown", (event) => {
      if (event.key === "F2") { event.preventDefault(); startRename(conv); }
      else if (event.key === "Delete") { event.preventDefault(); deleteChat(conv); }
    });
    row.addEventListener("dblclick", () => startRename(conv));
    wrap.append(row);
    return wrap;
  }

  function matchesSearch(conv, query) {
    if (!query) return true;
    if (conv.title.toLowerCase().includes(query)) return true;
    return (conv.messages ?? []).some((m) => m.text.toLowerCase().includes(query));
  }

  function renderList() {
    if (renaming) return;
    closeMenu();
    rows.replaceChildren();
    const query = searchInput.value.trim().toLowerCase();
    const shown = session.conversations.filter((c) => matchesSearch(c, query));
    const pinnedIds = layout.pinned;
    const pinned = pinnedIds.map((id) => shown.find((c) => c.id === id)).filter(Boolean);
    const groups = [["Pinned", pinned]];
    for (const group of GROUPS) groups.push([group, shown.filter((c) => c.group === group && !pinnedIds.includes(c.id))]);
    for (const [name, inGroup] of groups) {
      if (inGroup.length === 0) continue;
      rows.append(el("div", "chat-group", name));
      const block = el("div", "chat-group-rows");
      for (const conv of inGroup) block.append(rowFor(conv));
      rows.append(block);
    }
    if (shown.length === 0) {
      rows.append(el("p", "chat-list-empty", query ? "No chats match." : "No chats yet."));
    }
  }

  function renderThread() {
    const conv = activeConv();
    title.textContent = conv?.title ?? "New conversation";
    messages.replaceChildren();
    const msgs = conv?.messages ?? [];
    if (msgs.length === 0) messages.append(emptyState());
    for (const msg of msgs) {
      const actions = actionsRow(conv, msg);
      messages.append(msg.role === "user" ? userBlock(msg, actions) : modelBlock(conv, msg, actions, regenerateReply));
    }
    wireCodeCopy(messages);
    if (session.stick) scroller.scrollTop = scroller.scrollHeight;
  }

  function renderAll() {
    if (document.activeElement !== systemText) systemText.value = activeConv()?.system ?? "";
    updateSystemLabel();
    renderList();
    renderThread();
    refresh();
  }

  // Saved chats (live mode) ---------------------------------------------------
  const saveNotice = notice({ kind: "warn", text: "Could not save. Your work is still on screen." });
  saveNotice.hidden = true;
  composerWrap.prepend(saveNotice);
  let saveErrorTimer = 0;
  const pendingSaves = new Set();
  const scheduleSave = debounced(() => {
    for (const conv of pendingSaves) saveChat(conv);
    pendingSaves.clear();
  }, SAVE_DEBOUNCE_MS);
  function queueSave(conv) { pendingSaves.add(conv); scheduleSave(); }

  function showSaveError() {
    saveNotice.hidden = false;
    clearTimeout(saveErrorTimer);
    saveErrorTimer = setTimeout(() => { saveNotice.hidden = true; }, 4000);
  }

  async function saveChat(conv) {
    if (engine.mode === "sim" || !conv || conv.messages === null) return;
    try {
      const res = await store.put("chats", conv.id, chatRecord(conv));
      conv.updated = res?.updated ? res.updated * 1000 : Date.now();
      conv.group = groupFor(conv.updated);
      conv.time = timeLabel(conv.updated);
      saveNotice.hidden = true;
    } catch {
      showSaveError();
    }
  }

  function saveActiveChat() {
    return saveChat(activeConv());
  }

  async function loadChatMessages(conv) {
    try {
      const rec = await store.get("chats", conv.id);
      if (!rec || !Array.isArray(rec.messages)) throw new Error("Unreadable saved chat");
      conv.title = rec.title ?? conv.title;
      conv.model = rec.model ?? null;
      conv.system = rec.system ?? "";
      conv.avgResetAt = rec.avgResetAt ?? null;
      conv.created = rec.created ?? conv.created;
      conv.updated = rec.updated ?? conv.updated;
      conv.group = groupFor(conv.updated);
      conv.time = timeLabel(conv.updated);
      conv.messages = (rec.messages ?? []).map(toMessage);
    } catch {
      showSaveError();
    }
  }

  async function loadChats() {
    let items = [];
    try {
      items = await store.list("chats");
    } catch {
      showSaveError();
    }
    if (disposed || generation !== chatGeneration) return;
    session.conversations = items.map((item) => ({
      id: item.id,
      title: item.title ?? "Untitled chat",
      model: null,
      time: timeLabel(item.updated * 1000),
      group: groupFor(item.updated * 1000),
      created: item.updated * 1000,
      updated: item.updated * 1000,
      system: "",
      messages: null,
    }));
    const last = localStorage.getItem(LAST_KEY);
    const active = session.conversations.find((c) => c.id === last) ?? session.conversations[0] ?? null;
    if (!active) {
      const conv = makeConversation();
      session.conversations.push(conv);
      session.activeId = conv.id;
      localStorage.setItem(LAST_KEY, conv.id);
      return;
    }
    session.activeId = active.id;
    localStorage.setItem(LAST_KEY, active.id);
    await loadChatMessages(active);
  }

  function selectConversation(id) {
    session.activeId = id;
    session.stick = true;
    const conv = activeConv();
    if (conv) {
      systemText.value = conv.system ?? "";
      updateSystemLabel();
    }
    if (engine.mode !== "sim") localStorage.setItem(LAST_KEY, id);
    if (engine.mode !== "sim" && conv && conv.messages === null) {
      renderAll();
      loadChatMessages(conv).then(() => {
        if (disposed) return;
        if (activeConv() === conv) { systemText.value = conv.system ?? ""; updateSystemLabel(); }
        renderAll();
      });
      return;
    }
    renderAll();
  }

  function newConversation() {
    const conv = makeConversation();
    session.conversations.unshift(conv);
    selectConversation(conv.id);
  }

  // Message actions: copy, regenerate, delete. Shown on hover or keyboard focus.
  function actionsRow(conv, msg) {
    const row = el("div", "chat-msg-actions");
    const copy = button({ kind: "ghost", small: true, text: "Copy", onClick: () => copyMessage(copy, msg.text) });
    copy.classList.add("chat-action-copy");
    row.append(copy);
    if (msg.role === "model") {
      const regenerate = button({ kind: "ghost", small: true, text: "Regenerate", onClick: () => regenerateReply(conv, msg) });
      regenerate.classList.add("chat-action-regenerate");
      const isLastModel = conv.messages.filter((m) => m.role === "model").at(-1) === msg;
      regenerate.disabled = !isLastModel || engine.streaming || Boolean(engine.loading);
      row.append(regenerate);
    }
    const remove = button({ kind: "ghost", small: true, text: "Delete", onClick: () => deleteMessage(conv, msg) });
    remove.classList.add("chat-action-delete");
    row.append(remove);
    return row;
  }

  function copyMessage(btn, text) {
    const label = btn.textContent;
    const flash = (words) => {
      btn.textContent = words;
      setTimeout(() => { btn.textContent = label; }, 1500);
    };
    if (!navigator.clipboard) {
      flash("Could not copy");
      return;
    }
    navigator.clipboard.writeText(text).then(() => flash("Copied"), () => flash("Could not copy"));
  }

  function wireCodeCopy(container) {
    for (const btn of container.querySelectorAll(".md-copy")) {
      btn.addEventListener("click", () => {
        const code = btn.closest(".md-codeblock")?.querySelector("pre.md-code code")?.textContent ?? "";
        copyMessage(btn, code);
      });
    }
  }

  // Drop this reply and ask again with the same earlier messages.
  function regenerateReply(conv, msg) {
    const model = loadedModel();
    const index = conv.messages.indexOf(msg);
    if (!model || index < 0 || engine.streaming || engine.loading) return;
    const earlier = conv.messages.slice(0, index);
    if (!earlier.some((m) => m.role === "user")) return;
    conv.messages.splice(index, 1);
    const reply = { role: "model", model: model.name, text: "", thinking: "", pending: true, stats: null };
    conv.messages.push(reply);
    session.reply = { conv, msg: reply };
    session.peak = null;
    session.stick = true;
    if (!engine.sendPrompt(historyMessages(earlier), requestSettings())) {
      conv.messages.splice(-1, 1);
      session.reply = null;
    }
    renderAll();
  }

  function deleteMessage(conv, msg) {
    const index = conv.messages.indexOf(msg);
    if (index < 0) return;
    if (session.reply?.msg === msg) {
      engine.stop();
      session.reply = null;
    }
    conv.messages.splice(index, 1);
    if (engine.mode !== "sim") queueSave(conv);
    renderAll();
  }

  function sendDraft() {
    const text = input.value.trim();
    const model = loadedModel();
    if ((engine.mode !== "sim" && !session.loaded) || !text || !model || activeConv()?.messages === null || engine.loading || engine.streaming) return;
    let conv = activeConv();
    if (!conv) {
      conv = makeConversation();
      session.conversations.unshift(conv);
      session.activeId = conv.id;
    }
    const history = historyMessages(conv.messages);
    const reply = { role: "model", model: model.name, text: "", thinking: "", pending: true, stats: null };
    conv.messages.push({ role: "user", text }, reply);
    if (!conv.model) conv.model = model.name;
    if (conv.title === "New conversation") conv.title = titleFromText(text);
    session.reply = { conv, msg: reply };
    session.peak = null;
    session.stick = true;
    input.value = "";
    session.draft = "";
    if (!engine.sendPrompt([...history, { role: "user", content: text }], requestSettings())) {
      conv.messages.splice(-2, 2);
      session.reply = null;
      input.value = text;
      session.draft = text;
    }
    renderAll();
  }

  // Re-render the thread at most every 100 ms while a reply streams; the end renders once more.
  let streamRenderTimer = 0;
  function scheduleStreamRender() {
    if (streamRenderTimer) return;
    streamRenderTimer = setTimeout(() => {
      streamRenderTimer = 0;
      renderThread();
    }, 100);
  }
  function flushStreamRender() {
    if (streamRenderTimer) { clearTimeout(streamRenderTimer); streamRenderTimer = 0; }
  }

  // Raw answer text (newlines kept) builds the reply; the renderer turns it into markdown.
  function onText({ detail }) {
    const reply = session.reply;
    if (!reply) return;
    const msg = reply.msg;
    if (!msg.text && msg.thinkStartMs !== undefined && msg.thinkSeconds === undefined) {
      msg.thinkSeconds = (performance.now() - msg.thinkStartMs) / 1000;
      if (msg.thinkingOpen === undefined) msg.thinkingOpen = false;
    }
    msg.text += detail.delta ?? "";
    if (reply.conv === activeConv()) scheduleStreamRender();
  }

  function onWord() {
    const reply = session.reply;
    if (!reply) return;
    if (reply.conv === activeConv()) scheduleStreamRender();
  }

  // Reasoning words arrive before the answer: collect them on the reply for the Thinking block.
  function onThinking({ detail }) {
    const reply = session.reply;
    if (!reply) return;
    if (reply.msg.thinkStartMs === undefined) reply.msg.thinkStartMs = performance.now();
    reply.msg.thinking += detail.delta ?? "";
    if (reply.conv === activeConv()) scheduleStreamRender();
  }

  // Speed samples arrive every 100 ms while a reply runs, so the phase line and its timer move
  // even when no new words have arrived (reading the prompt, or a pause between thinking words).
  function onSpeed() {
    const reply = session.reply;
    if (!reply) return;
    if (reply.conv === activeConv()) scheduleStreamRender();
  }

  function onDone({ detail }) {
    const reply = session.reply;
    if (!reply) return;
    flushStreamRender();
    if (detail.failed) {
      // onError already wrote the plain sentence on this reply; keep the words it got, show no stats.
      reply.msg.pending = false;
    } else {
      Object.assign(reply.msg, {
        pending: false,
        stats: { at: Date.now(), words: detail.words, seconds: detail.seconds, speedSeconds: detail.speedSeconds, firstTokenSeconds: detail.firstTokenSeconds, firstWordSeconds: detail.firstWordSeconds, wordsPerSecond: detail.wordsPerSecond, tokens: detail.tokens, tokensPerSecond: detail.tokensPerSecond, thinkingSeconds: detail.thinkingSeconds, thinkingTokens: detail.thinkingTokens },
      });
    }
    session.reply = null;
    // The live speed is an estimate; the finished reply knows the engine's real token count. Bring this
    // reply's stretch of the graph, and the peak, onto the real figure so they agree with its footer.
    const fix = detail.tokenCorrection;
    if (!detail.failed && Number.isFinite(fix) && fix > 0 && Math.abs(fix - 1) > 0.01 && detail.startedAt) {
      for (const sample of session.speedHistory) if (sample.t >= detail.startedAt) sample.v *= fix;
      if (session.peak !== null) session.peak *= fix;
      session.meterTop = Math.max(session.meterTop, session.peak ?? 0);
      trend.redraw();
    }
    // A short reply ends before the live meter catches up, so its samples read low. The reply's own
    // speed is an average, and the fastest moment is at least that: lift its stretch of the graph and
    // the peak to it, so the peak, the graph and the big number agree.
    const final = detail.tokensPerSecond;
    if (!detail.failed && Number.isFinite(final) && final > 0 && detail.startedAt) {
      const own = session.speedHistory.filter((sample) => sample.t >= detail.startedAt);
      const top = own.reduce((m, sample) => Math.max(m, sample.v), 0);
      if (top > 0 && top < final) for (const sample of own) sample.v *= final / top;
      else if (top === 0) trend.push(final);
      session.peak = Math.max(session.peak ?? 0, final);
      session.meterTop = Math.max(session.meterTop, session.peak);
      trend.redraw();
    }
    if (engine.mode !== "sim") saveChat(reply.conv);
    renderThread();
    refresh();
    if (!input.disabled) input.focus();
  }

  // The engine stopped answering mid-reply: turn the stuck reply into a visible error block.
  function onError({ detail }) {
    const reply = session.reply;
    if (!reply) return;
    flushStreamRender();
    Object.assign(reply.msg, {
      pending: false,
      error: detail?.message ?? "The model engine stopped answering.",
      stoppedEarly: reply.msg.text.trim() !== "",
    });
    if (reply.conv === activeConv()) renderThread();
    refresh();
  }

  input.addEventListener("input", () => {
    session.draft = input.value;
    updateDraft();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendDraft();
    }
  });
  function closeComposerPanels() {
    if (!settingsPanel.hidden) { settingsPanel.hidden = true; settingsToggle.setAttribute("aria-expanded", "false"); }
    if (!systemPanel.hidden) { systemPanel.hidden = true; systemToggle.setAttribute("aria-expanded", "false"); }
  }
  function onEscape(event) {
    // Ctrl+Shift+O: a new chat, as in most chat apps.
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "o") {
      event.preventDefault();
      if (!newButton.disabled) newConversation();
      return;
    }
    if (event.key !== "Escape") return;
    if (!settingsPanel.hidden || !systemPanel.hidden) closeComposerPanels();
  }
  document.addEventListener("keydown", onEscape);
  systemText.addEventListener("input", () => {
    const conv = activeConv();
    if (conv) {
      conv.system = systemText.value;
      if (engine.mode !== "sim") queueSave(conv);
    }
    updateSystemLabel();
  });
  updateSystemLabel();
  renderChips();

  // Test hook: the export text builder for the open chat (used by 41-chat-manage).
  globalThis.benchChatExport = () => {
    const conv = activeConv();
    return conv ? chatMarkdown(conv) : null;
  };

  // Side chats ----------------------------------------------------------------
  // A model whose engine writes more than one reply at once (slots of 2 or more) can run other chats
  // beside the main one, each with its own messages, at the same time. One panel per extra slot.
  const sidePanes = new Map(); // conv id -> pane

  function sideRoom() {
    return engine.mode !== "sim" && Boolean(loadedModel()) && !engine.loading ? Math.max(0, (engine.slots ?? 1) - 1) : 0;
  }

  function openSideChat() {
    if (sidePanes.size >= sideRoom()) return;
    const conv = makeConversation();
    session.conversations.unshift(conv);
    addSide(conv);
    renderList();
    sidePanes.get(conv.id)?.input.focus();
  }

  function addSide(conv) {
    if (sidePanes.has(conv.id)) return;
    const pane = { conv, run: null, renderTimer: 0 };
    const titleNode = el("h1", "chat-title");
    const close = button({ kind: "ghost", small: true, onClick: () => closeSide(conv.id) });
    close.classList.add("chat-side-close");
    close.setAttribute("aria-label", "Close this side chat");
    close.title = "Close this side chat. It stays in your chat list.";
    close.append(icon(CLOSE_ICON));
    const sideHead = el("div", "chat-thread-head");
    sideHead.append(titleNode, close);
    const sideMessages = el("div", "chat-messages");
    const sideScroller = el("div", "chat-scroll");
    sideScroller.append(sideMessages);
    pane.stick = true;
    sideScroller.addEventListener("scroll", () => {
      pane.stick = sideScroller.scrollHeight - sideScroller.scrollTop - sideScroller.clientHeight < STICK_PX;
    });
    const sideHint = el("p", "chat-hint");
    const sideInput = el("textarea", "chat-input");
    sideInput.rows = 2;
    sideInput.placeholder = "Ask in this side chat";
    sideInput.setAttribute("aria-label", "Side chat message");
    const sideStop = button({ kind: "secondary", text: "Stop", onClick: () => pane.run?.stop() });
    sideStop.prepend(icon(stop.querySelector(".chat-icon").innerHTML));
    const sideSend = button({ kind: "primary", text: "Send", onClick: () => sendSide(pane) });
    sideSend.append(icon(send.querySelector(".chat-icon").innerHTML));
    const sideBar = el("div", "chat-composer-bar");
    sideBar.append(el("span", "chat-count"), sideStop, sideSend);
    const sideComposer = el("div", "chat-composer");
    sideComposer.append(sideHint, sideInput, sideBar);
    const sideWrap = el("div", "chat-composer-wrap");
    sideWrap.append(sideComposer);
    const node = module({ tag: "section", cls: "chat-thread chat-side", children: [sideHead, sideScroller, sideWrap] });
    node.setAttribute("aria-label", "Side chat");
    node.dataset.id = conv.id;
    sideInput.addEventListener("input", () => updateSide(pane));
    sideInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        sendSide(pane);
      }
    });
    Object.assign(pane, { node, titleNode, messages: sideMessages, scroller: sideScroller, hint: sideHint, input: sideInput, stop: sideStop, send: sideSend });
    sidePanes.set(conv.id, pane);
    if (!session.sideIds.includes(conv.id)) session.sideIds.push(conv.id);
    threadArea.append(node);
    if (session.activeId === conv.id) {
      // The main thread was showing this chat: give the main thread a fresh one.
      const fresh = makeConversation();
      session.conversations.unshift(fresh);
      selectConversation(fresh.id);
    }
    renderSide(pane);
    updateSide(pane);
    refresh();
  }

  function dropSide(id) {
    const pane = sidePanes.get(id);
    if (!pane) return;
    pane.run?.stop();
    clearTimeout(pane.renderTimer);
    pane.node.remove();
    sidePanes.delete(id);
    session.sideIds = session.sideIds.filter((x) => x !== id);
  }

  function closeSide(id) {
    const pane = sidePanes.get(id);
    if (!pane) return;
    dropSide(id);
    if (engine.mode !== "sim" && pane.conv.messages?.length) saveChat(pane.conv);
    renderList();
    refresh();
  }

  function renderSide(pane) {
    const conv = pane.conv;
    pane.titleNode.textContent = conv.title;
    pane.messages.replaceChildren();
    const msgs = conv.messages ?? [];
    if (msgs.length === 0) {
      const empty = el("div", "chat-empty");
      empty.append(el("p", "chat-empty-title", "Side chat"), el("p", "chat-empty-note", "Same model, its own conversation. It can answer while the main chat does."));
      pane.messages.append(empty);
    }
    for (const msg of msgs) {
      pane.messages.append(msg.role === "user" ? userBlock(msg, null) : modelBlock(conv, msg, null, () => retrySide(pane, msg)));
    }
    wireCodeCopy(pane.messages);
    if (pane.stick) pane.scroller.scrollTop = pane.scroller.scrollHeight;
  }

  function scheduleSideRender(pane) {
    if (pane.renderTimer) return;
    pane.renderTimer = setTimeout(() => { pane.renderTimer = 0; renderSide(pane); }, 100);
  }

  function updateSide(pane) {
    const model = loadedModel();
    const busy = Boolean(pane.run);
    let why = "";
    if (engine.loading) why = "A model is loading.";
    else if (!model) why = "No model loaded.";
    else if ((engine.slots ?? 1) < 2) why = "This model answers one chat at a time now.";
    pane.hint.textContent = why;
    pane.hint.hidden = why === "";
    pane.input.disabled = why !== "";
    pane.stop.disabled = !busy;
    pane.send.disabled = busy || why !== "" || pane.conv.messages === null || pane.input.value.trim() === "";
  }

  function updateSides() {
    threadArea.classList.toggle("has-sides", sidePanes.size > 0);
    const room = sideRoom();
    splitButton.disabled = sidePanes.size >= room;
    splitButton.title = !loadedModel() ? "Side chats need a loaded model."
      : room === 0 ? "This model answers one chat at a time, so side chats are off. They turn on for a model started to answer several at once."
        : sidePanes.size >= room ? `This model answers ${engine.slots} chats at once, and all of them are open.`
          : "Open a side chat: the same model, its own conversation, answering at the same time.";
    for (const pane of sidePanes.values()) updateSide(pane);
  }

  function sideOptions(conv) {
    return { ...requestSettings(), system: conv.system ?? "" };
  }

  function startSide(pane, history, reply) {
    const conv = pane.conv;
    pane.stick = true;
    const run = engine.sideReply(history, sideOptions(conv), {
      text: (delta) => {
        if (!reply.text && reply.thinkStartMs !== undefined && reply.thinkSeconds === undefined) {
          reply.thinkSeconds = (performance.now() - reply.thinkStartMs) / 1000;
          if (reply.thinkingOpen === undefined) reply.thinkingOpen = false;
        }
        reply.text += delta;
        scheduleSideRender(pane);
      },
      thinking: (delta) => {
        if (reply.thinkStartMs === undefined) reply.thinkStartMs = performance.now();
        reply.thinking += delta;
        scheduleSideRender(pane);
      },
      error: (message) => {
        Object.assign(reply, { error: message, stoppedEarly: reply.text.trim() !== "" });
      },
      done: (stats) => {
        if (pane.run === run) pane.run = null;
        reply.pending = false;
        if (!stats.failed && !reply.error) reply.stats = { at: Date.now(), words: wordCountOf(reply.text), ...stats };
        if (engine.mode !== "sim") saveChat(conv);
        if (sidePanes.get(conv.id) === pane) {
          clearTimeout(pane.renderTimer);
          pane.renderTimer = 0;
          renderSide(pane);
          updateSide(pane);
        }
        renderList();
      },
    });
    if (!run) return false;
    pane.run = run;
    return true;
  }

  function sendSide(pane) {
    const conv = pane.conv;
    const text = pane.input.value.trim();
    const model = loadedModel();
    if (!text || !model || pane.run || conv.messages === null || pane.input.disabled) return;
    const history = historyMessages(conv.messages);
    const reply = { role: "model", model: model.name, text: "", thinking: "", pending: true, stats: null };
    conv.messages.push({ role: "user", text }, reply);
    if (!conv.model) conv.model = model.name;
    if (conv.title === "New conversation") conv.title = titleFromText(text);
    pane.input.value = "";
    if (!startSide(pane, [...history, { role: "user", content: text }], reply)) {
      conv.messages.splice(-2, 2);
      pane.input.value = text;
    }
    renderSide(pane);
    updateSide(pane);
    renderList();
  }

  function retrySide(pane, msg) {
    const conv = pane.conv;
    const model = loadedModel();
    const index = conv.messages.indexOf(msg);
    if (!model || index < 0 || pane.run) return;
    const earlier = conv.messages.slice(0, index);
    if (!earlier.some((m) => m.role === "user")) return;
    conv.messages.splice(index, 1);
    const reply = { role: "model", model: model.name, text: "", thinking: "", pending: true, stats: null };
    conv.messages.push(reply);
    if (!startSide(pane, historyMessages(earlier), reply)) conv.messages.splice(-1, 1);
    renderSide(pane);
    updateSide(pane);
  }

  // Side chats open before a tab switch come back with the screen.
  async function restoreSides() {
    for (const id of [...session.sideIds]) {
      const conv = session.conversations.find((c) => c.id === id);
      if (!conv || !(await ensureMessages(conv)) || disposed) { session.sideIds = session.sideIds.filter((x) => x !== id); continue; }
      addSide(conv);
    }
  }

  if (engine.mode === "sim" || session.loaded) {
    renderAll();
    restoreSides();
  } else {
    newButton.disabled = true;
    renderAll();
    loadSettingsFromStore().then(() => {
      if (disposed) return;
      for (const field of SETTING_FIELDS) settingInputs[field.key].value = session.settings[field.key];
      thinkingSelect.value = session.settings.thinking;
      limitBox.checked = session.settings.thinkingLimit;
      renderChips();
    }).then(() => disposed ? undefined : loadChats()).then(() => {
      if (disposed || generation !== chatGeneration) return;
      session.loaded = true;
      newButton.disabled = false;
      renderAll();
      restoreSides();
    });
  }

  const listeners = {
    change: refresh,
    progress: refresh,
    speed: onSpeed,
    text: onText,
    word: onWord,
    thinking: onThinking,
    done: onDone,
    error: onError,
  };
  for (const [type, fn] of Object.entries(listeners)) engine.addEventListener(type, fn);

  // Two speed samples a second for the 60-second graph.
  const trendTimer = setInterval(() => {
    const value = engine.streaming ? Math.max(session.sampleTop ?? 0, engine.speed.tokensPerSecond ?? 0) : (session.sampleTop ?? 0);
    session.sampleTop = 0;
    trend.push(value);
  }, 500);

  return () => {
    disposed = true;
    // Leaving the tab ends the reply. Stop first, while the listeners can still store its text.
    if (engine.streaming) engine.stop();
    for (const pane of sidePanes.values()) pane.run?.stop();
    for (const [type, fn] of Object.entries(listeners)) engine.removeEventListener(type, fn);
    document.removeEventListener("keydown", onEscape);
    clearInterval(trendTimer);
    trend.dispose();
    closeMenu();
    // Leaving the screen finishes any delete still waiting for Undo.
    for (const id of [...pendingDeletes.keys()]) commitDelete(id);
    clearTimeout(streamRenderTimer);
    scheduleSave.flush();
    scheduleSettingsSave.flush();
  };
}
