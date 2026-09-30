import assert from "node:assert/strict";
import test from "node:test";
import type { EvaluationSummary, SearchTreeNode, TrajectoryNodeSpec } from "../domain.js";
import { createInitialTrajectoryNode, createRootNode, createSearchTreeNode } from "../workflow/spec.js";
import { SeededRandom } from "../search/random.js";
import { selectParent } from "../search/selector.js";

test("AFlow selector favors high-scoring complete workflows while preserving lambda exploration", () => {
  const rootSpec = createRootNode();
  const lowSpec = createInitialTrajectoryNode();
  const highSpec: TrajectoryNodeSpec = Object.freeze({ ...lowSpec, id: "trajectory-2" });
  const low = withEvaluation(createSearchTreeNode("low", "root", 1, lowSpec, [rootSpec, lowSpec]), evaluation(0));
  const high = withEvaluation(createSearchTreeNode("high", "root", 1, highSpec, [rootSpec, highSpec]), evaluation(1));
  const random = new SeededRandom(42);
  let selectedHigh = 0;
  let selectedLow = 0;
  for (let index = 0; index < 2_000; index++) {
    const selected = selectParent([low, high], 2, random);
    if (selected.id === high.id) selectedHigh++;
    else selectedLow++;
  }

  assert.ok(selectedHigh > 1_600, `expected score bias, selected high ${selectedHigh} times`);
  assert.ok(selectedLow > 200, `expected uniform exploration, selected low ${selectedLow} times`);
});

test("AFlow selector rejects partial or unevaluated paths", () => {
  const rootSpec = createRootNode();
  const trajectory = createInitialTrajectoryNode();
  const partial = createSearchTreeNode("partial", "root", 1, trajectory, [rootSpec, trajectory]);
  assert.throws(() => selectParent([partial], 2, new SeededRandom(7)), /complete evaluated workflows/);
});

function evaluation(score: number): EvaluationSummary {
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

function withEvaluation(node: SearchTreeNode, value: EvaluationSummary): SearchTreeNode {
  return Object.freeze({ ...node, evaluation: value });
}
