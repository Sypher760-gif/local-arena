// The live Models table is built from GET /api/models. Load shows a confirm, then switches
// the fake engine to the chosen model; the loaded light and the top bar follow. The not-on-disk
// entry is listed but has no Load button. The gateway runs with ARENA_SWITCH_FAKE=1 and a two-entry
// catalogue (switch-b-q4 on disk, missing-model-q4 not on disk).
export const name = "50-models-switch";

const rowSel = (id) => `.live-model-row[data-model-id="${id}"]`;

export async function run(t) {
  await t.open("models");
  await t.waitFor('document.querySelectorAll(".live-model-row").length === 2');
  t.assert((await t.count(".live-model-row")) === 2, "the table lists both catalogue entries");

  const missing = rowSel("missing-model-q4");
  t.assert(await t.exists(missing), "the not-on-disk entry is listed");
  t.assert((await t.text(`${missing} .live-disk`)).includes("Not found"), "the not-on-disk entry says it is not found");
  t.assert(!(await t.exists(`${missing} .live-load-btn`)), "the not-on-disk entry has no Load button");

  const target = rowSel("switch-b-q4");
  await t.click(`${target} .live-load-btn`);
  await t.waitFor(`!!document.querySelector('${target} .live-confirm-load')`);
  const confirm = await t.text(`${target} .live-confirm-text`);
  t.assert(confirm.includes("stops the model") && confirm.includes("switch-b"), `confirm sentence: ${confirm}`);

  await t.click(`${target} .live-confirm-load`);
  await t.waitFor(`document.querySelector('${target}').classList.contains("loaded")`, 20000);

  await t.waitFor('document.querySelector("#topbar .chip").innerText.includes("switch-b")', 10000);
}
