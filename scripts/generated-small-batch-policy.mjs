export const SMALL_BATCH_POLICY = Object.freeze({
  id: 'generated-drop-small-batch-v1',
  stages: [16, 32, 64],
  repeats: 1,
  seed: 20261027,
  targetF1: 0.90,
  coarseRegression: {16: 0.15, 32: 0.08},
});

export function searchPolicyForSize(count = 64) {
  if (count === 64) return SMALL_BATCH_POLICY;
  if (count !== 200) throw Error('Supported validation sizes are 64 and 200');
  return Object.freeze({...SMALL_BATCH_POLICY, id:'generated-drop-expanded-v2',
    stages:[16,32,64,128,200],coarseRegression:{16:0.15,32:0.08,64:0.05,128:0.03}});
}

/** Settled HTTP attempts plus all provider invocations still awaiting diagnostics. */
export function committedRequests(attempts, reservedInvocations, settledInvocations) {
  return attempts + Math.max(0,reservedInvocations-settledInvocations);
}

/** Selection uses only original public task order and a predeclared seed, never scores. */
export function selectSearchTasks(tasks, count = 64, seed = SMALL_BATCH_POLICY.seed) {
  if (!Number.isSafeInteger(count) || count < 1 || count > tasks.length) throw Error('Invalid subset size');
  if (new Set(tasks.map(task => task.id)).size !== tasks.length) throw Error('Duplicate task IDs');
  let state = seed >>> 0;
  const random = () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
  const shuffled = [...tasks];
  for (let index = shuffled.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]];
  }
  return shuffled.slice(0, count);
}

export function pairedStageDecision(evaluation, reference, size, policy = SMALL_BATCH_POLICY) {
  if (!evaluation.valid) return {advance:false, reason:'engineering-failure'};
  if (size === policy.stages.at(-1)) return {advance:false, reason:'completed-fixed-subset'};
  const parent = new Map((reference?.results ?? []).filter(row => row.valid && !row.error).map(row => [row.caseId,row]));
  const pairs = evaluation.results.filter(row => row.valid && !row.error && parent.has(row.caseId));
  if (pairs.length !== size) return {advance:true, reason:'insufficient-paired-evidence', overlap:pairs.length};
  const delta = pairs.reduce((sum,row) => sum + row.score - parent.get(row.caseId).score, 0) / pairs.length;
  const threshold = policy.coarseRegression[size];
  return {advance:delta >= -threshold, reason:delta < -threshold ? 'large-paired-regression' : 'retain-for-larger-batch', overlap:pairs.length, pairedDelta:delta, threshold};
}

export function bestFullCandidate(history, count = 64) {
  return history.filter(row => row.status === 'valid' && row.evaluation?.valid && row.evaluation.examples === count)
    .sort((a,b) => b.evaluation.score-a.evaluation.score || a.evaluation.totalTokens-b.evaluation.totalTokens)[0];
}
