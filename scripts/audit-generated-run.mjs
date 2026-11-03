/** Offline correction layer. Original scores, traces and paid usage remain unchanged. */
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
const json=async path=>JSON.parse(await readFile(path,'utf8'));
const rows=async path=>{try{return (await readFile(path,'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);}catch(error){if(error.code==='ENOENT')return [];throw error;}};
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function auditCases(samples,traces) {
  const byTask=new Map(traces.map(trace=>[trace.taskId,trace]));
  const reusable=[], rejected=[];
  for(const row of new Map(samples.map(row=>[row.caseId,row])).values()) {
    const taskId=row.caseId.replace(/#\d+$/,'');
    const trace=byTask.get(taskId);
    const fault=trace?.events.find(event=>event.nodeType?.startsWith('INFER.')
      && /HTTP \d{3}|PROVIDER_HTTP_ERROR|timed out|TIMEOUT|fetch failed|ECONNRESET/i.test(JSON.stringify(event.error??event.output?.error??'')));
    const reason=!row.valid||row.error?row.error??'Invalid execution':!trace?'Missing public execution trace':fault?JSON.stringify(fault.error??fault.output?.error):null;
    if(reason)rejected.push({caseId:row.caseId,reason});else reusable.push(row);
  }
  return {reusable,rejected};
}

export async function auditCandidate(directory,candidateId,{publish=false,ancestors=new Set()}={}) {
  const absolute=resolve(directory);
  const identity=(process.platform==='win32'?absolute.toLowerCase():absolute)+'\0'+candidateId;
  if(ancestors.has(identity))throw Error('Cyclic partial resume ancestry');
  const chain=new Set([...ancestors,identity]);
  const root=join(directory,'evaluations',candidateId);
  const samples=[...await rows(join(root,'samples.jsonl')),...await rows(join(root,'live-samples.jsonl')),...await rows(join(root,'regraded-samples.jsonl'))];
  let traces=[...await rows(join(root,'inherited-public-traces.jsonl')),...await rows(join(root,'public-traces.jsonl'))];
  // Older resume runs kept imported traces only in history.json. Recover their
  // public evidence from the original run after checking the same resume identity.
  const recordedTasks=new Set(traces.map(trace=>trace.taskId));
  if(samples.some(row=>row.valid&&!row.error&&!recordedTasks.has(row.caseId.replace(/#\d+$/,'')))) {
    let manifest;
    try { manifest=await json(join(directory,'manifest.json')); }
    catch(error) { if(error.code!=='ENOENT')throw error; }
    const origin=manifest?.partialResume;
    if(origin?.kind==='audited-partial-resume'&&(origin.resumedCandidateId??'seed-a')===candidateId) {
      const previous=await json(join(origin.directory,'manifest.json'));
      const parent=await json(join(origin.directory,'candidates',origin.candidateId+'.json'));
      const current=await json(join(directory,'candidates',candidateId+'.json'));
      validateResumeIdentity(previous,parent,{representation:manifest.representation,model:manifest.model,
        endpoint:manifest.endpoint,generation:manifest.generation,dataIdentity:manifest.data?.identity,
        taskIds:manifest.data?.taskIds,proposal:current.proposal??current});
      const inherited=await auditCandidate(origin.directory,origin.candidateId,{ancestors:chain});
      const validTasks=new Set(inherited.reusable.map(row=>row.caseId.replace(/#\d+$/,'')));
      traces=[...inherited.traces.filter(trace=>validTasks.has(trace.taskId)),...traces];
    }
  }
  const result=auditCases(samples,traces);
  const executionCounts={graphs:{},nodes:{}};
  for(const trace of traces)for(const event of trace.events??[]) {
    const target=event.kind==='graph-start'?executionCounts.graphs:event.kind==='node'?executionCounts.nodes:null;
    const id=event.kind==='graph-start'?event.graphId:event.nodeId;
    if(target&&typeof id==='string')target[id]=(target[id]??0)+1;
  }
  const audit={schemaVersion:1,policy:'generated-provider-health-v1',candidateId,
    recordedCases:new Set(samples.map(row=>row.caseId)).size,validSampleCount:result.reusable.length,
    meanLatencyMs:result.reusable.length?result.reusable.reduce((sum,row)=>sum+row.latencyMs,0)/result.reusable.length:null,
    passedRuns:result.reusable.filter(row=>row.score===1).length,
    rejected:result.rejected,validCaseIds:result.reusable.map(row=>row.caseId),
    inputIdentity:hash({samples,traces}),executionCounts,
    note:'Partial valid cases can be reused; no complete Search score is inferred. Originals are preserved.'};
  if(publish){
    await writeFile(join(root,'execution-audit.json'),JSON.stringify(audit,null,2)+'\n');
    await writeFile(join(root,'resumable-samples.jsonl'),result.reusable.map(row=>JSON.stringify(row)).join('\n')+(result.reusable.length?'\n':''));
  }
  return {...result,audit,traces};
}

export function validateResumeIdentity(previous,saved,current) {
  for(const [label,actual,expected] of [
    ['representation',previous.representation,current.representation],
    ['model',previous.model,current.model],['endpoint',previous.endpoint,current.endpoint],
    ['generation',previous.generation,current.generation],['data',previous.data?.identity,current.dataIdentity],
    ['task order',previous.data?.taskIds,current.taskIds],['candidate',saved.proposal,current.proposal],
  ])if(!isDeepStrictEqual(actual,expected))throw Error('Partial resume identity differs: '+label);
}

export async function loadAuditedPartialSeed(directory,candidateId,current) {
  const previous=await json(join(directory,'manifest.json'));
  const saved=await json(join(directory,'candidates',candidateId+'.json'));
  validateResumeIdentity(previous,saved,current);
  const result=await auditCandidate(directory,candidateId);
  const selected=new Set(current.taskIds.map(id=>id+'#1'));
  if(result.reusable.some(row=>!selected.has(row.caseId)))throw Error('Partial resume contains unexpected task/repeat');
  const validTasks=new Set(result.reusable.map(row=>row.caseId.replace(/#1$/,'')));
  return {...result,traces:result.traces.filter(trace=>validTasks.has(trace.taskId))};
}

export async function auditRun(directory) {
  const manifest=await json(join(directory,'manifest.json'));
  const candidates=[];
  for(const candidateId of await readdir(join(directory,'evaluations'))){
    const {audit,reusable}=await auditCandidate(directory,candidateId,{publish:true});
    candidates.push({...audit,observedMeanScore:reusable.length?reusable.reduce((sum,row)=>sum+row.score,0)/reusable.length:null,
      meanLatencyMs:audit.meanLatencyMs});
  }
  const observedAccountBlock=candidates.some(candidate=>candidate.rejected.some(row=>/HTTP 402|insufficient.*balance/i.test(row.reason)));
  const audit={schemaVersion:1,status:manifest.status==='searching'?(observedAccountBlock?'account-blocked':'interrupted'):manifest.status,
    dataset:manifest.dataset,completeSearchScore:null,candidates,
    recordedUsage:manifest.newUsage,usageIsLowerBound:manifest.newUsage?.unknownUsageAttempts>0||manifest.status==='searching'};
  await writeFile(join(directory,'execution-audit.json'),JSON.stringify(audit,null,2)+'\n');
  return audit;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  for(const directory of process.argv.slice(2)){
    const audit=await auditRun(resolve(directory));
    console.log(JSON.stringify({directory,status:audit.status,dataset:audit.dataset,candidates:audit.candidates.map(({candidateId,recordedCases,validSampleCount,rejected,observedMeanScore})=>({candidateId,recordedCases,validSampleCount,rejected:rejected.length,observedMeanScore}))}));
  }
}
