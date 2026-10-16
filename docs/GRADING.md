# Question bank and grading

## Question files

`app/data/questions-hard/<slug>.json`, one file per type, built by `tools/build_hard_bank.py` from public benchmarks. Slugs: `logic`, `math`, `science`, `coding`, `reading`, `following`. Each file is a JSON array of questions. This is the only question bank: Arena and Tests both draw from it (704 questions).

```json
{ "id": "math-gsm8k-test-0000", "type": "Math", "prompt": "...", "check": "number", "expected": "18", "source": "GSM8K", "difficulty": "easy" }
```

- `id`: the slug, the source and a number. `source`: the public benchmark it came from.
- `type`: exactly `Logic`, `Math`, `Science`, `Coding`, `Reading`, `Following instructions`.
- `prompt`: what the model is sent. Self-contained. For Reading it holds the short passage, then the question. Ask for a short answer ("Reply with just the number.") so grading is fair.
- `check`: how the answer is judged. One of:
  - `number`: `expected` is a number as a string. Optional `tolerance` (default 0).
  - `exact`: `expected` is a string. Optional `alt`: array of other accepted strings.
  - `contains`: `all` array (every term must appear) and/or `any` array (at least one must appear).
  - `rules`: `rules` array, every rule must pass. Used for Following instructions.
- `difficulty`: `easy`, `medium` or `hard`.

Rule objects: `{"kind":"maxWords","n":20}`, `minWords`, `startsWith` (`value`), `endsWith` (`value`), `includes` (`value`), `excludes` (`value`), `exactLines` (`n`), `allLower`, `allUpper`, `validJson`. Matching ignores case except `allLower`/`allUpper`.

## Grader

`app/js/grader.js` exports `grade(question, reply)` returning `{ correct: true | false | null, reason: string }`.

1. Clean the reply: drop `<think>...</think>` blocks and anything before a lone `</think>`. Trim.
2. Find the answer text: if the reply has a line starting `Answer:` or `Final answer:` (any case), use what follows the last one. Otherwise use the whole cleaned reply.
3. Judge by `check`:
   - `number`: take the last number in the answer text (commas and a leading `$` or `%` ignored, `1,234.5` is 1234.5, fractions like `3/4` are read as 0.75). Correct if within `tolerance` of `expected`.
   - `exact`: normalise both sides (lower case, trim, drop quotes and trailing punctuation, collapse spaces). Correct if the answer text equals `expected` or any `alt`, or its last non-empty line does.
   - `contains`: normalise, then check `all` and `any`.
   - `rules`: run every rule on the cleaned reply (not the answer text).
4. No `check` and no `expected` means the question cannot be graded: return `{ correct: null, reason: "Not graded: no expected answer." }`. Never guess.
5. `reason` is one plain sentence a person can read, for example `Expected 391, the reply says 381.`
6. Never throws. Non-string replies count as empty and return `correct: false`.

## Attribution

Generated rows preserve source_url, licence, split, source_row, edits and notes. See THIRD_PARTY_NOTICES.md. Saved run details retain full question and answer text; only card previews are shortened.
