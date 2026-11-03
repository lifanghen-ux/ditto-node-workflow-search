import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {auditCases,auditCandidate,validateResumeIdentity} from './audit-generated-run.mjs';

test('audit excludes swallowed provider faults while retaining paid retry telemetry',()=>{
  const valid={caseId:'ok#1',valid:true,score:1,prediction:'ok',providerAttempts:2,failedProviderAttempts:1};
  const masked={caseId:'bad#1',valid:true,score:0,prediction:'fallback'};
  const traces=[{taskId:'ok',events:[{kind:'node',nodeType:'INFER.REASONING.SAMPLE',output:{status:'success'}}]},
    {taskId:'bad',events:[{kind:'node',nodeType:'INFER.REASONING.SAMPLE',output:{status:'failed',error:{code:'PROVIDER_HTTP_ERROR',message:'HTTP 402'}}}]}];
  const result=auditCases([valid,masked],traces);
  assert.deepEqual(result.reusable,[valid]);
  assert.equal(result.reusable[0],valid);
  assert.match(result.rejected[0].reason,/402/);
  assert.equal(masked.valid,true); // Original artifact is unchanged.
});

test('handled tool errors remain scored model outcomes; missing traces cannot be reused',()=>{
  const row={caseId:'tool#1',valid:true,score:0};
  const result=auditCases([row,{caseId:'missing#1',valid:true,score:1}],[{taskId:'tool',events:[{nodeType:'INTERACTION.ACT.TOOL',error:{message:'HTTP 404 endpoint absent'}}]}]);
  assert.deepEqual(result.reusable,[row]);
  assert.match(result.rejected[0].reason,/Missing/);
});

test('resume rejects changed source, model, dataset and task order',()=>{
  const previous={representation:'A',model:'fixture',endpoint:'offline',generation:{temperature:0},data:{identity:{splitRole:'search'},taskIds:['a','b']}};
  const saved={proposal:{source:'unchanged'}};
  const current={representation:'A',model:'fixture',endpoint:'offline',generation:{temperature:0},dataIdentity:{splitRole:'search'},taskIds:['a','b'],proposal:saved.proposal};
  validateResumeIdentity(previous,saved,current);
  for(const changed of [{model:'other'},{dataIdentity:{splitRole:'test'}},{taskIds:['b','a']},{proposal:{source:'changed'}}])
    assert.throws(()=>validateResumeIdentity(previous,saved,{...current,...changed}),/identity differs/);
});

test('nested legacy resumes retain cached public evidence and reject changed ancestry',async t=>{
  const temp=await mkdtemp(join(tmpdir(),'ditto-resume-evidence-'));
  t.after(()=>rm(temp,{recursive:true,force:true}));
  const base={representation:'A',model:'fixture',endpoint:'offline',generation:{temperature:0},
    data:{identity:{splitRole:'search'},taskIds:['a','b','c']}};
  const row=id=>({caseId:id+'#1',valid:true,score:id==='b'?0:1,latencyMs:1});
  const trace=id=>({taskId:id,events:[{kind:'graph-start',graphId:'g-'+id},
    {kind:'node',nodeId:id,nodeType:'INFER.REASONING.SAMPLE',output:{status:'success'}}]});
  const paths=['parent','child','grandchild'].map(name=>join(temp,name));
  for(let index=0;index<paths.length;index++) {
    const directory=paths[index],root=join(directory,'evaluations','seed-a');
    await mkdir(root,{recursive:true});await mkdir(join(directory,'candidates'));
    await writeFile(join(directory,'manifest.json'),JSON.stringify({...base,...(index?{partialResume:{
      kind:'audited-partial-resume',directory:paths[index-1],candidateId:'seed-a',reusedCases:index}}:{})}));
    await writeFile(join(directory,'candidates','seed-a.json'),JSON.stringify({proposal:{source:'same model-generated module'}}));
    await writeFile(join(root,'samples.jsonl'),['a','b','c'].slice(0,index+1).map(id=>JSON.stringify(row(id))).join('\n')+'\n');
    await writeFile(join(root,'public-traces.jsonl'),JSON.stringify(trace(['a','b','c'][index]))+'\n');
  }
  const original=await readFile(join(paths[2],'evaluations','seed-a','samples.jsonl'),'utf8');
  const audited=await auditCandidate(paths[2],'seed-a',{publish:true});
  assert.deepEqual(audited.reusable.map(row=>row.caseId),['a#1','b#1','c#1']);
  assert.equal(audited.audit.passedRuns,2);
  assert.deepEqual(audited.audit.executionCounts,{graphs:{'g-a':1,'g-b':1,'g-c':1},nodes:{a:1,b:1,c:1}});
  assert.equal(audited.rejected.length,0);
  assert.equal(await readFile(join(paths[2],'evaluations','seed-a','samples.jsonl'),'utf8'),original);
  await writeFile(join(paths[0],'manifest.json'),JSON.stringify({...base,model:'different'}));
  await assert.rejects(auditCandidate(paths[2],'seed-a'),/identity differs: model/);
});

test('self-contained inherited traces preserve the provider-fault audit without the source run',async t=>{
  const temp=await mkdtemp(join(tmpdir(),'ditto-inherited-evidence-'));
  t.after(()=>rm(temp,{recursive:true,force:true}));
  const root=join(temp,'evaluations','seed-a');await mkdir(root,{recursive:true});
  await writeFile(join(root,'samples.jsonl'),['ok','bad'].map(id=>JSON.stringify({caseId:id+'#1',valid:true,score:1,latencyMs:1})).join('\n'));
  await writeFile(join(root,'inherited-public-traces.jsonl'),[
    {taskId:'ok',events:[{nodeType:'INFER.REASONING.SAMPLE',output:{status:'success'}}]},
    {taskId:'bad',events:[{nodeType:'INFER.REASONING.SAMPLE',error:{message:'HTTP 402'}}]},
  ].map(trace=>JSON.stringify(trace)).join('\n'));
  const audited=await auditCandidate(temp,'seed-a');
  assert.deepEqual(audited.reusable.map(row=>row.caseId),['ok#1']);
  assert.match(audited.rejected[0].reason,/402/);
});
