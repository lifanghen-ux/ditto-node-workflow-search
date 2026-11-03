import test from 'node:test';
import assert from 'node:assert/strict';
import { graph, graphStep, loop } from '@codesoul-co/ditto/runtime';
import { createExperimentRuntime } from '../dist/ditto/runtime.js';
import { captureProviderDiagnostics, currentProviderDiagnostics } from '../dist/ditto/provider-diagnostics.js';
import { evaluateTasks } from '../dist/benchmark/evaluator.js';
import { compileGeneratedWorkflowA } from './generated-workflow-a.mjs';
import { createProviderHealth } from './generated-provider-health.mjs';
import { unwrap, parseJson } from './workflow-capabilities.mjs';

test('a swallowed native Worker HTTP 402 is invalid and prevents later remote calls', async () => {
  const health = createProviderHealth(currentProviderDiagnostics);
  let remoteCalls = 0;
  const experiment = createExperimentRuntime({baseUrl:'https://offline.invalid',model:'fixture',apiKey:'offline',concurrency:1,timeoutMs:1000}, {
    provider:{async invoke(){remoteCalls++;throw Error('Model provider returned HTTP 402');}},
    beforeProviderCall:()=>health.admit(), onProviderError:error=>health.record(error),
  });
  // Deliberately ignores a failed native result, as the interrupted generated candidate did.
  const source = `export default function createWorkflow(api){
    const g=api.graph('fixture').node('answer','INFER.REASONING.SAMPLE',[],()=>({messages:[{role:'user',content:'fixture'}]}));
    return {outputNodeId:'answer',definition:api.loop({id:'fixture',*plan(task){
      yield* api.graphStep(g,task);return {answer:'fallback'};
    }})};
  }`;
  const run = task=>captureProviderDiagnostics(async records=>{
    const loaded=compileGeneratedWorkflowA(source,{graph,graphStep,loop,unwrap,parseJson,model:{provider:'deepseek',model:'fixture'},generation:{temperature:0,maxTokens:393216}});
    const result=await experiment.runtime.loop(loaded.definition,task);
    health.assert(records);
    return {...result,inputTokens:0,outputTokens:0,totalTokens:0};
  });
  let graded=0;
  try {
    const result=await evaluateTasks([{id:'one',dataset:'math',prompt:'fixture'}],{
      expectedLabel:()=>'',score:async()=>{graded++;return {score:0,expected:'',prediction:'',normalizedExpected:'',normalizedPrediction:'',method:'fixture'};},
    },run,{retryAttempts:1});
    assert.equal(result.valid,false);
    assert.match(result.results[0].error,/HTTP 402/);
    assert.equal(result.results[0].failureKind,'provider');
    assert.equal(graded,0);
    await assert.rejects(run({id:'two',prompt:'fixture'}),/HTTP 402/);
    assert.equal(remoteCalls,1);
  } finally { await experiment.close(); }
});

test('transient failure stays local to its task and successful SDK retries are unaffected',()=>{
  let context=[];
  const first=context;
  const health=createProviderHealth(()=>context);
  health.record(Error('HTTP 503'));
  assert.throws(()=>health.assert(),/503/);
  context=[];
  health.assert();
  assert.match(health.failure(first).message,/503/);
});

test('provider streaming errors reach the host before Worker handling', async()=>{
  const {admitProviderCalls}=await import('../dist/ditto/runtime.js');
  const seen=[];
  const provider=admitProviderCalls({async invoke(){throw Error('invoke failed');},async *stream(){throw Error('stream HTTP 402');}},undefined,undefined,error=>seen.push(error.message));
  await assert.rejects(provider.invoke({},{}),/invoke failed/);
  await assert.rejects(async()=>{for await(const event of provider.stream({},{}))void event;},/stream HTTP 402/);
  assert.deepEqual(seen,['invoke failed','stream HTTP 402']);
});

test('healthy in-flight completion remains valid after another task exhausts the account',()=>{
  let context=[];
  const health=createProviderHealth(()=>context);
  health.record(Error('HTTP 402'));
  context=[];
  health.assert(context);
  assert.throws(()=>health.admit(),/HTTP 402/);
});
