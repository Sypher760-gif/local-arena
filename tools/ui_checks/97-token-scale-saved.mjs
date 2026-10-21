// The live tok/s correction learned from a finished reply is kept per model, so after a reload (a new
// session) the first reply's live figure already uses it instead of starting from the word estimate.
export const name = "97-token-scale-saved";

export async function run(t) {
  await t.open("chat");
  await t.eval(`localStorage.removeItem("bench.tokenScale"); true`);
  await t.reload();
  await t.waitFor(`globalThis.benchEngine?.loadedModelId != null`, 15000);
  t.assert((await t.eval(`globalThis.benchEngine._tokenScale`)) === 1, "a fresh session did not start at scale 1");

  await t.type(".chat-input", "a reply long enough to learn the token scale from please");
  await t.waitFor(`!document.querySelector(".chat-composer-bar .btn-primary").disabled`);
  await t.click(".chat-composer-bar .btn-primary");
  await t.waitFor(`!!document.querySelector(".chat-msg-model .chat-stats")`, 30000);
  await t.waitFor(`!document.querySelector(".chat-writing")`, 30000);

  const model = await t.eval(`globalThis.benchEngine.loadedModelId`);
  const learned = await t.eval(`globalThis.benchEngine._tokenScale`);
  const saved = await t.eval(`JSON.parse(localStorage.getItem("bench.tokenScale") || "{}")[${JSON.stringify(model)}]`);
  t.assert(Number.isFinite(saved) && Math.abs(saved - learned) < 0.002, `saved ${saved}, learned ${learned}`);

  // New session: the saved scale is back before any reply.
  await t.reload();
  await t.waitFor(`globalThis.benchEngine?.loadedModelId != null`, 15000);
  const after = await t.eval(`globalThis.benchEngine._tokenScale`);
  t.assert(Math.abs(after - saved) < 0.002, `after reload the scale is ${after}, want ${saved}`);

  // A broken saved value is ignored.
  await t.eval(`localStorage.setItem("bench.tokenScale", JSON.stringify({ ${JSON.stringify(model)}: 99 })); true`);
  await t.reload();
  await t.waitFor(`globalThis.benchEngine?.loadedModelId != null`, 15000);
  t.assert((await t.eval(`globalThis.benchEngine._tokenScale`)) === 1, "an out-of-range saved scale was used");
  await t.eval(`localStorage.removeItem("bench.tokenScale"); true`);
}
