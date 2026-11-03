import { createHash } from 'node:crypto';

export const A_SEARCH_TARGETS = Object.freeze({
  math: 0.9832, drop: 0.8827, mbpp: 0.8395, bfcl: 0.7760, automationbench: 0.9890,
});

export function targetScore(dataset, override) {
  const value = override === undefined ? A_SEARCH_TARGETS[dataset] ?? 0.90 : Number(override);
  if (!Number.isFinite(value) || value < 0 || value >= 1) throw Error('target-score must be in [0,1)');
  return value;
}

/** Scores lie in [0,1]; even perfect remaining answers cannot exceed this bound. */
export function targetFeasibility(evaluation, fullSize, target) {
  if (!evaluation.valid || evaluation.examples >= fullSize) return null;
  const maximumScore = (evaluation.score * evaluation.examples + fullSize - evaluation.examples) / fullSize;
  return { advance: maximumScore > target, maximumScore,
    reason: maximumScore > target ? 'target-still-reachable' : 'cannot-exceed-target-even-with-perfect-remainder' };
}

function measured(record, fullSize) {
  const e = record.evaluation;
  if (record.status !== 'valid' || !e?.valid || e.examples !== fullSize) return null;
  return { id: record.id, score: e.score, tokensPerTask: e.totalTokens / fullSize,
    callsPerTask: e.providerAttemptCount / fullSize, wallTimeMsPerTask: e.durationMs / fullSize };
}

export function evolutionArchive(history, fullSize) {
  const rows = history.map(record => measured(record, fullSize)).filter(Boolean);
  const frontier = rows.filter(row => !rows.some(other => other.id !== row.id
    && other.score >= row.score && other.tokensPerTask <= row.tokensPerTask
    && (other.score > row.score || other.tokensPerTask < row.tokensPerTask)));
  return { scope: 'completed-full-validation-only', frontier,
    trials: history.map(record => ({ id: record.id, status: record.status,
      shape: record.shape ?? null, rationale: record.rationale?.slice(0, 700) ?? '',
      observedExamples: record.evaluation?.examples ?? 0,
      observedScore: record.evaluation?.valid ? record.evaluation.score : null,
      fullValidation: record.evaluation?.examples === fullSize && record.evaluation?.valid === true })),
    note: 'Shapes describe topology, not proof of semantic diversity. Partial scores cannot outrank completed candidates.' };
}

export function selectEvolutionParents(history, fullSize) {
  const full = history.filter(record => measured(record, fullSize));
  const best = [...full].sort((a, b) => b.evaluation.score - a.evaluation.score
    || a.evaluation.totalTokens - b.evaluation.totalTokens)[0];
  const frontierIds = new Set(evolutionArchive(history, fullSize).frontier.map(row => row.id));
  const cheap = full.filter(record => frontierIds.has(record.id))
    .sort((a, b) => a.evaluation.totalTokens - b.evaluation.totalTokens)[0];
  return [...new Map([best, cheap, history.at(-1)].filter(Boolean).map(record => [record.id, record])).values()];
}

export function workflowShape(plan) {
  const nodes = plan.nodes ?? [];
  const ids = new Map(nodes.map((node, index) => [node.id, index]));
  const topology = { nodes: nodes.map(node => ({ type: node.type,
    dependencies: (node.dependencies ?? []).map(id => ids.get(id) ?? id) })),
    graphSizes: (plan.graphs ?? []).map(graph => (graph.nodeIds ?? graph.nodes ?? []).length) };
  return { signature: createHash('sha256').update(JSON.stringify(topology)).digest('hex').slice(0, 12),
    nodeCount: nodes.length, operations: [...new Set(nodes.map(node => node.type))], graphCount: plan.graphs?.length ?? 0 };
}
