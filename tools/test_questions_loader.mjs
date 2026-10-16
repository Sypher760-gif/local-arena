// Tests for app/js/questions.js (the Arena and Tests question bank: loadQuestions and pickQuestion).
// Run: node tools/test_questions_loader.mjs
// No ports, no servers and no files: fetch is stubbed, so nothing leaves the process.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const QUESTIONS_JS = pathToFileURL(path.join(ROOT, "app", "js", "questions.js")).href;
const { loadQuestions, pickQuestion, questionsBase, DEFAULT_BASE, QUESTION_SLUGS } = await import(QUESTIONS_JS);

// The folder the app reads when the page gives no override. It is the benchmark pool: the real
// questions pulled from public tests, the only question set the app has.
const DEFAULT_BASE_URL = "data/questions-hard/";
// The fixture URLs below are written against the folder, whatever the page would ask for.
const fixtureUrl = (slug) => `${DEFAULT_BASE_URL}${slug}.json`;

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    const detail = await fn();
    passed += 1;
    console.log(`PASS ${name}`);
    return detail;
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}: ${error.message}`);
    return undefined;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const question = (id, type = "Math") => ({ id, type, prompt: `Question ${id}?`, check: "number", expected: "1" });

// Answers a set of URLs; any URL the map does not name comes back 404, like a missing file.
const fetchFrom = (map) => async (url) => {
  const answer = map[url];
  if (!answer) return { ok: false, status: 404, json: async () => ({ error: "not found" }) };
  return { ok: true, status: 200, json: async () => answer() };
};

const goodFile = (id) => () => [question(id)];

// --- loadQuestions ----------------------------------------------------------

await check("reads every one of the six files from the default base", async () => {
  const urls = [];
  const map = Object.fromEntries(QUESTION_SLUGS.map((slug, i) => [fixtureUrl(slug), goodFile(`Q-0${i}`)]));
  const list = await loadQuestions(undefined, async (url) => { urls.push(url); return fetchFrom(map)(url); });
  assert(list.length === 6, `got ${list.length} questions, want 6`);
  assert(urls.join(",") === QUESTION_SLUGS.map(fixtureUrl).join(","), `asked for ${urls.join(", ")}`);
  assert(list[0].id === "Q-00" && list[5].id === "Q-05", `ids are ${list.map((q) => q.id).join(",")}`);
});

await check("a base is used as given, with a trailing slash added if missing", async () => {
  const urls = [];
  await loadQuestions("bank/questions", async (url) => { urls.push(url); return { ok: false, json: async () => [] }; });
  assert(urls.every((url) => url.startsWith("bank/questions/")), `asked for ${urls.join(", ")}`);
});

await check("a missing file is skipped and the rest still load", async () => {
  const map = { [fixtureUrl("logic")]: goodFile("L-01"), [fixtureUrl("math")]: goodFile("M-01") };
  const list = await loadQuestions(undefined, fetchFrom(map));
  assert(list.length === 2, `got ${list.length} questions, want 2`);
  assert(list.some((q) => q.id === "M-01"), "the file after the missing one was dropped too");
});

await check("a file that is not JSON is skipped", async () => {
  const map = {
    [fixtureUrl("logic")]: goodFile("L-01"),
    [fixtureUrl("math")]: () => { throw new SyntaxError("Unexpected token <"); },
  };
  const list = await loadQuestions(undefined, fetchFrom(map));
  assert(list.length === 1 && list[0].id === "L-01", `got ${JSON.stringify(list)}`);
});

await check("a file holding something other than an array is skipped", async () => {
  const map = {
    [fixtureUrl("logic")]: () => ({ logic: [] }),
    [fixtureUrl("math")]: () => 7,
    [fixtureUrl("science")]: () => "Logic",
  };
  const list = await loadQuestions(undefined, fetchFrom(map));
  assert(list.length === 0, `got ${JSON.stringify(list)}`);
});

await check("junk entries inside a good file are dropped", async () => {
  const map = {
    [fixtureUrl("logic")]: () => [
      question("L-01", "Logic"),
      null,
      42,
      { type: "Logic", prompt: "No id." },
      { id: "", type: "Logic", prompt: "Empty id." },
      { id: "L-09", type: "Logic" },
      { id: "L-02", type: "Logic", prompt: "Kept." },
    ],
  };
  const list = await loadQuestions(undefined, fetchFrom(map));
  assert(list.length === 2, `kept ${list.length}: ${JSON.stringify(list)}`);
  assert(list.map((q) => q.id).join(",") === "L-01,L-02", `ids are ${list.map((q) => q.id).join(",")}`);
});

await check("a fetch that rejects never throws", async () => {
  const list = await loadQuestions(undefined, async () => { throw new TypeError("Failed to fetch"); });
  assert(Array.isArray(list) && list.length === 0, `got ${JSON.stringify(list)}`);
});

// --- the ?qbase switch ------------------------------------------------------

await check("the default folder is the benchmark pool, and ?qbase= overrides it", async () => {
  assert(DEFAULT_BASE === DEFAULT_BASE_URL, `the module's default base is ${DEFAULT_BASE}, want ${DEFAULT_BASE_URL}`);
  assert(questionsBase("http://127.0.0.1:8782/index.html") === DEFAULT_BASE_URL, `plain page gives ${questionsBase("http://127.0.0.1:8782/index.html")}`);
  assert(questionsBase("http://127.0.0.1:8782/index.html?qbase=my/questions") === "my/questions/", "a base without a slash does not get one");
  assert(questionsBase("http://127.0.0.1:8782/index.html?qbase=my/questions/") === "my/questions/", "a base with a slash is changed");
  assert(questionsBase("http://127.0.0.1:8782/index.html?qbase=") === DEFAULT_BASE_URL, "an empty override does not fall back");
  assert(questionsBase("not a url") === DEFAULT_BASE_URL, "an unreadable URL does not fall back");
  const urls = [];
  const list = await loadQuestions("http://127.0.0.1:9/bank/", async (url) => { urls.push(url); return { ok: false, json: async () => [] }; });
  assert(urls[0] === "http://127.0.0.1:9/bank/logic.json" && list.length === 0, `asked for ${urls[0]}`);
});

// --- pickQuestion -----------------------------------------------------------

const list = [question("A"), question("B"), question("C")];

await check("pickQuestion is deterministic with a fake rng", async () => {
  assert(pickQuestion(list, new Set(), () => 0)?.id === "A", "rng 0 does not pick the first unused question");
  assert(pickQuestion(list, new Set(), () => 0.5)?.id === "B", "rng 0.5 does not pick the middle question");
  assert(pickQuestion(list, new Set(), () => 0.99)?.id === "C", "rng just under 1 does not pick the last question");
  assert(pickQuestion(list, new Set(), () => 1)?.id === "C", "rng 1 runs off the end");
});

await check("pickQuestion never returns a used question", async () => {
  const used = new Set(["A", "C"]);
  assert(pickQuestion(list, used, () => 0)?.id === "B", "a used question was returned");
  assert(pickQuestion(list, used, () => 0.999)?.id === "B", "the only unused question was missed");
});

await check("pickQuestion hands out every question once, then starts over", async () => {
  const used = new Set();
  const drawn = [];
  for (let i = 0; i < 3; i += 1) {
    const next = pickQuestion(list, used, () => 0);
    drawn.push(next.id);
    used.add(next.id);
  }
  assert(drawn.join(",") === "A,B,C", `drew ${drawn.join(",")}, want A,B,C`);
  const again = pickQuestion(list, used, () => 0);
  assert(again !== null && list.includes(again), "an exhausted list stops handing out questions");
  assert(again.id === "A", `a fresh cycle starts at the top of the list, got ${again?.id}`);
});

await check("pickQuestion copes with an empty list and a plain array of used ids", async () => {
  assert(pickQuestion([], new Set(), () => 0) === null, "an empty list does not give null");
  assert(pickQuestion(null, new Set(), () => 0) === null, "a missing list does not give null");
  assert(pickQuestion(list, ["A"], () => 0)?.id === "B", "a used-ids array is not understood");
  assert(pickQuestion(list, undefined, () => 0)?.id === "A", "missing used ids are not understood");
});

console.log(`test_questions_loader: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
