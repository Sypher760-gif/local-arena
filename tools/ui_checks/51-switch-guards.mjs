// During a live switch the top bar shows "Loading", Chat disables Send and says a model is
// loading, and after the switch Send works again. The gateway runs in fake-switch mode (ui_check).
export const name = "51-switch-guards";

const rowSel = (id) => `.live-model-row[data-model-id="${id}"]`;
const SEND = ".chat-composer-bar .btn-primary";

export async function run(t) {
  // A draft makes Send live before the switch, so its disable/enable is a real change.
  await t.waitFor('!document.querySelector(".chat-input").disabled', 8000);
  await t.type(".chat-input", "hello");
  await t.waitFor(`!document.querySelector("${SEND}").disabled`, 8000);

  await t.open("models");
  await t.waitFor('document.querySelectorAll(".live-model-row").length === 2');
  const target = rowSel("switch-b-q4");

  // A previous check can leave a switch still finishing; an unload asked for then is refused, and the
  // row never changes — which used to look like a 90-second hang. Wait for the app to report no switch
  // running (the gateway's own state) before asking for the unload, then allow a wide bound.
  const free = `fetch("/api/switch/status").then((r) => r.json()).then((s) => ["idle", "ready"].includes(s.state))`;
  await t.waitFor(free, 60000);

  // Check 50 may have left switch-b loaded; unload it so the next click is a Load. The unload goes
  // through the gateway, and in a full run with the browser checks running it can take longer than
  // one poll tick, so allow a wide bound rather than a guessed one.
  if (await t.exists(`${target}.loaded`)) {
    await t.click(`${target} .live-load-btn`);
    try {
      await t.waitFor(`!document.querySelector('${target}').classList.contains("loaded")`, 90000);
    } catch (error) {
      // A bare timeout hides what the app was showing; say it, so the next run has something to go on.
      const chip = await t.text("#topbar .chip").catch(() => "?");
      const button = await t.eval(`(document.querySelector('${target} .live-load-btn') || {}).textContent`);
      const progress = await t.eval(`(document.querySelector(".load-progress") || {}).textContent`);
      throw new Error(`${error.message} — top bar: "${chip}", row button: "${button}", progress: "${progress}"`);
    }
  }

  await t.click(`${target} .live-load-btn`);
  await t.waitFor(`!!document.querySelector('${target} .live-confirm-load')`);
  await t.click(`${target} .live-confirm-load`);

  // Switch running: top bar shows Loading, Chat disables Send and says a model is loading.
  await t.open("chat");
  await t.waitFor('document.querySelector("#topbar .chip").innerText.includes("Loading")', 8000);
  await t.waitFor(`document.querySelector("${SEND}").disabled`, 8000);
  t.assert((await t.text(".chat-hint")).includes("A model is loading"), "chat shows the loading sentence");

  // After the switch finishes, Send works again with the draft still there.
  await t.waitFor(`!document.querySelector(".chat-input").disabled`, 45000);
  await t.waitFor(`!document.querySelector("${SEND}").disabled`, 8000);
}
