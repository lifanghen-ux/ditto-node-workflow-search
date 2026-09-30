import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CaseResult, EvaluationSummary } from "../domain.js";
import { artifactHash, publishCheckpoint, writeArtifact, type WorkflowCheckpoint } from "./checkpoints.js";

export interface IndependentTestSettings {
  readonly outputDirectory: string;
  readonly workflowConcurrency: number;
  readonly sampleConcurrency: number;
  readonly providerConcurrency: number;
  readonly testDataHash: string;
  readonly testRepeats: number;
}

export interface RoundTestJob {
  readonly searchNodeId: string;
  readonly key: string;
  readonly planHash: string;
  readonly testDataHash: string;
  readonly testRepeats: number;
  readonly sampleConcurrency: number;
  readonly providerConcurrency: number;
  readonly status: "queued" | "running" | "complete" | "failed";
  readonly attempt: number;
  readonly updatedAt: string;
  readonly score?: number;
  readonly legacyScore?: number;
  readonly error?: string;
}

/** A one-way consumer: it reads frozen plans and writes only test artifacts.
 * There is intentionally no optimizer, experience, or parent-selection API.
 */
export class IndependentRoundTests {
  readonly #settings: IndependentTestSettings;
  readonly #evaluate: (checkpoint: WorkflowCheckpoint, onCase: (result: CaseResult) => Promise<void>) => Promise<EvaluationSummary>;
  readonly #jobs = new Map<string, RoundTestJob>();
  readonly #queue: WorkflowCheckpoint[] = [];
  readonly #active = new Set<Promise<void>>();

  constructor(settings: IndependentTestSettings,
    evaluate: (checkpoint: WorkflowCheckpoint, onCase: (result: CaseResult) => Promise<void>) => Promise<EvaluationSummary>) {
    if (!Number.isSafeInteger(settings.workflowConcurrency) || settings.workflowConcurrency < 1) throw new Error("Invalid workflow concurrency");
    this.#settings = settings;
    this.#evaluate = evaluate;
  }

  get jobs(): readonly RoundTestJob[] { return [...this.#jobs.values()]; }
  get pending(): number { return this.#queue.length + this.#active.size; }

  async enqueue(checkpoint: WorkflowCheckpoint): Promise<void> {
    const key = artifactHash({ checkpoint, testDataHash: this.#settings.testDataHash, testRepeats: this.#settings.testRepeats });
    const known = this.#jobs.get(checkpoint.searchNodeId);
    if (known) {
      if (known.key !== key) throw new Error("A checkpoint changed after submission");
      return;
    }
    const directory = join(this.#settings.outputDirectory, checkpoint.searchNodeId);
    let previous: RoundTestJob | undefined;
    try { previous = JSON.parse(await readFile(join(directory, "job.json"), "utf8")) as RoundTestJob; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (previous && previous.key !== key) throw new Error("Test settings changed: choose a separate output directory");
    if (previous?.status === "complete") { this.#jobs.set(checkpoint.searchNodeId, previous); return; }
    await publishCheckpoint(join(directory, "checkpoint"), checkpoint);
    const job: RoundTestJob = {
      searchNodeId: checkpoint.searchNodeId, key, planHash: checkpoint.planHash,
      testDataHash: this.#settings.testDataHash, testRepeats: this.#settings.testRepeats,
      sampleConcurrency: this.#settings.sampleConcurrency, providerConcurrency: this.#settings.providerConcurrency,
      status: "queued", attempt: (previous?.attempt ?? 0) + 1, updatedAt: new Date().toISOString(),
    };
    await writeArtifact(join(directory, "job.json"), job);
    this.#jobs.set(checkpoint.searchNodeId, job);
    this.#queue.push(checkpoint);
    this.#dispatch();
  }

  async drain(): Promise<void> {
    while (this.pending) await Promise.all([...this.#active]);
  }

  #dispatch(): void {
    while (this.#active.size < this.#settings.workflowConcurrency && this.#queue.length) {
      const checkpoint = this.#queue.shift()!;
      const operation = this.#execute(checkpoint).finally(() => {
        this.#active.delete(operation);
        this.#dispatch();
      });
      this.#active.add(operation);
    }
  }

  async #execute(checkpoint: WorkflowCheckpoint): Promise<void> {
    const directory = join(this.#settings.outputDirectory, checkpoint.searchNodeId);
    const initial = this.#jobs.get(checkpoint.searchNodeId)!;
    const attemptDirectory = join(directory, `attempt-${initial.attempt}`);
    let writes = Promise.resolve();
    try {
      const running: RoundTestJob = { ...initial, status: "running", updatedAt: new Date().toISOString() };
      this.#jobs.set(checkpoint.searchNodeId, running);
      await writeArtifact(join(directory, "job.json"), running);
      await mkdir(attemptDirectory, { recursive: true });
      const summary = await this.#evaluate(checkpoint, (result) => {
        writes = writes.then(() => appendFile(join(attemptDirectory, "live-samples.jsonl"),
          `${JSON.stringify({ at: new Date().toISOString(), ...result })}\n`, "utf8"));
        return writes;
      });
      await writes;
      const { results, ...statistics } = summary;
      await writeArtifact(join(attemptDirectory, "summary.json"), statistics);
      // Full raw output is retained for scorer auditing, separate from search.
      await writeArtifact(join(attemptDirectory, "samples.json"), results);
      const complete: RoundTestJob = { ...running, status: "complete", updatedAt: new Date().toISOString(), score: summary.score,
        legacyScore: results.reduce((sum, result) => sum + Number(result.details?.legacyAFlowScore ?? result.score), 0) / results.length };
      await writeArtifact(join(directory, "job.json"), complete);
      this.#jobs.set(checkpoint.searchNodeId, complete);
    } catch (error) {
      const failed: RoundTestJob = { ...initial, status: "failed", updatedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) };
      this.#jobs.set(checkpoint.searchNodeId, failed);
      // Catch persistence failures too: a failed test must never stop search
      // or surface as an unhandled rejection in this independent worker.
      try { await writeArtifact(join(directory, "job.json"), failed); }
      catch (writeError) { console.error(JSON.stringify({ phase: "test-artifact-error", searchNodeId: checkpoint.searchNodeId, error: String(writeError) })); }
    }
  }
}
