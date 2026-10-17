import assert from "node:assert/strict";
import test from "node:test";
import { createDitto } from "@codesoul-co/ditto/runtime";
import { createContextWorker } from "@codesoul-co/ditto/worker/context";
import { createInferWorker, type ModelProvider } from "@codesoul-co/ditto/worker/infer";
import { createInteractionWorker } from "@codesoul-co/ditto/worker/interaction";
import { automationScope, type AutomationSession } from "../benchmark/automation.js";
import { createAutomationTools } from "../ditto/automation-tools.js";
import { WorkflowExecutor } from "../workflow/executor.js";
import { createRootNode, createInitialSampleNode, materializeAgentPlan } from "../workflow/spec.js";
import type { BenchmarkTask } from "../domain.js";

function task(id: string): BenchmarkTask {
  return { id, dataset: "automationbench", prompt: `Update world ${id}`, outputInstruction: "Plan then execute", metadata: { split: "validate" } };
}

function session(id: string, broken = false) {
  let calls = 0;
  let failure: Error | undefined;
  const events: Readonly<Record<string, unknown>>[] = [];
  const scope: AutomationSession = {
    tools: [{ name: "api_fetch", inputSchema: { type: "object", properties: { world: { type: "string" } }, required: ["world"] } }],
    async call(name, args) {
      assert.equal(name, "api_fetch");
      assert.equal(args.world, id, "concurrent tasks cannot cross worlds");
      if (broken) { failure = new Error("Automation bridge disconnected"); throw failure; }
      calls++;
      return { content: JSON.stringify({ world: id, changes: calls }) };
    },
    record(entry) { events.push(entry); },
    assertHealthy() { if (failure) throw failure; },
  };
  return { scope, events, calls: () => calls };
}

test("Automation uses native SAMPLE→ACT→OBSERVE tool turns beyond the default sixteen", async () => {
  const states = new Map<string, number>();
  const provider: ModelProvider = { async invoke(input) {
    automationScope.getStore()?.assertHealthy();
    if (!input.actions?.length) return { message: { role: "assistant", content: "Proposed plan only" }, finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    const id = String(input.metadata?.taskId);
    const turn = states.get(id) ?? 0;
    states.set(id, turn + 1);
    if (turn < 18) return { message: { role: "assistant", content: "" }, finishReason: "action_request", actionRequests: [{ id: `${id}-${turn}`, name: "api_fetch", arguments: { world: id } }], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    assert.equal(input.messages.filter(message => message.role === "tool").length, 18);
    return { message: { role: "assistant", content: `Actually updated ${id}` }, finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  } };
  const runtime = createDitto({ sandbox: { tools: ["api_fetch"] }, workers: [createContextWorker(), createInferWorker({ providers: { fake: provider }, defaultProvider: "fake" }), createInteractionWorker({ tools: createAutomationTools() })] });
  const executor = new WorkflowExecutor(runtime, "fake", "fake");
  const plan = materializeAgentPlan("search-001", [createRootNode(), createInitialSampleNode("Plan only")]);
  const worlds = [session("a"), session("b")];
  try {
    const outputs = await Promise.all(worlds.map((world, index) => automationScope.run(world.scope, () => executor.run(plan, task(index ? "b" : "a")))));
    for (const [index, output] of outputs.entries()) {
      assert.equal(worlds[index]!.calls(), 18);
      assert.match(output.answer, /Actually updated/);
      assert.equal(output.totalTokens, 40);
      const trace = worlds[index]!.events.find(event => event.kind === "runtime-react")!;
      assert.equal((trace.observations as unknown[]).length, 18);
      assert.equal(trace.status, "completed");
    }
  } finally { await runtime.close(); }
});

test("Automation infrastructure failure cannot become a successful textual completion", async () => {
  const provider: ModelProvider = { async invoke(input) {
    automationScope.getStore()?.assertHealthy();
    return input.actions?.length
      ? { message: { role: "assistant", content: "" }, finishReason: "action_request", actionRequests: [{ id: "broken-1", name: "api_fetch", arguments: { world: "broken" } }] }
      : { message: { role: "assistant", content: "plan" }, finishReason: "stop" };
  } };
  const runtime = createDitto({ sandbox: { tools: ["api_fetch"] }, workers: [createContextWorker(), createInferWorker({ providers: { fake: provider } }), createInteractionWorker({ tools: createAutomationTools() })] });
  const executor = new WorkflowExecutor(runtime, "fake", "fake");
  const plan = materializeAgentPlan("search-001", [createRootNode(), createInitialSampleNode()]);
  try { await assert.rejects(automationScope.run(session("broken", true).scope, () => executor.run(plan, task("broken"))), /bridge disconnected/); }
  finally { await runtime.close(); }
});
