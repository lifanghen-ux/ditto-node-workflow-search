import { join } from "node:path";
import type { BenchmarkTask } from "../domain.js";
import { evaluateTasks } from "./evaluator.js";
import { MFlowMathScorer } from "./mflow-math-scorer.js";
import { readJsonLines, requireRecord, requireString, stableId } from "./io.js";
import { stratifiedSample } from "./sampling.js";
import type { BenchmarkAdapter, BenchmarkEvaluationOptions, BenchmarkLoadOptions, BenchmarkRunner, LoadedBenchmark } from "./types.js";

// Common, answer-independent termination guidance validated after observed output loops.
export const MATH_TERMINATION_GUIDANCE = "Solve the problem directly. Present each calculation or case only once. Do not add self-checks, alternative interpretations, or repeated verification after completing the solution. End with the final answer.";

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
          // IDs and frozen data retain the original problem bytes. All candidate
          // Nodes receive the same guidance; this is a repaired prompt protocol.
          prompt: `${MATH_TERMINATION_GUIDANCE}\n\n${prompt}`,
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
      const scorer = new MFlowMathScorer(references);
      await scorer.preflight();
      return evaluateTasks(tasks, scorer, runner, options);
    },
  });
}
