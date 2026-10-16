// Chat settings are saved to the store (settings/chat) and come back after a reload.
export const name = "44-settings-saved";

const CHIP_TEXT = "#topbar .chip";
const CHIPS = ".chat-chips";
const TEMP_INPUT = ".chat-setting-input";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function clearSettings(t) {
  await t.eval(`(async () => {
    const res = await fetch('/api/store/settings');
    const items = (await res.json()).items ?? [];
    await Promise.all(items.map((i) => fetch('/api/store/settings/' + i.id, { method: 'DELETE' })));
    return items.length;
  })()`);
}

async function waitForSetting(t) {
  for (let i = 0; i < 80; i += 1) {
    const items = await t.storeList("settings");
    if (items.some((i) => i.id === "chat")) {
      const rec = await t.storeGet("settings", "chat");
      if (rec && Number(rec.temperature) === 0.3) return rec;
    }
    await sleep(250);
  }
  return null;
}

export async function run(t) {
  await clearSettings(t);
  await t.reload();
  await t.waitFor(`[...document.querySelectorAll("${CHIP_TEXT}")].some((c) => c.innerText.includes("fake-model"))`);

  await t.click(".chat-settings-toggle");
  await t.eval(`(() => {
    const temperature = document.querySelectorAll("${TEMP_INPUT}")[0];
    temperature.value = "0.3";
    temperature.dispatchEvent(new Event("change"));
  })()`);
  await t.waitFor(`document.querySelector("${CHIPS}")?.innerText.includes("temp 0.3")`);

  const rec = await waitForSetting(t);
  t.assert(rec, "settings/chat never reached the store with temperature 0.3");
  t.assert(Number(rec.temperature) === 0.3, `stored temperature is ${rec.temperature}, want 0.3`);

  // Drop the localStorage copy so the reloaded value can only come from the store.
  await t.eval(`localStorage.removeItem("bench.chat.settings")`);
  await t.reload();
  await t.waitFor(`[...document.querySelectorAll("${CHIP_TEXT}")].some((c) => c.innerText.includes("fake-model"))`);
  await t.waitFor(`document.querySelector("${CHIPS}")?.innerText.includes("temp 0.3")`, 8000);
  const value = await t.eval(`Number(document.querySelectorAll("${TEMP_INPUT}")[0].value)`);
  t.assert(value === 0.3, `temperature after reload is ${value}, want 0.3`);

  const stored = await t.storeGet("settings", "chat");
  t.assert(Number(stored.temperature) === 0.3, `storeGet temperature is ${stored.temperature}, want 0.3`);
}
