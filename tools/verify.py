"""Run every check in the project and print one verdict: python tools/verify.py [--quick]

Order: syntax checks, then every tools/test_*.py and tools/test_*.mjs, then tools/ui_check.mjs (skipped with --quick).
Prints PASS/FAIL per step with the last lines of any failure, then 'VERIFY: PASS' or 'VERIFY: FAIL'. Exit 0 only on PASS.
A failing UI step also names the checks that failed, one line each, and the check that was running when
the whole run failed (see docs/TESTING.md).
Run it before every commit. Standard library only.
"""
import glob
import os
import re
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
QUICK = "--quick" in sys.argv


# tools/ui_check.mjs prints `FAIL <check name>: <message>` per failed check, and
# `ui_check last check started: <name>` when the whole run failed (time limit, startup).
UI_FAILED_RE = re.compile(r"^FAIL ([^:]+):\s*(.*)$")
UI_LAST_RE = re.compile(r"^ui_check last check started:\s*(.+)$")
UI_RUN_LEVEL = ("run", "startup")


def ui_failure_lines(output):
    """One '  failed check: <name>: <first error line>' line per UI check that failed, plus
    '  last check started: <name>' when the run itself failed (no check named its own error).
    """
    lines = []
    for raw in output.splitlines():
        line = raw.strip()
        match = UI_FAILED_RE.match(line)
        if match and match.group(1) not in UI_RUN_LEVEL:
            lines.append("  failed check: %s: %s" % (match.group(1), match.group(2).strip()))
            continue
        match = UI_LAST_RE.match(line)
        if match:
            lines.append("  last check started: %s" % match.group(1).strip())
    return lines


def run(label, cmd, timeout, failure_notes=None):
    t0 = time.time()
    output = ""
    try:
        p = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=timeout, encoding="utf-8", errors="replace", creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        ok = p.returncode == 0
        output = p.stdout + p.stderr
    except subprocess.TimeoutExpired:
        ok, output = False, f"timed out after {timeout}s"
    artifact_dir = os.path.join(ROOT, "data", "test-artifacts", "verify")
    os.makedirs(artifact_dir, exist_ok=True)
    log_name = re.sub(r"[^a-zA-Z0-9_.-]+", "_", label) + ".log"
    with open(os.path.join(artifact_dir, log_name), "w", encoding="utf-8") as log:
        log.write(output)
    tail = output.strip().splitlines()[-12:]
    print(f"{'PASS' if ok else 'FAIL'}  {label} ({time.time() - t0:.1f}s)", flush=True)
    if not ok:
        print("\n".join("      " + line for line in tail), flush=True)
        for line in (failure_notes(output) if failure_notes else []):
            print(line, flush=True)
    return ok


def main():
    results = []
    results.append(run("py_compile server.py + tools", [sys.executable, "-m", "py_compile", "server.py", *sorted(glob.glob("tools/*.py")), *sorted(glob.glob("tools/*.pyw")), *sorted(glob.glob("*.py"))], 60))
    js = sorted(glob.glob("app/js/**/*.js", recursive=True)) + sorted(glob.glob("tools/*.mjs")) + sorted(glob.glob("tools/ui_checks/*.mjs"))
    bad = []
    for f in js:
        p = subprocess.run(["node", "--check", f], cwd=ROOT, capture_output=True, text=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if p.returncode != 0:
            bad.append(f + ": " + (p.stderr.strip().splitlines() or ["?"])[0])
    print(f"{'PASS' if not bad else 'FAIL'}  node --check ({len(js)} files)")
    for b in bad:
        print("      " + b)
    results.append(not bad)
    for f in sorted(glob.glob("tools/test_*.py")):
        results.append(run(f, [sys.executable, f], 240))
    for f in sorted(glob.glob("tools/test_*.mjs")):
        results.append(run(f, ["node", f], 240))
    if not QUICK and os.path.exists(os.path.join(ROOT, "tools", "ui_check.mjs")):
        results.append(run("tools/ui_check.mjs", ["node", "tools/ui_check.mjs"], 660, failure_notes=ui_failure_lines))
    ok = all(results)
    print("VERIFY: " + ("PASS" if ok else "FAIL") + f" ({sum(results)}/{len(results)} steps)")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import verify_lock  # full runs from different folders take turns (see tools/verify_lock.py)
    held = verify_lock.acquire(ROOT)
    try:
        code = main()
    finally:
        if held:
            verify_lock.release()
    sys.exit(code)
