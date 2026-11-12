import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mbppAdapter } from "./code-adapters.js";
import { evaluateTasks } from "./evaluator.js";
import type { AgentRunResult } from "../domain.js";

const answer = "def answer(x):\n    return x";
const run: AgentRunResult = {
  answer, executedNodeIds: ["main/solve"], executedGraphIds: ["main"],
  inputTokens: 10, outputTokens: 2, totalTokens: 12,
  providerAttempts: 1, usageKnown: true,
};

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "ditto-code-recovery-"));
  await writeFile(join(directory, "mbpp_validate.jsonl"), JSON.stringify({
    task_id: 1, prompt: "Return the argument.\n\ndef answer(x):",
    entry_point: "answer", code: answer,
    test: "def check():\n    assert answer(1) == 1",
  }) + "\n");
  return directory;
}

test("code-judge readiness failure prevents generation for full and subset evaluation", async () => {
  const dataDir = await fixture();
  let ready = false, preflights = 0, generations = 0, judgements = 0;
  try {
    const benchmark = await mbppAdapter.load({ dataDir, split: "validate", dataMode: "fixture", codeJudge: {
      async preflight() {
        preflights++;
        if (!ready) throw new Error("Docker judge is not ready");
      },
      async judge() { judgements++; return { passed: true, diagnostics: "ok", durationMs: 1 }; },
    } });
    const runner = async () => { generations++; return run; };
    await assert.rejects(benchmark.evaluate(runner), (error: any) =>
      /Docker judge is not ready/.test(error.message) && error.infrastructureFailure === true && error.failureKind === "judge");
    await assert.rejects(benchmark.evaluateSearchSubset!(["mbpp:1"], runner), /Docker judge is not ready/);
    assert.equal(generations, 0);
    assert.equal(judgements, 0);
    ready = true;
    const completed = await benchmark.evaluateSearchSubset!(["mbpp:1"], runner);
    assert.equal(completed.score, 1);
    assert.equal(preflights, 3, "a failed readiness check must not be cached as success");
    assert.equal(generations, 1);
    assert.equal(judgements, 1);
    ready = false;
    const cached = await benchmark.evaluate(runner, { priorCases: completed.results });
    assert.equal(cached.score, 1, "already graded cases need no running judge");
    assert.equal(preflights, 3);
    assert.equal(generations, 1);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("judge-only recovery preserves an empty wrong answer and unknown original usage", async () => {
  const dataDir = await fixture();
  let generations = 0, judgements = 0;
  try {
    const benchmark = await mbppAdapter.load({ dataDir, split: "validate", dataMode: "fixture", codeJudge: {
      async judge(request) {
        judgements++;
        assert.doesNotMatch(request.candidate, /return x/, "no reference implementation can replace the saved empty answer");
        if (judgements === 1) throw new Error("Docker judge interrupted");
        return { passed: false, diagnostics: "invalid candidate", durationMs: 1 };
      },
    } });
    const runner = async () => { generations++; return { ...run, answer: "", usageKnown: false }; };
    const first = await benchmark.evaluate(runner);
    const recovered = await benchmark.evaluate(runner, { priorCases: first.results });
    assert.equal(generations, 1);
    assert.equal(recovered.valid, true);
    assert.equal(recovered.score, 0);
    assert.equal(recovered.results[0]!.prediction, "");
    assert.equal(recovered.totalTokens, 12);
    assert.equal(recovered.tokenUsageStatus, "known-lower-bound");
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("saved MBPP judge failures are regraded after reload without generating another answer", async () => {
  const dataDir = await fixture();
  let generations = 0, judgements = 0;
  const runner = async () => { generations++; return run; };
  const load = () => mbppAdapter.load({ dataDir, split: "validate", dataMode: "fixture", codeJudge: {
    async judge(request) {
      judgements++;
      assert.equal(request.candidate, answer, "recovery must judge the original code");
      if (judgements < 3) throw new Error("Docker judge connection lost after generation");
      return { passed: true, diagnostics: "ok", durationMs: 1 };
    },
  } });
  try {
    let summary = await (await load()).evaluate(runner);
    assert.equal(summary.valid, false);
    assert.equal(summary.results[0]!.failureKind, "judge");
    assert.equal(summary.results[0]!.prediction, answer);
    for (let attempt = 0; attempt < 2; attempt++) {
      // Recovery records survive serialization and a newly loaded adapter.
      const priorCases = JSON.parse(JSON.stringify(summary.results));
      summary = await (await load()).evaluateSearchSubset!(["mbpp:1"], runner, { priorCases });
    }
    assert.equal(summary.valid, true);
    assert.equal(summary.score, 1);
    assert.equal(generations, 1);
    assert.equal(judgements, 3);
    assert.equal(summary.totalTokens, 12);
    assert.equal(summary.providerAttemptCount, 1);
    assert.equal(summary.tokenUsageStatus, "complete");
    assert.equal(summary.results[0]!.previousResults?.[0]?.failureKind, "judge");
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("world-based judge recovery still refuses regeneration without its saved world", async () => {
  let generations = 0, judgements = 0;
  const scorer = {
    recoveryData() { return undefined; },
    expectedLabel() { return "official checker"; },
    async score() { judgements++; throw new Error("world checkpoint missing"); },
  };
  const task = { id: "bfcl:fixture", dataset: "bfcl" as const, prompt: "Public task", outputInstruction: "", metadata: {} };
  const first = await evaluateTasks([task], scorer, async () => { generations++; return run; });
  const recovered = await evaluateTasks([task], scorer, async () => { generations++; return run; }, { priorCases: first.results });
  assert.equal(generations, 1);
  assert.equal(judgements, 1);
  assert.equal(recovered.valid, false);
  assert.match(recovered.results[0]!.error!, /saved world; regeneration is refused/);
});
