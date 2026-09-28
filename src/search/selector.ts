import type { SearchTreeNode } from "../domain.js";
import type { SeededRandom } from "./random.js";

/**
 * AFlow-inspired parent selection for a Node-level tree.
 *
 * Scores are back-propagated from runnable leaf paths, so an internal tree Node
 * is ranked by workflows that have actually passed through it. Unvisited Nodes
 * are selected before the score mixture so partial paths are not stranded.
 */
export function selectParent(
  candidates: readonly SearchTreeNode[],
  topK: number,
  random: SeededRandom,
): SearchTreeNode {
  if (!candidates.length) throw new Error("Cannot select from an empty search frontier");
  if (!Number.isSafeInteger(topK) || topK < 1) throw new Error("topK must be a positive integer");

  const unvisited = candidates.filter((candidate) => candidate.statistics.visits === 0);
  if (unvisited.length) return unvisited[Math.floor(random.next() * unvisited.length)]!;

  const ranked = [...candidates].sort(compareSearchNodes);
  const pool = ranked.slice(0, Math.min(topK, ranked.length));
  const root = candidates.find((candidate) => candidate.searchParentId === null);
  if (root && !pool.some((candidate) => candidate.id === root.id)) pool.push(root);

  const exploration = 0.3;
  const temperature = 0.12;
  const values = pool.map(searchValue);
  const maximum = Math.max(...values);
  const weights = values.map((value) => Math.exp((value - maximum) / temperature));
  const total = weights.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(total) || total <= 0) throw new Error("Invalid parent-selection weights");
  const probabilities = weights.map((weight) =>
    exploration / pool.length + (1 - exploration) * weight / total,
  );

  const sample = random.next();
  let cumulative = 0;
  for (let index = 0; index < pool.length; index++) {
    cumulative += probabilities[index]!;
    if (sample <= cumulative) return pool[index]!;
  }
  return pool.at(-1)!;
}

export function compareSearchNodes(left: SearchTreeNode, right: SearchTreeNode): number {
  const leftEvaluated = left.statistics.visits > 0;
  const rightEvaluated = right.statistics.visits > 0;
  if (leftEvaluated !== rightEvaluated) return leftEvaluated ? -1 : 1;

  return searchValue(right) - searchValue(left)
    || left.statistics.failedRuns - right.statistics.failedRuns
    || average(left.statistics.totalTokens, left.statistics.visits)
      - average(right.statistics.totalTokens, right.statistics.visits)
    || average(left.statistics.totalLatencyMs, left.statistics.visits)
      - average(right.statistics.totalLatencyMs, right.statistics.visits)
    || left.depth - right.depth
    || left.id.localeCompare(right.id);
}

/** Direct leaf evaluations use this comparator when freezing the best path. */
export function compareRunnableLeaves(left: SearchTreeNode, right: SearchTreeNode): number {
  if (!left.evaluation || !right.evaluation) {
    if (left.evaluation) return -1;
    if (right.evaluation) return 1;
    return left.id.localeCompare(right.id);
  }
  return right.evaluation.score - left.evaluation.score
    || left.evaluation.failedRuns - right.evaluation.failedRuns
    || left.evaluation.totalTokens - right.evaluation.totalTokens
    || left.evaluation.durationMs - right.evaluation.durationMs
    || left.pathHash.localeCompare(right.pathHash)
    || left.id.localeCompare(right.id);
}

function searchValue(node: SearchTreeNode): number {
  if (!node.statistics.visits) return Number.POSITIVE_INFINITY;
  return node.statistics.bestScore * 0.7 + node.statistics.meanScore * 0.3;
}

function average(total: number, count: number): number {
  return count ? total / count : Number.POSITIVE_INFINITY;
}
