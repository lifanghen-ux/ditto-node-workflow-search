import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentRunResult, BenchmarkTask, ScoreEvidence } from "../domain.js";
import { dropAdapter } from "../benchmark/drop.js";
import { evaluateTasks } from "../benchmark/evaluator.js";

const runResult = (): AgentRunResult => ({ answer: "public guess", executedNodeIds: [], executedGraphIds: [],
  inputTokens: 2, outputTokens: 3, totalTokens: 5, usageKnown: true });

test("DROP search subsets evaluate only distinct selected IDs and keep references outside runner inputs", async t => {
  const directory = await mkdtemp(join(tmpdir(), "ditto-drop-subset-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rows = ["a", "b", "c", "d"].map(id => ({ id, context: `PUBLIC passage and question ${id}`, ref_text: `PRIVATE_REFERENCE_${id}` }));
  for (const split of ["validate", "test"]) await writeFile(join(directory, `drop_${split}.jsonl`), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const benchmark = await dropAdapter.load({ dataDir: directory, split: "validate", dataMode: "fixture" });
  assert.ok(benchmark.evaluateSearchSubset);
  const seen: string[] = [];
  const summary = await benchmark.evaluateSearchSubset(["drop:c", "drop:a"], async task => {
    seen.push(task.id);
    assert.ok(!JSON.stringify(task).includes("PRIVATE_REFERENCE"));
    assert.ok(!Object.hasOwn(task, "reference"));
    assert.ok(!Object.hasOwn(task, "expected"));
    return runResult();
  }, { repeats: 2, concurrency: 1 });
  assert.deepEqual(seen, ["drop:c", "drop:a", "drop:c", "drop:a"]);
  assert.equal(summary.valid, true);
  assert.equal(summary.examples, 2);
  assert.equal(summary.repeats, 2);
  assert.deepEqual(summary.results.map(row => row.caseId), ["drop:c#1", "drop:a#1", "drop:c#2", "drop:a#2"]);
  assert.equal(benchmark.tasks.length, 4, "subset search must not mutate the full benchmark");
  let fullRuns = 0;
  const full = await benchmark.evaluate(async () => { fullRuns++; return runResult(); });
  assert.equal(fullRuns, 4);
  assert.equal(full.examples, 4);
});

test("DROP subsets reject empty, duplicate and unknown task IDs before starting runner work", async t => {
  const directory = await mkdtemp(join(tmpdir(), "ditto-drop-subset-invalid-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "drop_validate.jsonl"), JSON.stringify({ id: "a", context: "PUBLIC question", ref_text: "PRIVATE_REFERENCE" }) + "\n");
  const benchmark = await dropAdapter.load({ dataDir: directory, split: "validate", dataMode: "fixture" });
  let calls = 0;
  const runner = async () => { calls++; return runResult(); };
  assert.throws(() => benchmark.evaluateSearchSubset!([], runner), /distinct task IDs/);
  assert.throws(() => benchmark.evaluateSearchSubset!(["drop:a", "drop:a"], runner), /distinct task IDs/);
  assert.throws(() => benchmark.evaluateSearchSubset!(["drop:a", "drop:missing"], runner), /Unknown search task ID/);
  assert.equal(calls, 0);
});

test("DROP test split cannot be used through the development subset evaluator", async t => {
  const directory = await mkdtemp(join(tmpdir(), "ditto-drop-test-subset-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "drop_test.jsonl"), JSON.stringify({ id: "a", context: "PUBLIC held-out question", ref_text: "PRIVATE_HELD_OUT_REFERENCE" }) + "\n");
  const benchmark = await dropAdapter.load({ dataDir: directory, split: "test", dataMode: "fixture" });
  let calls = 0;
  assert.throws(() => benchmark.evaluateSearchSubset!(["drop:a"], async () => { calls++; return runResult(); }), /only use the validation split/);
  assert.equal(calls, 0);
});

test("callback failure stops new dispatch and waits for already running evaluations to finish", async t => {
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  const bothStarted = Promise.withResolvers<void>();
  const firstCallback = Promise.withResolvers<void>();
  t.after(() => { first.resolve(); second.resolve(); });
  const tasks: BenchmarkTask[] = Array.from({ length: 12 }, (_, index) => ({ id: `task-${index}`, dataset: "drop",
    prompt: `PUBLIC question ${index}`, outputInstruction: "", metadata: {} }));
  const started: string[] = [];
  const completed: string[] = [];
  let inFlightRecorded = false;
  let settled = false;
  const stop = new Error("controlled stop from persistence callback");
  const expectedLabel = "PRIVATE_FIXTURE_REFERENCE";
  const scorer = { expectedLabel: () => expectedLabel, async score(_id: string, prediction: string): Promise<ScoreEvidence> {
    return { score: 1, expected: expectedLabel, prediction, normalizedExpected: expectedLabel, normalizedPrediction: prediction, method: "fixture" };
  } };
  const finished = evaluateTasks(tasks, scorer, async task => {
    started.push(task.id);
    if (started.length === 2) bothStarted.resolve();
    if (task.id === "task-0") await first.promise;
    else if (task.id === "task-1") await second.promise;
    completed.push(task.id);
    return runResult();
  }, { concurrency: 2, repeats: 3, retryAttempts: 1, async onCase({ result }) {
    if (result.caseId === "task-0#1") { firstCallback.resolve(); throw stop; }
    if (result.caseId === "task-1#1") inFlightRecorded = true;
  } }).then(value => { settled = true; return { value, error: null }; }, error => { settled = true; return { value: null, error }; });

  await bothStarted.promise;
  assert.deepEqual(started, ["task-0", "task-1"]);
  first.resolve();
  await firstCallback.promise;
  // Let the rejected callback propagate through the worker catch; no wall-clock
  // timeout or race with an uncontrolled model response is needed.
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(settled, false, "evaluation must wait for the other in-flight operation");
  assert.deepEqual(started, ["task-0", "task-1"], "no replacement work should be dispatched after callback failure");
  second.resolve();
  const result = await finished;
  assert.equal(result.error, stop);
  assert.equal(result.value, null);
  assert.deepEqual(completed, ["task-0", "task-1"]);
  assert.equal(inFlightRecorded, true, "already paid in-flight work must still reach the persistence callback");
  assert.equal(started.length, 2, "later tasks and later repeats must never start");
});
