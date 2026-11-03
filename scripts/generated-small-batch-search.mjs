import { mkdir, writeFile, appendFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { spawnSync } from 'node:child_process';
import { graph, graphStep, loop } from '@codesoul-co/ditto/runtime';
import { loadProviderSettings } from '../dist/config.js';
import { createExperimentRuntime } from '../dist/ditto/runtime.js';
import { loadBenchmark, DockerPythonJudge } from '../dist/benchmark/index.js';
import { GENERATION, PROTOCOL } from '../dist/protocol.js';
import {
  captureProviderDiagnostics,
  currentProviderDiagnostics,
  summarizeProviderDiagnostics,
} from '../dist/ditto/provider-diagnostics.js';
import { compileGeneratedWorkflowA, GENERATED_A_GUIDE, GENERATED_A_GUIDE_VERSION } from './generated-workflow-a.mjs';
import {
  compileEvidenceDefinition,
  EVIDENCE_DEFINITION_GUIDE,
  EVIDENCE_DEFINITION_GUIDE_VERSION,
} from './generated-workflow-b.mjs';
import {
  GENERATED_SEARCH_PROMPT,
  GENERATED_SEARCH_PROMPT_VERSION,
  DROP_SEARCH_CONTRACT,
} from './generated-search-prompt.mjs';
import { sharedTools, unwrap, parseJson, answerText, SHARED_CAPABILITY_GUIDE } from './workflow-capabilities.mjs';
import { buildGeneratedFeedback } from './generated-search-feedback.mjs';
import { parseGeneratedProposal } from './generated-proposal-json.mjs';
import { createArtifactRegistry } from './generated-artifact-registry.mjs';
import { targetScore, targetFeasibility, evolutionArchive, selectEvolutionParents, workflowShape } from './a-evolution-policy.mjs';
import { createProviderHealth } from './generated-provider-health.mjs';
import { auditCandidate, loadAuditedPartialSeed } from './audit-generated-run.mjs';
import { datasetPromptGuidance } from './dataset-prompt-guidance.mjs';
import { compactRunHistory, readRunHistory } from './generated-run-history.mjs';
import {
  searchPolicyForSize,
  selectSearchTasks,
  pairedStageDecision,
  bestFullCandidate,
  committedRequests,
} from './generated-small-batch-policy.mjs';

const flags = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index],
    value = process.argv[index + 1];
  if (!name.startsWith('--') || value === undefined) throw Error('Options require --name value');
  flags[name.slice(2)] = value;
}
const positive = (name, fallback) => {
  const value = Number(flags[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw Error('Invalid ' + name);
  return value;
};
const representation = flags.representation ?? 'A';
const dataset = flags.dataset ?? 'drop';
const codeDataset = dataset === 'humaneval' || dataset === 'mbpp';
const metric = codeDataset ? 'pass@1' : dataset === 'drop' ? 'F1' : 'accuracy';
const validationSize = positive('validation-size', dataset === 'humaneval' ? 33 : dataset === 'mbpp' ? 86 : dataset === 'math' ? 119 : 200);
const evolution = representation === 'A' && flags.evolution !== 'false';
const searchPolicy = Object.freeze({ ...searchPolicyForSize(validationSize, dataset),
  targetF1: targetScore(dataset, flags['target-score']) });
const stopAfterStage = positive('stop-after-stage', validationSize);
if (stopAfterStage !== 1 && !searchPolicy.stages.includes(stopAfterStage)) throw Error('stop-after-stage must be 1 or a declared evaluation stage');
const evaluationStages = stopAfterStage === 1 ? [1] : searchPolicy.stages;
const evaluateOnly = flags['evaluate-only'] === 'true';
const fullSinglePass = flags['full-single-pass'] === 'true';
const generateOnly = flags['generate-only'] === 'true';
if (generateOnly && flags['seed-proposal']) throw Error('generate-only does not evaluate seed proposals');
if (evaluateOnly && !flags['seed-proposal']) throw Error('evaluate-only requires a saved seed-proposal');
if (flags['seed-partial-run'] && (!flags['seed-proposal'] || !flags['seed-partial-candidate']))
  throw Error('Partial resume requires seed-proposal and seed-partial-candidate');
const bestCandidate = () => bestFullCandidate(history, validationSize);
if (!['A', 'B'].includes(representation)) throw Error('representation must be A or B');
if (flags.repeats !== undefined && flags.repeats !== '1')
  throw Error('Small-batch search uses exactly one execution per task');
const rounds = positive('rounds', 6),
  concurrency = positive('concurrency', 3);
const maxCalls = positive('max-calls', 500),
  maxTokens = positive('max-tokens', 1500000);
const directory = resolve(
  flags.output ??
    'runs/generated-small-batch/' + dataset + '/' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + representation,
);
await mkdir(directory, { recursive: true });
const write = async (file, value) => {
  await mkdir(resolve(directory, file, '..'), { recursive: true });
  const snapshot = file === 'history.json' ? compactRunHistory(value, directory) : value;
  await writeFile(join(directory, file), JSON.stringify(snapshot, null, 2) + '\n');
};
const emit = (value) => console.log(JSON.stringify(value));
const digest = (value) =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
const usageKeys = [
  'providerAttempts',
  'failedProviderAttempts',
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'unknownUsageAttempts',
];
const emptyUsage = () => Object.fromEntries(usageKeys.map((key) => [key, 0]));
const newUsage = emptyUsage(),
  optimizerUsage = emptyUsage(),
  evaluationUsage = emptyUsage();
let activeUsageDestination = evaluationUsage;
const accountedRecords = new WeakMap();
let reservedRequests = 0;
let settledInvocations = 0;
let budgetError;
const providerHealth = createProviderHealth(currentProviderDiagnostics);
const usedOrReserved = () => committedRequests(newUsage.providerAttempts, reservedRequests, settledInvocations);
const history = [];
const artifactField = representation === 'A' ? 'source' : 'definition';
const artifactRegistry = createArtifactRegistry(artifactField);
const settings = { ...loadProviderSettings(), concurrency };
const model = { provider: 'deepseek', model: settings.model };
const promptBundle = flags['prompt-bundle']
  ? JSON.parse(await readFile(resolve(flags['prompt-bundle']), 'utf8'))
  : null;
if (promptBundle)
  for (const key of ['optimizer', 'taskContract', 'capabilityGuide', 'guideA', 'guideB']) {
    if (typeof promptBundle[key] !== 'string' || !promptBundle[key].trim())
      throw Error('Missing prompt bundle field: ' + key);
  }
const evolutionPrompt = evolution ? await readFile(resolve('prompts/a-evolution.zh-CN.md'), 'utf8') : '';
const optimizerPrompt = (promptBundle?.optimizer ?? GENERATED_SEARCH_PROMPT).replaceAll('F1', metric)
  .replaceAll('above 0.90', 'above ' + searchPolicy.targetF1)
  .replaceAll('超过0.90', '超过' + searchPolicy.targetF1) + '\n\n' + evolutionPrompt;
const taskContract = codeDataset
  ? `Implement the requested Python function from the public ${dataset} specification. Preserve its entry point and signature. Return one complete Python code block, including needed imports, and no tests or commentary. The existing Docker judge grades the code against private tests using pass@1. Design a reusable workflow; examples supplied to the optimizer are task data. Python execution is performed by the scorer after the workflow returns; the workflow has no Python execution tool.`
  : dataset === 'automationbench'
    ? 'Complete the requested business workflow by using the official simulated API tools. Only the final environment state is scored by the original task_completed_correctly metric: all scored assertions must pass. Final answer text alone does not perform actions. Preserve the provided task instructions. Design a reusable workflow that discovers relevant APIs and handles tool observations; the host does not supply an action plan. 根据已记录的工具错误改进流程：在当前任务中保留已明确未连接的服务，后续决策不要重复尝试这些服务；其余设计由你决定。'
    : dataset === 'math'
      ? 'Solve the supplied mathematical problem. Return an exact final answer, conventionally in \\boxed{...}. Design reusable prompts, computation and control using only the supplied capabilities. The host symbolic scorer is private and unavailable as a tool.'
      : dataset === 'bfcl'
        ? 'Complete the official BFCL multi-turn conversation through the supplied simulated tools. Discover the current public state and available function schemas. Only the current turn is visible. Actions change the world; final text alone does not execute functions. The original official checker scores the completed conversation.'
        : promptBundle?.taskContract ?? DROP_SEARCH_CONTRACT;
const guide = promptBundle
  ? representation === 'A'
    ? promptBundle.guideA
    : promptBundle.guideB
  : representation === 'A'
    ? GENERATED_A_GUIDE
    : EVIDENCE_DEFINITION_GUIDE;
const guideVersion = representation === 'A' ? GENERATED_A_GUIDE_VERSION : EVIDENCE_DEFINITION_GUIDE_VERSION;
let experiment, manifest, selected, benchmark, environment, datasetGuidance;
let executionTools = sharedTools;

function addUsage(destination, usage) {
  for (const key of usageKeys) destination[key] += usage[key] ?? 0;
}
function difference(after, before) {
  return Object.fromEntries(usageKeys.map((key) => [key, after[key] - before[key]]));
}
function settleUsage(records, destination) {
  for (const record of records ?? []) {
    const current = summarizeProviderDiagnostics([record]);
    if (!accountedRecords.has(record)) settledInvocations++;
    const prior = accountedRecords.get(record) ?? emptyUsage();
    const increment = difference(current, prior);
    addUsage(newUsage, increment);
    addUsage(destination, increment);
    accountedRecords.set(record, Object.fromEntries(usageKeys.map((key) => [key, current[key] ?? 0])));
  }
}
function reserveRequest() {
  if (usedOrReserved() >= maxCalls || newUsage.totalTokens >= maxTokens) {
    budgetError ??= Object.assign(Error('SEARCH_BUDGET_EXHAUSTED: stopping new requests; in-flight work will be saved'), {
      code: 'SEARCH_BUDGET_EXHAUSTED',
    });
    throw budgetError;
  }
  reservedRequests++;
}
const capabilities = {
  graph,
  graphStep,
  loop,
  model,
  generation: GENERATION,
  unwrap,
  parseJson,
  answerText,
  allowedTools: sharedTools.map((tool) => tool.name),
  beforeNode({ type }) {
    // Settle completed calls before admitting the next node.
    settleUsage(currentProviderDiagnostics(), evaluationUsage);
    providerHealth.admit();
    if (budgetError) throw budgetError;
  },
};
function compile(proposal) {
  if (representation === 'A') return compileGeneratedWorkflowA(proposal.source, capabilities);
  const trace = [];
  const definition = compileEvidenceDefinition(proposal.definition, capabilities, { trace });
  const spec = proposal.definition;
  const outputRef = spec.output.answer.ref;
  return {
    definition,
    trace,
    plan: {
      id: spec.id,
      nodes: spec.nodes.map((node) => ({ ...node, config: { inputBindings: node.inputBindings } })),
      graphs: spec.graphs,
      loop: spec.loop,
      outputBindings: spec.output,
      outputNodeId: outputRef?.[0] === 'nodes' ? outputRef[1] : 'defined-output',
    },
  };
}
function checkProposal(proposal, allowedIds) {
  const fields = ['referenceCandidateId', 'rationale', artifactField];
  if (
    !proposal ||
    typeof proposal !== 'object' ||
    Array.isArray(proposal) ||
    Object.keys(proposal).some((key) => !fields.includes(key)) ||
    fields.some((key) => !Object.hasOwn(proposal, key))
  )
    throw Error('Expected exactly ' + fields.join(', '));
  if (proposal.referenceCandidateId !== null && !allowedIds.includes(proposal.referenceCandidateId))
    throw Error('referenceCandidateId must be JSON null or a supplied parent ID');
  if (typeof proposal.rationale !== 'string' || !proposal.rationale.trim())
    throw Error('rationale must be nonempty text');
  const identity = artifactRegistry.assertNovel(proposal);
  return { identity, ...compile(proposal) };
}
async function persistManifest() {
  Object.assign(manifest, {
    newUsage: { ...newUsage },
    optimizerUsage: { ...optimizerUsage },
    evaluationUsage: { ...evaluationUsage },
    reservedRequests,
    settledInvocations,
  });
  await write('manifest.json', manifest);
}
function render() {
  const output = resolve(flags.report ?? join(directory, 'workflow-report.png'));
  const result = spawnSync(
    flags['report-python'] ??
      process.env.DITTO_REPORT_PYTHON ??
      process.env.DITTO_PROVIDER_PYTHON ??
      (process.platform === 'win32' ? 'python' : 'python3'),
    ['scripts/render-workflow-report.py', directory, '--output', output],
    { encoding: 'utf8', windowsHide: true },
  );
  emit(
    result.status === 0
      ? { phase: 'workflow-report', path: output }
      : { phase: 'workflow-report-error', message: result.stderr?.slice(0, 1000) },
  );
}
async function snapshotMechanism() {
  const paths = [
    'scripts/generated-small-batch-search.mjs',
    'scripts/a-evolution-policy.mjs',
    'scripts/generated-provider-health.mjs',
    'scripts/audit-generated-run.mjs',
    'scripts/generated-run-history.mjs',
    'scripts/dataset-prompt-guidance.mjs',
    'prompts/dataset-initial-prompts.zh-CN.json',
    'src/ditto/runtime.ts',
    'src/benchmark/code-adapters.ts',
    'src/benchmark/docker-python-judge.ts',
    'scripts/generated-small-batch-policy.mjs',
    'scripts/generated-search-prompt.mjs',
    'scripts/generated-search-feedback.mjs',
    'scripts/generated-proposal-json.mjs',
    'scripts/generated-artifact-registry.mjs',
    'scripts/python_support_blocks.py',
    'scripts/generated-workflow-a.mjs',
    'scripts/generated-workflow-b.mjs',
    'scripts/generated-infer-contract.mjs',
    'scripts/workflow-capabilities.mjs',
  ];
  for (const path of paths) {
    const content = await readFile(path, 'utf8');
    await mkdir(join(directory, 'mechanism'), { recursive: true });
    await writeFile(join(directory, 'mechanism', path.split('/').at(-1)), content);
  }
  for (const path of environment?.sourceFiles ?? []) await writeFile(join(directory, 'mechanism', path.split(/[\\/]/).at(-1)), await readFile(path, 'utf8'));
  if (evolution) await writeFile(join(directory, 'mechanism', 'a-evolution.zh-CN.md'), evolutionPrompt);
  if (flags['benchmark-module']) await writeFile(join(directory, 'mechanism', 'benchmark-module.mjs'),
    await readFile(resolve(flags['benchmark-module']), 'utf8'));
}
async function saveEvaluation(record, summary, stage, usageBefore, reusedCases) {
  record.evaluation = summary;
  record.status = summary.valid ? 'valid' : 'invalid';
  const { results, ...stats } = summary;
  const published = {
    ...stats,
    stage,
    protocol: searchPolicy.id,
    newUsage: difference(evaluationUsage, usageBefore),
    reusedCases,
  };
  await write('evaluations/' + record.id + '/summary.json', published);
  await writeFile(
    join(directory, 'evaluations', record.id, 'samples.jsonl'),
    results.map((row) => JSON.stringify(row)).join('\n') + '\n',
  );
  await write('history.json', history);
  await persistManifest();
  emit({
    phase: 'stage-complete',
    representation,
    candidateId: record.id,
    stage,
    valid: summary.valid,
    score: summary.valid ? summary.score : null,
    logicalCalls: summary.providerAttemptCount,
    newCalls: published.newUsage.providerAttempts,
    reusedCases,
  });
}
async function evaluateRecord(record, reference, priorCases = []) {
  const traces = (record.traces ??= []);
  record.traces = traces;
  let latest = priorCases;
  const progressResults = new Map();
  const usageBefore = { ...evaluationUsage };
  const importedIds = new Set(priorCases.filter((row) => row.valid && !row.error).map((row) => row.caseId));
  await mkdir(join(directory, 'evaluations', record.id), { recursive: true });
  if (priorCases.length && traces.length) await writeFile(
    join(directory, 'evaluations', record.id, 'inherited-public-traces.jsonl'),
    traces.map(trace => JSON.stringify(trace)).join('\n') + '\n',
  );
  const runTask = (task) =>
    captureProviderDiagnostics(async (records) => {
      const fresh = compile(record.proposal),
        graphEvents = [];
      try {
        const raw = await experiment.runtime.loop(fresh.definition, task, {
          onGraph: (event) => graphEvents.push(event),
        });
        providerHealth.assert(records);
        if (budgetError) throw budgetError;
        const result = typeof raw === 'string' ? { answer: raw } : raw;
        return {
          answer: answerText(result.answer),
          executedNodeIds:
            result.executedNodeIds ?? fresh.trace.filter((event) => event.kind === 'node').map((event) => event.nodeId),
          executedGraphIds:
            result.executedGraphIds ??
            graphEvents.filter((event) => event.status === 'completed').map((event) => event.graphId),
          ...summarizeProviderDiagnostics(records),
        };
      } catch (error) {
        throw Object.assign(providerHealth.failure(records) ?? error, summarizeProviderDiagnostics(records));
      } finally {
        settleUsage(records, evaluationUsage);
        const trace = { taskId: task.id, events: fresh.trace };
        traces.push(trace);
        await appendFile(
          join(directory, 'evaluations', record.id, 'public-traces.jsonl'),
          JSON.stringify(trace) + '\n',
        );
      }
    });
  const runner = task => environment ? environment.withTask(task.id, () => runTask(task)) : runTask(task);
  const onCase = async ({ completed, total, result }) => {
    await appendFile(join(directory, 'evaluations', record.id, 'live-samples.jsonl'), JSON.stringify(result) + '\n');
    progressResults.set(result.caseId, result);
    // Save partial results if a later case fails.
    const partial = [...progressResults.values()];
    const sum = (key) => partial.reduce((total, row) => total + (row[key] ?? 0), 0);
    record.evaluation = {
      valid: false,
      score: 0,
      examples: partial.length,
      repeats: 1,
      results: partial,
      validRuns: partial.filter((row) => row.valid && !row.error).length,
      providerAttemptCount: sum('providerAttempts'),
      totalTokens: sum('totalTokens'),
      inputTokens: sum('inputTokens'),
      outputTokens: sum('outputTokens'),
      tokenUsageStatus: partial.every((row) => row.usageKnown) ? 'complete' : 'known-lower-bound',
    };
    if (!result.valid) {
      const error = Error(result.error ?? 'Invalid execution');
      error.caseId = result.caseId;
      error.failureKind = result.failureKind;
      throw error;
    }
    if (completed % 8 === 0 || completed === total)
      emit({
        phase: 'progress',
        representation,
        candidateId: record.id,
        completed,
        total,
        newCalls: newUsage.providerAttempts,
      });
  };
  // Check the first task before starting a batch; reuse its result.
  if (!latest.some((row) => row.caseId === selected[0].id + '#1' && row.valid && !row.error)) {
    const first = await benchmark.evaluateSearchSubset([selected[0].id], runner, {
      repeats: 1,
      concurrency: 1,
      retryAttempts: 1,
      onCase,
    });
    latest = first.results;
  }
  for (const size of evaluationStages) {
    const ids = selected.slice(0, size).map((task) => task.id);
    const summary = await benchmark.evaluateSearchSubset(ids, runner, {
      repeats: 1,
      concurrency,
      retryAttempts: 1,
      priorCases: latest,
      onCase,
    });
    // Retain cached results needed by later stages.
    const merged = new Map(latest.map((row) => [row.caseId, row]));
    for (const row of summary.results) merged.set(row.caseId, row);
    latest = [...merged.values()];
    await saveEvaluation(
      record,
      summary,
      size,
      usageBefore,
      summary.results.filter((row) => importedIds.has(row.caseId)).length,
    );
    const targetBound = evolution && !fullSinglePass ? targetFeasibility(summary, validationSize, searchPolicy.targetF1) : null;
    const decision = targetBound?.advance === false ? targetBound
      : fullSinglePass ? { advance: size < validationSize, reason: size < validationSize ? 'requested-full-single-pass' : 'completed-fixed-subset' }
      : pairedStageDecision(summary, reference?.evaluation, size, searchPolicy);
    if (size === stopAfterStage && size < validationSize) {
      decision.advance = false;
      decision.reason = 'requested-small-batch-complete';
    }
    await write('evaluations/' + record.id + '/stage-' + size + '.json', {
      ...decision,
      score: summary.score,
      examples: size,
      comparisonReferenceId: reference?.id ?? null,
      comparisonPolicy: 'best-completed-' + validationSize + '-task-incumbent',
    });
    if (!decision.advance) {
      record.stageDecision = decision;
      break;
    }
  }
  return record;
}
async function seedFromCache() {
  if (flags['seed-proposal']) return;
  if (!flags['seed-run'] || flags['seed-run'] === 'none') return;
  if (!flags['seed-candidate']) throw Error('--seed-run requires --seed-candidate');
  const origin = resolve(flags['seed-run']),
    candidateId = flags['seed-candidate'];
  const previous = JSON.parse(await readFile(join(origin, 'manifest.json'), 'utf8'));
  for (const [name, expected, actual] of [
    ['representation', representation, previous.representation],
    ['model', settings.model, previous.model],
    ['endpoint', settings.baseUrl, previous.endpoint],
    ['generation', GENERATION, previous.generation],
    ['dataset', benchmark.identity, previous.data?.identity],
  ]) {
    if (!isDeepStrictEqual(expected, actual)) throw Error('Seed cache identity differs: ' + name);
  }
  const saved = JSON.parse(await readFile(join(origin, 'candidates', candidateId + '.json'), 'utf8'));
  if (saved.representation !== representation) throw Error('Seed representation mismatch');
  const selectedIds = new Set(selected.map((task) => task.id + '#1'));
  let sampleText;
  try {
    sampleText = await readFile(join(origin, 'evaluations', candidateId, 'samples.jsonl'), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    sampleText = await readFile(join(origin, 'evaluations', candidateId, 'live-samples.jsonl'), 'utf8');
  }
  let rows = sampleText
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  try {
    await readFile(join(origin, 'evaluations', candidateId, 'execution-audit.json'), 'utf8');
    rows = (await auditCandidate(origin, candidateId)).reusable;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const latest = new Map(rows.map((row) => [row.caseId, row]));
  const prior = [...latest.values()].filter((row) => selectedIds.has(row.caseId) && row.valid && !row.error);
  if (prior.length !== selected.length)
    throw Error('Seed must have all selected first-pass results; do not silently run a partial historical baseline');
  const compiled = compile(saved.proposal),
    id = 'seed-' + representation.toLowerCase();
  const record = {
    id,
    proposal: saved.proposal,
    rationale: saved.proposal.rationale,
    referenceCandidateId: null,
    status: 'pending',
    traces: [],
    traceEvidence: { directory: origin, candidateId },
    origin: {
      directory: origin,
      candidateId,
      kind: 'previous-llm-generated',
      traceAvailability: 'not-recorded',
      compatibility: 'same successful native operations; additive capabilities and trace/input checks only',
    },
  };
  history.push(record);
  artifactRegistry.remember(saved.proposal);
  try {
    record.traces = (await readFile(join(origin, 'evaluations', candidateId, 'public-traces.jsonl'), 'utf8'))
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    record.origin.traceAvailability = 'recorded-public-node-traces';
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await write('candidates/' + id + '.json', { representation, proposal: saved.proposal, origin: record.origin });
  await write('checkpoints/' + id + '.json', {
    plan: compiled.plan,
    referenceCandidateId: null,
    candidateOrigin: 'llm-generated-cache',
    optimizerProfile: previous.optimizerProfile,
  });
  // Score the cached baseline without new requests.
  const summary = await benchmark.evaluateSearchSubset(
    selected.map((task) => task.id),
    () => {
      throw Error('Cache unexpectedly missed');
    },
    { repeats: 1, concurrency, priorCases: prior },
  );
  manifest.cachedRuns = prior.length;
  await mkdir(join(directory, 'evaluations', id), { recursive: true });
  await saveEvaluation(record, summary, validationSize, { ...evaluationUsage }, prior.length);
  render();
}
async function propose(id, repair) {
  const feedbackHistory = evolution
    ? [...new Map([...selectEvolutionParents(history, validationSize), ...history.slice(-3)]
      .filter(Boolean).map(record => [record.id, record])).values()] : history;
  const feedback = buildGeneratedFeedback(feedbackHistory, selected, evolution
    ? { maxCases: 4, maxTraceCases: 2, maxFeedbackChars: 14000 } : {});
  const full = bestCandidate();
  const preferred = [history.at(-1), full, ...history.filter((row) => row.status === 'valid').slice(-2)].filter(
    Boolean,
  );
  const parents = evolution ? selectEvolutionParents(history, validationSize)
    : [...new Map(preferred.map((row) => [row.id, row])).values()];
  let rejected = repair?.proposal,
    previousError = repair?.error;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const input = {
      mode: rejected ? 'ENGINEERING REPAIR' : 'QUALITY SEARCH',
      goal: `Autonomously generate a reusable workflow strictly exceeding ${searchPolicy.targetF1} ${metric} on the fixed ${validationSize}-task validation set; prioritize accuracy and compare actual model calls, tokens and time.`,
      representation,
      taskContract,
      datasetGuidance,
      capabilityGuide: environment?.capabilityGuide ?? promptBundle?.capabilityGuide ?? SHARED_CAPABILITY_GUIDE,
      interfaceGuide: guide,
      outputContract: {
        referenceCandidateId: 'JSON null or an allowed parent ID',
        rationale: 'concise evidence, hypothesis, change, falsification and cost expectation',
        [artifactField]:
          representation === 'A' ? 'complete JavaScript module source string' : 'complete JSON definition',
      },
      allowedReferenceCandidateIds: parents.map((row) => row.id),
      publicTaskExamples: selected
        .slice(0, 2)
        .map((task) => ({
          id: task.id,
          dataset: task.dataset,
          prompt: task.prompt,
          outputInstruction: task.outputInstruction,
        })),
      parents: parents.map((row) => ({ id: row.id, artifact: row.proposal })),
      measuredHistory: feedback,
      ...(evolution ? { evolutionArchive: evolutionArchive(history, validationSize) } : {}),
      ...(environment ? { toolExecutionEvidence: history.map(record => ({
        candidateId: record.id, tasks: environment.summarizeTraces(record.traces ?? []),
      })) } : {}),
      searchPolicy,
      remainingBudget: {
        modelRequests: Math.max(0, maxCalls - usedOrReserved()),
        tokens: Math.max(0, maxTokens - newUsage.totalTokens),
      },
      ...(rejected ? { rejectedProposal: rejected, engineeringError: previousError } : {}),
    };
    await write('proposals/' + id + '-attempt-' + attempt + '-request.json', input);
    const plan = graph('automatic-small-batch-proposal').node('proposal', 'INFER.REASONING.SAMPLE', [], () => ({
      model: capabilities.model,
      generation: GENERATION,
      messages: [
        { role: 'system', content: optimizerPrompt },
        { role: 'user', content: JSON.stringify(input) },
      ],
      metadata: { role: 'optimizer', representation, experiment: searchPolicy.id },
    }));
    let content;
    try {
      const output = await captureProviderDiagnostics(async (records) => {
        try {
          const result = await experiment.runtime.run(plan, {});
          providerHealth.assert(records);
          return result;
        } finally {
          settleUsage(records, optimizerUsage);
        }
      });
      content = unwrap(output.proposal).message.content;
    } finally {
      await persistManifest();
    }
    await write('proposals/' + id + '-attempt-' + attempt + '-response.json', { content });
    try {
      const { proposal, repairedContent } = parseGeneratedProposal(content);
      if (repairedContent) await write('proposals/' + id + '-attempt-' + attempt + '-syntax-repair.json', { content: repairedContent });
      const compiled = checkProposal(
        proposal,
        parents.map((row) => row.id),
      );
      return { proposal, ...compiled };
    } catch (error) {
      rejected = content;
      previousError = error.message;
      await write('proposals/' + id + '-attempt-' + attempt + '-rejection.json', { error: previousError });
      emit({ phase: 'interface-repair', candidateId: id, attempt, error: previousError });
    }
  }
  throw Error('ENGINEERING_REPAIR_LIMIT: ' + previousError);
}

try {
  const codeJudge = codeDataset ? new DockerPythonJudge() : undefined;
  if (flags['benchmark-module'] || dataset === 'bfcl' || (dataset === 'automationbench' && validationSize === 200)) {
    flags['benchmark-module'] ??= 'scripts/generated-official-benchmarks.mjs';
    const { pathToFileURL } = await import('node:url');
    const adapter = await import(pathToFileURL(resolve(flags['benchmark-module'])).href);
    environment = await adapter.createGeneratedBenchmark({ dataset, split: 'validate', output: directory });
    benchmark = environment.benchmark;
    executionTools = environment.tools;
    capabilities.allowedTools = executionTools.map(tool => tool.name);
  } else if (dataset === 'automationbench') {
    throw Error('AutomationBench requires the official 200-task Search adapter');
  } else {
    benchmark = await loadBenchmark(dataset, { dataDir: resolve('data/datasets'), split: 'validate', limit: 0, codeJudge });
  }
  selected = environment ? benchmark.tasks : selectSearchTasks(benchmark.tasks, validationSize);
  if (selected.length !== validationSize) throw Error(`Expected ${validationSize} tasks, received ${selected.length}`);
  datasetGuidance = await datasetPromptGuidance(dataset, executionTools.map(tool => tool.name));
  if (datasetGuidance) await write('dataset-guidance.json', datasetGuidance);
  manifest = {
    schemaVersion: 3,
    status: 'preparing',
    createdAt: new Date().toISOString(),
    dataset,
    metric,
    split: 'validate',
    representation,
    optimizerProfile: GENERATED_SEARCH_PROMPT_VERSION,
    guideVersion,
    candidateOrigin: 'llm-generated',
    manualCandidateUse: false,
    evaluationValidityPolicy: 'generated-provider-health-v1',
    datasetPromptPool: datasetGuidance ? { version: datasetGuidance.version, size: datasetGuidance.initialPrompts.length } : null,
    fullSinglePass,
    evolution: evolution ? { policy: 'a-open-workflow-quality-cost-v1', target: searchPolicy.targetF1,
      evaluationRepeats: 1, idea: 'optional typed decisions and conditional compute; configured DeepSeek backend' } : null,
    model: settings.model,
    endpoint: settings.baseUrl,
    generation: GENERATION,
    repeats: 1,
    concurrency,
    protocol: {
      ...PROTOCOL,
      id: searchPolicy.id,
      validationRepeats: 1,
      workflowAttempts: 1,
      searchPolicy: 'automatic-evidence-hypothesis-staged-v2-full-infer',
    },
    searchPolicy,
    data: { identity: benchmark.identity, selectedExamples: validationSize, taskIds: selected.map((task) => task.id) },
    budget: { maxCalls, maxTokens, rounds, stopAfterStage, ...(environment ? { searchStallTurns: 2 } : {}), policy: 'stop new requests at limit; preserve in-flight usage' },
    cachedRuns: 0,
  };
  await write('selection.json', {
    policy: searchPolicy,
    taskIds: selected.map((task) => task.id),
    sourceIdentity: benchmark.identity,
  });
  await snapshotMechanism();
  if (environment) await writeFile(join(directory, 'execution-tool-reference.txt'), environment.toolReference);
  await persistManifest();
  if (promptBundle) {
    await write('prompt-bundle.json', promptBundle);
    manifest.promptOverride = { path: resolve(flags['prompt-bundle']), hash: digest(promptBundle) };
    await persistManifest();
  }
  await seedFromCache();
  if (flags['feedback-run']) {
    const origin = resolve(flags['feedback-run']);
    const previous = JSON.parse(await readFile(join(origin, 'manifest.json'), 'utf8'));
    if (previous.representation !== representation || !isDeepStrictEqual(previous.data.identity, benchmark.identity)
      || previous.model !== settings.model || !isDeepStrictEqual(previous.generation, GENERATION))
      throw Error('Feedback run must use the same representation, dataset and model settings');
    const saved = await readRunHistory(origin);
    artifactRegistry.rememberHistory(saved);
    for (const record of saved) {
      try {
        const evidence = record.traceEvidence ?? { directory: origin, candidateId: record.id };
        const audited = await auditCandidate(evidence.directory, evidence.candidateId);
        if (!record.traces?.length) record.traces = audited.traces;
        if (record.evaluation) {
          const rejected = new Map(audited.rejected.map(row => [row.caseId, row.reason]));
          const corrected = new Map(audited.reusable.map(row => [row.caseId, row]));
          const results = (record.evaluation.results ?? []).map(row => rejected.has(row.caseId)
            ? { ...row, valid: false, failureKind: 'provider', error: rejected.get(row.caseId) } : corrected.get(row.caseId) ?? row);
          const valid = results.length > 0 && results.every(row => row.valid && !row.error);
          record.evaluation = { ...record.evaluation, valid, score: valid
            ? results.reduce((sum, row) => sum + row.score, 0) / results.length : 0, results };
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      record.traceEvidence ??= { directory: origin, candidateId: record.id };
      record.id = 'previous-' + record.id;
      record.referenceCandidateId = null;
      record.status = 'historical-feedback';
      history.push(record);
    }
    manifest.feedbackSource = origin;
    await write('history.json', history);
  }
  if (flags['offline-only'] === 'true') {
    manifest.status = 'offline-cache-ready';
    await persistManifest();
    emit({ phase: 'offline-ready', directory });
    process.exitCode = 0;
  } else {
    // 先检查评分环境，避免生成代码后才发现无法评分。
    if (codeJudge) await codeJudge.preflight();
    experiment = createExperimentRuntime(settings, {
      tools: executionTools,
      onProviderError: error => providerHealth.record(error),
      ...(environment ? { async prepareProviderInput(input) {
        const prepared = environment.prepareProviderInput?.(input) ?? input;
        if (prepared !== input) await appendFile(join(directory, 'execution-model-inputs.jsonl'), JSON.stringify({ metadata: input.metadata, messages: prepared.messages }) + '\n');
        return prepared;
      } } : {}),
      beforeProviderCall() {
        // Includes calls inside TRAJECTORY and REFLECT repairs.
        providerHealth.admit();
        settleUsage(currentProviderDiagnostics(), activeUsageDestination);
        reserveRequest();
        try { environment?.beforeProviderCall(); }
        catch (error) { reservedRequests--; throw error; }
      },
    });
    capabilities.model = { provider: experiment.providerName, model: experiment.model };
    manifest.status = 'searching';
    await persistManifest();
    emit({
      phase: 'search-start',
      directory,
      representation,
      stages: searchPolicy.stages,
      repeats: 1,
      rounds,
      maxCalls,
      maxTokens,
    });
    if (flags['seed-proposal']) {
      const supplied = JSON.parse(await readFile(resolve(flags['seed-proposal']), 'utf8'));
      if (supplied.representation !== representation) throw Error('Supplied seed representation mismatch');
      const proposal = supplied.proposal,
        compiled = checkProposal(proposal, typeof proposal.referenceCandidateId === 'string' ? [proposal.referenceCandidateId] : []),
        id = 'seed-' + representation.toLowerCase();
      manifest.seedProposal = resolve(flags['seed-proposal']);
      const record = {
        id,
        proposal,
        rationale: proposal.rationale,
        referenceCandidateId: null,
        status: 'pending',
        traces: [],
        origin: supplied.origin,
        shape: workflowShape(compiled.plan),
      };
      history.push(record);
      artifactRegistry.remember(proposal);
      manifest.initialCandidateOrigin = evaluateOnly ? 'saved-model-candidate' : 'previous-model-candidate-with-user-supplied-prompts';
      await write('candidates/' + id + '.json', supplied);
      if (representation === 'A') await writeFile(join(directory, 'candidates', id + '.mjs'), proposal.source);
      await write('checkpoints/' + id + '.json', {
        plan: compiled.plan,
        candidateOrigin: manifest.initialCandidateOrigin,
      });
      let priorCases = [];
      if (flags['seed-partial-run']) {
        const origin = resolve(flags['seed-partial-run']);
        const audited = await loadAuditedPartialSeed(origin, flags['seed-partial-candidate'], {
          representation, model: settings.model, endpoint: settings.baseUrl, generation: GENERATION,
          dataIdentity: benchmark.identity, taskIds: selected.map(task => task.id), proposal,
        });
        priorCases = audited.reusable;
        record.traces = audited.traces;
        record.origin = { directory: origin, candidateId: flags['seed-partial-candidate'], kind: 'audited-partial-resume' };
        manifest.cachedRuns = priorCases.length;
        manifest.partialResume = { ...record.origin, resumedCandidateId: id,
          reusedCases: priorCases.length, rejectedCases: audited.rejected.length };
        emit({ phase: 'partial-cache-loaded', candidateId: id, reusedCases: priorCases.length,
          remainingCases: selected.length - priorCases.length });
      }
      await evaluateRecord(record, null, priorCases);
      render();
      if (record.evaluation?.valid && record.evaluation.examples === validationSize) {
        manifest.best = { candidateId: id, score: record.evaluation.score, examples: validationSize, repeats: 1 };
        await write('best/candidate.json', proposal);
        await write('best/validation-summary.json', { ...record.evaluation, results: undefined });
      }
      await persistManifest();
    }
    let repair;
    if (flags['repair-history']) {
      const previous = JSON.parse(await readFile(resolve(flags['repair-history']), 'utf8'));
      const failed = [...previous].reverse().find(record => record.proposal && record.engineeringFeedback?.length);
      if (!failed) throw Error('No execution failure found in repair history');
      repair = { proposal: failed.proposal, error: failed.engineeringFeedback.join('\n') };
      manifest.repairSource = resolve(flags['repair-history']);
    }
    if (flags['repair-response']) {
      const previous = JSON.parse(await readFile(resolve(flags['repair-response']), 'utf8'));
      try { checkProposal(parseGeneratedProposal(previous.content).proposal, []); }
      catch (error) { repair = { proposal: previous.content, error: error.message }; }
      if (!repair) throw Error('The supplied response already compiles; evaluate it as a seed instead');
      manifest.repairSource = resolve(flags['repair-response']);
    }
    for (let round = 1; round <= rounds && !evaluateOnly; round++) {
      const id = 'generated-' + String(round).padStart(3, '0');
      activeUsageDestination = optimizerUsage;
      const candidate = await propose(id, repair);
      repair = undefined;
      activeUsageDestination = evaluationUsage;
      artifactRegistry.remember(candidate.proposal);
      const record = {
        id,
        proposal: candidate.proposal,
        rationale: candidate.proposal.rationale,
        referenceCandidateId: candidate.proposal.referenceCandidateId,
        status: 'pending',
        traces: [],
        shape: workflowShape(candidate.plan),
      };
      const reference = bestCandidate();
      history.push(record);
      await write('candidates/' + id + '.json', {
        representation,
        proposal: candidate.proposal,
        artifactHash: candidate.identity,
      });
      if (representation === 'A')
        await writeFile(join(directory, 'candidates', id + '.mjs'), candidate.proposal.source);
      await write('checkpoints/' + id + '.json', {
        plan: candidate.plan,
        referenceCandidateId: record.referenceCandidateId,
        candidateOrigin: 'llm-generated',
        optimizerProfile: GENERATED_SEARCH_PROMPT_VERSION,
      });
      emit({
        phase: 'candidate-generated',
        representation,
        candidateId: id,
        nodes: candidate.plan.nodes.length,
        rationale: record.rationale,
      });
      if (generateOnly) {
        record.status = 'generated';
        manifest.status = 'candidate-ready';
        await write('history.json', history);
        break;
      }
      try {
        await evaluateRecord(record, reference);
      } catch (error) {
        record.status = 'invalid';
        record.engineeringFeedback = [String(error.message)];
        await write('history.json', history);
        await persistManifest();
        if (/HTTP (?:401|402|403)|insufficient.*balance|SEARCH_BUDGET_EXHAUSTED/i.test(error.message)) throw error;
        if (error.failureKind === 'provider' || error.failureKind === 'timeout') throw error;
        repair = { proposal: record.proposal, error: error.message };
        emit({ phase: 'candidate-engineering-failure', representation, candidateId: id, error: error.message });
        continue;
      }
      await write('history.json', history);
      await persistManifest();
      render();
      const best = bestCandidate();
      if (best) {
        await write('best/candidate.json', best.proposal);
        await write('best/validation-summary.json', { ...best.evaluation, results: undefined });
        manifest.best = { candidateId: best.id, score: best.evaluation.score, examples: validationSize, repeats: 1 };
      }
      if (evolution) await write('evolution-archive.json', evolutionArchive(history, validationSize));
      if (
        record.evaluation?.valid &&
        record.evaluation.examples === validationSize &&
        record.evaluation.score > searchPolicy.targetF1
      ) {
        manifest.status = 'target-reached';
        break;
      }
    }
    if (manifest.status === 'searching') manifest.status = evaluateOnly ? 'saved-candidate-evaluated' : 'round-budget-complete';
    await persistManifest();
    emit({
      phase: 'search-complete',
      directory,
      status: manifest.status,
      best: manifest.best,
      newUsage,
      optimizerUsage,
      cachedRuns: manifest.cachedRuns,
    });
  }
} catch (error) {
  const pending = history.at(-1);
  if (pending?.status === 'pending') {
    pending.status = 'invalid';
    pending.engineeringFeedback = [error.message];
  }
  if (manifest) {
    manifest.status = /SEARCH_BUDGET_EXHAUSTED/.test(error.message)
      ? 'cost-budget-complete'
      : /HTTP 402|insufficient.*balance/i.test(error.message)
        ? 'account-blocked'
        : 'failed';
    manifest.error = error.message;
    await persistManifest();
  }
  if (history.length) await write('history.json', history);
  emit({ phase: 'search-stopped', directory, status: manifest?.status, error: error.message, newUsage });
  if (history.length && manifest) render();
  process.exitCode = manifest?.status === 'cost-budget-complete' ? 0 : 1;
} finally {
  if (experiment) await experiment.close();
  if (environment) await environment.close();
}
