import type { AgentRunResult, BenchmarkTask, CaseResult, EvaluationSummary } from "../domain.js";
import type { BenchmarkEvaluationOptions, BenchmarkRunner, PrivateScorer } from "./types.js";

export async function evaluateTasks(
  tasks: readonly BenchmarkTask[],
  scorer: PrivateScorer,
  runner: BenchmarkRunner,
  options: BenchmarkEvaluationOptions = {},
): Promise<EvaluationSummary> {
  const repeats = options.repeats ?? 1;
  const concurrency = options.concurrency ?? 1;
  const retryAttempts = options.retryAttempts ?? 5;
  if (!Number.isInteger(repeats) || repeats < 1) throw new Error("Evaluation repeats must be a positive integer");
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("Evaluation concurrency must be a positive integer");
  if (!Number.isInteger(retryAttempts) || retryAttempts < 1) throw new Error("Retry attempts must be a positive integer");

  const started = Date.now();
  const results: CaseResult[] = [];
  const repeatScores: number[] = [];
  const total = tasks.length * repeats;
  let completed = 0;
  for (let repeat = 0; repeat < repeats; repeat++) {
    const current = await mapLimit(tasks, concurrency, async (task) => {
      const result = await evaluateOne(task, repeat, scorer, runner, retryAttempts);
      completed++;
      await options.onCase?.({ completed, total, result });
      return result;
    });
    results.push(...current);
    repeatScores.push(mean(current.map((result) => result.score)));
  }
  return Object.freeze({
    repeatScores: Object.freeze(repeatScores),
    score: mean(repeatScores),
    standardDeviation: standardDeviation(repeatScores),
    repeats,
    examples: tasks.length,
    successfulRuns: results.filter((result) => result.error === undefined).length,
    failedRuns: results.filter((result) => result.error !== undefined).length,
    timeoutRuns: results.filter((result) => result.failureKind === "timeout").length,
    wrongRuns: results.filter((result) => result.error === undefined && result.score === 0).length,
    inputTokens: sum(results.map((result) => result.inputTokens)),
    outputTokens: sum(results.map((result) => result.outputTokens)),
    totalTokens: sum(results.map((result) => result.totalTokens)),
    durationMs: Date.now() - started,
    results: Object.freeze(results),
  });
}

async function evaluateOne(
  task: BenchmarkTask,
  repeat: number,
  scorer: PrivateScorer,
  runner: BenchmarkRunner,
  retryAttempts: number,
): Promise<CaseResult> {
  const started = Date.now();
  let run: AgentRunResult;
  try {
    run = await retryWorkflow(() => runner(task), retryAttempts);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Object.freeze({
      caseId: `${task.id}#${repeat + 1}`,
      score: 0,
      expected: scorer.expectedLabel(task.id),
      prediction: "",
      normalizedExpected: "",
      normalizedPrediction: "",
      method: "evaluation-error",
      latencyMs: Date.now() - started,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      failureKind: classifyFailure(message),
      error: message,
    });
  }

  // A broken scorer invalidates the experiment; it must never become a model zero.
  const evidence = await scorer.score(task.id, run.answer);
  return Object.freeze({
    caseId: `${task.id}#${repeat + 1}`,
    ...evidence,
    latencyMs: Date.now() - started,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    totalTokens: run.totalTokens,
  });
}

/** AFlow retries the complete graph for every exception, five attempts, one second apart. */
async function retryWorkflow<T>(operation: () => Promise<T>, attempts: number): Promise<T> {
  let latest: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      latest = error;
      if (attempt === attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  throw latest;
}

function classifyFailure(message: string): NonNullable<CaseResult["failureKind"]> {
  if (/(?:\[TIMEOUT\]|deadline exceeded|timed out|ETIMEDOUT)/i.test(message)) return "timeout";
  if (/(?:HTTP (?:408|409|425|429|5\d\d)|ECONNRESET|fetch failed)/i.test(message)) return "provider";
  if (/(?:private tests|Docker judge|Python evaluation)/i.test(message)) return "judge";
  return "execution";
}

async function mapLimit<T, R>(values: readonly T[], concurrency: number, operation: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = cursor++;
      if (index >= values.length) return;
      results[index] = await operation(values[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function mean(values: readonly number[]): number {
  return values.length ? sum(values) / values.length : 0;
}

function standardDeviation(values: readonly number[]): number {
  const average = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
}
