// Arena votes persist: a cast vote is saved, a reload shows it in the record, Undo removes it.
export const name = "42-arena-saved";

const START = ".arena-start";
const VOTE_A = ".arena-vote-a";
const UNDO = ".arena-undo";
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
  for (let i = 0; i < 80; i += 1) {
    const items = await t.storeList("votes");
    if (items.length === want) return items;
    await sleep(250);
  }
  return t.storeList("votes");
}

// Start a round, wait for both answers, vote for A. Live mode streams the loaded engine model on both sides.
async function runRoundAndVote(t) {
  await t.waitFor(`document.querySelector("${START}") && !document.querySelector("${START}").hidden`, 8000);
  await t.click(START);
  await t.waitFor(`document.querySelector("${VOTE_A}") && !document.querySelector("${VOTE_A}").disabled`, 30000);
  await t.click(VOTE_A);
  await t.waitFor(`document.querySelector("${UNDO}") && !document.querySelector("${UNDO}").hidden`, 8000);
}

export async function run(t) {
  await clearVotes(t);
  await t.open("arena");
  await t.waitFor(`document.querySelector("${START}") !== null`, 8000);

  // Cast a vote: it lands in the store.
  await runRoundAndVote(t);
  let items = await waitForStoreCount(t, 1);
  t.assert(items.length === 1, `store has ${items.length} votes after a vote, want 1`);

  // Reload: the saved vote is loaded and the record shows it.
  await t.reload();
  await t.waitFor(`document.querySelector("${COUNT_A}")?.innerText === "A 1"`, 8000);

  // A second vote, then Undo removes the stored item (the earlier saved vote stays).
  await runRoundAndVote(t);
  items = await waitForStoreCount(t, 2);
  t.assert(items.length === 2, `store has ${items.length} votes after a second vote, want 2`);
  await t.click(UNDO);
  items = await waitForStoreCount(t, 1);
  t.assert(items.length === 1, `store has ${items.length} votes after Undo, want 1`);
}
