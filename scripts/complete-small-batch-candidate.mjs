/** Resume only missing/invalid executions of an unchanged generated candidate. */
import { readFile, writeFile, appendFile, mkdir, copyFile, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { spawnSync } from 'node:child_process';
import { graph, graphStep, loop } from '@codesoul-co/ditto/runtime';
import { loadProviderSettings } from '../dist/config.js';
import { createExperimentRuntime } from '../dist/ditto/runtime.js';
import { loadBenchmark } from '../dist/benchmark/index.js';
import { GENERATION } from '../dist/protocol.js';
import { captureProviderDiagnostics, currentProviderDiagnostics, summarizeProviderDiagnostics } from '../dist/ditto/provider-diagnostics.js';
import { selectSearchTasks, SMALL_BATCH_POLICY, bestFullCandidate } from './generated-small-batch-policy.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const usageKeys = ['providerAttempts','failedProviderAttempts','inputTokens','outputTokens','totalTokens','unknownUsageAttempts'];
const emptyUsage = () => Object.fromEntries(usageKeys.map(key => [key, 0]));
const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const emit = value => console.log(JSON.stringify(value));
const json = async path => JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/,''));
const same = (actual, expected, label) => { if (!isDeepStrictEqual(actual, expected)) throw Error(`Completion identity differs: ${label}`); };
const completeRow = row => row?.valid === true && row.error === undefined;
const EXPANDED_SEARCH_PROTOCOL = 'generated-drop-expanded-v2';
const FROZEN_EXPANSION_PROTOCOL = 'frozen-candidate-full200-expansion-v1';
const FULL_CONFIRMATION_PROTOCOL = 'frozen-candidate-full200-confirmation-v1';
function plus(target, increment) { for (const key of usageKeys) target[key] = (target[key] ?? 0) + (increment[key] ?? 0); }
async function lines(path, optional = false) {
  let raw;
  try { raw = await readFile(path,'utf8'); } catch (error) { if (optional && error.code === 'ENOENT') return []; throw error; }
  const rows = raw.replace(/^\uFEFF/,'').split(/\r?\n/);
  while (rows.length && !rows.at(-1).trim()) rows.pop();
  return rows.map((line,index) => { try { return JSON.parse(line); } catch { throw Error(`Malformed saved JSONL: ${path} line ${index+1}`); } });
}
async function backup(source, destination) { try { await copyFile(source,destination,constants.COPYFILE_EXCL); } catch (error) { if (!['EEXIST','ENOENT'].includes(error.code)) throw error; } }

/** Preserve the declared source order; a full split may have a shuffled order. */
export function validateConfirmationSelection(manifest, selection, benchmark) {
  const selectedIds = manifest.data?.taskIds;
  if (!Array.isArray(selectedIds) || ![64,200].includes(selectedIds.length) || new Set(selectedIds).size !== selectedIds.length)
    throw Error('Original manifest must declare 64 or 200 unique task IDs');
  same(selection.taskIds, selectedIds, 'original selection order');
  if (manifest.data.selectedExamples !== undefined) same(manifest.data.selectedExamples, selectedIds.length, 'declared selection size');
  if (selectedIds.length === 64) {
    same(manifest.searchPolicy?.id, SMALL_BATCH_POLICY.id, 'small-batch protocol');
    same(selectSearchTasks(benchmark.tasks).map(task => task.id), selectedIds, 'fixed public-order selection');
  } else {
    if (![EXPANDED_SEARCH_PROTOCOL,FROZEN_EXPANSION_PROTOCOL].includes(manifest.protocol?.id)) throw Error('200-task confirmation requires an expanded search or frozen full200 expansion source');
    if (manifest.protocol.id === EXPANDED_SEARCH_PROTOCOL) same(manifest.searchPolicy?.id, EXPANDED_SEARCH_PROTOCOL, 'expanded search protocol');
    if (benchmark.tasks.length !== 200 || benchmark.identity?.verified !== true) throw Error('Confirmation requires the pinned full 200-task validation split');
    same([...selectedIds].sort(), benchmark.tasks.map(task => task.id).sort(), 'full 200-task membership');
  }
  return [...selectedIds];
}

/** First-pass results are opaque immutable records, including paid retry usage. */
export function validateConfirmationCache(selectedIds, sourceRows, childRows = []) {
  const sourceIds = new Set(selectedIds.map(id => id+'#1'));
  const source = new Map(sourceRows.map(row => [row?.caseId,row]));
  if ([...source.keys()].some(id => !sourceIds.has(id))) throw Error('Source cache includes cases outside its frozen first-pass selection');
  if (selectedIds.some(id => !completeRow(source.get(id+'#1')))) throw Error(`Confirmation requires all ${selectedIds.length} original first-pass results`);
  const validIds = new Set(selectedIds.flatMap(id => [id+'#1',id+'#2',id+'#3']));
  const cases = new Map(source);
  for (const row of [...source.values(),...childRows]) {
    if (!validIds.has(row?.caseId)) throw Error(`Confirmation cache has cases outside the frozen ${selectedIds.length} × 3`);
    if (completeRow(row) && (typeof row.prediction !== 'string' || !Number.isFinite(row.score))) throw Error('Malformed reusable confirmation case');
  }
  for (const row of childRows) {
    if (sourceIds.has(row.caseId)) same(row,source.get(row.caseId),'confirmation preserved first-pass result');
    cases.set(row.caseId,row);
  }
  return cases;
}

/** Admit actual provider calls, including calls made inside a native Infer node. */
export function createConfirmationCallGate(maxCalls, { settle = () => {}, usage = emptyUsage(), getSettledRecordCount = () => 0 } = {}) {
  let reserved = 0, stopped = false;
  const committed = () => usage.providerAttempts + Math.max(0,reserved-getSettledRecordCount());
  return {
    get reserved() { return reserved; },
    get committed() { return committed(); },
    stop() { stopped = true; },
    beforeNode() { settle(); if (stopped) throw Error('CONFIRMATION_STOPPED'); },
    beforeProviderCall() {
      settle();
      if (stopped) throw Error('CONFIRMATION_STOPPED');
      if (committed() >= maxCalls) { stopped = true; throw Error('CONFIRMATION_BUDGET_EXHAUSTED'); }
      reserved++;
    },
  };
}

async function confirmFrozen({flags,directory,candidateId,manifest,saved,benchmark,selectedIds,latest,artifactHash,settings,frozenCapabilities,frozenCompiler,maxCalls,concurrency,offline}) {
  const examples = selectedIds.length, totalRuns = examples*3;
  const child = join(directory,'confirmations',candidateId), evalDir = join(child,'evaluations',candidateId);
  let childManifest;
  try { childManifest = await json(join(child,'manifest.json')); } catch(error) { if(error.code!=='ENOENT')throw error; }
  const childRows = await lines(join(evalDir,'live-samples.jsonl'),true);
  if (!childManifest && childRows.length) throw Error('Confirmation cache has no identity manifest');
  const cases = validateConfirmationCache(selectedIds,[...latest.values()],childRows);
  const mechanismFiles=await readdir(join(directory,'mechanism'));
  const mechanismSources=await Promise.all(mechanismFiles.map(async name=>[name,await readFile(join(directory,'mechanism',name),'utf8')]));
  const firstPassSummary=await json(join(directory,'evaluations',candidateId,'summary.json'));
  same(firstPassSummary.examples,examples,'first-pass examples');same(firstPassSummary.repeats,1,'first-pass repeats');
  if (firstPassSummary.valid !== true) throw Error('Source first-pass summary must be complete and valid before confirmation');
  if(childManifest) {
    same(childManifest.confirmation?.artifactHash,artifactHash,'confirmation artifact');
    same(childManifest.model,manifest.model,'confirmation model');same(childManifest.endpoint,manifest.endpoint,'confirmation endpoint');
    same(childManifest.generation,manifest.generation,'confirmation generation');same(childManifest.data,manifest.data,'confirmation data');same(childManifest.repeats,3,'confirmation repeats');
    same(await json(join(child,'candidates',candidateId+'.json')),saved,'confirmation candidate');
    same((await json(join(child,'selection.json'))).taskIds,selectedIds,'confirmation selected tasks');
    for(const [name,source] of mechanismSources)same(await readFile(join(child,'mechanism',name),'utf8'),source,'confirmation mechanism '+name);
  }
  const {sharedTools,unwrap,parseJson,answerText}=frozenCapabilities;
  const usage=emptyUsage(),accounted=new WeakMap(),priorUsage={...childManifest?.newUsage},reusable=[...cases.values()].filter(completeRow).length;
  const totalNewUsage=()=>{const total={...priorUsage};plus(total,usage);return total;};
  let stopped=false,experiment,settledRecordCount=0;
  const settle=records=>{for(const record of records??[]){const current=summarizeProviderDiagnostics([record]);if(!accounted.has(record))settledRecordCount++;const before=accounted.get(record)??emptyUsage();plus(usage,Object.fromEntries(usageKeys.map(key=>[key,(current[key]??0)-(before[key]??0)])));accounted.set(record,current);}};
  const gate = createConfirmationCallGate(maxCalls,{usage,getSettledRecordCount:()=>settledRecordCount,settle:()=>settle(currentProviderDiagnostics())});
  const capabilities={graph,graphStep,loop,model:{provider:'deepseek',model:settings.model},generation:GENERATION,unwrap,parseJson,answerText,allowedTools:sharedTools.map(tool=>tool.name),beforeNode:()=>gate.beforeNode()};
  const compile=()=>{if(manifest.representation==='A')return frozenCompiler.compileGeneratedWorkflowA(saved.proposal.source,capabilities);const trace=[];return {definition:frozenCompiler.compileEvidenceDefinition(saved.proposal.definition,capabilities,{trace}),trace};};
  compile();
  emit({phase:'confirmation-preflight',directory:child,candidateId,artifactHash,examples,totalRuns,repeats:3,concurrency,reusableCases:reusable,missingOrInvalid:totalRuns-reusable,maxAdditionalCalls:maxCalls,offline});
  if(offline)return;
  await mkdir(evalDir,{recursive:true});
  await backup(join(directory,'manifest.json'),join(directory,'manifest-before-confirmation-'+candidateId+'.json'));
  await backup(join(child,'manifest.json'),join(child,'manifest-before-confirmation.json'));
  const write=async(file,value)=>{const path=join(child,file);await mkdir(dirname(path),{recursive:true});await writeFile(path,JSON.stringify(value,null,2)+'\n');};
  const appends=new Map();
  const append=async(path,value)=>{const pending=(appends.get(path)??Promise.resolve()).then(()=>appendFile(path,JSON.stringify(value)+'\n'));appends.set(path,pending);await pending;};
  const startedAt=new Date().toISOString();
  const protocolId=examples===64?SMALL_BATCH_POLICY.id:FULL_CONFIRMATION_PROTOCOL;
  const confirmation={candidateId,repeats:3,examples,scope:`frozen-candidate-same${examples}`,frozen:true,noOptimization:true,artifactHash,sourceRun:directory,sourceProtocol:manifest.protocol?.id,
    firstPassReused:true,firstPassScore:firstPassSummary.score,firstPassLogicalCalls:firstPassSummary.providerAttemptCount,
    firstPassPreviouslySpent:{providerAttempts:firstPassSummary.providerAttemptCount,inputTokens:firstPassSummary.inputTokens,
      outputTokens:firstPassSummary.outputTokens,totalTokens:firstPassSummary.totalTokens,unknownUsageAttempts:firstPassSummary.unknownUsageAttemptCount}};
  childManifest={...manifest,...childManifest,status:'confirmation-running',repeats:3,concurrency,
    confirmation,protocol:{...manifest.protocol,id:protocolId,validationRepeats:3,...examples===200?{scope:'frozen-full200-three-repeats',fullFiveRepeatClaim:false}:{}},
    budget:{maxAdditionalCalls:maxCalls,policy:'provider admission for every actual invocation; original search history and budget unchanged'},cachedRuns:examples,
    cachedConfirmationRuns:reusable-examples,optimizerUsage:emptyUsage()};
  delete childManifest.best;delete childManifest.confirmations;delete childManifest.error;
  delete childManifest.budgetCompletionAllowance;delete childManifest.reservedRequests;
  const priorTraces=await lines(join(evalDir,'public-traces.jsonl'),true);
  let persistQueue=Promise.resolve();
  const persist=status=>{persistQueue=persistQueue.then(async()=>{const combined=totalNewUsage();Object.assign(childManifest,{status,newUsage:combined,evaluationUsage:combined,completionUsage:{...usage},budgetCompletionAllowance:{maxAdditionalCalls:maxCalls,reservedRequests:gate.reserved,settledRecords:settledRecordCount,committedRequests:gate.committed,usage:{...usage},startedAt},completedValid:[...cases.values()].filter(completeRow).length});await write('manifest.json',childManifest);});return persistQueue;};
  for(const [name] of mechanismSources){const path=join(child,'mechanism',name);await mkdir(dirname(path),{recursive:true});await backup(join(directory,'mechanism',name),path);}
  await write('candidates/'+candidateId+'.json',saved);
  await write('checkpoints/'+candidateId+'.json',await json(join(directory,'checkpoints',candidateId+'.json')));
  await write('selection.json',{...await json(join(directory,'selection.json')),repeats:3,confirmation});
  // Keep the reused first pass in the independent cache before dispatching any
  // new provider calls. Later resumes preserve these exact original records.
  const cachedFirstIds=new Set((await lines(join(evalDir,'live-samples.jsonl'),true)).filter(row=>row.caseId.endsWith('#1')).map(row=>row.caseId));
  const missingFirst=selectedIds.map(id=>latest.get(id+'#1')).filter(row=>!cachedFirstIds.has(row.caseId));
  if(missingFirst.length)await appendFile(join(evalDir,'live-samples.jsonl'),missingFirst.map(row=>JSON.stringify(row)).join('\n')+'\n');
  await persist('confirmation-running');
  let summary,failure;
  try {
    if(reusable<totalRuns)experiment=createExperimentRuntime(settings,{tools:sharedTools,beforeProviderCall:()=>gate.beforeProviderCall()});
    if(experiment)capabilities.model={provider:experiment.providerName,model:experiment.model};
    const runner=task=>captureProviderDiagnostics(async records=>{const fresh=compile(),graphEvents=[];try{if(stopped)throw Error('CONFIRMATION_STOPPED');const raw=await experiment.runtime.loop(fresh.definition,task,{onGraph:event=>graphEvents.push(event)}),result=typeof raw==='string'?{answer:raw}:raw;return {answer:answerText(result.answer),executedNodeIds:fresh.trace.filter(event=>event.kind==='node').map(event=>event.nodeId),executedGraphIds:graphEvents.filter(event=>event.status==='completed').map(event=>event.graphId),...summarizeProviderDiagnostics(records)};}catch(error){throw Object.assign(error,summarizeProviderDiagnostics(records));}finally{settle(records);const trace={taskId:task.id,events:fresh.trace,confirmation:true,at:new Date().toISOString()};priorTraces.push(trace);await append(join(evalDir,'public-traces.jsonl'),trace);}});
    summary=await benchmark.evaluateSearchSubset(selectedIds,runner,{repeats:3,concurrency,retryAttempts:1,priorCases:[...cases.values()],async onCase({completed,total,result}){
      const reused=cases.get(result.caseId)===result;cases.set(result.caseId,result);if(!reused)await append(join(evalDir,'live-samples.jsonl'),result);
      await persist('confirmation-running');if(!completeRow(result)){stopped=true;gate.stop();throw Error(result.error??'Invalid confirmation case');}
      if(!reused)emit({phase:'confirmation-progress',candidateId,completed,total,newCalls:usage.providerAttempts});
    }});
  }catch(error){stopped=true;gate.stop();failure=error;const rows=selectedIds.flatMap(id=>[1,2,3].map(repeat=>cases.get(id+'#'+repeat))).filter(Boolean),sum=key=>rows.reduce((total,row)=>total+(row[key]??0),0);summary={valid:false,score:0,repeatScores:[0,0,0],examples,repeats:3,validRuns:rows.filter(completeRow).length,successfulRuns:rows.filter(completeRow).length,failedRuns:rows.filter(row=>!completeRow(row)).length,missingRuns:totalRuns-rows.length,totalTokens:sum('totalTokens'),inputTokens:sum('inputTokens'),outputTokens:sum('outputTokens'),providerAttemptCount:sum('providerAttempts'),tokenUsageStatus:rows.every(row=>row.usageKnown)?'complete':'known-lower-bound',results:rows};}
  finally{if(experiment)await experiment.close();}
  same(await json(join(directory,'candidates',candidateId+'.json')),saved,'frozen candidate unchanged during confirmation');
  for(const [name,source] of mechanismSources)same(await readFile(join(directory,'mechanism',name),'utf8'),source,'frozen mechanism unchanged '+name);
  const {results,...stats}=summary;
  await write('evaluations/'+candidateId+'/summary.json',{...stats,stage:examples,protocol:protocolId,confirmation:true,
    reusedCases:examples,resumedConfirmationCases:reusable-examples,newUsage:totalNewUsage(),completionUsage:{...usage},
    firstPassScore:firstPassSummary.score,firstPassPreviouslySpent:confirmation.firstPassPreviouslySpent});
  await writeFile(join(evalDir,'samples.jsonl'),results.map(row=>JSON.stringify(row)).join('\n')+'\n');
  await write('history.json',[{id:candidateId,proposal:saved.proposal,status:summary.valid?'valid':'invalid',evaluation:summary,confirmation,noOptimization:true}]);
  await persist(summary.valid?'confirmation-complete':'confirmation-incomplete');
  // Only attach a reference to this independent result; never change the
  // parent's search scores/best selection or add child fees to parent newUsage.
  const parent=await json(join(directory,'manifest.json'));
  parent.confirmations={...parent.confirmations,[candidateId]:{directory:child,repeats:3,scope:confirmation.scope,noOptimization:true,valid:summary.valid,score:summary.valid?summary.score:null,newUsageLocation:join(child,'manifest.json')}};
  await writeFile(join(directory,'manifest.json'),JSON.stringify(parent,null,2)+'\n');
  emit({phase:'confirmation-finished',directory:child,candidateId,valid:summary.valid,score:summary.valid?summary.score:null,repeatScores:summary.repeatScores,newUsage:childManifest.newUsage,...failure?{error:failure.message}:{}});
  if(flags.report){const report=resolve(flags.report),rendered=spawnSync((process.env.DITTO_REPORT_PYTHON??process.env.DITTO_PROVIDER_PYTHON??(process.platform==='win32'?'python':'python3')),[join(projectRoot,'scripts','render-workflow-report.py'),child,'--output',report],{encoding:'utf8',windowsHide:true,cwd:projectRoot});emit({phase:'workflow-report',path:report,rendered:rendered.status===0});}
  if(!summary.valid)process.exitCode=1;
}

export async function main(argv = process.argv.slice(2)) {
  const flags = {};
  for (let i=0; i<argv.length; i+=2) {
    const key = argv[i], value = argv[i+1];
    if (!['--run-dir','--candidate','--max-calls','--report','--offline-only','--repeats','--concurrency'].includes(key) || value === undefined) throw Error('Use --run-dir PATH --candidate ID [--repeats 1|3] [--concurrency 3] [--max-calls 40] [--report PNG] [--offline-only true]');
    if (Object.hasOwn(flags,key.slice(2))) throw Error('Duplicate option');
    flags[key.slice(2)] = value;
  }
  if (!flags['run-dir'] || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(flags.candidate ?? '')) throw Error('Run directory and simple candidate ID are required');
  if (flags['offline-only'] !== undefined && !['true','false'].includes(flags['offline-only'])) throw Error('offline-only must be true or false');
  const maxCalls = Number(flags['max-calls'] ?? 40), offline = flags['offline-only'] === 'true';
  const repeats=Number(flags.repeats??1);if(![1,3].includes(repeats))throw Error('repeats must be 1 or 3');
  const concurrency=Number(flags.concurrency??1);if(!Number.isSafeInteger(concurrency)||concurrency<1)throw Error('concurrency must be a positive safe integer');
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1) throw Error('max-calls must be a positive safe integer');
  const directory = resolve(flags['run-dir']), candidateId = flags.candidate;
  const candidatePath = join(directory,'candidates',candidateId+'.json');
  const manifest = await json(join(directory,'manifest.json'));
  const selection = await json(join(directory,'selection.json'));
  const saved = await json(candidatePath), history = await json(join(directory,'history.json'));
  const settings = { ...loadProviderSettings(offline ? { ...process.env, CODE_SOUL_API_KEY:process.env.CODE_SOUL_API_KEY || 'offline-unused' } : process.env), concurrency:repeats===3?concurrency:1 };
  if (manifest.dataset !== 'drop' || manifest.split !== 'validate' || !['A','B'].includes(manifest.representation)) throw Error('Only saved generated DROP validation runs are supported');
  same(saved.representation,manifest.representation,'candidate representation');
  same(settings.model,manifest.model,'model'); same(settings.baseUrl,manifest.endpoint,'endpoint');
  same(GENERATION,manifest.generation,'frozen generation'); same(manifest.repeats,1,'one execution per task');
  const benchmark = await loadBenchmark('drop',{dataDir:join(projectRoot,'data','datasets'),split:'validate',limit:0});
  same(benchmark.identity,manifest.data?.identity,'pinned data identity');
  same(selection.sourceIdentity,benchmark.identity,'selection source identity');
  const selectedIds = validateConfirmationSelection(manifest,selection,benchmark);
  if (repeats === 1 && selectedIds.length !== 64) throw Error('Use --repeats 3 to confirm a complete 200-task source; incomplete 200-task runs are not completed by this tool');
  const artifactField = manifest.representation === 'A' ? 'source' : 'definition';
  const artifactHash = digest(saved.proposal?.[artifactField]);
  if (typeof saved.artifactHash !== 'string' || saved.artifactHash !== artifactHash) throw Error('Candidate artifactHash differs from its current original content');
  if (manifest.protocol?.id === FROZEN_EXPANSION_PROTOCOL) same(manifest.expansion?.artifactHash,artifactHash,'frozen expanded candidate hash');
  if (!Array.isArray(history)) throw Error('Saved history must be an array');
  const record = history.find(row => row.id === candidateId);
  if (!record) throw Error('Candidate is missing from saved history');
  same(record.proposal,saved.proposal,'history proposal and immutable candidate');
  const evaluationDir = join(directory,'evaluations',candidateId);
  const latest = new Map((await lines(join(evaluationDir,'live-samples.jsonl'))).map(row => [row.caseId,row]));
  const selectedCases = new Set(selectedIds.map(id => id+'#1'));
  if ([...latest.keys()].some(id => !selectedCases.has(id))) throw Error(`Live results include cases outside the original ${selectedIds.length} × 1 selection`);
  for (const row of latest.values()) if (completeRow(row) && (typeof row.prediction !== 'string' || !Number.isFinite(row.score))) throw Error('Malformed reusable case');
  const reusableIds = new Set([...latest.values()].filter(completeRow).map(row => row.caseId));
  const originalTraces = await lines(join(evaluationDir,'public-traces.jsonl'),true);
  // Use this run's frozen mechanism rather than silently changing its executor.
  const mechanism = join(directory,'mechanism');
  const frozenCapabilities = await import(pathToFileURL(join(mechanism,'workflow-capabilities.mjs')).href);
  const frozenCompiler = await import(pathToFileURL(join(mechanism,manifest.representation === 'A' ? 'generated-workflow-a.mjs' : 'generated-workflow-b.mjs')).href);
  if(repeats===3)return confirmFrozen({flags,directory,candidateId,manifest,saved,benchmark,selectedIds,latest,artifactHash,settings,frozenCapabilities,frozenCompiler,maxCalls,concurrency,offline});
  const {sharedTools,unwrap,parseJson,answerText} = frozenCapabilities;
  const completionUsage = emptyUsage(), accounted = new WeakMap();
  let reservations = 0, stopped = false, experiment;
  const originalUsage = { ...manifest.newUsage }, originalEvaluationUsage = { ...manifest.evaluationUsage };
  const previousCompletionUsage = { ...manifest.completionUsage };
  const startedAt = new Date().toISOString();
  function settle(records) {
    for (const item of records ?? []) {
      const current = summarizeProviderDiagnostics([item]), prior = accounted.get(item) ?? emptyUsage();
      plus(completionUsage,Object.fromEntries(usageKeys.map(key => [key,(current[key]??0)-(prior[key]??0)])));
      accounted.set(item,Object.fromEntries(usageKeys.map(key => [key,current[key]??0])));
    }
  }
  const capabilities = {graph,graphStep,loop,model:{provider:'deepseek',model:settings.model},generation:GENERATION,unwrap,parseJson,answerText,
    allowedTools:sharedTools.map(tool => tool.name),beforeNode({type}) {
      settle(currentProviderDiagnostics());
      if (stopped) throw Error('COMPLETION_STOPPED: no further operations dispatched');
      if (type === 'INFER.REASONING.SAMPLE') {
        if (Math.max(reservations,completionUsage.providerAttempts) >= maxCalls) { stopped = true; throw Error('COMPLETION_BUDGET_EXHAUSTED'); }
        reservations++;
      }
    }};
  function compile() {
    if (manifest.representation === 'A') return frozenCompiler.compileGeneratedWorkflowA(saved.proposal.source,capabilities);
    const trace = [], definition = frozenCompiler.compileEvidenceDefinition(saved.proposal.definition,capabilities,{trace});
    return {definition,trace};
  }
  compile(); // Offline construction validates the unchanged candidate before any API access.
  emit({phase:'completion-preflight',directory,candidateId,artifactHash,reusableCases:reusableIds.size,missingOrInvalid:64-reusableIds.size,maxAdditionalCalls:maxCalls,offline});
  if (offline) return;
  await mkdir(evaluationDir,{recursive:true});
  await backup(join(directory,'manifest.json'),join(directory,'manifest-before-completion.json'));
  await backup(join(directory,'history.json'),join(directory,'history-before-completion.json'));
  await backup(join(evaluationDir,'summary.json'),join(evaluationDir,'summary-before-completion.json'));
  const log = async value => { const event = {at:new Date().toISOString(),...value}; await appendFile(join(directory,'completion-log.jsonl'),JSON.stringify(event)+'\n'); emit(event); };
  const write = async(file,value) => { const path = join(directory,file); await mkdir(dirname(path),{recursive:true}); await writeFile(path,JSON.stringify(value,null,2)+'\n'); };
  const aggregatePartial = () => {
    const rows = selectedIds.map(id => latest.get(id+'#1')).filter(Boolean), sum = key => rows.reduce((total,row) => total+(row[key]??0),0);
    return {valid:false,score:0,repeatScores:[0],standardDeviation:0,examples:64,repeats:1,results:rows,
      validRuns:rows.filter(completeRow).length,successfulRuns:rows.filter(completeRow).length,failedRuns:rows.filter(row => !completeRow(row)).length,
      missingRuns:64-rows.length,timeoutRuns:rows.filter(row => row.failureKind==='timeout').length,wrongRuns:rows.filter(row => completeRow(row)&&row.score===0).length,
      inputTokens:sum('inputTokens'),outputTokens:sum('outputTokens'),totalTokens:sum('totalTokens'),providerAttemptCount:sum('providerAttempts'),
      unknownUsageAttemptCount:sum('unknownUsageAttempts'),tokenUsageStatus:rows.every(row => row.usageKnown)?'complete':'known-lower-bound',durationMs:Date.now()-Date.parse(startedAt)};
  };
  async function persist(summary, status) {
    record.evaluation = summary; record.status = summary.valid?'valid':'invalid'; record.traces = originalTraces;
    record.completion = {startedAt,updatedAt:new Date().toISOString(),artifactHash,reusedCases:reusableIds.size,completedValid:summary.validRuns,status};
    const mergedUsage = { ...originalUsage }; plus(mergedUsage,completionUsage);
    const mergedEvaluationUsage = { ...originalEvaluationUsage }; plus(mergedEvaluationUsage,completionUsage);
    const allCompletionUsage = { ...previousCompletionUsage }; plus(allCompletionUsage,completionUsage);
    Object.assign(manifest,{newUsage:mergedUsage,evaluationUsage:mergedEvaluationUsage,completionUsage:allCompletionUsage,
      budgetCompletionAllowance:{candidateId,startedAt,maxAdditionalCalls:maxCalls,originalBudget:{...manifest.budget},
        usage:{...completionUsage},reservedRequests:reservations,concurrency:1,reusedCases:reusableIds.size,status,
        note:'Explicit completion allowance is additional to the preserved original search budget; no new proposals or candidate edits.'}});
    const best = bestFullCandidate(history);
    if (best) {
      manifest.best = {candidateId:best.id,score:best.evaluation.score,examples:64,repeats:1};
      await write('best/candidate.json',best.proposal);
      await write('best/validation-summary.json',{...best.evaluation,results:undefined});
      try { const checkpoint = await json(join(directory,'checkpoints',best.id+'.json')); await write('best/plan.json',checkpoint.plan); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    manifest.status = best?.evaluation.valid === true && best.evaluation.examples === 64 && best.evaluation.score > 0.90 ? 'target-reached' : status;
    await write('history.json',history); await write('manifest.json',manifest);
  }
  let summary, failure;
  await log({phase:'completion-start',candidateId,reusedCases:reusableIds.size,maxAdditionalCalls:maxCalls,originalSearchMaxCalls:manifest.budget?.maxCalls});
  try {
    if (reusableIds.size < 64) experiment = createExperimentRuntime(settings,{tools:sharedTools});
    if (experiment) capabilities.model = {provider:experiment.providerName,model:experiment.model};
    const runner = task => captureProviderDiagnostics(async records => {
      const fresh = compile(), graphEvents = [];
      try {
        if (stopped) throw Error('COMPLETION_STOPPED');
        const raw = await experiment.runtime.loop(fresh.definition,task,{onGraph:event => graphEvents.push(event)});
        const result = typeof raw === 'string'?{answer:raw}:raw;
        return {answer:answerText(result.answer),executedNodeIds:fresh.trace.filter(event => event.kind==='node').map(event => event.nodeId),
          executedGraphIds:graphEvents.filter(event => event.status==='completed').map(event => event.graphId),...summarizeProviderDiagnostics(records)};
      } catch (error) { throw Object.assign(error,summarizeProviderDiagnostics(records)); }
      finally {
        settle(records);
        const trace = {taskId:task.id,events:fresh.trace,completion:true,at:new Date().toISOString()};
        originalTraces.push(trace);
        await appendFile(join(evaluationDir,'public-traces.jsonl'),JSON.stringify(trace)+'\n');
      }
    });
    summary = await benchmark.evaluateSearchSubset(selectedIds,runner,{repeats:1,concurrency:1,retryAttempts:1,priorCases:[...latest.values()],
      async onCase({completed,total,result}) {
        const reused = reusableIds.has(result.caseId) && latest.get(result.caseId)===result;
        latest.set(result.caseId,result);
        if (!reused) await appendFile(join(evaluationDir,'live-samples.jsonl'),JSON.stringify(result)+'\n');
        await persist(aggregatePartial(),'completion-running');
        if (!completeRow(result)) { stopped = true; throw Error(result.error ?? 'Completion execution invalid'); }
        if (!reused) await log({phase:'completion-progress',candidateId,completed,total,newCalls:completionUsage.providerAttempts});
      }});
  } catch (error) { stopped = true; failure = error; summary = aggregatePartial(); }
  finally { if (experiment) await experiment.close(); }
  const {results,...stats} = summary;
  await write('evaluations/'+candidateId+'/summary.json',{...stats,stage:64,protocol:SMALL_BATCH_POLICY.id,reusedCases:reusableIds.size,
    newUsage:{...completionUsage},completionUsage:{...completionUsage},completionAllowance:maxCalls,completionStatus:summary.valid?'complete':'incomplete'});
  await writeFile(join(evaluationDir,'samples.jsonl'),results.map(row => JSON.stringify(row)).join('\n')+'\n');
  await persist(summary,summary.valid?'completion-finished':'completion-incomplete');
  // Detect any external candidate edit as well; never publish a changed artifact.
  same(await json(candidatePath),saved,'candidate remained unchanged during completion');
  await log({phase:'completion-finished',candidateId,valid:summary.valid,score:summary.valid?summary.score:null,
    completedValid:summary.validRuns,reusedCases:reusableIds.size,completionUsage,newUsage:manifest.newUsage,status:manifest.status,
    ...(failure?{error:failure.message}:{})});
  if (flags.report) {
    const report = resolve(flags.report), python = (process.env.DITTO_REPORT_PYTHON??process.env.DITTO_PROVIDER_PYTHON??(process.platform==='win32'?'python':'python3'));
    const rendered = spawnSync(python,[join(projectRoot,'scripts','render-workflow-report.py'),directory,'--output',report],{encoding:'utf8',windowsHide:true,cwd:projectRoot});
    emit({phase:'workflow-report',path:report,rendered:rendered.status===0});
  }
  if (!summary.valid) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => { emit({phase:'completion-rejected',error:error.message}); process.exitCode=1; });
