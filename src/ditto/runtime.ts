import { createDitto, type DittoRuntime } from "@codesoul-co/ditto/runtime";
import { Sandbox } from "@codesoul-co/ditto/runtime/sandbox";
import { createContextWorker } from "@codesoul-co/ditto/worker/context";
import { createHttpProvider, createInferWorker, type ModelProvider } from "@codesoul-co/ditto/worker/infer";
import type { ProviderSettings } from "../config.js";
import { PythonTransport } from "./python-transport.js";

export interface ExperimentRuntime {
  readonly runtime: DittoRuntime;
  readonly providerName: string;
  readonly model: string;
  close(): Promise<void>;
}

/** npm Graph/Loop/Workers; injected transport uses AFlow's installed SDK. */
export function createExperimentRuntime(settings: ProviderSettings): ExperimentRuntime {
  const sandbox = new Sandbox(process.cwd(), { network: [new URL(settings.baseUrl).origin] });
  const transport = new PythonTransport(settings);
  // Per-request timeouts/retries live in OpenAI's SDK (connect 5s, read 600s).
  // A multi-call Node must not inherit a 600s total deadline including queue time.
  const nodeDeadline = 2 ** 31 - 1;
  const http = createHttpProvider({
    kind: "openai-compatible", baseUrl: settings.baseUrl, apiKey: settings.apiKey,
    maxTokensField: "max_tokens", sandbox, fetch: transport.fetch,
    providerOptions: { top_p: 1 }, timeoutMs: nodeDeadline,
  });
  const providerName = "deepseek";
  const runtime = createDitto({ workers: [
    createContextWorker(),
    createInferWorker({
      providers: { [providerName]: limitProviderConcurrency(http, settings.concurrency) },
      defaultProvider: providerName, timeoutMs: nodeDeadline,
    }),
  ] });
  return Object.freeze({ runtime, providerName, model: settings.model,
    async close() { try { await runtime.close(); } finally { await transport.close(); } },
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
  };
}
