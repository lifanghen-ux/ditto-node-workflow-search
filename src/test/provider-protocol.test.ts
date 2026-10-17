import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PythonTransport } from "../ditto/python-transport.js";
import { loadProviderSettings } from "../config.js";
import { GENERATION } from "../protocol.js";
import { createInitialTrajectoryNode, validateNode } from "../workflow/spec.js";

const python = process.env.DITTO_PROVIDER_PYTHON || process.env.AFLOW_SCORER_PYTHON || "python";

test("offline provider SDK tests cover request settings, stream assembly, retries and deadlines", () => {
  const result = spawnSync(python, ["-B", fileURLToPath(new URL("../../scripts/provider_bridge_test.py", import.meta.url))], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test("compiled transport finds the bridge and sends the fixed streaming protocol", async () => {
  let observed: Record<string, unknown> | undefined;
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += String(chunk);
    observed = JSON.parse(raw) as Record<string, unknown>;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ id: "fixture", model: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "answer" }, finish_reason: "stop" }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const transport = new PythonTransport({ baseUrl: `http://127.0.0.1:${address.port}`, model: "fixture", apiKey: "fixture", concurrency: 1, timeoutMs: 5000 });
  try {
    const response = await transport.fetch("http://ignored", { body: JSON.stringify({ model: "fixture", messages: [], temperature: 0.2, max_tokens: 128, top_p: 1, reasoning_effort: "high" }) });
    assert.equal(response.status, 200);
    const result = await response.json() as { choices: { message: { content: string }; finish_reason: string }[]; usage: { total_tokens: number } };
    assert.equal(result.choices[0]?.message.content, "answer");
    assert.equal(result.usage.total_tokens, 3);
    assert.deepEqual(observed?.thinking, { type: "disabled" });
    assert.equal(observed?.temperature, 0);
    assert.equal(observed?.max_tokens, 393216);
    assert.equal(observed?.stream, true);
    assert.equal(observed?.n, 1);
    assert.deepEqual(observed?.response_format, { type: "text" });
    assert.equal("top_p" in observed!, false);
    assert.equal("reasoning_effort" in observed!, false);
  } finally {
    await transport.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("delivery defaults accept DS_API_KEY and new trajectory plans carry no small ceiling", () => {
  const settings = loadProviderSettings({ DS_API_KEY: "fixture" });
  assert.equal(settings.baseUrl, "https://api.deepseek.com");
  assert.equal(settings.model, "deepseek-flash");
  assert.deepEqual(GENERATION, { temperature: 0, maxTokens: 393216 });
  const node = createInitialTrajectoryNode();
  assert.equal(node.config.maxSteps, undefined);
  validateNode(node);
  assert.throws(() => validateNode({ ...node, config: { ...node.config, maxSteps: 16 } }), /step truncation is disabled/);
});

test("concurrent workflow diagnostics retain missing usage, hidden retries and failed consumption", async () => {
  const { createExperimentRuntime } = await import("../ditto/runtime.js");
  const { WorkflowExecutor, WorkflowExecutionError } = await import("../workflow/executor.js");
  const { createRootNode, createInitialSampleNode, materializeAgentPlan } = await import("../workflow/spec.js");
  const calls = new Map<string, number>();
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const input = JSON.parse(body) as { messages: { content: string }[] };
    const key = input.messages[0]!.content.includes("diagnostic-multi") ? "multi" : input.messages[0]!.content;
    const count = (calls.get(key) ?? 0) + 1;
    calls.set(key, count);
    if ((key === "retry" && count === 1) || key === "failure") {
      response.writeHead(key === "retry" ? 429 : 402, { "content-type": "application/json", ...(key === "retry" ? { "retry-after": "1" } : {}) });
      response.end(JSON.stringify({ error: { message: "offline fixture" } }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ model: "fixture", choices: [{ index: 0, delta: { content: "answer" }, finish_reason: key === "length" ? "length" : "stop" }] })}\n\n`);
    if (key !== "missing" && !(key === "multi" && count === 1)) response.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const experiment = createExperimentRuntime({ baseUrl: `http://127.0.0.1:${address.port}`, model: "fixture", apiKey: "fixture", concurrency: 3, timeoutMs: 5000 });
  const executor = new WorkflowExecutor(experiment.runtime, experiment.providerName, experiment.model);
  const plan = materializeAgentPlan("usage", [createRootNode(), createInitialSampleNode()]);
  const run = (prompt: string) => executor.run(plan, { id: prompt, dataset: "math", prompt, outputInstruction: "", metadata: {} });
  try {
    const [known, missing, retry] = await Promise.all([run("known"), run("missing"), run("retry")]);
    assert.equal(known.usageKnown, true);
    assert.equal(known.providerAttempts, 1);
    assert.equal(known.totalTokens, 7);
    assert.equal(missing.usageKnown, false);
    assert.equal(missing.totalTokens, 0, "zero is only a lower bound when usage is absent");
    assert.equal(missing.unknownUsageAttempts, 1);
    assert.equal(retry.usageKnown, false);
    assert.equal(retry.providerAttempts, 2);
    assert.equal(retry.failedProviderAttempts, 1);
    assert.equal(retry.unknownUsageAttempts, 1);
    assert.equal(retry.totalTokens, 7);
    assert.equal(new Set([known, missing, retry].map((result) => result.providerDiagnostics?.[0]?.requestId)).size, 3, "parallel workflows must retain only their own request");
    const trajectory = createInitialTrajectoryNode("diagnostic-multi");
    const multiPlan = materializeAgentPlan("multi", [createRootNode(), { ...trajectory, config: { ...trajectory.config, options: { rounds: 2 } } }]);
    const multi = await executor.run(multiPlan, { id: "multi", dataset: "math", prompt: "problem", outputInstruction: "", metadata: {} });
    assert.equal(multi.providerAttempts, 2);
    assert.equal(multi.unknownUsageAttempts, 1, "an unknown intermediate call cannot disappear behind a known final response");
    assert.equal(multi.usageKnown, false);
    assert.equal(multi.totalTokens, 7);
    for (const prompt of ["failure", "length"]) {
      await assert.rejects(run(prompt), (error: unknown) => {
        assert.ok(error instanceof WorkflowExecutionError);
        assert.equal(error.usageKnown, prompt === "length");
        assert.equal(error.providerAttempts, 1);
        assert.equal(error.providerDiagnostics.length, 1);
        assert.equal(error.totalTokens, prompt === "length" ? 7 : 0);
        return true;
      });
    }
  } finally {
    await experiment.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
