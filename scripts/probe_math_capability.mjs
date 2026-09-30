import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AFlowMathScorer } from "../dist/benchmark/aflow-math-scorer.js";
import { scoreMathAnswer } from "../dist/benchmark/math-score.js";
import { loadProviderSettings } from "../dist/config.js";
import { createExperimentRuntime } from "../dist/ditto/runtime.js";
import { GENERATION } from "../dist/protocol.js";
import { WorkflowExecutor } from "../dist/workflow/executor.js";
import {
  createInitialSampleNode,
  createRootNode,
  instantiateProposal,
  materializeAgentPlan,
} from "../dist/workflow/spec.js";

const dataPath = resolve(process.argv[2] ?? "../data/datasets/math_validate.jsonl");
const outputPath = resolve(process.argv[3] ?? "math-capability-probe.json");
const limit = Number(process.argv[4] ?? "20");
if (!Number.isSafeInteger(limit) || limit < 1 || limit > 30) throw new Error("Probe limit must be in [1, 30]");

const allRows = (await readFile(dataPath, "utf8")).split(/\r?\n/).filter(Boolean).map(JSON.parse);
const indexes = Array.from({ length: limit }, (_, index) => Math.floor(index * allRows.length / limit));
const rows = indexes.map((index) => ({ index, ...allRows[index] }));
const tasks = rows.map((row) => Object.freeze({
  id: `probe:${row.index + 1}`,
  dataset: "math",
  prompt: row.problem,
  outputInstruction: "",
  metadata: Object.freeze({ split: "validate", level: row.level ?? "unknown", type: row.type ?? "unknown" }),
}));
const references = new Map(rows.map((row, index) => [tasks[index].id, row.solution]));

const root = createRootNode();
const baseline = materializeAgentPlan("probe-baseline", [root, createInitialSampleNode()]);
const solveInstruction = "Solve the problem independently and carefully. Return the final answer in one \\boxed{...} expression.";
const sample = (id) => instantiateProposal({
  type: "INFER.REASONING.SAMPLE", graphId: "solve", dependencies: [],
  config: { role: "solver", instruction: solveInstruction, generation: GENERATION },
}, id);
const sampleA = sample("sample-a");
const sampleB = sample("sample-b");
const sampleC = sample("sample-c");
const deliberate = instantiateProposal({
  type: "INFER.REASONING.DELIBERATE", graphId: "solve",
  dependencies: [sampleA.id, sampleB.id, sampleC.id],
  config: { mode: "select", generation: GENERATION },
}, "deliberate-1");
const reflect = instantiateProposal({
  type: "INFER.REASONING.REFLECT", graphId: "refine", dependencies: [],
  config: {
    mode: "revise",
    criteria: [
      "Verify the mathematical result independently.",
      "Preserve required units, degree signs, lists, matrices, and exact symbolic form.",
      "End with exactly one balanced \\boxed{...} final answer.",
    ],
    generation: GENERATION,
  },
}, "reflect-1");
const adapted = materializeAgentPlan("probe-adapted", [root, sampleA, sampleB, sampleC, deliberate, reflect]);

const provider = loadProviderSettings();
const experiment = createExperimentRuntime(provider);
const executor = new WorkflowExecutor(experiment.runtime, experiment.providerName, experiment.model);
const scorer = new AFlowMathScorer(references, { normalizedFallback: false });

async function evaluate(label, plan) {
  let completed = 0;
  const results = await mapLimit(tasks, 3, async (task, index) => {
    const run = await retryWorkflow(() => executor.run(plan, task), 5);
    const strict = await scorer.score(task.id, run.answer);
    const normalized = scoreMathAnswer(rows[index].solution, run.answer);
    const result = { id: task.id, strict: strict.score, normalized: normalized.score,
      expected: normalized.expected, prediction: normalized.prediction,
      inputTokens: run.inputTokens, outputTokens: run.outputTokens };
    completed++;
    console.log(JSON.stringify({ phase: "probe", workflow: label, completed,
      total: tasks.length, strict: result.strict, normalized: result.normalized }));
    return result;
  });
  return { label, strictScore: mean(results.map((item) => item.strict)),
    normalizedScore: mean(results.map((item) => item.normalized)), results };
}

try {
  await scorer.preflight();
  const baselineResult = await evaluate("baseline", baseline);
  const adaptedResult = await evaluate("adapted", adapted);
  const report = { createdAt: new Date().toISOString(), model: provider.model, examples: limit,
    indexes, baseline: baselineResult, adapted: adaptedResult };
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ phase: "probe-complete", outputPath, baseline: {
    strict: baselineResult.strictScore, normalized: baselineResult.normalizedScore }, adapted: {
    strict: adaptedResult.strictScore, normalized: adaptedResult.normalizedScore } }));
} finally {
  await scorer.close();
  await experiment.close();
}

async function mapLimit(values, concurrency, operation) {
  const results = new Array(values.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= values.length) return;
      results[index] = await operation(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

function mean(values) { return values.reduce((sum, value) => sum + value, 0) / values.length; }

async function retryWorkflow(operation, attempts) {
  for (let attempt = 1; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (attempt >= attempts) throw error;
      console.log(JSON.stringify({ phase: "probe-retry", attempt,
        error: error instanceof Error ? error.message : String(error) }));
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}
