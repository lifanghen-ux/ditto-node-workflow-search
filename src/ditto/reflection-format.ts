import type { ModelProvider, SampleInput, SampleOutput, Usage } from "@codesoul-co/ditto/worker/infer";
import { GENERATION } from "../protocol.js";

export interface ReflectionRepairEvent {
  readonly phase: "reflect-format-repair";
  readonly outcome: "retry" | "recovered" | "exhausted";
  readonly attempt: number;
  readonly mode: string;
  readonly taskId?: unknown;
  readonly nodeId?: unknown;
  readonly error?: string;
}

/** Application format repair only; the published REFLECT Node still validates every final response. */
export function withReflectionFormatRepair(provider: ModelProvider, emit: (event: ReflectionRepairEvent) => void | Promise<void> = () => undefined): ModelProvider {
  return {
    async invoke(input, options) {
      if (input.metadata?.nodeType !== "INFER.REASONING.REFLECT") return provider.invoke(input, options);
      const payload = JSON.parse(String(input.messages.at(-1)?.content)) as { mode?: unknown };
      if (!["critique", "verify", "revise"].includes(String(payload.mode))) throw new Error("REFLECT format repair requires the original published Node payload");
      const mode = String(payload.mode);
      const usages: Array<Usage | undefined> = [];
      let request: SampleInput = { ...input, generation: GENERATION };
      for (let attempt = 1; attempt <= 3; attempt++) {
        options.signal.throwIfAborted();
        const response = await provider.invoke(request, options);
        usages.push(response.usage);
        // Request failures and incomplete generation are not JSON-format mistakes.
        if (response.finishReason !== "stop") return response;
        let error: string | undefined;
        try { validateReflectionResponse(response.message.content, mode); }
        catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
        if (error === undefined) {
          if (attempt > 1) await emit({ phase: "reflect-format-repair", outcome: "recovered", attempt, mode, taskId: input.metadata?.taskId, nodeId: input.metadata?.nodeId });
          return { ...response, usage: aggregateUsage(usages), message: { ...response.message,
            metadata: { ...response.message.metadata, reflectionFormat: { attempts: attempt, repairs: attempt - 1, usageKnown: usages.every((usage) => usage?.inputTokens !== undefined && usage.outputTokens !== undefined) } },
          } };
        }
        await emit({ phase: "reflect-format-repair", outcome: attempt === 3 ? "exhausted" : "retry", attempt, mode, taskId: input.metadata?.taskId, nodeId: input.metadata?.nodeId, error });
        if (attempt === 3) throw new Error(`[REFLECT_FORMAT_ERROR] Invalid reflection after three responses: ${error}`);
        request = { ...input, generation: GENERATION, messages: [
          ...input.messages,
          { role: "assistant", content: response.message.content },
          { role: "user", content: `Your REFLECT response failed the published output schema: ${error}. Return one valid JSON object for mode=${mode}. Preserve the assessment meaning and original target; repair the response format. Optional fields must be omitted when unavailable, never null. In particular, suggestedFix must be a string when present. Do not add explanations or markdown outside the JSON object.` },
        ] };
      }
      throw new Error("Unreachable REFLECT format repair state");
    },
  };
}

function aggregateUsage(usages: readonly (Usage | undefined)[]): Usage {
  const result: Usage = {};
  for (const field of ["inputTokens", "outputTokens", "totalTokens", "reasoningTokens", "cachedInputTokens"] as const) {
    if (usages.every((usage) => usage?.[field] !== undefined)) result[field] = usages.reduce((sum, usage) => sum + usage![field]!, 0);
  }
  return result;
}

/** Mirrors @codesoul-co/ditto@0.1.1 reflect/schema.js; no coercion or normalization. */
export function validateReflectionResponse(content: SampleOutput["message"]["content"], mode: string): void {
  let result: Record<string, unknown>;
  try {
    if (typeof content !== "string") throw new Error();
    result = object(JSON.parse(content.replace(/^\s*```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "")), "model output");
  } catch { throw new Error("Model must return a valid JSON object"); }
  const assessment = object(result.assessment, "assessment");
  text(assessment.summary, "assessment.summary", true);
  if (assessment.passed !== undefined && typeof assessment.passed !== "boolean") throw new Error("assessment.passed must be boolean");
  if (mode === "verify" && typeof assessment.passed !== "boolean") throw new Error("verify requires assessment.passed");
  if (!Array.isArray(result.issues)) throw new Error("issues must be an array");
  for (const raw of result.issues) {
    const issue = object(raw, "issue");
    if (!["info", "warning", "error"].includes(String(issue.severity))) throw new Error("Invalid issue severity");
    text(issue.description, "issue.description");
    if (issue.suggestedFix !== undefined) text(issue.suggestedFix, "suggestedFix", true);
  }
  if (result.revisedResult !== undefined) message(result.revisedResult);
  if (mode === "revise") message(result.revisedResult);
}
function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string, empty = false): void {
  if (typeof value !== "string" || (!empty && !value.trim())) throw new Error(`${name} must be a string${empty ? "" : " (nonempty)"}`);
}
function message(value: unknown): void {
  const record = object(value, "message");
  if (!["system", "user", "assistant", "tool"].includes(String(record.role))) throw new Error("Invalid message role");
  if (typeof record.content !== "string" && !Array.isArray(record.content)) throw new Error("Invalid message content");
  if (record.metadata !== undefined) object(record.metadata, "message.metadata");
}
