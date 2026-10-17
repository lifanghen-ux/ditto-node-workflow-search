import { createDitto, type DittoRuntime } from "@codesoul-co/ditto/runtime";
import { Sandbox } from "@codesoul-co/ditto/runtime/sandbox";
import { createContextWorker } from "@codesoul-co/ditto/worker/context";
import { createMemoryWorker, type MemoryResources } from "@codesoul-co/ditto/worker/memory";
import { GENERATION } from "../protocol.js";
import { createInteractionWorker, type RegisteredTool } from "@codesoul-co/ditto/worker/interaction";
import { createAutomationTools } from "./automation-tools.js";
import { AUTOMATION_TOOLS, automationScope } from "../benchmark/automation.js";
import { createHttpProvider, createInferWorker, type ModelProvider } from "@codesoul-co/ditto/worker/infer";
import type { ProviderSettings } from "../config.js";
import { PythonTransport } from "./python-transport.js";
import { captureProviderDiagnostics, currentProviderDiagnostics, summarizeProviderDiagnostics } from "./provider-diagnostics.js";
import { acceptReceivedOutput } from "./output-limit.js";
import { withBaselineRepetitionGuidance } from "./repetition-guidance.js";
import { withReflectionFormatRepair } from "./reflection-format.js";
import { appendFile } from "node:fs/promises";

export interface ExperimentRuntime {
  readonly runtime: DittoRuntime;
  readonly provider: ModelProvider;
  readonly providerName: string;
  readonly model: string;
  close(): Promise<void>;
}

export interface ExperimentRuntimeOptions {
  readonly profile?: "math" | "automationbench";
  readonly tools?: readonly RegisteredTool[];
  readonly memory?: MemoryResources;
  readonly provider?: ModelProvider;
}

export function applyModelProfile(provider: ModelProvider, profile: "math" | "automationbench"): ModelProvider {
  if (profile === "math") return provider;
  function configure(input: Parameters<ModelProvider["invoke"]>[0]): Parameters<ModelProvider["invoke"]>[0] {
    const providerOptions = { ...input.model.providerOptions, thinking: { type: "disabled" }, n: 1, response_format: { type: "text" } } as Record<string, unknown>;
    delete providerOptions.top_p; delete providerOptions.reasoning_effort;
    return { ...input, generation: GENERATION, model: { ...input.model, providerOptions } };
  }
  return {
    invoke: (input, options) => provider.invoke(configure(input), options),
    ...(provider.stream ? { stream: (input, options) => provider.stream!(configure(input), options) } satisfies Pick<ModelProvider, "stream"> : {}),
  };
}

/** Published Graph/Loop/Workers with an independently pinned Python SDK transport. */
export function createExperimentRuntime(settings: ProviderSettings, options: ExperimentRuntimeOptions = {}): ExperimentRuntime {
  const sandbox = new Sandbox(process.cwd(), { network: [new URL(settings.baseUrl).origin] });
  const transport = options.provider ? undefined : new PythonTransport(settings, { profile: options.profile ?? "math" });
  // The Python bridge enforces settings.timeoutMs per request, including retries.
  // A multi-call Node must not inherit a 600s total deadline including queue time.
  const nodeDeadline = 2 ** 31 - 1;
  const http = options.provider ?? createHttpProvider({
    kind: "openai-compatible", baseUrl: settings.baseUrl, apiKey: settings.apiKey,
    maxTokensField: "max_tokens", sandbox, fetch: transport!.fetch,
    providerOptions: { thinking: { type: "disabled" }, response_format: { type: "text" } }, timeoutMs: nodeDeadline,
  });
  const checked = withReflectionFormatRepair(limitProviderConcurrency(withBaselineRepetitionGuidance(http), settings.concurrency), async (event) => {
    if (process.env.DITTO_PROVIDER_LOG) await appendFile(process.env.DITTO_PROVIDER_LOG,
      JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n", "utf8");
  });
  const providerName = "deepseek";
  const traced: ModelProvider = {
    async invoke(input, options) {
      automationScope.getStore()?.assertHealthy();
      const workflowRecords = currentProviderDiagnostics();
      return captureProviderDiagnostics(async (records) => {
        try {
          const output = acceptReceivedOutput(input, await checked.invoke(input, options));
          const diagnostics = summarizeProviderDiagnostics(records);
          return { ...output, message: { ...output.message,
            metadata: { ...output.message.metadata, providerDiagnostics: diagnostics },
          } };
        } finally {
          workflowRecords?.push(...records);
        }
      });
    },
  };
  const automation = options.profile === "automationbench";
  const tools = options.tools ?? (automation ? createAutomationTools() : []);
  const runtime = createDitto({ sandbox: { tools: tools.map(tool => tool.name) }, workers: [
    createContextWorker(automation ? { policy: { maxItems: 1_000_000, maxInlineBytes: 1_000_000 } } : {}),
    ...(automation || options.tools ? [createInteractionWorker({ tools, output: { async deliver(input) { return { deliveryId: input.deliveryId, status: "accepted" as const }; } } })] : []),
    ...(options.memory ? [createMemoryWorker(options.memory)] : []),
    createInferWorker({
      providers: { [providerName]: traced },
      defaultProvider: providerName, timeoutMs: nodeDeadline,
    }),
  ] });
  return Object.freeze({ runtime, provider: traced, providerName, model: settings.model,
    async close() { try { await runtime.close(); } finally { await transport?.close(); } },
  });
}

/** Direct handoff reserves the slot for the queued caller; newcomers cannot steal it. */
export function limitProviderConcurrency(provider: ModelProvider, maximum: number): ModelProvider {
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error("Invalid provider concurrency");
  let active = 0;
  const queue: Array<{ grant(): void; reject(error: unknown): void; signal: AbortSignal; abort(): void }> = [];
  function release(): void {
    const next = queue.shift();
    if (next) {
      next.signal.removeEventListener("abort", next.abort);
      next.grant();
    } else active--;
  }
  async function acquire(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (active < maximum) { active++; return; }
    await new Promise<void>((grant, reject) => {
      const item = { grant, reject, signal, abort: (): void => {
        const index = queue.indexOf(item);
        if (index >= 0) queue.splice(index, 1);
        reject(signal.reason);
      } };
      queue.push(item);
      signal.addEventListener("abort", item.abort, { once: true });
    });
  }
  return {
    async invoke(input, options) {
      await acquire(options.signal);
      try { options.signal.throwIfAborted(); return await provider.invoke(input, options); }
      finally { release(); }
    },
    ...(provider.stream ? { async *stream(input, options) {
      await acquire(options.signal);
      try { options.signal.throwIfAborted(); yield* provider.stream!(input, options); }
      finally { release(); }
    } } satisfies Pick<ModelProvider, "stream"> : {}),
  };
}
