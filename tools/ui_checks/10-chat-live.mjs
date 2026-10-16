// Live chat: one message goes through the gateway to the fake engine and comes back as a reply.
export const name = "10-chat-live";

const CHIP_TEXT = "#topbar .chip";

export async function run(t) {
  await t.open("chat");
  // The chip shows the model name and version as two text nodes ("fake-model" + "Q4"), not "fake-model-q4".
  await t.waitFor(`[...document.querySelectorAll("${CHIP_TEXT}")].some((c) => c.innerText.includes("fake-model") && c.innerText.includes("Q4"))`);

  await t.type(".chat-input", "hello there friend");
  await t.waitFor(`!document.querySelector(".chat-composer-bar .btn-primary").disabled`);
  t.assert(
    (await t.text(".chat-composer-bar .btn-primary")).trim() === "Send",
    "the primary composer button is not Send",
  );
  await t.click(".chat-composer-bar .btn-primary");

  await t.waitFor(`[...document.querySelectorAll(".chat-msg-model .chat-body")].some((p) => p.innerText.includes("fake reply"))`, 30000);
  await t.waitFor(`!document.querySelector(".chat-writing")`, 30000);

  const requests = await t.fakeRequests();
  t.assert(requests.length === 1, `fake engine got ${requests.length} requests, want 1`);
  const messages = requests[0].messages ?? [];
  const last = messages[messages.length - 1] ?? {};
  t.assert(
    last.role === "user" && last.content === "hello there friend",
    `last message is ${JSON.stringify(last)}, want the user's text`,
  );
}
