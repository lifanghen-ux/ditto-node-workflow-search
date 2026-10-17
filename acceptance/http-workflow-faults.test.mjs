import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createExperimentRuntime} from '../dist/ditto/runtime.js';
import {WorkflowExecutor} from '../dist/workflow/executor.js';
import {MFlowMathScorer} from '../dist/benchmark/mflow-math-scorer.js';
import {evaluateTasks} from '../dist/benchmark/evaluator.js';
import {NodeWorkflowSearch} from '../dist/search/optimizer.js';
import {backpropagateEvaluation} from '../dist/search/backprop.js';
import {selectParent, compareRunnableLeaves} from '../dist/search/selector.js';
import {SeededRandom} from '../dist/search/random.js';
import {createRootNode, createInitialSampleNode, createSearchTreeNode} from '../dist/workflow/spec.js';

const tasks=['correct','wrong','fault'].map(id=>({id,dataset:'math',prompt:id,outputInstruction:'',metadata:{}}));
const scenarios=[
  {name:'401',kind:'provider',http:1,workflows:1},
  {name:'402',kind:'provider',http:1,workflows:1},
  {name:'429',kind:'provider',http:6,workflows:2},
  {name:'500',kind:'provider',http:6,workflows:2},
  {name:'timeout',kind:'timeout',http:2,workflows:2},
  {name:'scorer',kind:'judge',http:1,workflows:0},
];

async function fixture(scenario, operation) {
  const directory=await mkdtemp(join(tmpdir(),'ditto-http-fault-'));
  const log=join(directory,'provider.jsonl');
  const previousLog=process.env.DITTO_PROVIDER_LOG;
  process.env.DITTO_PROVIDER_LOG=log;
  const counts=new Map(); let healthy=false;
  const server=createServer(async(request,response)=>{
    let raw='';for await(const chunk of request)raw+=chunk;
    const body=JSON.parse(raw),key=body.messages.at(-1).content;
    counts.set(key,(counts.get(key)||0)+1);
    if(key==='fault'&&!healthy&&scenario.name!=='scorer'){
      if(scenario.name==='timeout'){response.writeHead(200,{'content-type':'text/event-stream'});response.flushHeaders();return;}
      const status=Number(scenario.name);
      response.writeHead(status,{'content-type':'application/json','retry-after':'1'});
      response.end(JSON.stringify({error:{message:'local injected failure',code:`fixture_${status}`}}));return;
    }
    response.writeHead(200,{'content-type':'text/event-stream'});
    response.write(`data: ${JSON.stringify({id:'fixture',model:'fixture',choices:[{index:0,delta:{role:'assistant',content:key==='wrong'?'3':'2'},finish_reason:'stop'}]})}\n\n`);
    response.write(`data: ${JSON.stringify({choices:[],usage:{prompt_tokens:2,completion_tokens:1,total_tokens:3}})}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const experiment=createExperimentRuntime({baseUrl:`http://127.0.0.1:${server.address().port}`,model:'fixture',apiKey:'local-fixture',concurrency:1,timeoutMs:scenario.name==='timeout'?2000:10000});
  const executor=new WorkflowExecutor(experiment.runtime,experiment.providerName,experiment.model);
  const native=new MFlowMathScorer(new Map(tasks.map(t=>[t.id,'2'])));
  const scored=[];
  const scorer={expectedLabel:id=>native.expectedLabel(id),async score(id,prediction){
    scored.push(id);const result=await native.score(id,prediction);
    if(id==='fault'&&!healthy&&scenario.name==='scorer')throw new Error('local injected scorer failure');
    return result;
  }};
  try {await operation({executor,scorer,counts,scored,recover(){healthy=true;},async records(){return (await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);}});}
  finally {await experiment.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    if(previousLog===undefined)delete process.env.DITTO_PROVIDER_LOG;else process.env.DITTO_PROVIDER_LOG=previousLog;
    await rm(directory,{recursive:true,force:true});}
}

for(const scenario of scenarios)test(`local HTTP -> Python -> Ditto -> native scorer -> optimizer: ${scenario.name}`,{
  timeout:60000,skip:!process.env.MATH_SCORER_PYTHON&&!process.env.AFLOW_SCORER_PYTHON,
},async()=>{
  await fixture(scenario,async({executor,scorer,counts,scored,recover,records})=>{
    let invalid,plan,proposals=0;const feedback=[];
    await assert.rejects(new NodeWorkflowSearch({seed:42,rounds:1,topK:1,patience:5,
      evaluate:async value=>{plan=value;invalid=await evaluateTasks(tasks,scorer,t=>executor.run(value,t),{retryAttempts:2});return invalid;},
      proposer:{async propose(){proposals++;throw new Error('invalid baseline must not request optimization');}},
      callbacks:{async node(node,experience){if(node.evaluation)feedback.push({experience,visits:node.statistics.visits});}},
    }).run(),/Invalid evaluation/);
    assert.equal(invalid.valid,false);assert.equal(invalid.examples,3);assert.equal(invalid.validRuns,2);
    assert.equal(invalid.failedRuns,1);assert.equal(invalid.wrongRuns,1);
    const failed=invalid.results.find(x=>x.caseId==='fault#1');
    assert.equal(failed.failureKind,scenario.kind);assert.equal(failed.attempts.length,scenario.workflows);
    assert.equal(counts.get('fault'),scenario.http);assert.equal(proposals,0);
    assert.deepEqual(feedback,[{experience:null,visits:0}]);
    assert.equal(scored.filter(id=>id==='fault').length,scenario.kind==='judge'?1:0);
    assert.equal(failed.providerAttempts,scenario.http);
    assert.equal(failed.unknownUsageAttempts,scenario.kind==='judge'?0:scenario.http);
    assert.equal(failed.usageKnown,scenario.kind==='judge');
    const root=createRootNode(),sample=createInitialSampleNode();
    const node={...createSearchTreeNode('search-001','search-000',1,sample,[root,sample]),evaluation:invalid};
    assert.throws(()=>backpropagateEvaluation(new Map(),'unused',invalid),/Invalid evaluation/);
    assert.throws(()=>selectParent([node],1,new SeededRandom(42)),/Invalid evaluation/);
    assert.throws(()=>compareRunnableLeaves(node,node),/Invalid evaluation/);
    const logs=await records(),errors=logs.filter(x=>x.phase==='error');
    assert.equal(errors.length,scenario.kind==='judge'?0:scenario.http);
    if(errors.length){
      assert(errors.every(x=>x.status===(scenario.name==='timeout'?504:Number(scenario.name))));
      assert.equal(errors.filter(x=>x.retry).length,['429','500'].includes(scenario.name)?4:0);
      if(scenario.name==='429')assert(errors.every(x=>x.rateLimitCooldownSeconds===1));
    }
    recover();const recoveredCalls=[];
    const recovered=await evaluateTasks(tasks,scorer,t=>{recoveredCalls.push(t.id);return executor.run(plan,t);},{priorCases:invalid.results,retryAttempts:2});
    assert.deepEqual(recoveredCalls,scenario.kind==='judge'?[]:['fault']);assert.equal(recovered.valid,true);assert.equal(recovered.score,2/3);
    assert.equal(counts.get('correct'),1);assert.equal(counts.get('wrong'),1);
    assert.equal(recovered.results.find(x=>x.caseId==='wrong#1').score,0);
    assert.equal(recovered.results.find(x=>x.caseId==='fault#1').previousResults[0].failureKind,scenario.kind);
    console.log(JSON.stringify({scenario:scenario.name,httpFailurePhase:scenario.http,classification:failed.failureKind,workflowFailures:failed.attempts.length,optimizerBlocked:true,recoveredOriginalCases:1,validZeroRetained:true}));
  });
});
