import assert from 'node:assert/strict';
import test from 'node:test';
import { createDitto, graph, graphStep, loop } from '@codesoul-co/ditto/runtime';
import { Sandbox } from '@codesoul-co/ditto/runtime/sandbox';
import { createContextWorker } from '@codesoul-co/ditto/worker/context';
import { createInferWorker } from '@codesoul-co/ditto/worker/infer';
import { createInteractionWorker } from '@codesoul-co/ditto/worker/interaction';
import { compileEvidenceDefinition, validateEvidenceDefinition, EVIDENCE_DEFINITION_GUIDE, EVIDENCE_DEFINITION_GUIDE_VERSION } from './generated-workflow-b.mjs';

const ref = (...path) => ({ ref: path });
const fixture = () => ({ schemaVersion: 1, id: 'fixture',
  nodes: [
    { id: 'loaded', type: 'CONTEXT.LOAD', graphId: 'prepare', dependencies: [], inputBindings: { sources: [{ role: 'user', content: ref('task', 'prompt') }] } },
    { id: 'calculated', type: 'INTERACTION.ACT.TOOL', graphId: 'prepare', dependencies: ['loaded'], inputBindings: { call: { id: { concat: [ref('task', 'id'), ':arithmetic'] }, name: 'arithmetic', arguments: { expression: '1+1' } } } },
    { id: 'observed', type: 'INTERACTION.OBSERVE', graphId: 'prepare', dependencies: ['calculated'], inputBindings: { result: ref('nodes', 'calculated') } },
    { id: 'result', type: 'INFER.REASONING.SAMPLE', graphId: 'solve', dependencies: [], inputBindings: { messages: [{ role: 'user', content: { concat: [ref('task', 'prompt'), '\n', { json: ref('nodes', 'observed', 'structuredContent') }] } }] } },
  ],
  graphs: [{ id: 'prepare', nodeIds: ['loaded', 'calculated', 'observed'] }, { id: 'solve', nodeIds: ['result'] }],
  loop: { entryGraphId: 'prepare', transitions: { prepare: { kind: 'next', graphId: 'solve' }, solve: { kind: 'end' } } },
  output: { answer: { get: { value: { parse: ref('nodes', 'result', 'message', 'content') }, path: ['answer'] } } },
});
const unwrap = result => {
  if (result?.status !== 'success' || !result.output) throw new Error('fixture node failed');
  return result.output;
};
async function harness(operation) {
  const calls = [];
  const sandbox = new Sandbox(process.cwd(), { tools: ['arithmetic', 'locate_public_text'] });
  const runtime = createDitto({ sandbox: sandbox.policy, workers: [createContextWorker(), createInteractionWorker({ tools: [{
    name: 'arithmetic', inputSchema: { type: 'object' }, effects: ['read'], validate() {},
    async execute(input) { return { status: 'success', content: 'computed', structuredContent: { expression: input.expression, result: 2 } }; },
  }] }), createInferWorker({ providers: { fixture: { async invoke(input) {
    calls.push(input);
    return { message: { role: 'assistant', content: JSON.stringify({ answer: 'two', done: calls.length >= 2 }) }, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' };
  } } } })] });
  const capabilities = { graph, loop, graphStep, unwrap, model: { provider: 'fixture', model: 'fixture' }, generation: { temperature: 0, maxTokens: 393216 } };
  try { await operation(runtime, capabilities, calls); } finally { await runtime.close(); }
}

test('B uses native Graph/Loop, explicit prior-Graph tool evidence and fixed model settings', async () => {
  await harness(async (runtime, capabilities, calls) => {
    const input = { id: 'public-fixture', dataset: 'drop', prompt: 'PUBLIC PROBLEM', outputInstruction: '' };
    for (const key of ['expected', 'reference', 'metadata']) Object.defineProperty(input, key, { get() { throw new Error('Private task field accessed'); } });
    const definition = fixture();
    const compiled = compileEvidenceDefinition(definition, capabilities);
    definition.nodes[3].inputBindings.messages[0].content = 'MUTATED AFTER COMPILE';
    const result = await runtime.loop(compiled, input);
    assert.equal(result.answer, 'two');
    assert.deepEqual(result.executedGraphIds, ['prepare', 'solve']);
    assert.deepEqual(result.executedNodeIds, ['loaded', 'calculated', 'observed', 'result']);
    assert.deepEqual(result.outputs.calculated.structuredContent, { expression: '1+1', result: 2 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].messages[0].content, 'PUBLIC PROBLEM\n{"expression":"1+1","result":2}');
    assert.equal(calls[0].generation.maxTokens, 393216);
    assert.equal(calls[0].model.provider, 'fixture');
  });
});

test('B repeat reads the latest normalized output, then switch takes the satisfied branch', async () => {
  await harness(async (runtime, capabilities, calls) => {
    const definition = fixture();
    definition.loop.transitions.solve = { kind: 'repeat', graphId: 'solve', maxVisits: 4,
      until: { operator: 'truthy', left: { get: { value: { parse: ref('nodes', 'result', 'message', 'content') }, path: ['done'] } } } };
    const result = await runtime.loop(compileEvidenceDefinition(definition, capabilities), { id: 'p', dataset: 'drop', prompt: 'p', outputInstruction: '' });
    assert.equal(calls.length, 2);
    assert.deepEqual(result.executedGraphIds, ['prepare', 'solve', 'solve']);
    const switched = fixture();
    switched.loop.transitions.prepare = { kind: 'switch', cases: [{ when: { operator: 'equals', left: ref('nodes', 'observed', 'structuredContent', 'result'), right: 2 }, graphId: 'solve' }] };
    const switchedResult = await runtime.loop(compileEvidenceDefinition(switched, capabilities), { id: 'q', dataset: 'drop', prompt: 'q', outputInstruction: '' });
    assert.equal(switchedResult.answer, 'two');
    assert.deepEqual(switchedResult.executedGraphIds, ['prepare', 'solve']);
  });
});

test('B rejects unbound local data, unavailable tools, prototype paths and model overrides', () => {
  const unbound = fixture(); unbound.nodes[2].dependencies = [];
  assert.throws(() => validateEvidenceDefinition(unbound), /requires a dependency/);
  const tool = fixture(); tool.nodes[1].inputBindings.call.name = 'private_judge';
  assert.throws(() => validateEvidenceDefinition(tool), /unavailable tool/);
  const unsafe = fixture(); unsafe.output.answer = ref('nodes', 'result', '__proto__');
  assert.throws(() => validateEvidenceDefinition(unsafe), /unsafe path/);
  const override = fixture(); override.nodes[3].inputBindings.generation = { temperature: 1 };
  assert.throws(() => validateEvidenceDefinition(override), /unsupported field generation/);
  const label = fixture(); label.nodes[0].inputBindings.sources[0].content = ref('task', 'reference');
  assert.throws(() => validateEvidenceDefinition(label), /nonpublic task fields/);
});

test('B permits parallel siblings without forcing a model role template', async () => {
  await harness(async (runtime, capabilities, calls) => {
    const definition = fixture();
    definition.nodes.push({ id: 'independent', type: 'INFER.REASONING.SAMPLE', graphId: 'solve', dependencies: [],
      inputBindings: { messages: [{ role: 'user', content: 'Independently chosen generated instruction' }] } });
    definition.graphs[1].nodeIds.push('independent');
    definition.output.details = { peer: { parse: ref('nodes', 'independent', 'message', 'content') } };
    const result = await runtime.loop(compileEvidenceDefinition(definition, capabilities), { id: 'p', dataset: 'drop', prompt: 'p', outputInstruction: '' });
    assert.equal(calls.length, 2);
    assert.equal(result.details.peer.answer, 'two');
    assert.equal(definition.nodes[4].dependencies.length, 0);
  });
});

test('B coalesce handles not-yet-executed data and maxVisits ends a nonconverging repeat', async () => {
  await harness(async (runtime, capabilities, calls) => {
    const definition = fixture();
    definition.nodes[3].inputBindings.messages[0].content = { coalesce: [ref('nodes', 'result', 'message', 'content'), 'First visit'] };
    // A self-reference without local dependency is intentionally rejected; loop
    // state must cross an explicit Graph boundary to avoid scheduler ambiguity.
    assert.throws(() => validateEvidenceDefinition(definition), /requires a dependency/);
    definition.nodes[3].inputBindings.messages[0].content = { coalesce: [ref('prior', 'result', 'message', 'content'), 'Fallback'] };
    definition.loop.transitions.solve = { kind: 'repeat', graphId: 'solve', maxVisits: 2, until: { operator: 'truthy', left: false } };
    const result = await runtime.loop(compileEvidenceDefinition(definition, capabilities), { id: 'p', dataset: 'drop', prompt: 'p', outputInstruction: '' });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].messages[0].content, 'Fallback');
    assert.equal(calls[1].messages[0].content, '{"answer":"two","done":false}');
    assert.equal(result.executedGraphIds.length, 3);
  });
});

test('B guide describes the executable schema without a prescribed full workflow', () => {
  assert.match(EVIDENCE_DEFINITION_GUIDE, /inputBindings/);
  assert.match(EVIDENCE_DEFINITION_GUIDE, /coalesce/);
  assert.match(EVIDENCE_DEFINITION_GUIDE, /No node, role, Graph structure or tool use is mandatory/);
  const unknown = fixture(); unknown.loop.transitions.prepare.graphId = 'unknown';
  assert.throws(() => validateEvidenceDefinition(unknown), /unknown transition target/);
});

test('B statically rejects known invalid Context sources while accepting native source forms', () => {
  for (const source of ['plain text', null, [], { content: 'missing discriminator' }, { id: '', content: 'x' }, { role: 'invalid', content: 'x' }, { role: 'user' }, { id: 'item' }, { uri: '' }, { id: 'item', content: 'x', metadata: 'not an object' }]) {
    const definition = fixture();
    definition.nodes[0].inputBindings.sources = [source];
    assert.throws(() => validateEvidenceDefinition(definition), /sources\[0\]/);
  }
  const rawPrompt = fixture(); rawPrompt.nodes[0].inputBindings.sources = [ref('task', 'prompt')];
  assert.throws(() => validateEvidenceDefinition(rawPrompt), /must evaluate to an object/);
  const literalText = fixture(); literalText.nodes[0].inputBindings.sources = [{ literal: 'bare text' }];
  assert.throws(() => validateEvidenceDefinition(literalText), /must evaluate to an object/);
  for (const source of [
    { role: 'user', content: ref('task', 'prompt') },
    { id: 'inline', content: { any: ['JSON', null, 2] }, metadata: { public: true } },
    { id: { concat: [ref('task', 'id'), ':context'] }, content: ref('task', 'prompt') },
    { id: 'from-source', content: 'x', source: { uri: 'urn:public:source' } },
    { uri: 'urn:public:reference', mediaType: 'text/plain', digest: 'public-digest' },
  ]) {
    const definition = fixture(); definition.nodes[0].inputBindings.sources = [source];
    assert.doesNotThrow(() => validateEvidenceDefinition(definition));
  }
});

test('B catches the absent OBSERVE.content API field and accepts an observation Message source', async () => {
  const direct = fixture();
  direct.nodes[3].inputBindings.messages[0].content = ref('nodes', 'observed', 'content');
  assert.throws(() => validateEvidenceDefinition(direct), /OBSERVE has no top-level content/);
  const computed = fixture();
  computed.nodes[3].inputBindings.messages[0].content = { get: { value: ref('nodes', 'observed'), path: ['content'] } };
  assert.throws(() => validateEvidenceDefinition(computed), /OBSERVE has no top-level content/);
  await harness(async (runtime, capabilities) => {
    const definition = fixture();
    definition.nodes.push({ id: 'reloaded', type: 'CONTEXT.LOAD', graphId: 'prepare', dependencies: ['observed'], inputBindings: { sources: [ref('nodes', 'observed', 'message')] } });
    definition.graphs[0].nodeIds.push('reloaded');
    const result = await runtime.loop(compileEvidenceDefinition(definition, capabilities), { id: 'public', dataset: 'drop', prompt: 'public task', outputInstruction: '' });
    assert.equal(result.outputs.reloaded.items.length, 1);
    assert.ok(result.outputs.reloaded.items[0].content);
  });
  assert.match(EVIDENCE_DEFINITION_GUIDE_VERSION, /v4/);
  assert.match(EVIDENCE_DEFINITION_GUIDE, /OBSERVE has NO top-level content/);
});

test('B traces every actual invocation and raw output independently of returned details', async () => {
  await harness(async (runtime, capabilities) => {
    const definition = fixture(), trace = [];
    definition.loop.transitions.solve = { kind: 'repeat', graphId: 'solve', maxVisits: 2, until: { operator: 'truthy', left: false } };
    const result = await runtime.loop(compileEvidenceDefinition(definition, capabilities, { trace }), { id: 'trace-task', dataset: 'drop', prompt: 'public', outputInstruction: '' });
    assert.equal(trace.length, 5);
    assert.ok(trace.every(event => event.kind === 'node' && event.taskId === 'trace-task' && event.input && Object.hasOwn(event, 'output') && !event.error));
    const samples = trace.filter(event => event.nodeId === 'result');
    assert.deepEqual(samples.map(event => event.invocation), [2, 3]);
    assert.equal(samples[0].input.generation.maxTokens, 393216);
    assert.equal(samples[0].output.status, 'success');
    assert.equal(JSON.parse(samples[0].output.output.message.content).answer, 'two');
    assert.equal(trace.find(event => event.nodeId === 'observed').output.message.role, 'tool');
    result.outputs.result.message.content = 'changed after execution';
    assert.equal(JSON.parse(samples[1].output.output.message.content).answer, 'two');
  });
});

test('B beforeNode gate stops execution before a paid model call and preserves its trace error', async () => {
  await harness(async (runtime, capabilities, calls) => {
    const trace = [], gates = [];
    const gated = { ...capabilities, beforeNode(event) { gates.push(event); if (event.type === 'INFER.REASONING.SAMPLE') throw new Error('session-budget-exhausted'); } };
    await assert.rejects(() => runtime.loop(compileEvidenceDefinition(fixture(), gated, { trace }), { id: 'p', dataset: 'drop', prompt: 'p', outputInstruction: '' }), /session-budget-exhausted/);
    assert.equal(calls.length, 0);
    const sample = trace.find(event => event.nodeId === 'result');
    assert.match(sample.error, /session-budget-exhausted/);
    assert.ok(sample.input.messages[0].content.includes('p'));
    assert.ok(!Object.hasOwn(sample, 'output'));
    assert.equal(gates.at(-1).graphId, 'solve');
    assert.equal(gates.at(-1).invocation, 2);
  });
});

test('B validates dynamic inputs for all four Workers before invoking the invalid operation', async () => {
  const cases = [
    { nodeId: 'loaded', prompt: '"bare source"', edit: spec => { spec.nodes[0].inputBindings.sources = [{ parse: ref('task', 'prompt') }]; }, pattern: /sources\[0\].*object/ },
    { nodeId: 'calculated', prompt: '[]', edit: spec => { spec.nodes[1].inputBindings.call.arguments = { parse: ref('task', 'prompt') }; }, pattern: /arguments.*object/ },
    { nodeId: 'observed', prompt: '{"status":"success","output":{}}', edit: spec => { spec.nodes[2].inputBindings.result = { parse: ref('task', 'prompt') }; }, pattern: /callId.*DIRECT tool result/ },
    { nodeId: 'result', prompt: '{"payload":"not message text"}', edit: spec => { spec.nodes[3].inputBindings.messages[0].content = { parse: ref('task', 'prompt') }; }, pattern: /content.*string or MessagePart/ },
  ];
  for (const item of cases) await harness(async (runtime, capabilities, calls) => {
    const definition = fixture(), trace = [];
    item.edit(definition);
    await assert.rejects(() => runtime.loop(compileEvidenceDefinition(definition, capabilities, { trace }), { id: 'dynamic', dataset: 'drop', prompt: item.prompt, outputInstruction: '' }), item.pattern);
    assert.equal(calls.length, 0);
    const event = trace.find(entry => entry.nodeId === item.nodeId);
    assert.match(event.error, item.pattern);
    assert.ok(event.input, 'record the attempted resolved input as well as its failure');
    assert.ok(!Object.hasOwn(event, 'output'));
  });
});

test('B accumulated state updates are simultaneous, repeat conditions are numeric, and tasks start fresh', async () => {
  await harness(async (runtime, capabilities, calls) => {
    const definition = fixture();
    definition.loop.state = { history: [], previousHistory: [] };
    definition.loop.stateUpdates = { solve: {
      history: { append: [ref('state', 'history'), ref('nodes', 'result', 'message', 'content')] },
      previousHistory: ref('state', 'history'),
    } };
    definition.loop.transitions.solve = { kind: 'repeat', graphId: 'solve', maxVisits: 5,
      until: { operator: 'gte', left: ref('state', 'history', 'length'), right: 2 } };
    definition.output.details = { history: ref('state', 'history'), previous: ref('state', 'previousHistory'),
      stringLength: { get: { value: 'abc', path: ['length'] } }, character: { get: { value: 'abc', path: [1] } } };
    const compiled = compileEvidenceDefinition(definition, capabilities);
    for (const id of ['one', 'two']) {
      const result = await runtime.loop(compiled, { id, dataset: 'drop', prompt: 'p', outputInstruction: '' });
      assert.equal(result.state.history.length, 2);
      assert.equal(result.state.previousHistory.length, 1);
      assert.equal(result.details.history.length, 2);
      assert.equal(result.details.previous.length, 1);
      assert.equal(result.details.stringLength, 3);
      assert.equal(result.details.character, 'b');
    }
    assert.equal(calls.length, 4);
  });
});

test('B numeric comparison operators avoid string coercion and undeclared state is rejected', async () => {
  for (const [operator, target, expectedCalls] of [['gt', 1, 2], ['gte', 2, 2], ['lt', 2, 1], ['lte', 1, 1]]) await harness(async (runtime, capabilities, calls) => {
    const definition = fixture();
    definition.loop.state = { history: [] };
    definition.loop.stateUpdates = { solve: { history: { append: [ref('state', 'history'), 'event'] } } };
    definition.loop.transitions.solve = { kind: 'repeat', graphId: 'solve', maxVisits: 4, until: { operator, left: ref('state', 'history', 'length'), right: target } };
    await runtime.loop(compileEvidenceDefinition(definition, capabilities), { id: operator, dataset: 'drop', prompt: 'p', outputInstruction: '' });
    assert.equal(calls.length, expectedCalls);
  });
  const coerced = fixture(); coerced.loop.transitions.prepare = { kind: 'switch', cases: [{ when: { operator: 'gt', left: '2', right: 1 }, graphId: 'solve' }] };
  assert.throws(() => validateEvidenceDefinition(coerced), /without string conversion/);
  const unknown = fixture(); unknown.output.answer = ref('state', 'undeclared');
  assert.throws(() => validateEvidenceDefinition(unknown), /undeclared state key/);
});

test('B host tool allowlist is extensible and known malformed calls/messages fail statically', () => {
  const custom = fixture(); custom.nodes[1].inputBindings.call.name = 'custom_public_tool';
  assert.throws(() => validateEvidenceDefinition(custom), /unavailable tool/);
  assert.doesNotThrow(() => validateEvidenceDefinition(custom, { allowedTools: ['custom_public_tool'] }));
  const text = fixture(); text.nodes[1].inputBindings.call = { id: 'text-check', name: 'text_contains', arguments: { text: ref('task', 'prompt'), fragment: 'public', caseSensitive: true } };
  assert.doesNotThrow(() => validateEvidenceDefinition(text, { allowedTools: ['text_contains'] }));
  text.nodes[1].inputBindings.call.arguments.caseSensitive = 'yes';
  assert.throws(() => validateEvidenceDefinition(text, { allowedTools: ['text_contains'] }), /must evaluate to a boolean/);
  const invalidTool = fixture(); invalidTool.nodes[1].inputBindings.call.arguments = {};
  assert.throws(() => validateEvidenceDefinition(invalidTool), /expression is required/);
  for (const content of [null, 2, true, { unencoded: 'object' }]) {
    const invalidMessage = fixture(); invalidMessage.nodes[3].inputBindings.messages[0].content = content;
    assert.throws(() => validateEvidenceDefinition(invalidMessage), /content must evaluate to a string or MessagePart/);
  }
});

const inferFixture = () => ({
  schemaVersion: 1, id: 'native-infer',
  nodes: [
    { id: 'sample', type: 'INFER.REASONING.SAMPLE', graphId: 'reason', dependencies: [], inputBindings: {
      messages: [{ role: 'user', content: ref('task', 'prompt') }],
    } },
    { id: 'trajectory', type: 'INFER.REASONING.TRAJECTORY', graphId: 'reason', dependencies: ['sample'], inputBindings: {
      messages: [ref('nodes', 'sample', 'message')], objective: ref('task', 'prompt'),
      context: [{ content: ref('task', 'prompt') }], memory: [{ id: 'public-memory', content: 'Explicit public data' }],
      strategy: { name: 'cot', options: { rounds: 2 } },
    } },
    { id: 'deliberate', type: 'INFER.REASONING.DELIBERATE', graphId: 'reason', dependencies: ['sample', 'trajectory'], inputBindings: {
      messages: [{ role: 'user', content: ref('task', 'prompt') }], mode: 'select', selectCount: 1,
      candidates: [
        { id: 'sample', result: ref('nodes', 'sample', 'message') },
        { id: 'trajectory', result: ref('nodes', 'trajectory', 'result'), trajectory: ref('nodes', 'trajectory', 'steps') },
      ],
    } },
    { id: 'reflect', type: 'INFER.REASONING.REFLECT', graphId: 'reason', dependencies: ['deliberate'], inputBindings: {
      target: { result: ref('nodes', 'deliberate', 'result') }, mode: 'revise',
      messages: [{ role: 'user', content: ref('task', 'prompt') }],
      criteria: [{ id: 'requested-format', description: ref('task', 'outputInstruction'), weight: 1 }],
    } },
  ],
  graphs: [{ id: 'reason', nodeIds: ['sample', 'trajectory', 'deliberate', 'reflect'] }],
  loop: { entryGraphId: 'reason', transitions: { reason: { kind: 'repeat', graphId: 'reason', maxVisits: 3,
    until: { operator: 'truthy', left: ref('nodes', 'reflect', 'assessment', 'passed') } } },
    state: { revisions: [] }, stateUpdates: { reason: { revisions: { append: [ref('state', 'revisions'), ref('nodes', 'reflect', 'revisedResult')] } } } },
  output: { answer: ref('nodes', 'reflect', 'revisedResult', 'content'), details: ref('state', 'revisions') },
});
const publicTask = { id: 'native-public', dataset: 'drop', prompt: 'A public task', outputInstruction: 'Return a concise answer' };

async function nativeInferHarness(operation, respond) {
  const calls = [], counts = new Map();
  const sandbox = new Sandbox(process.cwd());
  const runtime = createDitto({ sandbox: sandbox.policy, workers: [createInferWorker({ providers: { fixture: { async invoke(input) {
    calls.push(input);
    const type = input.metadata?.nodeType, count = (counts.get(type) ?? 0) + 1;
    counts.set(type, count);
    let content;
    if (respond) content = await respond(input, count);
    else if (type === 'INFER.REASONING.SAMPLE') content = 'sample-result';
    else if (type === 'INFER.REASONING.TRAJECTORY') content = `path-${count}`;
    else if (type === 'INFER.REASONING.DELIBERATE') content = JSON.stringify({ result: { role: 'assistant', content: 'discard-this-selected-rewrite' }, selectedCandidateIds: ['trajectory'] });
    else if (type === 'INFER.REASONING.REFLECT') {
      const target = JSON.parse(input.messages.at(-1).content).target;
      content = JSON.stringify({ assessment: { summary: 'Public fixture assessment', passed: count >= 2 }, issues: [],
        revisedResult: { role: 'assistant', content: `${target.result.content}:revised-${count}` } });
    } else throw new Error(`Missing actual operation metadata: ${type}`);
    return { message: { role: 'assistant', content }, usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 }, finishReason: 'stop' };
  } } } })] });
  const capabilities = { graph, loop, graphStep, unwrap, model: { provider: 'fixture', model: 'fixture' }, generation: { temperature: 0, maxTokens: 393216 } };
  try { await operation(runtime, capabilities, calls); } finally { await runtime.close(); }
}

test('B dispatches all four real Infer operations, binds native outputs and repeats on reflection state', async () => {
  await nativeInferHarness(async (runtime, capabilities, calls) => {
    const definition = inferFixture(), trace = [], admitted = [];
    const compiled = compileEvidenceDefinition(definition, { ...capabilities, beforeNode(event) { admitted.push(event); } }, { trace });
    const result = await runtime.loop(compiled, publicTask);
    assert.equal(result.answer, 'path-4:revised-2');
    assert.deepEqual(result.executedGraphIds, ['reason', 'reason']);
    assert.deepEqual(result.executedNodeIds, ['sample', 'trajectory', 'deliberate', 'reflect', 'sample', 'trajectory', 'deliberate', 'reflect']);
    assert.equal(result.state.revisions.length, 2);
    assert.equal(calls.length, 10, 'a two-step trajectory performs two genuine provider invocations per visit');
    assert.equal(admitted.length, 8, 'beforeNode gates actual nodes while provider telemetry counts internal calls');
    assert.deepEqual(calls.map(call => call.metadata.nodeType), Array(2).fill([
      'INFER.REASONING.SAMPLE', 'INFER.REASONING.TRAJECTORY', 'INFER.REASONING.TRAJECTORY', 'INFER.REASONING.DELIBERATE', 'INFER.REASONING.REFLECT',
    ]).flat());
    for (const input of calls) {
      assert.deepEqual(input.model, capabilities.model);
      assert.deepEqual(input.generation, capabilities.generation);
      assert.equal(input.metadata.taskId, publicTask.id);
    }
    assert.equal(result.outputs.trajectory.status, 'completed');
    assert.equal(result.outputs.trajectory.stopReason, 'completed');
    assert.equal(result.outputs.trajectory.result.content, 'path-4');
    assert.equal(result.outputs.trajectory.steps.filter(step => step.type === 'model').length, 2);
    assert.equal(result.outputs.deliberate.result.content, 'path-4', 'native select returns the supplied selected candidate, not the model rewrite');
    assert.equal(result.outputs.reflect.assessment.passed, true);
    assert.ok(trace.every(event => event.output.status === 'success' && !event.error));
    const paths = trace.filter(event => event.nodeType === 'INFER.REASONING.TRAJECTORY');
    assert.ok(paths.every(event => event.input.constraints.maxSteps === Number.MAX_SAFE_INTEGER));
    assert.deepEqual(paths.map(event => event.invocation), [1, 2]);
    const comparison = JSON.parse(calls[3].messages.at(-1).content);
    assert.equal(comparison.candidates[1].result.content, 'path-2');
    assert.equal(comparison.candidates[1].trajectory.length, 3);
  });
  for (const operation of ['TRAJECTORY', 'DELIBERATE', 'REFLECT']) assert.match(EVIDENCE_DEFINITION_GUIDE, new RegExp(`INFER\\.REASONING\\.${operation}`));
  assert.match(EVIDENCE_DEFINITION_GUIDE, /result\.content/);
  assert.match(EVIDENCE_DEFINITION_GUIDE, /assessment\.passed/);
});

test('B validates known native Infer fields even when other input bindings are dynamic', () => {
  const invalid = [
    [1, input => { input.strategy = 'cot'; }, /strategy.*object/],
    [1, input => { input.strategy.name = 'invented-strategy'; }, /strategy.name/],
    [1, input => { input.strategy.options.rounds = 0; }, /rounds.*integer/],
    [1, input => { input.context = 'raw context'; }, /context.*array/],
    [1, input => { input.memory = [{ content: 'Missing ID' }]; }, /memory.*id is required/],
    [2, input => { input.candidates = []; }, /candidates.*nonempty array/],
    [2, input => { input.candidates[0].result = 'bare answer'; }, /result.*object/],
    [2, input => { input.candidates[1].id = input.candidates[0].id; }, /duplicate candidate ID/],
    [2, input => { input.selectCount = 3; }, /selectCount.*integer/],
    [2, input => { input.mode = 'merge'; }, /selectCount requires select mode/],
    [2, input => { input.candidates[1].trajectory = [{ id: 'step', index: -1, type: 'model' }]; }, /index.*integer/],
    [3, input => { input.mode = 'reflection'; }, /mode must be one of/],
    [3, input => { input.target = {}; }, /target requires/],
    [3, input => { input.target.result = { role: 'assistant', content: {} }; }, /content.*string or MessagePart/],
    [3, input => { input.criteria = ['Check correctness']; }, /criteria.*object/],
    [3, input => { input.criteria[0].weight = -1; }, /weight.*finite number/],
  ];
  for (const [index, edit, pattern] of invalid) {
    const definition = inferFixture(); edit(definition.nodes[index].inputBindings);
    assert.throws(() => validateEvidenceDefinition(definition), pattern);
  }
  const literal = inferFixture();
  literal.nodes[3].inputBindings = { mode: 'verify', target: { artifact: { public: true } }, messages: [] };
  assert.doesNotThrow(() => validateEvidenceDefinition(literal), 'fully literal input uses the installed native schema without model calls');
});

test('B rejects dynamically malformed added Infer inputs before invoking the real Worker', async () => {
  const scenarios = [
    ['INFER.REASONING.TRAJECTORY', { messages: [{ role: 'user', content: 'Public task' }], strategy: { parse: ref('task', 'prompt') } }, '"cot"', /strategy.*object/],
    ['INFER.REASONING.DELIBERATE', { candidates: { parse: ref('task', 'prompt') }, mode: 'select' }, '[{"id":"x","result":"raw string"}]', /result.*object/],
    ['INFER.REASONING.REFLECT', { target: { parse: ref('task', 'prompt') }, mode: 'verify' }, '{}', /target requires/],
    ['INFER.REASONING.REFLECT', { target: { artifact: 'public' }, mode: 'verify', criteria: { parse: ref('task', 'prompt') } }, '["bare criterion"]', /criteria.*object/],
  ];
  for (const [type, inputBindings, prompt, pattern] of scenarios) await nativeInferHarness(async (runtime, capabilities, calls) => {
    const trace = [], definition = { schemaVersion: 1, id: 'invalid-infer', nodes: [{ id: 'operation', type, graphId: 'main', dependencies: [], inputBindings }],
      graphs: [{ id: 'main', nodeIds: ['operation'] }], loop: { entryGraphId: 'main', transitions: { main: { kind: 'end' } } }, output: { answer: 'Unused' } };
    await assert.rejects(() => runtime.loop(compileEvidenceDefinition(definition, capabilities, { trace }), { ...publicTask, prompt }), pattern);
    assert.equal(calls.length, 0);
    assert.match(trace[0].error, pattern);
    assert.ok(trace[0].input);
    assert.ok(!Object.hasOwn(trace[0], 'output'));
  });
});

test('B preserves frozen model, generation and trajectory execution settings across all Infer bindings', async () => {
  for (let index = 0; index < 4; index++) for (const field of ['model', 'generation', 'metadata']) {
    const definition = inferFixture();
    definition.nodes[index].inputBindings[field] = {};
    assert.throws(() => validateEvidenceDefinition(definition), new RegExp(`unsupported field ${field}`));
  }
  for (const constraints of [{ maxSteps: 2 }, { maxTotalTokens: 10 }, { timeoutMs: 0 }]) {
    const definition = inferFixture(); definition.nodes[1].inputBindings.constraints = constraints;
    assert.throws(() => validateEvidenceDefinition(definition), /frozen configuration|unsupported field maxTotalTokens|timeoutMs.*integer/);
  }
  await nativeInferHarness(async (runtime, capabilities, calls) => {
    const definition = inferFixture(), trace = [];
    definition.nodes[1].inputBindings.constraints = { parse: ref('task', 'prompt') };
    await assert.rejects(() => runtime.loop(compileEvidenceDefinition(definition, capabilities, { trace }), { ...publicTask, prompt: '{"maxSteps":1}' }), /frozen configuration/);
    assert.equal(calls.length, 1, 'only the preceding valid SAMPLE was dispatched');
    assert.match(trace.find(event => event.nodeId === 'trajectory').error, /frozen configuration/);
  });
});

test('B beforeNode blocks each added native operation and retains its exact diagnostic identity', async () => {
  for (const [type, allowedCalls] of [['TRAJECTORY', 1], ['DELIBERATE', 3], ['REFLECT', 4]]) await nativeInferHarness(async (runtime, capabilities, calls) => {
    const trace = [], gates = [];
    const gated = { ...capabilities, beforeNode(event) { gates.push(event); if (event.type === `INFER.REASONING.${type}`) throw new Error('provider-budget-exhausted'); } };
    await assert.rejects(() => runtime.loop(compileEvidenceDefinition(inferFixture(), gated, { trace }), publicTask), /provider-budget-exhausted/);
    assert.equal(calls.length, allowedCalls);
    const event = trace.find(entry => entry.nodeType === `INFER.REASONING.${type}`);
    assert.match(event.error, /provider-budget-exhausted/);
    assert.equal(event.input.metadata.nodeType, event.nodeType);
    assert.equal(gates.at(-1).input.metadata.taskId, publicTask.id);
    assert.deepEqual(event.input.generation, capabilities.generation);
  });
});

test('B uses native Deliberate modes and Reflect optional outputs without inventing a message field', async () => {
  for (const mode of ['merge', 'consensus', 'debate']) await nativeInferHarness(async (runtime, capabilities, calls) => {
    const definition = inferFixture();
    definition.nodes[2].inputBindings.mode = mode; delete definition.nodes[2].inputBindings.selectCount;
    definition.nodes = definition.nodes.slice(0, 3); definition.graphs[0].nodeIds = ['sample', 'trajectory', 'deliberate'];
    definition.loop = { entryGraphId: 'reason', transitions: { reason: { kind: 'end' } } };
    definition.output = { answer: ref('nodes', 'deliberate', 'result', 'content') };
    const result = await runtime.loop(compileEvidenceDefinition(definition, capabilities), publicTask);
    assert.equal(result.answer, `native-${mode}`);
    assert.equal(JSON.parse(calls.at(-1).messages.at(-1).content).mode, mode);
  }, input => input.metadata.nodeType === 'INFER.REASONING.DELIBERATE'
    ? JSON.stringify({ result: { role: 'assistant', content: `native-${JSON.parse(input.messages.at(-1).content).mode}` } }) : 'public candidate');

  for (const mode of ['critique', 'verify']) await nativeInferHarness(async (runtime, capabilities, calls) => {
    const definition = inferFixture();
    definition.nodes = [definition.nodes[0], { ...definition.nodes[3], dependencies: ['sample'], inputBindings: { mode, target: { result: ref('nodes', 'sample', 'message') } } }];
    definition.graphs[0].nodeIds = ['sample', 'reflect'];
    definition.loop = { entryGraphId: 'reason', transitions: { reason: { kind: 'end' } } };
    definition.output = { answer: { coalesce: [ref('nodes', 'reflect', 'revisedResult', 'content'), ref('nodes', 'sample', 'message', 'content')] } };
    const result = await runtime.loop(compileEvidenceDefinition(definition, capabilities), publicTask);
    assert.equal(result.answer, 'public candidate');
    assert.equal(Object.hasOwn(result.outputs.reflect, 'message'), false);
    assert.equal(Object.hasOwn(result.outputs.reflect, 'revisedResult'), false);
    assert.equal(calls.length, 2);
  }, input => input.metadata.nodeType === 'INFER.REASONING.REFLECT'
    ? JSON.stringify({ assessment: { passed: true, summary: 'Verified public fixture' }, issues: [] }) : 'public candidate');
});
