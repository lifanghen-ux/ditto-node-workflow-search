import assert from "node:assert/strict";
import test from "node:test";
import { createDitto } from "@codesoul-co/ditto/runtime";
import { createContextWorker } from "@codesoul-co/ditto/worker/context";
import { createInferWorker, type ModelProvider } from "@codesoul-co/ditto/worker/infer";
import { createInteractionWorker } from "@codesoul-co/ditto/worker/interaction";
import { automationScope, type AutomationSession } from "../benchmark/automation.js";
import { createAutomationTools } from "../ditto/automation-tools.js";
import { WorkflowExecutor } from "../workflow/executor.js";
import { initialOrganization, buildOrganizationPlan } from "../workflow/organization.js";
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
  const runtime = createDitto({ sandbox: { tools: ["api_fetch"] }, workers: [createContextWorker(), createInferWorker({ providers: { fake: provider }, defaultProvider: "fake" }), createInteractionWorker({ tools: createAutomationTools(), output: {async deliver(input) {return {deliveryId:input.deliveryId,status:"accepted" as const};}} })] });
  const executor = new WorkflowExecutor(runtime, "fake", "fake");
  const plan = buildOrganizationPlan(initialOrganization("automationbench"));
  const worlds = [session("a"), session("b")];
  try {
    const outputs = await Promise.all(worlds.map((world, index) => automationScope.run(world.scope, () => executor.run(plan, task(index ? "b" : "a")))));
    for (const [index, output] of outputs.entries()) {
      assert.equal(worlds[index]!.calls(), 18);
      assert.match(output.answer, /Actually updated/);
      assert.equal(output.totalTokens, 38);
      const events = worlds[index]!.events.filter(event => event.kind === "organization-node");
      assert.equal(events.filter(event=>event.nodeType === "INTERACTION.OBSERVE").length,18);
      assert.equal(events.filter(event=>event.nodeType === "INTERACTION.ACT.TOOL").length,18);
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
  const runtime = createDitto({ sandbox: { tools: ["api_fetch"] }, workers: [createContextWorker(), createInferWorker({ providers: { fake: provider } }), createInteractionWorker({ tools: createAutomationTools(), output: {async deliver(input) {return {deliveryId:input.deliveryId,status:"accepted" as const};}} })] });
  const executor = new WorkflowExecutor(runtime, "fake", "fake");
  const plan = buildOrganizationPlan(initialOrganization("automationbench"));
  try { await assert.rejects(automationScope.run(session("broken", true).scope, () => executor.run(plan, task("broken"))), /bridge disconnected/); }
  finally { await runtime.close(); }
});

test("tool batches execute once and request IDs may be reused in a later model turn", async () => {
  for (const batch of [true, false]) {
    let turns = 0;
    const world = session("batch");
    const provider: ModelProvider = { async invoke(input) {
      const turn = turns++;
      if (turn < (batch ? 1 : 2)) return { message: { role: "assistant", content: "" }, finishReason: "action_request",
        actionRequests: (batch ? ["same", "second"] : ["same"]).map(id => ({ id, name: "api_fetch", arguments: { world: "batch" } })) };
      assert.equal(input.messages.filter(m => m.role === "tool").length, 2);
      assert.equal(input.messages.filter(m => m.role === "assistant").length, batch ? 1 : 2);
      return { message: { role: "assistant", content: "done" }, finishReason: "length" };
    } };
    const runtime = createDitto({ sandbox: { tools: ["api_fetch"] }, workers: [createContextWorker(), createInferWorker({ providers: { fake: provider } }), createInteractionWorker({ tools: createAutomationTools(), output: { async deliver(input) { return { deliveryId: input.deliveryId, status: "accepted" as const }; } } })] });
    try {
      const executor = new WorkflowExecutor(runtime, "fake", "fake");
      const result = await automationScope.run(world.scope, () => executor.run(buildOrganizationPlan(initialOrganization("automationbench")), task("batch")));
      assert.equal(world.calls(), 2); assert.equal(result.answer, "done");
    } finally { await runtime.close(); }
  }
});
