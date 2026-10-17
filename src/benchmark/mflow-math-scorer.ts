import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ScoreEvidence } from "../domain.js";
import type { PrivateScorer } from "./types.js";

const script = fileURLToPath(new URL("../../scripts/mflow_math_scorer.py", import.meta.url));
let active = 0;
const queue: Array<() => void> = [];

/** Same parse/verify defaults and preprocessing as MFlow 437040f1; no fallback. */
export class MFlowMathScorer implements PrivateScorer {
  constructor(readonly references: ReadonlyMap<string, string>) {}

  async preflight(): Promise<void> {
    const entry = this.references.entries().next().value;
    if (!entry || (await this.score(entry[0], entry[1])).score !== 1) {
      throw new Error("MFlow MATH scorer failed its startup self-test");
    }
  }

  async score(taskId: string, prediction: string): Promise<ScoreEvidence> {
    const gold = this.expectedLabel(taskId);
    if (active >= 4) await new Promise<void>((resolve) => queue.push(resolve));
    else active++;
    try {
      const python = process.env.MATH_SCORER_PYTHON || process.env.AFLOW_SCORER_PYTHON || "python";
      const stdout = await new Promise<string>((resolve, reject) => {
        const child = execFile(python, [script], {
          timeout: 30_000, windowsHide: true,
          env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|TOKEN|SECRET|PASSWORD/i.test(key))), PYTHONIOENCODING: "utf-8" },
        }, (error, output) => error ? reject(error) : resolve(output));
        // Keep arbitrarily long valid predictions out of Windows' command line.
        child.stdin!.on("error", (error) => { child.kill(); reject(error); });
        child.stdin!.end(JSON.stringify({ gold, answer: prediction }), "utf8");
      });
      if (!/^[01]$/.test(stdout.trim())) throw new Error("MATH scorer returned invalid output");
      return Object.freeze({ score: Number(stdout.trim()), expected: gold, prediction,
        normalizedExpected: "", normalizedPrediction: "", method: "mflow-math-verify-0.9.0",
        details: { mflowRevision: "437040f17a17cbf430f3f41227ca64c576cf1056", windowsTimeout: "external-process-30s" },
      });
    } finally {
      const next = queue.shift();
      if (next) next(); else active--;
    }
  }

  expectedLabel(taskId: string): string {
    const value = this.references.get(taskId);
    if (value === undefined) throw new Error(`Unknown MATH task: ${taskId}`);
    return value;
  }
}
