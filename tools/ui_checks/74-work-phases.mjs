// Work phases on a Chat reply: a live phase line with dots, the thought row open while the model
// thinks, shut with a "Thought for" summary when the answer starts, and "Worked for" after the reply.
export const name = "74-work-phases";

const CHIP = "#topbar .chip";
const NEW_BUTTON = ".chat-list-head .btn";
const SEND = ".chat-composer-bar .btn-primary";
const PHASE = ".chat-msg-model .work-phase";
const THOUGHT = ".chat-msg-model .thought-row";
const SUMMARY = `${THOUGHT} .thought-summary`;

const SENT = "Explain what a phase line is in plain English";

const thoughtState = `(() => {
  const row = document.querySelector("${THOUGHT}");
  return row && {
    open: row.open,
    label: row.querySelector(".thought-label")?.textContent,
    text: row.querySelector(".thought-text")?.textContent,
  };
})()`;

export async function run(t) {
  // A slower engine with extra thinking words keeps the thinking phase visible long enough to watch.
  // Keep the whole check well under the 40 s per-check limit: thinking ~1.5 s, answer ~14 s.
  await t.killEngine();
  await t.startEngine(["--wps", "8", "--think-words", "12"]);

  await t.open("chat");
  await t.waitFor(`[...document.querySelectorAll("${CHIP}")].some((c) => c.innerText.includes("fake-model"))`, 15000);
  await t.click(NEW_BUTTON);
  await t.waitFor(`document.querySelector(".chat-empty") !== null`);

  await t.click(".chat-settings-toggle");
  await t.eval(`(() => {
    const thinking = document.querySelector(".chat-setting-select");
    thinking.value = "low";
    thinking.dispatchEvent(new Event("change"));
    const maxTokens = document.querySelectorAll(".chat-setting-input")[2];
    maxTokens.value = "64";
    maxTokens.dispatchEvent(new Event("change"));
  })()`);
  await t.waitFor(`document.querySelector(".chat-chips")?.innerText.includes("thinking low")`);
  await t.waitFor(`document.querySelector(".chat-chips")?.innerText.includes("max 64")`);

  await t.type(".chat-input", SENT);
  await t.waitFor(`!document.querySelector("${SEND}").disabled`, 8000);
  await t.click(SEND);

  // Thinking: the phase line names it and the thought row is open while the reasoning streams.
  await t.waitFor(`document.querySelector("${PHASE}")?.innerText.includes("Thinking")`, 25000);
  t.assert(await t.count(".work-dots .work-dot") === 3, "the active phase line does not carry three pulsing dots");
  await t.waitFor(`document.querySelector("${THOUGHT}")?.open === true`, 8000);

  // The first answer word: the phase line says writing and the thought row folded shut on its own.
  await t.waitFor(`document.querySelector("${PHASE}")?.innerText.includes("Writing")`, 30000);
  const folded = await t.eval(thoughtState);
  t.assert(folded, "no thought row on the reply");
  t.assert(folded.open === false, "the thought row is still open after the answer started");
  t.assert((folded.label ?? "").includes("Thought for"), `thought summary is ${JSON.stringify(folded.label)}`);

  // Clicking the row opens it again and shows the reasoning text.
  await t.click(SUMMARY);
  await t.waitFor(`document.querySelector("${THOUGHT}")?.open === true`, 8000);
  const opened = await t.eval(thoughtState);
  t.assert((opened.text ?? "").includes("thinking"), `thought text is ${JSON.stringify(opened.text)}`);
  await t.click(SUMMARY);
  await t.waitFor(`document.querySelector("${THOUGHT}")?.open === false`, 8000);

  // Finished: the live line becomes the quiet "Worked for" line.
  await t.waitFor(`!document.querySelector(".chat-writing")`, 60000);
  await t.waitFor(`document.querySelector(".work-done")?.innerText.includes("Worked for")`, 10000);

  // Put a fast engine back for the checks that run after this one (74 is no longer the last check).
  await t.startEngine();
}
