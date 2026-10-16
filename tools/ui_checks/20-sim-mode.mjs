// Demo mode (?sim=1): the chat screen shows the simulated conversation list and no errors.
export const name = "20-sim-mode";

export async function run(t) {
  await t.open("chat", "?sim=1");
  await t.waitFor(`document.querySelectorAll(".chat-list .chat-group").length > 0`);
  const groups = await t.count(".chat-list .chat-group");
  t.assert(groups > 0, "demo conversation list has no date groups");
  const rows = await t.count(".chat-list .chat-group-rows > *");
  t.assert(rows > 0, "demo conversation list has no rows");
}
