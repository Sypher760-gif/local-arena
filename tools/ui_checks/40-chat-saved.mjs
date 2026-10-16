// Saved chats: a live chat is written to the store, comes back after a reload, and the list grows.
export const name = "40-chat-saved";

const CHIP_TEXT = "#topbar .chip";
const SEND_BUTTON = ".chat-composer-bar .btn-primary";
const NEW_BUTTON = ".chat-list-head .btn";
const ROW = ".chat-rows .list-row";
const NOTE = "remember this note";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Earlier checks share this gateway's store, so start from a clean one.
async function clearChats(t) {
  await t.eval(`(async () => {
    const res = await fetch('/api/store/chats');
    const items = (await res.json()).items ?? [];
    await Promise.all(items.map((i) => fetch('/api/store/chats/' + i.id, { method: 'DELETE' })));
    return items.length;
  })()`);
}

async function waitForStore(t, want) {
  for (let i = 0; i < 80; i += 1) {
    const items = await t.storeList("chats");
    if (items.length >= want) return items;
    await sleep(250);
  }
  return t.storeList("chats");
}

export async function run(t) {
  await clearChats(t);
  await t.reload();
  await t.waitFor(`[...document.querySelectorAll("${CHIP_TEXT}")].some((c) => c.innerText.includes("fake-model"))`);
  await t.waitFor(`document.querySelector(".chat-list-head .btn") && !document.querySelector(".chat-list-head .btn").disabled`, 10000);

  // No saved chats yet, so an empty New conversation is open. Send into it.
  await t.type(".chat-input", NOTE);
  await t.waitFor(`!document.querySelector("${SEND_BUTTON}").disabled`);
  await t.click(SEND_BUTTON);
  await t.waitFor(`document.querySelector(".chat-writing") === null`, 30000);

  const items = await waitForStore(t, 1);
  t.assert(items.length === 1, `store has ${items.length} chats, want 1`);
  const id = items[0].id;
  const rec = await t.storeGet("chats", id);
  const stored = rec.messages ?? [];
  t.assert(stored.length === 2, `stored messages has ${stored.length} entries, want 2`);
  t.assert(
    stored[0]?.role === "user" && stored[0]?.text === NOTE,
    `stored first message is ${JSON.stringify(stored[0])}, want the user's note`,
  );
  t.assert(stored[1]?.role === "model", `stored second message is ${JSON.stringify(stored[1])}, want a model reply`);

  // Reload: the chat is in the sidebar and its messages are back.
  await t.reload();
  await t.waitFor(`[...document.querySelectorAll("${CHIP_TEXT}")].some((c) => c.innerText.includes("fake-model"))`);
  await t.waitFor(`document.querySelector(".chat-list-head .btn") && !document.querySelector(".chat-list-head .btn").disabled`, 10000);
  await t.waitFor(`document.querySelector(".chat-msg-user")?.innerText.includes(${JSON.stringify(NOTE)})`, 8000);
  await t.waitFor(`document.querySelector(".chat-msg-model") !== null`, 8000);
  const title = await t.text(".list-row.selected .list-row-title");
  t.assert(title === NOTE, `sidebar title is "${title}", want "${NOTE}"`);

  // A second new chat makes the list show two.
  await t.waitFor(`!document.querySelector("${NEW_BUTTON}").disabled`, 8000);
  await t.click(NEW_BUTTON);
  await t.waitFor(`document.querySelectorAll("${ROW}").length === 2`, 8000);
}
