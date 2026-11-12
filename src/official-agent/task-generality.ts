import type {BenchmarkTask} from '../domain.js';
import {DefinitionError} from '../graph-agent/schema.js';
import type {OfficialAgentDefinition} from './schema.js';

export const TASK_GENERALITY_VERSION='public-function-specialization-v1';
/** A narrow syntactic policy: not a semantic proof of generalization. */
export function assertReusableStrategy(definition:OfficialAgentDefinition,tasks:readonly BenchmarkTask[]):void{
 const names=new Set(tasks.filter(task=>task.dataset==='mbpp'||task.dataset==='humaneval').flatMap(task=>{
  const name=task.metadata.entryPoint;
  // Plain words such as count/sort are legitimate generic strategy vocabulary.
  return typeof name==='string'&&/^[A-Za-z]\w*_\w+$/.test(name)?[name]:[];
 }));
 const visit=(value:unknown,path:string):void=>{
  if(typeof value==='string'){
   for(const name of names)if(new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(value))
    throw new DefinitionError(`Reusable strategy contains a measured task's function identifier: ${name}`,path,
     'Read the current function name/signature from input.task.prompt at execution time. Use task-independent reasoning, verification and control rules; do not embed per-function solution conventions in reusable config. This check is only an identifier guard and does not certify all other constants.');
  }else if(value&&typeof value==='object')for(const [key,child]of Object.entries(value))visit(child,path+'/'+key.replace(/~/g,'~0').replace(/\//g,'~1'));
 };
 visit(definition.config,'/config');
}
