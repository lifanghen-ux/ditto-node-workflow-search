import { join } from "node:path";
import type { BenchmarkTask, ScoreEvidence } from "../domain.js";
import { evaluateTasks } from "./evaluator.js";
import { readJsonLines, requireRecord, requireString, stableId } from "./io.js";
import { lengthBucket, stratifiedSample } from "./sampling.js";
import { scoreGsm8kAnswer } from "./text-scores.js";
import type { BenchmarkAdapter, BenchmarkEvaluationOptions, BenchmarkLoadOptions, BenchmarkRunner, LoadedBenchmark, PrivateScorer } from "./types.js";

interface Gsm8kRow {
  readonly task: BenchmarkTask;
  readonly reference: string;
}

export const gsm8kAdapter: BenchmarkAdapter = Object.freeze({
  dataset: "gsm8k",
  async load(options: BenchmarkLoadOptions): Promise<LoadedBenchmark> {
    const path = join(options.dataDir, `gsm8k_${options.split}.jsonl`);
    const rows = await readJsonLines(path, (value, row): Gsm8kRow => {
      const raw = requireRecord(value, path, row);
      const prompt = requireString(raw.question, "question", path, row);
      const reference = requireString(raw.answer, "answer", path, row);
      const sourceId = typeof raw.id === "string" || typeof raw.id === "number" ? String(raw.id) : stableId("row", prompt);
      return Object.freeze({
        task: Object.freeze({
          id: `gsm8k:${options.split}:${sourceId}`,
          dataset: "gsm8k",
          prompt,
          outputInstruction: "Solve the word problem and put the final numeric answer at the end of the response.",
          metadata: Object.freeze({ split: options.split, sourceId, lengthBucket: lengthBucket(prompt.length) }),
        }),
        reference,
      });
    });
    const selected = stratifiedSample(rows, options.limit ?? 0, options.seed ?? 42, (row) => String(row.task.metadata.lengthBucket));
    return loadedGsm8k(options.split, selected);
  },
});

function loadedGsm8k(split: "validate" | "test", rows: readonly Gsm8kRow[]): LoadedBenchmark {
  const references = new Map(rows.map((row) => [row.task.id, row.reference]));
  const tasks = Object.freeze(rows.map((row) => row.task));
  const scorer: PrivateScorer = {
    async score(taskId, prediction): Promise<ScoreEvidence> {
      return scoreGsm8kAnswer(referenceFor(references, taskId), prediction);
    },
    expectedLabel(taskId): string {
      return referenceFor(references, taskId);
    },
  };
  return Object.freeze({
    dataset: "gsm8k",
    split,
    tasks,
    evaluate: (runner: BenchmarkRunner, options?: BenchmarkEvaluationOptions) => evaluateTasks(tasks, scorer, runner, options),
  });
}

function referenceFor(references: ReadonlyMap<string, string>, taskId: string): string {
  const reference = references.get(taskId);
  if (reference === undefined) throw new Error(`Unknown GSM8K task: ${taskId}`);
  return reference;
}
