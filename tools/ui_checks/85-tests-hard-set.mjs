// The Tests screen has one question set: the real benchmark questions (the same bank Arena uses).
// No set chooser is shown, it starts at 10 of each type (60 in total), and the files it reads are the
// benchmark ones.
export const name = "85-tests-hard-set";

const START = ".setup-start";

export async function run(t) {
  await t.open("tests");
  await t.waitFor(`document.querySelector("${START}")?.textContent.includes("60 questions")`, 15000);
  t.assert(await t.count(".setup-sets") === 0, "a question set chooser is still shown");
  const count = await t.eval(`document.querySelector(".setup-type .setup-count").value`);
  t.assert(count === "10", `benchmark count is ${count}, want 10`);
  const benchQuestions = await t.eval(`fetch("data/questions-hard/logic.json").then((r) => r.json()).then((rows) => rows.length)`);
  t.assert(benchQuestions === 128, `the benchmark logic file has ${benchQuestions} questions, want 128`);
}
