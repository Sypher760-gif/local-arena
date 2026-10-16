// Arena live round: names stay hidden until the vote, the round ends in a recorded vote, Undo reverses it.
export const name = "60-arena-round";

const START = ".arena-start";
const VOTE_A = ".arena-vote-a";
const UNDO = ".arena-undo";
const COUNT_A = ".arena-count-a";
const NOTE = ".arena-note";

async function clearVotes(t) {
  await t.eval(`(async () => {
    const res = await fetch('/api/store/votes');
    const items = (await res.json()).items ?? [];
    await Promise.all(items.map((i) => fetch('/api/store/votes/' + i.id, { method: 'DELETE' })));
    return items.length;
  })()`);
}

const sideState = `(() => {
  const names = [...document.querySelectorAll('.arena-name')];
  const pills = [...document.querySelectorAll('.arena-pill')];
  const texts = [...document.querySelectorAll('.arena-text')];
  return {
    nameCount: names.length,
    namesHidden: names.length > 0 && names.every((n) => n.hidden),
    pillShown: pills.length > 0 && pills.every((p) => !p.hidden),
    pillText: pills[0] ? pills[0].innerText : "",
    answered: texts.length === 2 && texts.every((x) => x.innerText.trim() !== "" && x.innerText !== "No answer yet."),
  };
})()`;

export async function run(t) {
  await clearVotes(t);
  await t.killEngine();
  await t.startEngine(["--wps", "1000"]);

  await t.open("arena");
  await t.waitFor(`document.querySelector("${START}") && !document.querySelector("${START}").hidden && !document.querySelector("${START}").disabled`, 12000);

  await t.click(START);
  // Both answers stream in; the vote buttons unlock.
  await t.waitFor(`document.querySelector("${VOTE_A}") && !document.querySelector("${VOTE_A}").disabled`, 30000);
  // The answer text can land a tick after the unlock. Wait for it, so a busy machine does not read
  // a card that is still being painted; the assert below still proves both sides answered.
  await t.waitFor(`(() => {
    const x = [...document.querySelectorAll(".arena-text")];
    return x.length === 2 && x.every((e) => e.innerText.trim() !== "" && e.innerText !== "No answer yet.");
  })()`, 10000);

  // Before voting: names are hidden, the "Name hidden" pill shows, and both answers streamed a reply.
  const before = await t.eval(sideState);
  t.assert(before.nameCount === 2, `two answer cards, got ${before.nameCount}`);
  t.assert(before.answered, "both answers streamed a reply");
  t.assert(before.namesHidden, "model names are hidden before the vote");
  t.assert(before.pillShown && before.pillText.includes("hidden"), `name-hidden pill shows ("${before.pillText}")`);

  // Vote for A: the round ends in a recorded vote and the names appear.
  await t.click(VOTE_A);
  await t.waitFor(`document.querySelector("${UNDO}") && !document.querySelector("${UNDO}").hidden`, 8000);
  const after = await t.eval(sideState);
  t.assert(!after.namesHidden, "model names appear once you vote");
  const note = await t.text(NOTE);
  t.assert(note.includes("Vote recorded"), `note records the vote ("${note}")`);
  await t.waitFor(`document.querySelector("${COUNT_A}")?.innerText === "A 1"`, 8000);

  // Undo reverses the vote: back to the answered state, count back to zero, Undo hides again.
  await t.click(UNDO);
  await t.waitFor(`document.querySelector("${VOTE_A}") && !document.querySelector("${VOTE_A}").disabled`, 8000);
  const undone = await t.eval(`document.querySelector("${COUNT_A}")?.innerText`);
  t.assert(undone === "A 0", `Undo returns the count to zero ("${undone}")`);
  const undoHidden = await t.eval(`document.querySelector("${UNDO}")?.hidden`);
  t.assert(undoHidden === true, "Undo hides again after reversing the vote");
}
