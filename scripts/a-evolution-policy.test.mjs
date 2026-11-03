import test from 'node:test';
import assert from 'node:assert/strict';
import { targetScore, targetFeasibility, evolutionArchive, selectEvolutionParents, workflowShape } from './a-evolution-policy.mjs';
import { searchPolicyForSize } from './generated-small-batch-policy.mjs';
const row=(id,score,tokens,examples=200)=>({id,status:'valid',evaluation:{valid:true,score,totalTokens:tokens,
  providerAttemptCount:200,durationMs:1000,examples}});
test('targets preserve the supplied figure and complete validation sizes',()=>{
  assert.equal(targetScore('math'),.9832); assert.equal(targetScore('drop'),.8827);
  assert.equal(targetScore('mbpp'),.8395); assert.equal(targetScore('bfcl'),.776);
  assert.equal(targetScore('automationbench'),.989);
  assert.deepEqual(searchPolicyForSize(119,'math').stages,[16,32,64,119]);
  assert.deepEqual(searchPolicyForSize(200,'bfcl').stages,[16,32,64,128,200]);
  assert.equal(searchPolicyForSize(200,'automationbench').stages.at(-1),200);
  assert.throws(()=>targetScore('drop',1));
});
test('frontier preserves accurate and efficient full candidates without promoting partial scores',()=>{
  const history=[row('best',.95,4000),row('cheap',.90,1000),row('dominated',.85,2000),row('partial',1,5,16)];
  assert.deepEqual(evolutionArchive(history,200).frontier.map(r=>r.id),['best','cheap']);
  assert.deepEqual(selectEvolutionParents(history,200).map(r=>r.id),['best','cheap','partial']);
  assert.equal(evolutionArchive(history,200).trials.at(-1).fullValidation,false);
});
test('renaming nodes is not new topology, rewiring is recorded',()=>{
  const plan={nodes:[{id:'a',type:'CONTEXT.LOAD',dependencies:[]},{id:'b',type:'INFER.REASONING.SAMPLE',dependencies:['a']}]};
  const renamed={nodes:[{id:'x',type:'CONTEXT.LOAD',dependencies:[]},{id:'y',type:'INFER.REASONING.SAMPLE',dependencies:['x']}]};
  assert.equal(workflowShape(plan).signature,workflowShape(renamed).signature);
  assert.notEqual(workflowShape(plan).signature,workflowShape({nodes:[plan.nodes[0],{...plan.nodes[1],dependencies:[]}]}).signature);
});

test('quality screening saves calls only when the strict target is mathematically unreachable',()=>{
  assert.equal(targetFeasibility({valid:true,examples:16,score:0},200,.989).advance,false);
  assert.equal(targetFeasibility({valid:true,examples:16,score:15/16},119,.9832).advance,true);
  assert.equal(targetFeasibility({valid:true,examples:16,score:14/16},119,.9832).advance,false);
  assert.equal(targetFeasibility({valid:true,examples:64,score:.914},200,.8827).advance,true);
  assert.equal(targetFeasibility({valid:false,examples:16,score:0},200,.989),null);
});
