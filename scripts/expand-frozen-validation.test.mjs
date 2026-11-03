import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateExpansionCache, expansionScoreGroups, readExpansionCases } from './expand-frozen-validation.mjs';

const row = (id, score = 1, extra = {}) => ({ caseId: id + '#1', prediction: 'public answer', valid: true, score,
  expected: 'LOCAL_FIXTURE_PRIVATE_LABEL', totalTokens: 4, ...extra });

test('expansion preserves original records and reuses later successful child rows without promoting failed placeholders', () => {
  const original = row('a', .5), failed = row('b', 0, { valid: false, error: 'fixture failure', totalTokens: 9 });
  const cases = validateExpansionCache(['a', 'b', 'c'], ['a'], [original], [original, row('b', .8), failed, row('c')]);
  assert.equal(cases.get('a#1'), original);
  assert.equal(cases.get('b#1'), failed, 'latest failed result retains its paid usage for evaluator recovery');
  assert.equal(cases.get('b#1').totalTokens, 9);
  assert.equal(cases.get('b#1').valid, false);
});

test('unmatched IDs, changed original rows, other repeats and incomplete source caches are rejected', () => {
  const original = row('a');
  assert.throws(() => validateExpansionCache(['a', 'b'], ['a'], [original], [row('x')]), /unknown task or repeat/);
  assert.throws(() => validateExpansionCache(['a', 'b'], ['a'], [original], [{ ...row('b'), caseId: 'b#2' }]), /unknown task or repeat/);
  assert.throws(() => validateExpansionCache(['a', 'b'], ['a'], [original], [{ ...original, prediction: 'changed' }]), /unchanged original first-pass record/);
  assert.throws(() => validateExpansionCache(['a', 'b'], ['a'], []), /complete first-pass result/);
  assert.throws(() => validateExpansionCache(['a', 'b'], ['a'], [row('a', 0, { valid: false })]), /complete first-pass result/);
  assert.throws(() => validateExpansionCache(['a', 'a'], ['a'], [original]), /unique/);
});

test('grouped scores distinguish original selection, new tasks and complete full validation without exposing labels', () => {
  const cases = new Map([['a#1', row('a', 1)], ['b#1', row('b', .5)], ['c#1', row('c', 0)]]);
  const report = expansionScoreGroups(['a', 'b', 'c'], ['a'], cases);
  assert.equal(report.original64.score, 1);
  assert.equal(report.additional136.score, .25);
  assert.equal(report.full200.score, .5);
  assert.equal(report.full200.complete, true);
  assert.ok(!JSON.stringify(report).includes('PRIVATE_LABEL'));
  cases.delete('c#1');
  const partial = expansionScoreGroups(['a', 'b', 'c'], ['a'], cases);
  assert.equal(partial.full200.score, null, 'a partial average is never presented as a full result');
  assert.equal(partial.full200.observedValidMean, .75);
  assert.equal(partial.full200.missingRuns, 1);
});

test('case JSONL parsing rejects corrupt middle and truncated final records explicitly', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ditto-expand-cache-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'cases.jsonl');
  await writeFile(file, JSON.stringify(row('a')) + '\n');
  assert.equal((await readExpansionCases(file)).length, 1);
  await writeFile(file, JSON.stringify(row('a')) + '\n{"truncated');
  await assert.rejects(readExpansionCases(file), /Malformed expansion JSONL line 2/);
  await writeFile(file, JSON.stringify(row('a')) + '\nBAD_LINE\n' + JSON.stringify(row('b')) + '\n');
  await assert.rejects(readExpansionCases(file), /Malformed expansion JSONL line 2/);
  assert.deepEqual(await readExpansionCases(join(directory, 'missing'), true), []);
});
