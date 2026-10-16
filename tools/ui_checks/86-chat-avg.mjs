// Chat avg belongs to one chat: a new chat starts with no average, going back to a
// chat shows its own average again, and the small reset button clears it for that chat only.
export const name = "86-chat-avg";

const AVG = `(() => {
  const cell = [...document.querySelectorAll(".speed-stats .stat")].find((c) => c.querySelector(".stat-label")?.textContent.startsWith("Chat avg"));
  return cell ? cell.querySelector(".stat-value").textContent.trim() : null;
})()`;
const SEND = ".chat-composer-bar .btn-primary";
const NEW = [...Array(1)].map(() => `[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "New")`)[0];

async function ask(t, text) {
  const before = await t.eval(`document.querySelectorAll(".chat-msg-model .chat-stats").length`);
  await t.type(".chat-input", text);
  await t.waitFor(`!document.querySelector("${SEND}").disabled`);
  await t.click(SEND);
  await t.waitFor(`document.querySelectorAll(".chat-msg-model .chat-stats").length > ${before}`, 30000);
  await t.waitFor(`!document.querySelector(".chat-writing")`, 30000);
}

export async function run(t) {
  await t.open("chat");
  await t.waitFor(`!!document.querySelector(".stat-reset")`, 12000);
  const label = await t.eval(`document.querySelector(".stat-reset").getAttribute("aria-label")`);
  t.assert(label && !(await t.eval(`document.querySelector(".stat-reset").textContent.trim()`)), "the reset button should be an icon with no words");

  // Chat A gets an average.
  await t.eval(`${NEW}.click()`);
  await ask(t, "first chat question");
  const firstId = await t.eval(`localStorage.getItem("bench.chat.last")`);
  const avgA = await t.eval(AVG);
  t.assert(avgA && avgA !== "—", `chat A has no average after a reply ("${avgA}")`);

  // A brand new chat starts empty.
  await t.eval(`${NEW}.click()`);
  await t.waitFor(`document.querySelectorAll(".chat-msg-user, .chat-msg-model").length === 0`, 8000);
  t.assert((await t.eval(AVG)) === "—", `a new chat kept the old average ("${await t.eval(AVG)}")`);

  // Back to chat A: its average is there again.
  await t.eval(`[...document.querySelectorAll(".chat-list button")].find((b) => b.textContent.includes("first chat question"))?.click()`);
  await t.waitFor(`document.querySelectorAll(".chat-msg-model .chat-stats").length === 1`, 8000);
  t.assert((await t.eval(AVG)) === avgA, `chat A's average changed after a visit elsewhere ("${await t.eval(AVG)}" vs "${avgA}")`);

  // Reset clears it, and the next reply starts a fresh average.
  await t.click(".stat-reset");
  await t.waitFor(`${AVG} === "—"`, 4000);
  await ask(t, "after the reset");
  const after = await t.eval(AVG);
  t.assert(after && after !== "—", `no average after a reply that followed the reset ("${after}")`);
  return firstId ? "ok" : "ok (no last-id key)";
}
