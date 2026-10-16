// Arena keeps its round when you leave the tab: an answered round comes back as it was, a voted round
// keeps its record, and a round left mid-stream offers to run the sides that never finished.
export const name = "76-arena-keeps";

const START = ".arena-start";
const RESUME = ".arena-resume";
const VOTE_A = ".arena-vote-a";
const UNDO = ".arena-undo";
const NEXT = ".arena-next";
const NOTE = ".arena-note";
const COUNT_A = ".arena-count-a";

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

// Both answer modules: their text and their stats line, so we can prove nothing was lost.
const sideState = `(() => {
  const texts = [...document.querySelectorAll(".arena-text")].map((x) => x.innerText.trim());
  const stats = [...document.querySelectorAll(".arena-stats")].map((x) => x.innerText.trim());
  return { texts, stats };
})()`;

async function startAndWaitAnswered(t) {
  await t.waitFor(`document.querySelector("${START}") && !document.querySelector("${START}").hidden && !document.querySelector("${START}").disabled`, 15000);
  await t.click(START);
  await waitAnswered(t, "start");
}

// Waits for both answers, naming which wait it was and what the dock said when it ran out.
async function waitAnswered(t, label) {
  try {
    await t.waitFor(`document.querySelector("${VOTE_A}") && !document.querySelector("${VOTE_A}").disabled`, 45000);
  } catch (err) {
    const state = await t.eval(`(() => ({
      note: document.querySelector(".arena-note")?.innerText,
      statuses: [...document.querySelectorAll(".arena-status")].map((x) => x.innerText.trim()),
    }))()`);
    throw new Error(`${label}: ${err.message} | ${JSON.stringify(state)}`);
  }
}

async function leaveAndReturn(t) {
  await t.open("chat");
  await t.open("arena");
}

export async function run(t) {
  await clearVotes(t);
  await t.killEngine();
  await t.startEngine(["--wps", "1000"]);
  await t.open("arena");
  await t.waitFor(`!!document.querySelector("${START}")`, 15000);

  // A finished round survives leaving the tab: both answers and their stats come back, and voting works.
  await startAndWaitAnswered(t);
  const before = await t.eval(sideState);
  t.assert(before.texts.length === 2 && before.texts.every((x) => x && x !== "No answer yet."), `both answers streamed before leaving (${JSON.stringify(before.texts)})`);

  await leaveAndReturn(t);
  const after = await t.eval(sideState);
  t.assert(JSON.stringify(after.texts) === JSON.stringify(before.texts), `the answers changed after leaving (${JSON.stringify(after.texts)} vs ${JSON.stringify(before.texts)})`);
  t.assert(JSON.stringify(after.stats) === JSON.stringify(before.stats), `the stats changed after leaving (${JSON.stringify(after.stats)} vs ${JSON.stringify(before.stats)})`);
  t.assert(await t.eval(`!!document.querySelector("${VOTE_A}") && !document.querySelector("${VOTE_A}").disabled`), "the vote buttons are not enabled after returning");

  // A vote is kept too: the recorded vote and its Undo survive a trip to another screen.
  await t.click(VOTE_A);
  const items = await waitForStoreCount(t, 1);
  t.assert(items.length === 1, `store has ${items.length} votes after a vote, want 1`);
  await t.waitFor(`document.querySelector("${UNDO}") && !document.querySelector("${UNDO}").hidden`, 8000);
  await leaveAndReturn(t);
  t.assert((await t.text(COUNT_A)).includes("1"), `the recorded vote was lost after leaving ("${await t.text(COUNT_A)}")`);
  t.assert(await t.eval(`!!document.querySelector("${UNDO}") && !document.querySelector("${UNDO}").hidden`), "Undo is gone after returning to a voted round");

  // Next question starts a fresh round; it comes back idle with the record kept.
  await t.click(NEXT);
  await t.waitFor(`document.querySelector("${START}") && !document.querySelector("${START}").hidden`, 8000);
  await leaveAndReturn(t);
  t.assert(await t.eval(`document.querySelector("${START}") && !document.querySelector("${START}").hidden`), "the new round is not idle after returning");
  t.assert((await t.text(COUNT_A)).includes("1"), `the record was lost after starting a new round and leaving ("${await t.text(COUNT_A)}")`);

  // A round left while it is still running stops, says so, and can be run again.
  // A whole Arena answer is about 150 words, so wps 20 keeps one side near 8 s: slow enough to leave
  // in the middle of it, fast enough for the round to finish again inside a check.
  await t.killEngine();
  await t.startEngine(["--wps", "20"]);
  await t.waitFor(`!!document.querySelector("${START}") && !document.querySelector("${START}").disabled`, 15000);
  await t.click(START);
  await t.waitFor(`[...document.querySelectorAll(".arena-text")].some((x) => { const v = x.innerText.trim(); return v !== "" && v !== "No answer yet."; })`, 20000);
  await leaveAndReturn(t);

  const note = await t.text(NOTE);
  t.assert(note.includes("Stopped when you left"), `a left running round does not say it stopped ("${note}")`);
  t.assert(await t.eval(`!!document.querySelector("${RESUME}") && !document.querySelector("${RESUME}").hidden`), "there is no button to run the stopped round again");
  t.assert(await t.eval(`document.querySelector("${VOTE_A}")?.disabled === true`), "a stopped round offers the vote buttons");

  // Running it again finishes the round and unlocks voting.
  await t.click(RESUME);
  await waitAnswered(t, "resume");
  t.assert(await t.eval(`document.querySelector("${RESUME}").hidden === true`), "the run-again button is still there after the round finished");
}
