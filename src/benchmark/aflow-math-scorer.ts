import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { ScoreEvidence } from "../domain.js";
import { scoreMathAnswer, type MathScore } from "./math-score.js";
import type { PrivateScorer } from "./types.js";

interface ScorerResponse {
  readonly id: number | null;
  readonly score?: 0 | 1;
  readonly expected?: string;
  readonly prediction?: string;
  readonly equivalence?: "exact" | "numeric" | "symbolic" | "none";
  readonly extraction?: "boxed" | "last-sentence";
  readonly error?: string;
  readonly sourceHash?: string;
}

interface PendingScore {
  readonly rawPrediction: string;
  readonly normalized: MathScore;
  readonly resolve: (evidence: ScoreEvidence) => void;
  readonly reject: (error: Error) => void;
}

/** One persistent SymPy process per candidate evaluation; no per-case spawn cost. */
export class AFlowMathScorer implements PrivateScorer {
  readonly #references: ReadonlyMap<string, string>;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<number, PendingScore>();
  readonly #exit: Promise<void>;
  #failure: Error | undefined;
  #nextId = 1;
  #stderr = "";
  #closed = false;
  readonly #normalizedFallback: boolean;

  constructor(references: ReadonlyMap<string, string>, options: { readonly normalizedFallback?: boolean } = {}) {
    this.#references = references;
    this.#normalizedFallback = options.normalizedFallback ?? true;
    const python = process.env.AFLOW_SCORER_PYTHON?.trim() || "python";
    const script = fileURLToPath(new URL("../../scripts/aflow_math_scorer.py", import.meta.url));
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/KEY|TOKEN|SECRET|PASSWORD/i.test(name))),
      PYTHONIOENCODING: "utf-8",
    };
    this.#child = spawn(python, ["-u", script], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env });
    this.#child.stdin.on("error", (error) => this.#failPending(error));
    this.#child.stdout.setEncoding("utf8");
    this.#child.stderr.setEncoding("utf8");
    this.#child.stderr.on("data", (chunk: string) => {
      this.#stderr = (this.#stderr + chunk).slice(-4_000);
    });
    createInterface({ input: this.#child.stdout }).on("line", (line) => this.#receive(line));
    this.#exit = new Promise<void>((resolve, reject) => {
      this.#child.once("error", (error) => {
        this.#failPending(error);
        reject(error);
      });
      this.#child.once("close", (code) => {
        const error = code === 0
          ? undefined
          : new Error(`AFlow MATH scorer exited with code ${String(code)}${this.#stderr ? `: ${this.#stderr}` : ""}`);
        if (error) this.#failPending(error);
        else if (this.#pending.size) this.#failPending(new Error("AFlow MATH scorer exited before returning all scores"));
        if (error) reject(error);
        else resolve();
      });
    });
    void this.#exit.catch(() => undefined);
  }

  async preflight(): Promise<void> {
    const entry = this.#references.keys().next().value;
    if (entry === undefined) throw new Error("MATH split is empty");
    const evidence = await this.score(entry, referenceFor(this.#references, entry));
    if (evidence.score !== 1) throw new Error("AFlow scorer failed its startup self-test");
  }

  score(taskId: string, prediction: string): Promise<ScoreEvidence> {
    if (this.#closed) return Promise.reject(new Error("AFlow MATH scorer is closed"));
    if (this.#failure) return Promise.reject(this.#failure);
    const reference = referenceFor(this.#references, taskId);
    const normalized = scoreMathAnswer(reference, prediction);
    const id = this.#nextId++;
    return new Promise<ScoreEvidence>((resolve, reject) => {
      this.#pending.set(id, { rawPrediction: prediction, normalized, resolve, reject });
      this.#child.stdin.write(`${JSON.stringify({ id, reference, prediction })}\n`, (error) => {
        if (!error) return;
        this.#pending.delete(id);
        reject(error);
      });
    });
  }

  expectedLabel(taskId: string): string {
    return extractAFlowMathAnswer(referenceFor(this.#references, taskId));
  }

  async close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      this.#child.stdin.end();
    }
    await this.#exit;
  }

  #receive(line: string): void {
    let response: ScorerResponse;
    try {
      response = JSON.parse(line) as ScorerResponse;
    } catch (error) {
      this.#failPending(new Error(`AFlow MATH scorer returned invalid JSON: ${String(error)}`));
      return;
    }
    if (!Number.isSafeInteger(response.id)) {
      this.#failPending(new Error(`AFlow MATH scorer returned an invalid request ID: ${line.slice(0, 200)}`));
      return;
    }
    const pending = this.#pending.get(response.id!);
    if (!pending) return;
    this.#pending.delete(response.id!);
    if (response.error) {
      pending.reject(new Error(response.error));
      return;
    }
    if (response.score === undefined || response.expected === undefined || response.prediction === undefined) {
      pending.reject(new Error("AFlow MATH scorer returned an incomplete result"));
      return;
    }
    const normalizedFallback = this.#normalizedFallback && response.score === 0 && pending.normalized.score === 1;
    pending.resolve(Object.freeze({
      score: normalizedFallback ? 1 : response.score,
      expected: pending.normalized.expected,
      prediction: pending.rawPrediction,
      normalizedExpected: pending.normalized.normalizedExpected,
      normalizedPrediction: pending.normalized.normalizedPrediction,
      method: normalizedFallback ? "balanced-normalized-fallback" : "aflow-math-reference",
      details: Object.freeze({
        sourceHash: response.sourceHash,
        legacyAFlowScore: response.score,
        normalizedFallback,
        normalizedEquivalence: pending.normalized.equivalence,
        normalizedExtraction: pending.normalized.extraction,
      }),
    }));
  }

  #failPending(error: Error): void {
    this.#failure = error;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

export function extractAFlowMathAnswer(text: string): string {
  const matches = [...text.matchAll(/\\boxed{((?:[^{}]|{[^{}]*})*)}/gs)];
  const boxed = matches.at(-1)?.[1];
  if (boxed !== undefined) return boxed.trim();
  const sentences = text.split(/(?<!\d)[.!?]\s+/).map((item) => item.trim()).filter(Boolean);
  return sentences.at(-1) ?? "";
}

function referenceFor(references: ReadonlyMap<string, string>, taskId: string): string {
  const reference = references.get(taskId);
  if (reference === undefined) throw new Error(`Unknown MATH task: ${taskId}`);
  return reference;
}
