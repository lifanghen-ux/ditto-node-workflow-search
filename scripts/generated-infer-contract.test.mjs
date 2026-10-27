import assert from 'node:assert/strict';
import test from 'node:test';
import { createDitto } from '@codesoul-co/ditto/runtime';
import { createInferWorker } from '@codesoul-co/ditto/worker/infer';
import { SUPPORTED_INFER_TYPES, INFER_INPUT_FIELDS, validateGeneratedInferInput } from './generated-infer-contract.mjs';

const type = name => `INFER.REASONING.${name}`;
const capabilities = { model:{provider:'fixture',model:'frozen'},generation:{temperature:0,maxTokens:393216} };
const message = content => ({role:'assistant',content});
const messages = [{role:'user',content:'Public interface fixture. Return the answer.'}];
const candidates = [{id:'first',result:message('original first')},{id:'second',result:message('original second')}];
const inputs = {
  SAMPLE:{messages},
  TRAJECTORY:{messages,strategy:{name:'cot',options:{rounds:1}}},
  DELIBERATE:{messages,candidates},
  REFLECT:{messages,target:{result:message('original')},mode:'verify'},
};
function mockReply(input) {
  const first = String(input.messages[0]?.content);
  if (first.startsWith('Compare the supplied candidates')) {
    const payload = JSON.parse(input.messages.at(-1).content);
    return JSON.stringify({result:message('native merged result'),
      ...(payload.mode === 'select' ? {selectedCandidateIds:payload.candidates.slice(0,payload.selectCount).map(item=>item.id)} : {}),
      decisionSummary:'mock provider native decision'});
  }
  if (first.startsWith('Assess the supplied target')) {
    const payload = JSON.parse(input.messages.at(-1).content);
    return JSON.stringify({assessment:{summary:'native assessment',passed:false},
      issues:[{severity:'warning',description:'public fixture issue',suggestedFix:'public fixture fix'}],
      ...(payload.mode === 'revise' ? {revisedResult:message('native revised result')} : {})});
  }
  if (String(input.messages.at(-1).content).includes('"solutionSummary"')) return JSON.stringify({solutionSummary:'public summary',answer:'consistent answer'});
  return 'native public answer';
}
async function harness(run, reply = mockReply) {
  const calls=[];
  const runtime=createDitto({workers:[createInferWorker({defaultProvider:'fixture',providers:{fixture:{async invoke(input) {
    calls.push(structuredClone(input));
    assert.deepEqual(input.model,capabilities.model);
    assert.deepEqual(input.generation,capabilities.generation);
    return {message:message(reply(input,calls.length)),finishReason:'stop',usage:{inputTokens:2,outputTokens:3,totalTokens:5}};
  }}}})]});
  try { await run(runtime,calls); } finally { await runtime.close(); }
}

test('shared native validator exposes the complete four published Infer input field sets',()=>{
  assert.equal(SUPPORTED_INFER_TYPES.length,4);
  assert.ok(INFER_INPUT_FIELDS[type('SAMPLE')].includes('actions'));
  assert.ok(INFER_INPUT_FIELDS[type('TRAJECTORY')].includes('memory'));
  assert.ok(INFER_INPUT_FIELDS[type('DELIBERATE')].includes('selectCount'));
  assert.ok(INFER_INPUT_FIELDS[type('REFLECT')].includes('criteria'));
  assert.equal(Object.isFrozen(INFER_INPUT_FIELDS[type('REFLECT')]),true);
});

test('all five native trajectory strategies execute through a real installed Worker with fixed per-call settings',async()=>{
  await harness(async(runtime,calls)=>{
    for(const [name,options,expectedCalls] of [
      ['cot',{rounds:2},2],['long-cot',{},4],['self-consistency',{candidates:3},3],
      ['tot',{breadth:2,depth:2,beamWidth:1},6],['got',{breadth:2,depth:2},6],
    ]) {
      const start=calls.length;
      const checked=validateGeneratedInferInput(type('TRAJECTORY'),{messages,strategy:{name,options}},capabilities);
      assert.equal(checked.constraints.maxSteps,Number.MAX_SAFE_INTEGER);
      const result=await runtime.invoke(type('TRAJECTORY'),checked);
      assert.equal(result.status,'success',JSON.stringify(result));
      assert.equal(result.output.status,'completed');
      assert.equal(result.output.stopReason,'completed');
      assert.equal(result.output.result.role,'assistant');
      assert.equal(calls.length-start,expectedCalls);
      assert.equal(result.output.usage.totalTokens,expectedCalls*5);
      assert.equal(result.output.steps.at(-1).type,'final');
      assert.ok(result.output.steps.filter(step=>step.type==='model').length===expectedCalls);
      assert.ok(calls.slice(start).every(call=>call.metadata.nodeType===type('TRAJECTORY')));
    }
  });
});

test('all four native deliberate modes preserve native selected-message semantics including selectCount',async()=>{
  await harness(async(runtime,calls)=>{
    for(const mode of [undefined,'select','merge','consensus','debate']) {
      const checked=validateGeneratedInferInput(type('DELIBERATE'),{messages,candidates,...(mode?{mode}:{}),
        ...(mode==='select'?{selectCount:2}:{})},capabilities);
      const result=await runtime.invoke(type('DELIBERATE'),checked);
      assert.equal(result.status,'success',JSON.stringify(result));
      assert.equal(result.output.result.content,!mode||mode==='select'?'original first':'native merged result');
      if(mode==='select') assert.deepEqual(result.output.selectedCandidateIds,['first','second']);
      const payload=JSON.parse(calls.at(-1).messages.at(-1).content);
      assert.deepEqual(payload.messages,messages);
      assert.equal(payload.mode,mode??'select');
    }
  });
});

test('all three native reflection modes roundtrip target, criteria and false verdict without inventing a revised answer',async()=>{
  await harness(async(runtime,calls)=>{
    for(const mode of ['critique','verify','revise']) {
      const input={messages,target:{result:message('original'),artifact:{public:true}},mode,
        criteria:[{id:'criterion',description:'Check the public fixture',weight:0}],
        context:[{id:'context',content:{public:'data'},source:'public-source',score:0}],
        memory:[{id:'memory',content:'public memory',timestamp:0}],metadata:{nodeType:'spoofed',custom:'retained'}};
      const checked=validateGeneratedInferInput(type('REFLECT'),input,capabilities,{nodeId:'actual-node'});
      assert.equal(checked.metadata.nodeType,type('REFLECT'));
      const result=await runtime.invoke(type('REFLECT'),checked);
      assert.equal(result.status,'success',JSON.stringify(result));
      assert.equal(result.output.assessment.passed,false);
      assert.equal(result.output.issues[0].severity,'warning');
      assert.equal(result.output.revisedResult?.content,mode==='revise'?'native revised result':undefined);
      assert.equal(result.output.result,undefined);
      const payload=JSON.parse(calls.at(-1).messages.at(-1).content);
      for(const key of ['messages','target','criteria','context','memory']) assert.deepEqual(payload[key],input[key]);
      assert.equal(calls.at(-1).metadata.nodeId,'actual-node');
      assert.equal(calls.at(-1).metadata.custom,'retained');
    }
  });
});

test('native input errors and all frozen settings are checked before Worker dispatch',()=>{
  for(const [name,input] of Object.entries(inputs)) {
    assert.throws(()=>validateGeneratedInferInput(type(name),{...input,model:{model:'other'}},capabilities),/model differs/);
    assert.throws(()=>validateGeneratedInferInput(type(name),{...input,generation:{temperature:1}},capabilities),/generation differs/);
    assert.throws(()=>validateGeneratedInferInput(type(name),{...input,metadata:null},capabilities),/metadata must be an object/);
    assert.throws(()=>validateGeneratedInferInput(type(name),{...input,handwrittenOption:true},capabilities),/not a published input field/);
  }
  const validate=(name,changes)=>validateGeneratedInferInput(type(name),{...inputs[name],...changes},capabilities);
  for(const value of [16,0,2.5]) assert.throws(()=>validate('TRAJECTORY',{constraints:{maxSteps:value}}),/maxSteps differs/);
  assert.throws(()=>validate('TRAJECTORY',{constraints:{maxTotalTokens:10}}),/override frozen/);
  assert.throws(()=>validate('TRAJECTORY',{constraints:{timeoutMs:2**31}}),/timeoutMs is out of range/);
  for(const strategy of [{name:'unknown'},{name:'constructor'},{name:'cot',options:{rounds:65}},{name:'tot',options:{breadth:17}},{name:'self-consistency',options:{candidates:0}}])
    assert.throws(()=>validate('TRAJECTORY',{strategy}),/unknown native strategy|out of range/);
  assert.throws(()=>validate('TRAJECTORY',{strategy:'cot'}),/strategy must be an object/);
  assert.throws(()=>validate('DELIBERATE',{candidates:[candidates[0],candidates[0]]}),/Duplicate candidate ID/);
  assert.throws(()=>validate('DELIBERATE',{mode:'merge',selectCount:1}),/selectCount requires select mode/);
  assert.throws(()=>validate('DELIBERATE',{selectCount:3}),/selectCount is out of range/);
  assert.throws(()=>validate('REFLECT',{criteria:['wrong shape']}),/must be an object/);
  assert.throws(()=>validate('REFLECT',{target:{}}),/target requires/);
  assert.throws(()=>validate('REFLECT',{target:{result:{status:'success',output:{}}}}),/Invalid message role/);
});

test('native failures retain malformed output and tied self-consistency semantics',async()=>{
  await harness(async(runtime)=>{
    const checked=validateGeneratedInferInput(type('REFLECT'),inputs.REFLECT,capabilities);
    const result=await runtime.invoke(type('REFLECT'),checked);
    assert.equal(result.status,'failed');
    assert.equal(result.error.code,'INVALID_MODEL_OUTPUT');
    assert.equal(result.output,undefined);
  },()=>'{"assessment":{"summary":"missing required passed"},"issues":[]}');
  await harness(async(runtime)=>{
    const checked=validateGeneratedInferInput(type('TRAJECTORY'),{messages,strategy:{name:'self-consistency',options:{candidates:2}}},capabilities);
    const result=await runtime.invoke(type('TRAJECTORY'),checked);
    assert.equal(result.status,'failed');
    assert.equal(result.error.code,'NO_CONSENSUS');
    assert.equal(result.output.status,'partial');
    assert.equal(result.output.stopReason,'error');
  },(_input,count)=>JSON.stringify({answer:`different ${count}`}));
});

test('validator preserves native JSON content arrays, optional omissions, and host JSON prototypes',()=>{
  const checked=validateGeneratedInferInput(type('SAMPLE'),{messages:[{role:'user',content:[{arbitrary:'native array item'}],metadata:{public:true}}],metadata:undefined},capabilities);
  assert.deepEqual(checked.messages[0].content,[{arbitrary:'native array item'}]);
  assert.equal(Object.getPrototypeOf(checked),Object.prototype);
  assert.equal(Object.getPrototypeOf(checked.messages[0]),Object.prototype);
  assert.throws(()=>validateGeneratedInferInput(type('REFLECT'),{...inputs.REFLECT,target:{artifact:()=>false}},capabilities),/only JSON data/);
});
