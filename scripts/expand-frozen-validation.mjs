/** Expand one unchanged historical 64-task candidate to the original 200 tasks. */
import { readFile, writeFile, appendFile, mkdir, readdir, copyFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { graph, graphStep, loop } from '@codesoul-co/ditto/runtime';
import { loadProviderSettings } from '../dist/config.js';
import { createExperimentRuntime } from '../dist/ditto/runtime.js';
import { loadBenchmark } from '../dist/benchmark/index.js';
import { GENERATION } from '../dist/protocol.js';
import { captureProviderDiagnostics, currentProviderDiagnostics, summarizeProviderDiagnostics } from '../dist/ditto/provider-diagnostics.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const usageKeys = ['providerAttempts', 'failedProviderAttempts', 'inputTokens', 'outputTokens', 'totalTokens', 'unknownUsageAttempts'];
const emptyUsage = () => Object.fromEntries(usageKeys.map(key => [key, 0]));
const complete = row => row?.valid === true && row.error === undefined;
const same = (actual, expected, label) => { if (!isDeepStrictEqual(actual, expected)) throw Error(`Expansion identity differs: ${label}`); };
const json = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const emit = value => console.log(JSON.stringify(value));
function plus(target, value) { for (const key of usageKeys) target[key] = (target[key] ?? 0) + (value[key] ?? 0); }

export async function readExpansionCases(path, optional = false) {
  let raw;
  try { raw = await readFile(path, 'utf8'); } catch (error) { if (optional && error.code === 'ENOENT') return []; throw error; }
  const lines = raw.replace(/^\uFEFF/, '').split(/\r?\n/);
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  return lines.map((line, index) => {
    let row;
    try { row = JSON.parse(line); } catch { throw Error(`Malformed expansion JSONL line ${index + 1}`); }
    if (!row || typeof row !== 'object' || typeof row.caseId !== 'string') throw Error(`Malformed expansion case line ${index + 1}`);
    return row;
  });
}

/** Opaque scorer fields remain local; public reports contain counts/scores only. */
export function validateExpansionCache(allTaskIds, originalTaskIds, originalRows, childRows = []) {
  if (new Set(allTaskIds).size !== allTaskIds.length || new Set(originalTaskIds).size !== originalTaskIds.length)
    throw Error('Expansion task IDs must be unique');
  const all = new Set(allTaskIds.map(id => id + '#1'));
  const original = new Set(originalTaskIds.map(id => id + '#1'));
  if ([...original].some(id => !all.has(id))) throw Error('Original task selection is outside the full validation split');
  const source = new Map(originalRows.map(row => [row.caseId, row]));
  if ([...source.keys()].some(id => !original.has(id))) throw Error('Original cache includes cases outside its 64 first-pass selection');
  if ([...original].some(id => !complete(source.get(id)))) throw Error('Every original selected task must have a complete first-pass result');
  for (const row of source.values()) if (typeof row.prediction !== 'string' || !Number.isFinite(row.score)) throw Error('Malformed original cached result');
  const cases = new Map(source);
  for (const row of childRows) {
    if (!all.has(row.caseId)) throw Error('Expanded cache includes an unknown task or repeat');
    if (original.has(row.caseId)) same(row, source.get(row.caseId), 'unchanged original first-pass record');
    if (complete(row) && (typeof row.prediction !== 'string' || !Number.isFinite(row.score))) throw Error('Malformed completed expansion result');
    cases.set(row.caseId, row);
  }
  return cases;
}

export function expansionScoreGroups(allTaskIds, originalTaskIds, cases) {
  const original = new Set(originalTaskIds);
  const group = ids => {
    const observed = ids.map(id => cases.get(id + '#1')).filter(Boolean), valid = observed.filter(complete);
    const average = valid.length ? valid.reduce((sum, row) => sum + row.score, 0) / valid.length : null;
    return { taskCount: ids.length, observedRuns: observed.length, validRuns: valid.length,
      invalidRuns: observed.length - valid.length, missingRuns: ids.length - observed.length,
      complete: valid.length === ids.length, score: valid.length === ids.length ? average : null,
      observedValidMean: average };
  };
  return { original64: group(originalTaskIds), additional136: group(allTaskIds.filter(id => !original.has(id))), full200: group(allTaskIds) };
}

export async function main(argv = process.argv.slice(2)) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index], value = argv[index + 1];
    if (!['--run-dir', '--candidate', '--max-calls', '--concurrency', '--offline-only', '--output'].includes(name) || value === undefined)
      throw Error('Use --run-dir PATH --candidate ID [--max-calls 500] [--concurrency 3] [--offline-only true] [--output PATH]');
    if (Object.hasOwn(flags, name.slice(2))) throw Error('Duplicate expansion option');
    flags[name.slice(2)] = value;
  }
  if (!flags['run-dir'] || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(flags.candidate ?? '')) throw Error('Original run directory and candidate ID are required');
  if (flags['offline-only'] !== undefined && !['true', 'false'].includes(flags['offline-only'])) throw Error('offline-only must be true or false');
  const maxCalls = Number(flags['max-calls'] ?? 500), concurrency = Number(flags.concurrency ?? 3), offline = flags['offline-only'] === 'true';
  if (![maxCalls, concurrency].every(value => Number.isSafeInteger(value) && value > 0)) throw Error('max-calls/concurrency must be positive integers');
  const sourceDirectory = resolve(flags['run-dir']), candidateId = flags.candidate;
  const directory = resolve(flags.output ?? join(sourceDirectory, 'expanded-validation', candidateId));
  if (directory === sourceDirectory) throw Error('Expanded output must not overwrite the original run directory');
  const sourceManifest = await json(join(sourceDirectory, 'manifest.json'));
  const selection = await json(join(sourceDirectory, 'selection.json'));
  const saved = await json(join(sourceDirectory, 'candidates', candidateId + '.json'));
  if (sourceManifest.dataset !== 'drop' || sourceManifest.split !== 'validate' || !['A', 'B'].includes(sourceManifest.representation))
    throw Error('Expansion requires an original generated DROP validation run');
  same(sourceManifest.repeats, 1, 'original first-pass repeats');
  same(saved.representation, sourceManifest.representation, 'candidate representation');
  const settings = { ...loadProviderSettings(offline ? { ...process.env, CODE_SOUL_API_KEY: process.env.CODE_SOUL_API_KEY || 'offline-unused' } : process.env), concurrency };
  same(settings.model, sourceManifest.model, 'model'); same(settings.baseUrl, sourceManifest.endpoint, 'endpoint');
  same(GENERATION, sourceManifest.generation, 'generation');
  const benchmark = await loadBenchmark('drop', { dataDir: join(projectRoot, 'data/datasets'), split: 'validate', limit: 0 });
  if (benchmark.tasks.length !== 200 || benchmark.identity?.verified !== true) throw Error('Original pinned full 200-task validation split is required');
  same(benchmark.identity, sourceManifest.data?.identity, 'fixed data identity');
  same(selection.sourceIdentity, benchmark.identity, 'original selection data identity');
  const originalIds = sourceManifest.data?.taskIds;
  if (!Array.isArray(originalIds) || originalIds.length !== 64) throw Error('Original run must identify 64 tasks');
  same(selection.taskIds, originalIds, 'original selected IDs/order');
  const taskIds = benchmark.tasks.map(task => task.id), originalSet = new Set(originalIds);
  const additionalIds = taskIds.filter(id => !originalSet.has(id));
  const artifactField = sourceManifest.representation === 'A' ? 'source' : 'definition';
  const artifactHash = digest(saved.proposal?.[artifactField]);
  same(saved.artifactHash, artifactHash, 'candidate artifact hash');
  const sourceRows = await readExpansionCases(join(sourceDirectory, 'evaluations', candidateId, 'live-samples.jsonl'));
  const evaluationDirectory = join(directory, 'evaluations', candidateId);
  const childRows = await readExpansionCases(join(evaluationDirectory, 'live-samples.jsonl'), true);
  const cases = validateExpansionCache(taskIds, originalIds, sourceRows, childRows);
  let priorManifest;
  try { priorManifest = await json(join(directory, 'manifest.json')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const mechanismDirectory = join(sourceDirectory, 'mechanism');
  const mechanismNames = (await readdir(mechanismDirectory, { withFileTypes: true })).filter(entry => entry.isFile()).map(entry => entry.name);
  const mechanism = await Promise.all(mechanismNames.map(async name => [name, await readFile(join(mechanismDirectory, name), 'utf8')]));
  if (priorManifest) {
    same(priorManifest.expansion?.artifactHash, artifactHash, 'saved expanded artifact');
    same(priorManifest.model, sourceManifest.model, 'expanded model'); same(priorManifest.endpoint, sourceManifest.endpoint, 'expanded endpoint');
    same(priorManifest.generation, sourceManifest.generation, 'expanded generation'); same(priorManifest.repeats, 1, 'expanded repeats');
    same(priorManifest.data?.identity, benchmark.identity, 'expanded data'); same(priorManifest.data?.taskIds, taskIds, 'expanded task order');
    same(priorManifest.expansion?.originalTaskIds, originalIds, 'expanded original64 order');
    same(await json(join(directory, 'candidates', candidateId + '.json')), saved, 'saved unchanged candidate');
    for (const [name, content] of mechanism) same(await readFile(join(directory, 'mechanism', name), 'utf8'), content, 'saved frozen mechanism ' + name);
  } else if (childRows.length) throw Error('Expanded case cache has no identity manifest');

  const frozenTools = await import(pathToFileURL(join(mechanismDirectory, 'workflow-capabilities.mjs')).href);
  const frozenCompiler = await import(pathToFileURL(join(mechanismDirectory, sourceManifest.representation === 'A' ? 'generated-workflow-a.mjs' : 'generated-workflow-b.mjs')).href);
  const usage = emptyUsage(), accounted = new WeakMap(), previousUsage = { ...priorManifest?.newUsage };
  let reservedRequests = 0, stopped = false, experiment;
  const settle = records => {
    for (const item of records ?? []) {
      const current = summarizeProviderDiagnostics([item]), previous = accounted.get(item) ?? emptyUsage();
      plus(usage, Object.fromEntries(usageKeys.map(key => [key, (current[key] ?? 0) - (previous[key] ?? 0)])));
      accounted.set(item, current);
    }
  };
  const capabilities = { graph, graphStep, loop, model: { provider: 'deepseek', model: settings.model }, generation: GENERATION,
    unwrap: frozenTools.unwrap, parseJson: frozenTools.parseJson, answerText: frozenTools.answerText,
    allowedTools: frozenTools.sharedTools.map(tool => tool.name), beforeNode({ type }) {
      settle(currentProviderDiagnostics());
      if (stopped) throw Error('EXPANSION_STOPPED');
      if (type === 'INFER.REASONING.SAMPLE') {
        if (Math.max(reservedRequests, usage.providerAttempts) >= maxCalls) { stopped = true; throw Error('EXPANSION_BUDGET_EXHAUSTED'); }
        reservedRequests++;
      }
    } };
  const compile = () => {
    if (sourceManifest.representation === 'A') return frozenCompiler.compileGeneratedWorkflowA(saved.proposal.source, capabilities);
    const trace = [], definition = frozenCompiler.compileEvidenceDefinition(saved.proposal.definition, capabilities, { trace });
    return { definition, trace };
  };
  compile();
  const reusable = [...cases.values()].filter(complete).length;
  emit({ phase: 'expansion-preflight', sourceDirectory, directory, candidateId, representation: sourceManifest.representation,
    artifactHash, totalTasks: 200, originalCachedTasks: 64, additionalTasks: additionalIds.length,
    reusableCases: reusable, missingOrInvalid: 200 - reusable, repeats: 1, concurrency, maxAdditionalCalls: maxCalls, offline });
  if (offline) return { directory, reusableCases: reusable, missingOrInvalid: 200 - reusable, artifactHash };

  await mkdir(evaluationDirectory, { recursive: true });
  const write = async (file, value) => { const path = join(directory, file); await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(value, null, 2) + '\n'); };
  const appends = new Map();
  const append = (path, value) => { const next = (appends.get(path) ?? Promise.resolve()).then(() => appendFile(path, JSON.stringify(value) + '\n')); appends.set(path, next); return next; };
  for (const [name, content] of mechanism) { const path = join(directory, 'mechanism', name); await mkdir(dirname(path), { recursive: true }); if (!priorManifest) await writeFile(path, content); }
  if (!priorManifest) {
    await copyFile(fileURLToPath(import.meta.url), join(directory, 'mechanism', 'expand-frozen-validation.mjs'));
    await write('candidates/' + candidateId + '.json', saved);
    await write('checkpoints/' + candidateId + '.json', await json(join(sourceDirectory, 'checkpoints', candidateId + '.json')));
    await writeFile(join(evaluationDirectory, 'live-samples.jsonl'), originalIds.map(id => JSON.stringify(cases.get(id + '#1'))).join('\n') + '\n');
    try { await copyFile(join(sourceDirectory, 'evaluations', candidateId, 'public-traces.jsonl'), join(evaluationDirectory, 'public-traces.jsonl')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const manifest = { schemaVersion: 1, status: 'expansion-running', createdAt: priorManifest?.createdAt ?? new Date().toISOString(),
    dataset: 'drop', split: 'validate', representation: sourceManifest.representation, candidateOrigin: 'unchanged-llm-generated', manualCandidateUse: false,
    model: settings.model, endpoint: settings.baseUrl, generation: GENERATION, repeats: 1, concurrency,
    protocol: { id: 'frozen-candidate-full200-expansion-v1', scope: 'original-fixed200-validation-one-repeat', fullFiveRepeatClaim: false },
    data: { identity: benchmark.identity, selectedExamples: 200, taskIds }, optimizerUsage: emptyUsage(),
    expansion: { candidateId, artifactHash, sourceDirectory, originalTaskIds: originalIds, additionalTaskIds: additionalIds,
      originalCachedRuns: 64, originalSearchBudgetUnchanged: true, candidateFrozen: true, mechanism: 'original-source-run-snapshot' },
    budget: { maxAdditionalCalls: maxCalls, policy: 'stop new requests at allowance; wait for and save in-flight results' } };
  await write('selection.json', { taskIds, originalTaskIds: originalIds, additionalTaskIds: additionalIds, sourceIdentity: benchmark.identity, repeats: 1 });
  const combinedUsage = () => { const total = { ...previousUsage }; plus(total, usage); return total; };
  let persistQueue = Promise.resolve();
  const persist = status => {
    persistQueue = persistQueue.then(async () => {
      Object.assign(manifest, { status, newUsage: combinedUsage(), evaluationUsage: combinedUsage(), currentInvocationUsage: { ...usage },
        reservedRequests, groups: expansionScoreGroups(taskIds, originalIds, cases) });
      await write('manifest.json', manifest);
    });
    return persistQueue;
  };
  await persist('expansion-running');
  const partial = () => {
    const results = taskIds.map(id => cases.get(id + '#1')).filter(Boolean), sum = key => results.reduce((total, row) => total + (row[key] ?? 0), 0);
    return { valid: false, score: 0, repeatScores: [0], examples: 200, repeats: 1, results,
      validRuns: results.filter(complete).length, successfulRuns: results.filter(complete).length, failedRuns: results.filter(row => !complete(row)).length,
      inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), totalTokens: sum('totalTokens'), providerAttemptCount: sum('providerAttempts'),
      tokenUsageStatus: results.every(row => row.usageKnown) ? 'complete' : 'known-lower-bound' };
  };
  let summary, failure;
  try {
    if (reusable < 200) experiment = createExperimentRuntime(settings, { tools: frozenTools.sharedTools });
    if (experiment) capabilities.model = { provider: experiment.providerName, model: experiment.model };
    const runner = task => captureProviderDiagnostics(async records => {
      const fresh = compile(), graphEvents = [];
      try {
        if (stopped) throw Error('EXPANSION_STOPPED');
        const raw = await experiment.runtime.loop(fresh.definition, task, { onGraph: event => graphEvents.push(event) });
        const result = typeof raw === 'string' ? { answer: raw } : raw;
        return { answer: frozenTools.answerText(result.answer), executedNodeIds: fresh.trace.filter(event => event.kind === 'node').map(event => event.nodeId),
          executedGraphIds: graphEvents.filter(event => event.status === 'completed').map(event => event.graphId), ...summarizeProviderDiagnostics(records) };
      } catch (error) { throw Object.assign(error, summarizeProviderDiagnostics(records)); }
      finally {
        settle(records);
        await append(join(evaluationDirectory, 'public-traces.jsonl'), { taskId: task.id, events: fresh.trace, expansion: true, at: new Date().toISOString() });
      }
    });
    summary = await benchmark.evaluateSearchSubset(taskIds, runner, { repeats: 1, concurrency, retryAttempts: 1, priorCases: [...cases.values()],
      async onCase({ completed, total, result }) {
        const reused = cases.get(result.caseId) === result;
        cases.set(result.caseId, result);
        if (!reused) await append(join(evaluationDirectory, 'live-samples.jsonl'), result);
        await persist('expansion-running');
        if (!complete(result)) { stopped = true; throw Error(result.error ?? 'Invalid expansion case'); }
        if (!reused && (completed % 8 === 0 || completed === total)) emit({ phase: 'expansion-progress', candidateId, completed, total, newCalls: usage.providerAttempts });
      } });
  } catch (error) { stopped = true; failure = error; summary = partial(); }
  finally { if (experiment) await experiment.close(); }
  same(await json(join(sourceDirectory, 'candidates', candidateId + '.json')), saved, 'source candidate remained unchanged');
  for (const [name, content] of mechanism) same(await readFile(join(mechanismDirectory, name), 'utf8'), content, 'source mechanism remained unchanged ' + name);
  const { results, ...stats } = summary;
  const groups = expansionScoreGroups(taskIds, originalIds, cases);
  await write('evaluations/' + candidateId + '/summary.json', { ...stats, groups, reusedOriginalCases: 64, newUsage: combinedUsage(),
    scope: 'original-fixed200-validation-one-repeat', fullFiveRepeatClaim: false });
  await writeFile(join(evaluationDirectory, 'samples.jsonl'), results.map(row => JSON.stringify(row)).join('\n') + '\n');
  await write('history.json', [{ id: candidateId, proposal: saved.proposal, referenceCandidateId: null,
    status: summary.valid ? 'valid' : 'invalid', evaluation: summary }]);
  await persist(summary.valid ? 'expansion-complete' : 'expansion-incomplete');
  emit({ phase: 'expansion-complete', directory, candidateId, valid: summary.valid, groups, newUsage: combinedUsage(),
    ...(failure ? { error: failure.message } : {}) });
  if (!summary.valid) process.exitCode = 1;
  return { directory, valid: summary.valid, groups, newUsage: combinedUsage() };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  console.error(JSON.stringify({ phase: 'expansion-preflight-failed', error: error.message })); process.exitCode = 1;
});
