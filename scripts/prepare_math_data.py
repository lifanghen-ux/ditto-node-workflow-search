"""Extract the locked raw MATH splits needed by this experiment. Never overwrite."""
import argparse
import hashlib
import json
import tarfile
from pathlib import Path

ARCHIVE_SHA256 = "7089a373c27184ae1b67e322f8276642dab246359052989b03a27f48251ae053"
FILES = {
    "math_validate.jsonl": (119, "0ade63e8c9fe01fb8964fa22f73423be5e1c78addc9942808de464cabab188c0"),
    "math_test.jsonl": (486, "343361223de598f1a8ca101edd5d4a063b8152a3ae80f845855b0d8cfb858e5c"),
}

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--archive", type=Path, required=True)
parser.add_argument("--out", type=Path, required=True)
args = parser.parse_args()
if args.out.exists():
    raise FileExistsError(args.out)
if hashlib.sha256(args.archive.read_bytes()).hexdigest() != ARCHIVE_SHA256:
    raise ValueError("AFlow archive differs from the pinned MFlow source")
prepared = {}
with tarfile.open(args.archive, "r:gz") as archive:
    for name, (count, digest) in FILES.items():
        stream = archive.extractfile(name)
        if stream is None:
            raise ValueError(f"Missing archive member: {name}")
        content = stream.read()
        if hashlib.sha256(content).hexdigest() != digest or len(content.splitlines()) != count:
            raise ValueError(f"Locked member differs: {name}")
        prepared[name] = content
args.out.mkdir(parents=True)
for name, content in prepared.items():
    (args.out / name).write_bytes(content)
(args.out / "manifest.json").write_text(json.dumps({
    "protocol": "aflow-fixed-v1", "archiveSha256": ARCHIVE_SHA256,
    "members": {name: {"count": FILES[name][0], "sha256": FILES[name][1]} for name in prepared},
}, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"search": 119, "testPrepared": 486, "testEvaluated": 0}))
