/** Rejudge saved MBPP answers with corrected extraction. Makes no provider calls. */
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {loadBenchmark,DockerPythonJudge} from '../dist/benchmark/index.js';
import {auditCandidate} from './audit-generated-run.mjs';
const directory=resolve(process.argv[2]),candidateId=process.argv[3];
const manifest=JSON.parse(await readFile(join(directory,'manifest.json'),'utf8'));
if(manifest.dataset!=='mbpp')throw Error('Only MBPP scorer extraction correction is supported');
const codeJudge=new DockerPythonJudge();
await codeJudge.preflight();
const benchmark=await loadBenchmark('mbpp',{dataDir:resolve('data/datasets'),split:'validate',limit:0,codeJudge});
if(!isDeepStrictEqual(benchmark.identity,manifest.data.identity))throw Error('Saved MBPP dataset identity differs');
const audited=await auditCandidate(directory,candidateId);
const prior=new Map(audited.reusable.map(row=>[row.caseId,row]));
const ids=[...prior.keys()].map(id=>id.replace(/#1$/,''));
if(!ids.length)throw Error('No valid saved answers to regrade');
const summary=await benchmark.evaluateSearchSubset(ids,async task=>{
  const row=prior.get(task.id+'#1');
  return {...row,answer:row.prediction};
},{repeats:1,concurrency:1,retryAttempts:1});
if(!summary.valid)throw Error('Regrading failed; original artifacts preserved');
const corrected=summary.results.map(graded=>{
  const old=prior.get(graded.caseId);
  return {...old,score:graded.score,normalizedPrediction:graded.normalizedPrediction,method:graded.method,details:graded.details,
    scorerCorrection:{policy:'mbpp-prose-scaffold-fix-v1',previousScore:old.score,previousDetails:old.details}};
});
await writeFile(join(directory,'evaluations',candidateId,'regraded-samples.jsonl'),corrected.map(row=>JSON.stringify(row)).join('\n')+'\n');
console.log(JSON.stringify({phase:'saved-answers-regraded',dataset:'mbpp',candidateId,examples:corrected.length,
  passed:corrected.filter(row=>row.score===1).length,providerCalls:0}));
