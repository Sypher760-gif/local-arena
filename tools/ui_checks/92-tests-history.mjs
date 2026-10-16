export const name = "92-tests-history";

export async function run(t) {
  await t.killEngine();
  await t.startEngine(["--wps", "1000"]);
  await t.eval(`(async () => {
    const items = (await (await fetch('/api/store/runs')).json()).items;
    await Promise.all(items.map(i => fetch('/api/store/runs/' + i.id, {method:'DELETE'})));
    await fetch('/api/store/runs/70000', {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({
      id:70000, when:'fixture', model:'fixture', version:'Q4', totalMinutes:1, peakGB:1,
      averageTokensPerSecond:1, byType:[{type:'Logic',right:1,total:1,tokensPerSecond:1}], missed:[], missedCount:0
    })});
    const original = window.fetch;
    window.restoreHistoryFetch = () => { window.fetch = original; };
    let held = false;
    window.fetch = async (url, init) => {
      if (String(url) === '/api/store/runs' && (init?.method ?? 'GET') === 'GET' && !held) {
        held = true;
        const response = await original(url, init);
        return new Promise(resolve => { window.releaseHistory = () => resolve(response); });
      }
      return original(url, init);
    };
    return true;
  })()`);
  try {
    await t.open("tests");
    await t.waitFor(`!!window.releaseHistory && !!document.querySelector('.setup-start')`);
    t.assert(await t.eval(`document.querySelector('.setup-start').disabled`), "Tests started before saved IDs were known");
    await t.open("chat");
    await t.open("tests");
    await t.waitFor(`!document.querySelector('.setup-start')?.disabled`, 20000);
    await t.eval(`window.releaseHistory(); window.restoreHistoryFetch(); true`);
    const choices = await t.eval(`[...document.querySelectorAll('select[aria-label="Run to show"] option')].map(o => o.value)`);
    t.assert(choices.filter(id => id === "70000").length === 1, "a stale history loader duplicated a saved run");
    await t.eval(`document.querySelectorAll('.setup-type input[type=checkbox]').forEach(b => { if(b.checked) b.click(); }); true`);
    const answer = "complete-answer ".repeat(60).trim();
    const question = `[[reply:${answer}]] ${"question ".repeat(50).trim()}`;
    await t.type(".setup-custom-input", question);
    await t.click(".setup-start");
    await t.waitFor(`!!document.querySelector('.score-row') && !document.querySelector('.run-strip')`, 20000);
    await t.waitFor(`document.querySelector('select[aria-label="Run to show"]')?.value === '70001'`, 20000);
    const result = await t.storeGet("runs", "70001");
    t.assert(result.readYourself[0].answer === answer, "saved answer was truncated");
    t.assert(result.readYourself[0].question === question, "saved question was truncated");
    t.assert((await t.storeGet("runs", "70000")).model === "fixture", "new run overwrote the old ID");
  } finally {
    await t.eval(`window.restoreHistoryFetch?.(); (async () => {
      await fetch('/api/store/runs/70000', {method:'DELETE'});
      await fetch('/api/store/runs/70001', {method:'DELETE'});
      return true;
    })()`);
  }
}
