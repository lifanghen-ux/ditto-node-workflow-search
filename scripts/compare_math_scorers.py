"""Offline, search-only scorer diagnostic; never sends model requests."""
import argparse
import concurrent.futures
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def boundaries():
    return [
        ("fraction-decimal", r"\boxed{\frac{1}{2}}", "0.5", 1),
        ("fraction-latex", r"\boxed{\frac{1}{2}}", r"\dfrac{2}{4}", 1),
        ("equivalent-root", r"\boxed{\sqrt{2}}", r"\sqrt{8}/2", 1),
        ("numeric-wrong", r"\boxed{7}", r"\boxed{8}", 0),
        ("empty", r"\boxed{7}", "", 0),
        ("non-answer", r"\boxed{7}", "I cannot solve this problem.", 0),
        ("malformed-box", r"\boxed{7}", r"\boxed{", 0),
        ("final-box-wrong", r"\boxed{7}", r"First \boxed{7}; final \boxed{8}", 0),
        ("plain-integer", r"\boxed{7}", "7", 1),
        ("signed", r"\boxed{-2}", "-2", 1),
        ("fraction-wrong", r"\boxed{\frac{1}{2}}", r"\boxed{\frac{1}{3}}", 0),
        ("alphabetic-preprocess", r"\boxed{\text{east}}", "east", 1),
        ("alphabetic-wrong", r"\boxed{\text{east}}", "west", 0),
        ("bare-latex-preprocess", r"\boxed{\frac{3}{4}}", r"\frac{3}{4}", 1),
        ("boxed-nested", r"\boxed{\frac{1}{\sqrt{2}}}", r"\boxed{\frac{\sqrt{2}}{2}}", 1),
    ]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--search", type=Path, required=True)
    parser.add_argument("--converted-search", type=Path, required=True)
    parser.add_argument("--legacy-python", required=True)
    parser.add_argument("--aflow-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    repository = Path(__file__).resolve().parents[1]
    original = [json.loads(line) for line in args.search.read_text(encoding="utf-8-sig").splitlines() if line.strip()]
    converted = [json.loads(line) for line in args.converted_search.read_text(encoding="utf-8-sig").splitlines() if line.strip()]
    assert len(original) == len(converted) == 119
    assert all(a["problem"] == b["prompt"] and a["solution"] == b["answer"] for a, b in zip(original, converted))
    corpus = [{"id": f"gold-self-{index + 1:03}", "kind": "gold-self", "gold": row["solution"],
               "answer": row["solution"], "expectedScore": 1} for index, row in enumerate(original)]
    corpus += [{"id": name, "kind": "boundary", "gold": gold, "answer": answer, "expectedScore": expected}
               for name, gold, answer, expected in boundaries()]
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "corpus.jsonl").write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in corpus), encoding="utf-8")
    def canonical(row):
        try:
            proc = subprocess.run([sys.executable, str(repository / "scripts/mflow_math_scorer.py"), json.dumps(row)],
                                  capture_output=True, text=True, encoding="utf-8", timeout=30,
                                  env={**os.environ, "PYTHONIOENCODING": "utf-8"})
            if proc.returncode or proc.stdout.strip() not in ("0", "1"):
                return {"error": f"exit={proc.returncode}: {proc.stderr}", "stdout": proc.stdout}
            return {"score": int(proc.stdout.strip()), "stderr": proc.stderr}
        except subprocess.TimeoutExpired:
            return {"error": "external process deadline exceeded (30s)"}
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        new = list(pool.map(canonical, corpus))
    requests = "".join(json.dumps({"id": row["id"], "reference": row["gold"], "prediction": row["answer"]}) + "\n" for row in corpus)
    legacy = subprocess.run([args.legacy_python, str(repository / "scripts/aflow_math_scorer.py")],
                            input=requests, capture_output=True, text=True, encoding="utf-8", timeout=180,
                            env={**os.environ, "AFLOW_REFERENCE_ROOT": str(args.aflow_root), "PYTHONIOENCODING": "utf-8"})
    (args.output / "legacy-stderr.txt").write_text(legacy.stderr, encoding="utf-8")
    (args.output / "legacy-stdout.jsonl").write_text(legacy.stdout, encoding="utf-8")
    old = {row["id"]: row for row in (json.loads(line) for line in legacy.stdout.splitlines() if line.startswith("{"))}
    results = [{**row, "canonical": result, "legacy": old.get(row["id"], {"error": f"legacy process exit {legacy.returncode}"})}
               for row, result in zip(corpus, new)]
    (args.output / "results.jsonl").write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in results), encoding="utf-8")
    version_code = "import importlib.metadata as m,json,sys\nd={}\nfor p in ['math-verify','antlr4-python3-runtime','sympy','regex']:\n try:d[p]=m.version(p)\n except m.PackageNotFoundError:d[p]=None\nprint(json.dumps({'python':sys.version,'packages':d}))"
    versions = {name: json.loads(subprocess.check_output([python, "-c", version_code], text=True, encoding="utf-8"))
                for name, python in [("canonical", sys.executable), ("legacy", args.legacy_python)]}
    summary = {
        "searchExamples": 119, "testExamplesUsed": 0, "modelRequests": 0, "corpusCases": len(corpus),
        "canonicalGoldSelfPassed": sum(row["canonical"].get("score") == 1 for row in results if row["kind"] == "gold-self"),
        "canonicalBoundaryPassed": sum(row["canonical"].get("score") == row["expectedScore"] for row in results if row["kind"] == "boundary"),
        "canonicalErrors": sum("error" in row["canonical"] for row in results),
        "legacyErrors": sum("error" in row["legacy"] for row in results),
        "disagreements": [row["id"] for row in results if row["canonical"].get("score") != row["legacy"].get("score")],
        "versions": versions,
        "sha256": {str(path): digest(path) for path in [args.search, args.converted_search,
                    repository / "scripts/mflow_math_scorer.py", repository / "scripts/aflow_math_scorer.py",
                    args.aflow_root / "benchmarks/math.py", Path(__file__)]},
        "limitation": "Legacy uses the actual AFlow class in its existing environment, without dependency repair; missing or incompatible ANTLR may suppress symbolic equivalence. These are observed installed-path results, not controlled same-dependency scorer effects.",
        "windowsTimeout": "Canonical Windows internal timers disabled; each subprocess externally limited to 30 seconds.",
    }
    (args.output / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False))
    if summary["canonicalGoldSelfPassed"] != 119 or summary["canonicalBoundaryPassed"] != len(boundaries()) or summary["canonicalErrors"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
