// Tests: your own questions. A custom question with "=> expected" is graded by substring; one without
// is listed under "Read these yourself" and its question opens the detail panel.
export const name = "79-tests-own";

const START = ".setup-start";
const CUSTOM = ".setup-custom-input";
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

const untickAll = `(() => {
  [...document.querySelectorAll(".setup-type input[type=checkbox]")].forEach((b) => { if (b.checked) b.click(); });
  return true;
})()`;

// The two questions: one the fake engine will answer correctly (its reply echoes the prompt), one with
// no expected answer, so it is left for you to read.
const QUESTIONS = "Name the word thinking0 => thinking0\nExplain what a hash table is";

export async function run(t) {
  await clearRuns(t);
  await t.killEngine();
  await t.startEngine(["--wps", "1000"]);

  await t.open("tests");
  await t.waitFor(`!!document.querySelector("${CUSTOM}")`, 12000);
  await t.waitFor(`!document.querySelector("${START}").disabled`, 12000);

  // Only the custom questions run this time.
  await t.eval(untickAll);
  await t.type(CUSTOM, QUESTIONS);
  const total = await t.text(".setup-total");
  t.assert(total.includes("2"), `total says "${total}", want 2 questions`);
  await t.click(START);

  const items = await waitForStoreCount(t, 1);
  t.assert(items.length === 1, `store has ${items.length} runs after a run, want 1`);

  const rec = await t.storeGet("runs", items[0].id);
  const custom = rec.byType.find((b) => b.type === "Your questions");
  t.assert(custom, `saved run has no "Your questions" row (types: ${rec.byType.map((b) => b.type).join(",")})`);
  t.assert(custom.right === 1 && custom.total === 1, `scored custom questions: ${custom.right}/${custom.total}, want 1/1`);

  const read = rec.readYourself ?? [];
  t.assert(read.length === 1, `${read.length} questions under "Read these yourself", want 1`);
  t.assert(read[0].question === "Explain what a hash table is", `unscored question text ("${read[0].question}")`);
  t.assert(typeof read[0].answer === "string" && read[0].answer.trim().length > 0, "unscored question has no saved answer");

  // The page lists the unscored question under "Read these yourself".
  await t.waitFor(`!!document.querySelector(".read-yourself") && !document.querySelector(".read-yourself").hidden`, 8000);
  const readText = await t.text(".read-yourself");
  t.assert(readText.includes("Explain what a hash table is"), `read-yourself list does not show the question ("${readText}")`);

  // Opening it shows the real question text in the detail panel.
  await t.click(".read-card");
  await t.waitFor(`!!document.querySelector(".detail[open]")`, 8000);
  const detail = await t.text(".detail");
  t.assert(detail.includes("Explain what a hash table is"), `detail panel does not show the question ("${detail}")`);
  t.assert(detail.includes("No expected answer"), `detail panel does not say there is no expected answer ("${detail}")`);
}
