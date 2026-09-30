"""JSONL adapter around the actual frozen AFlow MATH scorer, without a port."""
import hashlib
import json
import os
import sys
from pathlib import Path

root = Path(os.environ.get("AFLOW_REFERENCE_ROOT", Path(__file__).resolve().parents[2])).resolve()
sys.path.insert(0, str(root))
from benchmarks.math import MATHBenchmark

benchmark = object.__new__(MATHBenchmark)
source_hash = hashlib.sha256((root / "benchmarks/math.py").read_bytes()).hexdigest()

for raw_line in sys.stdin:
    request = {}
    try:
        request = json.loads(raw_line)
        expected = benchmark.extract_model_answer(request["reference"])
        score, prediction = benchmark.calculate_score(request["reference"], request["prediction"])
        response = {
            "id": request["id"], "score": score, "expected": expected,
            "prediction": prediction, "sourceHash": source_hash,
        }
    except Exception as error:
        response = {"id": request.get("id"), "error": f"{type(error).__name__}: {error}"}
    sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
    sys.stdout.flush()
