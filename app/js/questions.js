// The one question bank behind Arena and Tests: the six files in app/data/questions-hard/, the
// real questions pulled from public benchmarks (MMLU-Pro, ARC, GSM8K, MATH-500, BBH, FOLIO, BoolQ,
// DROP, HotpotQA, SQuAD, CRUXEval, IFEval and others). A file that is missing or broken is skipped,
// never fatal. Plain ES module, no build step.
export const QUESTION_SLUGS = ["logic", "math", "science", "coding", "reading", "following"];
export const DEFAULT_BASE = "data/questions-hard/";

// ?qbase=<path> points the loader at another folder (the UI check uses its own fixtures).
// Falls back to the folder next to index.html when there is no override or no page to read.
export function questionsBase(href = typeof location === "undefined" ? "" : location.href) {
  let override = null;
  try {
    override = new URL(href).searchParams.get("qbase");
  } catch {
    override = null;
  }
  if (!override) return DEFAULT_BASE;
  return override.endsWith("/") ? override : `${override}/`;
}

// The least a question must have to be usable: an id to remember it by and a prompt to send.
function isQuestion(value) {
  return Boolean(value) && typeof value === "object"
    && typeof value.id === "string" && value.id !== ""
    && typeof value.prompt === "string" && value.prompt !== "";
}

async function loadFile(root, slug, fetchImpl) {
  try {
    const response = await fetchImpl(`${root}${slug}.json`);
    if (!response || !response.ok) return [];
    const data = await response.json();
    if (!Array.isArray(data)) return [];
    return data.filter(isQuestion);
  } catch {
    return [];
  }
}

// One flat array of every usable question in the six files. Never throws: a file that will not
// load or will not parse simply contributes nothing.
export async function loadQuestions(base, fetchImpl = globalThis.fetch) {
  const root = (base || questionsBase()).replace(/\/?$/, "/");
  const files = await Promise.all(QUESTION_SLUGS.map((slug) => loadFile(root, slug, fetchImpl)));
  return files.flat();
}

// A random question from the list that is not in usedIds. When every one has been used the whole
// list is fair game again, so a long session keeps going instead of running dry.
export function pickQuestion(list, usedIds, rng = Math.random) {
  const all = Array.isArray(list) ? list : [];
  if (all.length === 0) return null;
  const used = usedIds instanceof Set ? usedIds : new Set(usedIds ?? []);
  const fresh = all.filter((question) => !used.has(question.id));
  const pool = fresh.length > 0 ? fresh : all;
  const index = Math.max(0, Math.min(pool.length - 1, Math.floor(rng() * pool.length)));
  return pool[index];
}
