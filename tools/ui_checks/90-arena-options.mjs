// Arena options: category chips and difficulty pick the question; the Thinking choice reaches the
// engine as reasoning_effort; a 5-round match counts rounds; after the vote each answer is checked
// against the question's known answer; the choices survive a reload.
export const name = "90-arena-options";

export async function run(t) {
  await t.eval(`localStorage.removeItem("bench.arena.options")`).catch(() => {});
  await t.open("arena");
  await t.waitFor(`document.querySelectorAll(".arena-chip").length === 7`, 10000);
  await t.waitFor(`/questions match/.test(document.querySelector(".arena-pool-note")?.textContent ?? "")`, 15000);

  // From All, clicking Math picks Math alone.
  await t.eval(`[...document.querySelectorAll(".arena-chip")].find((c) => c.textContent === "Math").click()`);
  const tag = await t.text(".arena-tag");
  t.assert(tag === "Math", `question type is "${tag}" with only Math chosen`);
  const on = await t.eval(`[...document.querySelectorAll(".arena-chip.on")].map((c) => c.textContent)`);
  t.assert(JSON.stringify(on) === '["Math"]', `chips on: ${JSON.stringify(on)}`);
  // A second chip adds to it; clicking it again drops it; the last one off goes back to All.
  const chipsOn = `[...document.querySelectorAll(".arena-chip.on")].map((c) => c.textContent).join(",")`;
  const clickChip = (label) => t.eval(`[...document.querySelectorAll(".arena-chip")].find((c) => c.textContent === "${label}").click()`);
  await clickChip("Logic");
  t.assert((await t.eval(chipsOn)) === "Logic,Math", `after adding Logic: ${await t.eval(chipsOn)}`);
  await clickChip("Logic");
  await clickChip("Math");
  t.assert((await t.eval(chipsOn)) === "All", `after the last one off: ${await t.eval(chipsOn)}`);
  await clickChip("Math");

  // Another question keeps to the choice.
  for (let i = 0; i < 4; i += 1) {
    await t.click(".arena-skip");
    const again = await t.text(".arena-tag");
    t.assert(again === "Math", `"Another question" drew a ${again} question`);
  }

  // Difficulty narrows the pool.
  const before = await t.text(".arena-pool-note");
  await t.eval(`(() => { const s = document.querySelector("#arena-difficulty-select"); s.value = "hard"; s.dispatchEvent(new Event("change")); })()`);
  const after = await t.text(".arena-pool-note");
  t.assert(parseInt(after, 10) < parseInt(before, 10), `difficulty did not narrow the pool (${before} -> ${after})`);
  t.assert((await t.text(".arena-difficulty")) === "hard", "the drawn question is not hard");

  // Thinking: High; a 5-round match; answers checked after the vote.
  await t.eval(`(() => {
    const set = (id, v) => { const s = document.querySelector(id); s.value = v; s.dispatchEvent(new Event("change")); };
    set("#arena-thinking-select", "high"); set("#arena-match-select", "5"); set("#arena-grading-select", "after");
  })()`);
  t.assert((await t.text(".arena-match-note")) === "Round 1 of 5", "match note before the first round");

  // The fake engine keeps its last 50 requests: one round adds the last two.
  await t.click(".arena-start");
  await t.waitFor(`!document.querySelector(".arena-vote-a").disabled`, 30000);
  const sent = (await t.fakeRequests()).slice(-2);
  const efforts = sent.map((r) => (r.body ?? r).reasoning_effort);
  t.assert(efforts.every((e) => e === "high"), `reasoning_effort sent: ${JSON.stringify(efforts)}`);
  const caps = sent.map((r) => (r.body ?? r).max_tokens);
  t.assert(caps.every((c) => c >= 10000), `answer room with High thinking: ${JSON.stringify(caps)}`);

  // No verdict before the vote; one per side after it.
  t.assert(await t.count(".arena-verdict:not([hidden])") === 0, "answer checks are shown before the vote");
  await t.click(".arena-vote-a");
  await t.waitFor(`document.querySelectorAll(".arena-verdict:not([hidden])").length === 2`, 5000);
  const verdicts = await t.eval(`[...document.querySelectorAll(".arena-verdict:not([hidden]) .arena-verdict-mark")].map((n) => n.textContent)`);
  t.assert(verdicts.every((v) => v === "Correct" || v === "Wrong"), `verdicts: ${JSON.stringify(verdicts)}`);
  t.assert((await t.text(".arena-match-note")) === "Round 2 of 5", "match did not count the round");

  // Undo takes the round back off the match.
  await t.click(".arena-undo");
  t.assert((await t.text(".arena-match-note")) === "Round 1 of 5", "undo did not take the round back");
  await t.click(".arena-vote-b");

  // The choices survive a reload.
  await t.open("arena");
  await t.eval(`location.reload()`);
  await t.waitFor(`document.querySelectorAll(".arena-chip").length === 7`, 10000);
  const kept = await t.eval(`({
    thinking: document.querySelector("#arena-thinking-select").value,
    difficulty: document.querySelector("#arena-difficulty-select").value,
    rounds: document.querySelector("#arena-match-select").value,
    on: [...document.querySelectorAll(".arena-chip.on")].map((c) => c.textContent),
  })`);
  t.assert(kept.thinking === "high" && kept.difficulty === "hard" && kept.rounds === "5" && JSON.stringify(kept.on) === '["Math"]',
    `after reload: ${JSON.stringify(kept)}`);
  await t.eval(`localStorage.removeItem("bench.arena.options")`);
}
