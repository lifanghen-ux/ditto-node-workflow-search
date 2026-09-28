import assert from "node:assert/strict";
import test from "node:test";
import type { DeliberateNodeSpec, TrajectoryNodeSpec, WorkflowNodeSpec } from "../domain.js";
import {
  createInitialTrajectoryNode,
  createRootNode,
  materializeAgentPlan,
  pathFingerprint,
  validateNodePath,
} from "../workflow/spec.js";

test("a Node path materializes into local Graphs controlled by a Loop", () => {
  const nodes = [createRootNode(), createInitialTrajectoryNode()];
  const plan = materializeAgentPlan("search-trajectory-1", nodes);
  assert.deepEqual(plan.graphs, [
    { id: "prepare", nodeIds: ["context-load"] },
    { id: "solve", nodeIds: ["trajectory-1"] },
  ]);
  assert.deepEqual(plan.loop.transitions, {
    prepare: { kind: "next", graphId: "solve" },
    solve: { kind: "end" },
  });
  assert.equal(plan.outputNodeId, "trajectory-1");
});

test("construction order does not create runtime dependencies", () => {
  const solverA = createInitialTrajectoryNode();
  const solverB: TrajectoryNodeSpec = { ...solverA, id: "trajectory-2", config: { ...solverA.config, strategy: "tot", options: { breadth: 2, depth: 2, beamWidth: 1 } } };
  const deliberate: DeliberateNodeSpec = {
    id: "deliberate-1",
    type: "INFER.REASONING.DELIBERATE",
    graphId: "solve",
    dependencies: [solverA.id, solverB.id],
    config: { mode: "select", generation: { temperature: 0.1, maxTokens: 1024 } },
  };
  const nodes: readonly WorkflowNodeSpec[] = [createRootNode(), solverA, solverB, deliberate];
  validateNodePath(nodes);
  const plan = materializeAgentPlan("leaf", nodes);
  assert.deepEqual(plan.graphs[1]?.nodeIds, ["trajectory-1", "trajectory-2", "deliberate-1"]);
  assert.deepEqual(solverB.dependencies, []);
});

test("cross-Graph and forward dependencies are rejected", () => {
  const invalid: TrajectoryNodeSpec = { ...createInitialTrajectoryNode(), dependencies: ["context-load"] };
  assert.throws(() => validateNodePath([createRootNode(), invalid]), /cross-Graph dependency/);
  const forward: TrajectoryNodeSpec = { ...createInitialTrajectoryNode(), dependencies: ["trajectory-2"] };
  assert.throws(() => validateNodePath([createRootNode(), forward]), /unknown or forward dependency/);
});

test("path fingerprints include each Node's semantic configuration", () => {
  const root = createRootNode();
  const baseline = createInitialTrajectoryNode();
  const alternative: TrajectoryNodeSpec = { ...baseline, config: { ...baseline.config, strategy: "long-cot", options: { rounds: 3 } } };
  assert.notEqual(pathFingerprint([root, baseline]), pathFingerprint([root, alternative]));
  assert.equal(pathFingerprint([root, baseline]), pathFingerprint([root, structuredClone(baseline)]));
});
