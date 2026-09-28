import type {
  AgentRunResult,
  BenchmarkTask,
  DatasetName,
  EvaluationSummary,
  ScoreEvidence,
} from "../domain.js";

export type BenchmarkSplit = "validate" | "test";

/** A workflow runner receives public problem material only. */
export type BenchmarkRunner = (task: BenchmarkTask) => Promise<AgentRunResult>;

export interface BenchmarkLoadOptions {
  readonly dataDir: string;
  readonly split: BenchmarkSplit;
  /** Zero means the complete split. */
  readonly limit?: number;
  readonly seed?: number;
  readonly codeJudge?: CodeJudge;
}

export interface BenchmarkEvaluationOptions {
  readonly repeats?: number;
  readonly concurrency?: number;
  readonly retryAttempts?: number;
}

/**
 * Gold answers and executable tests are deliberately absent. Evaluation is a
 * closure over a private reference map created while loading the split.
 */
export interface LoadedBenchmark {
  readonly dataset: DatasetName;
  readonly split: BenchmarkSplit;
  readonly tasks: readonly BenchmarkTask[];
  evaluate(runner: BenchmarkRunner, options?: BenchmarkEvaluationOptions): Promise<EvaluationSummary>;
}

export interface BenchmarkAdapter {
  readonly dataset: DatasetName;
  load(options: BenchmarkLoadOptions): Promise<LoadedBenchmark>;
}

export interface PrivateScorer {
  score(taskId: string, prediction: string): Promise<ScoreEvidence>;
  expectedLabel(taskId: string): string;
}

export interface CodeJudgeRequest {
  readonly dataset: "humaneval" | "mbpp";
  readonly taskId: string;
  readonly entryPoint: string;
  readonly candidate: string;
  readonly testSource: string;
  readonly testImports: readonly string[];
}

export interface CodeJudgeResult {
  readonly passed: boolean;
  readonly diagnostics: string;
  readonly durationMs: number;
}

export interface CodeJudge {
  judge(request: CodeJudgeRequest, signal?: AbortSignal): Promise<CodeJudgeResult>;
}
