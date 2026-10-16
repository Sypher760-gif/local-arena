// Tests for app/js/engine.js (live client) and engine-sim.js (demo mode).
// Run: node tools/test_engine.mjs   (Node 22+: fetch, EventTarget, CustomEvent, AbortController)
// Starts tools/fake_engine.py on 8774 and tools/stub_gateway.py on 8773 as child processes.
// The live-switch checks also start server.py on 8771 with ARENA_SWITCH_FAKE=1 (fake switcher).
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OFFSET = Number(process.env.ARENA_PORT_OFFSET ?? 0); // 100, 200 ... moves every test port
const GATEWAY = `http://127.0.0.1:${8773 + OFFSET}`;
const SWITCH_GATEWAY = `http://127.0.0.1:${8771 + OFFSET}`;
const ENGINE = `http://127.0.0.1:${8774 + OFFSET}`;
const PYTHON = process.env.PYTHON ?? "python";
const ENGINE_JS = pathToFileURL(path.join(ROOT, "app", "js", "engine.js")).href;

const children = [];
let failures = 0;

function check(name, ok, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(test, timeoutMs, stepMs = 100) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await test()) return true;
    await sleep(stepMs);
  }
  return false;
}

function startProcess(scriptPath, args, env = {}) {
  const child = spawn(PYTHON, [path.join(ROOT, scriptPath), ...args], {
    cwd: ROOT,
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, ...env },
  });
  child.stderrText = "";
  child.stderr.on("data", (chunk) => {
    child.stderrText += chunk;
  });
  children.push(child);
  return child;
}

const startEngineProcess = (script, args) => startProcess(path.join("tools", script), args);

const isUp = (url) => fetch(url).then((r) => r.ok).catch(() => false);

// Web fetch resolves relative paths against the active gateway. The splitter test replaces the chat call.
const realFetch = globalThis.fetch;
let chatOverride = null;
let activeGateway = GATEWAY;
globalThis.fetch = (url, init) => {
  const text = String(url);
  if (chatOverride && text.startsWith("/v1/chat/completions")) return chatOverride(init);
  return realFetch(text.startsWith("/") ? activeGateway + text : text, init);
};
globalThis.location = { origin: GATEWAY, search: "", href: `${GATEWAY}/index.html` };

function within25(actual, expected) {
  return Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) <= 0.25 * expected;
}

async function fakeCompletionTokens() {
  let value = null;
  await waitUntil(async () => {
    const j = await realFetch(`${ENGINE}/debug/completions`).then((r) => r.json()).catch(() => null);
    value = j?.completions?.at(-1)?.completion_tokens ?? null;
    return value !== null;
  }, 3000);
  return value;
}

// Records every event of one reply. `finished` resolves on 'done'.
function watchReply(target) {
  const log = { words: [], texts: [], thinking: [], speeds: [], phases: [], errors: [], order: [], done: null };
  const ac = new AbortController();
  const { signal } = ac;
  const finished = new Promise((resolve) => {
    target.addEventListener("word", (e) => log.words.push(e.detail.word), { signal });
    target.addEventListener("text", (e) => log.texts.push(e.detail.delta), { signal });
    target.addEventListener("thinking", (e) => log.thinking.push(e.detail.delta), { signal });
    target.addEventListener("speed", (e) => { log.speeds.push(e.detail); log.phases.push(e.detail.phase); }, { signal });
    target.addEventListener("error", (e) => {
      log.errors.push(e.detail.message);
      log.order.push("error");
    }, { signal });
    target.addEventListener("done", (e) => {
      log.done = e.detail;
      log.order.push("done");
      ac.abort();
      resolve(log);
    }, { signal });
  });
  return { log, finished, dispose: () => ac.abort() };
}

// Starts a reply and waits up to 30 s for 'done'. Returns null if the reply did not start or did not end.
async function reply(target, start) {
  const watch = watchReply(target);
  if (!start()) {
    watch.dispose();
    return null;
  }
  return Promise.race([watch.finished, sleep(30000).then(() => null)]);
}

function streamOf(pieces) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const piece of pieces) controller.enqueue(encoder.encode(piece));
      controller.close();
    },
  });
}

async function main() {
  // Start the test engine and the stub gateway, then load the live client.
  const fake = startEngineProcess("fake_engine.py", ["--port", String(8774 + OFFSET), "--wps", "25"]);
  startEngineProcess("stub_gateway.py", ["--port", String(8773 + OFFSET), "--engine", `127.0.0.1:${8774 + OFFSET}`]);
  check("fake engine and stub gateway start", await waitUntil(async () =>
    (await isUp(`${ENGINE}/health`)) && (await isUp(`${GATEWAY}/index.html`)), 15000));

  const live = await import(ENGINE_JS);
  const engine = live.engine;
  check("live mode by default", engine.mode === "live");
  check("engine.js exports defaultLayers", typeof live.defaultLayers === "function");

  // 0. One streamed chunk is not one token. NInfer puts about three tokens in a chunk, so counting
  //    chunks showed about a third of the real speed; the count comes from the text instead.
  const est = live.estimateTokens;
  check("estimateTokens: a three-word chunk is about four tokens, not one",
    est("the quick brown") >= 3, String(est("the quick brown")));
  check("estimateTokens: a single word is one token", est("ready") === 1, String(est("ready")));
  check("estimateTokens: empty text is nothing", est("") === 0 && est(null) === 0 && est("   ") === 0);
  check("estimateTokens: text with no spaces falls back to characters",
    est("12345678901234567890") >= 4, String(est("12345678901234567890")));
  check("estimateTokens: a chunk with three tokens counts three times a one-token chunk",
    est("a b c") > est("a"), `${est("a b c")} vs ${est("a")}`);

  // 1. Status mapping.
  const up = await waitUntil(() => engine.reachable && engine.loadedModelId !== null, 8000);
  check("status: engine reachable through the gateway", up);
  check("status: model id", engine.loadedModelId === "fake-model-q4", String(engine.loadedModelId));
  check("status: model split into name and version",
    engine.loadedModel?.name === "fake-model" && engine.loadedModel?.version === "Q4" && engine.loadedModel?.id === "fake-model-q4",
    JSON.stringify(engine.loadedModel));
  check("status: maxContext from the engine", engine.maxContext === 32768, String(engine.maxContext));
  check("status: GPU used and total in GB",
    Math.abs(engine.gpuUsedGB - 6000 / 1024) < 0.001 && Math.abs(engine.gpuTotalGB - 12000 / 1024) < 0.001,
    `${engine.gpuUsedGB.toFixed(3)} / ${engine.gpuTotalGB.toFixed(3)}`);
  check("status: fit is fits for a small model", engine.fit === "fits", String(engine.fit));
  check("status: other apps 1.2 GB, no reply yet", engine.memory.otherAppsGB === 1.2 && engine.contextTokens === 0);
  check("status: loadSettings readable by chat (all on the card)", engine.loadSettings?.layersOnCard === Infinity);

  // 2. A plain reply.
  const r1 = await reply(engine, () => engine.sendPrompt("hi there", { maxTokens: 40 }));
  check("sendPrompt streams word events", r1 !== null && r1.words.length > 10, `${r1?.words.length ?? 0} words`);
  check("done: text, counts and finishReason stop",
    r1?.done && r1.done.text === r1.words.join(" ") && r1.done.words === r1.words.length
      && r1.done.finishReason === "stop" && r1.done.failed === false,
    JSON.stringify({ words: r1?.done?.words, finishReason: r1?.done?.finishReason, failed: r1?.done?.failed }));
  await waitUntil(async () => (await realFetch(`${ENGINE}/metrics`).then((r) => r.json()).catch(() => null))?.requests?.length >= 1, 3000);
  const fakeMetrics = await realFetch(`${ENGINE}/metrics`).then((r) => r.json()).catch(() => null);
  const fakeReq = fakeMetrics?.requests?.[0];
  const trueTps = r1?.done ? r1.done.tokens / r1.done.seconds : 0;
  const trueWriteTps = r1?.done && r1.done.speedSeconds > 0 ? r1.done.tokens / r1.done.speedSeconds : 0;
  const lastSpeed = r1?.speeds?.at(-1);
  check("done: tokens equal the fake engine completion_tokens",
    r1?.done?.tokens > 0 && r1.done.tokens === fakeReq?.completion_tokens && r1.done.tokens === r1.done.completionTokens,
    `done ${r1?.done?.tokens} / fake ${fakeReq?.completion_tokens}`);
  check("done: promptTokens from the engine usage", r1?.done?.promptTokens > 0 && r1.done.promptTokens === fakeReq?.prompt_tokens,
    `done ${r1?.done?.promptTokens} / fake ${fakeReq?.prompt_tokens}`);
  check("speed events carry a live tokensPerSecond", r1 && r1.speeds.length > 0 && r1.speeds.every((s) => typeof s.tokensPerSecond === "number" && s.tokensPerSecond >= 0),
    `${r1?.speeds.length ?? 0} speed events`);
  check("live tokensPerSecond within 25% of tokens/seconds", lastSpeed && trueTps > 0 && Math.abs(lastSpeed.tokensPerSecond - trueTps) <= 0.25 * trueTps,
    `live ${lastSpeed?.tokensPerSecond?.toFixed(1)} vs ${trueTps.toFixed(1)} tok/s`);
  check("done: tokensPerSecond is the speed over the first token to the last, within 25%",
    r1?.done && trueWriteTps > 0 && Math.abs(r1.done.tokensPerSecond - trueWriteTps) <= 0.25 * trueWriteTps,
    `done ${r1?.done?.tokensPerSecond?.toFixed(1)} vs ${trueWriteTps.toFixed(1)} tok/s`);
  check("done: the speed window is at most the whole reply time",
    r1?.done && r1.done.speedSeconds > 0 && r1.done.speedSeconds <= r1.done.seconds + 0.05,
    `window ${r1?.done?.speedSeconds?.toFixed(3)} s of ${r1?.done?.seconds?.toFixed(3)} s`);
  check("done: the first token arrives before the reply ends",
    r1?.done && r1.done.firstTokenSeconds !== null && r1.done.firstTokenSeconds <= r1.done.seconds + 0.05,
    `first token ${r1?.done?.firstTokenSeconds?.toFixed(3)} s, reply ${r1?.done?.seconds?.toFixed(3)} s`);
  check("text events carry the answer text", r1 && r1.texts.join("").trim().split(/\s+/).join(" ") === r1.done.text);
  check("speed measured after the reply", engine.lastReplySpeed > 0 && engine.speed.wordsPerSecond >= 0,
    `${engine.lastReplySpeed?.toFixed(1)} words per second`);
  check("contextTokens = prompt + reply after the reply", engine.contextTokens === r1.done.promptTokens + r1.done.completionTokens);

  // 3. Thinking.
  const r2 = await reply(engine, () => engine.sendPrompt("think", { thinking: "low", maxTokens: 20 }));
  check("thinking events when thinking is low", r2 !== null && r2.thinking.length > 0 && r2.thinking.join("").includes("thinking0"),
    `${r2?.thinking.length ?? 0} thinking chunks`);
  check("thinking text is not in the answer", r2 && !r2.done.text.includes("thinking"));
  const fake2 = await fakeCompletionTokens();
  check("thinking tokens are counted in the final token count",
    r2?.done && r2.done.tokens === fake2 && r2.done.tokens === r2.done.words + r2.thinking.length,
    `done ${r2?.done?.tokens} / fake ${fake2}, ${r2?.done?.words}+${r2?.thinking?.length}`);
  check("thinking reply tokensPerSecond is the speed over the first token to the last",
    r2?.done && r2.done.speedSeconds > 0 && within25(r2.done.tokensPerSecond, r2.done.tokens / r2.done.speedSeconds),
    `done ${r2?.done?.tokensPerSecond} vs ${r2?.done ? r2.done.tokens / r2.done.speedSeconds : "none"}`);
  check("done: thinkingSeconds above 0", r2?.done && r2.done.thinkingSeconds > 0,
    `thinkingSeconds ${r2?.done?.thinkingSeconds}`);
  check("done: thinkingTokens counts the thinking pieces, and a piece may hold more than one token",
    r2?.done && r2.done.thinkingTokens > 0 && r2.done.thinkingTokens >= r2.thinking.length,
    `done ${r2?.done?.thinkingTokens} / thinking pieces ${r2?.thinking?.length}`);
  const phaseSeq = [...new Set(r2?.phases ?? [])].join(",");
  check("speed phases go reading, thinking, writing in order", phaseSeq === "reading,thinking,writing", phaseSeq);

  // 4. Words split across chunks: a hand-made stream, cut inside words and inside an SSE line.
  chatOverride = () => new Response(streamOf([
    'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\nda',
    'ta: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choices":[{"delta":{"content":"lo wor"}}]}\n\n'
      + 'data: {"choices":[{"delta":{"content":"ld  foo"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\n'
      + "data: [DONE]\n\n",
  ]), { status: 200, headers: { "Content-Type": "text/event-stream" } });
  const r3 = await reply(engine, () => engine.sendPrompt([{ role: "user", content: "split" }]));
  chatOverride = null;
  check("split words are whole: Hello world foo",
    r3 && r3.words.join("|") === "Hello|world|foo", r3 ? r3.words.join("|") : "no reply");
  check("done from the usage chunk", r3?.done?.text === "Hello world foo" && r3.done.promptTokens === 7
    && r3.done.completionTokens === 3 && r3.done.tokens === 3 && r3.done.finishReason === "stop" && r3.done.failed === false);

  // 4b. Code and markup hold far more tokens than the live estimate counts (the
  //     graph's peak once sat under the reply's own speed). The finished reply reports how far off the
  //     estimate was, so the screen can fix its graph, and the next live figure learns from it.
  const keptScale = engine._tokenScale;
  engine._tokenScale = 1;
  chatOverride = () => new Response(streamOf([
    'data: {"choices":[{"delta":{"content":"a b c d "}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":20}}\n\n'
      + "data: [DONE]\n\n",
  ]), { status: 200, headers: { "Content-Type": "text/event-stream" } });
  const r4b = await reply(engine, () => engine.sendPrompt([{ role: "user", content: "markup" }]));
  chatOverride = null;
  check("done carries the token correction (engine count / live estimate)",
    r4b?.done?.tokenCorrection === 4, String(r4b?.done?.tokenCorrection));
  check("a short reply nudges the live scale, it does not jump to it",
    Math.abs(engine._tokenScale - 1.075) < 1e-9, String(engine._tokenScale));
  engine._tokenScale = keptScale;

  // 5. stop() mid-stream, and sendPrompt refused while streaming.
  const w5 = watchReply(engine);
  const started5 = engine.sendPrompt("long reply", { maxTokens: 300 });
  check("sendPrompt returns false while streaming", started5 === true && engine.sendPrompt("again") === false);
  await waitUntil(() => w5.log.words.length >= 5, 5000);
  engine.stop();
  const log5 = await Promise.race([w5.finished, sleep(5000).then(() => null)]);
  check("stop() ends the reply with finishReason cancel, text kept",
    log5?.done?.finishReason === "cancel" && log5.done.failed === false && log5.done.words > 0
      && log5.done.text === log5.words.join(" "),
    `${log5?.done?.words} words`);
  const idle = await waitUntil(async () => {
    const m = await realFetch(`${ENGINE}/metrics`).then((r) => r.json()).catch(() => null);
    return m?.live?.state === "idle";
  }, 3000);
  check("fake engine goes idle within 3 s of stop()", idle);

  // 6. Engine killed mid-reply, unreachable, then restarted.
  const w6 = watchReply(engine);
  engine.sendPrompt("kill", { maxTokens: 300 });
  await waitUntil(() => w6.log.words.length >= 5, 5000);
  fake.kill();
  const log6 = await Promise.race([w6.finished, sleep(10000).then(() => null)]);
  check("killed mid-reply: error, then done failed with the partial text",
    log6?.order.join(">") === "error>done" && log6.done.failed === true && log6.done.text.length > 0
      && log6.done.text === log6.words.join(" ") && log6.done.finishReason === "error",
    `order ${log6?.order.join(">")}, ${log6?.done?.words} words`);
  check("reachable false within 4 s of the kill", await waitUntil(() => !engine.reachable, 4000));
  check("unreachable: no model, sendPrompt returns false", engine.loadedModelId === null && engine.sendPrompt("x") === false);
  startEngineProcess("fake_engine.py", ["--port", String(8774 + OFFSET), "--wps", "25"]);
  check("reachable again after the engine restarts",
    await waitUntil(() => engine.reachable && engine.loadedModelId === "fake-model-q4", 6000));

  // 7. Live switching through the gateway (server.py with ARENA_SWITCH_FAKE=1, fake engine on 8774).
  const tmp = mkdtempSync(path.join(os.tmpdir(), "arena-switch-"));
  writeFileSync(path.join(tmp, "models.json"), JSON.stringify([
    { id: "switch-a", name: "Switch A", version: "Q8_0", engine: "llama.cpp", contextTokens: 4096, folder: tmp, matchId: "switch-a" },
    { id: "switch-b", name: "Switch B", version: "IQ3_XXS", engine: "llama.cpp", contextTokens: 4096, folder: tmp, matchId: "switch-b" },
    { id: "bad-entry", name: "Bad Entry", version: "Q4", engine: "llama.cpp", contextTokens: 4096, folder: tmp, matchId: 42 },
  ]), "utf8");
  startProcess("server.py", [], {
    ARENA_PORT: String(8771 + OFFSET),
    ARENA_ENGINE: `127.0.0.1:${8774 + OFFSET}`,
    ARENA_SWITCH_FAKE: "1",
    ARENA_MODELS: path.join(tmp, "models.json"),
    ARENA_STORE: path.join(tmp, "store"),
    ARENA_LIVE: path.join(tmp, "live"),
  });
  check("switch gateway starts", await waitUntil(() => isUp(`${SWITCH_GATEWAY}/index.html`), 15000));
  activeGateway = SWITCH_GATEWAY;
  await engine.refresh();
  check("switch gateway sees the same engine", engine.reachable && engine.loadedModelId === "fake-model-q4",
    `${engine.reachable} / ${engine.loadedModelId}`);

  const progressEvents = [];
  const switchErrors = [];
  engine.addEventListener("progress", (e) => progressEvents.push(e.detail));
  engine.addEventListener("error", (e) => switchErrors.push(e.detail.message));

  // A load ends with progress events and the new model loaded.
  const settle = async (promise, ms) => {
    try {
      return await Promise.race([promise, sleep(ms).then(() => "timeout")]);
    } catch (error) {
      return `rejected: ${error.message}`;
    }
  };
  const loadA = engine.loadModel("switch-a");
  check("loading state appears during a switch",
    engine.loading?.modelId === "switch-a" && engine.loading?.direction === "load", JSON.stringify(engine.loading));
  // Give the first poll a moment, then the gateway's stage label must be on the loading state.
  await sleep(1400);
  check("stage label is exposed during the switch",
    typeof engine.loading?.stageLabel === "string" && engine.loading.stageLabel.length > 0,
    JSON.stringify(engine.loading));
  const resultA = await settle(loadA, 90000);
  check("load switch-a finished", resultA === undefined, String(resultA));
  check("progress events during the switch", progressEvents.length >= 2
    && progressEvents.every((p) => p.modelId === "switch-a" && p.progress >= 0 && p.progress <= 1),
    `${progressEvents.length} events`);
  check("progress estimate is capped below 1 until ready", progressEvents.slice(0, -1).every((p) => p.progress <= (p.stageLabel === "Warming up the model" ? 0.97 : 0.95)),
    progressEvents.map((p) => p.progress.toFixed(2)).join(" "));
  check("progress never goes backwards",
    progressEvents.every((p, i) => i === 0 || p.progress >= progressEvents[i - 1].progress),
    progressEvents.map((p) => p.progress.toFixed(2)).join(" "));
  check("last progress event is 1", progressEvents.at(-1)?.progress === 1, String(progressEvents.at(-1)?.progress));
  check("loading cleared after the switch", engine.loading === null);
  check("the new model is loaded", engine.loadedModelId === "switch-a" && engine.loadedModel?.id === "switch-a",
    String(engine.loadedModelId));

  // A second load while a switch runs is refused with a plain message.
  progressEvents.length = 0;
  const loadB = engine.loadModel("switch-b");
  let refused = null;
  try {
    await engine.loadModel("switch-a");
  } catch (error) {
    refused = error.message;
  }
  check("second load while loading is refused", typeof refused === "string" && refused.length > 0, String(refused));
  const resultB = await settle(loadB, 90000);
  check("switch to the second model finished", resultB === undefined, String(resultB));
  check("second model loaded", engine.loadedModelId === "switch-b", String(engine.loadedModelId));

  // A switch the launcher cannot start ends as a plain error event.
  switchErrors.length = 0;
  await settle(engine.loadModel("bad-entry"), 30000);
  check("failed switch emits error", switchErrors.length === 1 && switchErrors[0].includes("switch failed"),
    String(switchErrors[0]));
  check("loading cleared after a failed switch", engine.loading === null);

  // Unload stops the engine and leaves nothing running.
  await settle(engine.unloadModel(), 60000);
  check("unload leaves the engine unreachable", await waitUntil(() => !engine.reachable && engine.loadedModelId === null, 8000));
  check("no fake engine answers after unload", !(await isUp(`${ENGINE}/health`)));

  // 8. Demo mode: ?sim=1 loads the simulated engine.
  globalThis.location = { ...globalThis.location, search: "?sim=1" };
  const sim = (await import(`${ENGINE_JS}?sim=1`)).engine;
  check("sim: mode is sim", sim.mode === "sim");
  await sim.loadModel("qwen3.5-9b-q4km", { instant: true });
  check("sim: loaded model and maxContext from data.js",
    sim.loadedModel?.name === "qwen3.5-9b" && sim.loadedModel?.version === "Q4_K_M" && sim.maxContext === 32768);
  const s1 = await reply(sim, () => sim.sendPrompt("hi"));
  check("sim: short reply completes with finishReason stop",
    s1?.done?.finishReason === "stop" && s1.done.failed === false && s1.done.text === s1.words.join(" ") && s1.words.length > 10,
    `${s1?.words.length ?? 0} words`);
  check("sim: text events on each word", s1 && s1.texts.length === s1.words.length && s1.texts[0] === `${s1.words[0]} `);
  const simTrueTps = s1?.done ? s1.done.tokens / s1.done.seconds : 0;
  check("sim: done carries tokens and tokensPerSecond", s1?.done?.tokens > 0 && s1.done.tokens === s1.done.completionTokens
    && simTrueTps > 0 && Math.abs(s1.done.tokensPerSecond - simTrueTps) <= 0.25 * simTrueTps,
    `${s1?.done?.tokens} tokens, ${s1?.done?.tokensPerSecond?.toFixed(1)} tok/s`);
  check("sim: speed events carry a live tokensPerSecond", s1 && s1.speeds.length > 0 && s1.speeds.every((s) => typeof s.tokensPerSecond === "number" && s.tokensPerSecond >= 0),
    `${s1?.speeds.length ?? 0} speed events`);
  check("sim: speed carries averageTokensPerSecond", sim.speed.averageTokensPerSecond > 0, String(sim.speed.averageTokensPerSecond));
}

let exitCode = 1;
try {
  await main();
  exitCode = failures === 0 ? 0 : 1;
  console.log(failures === 0 ? "ALL PASS" : `${failures} FAIL`);
} catch (error) {
  console.log(`FAIL test run stopped: ${error?.stack ?? error}`);
  exitCode = 1;
} finally {
  // Leave no fake engine running on the test port, whatever the checks did.
  try {
    await realFetch(`${SWITCH_GATEWAY}/api/switch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: null }),
    });
  } catch {
    // The gateway is already gone.
  }
  await sleep(1500);
  for (const child of children) {
    if (child.exitCode === null) child.kill();
    if (child.stderrText) console.log(`stderr of pid ${child.pid}: ${child.stderrText.trim().split("\n").slice(-3).join(" | ")}`);
  }
  await sleep(300);
  process.exit(exitCode);
}
