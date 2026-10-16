// Add a model (and edit one added before). One dialog, three ways in:
//   Found on this PC  model files Local Arena found in the usual folders (LM Studio, Hugging Face ...)
//   Model file        paste the path to any .gguf file
//   Running server    connect to LM Studio, Ollama or a llama-server that is already running
// then one settings step: name, context, graphics-card layers, cache, flash attention, vision file and
// extra flags, with a live "will it fit" estimate. The gateway checks everything again on save.
import { el, button, segMeter, toast } from "../ui.js";

const GiB = 1024 ** 3;
const CONTEXT_STEPS = [4096, 8192, 16384, 32768, 65536, 131072, 262144];
const OVERHEAD_GB = 0.6;        // compute buffers and the CUDA context, roughly
const TIGHT_SHARE = 0.92;       // above this share of the card it is "tight"

const fmtGB = (bytes) => (bytes >= GiB ? `${(bytes / GiB).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`);
const fmtCtx = (tokens) => (tokens >= 1024 ? `${Math.round(tokens / 1024)}K` : String(tokens));

async function api(method, path, body) {
  const res = await fetch(path, {
    method, headers: { "Content-Type": "application/json" }, cache: "no-store",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty reply */ }
  if (res.status === 404 && !data.error) {
    throw new Error("Local Arena's server does not support this yet. Restart Local Arena and try again.");
  }
  if (!res.ok) throw new Error(data.error || `The gateway answered ${res.status}.`);
  return data;
}

// Rough memory need on the graphics card: weights on the card plus the conversation cache.
export function estimateFit({ sizeBytes, layers, kvBytesPerToken, contextTokens, gpuLayers, kvCache, gpuTotalMiB }) {
  if (!sizeBytes || !gpuTotalMiB) return null;
  const share = gpuLayers === "auto" || gpuLayers === "all" || !layers ? 1 : Math.min(1, Math.max(0, gpuLayers / layers));
  const cacheScale = kvCache === "q8_0" ? 0.53 : kvCache === "q4_0" ? 0.28 : 1;
  const weights = sizeBytes * share;
  const cache = kvBytesPerToken && contextTokens ? kvBytesPerToken * contextTokens * cacheScale * share : null;
  const need = weights + (cache ?? 0) + OVERHEAD_GB * GiB;
  const card = gpuTotalMiB * 1024 ** 2;
  const verdict = need <= card * TIGHT_SHARE ? "fits" : need <= card ? "tight" : "spills";
  return { weights, cache, need, card, verdict, cacheKnown: cache !== null };
}

const VERDICT_TEXT = {
  fits: "Fits on the graphics card",
  tight: "Tight: close to the card's limit",
  spills: "Partly in system memory: it runs, but slower",
};

export function openAddModel({ onSaved, edit = null } = {}) {
  let discover = null;          // GET /api/models/discover
  let picked = null;            // the file or server being set up
  let tab = edit ? null : "found";
  let saving = false;

  const dialog = el("dialog", "add-model");
  dialog.setAttribute("aria-label", edit ? "Model settings" : "Add a model");
  const shell = el("div", "add-shell");
  dialog.append(shell);
  document.body.append(dialog);

  const close = () => {
    dialog.classList.add("is-closing");
    setTimeout(() => { dialog.close(); dialog.remove(); }, 140);
  };
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(); });
  dialog.addEventListener("click", (event) => { if (event.target === dialog) close(); });

  // ---- header -----------------------------------------------------------------------------
  const title = el("h2", "add-title", edit ? "Model settings" : "Add a model");
  const sub = el("p", "add-sub", edit
    ? "Changes apply the next time the model loads."
    : "Pick a model file on this PC, or connect to a server you already run.");
  const closeBtn = el("button", "add-close");
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
  closeBtn.addEventListener("click", close);
  const head = el("header", "add-head");
  const headText = el("div", "add-head-text");
  headText.append(title, sub);
  head.append(headText, closeBtn);

  const tabs = el("div", "add-tabs");
  tabs.setAttribute("role", "tablist");
  const tabDefs = [["found", "On this PC"], ["file", "From a path"], ["server", "Running server"]];
  const tabButtons = tabDefs.map(([id, label]) => {
    const b = el("button", "add-tab", label);
    b.type = "button";
    b.setAttribute("role", "tab");
    b.dataset.tab = id;
    b.addEventListener("click", () => { tab = id; picked = null; draw(); });
    tabs.append(b);
    return b;
  });

  const body = el("div", "add-body");
  const errorLine = el("p", "add-error");
  errorLine.hidden = true;
  const foot = el("footer", "add-foot");
  shell.append(head, edit ? el("span") : tabs, body, errorLine, foot);

  const showError = (text) => { errorLine.textContent = text || ""; errorLine.hidden = !text; };

  // ---- step 1: choose -------------------------------------------------------------------------
  function drawFound() {
    const wrap = el("div", "add-pane");
    if (!discover) { wrap.append(loadingLine("Looking for model files…")); return wrap; }
    const list = discover.models;
    const head = el("div", "add-pane-head");
    head.append(el("span", "add-pane-count", list.length
      ? `${list.length} model file${list.length === 1 ? "" : "s"} found`
      : "No model files found in the usual folders."));
    const folderBtn = el("button", "add-link", "Search another folder");
    folderBtn.type = "button";
    folderBtn.title = `Searched: ${discover.folders.join("; ")}`;
    folderBtn.addEventListener("click", () => { folderRow.hidden = !folderRow.hidden; if (!folderRow.hidden) folderInput.focus(); });
    head.append(folderBtn);
    const folderInput = el("input", "field-control mono-control");
    folderInput.placeholder = "C:\\Models";
    folderInput.setAttribute("aria-label", "Folder to search");
    const folderGo = button({ kind: "secondary", small: true, text: "Search it", onClick: async () => {
      showError("");
      try {
        discover = await api("POST", "/api/models/folders", { path: folderInput.value.trim() });
        draw();
      } catch (error) { showError(error.message); }
    } });
    folderInput.addEventListener("keydown", (e) => { if (e.key === "Enter") folderGo.click(); });
    const folderRow = el("div", "add-inline");
    folderRow.hidden = true;
    folderRow.append(folderInput, folderGo);
    wrap.append(head, folderRow);

    const rows = el("div", "add-list");
    rows.setAttribute("role", "list");
    for (const m of list) {
      const row = el("button", "add-row");
      row.type = "button";
      row.setAttribute("role", "listitem");
      row.disabled = m.added;
      const fit = estimateFit({ ...m, contextTokens: Math.min(m.contextLength ?? 8192, 32768), gpuLayers: "auto", kvCache: "f16", gpuTotalMiB: discover.gpuTotalMiB });
      const name = el("span", "add-row-name", m.name);
      name.title = m.path;
      const meta = el("span", "add-row-meta");
      meta.append(...[m.quant, m.architecture, m.contextLength ? `${fmtCtx(m.contextLength)} context` : null]
        .filter(Boolean).map((t) => el("span", "", t)));
      if (m.projector) meta.append(el("span", "add-badge", "vision"));
      const left = el("span", "add-row-left");
      left.append(name, meta);
      const size = el("span", "add-row-size", fmtGB(m.sizeBytes));
      const right = el("span", "add-row-right");
      if (m.added) right.append(el("span", "add-tag", "Added"));
      else {
        if (fit) right.append(fitDot(fit));
        right.append(chevron());
      }
      row.append(left, size, right);
      row.addEventListener("click", () => pick({ kind: "gguf", file: m }));
      rows.append(row);
    }
    wrap.append(rows);
    if (discover.truncated) wrap.append(el("p", "add-pane-note", "The search stopped early; add the folder your model is in to search it fully."));
    return wrap;
  }

  function drawFile() {
    const wrap = el("div", "add-pane");
    const input = el("input", "field-control mono-control add-path");
    input.placeholder = "C:\\Models\\Qwen3-8B-Q4_K_M.gguf";
    input.setAttribute("aria-label", "Path to a .gguf model file");
    const go = button({ kind: "primary", small: true, text: "Continue", onClick: async () => {
      showError("");
      const path = input.value.trim().replace(/^"(.*)"$/, "$1");
      if (!path) { showError("Paste the path to a .gguf file."); return; }
      go.disabled = true;
      try { pick({ kind: "gguf", file: await api("POST", "/api/models/inspect", { path }) }); }
      catch (error) { showError(error.message); go.disabled = false; }
    } });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") go.click(); });
    const row = el("div", "add-inline");
    row.append(input, go);
    wrap.append(el("label", "add-label", "Path to the model file"), row,
      el("p", "add-pane-note", "Tip: in File Explorer, hold Shift, right-click the file and choose “Copy as path”. Split models: give the first part (…-00001-of-…)."));
    setTimeout(() => input.focus(), 30);
    return wrap;
  }

  function drawServer() {
    const wrap = el("div", "add-pane");
    if (!discover) { wrap.append(loadingLine("Looking for running servers…")); return wrap; }
    const servers = discover.servers;
    if (servers.length) {
      const list = el("div", "add-list");
      for (const s of servers) {
        for (const id of s.models) {
          const added = s.added?.includes(id);
          const row = el("button", "add-row");
          row.type = "button";
          row.disabled = added;
          const left = el("span", "add-row-left");
          const meta = el("span", "add-row-meta");
          meta.append(el("span", "", s.label), el("span", "", `port ${s.port}`));
          left.append(el("span", "add-row-name", id), meta);
          const right = el("span", "add-row-right");
          if (added) right.append(el("span", "add-tag", "Added"));
          else right.append(el("span", "add-row-go", "Connect"), chevron());
          row.append(left, el("span", "add-row-size"), right);
          row.addEventListener("click", () => pick({ kind: "external", port: s.port, serverModel: id, label: s.label }));
          list.append(row);
        }
      }
      wrap.append(el("span", "add-pane-note", "Running now on this PC"), list);
    } else {
      wrap.append(el("p", "add-pane-note", "No running server found on the usual ports (LM Studio 1234, Ollama 11434, vLLM 8000)."));
    }
    const portInput = el("input", "field-control mono-control add-port");
    portInput.inputMode = "numeric";
    portInput.placeholder = "1234";
    portInput.setAttribute("aria-label", "Server port");
    const check = button({ kind: "secondary", small: true, text: "Check port", onClick: async () => {
      showError("");
      const port = Number(portInput.value);
      try {
        const found = await api("POST", "/api/models/probe", { port });
        if (!found.models.length) { showError(`The server on port ${port} lists no models.`); return; }
        discover.servers = [...discover.servers.filter((s) => s.port !== port), { port, label: "Server", models: found.models, added: [] }];
        draw();
      } catch (error) { showError(error.message); }
    } });
    portInput.addEventListener("keydown", (e) => { if (e.key === "Enter") check.click(); });
    const row = el("div", "add-inline");
    row.append(el("span", "add-inline-label", "Another port"), portInput, check);
    wrap.append(row, el("p", "add-pane-note", "Local Arena connects without stopping it. LM Studio, Ollama and a llama-server you started yourself keep running when you load another model, and keep using the graphics card."));
    return wrap;
  }

  // ---- step 2: settings -------------------------------------------------------------------------
  const form = {};
  function pick(choice) {
    showError("");
    picked = choice;
    if (choice.kind === "gguf") {
      const f = choice.file;
      const s = edit?.settings ?? {};
      Object.assign(form, {
        name: edit?.name ?? f.name,
        version: edit?.version ?? (f.quant || ""),
        contextTokens: s.contextTokens ?? Math.min(f.contextLength ?? 8192, 32768),
        gpuLayers: s.gpuLayers ?? "auto",
        flashAttn: s.flashAttn ?? "auto",
        kvCache: s.kvCache ?? "f16",
        runtime: s.runtime ?? discover?.runtimes?.[0] ?? "",
        useProjector: edit ? Boolean(s.projector) : Boolean(f.projector),
        extraArgs: s.extraArgs ?? "",
        note: edit?.note ?? "",
      });
    } else {
      Object.assign(form, { name: edit?.name ?? choice.serverModel, version: edit?.version ?? choice.label ?? "", contextTokens: edit?.contextTokens ?? null, note: edit?.note ?? "" });
    }
    draw();
  }

  function field(label, control, hint) {
    const wrap = el("label", "add-field");
    wrap.append(el("span", "add-label", label), control);
    if (hint) wrap.append(el("span", "add-hint", hint));
    return wrap;
  }

  function textInput(key, { mono = false, placeholder = "" } = {}) {
    const input = el("input", `field-control${mono ? " mono-control" : ""}`);
    input.value = form[key] ?? "";
    input.placeholder = placeholder;
    input.addEventListener("input", () => { form[key] = input.value; });
    return input;
  }

  function select(key, options, onChange) {
    const node = el("select", "field-control");
    for (const [value, label] of options) {
      const opt = el("option", "", label);
      opt.value = String(value);
      node.append(opt);
    }
    node.value = String(form[key]);
    node.addEventListener("change", () => {
      const raw = node.value;
      form[key] = /^\d+$/.test(raw) ? Number(raw) : raw;
      onChange?.();
    });
    return node;
  }

  function segmented(key, options, onChange) {
    const group = el("div", "add-seg");
    group.setAttribute("role", "radiogroup");
    const buttons = options.map(([value, label]) => {
      const b = el("button", "add-seg-btn", label);
      b.type = "button";
      b.setAttribute("role", "radio");
      b.addEventListener("click", () => { form[key] = value; sync(); onChange?.(); });
      group.append(b);
      return [value, b];
    });
    const sync = () => buttons.forEach(([value, b]) => {
      b.classList.toggle("on", form[key] === value);
      b.setAttribute("aria-checked", String(form[key] === value));
    });
    sync();
    return group;
  }

  function drawSettings() {
    const wrap = el("div", "add-pane add-settings");
    if (picked.kind === "external") {
      const summary = el("div", "add-summary");
      summary.append(el("span", "add-summary-name", picked.serverModel), el("span", "add-summary-meta", `${picked.label ?? "Server"} · port ${picked.port}`));
      const ctx = el("input", "field-control mono-control");
      ctx.inputMode = "numeric";
      ctx.placeholder = "optional, e.g. 32768";
      ctx.value = form.contextTokens ?? "";
      ctx.addEventListener("input", () => { form.contextTokens = Number(ctx.value) || null; });
      wrap.append(summary,
        el("div", "add-grid"),
      );
      wrap.lastChild.append(field("Name in Local Arena", textInput("name")), field("Label", textInput("version", { placeholder: "LM Studio" })),
        field("Context limit (tokens)", ctx, "Only for the panel's context meter. The server decides the real limit."));
      wrap.append(field("Note", textInput("note", { placeholder: "Anything worth remembering about this model" })));
      return wrap;
    }

    const f = picked.file;
    const summary = el("div", "add-summary");
    const meta = [f.architecture, f.quant, fmtGB(f.sizeBytes), f.layers ? `${f.layers} layers` : null, f.experts ? `${f.experts} experts` : null, f.contextLength ? `trained for ${fmtCtx(f.contextLength)}` : null].filter(Boolean).join(" · ");
    summary.append(el("span", "add-summary-name", f.file), el("span", "add-summary-meta", meta));
    summary.title = f.path;

    // fit meter: updates as settings change
    const fitMeter = segMeter({ min: 0, max: 100, variant: "bar" });
    const fitText = el("span", "add-fit-text");
    const fitNumbers = el("span", "add-fit-numbers");
    const fitBox = el("div", "add-fit");
    const fitHead = el("div", "add-fit-head");
    fitHead.append(fitText, fitNumbers);
    fitBox.append(fitHead, fitMeter);
    const updateFit = () => {
      const fit = estimateFit({ ...f, contextTokens: form.contextTokens, gpuLayers: form.gpuLayers, kvCache: form.kvCache, gpuTotalMiB: discover?.gpuTotalMiB });
      fitBox.hidden = !fit;
      if (!fit) return;
      fitBox.dataset.verdict = fit.verdict;
      fitText.textContent = VERDICT_TEXT[fit.verdict];
      fitNumbers.textContent = `about ${(fit.need / GiB).toFixed(1)} of ${(fit.card / GiB).toFixed(1)} GB`
        + (fit.cacheKnown ? ` · cache ${(fit.cache / GiB).toFixed(1)} GB` : " · cache size unknown");
      fitMeter.querySelector(".seg-meter").style.setProperty("--meter-color", fit.verdict === "fits" ? "var(--color-ok)" : fit.verdict === "tight" ? "var(--color-accent)" : "var(--color-bad)");
      fitMeter.set(Math.min(100, (fit.need / fit.card) * 100));
    };

    const maxCtx = f.contextLength ?? 262144;
    const ctxOptions = CONTEXT_STEPS.filter((c) => c <= maxCtx);
    if (!ctxOptions.includes(form.contextTokens)) ctxOptions.push(form.contextTokens);
    ctxOptions.sort((a, b) => a - b);
    const ctxSelect = select("contextTokens", ctxOptions.map((c) => [c, `${fmtCtx(c)} tokens${c === maxCtx ? " (model max)" : ""}`]), updateFit);

    const layerOptions = [["auto", "Auto"], ["all", "All"]];
    const layersInput = el("input", "field-control mono-control add-layers");
    layersInput.inputMode = "numeric";
    layersInput.placeholder = f.layers ? `0–${f.layers}` : "number";
    layersInput.value = typeof form.gpuLayers === "number" ? String(form.gpuLayers) : "";
    layersInput.addEventListener("input", () => {
      const n = Number(layersInput.value);
      if (layersInput.value.trim() !== "" && Number.isInteger(n) && n >= 0) { form.gpuLayers = n; layerSeg.querySelectorAll(".add-seg-btn").forEach((b) => b.classList.remove("on")); }
      updateFit();
    });
    const layerSeg = segmented("gpuLayers", layerOptions, () => { layersInput.value = ""; updateFit(); });
    const layerRow = el("div", "add-inline");
    layerRow.append(layerSeg, layersInput);

    const runtimes = discover?.runtimes ?? [];
    const runtimeChoices = [...new Set([form.runtime, ...runtimes].filter(Boolean))];
    const runtimeSelect = runtimeChoices.length
      ? select("runtime", runtimeChoices.map((p) => [p, shortPath(p)]))
      : textInput("runtime", { mono: true, placeholder: "C:\\llama.cpp\\llama-server.exe" });

    const grid = el("div", "add-grid");
    grid.append(
      field("Name in Local Arena", textInput("name")),
      field("Version", textInput("version", { mono: true })),
      field("Context limit", ctxSelect, "More room to read and remember, more graphics memory."),
      field("Layers on the graphics card", layerRow, "Auto lets llama-server decide. Fewer layers: slower, less memory."),
      field("Cache precision", segmented("kvCache", [["f16", "Full"], ["q8_0", "8-bit"], ["q4_0", "4-bit"]], updateFit), "Smaller cache fits longer chats, at a small quality cost."),
      field("Flash attention", segmented("flashAttn", [["auto", "Auto"], ["on", "On"], ["off", "Off"]]), "Faster and lighter on most cards. Auto is the safe choice."),
    );

    const advanced = el("details", "add-advanced");
    const summaryLine = el("summary", "", "Advanced");
    const adv = el("div", "add-grid");
    adv.append(field("llama-server program", runtimeSelect, runtimes.length ? null : "No llama-server found. Paste the path to llama-server.exe."));
    if (f.projector) {
      const vision = el("label", "check add-check");
      const box = el("input");
      box.type = "checkbox";
      box.checked = form.useProjector;
      box.addEventListener("change", () => { form.useProjector = box.checked; });
      vision.append(box, "Load the vision file, so the model can read images");
      adv.append(vision);
    }
    adv.append(field("Extra llama-server flags", textInput("extraArgs", { mono: true, placeholder: "--temp 0.7 --top-k 20" }), "Anything llama-server accepts, except the model, port and host."));
    adv.append(field("Note", textInput("note", { placeholder: "Anything worth remembering about this model" })));
    advanced.append(summaryLine, adv);
    if (!runtimes.length || form.extraArgs) advanced.open = true;

    wrap.append(summary, fitBox, grid, advanced);
    updateFit();
    return wrap;
  }

  // ---- save ----------------------------------------------------------------------------------
  async function save() {
    if (saving) return;
    showError("");
    saving = true;
    draw();
    try {
      let payload;
      if (picked.kind === "external") {
        payload = { kind: "external", name: form.name, version: form.version, port: picked.port, serverModel: picked.serverModel, contextTokens: form.contextTokens, note: form.note };
      } else {
        payload = {
          kind: "gguf", name: form.name, version: form.version, note: form.note,
          settings: {
            modelPath: picked.file.path, runtime: form.runtime, contextTokens: form.contextTokens,
            gpuLayers: form.gpuLayers, flashAttn: form.flashAttn, kvCache: form.kvCache, extraArgs: form.extraArgs,
            projector: form.useProjector && picked.file.projector ? picked.file.projector : "",
          },
        };
      }
      const result = edit ? await api("PUT", `/api/models/${encodeURIComponent(edit.id)}`, payload) : await api("POST", "/api/models", payload);
      toast({ text: edit ? `${result.model.name} saved` : `${result.model.name} added`, ms: 3500 });
      close();
      onSaved?.(result.model);
    } catch (error) {
      saving = false;
      showError(error.message);
      draw();
    }
  }

  // ---- drawing ---------------------------------------------------------------------------------
  function draw() {
    tabButtons.forEach((b) => {
      const on = !picked && b.dataset.tab === tab;
      b.classList.toggle("on", on);
      b.setAttribute("aria-selected", String(on));
    });
    tabs.hidden = Boolean(picked);
    title.textContent = edit ? "Model settings" : picked ? "Set it up" : "Add a model";
    sub.textContent = edit ? "Changes apply the next time the model loads."
      : picked?.kind === "external" ? "Local Arena connects to this server. Loading it never stops anything."
        : picked ? "Sensible defaults are already chosen. You can change them later from the model's menu."
          : "Pick a model file on this PC, or connect to a server you already run.";
    let pane;
    if (picked) pane = drawSettings();
    else if (tab === "found") pane = drawFound();
    else if (tab === "file") pane = drawFile();
    else pane = drawServer();
    body.replaceChildren(pane);

    foot.replaceChildren();
    if (picked) {
      if (!edit) foot.append(button({ kind: "ghost", text: "Back", onClick: () => { picked = null; showError(""); draw(); } }));
      const saveBtn = button({ kind: "primary", text: saving ? "Saving…" : edit ? "Save" : "Add model", onClick: save });
      saveBtn.disabled = saving;
      saveBtn.classList.add("add-save");
      foot.append(el("span", "add-foot-spacer"), saveBtn);
    }
    foot.hidden = !picked;
  }

  dialog.showModal();
  draw();
  api("GET", "/api/models/discover")
    .then((data) => {
      discover = data;
      if (edit) {
        if (edit.engine === "external") pick({ kind: "external", port: edit.port, serverModel: edit.matchId, label: edit.version });
        else return api("POST", "/api/models/inspect", { path: edit.settings?.modelPath }).then((file) => pick({ kind: "gguf", file }));
      }
      draw();
      return null;
    })
    .catch((error) => {
      discover = { models: [], folders: [], servers: [], runtimes: [], gpuTotalMiB: null };
      showError(error.message);
      draw();
    });
  return close;
}

function loadingLine(text) {
  const line = el("div", "add-loading");
  line.append(el("span", "add-spinner"), el("span", "", text));
  return line;
}

function fitDot(fit) {
  const node = el("span", `add-fit-dot ${fit.verdict}`);
  const need = `needs about ${(fit.need / GiB).toFixed(1)} of ${(fit.card / GiB).toFixed(0)} GB at 32K`;
  node.title = `${VERDICT_TEXT[fit.verdict]}: ${need}`;
  node.append(el("span", "dot"), el("span", "", fit.verdict === "fits" ? "Fits on GPU" : fit.verdict === "tight" ? "Tight fit" : "Partly on CPU"));
  return node;
}

function chevron() {
  const node = el("span", "add-row-chev");
  node.innerHTML = '<svg width="8" height="12" viewBox="0 0 8 12" aria-hidden="true"><path d="M2 2l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  return node;
}

function shortPath(path) {
  const parts = String(path).split(/[\\/]/);
  return parts.length > 3 ? `…\\${parts.slice(-3).join("\\")}` : path;
}
