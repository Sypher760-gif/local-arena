// Models with the engine killed and a fresh store: it still lists the models and says the engine is not answering.
export const name = "54-models-states";

export async function run(t) {
  t.allowErrors();
  await t.killEngine();
  await t.open("models");
  await t.waitFor(`document.querySelector(".live-model-row") !== null`, 12000);
  await t.waitFor(`document.querySelector("#topbar .chip")?.innerText.includes("not answering")`, 12000);
  const rows = await t.count(".live-model-row");
  t.assert(rows > 0, `models screen is blank: ${rows} model rows`);
  const text = await t.eval("document.body.innerText");
  t.assert(text.includes("not answering"), "models screen does not say the engine is not answering");
  await t.startEngine();
}
