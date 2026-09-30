import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { DockerPythonJudge, loadBenchmark, sha256File } from "./benchmark/index.js";
import type { BenchmarkSplit, LoadedBenchmark } from "./benchmark/types.js";
import { loadProviderSettings, parseArguments, type ExperimentOptions, type ProviderSettings } from "./config.js";
import type { DatasetName, EvaluationSummary } from "./domain.js";
import { createExperimentRuntime, type ExperimentRuntime } from "./ditto/runtime.js";
import { NodeWorkflowSearch } from "./search/optimizer.js";
import { NextNodeProposer } from "./search/proposer.js";
import { RunStore } from "./run/store.js";
import { WorkflowExecutor } from "./workflow/executor.js";
import { GENERATION, PROTOCOL } from "./protocol.js";

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const provider = loadProviderSettings();
  const experiment = createExperimentRuntime(provider);
  const executor = new WorkflowExecutor(experiment.runtime, experiment.providerName, experiment.model);
  try {
    if (options.command === "search") await search(options, provider, experiment, executor);
    else await testFrozen(options, provider, executor);
  } finally {
    await experiment.close();
  }
}

async function search(
  options: ExperimentOptions,
  provider: ProviderSettings,
  experiment: ExperimentRuntime,
  executor: WorkflowExecutor,
): Promise<void> {
  const store = await RunStore.create(options.outputRoot, options.dataset);
  const loaded = await openBenchmark(options, "validate");
  const dataPath = benchmarkPath(options, "validate");
  const manifest: Record<string, unknown> = {
    schemaVersion: 2,
    status: "searching",
    createdAt: new Date().toISOString(),
    dataset: options.dataset,
    split: "validate",
    metricProfile: metricProfile(options.dataset),
    dittoVersion: await dittoVersion(),
    package: "@codesoul-co/ditto",
    model: provider.model,
    endpoint: provider.baseUrl,
    providerConcurrency: provider.concurrency,
    evaluationConcurrency: options.evaluationConcurrency,
    generation: GENERATION,
    protocol: PROTOCOL,
    search: {
      rounds: options.rounds,
      repeats: options.repeats,
      testRepeats: options.testRepeats,
      topK: options.topK,
      selectionAlpha: 0.2,
      selectionLambda: 0.3,
      convergenceTopK: 3,
      convergenceZ: 0,
      convergenceConsecutiveRounds: options.patience,
      maximumDepth: options.maximumDepth,
      seed: options.seed,
    },
    data: {
      file: basename(dataPath),
      sha256: await sha256File(dataPath),
      selectedExamples: loaded.tasks.length,
      selectedIds: loaded.tasks.map((task) => task.id),
    },
    ...(isCodeDataset(options.dataset) ? { codeJudge: { kind: "docker", image: options.dockerImage, network: "none" } } : {}),
  };
  await store.writeManifest(manifest);
  console.log(JSON.stringify({ phase: "search-start", dataset: options.dataset, examples: loaded.tasks.length, runDirectory: store.directory }));

  const evaluate = (plan: Parameters<WorkflowExecutor["run"]>[0]): Promise<EvaluationSummary> => {
    let scoreSum = 0;
    return loaded.evaluate(
      (task) => executor.run(plan, task),
      {
        repeats: options.repeats,
        concurrency: options.evaluationConcurrency,
        retryAttempts: 5,
        async onCase(progress) {
          scoreSum += progress.result.score;
          await store.saveLiveCase(plan.leafSearchNodeId, progress.result);
          console.log(JSON.stringify({
            phase: "validation-progress",
            planId: plan.id,
            completed: progress.completed,
            total: progress.total,
            caseId: progress.result.caseId,
            caseScore: progress.result.score,
            runningScore: scoreSum / progress.completed,
            failed: progress.result.error !== undefined,
            failureKind: progress.result.failureKind ?? null,
            at: new Date().toISOString(),
          }));
        },
      },
    );
  };
  const proposer = new NextNodeProposer(experiment.runtime, experiment.providerName, experiment.model);
  let checkpointScore = -Infinity;
  const optimizer = new NodeWorkflowSearch({
    evaluate,
    proposer,
    rounds: options.rounds,
    topK: options.topK,
    patience: options.patience,
    maxDepth: options.maximumDepth,
    seed: options.seed,
    taskGoal: taskGoal(options.dataset),
    initialInstruction: initialInstruction(options.dataset),
    callbacks: {
      async node(node, experience, plan) {
        await store.saveSearchNode(node);
        if (node.evaluation) await store.saveEvaluation(node.id, node.evaluation);
        if (experience) await store.saveExperience(experience);
        if (node.evaluation && plan && node.evaluation.score > checkpointScore) {
          checkpointScore = node.evaluation.score;
          await store.saveBest({ leaf: node, plan, nodePath: plan.nodes, validation: node.evaluation,
            stoppedBecause: "search-in-progress", exploredNodes: 0 });
        }
      },
      async event(value) {
        await store.appendEvent({ at: new Date().toISOString(), ...value });
        if (["baseline-evaluated", "parent-selected", "path-evaluated", "proposal-failed", "evaluation-failed"].includes(String(value.type))) {
          console.log(JSON.stringify({ phase: "search-progress", ...value }));
        }
      },
    },
  });

  try {
    const result = await optimizer.run();
    const validation = result.bestLeaf.evaluation;
    if (!validation) throw new Error("Best search leaf has no direct validation evaluation");
    await store.saveTreeSnapshot(result.nodes);
    await store.saveBest({
      leaf: result.bestLeaf,
      nodePath: result.bestPath.map((entry) => entry.node),
      plan: result.bestPlan,
      validation,
      stoppedBecause: result.stoppedBecause,
      exploredNodes: result.nodes.length,
    });
    Object.assign(manifest, {
      status: "frozen",
      frozenAt: new Date().toISOString(),
      best: {
        leafId: result.bestLeaf.id,
        planId: result.bestPlan.id,
        pathHash: result.bestLeaf.pathHash,
        nodeCount: result.bestPath.length,
        validationScore: validation.score,
      },
    });
    await store.writeManifest(manifest);
    console.log(JSON.stringify({
      phase: "search-complete",
      dataset: options.dataset,
      runDirectory: store.directory,
      frozenLeaf: result.bestLeaf.id,
      nodeCount: result.bestPath.length,
      validationScore: validation.score,
      next: `test --dataset ${options.dataset} --run-dir ${store.directory}`,
    }));
  } catch (error) {
    Object.assign(manifest, {
      status: "failed",
      failedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    });
    await store.writeManifest(manifest);
    throw error;
  }
}

async function testFrozen(
  options: ExperimentOptions,
  provider: ProviderSettings,
  executor: WorkflowExecutor,
): Promise<void> {
  if (!options.runDir) throw new Error("test requires --run-dir");
  const store = await RunStore.open(options.runDir);
  const manifest = await store.readManifest();
  if (manifest.model !== provider.model || manifest.endpoint !== provider.baseUrl
    || JSON.stringify(manifest.protocol) !== JSON.stringify(PROTOCOL)) {
    throw new Error("Frozen model/endpoint/protocol does not match the current test configuration");
  }
  if (manifest.status === "complete") throw new Error("Final test already exists; refusing to overwrite it");
  if (manifest.dataset !== options.dataset) {
    throw new Error(`Frozen run belongs to ${String(manifest.dataset)}, not ${options.dataset}`);
  }
  if (manifest.status !== "frozen" && manifest.status !== "complete") {
    throw new Error(`Frozen run is not ready for test: status=${String(manifest.status)}`);
  }
  const plan = await store.readBestPlan();
  const loaded = await openBenchmark(options, "test");
  const dataPath = benchmarkPath(options, "test");
  console.log(JSON.stringify({ phase: "test-start", dataset: options.dataset, examples: loaded.tasks.length, frozenPlan: plan.id }));
  let scoreSum = 0;
  const summary = await loaded.evaluate(
    (task) => executor.run(plan, task),
    {
      repeats: options.testRepeats,
      concurrency: options.evaluationConcurrency,
      retryAttempts: 5,
      async onCase(progress) {
        scoreSum += progress.result.score;
        await store.saveLiveCase("test", progress.result);
        console.log(JSON.stringify({
          phase: "test-progress",
          planId: plan.id,
          completed: progress.completed,
          total: progress.total,
          caseId: progress.result.caseId,
          caseScore: progress.result.score,
          runningScore: scoreSum / progress.completed,
          failed: progress.result.error !== undefined,
          failureKind: progress.result.failureKind ?? null,
          at: new Date().toISOString(),
        }));
      },
    },
  );
  await store.saveTest(summary);
  Object.assign(manifest, {
    status: "complete",
    completedAt: new Date().toISOString(),
    test: {
      file: basename(dataPath),
      sha256: await sha256File(dataPath),
      selectedExamples: loaded.tasks.length,
      selectedIds: loaded.tasks.map((task) => task.id),
      score: summary.score,
      repeats: summary.repeats,
      standardDeviation: summary.standardDeviation,
    },
    execution: { model: provider.model, endpoint: provider.baseUrl },
  });
  await store.writeManifest(manifest);
  console.log(JSON.stringify({ phase: "test-complete", dataset: options.dataset, examples: loaded.tasks.length, score: summary.score, runDirectory: store.directory }));
}

async function openBenchmark(options: ExperimentOptions, split: BenchmarkSplit): Promise<LoadedBenchmark> {
  if (isCodeDataset(options.dataset)) {
    const judge = new DockerPythonJudge({ image: options.dockerImage });
    await judge.preflight();
    return loadBenchmark(options.dataset, {
      dataDir: options.dataDir,
      split,
      limit: split === "validate" ? options.searchLimit : options.testLimit,
      seed: split === "validate" ? options.seed : options.seed + 1,
      codeJudge: judge,
    });
  }
  return loadBenchmark(options.dataset, {
    dataDir: options.dataDir,
    split,
    limit: split === "validate" ? options.searchLimit : options.testLimit,
    seed: split === "validate" ? options.seed : options.seed + 1,
  });
}

function benchmarkPath(options: ExperimentOptions, split: BenchmarkSplit): string {
  return join(options.dataDir, `${options.dataset}_${split}.jsonl`);
}

function isCodeDataset(dataset: DatasetName): dataset is "humaneval" | "mbpp" {
  return dataset === "humaneval" || dataset === "mbpp";
}

function metricProfile(dataset: DatasetName): string {
  switch (dataset) {
    case "drop": return "aflow-drop-token-f1-v1";
    case "humaneval": return "docker-private-tests-pass-at-1-v1";
    case "mbpp": return "docker-private-tests-pass-at-1-v1";
    case "gsm8k": return "last-number-accuracy-v1";
    case "math": return "aflow-math-exact-numeric-symbolic-v1";
  }
}

function taskGoal(dataset: DatasetName): string {
  switch (dataset) {
    case "drop": return "Search a compact Ditto Node path that answers DROP reading-comprehension questions with high token F1.";
    case "humaneval": return "Search a compact Ditto Node path that produces correct HumanEval Python functions under private tests.";
    case "mbpp": return "Search a compact Ditto Node path that produces correct MBPP Python functions under private tests.";
    case "gsm8k": return "Search a compact Ditto Node path that solves GSM8K word problems with correct final numbers.";
    case "math": return "Search a compact Ditto Node path that maximizes the frozen AFlow MATH scorer on competition problems.";
  }
}

function initialInstruction(dataset: DatasetName): string {
  switch (dataset) {
    case "drop": return "Read the passage and question carefully. Derive the shortest supported answer; finish with the answer only.";
    case "humaneval": return "Implement the requested Python function correctly for general inputs. Return one complete Python code block and no tests.";
    case "mbpp": return "Implement the requested Python function correctly for general inputs. Return one complete Python code block and no tests.";
    case "gsm8k": return "Solve the word problem step by step, verify the arithmetic, and put the final numeric answer last.";
    // AFlow round 1 calls Custom with instruction="" and the raw problem. Keep
    // Ditto's baseline objective empty; differences added by Ditto Node
    // semantics remain the intended framework variable.
    case "math": return "";
  }
}

async function dittoVersion(): Promise<string> {
  try {
    const lock = JSON.parse(await readFile(join(process.cwd(), "package-lock.json"), "utf8")) as {
      packages?: Record<string, { version?: string }>;
    };
    return lock.packages?.["node_modules/@codesoul-co/ditto"]?.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ phase: "failed", error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
