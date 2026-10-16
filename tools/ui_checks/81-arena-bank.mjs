// Arena draws from the question bank: the question text, its type tag and its difficulty tag come
// from the six question files, four draws in a row do not repeat, and a bank that will not load
// leaves Arena with no question and Start off (there are no made-up stand-in questions any more).
//
// The gateway serves the app folder only, so this check hands the page its own fixture folder on an
// ephemeral port and points Arena at it with ?qbase=, the switch docs/GRADING.md reserves for tests.
export const name = "81-arena-bank";

import { readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "questions");
const SLUGS = ["logic", "math", "science", "coding", "reading", "following"];
const BANK = SLUGS.flatMap((slug) => JSON.parse(readFileSync(path.join(FIXTURES, `${slug}.json`), "utf8")));
const PROMPTS = BANK.map((q) => q.prompt);
const PROMPT_LIST = JSON.stringify(PROMPTS);
const TYPE_OF = new Map(BANK.map((q) => [q.prompt, q.type]));
const DIFFICULTY_OF = new Map(BANK.map((q) => [q.prompt, q.difficulty]));

const START = ".arena-start";
const NEXT = ".arena-next";
const VOTE_A = ".arena-vote-a";

// Read the question head with textContent, so the comparison is exact and not reflowed.
const questionText = `document.querySelector(".arena-question-text")?.textContent.trim()`;
const typeTag = `document.querySelector(".arena-tag")?.textContent.trim()`;
const difficultyTag = `(() => {\n  const node = document.querySelector(".arena-difficulty");\n  return !node || node.hidden ? "" : node.textContent.trim();\n})()`;

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

async function clearVotes(t) {
  await t.eval(`(async () => {
    const res = await fetch("/api/store/votes");
    const items = (await res.json()).items ?? [];
    await Promise.all(items.map((i) => fetch("/api/store/votes/" + i.id, { method: "DELETE" })));
    return items.length;
  })()`);
}

async function waitForStart(t) {
  await t.waitFor(`document.querySelector("${START}") && !document.querySelector("${START}").hidden && !document.querySelector("${START}").disabled`, 15000);
}

// Waits until the question head holds a fixture prompt that has not been drawn yet.
const newBankQuestion = (seen) => `${PROMPT_LIST}.includes(${questionText}) && !${JSON.stringify(seen)}.includes(${questionText})`;

// One whole round (both answers, a vote) and then Next question, which draws again.
async function drawAgain(t, seen) {
  await waitForStart(t);
  await t.click(START);
  await t.waitFor(`document.querySelector("${VOTE_A}") && !document.querySelector("${VOTE_A}").disabled`, 45000);
  await t.click(VOTE_A);
  await t.waitFor(`document.querySelector("${NEXT}") && !document.querySelector("${NEXT}").hidden`, 15000);
  await t.click(NEXT);
  await t.waitFor(newBankQuestion(seen), 15000);
  const drawn = await t.eval(questionText);
  t.assert(!seen.includes(drawn), `a draw repeated the question "${drawn}"`);
  t.assert(PROMPTS.includes(drawn), `the drawn question is not a fixture prompt ("${drawn}")`);
  return drawn;
}

export async function run(t) {
  const server = await serveFixtures();
  const qbase = encodeURIComponent(`http://127.0.0.1:${server.address().port}/`);
  try {
    await clearVotes(t);
    await t.killEngine();
    await t.startEngine(["--wps", "1000"]);

    // A fresh open takes its question from the fixtures.
    await t.open("arena", `?qbase=${qbase}`);
    await t.waitFor(newBankQuestion([]), 15000);
    const first = await t.eval(questionText);
    t.assert(PROMPTS.includes(first), `the first question is not a fixture prompt ("${first}")`);
    const tag = await t.eval(typeTag);
    t.assert(tag === TYPE_OF.get(first), `the type tag says "${tag}", the fixture says "${TYPE_OF.get(first)}"`);
    const difficulty = await t.eval(difficultyTag);
    t.assert(difficulty === DIFFICULTY_OF.get(first), `the difficulty tag says "${difficulty}", the fixture says "${DIFFICULTY_OF.get(first)}"`);

    // Three more draws: four questions in all, none of them a repeat while 12 are unused.
    const seen = [first];
    for (let draw = 0; draw < 3; draw += 1) seen.push(await drawAgain(t, seen));
    t.assert(new Set(seen).size === 4, `the four draws were not four different questions (${JSON.stringify(seen)})`);
    await clearVotes(t);

    // A bank that will not load: no stand-in question, a plain line, and no round can start.
    await t.open("arena", "?qbase=no-such-folder/");
    await t.waitFor(`${questionText} === "The question files could not be loaded."`, 15000);
    t.assert(await t.eval(`document.querySelector("${START}").disabled`), "Start is on with no question");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
