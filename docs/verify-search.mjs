// Reproduce the delivered 20-case official search acceptance without opening test.
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBenchmark, sha256File } from '../dist/benchmark/index.js';
import { automationIdentity } from '../dist/benchmark/automation.js';
import { createExperimentRuntime } from '../dist/ditto/runtime.js';
import { WorkflowExecutor } from '../dist/workflow/executor.js';
import { loadProviderSettings } from '../dist/config.js';
import { CaseRecovery, evaluationCodeHash } from '../dist/run/case-recovery.js';
import { GENERATION, PROTOCOL } from '../dist/protocol.js';

const [casePath,planPath,dataPath,outputPath,prepare]=process.argv.slice(2);
if(!casePath||!planPath||!dataPath||!outputPath)throw new Error('Usage: node docs/verify-search.mjs <cases.json> <plan.json> <data-dir> <output-dir> [--prepare-only]');
const root=fileURLToPath(new URL('..',import.meta.url));
const selection=JSON.parse(await readFile(resolve(casePath),'utf8'));
const plan=JSON.parse(await readFile(resolve(planPath),'utf8'));
if(!['math','automationbench'].includes(selection.dataset)||selection.split!=='validate'||selection.selectedIds?.length!==20)throw new Error('Exactly 20 fixed search cases are required; test is not supported by this example');
const codeSha256=await evaluationCodeHash(root);
if(codeSha256!==selection.engineCodeSha256)throw new Error('Engine source differs from this frozen acceptance manifest');
if(await sha256File(join(resolve(dataPath),selection.dataFile))!==selection.dataSha256)throw new Error('Frozen search data hash differs');
const output=resolve(outputPath);
const loaded=await loadBenchmark(selection.dataset,{dataDir:resolve(dataPath),split:'validate',limit:20,seed:selection.seed,artifactDir:output});
if(JSON.stringify(loaded.tasks.map(t=>t.id))!==JSON.stringify(selection.selectedIds))throw new Error('Selected IDs/order differ from frozen acceptance');
const automation=selection.dataset==='automationbench'?await automationIdentity():undefined;
if(prepare==='--prepare-only'){console.log(JSON.stringify({prepared:true,dataset:selection.dataset,cases:20,codeSha256,modelCalls:0,testCalls:0}));process.exit(0);}
if(prepare!==undefined)throw new Error('Unknown fifth argument');
const settings={...loadProviderSettings(),concurrency:3};
if(settings.baseUrl!=='https://api.deepseek.com'||settings.model!=='deepseek-flash')throw new Error('This acceptance example requires official DeepSeek deepseek-flash');
await mkdir(output,{recursive:true});
try{const completed=JSON.parse(await readFile(join(output,'summary.json'),'utf8'));if(completed.valid)throw new Error('Completed valid acceptance exists; use a separate output for an independent repeat');}catch(e){if(e.code!=='ENOENT')throw e;}
const manifest={dataset:selection.dataset,selection,plan,codeSha256,orchestrationSha256:await sha256File(fileURLToPath(import.meta.url)),...(automation?{automation}:{}),model:settings.model,endpoint:settings.baseUrl,generation:GENERATION,protocol:PROTOCOL,evaluationConcurrency:3,providerConcurrency:3,testCalls:0};
try{await writeFile(join(output,'manifest.json'),JSON.stringify(manifest,null,2),{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;const previous=JSON.parse(await readFile(join(output,'manifest.json'),'utf8'));if(JSON.stringify(previous)!==JSON.stringify(manifest))throw new Error('Existing recovery manifest differs');}
const attempt=join(output,'attempts',new Date().toISOString().replace(/[:.]/g,'-'));await mkdir(attempt,{recursive:true});
process.env.DITTO_PROVIDER_LOG=join(attempt,'provider.jsonl');
const recovery=await CaseRecovery.open(join(output,'.case-checkpoints'),manifest,{evaluationConcurrency:3,providerConcurrency:3});
await writeFile(join(attempt,'recovery.json'),JSON.stringify({identity:recovery.identity,recoveredValidCases:recovery.priorCases.filter(x=>x.valid).length}));
const experiment=createExperimentRuntime(settings);const executor=new WorkflowExecutor(experiment.runtime,experiment.providerName,experiment.model);
try{
 const result=await loaded.evaluate(t=>executor.run(plan,t),{concurrency:3,repeats:1,priorCases:recovery.priorCases,onCase:async({completed,total,result})=>{await recovery.record(result);await appendFile(join(attempt,'samples.jsonl'),JSON.stringify(result)+'\n');console.log(JSON.stringify({completed,total,valid:result.valid,score:result.valid?result.score:null}));}});
 await recovery.finish(result.valid===true);
 await writeFile(join(attempt,'summary.json'),JSON.stringify(result,null,2));await writeFile(join(output,'summary.json'),JSON.stringify(result,null,2));
 if(!result.valid)throw new Error('Invalid acceptance; preserve evidence and rerun only under the identical manifest');
}finally{await experiment.close();}
