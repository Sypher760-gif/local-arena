// Model tuning must be ready before a request, and stale responses must not replace newer settings.
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
globalThis.location = { search: "", href: "http://127.0.0.1/index.html" };
const pending = [];
const requests = [];
const status = (model) => ({ engine: { reachable: true, model, maxContext: 4096 }, gpu: null });
globalThis.fetch = async (url, init) => {
  if (url === "/api/status") return Response.json(status("first"));
  if (url === "/api/models") return new Promise(resolve => pending.push(resolve));
  if (url === "/v1/chat/completions") {
    requests.push(JSON.parse(init.body));
    return new Response('data: {"choices":[{"delta":{"content":"answer "}}]}\n\ndata: [DONE]\n\n');
  }
  throw new Error(`Unexpected request ${url}`);
};
const { engine } = await import(pathToFileURL(path.join(root, "app/js/engine.js")));
const wait = async (test) => {
  for (let i = 0; i < 100; i += 1) {
    if (test()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("Expected state did not arrive");
};
try {
  await wait(() => pending.length === 1);
  const old = engine._tuningPromise;
  engine._applyStatus(status("second"));
  await wait(() => pending.length === 2);
  const current = engine._tuningPromise;
  const reply = { temperature: 0.2, topK: 0, minP: 0, frequencyPenalty: 0, presencePenalty: 0, system: "new model prompt" };
  engine.sendPrompt("hello", { temperature: 1.5, presencePenalty: 1.5 });
  if (requests.length) throw new Error("Prompt was sent before model tuning was known");
  pending[1](Response.json({ models: [{ id: "second-entry", loaded: true, tuning: { reply } }] }));
  await current;
  await wait(() => requests.length === 1 && !engine.streaming);
  pending[0](Response.json({ models: [{ id: "first-entry", loaded: true, tuning: { reply: { temperature: 1.8 } } }] }));
  await old;
  if (engine.replyTuning.temperature !== 0.2 || engine.loadedEntryId !== "second-entry") throw new Error("Old catalogue response overwrote the selected model");
  const body = requests[0];
  if (body.model !== "second" || body.temperature !== 0.2 || body.messages[0].content !== reply.system) throw new Error("Request used the wrong model settings");
  if (body.top_k !== 0 || body.min_p !== 0 || body.frequency_penalty !== 0 || body.presence_penalty !== 0) throw new Error("Explicit zero settings were omitted");
  engine._applyStatus(status("third"));
  await wait(() => pending.length === 3);
  const changed = new Promise(resolve => engine.addEventListener("done", resolve, { once: true }));
  engine.sendPrompt("must not reach a different model");
  engine._applyStatus(status("fourth"));
  await wait(() => pending.length === 4);
  pending[2](Response.json({ models: [] }));
  const ended = await changed;
  if (!ended.detail.failed || requests.length !== 1) throw new Error("A pending prompt crossed to a different model");
  console.log("PASS tuning readiness, stale-response rejection, model identity, pending model change and explicit zero settings");
  process.exit(0);
} catch (error) {
  console.log(`FAIL ${error.stack}`);
  process.exit(1);
}
