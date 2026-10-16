// Chat settings are editable, sent to the engine, and survive a reload.
export const name = "31-chat-settings";

const CHIP_TEXT = "#topbar .chip";
const SEND_BUTTON = ".chat-composer-bar .btn-primary";

export async function run(t) {
  await t.open("chat");
  await t.waitFor(`[...document.querySelectorAll("${CHIP_TEXT}")].some((c) => c.innerText.includes("fake-model"))`);

  // Start from a fresh chat: "New" is disabled until the saved chats have loaded, so this also waits for that load.
  await t.click(".chat-list-head .btn");
  await t.waitFor(`document.querySelector(".chat-empty") !== null`);

  await t.click(".chat-settings-toggle");
  await t.eval(`(() => {
    const temperature = document.querySelectorAll(".chat-setting-input")[0];
    temperature.value = "0.3";
    temperature.dispatchEvent(new Event("change"));
    const thinking = document.querySelector(".chat-setting-select");
    thinking.value = "low";
    thinking.dispatchEvent(new Event("change"));
  })()`);
  await t.waitFor(`document.querySelector(".chat-chips")?.innerText.includes("temp 0.3")`);
  await t.waitFor(`document.querySelector(".chat-chips")?.innerText.includes("thinking low")`);

  await t.type(".chat-input", "answer briefly");
  await t.waitFor(`!document.querySelector("${SEND_BUTTON}").disabled`);
  await t.click(SEND_BUTTON);

  // The send can land a moment after the click; poll until the engine has logged it (still asserts exactly 1).
  let requests = await t.fakeRequests();
  for (let i = 0; i < 40 && requests.length < 1; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    requests = await t.fakeRequests();
  }
  await t.waitFor(`!document.querySelector(".chat-writing")`, 30000);
  t.assert(requests.length === 1, `fake engine got ${requests.length} requests, want 1`);
  t.assert(requests[0].temperature === 0.3, `temperature is ${requests[0].temperature}, want 0.3`);
  t.assert(requests[0].reasoning_effort === "low", `reasoning_effort is ${requests[0].reasoning_effort}, want low`);
  // Limit thinking is on by default: the cap is Low's thinking room. No repeat penalty is sent until one is set.
  t.assert(requests[0].thinking_budget === 2000, `thinking_budget is ${requests[0].thinking_budget}, want 2000`);
  t.assert(!("presence_penalty" in requests[0]), `presence_penalty sent unasked: ${requests[0].presence_penalty}`);

  await t.reload();
  await t.waitFor(`document.querySelector(".chat-chips")?.innerText.includes("thinking low")`);
  const saved = await t.eval(`(() => {
    const temperature = document.querySelectorAll(".chat-setting-input")[0];
    return { temperature: temperature.value, thinking: document.querySelector(".chat-setting-select").value };
  })()`);
  t.assert(Number(saved.temperature) === 0.3, `temperature after reload is ${saved.temperature}, want 0.3`);
  t.assert(saved.thinking === "low", `thinking after reload is ${saved.thinking}, want low`);
}
