import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDitto } from '@codesoul-co/ditto/runtime';
import { createContextWorker } from '@codesoul-co/ditto/worker/context';
import { createInferWorker, type ModelProvider } from '@codesoul-co/ditto/worker/infer';
import { buildOrganizationPlan, initialOrganization, validateOrganization, validateOrganizationPlan, nodeCatalog } from '../workflow/organization.js';
import type { OrganizationSpec } from '../workflow/organization-types.js';
import { WorkflowExecutor } from '../workflow/executor.js';
import { evaluateTasks } from '../benchmark/evaluator.js';
import type { AgentPlanSpec, AgentRunResult, BenchmarkTask, EvaluationSummary } from '../domain.js';
import { OrganizationWorkflowSearch, OrganizationProposer } from '../search/organization-search.js';
import type { SearchResumeState } from '../search/optimizer.js';
import { evaluationCodeHash } from '../run/case-recovery.js';
import { currentExecutionIdentity, builtCodeHash, assertExecutionIdentity } from '../run/execution-identity.js';
import { withGenerationGuidance } from '../ditto/generation-guidance.js';
import { createExperimentRuntime } from '../ditto/runtime.js';
import { validateCheckpoint, checkpointForPlan } from '../run/checkpoints.js';

const task:BenchmarkTask={id:'math-fixture',dataset:'math',prompt:'What is 1+1?',outputInstruction:'',metadata:{}};
const output=(answer:string):AgentRunResult=>({answer,executedNodeIds:[],executedGraphIds:[],inputTokens:1,outputTokens:1,totalTokens:2,usageKnown:true});
const scorer={expectedLabel(){return '2';},async score(_id:string,prediction:string){return {score:Number(prediction==='2'),prediction,expected:'2',normalizedExpected:'2',normalizedPrediction:prediction,method:'fixture'};}};
function fixture(provider:ModelProvider){const runtime=createDitto({workers:[createContextWorker(),createInferWorker({providers:{fixture:provider},defaultProvider:'fixture'})]});return {runtime,executor:new WorkflowExecutor(runtime,'fixture','fixture')};}
function revised():OrganizationSpec {
  return {...initialOrganization('math'),nodes:[...initialOrganization('math').nodes,{id:'revision',template:'revise',dependencies:['answer']}],
    graphs:[{id:'solve',nodeIds:['context','answer','revision']}],outputNodeId:'revision'};
}

test('all fixed nodes and Automation transitions are validated, with no fixed suffix',async()=>{
  validateOrganization(initialOrganization('automationbench'));
  const spec:OrganizationSpec={version:1,dataset:'automationbench',nodes:[{id:'context',template:'context',dependencies:[]},{id:'answer',template:'sample',dependencies:['context']}],graphs:[{id:'direct',nodeIds:['context','answer']}],entryGraphId:'direct',transitions:{direct:{kind:'end'}},outputNodeId:'answer'};
  let calls=0; const {runtime,executor}=fixture({async invoke(input){calls++;assert.equal(input.actions,undefined);return {message:{role:'assistant',content:'text only'},finishReason:'stop'};}});
  try {
    // A task scope is required for any Automation candidate, even one choosing no writes.
    const {automationScope}=await import('../benchmark/automation.js');
    const result=await automationScope.run({tools:[],async call(){throw Error('Unexpected tool');},record(){},assertHealthy(){}},()=>executor.run(buildOrganizationPlan(spec),{...task,dataset:'automationbench'}));
    assert.equal(calls,1); assert.deepEqual(result.executedGraphIds,['direct']);assert.equal(result.answer,'text only');
  }finally{await runtime.close();}
});

test('optimizer cannot change prompts, generation, tool capability or undeclared dependencies',()=>{
  for(const extra of [{config:{instruction:'cheat'}},{tool:'new-capability'},{generation:{maxTokens:1}}]){
    const spec=structuredClone(initialOrganization('math')) as any;Object.assign(spec.nodes[1],extra);assert.throws(()=>validateOrganization(spec),/unsupported field/);
  }
  const tampered=structuredClone(buildOrganizationPlan(initialOrganization('math'))) as any;tampered.nodes[1].config.instruction='changed';assert.throws(()=>validateOrganizationPlan(tampered),/fixed capability/);
  const spec=structuredClone(initialOrganization('math')) as any;spec.nodes[1].dependencies=['future'];assert.throws(()=>validateOrganization(spec),/dependency/);
  assert.equal(nodeCatalog('math').act,undefined);
});

test('searched dependency rewiring changes actual inference inputs while catalog stays fixed',async()=>{
  const inputs:string[]=[];
  const {runtime,executor}=fixture({async invoke(input){inputs.push(JSON.stringify(input.messages));return {message:{role:'assistant',content:inputs.length===1?'intermediate':'2'},finishReason:'stop'};}});
  const spec:OrganizationSpec={...initialOrganization('math'),nodes:[...initialOrganization('math').nodes,{id:'final',template:'sample',dependencies:['answer']}],graphs:[{id:'solve',nodeIds:['context','answer','final']}],outputNodeId:'final'};
  try{await executor.run(buildOrganizationPlan(spec),task);assert.match(inputs[1]!,/intermediate/);
    const detached={...spec,nodes:spec.nodes.map(n=>n.id==='final'?{...n,dependencies:[]}:n)};inputs.length=0;await executor.run(buildOrganizationPlan(detached),task);assert.doesNotMatch(inputs[1]!,/intermediate/);
  }finally{await runtime.close();}
});

test('complete length outputs score correct or wrong exactly once and valid zero is reused',async()=>{
  for(const answer of ['2','3']){
    let calls=0; const {runtime,executor}=fixture({async invoke(){calls++;return {message:{role:'assistant',content:answer},finishReason:'length',usage:{inputTokens:1,outputTokens:1,totalTokens:2}};}});
    try{const run=()=>executor.run(buildOrganizationPlan(initialOrganization('math')),task);const summary=await evaluateTasks([task],scorer,run);
      assert.equal(summary.valid,true);assert.equal(summary.score,Number(answer==='2'));assert.equal(calls,1);
      await evaluateTasks([task],scorer,run,{priorCases:summary.results});assert.equal(calls,1);
    }finally{await runtime.close();}
  }
});

test('a judge outage regrades the saved answer without another generation',async()=>{
  let generations=0;
  const first=await evaluateTasks([task],{...scorer,async score(){throw Error('Judge unavailable');}},async()=>{generations++;return output('3');});
  assert.equal(first.valid,false);
  const resumed=await evaluateTasks([task],scorer,async()=>{generations++;return output('2');},{priorCases:first.results});
  assert.equal(generations,1);assert.equal(resumed.valid,true);assert.equal(resumed.score,0);assert.equal(resumed.results[0]!.totalTokens,2);
});

test('complete optimizer JSON with length is parsed without another generation',async()=>{
  let calls=0; const {runtime}=fixture({async invoke(){calls++;return {message:{role:'assistant',content:JSON.stringify(revised())},finishReason:'length'};}});
  try{const proposal=await new OrganizationProposer(runtime,{provider:'fixture',model:'fixture'}).propose({parent:buildOrganizationPlan(initialOrganization('math')),experiences:[],accept:validateOrganization});assert.equal(proposal.outputNodeId,'revision');assert.equal(calls,1);}finally{await runtime.close();}
});

test('topology search freezes the measured plan and resumes without reevaluating completed candidates',async()=>{
  let evaluated=0;let saved:SearchResumeState|undefined;
  const evaluate=async(plan:AgentPlanSpec)=>{evaluated++;return evaluateTasks([task],scorer,async()=>output(plan.nodes.length===3?'2':'3'));};
  const options={dataset:'math' as const,rounds:1,seed:42,topK:4,patience:5,maxDepth:12,evaluate,proposer:{async propose(){return revised();}},callbacks:{async state(state:SearchResumeState){saved=structuredClone(state);}}};
  const result=await new OrganizationWorkflowSearch(options).run();assert.equal(result.bestPlan.outputNodeId,'revision');assert.equal(evaluated,2);assert.ok(saved?.organizationPlans);
  const hydrated={...saved!,nodes:saved!.nodes.map(n=>({...n,evaluation:n.evaluation?{...n.evaluation,results:[{...result.bestLeaf.evaluation!.results[0]!}]}:undefined}))} as SearchResumeState;
  const resumed=await new OrganizationWorkflowSearch({...options,resume:hydrated}).run();assert.deepEqual(resumed.bestPlan,result.bestPlan);assert.equal(evaluated,2);
  const checkpoint=checkpointForPlan(result.bestPlan,{dataset:'math',model:'fixture',endpoint:'fixture',metricProfile:'fixture',dittoVersion:'0.1.1',protocol:{}});validateCheckpoint(checkpoint);
});

test('source and built artifact changes are rejected before execution; frozen identity must match',async()=>{
  const root=await mkdtemp(join(tmpdir(),'ditto-identity-'));
  try{
    for(const dir of ['src','scripts','dist','node_modules/@codesoul-co/ditto/dist'])await mkdir(join(root,dir),{recursive:true});
    await writeFile(join(root,'src/a.ts'),'first');await writeFile(join(root,'dist/a.js'),'first');
    await writeFile(join(root,'package-lock.json'),JSON.stringify({packages:{'node_modules/@codesoul-co/ditto':{version:'0.1.1'}}}));await writeFile(join(root,'node_modules/@codesoul-co/ditto/package.json'),JSON.stringify({version:'0.1.1'}));
    await writeFile(join(root,'dist/build-identity.json'),JSON.stringify({source:await evaluationCodeHash(root),build:await builtCodeHash(root)}));
    const identity=await currentExecutionIdentity(root);assertExecutionIdentity(identity,await currentExecutionIdentity(root));assert.throws(()=>assertExecutionIdentity(identity,{...identity,nodeVersion:'other'}),/differs/);
    await writeFile(join(root,'dist/a.js'),'changed');await assert.rejects(currentExecutionIdentity(root),/Source\/build changed/);
    await writeFile(join(root,'dist/a.js'),'first');await writeFile(join(root,'src/a.ts'),'changed');await assert.rejects(currentExecutionIdentity(root),/Source\/build changed/);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('MFlow guidance applies only to its original conditions and never forbids mathematical checks',()=>{
  const plain={body:JSON.stringify({messages:[{role:'user',content:'question'}]})};assert.equal(withGenerationGuidance(plain),plain);
  const formatted=withGenerationGuidance({body:JSON.stringify({response_format:{type:'json_object'},messages:[{role:'user',content:'question'}]})});
  const body=JSON.parse(String(formatted!.body));assert.match(body.messages[0].content,/finish after its closing brace/);assert.doesNotMatch(body.messages[0].content,/Do not add self-checks/);
});

test('public runtime retains provider/tool injection without starting Python',async()=>{
  const experiment=createExperimentRuntime({baseUrl:'https://example.test',apiKey:'fixture',model:'fixture',timeoutMs:5000,concurrency:1},{provider:{async invoke(){return {message:{role:'assistant',content:'2'},finishReason:'stop'};}},tools:[]});
  try{assert.ok(experiment.provider);assert.equal((await new WorkflowExecutor(experiment.runtime,experiment.providerName,experiment.model).run(buildOrganizationPlan(initialOrganization('math')),task)).answer,'2');}finally{await experiment.close();}
});

test('structured outputs at the token limit use received JSON or fail normally without resampling', async()=>{
  for(const valid of [true,false]){
    let calls=0;
    const experiment=createExperimentRuntime({baseUrl:'https://example.test',apiKey:'fixture',model:'fixture',timeoutMs:5000,concurrency:1},{provider:{async invoke(input){
      calls++;
      if(input.metadata?.nodeType==='INFER.REASONING.REFLECT')return {message:{role:'assistant',content:valid?JSON.stringify({assessment:{summary:'fixed'},issues:[],revisedResult:{role:'assistant',content:'2'}}):'{broken'},finishReason:'length',usage:{inputTokens:1,outputTokens:1,totalTokens:2}};
      return {message:{role:'assistant',content:'3'},finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}};
    }},tools:[]});
    try{
      const summary=await evaluateTasks([task],scorer,()=>new WorkflowExecutor(experiment.runtime,experiment.providerName,experiment.model).run(buildOrganizationPlan(revised()),task));
      assert.equal(calls,2);assert.equal(summary.valid,true);assert.equal(summary.score,valid?1:0);
    }finally{await experiment.close();}
  }
});

test('JSON key order does not manufacture a new organization and pure control cycles are rejected',()=>{
  const original=initialOrganization('math');
  const permuted={...original,nodes:[...original.nodes].reverse()};
  assert.equal(buildOrganizationPlan(original).id,buildOrganizationPlan(permuted).id);
  const cycle={...original,graphs:[{id:'load',nodeIds:['context']},{id:'solve',nodeIds:['answer']}],entryGraphId:'load',transitions:{load:{kind:'next',graphId:'load'},solve:{kind:'end'}}} as OrganizationSpec;
  assert.throws(()=>validateOrganization(cycle),/cycle/);
});

test('pending organization is resumed exactly after an evaluation outage',async()=>{
  let saved:SearchResumeState|undefined;let evaluations=0;let proposals=0;
  const options={dataset:'math' as const,rounds:1,seed:42,topK:4,patience:5,maxDepth:12,
    proposer:{async propose(){proposals++;return revised();}},
    async evaluate(plan:AgentPlanSpec){evaluations++;if(evaluations===2)throw Error('environment outage');return evaluateTasks([task],scorer,async()=>output(plan.nodes.length===3?'2':'3'));},
    callbacks:{async state(state:SearchResumeState){saved=structuredClone(state);}}};
  await assert.rejects(new OrganizationWorkflowSearch(options).run(),/environment outage/);
  assert.ok(saved!.pendingOrganization);assert.equal(saved!.completedRounds,0);
  const resumed=await new OrganizationWorkflowSearch({...options,resume:saved!}).run();
  assert.equal(proposals,1);assert.equal(evaluations,3);assert.equal(resumed.bestPlan.outputNodeId,'revision');
});

test('malformed organization proposals repair at most three times',async()=>{
  let calls=0;const {runtime}=fixture({async invoke(){calls++;return {message:{role:'assistant',content:'{broken'},finishReason:'length'};}});
  try{await assert.rejects(new OrganizationProposer(runtime,{provider:'fixture',model:'fixture'}).propose({parent:buildOrganizationPlan(initialOrganization('math')),experiences:[],accept:validateOrganization}),/organization rejected/);assert.equal(calls,3);}finally{await runtime.close();}
});
