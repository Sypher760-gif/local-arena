// Arena per-side instructions: two system prompts reach the engine as each side's system prompt, they
// stay hidden with the names, appear after the vote, and both are saved with the vote.
export const name = "77-arena-system";

const START = ".arena-start";
const SUMMARY = ".arena-system-summary";
const FIRST = ".arena-system-first";
const SECOND = ".arena-system-second";
const VOTE_A = ".arena-vote-a";
const SIDE_SYSTEM = ".arena-side-system";

const FIRST_TEXT = "Answer like a careful teacher.";
const SECOND_TEXT = "Answer in three short bullet points.";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function clearVotes(t) {
  await t.eval(`(async () => {
    const res = await fetch('/api/store/votes');
    const items = (await res.json()).items ?? [];
    await Promise.all(items.map((i) => fetch('/api/store/votes/' + i.id, { method: 'DELETE' })));
    return items.length;
  })()`);
}

async function waitForStoreCount(t, want) {
  for (let i = 0; i < 120; i += 1) {
    const items = await t.storeList("votes");
    if (items.length === want) return items;
    await sleep(250);
  }
  return t.storeList("votes");
}

// What each side shows: its answer text, its instructions block and whether it is hidden.
const sides = `(() => {
  const texts = [...document.querySelectorAll(".arena-text")].map((x) => x.innerText.trim());
  const systems = [...document.querySelectorAll("${SIDE_SYSTEM}")].map((x) => ({ hidden: x.hidden, text: x.innerText.trim() }));
  const names = [...document.querySelectorAll(".arena-name")].map((x) => x.hidden);
  return { texts, systems, names };
})()`;

export async function run(t) {
  await clearVotes(t);
  await t.killEngine();
  // The fake engine echoes the system prompt it was sent, so the two instructions are distinguishable.
  await t.startEngine(["--echo-system", "--wps", "1000"]);

  await t.open("arena");
  await t.waitFor(`!!document.querySelector("${SUMMARY}")`, 15000);

  // The collapsed section opens and takes two different instructions.
  await t.click(SUMMARY);
  await t.type(FIRST, FIRST_TEXT);
  await t.type(SECOND, SECOND_TEXT);
  t.assert((await t.eval(`document.querySelector("${FIRST}").value`)) === FIRST_TEXT, "the first instructions field did not take the text");

  // Both pickers take the same model.
  await t.eval(`(() => {
    const b = [...document.querySelectorAll(".arena-top .btn")].find((x) => x.innerText.trim() === "Change models");
    if (!b) throw new Error("no Change models button");
    b.click();
    return true;
  })()`);
  const picks = await t.eval(`(() => {
    const selects = [...document.querySelectorAll(".arena-select")];
    const id = selects[0].value;
    selects[1].value = id;
    selects[1].dispatchEvent(new Event("change", { bubbles: true }));
    return selects.map((s) => s.value);
  })()`);
  t.assert(picks.length === 2 && picks[0] === picks[1], `the two pickers name different models (${picks.join(", ")})`);

  await t.waitFor(`document.querySelector("${START}") && !document.querySelector("${START}").hidden && !document.querySelector("${START}").disabled`, 15000);
  await t.click(START);
  await t.waitFor(`document.querySelector("${VOTE_A}") && !document.querySelector("${VOTE_A}").disabled`, 45000);

  // Before the vote: names and instructions hidden, and the two answers carry different instructions.
  const before = await t.eval(sides);
  t.assert(before.texts.length === 2 && before.texts.every((x) => x), `both sides should have an answer (${JSON.stringify(before.texts.slice(0, 1))})`);
  t.assert(before.texts[0] !== before.texts[1], "both sides answered with the same system echo, so the instructions did not reach the engine");
  t.assert(before.texts.every((x) => x.includes("[system: ")), `each answer should echo its system prompt (${JSON.stringify(before.texts)})`);
  t.assert(before.names.every((h) => h === true), "the model names are not hidden before the vote");
  t.assert(before.systems.every((s) => s.hidden === true), "the instructions are visible before the vote");

  // After the vote: each side shows its model and its own instructions.
  await t.click(VOTE_A);
  await t.waitFor(`[...document.querySelectorAll("${SIDE_SYSTEM}")].every((x) => !x.hidden)`, 8000);
  const after = await t.eval(sides);
  const shown = after.systems.map((s) => s.text).join(" | ");
  t.assert(shown.includes(FIRST_TEXT) && shown.includes(SECOND_TEXT), `the two sides did not reveal both instructions ("${shown}")`);
  for (let i = 0; i < 2; i += 1) {
    const wanted = after.systems[i].text.includes(FIRST_TEXT) ? FIRST_TEXT : SECOND_TEXT;
    t.assert(after.texts[i].includes(wanted), `side ${i} shows instructions that its answer did not follow ("${after.systems[i].text}")`);
  }

  // The vote records both instructions against the setup, and the same model twice.
  const items = await waitForStoreCount(t, 1);
  t.assert(items.length === 1, `store has ${items.length} votes after a vote, want 1`);
  const rec = await t.storeGet("votes", items[0].id);
  t.assert(rec.modelA === rec.modelB, `the vote should record the same model twice (${rec.modelA} vs ${rec.modelB})`);
  t.assert(rec.systemFirst === FIRST_TEXT, `systemFirst is ${JSON.stringify(rec.systemFirst)}, want ${JSON.stringify(FIRST_TEXT)}`);
  t.assert(rec.systemSecond === SECOND_TEXT, `systemSecond is ${JSON.stringify(rec.systemSecond)}, want ${JSON.stringify(SECOND_TEXT)}`);
}
