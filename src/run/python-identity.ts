import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DatasetName } from '../domain.js';

async function environment(python:string){
  const {stdout}=await promisify(execFile)(python,['-c',"import sys,json,importlib.metadata as m; print(json.dumps({'python':sys.version,'packages':sorted((p.metadata['Name'].lower(),p.version) for p in m.distributions())}))"],{windowsHide:true,timeout:30000,env:{...process.env,PYTHONIOENCODING:'utf-8'}});
  return JSON.parse(stdout) as {python:string;packages:[string,string][]};
}
export async function pythonExecutionIdentity(dataset:DatasetName){
  const provider=await environment(process.env.DITTO_PROVIDER_PYTHON || process.env.AFLOW_SCORER_PYTHON || 'python');
  if(Object.fromEntries(provider.packages).openai!=='2.14.0')throw new Error('Provider Python must use pinned openai==2.14.0');
  if(dataset!=='math')return {provider};
  const scorer=await environment(process.env.MATH_SCORER_PYTHON || process.env.AFLOW_SCORER_PYTHON || 'python');
  const packages=Object.fromEntries(scorer.packages);
  if(packages['math-verify']!=='0.9.0' || packages.sympy!=='1.14.0' || packages['antlr4-python3-runtime']!=='4.13.2')throw new Error('MATH scoring environment differs from requirements-scoring.txt');
  return {provider,scorer};
}
