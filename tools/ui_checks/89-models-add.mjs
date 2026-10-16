// Models: "Add model" opens a dialog; a .gguf path is read (name, compression, context), the
// settings step shows a fit estimate, saving lists the model as "Added", it loads through the normal
// switch, its menu edits settings and removes it. The hand-kept list is never offered for removal.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const name = "89-models-add";

function gguf() {
  const parts = [];
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const str = (s) => Buffer.concat([u64(Buffer.byteLength(s)), Buffer.from(s)]);
  const kv = [
    Buffer.concat([str("general.architecture"), u32(8), str("llama")]),
    Buffer.concat([str("general.name"), u32(8), str("Check Model")]),
    Buffer.concat([str("llama.context_length"), u32(4), u32(16384)]),
    Buffer.concat([str("llama.block_count"), u32(4), u32(24)]),
  ];
  parts.push(Buffer.from("GGUF"), u32(3), u64(0), u64(kv.length), ...kv, Buffer.alloc(1024));
  return Buffer.concat(parts);
}

// The added model's own ⋯ button (every row has one; the added row carries the "Added" tag).
const ADDED_MORE = `[...document.querySelectorAll(".live-model-row")].find((r) => r.querySelector(".model-added-tag")).querySelector(".live-more").click()`;

export async function run(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "arena-add-check-"));
  const file = path.join(dir, "Check-Model-8B-Q5_K_M.gguf");
  writeFileSync(file, gguf());
  const runtime = path.join(dir, "llama-server.exe");
  writeFileSync(runtime, "");

  await t.open("models");
  await t.waitFor(`!!document.querySelector(".add-model-btn")`);
  await t.waitFor(`document.querySelectorAll(".live-model-row").length >= 2`, 10000);   // the two test models
  const before = await t.count(".live-model-row");
  // Every model has a menu now (Settings); only added models offer Remove.
  t.assert(await t.count(".live-more") === before, "each model has a menu");

  await t.click(".add-model-btn");
  await t.waitFor(`!!document.querySelector("dialog.add-model[open]")`);
  await t.waitFor(`!document.querySelector(".add-loading")`, 20000);
  await t.click('.add-tab[data-tab="file"]');
  await t.type(".add-path", file);
  await t.eval(`document.querySelector(".add-path").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))`);
  await t.waitFor(`!!document.querySelector(".add-settings")`, 10000);

  const summary = await t.text(".add-summary-meta");
  t.assert(summary.includes("Q5_K_M") && summary.includes("24 layers") && summary.includes("16K"),
    `file summary reads "${summary}"`);
  const nameValue = await t.eval(`document.querySelector(".add-settings .add-field input").value`);
  t.assert(nameValue === "Check-Model-8B", `name is "${nameValue}", want "Check-Model-8B"`);
  t.assert(await t.eval(`document.querySelector(".add-tabs").hidden`), "the source tabs stay visible in the settings step");

  // Point it at a llama-server that exists (a stub: the check never starts it for real).
  await t.eval(`(() => {
    document.querySelector(".add-advanced").open = true;
    const sel = document.querySelector(".add-advanced select");
    if (sel) {
      const opt = document.createElement("option");
      opt.value = ${JSON.stringify(runtime)}; opt.textContent = "stub";
      sel.append(opt); sel.value = opt.value; sel.dispatchEvent(new Event("change"));
    } else {
      const input = document.querySelector(".add-advanced input.mono-control");
      input.value = ${JSON.stringify(runtime)}; input.dispatchEvent(new Event("input"));
    }
  })()`);
  // Cache 8-bit: a choice that must reach the saved settings.
  await t.eval(`[...document.querySelectorAll(".add-seg-btn")].find((b) => b.textContent === "8-bit").click()`);
  await t.click(".add-save");
  await t.waitFor(`!document.querySelector("dialog.add-model")`, 10000);
  await t.waitFor(`document.querySelectorAll(".live-model-row").length === ${before + 1}`, 10000);
  const tag = await t.text(".model-added-tag");
  t.assert(tag === "Added", `added model tag reads "${tag}"`);

  const saved = await t.eval(`fetch("/api/models").then((r) => r.json()).then((d) => d.models.find((m) => m.custom))`);
  t.assert(saved && saved.settings.kvCache === "q8_0" && saved.contextTokens === 16384 && saved.port === 8085,
    `saved model: ${JSON.stringify(saved)}`);

  // It loads through the normal switch (fake mode here).
  await t.eval(`[...document.querySelectorAll(".live-model-row")].find((r) => r.querySelector(".model-added-tag")).querySelector(".live-load-btn").click()`);
  // Load asks to confirm, as for every model.
  await t.waitFor(`!!document.querySelector(".live-model-row .live-action.confirming .btn-primary")`, 5000);
  await t.click(".live-model-row .live-action.confirming .btn-primary");
  await t.waitFor(`fetch("/api/switch/status").then((r) => r.json()).then((s) => s.state === "ready" && s.model === ${JSON.stringify(saved.id)})`, 20000);

  // Menu > Settings: rename it.
  await t.waitFor(`!document.querySelector(".live-model-row .live-load-btn[disabled]")`, 10000);
  await t.eval(ADDED_MORE);
  await t.waitFor(`!!document.querySelector(".ctx-menu")`);
  await t.eval(`[...document.querySelectorAll(".ctx-menu [role=menuitem]")].find((b) => b.textContent.startsWith("Settings")).click()`);
  // Settings opens the model's panel; its Load tab leads to the added model's own setup.
  await t.waitFor(`!!document.querySelector("dialog.model-settings[open]")`);
  await t.click('.ms-tabs .add-tab[data-tab="load"]');
  await t.click(".ms-open-load");
  await t.waitFor(`!!document.querySelector(".add-settings")`, 15000);
  t.assert((await t.text(".add-title")) === "Model settings", "edit dialog title");
  await t.eval(`(() => { const i = document.querySelector(".add-settings .add-field input"); i.value = "Renamed Check"; i.dispatchEvent(new Event("input")); })()`);
  await t.click(".add-save");
  await t.waitFor(`[...document.querySelectorAll(".model-name")].some((n) => n.textContent === "Renamed Check")`, 10000);

  // Remove is refused while loaded: the menu item is disabled.
  await t.eval(ADDED_MORE);
  await t.waitFor(`!!document.querySelector(".ctx-menu")`);
  const removeDisabled = await t.eval(`[...document.querySelectorAll(".ctx-menu [role=menuitem]")].find((b) => b.textContent.startsWith("Remove")).disabled`);
  t.assert(removeDisabled === true, "Remove is offered while the model is loaded");
  await t.eval(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);

  // Load another model, then remove the added one.
  await t.eval(`fetch("/api/switch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "switch-b-q4" }) })`);
  await t.waitFor(`fetch("/api/switch/status").then((r) => r.json()).then((s) => s.state === "ready" && s.model === "switch-b-q4")`, 20000);
  await t.waitFor(`!document.querySelector(".live-model-row.loaded .model-added-tag")`, 10000);
  await t.eval(ADDED_MORE);
  await t.waitFor(`!!document.querySelector(".ctx-menu")`);
  await t.eval(`[...document.querySelectorAll(".ctx-menu [role=menuitem]")].find((b) => b.textContent.startsWith("Remove")).click()`);
  await t.waitFor(`document.querySelectorAll(".live-model-row").length === ${before}`, 10000);
  const left = await t.eval(`fetch("/api/models").then((r) => r.json()).then((d) => d.models.filter((m) => m.custom).length)`);
  t.assert(left === 0, `${left} added models left after remove`);
}
