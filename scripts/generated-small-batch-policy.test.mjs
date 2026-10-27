import test from 'node:test';
import assert from 'node:assert/strict';
import { selectSearchTasks, pairedStageDecision, bestFullCandidate, searchPolicyForSize, committedRequests } from './generated-small-batch-policy.mjs';
test('selection is deterministic, nested and independent of scores', () => {
  const tasks = Array.from({length:200},(_,i)=>({id:'task-'+i,score:i/200}));
  const selected = selectSearchTasks(tasks);
  assert.equal(selected.length,64);
  assert.deepEqual(selected.map(t=>t.id),selectSearchTasks(tasks.map(t=>({...t,score:1-t.score}))).map(t=>t.id));
  assert.deepEqual(selectSearchTasks(tasks,16),selected.slice(0,16));
});

test('request accounting retains in-flight reservations alongside completed SDK retries', () => {
  assert.equal(committedRequests(3,3,1),5);
  assert.equal(committedRequests(3,3,3),3);
  assert.equal(committedRequests(0,3,0),3);
});

test('expanded validation retains original64 prefix and requires completed200 to rank', () => {
  const tasks=Array.from({length:200},(_,i)=>({id:'task-'+i}));
  assert.deepEqual(selectSearchTasks(tasks,200).slice(0,64),selectSearchTasks(tasks,64));
  const policy=searchPolicyForSize(200);
  assert.deepEqual(policy.stages,[16,32,64,128,200]);
  const full={id:'200',status:'valid',evaluation:{valid:true,examples:200,score:.90,totalTokens:2}};
  const partial={id:'64',status:'valid',evaluation:{valid:true,examples:64,score:.99,totalTokens:1}};
  assert.equal(bestFullCandidate([partial,full],200),full);
  assert.equal(pairedStageDecision({valid:true,results:[]},undefined,64,policy).advance,true);
  assert.equal(pairedStageDecision(full.evaluation,undefined,200,policy).advance,false);
});
test('only large paired regressions stop early; partial overlaps cannot eliminate a candidate', () => {
  const results = Array.from({length:16},(_,i)=>({caseId:'t'+i,valid:true,score:0.7}));
  const evaluation = {valid:true,results};
  assert.equal(pairedStageDecision(evaluation,{results:results.map(r=>({...r,score:0.8}))},16).advance,true);
  assert.equal(pairedStageDecision(evaluation,{results:results.map(r=>({...r,score:1}))},16).advance,false);
  assert.equal(pairedStageDecision(evaluation,{results:results.slice(0,8)},16).advance,true);
});
test('a high 16-task score never supersedes a complete 64-task candidate', () => {
  const full={id:'full',status:'valid',evaluation:{valid:true,examples:64,score:0.89,totalTokens:10}};
  assert.equal(bestFullCandidate([full,{id:'partial',status:'valid',evaluation:{valid:true,examples:16,score:1}}]).id,'full');
});
