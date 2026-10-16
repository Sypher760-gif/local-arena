// Reasoning shows as a folded Thinking block, and a new chat is titled from its first message.
export const name = "34-chat-thinking-title";

const CHIP_TEXT = "#topbar .chip";
const NEW_BUTTON = ".chat-list-head .btn";
const SEND_BUTTON = ".chat-composer-bar .btn-primary";
const THINKING = ".chat-msg-model .thought-row";
const ROW_TITLE = ".list-row.selected .list-row-title";

const SENT = "Explain how a transformer model reads a sentence step by step in plain English";
const EXPECTED_TITLE = SENT.trim().slice(0, 40).replace(/[.,;:!?]+$/, "").trim();

export async function run(t) {
  await t.open("chat");
  await t.waitFor(`[...document.querySelectorAll("${CHIP_TEXT}")].some((c) => c.innerText.includes("fake-model"))`);
  await t.click(NEW_BUTTON);
  await t.waitFor(`document.querySelector(".chat-empty") !== null`);

  // Thinking low makes the fake engine stream reasoning words before the answer.
  await t.click(".chat-settings-toggle");
  await t.eval(`(() => {
    const thinking = document.querySelector(".chat-setting-select");
    thinking.value = "low";
    thinking.dispatchEvent(new Event("change"));
  })()`);
  await t.waitFor(`document.querySelector(".chat-chips")?.innerText.includes("thinking low")`);

  await t.type(".chat-input", SENT);
  await t.waitFor(`!document.querySelector("${SEND_BUTTON}").disabled`);
  await t.click(SEND_BUTTON);
  await t.waitFor(`!document.querySelector(".chat-writing")`, 30000);

  // The reply carries a Thinking disclosure, closed once the answer is there.
  await t.waitFor(`document.querySelector("${THINKING}") !== null`, 5000);
  const thinking = await t.eval(`(() => {
    const box = document.querySelector("${THINKING}");
    return { open: box?.open, text: document.querySelector("${THINKING} .thought-text")?.textContent };
  })()`);
  t.assert(thinking.open === false, `the Thinking block is open after the answer started`);
  t.assert(typeof thinking.text === "string" && thinking.text.includes("thinking"), `Thinking text is ${JSON.stringify(thinking.text)}`);

  // The sidebar row is renamed from the first 40 characters of the first message.
  const title = await t.eval(`(() => document.querySelector("${ROW_TITLE}").innerText)()`);
  t.assert(title === EXPECTED_TITLE, `sidebar title is "${title}", want "${EXPECTED_TITLE}"`);
}
