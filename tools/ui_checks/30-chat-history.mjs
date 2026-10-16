// Chat sends the whole conversation, the system prompt and the settings to the engine.
export const name = "30-chat-history";

const CHIP_TEXT = "#topbar .chip";
const NEW_BUTTON = ".chat-list-head .btn";
const SEND_BUTTON = ".chat-composer-bar .btn-primary";

async function openFreshChat(t) {
  await t.open("chat");
  await t.waitFor(`[...document.querySelectorAll("${CHIP_TEXT}")].some((c) => c.innerText.includes("fake-model"))`);
  await t.click(NEW_BUTTON);
  await t.waitFor(`document.querySelector(".chat-empty") !== null`);
}

async function sendAndWait(t, text) {
  const before = await t.count(".chat-msg-model");
  await t.type(".chat-input", text);
  await t.waitFor(`!document.querySelector("${SEND_BUTTON}").disabled`);
  await t.click(SEND_BUTTON);
  await t.waitFor(`document.querySelectorAll(".chat-msg-model").length > ${before}`, 30000);
  await t.waitFor(`!document.querySelector(".chat-writing")`, 30000);
}

export async function run(t) {
  await openFreshChat(t);
  await sendAndWait(t, "first question");
  await sendAndWait(t, "second question");

  const requests = await t.fakeRequests();
  t.assert(requests.length === 2, `fake engine got ${requests.length} requests, want 2`);

  const second = requests[1];
  const messages = second.messages ?? [];
  t.assert(messages.length === 3, `second request has ${messages.length} messages, want 3`);
  t.assert(messages[0].role === "user" && messages[0].content === "first question",
    `first message is ${JSON.stringify(messages[0])}, want user "first question"`);
  t.assert(messages[1].role === "assistant" && String(messages[1].content).includes("fake reply"),
    `second message is ${JSON.stringify(messages[1]).slice(0, 120)}, want the fake reply as assistant`);
  t.assert(messages[2].role === "user" && messages[2].content === "second question",
    `third message is ${JSON.stringify(messages[2])}, want user "second question"`);
  t.assert(second.temperature === 0.7, `temperature is ${second.temperature}, want 0.7`);
  t.assert(second.top_p === 0.9, `top_p is ${second.top_p}, want 0.9`);
  t.assert(second.max_tokens === 4096, `max_tokens is ${second.max_tokens}, want 4096`);

  // System prompt: the request's first message is the system message.
  await openFreshChat(t);
  await t.click(".chat-system-toggle");
  await t.type(".chat-system-text", "Be brief");
  await sendAndWait(t, "one question");

  const after = await t.fakeRequests();
  t.assert(after.length === 3, `fake engine got ${after.length} requests, want 3`);
  const first = (after[2].messages ?? [])[0] ?? {};
  t.assert(first.role === "system" && first.content === "Be brief",
    `first message is ${JSON.stringify(first)}, want system "Be brief"`);
}
