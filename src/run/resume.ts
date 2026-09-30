import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { EvaluationSummary, SearchExperience, SearchTreeNode } from "../domain.js";
import { backpropagateEvaluation } from "../search/backprop.js";
import type { SearchResumeState } from "../search/optimizer.js";
import { SeededRandom } from "../search/random.js";
import { compareRunnableLeaves, selectParent } from "../search/selector.js";
import { nodePathTo } from "../search/tree.js";
import { createSearchTreeNode, pathFingerprint } from "../workflow/spec.js";

async function jsonLines<T>(path: string): Promise<T[]> {
  const text = await readFile(path, "utf8");
  return text.slice(0, text.lastIndexOf("\n") + 1).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as T);
}

/** Replay only published validation events up to the requested boundary.
 * Parent-selection draws and backpropagation use the existing implementations.
 * Test directories are never consulted by this importer.
 */
export async function loadHistoricalResume(directory: string, round: number): Promise<{
  readonly manifest: Record<string, unknown>; readonly state: SearchResumeState;
}> {
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as Record<string, unknown>;
  // New runs publish an atomic state after every completed search boundary.
  // Hydrate raw validation answers from their own immutable evaluations;
  // compact state files intentionally omit these potentially large arrays.
  let saved: SearchResumeState | undefined;
  try { saved = JSON.parse(await readFile(join(directory, "resume-state.json"), "utf8")) as SearchResumeState; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (saved?.completedRounds === round) {
    if (saved.schemaVersion !== 1) throw new Error("Unsupported search resume state");
    const nodes = await Promise.all(saved.nodes.map(async node => node.evaluation
      ? { ...node, evaluation: await readEvaluation(directory, node.id, node.evaluation.score) } : node));
    return { manifest, state: { ...saved, nodes } };
  }
  const settings = manifest.search as { seed: number; topK: number; maximumDepth: number };
  const events = await jsonLines<Record<string, unknown>>(join(directory, "search-events.jsonl"));
  const cutoff = events.findIndex(event => event.type === "convergence-checked" && event.round === round);
  if (cutoff < 0) throw new Error(`Round ${round} has no completed validation/convergence boundary`);
  const records = new Map((await jsonLines<SearchTreeNode>(join(directory, "search-tree.jsonl"))).map(node => [node.id, node]));
  const allExperiences = await jsonLines<SearchExperience>(join(directory, "experiences.jsonl"));
  const root = records.get("search-000");
  if (!root) throw new Error("Historical search has no root");
  const tree = new Map<string, SearchTreeNode>([[root.id, createSearchTreeNode(root.id, null, 0, root.node, [root.node])]]);
  const experiences: SearchExperience[] = [];
  const history: Array<Pick<EvaluationSummary, "score" | "standardDeviation">> = [];
  const random = new SeededRandom(settings.seed);
  let bestLeafId = "";
  let expectedParent: string | undefined;
  let completedRounds = 0;
  for (const event of events.slice(0, cutoff + 1)) {
    if (event.type === "parent-selected") {
      const frontier = [...tree.values()].filter(node => node.evaluation && node.depth < settings.maximumDepth);
      const selected = selectParent(frontier, settings.topK, random);
      if (selected.id !== event.searchNodeId) throw new Error("Historical parent-selection replay differs; refusing an inconsistent resume");
      expectedParent = selected.id;
    }
    if (event.type !== "baseline-evaluated" && event.type !== "path-evaluated") continue;
    const node = records.get(String(event.searchNodeId));
    if (!node || node.searchParentId === null) throw new Error("Historical evaluated path is missing");
    if (event.type === "path-evaluated" && node.searchParentId !== expectedParent) throw new Error("Historical candidate parent differs from the selected parent");
    const parentPath = nodePathTo(tree, node.searchParentId);
    const path = [...parentPath, node.node];
    if (pathFingerprint(path) !== node.pathHash) throw new Error("Historical workflow hash mismatch");
    const evaluation = await readEvaluation(directory, node.id, Number(event.score));
    tree.set(node.id, createSearchTreeNode(node.id, node.searchParentId, node.depth, node.node, path));
    backpropagateEvaluation(tree, node.id, evaluation);
    const experience = allExperiences.find(entry => entry.searchNodeId === node.id);
    if (!experience || experience.score !== evaluation.score) throw new Error("Historical experience is missing or inconsistent");
    experiences.push(experience);
    history.push({ score: evaluation.score, standardDeviation: evaluation.standardDeviation });
    if (!bestLeafId || compareRunnableLeaves(tree.get(node.id)!, tree.get(bestLeafId)!) < 0) bestLeafId = node.id;
    if (event.type === "path-evaluated") completedRounds = Number(event.round);
  }
  if (completedRounds !== round || !bestLeafId) throw new Error("Requested resume boundary could not be recovered");
  return { manifest, state: { schemaVersion: 1, nodes: [...tree.values()], experiences,
    evaluationHistory: history, completedRounds, proposalFailures: 0,
    nextSearchIndex: Math.max(...[...tree.keys()].map(id => Number(id.split("-")[1]))) + 1,
    bestLeafId, randomState: random.state } };
}

async function readEvaluation(directory: string, id: string, score: number): Promise<EvaluationSummary> {
  const statistics = JSON.parse(await readFile(join(directory, "evaluations", id, "summary.json"), "utf8")) as Omit<EvaluationSummary, "results">;
  const results = await jsonLines<EvaluationSummary["results"][number]>(join(directory, "evaluations", id, "samples.jsonl"));
  if (results.length !== statistics.examples * statistics.repeats || statistics.score !== score) throw new Error("Historical validation is incomplete or differs from its recorded score");
  return { ...statistics, results };
}
