import assert from 'node:assert/strict';
import test from 'node:test';
import { graph } from '@codesoul-co/ditto/runtime';
import { createExperimentRuntime } from '../dist/ditto/runtime.js';
import { GENERATION } from '../dist/protocol.js';
import { selectSearchTasks, SMALL_BATCH_POLICY } from './generated-small-batch-policy.mjs';
import { validateConfirmationSelection, validateConfirmationCache, createConfirmationCallGate } from './complete-small-batch-candidate.mjs';

const benchmark = { tasks: Array.from({ length: 200 }, (_, index) => ({ id: `drop:${index}` })), identity: { verified: true } };
const source = (protocol, ids) => ({ protocol: { id: protocol }, searchPolicy: { id: protocol }, data: { selectedExamples: ids.length, taskIds: ids } });
const result = (id, repeat = 1) => ({ caseId: `${id}#${repeat}`, valid: true, prediction: 'public fixture', score: .5,
  usageKnown: true, providerAttempts: 1, inputTokens: 2, outputTokens: 1, totalTokens: 3 });

test('confirmation preserves old64 selection and source-specific full200 order', () => {
  const oldIds = selectSearchTasks(benchmark.tasks).map(task => task.id);
  assert.deepEqual(validateConfirmationSelection(source(SMALL_BATCH_POLICY.id, oldIds), { taskIds: oldIds }, benchmark), oldIds);
  const reversed = benchmark.tasks.map(task => task.id).reverse();
  for (const protocol of ['generated-drop-expanded-v2', 'frozen-candidate-full200-expansion-v1']) {
    assert.deepEqual(validateConfirmationSelection(source(protocol, reversed), { taskIds: reversed }, benchmark), reversed);
  }
  const wrong = [...reversed]; wrong[0] = 'outside-full-split';
  assert.throws(() => validateConfirmationSelection(source('generated-drop-expanded-v2', wrong), { taskIds: wrong }, benchmark), /full 200-task membership/);
  assert.throws(() => validateConfirmationSelection(source('unknown', reversed), { taskIds: reversed }, benchmark), /requires an expanded search/);
  assert.throws(() => validateConfirmationSelection(source('generated-drop-expanded-v2', reversed), { taskIds: reversed }, { ...benchmark, identity: { verified: false } }), /pinned full 200/);
});

test('confirmation keeps exact paid first-pass records and resumes only the same three repeats', () => {
  for (const count of [64, 200]) {
    const ids = benchmark.tasks.slice(0, count).map(task => task.id), first = ids.map(id => result(id));
    first[0].providerAttempts = 3;
    first[0].previousResults = [{ valid: false, error: 'Historical paid retry' }];
    const child = ids.flatMap(id => [result(id, 2), result(id, 3)]);
    const cache = validateConfirmationCache(ids, first, [...first, ...child]);
    assert.equal(cache.size, count * 3);
    assert.equal(cache.get(ids[0] + '#1'), first[0]);
    assert.equal(cache.get(ids[0] + '#1').providerAttempts, 3);
    const changed = { ...first[0], providerAttempts: 1 };
    assert.throws(() => validateConfirmationCache(ids, first, [changed]), /preserved first-pass result/);
    assert.throws(() => validateConfirmationCache(ids, first, [result(ids[0], 4)]), /outside the frozen/);
    assert.throws(() => validateConfirmationCache(ids, first.slice(1)), /requires all/);
    assert.throws(() => validateConfirmationCache(ids, first, [{ ...result(ids[0], 2), prediction: 3 }]), /Malformed reusable/);
  }
});

test('provider reservations include retries already charged plus other unsettled invocations', () => {
  let settled = 0;
  const usage = { providerAttempts: 0 };
  const gate = createConfirmationCallGate(3, { usage, getSettledRecordCount: () => settled });
  gate.beforeNode(); gate.beforeNode();
  assert.equal(gate.reserved, 0, 'node hooks do not count internal provider calls twice');
  gate.beforeProviderCall(); gate.beforeProviderCall();
  assert.equal(gate.committed, 2);
  usage.providerAttempts = 2; settled = 1; // first invocation retried; second is still in flight
  assert.equal(gate.committed, 3);
  assert.throws(() => gate.beforeProviderCall(), /CONFIRMATION_BUDGET_EXHAUSTED/);
  assert.equal(gate.reserved, 2);
  assert.throws(() => gate.beforeNode(), /CONFIRMATION_STOPPED/);
});

test('confirmation provider gate stops native TRAJECTORY internal calls without any API', async () => {
  const gate = createConfirmationCallGate(1);
  let invoked = 0;
  const experiment = createExperimentRuntime({ baseUrl: 'https://offline.invalid', model: 'fixture', apiKey: 'unused', concurrency: 1, timeoutMs: 1000 }, {
    beforeProviderCall: () => gate.beforeProviderCall(),
    provider: { async invoke() { invoked++; return { message: { role: 'assistant', content: 'public fixture' }, finishReason: 'stop' }; } },
  });
  try {
    const plan = graph('confirmation-budget').node('trajectory', 'INFER.REASONING.TRAJECTORY', [], () => ({
      messages: [{ role: 'user', content: 'Public fixture' }], model: { provider: 'deepseek', model: 'fixture' }, generation: GENERATION,
      strategy: { name: 'cot', options: { rounds: 3 } }, constraints: { maxSteps: Number.MAX_SAFE_INTEGER },
    }));
    const output = await experiment.runtime.run(plan, {});
    assert.equal(invoked, 1);
    assert.equal(gate.reserved, 1);
    assert.match(JSON.stringify(output), /CONFIRMATION_BUDGET_EXHAUSTED/);
  } finally { await experiment.close(); }
});
