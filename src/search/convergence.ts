import type { EvaluationSummary } from "../domain.js";

export interface ConvergenceResult {
  readonly converged: boolean;
  readonly topKMean: number | null;
  readonly unchangedTransitions: number;
}

/**
 * Port of AFlow's convergence rule. At every completed workflow round it takes
 * the best `topK` validation means observed so far. With z=0, convergence means
 * that aggregate has remained exactly unchanged for `consecutiveRounds`
 * transitions.
 */
export function checkAFlowConvergence(
  rounds: readonly Pick<EvaluationSummary, "score" | "standardDeviation">[],
  topK = 3,
  z = 0,
  consecutiveRounds = 5,
): ConvergenceResult {
  if (!Number.isSafeInteger(topK) || topK < 1) throw new Error("topK must be a positive integer");
  if (!Number.isFinite(z) || z < 0) throw new Error("z must be a non-negative number");
  if (!Number.isSafeInteger(consecutiveRounds) || consecutiveRounds < 1) {
    throw new Error("consecutiveRounds must be a positive integer");
  }
  if (rounds.length < topK + 1) {
    return Object.freeze({ converged: false, topKMean: null, unchangedTransitions: 0 });
  }

  let previousMean: number | undefined;
  let previousSigma: number | undefined;
  let unchangedTransitions = 0;
  let currentMean = 0;

  for (let index = 0; index < rounds.length; index++) {
    const ranked = rounds
      .slice(0, index + 1)
      .map((round, roundIndex) => ({ round, roundIndex }))
      .sort((left, right) => right.round.score - left.round.score || left.roundIndex - right.roundIndex)
      .slice(0, topK);
    currentMean = mean(ranked.map(({ round }) => round.score));
    // Preserve AFlow's division by topK even before the list reaches topK.
    const currentSigma = Math.sqrt(ranked.reduce(
      (sum, { round }) => sum + round.standardDeviation ** 2,
      0,
    ) / topK ** 2);

    if (previousMean !== undefined && previousSigma !== undefined) {
      const delta = currentMean - previousMean;
      const sigmaDelta = Math.sqrt(currentSigma ** 2 + previousSigma ** 2);
      if (Math.abs(delta) <= z * sigmaDelta) {
        unchangedTransitions++;
        if (unchangedTransitions >= consecutiveRounds) {
          return Object.freeze({ converged: true, topKMean: currentMean, unchangedTransitions });
        }
      } else {
        unchangedTransitions = 0;
      }
    }
    previousMean = currentMean;
    previousSigma = currentSigma;
  }

  return Object.freeze({ converged: false, topKMean: currentMean, unchangedTransitions });
}

function mean(values: readonly number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}
