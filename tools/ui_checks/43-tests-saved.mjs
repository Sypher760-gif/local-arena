// Test runs persist: a finished run is saved, a reload lists it again.
export const name = "43-tests-saved";

const RUN_BTN = ".btn-primary";
const SCORE_ROW = ".score-row";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function clearRuns(t) {
  await t.eval(`(async () => {
    const res = await fetch('/api/store/runs');
    const items = (await res.json()).items ?? [];
    await Promise.all(items.map((i) => fetch('/api/store/runs/' + i.id, { method: 'DELETE' })));
    return items.length;
  })()`);
}

async function waitForStoreCount(t, want) {
  for (let i = 0; i < 240; i += 1) {
    const items = await t.storeList("runs");
    if (items.length === want) return items;
    await sleep(250);
  }
  return t.storeList("runs");
}

export async function run(t) {
  await clearRuns(t);

  // Restart the fake engine fast so the 120-question run finishes in a few seconds.
  await t.killEngine();
  await t.startEngine(["--wps", "1000"]);

  await t.open("tests");
  // Wait for the loaded model so the Run button is enabled.
  await t.waitFor(`document.querySelector("${RUN_BTN}") && !document.querySelector("${RUN_BTN}").disabled`, 12000);

  // A small run: two types, two questions each. The default full run timed this check out when the
  // machine was busy; saving and listing a run do not need 120 questions (same fix as 61-tests-run).
  await t.waitFor(`document.querySelectorAll(".setup-type").length > 0`, 12000);
  await t.eval(`(() => {
    const rows = [...document.querySelectorAll(".setup-type")];
    rows.forEach((row, i) => {
      const box = row.querySelector("input[type=checkbox]");
      if ((i < 2) !== box.checked) box.click();
      if (i < 2) {
        const input = row.querySelector(".setup-count");
        input.value = "2";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    return true;
  })()`);
  await t.waitFor(`/· 4 questions/.test(document.querySelector(".setup .btn-primary")?.textContent ?? "")`, 5000);

  // Run the tests: the finished run lands in the store.
  await t.click(RUN_BTN);
  let items = await waitForStoreCount(t, 1);
  t.assert(items.length === 1, `store has ${items.length} runs after a run, want 1`);

  // Reload: the saved run is listed again (the score table draws for it).
  await t.reload();
  await t.waitFor(`document.querySelector("${SCORE_ROW}") !== null`, 12000);
  const after = await t.storeList("runs");
  t.assert(after.length === 1, `store still has ${after.length} runs after reload, want 1`);
}
