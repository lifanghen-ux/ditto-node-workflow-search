import assert from "node:assert/strict";
import test from "node:test";
import { createHttpProvider, type SampleInput } from "@codesoul-co/ditto/worker/infer";
import { Sandbox } from "@codesoul-co/ditto/runtime/sandbox";
import { applyModelProfile, admitProviderCalls } from "../ditto/runtime.js";
import { EXPERIMENT_EXECUTION, EXPERIMENT_GENERATION, EXPERIMENT_PROVIDER_OPTIONS } from "../model-profile.js";
import { loadProviderSettings, parseArguments } from "../config.js";
import { createInitialTrajectoryNode } from "../workflow/spec.js";

test("all request paths override stale sampling settings before HTTP serialization", async () => {
  for (const profile of ["math", "automationbench"] as const) {
    const bodies: Record<string, unknown>[] = [];
    const http = createHttpProvider({ kind: "openai-compatible", baseUrl: "https://example.invalid", maxTokensField: "max_tokens",
      sandbox: new Sandbox(process.cwd(), { network: ["https://example.invalid"] }),
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "36" }, finish_reason: "stop" }] }),
          { headers: { "content-type": "application/json" } });
      },
    });
    const input: SampleInput = { messages: [{ role: "user", content: "public question" }],
      model: { model: "deepseek-flash", providerOptions: { top_p: 0.8, reasoning_effort: "high", seed: 42, thinking: { type: "enabled" } } },
      generation: { temperature: 0.9, topP: 0.2, maxTokens: 128 } };
    await applyModelProfile(http, profile).invoke(input, { signal: new AbortController().signal });
    const body = bodies[0]!;
    assert.equal(body.temperature, 0);
    assert.equal(body.max_tokens, 393216);
    assert.equal(body.n, 1);
    assert.deepEqual(body.thinking, { type: "disabled" });
    assert.deepEqual(body.response_format, { type: "text" });
    for (const key of ["top_p", "reasoning_effort", "seed"]) assert.equal(key in body, false);
    assert.equal(input.generation!.temperature, 0.9, "normalization must not mutate frozen artifacts");
  }
});

test("invoke and stream receive the same immutable generation policy", async () => {
  const seen: SampleInput[] = [];
  const output = { message: { role: "assistant" as const, content: "done" }, finishReason: "stop" as const };
  const provider = applyModelProfile({
    async invoke(input) { seen.push(input); return output; },
    async *stream(input) { seen.push(input); yield { type: "result" as const, output }; },
  }, "math");
  const input: SampleInput = { messages: [], model: { model: "fixture" }, generation: { maxTokens: 16 } };
  const options = { signal: new AbortController().signal };
  await provider.invoke(input, options);
  for await (const _event of provider.stream!(input, options)) { /* consume */ }
  assert.equal(seen.length, 2);
  for (const value of seen) {
    assert.deepEqual(value.generation, EXPERIMENT_GENERATION);
    assert.deepEqual(value.model.providerOptions, EXPERIMENT_PROVIDER_OPTIONS);
  }
  assert.equal(createInitialTrajectoryNode().config.maxSteps, Number.MAX_SAFE_INTEGER);
  assert.equal(EXPERIMENT_EXECUTION.maxIterations, Number.MAX_SAFE_INTEGER);
});

test("formal CLI rejects sampling and model or endpoint drift", () => {
  for (const flag of ["search-limit", "test-limit"]) {
    assert.throws(() => parseArguments(["search", "--dataset", "drop", `--${flag}`, "20"]), /complete pinned MFlow split/);
  }
  assert.equal(parseArguments(["search", "--dataset", "gsm8k"]).testLimit, 0);
  assert.equal(loadProviderSettings({ CODE_SOUL_API_KEY: "offline" }).model, "deepseek-flash");
  assert.throws(() => loadProviderSettings({ CODE_SOUL_API_KEY: "offline", CODE_SOUL_MODEL: "other" }), /fixed experiment/);
  assert.throws(() => loadProviderSettings({ CODE_SOUL_API_KEY: "offline", CODE_SOUL_BASE_URL: "https://example.invalid" }), /fixed experiment/);
});

test("host context reaches invoke and stream without mutating candidate messages", async () => {
  const seen: SampleInput[] = [];
  const output = { message: { role: "assistant" as const, content: "done" }, finishReason: "stop" as const };
  let admitted = 0;
  const provider = admitProviderCalls({
    async invoke(input) { seen.push(input); return output; },
    async *stream(input) { seen.push(input); yield { type: "result" as const, output }; },
  }, () => { admitted++; }, input => ({ ...input, messages: [{ role: "system", content: "tool reference" }, ...input.messages] }));
  const input: SampleInput = { messages: [{ role: "user", content: "public task" }], model: { model: "fixture" } };
  const options = { signal: new AbortController().signal };
  await provider.invoke(input, options);
  for await (const _event of provider.stream!(input, options)) { /* consume */ }
  assert.equal(admitted, 2);
  for (const value of seen) assert.deepEqual(value.messages, [{ role: "system", content: "tool reference" }, ...input.messages]);
  assert.equal(input.messages.length, 1);
});
