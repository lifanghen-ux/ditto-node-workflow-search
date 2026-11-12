import assert from 'node:assert/strict';
import test from 'node:test';
import {transformOfficialData} from '../official-agent/helpers.js';
import {runOfficialAgent} from '../official-agent/executor.js';
import {createExperimentRuntime} from '../ditto/runtime.js';
import {validateNativeLiteral} from '../official-agent/native-validation.js';
import {NATIVE_CONTRACTS,nativeOutputSchema} from '../official-agent/native-contracts.js';
import {loopResultDiagnostics} from '../official-agent/dataflow-diagnostics.js';

test('text can preserve absence for coalesce without changing valid falsy values or literal null text',()=>{
 assert.equal(transformOfficialData({operation:'text',value:null}),'null');
 for(const value of [null,undefined])assert.equal(transformOfficialData({operation:'text',value,preserveNull:true}),null);
 for(const [value,expected] of [[0,'0'],[false,'false'],['',''],['null','null']] as const)
  assert.equal(transformOfficialData({operation:'text',value,preserveNull:true}),expected);
 assert.throws(()=>transformOfficialData({operation:'text',value:null,preserveNull:'true'}),/preserveNull/);
 const schema=NATIVE_CONTRACTS['HOST.DATA.TRANSFORM']!.inputSchema;
 assert.throws(()=>validateNativeLiteral({operation:'text',value:null,preserveNull:'true'},schema,'/input'),/boolean/);
 assert.deepEqual(nativeOutputSchema('HOST.DATA.TRANSFORM',{operation:'text',preserveNull:true}).anyOf,[{type:'string'},{type:'null'}]);
});

test('runtime diagnoses a null serialization shadowing a real fallback and preserves the corrected data flow',async()=>{
 const settings={baseUrl:'https://example.invalid',apiKey:'offline',model:'mock',concurrency:1,timeoutMs:3000};
 const task={id:'public-null-flow',dataset:'drop' as const,prompt:'A public entity question.',outputInstruction:'',metadata:{}};
 const shared=createExperimentRuntime(settings,{provider:{async invoke(){throw Error('No model call needed');}}});
 const definition:any={version:1,id:'null-flow',graphs:{main:{nodes:[
  {id:'render',type:'HOST.DATA.TRANSFORM',input:{operation:'text',value:null}},
  {id:'final',type:'HOST.DATA.TRANSFORM',dependsOn:['render'],input:{operation:'coalesce',value:[{$ref:'nodes.render'},'public fallback']}},
 ],output:{$ref:'nodes.final'}}}};
 try{
  const before=await runOfficialAgent(definition,task,shared,settings);
  assert.equal(before.answer,'null');
  assert.match(JSON.stringify(before.trace),/NULL_FALLBACK_SHADOWED/);
  definition.graphs.main.nodes[0].input.preserveNull=true;
  const after=await runOfficialAgent(definition,task,shared,settings);
  assert.equal(after.answer,'public fallback');assert.doesNotMatch(JSON.stringify(after.trace),/NULL_FALLBACK_SHADOWED/);
  definition.graphs.main.nodes[0].input.value='null';
  const literal=await runOfficialAgent(definition,task,shared,settings);
  assert.equal(literal.answer,'null');assert.doesNotMatch(JSON.stringify(literal.trace),/NULL_FALLBACK_SHADOWED/);
 }finally{await shared.close();}
});

test('Loop boundary evidence exposes an answer discarded by a scalar result projection without rewriting it',async()=>{
 const settings={baseUrl:'https://example.invalid',apiKey:'offline',model:'mock',concurrency:1,timeoutMs:3000};
 const task={id:'public-loop-flow',dataset:'drop' as const,prompt:'A public question.',outputInstruction:'',metadata:{}};
 const shared=createExperimentRuntime(settings,{provider:{async invoke(){throw Error('No model call needed');}}});
 const definition:any={version:1,id:'loop-flow',graphs:{main:{nodes:[
  {id:'answer',type:'HOST.DATA.TRANSFORM',input:{operation:'text',value:'public Graph answer'}},
 ],output:{$ref:'nodes.answer'}}},loop:{entry:'solve',maxIterations:2,state:{final:''},steps:{solve:{graph:'main',input:{$ref:'input'},
  assign:{final:{$ref:'result.final',default:''}},transitions:[{end:'done'}]}},output:{$ref:'state.final'}}};
 try{
  const before=await runOfficialAgent(definition,task,shared,settings);
  assert.equal(before.answer,'');
  const boundary=before.trace?.find((event:any)=>event.nodeType==='HOST.LOOP.BOUNDARY') as any;
  assert.equal(boundary.output.result,'public Graph answer');assert.equal(boundary.output.state.final,'');
  assert.equal(boundary.publicDiagnostics[0].code,'LOOP_RESULT_SHAPE_MISMATCH');
  assert.match(boundary.publicDiagnostics[0].message,/result.final/);
  assert(!before.executedNodeIds.some(id=>id.includes('@loop')));
  definition.loop.steps.solve.assign.final={$ref:'result'};
  const after=await runOfficialAgent(definition,task,shared,settings);
  assert.equal(after.answer,'public Graph answer');assert.doesNotMatch(JSON.stringify(after.trace),/LOOP_RESULT_SHAPE_MISMATCH/);
 }finally{await shared.close();}
});

test('Loop diagnostics allow optional object fields and ignore literal expression-shaped data',()=>{
 assert.deepEqual(loopResultDiagnostics('main','solve',{value:{$ref:'result.optional',default:''}},{other:1}),[]);
 assert.deepEqual(loopResultDiagnostics('main','solve',{$literal:{value:{$ref:'result.optional',default:''}}},'text'),[]);
 assert.deepEqual(loopResultDiagnostics('main','solve',{value:{$ref:'result'}},'text'),[]);
});
