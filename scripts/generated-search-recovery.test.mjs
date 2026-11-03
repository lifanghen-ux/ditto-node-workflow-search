import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadGeneratedResume } from './generated-search-recovery.mjs';

const expected = {
  representation: 'B', model: 'deepseek-flash', endpoint: 'https://api.deepseek.com',
  generation: { temperature: 0, maxTokens: 393216 }, repeats: 5,
  dataIdentity: { protocol: 'fixed-fixture', rawSha256: 'fixture-identity', count: 200 },
};
const usage = { providerAttempts: 7, inputTokens: 100, outputTokens: 80, totalTokens: 180, unknownUsageAttempts: 1 };
const proposal = { referenceCandidateId: null, rationale: 'Fixture candidate', definition: { schemaVersion: 1, id: 'fixture' } };
const completed = (id, prediction = 'public answer') => ({
  caseId: id, valid: true, prediction, score: 1, expected: 'FIXTURE_PRIVATE_LABEL', normalizedExpected: 'FIXTURE_PRIVATE_LABEL',
  inputTokens: 3, outputTokens: 4, totalTokens: 7, usageKnown: true,
});
const failed = id => ({
  caseId: id, valid: false, prediction: '', score: 0, error: 'FIXTURE_PRIVATE_ERROR',
  failureKind: 'provider', inputTokens: 5, outputTokens: 1, totalTokens: 6, usageKnown: false,
});

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'generated-resume-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const write = async (file, value) => {
    const path = join(directory, file);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value));
  };
  await write('manifest.json', {
    schemaVersion: 2, status: 'failed', dataset: 'drop', split: 'validate', ...expected,
    data: { identity: expected.dataIdentity, selectedExamples: 200 },
  });
  await write('candidates/generated-002.json', { representation: expected.representation, proposal: options.proposal ?? proposal });
  await write('history.json', [{ id: 'generated-001', status: 'valid' }, { id: 'generated-002', status: 'invalid' }]);
  await write('optimizer-usage.json', usage);
  await write('evaluations/generated-002/live-samples.jsonl', (options.rows ?? [completed('drop:a#1'), failed('drop:b#1')]).map(row => JSON.stringify(row)).join('\n') + '\n');
  return { directory, write };
}

test('resume preserves the actual proposal, prior evaluator records, history and original optimizer cost', async t => {
  const { directory } = await fixture(t);
  const restored = await loadGeneratedResume(directory, 'generated-002', expected);
  assert.deepEqual(restored.proposal, proposal);
  assert.deepEqual(restored.optimizerUsage, usage);
  assert.deepEqual(restored.history.map(row => row.id), ['generated-001']);
  assert.equal(restored.priorCases.length, 2);
  assert.equal(restored.priorCases[0].expected, 'FIXTURE_PRIVATE_LABEL');
  assert.equal(restored.priorCases[1].valid, false);
  assert.equal(restored.priorCases[1].totalTokens, 6);
  assert.equal(restored.origin.reusableCases, 1);
  assert.equal(restored.origin.retryCases, 1);
  // Origin is safe to log; evaluator records are deliberately not part of it.
  assert.ok(!JSON.stringify(restored.origin).includes('PRIVATE'));
});

test('each frozen setting must match, including full data identity and repeats', async t => {
  const { directory } = await fixture(t);
  const replacements = {
    representation: 'A', model: 'another-model', endpoint: 'https://other.example',
    generation: { temperature: 0, maxTokens: 1 }, repeats: 3,
    dataIdentity: { ...expected.dataIdentity, rawSha256: 'different' },
  };
  for (const [key, value] of Object.entries(replacements))
    await assert.rejects(loadGeneratedResume(directory, 'generated-002', { ...expected, [key]: value }), new RegExp(`frozen setting differs: ${key}`));
});

test('duplicate case IDs use the latest saved row without turning failures into completed work', async t => {
  const rows = [failed('drop:a#1'), completed('drop:b#1'), completed('drop:a#1', 'latest'), failed('drop:b#1')];
  const { directory } = await fixture(t, { rows });
  const restored = await loadGeneratedResume(directory, 'generated-002', expected);
  assert.equal(restored.priorCases.length, 2);
  assert.equal(restored.priorCases.find(row => row.caseId === 'drop:a#1').prediction, 'latest');
  assert.equal(restored.priorCases.find(row => row.caseId === 'drop:b#1').valid, false);
  assert.equal(restored.origin.caseRecordsRead, 4);
  assert.equal(restored.origin.reusableCases, 1);
});

test('truncated final records and corrupt interior records are explicitly rejected without leaking content', async t => {
  const { directory, write } = await fixture(t);
  await write('evaluations/generated-002/live-samples.jsonl', JSON.stringify(completed('drop:a#1')) + '\n{"caseId":"FIXTURE_PRIVATE');
  await assert.rejects(loadGeneratedResume(directory, 'generated-002', expected), error => {
    assert.match(error.message, /line 2.*truncated final record/);
    assert.ok(!error.message.includes('FIXTURE_PRIVATE'));
    return true;
  });
  await write('evaluations/generated-002/live-samples.jsonl', JSON.stringify(completed('drop:a#1')) + '\nBROKEN_PRIVATE_LINE\n' + JSON.stringify(completed('drop:b#1')) + '\n');
  await assert.rejects(loadGeneratedResume(directory, 'generated-002', expected), /invalid JSON.*line 2/);
});

test('recovery rejects test runs, invalid artifact IDs, missing references and unknown proposal fields', async t => {
  const { directory, write } = await fixture(t);
  await assert.rejects(loadGeneratedResume(directory, '../generated-002', expected), /simple artifact ID/);
  await write('candidates/generated-002.json', { representation: 'B', proposal: { ...proposal, referenceCandidateId: 'missing' } });
  await assert.rejects(loadGeneratedResume(directory, 'generated-002', expected), /reference is missing/);
  await write('candidates/generated-002.json', { representation: 'B', proposal: { ...proposal, expected: 'PRIVATE' } });
  await assert.rejects(loadGeneratedResume(directory, 'generated-002', expected), /invalid public fields/);
  await write('manifest.json', { ...expected, dataset: 'drop', split: 'test' });
  await assert.rejects(loadGeneratedResume(directory, 'generated-002', expected), /DROP validation search/);
});

test('A source restores under the same settings without compiling or invoking it', async t => {
  const aProposal = { referenceCandidateId: null, rationale: 'A fixture', source: 'export default function createWorkflow(api) { throw new Error("must not execute"); }' };
  const { directory, write } = await fixture(t);
  await write('manifest.json', { ...expected, representation: 'A', dataset: 'drop', split: 'validate', data: { identity: expected.dataIdentity } });
  await write('candidates/generated-002.json', { representation: 'A', proposal: aProposal });
  const restored = await loadGeneratedResume(directory, 'generated-002', { ...expected, representation: 'A' });
  assert.deepEqual(restored.proposal, aProposal);
});
