import { mkdir, writeFile, appendFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { spawnSync } from 'node:child_process';
import { graph, graphStep, loop } from '@codesoul-co/ditto/runtime';
import { loadProviderSettings } from '../dist/config.js';
import { createExperimentRuntime } from '../dist/ditto/runtime.js';
import { loadBenchmark } from '../dist/benchmark/index.js';
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
const representation = flags.representation ?? 'B';
const validationSize = positive('validation-size', 64);
const searchPolicy = searchPolicyForSize(validationSize);
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
    'runs/generated-small-batch/drop/' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + representation,
);
await mkdir(directory, { recursive: true });
const write = async (file, value) => {
  await mkdir(resolve(directory, file, '..'), { recursive: true });
  await writeFile(join(directory, file), JSON.stringify(value, null, 2) + '\n');
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
const usedOrReserved = () => committedRequests(newUsage.providerAttempts, reservedRequests, settledInvocations);
const history = [],
  artifactIdentities = new Set();
const artifactField = representation === 'A' ? 'source' : 'definition';
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
const optimizerPrompt = promptBundle?.optimizer ?? GENERATED_SEARCH_PROMPT;
const guide = promptBundle
  ? representation === 'A'
    ? promptBundle.guideA
    : promptBundle.guideB
  : representation === 'A'
    ? GENERATED_A_GUIDE
    : EVIDENCE_DEFINITION_GUIDE;
const guideVersion = representation === 'A' ? GENERATED_A_GUIDE_VERSION : EVIDENCE_DEFINITION_GUIDE_VERSION;
let experiment, manifest, selected, benchmark;

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
    throw Object.assign(Error('SEARCH_BUDGET_EXHAUSTED: stopping new requests; in-flight work will be saved'), {
      code: 'SEARCH_BUDGET_EXHAUSTED',
    });
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
  const identity = digest(proposal[artifactField]);
  if (artifactIdentities.has(identity))
    throw Error('Identical artifact was already evaluated; use recorded evidence to make a substantive change');
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
    'scripts/generated-small-batch-policy.mjs',
    'scripts/generated-search-prompt.mjs',
    'scripts/generated-search-feedback.mjs',
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
  const runner = (task) =>
    captureProviderDiagnostics(async (records) => {
      const fresh = compile(record.proposal),
        graphEvents = [];
      try {
        const raw = await experiment.runtime.loop(fresh.definition, task, {
          onGraph: (event) => graphEvents.push(event),
        });
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
        throw Object.assign(error, summarizeProviderDiagnostics(records));
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
      retryAttempts: 2,
      onCase,
    });
    latest = first.results;
  }
  for (const size of searchPolicy.stages) {
    const ids = selected.slice(0, size).map((task) => task.id);
    const summary = await benchmark.evaluateSearchSubset(ids, runner, {
      repeats: 1,
      concurrency,
      retryAttempts: 2,
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
    const decision = pairedStageDecision(summary, reference?.evaluation, size, searchPolicy);
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
  const rows = sampleText
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
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
    origin: {
      directory: origin,
      candidateId,
      kind: 'previous-llm-generated',
      traceAvailability: 'not-recorded',
      compatibility: 'same successful native operations; additive capabilities and trace/input checks only',
    },
  };
  history.push(record);
  artifactIdentities.add(digest(saved.proposal[artifactField]));
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
  const feedback = buildGeneratedFeedback(history, selected);
  const full = bestCandidate();
  const preferred = [history.at(-1), full, ...history.filter((row) => row.status === 'valid').slice(-2)].filter(
    Boolean,
  );
  const parents = [...new Map(preferred.map((row) => [row.id, row])).values()];
  let rejected = repair?.proposal,
    previousError = repair?.error;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const input = {
      mode: rejected ? 'ENGINEERING REPAIR' : 'QUALITY SEARCH',
      goal: `Autonomously generate a reusable workflow exceeding 0.90 F1 on the fixed ${validationSize}-task validation set; use evidence to improve, not score assertions.`,
      representation,
      taskContract: promptBundle?.taskContract ?? DROP_SEARCH_CONTRACT,
      capabilityGuide: promptBundle?.capabilityGuide ?? SHARED_CAPABILITY_GUIDE,
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
          return await experiment.runtime.run(plan, {});
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
      const proposal = parseJson(content),
        compiled = checkProposal(
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
  benchmark = await loadBenchmark('drop', { dataDir: resolve('data/datasets'), split: 'validate', limit: 0 });
  selected = selectSearchTasks(benchmark.tasks, validationSize);
  manifest = {
    schemaVersion: 3,
    status: 'preparing',
    createdAt: new Date().toISOString(),
    dataset: 'drop',
    split: 'validate',
    representation,
    optimizerProfile: GENERATED_SEARCH_PROMPT_VERSION,
    guideVersion,
    candidateOrigin: 'llm-generated',
    manualCandidateUse: false,
    model: settings.model,
    endpoint: settings.baseUrl,
    generation: GENERATION,
    repeats: 1,
    concurrency,
    protocol: {
      ...PROTOCOL,
      id: searchPolicy.id,
      validationRepeats: 1,
      searchPolicy: 'automatic-evidence-hypothesis-staged-v2-full-infer',
    },
    searchPolicy,
    data: { identity: benchmark.identity, selectedExamples: validationSize, taskIds: selected.map((task) => task.id) },
    budget: { maxCalls, maxTokens, rounds, policy: 'stop new requests at limit; preserve in-flight usage' },
    cachedRuns: 0,
  };
  await write('selection.json', {
    policy: searchPolicy,
    taskIds: selected.map((task) => task.id),
    sourceIdentity: benchmark.identity,
  });
  await snapshotMechanism();
  await persistManifest();
  if (promptBundle) {
    await write('prompt-bundle.json', promptBundle);
    manifest.promptOverride = { path: resolve(flags['prompt-bundle']), hash: digest(promptBundle) };
    await persistManifest();
  }
  await seedFromCache();
  if (flags['offline-only'] === 'true') {
    manifest.status = 'offline-cache-ready';
    await persistManifest();
    emit({ phase: 'offline-ready', directory });
    process.exitCode = 0;
  } else {
    experiment = createExperimentRuntime(settings, {
      tools: sharedTools,
      beforeProviderCall() {
        // Includes calls inside TRAJECTORY and REFLECT repairs.
        settleUsage(currentProviderDiagnostics(), activeUsageDestination);
        reserveRequest();
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
        compiled = checkProposal(proposal, []),
        id = 'seed-' + representation.toLowerCase();
      const record = {
        id,
        proposal,
        rationale: proposal.rationale,
        referenceCandidateId: null,
        status: 'pending',
        traces: [],
        origin: supplied.origin,
      };
      history.push(record);
      artifactIdentities.add(compiled.identity);
      manifest.initialCandidateOrigin = 'previous-model-candidate-with-user-supplied-prompts';
      await write('candidates/' + id + '.json', supplied);
      if (representation === 'A') await writeFile(join(directory, 'candidates', id + '.mjs'), proposal.source);
      await write('checkpoints/' + id + '.json', {
        plan: compiled.plan,
        candidateOrigin: manifest.initialCandidateOrigin,
      });
      await evaluateRecord(record, null);
      render();
      if (record.evaluation?.valid && record.evaluation.examples === validationSize) {
        manifest.best = { candidateId: id, score: record.evaluation.score, examples: validationSize, repeats: 1 };
        await write('best/candidate.json', proposal);
        await write('best/validation-summary.json', { ...record.evaluation, results: undefined });
      }
      await persistManifest();
    }
    let repair;
    for (let round = 1; round <= rounds; round++) {
      const id = 'generated-' + String(round).padStart(3, '0');
      activeUsageDestination = optimizerUsage;
      const candidate = await propose(id, repair);
      repair = undefined;
      activeUsageDestination = evaluationUsage;
      artifactIdentities.add(candidate.identity);
      const record = {
        id,
        proposal: candidate.proposal,
        rationale: candidate.proposal.rationale,
        referenceCandidateId: candidate.proposal.referenceCandidateId,
        status: 'pending',
        traces: [],
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
      if (
        record.evaluation?.valid &&
        record.evaluation.examples === validationSize &&
        record.evaluation.score > searchPolicy.targetF1
      ) {
        manifest.status = 'target-reached';
        break;
      }
    }
    if (manifest.status === 'searching') manifest.status = 'round-budget-complete';
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
  if (manifest) {
    manifest.status = /SEARCH_BUDGET_EXHAUSTED/.test(error.message)
      ? 'cost-budget-complete'
      : /HTTP 402|insufficient.*balance/i.test(error.message)
        ? 'account-blocked'
        : 'failed';
    manifest.error = error.message;
    await persistManifest();
  }
  emit({ phase: 'search-stopped', directory, status: manifest?.status, error: error.message, newUsage });
  process.exitCode = manifest?.status === 'cost-budget-complete' ? 0 : 1;
} finally {
  if (experiment) await experiment.close();
}
