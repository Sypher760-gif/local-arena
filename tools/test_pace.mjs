// Answer-length choices for a Tests run: which questions run, how long each may be, and the time.
// Run: node tools/test_pace.mjs
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { pickForPace, tokenCap, estimateSeconds, formatEta, modelTokensPerSecond, PACE_OPTIONS } = await import(pathToFileURL(path.join(ROOT, "app", "js", "pace.js")).href);

let failures = 0;
function check(name, ok, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
}

function rngFrom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pool = [
  { id: "e1", difficulty: "easy" },
  { id: "e2", difficulty: "easy" },
  { id: "m1", difficulty: "medium" },
  { id: "h1", difficulty: "hard" },
  { id: "h2", difficulty: "hard" },
  { id: "h3", difficulty: "hard" },
  { id: "h4", difficulty: "hard" },
];

const short = pickForPace(pool, 4, "short", rngFrom(1));
check("short skips hard questions", short.length === 3 && short.every((q) => q.difficulty !== "hard"), short.map((q) => q.id).join(","));
check("short does not ask for more than exist", pickForPace(pool, 20, "short", rngFrom(1)).length === 3);

const mix = pickForPace(pool, 4, "mix", rngFrom(2));
check("mix keeps the asked count", mix.length === 4, String(mix.length));
check("mix uses fewer hard questions", mix.filter((q) => q.difficulty === "hard").length === 1, mix.map((q) => q.id).join(","));
check("mix uses no hard question when the count is under 4", pickForPace(pool, 3, "mix", rngFrom(3)).every((q) => q.difficulty !== "hard"));

const long = pickForPace(pool, 4, "long", rngFrom(4));
check("long can include more than one hard question", long.filter((q) => q.difficulty === "hard").length > 1, long.map((q) => q.id).join(","));
check("pick does not change the pool", pool.length === 7);

check("short cap is 400 even for a hard question", tokenCap({ difficulty: "hard" }, "short") === 400);
check("a hard question gets 2000 when it has room", tokenCap({ difficulty: "hard" }, "long") === 2000 && tokenCap({ difficulty: "hard" }, "mix") === 2000);
check("an easy question stays at 400", tokenCap({ difficulty: "easy" }, "long") === 400);
check("thinking adds its own room on top of the answer", tokenCap({ difficulty: "easy" }, "mix", "medium") === 4400 && tokenCap({ difficulty: "hard" }, "long", "xhigh") === 18000);
check("no thinking adds nothing", tokenCap({ difficulty: "easy" }, "mix", "none") === 400);
check("the time counts the thinking room", estimateSeconds([{ difficulty: "easy" }], "short", 10, "low") === (80 + 2000) / 10);

const seconds = estimateSeconds(
  [{ difficulty: "easy" }, { difficulty: "hard" }],
  "long",
  20,
);
check("time uses a short reply for easy and the long room for hard", seconds === (80 + 2000) / 20, String(seconds));
check("no speed means no time", estimateSeconds([{ difficulty: "easy" }], "short", 0) === null);

check("no model says to load one", formatEta(12, { modelLoaded: false }) === "Load a model to see the time.");
check("a loaded model with no speed says so", formatEta(null, { modelLoaded: true }) === "Time not known yet for this model.");
check("a known time is a plain about-phrase", formatEta(80, { modelLoaded: true }) === "about 80 seconds");

const model = { name: "Example", version: "Q4" };
check("usual speed of the loaded model wins", modelTokensPerSecond({
  model,
  warmup: { usual: 7, tokensPerSecond: 2 },
  runs: [{ model: "Example", version: "Q4", averageTokensPerSecond: 99 }],
}) === 7);
check("a saved run for this model is used when warm-up has no number", modelTokensPerSecond({
  model,
  warmup: null,
  runs: [
    { model: "Other", version: "Q4", averageTokensPerSecond: 50 },
    { model: "Example", version: "Q4", averageTokensPerSecond: 11 },
  ],
}) === 11);
check("another model's run is not used", modelTokensPerSecond({
  model,
  warmup: null,
  runs: [{ model: "Other", version: "Q4", averageTokensPerSecond: 50 }],
}) === null);

check("three choices, mix first", PACE_OPTIONS.map((o) => o.id).join(",") === "mix,short,long");
check("mix is the recommended choice", PACE_OPTIONS[0].recommended === true);

if (failures) {
  console.log(`FAIL ${failures}`);
  process.exit(1);
}
console.log("PASS");
