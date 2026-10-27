import type { BenchmarkTask, CaseResult, EvaluationSummary } from "../domain.js";
import type { DirectedCandidate } from "./directed-search.js";

export interface PublicCaseFeedback {
  readonly taskId: string;
  readonly prompt: string;
  readonly outputInstruction: string;
  readonly meanScore: number;
  /** A surface-form category for sample diversity, not a diagnosed failure cause. */
  readonly observationCategory: string;
  readonly change: "improved" | "regressed" | "unchanged" | "unknown";
  readonly referenceMeanScore: number | null;
  readonly outcomes: readonly { readonly repeat: number; readonly prediction: string; readonly score: number }[];
}

export type PairedWorkflowChanges =
  | { readonly status: "unavailable"; readonly reason: "no-reference" | "reference-unavailable" | "incomplete-or-unmatched-cases" }
  | { readonly status: "available"; readonly referenceCandidateId: string; readonly taskCount: number; readonly pairedRuns: number;
      readonly improvedTasks: number; readonly regressedTasks: number; readonly unchangedTasks: number; readonly meanScoreDelta: number };

export interface WorkflowFeedback {
  readonly candidateId: string;
  readonly status: "valid" | "invalid";
  readonly score: number | null;
  readonly publicCases: readonly PublicCaseFeedback[];
  readonly pairedChanges: PairedWorkflowChanges;
  readonly evaluationCost: {
    readonly scope: "workflow-evaluation-only";
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
    readonly durationMs: number;
    readonly providerAttempts: number | null;
    readonly failedAttempts: number | null;
    readonly usageStatus: "complete" | "known-lower-bound" | "unknown";
  } | null;
  readonly failureCounts: Readonly<Record<string, number>>;
}

interface ObservedTask {
  readonly task: BenchmarkTask;
  readonly outcomes: readonly { readonly repeat: number; readonly prediction: string; readonly score: number }[];
  readonly score: number;
  readonly category: string;
}

/**
 * The only optimizer feedback serialization boundary. Never spread a CaseResult:
 * it also holds private labels, judge errors, and raw generation diagnostics.
 * publicTasks must come from the opened validation benchmark, never the test split.
 */
export function buildWorkflowFeedback(
  history: readonly DirectedCandidate[],
  publicTasks: readonly BenchmarkTask[],
  options: { readonly maxCases?: number } = {},
): readonly WorkflowFeedback[] {
  const maxCases = options.maxCases ?? 6;
  if (!Number.isSafeInteger(maxCases) || maxCases < 0 || maxCases > 50) throw new Error("maxCases must be an integer from 0 to 50");
  const tasks = new Map(publicTasks.map(task => [task.id, task]));
  if (tasks.size !== publicTasks.length) throw new Error("Public task IDs must be unique");
  const byId = new Map(history.map(candidate => [candidate.id, candidate]));
  return history.map(candidate => {
    const evaluation = candidate.status === "valid" && candidate.evaluation?.valid !== false ? candidate.evaluation : undefined;
    const observed = evaluation ? observedTasks(evaluation, tasks) : [];
    const reference = candidate.referenceCandidateId === null ? undefined : byId.get(candidate.referenceCandidateId);
    const referenceEvaluation = reference?.status === "valid" && reference.evaluation?.valid !== false ? reference.evaluation : undefined;
    const referenceObserved = referenceEvaluation ? observedTasks(referenceEvaluation, tasks) : [];
    const referenceByTask = new Map(referenceObserved.map(value => [value.task.id, value]));
    const pairedChanges = pairedSummary(candidate.referenceCandidateId, evaluation, referenceEvaluation, observed, referenceObserved);
    const cases = observed.map(value => {
      const prior = pairedChanges.status === "available" ? referenceByTask.get(value.task.id) : undefined;
      const delta = prior ? value.score - prior.score : undefined;
      return {
        taskId: value.task.id, prompt: value.task.prompt, outputInstruction: value.task.outputInstruction,
        meanScore: value.score, observationCategory: value.category,
        change: delta === undefined ? "unknown" as const : delta > 1e-12 ? "improved" as const : delta < -1e-12 ? "regressed" as const : "unchanged" as const,
        referenceMeanScore: prior?.score ?? null,
        outcomes: value.outcomes,
      };
    });
    return {
      candidateId: candidate.id, status: candidate.status,
      score: evaluation && Number.isFinite(evaluation.score) ? evaluation.score : null,
      publicCases: diverseCases(cases, maxCases), pairedChanges,
      evaluationCost: evaluation ? {
        scope: "workflow-evaluation-only" as const,
        inputTokens: nonnegative(evaluation.inputTokens), outputTokens: nonnegative(evaluation.outputTokens),
        totalTokens: nonnegative(evaluation.totalTokens), durationMs: nonnegative(evaluation.durationMs),
        providerAttempts: optionalCount(evaluation.providerAttemptCount), failedAttempts: optionalCount(evaluation.failedAttemptCount),
        usageStatus: evaluation.tokenUsageStatus ?? "unknown" as const,
      } : null,
      failureCounts: publicFailureCounts(candidate.failureCounts),
    };
  });
}

function observedTasks(evaluation: EvaluationSummary, tasks: ReadonlyMap<string, BenchmarkTask>): readonly ObservedTask[] {
  const groups = new Map<string, { repeat: number; prediction: string; score: number }[]>();
  for (const row of evaluation.results) {
    if (!usableResult(row)) continue;
    const match = /^(.*)#([1-9]\d*)$/.exec(row.caseId);
    if (!match || !tasks.has(match[1]!)) continue;
    const id = match[1]!;
    const outcomes = groups.get(id) ?? [];
    outcomes.push({ repeat: Number(match[2]), prediction: row.prediction, score: row.score });
    groups.set(id, outcomes);
  }
  return [...groups].map(([id, outcomes]) => {
    const sorted = outcomes.sort((a, b) => a.repeat - b.repeat);
    const representative = [...sorted].sort((a, b) => a.score - b.score || a.repeat - b.repeat)[0]!;
    const task = tasks.get(id)!;
    return { task, outcomes: sorted, score: mean(sorted.map(value => value.score)), category: category(task.prompt, representative.prediction) };
  });
}

function pairedSummary(
  referenceId: string | null,
  evaluation: EvaluationSummary | undefined,
  reference: EvaluationSummary | undefined,
  currentTasks: readonly ObservedTask[],
  priorTasks: readonly ObservedTask[],
): PairedWorkflowChanges {
  if (referenceId === null) return { status: "unavailable", reason: "no-reference" };
  if (!reference) return { status: "unavailable", reason: "reference-unavailable" };
  const unavailable = { status: "unavailable" as const, reason: "incomplete-or-unmatched-cases" as const };
  if (!evaluation || !complete(evaluation, currentTasks) || !complete(reference, priorTasks)
    || evaluation.repeats !== reference.repeats || evaluation.examples !== reference.examples) return unavailable;
  const priorIds = new Set(reference.results.map(row => row.caseId));
  if (evaluation.results.some(row => !priorIds.has(row.caseId))) return unavailable;
  const priorByTask = new Map(priorTasks.map(value => [value.task.id, value.score]));
  if (currentTasks.some(value => !priorByTask.has(value.task.id))) return unavailable;
  const deltas = currentTasks.map(value => value.score - priorByTask.get(value.task.id)!);
  return {
    status: "available", referenceCandidateId: referenceId, taskCount: currentTasks.length, pairedRuns: evaluation.results.length,
    improvedTasks: deltas.filter(delta => delta > 1e-12).length,
    regressedTasks: deltas.filter(delta => delta < -1e-12).length,
    unchangedTasks: deltas.filter(delta => Math.abs(delta) <= 1e-12).length,
    meanScoreDelta: mean(deltas),
  };
}

function complete(evaluation: EvaluationSummary, observed: readonly ObservedTask[]): boolean {
  return evaluation.valid !== false && evaluation.examples > 0 && evaluation.repeats > 0
    && evaluation.results.length === evaluation.examples * evaluation.repeats
    && new Set(evaluation.results.map(row => row.caseId)).size === evaluation.results.length
    && evaluation.results.every(usableResult) && observed.length === evaluation.examples
    && observed.every(task => task.outcomes.length === evaluation.repeats
      && task.outcomes.every((value, index) => value.repeat === index + 1));
}

function usableResult(row: CaseResult): boolean {
  return row.valid !== false && !("error" in row) && Number.isFinite(row.score) && row.score >= 0 && row.score <= 1;
}

function diverseCases(cases: readonly PublicCaseFeedback[], maxCases: number): readonly PublicCaseFeedback[] {
  // First preserve paired regressions and repaired examples, then cover different
  // visible failure patterns. Each selected entry is one task with all repeats.
  const selected: PublicCaseFeedback[] = [];
  const seen = new Set<string>();
  const add = (value: PublicCaseFeedback | undefined): void => {
    if (value && selected.length < maxCases && !seen.has(value.taskId)) { selected.push(value); seen.add(value.taskId); }
  };
  const ordered = [...cases].sort((a, b) => a.meanScore - b.meanScore || a.taskId.localeCompare(b.taskId));
  add(ordered.find(value => value.change === "regressed"));
  add(ordered.find(value => value.change === "improved"));
  const categories = new Set(selected.map(value => value.observationCategory));
  for (const value of ordered) {
    if (value.meanScore >= 1 || seen.has(value.taskId) || categories.has(value.observationCategory)) continue;
    add(value); categories.add(value.observationCategory);
  }
  for (const value of ordered) if (value.meanScore < 1) add(value);
  return selected;
}

function category(prompt: string, prediction: string): string {
  if (!prediction.trim()) return "empty-answer";
  if (/=/.test(prediction)) return "answer-with-equation";
  if (/\d[\d,.]*-yard\b/i.test(prediction)) return "hyphenated-numeric-unit";
  if (prediction.includes("|")) return "pipe-separated-answer";
  if (/^\s*[-+]?\d+(?:,\d{3})*(?:\.\d+)?\s*(?:years?|months?|days?|yards?|francs?|percent|billion|million|seasons?)\s*$/i.test(prediction)) return "number-with-unit";
  if (/^\s*[-+]?\d+\.\d*0%?\s*$/.test(prediction)) return "decimal-trailing-zero";
  const question = prompt.split(/Question:/i).at(-1) ?? prompt;
  if (/how (?:many|much|long|old)|difference|total|percent/i.test(question)) return "quantity-question";
  if (/first|last|longest|shortest|most|least|smaller|larger|before|after/i.test(question)) return "comparison-or-order-question";
  return "span-or-other-question";
}

function publicFailureCounts(value: Readonly<Record<string, number>> | undefined): Readonly<Record<string, number>> {
  return Object.fromEntries(["provider", "execution", "timeout", "judge"].flatMap(key => {
    const count = value?.[key];
    return count !== undefined && Number.isSafeInteger(count) && count >= 0 ? [[key, count]] : [];
  }));
}
function mean(values: readonly number[]): number { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0; }
function nonnegative(value: number): number { return Number.isFinite(value) && value >= 0 ? value : 0; }
function optionalCount(value: number | undefined): number | null { return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : null; }
