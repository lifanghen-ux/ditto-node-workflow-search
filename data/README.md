# Local benchmark data

Dataset files are deliberately not committed. Put the ten JSONL files in `data/datasets/`, or pass another directory with `--data-dir`:

```text
drop_validate.jsonl       drop_test.jsonl
humaneval_validate.jsonl  humaneval_test.jsonl
mbpp_validate.jsonl       mbpp_test.jsonl
gsm8k_validate.jsonl      gsm8k_test.jsonl
math_validate.jsonl       math_test.jsonl
```

The loader accepts the AFlow experiment split schemas. Search opens only `*_validate.jsonl`; after a Node path is frozen, the separate `test` command opens only `*_test.jsonl`. Gold answers, canonical solutions, and hidden tests remain inside each adapter's private judge state and are never included in model input.

Use data only under its original dataset terms. This repository does not redistribute it.
