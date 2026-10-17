import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {evaluateTasks} from '../dist/benchmark/evaluator.js';
import {assertValidEvaluation,backpropagateEvaluation} from '../dist/search/backprop.js';
import {selectParent,compareRunnableLeaves} from '../dist/search/selector.js';
import {SeededRandom} from '../dist/search/random.js';
import {NodeWorkflowSearch} from '../dist/search/optimizer.js';
import {createRootNode,createInitialSampleNode,createSearchTreeNode} from '../dist/workflow/spec.js';

const tasks=['correct','wrong','fault'].map(id=>({id,dataset:'math',prompt:'fixture',outputInstruction:'',metadata:{}}));
const answer=(value='2')=>({answer:value,executedNodeIds:[],executedGraphIds:[],inputTokens:3,outputTokens:2,totalTokens:5});
const scorer={expectedLabel:()=> '2',async score(_id,prediction){return {score:prediction==='2'?1:0,expected:'2',prediction,normalizedExpected:'2',normalizedPrediction:prediction,method:'offline-fixture'};}};
for(const scenario of [
 {name:'401',message:'HTTP 401: unauthorized',kind:'provider',attempts:1},
 {name:'402',message:'HTTP 402: insufficient balance',kind:'provider',attempts:1},
 {name:'429',message:'HTTP 429: rate limited',kind:'provider',attempts:2},
 {name:'timeout',message:'HTTP 504: timed out',kind:'timeout',attempts:2},
 {name:'500',message:'HTTP 500: internal error',kind:'provider',attempts:2},
 {name:'scorer exception',message:'fixture scorer crashed',kind:'judge',attempts:1},
]){
 test(`meeting fault acceptance: ${scenario.name} stays invalid until the original sample is recovered`,async()=>{
  let calls=0,judgeCalls=0;
  const privateScorer={...scorer,async score(id,prediction){if(id==='fault'&&scenario.kind==='judge'){judgeCalls++;throw new Error(scenario.message);}return scorer.score(id,prediction);}};
  const invalid=await evaluateTasks(tasks,privateScorer,async task=>{
   if(task.id==='fault'){calls++;if(scenario.kind!=='judge')throw new Error(scenario.message);}
   return answer(task.id==='wrong'?'3':'2');
  },{retryAttempts:2});
  assert.equal(calls,scenario.attempts);assert.equal(judgeCalls,scenario.kind==='judge'?1:0);
  assert.equal(invalid.examples,3);assert.equal(invalid.results.length,3);assert.equal(invalid.valid,false);
  assert.equal(invalid.validRuns,2);assert.equal(invalid.failedRuns,1);assert.equal(invalid.wrongRuns,1);
  const failed=invalid.results.find(x=>x.caseId==='fault#1');
  assert.equal(failed.failureKind,scenario.kind);assert.equal(failed.error,scenario.message);
  assert.equal(failed.attempts.length,scenario.kind==='judge'?0:scenario.attempts);
  assert.equal(failed.usageKnown,scenario.kind==='judge');
  if(scenario.kind==='judge'){assert.equal(failed.prediction,'2');assert.equal(invalid.totalTokens,15);}
  else{assert(failed.attempts.every(x=>x.error===scenario.message&&x.usageKnown===false));assert.equal(invalid.tokenUsageStatus,'known-lower-bound');}
  assert.throws(()=>assertValidEvaluation(invalid),/Invalid evaluation/);
  assert.throws(()=>backpropagateEvaluation(new Map(),'unused',invalid),/Invalid evaluation/);
  const root=createRootNode(),sample=createInitialSampleNode();
  const node={...createSearchTreeNode('search-001','search-000',1,sample,[root,sample]),evaluation:invalid};
  assert.throws(()=>selectParent([node],1,new SeededRandom(42)),/Invalid evaluation/);
  assert.throws(()=>compareRunnableLeaves(node,node),/Invalid evaluation/);
  let proposals=0;const experiences=[];
  await assert.rejects(new NodeWorkflowSearch({seed:42,rounds:1,topK:1,patience:5,evaluate:async()=>invalid,
   proposer:{async propose(){proposals++;throw new Error('must not propose');}},
   callbacks:{async node(value,experience){if(value.evaluation)experiences.push({experience,visits:value.statistics.visits});}},
  }).run(),/Invalid evaluation/);
  assert.equal(proposals,0);assert.deepEqual(experiences,[{experience:null,visits:0}]);
  const recoveredCalls=[];
  const recovered=await evaluateTasks(tasks,scorer,async task=>{recoveredCalls.push(task.id);return answer();},{priorCases:invalid.results,retryAttempts:2});
  assert.deepEqual(recoveredCalls,scenario.kind==='judge'?[]:['fault']);assert.equal(recovered.valid,true);assert.equal(recovered.examples,3);
  assert.equal(recovered.results.length,3);assert.equal(recovered.validRuns,3);assert.equal(recovered.failedRuns,0);
  assert.equal(recovered.wrongRuns,1);assert.equal(recovered.score,2/3);
  assert.equal(recovered.results.find(x=>x.caseId==='wrong#1').score,0);
  assert.equal(recovered.results.find(x=>x.caseId==='wrong#1').valid,true);
  assert.equal(recovered.results.find(x=>x.caseId==='fault#1').previousResults[0].error,scenario.message);
  assert.doesNotThrow(()=>assertValidEvaluation(recovered));
 });
}
test('meeting SDK fault injection: explicit 401/402, 500 and transport timeout policy',()=>{
 const python=process.env.DITTO_PROVIDER_PYTHON||'python';
 const result=spawnSync(python,['-B',fileURLToPath(new URL('./provider-faults.py',import.meta.url))],{encoding:'utf8',windowsHide:true});
 assert.equal(result.status,0,result.stderr||result.error?.message);
});
