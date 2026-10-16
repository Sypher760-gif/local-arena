// Tests screen: set-up card, run and compare pickers, summary tiles, score by type, profile,
// missed questions and the questions you must read yourself.
// A run streams one reply per question. A built-in question is marked by comparing the whole reply
// with the question's expected answer; a custom question with an expected answer is graded by substring.
import { engine } from "../engine.js";
import {
  models, testRuns, GPU_TOTAL_GB, FIT_TIGHT_LIMIT, FIT_SPILL_LIMIT,
} from "../data.js";
import { el, module, sectionLabel, segMeter, speedScale, fmtSpeed, radar, readout, button, chip, notice } from "../ui.js";
import { store } from "../store.js";
import { grade } from "../grader.js";
import { loadQuestions, questionsBase } from "../questions.js";
import {
  PACE_OPTIONS, pickForPace, tokenCap, estimateSeconds, formatEta, modelTokensPerSecond,
  THINKING_OPTIONS, DEFAULT_THINKING,
} from "../pace.js";

// Sample text and simulation rules that data.js does not hold.
const QUESTION_SEED = 20261010;        // fixed seed: the same set-up draws the same questions
const MISSED_SHOWN = 3;               // missed-question cards shown before "Show all"
const RADAR_LABELS = { "Following instructions": "Instructions" }; // short axis labels
const STOP_NOTE = "Run stopped. Nothing was saved.";

// The set-up card -----------------------------------------------------------
const MIN_PER_TYPE = 1;        // the number box and the run clamp to this
const MAX_PER_TYPE = 20;
const CUSTOM_TYPE = "Your questions";   // the extra type your own questions run as
const CUSTOM_HINT = "One question per line. Add  => your expected answer  to have it marked right; a question without one is not scored.";
const GRADING_NOTE = "Marked by checking each answer against the expected answer. Open-ended questions are not scored.";
const BANK_ERROR = "The question files could not be loaded.";
// The one question set: the real benchmark questions (704, pulled from public tests), the same
// bank Arena draws from. Counts start at 10 of each type, up to 20.
const DEFAULT_SET = { id: "bench", perType: 10 };


// The six built-in question types, in run order, each with a one-line description for the card.
const QUESTION_TYPES = [
  { type: "Logic", description: "Short reasoning puzzles with one right answer." },
  { type: "Math", description: "Arithmetic and word problems, worked out step by step." },
  { type: "Science", description: "Science questions with one right answer." },
  { type: "Coding", description: "Short programming questions with one right answer." },
  { type: "Reading", description: "Questions about a short piece of text." },
  { type: "Following instructions", description: "Do exactly what the instructions ask, nothing more." },
];
const TYPE_NAMES = QUESTION_TYPES.map(({ type }) => type);

// Runs in this session, newest first. A copy, so data.js is never changed.
const runs = testRuns.slice();

// What the set-up card holds: which types are ticked, how many of each, and the custom questions.
// It lives at module level so the choices survive a look at another screen and back.
const setup = {
  enabled: new Set(TYPE_NAMES),
  counts: Object.fromEntries(TYPE_NAMES.map((type) => [type, DEFAULT_SET.perType])),
  custom: "",
  pace: "mix",
  thinking: DEFAULT_THINKING,
};

const HEAD_CELLS = [
  ["Type", false], ["Right", true], ["", false], ["Score", true], ["Vs last", true], ["tok/s", true],
];

// Helpers ------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, "0");
const pct = (right, total) => (total ? Math.round((right / total) * 100) : 0);
const fmt = (n, digits = 1) => (n === null || n === undefined ? "—" : n.toFixed(digits));
const TOKENS_PER_WORD = 1.33;   // same ratio the engine uses for tokens per second; used only for old word-only records

// Tokens-per-second display. New records carry tokensPerSecond; old records only have wordsPerSecond,
// so show the word-based estimate marked with ~.
function tpsText(tps, wps) {
  if (tps !== null && tps !== undefined) return fmt(tps);
  if (wps !== null && wps !== undefined) return `~${(wps * TOKENS_PER_WORD).toFixed(1)}`;
  return "—";
}

function mean(values) {
  const kept = values.filter((v) => v !== null && v !== undefined);
  return kept.length ? kept.reduce((a, b) => a + b, 0) / kept.length : null;
}

function totals(run) {
  return run.byType.reduce((sum, t) => ({ right: sum.right + t.right, total: sum.total + t.total }), { right: 0, total: 0 });
}

function fitWord(gb) {
  const share = gb / GPU_TOTAL_GB;
  return share < FIT_TIGHT_LIMIT ? "fits" : share <= FIT_SPILL_LIMIT ? "tight" : "spills over";
}

function splitSeconds(minutes) {
  const s = Math.round(minutes * 60);
  return { h: Math.floor(s / 3600), m: Math.floor((s % 3600) / 60), s: s % 60 };
}

// Hero figure for the total time tile: "11:42 min", or "1:54 h" from one hour up.
function clock(minutes) {
  const { h, m, s } = splitSeconds(minutes);
  return h ? { value: `${h}:${pad(m)}`, unit: "h" } : { value: `${pad(m)}:${pad(s)}`, unit: "min" };
}

function longTime(minutes) {
  const { h, m, s } = splitSeconds(minutes);
  return h ? `${h} h ${m} min` : `${m} min ${s} s`;
}

function clockTime(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// mulberry32: a small seeded generator returning numbers from 0 up to 1.
function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// One line per question. "text => expected" sets the expected answer; a bare line is not scored.
function parseCustom(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const at = line.indexOf("=>");
      return at === -1
        ? { question: line, expected: "" }
        : { question: line.slice(0, at).trim(), expected: line.slice(at + 2).trim() };
    })
    .filter((q) => q.question);
}

// The question bank, read once when the screen opens. bankLoaded stays false until it answers, so
// the set-up card can say it is reading the files instead of showing a wrong count.
let bank = [];
let bankLoaded = false;
let bankFailed = false;
const bankReady = loadQuestions(questionsBase()).then((list) => {
  bank = list;
  bankLoaded = true;
  bankFailed = list.length === 0;
  return list;
});

// How many questions of this type the files hold: Infinity while they are still being read.
function availableCount(type) {
  return bankLoaded ? bank.filter((question) => question.type === type).length : Infinity;
}

// The questions one ticked type will really run: the count asked for, capped at what the files hold.
function runCount(type) {
  if (!setup.enabled.has(type)) return 0;
  return Math.min(setup.counts[type], availableCount(type));
}

// The questions one choice will really run. The same seed the run uses, so the time matches the run.
function planRng() {
  return seededRandom(QUESTION_SEED + runs.length);
}

function plannedQuestions(pace, rng) {
  const list = [];
  for (const { type } of QUESTION_TYPES) {
    if (!setup.enabled.has(type)) continue;
    const pool = bank.filter((question) => question.type === type);
    list.push(...pickForPace(pool, setup.counts[type], pace, rng));
  }
  parseCustom(setup.custom).forEach((q, i) => {
    list.push({ type: CUSTOM_TYPE, id: `Y-${pad(i + 1)}`, prompt: q.question, expected: q.expected });
  });
  return list;
}

function setupQuestionCount() {
  if (!bankLoaded) {
    let total = 0;
    for (const type of TYPE_NAMES) total += runCount(type);
    return total + parseCustom(setup.custom).length;
  }
  return plannedQuestions(setup.pace, planRng()).length;
}

// One readable phrase for what an answer had to contain, for a missed card and the detail view.
function describeExpected(question) {
  if (question.check === "contains") {
    const all = Array.isArray(question.all) ? question.all : [];
    const any = Array.isArray(question.any) ? question.any : [];
    if (all.length && any.length) return `mentions: ${all.join(", ")} and any of: ${any.join(", ")}`;
    if (all.length) return `mentions: ${all.join(", ")}`;
    if (any.length) return `mentions any of: ${any.join(", ")}`;
    return "";
  }
  if (question.check === "rules") {
    const rules = Array.isArray(question.rules) ? question.rules : [];
    return rules.map(describeRule).filter(Boolean).join(", ");
  }
  return question.expected === undefined || question.expected === null ? "" : String(question.expected);
}

// One rule as a short phrase, for example "at most 20 words" or "lower case".
function describeRule(rule) {
  const value = rule && rule.value !== undefined && rule.value !== null ? String(rule.value) : "";
  switch (rule && rule.kind) {
    case "maxWords": return `at most ${rule.n} words`;
    case "minWords": return `at least ${rule.n} words`;
    case "startsWith": return `starts with "${value}"`;
    case "endsWith": return `ends with "${value}"`;
    case "includes": return `includes "${value}"`;
    case "excludes": return `does not include "${value}"`;
    case "exactLines": return `${rule.n} ${Number(rule.n) === 1 ? "line" : "lines"}`;
    case "allLower": return "lower case";
    case "allUpper": return "upper case";
    case "validJson": return "valid JSON";
    default: return "";
  }
}


// Keep card previews unchanged; saved records and the detail view retain the full text.
const preview = (text, limit) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, limit);

// Time for one answer-length choice, from the loaded model's own speed.
// The figure is the slow case: it assumes every easy answer uses its full 80-token share and every
// hard answer fills the whole 2,000-token limit. Measured runs finish well inside it, so the
// text says so.
function etaText(pace, model, tokensPerSecond) {
  if (!model) return formatEta(null, { modelLoaded: false });
  if (!bankLoaded) return formatEta(null, { modelLoaded: true });
  const questions = plannedQuestions(pace, planRng());
  if (!questions.length) return "Pick at least one question to see the time.";
  if (!(tokensPerSecond > 0)) return formatEta(null, { modelLoaded: true });
  const eta = formatEta(estimateSeconds(questions, pace, tokensPerSecond, setup.thinking), { modelLoaded: true });
  return `if answers run long: ${eta}`;
}

const thinkingLabel = (id) => THINKING_OPTIONS.find((option) => option.id === id)?.label ?? id;

function runLabel(run) {
  // Older runs saved no level: they all ran with thinking off.
  return `#${run.id} · ${run.when} · ${run.model} ${run.version} · ${thinkingLabel(run.thinking ?? "none")}`;
}

function summarize(active) {
  const { results } = active;
  // Every type that ran gets a score row. A type whose questions are all open-ended keeps its row
  // and is shown as "not scored" rather than 0%.
  const byType = [];
  for (const type of [...TYPE_NAMES, CUSTOM_TYPE]) {
    const mine = results.filter((r) => r.type === type);
    if (!mine.length) continue;
    const scored = mine.filter((r) => r.scored);
    byType.push({
      type,
      right: scored.filter((r) => r.correct).length,
      total: scored.length,
      unscored: scored.length === 0,
      wordsPerSecond: mean(mine.map((r) => r.wordsPerSecond)),
      tokensPerSecond: mean(mine.map((r) => r.tokensPerSecond)),
    });
  }
  const missed = results
    .filter((r) => r.scored && !r.correct)
    .map((r) => ({
      id: r.id, type: r.type, question: r.question, expected: r.expected, answer: r.answer,
      reason: r.reason,
    }));
  const readYourself = results
    .filter((r) => !r.scored)
    .map((r) => ({ id: r.id, type: r.type, question: r.question, answer: r.answer, reason: r.reason }));
  return {
    id: active.id,
    when: `today ${clockTime(new Date())}`,
    model: active.model.name,
    version: active.model.version,
    thinking: active.thinking ?? "none",
    totalMinutes: (performance.now() - active.startedAt) / 60000,
    peakGB: active.peakGB,
    graded: true,   // this run's answers were checked against the expected answers
    averageWordsPerSecond: mean(results.map((r) => r.wordsPerSecond)),
    averageTokensPerSecond: mean(results.map((r) => r.tokensPerSecond)),
    byType,
    missedCount: missed.length,
    missed,
    readYourself,
  };
}

const csvCell = (value) => {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

// Downloads the visible run's score table as a CSV file. The only file the app creates.
function exportCsv(run) {
  const rows = [["Type", "Right", "Total", "Score percent", "Tokens per second"]];
  for (const t of run.byType) {
    const tps = t.tokensPerSecond ?? (t.wordsPerSecond === null ? null : t.wordsPerSecond * TOKENS_PER_WORD);
    rows.push([t.type, t.right, t.total, t.unscored ? "" : pct(t.right, t.total), tps === null ? "" : tps.toFixed(1)]);
  }
  const text = rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  const link = el("a");
  link.href = url;
  link.download = `arena-test-run-${run.id}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

// Builders -----------------------------------------------------------------

function tile({ label, value, unit = "", big = false, note = "", compare = null }) {
  const figure = el("div", "tile-figure");
  figure.append(el("span", "tile-value", value));
  if (unit) figure.append(el("span", big ? "tile-unit big" : "tile-unit", unit));
  if (note) figure.append(el("span", "tile-note", note));
  const line = el("div", compare === null ? "compared muted" : "compared");
  if (compare === null) {
    line.textContent = "No run to compare";
  } else {
    line.append(el("span", "compared-tick"), document.createTextNode("Compared run "), el("span", "compared-value", compare));
  }
  return module({ tag: "section", cls: "tile", children: [sectionLabel(label), figure, line] });
}

// Segmented bar for one type, with a blue tick at the compared run's score.
function scoreBar(score, comparedScore, label) {
  const wrap = el("div", "score-bar");
  wrap.setAttribute("role", "img");
  wrap.setAttribute("aria-label", label);
  const meter = segMeter({ min: 0, max: 100, variant: "bar" });
  meter.set(score);
  wrap.append(meter);
  if (comparedScore !== null) {
    const tick = el("span", "score-tick");
    tick.style.left = `${comparedScore}%`;
    wrap.append(tick);
  }
  return wrap;
}

function deltaCell(change) {
  if (change === null) return el("span", "score-delta muted", "—");
  if (change > 0) return el("span", "score-delta up", `+${change}`);
  if (change < 0) return el("span", "score-delta down", `−${Math.abs(change)}`);
  return el("span", "score-delta same", "0");
}

function gridRow(cells, cls) {
  const row = el("div", `score-grid ${cls}`);
  row.append(...cells);
  return row;
}

export function render(root) {
  const live = engine.mode !== "sim";
  if (live) runs.length = 0;   // live mode shows only saved runs, loaded from the store below
  const state = {
    previewNoRuns: false,
    selectedId: runs[0]?.id ?? null,
    compareId: runs[1]?.id ?? null,
    showAll: false,
  };
  let run = null;       // the run in progress, or null
  let strip = null;     // its progress strip, or null
  let openedFrom = null; // the missed-question card that opened the detail dialog
  let historyReady = !live;
  let nextRunId = 1;
  let disposed = false;  // set when the screen is left, so the question files are not awaited anymore

  const visibleRuns = () => (state.previewNoRuns ? [] : runs);
  const selectedRun = () => visibleRuns().find((r) => r.id === state.selectedId) ?? null;
  const comparedRun = () => visibleRuns().find((r) => r.id === state.compareId) ?? null;
  const previousRun = (current) => {
    if (!current) return null;
    return runs
      .filter((r) => r.model === current.model && r.version === current.version && r.id < current.id)
      .sort((a, b) => b.id - a.id)[0] ?? null;
  };
  const otherRunId = (exclude) => visibleRuns().find((r) => r.id !== exclude)?.id ?? null;
  const resetSelection = () => {
    state.selectedId = visibleRuns()[0]?.id ?? null;
    state.compareId = visibleRuns()[1]?.id ?? null;
    state.showAll = false;
  };
  const currentModel = () => models.find((m) => m.id === engine.loadedModelId) ?? engine.loadedModel;

  // Static layout ----------------------------------------------------------

  const tests = el("div", "tests-cols");

  const runSelect = el("select");
  runSelect.setAttribute("aria-label", "Run to show");
  runSelect.addEventListener("change", () => {
    state.selectedId = Number(runSelect.value);
    if (state.compareId === state.selectedId) state.compareId = otherRunId(state.selectedId);
    state.showAll = false;
    draw();
  });
  const runPicker = el("label", "picker");
  runPicker.append(el("span", "swatch"), el("span", "", "Run"), runSelect);

  const compareSelect = el("select");
  compareSelect.setAttribute("aria-label", "Compare with");
  compareSelect.addEventListener("change", () => {
    state.compareId = compareSelect.value === "" ? null : Number(compareSelect.value);
    draw();
  });
  const comparePicker = el("label", "picker");
  comparePicker.append(el("span", "swatch compare"), el("span", "", "Compare with"), compareSelect);

  const previewInput = el("input");
  previewInput.type = "checkbox";
  previewInput.addEventListener("change", () => {
    state.previewNoRuns = previewInput.checked;
    resetSelection();
    draw();
  });
  const previewLabel = el("label", "toggle");
  previewLabel.append(previewInput, document.createTextNode("Show no-runs preview"), chip({ text: "Preview", small: true }));

  const exportButton = button({
    kind: "secondary",
    text: "Export",
    onClick: () => {
      const current = selectedRun();
      if (current) exportCsv(current);
    },
  });

  const toolbar = el("div", "tests-toolbar");
  const heading = el("h1", "", "Test results");
  const toolbarEnd = el("div", "toolbar-end");
  toolbarEnd.append(previewLabel, exportButton);
  toolbar.append(heading, runPicker, comparePicker, toolbarEnd);

  const message = el("p", "tests-note");
  message.setAttribute("role", "status");
  message.hidden = true;

  const saveNotice = notice({ kind: "warn", text: "Could not save. Your work is still on screen." });
  saveNotice.hidden = true;
  let saveErrorTimer = 0;
  function showSaveError() {
    saveNotice.hidden = false;
    clearTimeout(saveErrorTimer);
    saveErrorTimer = setTimeout(() => { saveNotice.hidden = true; }, 4000);
  }

  // Set-up card ------------------------------------------------------------

  const setupIntro = el("p", "setup-intro",
    "A test run asks the loaded model a set of questions and records its speed and how often it answers correctly. Pick what to include, then start.");
  const modelText = el("span", "setup-model-text", "");
  const modelsLink = el("a", "setup-model-link", "Open Models");
  modelsLink.href = "#/models";
  const modelLine = el("p", "setup-model");
  modelLine.append(modelText, modelsLink);

  const typeList = el("div", "setup-types");
  const typeRows = [];   // what each type row holds, so a failed file load can switch them off
  for (const { type, description } of QUESTION_TYPES) {
    const checkInput = el("input");
    checkInput.type = "checkbox";
    checkInput.checked = setup.enabled.has(type);
    const check = el("label", "check setup-check");
    check.append(checkInput, el("span", "setup-type-name", type));
    const desc = el("span", "setup-type-desc", description);
    const countInput = el("input", "setup-count");
    countInput.type = "number";
    countInput.min = String(MIN_PER_TYPE);
    countInput.max = String(MAX_PER_TYPE);
    countInput.value = String(setup.counts[type]);
    countInput.disabled = !checkInput.checked;
    countInput.setAttribute("aria-label", `How many ${type} questions`);
    const countBox = el("label", "setup-count-box");
    countBox.append(el("span", "setup-count-label", "Questions"), countInput);
    const hint = el("span", "setup-count-hint", "");
    hint.hidden = true;
    const row = el("div", "setup-type");
    row.append(check, desc, countBox, hint);
    typeRows.push({ type, checkInput, countInput, hint });
    checkInput.addEventListener("change", () => {
      if (bankFailed && checkInput.checked) {
        checkInput.checked = false;   // the question files did not load, so this type cannot run
        return;
      }
      if (checkInput.checked) setup.enabled.add(type);
      else setup.enabled.delete(type);
      countInput.disabled = !checkInput.checked;
      drawSetup();
    });
    countInput.addEventListener("input", () => {
      const value = Math.round(Number(countInput.value));
      setup.counts[type] = Number.isFinite(value)
        ? Math.min(MAX_PER_TYPE, Math.max(MIN_PER_TYPE, value))
        : DEFAULT_SET.perType;
      drawSetup();
    });
    // Leaving the box: show the number the run will really use, clamped the same way typing is.
    // Typing stays smooth because the box is left alone until the value is committed.
    countInput.addEventListener("change", () => {
      countInput.value = String(setup.counts[type]);
    });
    typeList.append(row);
  }

  const bankError = el("p", "setup-bank-error", BANK_ERROR);
  bankError.hidden = true;

  // A file that will not load: the built-in types are ticked off and switched off, while the
  // questions you write yourself still run.
  function disableBuiltIns() {
    setup.enabled.clear();
    bankError.hidden = false;
    for (const { checkInput, countInput } of typeRows) {
      checkInput.checked = false;
      countInput.disabled = true;
    }
  }

  const customInput = el("textarea", "setup-custom-input");
  customInput.rows = 4;
  customInput.value = setup.custom;
  customInput.placeholder = "What is 17% of 240? => 28.8\nExplain what a hash table is.";
  customInput.setAttribute("aria-label", "Your own questions");
  customInput.addEventListener("input", () => {
    setup.custom = customInput.value;
    drawSetup();
  });
  const customLabel = el("label", "setup-custom-label", "Your own questions (optional)");
  const customHint = el("p", "setup-custom-hint", CUSTOM_HINT);
  const customBlock = el("div", "setup-custom");
  customBlock.append(customLabel, customInput, customHint);

  const paceRows = [];
  const paceGroup = el("fieldset", "setup-pace");
  paceGroup.append(el("legend", "setup-pace-legend", "Answer length"));
  for (const option of PACE_OPTIONS) {
    const input = el("input");
    input.type = "radio";
    input.name = "answer-length";
    input.value = option.id;
    input.checked = setup.pace === option.id;
    const name = el("span", "setup-pace-name", option.label);
    const choice = el("label", "setup-pace-choice");
    choice.append(input, name);
    if (option.recommended) choice.append(el("span", "setup-pace-rec", "Recommended"));
    const detail = el("span", "setup-pace-detail", option.detail);
    const eta = el("span", "setup-pace-eta", "");
    const row = el("div", "setup-pace-row");
    row.append(choice, detail, eta);
    input.addEventListener("change", () => {
      if (!input.checked) return;
      setup.pace = option.id;
      drawSetup();
    });
    paceRows.push({ id: option.id, input, eta, row });
    paceGroup.append(row);
  }

  const thinkingSelect = el("select", "setup-thinking-select");
  thinkingSelect.id = "tests-thinking";
  for (const option of THINKING_OPTIONS) thinkingSelect.append(new Option(option.label, option.id));
  thinkingSelect.value = setup.thinking;
  thinkingSelect.addEventListener("change", () => {
    setup.thinking = THINKING_OPTIONS.some((o) => o.id === thinkingSelect.value) ? thinkingSelect.value : DEFAULT_THINKING;
    drawSetup();
  });
  const thinkingLabelNode = el("label", "setup-pace-legend", "Thinking");
  thinkingLabelNode.htmlFor = "tests-thinking";
  const thinkingGroup = el("div", "setup-thinking");
  thinkingGroup.append(thinkingLabelNode, thinkingSelect, el("span", "setup-pace-detail",
    "How hard the model thinks before it answers. More thinking is slower and usually scores higher. Thinking gets its own room, so it does not cut the answer short."));

  const totalText = el("span", "setup-total", "");
  const estimateNode = el("span", "setup-estimate", "");
  const startButton = button({ kind: "primary", text: "Start test run", onClick: startRun });
  startButton.classList.add("setup-start");
  const why = el("p", "setup-why");
  const foot = el("div", "setup-foot");
  foot.append(totalText, estimateNode, startButton);
  const setupForm = el("div", "setup-form");
  setupForm.append(setupIntro, modelLine, bankError, typeList, thinkingGroup, paceGroup, customBlock, foot, why);
  const runningLine = el("p", "setup-running", "");
  const setupNode = module({ tag: "section", cls: "setup", children: [setupForm, runningLine] });

  const tiles = el("div", "tiles");

  const legend = el("div", "legend");
  const thisRunKey = el("span", "legend-item");
  thisRunKey.append(el("span", "legend-swatch"), document.createTextNode("This run"));
  const comparedKey = el("span", "legend-item");
  comparedKey.append(el("span", "legend-tick"), document.createTextNode("Compared run"));
  legend.append(thisRunKey, comparedKey);
  const tableHead = el("div", "table-head");
  tableHead.append(sectionLabel("Score by question type"), legend);
  const scoreBox = el("div", "score-scroll");
  const vsNote = el("p", "table-foot");
  // One plain line about how this run was marked, shown once for the run on screen.
  const gradingNote = el("p", "tests-grading-note", GRADING_NOTE);
  gradingNote.hidden = true;
  const table = module({ tag: "section", cls: "table-module", children: [tableHead, scoreBox, vsNote, gradingNote] });

  const radarChart = radar({ axes: QUESTION_TYPES.map(({ type }) => RADAR_LABELS[type] ?? type) });
  const profileNote = notice({ kind: "ok", text: "No profile until a test run is finished." });
  const profile = module({ tag: "section", cls: "profile", children: [sectionLabel("Profile"), radarChart, profileNote] });

  const missedCount = el("span", "missed-count", "");
  const showAllButton = button({
    kind: "ghost",
    small: true,
    text: "Show all",
    onClick: () => {
      state.showAll = !state.showAll;
      applyShowAll();
    },
  });
  const cardsBox = el("div", "miss-list");
  const missedHeading = sectionLabel("Missed questions");
  missedHeading.append(document.createTextNode(" "), missedCount);
  const missed = module({
    tag: "section",
    cls: "missed",
    children: [
      el("div", "missed-head"),
      cardsBox,
    ],
  });
  missed.firstChild.append(missedHeading, showAllButton);

  const readList = el("div", "read-list");
  const readModule = module({
    tag: "section",
    cls: "read-yourself",
    children: [sectionLabel("Read these yourself"), readList],
  });

  const side = el("div", "side");
  side.append(profile, missed, readModule);
  const body = el("div", "body");
  body.append(table, side);

  const dialog = el("dialog", "detail");
  const detailBody = el("div", "detail-body");
  dialog.append(detailBody);
  dialog.addEventListener("close", () => {
    if (openedFrom) openedFrom.focus();
    openedFrom = null;
  });

  tests.append(toolbar, message, saveNotice, setupNode, tiles, body, dialog);
  root.append(tests);

  // Drawing ------------------------------------------------------------------

  function setMessage(text) {
    message.textContent = text;
    message.hidden = !text;
  }

  function drawPickers(current) {
    const list = visibleRuns();
    if (list.length) {
      runSelect.replaceChildren(...list.map((r) => new Option(runLabel(r), String(r.id))));
      runSelect.value = current ? String(current.id) : "";
    } else {
      runSelect.replaceChildren(new Option("No runs yet", ""));
    }
    runSelect.disabled = !list.length;

    const others = list.filter((r) => r.id !== state.selectedId);
    compareSelect.replaceChildren(new Option("None", ""), ...others.map((r) => new Option(runLabel(r), String(r.id))));
    compareSelect.value = comparedRun() ? String(state.compareId) : "";
    compareSelect.disabled = !list.length;
  }

  function drawTiles(current, compared) {
    const cur = current ? totals(current) : null;
    const cmp = compared ? totals(compared) : null;
    const time = current ? clock(current.totalMinutes) : { value: "—", unit: "" };
    tiles.replaceChildren(
      tile({
        label: "Overall score",
        value: cur && cur.total ? String(pct(cur.right, cur.total)) : "—",
        unit: "%",
        big: true,
        note: cur && cur.total ? `${cur.right} / ${cur.total}` : "",
        compare: cmp && cmp.total ? `${pct(cmp.right, cmp.total)}%` : null,
      }),
      tile({
        label: "Average speed",
        value: current ? tpsText(current.averageTokensPerSecond, current.averageWordsPerSecond) : "—",
        unit: "tok/s",
        compare: compared ? tpsText(compared.averageTokensPerSecond, compared.averageWordsPerSecond) : null,
      }),
      tile({
        label: "Total time",
        value: time.value,
        unit: time.unit,
        compare: compared ? longTime(compared.totalMinutes) : null,
      }),
      tile({
        label: "Peak graphics memory",
        value: current ? fmt(current.peakGB) : "—",
        unit: `of ${GPU_TOTAL_GB} GB`,
        compare: compared ? `${fmt(compared.peakGB)}, ${fitWord(compared.peakGB)}` : null,
      }),
    );
  }

  function drawScores(current, compared, previous) {
    gradingNote.hidden = !(current && current.graded);
    if (!current) {
      scoreBox.replaceChildren(notice({
        kind: "ok",
        text: "No test runs yet. Load a model, then run the tests to see scores here.",
      }));
      vsNote.textContent = "";
      return;
    }
    if (!current.byType.length) {
      scoreBox.replaceChildren(notice({ kind: "ok", text: "This run had no scored questions." }));
      vsNote.textContent = "";
      return;
    }

    const grid = el("div", "score-table");
    grid.append(gridRow(HEAD_CELLS.map(([text, num]) => el("span", num ? "num" : "", text)), "score-head"));    for (const t of current.byType) {
      const unscored = Boolean(t.unscored);
      const score = pct(t.right, t.total);
      const comparedType = compared?.byType.find((c) => c.type === t.type) ?? null;
      const comparedScore = comparedType && !comparedType.unscored
        ? pct(comparedType.right, comparedType.total)
        : null;
      const previousType = previous?.byType.find((p) => p.type === t.type) ?? null;
      const change = !unscored && previousType && !previousType.unscored
        ? score - pct(previousType.right, previousType.total)
        : null;
      const label = unscored
        ? `${t.type}: not scored`
        : comparedScore === null
          ? `${t.type}: ${score} percent`
          : `${t.type}: ${score} percent, compared run ${comparedScore} percent`;

      grid.append(gridRow([
        el("span", "score-type", t.type),
        el("span", "score-right num", unscored ? "—" : `${t.right}/${t.total}`),
        scoreBar(unscored ? 0 : score, unscored ? null : comparedScore, label),
        el("span", unscored ? "score-pct num not-scored" : "score-pct num", unscored ? "not scored" : `${score}%`),
        deltaCell(change),
        el("span", "score-wps num", tpsText(t.tokensPerSecond, t.wordsPerSecond)),
      ], "score-row"));
    }
    scoreBox.replaceChildren(grid);

    const counts = current.byType.filter((t) => !t.unscored).map((t) => t.total);
    const uniform = counts.length > 0 && counts.every((n) => n === counts[0]);
    const head = previous
      ? `"Vs last" compares against the previous run of this same model (#${previous.id}).`
      : `"Vs last" has nothing to compare: no earlier run of this model exists.`;
    // Types can now have different numbers of questions, so the noise note only fits when they match.
    const noise = !counts.length
      ? ""
      : uniform
        ? ` Each type has ${counts[0]} questions, so one question moves a score by ${Math.round(100 / counts[0])} points. Treat single-step changes as noise.`
        : " Types have different numbers of questions, so compare them by score, not by count.";
    vsNote.textContent = previous ? head + noise : head;
  }

  function percentsOf(run) {
    return TYPE_NAMES.map((type) => {
      const t = run.byType.find((x) => x.type === type);
      return t ? pct(t.right, t.total) : 0;
    });
  }

  function drawProfile(current, compared) {
    radarChart.hidden = !current;
    profileNote.hidden = !!current;
    if (current) radarChart.set(percentsOf(current), compared ? percentsOf(compared) : null);
  }

  function missedCard(item) {
    const card = el("button", "miss-card");
    card.type = "button";
    const meta = el("div", "miss-meta");
    meta.append(el("span", "", item.type), el("span", "miss-id", item.id));
    const answers = el("div", "miss-answers");
    answers.append(el("span", "expected", `expected ${item.expected}`), el("span", "got", `got ${preview(item.answer, 200)}`));
    card.append(meta, el("div", "miss-question", preview(item.question, 300)), answers);
    if (item.reason) card.append(el("div", "miss-reason", item.reason));
    card.addEventListener("click", () => showDetail(item, card));
    return card;
  }

  function applyShowAll() {
    [...cardsBox.querySelectorAll(".miss-card")].forEach((card, i) => {
      card.hidden = i >= MISSED_SHOWN && !state.showAll;
    });
    showAllButton.textContent = state.showAll ? "Show fewer" : "Show all";
  }

  function drawMissed(current) {
    const list = current ? current.missed : [];
    missedCount.textContent = current ? String(current.missedCount) : "—";
    if (list.length) {
      cardsBox.replaceChildren(...list.map(missedCard));
    } else {
      cardsBox.replaceChildren(el("p", "miss-empty", current ? "No missed questions in this run." : "No runs yet."));
    }
    showAllButton.hidden = list.length <= MISSED_SHOWN;
    applyShowAll();
  }

  function readCard(item) {
    const card = el("button", "read-card");
    card.type = "button";
    card.append(el("div", "read-question", preview(item.question, 300)), el("p", "read-answer", preview(item.answer, 200)));
    card.addEventListener("click", () => showDetail(item, card));
    return card;
  }

  function drawReadYourself(current) {
    const list = current?.readYourself ?? [];
    readModule.hidden = list.length === 0;
    readList.replaceChildren(...list.map(readCard));
  }

  function detailRow(label, child) {
    const row = el("div", "detail-row");
    row.append(sectionLabel(label, "span"), child);
    return row;
  }

  function showDetail(item, opener) {
    openedFrom = opener;
    const rows = [
      sectionLabel(`${item.type} · ${item.id}`),
      detailRow("Question", el("p", "detail-question", item.question)),
      detailRow("Expected answer", el("p", "detail-value expected", item.expected || "No expected answer.")),
      detailRow("Model's answer", el("p", "detail-value got", item.answer)),
    ];
    // A run saved before the answers were checked has no reason, and is shown exactly as it was.
    if (item.reason) rows.push(detailRow("Why it scored", el("p", "detail-value reason", item.reason)));
    rows.push(button({ kind: "secondary", text: "Close", onClick: () => dialog.close() }));
    detailBody.replaceChildren(...rows);
    dialog.showModal();
  }

  // The set-up card: model line, counts, estimate and a Start button with a plain reason when it cannot run.
  function drawSetup() {
    exportButton.disabled = !selectedRun();
    if (run) {
      setupNode.classList.add("running");
      const n = run.questions.length;
      runningLine.textContent = `Running ${n} ${n === 1 ? "question" : "questions"} on ${run.model.name} ${run.model.version}`;
      return;
    }
    setupNode.classList.remove("running");
    // A count that asks for more questions than the files hold says so on the type's own row.
    for (const { type, hint } of typeRows) {
      const capped = bankLoaded && setup.enabled.has(type) && setup.counts[type] > availableCount(type);
      hint.textContent = capped ? `The question files hold ${availableCount(type)}.` : "";
      hint.hidden = !capped;
    }
    const model = currentModel();
    const tokensPerSecond = modelTokensPerSecond({ model, warmup: engine.warmup, runs });
    thinkingSelect.value = setup.thinking;
    thinkingSelect.disabled = Boolean(run);
    for (const row of paceRows) {
      row.input.checked = setup.pace === row.id;
      row.row.classList.toggle("selected", setup.pace === row.id);
      row.eta.textContent = etaText(row.id, model, tokensPerSecond);
    }
    if (model) {
      modelText.textContent = `Testing ${model.name} ${model.version}`;
      modelsLink.hidden = true;
    } else {
      modelText.textContent = "Load a model to run the tests. ";
      modelsLink.hidden = false;
    }
    const total = setupQuestionCount();
    const reason = !historyReady ? "The saved runs are loading." : !model
      ? "Load a model to run the tests."
      : engine.loading
        ? "A model is loading."
        : engine.streaming
          ? "The model is busy answering. Wait for it to finish."
          : !bankLoaded
            ? "The question files are loading."
            : total === 0
              ? "Pick at least one question type or add your own question."
              : "";
    totalText.textContent = `${total} ${total === 1 ? "question" : "questions"}`;
    estimateNode.textContent = etaText(setup.pace, model, tokensPerSecond);
    startButton.textContent = `Start test run · ${total} ${total === 1 ? "question" : "questions"}`;
    startButton.disabled = reason !== "";
    why.textContent = reason;
  }

  function draw() {
    const current = selectedRun();
    const compared = comparedRun();
    drawPickers(current);
    drawTiles(current, compared);
    drawScores(current, compared, previousRun(current));
    drawProfile(current, compared);
    drawMissed(current);
    drawReadYourself(current);
    drawSetup();
  }

  // Run in progress ----------------------------------------------------------

  function mountStrip() {
    const counter = el("span", "strip-count");
    const model = el("span", "strip-model", `${run.model.name} ${run.model.version}`);
    const kind = el("span", "strip-type");
    const speed = readout({ size: "medium", unit: "tok/s", decimals: 1 });
    const speedMeter = segMeter({ min: 0, max: 120, peakHold: true, ticks: ["0", "30", "60", "90", "120"] });
    const progress = segMeter({ min: 0, max: 100, variant: "thin", color: "var(--color-compare)" });
    strip = { counter, kind, model, speed, speedMeter, progress };

    const status = el("div", "strip-group");
    status.append(sectionLabel("Run in progress"), model, counter, kind);
    const speedGroup = el("div", "strip-group");
    speedGroup.append(speed, speedMeter);
    const progressGroup = el("div", "strip-group");
    progressGroup.append(sectionLabel("Progress"), progress);
    const node = module({
      tag: "section",
      cls: "run-strip",
      children: [status, speedGroup, progressGroup, button({ kind: "secondary", text: "Stop", onClick: stopRun })],
    });
    strip.node = node;
    body.before(node);
  }

  function endRun() {
    clearTimeout(run.timer);
    run = null;
    strip?.node.remove();
    strip = null;
    drawSetup();
  }

  function abortRun(text) {
    endRun();
    setMessage(text);
  }

  function startRun() {
    const model = currentModel();
    if (run || !historyReady || !model || engine.loading || engine.streaming) return;
    const rng = seededRandom(QUESTION_SEED + runs.length);
    const questions = plannedQuestions(setup.pace, rng);
    if (!questions.length) return;
    run = {
      id: live ? nextRunId++ : (runs.length ? Math.max(...runs.map((r) => Number(r.id) || 0)) : 0) + 1,
      model,
      modelId: model.id,
      pace: setup.pace,
      thinking: setup.thinking,
      questions,
      index: 0,
      results: [],
      reply: "",
      startedAt: performance.now(),
      peakGB: engine.gpuUsedGB,
      stopping: false,
      timer: 0,
    };
    setMessage("");
    mountStrip();
    drawSetup();
    startQuestion();
  }

  function startQuestion() {
    const question = run.questions[run.index];
    run.reply = "";
    strip.counter.textContent = `Question ${run.index + 1} of ${run.questions.length}`;
    strip.kind.textContent = question.type;
    strip.progress.set((run.index / run.questions.length) * 100);
    // The chosen answer length sets the limit. A hard question gets more room only when the choice allows it.
    // The chosen thinking level is sent as is, and adds its own room on top of the answer's limit.
    if (!engine.sendPrompt(question.prompt, { thinking: run.thinking, maxTokens: tokenCap(question, run.pace, run.thinking) })) {
      abortRun("The model is not ready. Nothing was saved.");
    }
  }

  // Saved runs (live mode) ------------------------------------------------

  async function saveRun(entry) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await store.create("runs", String(entry.id), entry);
        nextRunId = Math.max(nextRunId, entry.id + 1);
        saveNotice.hidden = true;
        return true;
      } catch (error) {
        if (error.status !== 412) break;
        try {
          const items = await store.list("runs");
          entry.id = Math.max(entry.id, ...items.map((item) => Number(item.id) || 0)) + 1;
        } catch { break; }
      }
    }
    showSaveError();
    return false;
  }

  // Read saved runs so the list includes earlier sessions. Newest first, as the gateway lists them.
  async function loadRuns() {
    try {
      const items = await store.list("runs");
      const loaded = [];
      nextRunId = Math.max(0, ...items.map((item) => Number(item.id) || 0)) + 1;
      for (const item of items) {
        if (disposed) return;
        try {
          const rec = await store.get("runs", item.id);
          if (rec && Array.isArray(rec.byType)) loaded.push(rec);
        } catch { showSaveError(); }
      }
      if (disposed) return;
      runs.splice(0, runs.length, ...loaded);
      historyReady = true;
      resetSelection();
      draw();
    } catch {
      if (!disposed) showSaveError();
    }
  }

  async function finishRun() {
    const entry = summarize(run);
    endRun();
    runs.unshift(entry);
    const saved = !live || await saveRun(entry);
    state.previewNoRuns = false;
    previewInput.checked = false;
    state.selectedId = entry.id;
    state.compareId = previousRun(entry)?.id ?? null;
    state.showAll = false;
    setMessage(saved ? `Run #${entry.id} saved.` : "");
    draw();
  }

  function stopRun() {
    if (!run) return;
    run.stopping = true;
    engine.stop();
    abortRun(STOP_NOTE);
  }

  // Engine listeners -------------------------------------------------------

  function onChange() {
    if (run) run.peakGB = Math.max(run.peakGB, engine.gpuUsedGB);
    drawSetup();
  }

  function onSpeed() {
    if (!strip) return;
    strip.speed.set(engine.speed.tokensPerSecond);
    strip.top = Math.max(strip.top ?? 0, engine.speed.tokensPerSecond ?? 0);
    const stripScale = speedScale(strip.top, 100);
    strip.speedMeter.setMax(stripScale.max, stripScale.ticks.map(fmtSpeed));
    strip.speedMeter.set(engine.speed.tokensPerSecond);
  }

  // The whole reply is kept: the engine streams it in pieces and the run collects them.
  function onText(event) {
    if (!run) return;
    run.reply += event.detail.delta ?? "";
  }  // How one reply was marked: a built-in question against its expected answer, your own question by
  // the substring rule. A question with nothing to check against is not scored.
  function mark(question, reply) {
    if (question.type !== CUSTOM_TYPE) {
      const verdict = grade(question, reply);
      return { scored: verdict.correct !== null, correct: verdict.correct === true, reason: verdict.reason };
    }
    if (!question.expected) return { scored: false, correct: false, reason: "Not graded: no expected answer." };
    const correct = reply.toLowerCase().includes(question.expected.toLowerCase());
    return {
      scored: true,
      correct,
      reason: correct
        ? "Correct: the reply contains the expected answer."
        : `Expected "${question.expected}", the reply does not include it.`,
    };
  }

  function onDone(event) {
    if (!run || run.stopping) return;
    const { wordsPerSecond, tokensPerSecond, seconds } = event.detail;
    const reply = run.reply.trim();
    // A reply that failed or was cancelled means the model was stopped by something else, such as a load.
    if (event.detail.failed || event.detail.finishReason === "cancel") {
      abortRun("The model changed during the run. Nothing was saved.");
      return;
    }
    const question = run.questions[run.index];
    // A thinking model can use its whole token limit before it writes an answer: that is a wrong answer, not a stopped run.
    const verdict = reply ? mark(question, reply) : { scored: question.type !== CUSTOM_TYPE || Boolean(question.expected), correct: false, reason: "The model gave no answer (it ran out of room while thinking)." };
    run.results.push({
      id: question.id,
      type: question.type,
      scored: verdict.scored,
      correct: verdict.correct,
      wordsPerSecond,
      tokensPerSecond,
      seconds,
      answer: reply,
      question: question.prompt,
      expected: describeExpected(question),
      reason: verdict.reason,
    });
    run.index += 1;
    if (run.index === run.questions.length) finishRun();
    else run.timer = setTimeout(startQuestion, 0);
  }

  engine.addEventListener("change", onChange);
  engine.addEventListener("speed", onSpeed);
  engine.addEventListener("text", onText);
  engine.addEventListener("done", onDone);
  draw();
  // The question files are read once. A read that fails switches the built-in types off and says so
  // in one plain sentence; the questions you write yourself still run.
  bankReady.then(() => {
    if (disposed) return;
    if (bankFailed) disableBuiltIns();
    drawSetup();
  });
  if (live) loadRuns();

  return () => {
    disposed = true;
    engine.removeEventListener("change", onChange);
    engine.removeEventListener("speed", onSpeed);
    engine.removeEventListener("text", onText);
    engine.removeEventListener("done", onDone);
    if (run) {
      const active = run;
      run = null;
      clearTimeout(active.timer);
      active.stopping = true;
      engine.stop();
    }
  };
}
