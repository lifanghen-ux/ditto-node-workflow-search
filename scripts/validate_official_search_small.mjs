import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {loadBenchmark,DockerPythonJudge} from '../dist/benchmark/index.js';
import {loadProviderSettings} from '../dist/config.js';
import {createExperimentRuntime} from '../dist/ditto/runtime.js';
import {officialBaseline} from '../dist/official-agent/baselines.js';
import {automationLayeredController} from '../dist/official-agent/layered-controller.js';
import {loadOfficialInitialization} from '../dist/official-agent/initialization.js';
import {runOfficialAgent} from '../dist/official-agent/executor.js';
import {searchOfficialWorkflows} from '../dist/official-agent/search.js';
import {officialArtifactHash,validateOfficialDefinition,OFFICIAL_MUTATION_LIMITS} from '../dist/official-agent/schema.js';
import {generatedTools} from '../dist/graph-agent/tools.js';
import {evaluateUnifiedCandidate} from '../dist/unified/evaluation.js';
import {UnifiedRunStore,artifactHash} from '../dist/unified/store.js';
import {createProviderBudget} from '../dist/unified/provider-budget.js';
import {OFFICIAL_OPTIMIZER_SYSTEM_SHA256} from '../dist/official-agent/prompts.js';
import {NODE_SYSTEM_PROMPT_SHA256} from '../dist/graph-agent/system.js';
import {OFFICIAL_PROPOSAL_CONTRACT_VERSION} from '../dist/official-agent/proposal-contract.js';
import {NATIVE_CONTRACTS_VERSION} from '../dist/official-agent/native-contracts.js';
import {GENERATION} from '../dist/protocol.js';

// Real production search/evaluator on an explicitly labelled Search subset. Never Test.
const flags=new Map();for(let i=2;i<process.argv.length;i+=2){if(!process.argv[i+1])throw Error('Missing flag value');flags.set(process.argv[i].replace(/^--/,''),process.argv[i+1]);}
const dataset=flags.get('dataset');
if(!['drop','humaneval','mbpp','automationbench','bfcl'].includes(dataset))throw Error('One supported --dataset is required');
const store=new UnifiedRunStore(resolve(flags.get('output')??`runs/contract-small/${dataset}`));
const resume=flags.get('resume')==='true',previous=await store.optional('manifest.json');
if(previous&&!resume)throw Error('Existing experiment directory; use --resume true only for the same execution identity');
if(resume&&!previous)throw Error('Cannot resume an experiment without its manifest');
const concurrency=Number(flags.get('concurrency')??1);
if(!Number.isSafeInteger(concurrency)||concurrency<1||concurrency>4)throw Error('Diagnostic concurrency must be 1..4');
if(previous&&(previous.evaluationConcurrency??1)!==concurrency)throw Error('Resume concurrency differs');
const codeFiles=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z','src','scripts','prompts','package.json','package-lock.json','tsconfig.json'],{encoding:'utf8',windowsHide:true}).split('\0').filter(Boolean).sort();
const files={};for(const file of codeFiles)files[file]=createHash('sha256').update(await readFile(file)).digest('hex');
const currentSourceIdentity={commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim(),sha256:artifactHash(files),files};
if(previous){
 const driver='scripts/validate_official_search_small.mjs';
 const immutable=map=>Object.fromEntries(Object.entries(map).filter(([name])=>name!==driver));
 if(previous.dataset!==dataset||artifactHash(immutable(previous.sourceIdentity.files))!==artifactHash(immutable(files)))throw Error('Executable source/prompt/dependency identity changed; use a new experiment');
}
// Resume may update only this driver. Preserve the original execution/cache identity,
// retain the original code snapshot, and record the actual continuation driver separately.
const sourceIdentity=previous?.sourceIdentity??currentSourceIdentity;
const maxValidEvaluations=Number(flags.get('evaluate-only')==='true'?1:flags.get('max-valid-evaluations')??2),maxDesignRounds=Number(flags.get('max-design-rounds')??1),maxProposalAttempts=Number(flags.get('max-proposal-attempts')??3);
for(const value of [maxValidEvaluations,maxDesignRounds,maxProposalAttempts])if(!Number.isSafeInteger(value)||value<1)throw Error('Search limits must be positive integers');
const timeBudget={requestMs:600000,workflowMs:null,reason:'Small engineering validation; not a formal five-repeat score'};
const workflowAttemptsLimit=Number(flags.get('workflow-attempts')??5);
if(!Number.isSafeInteger(workflowAttemptsLimit)||workflowAttemptsLimit<1||workflowAttemptsLimit>5)throw Error('Workflow attempts must be between 1 and the main limit of 5');
const budget=createProviderBudget({maxCalls:Number(flags.get('max-calls')??250),maxTokens:Number(flags.get('max-tokens')??4000000),...(resume?{restored:await store.optional('provider-budget.json')}:{}),onEvent:event=>store.write('provider-budget.json',event.usage)});
let shared;
const manifest={...previous,protocol:'official-json-real-search-engineering-subset-v1',dataset,status:'preparing',createdAt:previous?.createdAt??new Date().toISOString(),sourceIdentity,formalTest:false,formalScore:false,repeats:1,seed:42,maximumNewValidCandidates:maxValidEvaluations-1,maximumDesignRounds:maxDesignRounds,maximumProposalAttempts:maxProposalAttempts,directionResourcePolicy:"shared-global-budget-no-direction-caps-v1",timeBudget,controller:flags.get('controller')??'default',mutationLimits:OFFICIAL_MUTATION_LIMITS,generation:GENERATION,optimizerSystemSha256:OFFICIAL_OPTIMIZER_SYSTEM_SHA256,nodeSystemSha256:NODE_SYSTEM_PROMPT_SHA256,proposalContract:OFFICIAL_PROPOSAL_CONTRACT_VERSION,nativeContracts:NATIVE_CONTRACTS_VERSION};
if(resume){manifest.continuations=[...(previous.continuations??[]),{at:new Date().toISOString(),driverSha256:files['scripts/validate_official_search_small.mjs'],previousWorkflowAttemptsLimit:previous.workflowAttemptsLimit??2,workflowAttemptsLimit,reason:'Infrastructure recovery; identical executor/prompt/dependencies and retained successful cases. Cumulative attempts and provider usage are not reset.'}];delete manifest.error;}
manifest.workflowAttemptsLimit=workflowAttemptsLimit;
manifest.evaluationConcurrency=concurrency;
manifest.evaluateOnly=maxValidEvaluations===1;
await store.write('manifest.json',manifest);if(!resume)await store.snapshot(process.cwd());
const emit=async event=>{await store.append('events.jsonl',{at:new Date().toISOString(),...event});if(['case-completed','stage-completed','unified-candidate-proposed','unified-design-skipped'].includes(event.type))console.log(JSON.stringify({dataset,type:event.type,candidateId:event.candidateId??event.pending?.id,caseId:event.caseId,valid:event.valid,score:event.score}));};
try{
 const settings={...loadProviderSettings(),concurrency};manifest.model=settings.model;
 if(['humaneval','mbpp'].includes(dataset))await new DockerPythonJudge({image:'python:3.13-slim'}).preflight();
 const benchmark=await loadBenchmark(dataset,{dataDir:resolve(flags.get('data-dir')??'../data/datasets'),split:'validate',dataMode:'formal',limit:0,artifactDir:store.path('private'),...(['humaneval','mbpp'].includes(dataset)?{codeJudge:new DockerPythonJudge({image:'python:3.13-slim'})}:{})});
 if(!benchmark.identity?.verified)throw Error('Pinned Search split verification failed');
 const ordered=benchmark.tasks.slice().sort((a,b)=>createHash('sha256').update('42:'+a.id).digest('hex').localeCompare(createHash('sha256').update('42:'+b.id).digest('hex')));
 const count=Number(flags.get('count')??(dataset==='bfcl'?4:3));
 const requestedIds=flags.get('task-ids')?.split(',');
 if(requestedIds&&(!requestedIds.length||new Set(requestedIds).size!==requestedIds.length||requestedIds.some(id=>!benchmark.tasks.some(task=>task.id===id))))throw Error('Explicit task IDs must be unique members of the pinned Search split');
 const tasks=requestedIds?requestedIds.map(id=>benchmark.tasks.find(task=>task.id===id)):dataset==='bfcl'?[...new Set(ordered.map(t=>t.metadata.category))].sort().map(category=>ordered.find(t=>t.metadata.category===category)).slice(0,count):ordered.slice(0,count);
 if(!tasks.length)throw Error('No public Search tasks selected');
 if(previous?.taskIds&&JSON.stringify(previous.taskIds)!==JSON.stringify(tasks.map(t=>t.id)))throw Error('Resume task selection differs');
 await store.write('selection.json',{data:benchmark.identity,sourceCount:benchmark.tasks.length,selectionRule:requestedIds?'explicit public Search error cases; diagnostic selection, not an accuracy estimate':dataset==='bfcl'?'one per public category, sha256(42:id) order':'sha256(42:id) order',tasks});
 const subset={...benchmark,tasks};
 const initialization=loadOfficialInitialization(dataset,flags.get('initialization')??'baseline');
 if(previous?.initialization?.identity&&previous.initialization.identity!==initialization.identity)throw Error('Resume initialization differs');
 const initialArtifact=flags.get('initial-candidate')?JSON.parse(await readFile(resolve(flags.get('initial-candidate')),'utf8')):undefined;
 if(initialArtifact?.toolArtifacts?.length)throw Error('This diagnostic driver does not import seed custom tools');
 const initialDefinition=initialArtifact?.definition??structuredClone(dataset==='automationbench'&&flags.get('controller')==='layered-v10'?automationLayeredController():officialBaseline(dataset));
 if(!initialArtifact)initialDefinition.config={...initialDefinition.config,...(initialization.seedStrategy?{strategy:initialization.seedStrategy}:{}),firstTaskRepeat:initialization.presentation==='repeat-task-on-first-sample'};
 const initialCandidate={source:flags.get('initial-candidate')??'officialBaseline',artifactHash:officialArtifactHash(initialDefinition)};
 if(previous?.initialCandidate&&artifactHash(previous.initialCandidate)!==artifactHash(initialCandidate))throw Error('Resume initial candidate differs');
 manifest.initialCandidate=initialCandidate;
 Object.assign(manifest,{initialization,dataIdentity:benchmark.identity,taskIds:tasks.map(t=>t.id),status:'searching'});await store.write('manifest.json',manifest);
 if(flags.get('preflight-only')==='true'){validateOfficialDefinition(initialDefinition);manifest.status='preflight-passed';}else{
 shared=createExperimentRuntime(settings,{timeBudget,connectTimeoutMs:10000,beforeProviderCall:async input=>{await budget.beforeProviderCall(input);await store.append('provider-requests.jsonl',{metadata:input.metadata,input});},afterProviderCall:async event=>{await budget.afterProviderCall(event);await store.append('provider-responses.jsonl',{metadata:event.input.metadata,output:event.output,error:event.error?.message,diagnostics:event.diagnostics});}});
 const result=await searchOfficialWorkflows({runtime:shared.runtime,model:{provider:shared.providerName,model:shared.model},dataset,publicTasks:tasks,expectedExamples:tasks.length,expectedRepeats:1,maxValidEvaluations,maxDesignRounds,maxProposalAttempts,seed:42,initialDefinition,initialization,identity:artifactHash({sourceIdentity,selection:tasks.map(t=>t.id),timeBudget}),...(resume?{resume:await store.read('search-state.json')}:{}),save:state=>store.write('search-state.json',state),event:emit,
  evaluate:(definition,id,reference,context)=>evaluateUnifiedCandidate({benchmark:subset,definition,id,store,candidateHash:officialArtifactHash(definition,context?.toolArtifacts),toolArtifacts:context?.toolArtifacts??[],executionIdentity:{source:sourceIdentity.sha256,model:settings.model,generation:GENERATION},repeats:1,concurrency,retryAttempts:workflowAttemptsLimit,timeBudget,prune:false,resume,runTask:async(spec,task)=>{const custom=generatedTools([...(context?.toolArtifacts??[])]);try{return await runOfficialAgent(spec,task,shared,settings,{tools:custom.tools});}finally{await custom.close();}},onEvent:emit})});
 const rows=result.state.history.map(row=>({id:row.id,parentId:row.parentId,status:row.status,direction:row.explorationDirection,rationale:row.rationale,score:row.evaluation?.score,examples:row.evaluation?.examples,valid:row.evaluation?.valid,issues:row.publicIssues,errors:row.publicErrors}));
 await store.write('summary.json',{dataset,status:result.state.validEvaluations>=Math.min(2,maxValidEvaluations)?'passed':'no-new-valid-candidate',stoppedBecause:result.stoppedBecause,validEvaluations:result.state.validEvaluations,proposalAttempts:result.state.proposalAttempts,engineeringFailures:result.state.engineeringFailures,rows,bestId:result.best.id,usage:budget.snapshot()});
 manifest.status=result.state.validEvaluations>=Math.min(2,maxValidEvaluations)?'passed':'no-new-valid-candidate';
 }
}catch(error){manifest.status='blocked';manifest.error=error.message;await store.write('failure.json',{message:error.message,code:error.code,stack:error.stack});process.exitCode=1;}
finally{await shared?.close();manifest.finishedAt=new Date().toISOString();manifest.usage=budget.snapshot();await store.write('manifest.json',manifest);await store.flush();console.log(JSON.stringify({dataset,status:manifest.status,directory:store.directory,usage:budget.snapshot()}));}
