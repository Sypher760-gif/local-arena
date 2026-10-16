export const name = "94-arena-model-identity";

export async function run(t) {
  await t.killEngine();
  await t.startEngine(["--wps", "1000"]);
  await t.open("arena");
  await t.waitFor(`!document.querySelector('.arena-start')?.disabled`, 20000);
  const picks = await t.eval(`(() => {
    const selects = [...document.querySelectorAll('.arena-select')];
    if(!selects.every(s => [...s.options].some(o => o.value === 'switch-b-q4'))) return false;
    for(const select of selects) { select.value='switch-b-q4'; select.dispatchEvent(new Event('change',{bubbles:true})); }
    return selects.map(s => s.value);
  })()`);
  t.assert(picks && picks.every(id => id === "switch-b-q4"), "live picker did not use catalogue entries");
  await t.click(".arena-start");
  await t.waitFor(`!document.querySelector('.arena-vote-a')?.disabled`, 45000);
  const requests = (await t.fakeRequests()).filter(r => r.stream === true);
  t.assert(requests.length === 2 && requests.every(r => r.model === "switch-b-q4"), "Arena did not ask the selected model on both sides");
  await t.click(".arena-vote-a");
  await t.waitFor(`document.querySelector('.arena-note')?.textContent.includes('Vote recorded')`);
  const items = await t.storeList("votes");
  const vote = await t.storeGet("votes", items[0].id);
  t.assert(vote.modelA === "switch-b-q4" && vote.modelB === "switch-b-q4", "vote recorded different model identities from the requests");
  await t.eval(`fetch('/api/store/votes/${vote.id}',{method:'DELETE'}).then(() => true)`);
  await t.killEngine();
  await t.startEngine(["--wps", "1000"]);
}
