// Plain-English review: with the engine killed, every screen shows plain sentences and no leaked
// jargon or raw error text (undefined, NaN, [object, TypeError, Failed to fetch, HTTP 5xx).
export const name = "53-plain-english";

const FORBIDDEN = ["undefined", "NaN", "[object", "TypeError", "Failed to fetch", "HTTP 5"];

const SCREENS = [
  { hash: "chat", ready: `document.querySelector(".chat-thread") !== null` },
  { hash: "models", ready: `document.querySelector(".live-model-row") !== null` },
  { hash: "arena", ready: `document.querySelector("#view").children.length > 0` },
  { hash: "tests", ready: `document.querySelector("#view").children.length > 0` },
];

export async function run(t) {
  // Killing the engine can log a page-side fetch error; this check reads visible text only.
  t.allowErrors();
  await t.killEngine();

  for (const screen of SCREENS) {
    await t.open(screen.hash);
    await t.waitFor(screen.ready, 8000);
    const text = await t.eval("document.body.innerText");
    for (const bad of FORBIDDEN) {
      t.assert(!text.includes(bad), `${screen.hash}: page text contains "${bad}"`);
    }
  }

  await t.startEngine();
}
