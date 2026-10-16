// Per-model settings: every model's ⋯ menu opens Settings with Reply and Load tabs. Reply settings
// saved for the loaded model reach the engine on the next request (Chat here); the row shows a
// Customized tag; the Load tab of a model with its own launcher is read-only; Reset clears it all.
export const name = "91-model-settings";

const ROW = `.live-model-row[data-model-id="switch-b-q4"]`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function run(t) {
  await t.open("models");
  await t.waitFor(`!!document.querySelector('${ROW} .live-more')`, 10000);

  // Load the model first, so its saved settings apply to the next reply.
  await t.click(`${ROW} .live-load-btn`);
  await t.waitFor(`!!document.querySelector('${ROW} .live-confirm-load')`);
  await t.click(`${ROW} .live-confirm-load`);
  await t.waitFor(`document.querySelector('${ROW}').classList.contains("loaded")`, 20000);

  // ⋯ > Settings opens the panel on the Reply tab.
  await t.click(`${ROW} .live-more`);
  await t.waitFor(`!!document.querySelector(".ctx-menu")`);
  await t.eval(`[...document.querySelectorAll(".ctx-menu [role=menuitem]")].find((b) => b.textContent.startsWith("Settings")).click()`);
  await t.waitFor(`!!document.querySelector("dialog.model-settings[open]")`);
  t.assert(await t.eval(`document.querySelector(".ms-tag").hidden`), "a fresh model shows Customized");

  await t.eval(`(() => {
    const set = (key, value) => { const i = document.querySelector('.ms-num[data-key="' + key + '"]'); i.value = value; i.dispatchEvent(new Event("change")); };
    set("temperature", "0.2");
    set("topK", "33");
    const stop = document.querySelector(".ms-stop"); stop.value = "###, END"; stop.dispatchEvent(new Event("change"));
  })()`);
  t.assert(!(await t.eval(`document.querySelector(".ms-tag").hidden`)), "Customized tag shows after a change");

  // The Load tab of a model with its own launcher only describes it.
  await t.click('.ms-tabs .add-tab[data-tab="load"]');
  t.assert(await t.exists(".ms-pane .ms-cmd"), "read-only Load tab shows the launch command");
  t.assert(await t.count(".ms-pane .add-seg") === 0, "read-only Load tab has no controls");

  await t.click(".ms-save");
  await t.waitFor(`!document.querySelector("dialog.model-settings")`, 5000);
  await t.waitFor(`!!document.querySelector('${ROW} .model-custom-tag')`, 10000);
  const saved = await t.eval(`fetch("/api/models").then((r) => r.json()).then((d) => d.models.find((m) => m.id === "switch-b-q4").tuning)`);
  t.assert(saved?.reply?.temperature === 0.2 && saved.reply.topK === 33, `saved: ${JSON.stringify(saved)}`);

  // A Chat reply now carries the model's own settings, over Chat's.
  await t.open("chat");
  await t.click(".chat-list-head .btn");
  await t.waitFor(`document.querySelector(".chat-empty") !== null`);
  const before = (await t.fakeRequests()).length;
  await t.type(".chat-input", "hello");
  await t.waitFor(`!document.querySelector(".chat-composer-bar .btn-primary").disabled`);
  await t.click(".chat-composer-bar .btn-primary");
  let requests = await t.fakeRequests();
  for (let i = 0; i < 40 && requests.length <= before; i += 1) { await sleep(250); requests = await t.fakeRequests(); }
  await t.waitFor(`!document.querySelector(".chat-writing")`, 30000);
  const last = requests[requests.length - 1];
  t.assert(last.temperature === 0.2, `temperature sent ${last.temperature}, want 0.2`);
  t.assert(last.top_k === 33, `top_k sent ${last.top_k}, want 33`);
  t.assert(JSON.stringify(last.stop) === '["###","END"]', `stop sent ${JSON.stringify(last.stop)}`);

  // Reset clears it: the tag goes, the next request is back to Chat's own temperature.
  await t.open("models");
  await t.waitFor(`!!document.querySelector('${ROW} .model-custom-tag')`, 10000);
  await t.click(`${ROW} .live-more`);
  await t.waitFor(`!!document.querySelector(".ctx-menu")`);
  await t.eval(`[...document.querySelectorAll(".ctx-menu [role=menuitem]")].find((b) => b.textContent.startsWith("Settings")).click()`);
  await t.waitFor(`!!document.querySelector("dialog.model-settings[open]")`);
  await t.click(".ms-reset");
  await t.waitFor(`!document.querySelector('${ROW} .model-custom-tag')`, 10000);
  const cleared = await t.eval(`fetch("/api/models").then((r) => r.json()).then((d) => d.models.find((m) => m.id === "switch-b-q4").tuning)`);
  t.assert(JSON.stringify(cleared) === "{}", `after reset: ${JSON.stringify(cleared)}`);
}
