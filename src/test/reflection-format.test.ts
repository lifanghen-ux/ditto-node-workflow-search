import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import type { SampleInput, ModelProvider } from "@codesoul-co/ditto/worker/infer";
import { withReflectionFormatRepair, validateReflectionResponse, type ReflectionRepairEvent } from "../ditto/reflection-format.js";
import { createExperimentRuntime, limitProviderConcurrency } from "../ditto/runtime.js";
import { WorkflowExecutor, WorkflowExecutionError } from "../workflow/executor.js";
import { createInitialSampleNode, createRootNode, materializeAgentPlan } from "../workflow/spec.js";
import { GENERATION } from "../protocol.js";

const invalidNull = JSON.stringify({ assessment: { passed: true, summary: "correct" }, issues: [{ severity: "info", description: "checked", suggestedFix: null }] });
const valid = JSON.stringify({ assessment: { passed: true, summary: "correct" }, issues: [] });
const input: SampleInput = { model: { model: "fixture" }, generation: GENERATION, metadata: { nodeType: "INFER.REASONING.REFLECT", nodeId: "reflect-1", taskId: "fixture" }, messages: [{ role: "system", content: "Reflect" }, { role: "user", content: JSON.stringify({ mode: "verify", target: { result: { role: "assistant", content: "2" } } }) }] };

test("REFLECT-only repairs null optional field and non-JSON with feedback on the third response", async () => {
  const requests: SampleInput[] = [];
  const events: ReflectionRepairEvent[] = [];
  const contents = [invalidNull, "not JSON", valid];
  const provider: ModelProvider = { async invoke(request) {
    requests.push(request);
    return { message: { role: "assistant", content: contents[requests.length - 1]! }, finishReason: "stop", usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } };
  } };
  const repaired = withReflectionFormatRepair(limitProviderConcurrency(provider, 1), (event) => { events.push(event); });
  const result = await repaired.invoke(input, { signal: new AbortController().signal });
  assert.equal(result.message.content, valid);
  assert.deepEqual(result.usage, { inputTokens: 6, outputTokens: 9, totalTokens: 15 });
  assert.equal(requests.length, 3);
  assert.ok(requests.every((request) => request.generation === GENERATION));
  assert.deepEqual(requests[1]!.messages.slice(0, 2), input.messages);
  assert.equal(requests[1]!.messages[2]!.content, invalidNull);
  assert.match(String(requests[1]!.messages[3]!.content), /suggestedFix must be a string/);
  assert.equal(requests[2]!.messages[2]!.content, "not JSON");
  assert.match(String(requests[2]!.messages[3]!.content), /valid JSON object/);
  assert.deepEqual(events.map((event) => event.outcome), ["retry", "retry", "recovered"]);
  assert.ok(events.every((event) => !("content" in event) && !("target" in event)));
});

test("exhausted format failures are bounded; other Nodes and provider failures are not format-retried", async () => {
  let calls = 0;
  const malformed: ModelProvider = { async invoke() { calls++; return { message: { role: "assistant", content: invalidNull }, finishReason: "stop" }; } };
  await assert.rejects(withReflectionFormatRepair(malformed).invoke(input, { signal: new AbortController().signal }), /REFLECT_FORMAT_ERROR/);
  assert.equal(calls, 3);
  calls = 0;
  await withReflectionFormatRepair(malformed).invoke({ ...input, metadata: { nodeType: "INFER.REASONING.SAMPLE" } }, { signal: new AbortController().signal });
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(withReflectionFormatRepair({ async invoke() { calls++; throw new Error("HTTP 402"); } }).invoke(input, { signal: new AbortController().signal }), /HTTP 402/);
  assert.equal(calls, 1);
  assert.throws(() => validateReflectionResponse(JSON.stringify({ assessment: { summary: "ok" }, issues: [] }), "verify"), /assessment.passed/);
  assert.throws(() => validateReflectionResponse(valid, "revise"), /message must be an object/);
});

test("SDK bridge and unmodified Core REFLECT preserve all repair consumption and reject exhaustion", async () => {
  let reflectCalls = 0;
  let exhausted = false;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const payload = JSON.parse(body) as { messages: { content: string }[]; temperature: number; max_tokens: number };
    assert.equal(payload.temperature, 0);
    assert.equal(payload.max_tokens, 393216);
    const reflecting = payload.messages[0]?.content.startsWith("Assess the supplied target");
    const content = reflecting ? (exhausted ? invalidNull : [invalidNull, "not JSON", valid][reflectCalls++ % 3]!) : "2";
    if (reflecting) assert.ok(payload.messages[1]!.content.includes('"mode":"verify"'));
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address === "object");
  const experiment = createExperimentRuntime({ baseUrl: `http://127.0.0.1:${address.port}`, model: "fixture", apiKey: "fixture", concurrency: 1, timeoutMs: 5000 });
  const executor = new WorkflowExecutor(experiment.runtime, experiment.providerName, experiment.model);
  const plan = materializeAgentPlan("reflection", [createRootNode(), createInitialSampleNode(), { id: "reflect-1", type: "INFER.REASONING.REFLECT", graphId: "refine", dependencies: [], config: { mode: "verify", criteria: ["correctness"], generation: GENERATION } }]);
  const task = { id: "fixture", dataset: "math" as const, prompt: "1+1", outputInstruction: "", metadata: {} };
  try {
    const result = await executor.run(plan, task);
    assert.equal(result.answer, "2", "verification format repair must preserve the original mathematical answer");
    assert.equal(reflectCalls, 3);
    assert.equal(result.providerAttempts, 4);
    assert.equal(result.totalTokens, 20);
    assert.equal(result.usageKnown, true);
    exhausted = true;
    await assert.rejects(executor.run(plan, task), (error: unknown) => {
      assert.ok(error instanceof WorkflowExecutionError);
      assert.match(error.message, /REFLECT_FORMAT_ERROR/);
      assert.equal(error.providerAttempts, 4);
      assert.equal(error.totalTokens, 20);
      assert.equal(error.usageKnown, true);
      return true;
    });
  } finally {
    await experiment.close(); server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
