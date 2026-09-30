import assert from "node:assert/strict";
import test from "node:test";
import type { EvaluationSummary, NodeProposal } from "../domain.js";
import { NodeWorkflowSearch } from "../search/optimizer.js";

test("search spends rounds only on evaluated workflows and applies AFlow Top-3 convergence", async () => {
  let evaluations = 0;
  let proposals = 0;
  const result = await new NodeWorkflowSearch({
    rounds: 20,
    topK: 4,
    patience: 5,
    maxDepth: 10,
    seed: 42,
    async evaluate() {
      evaluations++;
      return summary(0.5);
    },
    proposer: {
      async propose(request): Promise<NodeProposal> {
        proposals++;
        const proposal: NodeProposal = Object.freeze({
          type: "INFER.REASONING.SAMPLE",
          graphId: "solve",
          dependencies: Object.freeze([]),
          config: Object.freeze({
            role: "solver",
            instruction: `Independent candidate ${proposals}`,
            generation: Object.freeze({ temperature: 0.2, maxTokens: 2_048 }),
          }),
        });
        request.validate?.(proposal);
        return proposal;
      },
    },
  }).run();

  assert.equal(result.stoppedBecause, "converged");
  assert.equal(evaluations, 6, "baseline plus five unchanged candidate rounds");
  assert.equal(result.experiences.length, 6);
});

function summary(score: number): EvaluationSummary {
  return Object.freeze({
    score,
    standardDeviation: 0,
    repeats: 5,
    examples: 119,
    successfulRuns: 595,
    failedRuns: 0,
    timeoutRuns: 0,
    wrongRuns: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    durationMs: 0,
    results: Object.freeze([]),
  });
}
