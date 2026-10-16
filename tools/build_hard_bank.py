"""Cut the collected question pool into the hard set the Tests page can load.

Run: python tools/build_hard_bank.py
Writes app/data/questions-hard/<type>.json: the one question bank Arena and Tests use.
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CANDIDATES = os.path.join(ROOT, "docs", "question-research", "candidates")
OUT = os.path.join(ROOT, "app", "data", "questions-hard")

# The survey's cut. Noisy or mixed-licence science stays out. Code-writing stays out.
KEEP = {
    "logic": {"BBH", "FOLIO", "StrategyQA", "CommonsenseQA"},
    "math": {"GSM8K", "MATH-500", "Omni-MATH", "TheoremQA"},
    "science": {"ARC-Challenge", "MMLU-Pro", "MMLU-Redux"},
    "coding": {"CRUXEval"},
    "reading": {"DROP", "SQuAD 2.0", "HotpotQA", "BoolQ"},
    "following": {"IFEval"},
}
COMMONSENSE_CAP = 8
SLUGS = ["logic", "math", "science", "coding", "reading", "following"]
CHECKS = {"number", "exact", "contains", "rules"}


def difficulty_of(row):
    if row.get("needs_long_reasoning") or row.get("bench_difficulty") == "hard":
        return "hard"
    level = row.get("bench_difficulty")
    return level if level in ("easy", "medium") else "medium"


def to_question(row):
    question = {
        "id": row["cand_id"],
        "type": row["type"],
        "prompt": row["prompt"],
        "check": row["check"],
        "difficulty": difficulty_of(row),
        "source": row.get("source") or "",
    }
    if row.get("expected") not in (None, ""):
        question["expected"] = row["expected"]
    if row.get("alt"):
        question["alt"] = row["alt"]
    if row.get("rules"):
        question["rules"] = row["rules"]
    for key in ("source_url", "licence", "split", "source_row", "edits", "notes", "source_difficulty", "all", "any"):
        if key in row:
            question[key] = row[key]
    return question


def usable(row):
    if not isinstance(row, dict):
        return False
    if row.get("check") not in CHECKS:
        return False
    if not row.get("cand_id") or not row.get("prompt"):
        return False
    if row["check"] == "rules":
        return bool(row.get("rules"))
    return row.get("expected") not in (None, "")


def select(slug, rows):
    wanted = KEEP[slug]
    kept = [row for row in rows if usable(row) and row.get("source") in wanted]
    if slug != "logic":
        return kept
    other = [row for row in kept if row.get("source") != "CommonsenseQA"]
    common = [row for row in kept if row.get("source") == "CommonsenseQA"][:COMMONSENSE_CAP]
    return other + common


def load_rows(folder, slug):
    path = os.path.join(folder, f"{slug}.jsonl")
    rows = []
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def build(folder=CANDIDATES):
    return {slug: [to_question(row) for row in select(slug, load_rows(folder, slug))] for slug in SLUGS}


def main():
    banks = build()
    os.makedirs(OUT, exist_ok=True)
    for slug, questions in banks.items():
        path = os.path.join(OUT, f"{slug}.json")
        with open(path, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(questions, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        print(f"{slug}: {len(questions)}")


if __name__ == "__main__":
    main()
