import { join } from "node:path";
import type { BenchmarkTask, ScoreEvidence } from "../domain.js";
import { evaluateTasks } from "./evaluator.js";
import { readJsonLines, requireRecord, requireString, stableId } from "./io.js";
import { lengthBucket, stratifiedSample } from "./sampling.js";
import { scoreDropAnswer } from "./text-scores.js";
import type { BenchmarkAdapter, BenchmarkEvaluationOptions, BenchmarkLoadOptions, BenchmarkRunner, LoadedBenchmark, PrivateScorer } from "./types.js";

interface DropRow {
  readonly task: BenchmarkTask;
  readonly reference: string;
}

export const dropAdapter: BenchmarkAdapter = Object.freeze({
  dataset: "drop",
  async load(options: BenchmarkLoadOptions): Promise<LoadedBenchmark> {
    const path = join(options.dataDir, `drop_${options.split}.jsonl`);
    const rows = await readJsonLines(path, (value, row): DropRow => {
      const raw = requireRecord(value, path, row);
      const prompt = requireString(raw.context, "context", path, row);
      const reference = requireString(raw.ref_text, "ref_text", path, row);
      const sourceId = typeof raw.id === "string" || typeof raw.id === "number" ? String(raw.id) : stableId("row", prompt);
      return Object.freeze({
        task: Object.freeze({
          id: `drop:${options.split}:${sourceId}`,
          dataset: "drop",
          prompt,
          outputInstruction: "Return only the shortest answer supported by the passage. Use | only for genuinely alternative answers.",
          metadata: Object.freeze({ split: options.split, sourceId, lengthBucket: lengthBucket(prompt.length) }),
        }),
        reference,
      });
    });
    const selected = stratifiedSample(rows, options.limit ?? 0, options.seed ?? 42, (row) => String(row.task.metadata.lengthBucket));
    return loadedDrop(options.split, selected);
  },
});

function loadedDrop(split: "validate" | "test", rows: readonly DropRow[]): LoadedBenchmark {
  const references = new Map(rows.map((row) => [row.task.id, row.reference]));
  const tasks = Object.freeze(rows.map((row) => row.task));
  const scorer: PrivateScorer = {
    async score(taskId, prediction): Promise<ScoreEvidence> {
      return scoreDropAnswer(referenceFor(references, taskId), prediction);
    },
    expectedLabel(taskId): string {
      return referenceFor(references, taskId);
    },
  };
  return Object.freeze({
    dataset: "drop",
    split,
    tasks,
    evaluate: (runner: BenchmarkRunner, options?: BenchmarkEvaluationOptions) => evaluateTasks(tasks, scorer, runner, options),
  });
}

function referenceFor(references: ReadonlyMap<string, string>, taskId: string): string {
  const reference = references.get(taskId);
  if (reference === undefined) throw new Error(`Unknown DROP task: ${taskId}`);
  return reference;
}
