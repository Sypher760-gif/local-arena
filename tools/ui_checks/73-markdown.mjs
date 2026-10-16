// Markdown rendering: the fake engine returns bold, a list and a table; Chat and Arena show real elements.
export const name = "73-markdown";

const SEND = ".chat-composer-bar .btn-primary";
const START = ".arena-start";
const CHIP = "#topbar .chip";

const chatBody = `(() => {
  const body = [...document.querySelectorAll(".chat-msg-model .chat-body")].pop();
  if (!body) return null;
  return {
    strong: !!body.querySelector("strong"),
    list: !!body.querySelector("ul") || !!body.querySelector("ol"),
    table: !!body.querySelector("table"),
    stars: body.innerText.includes("**"),
  };
})()`;

const arenaTexts = `(() => [...document.querySelectorAll(".arena-text")].map((t) => ({
  strong: !!t.querySelector("strong"),
  list: !!t.querySelector("ul") || !!t.querySelector("ol"),
  table: !!t.querySelector("table"),
  stars: t.innerText.includes("**"),
})))()`;

export async function run(t) {
  // Chat: a reply with markdown renders as real elements, and the raw ** never shows.
  await t.open("chat");
  await t.waitFor(`[...document.querySelectorAll("${CHIP}")].some((c) => c.innerText.includes("fake-model"))`, 15000);
  await t.type(".chat-input", "[[markdown]] please");
  await t.waitFor(`!document.querySelector("${SEND}").disabled`, 8000);
  await t.click(SEND);
  await t.waitFor(`[...document.querySelectorAll(".chat-msg-model .chat-body")].some((b) => b.querySelector("table"))`, 30000);
  await t.waitFor(`!document.querySelector(".chat-writing")`, 30000);
  const chat = await t.eval(chatBody);
  t.assert(chat, "no model reply body on Chat");
  t.assert(chat.strong, "Chat reply has no <strong> for **bold**");
  t.assert(chat.list, "Chat reply has no <ul> or <ol> for the list");
  t.assert(chat.table, "Chat reply has no <table> for the table");
  t.assert(!chat.stars, "Chat reply still shows the literal ** markers");

  // Arena: the same markdown reply on both sides renders as real elements.
  await t.open("arena");
  await t.waitFor(`document.querySelector("${START}") && !document.querySelector("${START}").disabled`, 12000);
  await t.eval(`(() => { const b = [...document.querySelectorAll(".arena-question button")].find((x) => x.innerText.trim() === "Edit question"); if (b) b.click(); return !!b; })()`);
  await t.waitFor(`document.querySelector(".arena-edit-input") !== null`, 8000);
  await t.type(".arena-edit-input", "[[markdown]]");
  await t.eval(`(() => { const b = [...document.querySelectorAll(".arena-edit-buttons .btn-primary")].find((x) => x.innerText.trim() === "Done"); if (b) b.click(); return !!b; })()`);
  await t.waitFor(`document.querySelector(".arena-question-text")?.innerText.includes("[[markdown]]")`, 8000);
  await t.click(START);
  await t.waitFor(`[...document.querySelectorAll(".arena-text")].length === 2 && [...document.querySelectorAll(".arena-text")].every((x) => x.querySelector("table"))`, 30000);
  const sides = await t.eval(arenaTexts);
  t.assert(sides.length === 2, `two Arena answers, got ${sides.length}`);
  for (const [i, s] of sides.entries()) {
    t.assert(s.strong, `Arena side ${i} has no <strong>`);
    t.assert(s.list, `Arena side ${i} has no <ul> or <ol>`);
    t.assert(s.table, `Arena side ${i} has no <table>`);
    t.assert(!s.stars, `Arena side ${i} still shows the literal ** markers`);
  }
}
