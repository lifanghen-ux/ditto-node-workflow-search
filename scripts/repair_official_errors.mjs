import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile,writeFile,access} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {UnifiedRunStore,artifactHash} from '../dist/unified/store.js';
import {createProviderBudget} from '../dist/unified/provider-budget.js';

// Diagnostic repair of measured Search failures, not a formal search winner.
// Reuse a parent only when executable/prompt/data identities still match.
const flags=new Map();for(let i=2;i<process.argv.length;i+=2)flags.set(process.argv[i].replace(/^--/,''),process.argv[i+1]);
if(!flags.get('prior-run')||!flags.get('candidate')||!flags.get('output')||!flags.get('data-dir'))throw Error('--prior-run, --candidate, --data-dir and --output are required');
const prior=new UnifiedRunStore(resolve(flags.get('prior-run'))),id=flags.get('candidate');
const manifest=await prior.read('manifest.json'),selection=await prior.read('selection.json');
const parent=await prior.read(`candidates/${id}.json`),measured=await prior.read(`evaluations/${id}/summary.json`);
const dataset=manifest.dataset,store=new UnifiedRunStore(resolve(flags.get('output')));
const fromSnapshot=flags.get('from-snapshot')==='true';
const upgradeFeedback=flags.get('upgrade-feedback')==='true';
const frameworkUpgrade=flags.get('framework-upgrade')==='true';
if(frameworkUpgrade&&(fromSnapshot||upgradeFeedback))throw Error('Framework upgrade uses the current coherent build; do not mix snapshot/feedback-only modes');
if(upgradeFeedback&&!fromSnapshot)throw Error('Feedback upgrade requires a verified original snapshot');
const concurrency=Number(flags.get('concurrency')??1);
if(!Number.isSafeInteger(concurrency)||concurrency<1||concurrency>4)throw Error('Concurrency must be 1..4');
if(await store.optional('manifest.json'))throw Error('Use a fresh diagnostic output directory');
if(fromSnapshot)execFileSync(process.execPath,['--experimental-vm-modules','scripts/complete_official_measurement.mjs','--run',prior.directory,'--candidate',id,'--data-dir',resolve(flags.get('data-dir')),'--from-snapshot','true','--prepare-only','true'],{windowsHide:true,stdio:'pipe'});
// Load all context-owning modules from one verified build, including the BFCL
// bridge scope and provider diagnostics. Never mix their AsyncLocalStorage.
let moduleRoot=fromSnapshot?prior.path('code-snapshot/dist'):resolve('dist');
let executionFiles=fromSnapshot?manifest.sourceIdentity.files:undefined;
const feedbackChanges=[];
if(upgradeFeedback){
 // Rebuild one coherent module tree. Only presentation modules are replaced;
 // original runtime, tools, provider, bridge and scorer remain byte-identical.
 await store.snapshot(prior.path('code-snapshot'));
 executionFiles={...manifest.sourceIdentity.files};
 for(const file of ['src/unified/feedback.ts','src/unified/evidence.ts']){
  const bytes=await readFile(resolve(file)),sha256=createHash('sha256').update(bytes).digest('hex');
  await writeFile(store.path('code-snapshot/'+file),bytes);
  if(executionFiles[file]!==sha256)feedbackChanges.push({file,before:executionFiles[file],after:sha256});
  executionFiles[file]=sha256;
 }
 const configuration=JSON.parse(await readFile(resolve('tsconfig.json'),'utf8'));
 moduleRoot=store.path('code-snapshot/dist');
 configuration.compilerOptions={...configuration.compilerOptions,rootDir:store.path('code-snapshot/src'),outDir:moduleRoot};
 configuration.include=[store.path('code-snapshot/src/**/*.ts')];
 const configurationPath=store.path('code-snapshot/feedback.tsconfig.json');
 await writeFile(configurationPath,JSON.stringify(configuration));
 execFileSync(process.execPath,[resolve('node_modules/typescript/bin/tsc'),'-p',configurationPath],{windowsHide:true,stdio:'pipe'});
}
const module=path=>import(pathToFileURL(resolve(moduleRoot,path)).href);
const [{loadBenchmark,DockerPythonJudge},{loadProviderSettings},{createExperimentRuntime},{runOfficialAgent},
 {searchOfficialWorkflows,assertOfficialComplete},{evaluateTasks},{officialArtifactHash},{generatedTools},
 {evaluateUnifiedCandidate},{EvaluationTraceView,selectionEvaluation},{OFFICIAL_OPTIMIZER_SYSTEM_SHA256},
 {NODE_SYSTEM_PROMPT_SHA256},{GENERATION}]=await Promise.all([
 module('benchmark/index.js'),module('config.js'),module('ditto/runtime.js'),module('official-agent/executor.js'),
 module('official-agent/search.js'),module('benchmark/evaluator.js'),module('official-agent/schema.js'),module('graph-agent/tools.js'),
 module('unified/evaluation.js'),module('unified/evidence.js'),module('official-agent/prompts.js'),
 module('graph-agent/system.js'),module('protocol.js')]);
const maxProposalAttempts=Number(flags.get('proposal-attempts')??3);
const newCandidates=Number(flags.get('new-candidates')??3);
const exploration=flags.get('exploration')==='true';
const selectedIds=flags.has('task-ids')?flags.get('task-ids').split(','):undefined;
if(selectedIds&&(!selectedIds.length||new Set(selectedIds).size!==selectedIds.length||selectedIds.some(id=>!selection.tasks.some(task=>task.id===id))))throw Error('Selected IDs must be unique measured public Search tasks');
if(!Number.isSafeInteger(newCandidates)||newCandidates<1||newCandidates>6)throw Error('New candidate budget must be 1..6');
if(!Number.isSafeInteger(maxProposalAttempts)||maxProposalAttempts<1||maxProposalAttempts>6)throw Error('Diagnostic proposal attempts must be 1..6');
if(!['drop','mbpp','bfcl'].includes(dataset)||!measured.valid||measured.repeats!==1||parent.toolArtifacts?.length)throw Error('Expected a complete single-pass parent without custom tools');
const files={};
for(const file of execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z','src','scripts','prompts','package.json','package-lock.json','tsconfig.json'],{encoding:'utf8',windowsHide:true}).split('\0').filter(Boolean).sort())files[file]=createHash('sha256').update(await readFile(file)).digest('hex');
// These modules validate/propose/project measurements; they do not run the
// already measured parent's native operations, bridge, provider or scorer.
const validationAndFeedbackOnly=new Set(['scripts/repair_official_errors.mjs','scripts/complete_official_measurement.mjs','scripts/validate_official_search_small.mjs','src/unified/feedback.ts','src/unified/evidence.ts','src/unified/search.ts','src/unified/search-objective.ts','src/official-agent/task-generality.ts','src/official-agent/schema.ts','src/official-agent/proposal-contract.ts','src/official-agent/search.ts','src/official-agent/native-contracts.ts','src/benchmark/evaluation-contract.ts']);
executionFiles??=files;
function checkSource(saved){const differences=[];
for(const file of new Set([...Object.keys(executionFiles),...Object.keys(saved.sourceIdentity.files)]))if(executionFiles[file]!==saved.sourceIdentity.files[file]){
 const protectedFile=file.startsWith('prompts/')||['package.json','package-lock.json','src/config.ts','src/protocol.ts','src/model-profile.ts','src/graph-agent/system.ts'].includes(file)
  ||file.startsWith('src/benchmark/')&&file!=='src/benchmark/evaluation-contract.ts'&&!file.endsWith('.test.ts');
 if(frameworkUpgrade?protectedFile:!validationAndFeedbackOnly.has(file)&&!file.endsWith('.test.ts'))throw Error(`Measured parent executable differs: ${file}`);
 differences.push(file);
}return differences;}
const sourceDifferences=checkSource(manifest);
async function traceSource(source){
 let current=source;const visited=new Set();
 for(let depth=0;depth<16;depth++){
  const key=current.store.directory+'/'+current.id;if(visited.has(key))throw Error('Cyclic reused trace provenance');visited.add(key);
  try{await access(current.store.path(`evaluations/${current.id}/public-traces.jsonl`));return current;}catch(error){if(error.code!=='ENOENT')throw error;}
  const link=current.summary.measurementReused;if(!link?.run||!link?.candidate)throw Error('Measured candidate has no full public traces or reusable trace provenance');
  const nextStore=new UnifiedRunStore(resolve(link.run)),artifact=await nextStore.read(`candidates/${link.candidate}.json`),summary=await nextStore.read(`evaluations/${link.candidate}/summary.json`);
  checkSource(await nextStore.read('manifest.json'));
  if(officialArtifactHash(artifact.definition,artifact.toolArtifacts)!==officialArtifactHash(source.artifact.definition,source.artifact.toolArtifacts))throw Error('Reused trace artifact differs');
  const rows=new Map(summary.results.map(row=>[row.caseId,row]));
  if(!summary.valid||current.summary.results.some(row=>{const original=rows.get(row.caseId);return !original||original.score!==row.score||original.prediction!==row.prediction||original.valid!==row.valid;}))throw Error('Reused trace measurement differs');
  current={store:nextStore,id:link.candidate,artifact,summary};
 }
 throw Error('Reused trace provenance depth exceeded');
}
if(manifest.optimizerSystemSha256!==OFFICIAL_OPTIMIZER_SYSTEM_SHA256||manifest.nodeSystemSha256!==NODE_SYSTEM_PROMPT_SHA256||artifactHash(manifest.generation)!==artifactHash(GENERATION))throw Error('Measured prompt/generation differs');
const settings={...loadProviderSettings(),concurrency};if(settings.model!==manifest.model)throw Error('Measured model differs');
const archives=[];
if(flags.has('archive-run')){
 const archive=new UnifiedRunStore(resolve(flags.get('archive-run'))),archiveId=flags.get('archive-candidate')??'official-0001';
 const saved=await archive.read('manifest.json'),selected=await archive.read('selection.json'),artifact=await archive.read(`candidates/${archiveId}.json`),summary=await archive.read(`evaluations/${archiveId}/summary.json`);
 if(saved.dataset!==dataset||saved.model!==settings.model||artifactHash(selected)!==artifactHash(selection)||artifactHash(saved.generation)!==artifactHash(GENERATION)||saved.optimizerSystemSha256!==OFFICIAL_OPTIMIZER_SYSTEM_SHA256||saved.nodeSystemSha256!==NODE_SYSTEM_PROMPT_SHA256||!summary.valid||summary.repeats!==1||artifact.toolArtifacts?.length)throw Error('Archive model/data/protocol differs');
 const state=await archive.optional('search-state.json'),attempt=state?.history?.find(row=>row.id===archiveId),ancestor=state?.history?.find(row=>row.id===attempt?.parentId);
 const parentArtifactHash=ancestor?.definition?officialArtifactHash(ancestor.definition,ancestor.toolArtifacts):undefined;
 archives.push({store:archive,id:archiveId,manifest:saved,artifact,summary,parentArtifactHash,sourceDifferences:checkSource(saved)});
}
const timeBudget={...manifest.timeBudget,...(flags.has('request-ms')?{requestMs:Number(flags.get('request-ms')),reason:'Diagnostic provider recovery; retain successful measured parent outcomes without rerunning them'}:{})};
const budget=createProviderBudget({maxCalls:Number(flags.get('max-calls')??150),maxTokens:Number(flags.get('max-tokens')??5000000),onEvent:event=>store.write('provider-budget.json',event.usage)});
const driverIdentity={commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim(),sha256:artifactHash(files),files};
const sourceIdentity=fromSnapshot?{...manifest.sourceIdentity,...(upgradeFeedback?{files:executionFiles,sha256:artifactHash(executionFiles)}:{})}:driverIdentity;
const record={protocol:'official-standard-prompt-targeted-repair-v1',dataset,status:'preparing',createdAt:new Date().toISOString(),formalTest:false,formalScore:false,repeats:1,
 sourceIdentity,...(fromSnapshot?{executionSource:upgradeFeedback?'verified-original-execution-with-public-feedback-upgrade':'verified-original-code-snapshot',sourceSnapshotRun:prior.directory,driverIdentity,...(upgradeFeedback?{feedbackChanges}:{} )}:{}),evaluationConcurrency:concurrency,generation:GENERATION,model:settings.model,optimizerSystemSha256:OFFICIAL_OPTIMIZER_SYSTEM_SHA256,nodeSystemSha256:NODE_SYSTEM_PROMPT_SHA256,
 ...(frameworkUpgrade?{executionSource:'current-framework-upgrade',comparisonScope:'Historical measured parent versus a new framework/candidate combination; not a same-runtime workflow ablation. Preserve the historical source identity for any retained parent.',frameworkSourceDifferences:sourceDifferences}:{}),
 parentMeasurement:{run:prior.directory,candidate:id,artifactHash:officialArtifactHash(parent.definition),summaryHash:artifactHash(measured),executedBy:manifest.sourceIdentity.sha256,reusedWithoutModelCalls:true,sourceDifferences,originalTimeBudget:manifest.timeBudget},
 archives:archives.map(a=>({run:a.store.directory,candidate:a.id,summaryHash:artifactHash(a.summary),sourceDifferences:a.sourceDifferences,parentArtifactHash:a.parentArtifactHash})),
 selection:selectedIds?'explicit subset of measured public Search tasks; reuse exact prior case results':'same public Search cases as the measured parent',selectedTaskIds:selectedIds,exploration,maxProposalAttempts,newCandidates,targetScore:1,reason:exploration?'Protected standard worker directions with measured failure feedback.':'Isolated causal repair; retain standard optimizer, native contracts and mutation validation without forcing an unrelated worker change.',timeBudget};
await store.write('manifest.json',record);if(!upgradeFeedback)await store.snapshot(fromSnapshot?prior.path('code-snapshot'):process.cwd());
let shared;
try{
 if(dataset==='mbpp')await new DockerPythonJudge({image:'python:3.13-slim'}).preflight();
 const benchmark=await loadBenchmark(dataset,{dataDir:resolve(flags.get('data-dir')),split:'validate',dataMode:'formal',limit:0,artifactDir:store.path('private'),...(dataset==='mbpp'?{codeJudge:new DockerPythonJudge({image:'python:3.13-slim'})}:{})});
 if(artifactHash(benchmark.identity)!==artifactHash(selection.data))throw Error('Measured data identity differs');
 const originalTasks=selection.tasks.map(saved=>{const task=benchmark.tasks.find(task=>task.id===saved.id);if(!task||artifactHash(task)!==artifactHash(saved))throw Error('Measured public task differs');return task;});
 const tasks=selectedIds?selectedIds.map(id=>originalTasks.find(task=>task.id===id)):originalTasks,subset={...benchmark,tasks};
 await store.write('selection.json',{...selection,tasks,...(selectedIds?{selectionRule:'all selected prior failures plus explicit successful controls; diagnostic subset, not an accuracy estimate'}:{})});
 shared=createExperimentRuntime(settings,{timeBudget,connectTimeoutMs:10000,beforeProviderCall:async input=>{await budget.beforeProviderCall(input);await store.append('provider-requests.jsonl',{metadata:input.metadata,input});},afterProviderCall:async event=>{await budget.afterProviderCall(event);await store.append('provider-responses.jsonl',{metadata:event.input.metadata,output:event.output,error:event.error?.message,diagnostics:event.diagnostics});}});
 const emit=async event=>{await store.append('events.jsonl',{at:new Date().toISOString(),...event});if(['case-completed','unified-candidate-proposed','unified-design-skipped','measurement-reused'].includes(event.type))console.log(JSON.stringify({dataset,type:event.type,candidateId:event.candidateId??event.pending?.id,caseId:event.caseId,score:event.score}));};
 const seeds=[];
 for(const [index,source]of [{store:prior,id,artifact:parent,summary:measured},...archives].entries()){
  assertOfficialComplete(source.summary,originalTasks,1);
  const projected=selectedIds?await evaluateTasks(tasks,{score(){throw Error('Never rescore measured subset');},expectedLabel(){throw Error('No label access');}},async()=>{throw Error('Never regenerate measured subset');},{repeats:1,priorCases:source.summary.results}):source.summary;
  const seedId=`official-${String(index+1).padStart(4,'0')}`,traces=new EvaluationTraceView(tasks.map(task=>task.id),1);
  const original=await traceSource(source);
  for await(const trace of original.store.scan(`evaluations/${original.id}/public-traces.jsonl`)){
   if(!tasks.some(task=>task.id===trace.taskId))continue;
   traces.add(trace);await store.append(`evaluations/${seedId}/public-traces.jsonl`,trace);
  }
  const publicTraces=traces.views(projected.results),prefix=`evaluations/${seedId}`;
  await store.write(`candidates/${seedId}.json`,source.artifact);
  // Imported candidates remain roots in this new search. Their separately
  // verified measurement lineage retains paired repairs and regressions.
  const comparisonParentId=source.parentArtifactHash===officialArtifactHash(parent.definition,parent.toolArtifacts)?'official-0001':undefined;
  const comparison=comparisonParentId?{comparisonParentId}:{};
  await store.write(`${prefix}/summary.json`,{...projected,...comparison,publicTraces,measurementReused:{run:source.store.directory,candidate:source.id,...(frameworkUpgrade?{executionSource:source.manifest?.sourceIdentity?.sha256??manifest.sourceIdentity.sha256,historicalFramework:true}:{}),...(selectedIds?{projection:'exact prior case IDs, reaggregated without scoring or generation'}:{})}});
  seeds.push({id:seedId,parentId:null,status:'valid',designRound:0,proposalAttempt:0,definition:source.artifact.definition,rationale:'Imported complete single-pass Search measurement; preserve its strengths and observed failures.',artifactHash:officialArtifactHash(source.artifact.definition),evaluation:selectionEvaluation({...projected,...comparison},prefix,publicTraces)});
  await emit({type:'measurement-reused',candidateId:seedId,score:projected.score});
 }
 const result=await searchOfficialWorkflows({runtime:shared.runtime,model:{provider:shared.providerName,model:shared.model},dataset,publicTasks:tasks,expectedExamples:tasks.length,expectedRepeats:1,
  maxValidEvaluations:seeds.length+newCandidates,maxDesignRounds:newCandidates+1,maxProposalAttempts,...(!exploration?{exploration:false}:{}),seed:42,initialDefinition:parent.definition,measuredSeeds:seeds,targetScore:1,initialization:{kind:'measured-public-error-repair'},identity:artifactHash(record),save:state=>store.write('search-state.json',state),event:emit,
  evaluate:async(definition,candidateId,reference,context)=>{
   return evaluateUnifiedCandidate({benchmark:subset,definition,id:candidateId,store,candidateHash:officialArtifactHash(definition,context?.toolArtifacts),toolArtifacts:context?.toolArtifacts??[],executionIdentity:{source:sourceIdentity.sha256,model:settings.model,generation:GENERATION},repeats:1,concurrency,retryAttempts:1,timeBudget,prune:false,
    runTask:async(spec,task)=>{const custom=generatedTools([...(context?.toolArtifacts??[])]);try{return await runOfficialAgent(spec,task,shared,settings,{tools:custom.tools});}finally{await custom.close();}},onEvent:emit});
  }});
 record.status=result.state.validEvaluations>seeds.length||result.stoppedBecause==='score-target'?'completed':'no-new-valid-candidate';record.bestId=result.best.id;
 await store.write('summary.json',{dataset,formalScore:false,stoppedBecause:result.stoppedBecause,bestId:result.best.id,rows:result.state.history.map(row=>({id:row.id,status:row.status,score:row.evaluation?.score,errors:row.publicErrors})),usage:budget.snapshot()});
}catch(error){record.status='failed';record.error=error.message;process.exitCode=1;}
finally{await shared?.close();record.finishedAt=new Date().toISOString();record.usage=budget.snapshot();await store.write('manifest.json',record);await store.flush();console.log(JSON.stringify({dataset,status:record.status,bestId:record.bestId,error:record.error,usage:budget.snapshot(),directory:store.directory}));}
