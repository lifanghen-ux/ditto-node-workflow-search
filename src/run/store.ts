import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type {
  AgentPlanSpec,
  CaseResult,
  EvaluationSummary,
  SearchExperience,
  SearchTreeNode,
  WorkflowNodeSpec,
} from "../domain.js";

export interface FrozenProgram {
  readonly leaf: SearchTreeNode;
  readonly nodePath: readonly WorkflowNodeSpec[];
  readonly plan: AgentPlanSpec;
  readonly validation: EvaluationSummary;
  readonly stoppedBecause: string;
  readonly exploredNodes: number;
}

export class RunStore {
  readonly directory: string;
  #writes: Promise<void> = Promise.resolve();

  private constructor(directory: string) {
    this.directory = directory;
  }

  static async create(root: string, dataset: string): Promise<RunStore> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const id = `${timestamp}-${randomBytes(3).toString("hex")}`;
    const directory = resolve(root, dataset, id);
    await mkdir(directory, { recursive: true });
    return new RunStore(directory);
  }

  static async open(directory: string): Promise<RunStore> {
    const resolved = resolve(directory);
    await readFile(join(resolved, "best", "plan.json"), "utf8");
    return new RunStore(resolved);
  }

  async writeManifest(value: Readonly<Record<string, unknown>>): Promise<void> {
    await writeJson(join(this.directory, "manifest.json"), value);
  }

  async readManifest(): Promise<Record<string, unknown>> {
    const value = JSON.parse(await readFile(join(this.directory, "manifest.json"), "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Run manifest must be a JSON object");
    return value as Record<string, unknown>;
  }

  async appendEvent(value: Readonly<Record<string, unknown>>): Promise<void> {
    await appendJsonLine(join(this.directory, "search-events.jsonl"), value);
  }

  async saveLiveCase(scope: string, result: CaseResult): Promise<void> {
    const path = scope === "test" ? join(this.directory, "test", "live-samples.jsonl")
      : join(this.directory, "evaluations", scope, "live-samples.jsonl");
    this.#writes = this.#writes.then(() => appendJsonLine(path, { at: new Date().toISOString(), ...result }));
    await this.#writes;
  }

  /** One JSONL record is one search vertex, and one vertex contains exactly one Ditto Node. */
  async saveSearchNode(searchNode: SearchTreeNode): Promise<void> {
    const { evaluation, ...nodeWithoutEvaluation } = searchNode;
    await appendJsonLine(join(this.directory, "search-tree.jsonl"), {
      ...nodeWithoutEvaluation,
      ...(evaluation ? { evaluation: summaryWithoutResults(evaluation) } : {}),
    });
  }

  async saveEvaluation(searchNodeId: string, summary: EvaluationSummary): Promise<void> {
    const directory = join(this.directory, "evaluations", searchNodeId);
    await Promise.all([
      writeJson(join(directory, "summary.json"), summaryWithoutResults(summary)),
      writeJsonLines(join(directory, "samples.jsonl"), summary.results),
    ]);
  }

  async saveTreeSnapshot(nodes: readonly SearchTreeNode[]): Promise<void> {
    await writeJson(join(this.directory, "search-tree-final.json"), nodes);
  }

  async saveExperience(experience: SearchExperience): Promise<void> {
    await appendJsonLine(join(this.directory, "experiences.jsonl"), experience);
  }

  async saveBest(value: FrozenProgram): Promise<void> {
    const directory = join(this.directory, "best");
    await mkdir(directory, { recursive: true });
    await Promise.all([
      writeJson(join(directory, "plan.json"), value.plan),
      writeJson(join(directory, "node-path.json"), value.nodePath),
      writeJson(join(directory, "graphs.json"), value.plan.graphs),
      writeJson(join(directory, "loop.json"), value.plan.loop),
      writeJson(join(directory, "validation-summary.json"), summaryWithoutResults(value.validation)),
      writeJson(join(directory, "search-summary.json"), {
        stoppedBecause: value.stoppedBecause,
        exploredNodes: value.exploredNodes,
        bestLeafId: value.leaf.id,
        bestScore: value.validation.score,
        planId: value.plan.id,
      }),
    ]);
  }

  async saveTest(summary: EvaluationSummary): Promise<void> {
    const directory = join(this.directory, "test");
    await mkdir(directory, { recursive: true });
    await Promise.all([
      writeJson(join(directory, "summary.json"), summaryWithoutResults(summary)),
      writeJsonLines(join(directory, "samples.jsonl"), summary.results),
    ]);
  }

  async readBestPlan(): Promise<AgentPlanSpec> {
    return JSON.parse(await readFile(join(this.directory, "best", "plan.json"), "utf8")) as AgentPlanSpec;
  }
}

function summaryWithoutResults(summary: EvaluationSummary): Omit<EvaluationSummary, "results"> {
  const { results: _results, ...rest } = summary;
  return rest;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, jsonNumberReplacer, 2)}\n`, "utf8");
  await rename(temporary, path);
}

async function writeJsonLines(path: string, values: readonly unknown[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const content = values.map((value) => JSON.stringify(value, jsonNumberReplacer)).join("\n");
  await writeFile(path, content ? `${content}\n` : "", "utf8");
}

async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(value, jsonNumberReplacer)}\n`, "utf8");
}

function jsonNumberReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  return value;
}
