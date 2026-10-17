import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { ProviderSettings } from "../config.js";
import type { ProviderCallDiagnostics } from "../domain.js";
import { withGenerationGuidance } from "./generation-guidance.js";
import { currentProviderDiagnostics } from "./provider-diagnostics.js";

/** Public fetch injection; neither Ditto npm nor AFlow source is patched. */
export interface PythonTransportOptions {
  readonly profile?: "math" | "automationbench";
  readonly command?: string;
  readonly arguments?: readonly string[];
}
export class PythonTransport {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<number, { resolve(value: Response): void; reject(error: Error): void; cleanup(): void; controller?: ReadableStreamDefaultController<Uint8Array>; diagnostics?: ProviderCallDiagnostics[] }>();
  readonly #encoder = new TextEncoder();
  #id = 0;
  #failure: Error | undefined;
  #closed = false;
  readonly #exit: Promise<void>;
  readonly #timeoutMs: number;

  constructor(settings: ProviderSettings, options: PythonTransportOptions = {}) {
    this.#timeoutMs = settings.timeoutMs;
    const python = options.command || process.env.DITTO_PROVIDER_PYTHON || process.env.AFLOW_SCORER_PYTHON || "python";
    this.#child = spawn(python, options.arguments ? [...options.arguments] : ["-u", fileURLToPath(new URL("../../scripts/provider_bridge.py", import.meta.url))], {
      windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONIOENCODING: "utf-8", CODE_SOUL_BASE_URL: settings.baseUrl, CODE_SOUL_API_KEY: settings.apiKey },
    });
    this.#child.stdin.on("error", (error) => this.#fail(error));
    this.#child.stderr.resume();
    createInterface({ input: this.#child.stdout }).on("line", (line) => {
      try {
        const reply = JSON.parse(line) as { id: number; status: number; body: unknown; event?: "start" | "chunk" | "end" | "error"; diagnostics?: ProviderCallDiagnostics };
        const pending = this.#pending.get(reply.id);
        if (!pending) return;
        if (reply.event === "start") {
          if (pending.controller) throw new Error("Duplicate stream start");
          const stream = new ReadableStream<Uint8Array>({
            start(controller) { pending.controller = controller; },
            cancel: () => { this.#pending.delete(reply.id); pending.cleanup(); this.#child.stdin.write(JSON.stringify({ id: reply.id, cancel: reply.id }) + "\n"); },
          });
          pending.resolve(new Response(stream, { status: reply.status ?? 200, headers: { "content-type": "text/event-stream" } }));
          return;
        }
        if (reply.event === "chunk") {
          if (!pending.controller || reply.body === undefined) throw new Error("Stream chunk without start");
          pending.controller.enqueue(this.#encoder.encode(`data: ${JSON.stringify(reply.body)}\n\n`)); return;
        }
        if (reply.event === "end") {
          if (!pending.controller) throw new Error("Stream end without start");
          this.#pending.delete(reply.id); pending.cleanup();
          pending.controller.enqueue(this.#encoder.encode("data: [DONE]\n\n")); pending.controller.close(); return;
        }
        if (pending.controller) {
          this.#pending.delete(reply.id); pending.cleanup(); pending.controller.error(new Error(`Provider bridge stream failed (HTTP ${String(reply.status ?? 599)})`)); return;
        }
        const response = new Response([204, 205, 304].includes(reply.status) ? null : JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
        this.#pending.delete(reply.id);
        pending.cleanup();
        pending.diagnostics?.push(reply.diagnostics ?? {
          requestId: reply.id, attempts: 1, failedAttempts: reply.status === 200 ? 0 : 1,
          unknownUsageAttempts: 1, usageKnown: false, inputTokens: 0, outputTokens: 0, totalTokens: 0,
        });
        pending.resolve(response);
      } catch {
        this.#fail(new Error("Provider bridge protocol error"));
      }
    });
    this.#exit = new Promise<void>((resolve) => {
      this.#child.once("error", (error) => { this.#fail(error); resolve(); });
      this.#child.once("close", (code) => {
        this.#fail(new Error(`Provider bridge exited (${String(code)})`));
        resolve();
      });
    });
  }

  readonly fetch: typeof globalThis.fetch = async (_url, init) => {
    if (this.#closed) throw new Error("Provider bridge closed");
    init = withGenerationGuidance(init);
    if (this.#failure) throw this.#failure;
    init?.signal?.throwIfAborted();
    if (typeof init?.body !== "string") throw new Error("Provider bridge requires a JSON body");
    const id = ++this.#id;
    const body: unknown = JSON.parse(init.body);
    const diagnostics = currentProviderDiagnostics();
    return new Promise<Response>((resolve, reject) => {
      const aborted = (): void => {
        const pending = this.#pending.get(id);
        this.#pending.delete(id);
        cleanup();
        this.#child.stdin.write(JSON.stringify({ id, cancel: id }) + "\n");
        if (pending?.controller) pending.controller.error(new Error("Provider bridge request cancelled"));
        else reject(new Error("Provider bridge request cancelled"));
      };
      const cleanup = (): void => init.signal?.removeEventListener("abort", aborted);
      this.#pending.set(id, { resolve, reject, cleanup, ...(diagnostics ? { diagnostics } : {}) });
      init.signal?.addEventListener("abort", aborted, { once: true });
      this.#child.stdin.write(JSON.stringify({ id, body, timeoutMs: this.#timeoutMs }) + "\n", (error) => {
        if (error) this.#fail(error);
      });
    });
  };

  async close(): Promise<void> {
    if (this.#closed) { await this.#exit; return; }
    this.#closed = true;
    this.#fail(new Error("Provider bridge closed"));
    this.#child.stdin.end();
    const timer = setTimeout(() => this.#child.kill(), 5_000);
    try { await this.#exit; } finally { clearTimeout(timer); }
  }

  #fail(error: Error): void {
    this.#failure ??= error;
    for (const item of this.#pending.values()) { item.cleanup(); if (item.controller) item.controller.error(error); else item.reject(error); }
    this.#pending.clear();
  }
}
