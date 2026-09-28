import type { EvaluationSummary, SearchTreeNode } from "../domain.js";

/** Attach an evaluation to one runnable leaf and propagate it to all ancestors. */
export function backpropagateEvaluation(
  tree: Map<string, SearchTreeNode>,
  leafId: string,
  evaluation: EvaluationSummary,
): readonly SearchTreeNode[] {
  const updated: SearchTreeNode[] = [];
  const visited = new Set<string>();
  let cursorId: string | null = leafId;
  let direct = true;

  while (cursorId !== null) {
    if (visited.has(cursorId)) throw new Error(`Search parent cycle detected at ${cursorId}`);
    visited.add(cursorId);
    const current = tree.get(cursorId);
    if (!current) throw new Error(`Unknown search tree Node: ${cursorId}`);

    const visits = current.statistics.visits + 1;
    const scoreSum = current.statistics.scoreSum + evaluation.score;
    const next: SearchTreeNode = Object.freeze({
      ...current,
      ...(direct ? { evaluation } : {}),
      statistics: Object.freeze({
        visits,
        scoreSum,
        meanScore: scoreSum / visits,
        bestScore: Math.max(current.statistics.bestScore, evaluation.score),
        failedRuns: current.statistics.failedRuns + evaluation.failedRuns,
        totalTokens: current.statistics.totalTokens + evaluation.totalTokens,
        totalLatencyMs: current.statistics.totalLatencyMs + evaluation.durationMs,
      }),
    });
    tree.set(cursorId, next);
    updated.push(next);
    cursorId = current.searchParentId;
    direct = false;
  }

  return Object.freeze(updated);
}

export function emptyStatistics(): SearchTreeNode["statistics"] {
  return Object.freeze({
    visits: 0,
    scoreSum: 0,
    meanScore: 0,
    bestScore: Number.NEGATIVE_INFINITY,
    failedRuns: 0,
    totalTokens: 0,
    totalLatencyMs: 0,
  });
}
