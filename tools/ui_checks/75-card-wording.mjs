// The memory card talks like the engine does and the context meter is renamed everywhere.
// - Live (fake engine): "Context limit" is shown and the old words are gone; the fake engine's
//   kind is unknown, so the pages carry no memory claim at all (no ok, no Strata sentence).
// - The kind rules are then exercised by setting the engine's kind directly and letting the
//   screens re-render on the engine's change event (same path a status poll goes through):
//   strata shows the neutral Strata sentence, llama.cpp shows the fully-on-card sentence.
// Case: meter/table heads render uppercase through CSS text-transform and innerText follows it,
// so the wording checks compare lowercased page text.
export const name = "75-card-wording";

const CONTEXT = "context limit";
const OLD_LABEL = "conversation length";
const OLD_ROOM = "room for roughly";
const OK_CLAIM = "Fully on the card. Nothing is spilling";
const STRATA_TEXT = "Strata keeps part of the model in system memory on purpose";

function setKind(kind) {
  // Feeds the screens exactly what a status poll would give them (wording per engine kind).
  const engine = globalThis.benchEngine;
  engine.kind = kind;
  engine.emit("change");
  return true;
}

export async function run(t) {
  // Chat: renamed meter, room sentence removed, no memory claim while the kind is unknown.
  await t.open("chat");
  await t.waitFor(`!!document.querySelector(".chat-thread")`, 12000);
  await t.waitFor(`document.body.innerText.toLowerCase().includes(${JSON.stringify(CONTEXT)})`, 12000);
  const chatText = (await t.eval("document.body.innerText")).toLowerCase();
  t.assert(!chatText.includes(OLD_LABEL), `chat still shows "${OLD_LABEL}"`);
  t.assert(!chatText.includes(OLD_ROOM), `chat still shows "${OLD_ROOM}"`);
  t.assert(!chatText.includes(OK_CLAIM.toLowerCase()), `chat shows the "Fully on the card" claim while the kind is unknown`);

  // Models: renamed column and detail label.
  await t.open("models");
  await t.waitFor(`document.querySelectorAll(".live-model-row").length > 0`, 12000);
  const modelsText = (await t.eval("document.body.innerText")).toLowerCase();
  t.assert(modelsText.includes(CONTEXT), `models does not show "${CONTEXT}"`);
  t.assert(!modelsText.includes(OLD_LABEL), `models still shows "${OLD_LABEL}"`);

  // Strata: set the kind and the page must show the neutral sentence (and only then).
  await t.open("chat");
  await t.waitFor(`!!document.querySelector(".chat-thread")`, 12000);
  await t.eval(`(() => { ${setKind.toString()}; return setKind("strata"); })()`);
  await t.waitFor(`document.body.innerText.includes(${JSON.stringify(STRATA_TEXT)})`, 12000);

  // And llama.cpp back to the fully-on-card sentence.
  await t.eval(`(() => { ${setKind.toString()}; return setKind("llama.cpp"); })()`);
  await t.waitFor(`document.body.innerText.includes(${JSON.stringify(OK_CLAIM)})`, 12000);
  const final = await t.eval("document.body.innerText");
  t.assert(!final.includes(STRATA_TEXT), `chat still shows the Strata sentence for llama.cpp`);
}
