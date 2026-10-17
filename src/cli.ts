import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { pythonExecutionIdentity } from "./run/python-identity.js";
import { currentExecutionIdentity, assertExecutionIdentity } from "./run/execution-identity.js";
import { OrganizationProposer, OrganizationWorkflowSearch } from "./search/organization-search.js";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { DockerPythonJudge, loadBenchmark, sha256File, automationIdentity } from "./benchmark/index.js";
import type { BenchmarkSplit, LoadedBenchmark } from "./benchmark/types.js";
import { loadProviderSettings, parseArguments, type ExperimentOptions, type ProviderSettings } from "./config.js";
import type { DatasetName, EvaluationSummary } from "./domain.js";
import { createExperimentRuntime, type ExperimentRuntime } from "./ditto/runtime.js";
import { NodeWorkflowSearch } from "./search/optimizer.js";
import { NextNodeProposer } from "./search/proposer.js";
import { RunStore } from "./run/store.js";
import { CaseRecovery, displayScore, evaluationCodeHash } from "./run/case-recovery.js";
import { assertValidEvaluation } from "./search/backprop.js";
import { loadHistoricalResume } from "./run/resume.js";
import { WorkflowExecutor } from "./workflow/executor.js";
import { GENERATION, PROTOCOL } from "./protocol.js";

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const provider = Object.freeze({ ...loadProviderSettings(),
    concurrency: options.command === "search" ? options.searchProviderConcurrency : options.testProviderConcurrency });
  const experiment = createExperimentRuntime(provider, { profile: options.dataset === "automationbench" ? "automationbench" : "math" });
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
  const executionIdentity = { ...await currentExecutionIdentity(process.cwd()), python: await pythonExecutionIdentity(options.dataset), providerTimeoutMs: provider.timeoutMs };
  const codeSha256 = executionIdentity.source;
  const store = await RunStore.create(options.outputRoot, options.dataset);
  const loaded = await openBenchmark(options, "validate", store.directory);
  const automation = options.dataset === "automationbench" ? await automationIdentity() : undefined;
  const dataPath = benchmarkPath(options, "validate");
  const restored = options.resumeDir ? await loadHistoricalResume(options.resumeDir, options.resumeRound!, codeSha256) : undefined;
  if (restored) {
    const prior = restored.manifest;
    assertExecutionIdentity(prior.executionIdentity, executionIdentity);
    if (automation && JSON.stringify(prior.automation) !== JSON.stringify(automation)) throw new Error("Resume AutomationBench source/environment/scorer identity differs");
    const priorSearch = prior.search as Record<string, unknown>;
    const expected = { rounds: options.rounds, repeats: options.repeats, testRepeats: options.testRepeats,
      topK: options.topK, convergenceConsecutiveRounds: options.patience, maximumDepth: options.maximumDepth, seed: options.seed };
    if (prior.model !== provider.model || prior.endpoint !== provider.baseUrl || prior.dataset !== options.dataset
      || prior.metricProfile !== metricProfile(options.dataset) || JSON.stringify(prior.protocol) !== JSON.stringify(PROTOCOL)
      || JSON.stringify(prior.generation) !== JSON.stringify(GENERATION) || prior.dittoVersion !== await dittoVersion()
      || (prior.data as { sha256: string }).sha256 !== await sha256File(dataPath)
      || JSON.stringify((prior.data as { selectedIds: string[] }).selectedIds) !== JSON.stringify(loaded.tasks.map(task => task.id))
      || Object.entries(expected).some(([key, value]) => priorSearch[key] !== value)) throw new Error("Resume model/data/search settings differ from the frozen experiment");
  }
  const manifest: Record<string, unknown> = {
    schemaVersion: 3,
    executionIdentity,
    frozenTestDataSha256: await sha256File(benchmarkPath(options, "test")),
    testSettings: { repeats: options.testRepeats, limit: options.testLimit, seed: options.seed + 1 },
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
    independentRoundTests: { checkpointDirectory: "checkpoints", resultsUsedBySearch: false },
    generation: GENERATION,
    protocol: PROTOCOL,
    ...(automation ? { automation } : {}),
    ...(restored ? { resumedFrom: { directory: options.resumeDir, completedSearchRounds: restored.state.completedRounds,
      discardedIncompleteRound: restored.state.completedRounds + 1, originalProviderConcurrency: restored.manifest.providerConcurrency } } : {}),
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
  manifest.evaluationCodeSha256 = codeSha256;
  await store.writeManifest(manifest);
  console.log(JSON.stringify({ phase: "search-start", dataset: options.dataset, examples: loaded.tasks.length, runDirectory: store.directory }));

  const evaluate = async (plan: Parameters<WorkflowExecutor["run"]>[0]): Promise<EvaluationSummary> => {
    assertExecutionIdentity(executionIdentity, { ...await currentExecutionIdentity(process.cwd()), python: await pythonExecutionIdentity(options.dataset), providerTimeoutMs: provider.timeoutMs });
    // Publish locally before validation. A separate process consumes these
    // files; no test score or test completion enters this search process.
    await store.saveCheckpoint(plan);
    const recovery = await CaseRecovery.open(join(options.outputRoot, ".case-checkpoints", options.dataset), {
      schemaVersion: 1, plan, codeSha256, data: manifest.data,
      metricProfile: manifest.metricProfile, protocol: PROTOCOL, generation: GENERATION,
      ...(automation ? { automation } : {}),
      dittoVersion: manifest.dittoVersion, nodeVersion: process.version,
      model: provider.model, endpoint: provider.baseUrl, timeoutMs: provider.timeoutMs,
      repeats: options.repeats, scorerPython: process.env.MATH_SCORER_PYTHON || process.env.AFLOW_SCORER_PYTHON || "python",
      dockerImage: options.dockerImage,
    }, {
      providerConcurrency: provider.concurrency, evaluationConcurrency: options.evaluationConcurrency,
    });
    const recoveryRecord = { type: "case-recovery", planId: plan.id, identity: recovery.identity,
      recoveredValidCases: recovery.priorCases.filter(value => value.valid === true).length,
      originalOperations: recovery.originalOperations, currentOperations: recovery.currentOperations };
    await store.appendEvent(recoveryRecord);
    const caseRecoveries = (manifest.caseRecoveries ?? []) as unknown[];
    caseRecoveries.push(recoveryRecord);
    manifest.caseRecoveries = caseRecoveries;
    await store.writeManifest(manifest);
    let scoreSum = 0;
    let scoringValid = true;
    const summary = await loaded.evaluate(
      (task) => executor.run(plan, task),
      {
        repeats: options.repeats,
        concurrency: options.evaluationConcurrency,
        retryAttempts: 5,
        priorCases: recovery.priorCases,
        async onCase(progress) {
          scoreSum += progress.result.score;
          scoringValid &&= progress.result.valid === true;
          const runningScore = displayScore(scoringValid, scoreSum / progress.completed);
          await recovery.record(progress.result);
          await store.saveLiveCase(plan.leafSearchNodeId, progress.result);
          console.log(JSON.stringify({
            phase: "validation-progress",
            planId: plan.id,
            completed: progress.completed,
            total: progress.total,
            caseId: progress.result.caseId,
            caseScore: displayScore(progress.result.valid === true, progress.result.score),
            runningScore,
            valid: progress.result.valid,
            failed: progress.result.error !== undefined,
            failureKind: progress.result.failureKind ?? null,
            at: new Date().toISOString(),
          }));
        },
      },
    );
    assertExecutionIdentity(executionIdentity, { ...await currentExecutionIdentity(process.cwd()), python: await pythonExecutionIdentity(options.dataset), providerTimeoutMs: provider.timeoutMs });
    await recovery.finish(summary.valid === true);
    return summary;
  };
  const proposer = new NextNodeProposer(experiment.runtime, experiment.providerName, experiment.model);
  let checkpointScore = -Infinity;
  const searchOptions = {
    evaluate,
    proposer,
    rounds: options.rounds,
    topK: options.topK,
    patience: options.patience,
    maxDepth: options.maximumDepth,
    seed: options.seed,
    taskGoal: taskGoal(options.dataset),
    initialInstruction: initialInstruction(options.dataset),
    ...(restored ? { resume: restored.state } : {}),
    callbacks: {
      async node(node: import("./domain.js").SearchTreeNode, experience: import("./domain.js").SearchExperience | null, plan?: import("./domain.js").AgentPlanSpec) {
        await store.saveSearchNode(node);
        if (node.evaluation) await store.saveEvaluation(node.id, node.evaluation);
        if (node.evaluation && plan) await store.saveCheckpoint(plan);
        if (experience) await store.saveExperience(experience);
        if (node.evaluation && node.evaluation.valid !== false && node.evaluation.failedRuns === 0
          && plan && node.evaluation.score > checkpointScore) {
          checkpointScore = node.evaluation.score;
          await store.saveBest({ leaf: node, plan, nodePath: plan.nodes, validation: node.evaluation,
            stoppedBecause: "search-in-progress", exploredNodes: 0 });
        }
      },
      async event(value: Readonly<Record<string, unknown>>) {
        await store.appendEvent({ at: new Date().toISOString(), ...value });
        if (["search-resumed", "baseline-evaluated", "parent-selected", "path-evaluated", "proposal-failed", "evaluation-failed"].includes(String(value.type))) {
          console.log(JSON.stringify({ phase: "search-progress", ...value }));
        }
      },
      async state(value: import("./search/optimizer.js").SearchResumeState) { await store.saveResumeState(value); },
    },
  };
  const optimizer = options.dataset === "math" || options.dataset === "automationbench"
    ? new OrganizationWorkflowSearch({ ...searchOptions, dataset: options.dataset, proposer: new OrganizationProposer(experiment.runtime, { provider: experiment.providerName, model: experiment.model }) })
    : new NodeWorkflowSearch(searchOptions);

  try {
    const result = await optimizer.run();
    const validation = result.bestLeaf.evaluation;
    if (!validation) throw new Error("Best search leaf has no direct validation evaluation");
    assertValidEvaluation(validation);
    await store.saveTreeSnapshot(result.nodes);
    await store.saveBest({
      leaf: result.bestLeaf,
      nodePath: result.bestPlan.nodes,
      plan: result.bestPlan,
      validation,
      stoppedBecause: result.stoppedBecause,
      exploredNodes: result.nodes.length,
    });
    assertExecutionIdentity(executionIdentity, { ...await currentExecutionIdentity(process.cwd()), python: await pythonExecutionIdentity(options.dataset), providerTimeoutMs: provider.timeoutMs });
    Object.assign(manifest, {
      status: "frozen",
      frozenAt: new Date().toISOString(),
      best: {
        leafId: result.bestLeaf.id,
        planId: result.bestPlan.id,
        pathHash: result.bestLeaf.pathHash,
        planSha256: planHash(result.bestPlan),
        nodeCount: result.bestPlan.nodes.length,
        validationScore: validation.score,
      },
    });
    await store.writeManifest(manifest);
    console.log(JSON.stringify({
      phase: "search-complete",
      dataset: options.dataset,
      runDirectory: store.directory,
      frozenLeaf: result.bestLeaf.id,
      nodeCount: result.bestPlan.nodes.length,
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
  const executionIdentity = { ...await currentExecutionIdentity(process.cwd()), python: await pythonExecutionIdentity(options.dataset), providerTimeoutMs: provider.timeoutMs };
  assertExecutionIdentity(manifest.executionIdentity, executionIdentity);
  if (!isDeepStrictEqual(manifest.generation, GENERATION) || manifest.dittoVersion !== executionIdentity.dittoVersion || manifest.metricProfile !== metricProfile(options.dataset)) throw new Error("Frozen generation/scorer/dependency differs");
  if (options.dataset === "automationbench" && JSON.stringify(manifest.automation) !== JSON.stringify(await automationIdentity())) throw new Error("Frozen AutomationBench source/environment/scorer identity differs");
  if (manifest.model !== provider.model || manifest.endpoint !== provider.baseUrl
    || JSON.stringify(manifest.protocol) !== JSON.stringify(PROTOCOL)) {
    throw new Error("Frozen model/endpoint/protocol does not match the current test configuration");
  }
  if (manifest.status === "complete") throw new Error("Final test already exists; refusing to overwrite it");
  if (manifest.dataset !== options.dataset) {
    throw new Error(`Frozen run belongs to ${String(manifest.dataset)}, not ${options.dataset}`);
  }
  if (!["frozen", "test-running", "test-failed"].includes(String(manifest.status))) {
    throw new Error(`Frozen run is not ready for test: status=${String(manifest.status)}`);
  }
  if (!isDeepStrictEqual(manifest.testSettings, { repeats: options.testRepeats, limit: options.testLimit, seed: options.seed + 1 })) throw new Error("Test repeats/selection differ from the frozen protocol");
  const plan = await store.readBestPlan();
  if ((manifest.best as { planSha256?: string })?.planSha256 !== planHash(plan)) throw new Error("Frozen workflow changed after search");
  const frozenTestHash = await sha256File(benchmarkPath(options, "test"));
  if (manifest.frozenTestDataSha256 !== frozenTestHash) throw new Error("Test split changed after search");
  const loaded = await openBenchmark(options, "test", store.directory);
  const dataPath = benchmarkPath(options, "test");
  const recovery = await CaseRecovery.open(join(store.directory, "test", "recovery"), {
    stage: "frozen-test", executionIdentity, plan, model: provider.model, endpoint: provider.baseUrl,
    testDataHash: frozenTestHash, selectedIds: loaded.tasks.map(task => task.id), repeats: options.testRepeats,
  });
  Object.assign(manifest, { status: "test-running", execution: { executionIdentity, planSha256: planHash(plan) } });
  await store.writeManifest(manifest);
  console.log(JSON.stringify({ phase: "test-start", dataset: options.dataset, examples: loaded.tasks.length, frozenPlan: plan.id }));
  let scoreSum = 0;
  let scoringValid = true;
  const summary = await loaded.evaluate(
    (task) => executor.run(plan, task),
    {
      repeats: options.testRepeats,
      concurrency: options.evaluationConcurrency,
      retryAttempts: 5,
      priorCases: recovery.priorCases,
      async onCase(progress) {
        scoreSum += progress.result.score;
        scoringValid &&= progress.result.valid === true;
        const runningScore = displayScore(scoringValid, scoreSum / progress.completed);
        await recovery.record(progress.result);
        await store.saveLiveCase("test", progress.result);
        console.log(JSON.stringify({
          phase: "test-progress",
          planId: plan.id,
          completed: progress.completed,
          total: progress.total,
          caseId: progress.result.caseId,
          caseScore: displayScore(progress.result.valid === true, progress.result.score),
          runningScore,
          valid: progress.result.valid,
          failed: progress.result.error !== undefined,
          failureKind: progress.result.failureKind ?? null,
          at: new Date().toISOString(),
        }));
      },
    },
  );
  assertExecutionIdentity(executionIdentity, { ...await currentExecutionIdentity(process.cwd()), python: await pythonExecutionIdentity(options.dataset), providerTimeoutMs: provider.timeoutMs });
  await recovery.finish(summary.valid === true);
  await store.saveTest(summary);
  Object.assign(manifest, {
    status: summary.valid === true ? "complete" : "test-failed",
    completedAt: new Date().toISOString(),
    test: {
      file: basename(dataPath),
      sha256: await sha256File(dataPath),
      selectedExamples: loaded.tasks.length,
      selectedIds: loaded.tasks.map((task) => task.id),
      score: displayScore(summary.valid === true, summary.score),
      valid: summary.valid,
      repeats: summary.repeats,
      standardDeviation: summary.standardDeviation,
    },
    execution: { model: provider.model, endpoint: provider.baseUrl, executionIdentity, planSha256: planHash(plan) },
  });
  await store.writeManifest(manifest);
  console.log(JSON.stringify({ phase: summary.valid === true ? "test-complete" : "test-invalid", dataset: options.dataset,
    examples: loaded.tasks.length, score: displayScore(summary.valid === true, summary.score), runDirectory: store.directory }));
  assertValidEvaluation(summary);
}

async function openBenchmark(options: ExperimentOptions, split: BenchmarkSplit, artifactDir: string): Promise<LoadedBenchmark> {
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
    artifactDir,
  });
}

function benchmarkPath(options: ExperimentOptions, split: BenchmarkSplit): string {
  if (options.dataset === "automationbench") return join(options.dataDir, split === "validate" ? "search.jsonl" : "test.jsonl");
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
    case "math": return "mflow-math-verify-0.9.0";
    case "automationbench": return "automationbench-official-assertions-v1";
  }
}

function taskGoal(dataset: DatasetName): string {
  switch (dataset) {
    case "drop": return "Search a compact Ditto Node path that answers DROP reading-comprehension questions with high token F1.";
    case "humaneval": return "Search a compact Ditto Node path that produces correct HumanEval Python functions under private tests.";
    case "mbpp": return "Search a compact Ditto Node path that produces correct MBPP Python functions under private tests.";
    case "gsm8k": return "Search a compact Ditto Node path that solves GSM8K word problems with correct final numbers.";
    case "math": return "Search a compact Ditto Node path that maximizes mathematical answer accuracy on competition problems.";
    case "automationbench": return "Search the complete node organization including reasoning, tool dispatch, observation, context feedback and termination. Tool capabilities and grading are fixed.";
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
    case "automationbench": return "Prepare a concrete tool-use plan for the following task. Planning does not perform actions; an execution stage will use the official APIs afterward.\n\n";
  }
}

function planHash(plan: unknown): string { return createHash("sha256").update(JSON.stringify(plan)).digest("hex"); }

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
