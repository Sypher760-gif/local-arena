"""The hard-question cut keeps the survey's sources and a shape the grader can mark."""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import build_hard_bank as bank

failures = 0


def check(name, ok, detail=""):
    global failures
    if not ok:
        failures += 1
    print(("PASS" if ok else "FAIL") + " " + name + ((" (" + detail + ")") if detail else ""))


built = bank.build()
check("six files", set(built) == set(bank.SLUGS))
check("coding is only code-output questions", all(q["source"] == "CRUXEval" for q in built["coding"]), str(len(built["coding"])))
check("science skips the noisy sets", all(q["source"] in bank.KEEP["science"] for q in built["science"]))
check("only a few common-sense checks", sum(1 for q in built["logic"] if q["source"] == "CommonsenseQA") == 8)
check("math keeps the four sources", {q["source"] for q in built["math"]} == bank.KEEP["math"])
check("every question can be graded", all(q.get("check") in bank.CHECKS and q.get("prompt") and q.get("id") for rows in built.values() for q in rows))
check("a long math question is marked hard", any(q["difficulty"] == "hard" and q["source"] == "MATH-500" for q in built["math"]))
check("instruction questions carry rules", all(q.get("rules") for q in built["following"]))

if failures:
    print("FAIL %s" % failures)
    sys.exit(1)
print("PASS")
