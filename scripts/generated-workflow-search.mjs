import { graph, graphStep, loop } from '@codesoul-co/ditto/runtime';
import { mkdir, writeFile, appendFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { loadProviderSettings } from '../dist/config.js';
import { createExperimentRuntime } from '../dist/ditto/runtime.js';
import { loadBenchmark } from '../dist/benchmark/index.js';
import { GENERATION, PROTOCOL } from '../dist/protocol.js';
import { captureProviderDiagnostics, summarizeProviderDiagnostics } from '../dist/ditto/provider-diagnostics.js';
import { buildWorkflowFeedback } from '../dist/search/workflow-feedback.js';
import { sharedTools, unwrap, parseJson, answerText, SHARED_CAPABILITY_GUIDE } from './workflow-capabilities.mjs';
import { GENERATED_SEARCH_PROMPT, DROP_SEARCH_CONTRACT } from './generated-search-prompt.mjs';
import { compileGeneratedWorkflowA, GENERATED_A_GUIDE } from './generated-workflow-a.mjs';
import { compileEvidenceDefinition, validateEvidenceDefinition, EVIDENCE_DEFINITION_GUIDE } from './generated-workflow-b.mjs';
import { spawnSync } from 'node:child_process';
import { loadGeneratedResume } from './generated-search-recovery.mjs';

const flags = Object.fromEntries(process.argv.slice(2).reduce((rows,token,index,all) => {
  if (token.startsWith('--')) rows.push([token.slice(2),all[index+1]]); return rows;
},[]));
const representation = flags.representation ?? 'B';
if (!['A','B'].includes(representation)) throw new Error('representation must be A or B');
const positive = (name, fallback) => { const value = Number(flags[name] ?? fallback); if (!Number.isSafeInteger(value) || value < 1) throw Error(`Invalid ${name}`); return value; };
const rounds = positive('rounds',3), repeats = positive('repeats',5), concurrency = positive('concurrency',8);
if (repeats !== 5) throw new Error('This search uses the full fixed validation protocol: repeats must be 5');
if(Boolean(flags['resume-run'])!==Boolean(flags['resume-candidate']))throw new Error('Recovery requires both --resume-run and --resume-candidate');
const directory = resolve(flags.output ?? `runs/generated-search/drop/${new Date().toISOString().replace(/[:.]/g,'-')}-${representation}`);
await mkdir(directory,{recursive:true});
const write = async (file,value) => { await mkdir(resolve(directory,file,'..'),{recursive:true}); await writeFile(join(directory,file),JSON.stringify(value,null,2)+'\n'); };
const emit = value => console.log(JSON.stringify(value));
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const settings = {...loadProviderSettings(),concurrency};
const experiment = createExperimentRuntime(settings,{tools:sharedTools});
const model = {provider:experiment.providerName,model:experiment.model};
const capabilities = { graph,graphStep,loop,model,generation:GENERATION,unwrap,parseJson,answerText,allowedTools:sharedTools.map(t=>t.name) };
const guide = representation === 'A' ? GENERATED_A_GUIDE : EVIDENCE_DEFINITION_GUIDE;
const proposalGraph = graph('automatic-workflow-proposal').node('proposed','INFER.REASONING.SAMPLE',[],input => ({
  model,generation:GENERATION,messages:[{role:'system',content:GENERATED_SEARCH_PROMPT},{role:'user',content:JSON.stringify(input)}],
  metadata:{experiment:'generated-workflow-search-v1',role:'optimizer',representation},
}));
const history = [], hashes = new Set();
let optimizerUsage = {providerAttempts:0,inputTokens:0,outputTokens:0,totalTokens:0,unknownUsageAttempts:0};
let best;
const manifest = {schemaVersion:2,status:'searching',createdAt:new Date().toISOString(),dataset:'drop',split:'validate',
  representation,optimizerProfile:'generated-feedback-v1',candidateOrigin:'llm-generated',manualCandidateUse:false,
  model:settings.model,endpoint:settings.baseUrl,generation:GENERATION,protocol:PROTOCOL,repeats,concurrency,
  search:{policy:'model-chosen-reference-full-artifact',rounds,validEvaluations:0},capabilities:sharedTools.map(t=>t.name)};

function compile(proposal) {
  if (representation === 'A') return compileGeneratedWorkflowA(proposal.source,capabilities);
  validateEvidenceDefinition(proposal.definition);
  const definition = compileEvidenceDefinition(proposal.definition,capabilities);
  const raw = proposal.definition;
  const outputRef = raw.output?.answer?.ref;
  const nodes = raw.nodes.map(n=>({...n,config:{inputBindings:n.inputBindings}}));
  return {definition,plan:{id:raw.id,leafSearchNodeId:raw.id,nodes,graphs:raw.graphs,loop:raw.loop,outputNodeId:Array.isArray(outputRef)&&outputRef[0]==='nodes'?outputRef[1]:'defined-output',outputBindings:raw.output}};
}
function checkProposal(proposal) {
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) throw Error('Proposal must be object');
  const allowed = ['referenceCandidateId','rationale',representation==='A'?'source':'definition'];
  if (Object.keys(proposal).some(k=>!allowed.includes(k)) || allowed.some(k=>!Object.hasOwn(proposal,k))) throw Error('Proposal has incorrect fields');
  if (proposal.referenceCandidateId !== null && !history.some(c=>c.id===proposal.referenceCandidateId)) throw Error(`referenceCandidateId must be actual JSON null or an existing history id. Valid ids: ${JSON.stringify(history.map(c=>c.id))}`);
  if (typeof proposal.rationale !== 'string' || !proposal.rationale.trim()) throw Error('Public rationale required');
  if (representation==='A' && typeof proposal.source!=='string') throw Error('A source must be text');
  const identity = hash(representation==='A'?proposal.source:proposal.definition);
  if(hashes.has(identity)) throw Error('Duplicate artifact; propose a substantive change');
  return {identity,...compile(proposal)};
}
async function propose(candidateId,tasks) {
  let rejectedProposal, previousProposalError;
  for(let attempt=1;attempt<=3;attempt++) {
    const feedback=buildWorkflowFeedback(history,tasks);
    const input={taskGoal:'Automatically generate a reusable DROP workflow with validation F1 above 0.85; this is a target, not an observed result.',taskContract:DROP_SEARCH_CONTRACT,
      representation,outputContract:{referenceCandidateId:history.length?'JSON null or one exact id from allowedReferenceCandidateIds':'MUST be JSON null because history is empty',rationale:'string',[representation==='A'?'source':'definition']:representation==='A'?'complete JavaScript source string':'complete JSON definition object'},allowedReferenceCandidateIds:history.map(c=>c.id),capabilityGuide:SHARED_CAPABILITY_GUIDE,interfaceGuide:guide,
      history:history.map((c,index)=>({id:c.id,status:c.status,artifact:c.proposal,feedback:feedback[index],engineeringFeedback:c.engineeringFeedback??[]})),
      ...(previousProposalError?{previousProposalError,rejectedProposal}:{})};
    await write(`proposals/${candidateId}-attempt-${attempt}-request.json`,input);
    const sampled=await captureProviderDiagnostics(async records=>{
      try {return await experiment.runtime.run(proposalGraph,input);}
      finally {const usage=summarizeProviderDiagnostics(records); for(const key of Object.keys(optimizerUsage)) optimizerUsage[key]+=usage[key]??0; await write('optimizer-usage.json',optimizerUsage);}
    });
    const content=unwrap(sampled.proposed).message.content;
    await write(`proposals/${candidateId}-attempt-${attempt}-response.json`,{content});
    try {const proposal=parseJson(content);const compiled=checkProposal(proposal);return {proposal,...compiled};}
    catch(error) {rejectedProposal=content;previousProposalError=error.message;await write(`proposals/${candidateId}-attempt-${attempt}-failure.json`,{error:previousProposalError});emit({phase:'proposal-repair',representation,candidateId,attempt,error:previousProposalError});}
  }
  throw Error(`Generated ${representation} candidate failed validation after 3 attempts: ${previousProposalError}`);
}
function render() {
  const python=flags['report-python']??process.env.DITTO_REPORT_PYTHON??process.env.DITTO_PROVIDER_PYTHON??(process.platform==='win32'?'python':'python3');
  const output=resolve(flags.report??join(directory,'workflow-report.png'));
  const result=spawnSync(python,['scripts/render-workflow-report.py',directory,'--output',output],{encoding:'utf8',windowsHide:true});
  if(result.status===0) emit({phase:'workflow-report',path:output}); else emit({phase:'workflow-report-failed',status:result.status});
}
try {
  const benchmark=await loadBenchmark('drop',{dataDir:resolve('data/datasets'),split:'validate',limit:0,seed:42});
  manifest.data={identity:benchmark.identity,selectedExamples:benchmark.tasks.length};
  let resumed;
  if(flags['resume-run']) {
    resumed=await loadGeneratedResume(flags['resume-run'],flags['resume-candidate'],{representation,model:settings.model,endpoint:settings.baseUrl,generation:GENERATION,repeats,dataIdentity:benchmark.identity});
    history.push(...resumed.history);
    optimizerUsage={...resumed.optimizerUsage};
    manifest.resumedFrom=resumed.origin;
    manifest.search.validEvaluations=history.filter(c=>c.status==='valid').length;
    best=[...history].filter(c=>c.status==='valid').sort((a,b)=>b.evaluation.score-a.evaluation.score)[0];
    for(const c of history)hashes.add(hash(representation==='A'?c.proposal.source:c.proposal.definition));
    emit({phase:'generated-search-recovery',representation,reusableCases:resumed.origin.reusableCases,retryCases:resumed.origin.retryCases});
  }
  await write('manifest.json',manifest);
  await write('optimizer-usage.json',optimizerUsage);
  await write('search-instructions.json',{system:GENERATED_SEARCH_PROMPT,contract:DROP_SEARCH_CONTRACT,guide,sharedCapabilities:SHARED_CAPABILITY_GUIDE});
  emit({phase:'generated-search-start',representation,directory,examples:benchmark.tasks.length,repeats,rounds});
  let nextIndex=Math.max(0,...history.map(c=>Number(c.id.split('-').at(-1))),resumed?Number(flags['resume-candidate'].split('-').at(-1)):0)+1;
  if(!resumed&&!history.length)nextIndex=1;
  for(let round=1;manifest.search.validEvaluations<rounds && round<=rounds*3;round++) {
    const recovery=resumed;resumed=undefined;
    const id=recovery?flags['resume-candidate']:`generated-${String(nextIndex++).padStart(3,'0')}`;
    const candidate=recovery?{proposal:recovery.proposal,identity:hash(representation==='A'?recovery.proposal.source:recovery.proposal.definition),...compile(recovery.proposal)}:await propose(id,benchmark.tasks);
    hashes.add(candidate.identity);
    const plan={...candidate.plan,leafSearchNodeId:id};
    await write(`checkpoints/${id}.json`,{schemaVersion:1,searchNodeId:id,plan,candidateOrigin:'llm-generated'});
    await write(`candidates/${id}.json`,{representation,proposal:candidate.proposal,artifactHash:candidate.identity});
    if(representation==='A')await writeFile(join(directory,'candidates',`${id}.mjs`),candidate.proposal.source);
    await mkdir(join(directory,'evaluations',id),{recursive:true});
    emit({phase:'generated-candidate',representation,id,nodes:plan.nodes.length,rationale:candidate.proposal.rationale});
    const summary=await benchmark.evaluate(task=>captureProviderDiagnostics(async records=>{
      try {
      const fresh=compile(candidate.proposal);
      const graphEvents=[];
      const raw=await experiment.runtime.loop(fresh.definition,task,{onGraph:event=>graphEvents.push(event)});
      const result=typeof raw==='string'?{answer:raw}:raw;
      const answer=answerText(result.answer);
      const usage=summarizeProviderDiagnostics(records);
      const graphIds=graphEvents.filter(e=>e.status==='completed').map(e=>e.graphId);
      await appendFile(join(directory,`evaluations/${id}/public-traces.jsonl`),JSON.stringify({taskId:task.id,answer,graphEvents,details:result.details??null})+'\n');
      return {answer,executedNodeIds:result.executedNodeIds??graphEvents.filter(e=>e.status==='completed').flatMap(e=>e.nodes),executedGraphIds:result.executedGraphIds??graphIds,...usage};
      } catch(error) { throw Object.assign(error,summarizeProviderDiagnostics(records)); }
    }),{repeats,concurrency,retryAttempts:2,...(recovery?{priorCases:recovery.priorCases}:{}),async onCase({completed,total,result}){
      await mkdir(join(directory,'evaluations',id),{recursive:true});
      await appendFile(join(directory,`evaluations/${id}/live-samples.jsonl`),JSON.stringify(result)+'\n');
      if(/HTTP (?:401|402|403)|insufficient.*balance/i.test(result.error??'')) {
        throw new Error('Provider account requires attention; successful cases are retained for recovery. '+result.error);
      }
      if(completed%20===0||completed===total)emit({phase:'generated-progress',representation,id,completed,total,valid:result.valid});
    }});
    const {results,...stats}=summary;
    await write(`evaluations/${id}/summary.json`,stats);
    await writeFile(join(directory,`evaluations/${id}/samples.jsonl`),results.map(r=>JSON.stringify(r)).join('\n')+'\n');
    const failureCounts=Object.fromEntries(['provider','execution','timeout','judge'].map(kind=>[kind,results.filter(r=>r.failureKind===kind).length]));
    const record={id,referenceCandidateId:candidate.proposal.referenceCandidateId,rationale:candidate.proposal.rationale,proposal:candidate.proposal,
      plan,status:summary.valid?'valid':'invalid',...(summary.valid?{evaluation:summary}:{failureCounts,
        engineeringFeedback:[...new Set(results.filter(r=>r.failureKind==='execution').map(r=>r.error))].slice(0,3)})};
    history.push(record);
    await write('history.json',history);
    if(summary.valid) {
      manifest.search.validEvaluations++;
      if(!best||summary.score>best.evaluation.score){best=record;await write('best/plan.json',plan);await write('best/candidate.json',candidate.proposal);await write('best/validation-summary.json',stats);}
    }
    await write('manifest.json',manifest);
    emit({phase:'generated-evaluation-complete',representation,id,valid:summary.valid,score:summary.valid?summary.score:null,repeatScores:summary.valid?summary.repeatScores:null,providerAttemptCount:stats.providerAttemptCount,totalTokens:stats.totalTokens,directory});
    render();
    // The target only stops search after a complete five-repeat evaluation.
    if(best?.evaluation.score>0.85)break;
  }
  await write('manifest.json',{...manifest,status:best?'frozen':'no-valid-candidate',completedAt:new Date().toISOString(),best:best?{candidateId:best.id,score:best.evaluation.score}:null});
  emit({phase:'generated-search-complete',representation,bestScore:best?.evaluation.score??null,directory});
}catch(error){await write('manifest.json',{...manifest,status:'failed',error:error.message});throw error;}
finally{await experiment.close();}
