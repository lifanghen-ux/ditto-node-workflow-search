import assert from 'node:assert/strict';
import test from 'node:test';
import {OFFICIAL_BASELINE,validateOfficialDefinition,validateOfficialChange,officialArtifactHash,expandedOfficialNodes} from '../official-agent/schema.js';
import {parseOfficialProposal,searchOfficialWorkflows} from '../official-agent/search.js';
import {migrateLegacyDefinition} from '../official-agent/migration.js';
import {officialBaseline} from '../official-agent/baselines.js';
import {BASELINE_DEFINITION} from '../graph-agent/schema.js';
import {createExperimentRuntime,experimentRuntimeConfig} from '../ditto/runtime.js';
import {runOfficialAgent} from '../official-agent/executor.js';
import type {BenchmarkTask} from '../domain.js';
import {parseUnifiedArguments} from '../unified/cli.js';
import {runUnifiedExperiment} from '../official-agent/runner.js';

const task:BenchmarkTask={id:'fixture',dataset:'drop',prompt:'Passage: The touchdown was 49 yards. Question: How many yards?',outputInstruction:'',metadata:{}};
const clone=(x:unknown):any=>JSON.parse(JSON.stringify(x));
test('Test rejects a programmatic seed replacement before reading data or creating a provider',async()=>{
 await assert.rejects(runUnifiedExperiment({command:'test',initialDefinition:OFFICIAL_BASELINE} as any),/Test cannot replace its frozen selection/);
});
function child(direction:string,parent:any=OFFICIAL_BASELINE):any{
 const d=clone(parent),solve=d.graphs.main.nodes.find((n:any)=>n.id==='solve');
 if(direction==='native-reasoning'){
  solve.type='INFER.REASONING.TRAJECTORY';solve.input={...solve.input,objective:'Reason from the original public task',strategy:{name:'cot'},constraints:{maxSteps:1}};d.graphs.main.output={$ref:'nodes.solve.output.result.content'};
 }else{
  const id='new-'+direction;
  if(direction==='interaction')d.graphs.main.nodes.splice(-1,0,{id,type:'INTERACTION.ACT.TOOL',input:{call:{id:'fixture-call',name:'literal_text_find',arguments:{text:{$ref:'input.task.prompt'},needle:'49'}}}});
  else if(direction==='context-retrieval')d.graphs.main.nodes.splice(-1,0,{id,type:'CONTEXT.SELECT',dependsOn:['context'],input:{context:{$ref:'nodes.context'},purpose:'infer',limit:1}});
  else d.graphs.main.nodes.splice(-1,0,{id,type:'MEMORY.WRITE',dependsOn:['context'],input:{memories:[{content:{$ref:'nodes.context.items'}}]}});
  solve.dependsOn=[...(solve.dependsOn??[]),id];solve.input.messages={$op:'concat',args:[solve.input.messages,[{role:'user',content:{$ref:'nodes.'+id}}]]};
 }
 return{rationale:'Test one functional node with necessary reference wiring',definition:d};
}

function summary(d:any){return{valid:true,score:.5,standardDeviation:0,repeats:1,examples:1,successfulRuns:1,failedRuns:0,wrongRuns:0,timeoutRuns:0,inputTokens:1,outputTokens:1,totalTokens:2,durationMs:0,results:[{caseId:task.id+'#1',valid:true,score:.5,prediction:'49',expected:'PRIVATE_SENTINEL',normalizedExpected:'PRIVATE_SENTINEL',normalizedPrediction:'49',method:'fixture',latencyMs:0,inputTokens:1,outputTokens:1,totalTokens:2}],publicTraces:[{executedNodeIds:expandedOfficialNodes(d).map(n=>n.id)}]};}

test('measured archive preserves alternative feedback without rerunning seeds, and stops at the explicit score target',async()=>{
 const seeds=[1,2].map(index=>{const definition=clone(OFFICIAL_BASELINE);definition.config.strategy='Measured strategy '+index;
  return{id:`official-000${index}`,parentId:null,status:'valid' as const,designRound:0,proposalAttempt:0,definition,rationale:'Measured public alternative',artifactHash:officialArtifactHash(definition),evaluation:summary(definition)};});
 let proposals=0,evaluations=0;
 const runtime:any={async run(_graph:unknown,input:{request:string}){proposals++;const request=JSON.parse(input.request);
  assert.equal(request.measuredFeedback.feedback.length,2);assert.equal(request.immutableProtocol.evaluationContract.scoredArtifact,'final-answer-text');
  assert.equal(request.searchObjective.mode,'quality-recovery');assert.equal(request.searchObjective.bestMeasuredScore,.5);
  assert.doesNotMatch(input.request,/PRIVATE_SENTINEL/);
  const definition=clone(seeds[1]!.definition);definition.config.strategy='New supported strategy';
  return{proposal:{status:'success',output:{message:{content:JSON.stringify({rationale:'Compare the archived strengths',definition})}}}};
 }};
 const result=await searchOfficialWorkflows({runtime,model:{provider:'mock',model:'mock'},dataset:'drop',publicTasks:[task],expectedRepeats:1,exploration:false,
  measuredSeeds:seeds,targetScore:1,maxValidEvaluations:4,maxDesignRounds:3,evaluate:async definition=>{evaluations++;const value=summary(definition);return{...value,score:1,results:value.results.map(row=>({...row,score:1}))};}});
 assert.equal(proposals,1);assert.equal(evaluations,1);assert.equal(result.state.validEvaluations,3);assert.equal(result.best.id,'official-0003');assert.equal(result.stoppedBecause,'score-target');
 const invalid=clone(seeds);invalid[0].evaluation.score=1;
 await assert.rejects(searchOfficialWorkflows({runtime,model:{provider:'mock',model:'mock'},dataset:'drop',publicTasks:[task],expectedRepeats:1,exploration:false,measuredSeeds:invalid,evaluate:async()=>{throw Error('Must not evaluate an invalid archive');}}),/score does not match/);
});

test('official proposals keep metadata/tools outside the native definition and reject legacy formats',()=>{
 assert.equal(parseOfficialProposal(JSON.stringify({rationale:'Keep this native Agent configuration',definition:OFFICIAL_BASELINE})).definition.version,1);
 assert.throws(()=>parseOfficialProposal(JSON.stringify({rationale:'Old config',definition:BASELINE_DEFINITION})),/field|graphs|version|id/i);
 assert.throws(()=>validateOfficialDefinition({...clone(OFFICIAL_BASELINE),mutation:{primaryNodeId:'solve',auxiliary:[]}}),/unknown|Unknown/);
 const fake=clone(OFFICIAL_BASELINE);fake.graphs.main.nodes[1].input.model={model:'override'};assert.throws(()=>validateOfficialDefinition(fake),/immutable host/);
});

test('Subgraph reuse counts expanded SAMPLE calls and main remains mandatory',()=>{
 const d:any={version:1,id:'reuse',graphs:{main:{nodes:[{id:'left',kind:'subgraph',graph:'solver',input:{$ref:'input'}},{id:'right',kind:'subgraph',graph:'solver',input:{$ref:'input'}}],output:{left:{$ref:'nodes.left'},right:{$ref:'nodes.right'}}},solver:{nodes:[clone(OFFICIAL_BASELINE).graphs.main.nodes[1]],output:{$ref:'nodes.solve.output.message.content'}}}};
 d.graphs.solver.nodes[0].dependsOn=[];assert.throws(()=>validateOfficialDefinition(d),/SAMPLE/);delete d.graphs.main;assert.throws(()=>validateOfficialDefinition(d),/main/);
});

test('moving a solver into a reusable Subgraph is structural search, not unrelated leaf insertion',()=>{
 const d=clone(OFFICIAL_BASELINE),solve=d.graphs.main.nodes.pop();solve.dependsOn=[];d.graphs.answer={nodes:[solve],output:{$ref:'nodes.solve.output.message.content'}};
 d.graphs.main.nodes.push({id:'answer',kind:'subgraph',graph:'answer',dependsOn:['context'],input:{$ref:'input'}});d.graphs.main.output={$ref:'nodes.answer'};
 assert.doesNotThrow(()=>validateOfficialChange(OFFICIAL_BASELINE,d));
});

test('model-error classification cannot be assigned to a non-model parse source',()=>{
 const d=clone(OFFICIAL_BASELINE);d.graphs.main.nodes.push({id:'fake',type:'HOST.DATA.TRANSFORM',input:{operation:'parse',sourceKind:'model-json',value:{$ref:'input.task.prompt'}}});
 d.graphs.main.nodes[1].dependsOn.push('fake');d.graphs.main.nodes[1].input.messages={$op:'concat',args:[d.graphs.main.nodes[1].input.messages,[{role:'user',content:{$ref:'nodes.fake'}}]]};
 assert.throws(()=>validateOfficialDefinition(d),/direct native Infer/);
});

test('official search preserves parent policy, protected native directions, and private-reference exclusion',async()=>{
 const directions:string[]=[],requests:string[]=[];
 const runtime:any={async run(_g:any,input:any){requests.push(input.request);const request=JSON.parse(input.request),direction=request.exploration.direction;directions.push(direction);return{proposal:{status:'success',output:{message:{content:JSON.stringify(child(direction,request.parent.definition))}}}};}};
 const result=await searchOfficialWorkflows({runtime,model:{provider:'mock',model:'mock'},dataset:'drop',publicTasks:[task],expectedRepeats:1,maxValidEvaluations:5,maxDesignRounds:4,maxProposalAttempts:1,evaluate:async d=>summary(d)});
 assert.deepEqual(directions,['interaction','context-retrieval','native-reasoning','memory-cache']);assert.equal(result.state.validEvaluations,5);assert(!requests.join('').includes('PRIVATE_SENTINEL'));assert.equal(result.best.definition.version,1);
 for(const text of requests){
  const request=JSON.parse(text);
  assert.equal(request.proposalContract.schema.properties.rationale.type,'string');
  assert.deepEqual(request.proposalContract.schema.properties.mutation.required,['primaryNodeId','auxiliary']);
  assert(request.nativeCatalogue.nodes['CONTEXT.SELECT'].inputSchema.properties.purpose.enum.includes('infer'));
  assert.deepEqual(request.registeredTools.find((tool:any)=>tool.name==='bounded_arithmetic').inputSchema.required,['expression']);
  assert(request.interfaceGuide.includes('rationale is ONE NONEMPTY STRING'));
 }
});

test('tool artifacts participate in candidate identity while official JSON remains portable',()=>{
 const tool={name:'trim_text',description:'Trim supplied text',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']},executeSource:'function(args){return args.text.trim();}'};
 const proposal=parseOfficialProposal(JSON.stringify({rationale:'Register one pure helper',definition:OFFICIAL_BASELINE,toolArtifacts:[tool]}));
 assert.notEqual(officialArtifactHash(proposal.definition),officialArtifactHash(proposal.definition,proposal.toolArtifacts));assert(!Object.hasOwn(proposal.definition,'toolArtifacts'));
});

test('legacy memory graph imports into native JSON and executes with the npm compiler',async()=>{
 const old=clone(BASELINE_DEFINITION),solve=old.graphs[0].nodes[1];old.loop.maxGraphRuns=1;
 old.graphs[0].nodes.splice(1,0,{id:'remember',type:'MEMORY.WRITE',dependencies:['context'],config:{content:{ref:['nodes','context','items']}}},{id:'recall',type:'MEMORY.SEARCH',dependencies:['remember'],config:{query:{ref:['task','prompt']},limit:1}});
 solve.dependencies=['context','recall'];solve.config.evidence=[{ref:['nodes','recall']}];
 const imported=migrateLegacyDefinition(old),settings={baseUrl:'https://example.invalid',apiKey:'offline',model:'mock',concurrency:1,timeoutMs:3000};
 const shared=createExperimentRuntime(settings,{provider:{async invoke(input){assert.match(JSON.stringify(input.messages),/49 yards/);return{message:{role:'assistant',content:'49'},finishReason:'stop',usage:{inputTokens:3,outputTokens:1,totalTokens:4}};}}});
 try{const result=await runOfficialAgent(imported.definition,task,shared,settings);assert.equal(result.answer,'49');assert(result.executedNodeIds.includes('main/recall'));assert(result.executedNodeIds.some(id=>id.startsWith('main/transform-')));}finally{await shared.close();}
 const unsupported=clone(old);unsupported.loop.transitions.agent={kind:'repeat',graphId:'agent',maxVisits:2,until:{source:{from:'literal',value:true},operator:'truthy'}};assert.throws(()=>migrateLegacyDefinition(unsupported),/single-pass/);
});

test('task-world baselines declare real Loop/tool/observation flow under official schema',()=>{
 for(const dataset of ['automationbench','bfcl'] as const){const d=validateOfficialDefinition(officialBaseline(dataset));assert(d.loop);assert.equal(expandedOfficialNodes(d).filter(n=>n.type==='INFER.REASONING.SAMPLE').length,1);}
});

test('same-round metadata repair can admit a previously rejected executable definition',async()=>{
 let calls=0;const proposal=child('interaction');
 const runtime:any={async run(){calls++;const current=clone(proposal);if(calls===1)current.mutation={primaryNodeId:'new-interaction',auxiliary:{bad:'not an array'}};return{proposal:{status:'success',output:{message:{content:JSON.stringify(current)}}}};}};
 const result=await searchOfficialWorkflows({runtime,model:{provider:'mock',model:'mock'},dataset:'drop',publicTasks:[task],expectedRepeats:1,maxValidEvaluations:2,maxDesignRounds:1,maxProposalAttempts:2,evaluate:async d=>summary(d)});
 assert.equal(calls,2);assert.deepEqual(result.state.history.map(r=>r.status),['valid','invalid-proposal','valid']);assert.equal(result.state.validEvaluations,2);
});

test('host app env keys are isolated while legacy native keys remain actionable errors',()=>{
 assert.doesNotThrow(()=>experimentRuntimeConfig({DITTO_PROVIDER_PYTHON:'offline-python',DITTO_BFCL_ROOT:'offline-bfcl'}));
 assert.throws(()=>experimentRuntimeConfig({DITTO_PROVIDER_UNKNOWN:'bad'}),/Legacy env key/);
});

test('primary CLI selects optional initialization only for Search and preserves frozen Test',()=>{
 const options=parseUnifiedArguments(['search','--dataset','bfcl','--initialization','pr7-guidance','--offline-only','true']);assert.equal(options.initialization,'pr7-guidance');
 assert.equal(parseUnifiedArguments(['search','--dataset','drop']).initialization,undefined);
 assert.throws(()=>parseUnifiedArguments(['test','--dataset','drop','--run-dir','frozen','--initialization','pr10-selected']),/frozen initialization/);
});


test('a delivery deadline returns the completed baseline with an explicit budget reason, never false convergence',async()=>{
 let calls=0;
 const result=await searchOfficialWorkflows({runtime:{async run(){calls++;throw Error('unexpected');}} as any,model:{provider:'fixture',model:'fixture'},dataset:'drop',publicTasks:[task],expectedRepeats:1,maxValidEvaluations:20,maxDesignRounds:100000,deadlineAt:0,evaluate:async d=>summary(d)});
 assert.equal(calls,0);assert.equal(result.state.validEvaluations,1);assert.equal(result.stoppedBecause,'walltime-budget');
});
