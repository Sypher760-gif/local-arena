// Per-model settings: a side panel opened from a model's ⋯ menu on the Models screen, with two tabs.
//   Reply  sampling and prompt settings sent with every request to this model (Chat, Arena, Tests).
//          An empty field leaves the choice to the screen (Chat's own settings, for example).
//   Load   how the model starts. NInfer: its start options (context, drafter, drafts, cache, prefix
//          cache, server thinking cap), applied on the next load. A model added in Local Arena: its own
//          dialog. A running server or a model with its own launcher: shown read-only.
// Saved by the gateway (PUT /api/models/<id>/settings) in data/model-settings.json, never in the
// hand-kept catalogue.
import { engine } from "../engine.js";
import { el, button, toast } from "../ui.js";
import { openAddModel } from "./models-add.js";

const REPLY_FIELDS = [
  { key: "temperature", label: "Temperature", min: 0, max: 2, step: 0.05 },
  { key: "topK", label: "Top K", min: 0, max: 200, step: 1, whole: true },
  { key: "topP", label: "Top P", min: 0, max: 1, step: 0.05 },
  { key: "minP", label: "Min P", min: 0, max: 1, step: 0.01 },
  { key: "presencePenalty", label: "Presence Penalty", min: 0, max: 2, step: 0.1 },
  { key: "frequencyPenalty", label: "Frequency Penalty", min: 0, max: 2, step: 0.1 },
  { key: "seed", label: "Seed", min: 0, max: 2147483647, step: 1, whole: true },
];

const NINFER_CONTEXTS = [[16384, "16K"], [32768, "32K"], [65536, "64K"], [98304, "96K"], [131072, "128K"]];
const NINFER_SPEC = [["dflash2", "DFlash2"], ["mtp", "MTP"], ["none", "Off"]];
const NINFER_KV = [["rk4v4-e8", "rk4v4-e8"], ["rk2v4-e8", "rk2v4-e8"], ["rk8v4", "rk8v4"]];
const NINFER_PREFIX = [["small", "Small"], ["large", "Large"], ["off", "Off"]];

async function putSettings(id, body) {
  const res = await fetch(`/api/models/${encodeURIComponent(id)}/settings`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty reply */ }
  if (res.status === 404 && !data.error) throw new Error("Local Arena's server does not support this yet. Restart Local Arena and try again.");
  if (!res.ok) throw new Error(data.error || `The gateway answered ${res.status}.`);
  return data.tuning ?? {};
}

const isCustomized = (tuning) => Boolean(tuning && (Object.keys(tuning.reply ?? {}).length || Object.keys(tuning.load ?? {}).length));
export { isCustomized };

export function openModelSettings({ model, loaded = false, onSaved, onReload } = {}) {
  const saved = model.tuning ?? {};
  const reply = { ...(saved.reply ?? {}) };
  const current = model.ninferLoad ?? {};
  const load = { ...current, ...(saved.load ?? {}) };
  let tab = "reply";
  let saving = false;

  const dialog = el("dialog", "model-settings");
  dialog.setAttribute("aria-label", `${model.name} settings`);
  const shell = el("div", "ms-shell");
  dialog.append(shell);
  document.body.append(dialog);
  const close = () => {
    dialog.classList.add("is-closing");
    setTimeout(() => { dialog.close(); dialog.remove(); }, 160);
  };
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(); });
  dialog.addEventListener("click", (event) => { if (event.target === dialog) close(); });

  // ---- header ---------------------------------------------------------------------------------
  const head = el("header", "ms-head");
  const titleRow = el("div", "ms-title-row");
  const title = el("h2", "ms-title", model.name);
  const tag = el("span", "ms-tag", "Customized");
  titleRow.append(title, tag);
  const sub = el("p", "ms-sub", [model.version, model.contextTokens ? `${Math.round(model.contextTokens / 1024)}K context` : null, loaded ? "loaded now" : null].filter(Boolean).join(" · "));
  const closeBtn = el("button", "add-close");
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
  closeBtn.addEventListener("click", close);
  const headText = el("div", "ms-head-text");
  headText.append(titleRow, sub);
  head.append(headText, closeBtn);

  const tabs = el("div", "add-tabs ms-tabs");
  tabs.setAttribute("role", "tablist");
  const tabButtons = [["reply", "Reply"], ["load", "Load"]].map(([id, label]) => {
    const b = el("button", "add-tab", label);
    b.type = "button";
    b.setAttribute("role", "tab");
    b.dataset.tab = id;
    b.addEventListener("click", () => { tab = id; draw(); });
    tabs.append(b);
    return b;
  });

  const body = el("div", "ms-body");
  const errorLine = el("p", "add-error");
  errorLine.hidden = true;
  const foot = el("footer", "add-foot ms-foot");
  shell.append(head, tabs, body, errorLine, foot);
  const showError = (text) => { errorLine.textContent = text || ""; errorLine.hidden = !text; };

  // One setting per row, label left and control right, grouped under a section title (as LM Studio does).
  function row(label, control) {
    const node = el("label", "ms-row");
    node.append(el("span", "ms-row-label", label), control);
    return node;
  }
  function section(title, ...rows) {
    const node = el("section", "ms-section");
    node.append(el("h3", "ms-section-title", title), ...rows);
    return node;
  }

  function segmented(options, get, set) {
    const group = el("div", "add-seg");
    group.setAttribute("role", "radiogroup");
    const buttons = options.map(([value, label]) => {
      const b = el("button", "add-seg-btn", label);
      b.type = "button";
      b.setAttribute("role", "radio");
      b.addEventListener("click", (event) => { event.preventDefault(); set(value); sync(); syncTag(); });
      group.append(b);
      return [value, b];
    });
    const sync = () => buttons.forEach(([value, b]) => {
      b.classList.toggle("on", get() === value);
      b.setAttribute("aria-checked", String(get() === value));
    });
    sync();
    return group;
  }

  function numberBox(f, value, onValue) {
    const input = el("input", "field-control mono-control ms-num");
    input.type = "number";
    input.inputMode = "decimal";
    input.min = f.min;
    input.max = f.max;
    input.step = f.step;
    if (f.key) input.dataset.key = f.key;
    input.value = value ?? "";
    input.addEventListener("change", () => {
      const raw = input.value.trim();
      if (raw === "") { onValue(undefined); input.value = ""; syncTag(); return; }
      let n = Number(raw);
      if (!Number.isFinite(n)) { input.value = value ?? ""; return; }
      n = Math.min(f.max, Math.max(f.min, f.whole ? Math.round(n) : n));
      onValue(n);
      input.value = n;
      syncTag();
    });
    return input;
  }

  // ---- Reply tab --------------------------------------------------------------------------------
  function drawReply() {
    const wrap = el("div", "ms-pane");
    const system = el("textarea", "field-control ms-system");
    system.rows = 4;
    system.value = reply.system ?? "";
    system.setAttribute("aria-label", "System prompt");
    system.addEventListener("input", () => { if (system.value.trim()) reply.system = system.value; else delete reply.system; syncTag(); });
    const sysSection = el("section", "ms-section");
    sysSection.append(el("h3", "ms-section-title", "System Prompt"), system);

    const set = (key) => (v) => { if (v === undefined) delete reply[key]; else reply[key] = v; };
    const rows = REPLY_FIELDS.map((f) => row(f.label, numberBox(f, reply[f.key], set(f.key))));
    const stop = el("input", "field-control mono-control ms-stop");
    stop.value = (reply.stop ?? []).join(", ");
    stop.addEventListener("change", () => {
      const parts = stop.value.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 4);
      if (parts.length) reply.stop = parts; else delete reply.stop;
      stop.value = parts.join(", ");
      syncTag();
    });
    wrap.append(
      sysSection,
      section("Sampling", ...rows.slice(0, 4)),
      section("Penalties", ...rows.slice(4, 6)),
      section("Output", rows[6], row("Stop Strings", stop)),
    );
    return wrap;
  }

  // ---- Load tab ---------------------------------------------------------------------------------
  function drawLoad() {
    const wrap = el("div", "ms-pane");
    const kind = model.loadKind;
    if (kind === "ninfer") {
      const drafts = numberBox({ min: 1, max: 15, step: 1, whole: true }, load.spec === "none" ? "" : (load.draftTokens ?? 6),
        (v) => { load.draftTokens = v ?? 6; });
      drafts.classList.add("ms-drafts");
      drafts.disabled = load.spec === "none";
      const budget = numberBox({ min: 0, max: 8192, step: 1, whole: true }, load.thinkingBudget ?? 0, (v) => { load.thinkingBudget = v ?? 0; });
      budget.classList.add("ms-budget");
      wrap.append(
        section("Context",
          row("Context Length", segmented(NINFER_CONTEXTS, () => load.contextTokens, (v) => { load.contextTokens = v; }))),
        section("Speculative Decoding",
          row("Drafter", segmented(NINFER_SPEC, () => load.spec, (v) => {
            load.spec = v;
            if (v !== "none" && !load.draftTokens) load.draftTokens = v === "mtp" ? 4 : 6;
            draw();
          })),
          row("Draft Tokens", drafts)),
        section("Advanced",
          row("KV Cache", segmented(NINFER_KV, () => load.kvDtype, (v) => { load.kvDtype = v; })),
          row("Prefix Cache", segmented(NINFER_PREFIX, () => load.prefixCache, (v) => { load.prefixCache = v; })),
          row("Thinking Budget", budget)),
      );
      return wrap;
    }
    if (kind === "gguf") {
      const openBtn = button({ kind: "secondary", text: "Open load settings", onClick: () => { close(); openAddModel({ edit: model, onSaved }); } });
      openBtn.classList.add("ms-open-load");
      wrap.append(section("llama-server", openBtn));
      return wrap;
    }
    if (kind === "external") {
      wrap.append(section("Server", row("Port", el("span", "ms-value", String(model.port ?? "")))));
      return wrap;
    }
    wrap.append(section(model.launch?.by || "Launcher", el("code", "ms-cmd", model.launch?.detail || "")));
    return wrap;
  }

  // ---- save -------------------------------------------------------------------------------------
  const base = model.ninferBase ?? current;
  const loadChanged = () => model.loadKind === "ninfer" && Object.keys(load).some((k) => load[k] !== base[k]);
  let saveBtn = null;
  // A loaded model with changed load settings: the main button saves and reloads in one step.
  const reloadsOnSave = () => loaded && model.loadKind === "ninfer" && JSON.stringify(pickLoad()) !== JSON.stringify(saved.load ?? {});
  const syncTag = () => {
    tag.hidden = !(Object.keys(reply).length || loadChanged());
    if (saveBtn && !saving) saveBtn.textContent = reloadsOnSave() ? "Save and reload" : "Save";
  };
  // Load settings to save: only what differs from the model's own setup, so a later change to the
  // launcher's defaults still reaches every setting nobody changed here.
  function pickLoad() {
    const out = {};
    if (model.loadKind !== "ninfer") return out;
    for (const [k, v] of Object.entries(load)) if (v !== undefined && v !== base[k]) out[k] = v;
    if (out.spec === "none") delete out.draftTokens;
    return out;
  }

  async function save({ reset = false } = {}) {
    if (saving) return;
    saving = true;
    showError("");
    draw();
    try {
      const tuning = await putSettings(model.id, reset ? {} : { reply, load: pickLoad() });
      const needsReload = loaded && JSON.stringify(tuning.load ?? {}) !== JSON.stringify(saved.load ?? {});
      close();
      await engine.refreshTuning?.();
      onSaved?.(tuning);
      if (needsReload && !reset) {
        toast({ text: `${model.name} settings saved. Reloading it now.`, ms: 4000 });
        onReload?.();
      } else {
        toast({
          text: reset ? `${model.name}: back to its defaults` : `${model.name} settings saved`,
          action: needsReload ? "Reload now" : null,
          onAction: needsReload ? onReload : null,
          ms: needsReload ? 9000 : 3500,
        });
      }
    } catch (error) {
      saving = false;
      showError(error.message);
      draw();
    }
  }

  function draw() {
    tabButtons.forEach((b) => {
      const on = b.dataset.tab === tab;
      b.classList.toggle("on", on);
      b.setAttribute("aria-selected", String(on));
    });
    body.replaceChildren(tab === "reply" ? drawReply() : drawLoad());
    foot.replaceChildren();
    const resetBtn = button({ kind: "ghost", text: "Reset to defaults", onClick: () => save({ reset: true }) });
    resetBtn.classList.add("ms-reset");
    resetBtn.disabled = saving || !isCustomized(saved);
    saveBtn = button({ kind: "primary", text: saving ? "Saving…" : "Save", onClick: () => save() });
    saveBtn.classList.add("ms-save");
    saveBtn.disabled = saving;
    foot.append(resetBtn, el("span", "add-foot-spacer"), button({ kind: "ghost", text: "Cancel", onClick: close }), saveBtn);
    syncTag();
  }

  dialog.showModal();
  draw();
  return close;
}
