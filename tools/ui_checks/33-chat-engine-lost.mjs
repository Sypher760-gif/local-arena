// Engine failure: a lost engine turns the stuck reply into an error block and shows a banner.
export const name = "33-chat-engine-lost";

const CHIP_TEXT = "#topbar .chip";
const NEW_BUTTON = ".chat-list-head .btn";
const SEND_BUTTON = ".chat-composer-bar .btn-primary";
const ERROR_BLOCK = ".chat-error";
const RETRY_BUTTON = ".chat-action-retry";
const BANNER = ".chat-engine-banner:not([hidden])";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function run(t) {
  // Killing the engine mid-reply can log a page-side fetch error.
  t.allowErrors();

  // A slow engine keeps the reply streaming long enough to cut it off mid-word.
  await t.killEngine();
  await t.startEngine(["--wps", "5"]);

  await t.open("chat");
  await t.waitFor(`[...document.querySelectorAll("${CHIP_TEXT}")].some((c) => c.innerText.includes("fake-model"))`);
  await t.click(NEW_BUTTON);
  await t.waitFor(`document.querySelector(".chat-empty") !== null`);

  await t.type(".chat-input", "tell me a long story");
  await t.waitFor(`!document.querySelector("${SEND_BUTTON}").disabled`);
  await t.click(SEND_BUTTON);

  // Let the reply start and stream a few words.
  await t.waitFor(`document.querySelector(".chat-writing") !== null`, 15000);
  await t.waitFor(`document.querySelector(".chat-msg-model .chat-body")?.innerText.trim().length > 0`, 15000);
  await sleep(600);

  await t.killEngine();

  // The stuck reply becomes an error block with a Try again button, and the writing label is gone.
  await t.waitFor(`document.querySelector("${ERROR_BLOCK}") !== null && document.querySelector("${RETRY_BUTTON}") !== null`, 8000);
  t.assert((await t.count(".chat-writing")) === 0, "a reply is still marked writing after the engine was lost");

  // The engine-lost banner appears above the composer.
  await t.waitFor(`document.querySelector("${BANNER}") !== null`, 8000);

  // Bring the engine back: the banner disappears on its own.
  await t.startEngine();
  await t.waitFor(`document.querySelector("${BANNER}") === null`, 10000);
  const before = (await t.fakeRequests()).length;
  await t.click(RETRY_BUTTON);
  await t.waitFor(`!globalThis.benchEngine.streaming && !document.querySelector("${ERROR_BLOCK}")`, 20000);
  t.assert((await t.fakeRequests()).length === before + 1, "Try again did not send a replacement reply");
}
