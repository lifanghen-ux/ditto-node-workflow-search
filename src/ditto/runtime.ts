import { createDitto, type DittoRuntime } from "@codesoul-co/ditto/runtime";
import { Sandbox } from "@codesoul-co/ditto/runtime/sandbox";
import { createContextWorker } from "@codesoul-co/ditto/worker/context";
import {
  createHttpProvider,
  createInferWorker,
  type ModelProvider,
  type ModelStreamEvent,
} from "@codesoul-co/ditto/worker/infer";
import type { ProviderSettings } from "../config.js";

export interface ExperimentRuntime {
  readonly runtime: DittoRuntime;
  readonly providerName: string;
  readonly model: string;
  close(): Promise<void>;
}

/** Create Ditto entirely from public npm exports. No source imports or node_modules patches. */
export function createExperimentRuntime(settings: ProviderSettings): ExperimentRuntime {
  const origin = new URL(settings.baseUrl).origin;
  const sandbox = new Sandbox(process.cwd(), { network: [origin] });
  const http = createHttpProvider({
    kind: "openai-compatible",
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
    maxTokensField: "max_tokens",
    sandbox,
    timeoutMs: settings.timeoutMs,
  });
  const providerName = "codesoul";
  const limited = limitProviderConcurrency(http, settings.concurrency);
  const runtime = createDitto({
    workers: [
      createContextWorker(),
      // Provider calls queue at the shared semaphore. A finite Worker concurrency would
      // reject bursts because Ditto intentionally has no hidden invocation queue.
      createInferWorker({
        providers: { [providerName]: limited },
        defaultProvider: providerName,
        timeoutMs: settings.timeoutMs,
      }),
    ],
  });
  return Object.freeze({
    runtime,
    providerName,
    model: settings.model,
    close: () => runtime.close(),
  });
}

export function limitProviderConcurrency(provider: ModelProvider, maximum: number): ModelProvider {
  const semaphore = new Semaphore(maximum);
  return {
    invoke: (input, options) => semaphore.run(options.signal, () => provider.invoke(input, options)),
    ...(provider.stream ? {
      stream: (input: Parameters<NonNullable<ModelProvider["stream"]>>[0], options: Parameters<NonNullable<ModelProvider["stream"]>>[1]) =>
        limitedStream(semaphore, options.signal, () => provider.stream!(input, options)),
    } : {}),
  };
}

async function* limitedStream(
  semaphore: Semaphore,
  signal: AbortSignal,
  create: () => AsyncIterable<ModelStreamEvent>,
): AsyncIterable<ModelStreamEvent> {
  const release = await semaphore.acquire(signal);
  try {
    yield* create();
  } finally {
    release();
  }
}

class Semaphore {
  readonly #maximum: number;
  #active = 0;
  readonly #waiters: Array<() => void> = [];

  constructor(maximum: number) {
    if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error("Provider concurrency must be a positive integer");
    this.#maximum = maximum;
  }

  async run<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.#active < this.#maximum) {
      this.#active++;
      return this.#releaseOnce();
    }
    await new Promise<void>((resolve, reject) => {
      const wake = (): void => {
        signal.removeEventListener("abort", abort);
        resolve();
      };
      const abort = (): void => {
        const index = this.#waiters.indexOf(wake);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(signal.reason);
      };
      this.#waiters.push(wake);
      signal.addEventListener("abort", abort, { once: true });
    });
    signal.throwIfAborted();
    this.#active++;
    return this.#releaseOnce();
  }

  #releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active--;
      this.#waiters.shift()?.();
    };
  }
}
