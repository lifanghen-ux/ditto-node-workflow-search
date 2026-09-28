import assert from "node:assert/strict";
import test from "node:test";
import { createDitto } from "@codesoul-co/ditto/runtime";
import { createContextWorker } from "@codesoul-co/ditto/worker/context";
import { createInferWorker, type ModelProvider } from "@codesoul-co/ditto/worker/infer";
import type { AgentPlanSpec, BenchmarkTask, ReflectNodeSpec, SampleNodeSpec, WorkflowNodeSpec } from "../domain.js";
import { WorkflowExecutor } from "../workflow/executor.js";
import { createInitialTrajectoryNode, createRootNode, materializeAgentPlan } from "../workflow/spec.js";

const task: BenchmarkTask = Object.freeze({
  id: "math:validate:fixture",
  dataset: "math",
  prompt: "What is 1 + 1?",
  outputInstruction: "Return the final number.",
  metadata: Object.freeze({ split: "validate" }),
});

test("executor runs prepare then solve through one Ditto Loop", async () => {
  const fixture = createFixture(() => "\\boxed{2}");
  try {
    const plan = materializeAgentPlan("leaf", [createRootNode(), createInitialTrajectoryNode()]);
    const result = await fixture.executor.run(plan, task);
    assert.equal(result.answer, "\\boxed{2}");
    assert.deepEqual(result.executedGraphIds, ["prepare", "solve"]);
    assert.deepEqual(result.executedNodeIds, ["context-load", "trajectory-1"]);
    assert.equal(result.totalTokens, 3);
  } finally {
    await fixture.close();
  }
});

test("Loop repeat reuses a Graph definition and evaluates the newest output", async () => {
  let refineCalls = 0;
  const fixture = createFixture((nodeId) => nodeId === "finalizer-1" ? (++refineCalls === 1 ? "retry" : "done") : "draft");
  try {
    const finalizer: SampleNodeSpec = {
      id: "finalizer-1",
      type: "INFER.REASONING.SAMPLE",
      graphId: "refine",
      dependencies: [],
      config: { role: "finalizer", instruction: "Return done when ready.", generation: { temperature: 0, maxTokens: 128 } },
    };
    const nodes: readonly WorkflowNodeSpec[] = [createRootNode(), createInitialTrajectoryNode(), finalizer];
    const base = materializeAgentPlan("leaf", nodes);
    const plan: AgentPlanSpec = {
      ...base,
      loop: {
        entryGraphId: "prepare",
        maxGraphRuns: 4,
        transitions: {
          prepare: { kind: "next", graphId: "solve" },
          solve: { kind: "next", graphId: "refine" },
          refine: {
            kind: "repeat",
            graphId: "refine",
            maxVisits: 2,
            until: { sourceNodeId: "finalizer-1", path: ["message", "content"], operator: "equals", value: "done" },
          },
        },
      },
    };
    const result = await fixture.executor.run(plan, task);
    assert.equal(result.answer, "done");
    assert.deepEqual(result.executedGraphIds, ["prepare", "solve", "refine", "refine"]);
    assert.equal(result.executedNodeIds.filter((id) => id === "finalizer-1").length, 2);
  } finally {
    await fixture.close();
  }
});

test("Loop switch chooses a Graph from normalized prior output", async () => {
  const fixture = createFixture(() => "selected");
  try {
    const unused: SampleNodeSpec = {
      id: "unused-finalizer",
      type: "INFER.REASONING.SAMPLE",
      graphId: "refine",
      dependencies: [],
      config: { role: "finalizer", instruction: "Unused branch", generation: { temperature: 0, maxTokens: 128 } },
    };
    const nodes: readonly WorkflowNodeSpec[] = [createRootNode(), createInitialTrajectoryNode(), unused];
    const base = materializeAgentPlan("leaf", nodes);
    const plan: AgentPlanSpec = {
      ...base,
      outputNodeId: "trajectory-1",
      loop: {
        entryGraphId: "prepare",
        maxGraphRuns: 2,
        transitions: {
          prepare: {
            kind: "switch",
            cases: [{ when: { sourceNodeId: "context-load", path: ["items"], operator: "truthy" }, graphId: "solve" }],
            defaultGraphId: "refine",
          },
          solve: { kind: "end" },
          refine: { kind: "end" },
        },
      },
    };
    const result = await fixture.executor.run(plan, task);
    assert.deepEqual(result.executedGraphIds, ["prepare", "solve"]);
    assert.equal(result.answer, "selected");
  } finally {
    await fixture.close();
  }
});

test("a verify-only REFLECT preserves the preceding Graph's answer", async () => {
  const fixture = createFixture((nodeId) => nodeId === "reflect-1"
    ? JSON.stringify({ assessment: { passed: true, summary: "correct" }, issues: [] })
    : "draft-answer");
  try {
    const reflect: ReflectNodeSpec = {
      id: "reflect-1",
      type: "INFER.REASONING.REFLECT",
      graphId: "refine",
      dependencies: [],
      config: { mode: "verify", criteria: ["correctness"], generation: { temperature: 0, maxTokens: 128 } },
    };
    const plan = materializeAgentPlan("leaf", [createRootNode(), createInitialTrajectoryNode(), reflect]);
    const result = await fixture.executor.run(plan, task);
    assert.equal(result.answer, "draft-answer");
    assert.deepEqual(result.executedGraphIds, ["prepare", "solve", "refine"]);
  } finally {
    await fixture.close();
  }
});

function createFixture(answer: (nodeId: string) => string): { executor: WorkflowExecutor; close(): Promise<void> } {
  const provider: ModelProvider = {
    async invoke(input) {
      const nodeId = typeof input.metadata?.nodeId === "string" ? input.metadata.nodeId : "unknown";
      return {
        message: { role: "assistant", content: answer(nodeId) },
        finishReason: "stop",
        usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
      };
    },
  };
  const runtime = createDitto({
    workers: [createContextWorker(), createInferWorker({ providers: { fake: provider }, defaultProvider: "fake" })],
  });
  return {
    executor: new WorkflowExecutor(runtime, "fake", "fixture-model"),
    close: () => runtime.close(),
  };
}
