// Tests set-up card: it explains itself, shows six question types with counts, disables Start with a
// plain reason when nothing is picked, and runs exactly the ticked types and counts.
export const name = "78-tests-setup";

const START = ".setup-start";
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

// Ticks one type (if unticked) and sets its question count, through real events.
const pick = (name, count) => `(() => {
  const row = [...document.querySelectorAll(".setup-type")].find((r) => r.querySelector(".setup-type-name").textContent.trim() === ${JSON.stringify(name)});
  if (!row) throw new Error("no setup row for " + ${JSON.stringify(name)});
  const box = row.querySelector("input[type=checkbox]");
  if (!box.checked) box.click();
  const input = row.querySelector(".setup-count");
  input.value = String(${count});
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
})()`;

// Types a number into a type's count box and, with commit, fires change like leaving the box.
const setCount = (name, count, commit) => `(() => {
  const row = [...document.querySelectorAll(".setup-type")].find((r) => r.querySelector(".setup-type-name").textContent.trim() === ${JSON.stringify(name)});
  if (!row) throw new Error("no setup row for " + ${JSON.stringify(name)});
  const input = row.querySelector(".setup-count");
  input.value = String(${count});
  input.dispatchEvent(new Event("input", { bubbles: true }));
  ${commit ? 'input.dispatchEvent(new Event("change", { bubbles: true }));' : ""}
  return input.value;
})()`;

const countBoxValue = (name) => `(() => {
  const row = [...document.querySelectorAll(".setup-type")].find((r) => r.querySelector(".setup-type-name").textContent.trim() === ${JSON.stringify(name)});
  return row ? row.querySelector(".setup-count").value : null;
})()`;

const untickAll = `(() => {
  [...document.querySelectorAll(".setup-type input[type=checkbox]")].forEach((b) => { if (b.checked) b.click(); });
  return true;
})()`;

export async function run(t) {
  await clearRuns(t);
  await t.killEngine();
  await t.startEngine(["--wps", "1000"]);

  await t.open("tests");
  await t.waitFor(`!!document.querySelector(".setup")`, 12000);

  // The card explains itself and names the model that will be tested.
  const intro = await t.text(".setup-intro");
  t.assert(intro.includes("asks the loaded model a set of questions"), `intro does not explain a run ("${intro}")`);
  await t.waitFor(`document.querySelector(".setup-model-text").innerText.includes("fake-model")`, 12000);
  const boxes = await t.count(".setup-type input[type=checkbox]");
  t.assert(boxes === 6, `${boxes} question-type checkboxes, want 6`);
  t.assert(!(await t.exists(".setup-placeholder")), "old placeholder notice is still shown");
  const bankErrorHidden = await t.eval(`document.querySelector(".setup-bank-error")?.hidden !== false`);
  t.assert(bankErrorHidden, "question-files error is shown even though the bank loaded");
  const startText = await t.text(START);
  t.assert(/\d+ questions/.test(startText), `Start button does not name the count ("${startText}")`);

  // Nothing ticked: Start is disabled and says why in plain words.
  await t.eval(untickAll);
  await t.waitFor(`document.querySelector("${START}").disabled`, 4000);
  const why = await t.text(".setup-why");
  t.assert(why.trim().length > 0, "disabled Start button has no reason");
  t.assert(!why.includes("undefined") && !why.includes("NaN"), `reason has raw text ("${why}")`);

  // Two types, three questions each: exactly six questions, and only those types are saved.
  await t.eval(pick("Logic", 3));
  await t.eval(pick("Math", 3));

  // A number above the limit is clamped for the run, and leaving the box shows the number that will be used.
  await t.eval(setCount("Logic", 99, true));
  const boxed = await t.eval(countBoxValue("Logic"));
  t.assert(boxed === "20", `count box shows "${boxed}" after typing 99 and leaving it, want the maximum 20`);
  const clampedTotal = await t.text(".setup-total");
  t.assert(clampedTotal.includes("23"), `total is "${clampedTotal}" after typing 99, want 23 questions (20 + 3)`);
  await t.eval(pick("Logic", 3));   // back to 3 each for the run below

  const total = await t.text(".setup-total");
  t.assert(total.includes("6"), `total says "${total}", want 6 questions`);
  await t.click(START);

  const items = await waitForStoreCount(t, 1);
  t.assert(items.length === 1, `store has ${items.length} runs after a run, want 1`);

  const asked = await t.fakeRequests();
  t.assert(asked.length === 6, `fake engine received ${asked.length} questions, want 6`);

  const rec = await t.storeGet("runs", items[0].id);
  const types = rec.byType.map((b) => b.type).sort();
  t.assert(types.length === 2 && types[0] === "Logic" && types[1] === "Math",
    `saved run types are "${types.join(",")}", want Logic,Math`);
  const questions = rec.byType.reduce((n, b) => n + b.total, 0);
  t.assert(questions === 6, `saved run has ${questions} questions, want 6`);
  t.assert(rec.byType.every((b) => b.total === 3), `saved run counts are ${rec.byType.map((b) => b.total).join(",")}, want 3 each`);
}
