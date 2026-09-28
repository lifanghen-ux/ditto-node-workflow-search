import assert from "node:assert/strict";
import test from "node:test";
import type { SearchNodeStatistics, SearchTreeNode } from "../domain.js";
import { createInitialTrajectoryNode, createRootNode, createSearchTreeNode } from "../workflow/spec.js";
import { SeededRandom } from "../search/random.js";
import { selectParent } from "../search/selector.js";

test("selector strongly favors high-scoring Nodes while preserving random exploration", () => {
  const rootSpec = createRootNode();
  const root = withStatistics(
    createSearchTreeNode("root", null, 0, rootSpec, [rootSpec]),
    statistics(10, 0),
  );
  const trajectory = createInitialTrajectoryNode();
  const high = withStatistics(
    createSearchTreeNode("high", root.id, 1, trajectory, [rootSpec, trajectory]),
    statistics(10, 1),
  );
  const random = new SeededRandom(42);
  let selectedHigh = 0;
  let selectedRoot = 0;
  for (let index = 0; index < 2_000; index++) {
    const selected = selectParent([root, high], 2, random);
    if (selected.id === high.id) selectedHigh++;
    else selectedRoot++;
  }

  assert.ok(selectedHigh > 1_500, `expected score bias, selected high ${selectedHigh} times`);
  assert.ok(selectedRoot > 150, `expected uniform exploration, selected root ${selectedRoot} times`);
});

test("selector completes an unvisited partial branch before score sampling", () => {
  const rootSpec = createRootNode();
  const root = withStatistics(
    createSearchTreeNode("root", null, 0, rootSpec, [rootSpec]),
    statistics(2, 1),
  );
  const trajectory = createInitialTrajectoryNode();
  const partial = createSearchTreeNode("partial", root.id, 1, trajectory, [rootSpec, trajectory]);
  assert.equal(selectParent([root, partial], 2, new SeededRandom(7)).id, partial.id);
});

function statistics(visits: number, score: number): SearchNodeStatistics {
  return Object.freeze({
    visits,
    scoreSum: score * visits,
    meanScore: score,
    bestScore: score,
    failedRuns: 0,
    totalTokens: 100 * visits,
    totalLatencyMs: 10 * visits,
  });
}

function withStatistics(node: SearchTreeNode, value: SearchNodeStatistics): SearchTreeNode {
  return Object.freeze({ ...node, statistics: value });
}
