// An empty reply from a model that finished normally (a thinking model that used its whole limit)
// is a wrong answer: the run is kept and the missed card says the model gave no answer.
export const name = "83-tests-empty-answer";

import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "empty");
const SLUGS = ["logic", "math", "science", "coding", "reading", "following"];

const START = ".setup-start";
const SCORE_ROW = ".score-row";

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

// Serves the fixture files the way the gateway would, with CORS so the page on 8782 may read them.
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
    response.end(readFileSync(path.join(FIXTURES, `${slug}.json`)));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const untickAll = `(() => {
  [...document.querySelectorAll(".setup-type input[type=checkbox]")].forEach((b) => { if (b.checked) b.click(); });
  return true;
})()`;

// Ticks one type (if unticked) and sets its question count, through real events.
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

export async function run(t) {
  const server = await serveFixtures();
  const qbase = encodeURIComponent(`http://127.0.0.1:${server.address().port}/`);
  try {
    await clearRuns(t);
    await t.killEngine();
    await t.startEngine(["--wps", "1000"]);
    await t.open("tests", `?qbase=${qbase}`);
    await t.waitFor(`!!document.querySelector(\".setup\")`, 12000);
    await t.waitFor(`!document.querySelector(\"${START}\").disabled`, 15000);
    await t.eval(untickAll);
    await t.eval(pick("Math", 1));
    await t.click(START);

    // The model finishes normally but writes nothing: that is a wrong answer, saved with its reason.
    const items = await waitForStoreCount(t, 1);
    t.assert(items.length === 1, `store has ${items.length} runs after an empty-answer run, want 1 (the run must not be dropped)`);
    const rec = await t.storeGet("runs", items[0].id);
    const math = rec.byType.find((b) => b.type === "Math");
    t.assert(math && math.right === 0 && math.total === 1, `Math row is ${math ? math.right + "/" + math.total : "missing"}, want 0/1`);
    const miss = (rec.missed ?? [])[0];
    t.assert(miss && String(miss.reason).includes("no answer"), `missed reason is \"${miss && miss.reason}\", want the no-answer sentence`);
    await clearRuns(t);
  } finally {
    server.close();
  }
}
