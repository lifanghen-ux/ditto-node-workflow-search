import assert from 'node:assert/strict';
import test from 'node:test';
import type {BenchmarkTask,CaseResult} from '../domain.js';
import {buildUnifiedFeedback,traceValue,selectPublicTraceEvents,publicBfclFunctionCatalogue,publicBfclTurnEvidence,type FeedbackEvaluation} from '../unified/feedback.js';
import {EvaluationTraceView,selectionEvaluation} from '../unified/evidence.js';
import {publicEvaluationContract} from '../benchmark/evaluation-contract.js';
import {searchObjective} from '../unified/search-objective.js';

const task:BenchmarkTask={id:'public:1',dataset:'mbpp',prompt:'Write a function from this public specification.',outputInstruction:'Return Python code.',metadata:{}};
test('failed executable checks retain their real diagnostics before large code or conversation copies',()=>{
 const event={nodeId:'probe',nodeType:'INTERACTION.ACT.TOOL',input:{call:{name:'public_python_check',arguments:{source:'x'.repeat(10000),entryPoint:'f',checks:"def check(): f('abc')"}}},
  publicDiagnostics:[{code:'PUBLIC_CHECK_FAILED',message:'Executed public check failed.'}],
  output:{callId:'probe',source:'public_python_check',status:'success',structuredContent:{passed:false,diagnostics:'ValueError: cannot convert a letter'}}};
 const events=[{nodeId:'first'},event,...Array.from({length:30},(_,i)=>({nodeId:'later'+i,nodeType:'HOST.DATA.TRANSFORM',output:'fallback'}))];
 const selected=selectPublicTraceEvents(events);assert(selected.some((row:any)=>row.nodeId==='probe'));
 const compact=JSON.stringify(traceValue(event,1200));assert.match(compact,/ValueError/);assert.match(compact,/def check/);
 const bfcl=traceValue({callId:'submit',source:'bfcl_respond',status:'success',structuredContent:{history:'x'.repeat(10000),completionCheck:{passed:false,checks:[{actual:50,target:40}]}}},1200);
 assert.match(JSON.stringify(bfcl),/"actual":50/);assert.match(JSON.stringify(bfcl),/"target":40/);
});
test('imported search roots retain verified paired measurement regressions separately from search ancestry',()=>{
 const before={...evaluation('old code'),score:1,results:evaluation('old code').results.map(row=>({...row,score:1}))};
 const after={...evaluation('new code'),comparisonParentId:'measured-before'};
 const packet=buildUnifiedFeedback([
  {id:'measured-before',parentId:null,status:'valid',evaluation:before},
  {id:'measured-after',parentId:null,status:'valid',evaluation:after}
 ],[task]);
 const row=packet.feedback.find(row=>row.id==='measured-after')!;
 assert.equal(row.parentId,null);assert.equal(row.paired.referenceId,'measured-before');
 assert.equal(row.paired.regressedTasks,1);assert.equal(row.paired.meanScoreDelta,-1);
 assert.equal(row.cases[0]!.outcomes[0]!.parentOutcome!.prediction.text,'old code');
 assert.doesNotMatch(JSON.stringify(packet),/PRIVATE-ANSWER/);
});
test('new regressions and an unchanged passing control precede ordinary repeated failures',()=>{
 const tasks=Array.from({length:8},(_,i)=>({...task,id:'public:'+String(i).padStart(2,'0')}));
 const make=(scores:number[])=>({...evaluation('public code'),score:scores.reduce((a,b)=>a+b,0)/8,examples:8,
  results:tasks.map((t,i)=>({...evaluation('public code').results[0]!,caseId:t.id+'#1',score:scores[i]!}))});
 const before=make([1,0,0,0,0,1,1,1]),after={...make([0,0,0,0,1,1,0,0]),comparisonParentId:'before'};
 const packet=buildUnifiedFeedback([{id:'before',parentId:null,status:'valid',evaluation:before},
  {id:'after',parentId:null,status:'valid',evaluation:after}],tasks);
 const child=packet.feedback.find(row=>row.id==='after')!;
 assert.equal(child.paired.regressedTasks,3);
 for(const id of ['public:00','public:06','public:07','public:04','public:05'])assert(child.cases.some(row=>row.taskId===id));
 assert(child.cases.length<=6);assert.doesNotMatch(JSON.stringify(packet),/PRIVATE-ANSWER/);
});
test('bounded feedback keeps the actual Loop assignment that discarded a Graph result',()=>{
 const events=Array.from({length:30},(_,i)=>({nodeId:'bookkeeping-'+i,nodeType:'HOST.DATA.TRANSFORM',output:i}));
 (events as any[])[15]={nodeId:'final',nodeType:'HOST.DATA.TRANSFORM',output:'PUBLIC-GRAPH-ANSWER'};
 (events as any[])[16]={nodeId:'@loop:solve:1',nodeType:'HOST.LOOP.BOUNDARY',
  publicDiagnostics:[{code:'LOOP_RESULT_SHAPE_MISMATCH',sourceNodeId:'main/@loop:solve',message:'result.final used its default on a string Graph result.'}],
  output:{step:'solve',iteration:1,result:'PUBLIC-GRAPH-ANSWER',state:{final:'',expected:'PRIVATE-ANSWER',apiKey:'SECRET'}}};
 const view=new EvaluationTraceView([task.id],1);view.add({taskId:task.id,caseId:task.id+'#1',events});
 const packet=buildUnifiedFeedback([{id:'candidate',parentId:null,status:'valid',evaluation:evaluation('',view.views(evaluation('').results))}],[task]);
 const text=JSON.stringify(packet);assert.match(text,/PUBLIC-GRAPH-ANSWER/);assert.match(text,/LOOP_RESULT_SHAPE_MISMATCH/);
 assert.doesNotMatch(text,/PRIVATE-|SECRET/);
});
test('public BFCL API declarations survive large observations without inventing a recommended action',()=>{
 const catalogue=publicBfclFunctionCatalogue([{output:{source:'bfcl_state',structuredContent:{functions:[
  {name:'create',description:'Shared boilerplate. Tool description: Create the requested resource.',parameters:{properties:{title:{type:'string'},quantity:{type:'integer'}},required:['title']}},
  {name:'read',description:'Read one resource.',parameters:{properties:{id:{type:'integer'}},required:['id']}}
 ],observations:['x'.repeat(50000)],privateAnswer:'PRIVATE-ANSWER'}}}]) as any;
 assert.equal(catalogue.functions.length,2);assert.deepEqual(catalogue.functions[0].required,['title']);
 assert.equal(catalogue.functions[0].description,'Create the requested resource.');assert.equal(catalogue.truncated,false);
 assert.doesNotMatch(JSON.stringify(catalogue),/PRIVATE-|recommended|xxxxx/);
});
test('BFCL repair feedback retains additive parameter semantics, return units and defaults',()=>{
 const catalogue=publicBfclFunctionCatalogue([{output:{source:'bfcl_state',structuredContent:{functions:[
  {name:'fill',description:'Fill the tank.',parameters:{properties:{amount:{type:'float',description:'Additional fuel to add, in gallons.'},mode:{type:'string',default:'add',enum:['add','replace']}},required:['amount']},
   response:{type:'dict',properties:{fuelLevel:{type:'float',description:'The resulting total fuel level in gallons.'}}}}
 ]}}}]) as any;
 const fn=catalogue.functions[0];
 assert.equal(fn.parameters.amount.description,'Additional fuel to add, in gallons.');
 assert.equal(fn.parameters.mode.default,'add');assert.deepEqual(fn.parameters.mode.enum,['add','replace']);
 assert.equal(fn.response.properties.fuelLevel.description,'The resulting total fuel level in gallons.');
});
test('bounded BFCL catalogue prioritizes actual calls after many unused declarations',()=>{
 const functions=Array.from({length:40},(_,i)=>({name:'unused'+i,description:'Unrelated public operation. '.repeat(20),parameters:{properties:{name:{type:'string',description:'Public name. '.repeat(20)}}}}));
 functions.push({name:'measure',description:'Measure a public distance.',parameters:{properties:{name:{type:'string',description:'The requested destination zipcode.'}}}});
 const catalogue=publicBfclFunctionCatalogue([
  {output:{source:'bfcl_state',structuredContent:{functions}}},
  {input:{call:{name:'bfcl_call',arguments:{calls:[{name:'measure',arguments:{name:'12345'}}]}}},output:{source:'bfcl_call',structuredContent:{observations:['public result']}}}
 ],2000) as any;
 assert.equal(catalogue.functions[0].name,'measure');
 assert.equal(catalogue.functions[0].parameters.name.description,'The requested destination zipcode.');
 assert.equal(catalogue.truncated,true);assert(JSON.stringify(catalogue).length<=2000);
 assert.doesNotMatch(JSON.stringify(catalogue),/recommended|12345/);
});
test('rejected BFCL requests are not reported as executed business calls or submitted turns',()=>{
 const event=(name:string,args:unknown,body:unknown)=>({input:{call:{name,arguments:args}},output:{source:name,status:'success',structuredContent:body}});
 const evidence=publicBfclTurnEvidence([
  event('bfcl_call',{turn:0,calls:[{name:'lookup',arguments:{id:1}}]},{turn:0,error:'Unavailable function: lookup'}),
  event('bfcl_call',{turn:0,calls:[{name:'read',arguments:{id:1}}]},{turn:0,observations:['real response']}),
  event('bfcl_respond',{turn:0,message:'done'},{turn:1,history:[],functions:[],complete:false}),
  event('bfcl_respond',{turn:1,message:'again'},{complete:true,error:'Conversation ended'})
 ]) as any;
 assert.equal(evidence.turns[0].actions[0].status,'rejected');assert.equal(evidence.turns[0].actions[0].publicError,'Unavailable function: lookup');
 assert.equal(evidence.turns[0].actions[1].status,'executed');assert.equal(evidence.turns[0].submissions,1);
 assert(!evidence.turns.some((turn:any)=>turn.turn===1&&turn.submissions>0));
});
test('later feedback pages expose additional public failures while retaining a successful control',()=>{
 const tasks=Array.from({length:18},(_,i)=>({...task,id:'public:'+String(i).padStart(2,'0')}));
 const base=evaluation('public implementation');
 const results=tasks.map((t,i)=>({...base.results[0]!,caseId:t.id+'#1',score:i===17?1:0}));
 const record={id:'measured',parentId:null,status:'valid',evaluation:{...base,results,examples:18}};
 const page=(offset:number)=>buildUnifiedFeedback([record],tasks,{failureOffset:offset}).feedback[0]!.cases.map(row=>row.taskId);
 assert(page(0).includes('public:17'));assert(page(8).includes('public:17'));
 assert(page(8).includes('public:08'));assert(!page(0).includes('public:08'));
});
test('quality recovery distinguishes repeated business execution from cosmetic replies and changed arguments',()=>{
 const bfcl={...task,dataset:'bfcl' as const};
 const measured=(id:string,key:string,reply:string)=>{
  const events=[{nodeType:'INTERACTION.ACT.TOOL',input:{call:{name:'bfcl_call',arguments:{turn:0,calls:[{name:'lookup',arguments:{key}}]}}},output:{source:'bfcl_call',status:'success',structuredContent:{turn:0,observations:['public result']}}},
   {nodeType:'INTERACTION.ACT.TOOL',input:{call:{name:'bfcl_respond',arguments:{turn:0,message:reply}}},output:{source:'bfcl_respond',status:'success',structuredContent:{turn:1,complete:true}}}];
  const view=new EvaluationTraceView([task.id],1);view.add({taskId:task.id,caseId:task.id+'#1',events});
  return{id,parentId:null,status:'valid',evaluation:evaluation(reply,view.views(evaluation(reply).results))};
 };
 const history=[measured('one','a','first'),measured('two','a','rewritten'),measured('three','b','rewritten')];
 const packet=buildUnifiedFeedback(history,[bfcl]);
 assert.deepEqual(packet.feedback[0]!.cases[0]!.executionComparison?.sameSequenceAs,[{candidateId:'two',caseId:task.id+'#1'}]);
 assert.deepEqual(packet.feedback[2]!.cases[0]!.executionComparison?.sameSequenceAs,[]);
 const objective=searchObjective(history);assert.equal(objective.mode,'quality-recovery');assert.equal(objective.consecutiveMeasurementsWithoutQualityImprovement,2);
 assert.equal(searchObjective([{...history[0]!,evaluation:{...history[0]!.evaluation,score:1}}]).mode,'cost-reduction');
 assert.doesNotMatch(JSON.stringify(packet),/PRIVATE-ANSWER/);
});
test('optimizer feedback describes the actually scored BFCL artifact instead of treating projected final text as the score target',()=>{
 const bfcl={...task,dataset:'bfcl' as const};
 const packet=buildUnifiedFeedback([{id:'candidate',parentId:null,status:'valid',evaluation:evaluation('finished')}],[bfcl]);
 assert.equal(packet.evaluationContract?.scoredArtifact,'executed-official-world-snapshot');
 assert.equal(packet.evaluationContract?.finalAnswerProjectionScored,false);
 assert.equal(publicEvaluationContract('mbpp').scoredArtifact,'extracted-python-implementation');
 assert.equal(publicEvaluationContract('drop').scoredArtifact,'final-answer-text');
 assert.doesNotMatch(JSON.stringify(packet),/PRIVATE-ANSWER/);
});
function evaluation(prediction:string,publicTraces:readonly unknown[]=[]):FeedbackEvaluation{
 const row:CaseResult={caseId:task.id+'#1',valid:true,score:0,prediction,normalizedPrediction:prediction,
  expected:'PRIVATE-ANSWER',normalizedExpected:'PRIVATE-ANSWER',method:'fixture',latencyMs:1,inputTokens:1,outputTokens:1,totalTokens:2};
 return{valid:true,score:0,standardDeviation:0,examples:1,repeats:1,results:[row],successfulRuns:1,failedRuns:0,timeoutRuns:0,wrongRuns:1,inputTokens:1,outputTokens:1,totalTokens:2,durationMs:1,publicTraces};
}

test('feedback retains native tool business errors without admitting scorer diagnostics or secret fields',()=>{
 const native={callId:'public-call',source:'bfcl_call',status:'success',content:'x'.repeat(5000),structuredContent:{error:{message:'No contact with id 42',expected:'PRIVATE-TOOL',authorization:'SECRET'},publicValue:42}};
 const packet=traceValue({error:'PRIVATE-SCORER',output:native,other:{error:'PRIVATE-OTHER'},previousResults:[{error:'PRIVATE-OLD'}]},4000);
 const text=JSON.stringify(packet);
 assert.match(text,/No contact with id 42/);assert.match(text,/publicValue/);
 assert.doesNotMatch(text,/PRIVATE-|SECRET|previousResults/);
 assert.match(JSON.stringify(traceValue({...native,status:'failed',error:{code:'TOOL_ERROR',message:'Bad arguments'}})),/Bad arguments/);
 assert.doesNotMatch(JSON.stringify(traceValue({source:'fake',status:'failed',error:'PRIVATE-NOT-NATIVE'})),/PRIVATE-/);
});

test('bounded feedback keeps a complete medium Python answer and the middle of a DROP passage',()=>{
 const code='def answer(value):\n'+('    # public implementation detail\n'.repeat(45))+'    return value + 1\n';
 const summary=selectionEvaluation(evaluation(code),'fixture');
 const packet=buildUnifiedFeedback([{id:'candidate',parentId:null,status:'valid',evaluation:summary}],[task]);
 assert.equal(packet.feedback[0]!.cases[0]!.outcomes[0]!.prediction.text,code);
 assert.equal(packet.feedback[0]!.cases[0]!.outcomes[0]!.prediction.truncated,false);
 const drop={...task,dataset:'drop' as const,prompt:'Passage: '+('a'.repeat(3100))+' PUBLIC-MIDDLE-EVIDENCE '+('b'.repeat(3100))+'\nQuestion: What happened?'};
 const dropPacket=buildUnifiedFeedback([{id:'candidate',parentId:null,status:'valid',evaluation:evaluation('42')}],[drop]);
 assert.match(dropPacket.feedback[0]!.cases[0]!.prompt.text,/PUBLIC-MIDDLE-EVIDENCE/);
 assert(JSON.stringify(dropPacket).length<=60000);assert.doesNotMatch(JSON.stringify(packet),/PRIVATE-ANSWER/);
});

test('selection and feedback retain late action inputs and their observations instead of bookkeeping only',()=>{
 const events=Array.from({length:30},(_,i)=>({nodeId:'bookkeeping-'+i,nodeType:'HOST.DATA.TRANSFORM',output:{value:i}}));
 events[18]={nodeId:'reason',nodeType:'INFER.REASONING.SAMPLE',output:{value:18}};
 (events as any[])[19]={nodeId:'call',nodeType:'INTERACTION.ACT.TOOL',input:{call:{id:'late-call',name:'bfcl_call',arguments:{turn:3,calls:[{name:'write_file',arguments:{content:'PUBLIC-LAST-QUESTION'}}]}}},
  output:{callId:'late-call',source:'bfcl_call',status:'success',structuredContent:{error:{message:'PUBLIC-TOOL-ERROR'}}}};
 (events as any[])[20]={nodeId:'observe',nodeType:'INTERACTION.OBSERVE',output:structuredClone((events as any[])[19].output)};
 for(const index of [24,27]){
  (events as any[])[index]={nodeId:'reply-reason',nodeType:'INFER.REASONING.SAMPLE',output:{message:'finish'}};
  (events as any[])[index+1]={nodeId:'reply',nodeType:'INTERACTION.ACT.TOOL',input:{call:{id:'reply-'+index,name:'bfcl_respond',arguments:{message:'done'}}},output:{callId:'reply-'+index,source:'bfcl_respond',status:'success'}};
 }
 const view=new EvaluationTraceView([task.id],1);view.add({taskId:task.id,caseId:task.id+'#1',events});
 const summary=evaluation('finished',view.views(evaluation('finished').results));
 const packet=buildUnifiedFeedback([{id:'candidate',parentId:null,status:'valid',evaluation:summary}],[task]);
 const text=JSON.stringify(packet);assert.match(text,/PUBLIC-LAST-QUESTION/);assert.match(text,/PUBLIC-TOOL-ERROR/);
 const run=(packet.feedback[0]!.cases[0] as any).trace.runs[0];
 const action=run.events.find((event:any)=>event.nodeId==='call');assert.equal(action.eventIndex,19);
 assert(run.events.some((event:any)=>event.nodeId==='reason'));assert(run.events.length<=6);
 assert.deepEqual(run.events.map((event:any)=>event.eventIndex),run.events.map((event:any)=>event.eventIndex).toSorted((a:number,b:number)=>a-b));
 assert(text.length<=60000);
});

test('BFCL feedback retains the revealed middle-turn request and action independently of the last event window',()=>{
 const events:any[]=[],history:any[]=[];
 const action=(name:string,args:any,result:any)=>events.push({nodeType:'INTERACTION.ACT.TOOL',input:{call:{id:'reused',name,arguments:args}},output:{callId:'reused',source:name,status:'success',structuredContent:result}});
 for(let turn=0;turn<4;turn++){
  history.push({role:'user',content:turn===2?'PUBLIC-MIDDLE: retrieve this ticket':'PUBLIC-TURN-'+turn});
  action('bfcl_state',{}, {turn,complete:false,history:structuredClone(history),functions:[{name:'list_tickets'},{name:'read_ticket'}]});
  action('bfcl_call',{turn,calls:[{name:turn===2?'list_tickets':'some_action',arguments:{id:turn}}]}, {turn,observations:['PUBLIC-RESULT-'+turn],observationShapes:[{observed:{kind:'array'},declaredKind:'object'}]});
  action('bfcl_respond',{turn,message:'finished '+turn},{turn:turn+1,complete:turn===3});
 }
 for(let i=0;i<20;i++)events.push({nodeType:'HOST.DATA.TRANSFORM',output:'bookkeeping'});
 const view=new EvaluationTraceView([task.id],1);view.add({taskId:task.id,caseId:task.id+'#1',events,expected:'PRIVATE-ANSWER'});
 const summary=evaluation('finished',view.views(evaluation('finished').results));
 const packet=buildUnifiedFeedback([{id:'candidate',parentId:null,status:'valid',evaluation:summary}],[task]);
 const run=(packet.feedback[0]!.cases[0] as any).trace.runs[0],text=JSON.stringify(run);
 assert.match(text,/PUBLIC-MIDDLE/);assert.match(text,/list_tickets/);assert.match(text,/PUBLIC-RESULT-2/);
 assert.match(text,/read_ticket/);assert.doesNotMatch(text,/PRIVATE-ANSWER/);
 assert.equal(run.bfclTurns.turns.length,4);assert(run.events.length<=6);assert(text.length<8000);
 const fullSplitView=new EvaluationTraceView([task.id,...Array.from({length:199},(_,i)=>'other-'+i)],1);
 fullSplitView.add({taskId:task.id,caseId:task.id+'#1',events});
 const compact=fullSplitView.views(evaluation('finished').results)[0] as any;
 assert.equal(compact.bfclTurns.turns.length,4);assert(JSON.stringify(compact).length<4745);
});
