// Tests: three answer-length choices, each with a time from the loaded model.
// The long choice sends a hard question with a 2,000-token limit. The short choice skips hard
// questions and keeps the 400-token limit.
export const name = "84-tests-pace";

import http from "node:http";

const SLUGS = ["logic", "math", "science", "coding", "reading", "following"];
const START = ".setup-start";
const UNKNOWN = "Time not known yet for this model.";

const MATH = [
  {
    id: "M-E",
    type: "Math",
    prompt: "EASY-PACE question. Reply with just the number. [[reply:1]]",
    check: "number",
    expected: "1",
    difficulty: "easy",
  },
  ...[1, 2, 3, 4].map((n) => ({
    id: `M-H${n}`,
    type: "Math",
    prompt: `HARD-PACE question ${n}. Reply with just the number. [[reply:1]]`,
    check: "number",
    expected: "1",
    difficulty: "hard",
  })),
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function clearRuns(t) {
  await t.eval(`(async () => {
    const res = await fetch('/api/store/runs');
    const items = (await res.json()).items ?? [];
    await Promise.all(items.map((i) => fetch('/api/store/runs/' + i.id, { method: 'DELETE' })));
    return items.length;
  })()`);
}

async function waitForStoreCount(t, want) {
  for (let i = 0; i < 240; i += 1) {
    const items = await t.storeList("runs");
    if (items.length === want) return items;
    await sleep(250);
  }
  return t.storeList("runs");
}

function serveFixtures() {
  const server = http.createServer((request, response) => {
    const headers = { "Access-Control-Allow-Origin": "*" };
    const slug = (request.url ?? "").split("?")[0].replace(/^\//, "").replace(/\.json$/, "");
    if (!SLUGS.includes(slug)) {
      response.writeHead(404, headers);
      response.end("not found");
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json", ...headers });
    response.end(JSON.stringify(slug === "math" ? MATH : []));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const untickAll = `(() => {
  [...document.querySelectorAll(".setup-type input[type=checkbox]")].forEach((b) => { if (b.checked) b.click(); });
  return true;
})()`;

const pick = (typeName, count) => `(() => {
  const row = [...document.querySelectorAll(".setup-type")].find((r) => r.querySelector(".setup-type-name").textContent.trim() === ${JSON.stringify(typeName)});
  if (!row) throw new Error("no setup row for " + ${JSON.stringify(typeName)});
  const box = row.querySelector("input[type=checkbox]");
  if (!box.checked) box.click();
  const input = row.querySelector(".setup-count");
  input.value = String(${count});
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
})()`;

const choose = (label) => `(() => {
  const row = [...document.querySelectorAll(".setup-pace:not(.setup-sets) .setup-pace-row")].find((r) => r.querySelector(".setup-pace-name").textContent.trim() === ${JSON.stringify(label)});
  if (!row) throw new Error("no pace row for " + ${JSON.stringify(label)});
  row.querySelector("input").click();
  return row.querySelector(".setup-pace-eta").textContent;
})()`;

function userText(req) {
  const messages = req.messages ?? [];
  const last = [...messages].reverse().find((message) => message.role === "user");
  return String(last?.content ?? "");
}

function minutesOf(text) {
  const about = String(text);
  const seconds = about.match(/about (\d+) seconds/);
  if (seconds) return Number(seconds[1]) / 60;
  const minutes = about.match(/about (\d+) minutes/);
  if (minutes) return Number(minutes[1]);
  const hours = about.match(/about ([\d.]+) hours/);
  if (hours) return Number(hours[1]) * 60;
  return null;
}

export async function run(t) {
  const server = await serveFixtures();
  const qbase = encodeURIComponent(`http://127.0.0.1:${server.address().port}/`);
  try {
    await clearRuns(t);
    await t.killEngine();
    await t.startEngine(["--wps", "1000"]);
    await t.open("tests", `?qbase=${qbase}`);
    await t.waitFor(`!!document.querySelector(".setup-pace")`, 12000);
    await t.waitFor(`document.querySelector(".setup-model-text").innerText.includes("fake-model")`, 12000);

    const names = await t.eval(`[...document.querySelectorAll(".setup-pace-name")].map((n) => n.textContent.trim()).join("|")`);
    t.assert(names === "Mix|Keep the short limit|Give hard questions more room", `choices are "${names}"`);
    const recommended = await t.eval(`document.querySelector(".setup-pace-rec")?.textContent.trim()`);
    t.assert(recommended === "Recommended", `recommended mark is "${recommended}"`);
    const mixOn = await t.eval(`document.querySelector(".setup-pace:not(.setup-sets) .setup-pace-row input").checked`);
    t.assert(mixOn, "Mix is not the selected choice");

    // Thinking: a dropdown from no thinking to the highest level, medium by default.
    const levels = await t.eval(`[...document.querySelectorAll("#tests-thinking option")].map((o) => o.value).join("|")`);
    t.assert(levels === "none|low|medium|high|xhigh", `thinking levels are "${levels}"`);
    const level = await t.eval(`document.querySelector("#tests-thinking").value`);
    t.assert(level === "medium", `thinking starts at "${level}", want medium`);
    // The answer-length checks below measure the answer limits alone, so they run with thinking off.
    await t.eval(`(() => { const s = document.querySelector("#tests-thinking"); s.value = "none"; s.dispatchEvent(new Event("change")); return true; })()`);

    const unknown = await t.eval(`[...document.querySelectorAll(".setup-pace-eta")].map((n) => n.textContent).join("|")`);
    t.assert(unknown.split("|").every((line) => line === UNKNOWN), `time shows before the model speed is known ("${unknown}")`);

    await t.eval(`(() => {
      const engine = globalThis.benchEngine;
      engine.warmup = { tokensPerSecond: 4, usual: 20, slow: false };
      engine.emit("change");
      return true;
    })()`);
    await t.eval(untickAll);
    await t.eval(pick("Math", 4));
    await t.waitFor(`document.querySelector(".setup-pace-eta").textContent.includes("about")`, 8000);

    const times = await t.eval(`[...document.querySelectorAll(".setup-pace:not(.setup-sets) .setup-pace-row")].map((row) => ({ name: row.querySelector(".setup-pace-name").textContent.trim(), eta: row.querySelector(".setup-pace-eta").textContent }))`);
    const byName = Object.fromEntries(times.map((row) => [row.name, row.eta]));
    const shortMin = minutesOf(byName["Keep the short limit"]);
    const mixMin = minutesOf(byName.Mix);
    const longMin = minutesOf(byName["Give hard questions more room"]);
    t.assert(shortMin !== null && mixMin !== null && longMin !== null, `a time is missing (${JSON.stringify(times)})`);
    t.assert(shortMin < mixMin && mixMin < longMin, `times are not short < mix < long (${JSON.stringify(times)})`);
    t.assert(
      times.every((row) => row.eta.startsWith("if answers run long: about")),
      `a time is not labelled as the slow case (${JSON.stringify(times)})`,
    );

    await t.eval(choose("Give hard questions more room"));
    await t.click(START);
    const first = await waitForStoreCount(t, 1);
    t.assert(first.length === 1, `store has ${first.length} runs after the long choice, want 1`);
    const longReqs = await t.fakeRequests();
    const hard = longReqs.filter((req) => userText(req).includes("HARD-PACE"));
    const easy = longReqs.filter((req) => userText(req).includes("EASY-PACE"));
    t.assert(hard.length >= 2, `long choice sent ${hard.length} hard questions, want at least 2`);
    t.assert(hard.every((req) => req.max_tokens === 2000), `a hard question was not given 2000 tokens (${hard.map((req) => req.max_tokens).join(",")})`);
    t.assert(easy.every((req) => req.max_tokens === 400), `an easy question was not kept at 400 (${easy.map((req) => req.max_tokens).join(",")})`);

    const beforeShort = longReqs.length;
    await t.eval(choose("Keep the short limit"));
    await t.waitFor(`document.querySelector("${START}").textContent.includes("1 question")`, 8000);
    await t.click(START);
    const second = await waitForStoreCount(t, 2);
    t.assert(second.length === 2, `store has ${second.length} runs after the short choice, want 2`);
    const added = (await t.fakeRequests()).slice(beforeShort);
    t.assert(added.length === 1, `short choice sent ${added.length} questions, want 1`);
    t.assert(userText(added[0]).includes("EASY-PACE"), "short choice sent a hard question");
    t.assert(added[0].max_tokens === 400, `short choice used ${added[0].max_tokens} tokens, want 400`);
    t.assert(added[0].reasoning_effort === "none", `thinking off sent "${added[0].reasoning_effort}"`);

    // Highest thinking: the level goes to the engine, its room is added to the answer's limit, and the
    // saved run carries the level.
    await t.eval(`(() => { const s = document.querySelector("#tests-thinking"); s.value = "xhigh"; s.dispatchEvent(new Event("change")); return true; })()`);
    const beforeHigh = (await t.fakeRequests()).length;
    await t.click(START);
    const third = await waitForStoreCount(t, 3);
    t.assert(third.length === 3, `store has ${third.length} runs after highest thinking, want 3`);
    const high = (await t.fakeRequests()).slice(beforeHigh);
    t.assert(high.length === 1 && high[0].reasoning_effort === "xhigh", `highest thinking sent ${JSON.stringify(high.map((q) => q.reasoning_effort))}`);
    t.assert(high[0].max_tokens === 400 + 16000, `highest thinking used ${high[0].max_tokens} tokens, want 16400`);
    const saved = await t.eval(`fetch('/api/store/runs').then((r) => r.json()).then((d) => Promise.all(d.items.map((i) => fetch('/api/store/runs/' + i.id).then((x) => x.json()))))`);
    t.assert(saved.some((r) => (r.data ?? r).thinking === "xhigh"), `no saved run carries thinking "xhigh" (${JSON.stringify(saved.map((r) => (r.data ?? r).thinking))})`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
