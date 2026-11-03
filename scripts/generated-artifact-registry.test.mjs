import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createArtifactRegistry} from './generated-artifact-registry.mjs';

test('feedback imports reject identical A code despite changed labels, rationale and score', () => {
  const source = 'export default function createWorkflow(api) { return api.graph("same"); }';
  const registry = createArtifactRegistry('source');
  registry.rememberHistory([{id:'previous-seed-a',status:'historical-feedback',
    proposal:{source,rationale:'old rationale',referenceCandidateId:null},evaluation:{score:.985}}]);
  assert.throws(() => registry.assertNovel({source,rationale:'claims a new mechanism',
    referenceCandidateId:'previous-seed-a'}), /Identical artifact/);
  const changed = {source:source.replace('same', 'new')};
  assert.equal(registry.assertNovel(changed), createHash('sha256').update(changed.source).digest('hex'));
});

test('new and failed artifacts are remembered without rejecting unseen revisions', () => {
  const registry = createArtifactRegistry('source');
  const first = {source:'first'};
  assert.doesNotThrow(() => registry.assertNovel(first));
  registry.remember(first);
  registry.rememberHistory([{status:'invalid',proposal:{source:'failed'}}]);
  assert.throws(() => registry.assertNovel(first), /Identical artifact/);
  assert.throws(() => registry.assertNovel({source:'failed'}), /Identical artifact/);
  assert.doesNotThrow(() => registry.assertNovel({source:'repaired'}));
});

test('B identity uses the definition and skips records with no corresponding artifact', () => {
  const registry = createArtifactRegistry('definition');
  registry.rememberHistory([{proposal:{source:'unrelated A'}},{id:'without-proposal'},
    {proposal:{definition:{nodes:[{id:'a'}]}}}]);
  assert.throws(() => registry.assertNovel({definition:{nodes:[{id:'a'}]},rationale:'new'}), /Identical artifact/);
  assert.doesNotThrow(() => registry.assertNovel({definition:{nodes:[{id:'b'}]}}));
});
