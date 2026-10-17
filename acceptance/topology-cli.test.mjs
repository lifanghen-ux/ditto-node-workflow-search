import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('CLI searches a full topology, freezes it, tests it and rejects a mismatched engine before calls',{
  timeout:120000,skip:!process.env.MATH_SCORER_PYTHON,
},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'ditto-topology-cli-'));
  const data=join(directory,'data'),runs=join(directory,'runs');await mkdir(data);
  for(const split of ['validate','test'])await writeFile(join(data,`math_${split}.jsonl`),JSON.stringify({problem:'What is 1+1?',solution:'\\boxed{2}',level:'Level 1',type:'Algebra'})+'\n');
  let requests=0;
  const server=createServer(async(request,response)=>{
    let raw='';for await(const chunk of request)raw+=chunk;
    const input=JSON.parse(raw);requests++;
    assert.ok(input.messages.every(m=>!String(m.content).includes('Do not add self-checks')));
    let content='3';
    if(input.messages.some(m=>String(m.content).startsWith('Search only the organization'))){
      const {parent}=JSON.parse(input.messages.at(-1).content);
      const spec={...parent,nodes:[...parent.nodes,{id:'revision',template:'revise',dependencies:['answer']}],graphs:[{id:'solve',nodeIds:['context','answer','revision']}],outputNodeId:'revision'};
      content=JSON.stringify(spec);
      assert.equal(input.response_format.type,'json_object');
      assert.ok(input.messages.some(m=>String(m.content).startsWith('[MFLOW finite-programs-v2]')));
    }else if(input.messages.some(m=>String(m.content).startsWith('Assess the supplied target'))){
      content=JSON.stringify({assessment:{summary:'The arithmetic is 2.'},issues:[],revisedResult:{role:'assistant',content:'2'}});
    }
    response.writeHead(200,{'content-type':'text/event-stream'});
    response.end(`data: ${JSON.stringify({choices:[{index:0,delta:{role:'assistant',content},finish_reason:'length'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const env={...Object.fromEntries(Object.entries(process.env).filter(([key])=>!/KEY|TOKEN|SECRET|PASSWORD/i.test(key))),
    CODE_SOUL_API_KEY:'local-fixture',CODE_SOUL_MODEL:'fixture',CODE_SOUL_BASE_URL:`http://127.0.0.1:${server.address().port}`,NO_PROXY:'127.0.0.1,localhost'};
  const cli=(args)=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['dist/cli.js',...args],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});let out='';
    child.stdout.on('data',chunk=>out+=chunk);child.stderr.on('data',chunk=>out+=chunk);child.on('error',reject);child.on('close',code=>resolve({code,out}));
  });
  try{
    const settings=['--dataset','math','--data-dir',data,'--rounds','1','--repeats','1','--test-repeats','1','--evaluation-concurrency','1'];
    const search=await cli(['search',...settings,'--output-root',runs]);assert.equal(search.code,0,search.out);
    const run=join(runs,'math',(await readdir(join(runs,'math')))[0]);
    const manifest=JSON.parse(await readFile(join(run,'manifest.json'),'utf8'));
    const plan=JSON.parse(await readFile(join(run,'best/plan.json'),'utf8'));
    assert.equal(manifest.status,'frozen');assert.equal(manifest.best.validationScore,1);assert.equal(plan.outputNodeId,'revision');assert.ok(plan.organization);
    assert.equal(requests,4,'initial SAMPLE, proposal, candidate SAMPLE and revision');
    const tested=await cli(['test',...settings,'--run-dir',run]);assert.equal(tested.code,0,tested.out);assert.equal(requests,6);
    const complete=JSON.parse(await readFile(join(run,'manifest.json'),'utf8'));assert.equal(complete.test.score,1);assert.equal(complete.status,'complete');
    assert.deepEqual(complete.execution.executionIdentity,manifest.executionIdentity);
    const results=(await readFile(join(run,'test/samples.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(results[0].providerDiagnostics.every(d=>d.finishReason==='length'));
    await writeFile(join(run,'manifest.json'),JSON.stringify({...manifest,executionIdentity:{...manifest.executionIdentity,source:'old-engine'}}));
    const rejected=await cli(['test',...settings,'--run-dir',run]);assert.notEqual(rejected.code,0);assert.match(rejected.out,/execution identity differs/);assert.equal(requests,6);
  }finally{
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});
  }
});
