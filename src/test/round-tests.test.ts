import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { EvaluationSummary } from "../domain.js";
import { parseArguments, loadProviderSettings } from "../config.js";
import { limitProviderConcurrency } from "../ditto/runtime.js";
import { parseRoundTestArguments } from "../round-test-config.js";
import { checkpointForPlan, discoverCheckpoints, publishCheckpoint } from "../run/checkpoints.js";
import { IndependentRoundTests } from "../run/independent-tests.js";
import { acquireTestLock } from "../run/test-lock.js";
import { createInitialSampleNode, createRootNode, createSearchTreeNode, instantiateProposal, materializeAgentPlan } from "../workflow/spec.js";

const manifest = { dataset: "math", model: "fake-model", endpoint: "https://example.invalid", protocol: {}, metricProfile: "fake", dittoVersion: "0.1.1" };
const rootSpec = createRootNode();
const initialSpec = createInitialSampleNode();
const baselinePlan = materializeAgentPlan("search-001", [rootSpec, initialSpec]);
const baseline = checkpointForPlan(baselinePlan, manifest);
const extra = instantiateProposal({ type: "INFER.REASONING.SAMPLE", graphId: "refine", dependencies: [],
  config: { role: "finalizer", instruction: "Check the result", generation: { temperature: 0, maxTokens: 393_216 } } }, "sample-2");
const candidate = checkpointForPlan(materializeAgentPlan("search-002", [rootSpec, initialSpec, extra]), manifest);

function summary(score: number): EvaluationSummary {
  return { score, standardDeviation: 0, repeats: 1, examples: 1, successfulRuns: 1, failedRuns: 0,
    timeoutRuns: 0, wrongRuns: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, durationMs: 1,
    results: [{ caseId: "private-test:1", score, expected: "1", prediction: "1", normalizedExpected: "1", normalizedPrediction: "1",
      method: "fake", latencyMs: 1, inputTokens: 0, outputTokens: 0, totalTokens: 0 }] };
}

test("search/test sample and provider concurrency are independent without changing search rules", () => {
  const options = parseArguments(["search", "--search-concurrency", "512", "--search-provider-concurrency", "1000", "--test-concurrency", "400"]);
  assert.equal(options.evaluationConcurrency, 512);
  assert.equal(options.searchProviderConcurrency, 1000);
  assert.equal(options.testConcurrency, 400);
  assert.equal(options.rounds, 20);
  assert.equal(options.repeats, 5);
  assert.equal(options.topK, 4);
  assert.equal(options.patience, 5);
  assert.equal(parseArguments(["search", "--evaluation-concurrency", "3"]).searchProviderConcurrency, 3);
  assert.equal(parseArguments(["test", "--run-dir", "run", "--test-concurrency", "200"]).testProviderConcurrency, 200);
  assert.equal(loadProviderSettings({ CODE_SOUL_API_KEY: "fake", CODE_SOUL_CONCURRENCY: "1000" }).concurrency, 1000);
  assert.throws(() => parseRoundTestArguments(["--run-dir", "run", "--data-dir", "data", "--output-dir", "run/test-results"]));
});

test("a global provider limit of 200 is respected across simultaneous workflows", async () => {
  let active = 0;
  let peak = 0;
  let calls = 0;
  const provider = limitProviderConcurrency({ async invoke() {
    active++;
    peak = Math.max(peak, active);
    calls++;
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    return { message: { role: "assistant", content: "1" } } as never;
  } }, 200);
  await Promise.all(Array.from({ length: 450 }, () => provider.invoke({} as never, { signal: new AbortController().signal } as never)));
  assert.equal(calls, 450);
  assert.equal(peak, 200);
});

test("historical workflow recovery reads complete leaves without modifying search files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ditto-checkpoints-"));
  try {
    await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
    const root = createSearchTreeNode("search-000", null, 0, rootSpec, [rootSpec]);
    const initial = createSearchTreeNode("search-001", root.id, 1, initialSpec, baselinePlan.nodes);
    const child = createSearchTreeNode("search-002", initial.id, 2, extra, candidate.plan.nodes);
    const treeText = [root, { ...initial, evaluation: summary(0.8) }, { ...child, evaluation: summary(0.9) }].map(x=>JSON.stringify(x)).join("\n") + "\n";
    await writeFile(join(directory, "search-tree.jsonl"), treeText + '{"partial');
    const recovered = await discoverCheckpoints(directory);
    assert.deepEqual(recovered.map(x=>x.plan), [baselinePlan, candidate.plan]);
    assert.equal(await readFile(join(directory, "search-tree.jsonl"), "utf8"), treeText + '{"partial');
    await publishCheckpoint(join(directory, "checkpoints"), recovered[0]!);
    assert.equal((await discoverCheckpoints(directory)).length, 2);
    await assert.rejects(publishCheckpoint(join(directory, "checkpoints"), { ...baseline, model: "changed" }), /immutable/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("test submissions return before evaluation finishes and completed jobs survive restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ditto-tests-"));
  try {
    const releases: Array<() => void> = [];
    const started: string[] = [];
    const settings = { outputDirectory: directory, workflowConcurrency: 2, sampleConcurrency: 200, providerConcurrency: 200, testDataHash: "fixed-test-hash", testRepeats: 3 };
    const runner = new IndependentRoundTests(settings, async checkpoint => {
      started.push(checkpoint.searchNodeId);
      await new Promise<void>(resolve => releases.push(resolve));
      return summary(1);
    });
    await runner.enqueue(baseline);
    await runner.enqueue(candidate);
    await runner.enqueue(baseline);
    assert.equal(runner.jobs.length, 2);
    // Allow local artifact writes to finish; fake model operations remain blocked.
    for (let count = 0; started.length < 2 && count < 100; count++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(started.sort(), ["search-001", "search-002"]);
    assert.equal(runner.pending, 2);
    releases.forEach(release => release());
    await runner.drain();
    assert.ok(runner.jobs.every(job => job.status === "complete"));
    let reruns = 0;
    const restarted = new IndependentRoundTests(settings, async () => { reruns++; return summary(1); });
    await restarted.enqueue(baseline);
    await restarted.enqueue(candidate);
    await restarted.drain();
    assert.equal(reruns, 0);
    assert.ok(restarted.jobs.every(job => job.score === 1));
    const lock = await acquireTestLock(directory);
    await assert.rejects(acquireTestLock(directory), /already owns/);
    await lock();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a failed independent test does not stop another workflow or modify its checkpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ditto-test-failure-"));
  try {
    const runner = new IndependentRoundTests({ outputDirectory: directory, workflowConcurrency: 1,
      sampleConcurrency: 200, providerConcurrency: 200, testDataHash: "fixed", testRepeats: 3 }, async checkpoint => {
      if (checkpoint.searchNodeId === "search-001") throw new Error("fake provider failure");
      return summary(1);
    });
    await runner.enqueue(baseline);
    await runner.enqueue(candidate);
    await runner.drain();
    assert.equal(runner.jobs[0]!.status, "failed");
    assert.equal(runner.jobs[1]!.status, "complete");
    assert.equal(baseline.planHash, checkpointForPlan(baselinePlan, manifest).planHash);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("invalid independent evaluations retain evidence and retry after restart instead of completing at zero", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ditto-test-invalid-"));
  const settings = { outputDirectory: directory, workflowConcurrency: 1, sampleConcurrency: 1,
    providerConcurrency: 1, testDataHash: "fixed", testRepeats: 1 };
  try {
    const invalid: EvaluationSummary = { ...summary(0), valid: false, failedRuns: 1, successfulRuns: 0,
      results: [{ ...summary(0).results[0]!, valid: false, error: "HTTP 402", failureKind: "provider" }] };
    const runner = new IndependentRoundTests(settings, async () => invalid);
    await runner.enqueue(baseline); await runner.drain();
    assert.equal(runner.jobs[0]!.status, "failed");
    assert.equal(runner.jobs[0]!.score, undefined);
    assert.equal(runner.jobs[0]!.legacyScore, undefined);
    const saved = JSON.parse(await readFile(join(directory, baseline.searchNodeId, "attempt-1", "summary.json"), "utf8"));
    assert.equal(saved.valid, false);
    assert.equal(JSON.parse(await readFile(join(directory, baseline.searchNodeId, "attempt-1", "samples.json"), "utf8"))[0].error, "HTTP 402");
    let calls = 0;
    const restarted = new IndependentRoundTests(settings, async () => { calls++; return { ...summary(0), valid: true }; });
    await restarted.enqueue(baseline); await restarted.drain();
    assert.equal(calls, 1); assert.equal(restarted.jobs[0]!.attempt, 2);
    assert.equal(restarted.jobs[0]!.status, "complete"); assert.equal(restarted.jobs[0]!.score, 0);
    const completed = new IndependentRoundTests(settings, async () => { throw new Error("valid zero must be reused"); });
    await completed.enqueue(baseline); await completed.drain();
    assert.equal(completed.jobs[0]!.status, "complete"); assert.equal(completed.jobs[0]!.attempt, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("legacy complete jobs are checked against saved evaluation validity before skipping", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ditto-test-legacy-invalid-"));
  const settings = { outputDirectory: directory, workflowConcurrency: 1, sampleConcurrency: 1,
    providerConcurrency: 1, testDataHash: "fixed", testRepeats: 1 };
  try {
    const original = new IndependentRoundTests(settings, async () => summary(0));
    await original.enqueue(baseline); await original.drain();
    const attempt = join(directory, baseline.searchNodeId, "attempt-1");
    // Reproduce the old complete/zero artifact despite invalid underlying evaluation.
    await writeFile(join(attempt, "summary.json"), JSON.stringify({ ...summary(0), valid: false }));
    let calls = 0;
    const restarted = new IndependentRoundTests(settings, async () => { calls++; return summary(1); });
    await restarted.enqueue(baseline); await restarted.drain();
    assert.equal(calls, 1); assert.equal(restarted.jobs[0]!.attempt, 2);
    assert.equal(restarted.jobs[0]!.score, 1);
    assert.equal(JSON.parse(await readFile(join(attempt, "job.json"), "utf8")).status, "complete");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("independent completion rejects inconsistent failed or incomplete sample evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ditto-test-inconsistent-"));
  try {
    for (const [label, results] of [
      ["failed-case", [{ ...summary(0).results[0]!, valid: false, error: "scorer failed" }]],
      ["missing-case", []],
    ] as const) {
      const runner = new IndependentRoundTests({ outputDirectory: join(directory, label), workflowConcurrency: 1,
        sampleConcurrency: 1, providerConcurrency: 1, testDataHash: "fixed", testRepeats: 1 },
      async () => ({ ...summary(0), valid: true, results }));
      await runner.enqueue(baseline); await runner.drain();
      assert.equal(runner.jobs[0]!.status, "failed");
      assert.equal(runner.jobs[0]!.score, undefined);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
