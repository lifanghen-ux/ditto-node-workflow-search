import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentRunResult } from "../domain.js";
import { humanevalAdapter } from "./code-adapters.js";
import { extractPythonCandidate } from "./docker-python-judge.js";
import { stratifiedSample } from "./sampling.js";
import { scoreCompetitionMathAnswer, scoreDropAnswer, scoreGsm8kAnswer } from "./text-scores.js";
import type { CodeJudge } from "./types.js";

test("text benchmark scorers match their declared semantics", () => {
  assert.equal(scoreDropAnswer("The red fox|fox", "a fox").score, 1);
  assert.equal(scoreGsm8kAnswer("1,234", "work... final 1234").score, 1);
  assert.equal(scoreCompetitionMathAnswer("Therefore \\boxed{\\frac{1}{2}}", "Answer: \\boxed{0.5}").score, 1);
});

test("stratified sampling is deterministic and covers strata", () => {
  const values = ["a1", "a2", "a3", "b1", "b2", "c1"];
  const first = stratifiedSample(values, 3, 7, (value) => value[0]!);
  const second = stratifiedSample(values, 3, 7, (value) => value[0]!);
  assert.deepEqual(first, second);
  assert.deepEqual(new Set(first.map((value) => value[0])), new Set(["a", "b", "c"]));
});

test("candidate extraction prefers a fenced complete entry point", () => {
  const extracted = extractPythonCandidate("text\n```python\ndef answer(x):\n    return x\n```", "def answer(x):", "answer");
  assert.match(extracted, /^def answer/);
  const completion = extractPythonCandidate("if x:\n    return x\nreturn 0", "def answer(x):", "answer");
  assert.equal(completion, "def answer(x):\n    if x:\n        return x\n    return 0");
});

test("code adapter keeps tests private and delegates to the injected judge", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ditto-benchmark-"));
  let observedTest = "";
  const judge: CodeJudge = {
    async judge(request) {
      observedTest = request.testSource;
      return { passed: true, diagnostics: "ok", durationMs: 1 };
    },
  };
  try {
    await writeFile(join(directory, "humaneval_validate.jsonl"), `${JSON.stringify({
      task_id: "HumanEval/0",
      prompt: "def answer(x):\n    \"\"\"identity\"\"\"\n",
      entry_point: "answer",
      canonical_solution: "    return x",
      test: "def check(candidate):\n    assert candidate(1) == 1",
    })}\n`, "utf8");
    const loaded = await humanevalAdapter.load({ dataDir: directory, split: "validate", codeJudge: judge });
    assert.equal(JSON.stringify(loaded.tasks).includes("candidate(1)"), false);
    const result: AgentRunResult = {
      answer: "```python\ndef answer(x):\n    return x\n```",
      executedNodeIds: [],
      executedGraphIds: [],
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
    };
    const summary = await loaded.evaluate(async () => result);
    assert.equal(summary.score, 1);
    assert.match(observedTest, /candidate\(1\)/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("evaluation reports monotonic live progress without exposing judge references", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ditto-progress-"));
  const updates: Array<{ completed: number; total: number; score: number }> = [];
  try {
    await writeFile(join(directory, "humaneval_validate.jsonl"), `${JSON.stringify({
      task_id: "HumanEval/1",
      prompt: "def answer(x):\n",
      entry_point: "answer",
      canonical_solution: "    return x",
      test: "def check(candidate):\n    assert candidate(1) == 1",
    })}\n`, "utf8");
    const loaded = await humanevalAdapter.load({
      dataDir: directory,
      split: "validate",
      codeJudge: { async judge() { return { passed: true, diagnostics: "ok", durationMs: 1 }; } },
    });
    await loaded.evaluate(async () => ({
      answer: "def answer(x):\n    return x",
      executedNodeIds: [], executedGraphIds: [], inputTokens: 1, outputTokens: 1, totalTokens: 2,
    }), {
      repeats: 2,
      onCase: ({ completed, total, result }) => { updates.push({ completed, total, score: result.score }); },
    });
    assert.deepEqual(updates, [
      { completed: 1, total: 2, score: 1 },
      { completed: 2, total: 2, score: 1 },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
