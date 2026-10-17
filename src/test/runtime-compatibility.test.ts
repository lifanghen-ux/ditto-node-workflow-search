import assert from "node:assert/strict";
import test from "node:test";
import { createHttpProvider, type ModelProvider, type SampleInput, type SampleOutput } from "@codesoul-co/ditto/worker/infer";
import { Sandbox } from "@codesoul-co/ditto/runtime/sandbox";
import type { MemoryResources } from "@codesoul-co/ditto/worker/memory";
const AUTOMATION_GENERATION = Object.freeze({ temperature: 0, maxTokens: 393216 });
const AUTOMATION_PROVIDER_OPTIONS = Object.freeze({ thinking: { type: "disabled" }, n: 1, response_format: { type: "text" } });
import { GENERATION } from "../protocol.js";
import { applyModelProfile, createExperimentRuntime, limitProviderConcurrency } from "../ditto/runtime.js";
import { PythonTransport } from "../ditto/python-transport.js";

const settings = { baseUrl: "https://example.invalid", model: "fixture", apiKey: "offline-fixture", concurrency: 1, timeoutMs: 600_000 };
const input: SampleInput = { model: { model: "fixture", providerOptions: { top_p: 0.5, reasoning_effort: "high", thinking: { type: "enabled" } } },
  messages: [{ role: "user", content: "fixture" }], generation: { ...GENERATION } };
const output: SampleOutput = { message: { role: "assistant", content: "done" }, finishReason: "stop" };
const callOptions = { signal: new AbortController().signal };

test("automation profile covers invoke and stream while MATH preserves its original inputs", async () => {
  const received: SampleInput[] = [];
  const original: ModelProvider = {
    async invoke(value) { received.push(value); return output; },
    async *stream(value) { received.push(value); yield { type: "result", output }; },
  };
  const provider = applyModelProfile(original, "automationbench");
  await provider.invoke(input, callOptions);
  for await (const event of provider.stream!(input, callOptions)) assert.equal(event.type, "result");
  for (const value of received) {
    assert.deepEqual(value.generation, AUTOMATION_GENERATION);
    assert.deepEqual(value.model.providerOptions, AUTOMATION_PROVIDER_OPTIONS);
  }
  assert.equal(applyModelProfile(original, "math"), original);
  assert.deepEqual(input.generation, GENERATION);
  assert.equal(input.model.providerOptions?.top_p, 0.5);
});

test("four public workers route Memory and supplied Interaction tools without owning an injected provider", async () => {
  const unsupported = async (): Promise<never> => { throw new Error("unused"); };
  const memory: MemoryResources = { store: { async get() { return []; }, query: unsupported, write: unsupported, update: unsupported, delete: unsupported } };
  let calls = 0;
  const provider: ModelProvider = { async invoke() { calls++; return output; } };
  const experiment = createExperimentRuntime(settings, { profile: "automationbench", memory, provider, tools: [{
    name: "echo", inputSchema: { type: "object" }, validate() {}, async execute(arguments_) { return { status: "success", content: String(arguments_.text) }; },
  }] });
  try {
    assert.equal(experiment.runtime.workers().length, 4);
    const loaded = await experiment.runtime.invoke("CONTEXT.LOAD", { sources: Array.from({ length: 300 }, (_, index) => ({
      id: `context-${index}`, content: index === 0 ? "x".repeat(65_537) : "item",
    })) });
    assert.equal(loaded.items.length, 300);
    assert.equal(String(loaded.items[0]?.content).length, 65_537);
    assert.equal((await experiment.runtime.invoke("MEMORY.GET", { ids: ["unused"] })).status, "success");
    assert.equal((await experiment.runtime.invoke("INTERACTION.ACT.TOOL", { call: { id: "1", name: "echo", arguments: { text: "hello" } } })).content, "hello");
    assert.equal((await experiment.runtime.invoke("INFER.REASONING.SAMPLE", input)).status, "success");
    assert.equal(calls, 1);
  } finally { await experiment.close(); }
  await provider.invoke(input, callOptions);
  assert.equal(calls, 2);
  const math = createExperimentRuntime(settings, { provider });
  try {
    assert.equal(math.runtime.workers().length, 2);
    await assert.rejects(math.runtime.invoke("CONTEXT.LOAD", { sources: [{ id: "large", content: "x".repeat(65_537) }] }), /inline byte limit/);
  } finally { await math.close(); }
});

test("one provider limit covers streamed and ordinary requests and releases an abandoned iterator", async () => {
  let invokeCalls = 0;
  const provider = limitProviderConcurrency({
    async invoke() { invokeCalls++; return output; },
    async *stream() { yield { type: "text_delta", delta: "partial" }; yield { type: "result", output }; },
  }, 1);
  const iterator = provider.stream!(input, callOptions)[Symbol.asyncIterator]();
  await iterator.next();
  const queued = provider.invoke(input, callOptions);
  await Promise.resolve();
  assert.equal(invokeCalls, 0);
  await iterator.return?.();
  assert.deepEqual(await queued, output);
  assert.equal(invokeCalls, 1);

  const held = provider.stream!(input, callOptions)[Symbol.asyncIterator]();
  await held.next();
  const cancellation = new AbortController();
  const cancelled = provider.invoke(input, { signal: cancellation.signal });
  cancellation.abort(new Error("queued cancelled"));
  await assert.rejects(cancelled, /queued cancelled/);
  await held.return?.();
  await provider.invoke(input, callOptions);
  assert.equal(invokeCalls, 2);
});

// This subprocess exercises the real JSONL transport and npm SSE parser offline.
const fixtureProcess = String.raw`
import { createInterface } from 'node:readline';
const emit = record => process.stdout.write(JSON.stringify(record) + '\n');
const cancelled = [];
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.cancel !== undefined) { cancelled.push(request.cancel); return; }
  const { id, body } = request;
  if (body.mode === 'inspect') { emit({ id, status: 200, body: { cancelled } }); return; }
  if (body.mode === 'pending') return;
  emit({ id, status: 200, event: 'start' });
  if (body.mode === 'crash') { process.exit(7); return; }
  if (body.mode === 'error') { emit({ id, status: 599, event: 'error', body: { error: { type: 'FixtureError' } } }); return; }
  if (body.mode === 'wait') { emit({ id, event: 'chunk', body: { choices: [{ delta: { content: 'partial' } }] } }); return; }
  emit({ id, event: 'chunk', body: { choices: [{ index: 0, delta: { content: 'read ', reasoning_content: 'fixture reasoning', tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'read_', arguments: '{"path":' } }] } }] } });
  emit({ id, event: 'chunk', body: { choices: [{ index: 0, delta: { content: 'file', tool_calls: [{ index: 0, function: { name: 'file', arguments: '"x"}' } }] }, finish_reason: 'tool_calls' }] } });
  emit({ id, event: 'chunk', body: { choices: [], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6, prompt_tokens_details: { cached_tokens: 1 } } } });
  emit({ id, event: 'end' });
});`;

function fixtureTransport(): PythonTransport {
  return new PythonTransport(settings, { profile: "automationbench", command: process.execPath, arguments: ["--input-type=module", "-e", fixtureProcess] });
}

test("JSONL transport streams real SSE with text, split tool calls, finish reason and trailing usage", async () => {
  const transport = fixtureTransport();
  try {
    const provider = createHttpProvider({ kind: "openai-compatible", baseUrl: settings.baseUrl,
      sandbox: new Sandbox(process.cwd(), { network: [settings.baseUrl] }), fetch: transport.fetch });
    const events = [];
    for await (const event of provider.stream!(input, callOptions)) events.push(event);
    assert.deepEqual(events.filter(event => event.type === "text_delta").map(event => event.delta), ["read ", "file"]);
    const result = events.find(event => event.type === "result");
    assert.ok(result?.type === "result");
    assert.equal(result.output.finishReason, "action_request");
    assert.deepEqual(result.output.actionRequests, [{ id: "call-1", name: "read_file", arguments: { path: "x" } }]);
    assert.deepEqual(result.output.usage, { inputTokens: 4, outputTokens: 2, totalTokens: 6, cachedInputTokens: 1 });
    assert.equal(result.output.message.metadata?.reasoningContent, "fixture reasoning");
  } finally { await transport.close(); }
});

test("JSONL transport cancels pending and active streams and propagates bridge errors", async () => {
  const transport = fixtureTransport();
  const send = (mode: string, signal?: AbortSignal): Promise<Response> => transport.fetch(settings.baseUrl, {
    body: JSON.stringify({ mode }), ...(signal ? { signal } : {}),
  });
  try {
    const controller = new AbortController();
    const pending = send("pending", controller.signal);
    controller.abort();
    await assert.rejects(pending, /cancelled/);
    const active = new AbortController();
    const stream = await send("wait", active.signal);
    const reader = stream.body!.getReader();
    await reader.read();
    const next = reader.read();
    active.abort();
    await assert.rejects(next, /cancelled/);
    const error = await send("error");
    await assert.rejects(error.text(), /failed/);
    const inspection = await (await send("inspect")).json() as { cancelled: number[] };
    assert.deepEqual(inspection.cancelled, [1, 2]);
    const closing = await send("wait");
    const closingText = closing.text();
    const closeError = assert.rejects(closingText, /closed/);
    await transport.close();
    await closeError;
  } finally { await transport.close(); }
});

test("JSONL transport propagates subprocess exit to an active streamed response", async () => {
  const transport = fixtureTransport();
  try {
    const response = await transport.fetch(settings.baseUrl, { body: JSON.stringify({ mode: "crash" }) });
    await assert.rejects(response.text(), /exited \(7\)/);
  } finally { await transport.close(); }
});
