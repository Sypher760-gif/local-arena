// Tests for app/js/grader.js (the Local Arena answer grader).
// Run: node tools/test_grader.mjs
// No ports, no servers, no packages: only the module and Node itself.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GRADER_JS = pathToFileURL(path.join(ROOT, "app", "js", "grader.js")).href;
const { grade, cleanReply } = await import(GRADER_JS);

let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
  if (ok) { passed += 1; return; }
  failed += 1;
  console.log(`FAIL ${name}${detail ? ` (${detail})` : ""}`);
}

// Assert the correct flag, and that a reason sentence comes back.
function correct(name, question, reply, want) {
  let got;
  try { got = grade(question, reply); } catch (err) { check(name, false, `threw: ${err && err.message}`); return null; }
  const okType = got && typeof got.reason === "string" && got.reason.length > 0;
  check(name, got && got.correct === want && okType, `correct=${got && String(got.correct)} want=${String(want)} reason=${got && got.reason}`);
  return got;
}

// Assert the reason sentence mentions a fragment.
function reason(name, question, reply, fragment) {
  const got = grade(question, reply);
  check(name, got && typeof got.reason === "string" && got.reason.toLowerCase().includes(fragment.toLowerCase()),
    got && got.reason);
}

// Assert the call does not throw and returns a bool-or-null correct flag.
function noThrow(name, question, reply) {
  let got;
  try { got = grade(question, reply); } catch (err) { check(name, false, `threw: ${err && err.message}`); return; }
  check(name, got && typeof got === "object" && (got.correct === true || got.correct === false || got.correct === null)
    && typeof got.reason === "string", JSON.stringify(got));
}

// ---- cleanReply ----
check("cleanReply drops a think block", cleanReply("<think>hidden</think>Hello") === "Hello", cleanReply("<think>hidden</think>Hello"));
check("cleanReply drops a multi-line think block", cleanReply("<think>a\nb</think>\nThe answer is 4.") === "The answer is 4.", cleanReply("<think>a\nb</think>\nThe answer is 4."));
check("cleanReply drops text before a lone close", cleanReply("reasoning here</think>42") === "42", cleanReply("reasoning here</think>42"));
check("cleanReply keeps text around a closed block", cleanReply("a<think>b</think>c") === "ac", cleanReply("a<think>b</think>c"));
check("cleanReply is case-insensitive on tags", cleanReply("<THINK>x</THINK>y") === "y", cleanReply("<THINK>x</THINK>y"));
check("cleanReply trims whitespace", cleanReply("   padded   ") === "padded", cleanReply("   padded   "));
check("cleanReply returns empty for null", cleanReply(null) === "");
check("cleanReply returns empty for undefined", cleanReply(undefined) === "");
check("cleanReply returns empty for a number", cleanReply(123) === "");
check("cleanReply leaves plain text alone", cleanReply("no tags here") === "no tags here");

// ---- number: basics ----
correct("number plain", { check: "number", expected: "391" }, "391", true);
correct("number inside a sentence", { check: "number", expected: "391" }, "The answer is 391.", true);
correct("number with trailing punctuation", { check: "number", expected: "391" }, "391!", true);
correct("number uses the last value", { check: "number", expected: "391" }, "I first got 380, but the answer is 391", true);
correct("number last value wins when wrong", { check: "number", expected: "391" }, "391 but actually 380", false);
correct("number must not accept 391 for 39", { check: "number", expected: "39" }, "391", false);
correct("number must not accept 39 for 391", { check: "number", expected: "391" }, "39", false);
correct("number ignores an early right value", { check: "number", expected: "5" }, "The 5 apples cost 50", false);
correct("number with commas", { check: "number", expected: "1234.5" }, "1,234.5", true);
correct("number with a dollar sign", { check: "number", expected: "12" }, "It costs $12", true);
correct("number with a percent sign", { check: "number", expected: "50" }, "50%", true);
correct("number negative", { check: "number", expected: "-7" }, "-7 degrees", true);
correct("number negative inside a sentence", { check: "number", expected: "-7" }, "the temperature is -7 today", true);
correct("number decimal", { check: "number", expected: "3.14" }, "pi is about 3.14", true);
correct("number fraction as a decimal", { check: "number", expected: "0.75" }, "3/4", true);
correct("number half as a fraction", { check: "number", expected: "0.5" }, "1/2", true);
correct("number expected as a fraction", { check: "number", expected: "3/4" }, "0.75", true);
correct("number expected with a comma", { check: "number", expected: "1,234" }, "1234", true);
correct("number wrong value", { check: "number", expected: "391" }, "The answer is 381.", false);
correct("number missing number", { check: "number", expected: "7" }, "I have no idea", false);
reason("number missing number reason", { check: "number", expected: "7" }, "I have no idea", "no number");
correct("number empty reply", { check: "number", expected: "5" }, "", false);
reason("number wrong reason names expected", { check: "number", expected: "391" }, "381", "Expected 391");

// ---- number: tolerance edges ----
correct("number inside tolerance", { check: "number", expected: "100", tolerance: 0.5 }, "100.4", true);
correct("number exactly on tolerance edge", { check: "number", expected: "100", tolerance: 0.5 }, "100.5", true);
correct("number just over tolerance edge", { check: "number", expected: "100", tolerance: 0.5 }, "100.6", false);
correct("number below tolerance edge", { check: "number", expected: "100", tolerance: 0.5 }, "99.5", true);
correct("number default tolerance rejects drift", { check: "number", expected: "100" }, "101", false);

// ---- answer lines ----
correct("Answer line is used", { check: "number", expected: "391" }, "Some reasoning first.\nAnswer: 391", true);
correct("Final answer line wins over Answer line", { check: "number", expected: "391" }, "Answer: 380\nFinal answer: 391", true);
correct("Answer line any case", { check: "number", expected: "8" }, "answer: 8", true);
correct("Answer line without a space", { check: "exact", expected: "Paris" }, "answer:Paris", true);
correct("Rules run on the whole cleaned reply", { check: "rules", rules: [{ kind: "startsWith", value: "OK" }] }, "<think>no</think>OK fine", true);

// ---- exact ----
correct("exact plain", { check: "exact", expected: "Paris" }, "Paris", true);
correct("exact ignores case", { check: "exact", expected: "Paris" }, "paris", true);
correct("exact trims spaces", { check: "exact", expected: "Paris" }, "  Paris  ", true);
correct("exact drops trailing punctuation", { check: "exact", expected: "Paris" }, "Paris.", true);
correct("exact drops surrounding quotes", { check: "exact", expected: "Paris" }, "\"Paris\"", true);
correct("exact drops a quote and a period", { check: "exact", expected: "Paris" }, "\"Paris\".", true);
correct("exact rejects a longer sentence", { check: "exact", expected: "Paris" }, "The capital is Paris", false);
correct("exact uses the answer line", { check: "exact", expected: "Paris" }, "Long reasoning.\nAnswer: Paris", true);
correct("exact uses the last non-empty line", { check: "exact", expected: "Paris" }, "some text\nParis", true);
correct("exact alt is accepted", { check: "exact", expected: "Paris", alt: ["FR", "the city of light"] }, "FR", true);
correct("exact alt on the last line", { check: "exact", expected: "Paris", alt: ["FR"] }, "the capital\nFR", true);
correct("exact collapses inner spaces", { check: "exact", expected: "New York" }, "new   york", true);
correct("exact wrong answer", { check: "exact", expected: "Paris" }, "London", false);
correct("exact extra word fails", { check: "exact", expected: "Paris" }, "Paris, France", false);

// ---- contains ----
correct("contains all terms", { check: "contains", all: ["cat", "hat"] }, "the cat sat on the hat", true);
correct("contains all missing one", { check: "contains", all: ["cat", "hat"] }, "the cat sat", false);
correct("contains any term", { check: "contains", any: ["dog", "cat"] }, "I have a cat", true);
correct("contains no any term", { check: "contains", any: ["dog", "cat"] }, "I have a fish", false);
correct("contains all and any together", { check: "contains", all: ["red", "blue"], any: ["circle", "square"] }, "a red blue circle", true);
correct("contains all passes but any fails", { check: "contains", all: ["red", "blue"], any: ["circle", "square"] }, "a red blue", false);
correct("contains any passes but all fails", { check: "contains", all: ["red", "blue"], any: ["circle"] }, "a red circle", false);
correct("contains ignores case", { check: "contains", all: ["Cat"] }, "the CAT sat", true);
reason("contains missing term reason", { check: "contains", all: ["hat"] }, "the cat sat", "hat");

// ---- rules: maxWords / minWords ----
correct("maxWords pass", { check: "rules", rules: [{ kind: "maxWords", n: 3 }] }, "one two three", true);
correct("maxWords fail", { check: "rules", rules: [{ kind: "maxWords", n: 3 }] }, "one two three four", false);
correct("minWords pass", { check: "rules", rules: [{ kind: "minWords", n: 2 }] }, "hi there", true);
correct("minWords fail", { check: "rules", rules: [{ kind: "minWords", n: 2 }] }, "hi", false);
correct("maxWords ignores extra spacing", { check: "rules", rules: [{ kind: "maxWords", n: 2 }] }, "one    two", true);

// ---- rules: startsWith / endsWith / includes / excludes ----
correct("startsWith pass", { check: "rules", rules: [{ kind: "startsWith", value: "Hello" }] }, "Hello world", true);
correct("startsWith fail", { check: "rules", rules: [{ kind: "startsWith", value: "Hello" }] }, "world Hello", false);
correct("startsWith ignores case", { check: "rules", rules: [{ kind: "startsWith", value: "hello" }] }, "Hello there", true);
correct("endsWith pass", { check: "rules", rules: [{ kind: "endsWith", value: "done" }] }, "all done", true);
correct("endsWith fail", { check: "rules", rules: [{ kind: "endsWith", value: "done" }] }, "done already", false);
correct("includes pass", { check: "rules", rules: [{ kind: "includes", value: "json" }] }, "the JSON data", true);
correct("includes fail", { check: "rules", rules: [{ kind: "includes", value: "json" }] }, "xml data", false);
correct("excludes pass", { check: "rules", rules: [{ kind: "excludes", value: "banana" }] }, "I like apples", true);
correct("excludes fail", { check: "rules", rules: [{ kind: "excludes", value: "banana" }] }, "I like banana", false);

// ---- rules: exactLines ----
correct("exactLines pass", { check: "rules", rules: [{ kind: "exactLines", n: 2 }] }, "line one\nline two", true);
correct("exactLines fail", { check: "rules", rules: [{ kind: "exactLines", n: 2 }] }, "only one line", false);
correct("exactLines ignores a trailing newline", { check: "rules", rules: [{ kind: "exactLines", n: 2 }] }, "a\nb\n", true);
correct("exactLines three", { check: "rules", rules: [{ kind: "exactLines", n: 3 }] }, "a\nb\nc", true);

// ---- rules: allLower / allUpper ----
correct("allLower pass", { check: "rules", rules: [{ kind: "allLower" }] }, "all lowercase here", true);
correct("allLower fail", { check: "rules", rules: [{ kind: "allLower" }] }, "Has A Capital", false);
correct("allLower is case-sensitive", { check: "rules", rules: [{ kind: "allLower" }] }, "no capitals", true);
correct("allUpper pass", { check: "rules", rules: [{ kind: "allUpper" }] }, "ALL UPPER", true);
correct("allUpper fail", { check: "rules", rules: [{ kind: "allUpper" }] }, "Mixed case", false);

// ---- rules: validJson ----
correct("validJson bare object", { check: "rules", rules: [{ kind: "validJson" }] }, "{\"a\": 1}", true);
correct("validJson with a json fence", { check: "rules", rules: [{ kind: "validJson" }] }, "```json\n{\"a\": 1}\n```", true);
correct("validJson with a bare fence", { check: "rules", rules: [{ kind: "validJson" }] }, "```\n[1, 2, 3]\n```", true);
correct("validJson with prose around a fence", { check: "rules", rules: [{ kind: "validJson" }] }, "Here it is:\n```json\n{\"ok\": true}\n```", true);
correct("validJson fail", { check: "rules", rules: [{ kind: "validJson" }] }, "not json at all", false);
correct("validJson rejects empty reply", { check: "rules", rules: [{ kind: "validJson" }] }, "", false);

// ---- rules: multiple rules together ----
correct("all rules pass", { check: "rules", rules: [{ kind: "maxWords", n: 5 }, { kind: "startsWith", value: "OK" }] }, "OK this is fine", true);
correct("one failing rule fails the set", { check: "rules", rules: [{ kind: "maxWords", n: 5 }, { kind: "startsWith", value: "NO" }] }, "OK this is fine", false);
reason("rule fail reason names the rule", { check: "rules", rules: [{ kind: "maxWords", n: 1 }] }, "too many words", "Rule maxWords failed");

// ---- missing check / expected ----
correct("missing check and expected is null", {}, "391", null);
correct("missing everything is null", { id: "M-01", type: "Math", prompt: "?" }, "391", null);
correct("expected present but no check is null", { expected: "391" }, "391", null);
correct("unknown check is null", { check: "vibes", expected: "391" }, "391", null);
correct("number without expected is null", { check: "number" }, "391", null);
correct("exact without expected is null", { check: "exact" }, "Paris", null);

// ---- odd input never throws ----
correct("empty reply with number check", { check: "number", expected: "1" }, "", false);
correct("non-string number reply", { check: "number", expected: "1" }, 12345, false);
correct("null reply", { check: "exact", expected: "x" }, null, false);
correct("object reply", { check: "contains", all: ["x"] }, { a: 1 }, false);
correct("undefined reply", { check: "rules", rules: [{ kind: "maxWords", n: 2 }] }, undefined, false);
noThrow("undefined question and reply", undefined, undefined);
noThrow("null question", null, "hello");
noThrow("numeric question", 42, "hello");
noThrow("rules with a null rule", { check: "rules", rules: [null] }, "hello");
noThrow("rules with a non-array rules field", { check: "rules", rules: "nope" }, "hello");
noThrow("tolerance as a string", { check: "number", expected: "5", tolerance: "1" }, "5", true);
noThrow("huge plain reply", { check: "number", expected: "5" }, "a".repeat(200000), false);
noThrow("huge reply full of open think tags", { check: "number", expected: "5" }, "<think>".repeat(20000), false);
noThrow("huge reply with a real answer", { check: "number", expected: "5" }, `${"x".repeat(100000)}\n${"<think>no</think>".repeat(1000)}Answer: 5`, true);
noThrow("question with a huge expected", { check: "exact", expected: "y".repeat(50000) }, "y".repeat(50000), true);

console.log(`test_grader: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
