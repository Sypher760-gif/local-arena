// Every speed readout on Chat and Arena reads tok/s, and the Chat reply footer says tok/s.
export const name = "72-tokens-speed";

const HERO_UNIT = `(() => {
  const n = document.querySelector(".readout-hero");
  const u = n && n.parentElement.querySelector(".readout-unit");
  return u ? u.textContent : null;
})()`;

export async function run(t) {
  // Chat speed card: the big number is in tok/s.
  await t.open("chat");
  await t.waitFor(`!!document.querySelector(".readout-hero")`);
  const heroUnit = await t.eval(HERO_UNIT);
  t.assert(heroUnit === "tok/s", `Chat speed card unit is "${heroUnit}", want "tok/s"`);

  // Send a reply and read the line under it.
  await t.type(".chat-input", "count the tokens please now");
  await t.waitFor(`!document.querySelector(".chat-composer-bar .btn-primary").disabled`);
  await t.click(".chat-composer-bar .btn-primary");
  await t.waitFor(`!!document.querySelector(".chat-msg-model .chat-stats")`, 30000);
  await t.waitFor(`!document.querySelector(".chat-writing")`, 30000);

  const footer = await t.text(".chat-msg-model .chat-stats");
  t.assert(footer.includes("tok/s"), `reply footer is "${footer}", want it to contain "tok/s"`);
  t.assert(!footer.includes("words per second"), `reply footer is "${footer}", want no "words per second"`);
  // The speed shown is over the first token to the last, and the wait for the first token is separate.
  t.assert(footer.includes("first token"), `reply footer is "${footer}", want the wait for the first token in it`);
  t.assert(/over \d+\.\d s/.test(footer), `reply footer is "${footer}", want the window the speed was measured over`);

  // Arena side readouts use tokens.
  await t.open("arena");
  await t.waitFor(`!!document.querySelector(".arena-speed .readout-unit")`);
  const arenaUnit = await t.text(".arena-speed .readout-unit");
  t.assert(arenaUnit === "tok/s", `Arena side readout unit is "${arenaUnit}", want "tok/s"`);
}
