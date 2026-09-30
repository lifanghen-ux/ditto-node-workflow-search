import assert from "node:assert/strict";
import test from "node:test";
import type { EvaluationSummary } from "../domain.js";
import { checkAFlowConvergence } from "../search/convergence.js";

test("AFlow convergence observes an unchanged running Top-3 mean", () => {
  const improving = [0.1, 0.2, 0.3, 0.4].map(summary);
  assert.equal(checkAFlowConvergence(improving).converged, false);

  const stable = [0.1, 0.2, 0.3, 0.4, 0.05, 0.06, 0.07, 0.08, 0.09].map(summary);
  const result = checkAFlowConvergence(stable);
  assert.equal(result.converged, true);
  assert.equal(result.unchangedTransitions, 5);
  assert.equal(result.topKMean, 0.3);
});

function summary(score: number): EvaluationSummary {
  return {
    score,
    standardDeviation: 0,
    repeats: 5,
    examples: 119,
    successfulRuns: 595,
    failedRuns: 0,
    timeoutRuns: 0,
    wrongRuns: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    durationMs: 0,
    results: [],
  };
}
