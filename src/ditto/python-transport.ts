import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { ProviderSettings } from "../config.js";

/** Public fetch injection; neither Ditto npm nor AFlow source is patched. */
export class PythonTransport {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<number, { resolve(value: Response): void; reject(error: Error): void; cleanup(): void }>();
  #id = 0;
  #failure: Error | undefined;
  readonly #exit: Promise<void>;

  constructor(settings: ProviderSettings) {
    const python = process.env.AFLOW_SCORER_PYTHON || "python";
    this.#child = spawn(python, ["-u", fileURLToPath(new URL("../../scripts/provider_bridge.py", import.meta.url))], {
      windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONIOENCODING: "utf-8", CODE_SOUL_BASE_URL: settings.baseUrl, CODE_SOUL_API_KEY: settings.apiKey },
    });
    this.#child.stdin.on("error", (error) => this.#fail(error));
    this.#child.stderr.resume();
    createInterface({ input: this.#child.stdout }).on("line", (line) => {
      try {
        const reply = JSON.parse(line) as { id: number; status: number; body: unknown };
        const pending = this.#pending.get(reply.id);
        if (!pending) return;
        this.#pending.delete(reply.id);
        pending.cleanup();
        pending.resolve(new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } }));
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
    if (this.#failure) throw this.#failure;
    init?.signal?.throwIfAborted();
    if (typeof init?.body !== "string") throw new Error("Provider bridge requires a JSON body");
    const id = ++this.#id;
    const body: unknown = JSON.parse(init.body);
    return new Promise<Response>((resolve, reject) => {
      const aborted = (): void => {
        this.#pending.delete(id);
        reject(new Error("Provider bridge request cancelled"));
      };
      const cleanup = (): void => init.signal?.removeEventListener("abort", aborted);
      this.#pending.set(id, { resolve, reject, cleanup });
      init.signal?.addEventListener("abort", aborted, { once: true });
      this.#child.stdin.write(JSON.stringify({ id, body }) + "\n", (error) => {
        if (error) this.#fail(error);
      });
    });
  };

  async close(): Promise<void> {
    this.#child.stdin.end();
    const timer = setTimeout(() => this.#child.kill(), 5_000);
    try { await this.#exit; } finally { clearTimeout(timer); }
  }

  #fail(error: Error): void {
    this.#failure = error;
    for (const item of this.#pending.values()) { item.cleanup(); item.reject(error); }
    this.#pending.clear();
  }
}
