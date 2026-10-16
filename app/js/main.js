// App shell: hash router, top bar, Ctrl+1 to Ctrl+4 quick switch, and the hidden #/gallery page.
import { engine } from "./engine.js";
import {
  models, slots, conversations, testRuns, chatSettings, GPU_TOTAL_GB, DEFAULT_CONTEXT_TOKENS,
} from "./data.js";
import {
  el, module, sectionLabel, segMeter, ring, speedChart, radar, readout, chip, statusLight,
  button, largeButton, listRow, keycap, notice,
} from "./ui.js";
import { render as renderChat } from "./screens/chat.js";
import { render as renderArena } from "./screens/arena.js";
import { render as renderTests } from "./screens/tests.js";
import { render as renderModels } from "./screens/models.js";

const TABS = [["chat", "Chat"], ["arena", "Arena"], ["tests", "Tests"], ["models", "Models"]];
const ROUTES = {
  chat: renderChat,
  arena: renderArena,
  tests: renderTests,
  models: renderModels,
  gallery: renderGallery,
};
const FIT_LABEL = { fits: "Fits", tight: "Tight", spills: "Spills over" };
const FIT_COLOR = { fits: "var(--color-ok)", tight: "var(--color-accent)", spills: "var(--color-bad)" };

const view = document.getElementById("view");
const topbar = {};
let cleanup = () => {};

function modelById(id) {
  return models.find((m) => m.id === id) ?? null;
}

// Live mode: the top bar needs the name of a catalogue model that data.js has never heard of.
const liveModels = new Map();
function refreshLiveModels() {
  if (engine.mode === "sim") return;
  fetch("/api/models", { cache: "no-store" })
    .then((res) => (res.ok ? res.json() : { models: [] }))
    .then((data) => {
      for (const model of Array.isArray(data.models) ? data.models : []) liveModels.set(model.id, model);
      refreshTopbar();
    })
    .catch(() => {});
}

function currentRoute() {
  const name = location.hash.replace("#/", "");
  return Object.hasOwn(ROUTES, name) ? name : "chat";
}

// Top bar -----------------------------------------------------------------

function buildTopbar(header) {
  const logo = el("div", "topbar-logo");
  logo.innerHTML = '<img src="assets/arena-icon-64.png" alt="" width="24" height="24" class="topbar-mark">';
  logo.append(el("span", "", "Local Arena"));

  const nav = el("nav", "nav");
  nav.setAttribute("aria-label", "Screens");
  topbar.links = TABS.map(([route, label]) => {
    const link = el("a", "", label);
    link.href = `#/${route}`;
    link.dataset.route = route;
    nav.append(link);
    return link;
  });

  const right = el("div", "topbar-right");
  const gpuWrap = el("div", "gpu-meter-wrap");
  topbar.gpuMeter = segMeter({ min: 0, max: GPU_TOTAL_GB, variant: "small" });
  topbar.usedText = document.createTextNode("0.0");
  const gpuValue = el("span", "gpu-value");
  topbar.totalText = el("span", "gpu-total", ` / ${GPU_TOTAL_GB} GB`);
  gpuValue.append(topbar.usedText, topbar.totalText);
  gpuWrap.append(el("span", "gpu-label", "GPU"), topbar.gpuMeter, gpuValue);
  topbar.chipNode = modelChip();
  topbar.chipMode = "model";
  right.append(gpuWrap, topbar.chipNode);

  header.replaceChildren(logo, nav, right);
}

function modelChip() {
  return chip({ text: "No model loaded", light: "idle", onClick: () => { location.hash = "#/models"; } });
}

function noteChip() {
  const node = chip({ text: "Models take turns on the card" });
  node.classList.add("chip-note");
  return node;
}

// The plain slow-start sentence shared by the top bar and the Models screen.
export function slowStartText(warmup) {
  if (!warmup || !warmup.slow) return null;
  const now = typeof warmup.tokensPerSecond === "number" ? warmup.tokensPerSecond.toFixed(1) : "?";
  const usual = typeof warmup.usual === "number" && warmup.usual > 0 ? Math.round(warmup.usual) : null;
  return usual
    ? `This model started slowly (${now} tokens per second; it usually does ${usual}). Reloading it usually fixes this.`
    : `This model started slowly (${now} tokens per second). Reloading it usually fixes this.`;
}

export const reloadLoadedModel = () => {
  const id = engine.loadedEntryId ?? engine.loadedModelId;
  return id ? engine.loadModel(id) : Promise.resolve();
};

function loadedChipState() {
  if (engine.loading) {
    const id = engine.loading.modelId;
    const target = modelById(id) ?? liveModels.get(id) ?? engine.loadedModel ?? { name: id ?? "A model" };
    const percent = Math.round(engine.loading.progress * 100);
    if (engine.loading.direction === "load") {
      return { text: target.name, sub: `Loading: ${engine.loading.stageLabel ?? "Loading the model into memory"} ${percent}%`, light: "warn" };
    }
    return { text: target.name, sub: `Unloading: ${engine.loading.stageLabel ?? "Stopping the current model"} ${percent}%`, light: "warn" };
  }
  if (engine.mode !== "sim" && !engine.reachable) {
    return { text: "Model engine not answering", sub: "", light: "warn" };
  }
  const model = modelById(engine.loadedModelId) ?? liveModels.get(engine.loadedModelId) ?? engine.loadedModel;
  if (!model) return { text: "No model loaded", sub: "", light: "idle" };
  const slowLine = slowStartText(engine.warmup);
  if (slowLine) return { text: model.name, sub: "Started slowly — reload it?", light: "warn" };
  return { text: model.name, sub: model.version, light: "ok" };
}

function refreshTopbar() {
  const total = engine.mode === "sim" ? GPU_TOTAL_GB : engine.gpuTotalGB;
  if (total > 0) topbar.gpuMeter.setMax(total);
  topbar.totalText.textContent = total > 0 ? ` / ${Number(total.toFixed(1))} GB` : " / ? GB";
  topbar.gpuMeter.set(engine.gpuUsedGB);
  topbar.usedText.textContent = engine.gpuUsedGB.toFixed(1);
  const mode = currentRoute() === "arena" ? "arena" : "model";
  if (mode !== topbar.chipMode) {
    const next = mode === "arena" ? noteChip() : modelChip();
    topbar.chipNode.replaceWith(next);
    topbar.chipNode = next;
    topbar.chipMode = mode;
  }
  if (mode === "model") topbar.chipNode.set(loadedChipState());
}

// Router -------------------------------------------------------------------

function showRoute() {
  const name = currentRoute();
  cleanup();
  view.replaceChildren();
  cleanup = ROUTES[name](view) ?? (() => {});
  for (const link of topbar.links) {
    if (link.dataset.route === name) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  refreshTopbar();
}

// Ctrl+1 to Ctrl+4 load the model in that quick-switch slot, from any screen.
function onKeyDown(event) {
  if (!event.ctrlKey || event.altKey || event.metaKey || !/^[1-4]$/.test(event.key)) return;
  event.preventDefault();
  engine.swapToSlot(Number(event.key)).catch((error) => console.warn(error.message));
}

// Gallery: every component with sample data and live engine values. Not in the tab bar. ----

function renderGallery(root) {
  const grid = el("div", "gallery-grid");
  const live = [];
  const add = (title, ...children) => {
    grid.append(module({ children: [sectionLabel(title), ...children] }));
  };

  // Speed
  const speed = readout({ size: "hero", unit: "tok/s", decimals: 1 });
  const speedMeter = segMeter({ min: 0, max: 120, peakHold: true, ticks: ["0", "30", "60", "90", "120"] });
  const trend = speedChart({ seconds: 60 });
  live.push(() => {
    speed.set(engine.speed.tokensPerSecond);
    speedMeter.set(engine.speed.tokensPerSecond);
  });
  const trendTimer = setInterval(() => trend.push(engine.speed.tokensPerSecond), 1000);
  add("Speed", speed, speedMeter, trend);

  // Graphics memory
  const gauge = ring({ total: GPU_TOTAL_GB });
  const cardBar = segMeter({ min: 0, max: GPU_TOTAL_GB, variant: "bar" });
  live.push(() => {
    const parts = engine.memory;
    gauge.set([
      { value: parts.modelGB, color: "var(--color-accent)" },
      { value: parts.conversationGB, color: "var(--color-compare)" },
      { value: parts.otherAppsGB, color: "var(--color-neutral-series)" },
      { value: Math.max(0, GPU_TOTAL_GB - engine.gpuUsedGB), color: "var(--color-meter-track)", free: true },
    ]);
    cardBar.set(engine.gpuUsedGB);
  });
  // Copy depends on the engine kind: llama.cpp always keeps the whole model on the card, Strata
  // swaps part of it on and off the card, and an unknown engine gets no claim at all.
  const status = notice({ kind: "ok", text: "Fully on the card. Nothing is spilling into system memory." });
  const strataInfo = notice({
    kind: "info",
    text: "Strata keeps part of the model in system memory on purpose and moves it to the card as needed. Speed depends on how much of it is on the card.",
  });
  const warning = notice({ kind: "warn", text: "This model will not fully fit. It will run partly from system memory." });
  add("Graphics memory", gauge, cardBar, status, strataInfo, warning);

  // Context limit
  const length = segMeter({ min: 0, max: 100, variant: "thin", color: "var(--color-compare)" });
  length.set((DEFAULT_CONTEXT_TOKENS / models[0].maxContext) * 100);
  add("Context limit", length);

  // Readouts
  const large = readout({ size: "large", unit: "GB used", decimals: 1 });
  const medium = readout({ size: "medium", unit: "words per second expected", decimals: 1 });
  live.push(() => {
    large.set(engine.gpuUsedGB);
    medium.set(engine.expectedWps);
  });
  add("Readouts", large, medium);

  // Buttons and chips
  const chipRow = el("div", "gallery-row");
  chipRow.append(
    chip({ text: models[0].name, sub: models[0].version, light: "ok", onClick: () => {} }),
    ...chatSettings.map((text) => chip({ text, small: true })),
  );
  const buttonRow = el("div", "gallery-row");
  buttonRow.append(
    button({ kind: "primary", text: "Send" }),
    button({ kind: "secondary", text: "Stop" }),
    button({ kind: "ghost", text: "Export" }),
    button({ kind: "secondary", text: "Small", small: true }),
    largeButton({ kind: "primary", text: "Load" }),
    largeButton({ kind: "secondary", text: "Unload" }),
  );
  add("Buttons and chips", chipRow, buttonRow);

  // Status lights and keys
  const lights = el("div", "gallery-row");
  for (const state of ["ok", "idle", "warn", "bad"]) {
    lights.append(statusLight(state), el("span", "chip-sub", state));
  }
  lights.append(keycap("Ctrl"), keycap("1"));
  add("Status lights and keys", lights);

  // Lists
  const list = el("div");
  list.append(
    listRow({ title: conversations[0].title, sub: conversations[0].model, meta: conversations[0].time, selected: true }),
    listRow({ title: conversations[1].title, sub: conversations[1].model, meta: conversations[1].time }),
  );
  add("List rows", list);

  // Fit meters, one per model file
  const fitRows = models.map((model) => {
    const est = engine.estimateMemory({ modelId: model.id });
    const row = el("div", "gallery-row");
    const meter = segMeter({ min: 0, max: 100, variant: "fit", color: FIT_COLOR[est.fit] });
    meter.set((est.gpuGB / GPU_TOTAL_GB) * 100);
    row.append(el("span", "", `${model.name} ${model.version}`), meter, el("span", "", FIT_LABEL[est.fit]));
    return row;
  });
  add("Fit on the card", ...fitRows);

  // Radar: this run against the compared run
  const axes = testRuns[0].byType.map((t) => t.type);
  const profile = radar({ axes });
  const percent = (run) => run.byType.map((t) => (t.right / t.total) * 100);
  profile.set(percent(testRuns[0]), percent(testRuns[1]));
  add("Profile", profile);

  root.append(grid);
  const update = () => live.forEach((fn) => fn());
  engine.addEventListener("change", update);
  update();

  return () => {
    clearInterval(trendTimer);
    trend.dispose();
    engine.removeEventListener("change", update);
  };
}

// Start --------------------------------------------------------------------

buildTopbar(document.getElementById("topbar"));
refreshLiveModels();
engine.addEventListener("change", refreshTopbar);
window.addEventListener("hashchange", showRoute);
window.addEventListener("keydown", onKeyDown);
// Open demo mode with the first slot's model, with no animation.
// Demo mode only: the live engine shows whatever model is already loaded and never loads one itself.
if (engine.mode === "sim" && slots[0].modelId) engine.loadModel(slots[0].modelId, { instant: true });
showRoute();
