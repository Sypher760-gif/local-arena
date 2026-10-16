// Answer grader for the Local Arena tests screen. A pure ES module: no imports, no build step, the
// same code runs in the browser and in Node. grade(question, reply) returns
// { correct: true | false | null, reason: string } and never throws, even on odd input.
// cleanReply(reply) is exported so the tests can check the reply cleaning on its own.

const OPEN_TAG = "<think";
const CLOSE_TAG = "</think>";

// A number can carry commas, a decimal part, and may be written as a fraction such as 3/4.
const NUMBER_RE = /-?\d[\d,]*(?:\.\d+)?(?:\s*\/\s*\d[\d,]*(?:\.\d+)?)?/g;

function notGraded(reason) {
  return { correct: null, reason: reason || "Not graded: no expected answer." };
}

// Drop complete <think>...</think> blocks, then drop anything before a lone </think>.
// Scans with indexOf instead of a lazy regex so a huge reply stays fast and never throws.
function dropThinkBlocks(text) {
  const lower = text.toLowerCase();
  let out = "";
  let i = 0;
  while (i < text.length) {
    const open = lower.indexOf(OPEN_TAG, i);
    if (open === -1) { out += text.slice(i); break; }
    const after = lower.charAt(open + OPEN_TAG.length);
    if (after !== ">" && after !== " " && after !== "\t" && after !== "\n" && after !== "\r") {
      out += text.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    const close = lower.indexOf(CLOSE_TAG, open + OPEN_TAG.length);
    if (close === -1) { out += text.slice(open); break; }
    out += text.slice(i, open);
    i = close + CLOSE_TAG.length;
  }
  return out;
}

function dropBeforeLoneClose(text) {
  const idx = text.toLowerCase().lastIndexOf(CLOSE_TAG);
  return idx === -1 ? text : text.slice(idx + CLOSE_TAG.length);
}

export function cleanReply(reply) {
  if (typeof reply !== "string") return "";
  return dropBeforeLoneClose(dropThinkBlocks(reply)).trim();
}

// Turn one number token into a value. Comma grouping is ignored and a/b is read as a fraction.
function parseNumber(token) {
  if (token.includes("/")) {
    const parts = token.split("/");
    const top = Number(parts[0].replace(/,/g, ""));
    const bottom = Number(parts[1].replace(/,/g, ""));
    if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom === 0) return NaN;
    return top / bottom;
  }
  return Number(token.replace(/,/g, ""));
}

// The last readable number in the text, or null when there is none.
function lastNumber(text) {
  const matches = text.match(NUMBER_RE);
  if (!matches) return null;
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const value = parseNumber(matches[i]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function parseExpected(raw) {
  return parseNumber(String(raw).replace(/[$,%\s]/g, ""));
}

// Lower case, collapse spaces, drop surrounding quotes and trailing punctuation.
function normalise(value) {
  let text = String(value == null ? "" : value).toLowerCase().replace(/\s+/g, " ").trim();
  let before;
  do {
    before = text;
    text = text.replace(/^["'`\u201c\u201d\u2018\u2019\s]+/, "").replace(/["'`\u201c\u201d\u2018\u2019\s]+$/, "");
    text = text.replace(/[.,;:!?]+$/, "").trim();
  } while (text !== before);
  return text;
}

function lastNonEmptyLine(text) {
  const lines = String(text).split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].trim() !== "") return lines[i];
  }
  return "";
}

// If a line starts with "Answer:" or "Final answer:" (any case), use what follows the last one.
function answerPart(cleaned) {
  let answer = null;
  for (const line of cleaned.split(/\r?\n/)) {
    const trimmed = line.trim();
    const lower = trimmed.toLowerCase();
    if (lower.startsWith("final answer:")) answer = trimmed.slice("final answer:".length).trim();
    else if (lower.startsWith("answer:")) answer = trimmed.slice("answer:".length).trim();
  }
  return answer === null ? cleaned : answer;
}

function judgeNumber(question, answerText) {
  if (question.expected === undefined || question.expected === null || String(question.expected).trim() === "") {
    return notGraded();
  }
  const expected = parseExpected(question.expected);
  if (!Number.isFinite(expected)) return notGraded();
  const rawTolerance = Number(question.tolerance);
  const tolerance = Number.isFinite(rawTolerance) && rawTolerance >= 0 ? rawTolerance : 0;
  const value = lastNumber(answerText);
  if (value === null) {
    return { correct: false, reason: `Expected ${question.expected}, the reply has no number.` };
  }
  if (Math.abs(value - expected) <= tolerance) {
    return { correct: true, reason: `Correct: the reply says ${value}, within ${tolerance} of ${expected}.` };
  }
  return { correct: false, reason: `Expected ${question.expected}, the reply says ${value}.` };
}

function judgeExact(question, answerText) {
  if (question.expected === undefined || question.expected === null) return notGraded();
  const targets = [String(question.expected)];
  if (Array.isArray(question.alt)) for (const alt of question.alt) targets.push(String(alt));
  const wanted = targets.map(normalise);
  const whole = normalise(answerText);
  const tail = normalise(lastNonEmptyLine(answerText));
  if (wanted.includes(whole) || wanted.includes(tail)) {
    return { correct: true, reason: "Correct: the reply matches the expected answer." };
  }
  return { correct: false, reason: `Expected "${question.expected}", the reply says "${answerText}".` };
}

function judgeContains(question, answerText) {
  const text = normalise(answerText);
  const all = Array.isArray(question.all) ? question.all.map((term) => normalise(term)) : [];
  const any = Array.isArray(question.any) ? question.any.map((term) => normalise(term)) : [];
  for (const term of all) {
    if (!text.includes(term)) return { correct: false, reason: `The reply is missing "${term}".` };
  }
  if (any.length > 0 && !any.some((term) => text.includes(term))) {
    return { correct: false, reason: `The reply does not include any of: ${any.join(", ")}.` };
  }
  return { correct: true, reason: "Correct: the reply contains the expected terms." };
}

function countWords(text) {
  return text.split(/\s+/).filter((word) => word !== "").length;
}

function countLines(text) {
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

function stripFences(text) {
  const match = String(text).match(/```[a-zA-Z]*\s*\n?([\s\S]*?)```/);
  return match ? match[1] : text;
}

function isJson(text) {
  const body = stripFences(text).trim();
  if (body === "") return false;
  try { JSON.parse(body); return true; } catch { return false; }
}

function rulePass() { return { ok: true }; }
function ruleFail(kind, detail) { return { ok: false, reason: `Rule ${kind} failed: ${detail}.` }; }

function runRule(rule, reply) {
  if (!rule || typeof rule !== "object") return ruleFail("rule", "the rule was not readable");
  const kind = rule.kind;
  const lower = reply.toLowerCase();
  const value = rule.value == null ? "" : String(rule.value);
  const valueLower = value.toLowerCase();
  switch (kind) {
    case "maxWords": {
      const n = Number(rule.n);
      const count = countWords(reply);
      return count <= n ? rulePass() : ruleFail(kind, `the reply has ${count} words, the limit is ${n}`);
    }
    case "minWords": {
      const n = Number(rule.n);
      const count = countWords(reply);
      return count >= n ? rulePass() : ruleFail(kind, `the reply has ${count} words, at least ${n} are needed`);
    }
    case "startsWith":
      return lower.startsWith(valueLower) ? rulePass() : ruleFail(kind, `the reply does not start with "${value}"`);
    case "endsWith":
      return lower.endsWith(valueLower) ? rulePass() : ruleFail(kind, `the reply does not end with "${value}"`);
    case "includes":
      return lower.includes(valueLower) ? rulePass() : ruleFail(kind, `the reply does not include "${value}"`);
    case "excludes":
      return lower.includes(valueLower) ? ruleFail(kind, `the reply includes "${value}"`) : rulePass();
    case "exactLines": {
      const n = Number(rule.n);
      const count = countLines(reply);
      return count === n ? rulePass() : ruleFail(kind, `the reply has ${count} lines, exactly ${n} are needed`);
    }
    case "allLower":
      return /[A-Z]/.test(reply) ? ruleFail(kind, "the reply has an uppercase letter") : rulePass();
    case "allUpper":
      return /[a-z]/.test(reply) ? ruleFail(kind, "the reply has a lowercase letter") : rulePass();
    case "validJson":
      return isJson(reply) ? rulePass() : ruleFail(kind, "the reply is not valid JSON");
    default:
      return ruleFail(kind, "the rule kind is unknown");
  }
}

function judgeRules(question, reply) {
  const rules = Array.isArray(question.rules) ? question.rules : [];
  for (const rule of rules) {
    const result = runRule(rule, reply);
    if (!result.ok) return { correct: false, reason: result.reason };
  }
  return { correct: true, reason: "Correct: the reply follows every rule." };
}

export function grade(question, reply) {
  const q = question && typeof question === "object" ? question : {};
  const check = typeof q.check === "string" ? q.check : "";
  if (!check && (q.expected === undefined || q.expected === null)) return notGraded();
  if (typeof reply !== "string") return { correct: false, reason: "The reply is empty." };
  const cleaned = cleanReply(reply);
  const answerText = answerPart(cleaned);
  switch (check) {
    case "number": return judgeNumber(q, answerText);
    case "exact": return judgeExact(q, answerText);
    case "contains": return judgeContains(q, answerText);
    case "rules": return judgeRules(q, cleaned);
    default: return notGraded(`Not graded: no readable check for "${check}".`);
  }
}
