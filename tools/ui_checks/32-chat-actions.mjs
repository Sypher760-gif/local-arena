// Message actions: copy, regenerate and delete.
export const name = "32-chat-actions";

const CHIP_TEXT = "#topbar .chip";
const SEND_BUTTON = ".chat-composer-bar .btn-primary";

async function waitForRequests(t, want) {
  for (let i = 0; i < 60; i += 1) {
    const requests = await t.fakeRequests();
    if (requests.length >= want) return requests;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return t.fakeRequests();
}

export async function run(t) {
  await t.open("chat");
  await t.waitFor(`[...document.querySelectorAll("${CHIP_TEXT}")].some((c) => c.innerText.includes("fake-model"))`);
  await t.click(".chat-list-head .btn");
  await t.waitFor(`document.querySelector(".chat-empty") !== null`);

  await t.type(".chat-input", "explain this simply");
  await t.waitFor(`!document.querySelector("${SEND_BUTTON}").disabled`);
  await t.click(SEND_BUTTON);
  await t.waitFor(`[...document.querySelectorAll(".chat-msg-model .chat-body")].some((p) => p.innerText.includes("fake reply"))`, 30000);
  await t.waitFor(`!document.querySelector(".chat-writing")`, 30000);

  const first = await waitForRequests(t, 1);
  t.assert(first.length === 1, `fake engine got ${first.length} requests, want 1`);
  const firstMessages = JSON.stringify(first[0].messages);

  await t.click(".chat-action-regenerate");
  const second = await waitForRequests(t, 2);
  t.assert(second.length === 2, `fake engine got ${second.length} requests after Regenerate, want 2`);
  await t.waitFor(`!document.querySelector(".chat-writing")`, 30000);
  t.assert(JSON.stringify(second[1].messages) === firstMessages,
    `regenerate sent ${JSON.stringify(second[1].messages)}, want the same messages as the first request`);
  t.assert((await t.count(".chat-msg-model")) === 1, "the thread does not show exactly one model reply");

  await t.click(".chat-action-copy");
  await t.waitFor(`["Copied","Could not copy"].includes(document.querySelector(".chat-action-copy")?.textContent)`);

  await t.click(".chat-action-delete");
  await t.waitFor(`document.querySelector(".chat-msg-user") === null`);
  t.assert((await t.count(".chat-msg-model")) === 1, "deleting the user message also removed the model reply");
}
