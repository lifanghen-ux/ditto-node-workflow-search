import { join } from "node:path";
import type { BenchmarkTask } from "../domain.js";
import { evaluateTasks } from "./evaluator.js";
import { AFlowMathScorer } from "./aflow-math-scorer.js";
import { readJsonLines, requireRecord, requireString, stableId } from "./io.js";
import { stratifiedSample } from "./sampling.js";
import type { BenchmarkAdapter, BenchmarkEvaluationOptions, BenchmarkLoadOptions, BenchmarkRunner, LoadedBenchmark } from "./types.js";

interface MathRow {
  readonly task: BenchmarkTask;
  readonly solution: string;
}

export const mathAdapter: BenchmarkAdapter = Object.freeze({
  dataset: "math",
  async load(options: BenchmarkLoadOptions): Promise<LoadedBenchmark> {
    const path = join(options.dataDir, `math_${options.split}.jsonl`);
    const rows = await readJsonLines(path, (value, row): MathRow => {
      const raw = requireRecord(value, path, row);
      const prompt = requireString(raw.problem, "problem", path, row);
      const solution = requireString(raw.solution, "solution", path, row);
      const level = typeof raw.level === "string" ? raw.level : "unknown";
      const type = typeof raw.type === "string" ? raw.type : "unknown";
      return Object.freeze({
        task: Object.freeze({
          id: `math:${options.split}:${row}:${stableId("problem", prompt).slice(-16)}`,
          dataset: "math",
          prompt,
          // AFlow's initial MATH workflow supplies the raw problem with no
          // additional answer-format instruction. Its scorer handles boxed and
          // final-sentence answers, so Ditto must not receive a stricter prompt.
          outputInstruction: "",
          metadata: Object.freeze({ split: options.split, level, type }),
        }),
        solution,
      });
    });
    const selected = stratifiedSample(rows, options.limit ?? 0, options.seed ?? 42, (row) => `${row.task.metadata.type}:${row.task.metadata.level}`);
    return loadedMath(options.split, selected);
  },
});

function loadedMath(split: "validate" | "test", rows: readonly MathRow[]): LoadedBenchmark {
  const references = new Map(rows.map((row) => [row.task.id, row.solution]));
  const tasks = Object.freeze(rows.map((row) => row.task));
  return Object.freeze({
    dataset: "math",
    split,
    tasks,
    async evaluate(runner: BenchmarkRunner, options?: BenchmarkEvaluationOptions) {
      const scorer = new AFlowMathScorer(references);
      try {
        await scorer.preflight();
        return await evaluateTasks(tasks, scorer, runner, options);
      } finally {
        await scorer.close();
      }
    },
  });
}
