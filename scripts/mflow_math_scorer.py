"""Pinned MFlow math-verify semantics, supervised by a 30-second host process deadline.

Windows math-verify timeout closures cannot be pickled by spawn. Disable only
those internal timers on Windows; the TypeScript caller owns the hard deadline.
"""
import json
import os
import re
import sys
from math_verify import parse, verify


def score(record):
    parse_options = {"parsing_timeout": None} if os.name == "nt" else {}
    verify_options = {"timeout_seconds": None} if os.name == "nt" else {}
    gold = parse(record["gold"], **parse_options)
    text = record["answer"].strip()
    if "\\" in text and not any(marker in text for marker in ("$", r"\(", r"\[", r"\boxed")):
        text = "$" + text + "$"
    if re.fullmatch(r"[A-Za-z][A-Za-z ]*", text) and re.search(r"\\boxed\{\\text\{[A-Za-z ]+\}\}", record["gold"]):
        text = r"\boxed{\text{" + text + "}}"
    answer = parse(text, **parse_options)
    return int(bool(gold and answer and verify(gold, answer, **verify_options)))


if __name__ == "__main__":
    print(score(json.loads(sys.argv[1] if len(sys.argv) > 1 else sys.stdin.read())))
