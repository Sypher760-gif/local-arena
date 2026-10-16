// Tests run the real question bank and grade each answer: over fixture questions whose prompts
// carry [[reply:...]] markers, one answer is right, one is wrong, and one rules question fails.
// The result view shows the right counts, the expected text and the reason sentence.
//
// The gateway serves the app folder only, so this check hands the page its own fixture folder on an
// ephemeral port and points Tests at it with ?qbase=, the switch docs/GRADING.md reserves for tests.
export const name = "82-tests-graded";

import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "graded");
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

    // The run draws from the graded fixtures, not from the real question files.
    await t.open("tests", `?qbase=${qbase}`);
    await t.waitFor(`!!document.querySelector(".setup")`, 12000);
    await t.waitFor(`!document.querySelector("${START}").disabled`, 15000);

    // Only Math (both fixture questions) and one Following instructions question run.
    await t.eval(untickAll);
    await t.eval(pick("Math", 2));
    await t.eval(pick("Following instructions", 1));
    const total = await t.text(".setup-total");
    t.assert(total.includes("3"), `total says "${total}", want 3 questions`);
    await t.click(START);

    const items = await waitForStoreCount(t, 1);
    t.assert(items.length === 1, `store has ${items.length} runs after a run, want 1`);

    const asked = await t.fakeRequests();
    t.assert(asked.length === 3, `fake engine received ${asked.length} questions, want 3`);

    const rec = await t.storeGet("runs", items[0].id);
    const math = rec.byType.find((b) => b.type === "Math");
    t.assert(math, `saved run has no "Math" row (types: ${rec.byType.map((b) => b.type).join(",")})`);
    t.assert(math.right === 1 && math.total === 2, `Math row is ${math.right}/${math.total}, want 1/2 (one right, one wrong)`);
    const following = rec.byType.find((b) => b.type === "Following instructions");
    t.assert(following, `saved run has no "Following instructions" row`);
    t.assert(following.right === 0 && following.total === 1, `Following row is ${following.right}/${following.total}, want 0/1 (the rules question fails)`);

    // One wrong number answer and one failed rules answer are missed; nothing is left unread.
    const missed = rec.missed ?? [];
    t.assert(missed.length === 2, `${missed.length} missed questions, want 2`);
    const mathMiss = missed.find((m) => m.type === "Math");
    t.assert(mathMiss, "no missed Math question");
    t.assert(mathMiss.expected === "391", `missed Math expected is "${mathMiss.expected}", want "391"`);
    t.assert(
      typeof mathMiss.reason === "string" && mathMiss.reason.includes("Expected 391"),
      `missed Math reason does not say what was expected ("${mathMiss.reason}")`,
    );
    const rulesMiss = missed.find((m) => m.type === "Following instructions");
    t.assert(rulesMiss, "no missed Following instructions question");
    t.assert(
      typeof rulesMiss.expected === "string" && rulesMiss.expected.length > 0,
      "missed rules question has no expected text",
    );
    t.assert(
      typeof rulesMiss.reason === "string" && rulesMiss.reason.includes("Rule"),
      `missed rules reason is not a rule sentence ("${rulesMiss.reason}")`,
    );
    t.assert((rec.readYourself ?? []).length === 0, "graded run should leave nothing under Read these yourself");

    // The result view shows the same counts, the expected text and the reason sentence, once per run.
    await t.waitFor(`document.querySelector("${SCORE_ROW}") !== null`, 12000);
    const body = await t.eval("document.body.innerText");
    t.assert(body.includes("1/2"), `result view does not show the Math 1/2 count`);
    t.assert(body.includes("391"), `result view does not show the expected text "391"`);
    t.assert(body.includes("Expected 391"), `result view does not show the reason sentence`);
    t.assert(body.includes("Rule"), `result view does not show the rules reason`);
    const note = await t.text(".tests-grading-note");
    t.assert(
      note === "Marked by checking each answer against the expected answer. Open-ended questions are not scored.",
      `grading note is "${note}"`,
    );
    t.assert(!body.includes("Not stored for simulated runs."), "old simulated text is still shown for a new run");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
