import assert from 'node:assert/strict';
import test from 'node:test';
import { createDitto, graph, graphStep, loop } from '@codesoul-co/ditto/runtime';
import { createInferWorker } from '@codesoul-co/ditto/worker/infer';
import { compileGeneratedWorkflowA, validateGeneratedWorkflowSource, GENERATED_A_GUIDE_VERSION } from './generated-workflow-a.mjs';

// Small fixtures verify the loader; these are not benchmark workflow candidates.
const fixture = `export default function createWorkflow(api) {
  const g = api.graph('solve').node('answer','INFER.REASONING.SAMPLE',[],task=>({messages:[{role:'user',content:task.prompt}]}));
  const definition = api.loop({id:'fixture',*plan(task){const result=yield* api.graphStep(g,task);return {answer:api.unwrap(result.answer).message.content};}});
  return {definition,outputNodeId:'answer'};
}`;
const capabilities = {graph,graphStep,loop,model:{provider:'fixture',model:'frozen'},generation:{temperature:0,maxTokens:393216},unwrap:value=>value.output??value,parseJson:JSON.parse};

test('A records real Graphs and explicit local bindings without a hand-authored plan',()=>{
  const loaded=compileGeneratedWorkflowA(fixture,capabilities);
  assert.deepEqual(loaded.plan.graphs,[{id:'solve',nodeIds:['answer']}]);
  const iterator=loaded.definition.plan({prompt:'PUBLIC QUESTION'});
  const call=iterator.next().value;
  const bound=call.graph.tasks[0].bind(call.input,{});
  assert.deepEqual(bound.model,capabilities.model);
  assert.deepEqual(bound.generation,capabilities.generation);
  assert.equal(bound.messages[0].content,'PUBLIC QUESTION');
  assert.equal(iterator.next({answer:{status:'success',output:{message:{content:'  public answer  '}}}}).value.answer,'public answer');
  assert.equal(loaded.trace[0].kind,'graph-start');
  assert.equal(loaded.trace.at(-1).kind,'graph-complete');
});

test('A rejects direct host APIs, import escapes and computed API access',()=>{
  for(const statement of ['process.env.KEY;','require("fs");','fetch("https://invalid.example");','api["graph"]("x");','({}).constructor;','import("node:fs");'])
    assert.throws(()=>validateGeneratedWorkflowSource(fixture.replace("const g =",`${statement} const g =`)),/Generated A validation/);
});

test('A rejects wrong local dependencies and forged plan records',()=>{
  assert.throws(()=>compileGeneratedWorkflowA(fixture.replace("SAMPLE',[]","SAMPLE',['missing']"),capabilities),/local dependencies/);
  const forged=fixture.replace("return {definition,outputNodeId:'answer'}","return {definition,outputNodeId:'answer',plan:{nodes:[],graphs:[]}}");
  assert.throws(()=>compileGeneratedWorkflowA(forged,capabilities),/claimed plan differs/);
});

test('A rejects model overrides at actual binding and tools outside the shared set',()=>{
  const override=fixture.replace("messages:[", "model:{provider:'other',model:'other'},messages:[");
  const loaded=compileGeneratedWorkflowA(override,capabilities);
  const call=loaded.definition.plan({prompt:'x'}).next().value;
  assert.throws(()=>call.graph.tasks[0].bind(call.input,{}),/model differs/);
  const tool=fixture.replace("'INFER.REASONING.SAMPLE'","'INTERACTION.ACT.TOOL'").replace("({messages:[{role:'user',content:task.prompt}]})","({call:{id:'x',name:'private_judge',arguments:{}}})");
  const loadedTool=compileGeneratedWorkflowA(tool,capabilities);
  const toolCall=loadedTool.definition.plan({prompt:'x'}).next().value;
  assert.throws(()=>toolCall.graph.tasks[0].bind(toolCall.input,{}),/outside the common capability/);
});

test('A factory construction timeout does not masquerade as a scored candidate',()=>{
  assert.throws(()=>compileGeneratedWorkflowA(fixture.replace("const g =","while(true){} const g ="),capabilities,{factoryTimeoutMs:20}),/timed out/);
});

test('A records checked inputs and raw outputs under the correct repeated Graph invocation',()=>{
  const repeated=fixture.replace('const result=yield* api.graphStep(g,task);',"let result; for(let index=0;index<2;index++){result=yield* api.graphStep(g,{prompt:task.prompt+String(index)});}");
  const loaded=compileGeneratedWorkflowA(repeated,capabilities);
  const iterator=loaded.definition.plan({prompt:'PUBLIC-'});
  const first=iterator.next().value;
  first.graph.tasks[0].bind(first.input,{});
  const rawFirst={status:'success',output:{message:{content:'first evidence'},usage:{totalTokens:4}}};
  const second=iterator.next({answer:rawFirst}).value;
  second.graph.tasks[0].bind(second.input,{});
  const rawSecond={status:'success',output:{message:{content:'second evidence'}}};
  assert.equal(iterator.next({answer:rawSecond}).value.answer,'second evidence');
  const calls=loaded.trace.filter(event=>event.kind==='node');
  assert.equal(calls.length,2);
  assert.deepEqual(calls.map(call=>call.invocation),[1,2]);
  assert.deepEqual(calls.map(call=>call.input.messages[0].content),['PUBLIC-0','PUBLIC-1']);
  assert.deepEqual(calls[0].output,rawFirst);
  assert.deepEqual(calls[1].output,rawSecond);
  rawFirst.output.message.content='later mutation';
  assert.equal(calls[0].output.output.message.content,'first evidence');
  assert.doesNotThrow(()=>JSON.stringify(loaded.trace));
  assert.match(GENERATED_A_GUIDE_VERSION,/input-shapes-and-trace/);
});

function inputFixture(type, inputExpression) {
  return `export default function createWorkflow(api) {
    const g=api.graph('shape').node('node','${type}',[],task=>(${inputExpression}));
    const definition=api.loop({id:'shape',*plan(task){yield* api.graphStep(g,task); return {answer:'fixture'};}});
    return {definition,outputNodeId:'node'};
  }`;
}
test('A explains malformed dynamic input shapes before any Worker call',()=>{
  for(const [type,input,error] of [
    ['CONTEXT.LOAD',"{sources:[task.prompt]}",/LOAD input.sources\[0\] must be an object/],
    ['INTERACTION.OBSERVE',"{result:{status:'success',output:{message:{content:'wrong envelope'}}}}",/OBSERVE input.result.callId/],
    ['INFER.REASONING.SAMPLE',"{messages:[{role:'user',content:{unsupported:'object'}}]}",/SAMPLE: Invalid message content/],
    ['INTERACTION.ACT.TOOL',"{call:{id:'x',name:'arithmetic',arguments:{expression:42}}}",/TOOL arithmetic.arguments.expression must be a nonempty string/],
  ]) {
    const loaded=compileGeneratedWorkflowA(inputFixture(type,input),capabilities);
    const iterator=loaded.definition.plan({prompt:'public'});
    const call=iterator.next().value;
    assert.throws(()=>call.graph.tasks[0].bind(call.input,{}),error);
    const record=loaded.trace.find(event=>event.kind==='node');
    assert.equal(record.invocation,1);
    assert.match(record.error.message,error);
    assert.doesNotThrow(()=>JSON.stringify(loaded.trace));
  }
});

test('A sends validated VM-created tool arguments as ordinary host JSON',()=>{
  const source=inputFixture('INTERACTION.ACT.TOOL',"{call:{id:'check',name:'text_contains',arguments:{text:task.prompt,fragment:'public',caseSensitive:false}}}");
  const loaded=compileGeneratedWorkflowA(source,{...capabilities,allowedTools:['text_contains']});
  const call=loaded.definition.plan({prompt:'public evidence'}).next().value;
  const input=call.graph.tasks[0].bind(call.input,{});
  assert.equal(Object.getPrototypeOf(input),Object.prototype);
  assert.equal(Object.getPrototypeOf(input.call.arguments),Object.prototype);
  assert.deepEqual(input.call.arguments,{text:'public evidence',fragment:'public',caseSensitive:false});
});

test('A retains Graph failures and raw failed Worker outputs as execution evidence',()=>{
  const loaded=compileGeneratedWorkflowA(fixture,capabilities);
  const iterator=loaded.definition.plan({prompt:'public'});
  const call=iterator.next().value;
  call.graph.tasks[0].bind(call.input,{});
  assert.throws(()=>iterator.throw(Object.assign(new Error('fixture Worker failed'),{code:'FIXTURE_FAILED'})),/fixture Worker failed/);
  assert.deepEqual(loaded.trace.at(-1),{kind:'graph-failed',graphId:'solve',invocation:1,error:{name:'Error',message:'fixture Worker failed',code:'FIXTURE_FAILED'}});
  const direct=compileGeneratedWorkflowA(inputFixture('INTERACTION.ACT.TOOL',"{call:{id:'x',name:'arithmetic',arguments:{expression:'1+1'}}}"),capabilities);
  const run=direct.definition.plan({prompt:'public'});const graphCall=run.next().value;
  graphCall.graph.tasks[0].bind(graphCall.input,{});
  const error={code:'FIXTURE_TOOL_ERROR',message:'fixture failure',retryable:false};
  const output={callId:'x',source:'arithmetic',status:'failed',error};
  run.next({node:output});
  assert.deepEqual(direct.trace.find(event=>event.kind==='node').output,output);
  assert.deepEqual(direct.trace.find(event=>event.kind==='node').error,error);
});

test('A beforeNode sees checked input and can stop execution before the Worker',()=>{
  let workerCalls=0;
  const stop=Object.assign(new Error('fixture request budget reached'),{code:'REQUEST_BUDGET_REACHED'});
  const loaded=compileGeneratedWorkflowA(fixture,{...capabilities,beforeNode(event){
    assert.equal(event.type,'INFER.REASONING.SAMPLE');
    assert.equal(event.nodeId,'answer');
    assert.equal(event.graphId,'solve');
    assert.equal(event.invocation,1);
    assert.deepEqual(event.input.model,capabilities.model);
    assert.equal(event.input.messages[0].content,'public input');
    throw stop;
  }});
  const iterator=loaded.definition.plan({prompt:'public input'});
  const call=iterator.next().value;
  assert.throws(()=>{
    const checked=call.graph.tasks[0].bind(call.input,{});
    workerCalls++;
    return checked;
  },error=>error===stop);
  assert.equal(workerCalls,0);
  const record=loaded.trace.find(event=>event.kind==='node');
  assert.equal(record.error.code,'REQUEST_BUDGET_REACHED');
  assert.equal(record.error.message,'fixture request budget reached');
  assert.deepEqual(record.input.model,capabilities.model);
  assert.equal(record.output,undefined);
});

test('A binds TRAJECTORY, DELIBERATE and REFLECT to real native Workers with complete input/output traces',async()=>{
  const calls=[];
  const runtime=createDitto({workers:[createInferWorker({defaultProvider:'fixture',providers:{fixture:{async invoke(input){
    calls.push(structuredClone(input));
    assert.deepEqual(input.model,capabilities.model);
    assert.deepEqual(input.generation,capabilities.generation);
    const first=String(input.messages[0].content);
    let content='native draft';
    if(first.startsWith('Compare the supplied candidates')) content=JSON.stringify({result:{role:'assistant',content:'ignored replacement'},selectedCandidateIds:['draft']});
    if(first.startsWith('Assess the supplied target')) content=JSON.stringify({assessment:{summary:'fixture revision'},issues:[],revisedResult:{role:'assistant',content:'native final'}});
    return {message:{role:'assistant',content},finishReason:'stop',usage:{totalTokens:4}};
  }}}})]});
  const source=`export default function createWorkflow(api) {
    const g=api.graph('infer-roundtrip')
      .node('trajectory','INFER.REASONING.TRAJECTORY',[],task=>({messages:[{role:'user',content:task.prompt}],strategy:{name:'cot',options:{rounds:1}}}))
      .node('decision','INFER.REASONING.DELIBERATE',['trajectory'],(task,{trajectory})=>({messages:[{role:'user',content:task.prompt}],mode:'select',candidates:[{id:'draft',result:api.unwrap(trajectory).result,trajectory:api.unwrap(trajectory).steps}]}))
      .node('reflection','INFER.REASONING.REFLECT',['decision'],(task,{decision})=>({messages:[{role:'user',content:task.prompt}],mode:'revise',target:{result:api.unwrap(decision).result},criteria:[{id:'format',description:'Follow the public requested format'}]}));
    const definition=api.loop({id:'native-roundtrip',*plan(task){const result=yield* api.graphStep(g,task);return {answer:api.unwrap(result.reflection).revisedResult.content};}});
    return {definition,outputNodeId:'reflection'};
  }`;
  try {
    const compiled=compileGeneratedWorkflowA(source,capabilities);
    const result=await runtime.loop(compiled.definition,{prompt:'Public fixture question'});
    assert.equal(result.answer,'native final');
    assert.equal(calls.length,3);
    assert.deepEqual(calls.map(call=>call.metadata.nodeType),['INFER.REASONING.TRAJECTORY','INFER.REASONING.DELIBERATE','INFER.REASONING.REFLECT']);
    const trace=compiled.trace.filter(event=>event.kind==='node');
    assert.equal(trace[0].input.constraints.maxSteps,Number.MAX_SAFE_INTEGER);
    assert.equal(trace[0].output.output.status,'completed');
    assert.equal(trace[1].input.candidates[0].trajectory.at(-1).type,'final');
    assert.equal(trace[1].output.output.result.content,'native draft');
    assert.equal(trace[2].input.target.result.content,'native draft');
    assert.equal(trace[2].output.output.revisedResult.content,'native final');
    assert.deepEqual(trace.map(event=>event.input.metadata.nodeId),['trajectory','decision','reflection']);
  } finally { await runtime.close(); }
});
