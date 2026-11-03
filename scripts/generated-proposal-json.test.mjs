import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGeneratedProposal } from './generated-proposal-json.mjs';

test('repairs missing punctuation without changing workflow values', () => {
  const input = '{"definition":{"messages":[{"literal":"next action"]},"rationale":"fixture"}';
  const result = parseGeneratedProposal(input);
  assert.deepEqual(result.proposal, { definition: { messages: [{ literal: 'next action' }] }, rationale: 'fixture' });
  assert.ok(result.repairedContent);
});

test('leaves valid output intact and rejects repairs that invent values', () => {
  assert.deepEqual(parseGeneratedProposal('```json\n{"definition":{}}\n```'), { proposal: { definition: {} } });
  assert.throws(() => parseGeneratedProposal('{"definition":}'));
  assert.throws(() => parseGeneratedProposal('{"rationale":"unfinished'));
});
