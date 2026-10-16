// How long a Tests answer may be. Three choices, picked on the Tests page.
// A hard question is one marked difficulty "hard". Those need room to work the answer out.
// A short answer is assumed to use 80 tokens (about 60 words). A hard answer that is given room
// is assumed to use the whole 2,000-token limit, so the time estimate is the slow case.

export const SHORT_TOKENS = 400;
export const LONG_TOKENS = 2000;
export const SHORT_ANSWER_TOKENS = 80;
export const LONG_ANSWER_TOKENS = 2000;

// How hard the model thinks before it answers. Thinking gets its own room on top of the answer's limit,
// so a model that thinks does not use up the answer's share. "xhigh" is the highest level the engines
// know: NInfer and Strata take it as is, and NInfer rounds it to the nearest level a template accepts.
export const THINKING_OPTIONS = [
  { id: "none", label: "No thinking", room: 0 },
  { id: "low", label: "Low", room: 2000 },
  { id: "medium", label: "Medium", room: 4000 },
  { id: "high", label: "High", room: 8000 },
  { id: "xhigh", label: "Highest", room: 16000 },
];
export const DEFAULT_THINKING = "medium";

export function thinkingRoom(thinking) {
  return THINKING_OPTIONS.find((option) => option.id === thinking)?.room ?? 0;
}

export const PACE_OPTIONS = [
  {
    id: "mix",
    label: "Mix",
    recommended: true,
    detail: "Easy questions stay short. Hard questions get more room. Each run uses fewer hard questions.",
  },
  {
    id: "short",
    label: "Keep the short limit",
    detail: "Faster, but the test stays easier.",
  },
  {
    id: "long",
    label: "Give hard questions more room",
    detail: "Fairer test, much slower.",
  },
];

export function isHard(question) {
  return question?.difficulty === "hard";
}

function shuffle(list, rng) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Up to `count` questions for this choice. Short skips hard questions. Mix keeps at most one
// hard question in every four, and none when fewer than four are asked. Long uses the whole pool.
export function pickForPace(pool, count, pace, rng = Math.random) {
  const source = Array.isArray(pool) ? pool : [];
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (!n || !source.length) return [];
  const hard = source.filter(isHard);
  const rest = source.filter((question) => !isHard(question));
  if (pace === "short") return shuffle(rest, rng).slice(0, n);
  if (pace === "long") return shuffle(source, rng).slice(0, n);
  const hardCap = n >= 4 ? Math.floor(n * 0.25) : 0;
  const pickedHard = shuffle(hard, rng).slice(0, hardCap);
  const pickedRest = shuffle(rest, rng).slice(0, n - pickedHard.length);
  return shuffle(pickedHard.concat(pickedRest), rng);
}

export function tokenCap(question, pace, thinking = "none") {
  const answer = pace === "short" || !isHard(question) ? SHORT_TOKENS : LONG_TOKENS;
  return answer + thinkingRoom(thinking);
}

// The slow case: every answer fills its share, and every thought fills its whole thinking room.
export function estimateSeconds(questions, pace, tokensPerSecond, thinking = "none") {
  if (!(tokensPerSecond > 0) || !Array.isArray(questions) || questions.length === 0) return null;
  const tokens = questions.reduce((sum, question) => {
    const cap = pace === "short" || !isHard(question) ? SHORT_ANSWER_TOKENS : LONG_ANSWER_TOKENS;
    return sum + cap + thinkingRoom(thinking);
  }, 0);
  return tokens / tokensPerSecond;
}

const roundTo = (n, step) => Math.max(step, Math.round(n / step) * step);

export function formatEta(seconds, { modelLoaded } = {}) {
  if (!modelLoaded) return "Load a model to see the time.";
  if (seconds == null || !Number.isFinite(seconds)) return "Time not known yet for this model.";
  if (seconds < 100) return `about ${roundTo(seconds, 10)} seconds`;
  if (seconds < 3600) return `about ${roundTo(seconds / 60, 1)} minutes`;
  return `about ${(seconds / 3600).toFixed(1)} hours`;
}

// Speed for the loaded model only. The recorded usual speed wins. A saved run is used only when
// it is the same model. Another model's speed is never shown.
export function modelTokensPerSecond({ model, warmup, runs } = {}) {
  if (!model) return null;
  const usual = warmup?.usual;
  if (typeof usual === "number" && usual > 0) return usual;
  const now = warmup?.tokensPerSecond;
  if (typeof now === "number" && now > 0) return now;
  if (!Array.isArray(runs)) return null;
  for (const run of runs) {
    if (run?.model === model.name && run?.version === model.version
      && typeof run.averageTokensPerSecond === "number" && run.averageTokensPerSecond > 0) {
      return run.averageTokensPerSecond;
    }
  }
  return null;
}
