// Arena phases: each side shows a live phase line (Thinking with dots, then Writing) while its answer
// is made, and a closed "Thought for" row with the reasoning text after. Checked at 1024 px wide.
export const name = "57-arena-phases";

const START = ".arena-start";
const VOTE_A = ".arena-vote-a";
const SIDE = `[...document.querySelectorAll(".arena-side")]`;

const sidePhase = (i) => `${SIDE}[${i}].querySelector(".arena-status.work-phase")?.innerText`;
const thoughtState = (i) => `(() => {
  const row = ${SIDE}[${i}]?.querySelector(".thought-row");
  return row && {
    open: row.open,
    label: row.querySelector(".thought-label")?.textContent,
    text: row.querySelector(".thought-text")?.textContent,
  };
})()`;

export async function run(t) {
  // Slow enough to watch the thinking phase, fast enough to keep both sides inside the check limit.
  await t.setViewport(1024, 720);
  await t.killEngine();
  await t.startEngine(["--wps", "15", "--think-words", "30"]);

  await t.open("arena");
  await t.waitFor(`document.querySelector("${START}") && !document.querySelector("${START}").hidden && !document.querySelector("${START}").disabled`, 15000);

  await t.click(START);

  // Side A thinks: the phase line names it with three pulsing dots and the thought row is open.
  await t.waitFor(`${sidePhase(0)}?.includes("Thinking")`, 25000);
  t.assert(await t.eval(`${SIDE}[0].querySelectorAll(".arena-status .work-dots .work-dot").length`) === 3,
    "the thinking phase line does not carry three pulsing dots");
  await t.waitFor(`${SIDE}[0].querySelector(".thought-row")?.open === true`, 8000);

  // Side A answers: the phase line says Writing and the thought row folded shut on its own.
  await t.waitFor(`${sidePhase(0)}?.includes("Writing")`, 30000);
  const folded = await t.eval(thoughtState(0));
  t.assert(folded, "side A has no thought row");
  t.assert(folded.open === false, `side A thought row is still open (${folded.open})`);
  t.assert((folded.label ?? "").includes("Thought for"), `side A thought summary is ${JSON.stringify(folded.label)}`);

  // Side B runs after A: its own phase line appears while its answer is being made.
  await t.waitFor(`${SIDE}[1].querySelector(".arena-status.work-phase") !== null`, 30000);
  t.assert(/Reading|Thinking|Writing/.test((await t.eval(sidePhase(1))) ?? ""), "side B phase line has no phase word");

  // Both answers are in: each side keeps a closed "Thought for" row holding the reasoning text.
  await t.waitFor(`document.querySelector("${VOTE_A}") && !document.querySelector("${VOTE_A}").disabled`, 60000);
  for (const i of [0, 1]) {
    const done = await t.eval(thoughtState(i));
    t.assert(done, `side ${"AB"[i]} has no thought row after its answer`);
    t.assert(done.open === false, `side ${"AB"[i]} thought row is not closed after the round`);
    t.assert((done.label ?? "").includes("Thought for"), `side ${"AB"[i]} summary is ${JSON.stringify(done.label)}`);
    t.assert((done.text ?? "").includes("thinking"), `side ${"AB"[i]} thought text is ${JSON.stringify(done.text)}`);
  }
  t.assert(await t.eval(`${SIDE}[0].querySelector(".arena-status.work-phase")`) === null
    && await t.eval(`${SIDE}[1].querySelector(".arena-status.work-phase")`) === null,
    "a phase line is still live after both answers are in");

  // 1024 px wide: the two answer cards sit side by side and both are readable.
  const layout = await t.eval(`(() => {
    const [a, b] = ${SIDE};
    return { aWidth: a.getBoundingClientRect().width, bWidth: b.getBoundingClientRect().width, sameRow: a.getBoundingClientRect().top === b.getBoundingClientRect().top };
  })()`);
  t.assert(layout.aWidth > 300 && layout.bWidth > 300 && layout.sameRow,
    `both cards share the 1024 px row (${layout.aWidth} x ${layout.bWidth}, sameRow ${layout.sameRow})`);
}
