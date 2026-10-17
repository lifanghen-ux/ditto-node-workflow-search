import assert from "node:assert/strict";
import test from "node:test";
import type { EvaluationSummary, NodeProposal } from "../domain.js";
import { NodeWorkflowSearch, type SearchResumeState } from "../search/optimizer.js";
import { SeededRandom } from "../search/random.js";

test("resuming after round two preserves selection, scores and convergence without rerunning the prefix", async () => {
  const options = { rounds: 8, topK: 4, patience: 5, maxDepth: 10, seed: 42 };
  const proposer = {
    async propose(request: Parameters<import("../search/proposer.js").NextNodeProposer["propose"]>[0]): Promise<NodeProposal> {
      const proposal: NodeProposal = {
        type: "INFER.REASONING.SAMPLE", graphId: "solve", dependencies: [],
        config: { role: "solver", instruction: `candidate-${request.experiences.length}-${request.path.length}`,
          generation: { temperature: 0, maxTokens: 393_216 } },
      };
      request.validate?.(proposal);
      return proposal;
    },
  };
  const score = () => summary(0.8);
  const full = await new NodeWorkflowSearch({ ...options, proposer, evaluate: async () => score() }).run();
  let saved: SearchResumeState | undefined;
  await assert.rejects(new NodeWorkflowSearch({ ...options, proposer, evaluate: async () => score(), callbacks: {
    async state(state) {
      if (state.completedRounds === 2) {
        saved = structuredClone(state);
        throw new Error("simulated interruption after completed round two");
      }
    },
  } }).run(), /simulated interruption/);
  assert.ok(saved);
  let newEvaluations = 0;
  const resumed = await new NodeWorkflowSearch({ ...options, proposer, resume: saved,
    async evaluate() { newEvaluations++; return score(); },
  }).run();
  assert.equal(newEvaluations, full.experiences.length - 3, "baseline and the first two rounds must not be evaluated again");
  assert.deepEqual(resumed.nodes, full.nodes);
  assert.deepEqual(resumed.experiences, full.experiences);
  assert.deepEqual(resumed.bestPlan, full.bestPlan);
  assert.equal(resumed.stoppedBecause, full.stoppedBecause);
});

test("restoring the random generator resumes exactly the next parent-selection draw", () => {
  const original = new SeededRandom(42);
  original.next(); original.next();
  const restored = new SeededRandom(1);
  restored.restore(original.state);
  assert.equal(restored.next(), original.next());
  assert.throws(() => restored.restore(0));
});

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
            generation: Object.freeze({ temperature: 0, maxTokens: 393_216 }),
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

test("repeated structural rejection stops after three saved batches without scoring a fallback", async () => {
  const { ProposalValidationError } = await import("../search/proposer.js");
  let proposals = 0;
  let evaluations = 0;
  const states: number[] = [];
  const rejected: unknown[] = [];
  await assert.rejects(new NodeWorkflowSearch({ rounds: 20, topK: 1, patience: 5, seed: 42,
    async evaluate() { evaluations++; return summary(0.5); },
    proposer: { async propose(request) {
      proposals++;
      assert.equal(request.previousRejections?.length, proposals - 1);
      await request.onRejection?.({ content: "raw invalid proposal", error: "cross-Graph dependency" });
      throw new ProposalValidationError("cross-Graph dependency");
    } },
    callbacks: { async state(state) { states.push(state.proposalFailures); }, async event(value) { if (value.type === "proposal-rejected") rejected.push(value); } },
  }).run(), /3 invalid proposal batches/);
  assert.equal(proposals, 3);
  assert.equal(evaluations, 1, "only the baseline is evaluated");
  assert.deepEqual(states, [0, 1, 2, 3]);
  assert.equal(rejected.length, 3);
});
