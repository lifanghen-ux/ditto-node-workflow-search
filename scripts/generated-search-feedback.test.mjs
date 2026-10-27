import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGeneratedFeedback } from './generated-search-feedback.mjs';

const task = (id, prompt = `PUBLIC task ${id}`) => ({ id, dataset: 'drop', prompt, outputInstruction: 'public contract', metadata: { secret: 'PRIVATE_TASK_METADATA' } });
function row(id, score, prediction = 'public prediction', extras = {}) {
  const value = { caseId: id, valid: true, score, prediction, inputTokens: 2, outputTokens: 3, totalTokens: 5, usageKnown: true, ...extras };
  for (const key of ['expected', 'normalizedExpected', 'details', 'generationOutcomes', 'previousResults'])
    Object.defineProperty(value, key, { enumerable: true, get() { throw new Error(`Private row field read: ${key}`); } });
  return value;
}
function record(id, results, referenceCandidateId = null, extras = {}) {
  return { id, status: 'valid', proposal: { referenceCandidateId, rationale: 'PRIVATE_PROPOSAL_NOT_FEEDBACK' }, referenceCandidateId,
    evaluation: { results, score: 0, examples: new Set(results.map(value => value.caseId.replace(/#\d+$/, ''))).size,
      repeats: 1, inputTokens: 9, outputTokens: 11, totalTokens: 20, durationMs: 8, providerAttemptCount: 4,
      tokenUsageStatus: 'known-lower-bound' }, ...extras };
}

test('quality feedback uses a CaseResult whitelist and never reads labels or private scorer diagnostics', () => {
  const child = record('a', [row('a#1', .5)], null, { engineeringFeedback: ['PRIVATE_SCORER_MESSAGE expected PRIVATE_LABEL'] });
  const feedback = buildGeneratedFeedback([child], [task('a')])[0];
  assert.equal(feedback.quality.meanScore, .5, 'do not repeat a placeholder aggregate score');
  assert.equal(feedback.cases[0].current.outcomes[0].prediction, 'public prediction');
  assert.equal(feedback.cost.totalTokens, 20);
  assert.equal(feedback.cost.scope, 'recorded-evaluation-only-excludes-optimizer');
  assert.equal(feedback.engineering.issues[0].kind, 'judge');
  assert.ok(!JSON.stringify(feedback).includes('PRIVATE'));
  assert.ok(!Object.hasOwn(feedback, 'proposal'));
});

test('partial sample comparisons use only common valid caseIds and state the overlap scope', () => {
  const parent = record('parent', [row('a#1', .2), row('a#2', 1), row('b#1', 1)]);
  const child = record('child', [row('a#1', .8), row('a#2', 0, '', { valid: false, error: 'PRIVATE_PROVIDER_FAILURE', failureKind: 'provider' }), row('c#1', 1)], 'parent');
  const feedback = buildGeneratedFeedback([parent, child], [task('a'), task('b'), task('c')])[1];
  assert.equal(feedback.paired.status, 'available');
  assert.equal(feedback.paired.overlapRuns, 1);
  assert.equal(feedback.paired.overlapTasks, 1);
  assert.equal(feedback.paired.currentOnlyValidRuns, 1);
  assert.equal(feedback.paired.referenceOnlyValidRuns, 2);
  assert.ok(Math.abs(feedback.paired.meanScoreDelta - .6) < 1e-12);
  assert.equal(feedback.sample.observedRuns, 3);
  assert.equal(feedback.sample.invalidRuns, 1);
  assert.equal(feedback.quality.meanScore, .9);
  assert.match(feedback.paired.note, /not the complete validation split/);
  assert.equal(feedback.engineering.failureCounts.provider, 1);
  const example = feedback.cases.find(value => value.taskId === 'a');
  assert.equal(example.current.totalOutcomes, 1);
  assert.equal(example.reference.totalOutcomes, 2);
  assert.ok(!JSON.stringify(feedback).includes('PRIVATE'));
});

test('selection includes the largest regression, losses, an improvement and a successful control without solution categories', () => {
  const parent = record('p', [row('a#1', 1), row('b#1', 1), row('c#1', 0), row('d#1', 1), row('e#1', 0), row('f#1', .5), row('g#1', .5)]);
  const child = record('c', [row('a#1', .6), row('b#1', .1), row('c#1', 1), row('d#1', 1), row('e#1', 0), row('f#1', .2), row('g#1', .7)], 'p');
  const feedback = buildGeneratedFeedback([parent, child], 'abcdefg'.split('').map(id => task(id)))[1];
  assert.ok(feedback.cases.length <= 6);
  assert.equal(feedback.cases.find(value => value.selectedBecause === 'largest-regression').taskId, 'b');
  assert.equal(feedback.cases.find(value => value.selectedBecause === 'largest-loss').taskId, 'e');
  assert.equal(feedback.cases.find(value => value.selectedBecause === 'largest-improvement').taskId, 'c');
  assert.ok(feedback.cases.some(value => value.selectedBecause === 'successful-control'));
  assert.ok(feedback.cases.every(value => !Object.hasOwn(value, 'failureCategory')));
  assert.equal(new Set(feedback.cases.map(value => value.taskId)).size, feedback.cases.length);
});

test('runtime traces preserve arbitrary business fields and repeated loop invocations while removing sensitive fields', () => {
  const input = { operands: [10, 4], constraints: { units: 'public unit', relation: 'public custom relation' } };
  for (const key of ['expected', 'normalizedExpected', 'referenceAnswer', 'secretToken', 'privateNotes'])
    Object.defineProperty(input, key, { enumerable: true, get() { throw new Error(`Sensitive trace field read: ${key}`); } });
  const events = Array.from({ length: 20 }, (_, index) => ({
    kind: 'node-complete', graphId: 'repeat-graph', nodeId: 'custom', nodeType: 'INFER.REASONING.SAMPLE', invocation: index + 1,
    input, output: { arbitraryBusinessResult: 'x'.repeat(4000), customNested: { referenceAnswer: 'PRIVATE_LABEL', ordinaryField: true } },
  }));
  const candidate = record('a', [row('a#1', .5, 'y'.repeat(1000))], null, { traces: [{ taskId: 'a', events }] });
  const feedback = buildGeneratedFeedback([candidate], [task('a', 'PUBLIC '.repeat(1000))])[0];
  const example = feedback.cases[0];
  assert.equal(example.promptTruncated, true);
  assert.equal(example.current.outcomes[0].predictionTruncated, true);
  assert.equal(example.currentTrace.originalEvents, 20);
  assert.equal(example.currentTrace.truncated, true);
  assert.equal(example.currentTrace.events[0].invocation, 1);
  assert.equal(example.currentTrace.events.at(-1).invocation, 20);
  assert.deepEqual(example.currentTrace.events[0].input.value.operands, [10, 4]);
  assert.equal(example.currentTrace.events[0].input.value.constraints.relation, 'public custom relation');
  assert.equal(example.currentTrace.events[0].input.omittedFields, 5);
  assert.ok(JSON.stringify(example.currentTrace).includes('arbitraryBusinessResult'));
  assert.ok(!JSON.stringify(feedback).includes('PRIVATE'));
  assert.equal(feedback.truncation.applied, true);
});

test('feedback is bounded, at most three cases have traces, and omitted data is marked', () => {
  const tasks = Array.from({ length: 8 }, (_, index) => task(`t${index}`, 'public '.repeat(2000)));
  const candidate = record('a', tasks.map(value => row(`${value.id}#1`, .5, 'prediction '.repeat(1000))), null, {
    traces: tasks.map(value => ({ taskId: value.id, events: Array.from({ length: 30 }, (_, invocation) => ({ kind: 'node', invocation, input: { custom: 'x'.repeat(10000) }, output: { custom: 'y'.repeat(10000) } })) })),
  });
  const feedback = buildGeneratedFeedback([candidate], tasks)[0];
  assert.ok(JSON.stringify(feedback).length <= 30000);
  assert.ok(feedback.cases.filter(value => value.currentTrace).length <= 3);
  assert.equal(feedback.truncation.applied, true);
  assert.equal(feedback.sample.observedTasks, 8);
  assert.ok(feedback.cases.length <= 6);
});

test('long task truncation preserves passage opening and the question at its end', () => {
  const question = 'Question: PUBLIC QUESTION AT THE END?\nAnswer:';
  const prompt = 'PUBLIC PASSAGE OPENING ' + 'middle passage '.repeat(1000) + question;
  const candidate = record('a', [row('a#1', .5)]);
  const feedback = buildGeneratedFeedback([candidate], [task('a', prompt)])[0];
  const shown = feedback.cases[0];
  assert.equal(shown.promptTruncated, true);
  assert.ok(shown.prompt.startsWith('PUBLIC PASSAGE OPENING'));
  assert.ok(shown.prompt.endsWith(question));
  assert.ok(shown.prompt.includes('[...truncated...]'));
  assert.ok(shown.prompt.endsWith(prompt.slice(-800)));
  assert.equal(shown.originalPromptLength, prompt.length);
  assert.ok(JSON.stringify(feedback).length <= 30000);
});

test('unknown tasks, duplicate case IDs and no overlap cannot masquerade as paired improvements', () => {
  const parent = record('p', [row('a#1', 1)]);
  const child = record('c', [row('b#1', 0), row('b#1', 1), row('not-public#1', 1, 'PRIVATE_OTHER_SPLIT')], 'p');
  const feedback = buildGeneratedFeedback([parent, child], [task('a'), task('b')])[1];
  assert.equal(feedback.sample.observedRuns, 1);
  assert.equal(feedback.quality.meanScore, 1);
  assert.equal(feedback.paired.status, 'unavailable');
  assert.equal(feedback.paired.meanScoreDelta, null);
  assert.equal(feedback.paired.overlapRuns, 0);
  assert.ok(!JSON.stringify(feedback).includes('PRIVATE'));
});
