import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {loadProviderSettings} from '../dist/config.js';
import {officialArtifactHash} from '../dist/official-agent/schema.js';
import {UnifiedRunStore,artifactHash} from '../dist/unified/store.js';
import {createProviderBudget} from '../dist/unified/provider-budget.js';
import {GENERATION} from '../dist/protocol.js';

// Complete one identical artifact's interrupted measurement. Never invent a
// search checkpoint or rerun valid cases merely because feedback policy changed.
const flags=new Map();for(let i=2;i<process.argv.length;i+=2)flags.set(process.argv[i].replace(/^--/,''),process.argv[i+1]);
if(!flags.get('run')||!flags.get('candidate')||!flags.get('data-dir'))throw Error('--run, --candidate and --data-dir are required');
const store=new UnifiedRunStore(resolve(flags.get('run'))),id=flags.get('candidate');
const manifest=await store.read('manifest.json'),selection=await store.read('selection.json'),candidate=await store.read(`candidates/${id}.json`);
if(!['drop','mbpp','bfcl'].includes(manifest.dataset)||manifest.repeats!==1||candidate.toolArtifacts?.length)throw Error('Expected a single-pass measured artifact without custom tools');
const compatible=new Set(['scripts/repair_official_errors.mjs','scripts/complete_official_measurement.mjs','scripts/validate_official_search_small.mjs','src/official-agent/schema.ts','src/official-agent/proposal-contract.ts','src/official-agent/search.ts','src/official-agent/task-generality.ts','src/official-agent/native-contracts.ts','src/benchmark/evaluation-contract.ts','src/unified/feedback.ts','src/unified/evidence.ts','src/unified/search.ts','src/unified/search-objective.ts']);
const files={};for(const file of execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z','src','scripts','prompts','package.json','package-lock.json','tsconfig.json'],{encoding:'utf8',windowsHide:true}).split('\0').filter(Boolean).sort())files[file]=createHash('sha256').update(await readFile(file)).digest('hex');
const differences=[...new Set([...Object.keys(files),...Object.keys(manifest.sourceIdentity.files)])].filter(file=>files[file]!==manifest.sourceIdentity.files[file]);
const fromSnapshot=flags.get('from-snapshot')==='true';
let moduleRoot=resolve('dist');
if(fromSnapshot){
 // Build the exact original executor rather than approving arbitrary changes to
 // it. Every saved source/prompt/driver is checked against the original digest.
 const snapshot=new UnifiedRunStore(store.path('code-snapshot'));
 for(const [file,expected]of Object.entries(manifest.sourceIdentity.files)){
  let bytes;
  try{bytes=await readFile(snapshot.path(file));}
  catch(error){
   if(error.code!=='ENOENT'||file!=='tsconfig.json')throw error;
   bytes=await readFile(resolve(file));
  }
  if(createHash('sha256').update(bytes).digest('hex')!==expected)throw Error('Original code snapshot differs: '+file);
 }
 for(const file of ['package.json','package-lock.json','tsconfig.json'])
  if(files[file]!==manifest.sourceIdentity.files[file])throw Error('Original compiler/dependency settings differ: '+file);
 const configuration=JSON.parse(await readFile(resolve('tsconfig.json'),'utf8'));
 moduleRoot=snapshot.path('dist');
 configuration.compilerOptions={...configuration.compilerOptions,rootDir:snapshot.path('src'),outDir:moduleRoot};
 configuration.include=[snapshot.path('src/**/*.ts')];
 const configurationPath=snapshot.path('continuation.tsconfig.json');
 await writeFile(configurationPath,JSON.stringify(configuration));
 execFileSync(process.execPath,[resolve('node_modules/typescript/bin/tsc'),'-p',configurationPath],{windowsHide:true,stdio:'pipe'});
}else if(differences.some(file=>!compatible.has(file)&&!file.endsWith('.test.ts')))throw Error('Executable runtime/provider/bridge/scorer changed; use a verified original --from-snapshot true or start a new measurement');
if(flags.get('prepare-only')==='true'){
 if(!fromSnapshot)throw Error('prepare-only requires from-snapshot');
 console.log(JSON.stringify({status:'verified-original-snapshot-ready',run:store.directory,candidate:id,moduleRoot,sourceHash:manifest.sourceIdentity.sha256,providerCalls:0}));
 process.exit(0);
}
// All context-owning modules must come from the same build (notably BFCL scope
// and provider accounting). Mixing current and original AsyncLocalStorage fails.
const module=path=>import(pathToFileURL(resolve(moduleRoot,path)).href);
const [{loadBenchmark,DockerPythonJudge},{createExperimentRuntime},{runOfficialAgent},{evaluateUnifiedCandidate}]=await Promise.all([
 module('benchmark/index.js'),module('ditto/runtime.js'),module('official-agent/executor.js'),module('unified/evaluation.js')]);
const settings={...loadProviderSettings(),concurrency:1};
if(settings.model!==manifest.model||artifactHash(GENERATION)!==artifactHash(manifest.generation))throw Error('Model or generation differs');
const workflowAttemptsLimit=Number(flags.get('workflow-attempts')??manifest.workflowAttemptsLimit??1);
if(!Number.isSafeInteger(workflowAttemptsLimit)||workflowAttemptsLimit<1||workflowAttemptsLimit>5)throw Error('Workflow attempts must be 1..5; previous failures remain charged');
const before=await store.read('provider-budget.json');
const budget=createProviderBudget({maxCalls:Number(flags.get('max-calls')??1200),maxTokens:Number(flags.get('max-tokens')??5000000),restored:before,onEvent:event=>store.write('provider-budget.json',event.usage)});
const record={candidate:id,status:'preparing',startedAt:new Date().toISOString(),preservedExecutionIdentity:manifest.sourceIdentity.sha256,actualSourceHash:artifactHash(files),validationOnlyDifferences:differences,usageBefore:before,reason:'Same solver artifact, dataset, provider, generation, executable runtime and scorer. Only proposal/feedback validation code changed. Resume valid case results without regeneration.'};
record.workflowAttemptsLimit=workflowAttemptsLimit;
if(fromSnapshot){record.executionSource='verified-original-code-snapshot';record.moduleRoot=moduleRoot;record.workingTreeDifferences=differences;delete record.validationOnlyDifferences;record.reason='Compile and execute the verified original code snapshot, preserving model, artifact, data, scorer, cache identity and successful cases. Current working-tree executor changes are not used.';}
await store.write(`continuation-${id}.json`,record);
let shared;
try{
 if(manifest.dataset==='mbpp')await new DockerPythonJudge({image:'python:3.13-slim'}).preflight();
 const benchmark=await loadBenchmark(manifest.dataset,{dataDir:resolve(flags.get('data-dir')),split:'validate',dataMode:'formal',limit:0,artifactDir:store.path('private'),...(manifest.dataset==='mbpp'?{codeJudge:new DockerPythonJudge({image:'python:3.13-slim'})}:{})});
 if(artifactHash(benchmark.identity)!==artifactHash(selection.data))throw Error('Dataset differs');
 const tasks=selection.tasks.map(saved=>{const task=benchmark.tasks.find(task=>task.id===saved.id);if(!task||artifactHash(task)!==artifactHash(saved))throw Error('Public task differs');return task;});
 const saved=await store.read(`evaluations/${id}/checkpoint.json`),valid=new Set(saved.cases.filter(row=>row.valid&&!row.error).map(row=>row.caseId));
 record.reusedValidCases=valid.size;record.totalCases=tasks.length;
 shared=createExperimentRuntime(settings,{timeBudget:manifest.timeBudget,connectTimeoutMs:10000,beforeProviderCall:async input=>{await budget.beforeProviderCall(input);await store.append('provider-requests.jsonl',{metadata:input.metadata,input});},afterProviderCall:async event=>{await budget.afterProviderCall(event);await store.append('provider-responses.jsonl',{metadata:event.input.metadata,output:event.output,error:event.error?.message,diagnostics:event.diagnostics});}});
 const result=await evaluateUnifiedCandidate({benchmark:{...benchmark,tasks},definition:candidate.definition,id,store,candidateHash:officialArtifactHash(candidate.definition),executionIdentity:{source:manifest.sourceIdentity.sha256,model:settings.model,generation:GENERATION},repeats:1,concurrency:1,retryAttempts:workflowAttemptsLimit,timeBudget:manifest.timeBudget,prune:false,resume:true,
  runTask:(definition,task)=>runOfficialAgent(definition,task,shared,settings),onEvent:event=>{if(event.type==='case-completed'&&!valid.has(event.caseId))console.log(JSON.stringify(event));}});
 record.status='completed';record.score=result.score;record.examples=result.examples;
}catch(error){record.status='failed';record.error=error.message;process.exitCode=1;}
finally{await shared?.close();record.finishedAt=new Date().toISOString();record.usageAfter=budget.snapshot();await store.write(`continuation-${id}.json`,record);await store.flush();console.log(JSON.stringify(record));}
