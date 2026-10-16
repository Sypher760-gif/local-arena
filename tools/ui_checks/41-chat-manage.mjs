// Chat management from the right-click menu: rename persists, pin moves the chat to Pinned, export
// builds the markdown, delete can be undone, and a delete that is not undone removes the chat.
export const name = "41-chat-manage";

const CHIP_TEXT = "#topbar .chip";
const SEND_BUTTON = ".chat-composer-bar .btn-primary";
const ROW = ".chat-row-wrap .list-row";
const ITEM = (label) => `[...document.querySelectorAll(".ctx-item")].find((b) => b.textContent.startsWith(${JSON.stringify(label)}))`;
const NOTE = "keep this thread";
const NEW_TITLE = "Renamed thread";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function clearChats(t) {
  await t.eval(`(async () => {
    const res = await fetch('/api/store/chats');
    const items = (await res.json()).items ?? [];
    await Promise.all(items.map((i) => fetch('/api/store/chats/' + i.id, { method: 'DELETE' })));
    return items.length;
  })()`);
}

async function waitForStoreCount(t, want) {
  for (let i = 0; i < 80; i += 1) {
    const items = await t.storeList("chats");
    if (items.length === want) return items;
    await sleep(250);
  }
  return t.storeList("chats");
}

// Right-click the first chat row, then pick a menu item by its label.
async function menuPick(t, label) {
  await t.eval(`(() => {
    const row = document.querySelector(${JSON.stringify(ROW)});
    const b = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: b.left + 30, clientY: b.top + 12 }));
    return true;
  })()`);
  await t.waitFor(`!!${ITEM(label)}`, 8000);
  await t.eval(`${ITEM(label)}.click() ?? true`);
}

async function waitForTitle(t, id, want) {
  for (let i = 0; i < 80; i += 1) {
    const rec = await t.storeGet("chats", id);
    if (rec && rec.title === want) return true;
    await sleep(250);
  }
  return false;
}

export async function run(t) {
  await clearChats(t);
  await t.reload();
  await t.waitFor(`[...document.querySelectorAll("${CHIP_TEXT}")].some((c) => c.innerText.includes("fake-model"))`);
  await t.waitFor(`document.querySelector(".chat-list-head .btn") && !document.querySelector(".chat-list-head .btn").disabled`, 10000);

  // Send into the auto-created empty chat so it is saved with a user line and a model reply.
  await t.type(".chat-input", NOTE);
  await t.waitFor(`!document.querySelector("${SEND_BUTTON}").disabled`);
  await t.click(SEND_BUTTON);
  await t.waitFor(`document.querySelector(".chat-writing") === null`, 30000);
  const items = await waitForStoreCount(t, 1);
  t.assert(items.length === 1, `store has ${items.length} chats, want 1`);
  const id = items[0].id;

  // Rename in place: open the row menu, Rename, type a new title, Enter.
  // The list can re-render while we type (it throws the input away), so retry the whole rename a few times.
  let renamed = false;
  for (let attempt = 0; attempt < 4 && !renamed; attempt += 1) {
    await menuPick(t, "Rename");
    await t.waitFor(`document.querySelector(".chat-row-rename-input") !== null`, 8000);
    await t.type(".chat-row-rename-input", NEW_TITLE);
    const typed = await t.eval(`document.querySelector(".chat-row-rename-input")?.value === ${JSON.stringify(NEW_TITLE)}`);
    if (!typed) continue;
    await t.press("Enter");
    // Enter commits; blur is a fallback in case the keypress races the focus.
    await t.eval(`document.querySelector(".chat-row-rename-input")?.blur() ?? true`);
    renamed = await waitForTitle(t, id, NEW_TITLE);
  }
  t.assert(renamed, `store title did not become "${NEW_TITLE}" after rename`);

  // Reload: the new title is in the sidebar.
  await t.reload();
  await t.waitFor(`[...document.querySelectorAll("${CHIP_TEXT}")].some((c) => c.innerText.includes("fake-model"))`);
  await t.waitFor(`document.querySelector(".chat-list-head .btn") && !document.querySelector(".chat-list-head .btn").disabled`, 10000);
  await t.waitFor(`document.querySelector(".list-row.selected .list-row-title")?.innerText === ${JSON.stringify(NEW_TITLE)}`, 8000);

  // Export: the markdown builder holds both message texts.
  const markdown = await t.eval("window.benchChatExport()");
  t.assert(typeof markdown === "string" && markdown.length > 0, "export text is empty");
  t.assert(markdown.includes(NOTE), `export text is missing the user line: ${markdown}`);
  t.assert(markdown.includes("fake reply"), `export text is missing the model reply: ${markdown}`);

  // Pin: the chat moves under a Pinned heading; Unpin moves it back.
  await menuPick(t, "Pin to top");
  await t.waitFor(`document.querySelector(".chat-group")?.textContent === "Pinned"`, 8000);
  await menuPick(t, "Unpin");
  await t.waitFor(`![...document.querySelectorAll(".chat-group")].some((g) => g.textContent === "Pinned")`, 8000);

  // Delete, then Undo: the chat comes back and is still in the store.
  await menuPick(t, "Delete");
  await t.waitFor(`!!document.querySelector(".toast-action")`, 8000);
  await t.click(".toast-action");
  await t.waitFor(`[...document.querySelectorAll(".list-row-title")].map((n) => n.textContent).includes(${JSON.stringify(NEW_TITLE)})`, 8000);
  await sleep(500);
  t.assert((await t.storeList("chats")).length === 1, "undo did not keep the chat in the store");

  // Delete for real: once the undo window passes, the chat is gone from the sidebar and the store.
  await menuPick(t, "Delete");
  await t.waitFor(`![...document.querySelectorAll(".list-row-title")].map((n) => n.textContent).includes(${JSON.stringify(NEW_TITLE)})`, 8000);
  const after = await waitForStoreCount(t, 0);
  t.assert(after.length === 0, `store still has ${after.length} chats after delete, want 0`);
}
