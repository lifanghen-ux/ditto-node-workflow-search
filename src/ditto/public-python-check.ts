import type {RegisteredTool} from '@codesoul-co/ditto/worker/interaction';
import type {CodeJudge} from '../benchmark/types.js';
import {DockerPythonJudge} from '../benchmark/docker-python-judge.js';

export const PUBLIC_PYTHON_INPUT_SCHEMA={type:'object',properties:{source:{type:'string',minLength:1,maxLength:65536},entryPoint:{type:'string',pattern:'^[A-Za-z_][A-Za-z0-9_]*$'},checks:{type:'string',minLength:1,maxLength:16384}},required:['source','entryPoint','checks'],additionalProperties:false};
export const PUBLIC_PYTHON_OUTPUT_SCHEMA={type:'object',properties:{passed:{type:'boolean'},diagnostics:{type:'string'},durationMs:{type:'number'},scope:{type:'string'}},required:['passed','diagnostics','durationMs','scope'],additionalProperties:false};

/** Uses the isolated execution service with exclusively caller-supplied code and
 * checks. No benchmark loader, private assertion, reference map or scorer access. */
export function createPublicPythonCheck(judge:CodeJudge=new DockerPythonJudge()):RegisteredTool&{close():Promise<void>}{
 const lifetime=new AbortController(),pending=new Set<Promise<unknown>>();let closed=false;
 return{name:'public_python_check',description:'Execute supplied Python source and public self-generated checks in an isolated Docker sandbox. checks must define check() and call/assert the supplied entry point. Real exceptions and assertion diagnostics are returned. Passing checks proves only those checks; hidden benchmark tests are unavailable. No host execution fallback.',inputSchema:PUBLIC_PYTHON_INPUT_SCHEMA,effects:[],validate(){},
  async close(){closed=true;lifetime.abort(new Error('Public Python checker closed'));await Promise.allSettled([...pending]);},
  async execute(args,context){
   if(closed)throw new Error('Public Python checker is closed');
   context.signal?.throwIfAborted();
   if(Object.keys(args).length!==3||!['source','entryPoint','checks'].every(key=>typeof args[key]==='string')
    ||!String(args.source).length||String(args.source).length>65536||!String(args.checks).length||String(args.checks).length>16384
    ||!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(args.entryPoint)))return{status:'failed',error:{code:'B_TOOL_INPUT',message:'Expected source (1..65536 characters), a Python entryPoint identifier, and checks (1..16384 characters) defining check()',retryable:false}};
   const signal=context.signal?AbortSignal.any([lifetime.signal,context.signal]):lifetime.signal;
   const operation=judge.judge({dataset:'mbpp',taskId:'public-generated-check',candidate:String(args.source),entryPoint:String(args.entryPoint),testSource:String(args.checks),testImports:[]},signal);
   pending.add(operation);
   let measured;
   try{measured=await operation;}finally{pending.delete(operation);}
   const diagnostics=measured.diagnostics==='exit=0; private tests passed'?'exit=0; supplied public checks passed':measured.diagnostics==='exit=1; private tests failed without diagnostics'?'exit=1; supplied public checks failed without diagnostics':measured.diagnostics;
   return{status:'success',structuredContent:{...measured,diagnostics,scope:'Only caller-supplied public checks executed. This is not an official score or proof for other inputs.'}};
  }};
}
