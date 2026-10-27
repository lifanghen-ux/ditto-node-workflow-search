import assert from "node:assert/strict";
import test from "node:test";
import type { BenchmarkTask, CaseResult, EvaluationSummary } from "../domain.js";
import type { DirectedCandidate } from "../search/directed-search.js";
import { buildWorkflowFeedback } from "../search/workflow-feedback.js";
import { createInitialSampleNode, createRootNode, materializeAgentPlan } from "../workflow/spec.js";

const task = (id: string, question = "How many yards?"): BenchmarkTask => ({
  id, dataset: "drop", prompt: `PUBLIC PASSAGE\nQuestion: ${question}`, outputInstruction: "PUBLIC OUTPUT CONTRACT",
  metadata: { secretMetadataMustNotLeak: "PRIVATE_METADATA" },
});
const row = (id: string, repeat: number, prediction: string, score: number): CaseResult => {
  const value: CaseResult = {
    caseId: `${id}#${repeat}`, prediction, score, valid: true,
    expected: "PRIVATE_GOLD", normalizedExpected: "PRIVATE_GOLD", normalizedPrediction: "PRIVATE_NORMALIZED",
    method: "private-method", details: { secret: "PRIVATE_DETAILS" },
    generationOutcomes: [{ nodeId: "node", nodeType: "sample", finishReason: "length", usable: false, content: "PRIVATE_RAW_GENERATION" }],
    providerDiagnostics: [], latencyMs: 4, inputTokens: 2, outputTokens: 3, totalTokens: 5,
  };
  // Reading a label is itself a privacy regression, even if it is later removed.
  for (const key of ["expected", "normalizedExpected", "details", "generationOutcomes", "normalizedPrediction"])
    Object.defineProperty(value, key, { enumerable: true, get() { throw new Error(`Do not read private field ${key}`); } });
  return value;
};
function evaluation(results: readonly CaseResult[], repeats = 1): EvaluationSummary {
  return {
    valid: true, score: results.reduce((sum, value) => sum + value.score, 0) / results.length,
    standardDeviation: 0, repeats, examples: results.length / repeats,
    successfulRuns: results.length, failedRuns: 0, timeoutRuns: 0, wrongRuns: results.filter(value => value.score < 1).length,
    inputTokens: 20, outputTokens: 30, totalTokens: 50, durationMs: 40, tokenUsageStatus: "known-lower-bound",
    providerAttemptCount: 8, failedAttemptCount: 2, results,
  };
}
function candidate(id: string, results: readonly CaseResult[], referenceCandidateId: string | null = null, repeats = 1): DirectedCandidate {
  return {
    id, referenceCandidateId, rationale: "PRIVATE_RATIONALE_MUST_NOT_BE_COPIED",
    status: "valid", plan: materializeAgentPlan(id, [createRootNode(), createInitialSampleNode()]),
    planHash: id, evaluation: evaluation(results, repeats),
  };
}

test("feedback exposes only public task text, predictions, scores and explicit cost fields", () => {
  const history = [candidate("a", [row("case-a", 1, "PUBLIC PREDICTION", 0)])];
  const feedback = buildWorkflowFeedback(history, [task("case-a")]);
  const wire = JSON.stringify(feedback);
  assert.ok(!wire.includes("PRIVATE"));
  assert.ok(wire.includes("PUBLIC PREDICTION"));
  assert.ok(wire.includes("PUBLIC PASSAGE"));
  assert.equal(feedback[0]!.publicCases[0]!.outcomes[0]!.score, 0);
  assert.deepEqual(feedback[0]!.evaluationCost, {
    scope: "workflow-evaluation-only", inputTokens: 20, outputTokens: 30, totalTokens: 50, durationMs: 40,
    providerAttempts: 8, failedAttempts: 2, usageStatus: "known-lower-bound",
  });
});

test("diverse feedback deduplicates repeats and includes later failure patterns", () => {
  const tasks = [task("a"), task("b"), task("c")];
  const cases = [row("a", 1, "49-yard", 0), row("a", 2, "49-yard", 0),
    row("b", 1, "38-yard", 0), row("b", 2, "38-yard", 0),
    row("c", 1, "2 + 2 = 4", .5), row("c", 2, "4", 1)];
  const feedback = buildWorkflowFeedback([candidate("a", cases, null, 2)], tasks, { maxCases: 2 })[0]!;
  assert.equal(feedback.publicCases.length, 2);
  assert.deepEqual(feedback.publicCases.map(value => value.taskId), ["a", "c"]);
  assert.equal(feedback.publicCases[1]!.outcomes.length, 2);
  assert.equal(feedback.publicCases[1]!.meanScore, .75);
});

test("paired changes average repetitions within tasks and retain repairs and regressions", () => {
  const tasks = [task("a"), task("b"), task("c")];
  const base = candidate("base", [row("a", 1, "old", 0), row("a", 2, "old", .5),
    row("b", 1, "old", 1), row("b", 2, "old", 1), row("c", 1, "old", 1), row("c", 2, "old", 1)], null, 2);
  const child = candidate("child", [row("a", 1, "new", 1), row("a", 2, "new", 1),
    row("b", 1, "new", .5), row("b", 2, "new", .5), row("c", 1, "new", 1), row("c", 2, "new", 1)], "base", 2);
  const feedback = buildWorkflowFeedback([base, child], tasks, { maxCases: 2 })[1]!;
  assert.deepEqual(feedback.pairedChanges, {
    status: "available", referenceCandidateId: "base", taskCount: 3, pairedRuns: 6,
    improvedTasks: 1, regressedTasks: 1, unchangedTasks: 1, meanScoreDelta: .25 / 3,
  });
  assert.deepEqual(feedback.publicCases.map(value => value.change), ["regressed", "improved"]);
  assert.equal(feedback.publicCases[1]!.referenceMeanScore, .25);
});

test("different repeat sets or missing public tasks are unknown rather than no regression", () => {
  const base = candidate("base", [row("a", 1, "x", 0), row("a", 2, "x", 0)], null, 2);
  const child = candidate("child", [row("a", 1, "x", 1), row("a", 3, "x", 1)], "base", 2);
  const feedback = buildWorkflowFeedback([base, child], [task("a")])[1]!;
  assert.deepEqual(feedback.pairedChanges, { status: "unavailable", reason: "incomplete-or-unmatched-cases" });
  // All child answers passed. There need not be a failure example to display;
  // the explicit unavailable summary still prevents claiming no regressions.
  const unmatched = buildWorkflowFeedback([base, child], [task("unrelated")])[1]!;
  assert.deepEqual(unmatched.publicCases, []);
});

test("invalid evaluations never expose placeholder scores, private errors or arbitrary failure categories", () => {
  const invalid: DirectedCandidate = { ...candidate("invalid", []), status: "invalid",
    failureCounts: { provider: 2, judge: 1, "PRIVATE_ERROR_MESSAGE": 7, execution: -1 } };
  const feedback = buildWorkflowFeedback([invalid], [task("a")])[0]!;
  assert.equal(feedback.score, null);
  assert.equal(feedback.evaluationCost, null);
  assert.deepEqual(feedback.publicCases, []);
  assert.deepEqual(feedback.failureCounts, { provider: 2, judge: 1 });
  assert.ok(!JSON.stringify(feedback).includes("PRIVATE"));
});

test("public task metadata and non-whitelisted case IDs do not enter feedback", () => {
  const feedback = buildWorkflowFeedback([candidate("a", [row("not-public", 1, "PRIVATE_OTHER_SPLIT_PREDICTION", 0)])], [task("a")]);
  assert.deepEqual(feedback[0]!.publicCases, []);
  assert.ok(!JSON.stringify(feedback).includes("PRIVATE"));
});
