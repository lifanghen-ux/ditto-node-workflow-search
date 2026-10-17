import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRunResult, BenchmarkTask, EvaluationSummary } from "../domain.js";
import { assertValidEvaluation, backpropagateEvaluation } from "../search/backprop.js";
import { NodeWorkflowSearch } from "../search/optimizer.js";
import { evaluateTasks } from "./evaluator.js";

const tasks: BenchmarkTask[] = ["first", "second"].map(id => ({
  id, dataset: "math", prompt: "1+1", outputInstruction: "answer", metadata: {},
}));
const run = (answer = "2"): AgentRunResult => ({
  answer, executedNodeIds: [], executedGraphIds: [], inputTokens: 3, outputTokens: 2, totalTokens: 5,
});
const scorer = {
  async score(_id: string, prediction: string) {
    return { score: prediction === "2" ? 1 : 0, expected: "2", prediction,
      normalizedExpected: "2", normalizedPrediction: prediction, method: "fixture" };
  },
  expectedLabel() { return "2"; },
};

test("one correct answer plus HTTP 402 invalidates the whole fixed denominator", async () => {
  let failedAttempts = 0;
  const summary = await evaluateTasks(tasks, scorer, async task => {
    if (task.id === "second") { failedAttempts++; throw new Error("HTTP 402: insufficient balance"); }
    return run();
  });
  assert.equal(failedAttempts, 1);
  assert.equal(summary.valid, false);
  assert.equal(summary.examples, 2);
  assert.equal(summary.validRuns, 1);
  assert.equal(summary.wrongRuns, 0);
  assert.equal(summary.failedRuns, 1);
  assert.equal(summary.unknownUsageRuns, 1);
  assert.equal(summary.results[1]?.failureKind, "provider");
  assert.equal(summary.results[1]?.attempts?.[0]?.usageKnown, false);
  assert.throws(() => assertValidEvaluation(summary), /Invalid evaluation/);
  assert.throws(() => backpropagateEvaluation(new Map(), "unused", summary), /Invalid evaluation/);
});

test("a completed wrong answer remains a valid zero", async () => {
  const summary = await evaluateTasks(tasks.slice(0, 1), scorer, async () => run("3"));
  assert.equal(summary.valid, true);
  assert.equal(summary.score, 0);
  assert.equal(summary.wrongRuns, 1);
  assert.equal(summary.failedRuns, 0);
  assert.doesNotThrow(() => assertValidEvaluation(summary));
});

test("successful answers with missing provider usage report known lower bounds", async () => {
  const summary = await evaluateTasks(tasks.slice(0, 1), scorer, async () => ({
    ...run(), usageKnown: false, failedProviderAttempts: 1, providerAttempts: 2, unknownUsageAttempts: 1,
    providerDiagnostics: [{ requestId: 1, attempts: 2, failedAttempts: 1, unknownUsageAttempts: 1,
      usageKnown: false, inputTokens: 3, outputTokens: 2, totalTokens: 5 }],
  }));
  assert.equal(summary.valid, true);
  assert.equal(summary.score, 1);
  assert.equal(summary.unknownUsageRuns, 1);
  assert.equal(summary.tokenUsageStatus, "known-lower-bound");
  assert.equal(summary.totalTokens, 5);
  assert.equal(summary.failedAttemptCount, 1);
  assert.equal(summary.providerAttemptCount, 2);
  assert.equal(summary.unknownUsageAttemptCount, 1);
  assert.equal(summary.results[0]?.providerDiagnostics?.[0]?.requestId, 1);
});

test("known usage and provider diagnostics survive failed workflow attempts and recovery", async () => {
  const error = Object.assign(new Error("HTTP 503"), { inputTokens: 6, outputTokens: 4, totalTokens: 10,
    failedProviderAttempts: 2, providerAttempts: 2, unknownUsageAttempts: 1,
    providerDiagnostics: [{ requestId: 2, attempts: 2, failedAttempts: 2, unknownUsageAttempts: 1,
      usageKnown: false, inputTokens: 6, outputTokens: 4, totalTokens: 10 }],
  });
  const first = await evaluateTasks(tasks.slice(0, 1), scorer, async () => { throw error; }, { retryAttempts: 1 });
  assert.equal(first.totalTokens, 10);
  assert.equal(first.failedAttemptCount, 3);
  const recovered = await evaluateTasks(tasks.slice(0, 1), scorer, async () => ({ ...run(), providerAttempts: 1 }), {
    priorCases: first.results,
  });
  assert.equal(recovered.totalTokens, 15);
  assert.equal(recovered.providerAttemptCount, 3);
  assert.equal(recovered.failedAttemptCount, 3);
  assert.equal(recovered.unknownUsageRuns, 1);
  assert.equal(recovered.results[0]?.providerDiagnostics?.length, 1);
  assert.equal(recovered.results[0]?.attempts?.[0]?.totalTokens, 10);
});

test("invalid format output with two fully accounted responses keeps complete cost", async () => {
  const knownError = Object.assign(new Error("REFLECT output format invalid"), {
    usageKnown: true, inputTokens: 10, outputTokens: 6, totalTokens: 16,
    providerAttempts: 2, failedProviderAttempts: 0, unknownUsageAttempts: 0,
    providerDiagnostics: [1, 2].map(requestId => ({ requestId, attempts: 1, failedAttempts: 0,
      unknownUsageAttempts: 0, usageKnown: true, inputTokens: 5, outputTokens: 3, totalTokens: 8 })),
  });
  const invalid = await evaluateTasks(tasks.slice(0, 1), scorer, async () => { throw knownError; });
  assert.equal(invalid.valid, false);
  assert.equal(invalid.failedRuns, 1);
  assert.equal(invalid.wrongRuns, 0);
  assert.equal(invalid.totalTokens, 16);
  assert.equal(invalid.tokenUsageStatus, "complete");
  assert.equal(invalid.unknownUsageRuns, 0);
  assert.equal(invalid.results[0]?.attempts?.[0]?.usageKnown, true);
  assert.equal(invalid.results[0]?.providerDiagnostics?.length, 2);
  const recovered = await evaluateTasks(tasks.slice(0, 1), scorer, async () => ({ ...run(), usageKnown: true }), {
    priorCases: invalid.results,
  });
  assert.equal(recovered.valid, true);
  assert.equal(recovered.totalTokens, 21);
  assert.equal(recovered.tokenUsageStatus, "complete");
  assert.equal(recovered.unknownUsageRuns, 0);
});

test("scorer crash retains prediction and known usage as a judge failure", async () => {
  const summary = await evaluateTasks(tasks, { ...scorer, async score() { throw new Error("scorer crashed"); } }, async () => run());
  assert.equal(summary.valid, false);
  assert.equal(summary.failedRuns, 2);
  assert.equal(summary.wrongRuns, 0);
  assert.equal(summary.totalTokens, 10);
  assert.equal(summary.results[0]?.prediction, "2");
  assert.equal(summary.results[0]?.failureKind, "judge");
  assert.match(summary.results[0]?.error ?? "", /scorer crashed/);
});

test("transient workflow retries are finite and recovered usage remains incomplete", async () => {
  let attempts = 0;
  const recovered = await evaluateTasks(tasks.slice(0, 1), scorer, async () => {
    if (++attempts === 1) throw new Error("HTTP 503: unavailable");
    return run();
  }, { retryAttempts: 2 });
  assert.equal(attempts, 2);
  assert.equal(recovered.valid, true);
  assert.equal(recovered.failedAttemptCount, 1);
  assert.equal(recovered.unknownUsageRuns, 1);
  assert.equal(recovered.results[0]?.attempts?.[0]?.error, "HTTP 503: unavailable");
  attempts = 0;
  const exhausted = await evaluateTasks(tasks.slice(0, 1), scorer, async () => {
    attempts++; throw new Error("HTTP 503: unavailable");
  }, { retryAttempts: 2 });
  assert.equal(attempts, 2);
  assert.equal(exhausted.valid, false);
  assert.equal(exhausted.results[0]?.attempts?.length, 2);
});

test("authentication and parameter failures are never retried", async () => {
  for (const message of ["HTTP 401: unauthorized", "HTTP 400: invalid parameter"]) {
    let attempts = 0;
    await evaluateTasks(tasks.slice(0, 1), scorer, async () => { attempts++; throw new Error(message); });
    assert.equal(attempts, 1);
  }
});

test("invalid candidate evidence is saved but never reaches optimizer feedback", async () => {
  const valid = await evaluateTasks(tasks.slice(0, 1), scorer, async () => run());
  const invalid: EvaluationSummary = { ...valid, valid: false, failedRuns: 1 };
  let evaluations = 0;
  const seen: Array<{ valid: boolean | undefined; hasExperience: boolean; visits: number }> = [];
  await assert.rejects(new NodeWorkflowSearch({
    seed: 42, rounds: 2, topK: 1, patience: 5,
    async evaluate() { return ++evaluations === 1 ? valid : invalid; },
    proposer: { async propose() { return {
      type: "INFER.REASONING.SAMPLE", graphId: "solve", dependencies: [],
      config: { role: "solver", instruction: "candidate", generation: { temperature: 0, maxTokens: 393216 } },
    }; } },
    callbacks: { async node(node, experience) {
      if (node.evaluation) seen.push({ valid: node.evaluation.valid, hasExperience: experience !== null, visits: node.statistics.visits });
    } },
  }).run(), /Invalid evaluation/);
  assert.equal(evaluations, 2);
  assert.deepEqual(seen.at(-1), { valid: false, hasExperience: false, visits: 0 });
});
