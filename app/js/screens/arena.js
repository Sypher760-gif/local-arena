// Arena screen: two models answer one real benchmark question (the bank Tests uses) and the user votes.
import { engine } from "../engine.js";
import { models } from "../data.js";
import { loadQuestions, pickQuestion } from "../questions.js";
import { store, newId } from "../store.js";
import { el, module, sectionLabel, segMeter, speedScale, readout, keycap, button, notice } from "../ui.js";
import { renderMarkdown } from "../markdown.js";
import { grade } from "../grader.js";
import { THINKING_OPTIONS, thinkingRoom, LONG_TOKENS } from "../pace.js";

const CUSTOM_KEY = "benchArenaQuestion"; // set by Chat's "Send to Arena"; read once
const SPEED_MAX = 120;                   // tokens per second: the meter's full scale
const SIDE_COLOR = { A: "var(--color-accent)", B: "var(--color-compare)" };
const CHAT_SETTINGS_KEY = "bench.chat.settings"; // Chat saves its reply settings here
const THINKING_LEVELS = THINKING_OPTIONS.map((o) => o.id);
const OPTIONS_KEY = "bench.arena.options";   // the round options, kept in this browser
// The question types in the bank, with the short label the chips show.
const CATEGORIES = [
  ["Logic", "Logic"], ["Math", "Math"], ["Science", "Science"],
  ["Coding", "Coding"], ["Reading", "Reading"], ["Following instructions", "Instructions"],
];
const DIFFICULTIES = [["any", "Any"], ["easy", "Easy"], ["medium", "Medium"], ["hard", "Hard"]];
const MATCH_SIZES = [[0, "Endless"], [5, "5"], [10, "10"], [20, "20"]];
const GRADING = [["after", "After I vote"], ["off", "Off"]];
const BRAIN_ICON = '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M6 2.5c-.8-1.3-3-1.3-3.7.1-1.5.1-2.1 1.9-1.1 3-1 1.1-.4 2.8 1.2 2.9.5 1.4 2.4 1.5 3.6.7 1.2.8 3.1.7 3.6-.7 1.6-.1 2.2-1.8 1.2-2.9 1-1.1.4-2.9-1.1-3-.7-1.4-2.9-1.4-3.7-.1z" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/><path d="M6 2.7v6.4" fill="none" stroke="currentColor" stroke-width="1.1"/></svg>';
const CHEVRON_ICON = '<svg width="10" height="10" viewBox="0 0 10 10"><path d="M2.5 4 L5 6.5 L7.5 4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const CHOICES = [
  { id: "A", label: "A is better", arrow: "←", key: "ArrowLeft", cls: "arena-vote-a" },
  { id: "tie", label: "Tie", arrow: "↑", key: "ArrowUp", cls: "arena-vote-tie" },
  { id: "bad", label: "Both bad", arrow: "↓", key: "ArrowDown", cls: "arena-vote-bad" },
  { id: "B", label: "B is better", arrow: "→", key: "ArrowRight", cls: "arena-vote-b" },
];
const IDLE_NOTE = "Names appear once you vote. Speed stays visible so you can weigh quality against the wait.";

// Kept in memory for the session. Survives tab switches; lost on page reload.
const session = {
  round: 1,
  record: { A: 0, tie: 0, B: 0 },
  votes: [],
  modelIds: engine.mode === "sim" ? [models[0].id, models[models.length - 1].id] : [null, null],
  hideNames: true,
  pickerOpen: false,
  question: null,  // { type, text, bankId, difficulty, source }; null text while the bank is still loading
  bank: null,      // the real questions, once loaded (id, type, prompt, difficulty)
  bankPromise: null, // the one load of the question files; every later caller reuses it
  usedIds: new Set(), // ids already asked this session, so a draw is not a repeat
  phase: "idle",   // idle | running | stopped | answered | voted
  sides: null,     // { A, B } once a round starts
  activeKey: null, // side that is running now
  choice: null,
  votesLoaded: false, // live mode: saved votes have been read from the store
  editing: false,  // the question edit box is open (kept while the app is open)
  editDraft: "",   // what is typed in it right now
  systemFirst: "",   // system prompt for the first setup (its own, not side A's)
  systemSecond: "",  // system prompt for the second setup
  instructionsOpen: false, // the instructions section is open (kept while the app is open)
  options: null,     // round options (loadOptions): categories, difficulty, match length, thinking, grading
  match: { done: 0, wins: [0, 0], ties: 0 }, // this match: rounds voted, wins by setup (first, second)
  noMatch: false,    // the filters match no question in the bank
};

function loadOptions() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(OPTIONS_KEY)); } catch { saved = null; }
  const all = CATEGORIES.map(([id]) => id);
  const types = Array.isArray(saved?.types) ? saved.types.filter((t) => all.includes(t)) : all;
  return {
    types: types.length ? types : all,
    difficulty: DIFFICULTIES.some(([id]) => id === saved?.difficulty) ? saved.difficulty : "any",
    matchSize: MATCH_SIZES.some(([n]) => n === saved?.matchSize) ? saved.matchSize : 0,
    thinking: THINKING_LEVELS.includes(saved?.thinking) ? saved.thinking : arenaThinking(),
    grading: GRADING.some(([id]) => id === saved?.grading) ? saved.grading : "after",
  };
}

function saveOptions() {
  try { localStorage.setItem(OPTIONS_KEY, JSON.stringify(session.options)); } catch { /* private mode */ }
}

const matchesOptions = (q) => session.options.types.includes(q.type)
  && (session.options.difficulty === "any" || q.difficulty === session.options.difficulty);

// The question files (the same real benchmark questions Tests uses) load once, on first use.
function loadBank() {
  if (!session.bankPromise) {
    session.bankPromise = loadQuestions()
      .then((list) => { session.bank = list; return list; })
      .catch(() => { session.bank = []; return []; });
  }
  return session.bankPromise;
}

const bankHasQuestions = () => Array.isArray(session.bank) && session.bank.length > 0;

// A real question from the bank. Until the bank is read, or when no question matches the choices,
// the round has no question (bankId null, empty text) and cannot start.
function nextQuestion() {
  if (!session.options) session.options = loadOptions();
  session.noMatch = false;
  if (bankHasQuestions()) {
    const pool = session.bank.filter(matchesOptions);
    const question = pickQuestion(pool, session.usedIds);
    if (question) {
      session.usedIds.add(question.id);
      return {
        type: question.type || "Question",
        text: question.prompt,
        answers: null,
        bankId: question.id,
        difficulty: question.difficulty ?? null,
        source: question,   // the bank entry, so both answers can be checked against it
      };
    }
    session.noMatch = true;
  }
  return { type: "", text: "", bankId: null, difficulty: null, empty: true };
}

function resetRound() {
  session.phase = "idle";
  session.sides = null;
  session.activeKey = null;
  session.choice = null;
}

// A question sent from Chat replaces the current one. A voted round stays in the record.
function takeCustomQuestion() {
  const text = sessionStorage.getItem(CUSTOM_KEY);
  if (!text) return;
  sessionStorage.removeItem(CUSTOM_KEY);
  if (session.phase === "voted") session.round += 1;
  session.question = { type: "Your question", text };
  resetRound();
}

const liveModels = new Map();
const modelById = (id) => (engine.mode === "sim" ? models.find((m) => m.id === id) : liveModels.get(id)) ?? null;
const bucket = (choice) => (choice === "A" || choice === "B" ? choice : "tie");
const percent = (v) => `${Math.round(v * 100)}%`;

// The stored shape for one vote (docs/API.md): the vote plus its id and a plain-English title.
function voteRecord(v) {
  const nameA = modelById(v.modelA)?.name ?? v.modelA;
  const nameB = modelById(v.modelB)?.name ?? v.modelB;
  return {
    id: v.id,
    title: `${nameA} vs ${nameB}: ${v.choice}`,
    round: v.round,
    type: v.type,
    question: v.question,
    modelA: v.modelA,
    modelB: v.modelB,
    answerA: v.answerA,
    answerB: v.answerB,
    wpsA: v.wpsA,
    wpsB: v.wpsB,
    tpsA: v.tpsA,
    tpsB: v.tpsB,
    systemFirst: v.systemFirst,
    systemSecond: v.systemSecond,
    thinking: v.thinking,
    bankId: v.bankId,
    correctA: v.correctA,
    correctB: v.correctB,
    choice: v.choice,
    timestamp: v.timestamp,
  };
}

// system is the setup's system prompt; setup is 0 for the first setup and 1 for the second, so the
// instructions can be recorded against the setup rather than the letter (A or B is random each round).
function newSide(modelId, system = "", setup = 0) {
  return {
    modelId, system, setup, text: "", words: 0, tokens: 0, liveWps: 0, liveTps: 0, wps: null, tps: null,
    firstWordS: null, totalS: null, status: "waiting", progress: 0,
    thinking: "", thinkStartMs: null, thinkSeconds: null, thinkingOpen: null, grade: null,
  };
}
const EMPTY_SIDE = newSide(null);

function statusText(side) {
  if (side.status === "loading") return `Loading model ${percent(side.progress)}`;
  if (side.status === "unloading") return `Unloading model ${percent(side.progress)}`;
  return { waiting: "Waiting", writing: "Writing", done: "Done", failed: "Failed" }[side.status];
}

// The same reply settings Chat saves (localStorage); Arena answers with the thinking level the user chose.
function arenaThinking() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(CHAT_SETTINGS_KEY)); } catch { saved = null; }
  return THINKING_LEVELS.includes(saved?.thinking) ? saved.thinking : "medium";
}

// Static icon markup only. Never pass user text here.
function icon(markup) {
  const node = el("span", "arena-icon");
  node.setAttribute("aria-hidden", "true");
  node.innerHTML = markup;
  return node;
}

function secondsText(seconds) {
  if (seconds < 1) return "under a second";
  if (seconds < 60) return `${Math.round(seconds)} s`;
  return `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
}

// What this side is doing right now, read from what it has said so far.
function sidePhase(side) {
  if (side.text) return "writing";
  if (side.thinking) return "thinking";
  return "reading";
}

// Thinking time so far: frozen when the answer started, running while the side still thinks.
function sideThinkingSeconds(side) {
  if (side.thinkSeconds !== null) return side.thinkSeconds;
  if (side.thinkStartMs !== null) return (performance.now() - side.thinkStartMs) / 1000;
  return null;
}

// The reasoning text as a toggle row: open while the side thinks, shut when its answer starts.
function thoughtRow(side) {
  const row = el("details", "thought-row");
  const chevron = icon(CHEVRON_ICON);
  chevron.classList.add("thought-chevron");
  const label = side.status === "writing" && !side.text ? "Thinking"
    : `Thought for ${secondsText(side.thinkSeconds ?? sideThinkingSeconds(side) ?? 0)}`;
  const summary = el("summary", "thought-summary");
  summary.append(chevron, el("span", "thought-label", label));
  row.append(summary, el("div", "thought-text", side.thinking));
  row.open = side.thinkingOpen ?? !side.text;
  // The click lands before the browser opens or closes the row, so the choice survives a re-render.
  summary.addEventListener("click", () => { side.thinkingOpen = !row.open; });
  return row;
}

function buildSide(key) {
  const section = el("section", "arena-side");
  section.setAttribute("aria-label", `Answer ${key}`);
  section.style.setProperty("--side-color", SIDE_COLOR[key]);

  const badge = el("span", "arena-badge", key);
  const pill = el("span", "arena-pill", "Name hidden");
  const name = el("span", "arena-name");
  name.hidden = true;
  const status = el("span", "arena-status");
  const speed = readout({ size: "medium", unit: "tok/s", decimals: 1 });
  speed.classList.add("arena-speed");
  const head = el("div", "arena-side-head");
  head.append(badge, pill, name, status, speed);

  const meter = segMeter({ min: 0, max: SPEED_MAX, peakHold: true, color: SIDE_COLOR[key] });
  meter.classList.add("arena-meter");
  const first = el("span");
  const words = el("span");
  const total = el("span");
  const stats = el("div", "arena-stats");
  stats.append(first, words, total);
  const gauge = el("div", "arena-gauge");
  gauge.append(meter, stats);

  // This setup's instructions: hidden while the names are hidden, shown after the vote.
  const system = el("div", "arena-side-system");
  system.hidden = true;
  // The answer check: shown only after the vote, so it never sways it.
  const verdict = el("div", "arena-verdict");
  verdict.hidden = true;

  const failure = notice({ kind: "warn", text: "This model did not finish. It either did not load (not enough free graphics memory) or the engine stopped answering." });
  failure.hidden = true;
  const thought = el("div", "arena-thought");
  const text = el("div", "arena-text");
  section.append(head, system, verdict, gauge, thought, failure, text);
  return { key, section, pill, name, status, speed, meter, first, words, total, thought, system, text, failure, verdict };
}

export function render(root) {
  if (!session.options) session.options = loadOptions();
  if (!session.question || (session.question.empty && bankHasQuestions())) session.question = nextQuestion();
  takeCustomQuestion();

  let cancelled = false;
  let meterTop = 0;   // fastest speed either side has shown on this screen
  let detachWriting = () => {};

  // Re-render the answers at most every 100 ms while a side streams; the end paints once more.
  let paintTimer = 0;
  function schedulePaint() {
    if (paintTimer) return;
    paintTimer = setTimeout(() => { paintTimer = 0; paint(); }, 100);
  }
  function flushPaint() {
    if (paintTimer) { clearTimeout(paintTimer); paintTimer = 0; }
  }

  // Header strip ---------------------------------------------------------
  const roundNo = el("span", "arena-round-no", String(session.round));
  const roundLabel = sectionLabel("Round ", "span");
  roundLabel.append(roundNo);

  const countA = el("span", "arena-count-a");
  const countB = el("span", "arena-count-b");
  const countTie = el("span", "arena-count-tie");
  const segA = el("span", "arena-record-a");
  const segTie = el("span", "arena-record-tie");
  const segB = el("span", "arena-record-b");
  const bar = el("div", "arena-record");
  bar.append(segA, segTie, segB);
  bar.setAttribute("role", "img");
  const recordNote = el("span", "arena-record-note", "No votes saved yet.");
  const recordWrap = el("div", "arena-record-wrap");
  recordWrap.append(countA, bar, countB, countTie, recordNote);

  const hideInput = el("input");
  hideInput.type = "checkbox";
  hideInput.checked = session.hideNames;
  hideInput.addEventListener("change", () => {
    session.hideNames = hideInput.checked;
    paint();
  });
  const hideLabel = el("label", "arena-check");
  hideLabel.append(hideInput, "Hide names until I vote");

  const changeButton = button({ kind: "secondary", small: true, text: "Change models" });
  changeButton.addEventListener("click", () => {
    session.pickerOpen = !session.pickerOpen;
    paint();
  });

  const topRow = el("div", "arena-top");
  const matchNote = el("span", "arena-match-note");
  topRow.append(roundLabel, matchNote, recordWrap, hideLabel, changeButton);

  // Round options: which questions, how many rounds, how hard the models think, answer checking.
  const opts = session.options;
  const optionControls = [];
  const optGroup = (label, control, cls = "") => {
    const group = el("div", `arena-opt ${cls}`.trim());
    group.append(el("span", "arena-opt-label", label), control);
    return group;
  };
  const chipRow = el("div", "arena-chips");
  chipRow.setAttribute("role", "group");
  chipRow.setAttribute("aria-label", "Question categories");
  const chips = CATEGORIES.map(([id, label]) => {
    const chipNode = el("button", "arena-chip", label);
    chipNode.type = "button";
    chipNode.dataset.type = id;
    chipNode.addEventListener("click", () => {
      const all = CATEGORIES.map(([type]) => type);
      const on = opts.types.includes(id);
      if (opts.types.length === all.length) opts.types = [id];             // from All: pick just this one
      else if (on && opts.types.length === 1) opts.types = all;            // the last one off: back to All
      else opts.types = on ? opts.types.filter((t) => t !== id) : [...opts.types, id]; // add or drop one
      optionsChanged(true);
    });
    chipRow.append(chipNode);
    optionControls.push(chipNode);
    return chipNode;
  });
  const allChip = el("button", "arena-chip arena-chip-all", "All");
  allChip.type = "button";
  allChip.addEventListener("click", () => { opts.types = CATEGORIES.map(([id]) => id); optionsChanged(true); });
  chipRow.prepend(allChip);
  optionControls.push(allChip);

  const optSelect = (key, choices, id, onChange) => {
    const node = el("select", "arena-opt-select");
    node.id = id;
    for (const [value, label] of choices) node.append(new Option(label, String(value)));
    node.value = String(opts[key]);
    node.addEventListener("change", () => {
      opts[key] = typeof choices[0][0] === "number" ? Number(node.value) : node.value;
      onChange?.();
      optionsChanged(false);
    });
    optionControls.push(node);
    return node;
  };
  const difficultySelect = optSelect("difficulty", DIFFICULTIES, "arena-difficulty-select", () => redrawIfFiltered());
  const matchSelect = optSelect("matchSize", MATCH_SIZES, "arena-match-select", () => { session.match = { done: 0, wins: [0, 0], ties: 0 }; });
  const thinkingSelect = optSelect("thinking", THINKING_OPTIONS.map((o) => [o.id, o.label]), "arena-thinking-select");
  const gradingSelect = optSelect("grading", GRADING, "arena-grading-select");
  thinkingSelect.title = "How hard both models think before they answer. More thinking is slower and usually better.";
  gradingSelect.title = "Local Arena checks each answer against the question's known answer and shows the result once you have voted.";
  const skipButton = button({ kind: "ghost", small: true, text: "Another question" });
  skipButton.classList.add("arena-skip");
  skipButton.title = "Draw a different question with these options";
  skipButton.addEventListener("click", () => {
    if (session.phase !== "idle") return;
    session.editing = false;
    session.question = nextQuestion();
    paint();
  });
  const optionsRow = el("div", "arena-options");
  const poolNote = el("span", "arena-pool-note");
  const chipWrap = el("div", "arena-chip-wrap");
  chipWrap.append(chipRow, poolNote);
  optionsRow.append(
    optGroup("Questions", chipWrap, "arena-opt-wide"),
    optGroup("Difficulty", difficultySelect),
    optGroup("Rounds", matchSelect),
    optGroup("Thinking", thinkingSelect),
    optGroup("Check answers", gradingSelect),
  );
  function redrawIfFiltered() {
    const q = session.question;
    if (session.phase === "idle" && !session.editing && (q.empty || (q.source && !matchesOptions(q.source)))) {
      session.question = nextQuestion();
    }
  }
  function optionsChanged(filtersChanged) {
    if (filtersChanged) redrawIfFiltered();
    saveOptions();
    paint();
  }

  // Model picker (opened by Change models)
  const selects = [0, 1].map((i) => {
    const select = el("select", "arena-select");
    select.addEventListener("change", () => {
      session.modelIds[i] = select.value;
    });
    const label = el("label", "arena-pick");
    label.append(sectionLabel(i === 0 ? "First model" : "Second model", "span"), select);
    return label;
  });
  let catalogueReady = engine.mode === "sim";
  function fillModelSelects() {
    const choices = engine.mode === "sim" ? models : [...liveModels.values()];
    for (let i = 0; i < selects.length; i += 1) {
      const select = selects[i].querySelector("select");
      select.replaceChildren(...choices.map((m) => {
        const option = el("option", "", engine.mode === "sim" ? `${m.name} ${m.version}, ${m.sizeGB} GB` : `${m.name} ${m.version ?? ""}`.trim());
        option.value = m.id;
        return option;
      }));
      select.value = session.modelIds[i] ?? "";
    }
  }
  async function loadCatalogue() {
    try {
      const res = await fetch("/api/models", { cache: "no-store" });
      if (!res.ok) throw new Error("catalogue");
      const data = await res.json();
      if (cancelled) return;
      liveModels.clear();
      for (const model of data.models ?? []) if (model.onDisk || model.loaded) liveModels.set(model.id, model);
      const loaded = (data.models ?? []).find((m) => m.loaded);
      const current = loaded ?? engine.loadedModel;
      if (current && !liveModels.has(current.id)) liveModels.set(current.id, { ...current, loaded: true });
      for (let i = 0; i < 2; i += 1) {
        if (!liveModels.has(session.modelIds[i])) session.modelIds[i] = current?.id ?? liveModels.keys().next().value ?? null;
      }
      catalogueReady = true;
      fillModelSelects();
      paint();
    } catch { if (!cancelled) paint(); }
  }
  fillModelSelects();
  const pickerNote = el("span", "arena-picker-note", "The two models take turns on the card. Which one is A and which is B is random each round.");
  const pickerDone = button({ kind: "secondary", small: true, text: "Done" });
  pickerDone.addEventListener("click", () => {
    session.pickerOpen = false;
    paint();
  });
  const picker = el("div", "arena-picker");
  picker.append(...selects, pickerNote, pickerDone);

  // Question
  const questionType = el("span", "arena-tag");
  const questionDifficulty = el("span", "arena-difficulty");
  questionDifficulty.hidden = true;
  const questionHead = el("div", "arena-question-head");
  const questionSource = el("span", "arena-difficulty arena-source");
  questionHead.append(sectionLabel("Question", "span"), questionType, questionDifficulty, questionSource);
  const questionText = el("div", "arena-question-text");
  const editInput = el("textarea", "arena-edit-input");
  editInput.rows = 3;
  editInput.setAttribute("aria-label", "Question text");
  const editDone = button({ kind: "primary", small: true, text: "Done" });
  const editCancel = button({ kind: "ghost", small: true, text: "Cancel" });
  const editButtons = el("div", "arena-edit-buttons");
  editButtons.append(editDone, editCancel);
  const editBox = el("div", "arena-edit");
  editBox.append(editInput, editButtons);
  editBox.hidden = true;
  const editButton = button({ kind: "ghost", small: true, text: "Edit question" });
  const questionMain = el("div", "arena-question-main");
  questionMain.append(questionHead, questionText, editBox);
  const questionRow = el("div", "arena-question");
  questionRow.append(questionMain);

  editButton.addEventListener("click", () => {
    if (session.phase !== "idle") return;
    session.editing = true;
    session.editDraft = session.question.text;
    editInput.value = session.editDraft;
    paint();
    editInput.focus();
  });
  // The draft is kept on the session, so leaving the tab and coming back does not lose it.
  editInput.addEventListener("input", () => {
    session.editDraft = editInput.value;
  });
  editDone.addEventListener("click", () => {
    const text = editInput.value.trim();
    if (text && text !== session.question.text) {
      session.question = { type: "Custom", text };
    }
    session.editing = false;
    paint();
  });
  editCancel.addEventListener("click", () => {
    session.editing = false;
    paint();
  });

  // Instructions for each side (optional): two system prompts, kept on the session like the question.
  const systemFirstInput = el("textarea", "arena-system-input arena-system-first");
  systemFirstInput.rows = 2;
  systemFirstInput.value = session.systemFirst;
  systemFirstInput.placeholder = "Answer like a careful teacher.";
  systemFirstInput.setAttribute("aria-label", "Instructions for the first setup");
  systemFirstInput.addEventListener("input", () => { session.systemFirst = systemFirstInput.value; });
  const systemSecondInput = el("textarea", "arena-system-input arena-system-second");
  systemSecondInput.rows = 2;
  systemSecondInput.value = session.systemSecond;
  systemSecondInput.placeholder = "Answer in three short bullet points.";
  systemSecondInput.setAttribute("aria-label", "Instructions for the second setup");
  systemSecondInput.addEventListener("input", () => { session.systemSecond = systemSecondInput.value; });
  const systemFirstField = el("label", "arena-system-field");
  systemFirstField.append(sectionLabel("Instructions for the first setup", "span"), systemFirstInput);
  const systemSecondField = el("label", "arena-system-field");
  systemSecondField.append(sectionLabel("Instructions for the second setup", "span"), systemSecondInput);
  const systemNote = el("p", "arena-system-note", "Each text is sent to that setup as its system prompt, so it shapes that side's answer. Leave both empty to send none.");
  const systemSummary = el("summary", "arena-system-summary", "Different instructions for each side (optional)");
  const instructions = el("details", "arena-instructions");
  instructions.open = session.instructionsOpen;
  instructions.addEventListener("toggle", () => { session.instructionsOpen = instructions.open; });
  instructions.append(systemSummary, systemNote, systemFirstField, systemSecondField);

  const keepNote = el("p", "arena-help", "Your round, your question and your votes are kept while the app is open. Reloading the page starts fresh.");
  const questionActions = el("div", "arena-question-actions");
  questionActions.append(skipButton, editButton);
  questionRow.append(questionActions);
  const strip = module({ tag: "section", cls: "arena-strip", children: [topRow, picker, optionsRow, questionRow, instructions, keepNote] });
  picker.hidden = true;

  // Answers --------------------------------------------------------------
  const views = { A: buildSide("A"), B: buildSide("B") };
  const answers = el("div", "arena-answers");
  answers.append(views.A.section, views.B.section);

  // Vote dock ------------------------------------------------------------
  const voteRow = el("div", "arena-votes");
  const voteButtons = CHOICES.map((c) => {
    const node = el("button", `arena-vote ${c.cls}`);
    node.type = "button";
    const key = keycap(c.arrow);
    key.setAttribute("aria-hidden", "true");
    node.append(...(c.id === "B" ? [c.label, key] : [key, c.label]));
    node.addEventListener("click", () => vote(c.id));
    voteRow.append(node);
    return { id: c.id, node };
  });

  const note = el("span", "arena-note");
  const undoButton = button({ kind: "ghost", small: true, text: "Undo" });
  undoButton.classList.add("arena-undo");
  undoButton.addEventListener("click", undo);
  const statusLeft = el("div", "arena-status-left");
  statusLeft.append(note, undoButton);
  const startButton = button({ kind: "primary", text: "Start round" });
  startButton.classList.add("arena-start");
  startButton.addEventListener("click", runRound);
  const nextButton = button({ kind: "secondary", small: true, text: "Next question" });
  nextButton.classList.add("arena-next");
  nextButton.addEventListener("click", nextRound);
  // Shown after a round was interrupted by leaving the tab: runs only the sides that never finished.
  const resumeButton = button({ kind: "primary", text: "Run this round again" });
  resumeButton.classList.add("arena-resume");
  resumeButton.addEventListener("click", resumeRound);
  const statusActions = el("div", "arena-status-actions");
  statusActions.append(startButton, resumeButton, nextButton);
  const statusRow = el("div", "arena-status-row");
  statusRow.append(statusLeft, statusActions);

  const dock = module({ tag: "footer", cls: "arena-dock", children: [voteRow, statusRow] });

  // Saved votes (live mode) --------------------------------------------------
  const saveNotice = notice({ kind: "warn", text: "Could not save. Your work is still on screen." });
  saveNotice.hidden = true;
  statusLeft.prepend(saveNotice);
  let saveErrorTimer = 0;

  function showSaveError() {
    saveNotice.hidden = false;
    clearTimeout(saveErrorTimer);
    saveErrorTimer = setTimeout(() => { saveNotice.hidden = true; }, 4000);
  }

  async function saveVote(v) {
    try {
      await store.put("votes", v.id, voteRecord(v));
      saveNotice.hidden = true;
    } catch {
      showSaveError();
    }
  }

  async function removeVote(id) {
    try {
      await store.remove("votes", id);
    } catch {
      showSaveError();
    }
  }

  // Read saved votes so the record counts include earlier sessions. Only once per page load.
  async function loadVotes() {
    session.votesLoaded = true;
    let items = [];
    try {
      items = await store.list("votes");
    } catch {
      showSaveError();
      return;
    }
    for (const item of items) {
      try {
        const v = await store.get("votes", item.id);
        if (v && v.choice) session.record[bucket(v.choice)] += 1;
      } catch {
        // A record that will not read is skipped; the rest of the counts still stand.
      }
    }
    paint();
  }

  const screen = el("div", "arena");
  screen.append(strip, answers, dock);
  root.append(screen);

  // Painting -------------------------------------------------------------

  function paintRecord() {
    const { A, tie, B } = session.record;
    countA.textContent = `A ${A}`;
    countB.textContent = `${B} B`;
    countTie.textContent = `${tie} tied`;
    segA.style.flex = `${A} 1 0`;
    segTie.style.flex = `${tie} 1 0`;
    segB.style.flex = `${B} 1 0`;
    bar.setAttribute("aria-label", `A won ${A}, tied ${tie}, B won ${B}`);
    recordNote.hidden = A + tie + B > 0;
  }

  function copyCode(btn, text) {
    const label = btn.textContent;
    const flash = (words) => { btn.textContent = words; setTimeout(() => { btn.textContent = label; }, 1500); };
    if (!navigator.clipboard) { flash("Could not copy"); return; }
    navigator.clipboard.writeText(text).then(() => flash("Copied"), () => flash("Could not copy"));
  }

  function wireCodeCopy(container) {
    for (const btn of container.querySelectorAll(".md-copy")) {
      btn.addEventListener("click", () => {
        const code = btn.closest(".md-codeblock")?.querySelector("pre.md-code code")?.textContent ?? "";
        copyCode(btn, code);
      });
    }
  }

  function paintSide(view, side) {
    const model = modelById(side.modelId);
    const revealed = model !== null && (session.phase === "voted" || !session.hideNames);
    view.pill.hidden = revealed;
    view.name.hidden = !revealed;
    if (revealed) view.name.replaceChildren(`${model.name} `, el("span", "arena-version", model.version));
    if (side.status === "writing") {
      const phase = sidePhase(side);
      const parts = [];
      if (phase === "thinking") parts.push(icon(BRAIN_ICON));
      const seconds = phase === "thinking" ? sideThinkingSeconds(side) : null;
      const words = phase === "reading" ? "Reading"
        : phase === "writing" ? "Writing"
          : seconds !== null && seconds >= 1 ? `Thinking ${secondsText(seconds)}` : "Thinking";
      parts.push(el("span", "work-shimmer", words));
      const dots = el("span", "work-dots");
      dots.setAttribute("aria-hidden", "true");
      for (let i = 0; i < 3; i += 1) dots.append(el("span", "work-dot"));
      parts.push(dots);
      view.status.className = "arena-status work-phase";
      view.status.replaceChildren(...parts);
    } else {
      view.status.className = "arena-status";
      view.status.textContent = statusText(side);
    }
    // The instructions are hidden with the names, and shown for each side after the vote.
    const showVerdict = session.phase === "voted" && session.options.grading === "after" && side.grade && side.grade.correct !== null;
    view.verdict.hidden = !showVerdict;
    if (showVerdict) {
      view.verdict.className = `arena-verdict ${side.grade.correct ? "is-right" : "is-wrong"}`;
      view.verdict.replaceChildren(el("span", "arena-verdict-mark", side.grade.correct ? "Correct" : "Wrong"),
        el("span", "arena-verdict-reason", side.grade.reason));
    }
    view.system.hidden = !revealed || !side.system;
    if (revealed && side.system) view.system.textContent = `Instructions: ${side.system}`;
    view.speed.set(side.liveTps);
    // The meter's scale grows to fit the faster side, so both sides share one scale.
    meterTop = Math.max(meterTop, side.liveTps ?? 0);
    view.meter.setMax(speedScale(meterTop, SPEED_MAX).max);
    view.meter.set(side.liveTps);
    view.first.textContent = `first word ${side.firstWordS === null ? "—" : `${side.firstWordS.toFixed(1)} s`}`;
    view.words.textContent = `${side.words} words`;
    view.total.textContent = `done in ${side.totalS === null ? "—" : `${side.totalS.toFixed(1)} s`}`;
    view.text.classList.toggle("arena-text-empty", side.text === "");
    if (view.lastText !== side.text) {
      view.lastText = side.text;
      if (side.text === "") view.text.textContent = "No answer yet.";
      else { view.text.replaceChildren(renderMarkdown(side.text)); wireCodeCopy(view.text); }
    }
    view.failure.hidden = side.status !== "failed";
    view.thought.replaceChildren();
    if (side.thinking) view.thought.append(thoughtRow(side));
  }

  function statusNote() {
    if (session.phase === "running") {
      const side = session.sides?.[session.activeKey];
      return side ? `Side ${session.activeKey}: ${statusText(side)}` : "Starting the round";
    }
    if (session.phase === "stopped") return "Stopped when you left. Run this round again.";
    if (session.phase === "answered") return "Both answers are in. Vote with the buttons or the arrow keys.";
    if (session.phase === "voted") return `Vote recorded: ${CHOICES.find((c) => c.id === session.choice).label}.`;
    return IDLE_NOTE;
  }

  function paintOptions() {
    const locked = session.phase === "running";
    for (const node of optionControls) node.disabled = locked;
    const allOn = opts.types.length === CATEGORIES.length;
    allChip.classList.toggle("on", allOn);
    allChip.setAttribute("aria-pressed", String(allOn));
    for (const node of chips) {
      const on = !allOn && opts.types.includes(node.dataset.type);
      node.classList.toggle("on", on);
      node.setAttribute("aria-pressed", String(opts.types.includes(node.dataset.type)));
    }
    difficultySelect.value = opts.difficulty;
    matchSelect.value = String(opts.matchSize);
    thinkingSelect.value = opts.thinking;
    gradingSelect.value = opts.grading;
    skipButton.disabled = session.phase !== "idle" || !bankHasQuestions();
    const pool = bankHasQuestions() ? session.bank.filter(matchesOptions).length : null;
    poolNote.textContent = pool === null ? "" : session.noMatch ? "No question matches these choices." : `${pool} questions match`;
    const m = session.match;
    const size = opts.matchSize;
    if (size > 0) {
      const finished = m.done >= size;
      matchNote.textContent = finished
        ? `Match over · first setup ${m.wins[0]}, second ${m.wins[1]}, ${m.ties} tied`
        : `Round ${Math.min(m.done + 1, size)} of ${size}`;
      matchNote.hidden = false;
      roundLabel.hidden = true;
    } else {
      matchNote.hidden = true;
      roundLabel.hidden = false;
    }
  }

  function paint() {
    if (cancelled) return;
    roundNo.textContent = String(session.round);
    paintRecord();
    changeButton.disabled = session.phase === "running";
    changeButton.setAttribute("aria-expanded", String(session.pickerOpen));
    picker.hidden = !session.pickerOpen;
    questionType.textContent = session.question.type;
    questionDifficulty.textContent = session.question.difficulty ?? "";
    questionDifficulty.hidden = !session.question.difficulty;
    const src = session.question.source?.source;
    questionSource.textContent = src ? `from ${src}` : "";
    questionSource.hidden = !src;
    paintOptions();
    questionText.textContent = session.question.empty
      ? (session.bank === null ? "Loading questions…" : session.noMatch ? "No question matches these choices." : "The question files could not be loaded.")
      : session.question.text;
    questionText.hidden = session.editing;
    editBox.hidden = !session.editing;
    if (session.editing && editInput.value !== session.editDraft) editInput.value = session.editDraft;
    editButton.disabled = session.phase !== "idle" || session.editing;
    for (const key of ["A", "B"]) paintSide(views[key], session.sides?.[key] ?? EMPTY_SIDE);
    for (const { id, node } of voteButtons) {
      node.disabled = session.phase !== "answered";
      node.setAttribute("aria-pressed", String(session.choice === id));
    }
    const switchingElsewhere = session.phase === "idle" && Boolean(engine.loading);
    const engineDown = engine.mode !== "sim" && !engine.reachable && !engine.loading;
    const noModelLoaded = engine.mode !== "sim" && session.phase === "idle" && !engine.loading && !engineDown && engine.loadedModelId === null;
    note.textContent = switchingElsewhere ? "A model is loading"
      : engineDown ? "The model engine is not answering. Try again."
      : noModelLoaded ? "No model is loaded. Load one on the Models screen to start a round."
      : statusNote();
    note.classList.toggle("arena-note-strong", session.phase === "voted");
    undoButton.hidden = session.phase !== "voted";
    startButton.hidden = session.phase !== "idle";
    startButton.disabled = switchingElsewhere || engineDown || noModelLoaded || Boolean(session.question.empty) || !catalogueReady || session.modelIds.some((id) => !id);
    resumeButton.hidden = session.phase !== "stopped";
    resumeButton.disabled = switchingElsewhere || engineDown;
    nextButton.hidden = session.phase !== "voted";
    const matchOver = session.options.matchSize > 0 && session.match.done >= session.options.matchSize;
    nextButton.textContent = matchOver ? "New match" : "Next question";
  }

  // Actions --------------------------------------------------------------

  function vote(choice) {
    if (session.phase !== "answered") return;
    const { A, B } = session.sides;
    // The instructions belong to the setup, so record them by setup number, not by side letter.
    const bySetup = (index) => (A.setup === index ? A.system : B.system) || "";
    const v = {
      round: session.round,
      type: session.question.type,
      question: session.question.text,
      modelA: A.modelId,
      modelB: B.modelId,
      answerA: A.text,
      answerB: B.text,
      wpsA: A.wps,
      wpsB: B.wps,
      tpsA: A.tps,
      tpsB: B.tps,
      systemFirst: bySetup(0),
      systemSecond: bySetup(1),
      choice,
      timestamp: new Date().toISOString(),
    };
    if (engine.mode !== "sim") v.id = newId();
    if (session.question.source) {
      A.grade = grade(session.question.source, A.text);
      B.grade = grade(session.question.source, B.text);
      v.correctA = A.grade.correct;
      v.correctB = B.grade.correct;
    }
    v.thinking = session.options.thinking;
    v.bankId = session.question.bankId ?? null;
    // The match counts wins by setup (first or second model), since A and B swap at random.
    const winnerSetup = choice === "A" ? A.setup : choice === "B" ? B.setup : null;
    v.matchWinner = winnerSetup;
    session.match.done += 1;
    if (winnerSetup === null) session.match.ties += 1;
    else session.match.wins[winnerSetup] += 1;
    session.votes.push(v);
    session.record[bucket(choice)] += 1;
    session.choice = choice;
    session.phase = "voted";
    if (engine.mode !== "sim") saveVote(v);
    paint();
  }

  function undo() {
    if (session.phase !== "voted") return;
    const last = session.votes.pop();
    session.record[bucket(last.choice)] -= 1;
    session.match.done = Math.max(0, session.match.done - 1);
    if (last.matchWinner === null || last.matchWinner === undefined) session.match.ties = Math.max(0, session.match.ties - 1);
    else session.match.wins[last.matchWinner] = Math.max(0, session.match.wins[last.matchWinner] - 1);
    session.choice = null;
    session.phase = "answered";
    if (engine.mode !== "sim" && last.id) removeVote(last.id);
    paint();
  }

  function nextRound() {
    if (session.phase !== "voted") return;
    session.round += 1;
    if (session.options.matchSize > 0 && session.match.done >= session.options.matchSize) {
      session.match = { done: 0, wins: [0, 0], ties: 0 };
    }
    session.question = nextQuestion();
    resetRound();
    paint();
  }

  async function runRound() {
    if (session.phase !== "idle" || engine.loading) return;
    session.editing = false;
    const { question } = session;
    const [first, second] = session.modelIds;
    const flip = Math.random() < 0.5; // random side per round, so position tells nothing
    // Each setup carries its own instructions; the blind flip decides which setup is A.
    const setups = flip
      ? [{ model: second, system: session.systemSecond, setup: 1 }, { model: first, system: session.systemFirst, setup: 0 }]
      : [{ model: first, system: session.systemFirst, setup: 0 }, { model: second, system: session.systemSecond, setup: 1 }];
    session.sides = {
      A: newSide(setups[0].model, setups[0].system, setups[0].setup),
      B: newSide(setups[1].model, setups[1].system, setups[1].setup),
    };
    session.phase = "running";
    paint();
    for (const key of ["A", "B"]) {
      session.activeKey = key;
      await runSide(session.sides[key]);
      if (cancelled) return;
    }
    session.activeKey = null;
    session.phase = "answered";
    paint();
  }

  // After a round was stopped by leaving the tab: run only the sides that never finished,
  // and keep the answer and stats of every side that had already finished.
  async function resumeRound() {
    if (session.phase !== "stopped" || engine.loading) return;
    session.editing = false;
    paint();
    for (const key of ["A", "B"]) {
      const side = session.sides[key];
      if (side.status === "done") continue;
      session.sides[key] = newSide(side.modelId, side.system, side.setup);
      session.phase = "running";
      session.activeKey = key;
      paint();
      await runSide(session.sides[key]);
      if (cancelled) return;
    }
    session.activeKey = null;
    session.phase = "answered";
    paint();
  }

  // One turn: unload the previous model, load this side's model, stream its answer.
  async function runSide(side) {
    // Both pickers may name the same model: when it is already loaded, skip the unload and reload.
    const currentId = engine.mode === "sim" ? engine.loadedModelId : (engine.loadedEntryId ?? engine.loadedModelId);
    if (currentId !== side.modelId) {
      if (engine.mode === "sim" && engine.loadedModelId) {
        side.status = "unloading";
        paint();
        await engine.unloadModel();
        if (cancelled) return;
      }
      side.status = "loading";
      paint();
      try {
        await engine.loadModel(side.modelId);
        if (engine.mode !== "sim" && (engine.loadedEntryId ?? engine.loadedModelId) !== side.modelId) throw new Error("model not loaded");
      } catch {
        if (cancelled) return;
        side.status = "failed";
        paint();
        return;
      }
      if (cancelled) return;
    }
    side.status = "writing";
    paint();
    await streamEngine(side);
    if (cancelled || side.status === "failed") return;
    paint();
  }


  // No prepared answer: the engine streams its own reply and reports through events.
  function streamEngine(side) {
    return new Promise((resolve) => {
      const onText = (event) => {
        if (!side.text && side.thinkStartMs !== null && side.thinkSeconds === null) {
          side.thinkSeconds = (performance.now() - side.thinkStartMs) / 1000;
          if (side.thinkingOpen === null) side.thinkingOpen = false;
        }
        side.text += event.detail.delta ?? "";
        schedulePaint();
      };
      const onThinking = (event) => {
        if (side.thinkStartMs === null) side.thinkStartMs = performance.now();
        side.thinking += event.detail.delta ?? "";
        schedulePaint();
      };
      const onWord = (event) => {
        side.words = event.detail.index + 1;
      };
      const onSpeed = (event) => {
        side.liveWps = event.detail.wordsPerSecond;
        side.liveTps = event.detail.tokensPerSecond;
        schedulePaint();
      };
      const onDone = (event) => {
        detach();
        flushPaint();
        side.words = event.detail.words;
        side.tokens = event.detail.tokens;
        side.firstWordS = event.detail.firstWordSeconds;
        side.totalS = event.detail.seconds;
        side.wps = event.detail.wordsPerSecond;
        side.tps = event.detail.tokensPerSecond;
        side.liveWps = side.wps;
        side.liveTps = side.tps;
        if (typeof event.detail.thinkingSeconds === "number") side.thinkSeconds = event.detail.thinkingSeconds;
        // A stream the engine lost mid-answer ends with failed set: show that, not a clean Done.
        side.status = event.detail.failed ? "failed" : "done";
        resolve();
      };
      const detach = () => {
        engine.removeEventListener("text", onText);
        engine.removeEventListener("thinking", onThinking);
        engine.removeEventListener("word", onWord);
        engine.removeEventListener("speed", onSpeed);
        engine.removeEventListener("done", onDone);
        detachWriting = () => {};
      };
      engine.addEventListener("text", onText);
      engine.addEventListener("thinking", onThinking);
      engine.addEventListener("word", onWord);
      engine.addEventListener("speed", onSpeed);
      engine.addEventListener("done", onDone);
      detachWriting = detach;
      // Each side sends its own setup's system prompt.
      if (!engine.sendPrompt(session.question.text, { thinking: session.options.thinking, system: side.system, maxTokens: LONG_TOKENS + thinkingRoom(session.options.thinking) })) {
        detach();
        side.status = "failed";
        resolve();
      }
    });
  }

  function onProgress(event) {
    const side = session.sides?.[session.activeKey];
    if (!side || cancelled) return;
    side.status = event.detail.direction === "load" ? "loading" : "unloading";
    side.progress = event.detail.progress;
    paint();
  }

  // Arrow keys vote after both answers are in, unless a field has focus.
  function onKey(event) {
    if (session.phase !== "answered" || event.ctrlKey || event.altKey || event.metaKey) return;
    if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) return;
    const choice = CHOICES.find((c) => c.key === event.key);
    if (!choice) return;
    event.preventDefault();
    vote(choice.id);
  }

  function onChange() {
    if (!cancelled) paint();
  }

  engine.addEventListener("progress", onProgress);
  engine.addEventListener("change", onChange);
  document.addEventListener("keydown", onKey);
  paint();
  if (engine.mode !== "sim") loadCatalogue();
  if (engine.mode !== "sim" && !session.votesLoaded) loadVotes();

  // First use: read the question files. An idle round waiting for its question gets one once they
  // land; a round already running, or a question you typed, is left alone.
  if (!bankHasQuestions()) {
    loadBank().then((list) => {
      if (cancelled) return;
      if (list.length === 0) { paint(); return; }
      if (session.phase === "idle" && session.question?.empty && !session.editing) {
        session.question = nextQuestion();
        paint();
      }
    });
  }

  // Leaving the tab stops the work but keeps the round: a finished round stays as it was
  // (answers, stats and vote buttons), and a running one is kept as "stopped" so it can be resumed.
  return () => {
    cancelled = true;
    detachWriting();
    clearTimeout(paintTimer);
    engine.stop();
    engine.removeEventListener("progress", onProgress);
    engine.removeEventListener("change", onChange);
    document.removeEventListener("keydown", onKey);
    if (session.phase === "running") session.phase = "stopped";
  };
}
