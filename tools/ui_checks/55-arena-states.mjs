// Arena with the engine killed and no saved votes: it says the engine is not answering and no votes are saved.
export const name = "55-arena-states";

export async function run(t) {
  t.allowErrors();
  await t.killEngine();
  await t.eval(`(async () => {
    const res = await fetch('/api/store/votes');
    const items = (await res.json()).items ?? [];
    await Promise.all(items.map((i) => fetch('/api/store/votes/' + i.id, { method: 'DELETE' })));
    return items.length;
  })()`);
  await t.open("arena");
  await t.waitFor(`document.querySelector(".arena-note")?.innerText.includes("not answering")`, 12000);
  await t.waitFor(`document.querySelector(".arena-record-note") && !document.querySelector(".arena-record-note").hidden`, 12000);
  const text = await t.eval("document.body.innerText");
  t.assert(text.includes("not answering"), "arena does not show the engine-not-answering state");
  t.assert(text.includes("No votes saved yet"), "arena does not say no votes are saved");
  t.assert(await t.eval(`document.querySelector(".arena-start").disabled === true`), "arena Start is enabled with no model loaded");
  await t.startEngine();
}
