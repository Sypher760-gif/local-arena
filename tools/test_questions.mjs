// Tests for the Local Arena question bank (app/data/questions-hard/*.json): the real benchmark questions
// Arena and Tests both draw from. Run: node tools/test_questions.mjs (no packages, network or ports)
//
// Checks the contract in docs/GRADING.md: six arrays, each with at least 20 questions (the most a
// Tests run takes per type), ids named <slug>-<source>-..., type matching the file, a named public
// source, a known check kind with the fields it needs, a number expected that parses, rule kinds
// from the allowed list, valid difficulties, no duplicate prompts or ids, and 704 questions in all.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "app", "data", "questions-hard");

const FILES = [
  { slug: "logic", type: "Logic", letter: "L" },
  { slug: "math", type: "Math", letter: "M" },
  { slug: "science", type: "Science", letter: "S" },
  { slug: "coding", type: "Coding", letter: "C" },
  { slug: "reading", type: "Reading", letter: "R" },
  { slug: "following", type: "Following instructions", letter: "F" },
];

const MIN_PER_FILE = 20;
const TOTAL = 704;
let total = 0;
const DIFFICULTIES = ["easy", "medium", "hard"];
const CHECK_KINDS = ["number", "exact", "contains", "rules"];
const RULE_KINDS = [
  "maxWords", "minWords", "startsWith", "endsWith", "includes", "excludes",
  "exactLines", "allLower", "allUpper", "validJson",
];
const RULE_NUMBER_KINDS = ["maxWords", "minWords", "exactLines"];
const RULE_VALUE_KINDS = ["startsWith", "endsWith", "includes", "excludes"];

let passed = 0;
let failed = 0;

function ok() {
  passed += 1;
}

function problem(message) {
  failed += 1;
  console.log(`PROBLEM ${message}`);
}

function check(condition, message) {
  if (condition) ok();
  else problem(message);
  return condition;
}

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isStringArray = (value) => Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string" && v.trim() !== "");
const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);
const parseNumber = (value) => Number(String(value).trim());

const idsSeen = new Map();
const promptsSeen = new Map();

function checkRule(where, rule) {
  if (!isPlainObject(rule)) {
    check(false, `${where}: a rule is not an object`);
    return;
  }
  if (!check(RULE_KINDS.includes(rule.kind), `${where}: rule kind "${rule.kind}" is not one of ${RULE_KINDS.join(", ")}`)) return;
  if (RULE_NUMBER_KINDS.includes(rule.kind)) {
    check(Number.isInteger(rule.n) && rule.n > 0, `${where}: rule ${rule.kind} needs a positive integer n (got ${JSON.stringify(rule.n)})`);
  }
  if (RULE_VALUE_KINDS.includes(rule.kind)) {
    check(typeof rule.value === "string" && rule.value.trim() !== "", `${where}: rule ${rule.kind} needs a non-empty string value`);
  }
}

function checkQuestion(where, question, file) {
  if (!isPlainObject(question)) {
    check(false, `${where}: question is not an object`);
    return;
  }

  // id
  const idOk = typeof question.id === "string" && question.id.startsWith(`${file.slug}-`);
  check(idOk, `${where}: id "${question.id}" does not start with "${file.slug}-"`);
  check(typeof question.source === "string" && question.source.trim() !== "", `${where}: no public source named`);
  if (idOk) {
    if (idsSeen.has(question.id)) problem(`${where}: id "${question.id}" is already used in ${idsSeen.get(question.id)}`);
    else {
      idsSeen.set(question.id, file.slug);
      ok();
    }
  }

  // type
  check(question.type === file.type, `${where}: type "${question.type}" should be "${file.type}"`);

  // prompt
  const promptOk = typeof question.prompt === "string" && question.prompt.trim() !== "";
  check(promptOk, `${where}: prompt is missing or empty`);
  if (promptOk) {
    const key = question.prompt.trim();
    if (promptsSeen.has(key)) problem(`${where}: prompt duplicates ${promptsSeen.get(key)}`);
    else {
      promptsSeen.set(key, question.id);
      ok();
    }
  }

  // difficulty
  check(DIFFICULTIES.includes(question.difficulty), `${where}: difficulty "${question.difficulty}" is not one of ${DIFFICULTIES.join(", ")}`);

  // check kind and its fields
  if (!check(CHECK_KINDS.includes(question.check), `${where}: check "${question.check}" is not one of ${CHECK_KINDS.join(", ")}`)) return;

  if (question.check === "number") {
    check(typeof question.expected === "string", `${where}: number check needs expected as a string`);
    const parsed = question.expected === undefined ? NaN : parseNumber(question.expected);
    check(Number.isFinite(parsed), `${where}: number expected "${question.expected}" does not parse as a number`);
    if (question.tolerance !== undefined) {
      check(isFiniteNumber(question.tolerance) && question.tolerance >= 0, `${where}: tolerance must be a number zero or more`);
    }
  } else if (question.check === "exact") {
    check(typeof question.expected === "string" && question.expected.trim() !== "", `${where}: exact check needs a non-empty string expected`);
    if (question.alt !== undefined) {
      check(Array.isArray(question.alt) && question.alt.every((v) => typeof v === "string"), `${where}: alt must be an array of strings`);
    }
  } else if (question.check === "contains") {
    const hasAll = question.all !== undefined;
    const hasAny = question.any !== undefined;
    check(hasAll || hasAny, `${where}: contains check needs an all array or an any array`);
    if (hasAll) check(isStringArray(question.all), `${where}: all must be a non-empty array of strings`);
    if (hasAny) check(isStringArray(question.any), `${where}: any must be a non-empty array of strings`);
  } else if (question.check === "rules") {
    const rulesOk = check(Array.isArray(question.rules) && question.rules.length > 0, `${where}: rules check needs a non-empty rules array`);
    if (rulesOk) question.rules.forEach((rule, i) => checkRule(`${where} rule ${i + 1}`, rule));
  }
}

function checkFile(file) {
  let text;
  try {
    text = readFileSync(path.join(DIR, `${file.slug}.json`), "utf8");
  } catch (error) {
    check(false, `${file.slug}.json cannot be read (${error.code ?? error.message})`);
    return;
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    check(false, `${file.slug}.json is not valid JSON (${error.message})`);
    return;
  }

  if (!check(Array.isArray(data), `${file.slug}.json is not a JSON array`)) return;
  check(data.length >= MIN_PER_FILE, `${file.slug}.json has ${data.length} questions, need at least ${MIN_PER_FILE}`);
  total += data.length;

  data.forEach((question, i) => checkQuestion(`${file.slug}[${i}]`, question, file));
}

for (const file of FILES) checkFile(file);
check(total === TOTAL, `the bank holds ${total} questions, want ${TOTAL}`);

console.log(`test_questions: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
