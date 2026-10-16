// Models screen: quick-switch slots, the model table, general settings and the load panel.
// Sample numbers come from data.js. Memory and speed come from engine.estimateMemory.
import { engine, defaultLayers } from "../engine.js";
import { slowStartText, reloadLoadedModel } from "../main.js";
import {
  models, slots, testRuns, settings, GPU_TOTAL_GB, SYS_TOTAL_GB, OTHER_APPS_GB, DEFAULT_CONTEXT_TOKENS, FULL_WPS,
} from "../data.js";
import { el, module, sectionLabel, segMeter, statusLight, notice, keycap, button, largeButton, contextMenu, toast } from "../ui.js";
import { openAddModel } from "./models-add.js";
import { openModelSettings, isCustomized } from "./model-settings.js";

const CONTEXT_OPTIONS = [16384, 32768, 65536]; // conversation sizes in the picker, in tokens
const PICKER_START = 16384;                    // the picker starts here
const WORDS_PER_TOKEN = 0.75;                  // rough English ratio, used only for the picker label
const TOKENS_PER_WORD = 1.33;                  // same ratio the engine uses for tokens per second
const ASSUMED_LAYERS = 40;                     // layer count assumed for a file added by hand
const ASSUMED_MAX_CONTEXT = 32768;             // context limit for a file added by hand
const LOAD_TIME_NOTE = "Loading takes about 20 seconds. The current chat stays open.";
const FIT_LABEL = { fits: "Fits", tight: "Tight", spills: "Spills over" };
const FIT_COLOR = { fits: "var(--color-ok)", tight: "var(--color-accent)", spills: "var(--color-bad)" };
const FILE_VERSION = /Q\d(?:_[A-Z0-9]+)+/i;    // compression name in a file name, for example Q4_K_M
const IDLE_OPTIONS = [["10", "10 minutes"], ["60", "1 hour"], ["0", "Never"]];

const modelName = (model) => `${model.name} ${model.version}`;
const findModel = (id) => models.find((m) => m.id === id) ?? null;
const slotFor = (id) => slots.find((s) => s.modelId === id) ?? null;
const emptySlot = () => slots.find((s) => !s.modelId) ?? null;

function speedText(wordsPerSecond) {
  return settings.speedInWords
    ? `${Math.round(wordsPerSecond)} words/s`
    : `${Math.round(wordsPerSecond * TOKENS_PER_WORD)} tokens/s`;
}

function contextText(tokens) {
  const words = Math.floor((tokens * WORDS_PER_TOKEN) / 1000) * 1000;
  return `${tokens / 1024}K tokens · about ${words.toLocaleString("en-US")} words`;
}

function lastTestText(model) {
  const run = testRuns.find((r) => r.model === model.name && r.version === model.version);
  if (!run) return "Not tested";
  const right = run.byType.reduce((sum, t) => sum + t.right, 0);
  const total = run.byType.reduce((sum, t) => sum + t.total, 0);
  return `${Math.round((right / total) * 100)}% · ${speedText(run.averageWordsPerSecond)}`;
}

// Puts a slot number on a model. The model leaves any slot it held. Null clears it.
function assignSlot(modelId, number) {
  for (const slot of slots) if (slot.modelId === modelId) slot.modelId = null;
  if (number) slots.find((s) => s.slot === number).modelId = modelId;
}

function modelFromFile(file) {
  const stem = file.name.replace(/\.gguf$/i, "");
  const match = stem.match(FILE_VERSION);
  const version = match ? match[0].toUpperCase() : "Unknown";
  const name = (match ? stem.replace(match[0], "") : stem).replace(/[-_. ]+$/, "") || stem;
  return {
    id: `${name}-${version}`.toLowerCase(),
    name,
    version,
    sizeGB: file.size / 1024 ** 3,
    layers: ASSUMED_LAYERS,
    maxContext: ASSUMED_MAX_CONTEXT,
    failsToLoad: false,
  };
}

function memoryBlock(label, number, total, meter) {
  const line = el("div", "mem-line");
  const value = el("span", "mem-value");
  value.append(number, el("span", "mem-unit", ` ${total}`));
  line.append(el("span", "", label), value);
  const block = el("div", "mem-block");
  block.append(line, meter);
  return block;
}

function checkField(text, checked, onChange) {
  const label = el("label", "check");
  const box = el("input");
  box.type = "checkbox";
  box.checked = checked;
  box.addEventListener("change", () => onChange(box.checked));
  label.append(box, text);
  return label;
}

// Live mode builds the table from GET /api/models and switches models through the gateway.
const LIVE_CONFIRM = (name) => `This stops the model that is running now and loads ${name}. Anything being written is lost. Continue?`;

function renderLive(root) {
  let pendingId = null;   // the model shown with the confirm, awaiting the go-ahead
  let loadError = "";
  let attemptId = null;   // the last model a load was tried on, for Retry
  const rows = [];

  // Two entries can share one model id and differ only in context (NInfer's 64K and 128K profiles,
  // and Bonsai Fast next to Bonsai 128K). When an entry states the context it needs, the engine's own
  // context size has to match too, or both rows would claim to be the loaded one.
  const isLoaded = (model, loadedId, loadedContext) => {
    if (loadedId === null) return false;
    const matches = (typeof model.matchId === "string" && model.matchId && loadedId.includes(model.matchId)) || loadedId === model.id;
    if (!matches) return false;
    if (typeof model.matchContext === "number") return loadedContext === model.matchContext;
    return true;
  };
  const nameOf = (id) => rows.find((r) => r.model.id === id)?.model.name ?? id ?? "A model";

  const countText = el("span", "count", "0");
  const title = sectionLabel("On this computer", "h1");
  title.append(" ", countText);
  const tableHead = el("div", "table-head");
  const addButton = button({ kind: "primary", small: true, text: "Add model", onClick: () => openAddModel({ onSaved: reload }) });
  addButton.classList.add("add-model-btn");
  tableHead.append(title, addButton);

  const headRow = el("div", "live-model-head");
  headRow.append(
    el("span", "", "Model"), el("span", "", "Version"), el("span", "", "Context limit"),
    el("span", "", "On this PC"), el("span", ""),
  );
  const rowList = el("div");
  const emptyNote = el("div", "live-empty-add");
  emptyNote.append(el("p", "", "No models are listed yet. Add a model file from this PC, or connect to a server you already run."),
    button({ kind: "secondary", small: true, text: "Add a model", onClick: () => openAddModel({ onSaved: reload }) }));
  const table = el("div", "live-model-table");
  table.append(headRow, rowList, emptyNote);
  const tableScroll = el("div", "table-scroll");
  tableScroll.tabIndex = 0;
  tableScroll.setAttribute("role", "region");
  tableScroll.setAttribute("aria-label", "Models");
  tableScroll.append(table);

  const progressText = el("span");
  const progressMeter = segMeter({ min: 0, max: 100, variant: "bar" });
  const progressBox = el("div", "load-progress");
  progressBox.append(progressText, progressMeter);

  const errorText = el("span");
  const retryButton = button({ kind: "secondary", small: true, text: "Retry", onClick: () => { if (attemptId) startLoad(attemptId); } });
  const errorBox = el("div", "notice bad");
  errorBox.append(el("span", "dot"), errorText, retryButton);

  // After a slow start, say so plainly and offer Reload model (no automatic reload exists).
  const slowText = el("span");
  const slowButton = button({ kind: "secondary", small: true, text: "Reload model", onClick: () => { reloadLoadedModel().catch(() => {}); } });
  slowButton.classList.add("reload-model-btn");
  const slowBox = el("div", "notice warn");
  slowBox.append(el("span", "dot"), slowText, slowButton);

  const tableModule = module({ tag: "section", cls: "table-module live-table", children: [tableHead, progressBox, errorBox, slowBox, tableScroll] });
  const main = el("main", "models-main");
  main.append(tableModule);
  const shell = el("div", "models-cols");
  shell.append(main);
  root.append(shell);

  function buildRow(model) {
    const node = el("div", "live-model-row");
    node.dataset.modelId = model.id;
    if (model.note) node.title = model.note;  // the numbers behind this model: hover the row
    const dot = statusLight("idle");
    const nameCell = el("span", "model-cell");
    nameCell.append(dot, el("span", "model-name", model.name));
    if (model.custom) {
      const tag = el("span", "model-added-tag", model.engine === "external" ? "Server" : "Added");
      tag.title = model.engine === "external" ? "A server you run; Local Arena connects to it." : "Added in Local Arena; started with llama-server.";
      nameCell.append(tag);
    }
    if (isCustomized(model.tuning)) {
      const tag = el("span", "model-custom-tag", "Customized");
      tag.title = "This model has its own settings. Open its menu, then Settings.";
      nameCell.append(tag);
    }
    const versionCell = el("span", "mono muted", model.version || "");
    const contextCell = el("span", "mono muted", model.contextTokens ? `${model.contextTokens / 1024}K tokens (pieces of words)` : "");
    const diskCell = el("span", "live-disk", model.onDisk ? "On this PC" : "Not found on this PC");
    if (!model.onDisk) diskCell.classList.add("missing");
    const actionCell = el("span", "live-action");
    node.append(nameCell, versionCell, contextCell, diskCell, actionCell);
    rowList.append(node);
    const row = { model, node, dot, actionCell };
    rows.push(row);
    node.addEventListener("contextmenu", (event) => { event.preventDefault(); openRowMenu(row, event.clientX, event.clientY); });
  }

  function openSettings(row) {
    const loaded = row.node.classList.contains("loaded");
    openModelSettings({
      model: row.model, loaded, onSaved: reload,
      onReload: () => { if (!engine.loading) startLoad(row.model.id); },
    });
  }

  // Every model: Settings (reply and load). Added models also: their file path, and Remove.
  function openRowMenu(row, x, y, anchor = null) {
    const { model } = row;
    const loaded = row.node.classList.contains("loaded");
    const busy = Boolean(engine.loading);
    anchor?.setAttribute("aria-expanded", "true");
    const items = [{ label: "Settings…", onSelect: () => openSettings(row) }];
    if (model.custom) {
      items.push(
        { label: "Copy file path", disabled: !model.settings?.modelPath, onSelect: () => navigator.clipboard?.writeText(model.settings.modelPath).then(() => toast({ text: "Path copied", ms: 2000 })) },
        "-",
        { label: "Remove from Local Arena", danger: true, disabled: loaded || busy, hint: loaded ? "loaded" : "", onSelect: () => removeModel(model) },
      );
    }
    contextMenu({ x, y, label: `${model.name} actions`, onClose: () => anchor?.setAttribute("aria-expanded", "false"), items });
  }

  async function removeModel(model) {
    try {
      const res = await fetch(`/api/models/${encodeURIComponent(model.id)}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "The model could not be removed.");
      toast({ text: `${model.name} removed. The file stays on disk.`, ms: 4000 });
      reload();
    } catch (error) {
      loadError = error.message;
      refresh();
    }
  }

  function drawAction(row, model, loaded, busy) {
    const { actionCell } = row;
    actionCell.replaceChildren();
    actionCell.classList.remove("confirming");
    if (!model.onDisk) {
      actionCell.append(moreButton(row));
      return;
    }
    if (pendingId === model.id) {
      actionCell.classList.add("confirming");
      const confirmLoad = button({ kind: "primary", small: true, text: "Load", onClick: () => { pendingId = null; startLoad(model.id); } });
      confirmLoad.classList.add("live-confirm-load");
      const confirmCancel = button({ kind: "ghost", small: true, text: "Cancel", onClick: () => { pendingId = null; refresh(); } });
      confirmCancel.classList.add("live-confirm-cancel");
      actionCell.append(el("span", "live-confirm-text", LIVE_CONFIRM(model.name)), confirmLoad, confirmCancel);
      return;
    }
    const btn = button({
      kind: "secondary", small: true, text: loaded ? "Unload" : "Load",
      onClick: () => (loaded ? doUnload() : requestLoad(model.id)),
    });
    btn.classList.add("live-load-btn");
    btn.disabled = busy;
    actionCell.append(btn);
    actionCell.append(moreButton(row));
  }

  function moreButton(row) {
    const more = el("button", "live-more", "⋯");
    more.type = "button";
    more.setAttribute("aria-label", `More for ${row.model.name}`);
    more.setAttribute("aria-haspopup", "menu");
    more.setAttribute("aria-expanded", "false");
    more.addEventListener("click", () => {
      const box = more.getBoundingClientRect();
      openRowMenu(row, box.right - 196, box.bottom + 4, more);
    });
    return more;
  }

  function requestLoad(id) {
    loadError = "";
    pendingId = id;
    refresh();
  }

  async function startLoad(id) {
    loadError = "";
    attemptId = id;
    refresh();
    try {
      await engine.loadModel(id);
    } catch (error) {
      loadError = error.message;
    }
    refresh();
  }

  async function doUnload() {
    loadError = "";
    attemptId = null;
    refresh();
    try {
      await engine.unloadModel();
    } catch (error) {
      loadError = error.message;
    }
    refresh();
  }

  function onError(event) {
    loadError = (event.detail && event.detail.message) || "The model could not be loaded.";
    refresh();
  }

  function refresh() {
    const loadedId = engine.loadedModelId;
    const loadedContext = engine.maxContext;
    const job = engine.loading;
    const busy = Boolean(job);
    for (const row of rows) {
      const loaded = isLoaded(row.model, loadedId, loadedContext);
      const loading = busy && job.modelId === row.model.id;
      row.node.classList.toggle("loaded", loaded);
      row.dot.set(loaded ? "ok" : loading ? "warn" : "idle");
      drawAction(row, row.model, loaded, busy);
    }
    countText.textContent = String(rows.length);
    emptyNote.hidden = rows.length > 0;
    progressBox.hidden = !job;
    if (job) {
      progressText.textContent = `${job.direction === "load" ? "Loading" : "Unloading"} ${nameOf(job.modelId)}: ${job.stageLabel ?? ""} ${Math.round(job.progress * 100)}%`;
      progressMeter.set(job.progress * 100);
    }
    errorBox.hidden = !loadError;
    errorText.textContent = loadError;
    const slowLine = slowStartText(engine.warmup);
    slowBox.hidden = !slowLine || Boolean(job);
    slowText.textContent = slowLine ?? "";
  }

  function reload() {
    return fetch("/api/models", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : { models: [] }))
      .then((data) => {
        const list = Array.isArray(data.models) ? data.models : [];
        rows.length = 0;
        rowList.replaceChildren();
        list.forEach(buildRow);
        refresh();
      })
      .catch(() => refresh());
  }
  reload();

  engine.addEventListener("change", refresh);
  engine.addEventListener("progress", refresh);
  engine.addEventListener("error", onError);
  refresh();

  return () => {
    engine.removeEventListener("change", refresh);
    engine.removeEventListener("progress", refresh);
    engine.removeEventListener("error", onError);
  };
}

export function render(root) {
  if (engine.mode !== "sim") return renderLive(root);
  let selectedId = engine.loadedModelId ?? models[0]?.id ?? null;
  let contextTokens = PICKER_START;
  let layers = 0;
  let loadError = "";
  let filter = "";
  let showEmpty = false;
  let pickerFor = null;
  const rows = [];
  const slotCards = [];

  // Quick switch -------------------------------------------------------------

  const hint = el("span", "switch-hint");
  hint.append("Press ", keycap("Ctrl"), " + number anywhere to swap");
  const switchHead = el("div", "switch-head");
  switchHead.append(sectionLabel("Quick switch"), hint);

  const slotGrid = el("div", "slot-grid");
  slots.forEach((slot) => {
    const node = el("button", "slot");
    node.type = "button";
    const light = statusLight("idle");
    const stateText = el("span");
    const state = el("span", "slot-state");
    state.append(light, stateText);
    const top = el("span", "slot-top");
    top.append(el("span", "slot-num", String(slot.slot)), state);
    const nameText = el("span", "slot-model");
    const versionText = el("span", "slot-version");
    const name = el("span", "slot-name");
    name.append(nameText, versionText);
    node.append(top, name);
    node.addEventListener("click", () => pressSlot(slot.slot));
    slotGrid.append(node);
    slotCards.push({ node, light, stateText, nameText, versionText });
  });
  const switchModule = module({ tag: "section", cls: "quick-switch", children: [switchHead, slotGrid] });

  // Model table ----------------------------------------------------------------

  const countText = el("span", "count", "0");
  const title = sectionLabel("On this computer", "h1");
  title.append(" ", countText);
  const filterInput = el("input", "field-control filter-input");
  filterInput.type = "search";
  filterInput.placeholder = "Filter";
  filterInput.setAttribute("aria-label", "Filter models");
  filterInput.addEventListener("input", () => {
    filter = filterInput.value.trim().toLowerCase();
    applyFilter();
  });
  const addInput = el("input");
  addInput.type = "file";
  addInput.accept = ".gguf";
  addInput.hidden = true;
  addInput.addEventListener("change", addModelFile);
  const addButton = button({ kind: "secondary", small: true, text: "Add model file", onClick: () => addInput.click() });
  const tableHead = el("div", "table-head");
  tableHead.append(title, filterInput, addButton, addInput);

  const headRow = el("div", "model-head");
  headRow.append(
    el("span", "", "Model"), el("span", "", "Version"), el("span", "num", "File"),
    el("span", "", `Fit on the ${GPU_TOTAL_GB} GB card`), el("span", "", "Last test"),
    el("span", "", "Slot"), el("span"),
  );
  const rowList = el("div");
  const emptyNote = el("p", "empty-note");
  const table = el("div", "model-table");
  table.append(headRow, rowList, emptyNote);
  const tableScroll = el("div", "table-scroll");
  tableScroll.tabIndex = 0;
  tableScroll.setAttribute("role", "region");
  tableScroll.setAttribute("aria-label", "Model files");
  tableScroll.append(table);
  const tableModule = module({ tag: "section", cls: "table-module", children: [tableHead, tableScroll] });

  // General settings -----------------------------------------------------------

  const folderInput = el("input", "field-control folder-input");
  folderInput.type = "text";
  folderInput.value = settings.modelsFolder;
  folderInput.addEventListener("input", () => {
    settings.modelsFolder = folderInput.value;
    applyFilter();
  });
  const browse = button({
    kind: "secondary",
    text: "Browse",
    onClick: () => { folderInput.focus(); folderInput.select(); },
  });
  const folderRow = el("span", "folder-row");
  folderRow.append(folderInput, browse);
  const folderField = el("label", "field");
  folderField.append("Models folder", folderRow);

  const idleSelect = el("select", "field-control");
  idleSelect.append(...IDLE_OPTIONS.map(([value, text]) => new Option(text, value)));
  idleSelect.value = String(settings.idleUnloadMinutes);
  idleSelect.addEventListener("change", () => { settings.idleUnloadMinutes = Number(idleSelect.value); });
  const idleField = el("label", "field");
  idleField.append("Unload a model after it sits idle for", idleSelect);

  const warnCheck = checkField("Warn before loading a model that will not fully fit", settings.warnBeforeFitFail, (checked) => {
    settings.warnBeforeFitFail = checked;
    refresh();
  });
  const speedCheck = checkField("Show speed in words per second (when off, it shows tokens)", settings.speedInWords, (checked) => {
    settings.speedInWords = checked;
    refresh();
  });
  const emptyCheck = checkField("Show empty folder (preview only)", false, (checked) => {
    showEmpty = checked;
    refresh();
  });
  const previewRow = el("div", "preview-row");
  previewRow.append(emptyCheck);

  const settingsGrid = el("div", "settings-grid");
  settingsGrid.append(folderField, idleField, warnCheck, speedCheck);
  const settingsModule = module({
    tag: "section", cls: "settings-module",
    children: [sectionLabel("General"), settingsGrid, previewRow],
  });

  const main = el("main", "models-main");
  main.append(switchModule, tableModule, settingsModule);

  // Load panel -----------------------------------------------------------------

  const headName = el("span", "load-name");
  const headSub = el("span", "load-sub");
  const panelHead = el("div", "load-head");
  panelHead.append(sectionLabel("Selected", "span"), headName, headSub);
  const emptyText = el("p", "load-empty");

  const layersNumber = el("span", "", "0");
  const layersTotal = el("span", "faint", "");
  const layerValue = el("span", "field-value");
  layerValue.append(layersNumber, layersTotal);
  const layerLabel = el("label", "field-label", "Share on the graphics card");
  layerLabel.htmlFor = "models-layers";
  const layerHead = el("div", "field-head");
  layerHead.append(layerLabel, layerValue);
  const layerRange = el("input", "layer-slider");
  layerRange.type = "range";
  layerRange.min = "0";
  layerRange.id = "models-layers";
  layerRange.addEventListener("input", () => {
    layers = Number(layerRange.value);
    refresh();
  });
  const layerHint = el("span", "field-hint", "More on the card is faster, until the card runs out of room.");
  const layersBlock = el("div", "load-block");
  layersBlock.append(layerHead, layerRange, layerHint);

  const contextSelect = el("select", "field-control mono-control");
  contextSelect.id = "models-context";
  contextSelect.addEventListener("change", () => {
    contextTokens = Number(contextSelect.value);
    refresh();
  });
  const contextLabelEl = el("label", "field-label", "Context limit it can hold");
  contextLabelEl.htmlFor = "models-context";
  const contextBlock = el("div", "load-block");
  contextBlock.append(contextLabelEl, contextSelect);

  const layerSection = el("div", "load-section");
  layerSection.append(layersBlock, contextBlock);

  const gpuNumber = el("span", "", "0.0");
  const gpuMeter = segMeter({ min: 0, max: GPU_TOTAL_GB, variant: "bar" });
  const sysNumber = el("span", "", "0.0");
  const sysMeter = segMeter({ min: 0, max: SYS_TOTAL_GB, variant: "bar", color: "var(--color-compare)" });
  const warningSlot = el("div");
  const memorySection = el("div", "load-section memory");
  memorySection.append(
    sectionLabel("Estimated memory"),
    memoryBlock("Graphics card", gpuNumber, `/ ${GPU_TOTAL_GB.toFixed(1)} GB`, gpuMeter),
    memoryBlock("System memory", sysNumber, `/ ${SYS_TOTAL_GB.toFixed(1)} GB`, sysMeter),
    warningSlot,
  );

  const progressText = el("span");
  const progressMeter = segMeter({ min: 0, max: 100, variant: "bar" });
  const progressBox = el("div", "load-progress");
  progressBox.append(progressText, progressMeter);
  const errorText = el("span");
  const errorBox = el("div", "notice bad");
  errorBox.append(el("span", "dot"), errorText);
  const loadButton = largeButton({ kind: "primary", text: "Load", onClick: loadSelected });
  loadButton.classList.add("load-primary");
  const unloadButton = largeButton({ kind: "secondary", text: "Unload current", onClick: unloadCurrent });
  const assignButton = largeButton({ kind: "secondary", text: "Assign to slot", onClick: assignToFreeSlot });
  const actionRow = el("div", "action-row");
  actionRow.append(assignButton, unloadButton);
  const slotHint = el("span", "panel-hint", "All four slots are full. Set a slot for a model in the table.");
  const actions = el("div", "load-actions");
  actions.append(progressBox, errorBox, loadButton, actionRow, slotHint, el("span", "load-note", LOAD_TIME_NOTE));

  const body = el("div", "load-body");
  body.append(layerSection, memorySection, actions);
  const panel = module({ tag: "aside", cls: "load-panel", children: [panelHead, emptyText, body] });
  panel.setAttribute("aria-label", "Load settings");

  const shell = el("div", "models-cols");
  shell.append(main, panel);
  root.append(shell);

  // Behaviour ------------------------------------------------------------------

  function buildRow(model) {
    const fit = engine.estimateMemory({
      modelId: model.id, layersOnCard: model.layers, contextTokens: DEFAULT_CONTEXT_TOKENS,
    });
    const node = el("div", "model-row");
    const dot = statusLight("idle");
    const nameButton = el("button", "model-name", model.name);
    nameButton.type = "button";
    nameButton.addEventListener("click", () => selectModel(model.id));
    const nameCell = el("span", "model-cell");
    nameCell.append(dot, nameButton);

    const fitMeter = segMeter({ min: 0, max: 100, variant: "fit", color: FIT_COLOR[fit.fit] });
    fitMeter.set(Math.min(100, (fit.gpuGB / GPU_TOTAL_GB) * 100));
    const fitCell = el("span", "fit-cell");
    fitCell.style.color = FIT_COLOR[fit.fit];
    fitCell.append(fitMeter, el("span", "", FIT_LABEL[fit.fit]));

    const test = el("span", "mono muted");
    const slotSelect = el("select", "field-control slot-select");
    slotSelect.setAttribute("aria-label", `Quick-switch slot for ${modelName(model)}`);
    slotSelect.append(new Option("No slot", "0"), ...slots.map((s) => new Option(`Slot ${s.slot}`, String(s.slot))));
    slotSelect.addEventListener("change", () => {
      assignSlot(model.id, Number(slotSelect.value) || null);
      refresh();
    });
    const action = button({ kind: "secondary", small: true, text: "Load", onClick: () => rowAction(model.id) });

    // Clicks on the row's empty space select it. Controls handle their own clicks.
    node.addEventListener("click", (event) => {
      if (!event.target.closest("button, select")) selectModel(model.id);
    });
    node.append(
      nameCell,
      el("span", "mono muted", model.version),
      el("span", "num", `${model.sizeGB.toFixed(1)} GB`),
      fitCell, test, slotSelect, action,
    );
    rowList.append(node);
    rows.push({ model, node, nameButton, dot, test, slotSelect, action });
  }

  function applyFilter() {
    let shown = 0;
    for (const row of rows) {
      const text = `${row.model.name} ${row.model.version}`.toLowerCase();
      const match = !showEmpty && text.includes(filter);
      row.node.hidden = !match;
      if (match) shown += 1;
    }
    countText.textContent = String(shown);
    emptyNote.hidden = shown > 0;
    emptyNote.textContent = showEmpty
      ? `No model files in ${settings.modelsFolder} yet. Put model files in that folder, or use Add model file.`
      : "No model matches that filter.";
  }

  function selectModel(id) {
    const model = findModel(id);
    selectedId = model ? model.id : null;
    loadError = "";
    if (model) {
      const allowed = CONTEXT_OPTIONS.filter((t) => t <= model.maxContext);
      if (!allowed.includes(contextTokens)) contextTokens = allowed[allowed.length - 1];
      layers = defaultLayers(model, contextTokens);
    }
    refresh();
  }

  async function loadSelected() {
    const model = findModel(selectedId);
    if (!model) return;
    loadError = "";
    refresh();
    try {
      await engine.loadModel(model.id, { layersOnCard: layers, contextTokens });
    } catch (error) {
      loadError = error.message;
    }
    refresh();
  }

  async function unloadCurrent() {
    await engine.unloadModel();
    refresh();
  }

  function rowAction(id) {
    if (engine.loadedModelId === id) return unloadCurrent();
    selectModel(id);
    return loadSelected();
  }

  async function pressSlot(number) {
    const slot = slots.find((s) => s.slot === number);
    if (!slot.modelId) {
      // An empty slot takes the selected model.
      if (selectedId && !slotFor(selectedId)) assignSlot(selectedId, number);
      refresh();
      return;
    }
    loadError = "";
    try {
      await engine.swapToSlot(number);
    } catch (error) {
      loadError = error.message;
    }
    refresh();
  }

  function assignToFreeSlot() {
    const free = emptySlot();
    if (free && selectedId && !slotFor(selectedId)) assignSlot(selectedId, free.slot);
    refresh();
  }

  function addModelFile() {
    const file = addInput.files[0];
    addInput.value = "";
    if (!file) return;
    let model = modelFromFile(file);
    const existing = findModel(model.id);
    if (existing) {
      model = existing;
    } else {
      models.push(model);
      buildRow(model);
    }
    showEmpty = false;
    emptyCheck.querySelector("input").checked = false;
    selectModel(model.id);
  }

  function refresh() {
    const loadedId = engine.loadedModelId;
    const job = engine.loading;
    const busy = Boolean(job);

    slotCards.forEach((card, i) => {
      const model = findModel(slots[i].modelId);
      const loaded = Boolean(model) && model.id === loadedId;
      const loading = Boolean(model) && job?.modelId === model.id;
      card.node.classList.toggle("loaded", loaded);
      card.node.classList.toggle("empty", !model);
      card.node.disabled = busy;
      card.light.hidden = !model;
      card.light.set(loaded ? "ok" : loading ? "warn" : "idle");
      card.stateText.textContent = loaded ? "Loaded"
        : loading ? (job.direction === "load" ? "Loading" : "Unloading")
          : model ? "Ready" : "";
      card.nameText.textContent = model ? model.name : "Empty";
      card.versionText.textContent = model ? model.version : "Assign a model";
    });

    for (const row of rows) {
      const { model } = row;
      const loaded = model.id === loadedId;
      const selected = !showEmpty && model.id === selectedId;
      row.node.classList.toggle("selected", selected);
      row.nameButton.setAttribute("aria-pressed", String(selected));
      row.dot.set(loaded ? "ok" : job?.modelId === model.id ? "warn" : "idle");
      row.test.textContent = lastTestText(model);
      row.action.textContent = loaded ? "Unload" : "Load";
      row.action.disabled = busy;
      row.slotSelect.value = String(slotFor(model.id)?.slot ?? 0);
    }
    applyFilter();

    const model = showEmpty ? null : findModel(selectedId);
    headName.textContent = model ? model.name : "Nothing selected";
    headSub.textContent = model
      ? `${model.version} · ${model.sizeGB.toFixed(1)} GB · ${
        model.id === loadedId ? "loaded"
          : job?.modelId === model.id ? (job.direction === "load" ? "loading" : "unloading")
            : "not loaded"}`
      : "";
    emptyText.hidden = Boolean(model);
    emptyText.textContent = showEmpty ? "No model files to set up." : "Click a model in the table to set it up.";
    body.hidden = !model;

    if (model) {
      if (pickerFor !== model.id) {
        pickerFor = model.id;
        const allowed = CONTEXT_OPTIONS.filter((t) => t <= model.maxContext);
        contextSelect.replaceChildren(...allowed.map((t) => new Option(contextText(t), String(t))));
      }
      contextSelect.value = String(contextTokens);
      layerRange.max = String(model.layers);
      layerRange.value = String(layers);
      layersNumber.textContent = String(layers);
      layersTotal.textContent = ` / ${model.layers} layers`;

      const est = engine.estimateMemory({ modelId: model.id, layersOnCard: layers, contextTokens });
      const gpuUsed = est.gpuGB + OTHER_APPS_GB;
      gpuNumber.textContent = gpuUsed.toFixed(1);
      gpuMeter.set(gpuUsed);
      sysNumber.textContent = est.sysGB.toFixed(1);
      sysMeter.set(est.sysGB);
      warningSlot.replaceChildren();
      if (est.fit === "spills" && settings.warnBeforeFitFail) {
        warningSlot.append(notice({
          kind: "warn",
          text: `Part of this model will run from system memory. Expect roughly ${speedText(est.expectedWps)}, against ${speedText(FULL_WPS)} for a model that fits entirely.`,
        }));
      }

      const loaded = model.id === loadedId;
      const loadedModel = findModel(loadedId);
      loadButton.textContent = loaded ? "Loaded" : loadedModel ? `Load, replacing ${modelName(loadedModel)}` : "Load";
      loadButton.disabled = busy || loaded;
      unloadButton.disabled = busy || !loadedId;
      const taken = slotFor(model.id);
      const free = emptySlot();
      assignButton.disabled = Boolean(taken) || !free;
      slotHint.hidden = Boolean(taken) || Boolean(free);
    }

    errorText.textContent = loadError;
    errorBox.hidden = !loadError;
    progressBox.hidden = !job;
    if (job) {
      progressText.textContent = `${job.direction === "load" ? "Loading" : "Unloading"} ${modelName(findModel(job.modelId))}: ${job.stageLabel ?? ""} ${Math.round(job.progress * 100)}%`;
      progressMeter.set(job.progress * 100);
    }
  }

  // Start ----------------------------------------------------------------------

  models.forEach(buildRow);
  selectModel(selectedId);
  engine.addEventListener("change", refresh);
  engine.addEventListener("progress", refresh);

  return () => {
    engine.removeEventListener("change", refresh);
    engine.removeEventListener("progress", refresh);
  };
}
