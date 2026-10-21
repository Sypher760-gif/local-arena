// Side chats: a model that writes two replies at once lets a second chat answer beside the main one.
export const name = "96-chat-side";

const CHIP_TEXT = "#topbar .chip";
const NEW_BUTTON = ".chat-list-head .btn";
const SPLIT = ".chat-split";
const MAIN = ".chat-thread:not(.chat-side)";
const SIDE = ".chat-side";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function run(t) {
  t.allowErrors();

  // One slot: the button is there but off, and says why.
  await t.open("chat");
  await t.waitFor(`[...document.querySelectorAll("${CHIP_TEXT}")].some((c) => c.innerText.includes("fake-model"))`);
  await t.waitFor(`document.querySelector("${SPLIT}") !== null`);
  t.assert((await t.count(".chat-thread-head .btn")) === 1, "the thread head has more than the side-chat button");
  t.assert(!(await t.eval(`[...document.querySelectorAll(".chat-thread-head .btn")].some((b) => b.innerText.includes("Arena"))`)),
    "the Send to Arena button is still in the thread head");
  await t.waitFor(`document.querySelector("${SPLIT}").disabled`);
  t.assert((await t.eval(`document.querySelector("${SPLIT}").title`)).includes("one chat at a time"), "the off button does not say why");

  // Two slots and a slow engine, so both replies are still writing at the same moment.
  await t.killEngine();
  await t.startEngine(["--wps", "6", "--slots", "2"]);
  await t.waitFor(`globalThis.benchEngine.slots === 2`, 10000);
  await t.waitFor(`!document.querySelector("${SPLIT}").disabled`, 5000);
  await t.click(NEW_BUTTON);
  await t.click(SPLIT);
  await t.waitFor(`document.querySelector("${SIDE}") !== null`);
  t.assert(await t.eval(`document.querySelector("${SPLIT}").disabled`), "a second side chat opened on a two-slot model");

  await t.type(`${MAIN} .chat-input`, "main question");
  await t.click(`${MAIN} .chat-composer-bar .btn-primary`);
  await t.waitFor(`document.querySelector("${MAIN} .chat-writing") !== null`, 15000);
  await t.type(`${SIDE} .chat-input`, "side question");
  await t.waitFor(`!document.querySelector("${SIDE} .chat-composer-bar .btn-primary").disabled`);
  await t.click(`${SIDE} .chat-composer-bar .btn-primary`);
  await t.waitFor(`document.querySelector("${SIDE} .chat-writing") !== null`, 15000);
  t.assert(await t.eval(`document.querySelector("${MAIN} .chat-writing") !== null`), "the main reply stopped when the side chat started");
  await t.waitFor(`document.querySelector("${MAIN} .chat-msg-model .chat-body")?.innerText.trim().length > 0 && document.querySelector("${SIDE} .chat-msg-model .chat-body")?.innerText.trim().length > 0`, 15000);

  // Two separate conversations went to the engine, each with only its own question.
  const asks = (await t.fakeRequests()).map((r) => (r.messages ?? []).filter((m) => m.role === "user").map((m) => m.content).join("|"));
  t.assert(asks.includes("main question") && asks.includes("side question"), `requests ${JSON.stringify(asks)}`);

  // Stop in the side chat ends only that reply.
  await t.click(`${SIDE} .chat-composer-bar .btn-secondary`);
  await t.waitFor(`document.querySelector("${SIDE} .chat-writing") === null`, 5000);
  t.assert(await t.eval(`document.querySelector("${MAIN} .chat-writing") !== null`), "stopping the side chat stopped the main one");

  // Both chats are saved and listed; closing the side panel keeps its chat.
  await t.waitFor(`!globalThis.benchEngine.streaming`, 60000);
  await sleep(800);
  const saved = await t.storeList("chats");
  t.assert(saved.some((c) => c.title === "side question") && saved.some((c) => c.title === "main question"), `saved ${JSON.stringify(saved.map((c) => c.title))}`);
  await t.click(`${SIDE} .chat-side-close`);
  await t.waitFor(`document.querySelector("${SIDE}") === null`);
  t.assert(await t.eval(`[...document.querySelectorAll(".chat-row-wrap")].some((r) => r.innerText.includes("side question"))`), "the closed side chat left the list");

  await t.killEngine();
  await t.startEngine();
}
