// After a slow start (engine.warmup.slow) the Models screen shows the plain sentence and a
// "Reload model" button; a fast (or absent) warm-up shows neither. The engine polls /api/status
// every 3 s, but the check does not wait on the gateway: it feeds the status object through the
// engine's own handler (the same code the gateway's replies go through), then lets the screen
// re-render from the engine's change event.
export const name = "80-slow-start";

const SLOW = "This model started slowly";
const RELOAD = ".reload-model-btn";

async function applyWarmup(t, warmup) {
  await t.eval(`(() => {
    const engine = globalThis.benchEngine;
    engine.applyWarmupForTest(globalThis.benchEngine.loadedModelId, ${JSON.stringify(warmup)});
    return true;
  })()`);
}

export async function run(t) {
  await t.open("models");
  await t.waitFor('document.querySelectorAll(".live-model-row").length === 2');

  // A model must be loaded first (the screen's warm-up line belongs to the loaded model).
  await t.waitFor('globalThis.benchEngine.loadedModelId !== null', 15000);

  // Slow warm-up: the sentence and the button appear.
  await applyWarmup(t, { tokensPerSecond: 3.6, usual: 45, slow: true });
  await t.waitFor(`document.body.innerText.includes(${JSON.stringify(SLOW)})`, 8000);
  const sentence = await t.eval(`document.body.innerText.split("\\n").find((l) => l.includes(${JSON.stringify(SLOW)})) ?? ""`);
  t.assert(sentence.includes("3.6 tokens per second") && sentence.includes("it usually does 45"),
    `slow sentence is the plain one: "${sentence}"`);
  t.assert(await t.exists(RELOAD), "Reload model button shows after a slow start");

  // Fast warm-up: neither shows. (The button is in the DOM but its notice box is hidden.)
  const reloadVisible = `!!document.querySelector("${RELOAD}") && !document.querySelector("${RELOAD}").closest(".notice").hidden`;
  await applyWarmup(t, { tokensPerSecond: 45, usual: 45, slow: false });
  await t.waitFor(`!document.body.innerText.includes(${JSON.stringify(SLOW)})`, 8000);
  t.assert(!(await t.eval(reloadVisible)), "no Reload model button after a fast start");

  // No warm-up at all: neither shows either.
  await applyWarmup(t, null);
  await t.waitFor(`!document.body.innerText.includes(${JSON.stringify(SLOW)})`, 8000);
  t.assert(!(await t.eval(reloadVisible)), "no Reload model button when warmup is unknown");

  // Clicking Reload model actually asks the engine to load the loaded model again.
  await applyWarmup(t, { tokensPerSecond: 3.6, usual: 45, slow: true });
  await t.waitFor(`!document.querySelector("${RELOAD}").closest(".notice").hidden`, 8000);
  await t.click(RELOAD);
  // The switch starts: loading state appears with a stage label.
  await t.waitFor(`globalThis.benchEngine.loading !== null && globalThis.benchEngine.loading.direction === "load"`, 10000);
  // The fake switch takes a few seconds; let it finish so the next check starts clean.
  await t.waitFor(`globalThis.benchEngine.loading === null`, 60000);
}
