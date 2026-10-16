// Tests with the engine killed and no saved runs: it tells the user to load a model and says there are no runs yet.
export const name = "56-tests-states";

export async function run(t) {
  t.allowErrors();
  await t.killEngine();
  await t.eval(`(async () => {
    const res = await fetch('/api/store/runs');
    const items = (await res.json()).items ?? [];
    await Promise.all(items.map((i) => fetch('/api/store/runs/' + i.id, { method: 'DELETE' })));
    return items.length;
  })()`);
  await t.open("tests");
  await t.waitFor(`document.querySelector(".setup-model-text")?.innerText.includes("Load a model to run the tests")`, 12000);
  const text = await t.eval("document.body.innerText");
  t.assert(text.includes("Load a model to run the tests"), "tests does not tell the user to load a model");
  t.assert(text.includes("No runs yet"), "tests does not say there are no runs yet");
  t.assert(text.includes("not answering"), "tests does not show the engine-not-answering state");
  await t.startEngine();
}
