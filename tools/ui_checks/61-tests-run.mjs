// Tests live run: a short run finishes, shows the score table, and its CSV export is well formed.
export const name = "61-tests-run";

const RUN_BTN = ".btn-primary";
const SCORE_ROW = ".score-row";
const NOTE = ".tests-note";

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
  await t.killEngine();
  await t.startEngine(["--wps", "1000"]);

  await t.open("tests");
  await t.waitFor(`document.querySelector("${RUN_BTN}") && !document.querySelector("${RUN_BTN}").disabled`, 12000);

  // A small run: two types, two questions each. The default 60-question run took over a minute
  // when the machine was busy and timed this check out; saving and exporting do not need 60.
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

  // Run the tests: the finished run shows its score table and lands in the store.
  await t.click(RUN_BTN);
  const items = await waitForStoreCount(t, 1);
  t.assert(items.length === 1, `store has ${items.length} runs after a run, want 1`);

  await t.waitFor(`document.querySelector("${SCORE_ROW}") !== null`, 12000);
  const rows = await t.count(SCORE_ROW);
  t.assert(rows > 0, `score table shows ${rows} rows`);
  const saved = await t.text(NOTE);
  t.assert(saved.includes("saved"), `run reports it was saved ("${saved}")`);

  // Export the run as CSV and read the exact text the app produced.
  await t.eval(`(() => {
    window.__csv = null;
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => { window.__csv = blob; return orig(blob); };
    const btn = [...document.querySelectorAll('.toolbar-end .btn-secondary')].find((b) => b.innerText.trim() === 'Export');
    if (!btn) throw new Error('no Export button');
    btn.click();
    return true;
  })()`);
  const csv = await t.eval(`window.__csv ? window.__csv.text() : null`);
  t.assert(typeof csv === "string" && csv.length > 0, "CSV export produced text");

  const lines = csv.split("\r\n");
  t.assert(csv.endsWith("\r\n"), "CSV ends with a newline");
  const body = lines.slice(0, -1); // drop the trailing empty line after the final newline
  t.assert(body[0] === "Type,Right,Total,Score percent,Tokens per second", `CSV header ("${body[0]}")`);
  t.assert(body.length - 1 === rows, `CSV has ${body.length - 1} data rows for ${rows} score rows`);
  for (const line of body.slice(1)) {
    const cells = line.split(",");
    t.assert(cells.length === 5, `CSV row has 5 columns: "${line}"`);
    const score = Number(cells[3]);
    t.assert(Number.isInteger(score) && score >= 0 && score <= 100, `score percent is 0-100: "${line}"`);
  }
  t.assert(!/undefined|NaN|\[object/.test(csv), "CSV has no undefined/NaN/[object values");
}
